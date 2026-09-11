import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "./env";
import { closeWorkers, createWorkers, pickWorker, type WorkerSlot } from "./workers";

let slots: WorkerSlot[] = [];

beforeAll(async () => {
  const env = loadEnv({
    SFU_WORKERS: "2",
    SFU_MEDIA_PORT_BASE: String(42000 + Math.floor(Math.random() * 900)),
  });
  slots = await createWorkers(env, pino({ level: "silent" }));
});

afterAll(async () => {
  await closeWorkers(slots);
});

describe("workers", () => {
  it("starts one mediasoup worker per slot with a WebRtcServer", () => {
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.worker.closed).toBe(false);
      expect(slot.webRtcServer.closed).toBe(false);
      expect(slot.rooms).toBe(0);
    }
  });

  it("picks the least loaded worker", () => {
    slots[0]!.rooms = 3;
    slots[1]!.rooms = 1;
    expect(pickWorker(slots)).toBe(slots[1]);
    slots[1]!.rooms = 5;
    expect(pickWorker(slots)).toBe(slots[0]);
  });

  it("reports resource usage from the worker", async () => {
    const usage = await slots[0]!.worker.getResourceUsage();
    expect(usage.ru_maxrss).toBeGreaterThan(0);
  });
});
