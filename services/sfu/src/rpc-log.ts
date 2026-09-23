import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import type { Logger } from "pino";

/**
 * Logs every gRPC call this SFU serves at debug level: method, outcome and handling time. The
 * session and participant ids are logged when the request carries them; payload blobs are not.
 * A server stream (Stats) is logged when it opens.
 */
export function rpcServerLog(log: Logger): Interceptor {
  return (next) => async (req) => {
    const method = req.method.name;
    const ids = req.stream ? {} : pickIds(req.message);
    const started = performance.now();
    try {
      const res = await next(req);
      const ms = Math.round(performance.now() - started);
      if (res.stream) log.debug({ method, ...ids, ms }, "grpc stream opened");
      else log.debug({ method, ...ids, ms, code: "OK" }, "grpc handled");
      return res;
    } catch (error) {
      const code = Code[ConnectError.from(error).code];
      const ms = Math.round(performance.now() - started);
      log.debug({ method, ...ids, ms, code }, "grpc handled");
      throw error;
    }
  };
}

function pickIds(message: unknown): { sessionId?: string; participantId?: string } {
  const m = message as { sessionId?: unknown; participantId?: unknown };
  return {
    ...(typeof m.sessionId === "string" && m.sessionId ? { sessionId: m.sessionId } : {}),
    ...(typeof m.participantId === "string" && m.participantId
      ? { participantId: m.participantId }
      : {}),
  };
}
