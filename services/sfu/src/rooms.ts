import { randomUUID } from "node:crypto";
import type { types as ms } from "mediasoup";
import type { Logger } from "pino";
import { MEDIA_CODECS } from "./codecs";
import type { Env } from "./env";
import { SfuError, guarded } from "./errors";
import { EventQueue, MAX_QUEUED_EVENTS, type RoomEvent } from "./events";
import { pickWorker, type WorkerSlot } from "./workers";

export type Direction = "send" | "recv";
export type Kind = "audio" | "video";
export type Source = "mic" | "camera" | "screen" | "screen_audio";

/** appData on every producer; lets a restarted controller rebuild its bindings from a snapshot. */
export type EntityMeta = {
  sfuId: string;
  sessionId: string;
  participantId: string;
  trackId: string;
  kind: Kind;
  source: Source;
  origin: "local" | "pipe";
};

export type TransportEntry = {
  transport: ms.WebRtcTransport;
  participantId: string;
  direction: Direction;
};
export type ProducerEntry = {
  producer: ms.Producer;
  meta: EntityMeta;
  transportId: string;
  layerCount: number;
};
export type ConsumerEntry = {
  consumer: ms.Consumer;
  participantId: string;
  transportId: string;
  producerId: string;
};

export type TransportParams = {
  transportId: string;
  iceParameters: ms.IceParameters;
  iceCandidates: ms.IceCandidate[];
  dtlsParameters: ms.DtlsParameters;
};

export type PublishResult = { producerId: string; trackId: string; layerCount: number };
export type SubscribeResult = {
  consumerId: string;
  kind: Kind;
  rtpParameters: ms.RtpParameters;
  producerPaused: boolean;
};

export type RoomSnapshot = {
  transports: Array<{
    transportId: string;
    participantId: string;
    direction: Direction;
    iceState: string;
    dtlsState: string;
    iceParameters: ms.IceParameters;
    iceCandidates: ms.IceCandidate[];
    dtlsParameters: ms.DtlsParameters;
  }>;
  producers: Array<{
    producerId: string;
    meta: EntityMeta;
    paused: boolean;
    layerCount: number;
    transportId: string;
  }>;
  consumers: Array<{
    consumerId: string;
    producerId: string;
    participantId: string;
    transportId: string;
    paused: boolean;
    producerPaused: boolean;
    preferredLayers: ms.ConsumerLayers | undefined;
    currentLayers: ms.ConsumerLayers | undefined;
    priority: number;
  }>;
};

/** A Stats subscription: the snapshot it starts from and the events that follow it. */
export type StatsOpening = {
  snapshot: RoomSnapshot;
  events: AsyncGenerator<RoomEvent, void, undefined>;
};

export type RoomOptions = {
  sfuId: string;
  audioLevelIntervalMs: number;
  qosIntervalMs: number;
  initialAvailableOutgoingBitrate: number;
  /** Room-level warnings (a Stats subscriber falling behind); silent when absent. */
  log?: Logger;
};

export function roomOptionsFrom(env: Env, log?: Logger): RoomOptions {
  return {
    sfuId: env.SFU_ID,
    audioLevelIntervalMs: env.SFU_AUDIO_LEVEL_INTERVAL_MS,
    qosIntervalMs: env.SFU_QOS_INTERVAL_MS,
    initialAvailableOutgoingBitrate: env.SFU_INITIAL_OUTGOING_BITRATE,
    log,
  };
}

export class Room {
  readonly transports = new Map<string, TransportEntry>();
  readonly producers = new Map<string, ProducerEntry>();
  readonly consumers = new Map<string, ConsumerEntry>();
  private readonly queues = new Set<EventQueue<RoomEvent>>();
  private readonly qosTimer: NodeJS.Timeout;
  private readonly log: Logger | undefined;
  private closed = false;

