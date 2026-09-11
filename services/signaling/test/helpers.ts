import { randomUUID } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import Redis from "ioredis";
import pino from "pino";
import { createDb, type Db } from "@zoomclone/db";
import { ensureTestDatabase, testDatabaseUrl, truncateAll } from "@zoomclone/db/testing";
import { InMemoryEventBus } from "@zoomclone/events";
import { ServerMessageSchema, type ServerMessage, type SignalingClaims } from "@zoomclone/protocol";
import { SfuService } from "@zoomclone/sfu-proto";
import { loadSigningKeys, type SigningKeys } from "@zoomclone/tokens";
import { loadEnv, type Env } from "../src/env";
import type { ParticipantLink } from "../src/gateway/link";
import { Checkpoint, OwnerLease } from "../src/room/checkpoint";
import { RoomController, type ControllerTimings } from "../src/room/controller";
import { RoomRegistry, type RegistryTimings } from "../src/room/registry";
import { DEFAULT_ROOM_OPTIONS, Room } from "../src/room/room";
import { SfuDirectory } from "../src/sfu/directory";
import type { FakeSfu } from "./fake-sfu";

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? "redis://localhost:56379/1";
}

/** Short timers so grace, idle, hello and ping paths run in tens of milliseconds. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    DISCONNECT_GRACE_MS: "800",
    ROOM_IDLE_TIMEOUT_MS: "400",
    HELLO_TIMEOUT_MS: "300",
    PING_TIMEOUT_MS: "5000",
    CHECKPOINT_WINDOW_MS: "20",
    HEARTBEAT_MS: "100",
    OWNER_LEASE_MS: "2000",
    ...overrides,
  });
}

export function connectRedis(): Redis {
  return new Redis(testRedisUrl());
}

export async function flushTestRedis(redis: Redis): Promise<void> {
  await redis.flushdb();
}

export const silentLog = pino({ level: "silent" });

export type TestInfra = {
  env: Env;
  db: Db;
  redis: Redis;
  subscriber: Redis;
  bus: InMemoryEventBus;
  keys: SigningKeys;
  close: () => Promise<void>;
};

/** Real Postgres (truncated) and Redis db 1 (flushed), one in-memory bus, ephemeral signing keys. */
export async function createTestInfra(
  envOverrides: Record<string, string> = {},
): Promise<TestInfra> {
  await ensureTestDatabase();
  const env = testEnv(envOverrides);
  const db = createDb(env.DATABASE_URL, { max: 5 });
  const redis = connectRedis();
  const subscriber = connectRedis();
  await truncateAll(db);
  await flushTestRedis(redis);
  const keys = await loadSigningKeys({ kid: "test" });
  return {
    env,
    db,
    redis,
    subscriber,
    bus: new InMemoryEventBus(),
    keys,
    close: async () => {
      await subscriber.quit();
      await redis.quit();
      await db.end();
    },
  };
}

/** A meeting plus its live session so participants and endSession have rows to touch. */
export async function seedSession(
  db: Db,
  sessionId: string = randomUUID(),
  settings: { lobby: boolean; max_participants: number } = { lobby: true, max_participants: 500 },
): Promise<{ meetingId: string; sessionId: string }> {
  const meetingId = randomUUID();
  await db`
    INSERT INTO meetings (id, code, org_id, organizer_id, region, settings, status)
    VALUES (${meetingId}, ${randomUUID().slice(0, 10)}, ${randomUUID()}, ${randomUUID()}, 'local',
            ${db.json(settings)}, 'live')`;
  await db`
    INSERT INTO meeting_sessions (id, meeting_id, started_at, home_sfu_id)
    VALUES (${sessionId}, ${meetingId}, now(), 'fake-sfu')`;
  return { meetingId, sessionId };
}

export function mintClaims(
  overrides: Partial<SignalingClaims> & { session_id: string },
): SignalingClaims {
  return {
    participant_id: randomUUID(),
    role: "attendee",
    lobby: false,
    sfu_hint: "fake-sfu",
    display_name: "Guest",
    lobby_enabled: true,
    max_participants: 10,
    ...overrides,
  };
}

