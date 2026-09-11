import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  MediaKind,
  MediaSource,
  SfuService,
  TransportDirection,
  type StatsEventSchema,
  type StatsRequest,
} from "@zoomclone/sfu-proto";

export type StatsEventInit = NonNullable<MessageInitShape<typeof StatsEventSchema>["event"]>;

export const FAKE_RTP_CAPABILITIES = {
  codecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }],
  headerExtensions: [],
};

export type FakeTransport = {
  id: string;
  participantId: string;
  direction: TransportDirection;
  connected: boolean;
  iceParameters: Record<string, unknown>;
  iceCandidates: Record<string, unknown>[];
  dtlsParameters: Record<string, unknown>;
};
export type FakeProducer = {
  id: string;
  trackId: string;
  participantId: string;
  transportId: string;
  kind: MediaKind;
  source: MediaSource;
  paused: boolean;
  layerCount: number;
};
export type FakeConsumer = {
  id: string;
  producerId: string;
  participantId: string;
  transportId: string;
  paused: boolean;
  preferredSpatialLayer?: number;
  priority: number;
};
export type FakeRoom = {
  transports: Map<string, FakeTransport>;
  producers: Map<string, FakeProducer>;
  consumers: Map<string, FakeConsumer>;
};
export type FakeCall = { method: string; request: Record<string, unknown> };