  constructor(
    readonly sessionId: string,
    readonly slot: WorkerSlot,
    readonly router: ms.Router,
    readonly audioLevelObserver: ms.AudioLevelObserver,
    readonly options: RoomOptions,
  ) {
    this.log = options.log;
    audioLevelObserver.on("volumes", (volumes) => {
      this.emit({
        type: "dominant_speakers",
        speakers: volumes.map((v) => ({
          participantId: String(v.producer.appData["participantId"] ?? ""),
          producerId: v.producer.id,
          volume: v.volume,
        })),
      });
    });
    audioLevelObserver.on("silence", () => this.emit({ type: "silence" }));
    this.qosTimer = setInterval(() => void this.sampleQos(), options.qosIntervalMs);
    this.qosTimer.unref();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Live Stats subscribers registered on this room. */
  get subscriberCount(): number {
    return this.queues.size;
  }

  // ---- transports ----

  async createTransport(participantId: string, direction: Direction): Promise<TransportParams> {
    this.assertOpen();
    const transport = await guarded(() =>
      this.router.createWebRtcTransport({
        webRtcServer: this.slot.webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: this.options.initialAvailableOutgoingBitrate,
        appData: { participantId, direction },
      }),
    );
    this.transports.set(transport.id, { transport, participantId, direction });
    transport.on("icestatechange", (state) =>
      this.emit({ type: "ice_state", transportId: transport.id, participantId, state }),
    );
    transport.on("dtlsstatechange", (state) => {
      if (state === "closed" || state === "failed") {
        this.dropTransport(transport.id, `dtls_${state}`);
      }
    });
    return {
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(transportId: string, dtlsParameters: ms.DtlsParameters): Promise<void> {
    const entry = this.requireTransport(transportId);
    await guarded(() => entry.transport.connect({ dtlsParameters }));
  }

  async restartIce(transportId: string): Promise<ms.IceParameters> {
    const entry = this.requireTransport(transportId);
    return guarded(() => entry.transport.restartIce());
  }

  async closeTransport(transportId: string): Promise<void> {
    this.requireTransport(transportId);
    this.dropTransport(transportId, "closed");
  }

  requireTransport(transportId: string): TransportEntry {
    const entry = this.transports.get(transportId);
    if (!entry) throw new SfuError("NOT_FOUND", `transport ${transportId} not found`);
    return entry;
  }

  /** Closing the mediasoup transport closes its producers and consumers, whose handlers emit their own events first. */
  private dropTransport(transportId: string, reason: string): void {
    const entry = this.transports.get(transportId);
    if (!entry) return;
    this.transports.delete(transportId);
    if (!entry.transport.closed) entry.transport.close();
    this.emit({
      type: "transport_closed",
      transportId,
      participantId: entry.participantId,
      reason,
    });
  }

  // ---- media ----

  async publish(
    participantId: string,
    transportId: string,
    kind: Kind,
    source: Source,
    rtpParameters: ms.RtpParameters,
    paused: boolean,
  ): Promise<PublishResult> {
    this.assertOpen();
    const entry = this.requireOwnedTransport(transportId, participantId, "send");
    const trackId = randomUUID();
    const meta: EntityMeta = {
      sfuId: this.options.sfuId,
      sessionId: this.sessionId,
      participantId,
      trackId,
      kind,
      source,
      origin: "local",
    };
    const producer = await guarded(() =>
      entry.transport.produce({ kind, rtpParameters, paused, appData: { ...meta } }),
    );
    const layerCount = rtpParameters.encodings?.length ?? 1;
    this.producers.set(producer.id, { producer, meta, transportId, layerCount });
    // mediasoup scores an encoding that stopped sending as 0, and browsers drop their top simulcast
    // layer whenever bandwidth dips, so the minimum would pin the event at 0; the maximum tracks
    // the best layer still flowing and only reaches 0 when nothing is.
    producer.on("score", (scores) =>
      this.emit({
        type: "producer_score",
        producerId: producer.id,
        score: scores.length ? Math.max(...scores.map((s) => s.score)) : 0,
      }),
    );
    producer.on("transportclose", () => this.dropProducer(producer.id));
    if (kind === "audio") {
      try {
        await guarded(() => this.audioLevelObserver.addProducer({ producerId: producer.id }));
      } catch (error) {
        // Roll back: the caller never learned this producer's id, so leave no trace and no event.
        producer.close();
        this.producers.delete(producer.id);
        throw error;
      }
    }
    return { producerId: producer.id, trackId, layerCount };
  }

  async unpublish(producerId: string): Promise<void> {
    const entry = this.requireProducer(producerId);
    entry.producer.close();
    this.dropProducer(producerId);
  }

  async setProducerPaused(producerId: string, paused: boolean): Promise<void> {
    const entry = this.requireProducer(producerId);
    await guarded(() => (paused ? entry.producer.pause() : entry.producer.resume()));
  }

  async subscribe(
    participantId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: ms.RtpCapabilities,
    maxSpatialLayer?: number,
    priority?: number,
  ): Promise<SubscribeResult> {
    this.assertOpen();
    const entry = this.requireOwnedTransport(transportId, participantId, "recv");
    this.requireProducer(producerId);
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new SfuError("FAILED_PRECONDITION", "rtp capabilities cannot consume this producer");
    }
    const consumer = await guarded(() =>
      entry.transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
        preferredLayers:
          maxSpatialLayer === undefined ? undefined : { spatialLayer: maxSpatialLayer },
        appData: { participantId, producerId },
      }),
    );
    // Register and wire the consumer before setPriority so a rejection below has something to
    // roll back cleanly, rather than leaving a mediasoup consumer alive but untracked.
    this.consumers.set(consumer.id, { consumer, participantId, transportId, producerId });
    consumer.on("layerschange", (layers) =>
      this.emit({
        type: "consumer_layers",
        consumerId: consumer.id,
        active: layers !== undefined,
        spatialLayer: layers?.spatialLayer ?? 0,
        temporalLayer: layers?.temporalLayer ?? 0,
      }),
    );
    consumer.on("producerclose", () => this.dropConsumer(consumer.id, "producerclose"));
    consumer.on("transportclose", () => this.dropConsumer(consumer.id, "transportclose"));
    if (priority !== undefined) {
      try {
        await guarded(() => consumer.setPriority(priority));
      } catch (error) {
        // Roll back: the caller never learned this consumer's id, so leave no trace and no event.
        consumer.close();
        this.consumers.delete(consumer.id);
        throw error;
      }
    }
    return {
      consumerId: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerPaused: consumer.producerPaused,
    };
  }

