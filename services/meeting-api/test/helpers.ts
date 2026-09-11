import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { createDb, type Db } from "@zoomclone/db";
import { ensureTestDatabase, testDatabaseUrl, truncateAll } from "@zoomclone/db/testing";
import { InMemoryEventBus } from "@zoomclone/events";
import { loadSigningKeys } from "@zoomclone/tokens";
import { buildApp, type App } from "../src/app";
import { createDeps, type AppDeps, type Infra } from "../src/deps";
import { loadEnv, type Env } from "../src/env";

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? "redis://localhost:56379/1";
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    AUTH_DEV_ISSUER: "true",
    STUN_URLS: "stun:stun.example.com:3478",
    TURN_URLS: "turn:turn.example.com:443?transport=tcp",
    TURN_SECRET: "turn-secret",
    JOIN_RATE_LIMIT: "1000",
    ...overrides,
  });
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function mintUser(
  ctx: TestContext,
  body: { sub?: string; org_id?: string; name?: string },
): Promise<{ token: string; sub: string; orgId: string }> {
  const res = await ctx.app.inject({ method: "POST", url: "/dev/oidc/token", payload: body });
  if (res.statusCode !== 200) throw new Error(`dev token failed: ${res.body}`);
  const json = res.json<{ access_token: string; sub: string; org_id: string }>();
  return { token: json.access_token, sub: json.sub, orgId: json.org_id };
}

export type TestContext = {
  app: App;
  deps: AppDeps;
  env: Env;
  db: Db;
  redis: Redis;
  close: () => Promise<void>;
};

/** Fresh app against the real test Postgres (truncated) and Redis db 1 (flushed). */
export async function createTestContext(
  envOverrides: Record<string, string> = {},
  infraOverrides: Partial<Omit<Infra, "db" | "redis" | "bus" | "keys">> = {},
): Promise<TestContext> {
  await ensureTestDatabase();
  const env = testEnv(envOverrides);
  const db = createDb(env.DATABASE_URL, { max: 10 });
  const redis = new Redis(env.REDIS_URL);
  await truncateAll(db);
  await redis.flushdb();
  const keys = await loadSigningKeys({ kid: env.SIGNING_KID });
  const deps = createDeps(env, { db, redis, bus: new InMemoryEventBus(), keys, ...infraOverrides });
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    env,
    db,
    redis,
    close: async () => {
      await app.close();
      await redis.quit();
      await db.end();
    },
  };
}

/** Simulates what /join does when a meeting goes live: one session row, meeting status live. */
export async function startSession(
  db: Db,
  meetingId: string,
  sfuId = "sfu-local-1",
): Promise<string> {
  const sessionId = randomUUID();
  await db`
    INSERT INTO meeting_sessions (id, meeting_id, started_at, home_sfu_id)
    VALUES (${sessionId}, ${meetingId}, now(), ${sfuId})`;
  await db`UPDATE meetings SET status = 'live' WHERE id = ${meetingId}`;
  return sessionId;
}
