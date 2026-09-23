import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testRedisUrl } from "../test/helpers";
import { RoomStateReader } from "./room-state";

const sid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11";
let redis: Redis;

beforeAll(() => {
  redis = new Redis(testRedisUrl());
});
beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await redis.quit();
});

describe("RoomStateReader", () => {
  it("returns null when the room has no checkpoint", async () => {
    expect(await new RoomStateReader(redis).read(sid)).toBeNull();
  });

  it("reads status, end reason, lock and roster size from the spec 4.2 keys", async () => {
    await redis.hset(`{room:${sid}}:meta`, {
      status: "live",
      locked: "true",
      home_sfu: "sfu-local-1",
    });
    await redis.hset(`{room:${sid}}:roster`, { p1: "{}", p2: "{}" });
    expect(await new RoomStateReader(redis).read(sid)).toEqual({
      status: "live",
      endReason: null,
      locked: true,
      rosterSize: 2,
    });
    await redis.hset(`{room:${sid}}:meta`, {
      status: "ended",
      end_reason: "host_end",
      locked: "false",
    });
    expect(await new RoomStateReader(redis).read(sid)).toMatchObject({
      status: "ended",
      endReason: "host_end",
      locked: false,
    });
  });
});