  async setConsumerPaused(consumerId: string, paused: boolean): Promise<void> {
    const entry = this.requireConsumer(consumerId);
    await guarded(() => (paused ? entry.consumer.pause() : entry.consumer.resume()));
  }

  async unsubscribe(consumerId: string): Promise<void> {
    const entry = this.requireConsumer(consumerId);
    entry.consumer.close();
    this.dropConsumer(consumerId, "unsubscribed");
  }

  async setLayer(
    consumerId: string,
    spatialLayer: number,
    temporalLayer?: number,
    priority?: number,
  ): Promise<void> {
    const entry = this.requireConsumer(consumerId);
    await guarded(() => entry.consumer.setPreferredLayers({ spatialLayer, temporalLayer }));
    if (priority !== undefined) await guarded(() => entry.consumer.setPriority(priority));
  }

  requireProducer(producerId: string): ProducerEntry {
    const entry = this.producers.get(producerId);
    if (!entry) throw new SfuError("NOT_FOUND", `producer ${producerId} not found`);
    return entry;
  }

  requireConsumer(consumerId: string): ConsumerEntry {
    const entry = this.consumers.get(consumerId);
    if (!entry) throw new SfuError("NOT_FOUND", `consumer ${consumerId} not found`);
    return entry;
  }

  requireOwnedTransport(
    transportId: string,
    participantId: string,
    direction: Direction,
  ): TransportEntry {
    const entry = this.requireTransport(transportId);
    if (entry.participantId !== participantId) {
      throw new SfuError("PERMISSION_DENIED", "transport belongs to another participant");
    }
    if (entry.direction !== direction) {
      throw new SfuError("FAILED_PRECONDITION", `operation needs a ${direction} transport`);
    }
    return entry;
  }

  private dropProducer(producerId: string): void {
    const entry = this.producers.get(producerId);
    if (!entry) return;
    this.producers.delete(producerId);
    this.emit({
      type: "producer_closed",
      producerId,
      trackId: entry.meta.trackId,
      participantId: entry.meta.participantId,
    });
  }

  private dropConsumer(
    consumerId: string,
    reason: "producerclose" | "transportclose" | "unsubscribed",
  ): void {
    if (!this.consumers.delete(consumerId)) return;
    this.emit({ type: "consumer_closed", consumerId, reason });
  }

  // ---- snapshot, events, lifecycle ----

  snapshot(): RoomSnapshot {
    return {
      transports: [...this.transports].map(([transportId, t]) => ({
        transportId,
        participantId: t.participantId,
        direction: t.direction,
        iceState: t.transport.iceState,
        dtlsState: t.transport.dtlsState,
        iceParameters: t.transport.iceParameters,
        iceCandidates: t.transport.iceCandidates,
        dtlsParameters: t.transport.dtlsParameters,
      })),
      producers: [...this.producers].map(([producerId, p]) => ({
        producerId,
        meta: p.meta,
        paused: p.producer.paused,
        layerCount: p.layerCount,
        transportId: p.transportId,
      })),
      consumers: [...this.consumers].map(([consumerId, c]) => ({
        consumerId,
        producerId: c.producerId,
        participantId: c.participantId,
        transportId: c.transportId,
        paused: c.consumer.paused,
        producerPaused: c.consumer.producerPaused,
        preferredLayers: c.consumer.preferredLayers,
        currentLayers: c.consumer.currentLayers,
        priority: c.consumer.priority,
      })),
    };
  }

