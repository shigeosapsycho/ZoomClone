import * as mediasoup from "mediasoup";
import type { types as ms } from "mediasoup";
import type { Logger } from "pino";
import type { Env } from "./env";

export type WorkerSlot = {
  index: number;
  worker: ms.Worker;
  webRtcServer: ms.WebRtcServer;
  /** Rooms currently allocated on this worker; used for placement. */
  rooms: number;
};

/**
 * One worker per slot, one WebRtcServer per worker so every transport on that worker shares a
 * single UDP and TCP port (SFU_MEDIA_PORT_BASE + index). Docker and Windows friendly.
 */
export async function createWorkers(
  env: Env,
  log: Logger,
  /** Called as soon as each worker process exists, so a shutdown during startup can close it. */
  onWorker?: (worker: ms.Worker) => void,
): Promise<WorkerSlot[]> {
  const slots: WorkerSlot[] = [];
  for (let index = 0; index < env.SFU_WORKERS; index++) {
    const worker = await mediasoup.createWorker({
      logLevel: env.MEDIASOUP_LOG_LEVEL,
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      appData: { index },
    });
    onWorker?.(worker);
    worker.on("died", (error) => {
      // fatal flushes synchronously, so the line survives the exit that follows it.
      log.fatal({ err: error, index, pid: worker.pid }, "mediasoup worker died");
      process.exit(1);
    });
    const port = env.SFU_MEDIA_PORT_BASE + index;
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: "udp", ip: env.SFU_LISTEN_IP, announcedAddress: env.SFU_ANNOUNCED_IP, port },
        { protocol: "tcp", ip: env.SFU_LISTEN_IP, announcedAddress: env.SFU_ANNOUNCED_IP, port },
      ],
    });
    slots.push({ index, worker, webRtcServer, rooms: 0 });
  }
  return slots;
}

export function pickWorker(slots: WorkerSlot[]): WorkerSlot {
  if (slots.length === 0) throw new Error("no mediasoup workers");
  return slots.reduce((best, slot) => (slot.rooms < best.rooms ? slot : best));
}

export async function closeWorkers(slots: WorkerSlot[]): Promise<void> {
  for (const slot of slots) {
    slot.worker.close();
  }
}
