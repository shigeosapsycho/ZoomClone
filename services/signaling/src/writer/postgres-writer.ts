import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import { endSession, isEndReason, type Db } from "@zoomclone/db";
import type { EventBus, EventEnvelope } from "@zoomclone/events";

export type WriterOptions = { flushMs?: number; maxAttempts?: number; retryMs?: number };

type Item =
  | EventEnvelope<"participant.joined">
  | EventEnvelope<"participant.left">
  | EventEnvelope<"session.ended">;

/**
 * Bus consumer for attendance rows (design doc "writer/PostgresWriter.ts"). Every write is
 * idempotent (at-least-once delivery), ordered per process, and never awaited on the message
 * path. A poison item is retried a bounded number of times and then dropped with an error log.
 */
export class PostgresWriter {
  private readonly queue: Item[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private readonly flushMs: number;
  private readonly maxAttempts: number;
  private readonly retryMs: number;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly log: Logger,
    opts: WriterOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 100;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.retryMs = opts.retryMs ?? 500;
  }

  get pending(): number {
    return this.queue.length;
  }

  start(): void {
    this.unsubscribers.push(
      this.bus.subscribe("participant.joined", (e) => this.enqueue(e)),
      this.bus.subscribe("participant.left", (e) => this.enqueue(e)),
      this.bus.subscribe("session.ended", (e) => this.enqueue(e)),
    );
  }

  /** Drains the queue (retries included); resolves once every queued item is written or dropped. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  private enqueue(item: Item): void {
    if (this.stopped) return;
    this.queue.push(item);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue[0]!;
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          await this.write(item);
          break;
        } catch (error) {
          if (attempt >= this.maxAttempts) {
            this.log.error(
              { error, type: item.type, key: item.key, attempt },
              "attendance write dropped",
            );
            break;
          }
          this.log.warn(
            { error, type: item.type, key: item.key, attempt },
            "attendance write failed, retrying",
          );
          await sleep(this.retryMs);
        }
      }
      this.queue.shift();
    }
  }

  private async write(item: Item): Promise<void> {
    switch (item.type) {
      case "participant.joined": {
        const p = item.payload;
        await this.db`
          INSERT INTO participants (id, session_id, user_id, display_name, role, joined_at)
          VALUES (${p.participant_id}, ${p.session_id}, ${p.user_id}, ${p.display_name}, ${p.role}, ${p.joined_at})
          ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role`;
        return;
      }
      case "participant.left": {
        const p = item.payload;
        await this.db`
          UPDATE participants SET left_at = ${p.left_at}, leave_reason = ${p.reason}
          WHERE id = ${p.participant_id} AND left_at IS NULL`;
        return;
      }
      case "session.ended": {
        const p = item.payload;
        await endSession(this.db, {
          sessionId: p.session_id,
          reason: isEndReason(p.reason) ? p.reason : "idle",
          peakParticipants: p.peak_participants,
        });
        return;
      }
    }
  }
}
