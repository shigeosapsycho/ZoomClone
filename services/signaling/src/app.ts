import * as http from "node:http";
import type { Logger } from "pino";
import type { WebSocketServer } from "ws";
import type { Env } from "./env";
import { attachGateway } from "./gateway/server";
import type { TokenVerifier } from "./gateway/auth";
import type { Metrics } from "./metrics";
import type { RoomRegistry } from "./room/registry";

export type AppDeps = {
  registry: RoomRegistry;
  verifier: TokenVerifier;
  env: Env;
  log: Logger;
  metrics: Metrics;
};

/** Plain http for /healthz and /metrics; WebSocket upgrades on /rooms/:session_id. */
export function createApp(deps: AppDeps): { server: http.Server; wss: WebSocketServer } {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: deps.registry.size }));
      return;
    }
    if (pathname === "/metrics") {
      void deps.metrics.registry.metrics().then(
        (body) => {
          res.writeHead(200, { "content-type": deps.metrics.registry.contentType });
          res.end(body);
        },
        (error: unknown) => {
          res.writeHead(500);
          res.end(String(error));
        },
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
  });
  const wss = attachGateway(server, {
    registry: deps.registry,
    verifier: deps.verifier,
    env: deps.env,
    log: deps.log,
    metrics: { connections: deps.metrics.connections },
  });
  return { server, wss };
}
