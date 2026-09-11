import { z } from "zod";

const bool = z.stringbool().default(false);
const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    MEETING_API_PORT: z.coerce.number().int().default(8080),
    LOG_LEVEL: z.string().default("info"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    TOKEN_ISSUER: z.string().default("meeting-api"),
    SIGNING_KEY_PEM: z.string().optional(),
    SIGNING_KID: z.string().default("dev-1"),
    AUTH_DEV_ISSUER: bool,
    DEV_ISSUER_URL: z.string().default("http://localhost:8080/dev/oidc"),
    OIDC_ISSUER: z.string().optional(),
    OIDC_AUDIENCE: z.string().default("zoomclone"),
    OIDC_JWKS_URL: z.string().optional(),
    DEFAULT_ORG_ID: z.uuid().default("11111111-1111-4111-8111-111111111111"),
    DEFAULT_REGION: z.string().default("local"),
    SFU_ID: z.string().default("sfu-local-1"),
    SIGNALING_PUBLIC_URL: z.string().default("ws://localhost:8081"),
    STUN_URLS: csv,
    TURN_URLS: csv,
    TURN_SECRET: z.string().optional(),
    TURN_TTL_SECONDS: z.coerce.number().int().default(3600),
    JOIN_RATE_LIMIT: z.coerce.number().int().default(10),
    JOIN_RATE_WINDOW_MS: z.coerce.number().int().default(60_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (env.AUTH_DEV_ISSUER) {
        ctx.addIssue({
          code: "custom",
          path: ["AUTH_DEV_ISSUER"],
          message: "AUTH_DEV_ISSUER must be false in production",
        });
      }
      if (!env.SIGNING_KEY_PEM) {
        ctx.addIssue({
          code: "custom",
          path: ["SIGNING_KEY_PEM"],
          message: "SIGNING_KEY_PEM is required in production",
        });
      }
    }
    if (!env.AUTH_DEV_ISSUER && (!env.OIDC_ISSUER || !env.OIDC_JWKS_URL)) {
      ctx.addIssue({
        code: "custom",
        path: ["OIDC_ISSUER"],
        message: "OIDC_ISSUER and OIDC_JWKS_URL are required unless AUTH_DEV_ISSUER=true",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
