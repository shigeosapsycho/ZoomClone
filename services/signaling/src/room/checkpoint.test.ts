import { setTimeout as sleep } from "node:timers/promises";
import type Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, flushTestRedis } from "../../test/helpers";
import {
  Checkpoint,
  ENDED_TTL_SECONDS,
  OwnerLease,
  ROOM_TTL_SECONDS,
  loadSnapshot,
  roomKeys,
} from "./checkpoint";
import { Room } from "./room";

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const W = "44444444-4444-4444-8444-444444444444";

let redis: Redis;

beforeAll(() => {
  redis = connectRedis();
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(async () => {
  await flushTestRedis(redis);
});

function seededRoom(): Room {
  const room = Room.create({
    session_id: S,
    home_sfu: "sfu-local-1",
    lobby_enabled: true,
    max_participants: 10,
  });
  room.apply({ type: "join", participant_id: HOST, name: "Host", role: "host" });
  room.apply({ type: "join", participant_id: A, name: "Ann", role: "attendee" });
  room.apply({ type: "lobby_request", participant_id: W, name: "Wren" });
  room.apply({
    type: "publish",
    participant_id: A,
    track: { track_id: "t1", owner: A, kind: "audio", source: "mic", paused: false, layers: 1 },
  });
  return room;
}

describe("Checkpoint", () => {
  it("writeAll writes the spec 4.2 layout with a one hour ttl", async () => {
    const room = seededRoom();
    const checkpoint = new Checkpoint(redis, room, { windowMs: 20 });
    await checkpoint.writeAll();
    const keys = roomKeys(S);
    expect(keys.meta).toBe(`{room:${S}}:meta`);
    const meta = await redis.hgetall(keys.meta);
    expect(meta).toEqual({
      status: "live",
      home_sfu: "sfu-local-1",
      host_ids: JSON.stringify([HOST]),
      locked: "false",
      lobby_enabled: "true",
      recording: "false",
      epoch: "1",
      peak: "2",
      max_participants: "10",
      session_id: S,
    });
    expect(await redis.hlen(keys.roster)).toBe(2);
    expect(JSON.parse((await redis.hget(keys.roster, A)) ?? "null")).toMatchObject({
      name: "Ann",
      role: "attendee",
    });
    expect(JSON.parse((await redis.hget(keys.lobby, W)) ?? "null")).toMatchObject({ name: "Wren" });
    expect(JSON.parse((await redis.hget(keys.tracks, "t1")) ?? "null")).toMatchObject({ owner: A });
    expect(await redis.get(keys.seq)).toBe(String(room.seq));
    for (const key of [keys.meta, keys.roster, keys.lobby, keys.tracks, keys.seq]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(ROOM_TTL_SECONDS - 100);
      expect(ttl).toBeLessThanOrEqual(ROOM_TTL_SECONDS);
    }
    expect(await redis.exists(keys.departed)).toBe(0);
    await checkpoint.stop();
  });

  it("schedule coalesces within the window and rewrites only dirty sections", async () => {
    const room = seededRoom();
    const lags: number[] = [];
    const checkpoint = new Checkpoint(redis, room, { windowMs: 20, onLag: (ms) => lags.push(ms) });
    await checkpoint.writeAll();
    const keys = roomKeys(S);
    await redis.del(keys.tracks);
    room.apply({ type: "hand", participant_id: A, raised: true });
    checkpoint.schedule();
    room.apply({ type: "lobby_leave", participant_id: W });
    checkpoint.schedule();
    await sleep(80);
    expect(lags).toHaveLength(1);
    expect(JSON.parse((await redis.hget(keys.roster, A)) ?? "null")).toMatchObject({ hand: true });
    expect(await redis.exists(keys.lobby)).toBe(0);
    expect(await redis.exists(keys.tracks)).toBe(0);
    expect(await redis.get(keys.seq)).toBe(String(room.seq));
    await checkpoint.stop();
  });

  it("loadSnapshot round-trips a live room and reports ended rooms", async () => {
    const room = seededRoom();
    room.apply({ type: "remove", actor: HOST, participant_id: A });
    const checkpoint = new Checkpoint(redis, room, { windowMs: 20 });
    expect(await loadSnapshot(redis, S)).toEqual({ kind: "none" });
    await checkpoint.writeAll();
    const loaded = await loadSnapshot(redis, S);
    expect(loaded.kind).toBe("live");
    if (loaded.kind !== "live") throw new Error("expected live");
    expect(loaded.snapshot).toEqual(room.toSnapshot());
    expect(loaded.snapshot.departed[A]).toMatchObject({ reason: "removed" });

    room.apply({ type: "end", reason: "host_end" });
    await checkpoint.markEnded("host_end");
    expect(await loadSnapshot(redis, S)).toEqual({ kind: "ended", reason: "host_end" });
    const keys = roomKeys(S);
    expect(await redis.hgetall(keys.meta)).toMatchObject({
      status: "ended",
      end_reason: "host_end",
    });
    expect(await redis.exists(keys.roster, keys.lobby, keys.tracks, keys.departed, keys.seq)).toBe(
      0,
    );
    expect(await redis.ttl(keys.meta)).toBeLessThanOrEqual(ENDED_TTL_SECONDS);
    checkpoint.schedule();
    await checkpoint.flush();
    expect(await redis.exists(keys.roster)).toBe(0);
    expect(await redis.ttl(keys.meta)).toBeLessThanOrEqual(ENDED_TTL_SECONDS);
    await checkpoint.stop();
  });

  it("stop flushes pending dirty sections and refreshTtl extends every key", async () => {
    const room = seededRoom();
    const checkpoint = new Checkpoint(redis, room, { windowMs: 5_000 });
    await checkpoint.writeAll();
    const keys = roomKeys(S);
    await redis.expire(keys.roster, 10);
    await checkpoint.refreshTtl();
    expect(await redis.ttl(keys.roster)).toBeGreaterThan(ROOM_TTL_SECONDS - 100);
    room.apply({ type: "lock", actor: HOST, locked: true });
    checkpoint.schedule();
    await checkpoint.stop();
    expect((await redis.hgetall(keys.meta)).locked).toBe("true");
  });
});

describe("OwnerLease", () => {
  it("is exclusive, refreshable only by its holder, and released explicitly", async () => {
    const first = new OwnerLease(redis, S, 2_000);
    const second = new OwnerLease(redis, S, 2_000);
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(await second.refresh()).toBe(false);
    expect(await first.refresh()).toBe(true);
    const ttl = await redis.pttl(roomKeys(S).owner);
    expect(ttl).toBeGreaterThan(1_000);
    await second.release();
    expect(await redis.get(roomKeys(S).owner)).toBe(first.token);
    await first.release();
    expect(await second.acquire()).toBe(true);
    await second.release();
  });

  it("expires on its own", async () => {
    const lease = new OwnerLease(redis, S, 50);
    expect(await lease.acquire()).toBe(true);
    await sleep(120);
    expect(await lease.refresh()).toBe(false);
    expect(await new OwnerLease(redis, S, 50).acquire()).toBe(true);
  });
});
