import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { ApiError } from "@zoomclone/protocol";

/** Every error leaves as { error: { code, message, details? } }. Internal details never leak. */
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError) {
    if (error.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(error.retryAfterSeconds));
    }
    return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return reply.status(400).send({
      error: {
        code: "VALIDATION",
        message: "request validation failed",
        details: error.validation,
      },
    });
  }
  if (isResponseSerializationError(error)) {
    request.log.error(error, "response serialization failed");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "internal error" } });
  }
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  if (status >= 500) {
    request.log.error(error);
    return reply.status(status).send({ error: { code: "INTERNAL", message: "internal error" } });
  }
  const code = status === 404 ? "NOT_FOUND" : status === 401 ? "UNAUTHORIZED" : "VALIDATION";
  return reply.status(status).send({ error: { code, message: error.message } });
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({ error: { code: "NOT_FOUND", message: "route not found" } });
}
