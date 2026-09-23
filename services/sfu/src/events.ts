/** Everything a room reports to its Stats subscribers (design doc "StatsEvent"). */
export type RoomEvent =
  | {
      type: "dominant_speakers";
      speakers: Array<{ participantId: string; producerId: string; volume: number }>;
    }
  | { type: "silence" }
  | {
      type: "consumer_layers";
      consumerId: string;
      active: boolean;
      spatialLayer: number;
      temporalLayer: number;
    }
  | { type: "producer_score"; producerId: string; score: number }
  | { type: "producer_closed"; producerId: string; trackId: string; participantId: string }
  | {
      type: "consumer_closed";
      consumerId: string;
      reason: "producerclose" | "transportclose" | "unsubscribed";
    }
  | { type: "ice_state"; transportId: string; participantId: string; state: string }
  | { type: "transport_closed"; transportId: string; participantId: string; reason: string }
  | {
      type: "qos";
      transportId: string;
      participantId: string;
      bytesSent: number;
      bytesReceived: number;
      sendBitrate: number;
      recvBitrate: number;
      availableOutgoingBitrate: number;
      rtpPacketLossSent: number;
      rtpPacketLossReceived: number;
    }
  | { type: "room_closed" };

/** Buffered events per subscriber before the stream is cut; the proto's Stats comment quotes it. */
export const MAX_QUEUED_EVENTS = 4096;

export type EventQueueOptions = {
  /** Backlog limit; the queue ends itself instead of growing past it. Default MAX_QUEUED_EVENTS. */
  maxSize?: number;
  /** Called once, when the limit is hit, before the queue ends. */
  onOverflow?: () => void;
};

/**
 * One subscriber's buffer. push() never blocks the emitter; drain() yields in order until end().
 * A subscriber that falls more than maxSize behind loses its backlog and its stream ends cleanly,
 * so it reopens and treats the fresh snapshot as the truth instead of consuming unbounded memory.
 */
export class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly maxSize: number;
  private readonly onOverflow: (() => void) | undefined;
  private waiter: (() => void) | null = null;
  private done = false;

  constructor({ maxSize = MAX_QUEUED_EVENTS, onOverflow }: EventQueueOptions = {}) {
    this.maxSize = maxSize;
    this.onOverflow = onOverflow;
  }

  push(item: T): void {
    if (this.done) return;
    if (this.items.length >= this.maxSize) {
      this.items.length = 0;
      this.onOverflow?.();
      this.end();
      return;
    }
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.done = true;
    this.wake();
  }

  get ended(): boolean {
    return this.done;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *drain(signal?: AbortSignal): AsyncGenerator<T, void, undefined> {
    const onAbort = () => this.end();
    if (signal?.aborted) this.end();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const next = this.items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (this.done) return;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.done = true;
    }
  }
}
