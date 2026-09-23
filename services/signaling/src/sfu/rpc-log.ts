import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import type { Logger } from "pino";

/**
 * Logs every gRPC call this process makes to an SFU at debug level: method, target, outcome and
 * round trip. Payloads are not logged (SDP-sized JSON blobs, and DTLS fingerprints). A server
 * stream (Stats) is logged when it opens; its events are the stats consumer's business.
 */
export function rpcClientLog(log: Logger, sfuId: string): Interceptor {
  return (next) => async (req) => {
    const method = req.method.name;
    const started = performance.now();
    try {
      const res = await next(req);
      const ms = Math.round(performance.now() - started);
      if (res.stream) log.debug({ sfu: sfuId, method, ms }, "grpc stream opened");
      else log.debug({ sfu: sfuId, method, ms, code: "OK" }, "grpc call");
      return res;
    } catch (error) {
      const code = Code[ConnectError.from(error).code];
      const ms = Math.round(performance.now() - started);
      log.debug({ sfu: sfuId, method, ms, code }, "grpc call");
      throw error;
    }
  };
}
