import { Gauge, Registry, collectDefaultMetrics } from "prom-client";
import type { RoomManager } from "./rooms";

export type Metrics = { registry: Registry };

/** Spec 9.1 capacity metrics, collected on scrape from the room manager. */
export function createMetrics(manager: RoomManager): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  new Gauge({
    name: "sfu_rooms",
    help: "Rooms (routers) allocated on this SFU",
    registers: [registry],
    collect() {
      this.set(manager.size);
    },
  });
  new Gauge({
    name: "sfu_transports",
    help: "WebRTC transports across all rooms",
    registers: [registry],
    collect() {
      let total = 0;
      for (const room of manager.rooms()) total += room.transports.size;
      this.set(total);
    },
  });
  return { registry };
}
