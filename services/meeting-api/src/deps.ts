import type Redis from "ioredis";
import type { Db } from "@zoomclone/db";
import type { EventBus } from "@zoomclone/events";
import type { SigningKeys } from "@zoomclone/tokens";
import { createUserVerifier, type UserVerifier } from "./auth/user-verifier";
import type { Env } from "./env";
import { createMetrics, type Metrics } from "./metrics";

/** Infrastructure handles created by main.ts or by tests. */
export type Infra = {
  db: Db;
  redis: Redis;
  bus: EventBus;
  keys: SigningKeys;
  clock?: () => Date;
};

export type AppDeps = {
  env: Env;
  metrics: Metrics;
  db: Db;
  redis: Redis;
  bus: EventBus;
  keys: SigningKeys;
  userVerifier: UserVerifier;
  clock: () => Date;
};

export function createDeps(env: Env, infra: Infra): AppDeps {
  return {
    env,
    metrics: createMetrics(),
    db: infra.db,
    redis: infra.redis,
    bus: infra.bus,
    keys: infra.keys,
    userVerifier: createUserVerifier(env, infra.keys),
    clock: infra.clock ?? (() => new Date()),
  };
}
