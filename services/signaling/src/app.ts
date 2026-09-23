import * as http from "node:http";
import type { Logger } from "pino";
import type { WebSocketServer } from "ws";
import type { HarnessBundle } from "./dev/build";
import type { Env } from "./env";
import { attachGateway, pathnameOf } from "./gateway/server";
import type { TokenVerifier } from "./gateway/auth";
import type { Metrics } from "./metrics";
import type { RoomRegistry } from "./room/registry";

export type AppDeps = {
  registry: RoomRegistry;
  verifier: TokenVerifier;
  env: Env;
  log: Logger;
  metrics: Metrics;
  harness?: HarnessBundle;
};

/** Plain http for /healthz and /metrics; WebSocket upgrades on /rooms/:session_id. */
export function createApp(deps: AppDeps): { server: http.Server; wss: WebSocketServer } {
  const server = http.createServer((req, res) => {
    const pathname = pathnameOf(req);
    if (pathname === null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "VALIDATION", message: "invalid request target" } }));
      return;
    }
    if (deps.harness && (pathname === "/dev" || pathname === "/dev/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(deps.harness.html);
      return;
    }
    if (deps.harness && pathname === "/dev/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(deps.harness.js);
      return;
    }
    if (deps.harness && pathname === "/dev/app.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(deps.harness.css);
      return;
    }
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
