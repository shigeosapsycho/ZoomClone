import pino, { type LoggerOptions } from "pino";
import type { Env } from "./env";

/**
 * pino serializes only the `err` key out of the box, so `{ error }` would print `"error":{}`.
 * Both keys get the standard error serializer: call sites keep their `{ error }` shape and the
 * line still carries type, message and stack. Non-Error values pass through unchanged.
 */
export function loggerOptions(env: Pick<Env, "NODE_ENV" | "LOG_LEVEL">): LoggerOptions {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  };
  if (env.NODE_ENV === "development") options.transport = { target: "pino-pretty" };
  return options;
}
