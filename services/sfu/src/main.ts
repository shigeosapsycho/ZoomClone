import pino from "pino";
import { createSfuServer } from "./app";
import { loadEnv } from "./env";
import { createMetrics } from "./metrics";
import { RoomManager, roomOptionsFrom } from "./rooms";
import { closeWorkers, createWorkers } from "./workers";

const env = loadEnv();
const log = pino(
  env.NODE_ENV === "development"
    ? { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } }
    : { level: env.LOG_LEVEL },
);
const slots = await createWorkers(env);
const manager = new RoomManager(slots, roomOptionsFrom(env));
const server = createSfuServer(manager, createMetrics(manager));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  try {
    await manager.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeWorkers(slots);
    process.exit(0);
  } catch (error) {
    log.error(error, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

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
