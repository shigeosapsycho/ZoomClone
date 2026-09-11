import type { types as ms } from "mediasoup";
import { MEDIA_CODECS } from "./codecs";
import type { Env } from "./env";
import { SfuError, guarded } from "./errors";
import { EventQueue, type RoomEvent } from "./events";
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

export type RoomSnapshot = {
  transports: Array<{
    transportId: string;
    participantId: string;
    direction: Direction;
    iceState: string;
    dtlsState: string;
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

export type RoomOptions = {
  sfuId: string;
  audioLevelIntervalMs: number;
  qosIntervalMs: number;
  initialAvailableOutgoingBitrate: number;
};

export function roomOptionsFrom(env: Env): RoomOptions {
  return {
    sfuId: env.SFU_ID,
    audioLevelIntervalMs: env.SFU_AUDIO_LEVEL_INTERVAL_MS,
    qosIntervalMs: env.SFU_QOS_INTERVAL_MS,
    initialAvailableOutgoingBitrate: env.SFU_INITIAL_OUTGOING_BITRATE,
  };
}

export class Room {
  readonly transports = new Map<string, TransportEntry>();
  readonly producers = new Map<string, ProducerEntry>();
  readonly consumers = new Map<string, ConsumerEntry>();
  private readonly queues = new Set<EventQueue<RoomEvent>>();
  private readonly qosTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly sessionId: string,
    readonly slot: WorkerSlot,
    readonly router: ms.Router,
    readonly audioLevelObserver: ms.AudioLevelObserver,
    readonly options: RoomOptions,
  ) {
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

  // ---- media (Task 3 adds publish/subscribe methods here) ----

  // ---- snapshot, events, lifecycle ----

  snapshot(): RoomSnapshot {
    return {
      transports: [...this.transports].map(([transportId, t]) => ({
        transportId,
        participantId: t.participantId,
        direction: t.direction,
        iceState: t.transport.iceState,
        dtlsState: t.transport.dtlsState,
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

  /** Live event stream for one subscriber; ends on room close or when the signal aborts. */
  async *events(signal?: AbortSignal): AsyncGenerator<RoomEvent, void, undefined> {
    const queue = new EventQueue<RoomEvent>();
    this.queues.add(queue);
    if (this.closed) queue.end();
    try {
      yield* queue.drain(signal);
    } finally {
      this.queues.delete(queue);
    }
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
    const audioLevelObserver = await guarded(() =>
      router.createAudioLevelObserver({
        maxEntries: 5,
        threshold: -60,
        interval: this.options.audioLevelIntervalMs,
      }),
    );
    slot.rooms += 1;
    const room = new Room(sessionId, slot, router, audioLevelObserver, this.options);
    this.roomsById.set(sessionId, room);
    return room;
  }

  async close(sessionId: string): Promise<void> {
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

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.roomsById.keys()]) await this.close(sessionId);
  }
}
