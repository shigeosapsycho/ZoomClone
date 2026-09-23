import { availableParallelism } from "node:os";
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  SFU_ID: z.string().min(1).default("sfu-local-1"),
  SFU_GRPC_PORT: z.coerce.number().int().default(9090),
  SFU_WORKERS: z.coerce.number().int().min(1).default(availableParallelism()),
  SFU_MEDIA_PORT_BASE: z.coerce.number().int().min(1024).default(40000),
  SFU_LISTEN_IP: z.string().default("0.0.0.0"),
  SFU_ANNOUNCED_IP: z.string().default("127.0.0.1"),
  SFU_QOS_INTERVAL_MS: z.coerce.number().int().min(250).default(5000),
  SFU_AUDIO_LEVEL_INTERVAL_MS: z.coerce.number().int().min(100).default(300),
  SFU_INITIAL_OUTGOING_BITRATE: z.coerce.number().int().default(1_000_000),
  MEDIASOUP_LOG_LEVEL: z.enum(["debug", "warn", "error", "none"]).default("warn"),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
