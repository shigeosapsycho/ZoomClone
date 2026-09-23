import { z } from "zod";

const bool = z.stringbool().default(false);

/** "id=url,id=url" -> { id: url }. */
const endpoints = z
  .string()
  .default("sfu-local-1=http://localhost:9090")
  .transform((raw, ctx) => {
    const out: Record<string, string> = {};
    for (const part of raw.split(",")) {
      const entry = part.trim();
      if (!entry) continue;
      const eq = entry.indexOf("=");
      if (eq <= 0 || eq === entry.length - 1) {
        ctx.addIssue({ code: "custom", message: `SFU_ENDPOINTS entry "${entry}" is not id=url` });
        return z.NEVER;
      }
      out[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
    }
    if (Object.keys(out).length === 0) {
      ctx.addIssue({ code: "custom", message: "SFU_ENDPOINTS must list at least one SFU" });
      return z.NEVER;
    }
    return out;
  });

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.string().default("info"),
    SIGNALING_PORT: z.coerce.number().int().default(8081),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    TOKEN_ISSUER: z.string().default("meeting-api"),
    MEETING_API_JWKS_URL: z.string().default("http://localhost:8080/.well-known/jwks.json"),
    /** Where the browser client posts /v1/join (same origin the API's CORS_ORIGINS allows). */
    MEETING_API_PUBLIC_URL: z.string().default("http://localhost:8080"),
    SFU_ENDPOINTS: endpoints,
    DISCONNECT_GRACE_MS: z.coerce.number().int().min(10).default(30_000),
    ROOM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(10).default(300_000),
    HELLO_TIMEOUT_MS: z.coerce.number().int().min(10).default(5_000),
    // Three missed 10 s pings (design doc): the watchdog closes 4000 past this silence.
    PING_TIMEOUT_MS: z.coerce.number().int().min(10).default(30_000),
    CHECKPOINT_WINDOW_MS: z.coerce.number().int().min(1).default(50),
    HEARTBEAT_MS: z.coerce.number().int().min(10).default(5_000),
    OWNER_LEASE_MS: z.coerce.number().int().min(20).default(15_000),
    RING_BUFFER_SIZE: z.coerce.number().int().min(1).default(500),
    RING_BUFFER_MS: z.coerce.number().int().min(10).default(60_000),
    DEPARTED_TTL_MS: z.coerce.number().int().min(10).default(600_000),
    MAX_BUFFERED_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
    DEV_HARNESS: bool,
  })
  .superRefine((env, ctx) => {
    // The gallery is a dev page with a harness on window; production must not serve it.
    if (env.NODE_ENV === "production" && env.DEV_HARNESS) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_HARNESS"],
        message: "DEV_HARNESS must be false in production",
      });
    }
  });
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
