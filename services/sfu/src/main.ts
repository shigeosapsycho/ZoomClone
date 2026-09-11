import type { Http2Server } from "node:http2";
import pino from "pino";
import { createSfuServer } from "./app";
import { loadEnv } from "./env";
import { createMetrics } from "./metrics";
import { RoomManager, roomOptionsFrom } from "./rooms";
import { closeWorkers, createWorkers, type WorkerSlot } from "./workers";

const env = loadEnv();
const log = pino(
  env.NODE_ENV === "development"
    ? { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } }
    : { level: env.LOG_LEVEL },
);

type App = { slots: WorkerSlot[]; manager: RoomManager; server: Http2Server };

// Assigned once startup completes; the signal handlers below are registered before that, so a
// signal that arrives during startup finds nothing to close and just exits.
let app: App | undefined;
let shuttingDown = false;

/**
 * Everything before the first await runs inside the signal dispatch itself. mediasoup's Worker
 * installs its own process.once("SIGINT" | "SIGTERM") handler that closes the worker (and with it
 * every router) at once, and Node runs signal listeners in registration order, so ours, registered
 * before createWorkers(), gets to close the allocated rooms first: live Stats streams then end
 * cleanly instead of seeing a burst of child close events on a room that is still open. Windows
 * delivers neither signal this way (no SIGTERM at all, SIGINT only for a console Ctrl+C), so the
 * ordering matters on Linux.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 5000).unref();
  log.info({ signal }, "shutting down");
  const running = app;
  running?.manager.closeAllocated();
  try {
    if (running) {
      await running.manager.closeAll();
      await new Promise<void>((resolve) => running.server.close(() => resolve()));
      await closeWorkers(running.slots);
    }
    process.exit(0);
  } catch (error) {
    log.error(error, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const slots = await createWorkers(env, log);
const manager = new RoomManager(slots, roomOptionsFrom(env, log));
const server = createSfuServer(manager, createMetrics(manager));
app = { slots, manager, server };

server.listen(env.SFU_GRPC_PORT, "0.0.0.0", () => {
  log.info(
    {
      sfuId: env.SFU_ID,
      grpcPort: env.SFU_GRPC_PORT,
      workers: slots.length,
      mediaPorts: `${env.SFU_MEDIA_PORT_BASE}-${env.SFU_MEDIA_PORT_BASE + slots.length - 1}`,
      announcedIp: env.SFU_ANNOUNCED_IP,
    },
    "sfu listening",
  );
});
