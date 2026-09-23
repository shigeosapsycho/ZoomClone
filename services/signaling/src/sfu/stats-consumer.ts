import type { Client } from "@connectrpc/connect";
import type { SfuService, Snapshot, StatsEvent } from "@zoomclone/sfu-proto";
import type { Logger } from "pino";
import { describeSfuError } from "./codec";

export type StatsHandlers = {
  /** Runs before every open (the controller's idempotent AllocateRoom, so a lost room is recreated). */
  beforeOpen?: () => Promise<void>;
  onSnapshot: (snapshot: Snapshot) => void;
  onEvent: (event: StatsEvent) => void;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Consumes the SFU Stats stream for one room with reconnect (design doc "sfu-client/"): every
 * open yields a snapshot first, which the controller reconciles both ways, then live events.
 */
export class StatsConsumer {
  readonly done: Promise<void>;
  private readonly abort = new AbortController();
  private stopped = false;
  private firstSnapshot: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private resolveDone!: () => void;

  constructor(
    private readonly client: Client<typeof SfuService>,
    private readonly sessionId: string,
    private readonly handlers: StatsHandlers,
    private readonly log: Logger,
    private readonly retryMs = 1000,
  ) {
    this.done = new Promise<void>((resolve) => (this.resolveDone = resolve));
  }

  /** Resolves once the first snapshot has been handled; rejects after timeoutMs without one. */
  start(timeoutMs = 5000): Promise<void> {
    const first = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firstSnapshot = null;
        reject(new Error(`no stats snapshot for ${this.sessionId} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.firstSnapshot = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    void this.run();
    return first;
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.firstSnapshot?.reject(new Error("stats consumer stopped"));
    this.firstSnapshot = null;
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopped) {
        try {
          await this.handlers.beforeOpen?.();
          for await (const event of this.client.stats(
            { sessionId: this.sessionId },
            { signal: this.abort.signal },
          )) {
            if (event.event.case === "snapshot") {
              this.handlers.onSnapshot(event.event.value);
              this.firstSnapshot?.resolve();
              this.firstSnapshot = null;
            } else {
              this.handlers.onEvent(event);
            }
          }
          if (!this.stopped)
            this.log.warn({ sessionId: this.sessionId }, "stats stream ended, reopening");
        } catch (error) {
          if (this.stopped) return;
          this.log.warn(
            { sessionId: this.sessionId, error: describeSfuError(error) },
            "stats stream failed, retrying",
          );
        }
        if (this.stopped) return;
        await sleep(this.retryMs, this.abort.signal);
      }
    } finally {
      this.resolveDone();
    }
  }
}
