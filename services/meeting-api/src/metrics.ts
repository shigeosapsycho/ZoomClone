import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export type Metrics = {
  registry: Registry;
  joinLatency: Histogram<string>;
  joinErrors: Counter<"code">;
};

/** Spec 9.1 join metrics. A fresh registry per app instance keeps tests independent. */
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const joinLatency = new Histogram({
    name: "join_latency_seconds",
    help: "POST /join latency in seconds",
    buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });
  const joinErrors = new Counter({
    name: "join_errors_total",
    help: "POST /join errors by code",
    labelNames: ["code"] as const,
    registers: [registry],
  });
  return { registry, joinLatency, joinErrors };
}