/** Records every frame (validated against ServerMessageSchema) and the close code. */
export class FakeLink implements ParticipantLink {
  readonly id = randomUUID();
  readonly sent: ServerMessage[] = [];
  closedWith: { code: number; reason?: string } | null = null;

  send(message: ServerMessage): void {
    this.sent.push(ServerMessageSchema.parse(message));
  }

  close(code: number, reason?: string): void {
    this.closedWith ??= reason === undefined ? { code } : { code, reason };
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  ofType<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  async waitFor<T extends ServerMessage["type"]>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const found = await waitFor(() => this.ofType(type).find(predicate), timeoutMs);
    if (!found)
      throw new Error(
        `no ${type} within ${timeoutMs} ms; got ${this.sent.map((m) => m.type).join(",")}`,
      );
    return found;
  }
}

/** Polls until the getter returns a truthy value or the timeout elapses (returns undefined). */
export async function waitFor<T>(
  getter: () => T | undefined | false,
  timeoutMs = 2000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getter();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const value = getter();
  return value || undefined;
}

export type TestController = {
  controller: RoomController;
  room: Room;
  lease: OwnerLease;
  gone: Promise<string>;
};

export async function createTestController(opts: {
  infra: TestInfra;
  sfu: FakeSfu;
  sessionId?: string;
  room?: Room;
  timings?: Partial<ControllerTimings>;
}): Promise<TestController> {
  const { env, redis, db, bus } = opts.infra;
  const sessionId = opts.room?.sessionId ?? opts.sessionId ?? randomUUID();
  const room =
    opts.room ??
    Room.create({
      session_id: sessionId,
      home_sfu: "fake-sfu",
      lobby_enabled: true,
      max_participants: 10,
    });
  const checkpoint = new Checkpoint(redis, room, { windowMs: env.CHECKPOINT_WINDOW_MS });
  const lease = new OwnerLease(redis, sessionId, env.OWNER_LEASE_MS);
  if (!(await lease.acquire())) throw new Error("test lease not acquired");
  const sfu = createClient(SfuService, createGrpcTransport({ baseUrl: opts.sfu.baseUrl }));
  let resolveGone!: (id: string) => void;
  const gone = new Promise<string>((resolve) => (resolveGone = resolve));
  const controller = new RoomController({
    room,
    sfu,
    checkpoint,
    lease,
    db,
    bus,
    log: silentLog,
    timings: {
      graceMs: env.DISCONNECT_GRACE_MS,
      idleMs: env.ROOM_IDLE_TIMEOUT_MS,
      heartbeatMs: env.HEARTBEAT_MS,
      speakerTickMs: 50,
      statsRetryMs: 50,
      ...opts.timings,
    },
    onGone: resolveGone,
  });
  await controller.start();
  return { controller, room, lease, gone };
}

export function createTestRegistry(
  infra: TestInfra,
  sfuBaseUrl: string,
  overrides: Partial<RegistryTimings> = {},
): RoomRegistry {
  const { env } = infra;
  return new RoomRegistry({
    redis: infra.redis,
    subscriber: infra.subscriber,
    sfus: new SfuDirectory({ "fake-sfu": sfuBaseUrl }),
    db: infra.db,
    bus: infra.bus,
    log: silentLog,
    timings: {
      graceMs: env.DISCONNECT_GRACE_MS,
      idleMs: env.ROOM_IDLE_TIMEOUT_MS,
      heartbeatMs: env.HEARTBEAT_MS,
      speakerTickMs: 50,
      statsRetryMs: 50,
      checkpointWindowMs: env.CHECKPOINT_WINDOW_MS,
      leaseMs: env.OWNER_LEASE_MS,
      ...overrides,
    },
    roomOptions: DEFAULT_ROOM_OPTIONS,
  });
}
