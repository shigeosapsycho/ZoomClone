import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiError,
  JoinRequestSchema,
  JoinResponseSchema,
  normalizeMeetingCode,
} from "@zoomclone/protocol";

/** Spec 5.1 POST /join. Registered with prefix /v1. Bearer is optional (guests). */
export const joinRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { join, limiters, metrics, clock } = app.deps;

  r.post(
    "/join",
    { schema: { body: JoinRequestSchema, response: { 200: JoinResponseSchema } } },
    async (req) => {
      const started = process.hrtime.bigint();
      try {
        const now = clock().getTime();
        const byIp = limiters.ip.hit(req.ip, now);
        if (!byIp.allowed) {
          throw new ApiError("RATE_LIMITED", "too many join attempts", byIp.retryAfterSeconds);
        }
        const codeKey = normalizeMeetingCode(req.body.code) ?? req.body.code.trim().toLowerCase();
        const byCode = limiters.code.hit(codeKey, now);
        if (!byCode.allowed) {
          throw new ApiError(
            "RATE_LIMITED",
            "too many join attempts for this code",
            byCode.retryAfterSeconds,
          );
        }
        const grant = await join.join(req.body, req.user);
        metrics.joinLatency.observe(Number(process.hrtime.bigint() - started) / 1e9);
        return grant;
      } catch (err) {
        if (err instanceof ApiError) metrics.joinErrors.inc({ code: err.code });
        throw err;
      }
    },
  );
};
