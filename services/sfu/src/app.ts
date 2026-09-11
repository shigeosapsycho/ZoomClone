import * as http2 from "node:http2";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { Metrics } from "./metrics";
import type { RoomManager } from "./rooms";
import { sfuRoutes } from "./service";

/** gRPC (h2c) for the room controller, plus /healthz and /metrics on the same port. */
export function createSfuServer(manager: RoomManager, metrics: Metrics): http2.Http2Server {
  const rpc = connectNodeAdapter({ routes: sfuRoutes(manager) });
  return http2.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: manager.size }));
      return;
    }
    if (req.url === "/metrics") {
      void metrics.registry.metrics().then(
        (body) => {
          res.writeHead(200, { "content-type": metrics.registry.contentType });
          res.end(body);
        },
        (error: unknown) => {
          res.writeHead(500);
          res.end(String(error));
        },
      );
      return;
    }
    rpc(req, res);
  });
}
