import Redis from "ioredis";
import { createDb } from "@zoomclone/db";
import { InMemoryEventBus } from "@zoomclone/events";
import { loadSigningKeys } from "@zoomclone/tokens";
import { buildApp } from "./app";
import { createDeps } from "./deps";
import { loadEnv } from "./env";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL);
const keys = await loadSigningKeys({ pem: env.SIGNING_KEY_PEM, kid: env.SIGNING_KID });
const bus = new InMemoryEventBus((error, event) => {
  console.error(`event handler failed for ${event.type}`, error);
});
const app = await buildApp(createDeps(env, { db, redis, bus, keys }));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
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
