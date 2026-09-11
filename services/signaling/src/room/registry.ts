import type Redis from "ioredis";
import type { Logger } from "pino";
import { isEndReason, type Db, type EndReason } from "@zoomclone/db";
import type { EventBus } from "@zoomclone/events";
import type { SfuDirectory } from "../sfu/directory";
import { Checkpoint, OwnerLease, loadSnapshot } from "./checkpoint";
import { RoomController, type ControllerMetrics, type ControllerTimings } from "./controller";
import { Room, type RoomOptions } from "./room";

export class ControllerBusyError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} is owned by another controller`);
    this.name = "ControllerBusyError";
  }
}

export class RoomEndedError extends Error {
  constructor(
    sessionId: string,
    readonly reason: string | null,
  ) {
    super(`session ${sessionId} has ended`);
    this.name = "RoomEndedError";
  }
}

export type RegistrySeed = { sfu_hint: string; lobby_enabled: boolean; max_participants: number };
export type RegistryTimings = ControllerTimings & { checkpointWindowMs: number; leaseMs: number };
export type RegistryMetrics = ControllerMetrics & {
  failover(): void;
  checkpointLag(ms: number): void;
};
export type RegistryDeps = {
  redis: Redis;
  /** Dedicated connection in subscriber mode for the ctl channels. */
  subscriber: Redis;
  sfus: SfuDirectory;
  db: Db;
  bus: EventBus;
  log: Logger;
  timings: RegistryTimings;
  roomOptions: RoomOptions;
  metrics?: RegistryMetrics;
};

/** Control plane to controller channel (meeting-api's room-control.ts publishes here). */
export function ctlChannel(sessionId: string): string {
  return `room:${sessionId}:ctl`;
}
const CTL_CHANNEL = /^room:([0-9a-f-]{36}):ctl$/;

/**
 * One controller per live session in this process (design doc "room/RoomRegistry.ts"):
 * in-memory, else owner lease + Redis checkpoint rehydrate (the controller's start() reconciles
 * against the SFU snapshot), else a fresh room seeded from the hello claims.
 */
export class RoomRegistry {
  private readonly controllers = new Map<string, RoomController>();
  private readonly pending = new Map<string, Promise<RoomController>>();
  private closing = false;

  constructor(private readonly deps: RegistryDeps) {
    deps.subscriber.on("message", (channel: string, message: string) =>
      this.onCtl(channel, message),
    );
  }

  get size(): number {
    return this.controllers.size;
  }

  peek(sessionId: string): RoomController | undefined {
    return this.controllers.get(sessionId);
  }

  get(sessionId: string, seed: RegistrySeed): Promise<RoomController> {
    const existing = this.controllers.get(sessionId);
    if (existing) return Promise.resolve(existing);
    const inflight = this.pending.get(sessionId);
    if (inflight) return inflight;
    if (this.closing) return Promise.reject(new Error("registry is closing"));
    const promise = this.build(sessionId, seed).finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, promise);
    return promise;
  }

  /** Graceful shutdown: controllers flush and release without ending their rooms. */
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.controllers.values()].map((c) => c.close()));
  }

  private async build(sessionId: string, seed: RegistrySeed): Promise<RoomController> {
    const { redis, timings, log, metrics } = this.deps;
    const lease = new OwnerLease(redis, sessionId, timings.leaseMs);
    if (!(await lease.acquire())) throw new ControllerBusyError(sessionId);
    let controller: RoomController | null = null;
    try {
      const loaded = await loadSnapshot(redis, sessionId);
      if (loaded.kind === "ended") throw new RoomEndedError(sessionId, loaded.reason);
      const rehydrated = loaded.kind === "live";
      const room = rehydrated
        ? Room.fromSnapshot(loaded.snapshot, { bumpEpoch: true }, this.deps.roomOptions)
        : Room.create(
            {
              session_id: sessionId,
              home_sfu: seed.sfu_hint,
              lobby_enabled: seed.lobby_enabled,
              max_participants: seed.max_participants,
            },
            this.deps.roomOptions,
          );
      const checkpoint = new Checkpoint(redis, room, {
        windowMs: timings.checkpointWindowMs,
        onLag: (ms) => metrics?.checkpointLag(ms),
        onError: (error) => log.error({ sessionId, error }, "checkpoint write failed"),
      });
      controller = new RoomController({
        room,
        sfu: this.deps.sfus.get(room.homeSfu),
        checkpoint,
        lease,
        db: this.deps.db,
        bus: this.deps.bus,
        log,
        timings,
        metrics,
        onGone: (id) => this.drop(id),
      });
      await controller.start();
      await this.deps.subscriber.subscribe(ctlChannel(sessionId));
      this.controllers.set(sessionId, controller);
      if (rehydrated) {
        metrics?.failover();
        log.info({ sessionId, epoch: room.epoch, roster: room.roster().length }, "room rehydrated");
      } else {
        this.deps.bus.publish("room.created", sessionId, {
          session_id: sessionId,
          home_sfu: room.homeSfu,
          epoch: room.epoch,
        });
        log.info({ sessionId, homeSfu: room.homeSfu }, "room created");
      }
      return controller;
    } catch (error) {
      if (controller) await controller.close(1011, "start failed").catch(() => undefined);
      else await lease.release().catch(() => undefined);
      throw error;
    }
  }

  private drop(sessionId: string): void {
    this.controllers.delete(sessionId);
    void this.deps.subscriber
      .unsubscribe(ctlChannel(sessionId))
      .catch((error: unknown) =>
        this.deps.log.warn({ sessionId, error }, "ctl unsubscribe failed"),
      );
  }

  private onCtl(channel: string, message: string): void {
    const match = CTL_CHANNEL.exec(channel);
    if (!match) return;
    const controller = this.controllers.get(match[1]!);
    if (!controller) return;
    let command: { cmd?: unknown; reason?: unknown };
    try {
      command = JSON.parse(message) as { cmd?: unknown; reason?: unknown };
    } catch {
      this.deps.log.warn({ channel, message }, "malformed ctl message");
      return;
    }
    if (command.cmd !== "end") return;
    const reason: EndReason = isEndReason(command.reason) ? command.reason : "api_end";
    void controller.endRoom(reason);
  }
}
