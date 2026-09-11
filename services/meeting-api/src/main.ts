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

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await redis.quit();
  await db.end();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: env.MEETING_API_PORT, host: "0.0.0.0" });
app.log.info({ devIssuer: env.AUTH_DEV_ISSUER, kid: keys.kid }, "meeting-api listening");
