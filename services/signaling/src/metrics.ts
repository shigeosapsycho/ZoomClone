import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { RegistryMetrics } from "./room/registry";

export type Metrics = {
  registry: Registry;
  connections: Gauge;
  rooms: Gauge;
  checkpointLag: Histogram;
  resyncTotal: Counter;
  replayTotal: Counter;
  failoverTotal: Counter;
  forRegistry(): RegistryMetrics;
};

/** Design doc "metrics.ts": ws_connections, room_count, checkpoint_lag_ms, resync_total, failover_total. */
export function createMetrics(roomCount: () => number): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const connections = new Gauge({
    name: "ws_connections",
    help: "Open signaling sockets",
    registers: [registry],
  });
  const rooms = new Gauge({
    name: "room_count",
    help: "Rooms owned by this controller process",
    registers: [registry],
    collect() {
      this.set(roomCount());
    },
  });
  const checkpointLag = new Histogram({
    name: "checkpoint_lag_ms",
    help: "Delay between a room change and its Redis checkpoint",
    buckets: [10, 25, 50, 100, 250, 500, 1000],
    registers: [registry],
  });
  const resyncTotal = new Counter({
    name: "resync_total",
    help: "Reconnects answered with a full resync",
    registers: [registry],
  });
  const replayTotal = new Counter({
    name: "replay_total",
    help: "Reconnects answered with a replay",
    registers: [registry],
  });
  const failoverTotal = new Counter({
    name: "failover_total",
    help: "Rooms rehydrated from Redis",
    registers: [registry],
  });
  return {
    registry,
    connections,
    rooms,
    checkpointLag,
    resyncTotal,
    replayTotal,
    failoverTotal,
    forRegistry: () => ({
      resync: () => resyncTotal.inc(),
      replay: () => replayTotal.inc(),
      failover: () => failoverTotal.inc(),
      checkpointLag: (ms) => checkpointLag.observe(ms),
    }),
  };
}
