import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { ChainableCommander } from "ioredis";
import { z } from "zod";
import { LobbyEntrySchema, RosterEntrySchema, TrackInfoSchema } from "@zoomclone/protocol";
import type { Room } from "./room";
import type { RoomSnapshot, Section } from "./types";

export const ROOM_TTL_SECONDS = 3600;
export const ENDED_TTL_SECONDS = 60;

export type RoomKeys = {
  meta: string;
  roster: string;
  lobby: string;
  tracks: string;
  departed: string;
  seq: string;
  owner: string;
  /** Every key except the owner lease (the lease has its own ttl). */
  data: string[];
};

/** Spec 4.2 hash-tag layout so all of a room's keys share a cluster slot. */
export function roomKeys(sessionId: string): RoomKeys {
  const p = `{room:${sessionId}}`;
  const keys = {
    meta: `${p}:meta`,
    roster: `${p}:roster`,
    lobby: `${p}:lobby`,
    tracks: `${p}:tracks`,
    departed: `${p}:departed`,
    seq: `${p}:seq`,
    owner: `${p}:owner`,
  };
  return {
    ...keys,
    data: [keys.meta, keys.roster, keys.lobby, keys.tracks, keys.departed, keys.seq],
  };
}

const DepartedSchema = z.object({ reason: z.enum(["removed", "denied", "grace"]), at: z.string() });

export type LoadedRoom =
  | { kind: "none" }
  | { kind: "ended"; reason: string | null }
  | { kind: "live"; snapshot: RoomSnapshot };

export async function loadSnapshot(redis: Redis, sessionId: string): Promise<LoadedRoom> {
  const keys = roomKeys(sessionId);
  const meta = await redis.hgetall(keys.meta);
  if (Object.keys(meta).length === 0) return { kind: "none" };
  if (meta["status"] === "ended") return { kind: "ended", reason: meta["end_reason"] ?? null };
  const [roster, lobby, tracks, departed, seq] = await Promise.all([
    redis.hgetall(keys.roster),
    redis.hgetall(keys.lobby),
    redis.hgetall(keys.tracks),
    redis.hgetall(keys.departed),
    redis.get(keys.seq),
  ]);
  const parseAll = <T>(hash: Record<string, string>, schema: z.ZodType<T>): T[] =>
    Object.values(hash).map((raw) => schema.parse(JSON.parse(raw)));
  return {
    kind: "live",
    snapshot: {
      session_id: sessionId,
      home_sfu: meta["home_sfu"] ?? "",
      epoch: Number(meta["epoch"] ?? "1"),
      seq: Number(seq ?? "0"),
      status: "live",
      end_reason: null,
      locked: meta["locked"] === "true",
      lobby_enabled: meta["lobby_enabled"] === "true",
      recording: meta["recording"] === "true",
      max_participants: Number(meta["max_participants"] ?? "500"),
      host_ids: JSON.parse(meta["host_ids"] ?? "[]") as string[],
      peak: Number(meta["peak"] ?? "0"),
      roster: parseAll(roster, RosterEntrySchema),
      lobby: parseAll(lobby, LobbyEntrySchema),
      tracks: parseAll(tracks, TrackInfoSchema),
      departed: Object.fromEntries(
        Object.entries(departed).map(([id, raw]) => [id, DepartedSchema.parse(JSON.parse(raw))]),
      ),
    },
  };
}

function metaFields(s: RoomSnapshot): Record<string, string> {
  const fields: Record<string, string> = {
    status: s.status,
    home_sfu: s.home_sfu,
    host_ids: JSON.stringify(s.host_ids),
    locked: String(s.locked),
    lobby_enabled: String(s.lobby_enabled),
    recording: String(s.recording),
    epoch: String(s.epoch),
    peak: String(s.peak),
    max_participants: String(s.max_participants),
    session_id: s.session_id,
  };
  if (s.end_reason !== null) fields["end_reason"] = s.end_reason;
  return fields;
}

function rewriteHash(
  multi: ChainableCommander,
  key: string,
  entries: Record<string, string>,
): void {
  multi.del(key);
  if (Object.keys(entries).length > 0) multi.hset(key, entries);
}

export type CheckpointOptions = {
  windowMs: number;
  ttlSeconds?: number;
  onLag?: (ms: number) => void;
  onError?: (error: unknown) => void;
};

