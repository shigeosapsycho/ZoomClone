import type Redis from "ioredis";
import type { Db } from "@zoomclone/db";
import type { EventBus } from "@zoomclone/events";
import type { CodeRng } from "@zoomclone/protocol";
import type { SigningKeys } from "@zoomclone/tokens";
import { createUserVerifier, type UserVerifier } from "./auth/user-verifier";
import type { Env } from "./env";
import { createMetrics, type Metrics } from "./metrics";
import { MeetingsRepo } from "./meetings/repo";
import { MeetingsService } from "./meetings/service";
import { RedisRoomControl, type RoomControl } from "./room-control";

/** Infrastructure handles created by main.ts or by tests. */
export type Infra = {
  db: Db;
  redis: Redis;
  bus: EventBus;
  keys: SigningKeys;
  clock?: () => Date;
  codeRng?: CodeRng;
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
  roomControl: RoomControl;
  meetingsRepo: MeetingsRepo;
  meetings: MeetingsService;
};

export function createDeps(env: Env, infra: Infra): AppDeps {
  const roomControl = new RedisRoomControl(infra.redis);
  const meetingsRepo = new MeetingsRepo(infra.db);
  const meetings = new MeetingsService({
    db: infra.db,
    repo: meetingsRepo,
    roomControl,
    region: env.DEFAULT_REGION,
    codeRng: infra.codeRng,
  });
  return {
    env,
    metrics: createMetrics(),
    db: infra.db,
    redis: infra.redis,
    bus: infra.bus,
    keys: infra.keys,
    userVerifier: createUserVerifier(env, infra.keys),
    clock: infra.clock ?? (() => new Date()),
    roomControl,
    meetingsRepo,
    meetings,
  };
}
