import Redis from "ioredis";
import { createDb } from "@zoomclone/db";
import { InMemoryEventBus } from "@zoomclone/events";
import { loadSigningKeys } from "@zoomclone/tokens";
import { buildApp } from "./app";
import { createDeps } from "./deps";
import { loadEnv } from "./env";
import { startSweeper } from "./rate-limit";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL);
const keys = await loadSigningKeys({ pem: env.SIGNING_KEY_PEM, kid: env.SIGNING_KID });
const bus = new InMemoryEventBus((error, event) => {
  console.error(`event handler failed for ${event.type}`, error);
});
const deps = createDeps(env, { db, redis, bus, keys });
const app = await buildApp(deps);
const stopSweeper = startSweeper([deps.limiters.ip, deps.limiters.code], env.JOIN_RATE_WINDOW_MS);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    stopSweeper();
    await app.close();
    await redis.quit();
    await db.end();
    process.exit(0);
  } catch (error) {
    app.log.error(error, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: env.MEETING_API_PORT, host: "0.0.0.0" });
app.log.info({ devIssuer: env.AUTH_DEV_ISSUER, kid: keys.kid }, "meeting-api listening");