  /**
   * Registers the subscriber before taking the snapshot, so nothing emitted after the snapshot
   * is lost: events land in the queue and drain after the snapshot has been sent. The generator
   * body only runs on the first pull, so abort and overflow unregister the queue from here rather
   * than from inside it: a subscriber that aborts before ever pulling still goes away.
   */
  openStats(signal?: AbortSignal): StatsOpening {
    const queue: EventQueue<RoomEvent> = new EventQueue({
      maxSize: MAX_QUEUED_EVENTS,
      onOverflow: () => {
        this.queues.delete(queue);
        this.log?.warn(
          { sessionId: this.sessionId, maxQueuedEvents: MAX_QUEUED_EVENTS },
          "stats subscriber fell behind, ending its stream",
        );
      },
    });
    const unregister = () => {
      this.queues.delete(queue);
      queue.end();
    };
    if (this.closed) queue.end();
    else this.queues.add(queue);
    const snapshot = this.snapshot();
    if (signal?.aborted) unregister();
    else signal?.addEventListener("abort", unregister, { once: true });
    const events = (async function* () {
      try {
        yield* queue.drain(signal);
      } finally {
        signal?.removeEventListener("abort", unregister);
        unregister();
      }
    })();
    return { snapshot, events };
  }

  /** Live event stream for one subscriber; ends on room close, overflow, or abort. */
  events(signal?: AbortSignal): AsyncGenerator<RoomEvent, void, undefined> {
    return this.openStats(signal).events;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.qosTimer);
    this.router.close();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
    this.slot.rooms -= 1;
    this.emit({ type: "room_closed" });
    for (const queue of this.queues) queue.end();
    this.queues.clear();
  }

  private emit(event: RoomEvent): void {
    if (this.closed && event.type !== "room_closed") return;
    for (const queue of this.queues) queue.push(event);
  }

  private assertOpen(): void {
    if (this.closed) throw new SfuError("FAILED_PRECONDITION", `room ${this.sessionId} is closed`);
  }

  private async sampleQos(): Promise<void> {
    if (this.closed || this.queues.size === 0) return;
    for (const [transportId, entry] of this.transports) {
      try {
        const [stats] = await entry.transport.getStats();
        if (!stats) continue;
        this.emit({
          type: "qos",
          transportId,
          participantId: entry.participantId,
          bytesSent: stats.bytesSent,
          bytesReceived: stats.bytesReceived,
          sendBitrate: stats.sendBitrate,
          recvBitrate: stats.recvBitrate,
          availableOutgoingBitrate: stats.availableOutgoingBitrate ?? 0,
          rtpPacketLossSent: stats.rtpPacketLossSent ?? 0,
          rtpPacketLossReceived: stats.rtpPacketLossReceived ?? 0,
        });
      } catch {
        // transport closed between the loop and getStats; its close event already fired
      }
    }
  }
}

export class RoomManager {
  private readonly roomsById = new Map<string, Room>();
  private readonly pending = new Map<string, Promise<Room>>();

  constructor(
    private readonly slots: WorkerSlot[],
    private readonly options: RoomOptions,
  ) {}

  get sfuId(): string {
    return this.options.sfuId;
  }

  get size(): number {
    return this.roomsById.size;
  }

  rooms(): IterableIterator<Room> {
    return this.roomsById.values();
  }

  get(sessionId: string): Room | undefined {
    return this.roomsById.get(sessionId);
  }

  require(sessionId: string): Room {
    const room = this.roomsById.get(sessionId);
    if (!room) throw new SfuError("NOT_FOUND", `room ${sessionId} not found`);
    return room;
  }