/**
 * Write-behind checkpoint (design doc "room/checkpoint.ts"): schedule() coalesces changes for
 * windowMs, then one MULTI rewrites the dirty sections plus seq and refreshes every ttl. Writes
 * are chained so two flushes never interleave. After markEnded nothing is written again.
 */
export class Checkpoint {
  private timer: NodeJS.Timeout | null = null;
  private scheduledAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly keys: RoomKeys;
  private readonly ttl: number;

  constructor(
    private readonly redis: Redis,
    private readonly room: Room,
    private readonly opts: CheckpointOptions,
  ) {
    this.keys = roomKeys(room.sessionId);
    this.ttl = opts.ttlSeconds ?? ROOM_TTL_SECONDS;
  }

  schedule(): void {
    if (this.stopped || this.timer) return;
    this.scheduledAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.windowMs);
  }

  flush(): Promise<void> {
    this.chain = this.chain
      .then(() => this.write(this.room.takeDirty()))
      .catch((error: unknown) => this.opts.onError?.(error));
    return this.chain;
  }

  writeAll(): Promise<void> {
    this.room.markAllDirty();
    return this.flush();
  }

  async refreshTtl(): Promise<void> {
    if (this.stopped) return;
    const pipeline = this.redis.pipeline();
    for (const key of this.keys.data) pipeline.expire(key, this.ttl);
    await pipeline.exec();
  }

  /** Terminal write: only meta survives, for 60 s, so /join never reuses a dying session. */
  async markEnded(reason: string): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.chain.catch(() => undefined);
    const multi = this.redis.multi();
    multi.hset(this.keys.meta, { status: "ended", end_reason: reason });
    multi.del(
      this.keys.roster,
      this.keys.lobby,
      this.keys.tracks,
      this.keys.departed,
      this.keys.seq,
    );
    multi.expire(this.keys.meta, ENDED_TTL_SECONDS);
    await multi.exec();
  }

  /** Final flush of whatever is dirty (graceful shutdown keeps the room rehydratable). */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    await this.flush();
    this.stopped = true;
  }

  private async write(dirty: Set<Section>): Promise<void> {
    if (this.stopped) return;
    const s = this.room.toSnapshot();
    if (s.status === "ended") return;
    const multi = this.redis.multi();
    if (dirty.has("meta")) multi.hset(this.keys.meta, metaFields(s));
    if (dirty.has("roster"))
      rewriteHash(
        multi,
        this.keys.roster,
        toHash(s.roster, (r) => r.participant_id),
      );
    if (dirty.has("lobby"))
      rewriteHash(
        multi,
        this.keys.lobby,
        toHash(s.lobby, (l) => l.participant_id),
      );
    if (dirty.has("tracks"))
      rewriteHash(
        multi,
        this.keys.tracks,
        toHash(s.tracks, (t) => t.track_id),
      );
    if (dirty.has("departed")) {
      rewriteHash(
        multi,
        this.keys.departed,
        Object.fromEntries(Object.entries(s.departed).map(([id, d]) => [id, JSON.stringify(d)])),
      );
    }
    multi.set(this.keys.seq, String(s.seq));
    for (const key of this.keys.data) multi.expire(key, this.ttl);
    await multi.exec();
    if (this.scheduledAt > 0) {
      this.opts.onLag?.(Date.now() - this.scheduledAt);
      this.scheduledAt = 0;
    }
  }
}

function toHash<T>(items: T[], key: (item: T) => string): Record<string, string> {
  return Object.fromEntries(items.map((item) => [key(item), JSON.stringify(item)]));
}

const REFRESH_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

/** Controller ownership of one room: SET NX PX, refreshed by the heartbeat (design doc). */
export class OwnerLease {
  readonly token = randomUUID();
  private readonly key: string;

  constructor(
    private readonly redis: Redis,
    sessionId: string,
    private readonly ttlMs: number,
  ) {
    this.key = roomKeys(sessionId).owner;
  }

  async acquire(): Promise<boolean> {
    const result = await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX");
    return result === "OK";
  }

  /** False when the lease expired or another controller holds it. */
  async refresh(): Promise<boolean> {
    const result = await this.redis.eval(REFRESH_LUA, 1, this.key, this.token, String(this.ttlMs));
    return result === 1;
  }

  async release(): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, this.key, this.token);
  }
}