class Queue<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }
  end(): void {
    this.ended = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  async *drain(signal: AbortSignal): AsyncGenerator<T> {
    const onAbort = () => this.end();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        if (this.items.length > 0) {
          yield this.items.shift()!;
          continue;
        }
        if (this.ended || signal.aborted) return;
        await new Promise<void>((resolve) => (this.waiter = resolve));
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * In-process SfuService over h2c: records every call, hands out predictable ids, keeps per-room
 * entity maps for snapshots, lets tests inject failures and push Stats events.
 */
export class FakeSfu {
  readonly calls: FakeCall[] = [];
  baseUrl = "";
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly streams = new Map<string, Set<Queue<StatsEventInit>>>();
  private readonly failures = new Map<string, { code: Code; skip: number }>();
  private counters = { t: 0, p: 0, c: 0 };
  private server: http2.Http2Server | null = null;

  async start(): Promise<string> {
    const server = http2.createServer(
      connectNodeAdapter({ routes: (router) => this.routes(router) }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const set of this.streams.values()) for (const q of set) q.end();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  reset(): void {
    this.calls.length = 0;
    this.failures.clear();
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Fails the (skip + 1)th upcoming call of `method` with `code`. */
  failNext(method: string, code: Code, skip = 0): void {
    this.failures.set(method, { code, skip });
  }

  room(sessionId: string): FakeRoom | undefined {
    return this.rooms.get(sessionId);
  }

  /** Pre-populates a room as if a previous controller had created these entities. */
  seedRoom(
    sessionId: string,
    seed: {
      transports?: Array<{ participantId: string; direction: "send" | "recv" }>;
      producers?: Array<{
        participantId: string;
        trackId: string;
        kind: "audio" | "video";
        source: "mic" | "camera" | "screen" | "screen_audio";
        paused?: boolean;
      }>;
    },
  ): { transportIds: string[]; producerIds: string[] } {
    const room = this.ensureRoom(sessionId);
    const transportIds: string[] = [];
    const producerIds: string[] = [];
    for (const t of seed.transports ?? []) {
      const transport = this.newTransport(
        t.participantId,
        t.direction === "send" ? TransportDirection.SEND : TransportDirection.RECV,
      );
      transport.connected = true;
      room.transports.set(transport.id, transport);
      transportIds.push(transport.id);
    }
    for (const p of seed.producers ?? []) {
      const send = [...room.transports.values()].find(
        (t) => t.participantId === p.participantId && t.direction === TransportDirection.SEND,
      );
      if (!send) throw new Error(`seedRoom: ${p.participantId} has no send transport`);
      const id = `p${++this.counters.p}`;
      room.producers.set(id, {
        id,
        trackId: p.trackId,
        participantId: p.participantId,
        transportId: send.id,
        kind: p.kind === "audio" ? MediaKind.AUDIO : MediaKind.VIDEO,
        source: {
          mic: MediaSource.MIC,
          camera: MediaSource.CAMERA,
          screen: MediaSource.SCREEN,
          screen_audio: MediaSource.SCREEN_AUDIO,
        }[p.source],
        paused: p.paused ?? false,
        layerCount: p.kind === "video" ? 3 : 1,
      });
      producerIds.push(id);
    }
    return { transportIds, producerIds };
  }

  emit(sessionId: string, event: StatsEventInit): void {
    for (const q of this.streams.get(sessionId) ?? []) q.push(event);
  }

  /** Ends every open Stats stream for the session (simulates a dropped connection). */
  dropStreams(sessionId: string): void {
    for (const q of this.streams.get(sessionId) ?? []) q.end();
    this.streams.delete(sessionId);
  }

  // ---- internals ----

  private guard(method: string, request: object): void {
    this.calls.push({ method, request: { ...request } as Record<string, unknown> });
    const failure = this.failures.get(method);
    if (!failure) return;
    if (failure.skip > 0) {
      failure.skip--;
      return;
    }
    this.failures.delete(method);
    throw new ConnectError(`injected ${method} failure`, failure.code);
  }

  private ensureRoom(sessionId: string): FakeRoom {
    let room = this.rooms.get(sessionId);
    if (!room) {
      room = { transports: new Map(), producers: new Map(), consumers: new Map() };
      this.rooms.set(sessionId, room);
    }
    return room;
  }

  private requireRoom(sessionId: string): FakeRoom {
    const room = this.rooms.get(sessionId);
    if (!room) throw new ConnectError(`room ${sessionId} not found`, Code.NotFound);
    return room;
  }

  private findTransport(transportId: string): { room: FakeRoom; transport: FakeTransport } {
    for (const room of this.rooms.values()) {
      const transport = room.transports.get(transportId);
      if (transport) return { room, transport };
    }
    throw new ConnectError(`transport ${transportId} not found`, Code.NotFound);
  }

  private findProducer(producerId: string): { room: FakeRoom; producer: FakeProducer } {
    for (const room of this.rooms.values()) {
      const producer = room.producers.get(producerId);
      if (producer) return { room, producer };
    }
    throw new ConnectError(`producer ${producerId} not found`, Code.NotFound);
  }

  private findConsumer(consumerId: string): { room: FakeRoom; consumer: FakeConsumer } {
    for (const room of this.rooms.values()) {
      const consumer = room.consumers.get(consumerId);
      if (consumer) return { room, consumer };
    }
    throw new ConnectError(`consumer ${consumerId} not found`, Code.NotFound);
  }

  private newTransport(participantId: string, direction: TransportDirection): FakeTransport {
    const n = ++this.counters.t;
    return {
      id: `t${n}`,
      participantId,
      direction,
      connected: false,
      iceParameters: { usernameFragment: `ufrag${n}`, password: `pwd${n}`, iceLite: true },
      iceCandidates: [
        {
          foundation: "udpcandidate",
          ip: "127.0.0.1",
          port: 40000 + n,
          priority: 1,
          protocol: "udp",
          type: "host",
        },
      ],
      dtlsParameters: { role: "auto", fingerprints: [{ algorithm: "sha-256", value: `AA:${n}` }] },
    };
  }

  private snapshot(sessionId: string, room: FakeRoom): StatsEventInit {
    return {
      case: "snapshot",
      value: {
        transports: [...room.transports.values()].map((t) => ({
          transportId: t.id,
          participantId: t.participantId,
          direction: t.direction,
          iceState: t.connected ? "connected" : "new",
          dtlsState: t.connected ? "connected" : "new",
          iceParametersJson: JSON.stringify(t.iceParameters),
          iceCandidatesJson: JSON.stringify(t.iceCandidates),
          dtlsParametersJson: JSON.stringify(t.dtlsParameters),
        })),
        producers: [...room.producers.values()].map((p) => ({
          producerId: p.id,
          meta: {
            sfuId: "fake-sfu",
            sessionId,
            participantId: p.participantId,
            trackId: p.trackId,
            kind: p.kind,
            source: p.source,
            origin: "local",
          },
          paused: p.paused,
          layerCount: p.layerCount,
          transportId: p.transportId,
        })),
        consumers: [...room.consumers.values()].map((c) => ({
          consumerId: c.id,
          producerId: c.producerId,
          participantId: c.participantId,
          transportId: c.transportId,
          paused: c.paused,
          producerPaused: room.producers.get(c.producerId)?.paused ?? false,
          preferredSpatialLayer: c.preferredSpatialLayer,
          priority: c.priority,
        })),
      },
    };
  }

  private async *statsStream(
    req: StatsRequest,
    ctx: HandlerContext,
  ): AsyncGenerator<{ event: StatsEventInit }> {
    this.guard("stats", req);
    const room = this.requireRoom(req.sessionId);
    const queue = new Queue<StatsEventInit>();
    let set = this.streams.get(req.sessionId);
    if (!set) {
      set = new Set();
      this.streams.set(req.sessionId, set);
    }
    set.add(queue);
    try {
      yield { event: this.snapshot(req.sessionId, room) };
      for await (const event of queue.drain(ctx.signal)) yield { event };
    } finally {
      set.delete(queue);
    }
  }

  private routes(router: ConnectRouter): void {
    router.service(SfuService, {
      allocateRoom: (req) => {
        this.guard("allocateRoom", req);
        this.ensureRoom(req.sessionId);
        return { rtpCapabilitiesJson: JSON.stringify(FAKE_RTP_CAPABILITIES), sfuId: "fake-sfu" };
      },
      closeRoom: (req) => {
        this.guard("closeRoom", req);
        this.rooms.delete(req.sessionId);
        this.dropStreams(req.sessionId);
        return {};
      },
      createTransport: (req) => {
        this.guard("createTransport", req);
        const room = this.requireRoom(req.sessionId);
        const transport = this.newTransport(req.participantId, req.direction);
        room.transports.set(transport.id, transport);
        return {
          transportId: transport.id,
          iceParametersJson: JSON.stringify(transport.iceParameters),
          iceCandidatesJson: JSON.stringify(transport.iceCandidates),
          dtlsParametersJson: JSON.stringify(transport.dtlsParameters),
        };
      },
      connectTransport: (req) => {
        this.guard("connectTransport", req);
        const { transport } = this.findTransport(req.transportId);
        if (transport.connected)
          throw new ConnectError("already connected", Code.FailedPrecondition);
        transport.connected = true;
        return {};
      },
      closeTransport: (req) => {
        this.guard("closeTransport", req);
        const { room, transport } = this.findTransport(req.transportId);
        room.transports.delete(transport.id);
        for (const [id, p] of room.producers)
          if (p.transportId === transport.id) room.producers.delete(id);
        for (const [id, c] of room.consumers)
          if (c.transportId === transport.id) room.consumers.delete(id);
        return {};
      },
      restartIce: (req) => {
        this.guard("restartIce", req);
        const { transport } = this.findTransport(req.transportId);
        return {
          iceParametersJson: JSON.stringify({
            ...transport.iceParameters,
            usernameFragment: "restarted",
          }),
        };
      },
      publish: (req) => {
        this.guard("publish", req);
        const room = this.requireRoom(req.sessionId);
        const transport = room.transports.get(req.transportId);
        if (!transport) throw new ConnectError("transport not found", Code.NotFound);
        if (transport.participantId !== req.participantId) {
          throw new ConnectError("not your transport", Code.PermissionDenied);
        }
        if (transport.direction !== TransportDirection.SEND) {
          throw new ConnectError("wrong direction", Code.FailedPrecondition);
        }
        const n = ++this.counters.p;
        const producer: FakeProducer = {
          id: `p${n}`,
          trackId: `trk${n}`,
          participantId: req.participantId,
          transportId: req.transportId,
          kind: req.kind,
          source: req.source,
          paused: req.paused,
          layerCount: req.kind === MediaKind.VIDEO ? 3 : 1,
        };
        room.producers.set(producer.id, producer);
        return {
          producerId: producer.id,
          trackId: producer.trackId,
          layerCount: producer.layerCount,
        };
      },
      unpublish: (req) => {
        this.guard("unpublish", req);
        const { room, producer } = this.findProducer(req.producerId);
        room.producers.delete(producer.id);
        for (const [id, c] of room.consumers)
          if (c.producerId === producer.id) room.consumers.delete(id);
        return {};
      },
      setProducerPaused: (req) => {
        this.guard("setProducerPaused", req);
        this.findProducer(req.producerId).producer.paused = req.paused;
        return {};
      },
      subscribe: (req) => {
        this.guard("subscribe", req);
        const room = this.requireRoom(req.sessionId);
        const transport = room.transports.get(req.transportId);
        if (!transport) throw new ConnectError("transport not found", Code.NotFound);
        if (transport.direction !== TransportDirection.RECV) {
          throw new ConnectError("wrong direction", Code.FailedPrecondition);
        }
        const producer = room.producers.get(req.producerId);
        if (!producer) throw new ConnectError("producer not found", Code.NotFound);
        const n = ++this.counters.c;
        const consumer: FakeConsumer = {
          id: `c${n}`,
          producerId: producer.id,
          participantId: req.participantId,
          transportId: req.transportId,
          paused: true,
          preferredSpatialLayer: req.maxSpatialLayer,
          priority: req.priority ?? 1,
        };
        room.consumers.set(consumer.id, consumer);
        return {
          consumerId: consumer.id,
          kind: producer.kind,
          rtpParametersJson: JSON.stringify({ codecs: [], encodings: [{ ssrc: 5_000_000 + n }] }),
          producerPaused: producer.paused,
        };
      },
      setConsumerPaused: (req) => {
        this.guard("setConsumerPaused", req);
        this.findConsumer(req.consumerId).consumer.paused = req.paused;
        return {};
      },
      unsubscribe: (req) => {
        this.guard("unsubscribe", req);
        const { room, consumer } = this.findConsumer(req.consumerId);
        room.consumers.delete(consumer.id);
        return {};
      },
      setLayer: (req) => {
        this.guard("setLayer", req);
        const { consumer } = this.findConsumer(req.consumerId);
        consumer.preferredSpatialLayer = req.spatialLayer;
        if (req.priority !== undefined) consumer.priority = req.priority;
        return {};
      },
      cascade: (req) => {
        this.guard("cascade", req);
        throw new ConnectError("cascade is not implemented", Code.Unimplemented);
      },
      stats: (req, ctx) => this.statsStream(req, ctx),
    });
  }
}
