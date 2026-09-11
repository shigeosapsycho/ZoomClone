import Redis from "ioredis";
import pino from "pino";
import { createDb } from "@zoomclone/db";
import { InMemoryEventBus } from "@zoomclone/events";
import { createApp } from "./app";
import { loadEnv } from "./env";
import { remoteTokenVerifier } from "./gateway/auth";
import { createMetrics } from "./metrics";
import { RoomRegistry } from "./room/registry";
import { SfuDirectory } from "./sfu/directory";
import { PostgresWriter } from "./writer/postgres-writer";

const env = loadEnv();
const log = pino(
  env.NODE_ENV === "development"
    ? { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } }
    : { level: env.LOG_LEVEL },
);
const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL);
const subscriber = new Redis(env.REDIS_URL);
const bus = new InMemoryEventBus((error, event) =>
  log.error({ error, type: event.type }, "event handler failed"),
);
const metrics = createMetrics(() => registry.size);
const registry = new RoomRegistry({
  redis,
  subscriber,
  sfus: new SfuDirectory(env.SFU_ENDPOINTS),
  db,
  bus,
  log,
  timings: {
    graceMs: env.DISCONNECT_GRACE_MS,
    idleMs: env.ROOM_IDLE_TIMEOUT_MS,
    heartbeatMs: env.HEARTBEAT_MS,
    speakerTickMs: 300,
    statsRetryMs: 1000,
    checkpointWindowMs: env.CHECKPOINT_WINDOW_MS,
    leaseMs: env.OWNER_LEASE_MS,
  },
  roomOptions: {
    ringSize: env.RING_BUFFER_SIZE,
    ringMs: env.RING_BUFFER_MS,
    departedTtlMs: env.DEPARTED_TTL_MS,
  },
  metrics: metrics.forRegistry(),
});
const writer = new PostgresWriter(db, bus, log);
writer.start();
const { server, wss } = createApp({
  registry,
  verifier: remoteTokenVerifier(env.MEETING_API_JWKS_URL, env.TOKEN_ISSUER),
  env,
  log,
  metrics,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  setTimeout(() => process.exit(1), 10_000).unref();
  try {
    // Controllers flush their checkpoints and release their leases; rooms stay live in Redis so
    // the next process rehydrates them. Sockets close 1012 and clients reconnect.
    await registry.closeAll();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writer.stop();
    await subscriber.quit();
    await redis.quit();
    await db.end();
    process.exit(0);
  } catch (error) {
    log.error(error, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(env.SIGNALING_PORT, "0.0.0.0", () => {
  log.info(
    {
      port: env.SIGNALING_PORT,
      sfus: Object.keys(env.SFU_ENDPOINTS),
      jwks: env.MEETING_API_JWKS_URL,
    },
    "signaling listening",
  );
});