  /** Idempotent, including under concurrent calls: a second allocate awaits the first. */
  async allocate(sessionId: string): Promise<Room> {
    const existing = this.roomsById.get(sessionId);
    if (existing) return existing;
    const inFlight = this.pending.get(sessionId);
    if (inFlight) return inFlight;
    const creation = this.createRoom(sessionId).finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, creation);
    return creation;
  }

  private async createRoom(sessionId: string): Promise<Room> {
    const slot = pickWorker(this.slots);
    const router = await guarded(() =>
      slot.worker.createRouter({ mediaCodecs: MEDIA_CODECS, appData: { sessionId } }),
    );
    let audioLevelObserver: ms.AudioLevelObserver;
    try {
      audioLevelObserver = await guarded(() =>
        router.createAudioLevelObserver({
          maxEntries: 5,
          threshold: -60,
          interval: this.options.audioLevelIntervalMs,
        }),
      );
    } catch (error) {
      router.close(); // nobody holds the router yet; do not leak it on the worker
      throw error;
    }
    slot.rooms += 1;
    const room = new Room(sessionId, slot, router, audioLevelObserver, this.options);
    this.roomsById.set(sessionId, room);
    return room;
  }

  /** Closes the room; an allocation still in flight for this id is awaited so it cannot survive. */
  async close(sessionId: string): Promise<void> {
    const inFlight = this.pending.get(sessionId);
    if (inFlight) await inFlight.catch(() => undefined);
    this.dropRoom(sessionId);
  }

  /**
   * Closes every allocated room now, synchronously; nothing is awaited so callers can run it
   * inside a signal handler before mediasoup's own handlers close the workers. Allocations still
   * in flight are not covered: closeAll() awaits those.
   */
  closeAllocated(): void {
    for (const sessionId of [...this.roomsById.keys()]) this.dropRoom(sessionId);
  }

  /** closeAllocated() plus every allocation that was in flight when the call started. */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
    this.closeAllocated();
  }

  private dropRoom(sessionId: string): void {
    const room = this.roomsById.get(sessionId);
    if (!room) return;
    this.roomsById.delete(sessionId);
    room.close();
  }

  findRoomByTransport(transportId: string): Room | undefined {
    for (const room of this.roomsById.values()) if (room.transports.has(transportId)) return room;
    return undefined;
  }

  findRoomByProducer(producerId: string): Room | undefined {
    for (const room of this.roomsById.values()) if (room.producers.has(producerId)) return room;
    return undefined;
  }

  findRoomByConsumer(consumerId: string): Room | undefined {
    for (const room of this.roomsById.values()) if (room.consumers.has(consumerId)) return room;
    return undefined;
  }

  requireRoomByTransport(transportId: string): Room {
    const room = this.findRoomByTransport(transportId);
    if (!room) throw new SfuError("NOT_FOUND", `transport ${transportId} not found`);
    return room;
  }

  requireRoomByProducer(producerId: string): Room {
    const room = this.findRoomByProducer(producerId);
    if (!room) throw new SfuError("NOT_FOUND", `producer ${producerId} not found`);
    return room;
  }

  requireRoomByConsumer(consumerId: string): Room {
    const room = this.findRoomByConsumer(consumerId);
    if (!room) throw new SfuError("NOT_FOUND", `consumer ${consumerId} not found`);
    return room;
  }

  /** Publish with the cross-room check: a transport in another room is PERMISSION_DENIED. */
  async publish(
    sessionId: string,
    participantId: string,
    transportId: string,
    kind: Kind,
    source: Source,
    rtpParameters: ms.RtpParameters,
    paused: boolean,
  ): Promise<PublishResult> {
    const room = this.require(sessionId);
    this.assertTransportNotElsewhere(room, transportId);
    return room.publish(participantId, transportId, kind, source, rtpParameters, paused);
  }

  /** Subscribe with the cross-room checks: another room's transport or producer is denied. */
  async subscribe(
    sessionId: string,
    participantId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: ms.RtpCapabilities,
    maxSpatialLayer?: number,
    priority?: number,
  ): Promise<SubscribeResult> {
    const room = this.require(sessionId);
    // Check the transport first so a wrong-direction transport still fails FAILED_PRECONDITION
    // even when the producer id also belongs to another room.
    this.assertTransportNotElsewhere(room, transportId);
    room.requireOwnedTransport(transportId, participantId, "recv");
    if (!room.producers.has(producerId) && this.findRoomByProducer(producerId)) {
      throw new SfuError("PERMISSION_DENIED", "producer belongs to another room");
    }
    return room.subscribe(
      participantId,
      transportId,
      producerId,
      rtpCapabilities,
      maxSpatialLayer,
      priority,
    );
  }

  /** A transport id that resolves to a different room is a cross-room access, not a missing id. */
  private assertTransportNotElsewhere(room: Room, transportId: string): void {
    if (room.transports.has(transportId)) return;
    const owner = this.findRoomByTransport(transportId);
    if (owner && owner !== room) {
      throw new SfuError("PERMISSION_DENIED", "transport belongs to another room");
    }
  }
}
