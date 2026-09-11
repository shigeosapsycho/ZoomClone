import Redis from "ioredis";
import { loadEnv, type Env } from "../src/env";

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? "redis://localhost:56379/1";
}

/** Short timers so grace, idle, hello and ping paths run in tens of milliseconds. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      "postgres://zoomclone:zoomclone@localhost:55432/zoomclone_test",
    REDIS_URL: testRedisUrl(),
    DISCONNECT_GRACE_MS: "800",
    ROOM_IDLE_TIMEOUT_MS: "400",
    HELLO_TIMEOUT_MS: "300",
    PING_TIMEOUT_MS: "5000",
    CHECKPOINT_WINDOW_MS: "20",
    HEARTBEAT_MS: "100",
    OWNER_LEASE_MS: "2000",
    ...overrides,
  });
}

export function connectRedis(): Redis {
  return new Redis(testRedisUrl());
}

export async function flushTestRedis(redis: Redis): Promise<void> {
  await redis.flushdb();
}
