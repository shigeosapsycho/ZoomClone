# Plan 3: Signaling Service (gateway, room controller, registry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `services/signaling`: the WebSocket gateway plus the room controller (one process, explicit module boundary) that turns the design doc's signaling protocol into SFU gRPC calls, Redis checkpoints, bus events and Postgres attendance rows, verified against a fake in-process SFU, real Redis, real Postgres and (once) the real `services/sfu`.

**Architecture:** `gateway/` owns sockets: it authenticates the `hello` JWT, validates every frame with the shared zod schemas, does ping accounting and rate limiting, wraps each socket in a `ParticipantLink` and hands messages to a `RoomController` obtained from the `RoomRegistry`. `room/room.ts` is a pure synchronous state machine (`apply(command) -> events with fanout targets`, seq numbers, ring buffer, snapshot round trip). `room/controller.ts` sequences SFU calls before room mutations, fans events out to links, keeps the not-checkpointed `MediaBindings`, runs the grace and idle timers, consumes the SFU `Stats` stream and ends rooms. `room/checkpoint.ts` is the write-behind Redis writer (50 ms window) plus loader, owner lease and heartbeat. `room/registry.ts` finds or builds a controller per session (in-memory, else lease + rehydrate from Redis + SFU snapshot reconcile, else fresh). `writer/postgres-writer.ts` consumes bus events into `participants` rows and the idempotent `endSession`.

**Tech Stack:** ws 8.21.3, @connectrpc/connect 2.2.0, @connectrpc/connect-node 2.2.0, @bufbuild/protobuf 2.14.1, ioredis 5.11.1, jose 6.2.12, pino 10.3.1, prom-client 15.1.3, zod 4.6.2, vitest 4.1.11, TypeScript 5.9.3, tsx 4.23.13.

**Spec:** `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md` (sections "WebSocket signaling", "Data model" (Redis layout), "Components > services/signaling", "Core flows", Phases 4 and 5). Plan 1 (`docs/superpowers/plans/2026-09-10-plan-1-foundation-control-plane.md`) established the workspace conventions; Plan 2 (`docs/superpowers/plans/2026-09-10-plan-2-sfu-service.md`) built the SFU this service calls.

## Global Constraints

- Everything in Plan 1's and Plan 2's Global Constraints still applies: Node `>=24`, pnpm 9.15.9, ESM, TypeScript strict with `moduleResolution: bundler`, extensionless relative imports, workspace packages export TypeScript source, no build step, tests against real infrastructure (real Redis on `redis://localhost:56379/1`, real Postgres `zoomclone_test` on port 55432, the fake SFU only stands in for mediasoup), `pnpm check` green before every commit, Conventional Commits with the two trailer lines (`Co-Authored-By: <model> <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY`), no em dashes in prose, branch `feat/mvp-vertical-slice`.
- Pinned versions for this plan: ws 8.21.3, @types/ws 8.18.1, @connectrpc/connect 2.2.0, @connectrpc/connect-node 2.2.0, @bufbuild/protobuf 2.14.1, ioredis 5.11.1, jose 6.2.12, pino 10.3.1, pino-pretty 13.1.3, prom-client 15.1.3.
- Ports and env: signaling `8081` (`SIGNALING_PORT`), SFU endpoints from `SFU_ENDPOINTS="sfu-local-1=http://localhost:9090"`, JWKS from `MEETING_API_JWKS_URL=http://localhost:8080/.well-known/jwks.json`, issuer `TOKEN_ISSUER=meeting-api` (must equal the meeting-api value). Tests never touch these ports: the gateway listens on port 0, the fake SFU on port 0.
- The shared zod schemas in `@zoomclone/protocol` are the source of truth for every frame. The gateway parses with `ClientMessageSchema`; every message the service sends must satisfy `ServerMessageSchema` (tests assert this on every received frame).
- Redis key layout (design doc "Data model", read by meeting-api's `RoomStateReader`): `{room:<session_id>}:meta` HASH with `status` (`live` | `ended`), `end_reason`, `home_sfu`, `host_ids` (JSON array), `locked` / `lobby_enabled` / `recording` (`"true"` | `"false"`), `epoch`, `peak`, `max_participants`, `session_id`; `:roster`, `:lobby`, `:tracks`, `:departed` HASHes keyed by id with JSON values; `:seq` STRING; `:owner` STRING lease. TTL 3600 s refreshed by the heartbeat; `markEnded` keeps only `meta` (status `ended`, `end_reason`) for 60 s. The ctl channel is `room:<session_id>:ctl` with `{"cmd":"end","reason":"api_end"}` (see `services/meeting-api/src/room-control.ts`).
- Timers are real (no vitest fake timers: they interfere with sockets and ioredis). Tests shorten them through env: `DISCONNECT_GRACE_MS`, `ROOM_IDLE_TIMEOUT_MS`, `HELLO_TIMEOUT_MS`, `PING_TIMEOUT_MS`, `CHECKPOINT_WINDOW_MS`, `HEARTBEAT_MS`, `OWNER_LEASE_MS`.
- Ordering rule (design doc): SFU calls first, room mutation only after they succeed; a failed second call rolls the first back. No partial roster state after a gRPC failure.
- SFU contract facts (Plan 2 final review): `AllocateRoom` and `CloseRoom` are idempotent, every other cleanup call answers `NOT_FOUND` on repeat, so cleanup paths tolerate `NOT_FOUND`; a `Stats` stream that ends without an error means the SFU room is gone (or the subscriber fell 4096 events behind), so reopen with `AllocateRoom` then `Stats` and treat the new snapshot as the truth; `Subscribe` needs the recv transport to exist, not to be connected; `Qos.bytes_sent` / `bytes_received` are `bigint` and are never `JSON.stringify`'d.
- No em dashes anywhere, including test names, log messages and comments.

## Rulings folded into this plan (design-doc refinements, recorded in Task 0)

- `hello` is acknowledged like every other request: `ack {id, payload: {mode: "welcome" | "resync" | "replay", epoch, seq}}` is sent first, then the `welcome` / `resync` snapshot or the replayed events. The design doc's table listed only the push; without an ack a replay that has nothing to replay would be indistinguishable from a hung hello.
- New server event `lobby.left {participant_id}` (to hosts) so a waiting list shrinks when a waiter is denied or disconnects. Lobby waiters get no disconnect grace: a waiter whose socket closes leaves the lobby at once and re-requests on the next `hello`.
- `TransportSnapshot` in the SFU `Stats` snapshot now carries `ice_parameters_json`, `ice_candidates_json`, `dtls_parameters_json`, so a rehydrated controller can hand a reconnecting client its existing transports in `resync.media` (same ids: the client keeps its media). Without them every signaling restart would force transport rebuilds and re-publishes.
- `track.updated {layers}` targeted at one subscriber means "spatial layers being delivered to your consumer: 0 none, 1 low, 2 medium, 3 high" (from the SFU `consumer_layers` event, `spatial_layer + 1` when active, `0` when inactive). `TrackInfo.layers` stays the producer's layer count. Both are counts, so `layers <= track.layers` always holds.
- `participant.joined` is fanned to everyone except the joiner (the joiner has the snapshot); every other roster event goes to the whole roster including the actor, so clients apply one uniform event stream. `hand` state changes emit the `hand` event only (never `participant.updated {hand}`), so a client has a single source for it.
- Removing a host is refused (`FORBIDDEN`); a host cannot remove themselves. Chat direct messages are delivered to sender and recipient (`only [from, to]`).

## File structure (what this plan creates)

```
proto/sfu/v1/sfu.proto                       + transport params in TransportSnapshot (Task 0)
packages/protocol/src/ws/server.ts           + lobby.left event, HelloAckSchema (Task 0)
services/sfu/package.json                    + "./testing" export for startTestSfu (Task 0)
services/signaling/
  package.json tsconfig.json vitest.config.ts
  src/env.ts                    zod env
  src/room/types.ts             Command, Target, Emitted, RoomSnapshot, RoomError, Outcome
  src/room/ring-buffer.ts       RingBuffer (500 events / 60 s) and target matching
  src/room/room.ts              Room: pure state machine
  src/room/active-speakers.ts   ActiveSpeakerTracker
  src/room/checkpoint.ts        roomKeys, Checkpoint (write-behind), loadSnapshot, OwnerLease
  src/room/media-bindings.ts    MediaBindings (transport params, producers, consumers; not checkpointed)
  src/room/controller.ts        RoomController
  src/room/registry.ts          RoomRegistry (+ ControllerBusyError, RoomEndedError)
  src/sfu/codec.ts              JSON blob parsing, enum mapping, describeSfuError, isNotFound
  src/sfu/directory.ts          SfuDirectory (sfu_id -> Connect client)
  src/sfu/stats-consumer.ts     StatsConsumer (Stats stream with reconnect)
  src/gateway/link.ts           ParticipantLink interface + WsLink
  src/gateway/auth.ts           TokenVerifier (remote JWKS or local keys)
  src/gateway/rate-limit.ts     TokenBucket
  src/gateway/server.ts         attachGateway(httpServer, deps): ws upgrade + per-connection state machine
  src/writer/postgres-writer.ts PostgresWriter
  src/metrics.ts                prom-client registry and gauges/counters
  src/app.ts                    http server: /healthz, /metrics, ws upgrade
  src/main.ts                   entrypoint
  test/helpers.ts               infra, env, claims, tokens, seedSession, TestClient, startTestSignaling
  test/fake-sfu.ts              FakeSfu: in-process SfuService over http2 with call log and event injection
  src/**/*.test.ts              tests next to the code
```

---

### Task 0: Contract extensions (proto transport params, protocol events, sfu testing export, design-doc notes)

**Files:**
- Modify: `proto/sfu/v1/sfu.proto`, `services/sfu/src/rooms.ts`, `services/sfu/src/service.ts`, `services/sfu/src/rooms.transports.test.ts`, `services/sfu/src/service.test.ts`, `services/sfu/package.json`, `packages/protocol/src/ws/server.ts`, `packages/protocol/src/ws/messages.test.ts`, `packages/events/src/bus.ts`, `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md`
- Generated: `packages/sfu-proto/src/gen/sfu/v1/sfu_pb.ts` (via `pnpm proto:gen`)

**Interfaces:**
- Produces: `TransportSnapshot.iceParametersJson / iceCandidatesJson / dtlsParametersJson` (strings, JSON of the mediasoup objects); `RoomSnapshot.transports[i].iceParameters / iceCandidates / dtlsParameters` in the SFU; `@zoomclone/sfu/testing` exporting `startTestSfu`, `audioRtpParameters`, `videoSimulcastRtpParameters`, `CLIENT_DTLS_PARAMETERS`, `take`; in `@zoomclone/protocol`: server event `lobby.left {participant_id}` and `HelloAckSchema` / `HelloAck` (`{ mode: "welcome" | "resync" | "replay"; epoch: number; seq: number }`); in `@zoomclone/events`: `EventMap["room.created"]` becomes `{ session_id: string; home_sfu: string; epoch: number }` (the controller only knows the session id; the meeting id is one join away in Postgres).

- [ ] **Step 1: Proto fields**

In `proto/sfu/v1/sfu.proto`, replace the `TransportSnapshot` message with:

```proto
message TransportSnapshot {
  string transport_id = 1;
  string participant_id = 2;
  TransportDirection direction = 3;
  string ice_state = 4;
  string dtls_state = 5;
  // Full client-facing parameters, so a restarted room controller can hand a reconnecting
  // client its existing transports instead of recreating them.
  string ice_parameters_json = 6;
  string ice_candidates_json = 7;
  string dtls_parameters_json = 8;
}
```

Run: `pnpm proto:lint && pnpm proto:gen`
Expected: no lint output; `packages/sfu-proto/src/gen/sfu/v1/sfu_pb.ts` now declares `iceParametersJson`, `iceCandidatesJson`, `dtlsParametersJson` on `TransportSnapshot`.

- [ ] **Step 2: SFU snapshot carries the parameters (failing tests first)**

In `services/sfu/src/rooms.transports.test.ts`, inside the test `"snapshot lists transports with their states and closing the room ends event streams"`, directly after the existing `expect(snap.transports[0]).toMatchObject({ ... })` block, add:

```ts
    expect(snap.transports[0]?.iceParameters.usernameFragment).toBeTypeOf("string");
    expect(snap.transports[0]?.iceCandidates.length).toBeGreaterThan(0);
    expect(snap.transports[0]?.dtlsParameters.fingerprints.length).toBeGreaterThan(0);
```

In `services/sfu/src/service.test.ts`, inside `"streams a snapshot then live events, and ends when the room closes"`, directly after the `expect(snapshot.transports.map((t) => t.transportId).sort()).toEqual(...)` assertion, add:

```ts
    const firstTransport = snapshot.transports[0];
    if (!firstTransport) throw new Error("expected a transport in the snapshot");
    expect(JSON.parse(firstTransport.iceParametersJson)).toMatchObject({
      usernameFragment: expect.any(String),
    });
    expect(JSON.parse(firstTransport.iceCandidatesJson)).toBeInstanceOf(Array);
    expect(JSON.parse(firstTransport.dtlsParametersJson)).toMatchObject({
      fingerprints: expect.any(Array),
    });
```

Run: `pnpm --filter @zoomclone/sfu test -- rooms.transports service`
Expected: FAIL (typecheck-level: `iceParameters` does not exist on the snapshot entry; vitest reports the assertion or type failure).

- [ ] **Step 3: Implement**

In `services/sfu/src/rooms.ts`, extend the `RoomSnapshot.transports` element type:

```ts
  transports: Array<{
    transportId: string;
    participantId: string;
    direction: Direction;
    iceState: string;
    dtlsState: string;
    iceParameters: ms.IceParameters;
    iceCandidates: ms.IceCandidate[];
    dtlsParameters: ms.DtlsParameters;
  }>;
```

and in `snapshot()` extend the transports mapping:

```ts
      transports: [...this.transports].map(([transportId, t]) => ({
        transportId,
        participantId: t.participantId,
        direction: t.direction,
        iceState: t.transport.iceState,
        dtlsState: t.transport.dtlsState,
        iceParameters: t.transport.iceParameters,
        iceCandidates: t.transport.iceCandidates,
        dtlsParameters: t.transport.dtlsParameters,
      })),
```

In `services/sfu/src/service.ts` `snapshotToProto`, extend the transports mapping:

```ts
      transports: snapshot.transports.map((t) => ({
        transportId: t.transportId,
        participantId: t.participantId,
        direction: directionToProto(t.direction),
        iceState: t.iceState,
        dtlsState: t.dtlsState,
        iceParametersJson: JSON.stringify(t.iceParameters),
        iceCandidatesJson: JSON.stringify(t.iceCandidates),
        dtlsParametersJson: JSON.stringify(t.dtlsParameters),
      })),
```

Run: `pnpm --filter @zoomclone/sfu test`
Expected: all sfu tests pass (40 tests, the two extended ones included).

- [ ] **Step 4: Export the SFU test helpers for other workspaces**

In `services/sfu/package.json` add, directly after `"type": "module",`:

```json
  "exports": {
    "./testing": "./test/helpers.ts"
  },
```

- [ ] **Step 5: Protocol additions (failing test first)**

In `packages/protocol/src/ws/messages.test.ts` add a test (next to the existing server-message tests):

```ts
  it("accepts lobby.left and the hello ack payload", () => {
    const left = ServerMessageSchema.safeParse({
      type: "lobby.left",
      seq: 7,
      payload: { participant_id: "0f1b6c2e-8d5a-4e2b-9c1d-2b3a4c5d6e7f" },
    });
    expect(left.success).toBe(true);
    expect(HelloAckSchema.safeParse({ mode: "replay", epoch: 2, seq: 40 }).success).toBe(true);
    expect(HelloAckSchema.safeParse({ mode: "nope", epoch: 2, seq: 40 }).success).toBe(false);
  });
```

Add `HelloAckSchema` to the file's import from `"./server"` (or from `"./index"`, whichever the file already imports `ServerMessageSchema` from).

Run: `pnpm --filter @zoomclone/protocol test`
Expected: FAIL (`lobby.left` is not a known type; `HelloAckSchema` is not exported).

- [ ] **Step 6: Implement the protocol additions**

In `packages/protocol/src/ws/server.ts`:

Add after `WelcomeSchema` / `Welcome`:

```ts
/** Reply to hello, sent before the welcome / resync snapshot or the replayed events. */
export const HelloAckSchema = z.object({
  mode: z.enum(["welcome", "resync", "replay"]),
  epoch: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
});
export type HelloAck = z.infer<typeof HelloAckSchema>;
```

Inside the `ServerMessageSchema` union, directly after the `lobby.result` entry, add:

```ts
  event("lobby.left", z.object({ participant_id: ParticipantIdSchema })),
```

Run: `pnpm --filter @zoomclone/protocol test`
Expected: PASS.

- [ ] **Step 7: room.created payload**

In `packages/events/src/bus.ts` change the `room.created` entry of `EventMap` to:

```ts
  "room.created": { session_id: string; home_sfu: string; epoch: number };
```

Run: `pnpm typecheck`
Expected: clean (nothing publishes `room.created` yet; verify with `grep -rn "room.created" services packages --include=*.ts`).

- [ ] **Step 8: Design-doc notes**

In `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md`:

1. In the client-to-server table, change the `hello` row's ack column from `(push: \`welcome\` or \`resync\`)` to `` `{mode: welcome | resync | replay, epoch, seq}`, then push `welcome`, `resync` or the replayed events ``.
2. In the server-to-client pushes paragraph, after `` `lobby.result {admitted}` (waiter), `` insert `` `lobby.left {participant_id}` (hosts, when a waiter is denied or disconnects), ``.
3. In the `StatsEvent` paragraph, change `transports with \`direction\`, \`ice_state\`, \`dtls_state\`` to `transports with \`direction\`, \`ice_state\`, \`dtls_state\` and their full client parameters (\`ice_parameters\`, \`ice_candidates\`, \`dtls_parameters\` as JSON) so a rehydrated controller can reuse them`.
4. In the "Reconnect" paragraph, after the sentence ending `rebuilds transports if they changed (SFU room was recreated).`, add: `Lobby waiters have no grace: a waiter whose socket closes leaves the lobby at once (hosts receive \`lobby.left\`) and re-requests on the next \`hello\`.`
5. In the server pushes paragraph, change `` `track.added/.removed/.updated` (`paused`, `layers`) `` to `` `track.added/.removed/.updated` (`paused` to everyone; `layers` only to the subscriber it concerns: spatial layers being delivered, 0 none, 1 low, 2 medium, 3 high) ``.

- [ ] **Step 9: Full check and commit**

Run: `pnpm check`
Expected: typecheck, format and every workspace's tests green.

```sh
git add proto packages/sfu-proto packages/protocol packages/events services/sfu docs/superpowers/specs
git commit -F - <<'EOF'
feat(contracts): carry transport params in Stats snapshots, add lobby.left and the hello ack

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 1: Signaling workspace, env, ring buffer

**Files:**
- Create: `services/signaling/package.json`, `services/signaling/tsconfig.json`, `services/signaling/vitest.config.ts`, `services/signaling/src/env.ts`, `services/signaling/src/env.test.ts`, `services/signaling/src/room/types.ts`, `services/signaling/src/room/ring-buffer.ts`, `services/signaling/src/room/ring-buffer.test.ts`

**Interfaces:**
- Produces: `loadEnv(source?) -> Env` with the keys listed in Step 2; `Target`, `Emitted`, `Command`, `RoomSnapshot`, `RoomError`, `Outcome`, `DepartedReason`, `Section` (types.ts); `RingBuffer` (`push(e)`, `replay(participantId, afterSeq, currentSeq, isTarget)`, `evict(now)`, `oldestSeq`, `size`) and `matchesTarget(target, participantId, membership)` (ring-buffer.ts).

- [ ] **Step 1: Workspace files**

`services/signaling/package.json`:

```json
{
  "name": "@zoomclone/signaling",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "dev": "node --env-file-if-exists=../../.env --import tsx --watch src/main.ts",
    "start": "node --env-file-if-exists=../../.env --import tsx src/main.ts"
  },
  "dependencies": {
    "@bufbuild/protobuf": "2.14.1",
    "@connectrpc/connect": "2.2.0",
    "@connectrpc/connect-node": "2.2.0",
    "@zoomclone/db": "workspace:*",
    "@zoomclone/events": "workspace:*",
    "@zoomclone/protocol": "workspace:*",
    "@zoomclone/sfu-proto": "workspace:*",
    "@zoomclone/tokens": "workspace:*",
    "ioredis": "5.11.1",
    "jose": "6.2.12",
    "pino": "10.3.1",
    "prom-client": "15.1.3",
    "ws": "8.21.3",
    "zod": "4.6.2"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "@types/ws": "8.18.1",
    "@zoomclone/sfu": "workspace:*",
    "pino-pretty": "13.1.3",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`services/signaling/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`services/signaling/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
```

Run: `pnpm install`
Expected: lockfile updated with ws 8.21.3 and @types/ws 8.18.1; no peer warnings that mention signaling.

- [ ] **Step 2: Env (failing test first)**

`services/signaling/src/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const base = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://localhost:56379/1",
};

describe("signaling env", () => {
  it("applies defaults and parses the SFU endpoint list", () => {
    const env = loadEnv(base);
    expect(env.SIGNALING_PORT).toBe(8081);
    expect(env.TOKEN_ISSUER).toBe("meeting-api");
    expect(env.MEETING_API_JWKS_URL).toBe("http://localhost:8080/.well-known/jwks.json");
    expect(env.SFU_ENDPOINTS).toEqual({ "sfu-local-1": "http://localhost:9090" });
    expect(env.DISCONNECT_GRACE_MS).toBe(30_000);
    expect(env.ROOM_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(env.HELLO_TIMEOUT_MS).toBe(5_000);
    expect(env.PING_TIMEOUT_MS).toBe(30_000);
    expect(env.CHECKPOINT_WINDOW_MS).toBe(50);
    expect(env.HEARTBEAT_MS).toBe(5_000);
    expect(env.OWNER_LEASE_MS).toBe(15_000);
    expect(env.RING_BUFFER_SIZE).toBe(500);
    expect(env.RING_BUFFER_MS).toBe(60_000);
    expect(env.DEPARTED_TTL_MS).toBe(600_000);
    expect(env.MAX_BUFFERED_BYTES).toBe(1_048_576);
    expect(env.DEV_HARNESS).toBe(false);
  });

  it("parses several SFU endpoints and rejects malformed entries", () => {
    expect(
      loadEnv({ ...base, SFU_ENDPOINTS: "a=http://a:9090, b=http://b:9090" }).SFU_ENDPOINTS,
    ).toEqual({ a: "http://a:9090", b: "http://b:9090" });
    expect(() => loadEnv({ ...base, SFU_ENDPOINTS: "nonsense" })).toThrow();
  });

  it("requires the database and redis urls", () => {
    expect(() => loadEnv({ REDIS_URL: "redis://x" })).toThrow();
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- env`
Expected: FAIL (`./env` not found).

- [ ] **Step 3: Implement env**

`services/signaling/src/env.ts`:

```ts
import { z } from "zod";

const bool = z.stringbool().default(false);

/** "id=url,id=url" -> { id: url }. */
const endpoints = z
  .string()
  .default("sfu-local-1=http://localhost:9090")
  .transform((raw, ctx) => {
    const out: Record<string, string> = {};
    for (const part of raw.split(",")) {
      const entry = part.trim();
      if (!entry) continue;
      const eq = entry.indexOf("=");
      if (eq <= 0 || eq === entry.length - 1) {
        ctx.addIssue({ code: "custom", message: `SFU_ENDPOINTS entry "${entry}" is not id=url` });
        return z.NEVER;
      }
      out[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
    }
    if (Object.keys(out).length === 0) {
      ctx.addIssue({ code: "custom", message: "SFU_ENDPOINTS must list at least one SFU" });
      return z.NEVER;
    }
    return out;
  });

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  SIGNALING_PORT: z.coerce.number().int().default(8081),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  TOKEN_ISSUER: z.string().default("meeting-api"),
  MEETING_API_JWKS_URL: z.string().default("http://localhost:8080/.well-known/jwks.json"),
  SFU_ENDPOINTS: endpoints,
  DISCONNECT_GRACE_MS: z.coerce.number().int().min(10).default(30_000),
  ROOM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(10).default(300_000),
  HELLO_TIMEOUT_MS: z.coerce.number().int().min(10).default(5_000),
  // Three missed 10 s pings (design doc): the watchdog closes 4000 past this silence.
  PING_TIMEOUT_MS: z.coerce.number().int().min(10).default(30_000),
  CHECKPOINT_WINDOW_MS: z.coerce.number().int().min(1).default(50),
  HEARTBEAT_MS: z.coerce.number().int().min(10).default(5_000),
  OWNER_LEASE_MS: z.coerce.number().int().min(20).default(15_000),
  RING_BUFFER_SIZE: z.coerce.number().int().min(1).default(500),
  RING_BUFFER_MS: z.coerce.number().int().min(10).default(60_000),
  DEPARTED_TTL_MS: z.coerce.number().int().min(10).default(600_000),
  MAX_BUFFERED_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
  DEV_HARNESS: bool,
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
```

Run: `pnpm --filter @zoomclone/signaling test -- env`
Expected: PASS (3 tests).

- [ ] **Step 4: Room types**

`services/signaling/src/room/types.ts`:

```ts
import type {
  LobbyEntry,
  Role,
  RoomEvent,
  RosterEntry,
  TrackInfo,
  WsErrorCode,
} from "@zoomclone/protocol";

/** Who receives an event. Resolved over the roster (and lobby for "everyone") at fanout time. */
export type Target =
  | { kind: "all" }
  | { kind: "hosts" }
  | { kind: "everyone" }
  | { kind: "only"; participant_ids: string[] }
  | { kind: "all_except"; participant_id: string };

export type Emitted = { event: RoomEvent; target: Target; at: number };

export type DepartedReason = "removed" | "denied" | "grace";
export type Departed = { reason: DepartedReason; at: string };

/** Checkpoint sections; the write-behind writer only rewrites dirty ones. */
export type Section = "meta" | "roster" | "lobby" | "tracks" | "departed";

export type RoomSnapshot = {
  session_id: string;
  home_sfu: string;
  epoch: number;
  seq: number;
  status: "live" | "ended";
  end_reason: string | null;
  locked: boolean;
  lobby_enabled: boolean;
  recording: boolean;
  max_participants: number;
  host_ids: string[];
  peak: number;
  roster: RosterEntry[];
  lobby: LobbyEntry[];
  tracks: TrackInfo[];
  departed: Record<string, Departed>;
};

export type Command =
  | { type: "join"; participant_id: string; name: string; role: Role }
  | { type: "lobby_request"; participant_id: string; name: string }
  | { type: "lobby_leave"; participant_id: string }
  | { type: "admit"; actor: string; participant_id: string }
  | { type: "deny"; actor: string; participant_id: string }
  | { type: "disconnect"; participant_id: string }
  | { type: "reconnect"; participant_id: string }
  | { type: "leave"; participant_id: string }
  | { type: "remove"; actor: string; participant_id: string }
  | { type: "publish"; participant_id: string; track: TrackInfo }
  | { type: "unpublish"; participant_id: string; track_id: string }
  | { type: "track_lost"; track_id: string }
  | { type: "track_layers"; participant_id: string; track_id: string; layers: number }
  | { type: "set_media_state"; participant_id: string; muted?: boolean; video_off?: boolean }
  | { type: "host_mute"; actor: string; participant_id: string }
  | { type: "hand"; participant_id: string; raised: boolean }
  | { type: "chat"; from: string; body: string; to?: string }
  | { type: "reaction"; from: string; emoji: string }
  | { type: "lock"; actor: string; locked: boolean }
  | { type: "active_speakers"; participant_ids: string[] }
  | { type: "end"; reason: string };

/** close is set when the rejection maps to a WebSocket close code (hello path). */
export type RoomError = { code: WsErrorCode; message: string; close?: number };

export type Outcome = { ok: true; events: Emitted[] } | { ok: false; error: RoomError };

export type Membership = {
  inRoster: (participantId: string) => boolean;
  isHost: (participantId: string) => boolean;
  inLobby: (participantId: string) => boolean;
};
```

- [ ] **Step 5: Ring buffer (failing test first)**

`services/signaling/src/room/ring-buffer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RoomEvent } from "@zoomclone/protocol";
import { RingBuffer, matchesTarget } from "./ring-buffer";
import type { Emitted, Membership, Target } from "./types";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const HOST = "33333333-3333-4333-8333-333333333333";
const WAITER = "44444444-4444-4444-8444-444444444444";

const membership: Membership = {
  inRoster: (id) => [P1, P2, HOST].includes(id),
  isHost: (id) => id === HOST,
  inLobby: (id) => id === WAITER,
};

function emitted(seq: number, target: Target, at = 0): Emitted {
  const event: RoomEvent = { type: "reaction", seq, payload: { from: P1, emoji: "x" } };
  return { event, target, at };
}

describe("matchesTarget", () => {
  it("resolves every target kind against the membership", () => {
    expect(matchesTarget({ kind: "all" }, P1, membership)).toBe(true);
    expect(matchesTarget({ kind: "all" }, WAITER, membership)).toBe(false);
    expect(matchesTarget({ kind: "hosts" }, HOST, membership)).toBe(true);
    expect(matchesTarget({ kind: "hosts" }, P1, membership)).toBe(false);
    expect(matchesTarget({ kind: "everyone" }, WAITER, membership)).toBe(true);
    expect(matchesTarget({ kind: "everyone" }, "nobody", membership)).toBe(false);
    expect(matchesTarget({ kind: "only", participant_ids: [WAITER] }, WAITER, membership)).toBe(true);
    expect(matchesTarget({ kind: "only", participant_ids: [WAITER] }, P1, membership)).toBe(false);
    expect(matchesTarget({ kind: "all_except", participant_id: P1 }, P1, membership)).toBe(false);
    expect(matchesTarget({ kind: "all_except", participant_id: P1 }, P2, membership)).toBe(true);
  });
});

describe("RingBuffer", () => {
  it("replays only the events after the cursor that target the participant", () => {
    const buffer = new RingBuffer({ maxSize: 500, maxAgeMs: 60_000 });
    buffer.push(emitted(1, { kind: "all" }));
    buffer.push(emitted(2, { kind: "hosts" }));
    buffer.push(emitted(3, { kind: "all_except", participant_id: P1 }));
    buffer.push(emitted(4, { kind: "only", participant_ids: [P1] }));
    const replay = buffer.replay(P1, 1, 4, membership);
    expect(replay?.map((e) => e.seq)).toEqual([4]);
    expect(buffer.replay(HOST, 0, 4, membership)?.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("returns an empty replay when the cursor is current and null when it is ahead", () => {
    const buffer = new RingBuffer({ maxSize: 500, maxAgeMs: 60_000 });
    buffer.push(emitted(1, { kind: "all" }));
    expect(buffer.replay(P1, 1, 1, membership)).toEqual([]);
    expect(buffer.replay(P1, 5, 1, membership)).toBeNull();
  });

  it("returns null once the needed events fell out of the size window", () => {
    const buffer = new RingBuffer({ maxSize: 3, maxAgeMs: 60_000 });
    for (let seq = 1; seq <= 5; seq++) buffer.push(emitted(seq, { kind: "all" }));
    expect(buffer.size).toBe(3);
    expect(buffer.oldestSeq).toBe(3);
    expect(buffer.replay(P1, 1, 5, membership)).toBeNull();
    expect(buffer.replay(P1, 2, 5, membership)?.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("evicts by age on push and on demand", () => {
    const buffer = new RingBuffer({ maxSize: 500, maxAgeMs: 1_000 });
    buffer.push(emitted(1, { kind: "all" }, 0));
    buffer.push(emitted(2, { kind: "all" }, 500));
    buffer.push(emitted(3, { kind: "all" }, 1_600));
    expect(buffer.oldestSeq).toBe(2);
    buffer.evict(3_000);
    expect(buffer.size).toBe(0);
    expect(buffer.replay(P1, 2, 3, membership)).toBeNull();
    expect(buffer.replay(P1, 3, 3, membership)).toEqual([]);
  });

  it("an empty buffer replays nothing when the cursor is current", () => {
    const buffer = new RingBuffer({ maxSize: 500, maxAgeMs: 60_000 });
    expect(buffer.replay(P1, 0, 0, membership)).toEqual([]);
    expect(buffer.replay(P1, 0, 3, membership)).toBeNull();
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- ring-buffer`
Expected: FAIL (`./ring-buffer` not found).

- [ ] **Step 6: Implement the ring buffer**

`services/signaling/src/room/ring-buffer.ts`:

```ts
import type { RoomEvent } from "@zoomclone/protocol";
import type { Emitted, Membership, Target } from "./types";

export function matchesTarget(target: Target, participantId: string, m: Membership): boolean {
  switch (target.kind) {
    case "all":
      return m.inRoster(participantId);
    case "hosts":
      return m.inRoster(participantId) && m.isHost(participantId);
    case "everyone":
      return m.inRoster(participantId) || m.inLobby(participantId);
    case "only":
      return target.participant_ids.includes(participantId);
    case "all_except":
      return participantId !== target.participant_id && m.inRoster(participantId);
  }
}

/**
 * Replay window for reconnects (design doc: last 500 events or 60 s). Entries are appended in
 * seq order; eviction drops from the head by size and by age.
 */
export class RingBuffer {
  private entries: Emitted[] = [];

  constructor(private readonly opts: { maxSize: number; maxAgeMs: number }) {}

  get size(): number {
    return this.entries.length;
  }

  /** Seq of the oldest retained event, or null when empty. */
  get oldestSeq(): number | null {
    return this.entries[0]?.event.seq ?? null;
  }

  push(e: Emitted): void {
    this.entries.push(e);
    this.evict(e.at);
  }

  evict(now: number): void {
    const cutoff = now - this.opts.maxAgeMs;
    let drop = 0;
    while (
      drop < this.entries.length &&
      (this.entries.length - drop > this.opts.maxSize || this.entries[drop]!.at < cutoff)
    ) {
      drop++;
    }
    if (drop > 0) this.entries = this.entries.slice(drop);
  }

  /**
   * Events with seq > afterSeq addressed to the participant, or null when the buffer no longer
   * covers afterSeq + 1 (the caller must resync). afterSeq === currentSeq means nothing missed.
   */
  replay(
    participantId: string,
    afterSeq: number,
    currentSeq: number,
    membership: Membership,
  ): RoomEvent[] | null {
    if (afterSeq > currentSeq) return null;
    if (afterSeq === currentSeq) return [];
    const oldest = this.oldestSeq;
    if (oldest === null || oldest > afterSeq + 1) return null;
    return this.entries
      .filter((e) => e.event.seq > afterSeq && matchesTarget(e.target, participantId, membership))
      .map((e) => e.event);
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test`
Expected: PASS (8 tests across env and ring-buffer).

- [ ] **Step 7: Full check and commit**

Run: `pnpm check`

```sh
git add pnpm-lock.yaml services/signaling
git commit -F - <<'EOF'
feat(signaling): scaffold the service with env and the replay ring buffer

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 2: Room state machine (pure)

**Files:**
- Create: `services/signaling/src/room/room.ts`, `services/signaling/src/room/room.test.ts`

**Interfaces:**
- Consumes: `RingBuffer`, `matchesTarget` (Task 1), the types in `types.ts`, `HOST_ROLES`, `CloseCode`, `RoomEvent`, `RosterEntry`, `LobbyEntry`, `TrackInfo`, `Welcome` from `@zoomclone/protocol`.
- Produces: `class Room` with `static create(init: RoomInit, opts?: RoomOptions)`, `static fromSnapshot(snapshot, { bumpEpoch }, opts?)`, `apply(command, now?) -> Outcome`, `canJoin(participantId, role) -> RoomError | null` (hello-time pre-check, no mutation), `replay(participantId, afterSeq, now?) -> RoomEvent[] | null`, `welcomeFor(participantId) -> Welcome` (no `media`; the controller adds it), `toSnapshot()`, `takeDirty() -> Set<Section>`, `markAllDirty()`, `membership() -> Membership`, and read accessors `sessionId`, `homeSfu`, `epoch`, `seq`, `status`, `endReason`, `locked`, `lobbyEnabled`, `recording`, `maxParticipants`, `peak`, `hostIds()`, `roster()`, `rosterEntry(id)`, `inRoster(id)`, `rosterIds()`, `lobby()`, `inLobby(id)`, `lobbyIds()`, `tracks()`, `track(id)`, `tracksOf(owner, source?)`, `departed(id)`, `isHost(id)`, `isIdle()`. `RoomInit = { session_id; home_sfu; lobby_enabled; max_participants; epoch? }`, `RoomOptions = { ringSize; ringMs; departedTtlMs }`, `DEFAULT_ROOM_OPTIONS`.
- Rules the controller relies on: `join` / `lobby_request` errors carry `close` (4009 locked, 4007 capacity, 4002 / 4003 / 4008 departed, 4004 ended); `leave` on an unknown participant is a no-op (`ok`, no events); `track_lost` on an unknown track is a no-op; `end` is idempotent; every other command on an ended room fails `FORBIDDEN` with `close: 4004`.

- [ ] **Step 1: Failing tests**

`services/signaling/src/room/room.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CloseCode, ServerMessageSchema, type TrackInfo } from "@zoomclone/protocol";
import { Room, type RoomInit } from "./room";
import type { Emitted, Outcome } from "./types";

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const W = "44444444-4444-4444-8444-444444444444";
const T0 = Date.parse("2026-09-10T10:00:00.000Z");

function fresh(overrides: Partial<RoomInit> = {}): Room {
  return Room.create({
    session_id: S,
    home_sfu: "sfu-local-1",
    lobby_enabled: true,
    max_participants: 4,
    ...overrides,
  });
}

function must(outcome: Outcome): Emitted[] {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}: ${outcome.error.message}`);
  for (const e of outcome.events) expect(ServerMessageSchema.safeParse(e.event).success).toBe(true);
  return outcome.events;
}

function mustFail(outcome: Outcome) {
  if (outcome.ok) throw new Error("expected failure");
  return outcome.error;
}

function types(events: Emitted[]): string[] {
  return events.map((e) => e.event.type);
}

function track(owner: string, id: string, source: TrackInfo["source"] = "mic"): TrackInfo {
  return {
    track_id: id,
    owner,
    kind: source === "mic" || source === "screen_audio" ? "audio" : "video",
    source,
    paused: false,
    layers: source === "camera" ? 3 : 1,
  };
}

/** Host plus two attendees joined, one mic and one camera track for A. */
function seeded(): Room {
  const room = fresh();
  must(room.apply({ type: "join", participant_id: HOST, name: "Host", role: "host" }, T0));
  must(room.apply({ type: "join", participant_id: A, name: "Ann", role: "attendee" }, T0 + 1));
  must(room.apply({ type: "join", participant_id: B, name: "Bob", role: "attendee" }, T0 + 2));
  must(room.apply({ type: "publish", participant_id: A, track: track(A, "t-a-mic") }, T0 + 3));
  must(room.apply({ type: "publish", participant_id: A, track: track(A, "t-a-cam", "camera") }, T0 + 4));
  return room;
}

describe("Room: joining", () => {
  it("adds to the roster, tracks peak and hosts, and tells everyone except the joiner", () => {
    const room = fresh();
    const events = must(
      room.apply({ type: "join", participant_id: HOST, name: "Host", role: "host" }, T0),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toEqual({
      type: "participant.joined",
      seq: 1,
      payload: {
        participant: {
          participant_id: HOST,
          name: "Host",
          role: "host",
          muted: false,
          video_off: false,
          hand: false,
          connected: true,
          joined_at: "2026-09-10T10:00:00.000Z",
        },
      },
    });
    expect(events[0]?.target).toEqual({ kind: "all_except", participant_id: HOST });
    expect(room.peak).toBe(1);
    expect(room.hostIds()).toEqual([HOST]);
    expect(room.isHost(HOST)).toBe(true);
    expect(room.isIdle()).toBe(false);
  });

  it.each([
    {
      name: "locked room refuses attendees with 4009",
      setup: (room: Room) => {
        must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
        must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
      },
      join: { participant_id: A, role: "attendee" as const },
      code: "LOCKED",
      close: CloseCode.LOCKED,
    },
    {
      name: "full room refuses with 4007",
      setup: (room: Room) => {
        for (const id of [HOST, A, B, W]) {
          must(room.apply({ type: "join", participant_id: id, name: id, role: "attendee" }, T0));
        }
      },
      join: { participant_id: "55555555-5555-4555-8555-555555555555", role: "attendee" as const },
      code: "CAPACITY",
      close: CloseCode.CAPACITY,
    },
    {
      name: "removed participant is refused with 4002",
      setup: (room: Room) => {
        must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
        must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
        must(room.apply({ type: "remove", actor: HOST, participant_id: A }, T0));
      },
      join: { participant_id: A, role: "attendee" as const },
      code: "FORBIDDEN",
      close: CloseCode.REMOVED,
    },
    {
      name: "denied waiter is refused with 4003",
      setup: (room: Room) => {
        must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
        must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
        must(room.apply({ type: "deny", actor: HOST, participant_id: W }, T0));
      },
      join: { participant_id: W, role: "attendee" as const },
      code: "FORBIDDEN",
      close: CloseCode.LOBBY_DENIED,
    },
    {
      name: "grace-expired participant is refused with 4008",
      setup: (room: Room) => {
        must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
        must(room.apply({ type: "disconnect", participant_id: A }, T0));
        must(room.apply({ type: "leave", participant_id: A }, T0));
      },
      join: { participant_id: A, role: "attendee" as const },
      code: "FORBIDDEN",
      close: CloseCode.REJOIN_REQUIRED,
    },
    {
      name: "ended room refuses with 4004",
      setup: (room: Room) => {
        must(room.apply({ type: "end", reason: "host_end" }, T0));
      },
      join: { participant_id: A, role: "attendee" as const },
      code: "FORBIDDEN",
      close: CloseCode.ROOM_ENDED,
    },
  ])("$name", ({ setup, join, code, close }) => {
    const room = fresh();
    setup(room);
    const error = mustFail(
      room.apply({ type: "join", participant_id: join.participant_id, name: "x", role: join.role }, T0),
    );
    expect(error.code).toBe(code);
    expect(error.close).toBe(close);
  });

  it("lets a host into a locked room and refuses duplicate joins", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    const second = "55555555-5555-4555-8555-555555555555";
    must(room.apply({ type: "join", participant_id: second, name: "H2", role: "host" }, T0));
    expect(mustFail(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0)).code).toBe(
      "INVALID",
    );
  });

  it("canJoin mirrors join's rejections without mutating anything", () => {
    const room = fresh({ max_participants: 2 });
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    expect(room.canJoin(A, "attendee")).toBeNull();
    must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    expect(room.canJoin(A, "attendee")).toMatchObject({ code: "LOCKED", close: CloseCode.LOCKED });
    expect(room.canJoin(A, "host")).toBeNull();
    must(room.apply({ type: "lock", actor: HOST, locked: false }, T0));
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
    expect(room.canJoin(B, "attendee")).toMatchObject({ code: "CAPACITY", close: CloseCode.CAPACITY });
    expect(room.canJoin(A, "attendee")).toMatchObject({ code: "INVALID" });
    must(room.apply({ type: "remove", actor: HOST, participant_id: A }, T0));
    expect(room.canJoin(A, "attendee")).toMatchObject({ code: "FORBIDDEN", close: CloseCode.REMOVED });
    expect(room.seq).toBe(room.toSnapshot().seq);
    must(room.apply({ type: "end", reason: "host_end" }, T0));
    expect(room.canJoin(B, "attendee")).toMatchObject({ close: CloseCode.ROOM_ENDED });
  });
});

describe("Room: lobby", () => {
  it("request notifies hosts, admit moves the waiter in with lobby.result then participant.joined", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    const request = must(room.apply({ type: "lobby_request", participant_id: W, name: "Wren" }, T0));
    expect(request[0]?.event).toMatchObject({
      type: "lobby.request",
      payload: { participant_id: W, name: "Wren" },
    });
    expect(request[0]?.target).toEqual({ kind: "hosts" });
    expect(room.inLobby(W)).toBe(true);
    expect(room.lobby()).toEqual([
      { participant_id: W, name: "Wren", requested_at: "2026-09-10T10:00:00.000Z" },
    ]);

    const admit = must(room.apply({ type: "admit", actor: HOST, participant_id: W }, T0 + 5));
    expect(types(admit)).toEqual(["lobby.result", "participant.joined"]);
    expect(admit[0]?.event.payload).toEqual({ admitted: true });
    expect(admit[0]?.target).toEqual({ kind: "only", participant_ids: [W] });
    expect(admit[1]?.target).toEqual({ kind: "all_except", participant_id: W });
    expect(room.inLobby(W)).toBe(false);
    expect(room.rosterEntry(W)).toMatchObject({ role: "attendee", connected: true });
  });

  it("deny answers the waiter, tells hosts lobby.left and marks the waiter departed", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    const deny = must(room.apply({ type: "deny", actor: HOST, participant_id: W }, T0));
    expect(types(deny)).toEqual(["lobby.result", "lobby.left"]);
    expect(deny[0]?.event.payload).toEqual({ admitted: false });
    expect(deny[1]?.target).toEqual({ kind: "hosts" });
    expect(room.departed(W)).toBe("denied");
    expect(room.lobby()).toEqual([]);
  });

  it("lobby_leave drops the waiter with lobby.left and is a no-op for strangers", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    expect(types(must(room.apply({ type: "lobby_leave", participant_id: W }, T0)))).toEqual(["lobby.left"]);
    expect(must(room.apply({ type: "lobby_leave", participant_id: W }, T0))).toEqual([]);
    expect(room.departed(W)).toBeUndefined();
  });

  it("waiters are refused while locked, and admit refuses when the room is full", () => {
    const room = fresh({ max_participants: 2 });
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
    expect(mustFail(room.apply({ type: "admit", actor: HOST, participant_id: W }, T0)).code).toBe("CAPACITY");
    must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    const locked = mustFail(room.apply({ type: "lobby_request", participant_id: B, name: "B" }, T0));
    expect(locked.close).toBe(CloseCode.LOCKED);
  });

  it("room end reaches waiters too", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    const ended = must(room.apply({ type: "end", reason: "host_end" }, T0));
    expect(ended[0]?.target).toEqual({ kind: "everyone" });
  });
});

describe("Room: host controls and roles", () => {
  it.each([
    { type: "admit", actor: A, participant_id: W },
    { type: "deny", actor: A, participant_id: W },
    { type: "host_mute", actor: A, participant_id: B },
    { type: "remove", actor: A, participant_id: B },
  ] as const)("$type from an attendee is FORBIDDEN (role comes from the roster)", (command) => {
    const room = seeded();
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    expect(mustFail(room.apply(command, T0)).code).toBe("FORBIDDEN");
  });

  it("lock from an attendee is FORBIDDEN and from a host emits room.updated once", () => {
    const room = seeded();
    expect(mustFail(room.apply({ type: "lock", actor: A, locked: true }, T0)).code).toBe("FORBIDDEN");
    const events = must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    expect(events[0]?.event).toMatchObject({ type: "room.updated", payload: { locked: true } });
    expect(must(room.apply({ type: "lock", actor: HOST, locked: true }, T0))).toEqual([]);
    expect(room.locked).toBe(true);
  });

  it("remove drops the participant and their tracks, refuses self and hosts, and denies waiters", () => {
    const room = seeded();
    const events = must(room.apply({ type: "remove", actor: HOST, participant_id: A }, T0 + 10));
    expect(types(events)).toEqual(["track.removed", "track.removed", "participant.left"]);
    expect(events[2]?.event.payload).toEqual({ participant_id: A, reason: "removed" });
    expect(room.inRoster(A)).toBe(false);
    expect(room.tracks()).toEqual([]);
    expect(room.departed(A)).toBe("removed");
    expect(mustFail(room.apply({ type: "remove", actor: HOST, participant_id: HOST }, T0)).code).toBe("INVALID");
    const second = "55555555-5555-4555-8555-555555555555";
    must(room.apply({ type: "join", participant_id: second, name: "H2", role: "host" }, T0));
    expect(mustFail(room.apply({ type: "remove", actor: HOST, participant_id: second }, T0)).code).toBe(
      "FORBIDDEN",
    );
    expect(mustFail(room.apply({ type: "remove", actor: HOST, participant_id: W }, T0)).code).toBe("NOT_FOUND");
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    const waiter = must(room.apply({ type: "remove", actor: HOST, participant_id: W }, T0));
    expect(types(waiter)).toEqual(["lobby.result", "lobby.left"]);
    expect(room.departed(W)).toBe("denied");
  });

  it("host_mute mutes the target and pauses their mic tracks", () => {
    const room = seeded();
    const events = must(room.apply({ type: "host_mute", actor: HOST, participant_id: A }, T0));
    expect(types(events)).toEqual(["participant.updated", "track.updated"]);
    expect(events[0]?.event.payload).toEqual({ participant_id: A, patch: { muted: true } });
    expect(events[1]?.event.payload).toEqual({ track_id: "t-a-mic", patch: { paused: true } });
    expect(room.rosterEntry(A)?.muted).toBe(true);
    expect(room.track("t-a-mic")?.paused).toBe(true);
    expect(room.track("t-a-cam")?.paused).toBe(false);
    expect(must(room.apply({ type: "host_mute", actor: HOST, participant_id: A }, T0))).toEqual([]);
  });
});

describe("Room: presence", () => {
  it("disconnect and reconnect toggle connected, notify the others, and are idempotent", () => {
    const room = seeded();
    const off = must(room.apply({ type: "disconnect", participant_id: A }, T0));
    expect(off[0]?.event).toMatchObject({
      type: "participant.updated",
      payload: { participant_id: A, patch: { connected: false } },
    });
    expect(off[0]?.target).toEqual({ kind: "all_except", participant_id: A });
    expect(must(room.apply({ type: "disconnect", participant_id: A }, T0))).toEqual([]);
    const on = must(room.apply({ type: "reconnect", participant_id: A }, T0));
    expect(on[0]?.event.payload).toEqual({ participant_id: A, patch: { connected: true } });
    expect(must(room.apply({ type: "reconnect", participant_id: A }, T0))).toEqual([]);
    expect(mustFail(room.apply({ type: "disconnect", participant_id: W }, T0)).code).toBe("NOT_FOUND");
  });

  it("leave after the grace removes tracks, reports timeout, marks departed grace, and is a no-op twice", () => {
    const room = seeded();
    const events = must(room.apply({ type: "leave", participant_id: A }, T0));
    expect(types(events)).toEqual(["track.removed", "track.removed", "participant.left"]);
    expect(events[2]?.event.payload).toEqual({ participant_id: A, reason: "timeout" });
    expect(events[2]?.target).toEqual({ kind: "all" });
    expect(room.departed(A)).toBe("grace");
    expect(must(room.apply({ type: "leave", participant_id: A }, T0))).toEqual([]);
    expect(room.peak).toBe(3);
  });

  it("is idle only when roster and lobby are both empty", () => {
    const room = fresh();
    expect(room.isIdle()).toBe(true);
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    expect(room.isIdle()).toBe(false);
    must(room.apply({ type: "lobby_leave", participant_id: W }, T0));
    expect(room.isIdle()).toBe(true);
  });
});

describe("Room: tracks and media state", () => {
  it("publish adds a track for everyone; owner mismatch and duplicates are rejected", () => {
    const room = seeded();
    const events = must(
      room.apply({ type: "publish", participant_id: B, track: track(B, "t-b-mic") }, T0),
    );
    expect(events[0]?.event).toMatchObject({ type: "track.added", payload: { track: { track_id: "t-b-mic" } } });
    expect(events[0]?.target).toEqual({ kind: "all" });
    expect(mustFail(room.apply({ type: "publish", participant_id: B, track: track(A, "t-x") }, T0)).code).toBe(
      "INVALID",
    );
    expect(
      mustFail(room.apply({ type: "publish", participant_id: B, track: track(B, "t-b-mic") }, T0)).code,
    ).toBe("INVALID");
    expect(mustFail(room.apply({ type: "publish", participant_id: W, track: track(W, "t-w") }, T0)).code).toBe(
      "NOT_FOUND",
    );
  });

  it("unpublish requires the owner; track_lost is a no-op for unknown tracks", () => {
    const room = seeded();
    expect(mustFail(room.apply({ type: "unpublish", participant_id: B, track_id: "t-a-mic" }, T0)).code).toBe(
      "FORBIDDEN",
    );
    expect(mustFail(room.apply({ type: "unpublish", participant_id: A, track_id: "nope" }, T0)).code).toBe(
      "NOT_FOUND",
    );
    expect(types(must(room.apply({ type: "unpublish", participant_id: A, track_id: "t-a-mic" }, T0)))).toEqual([
      "track.removed",
    ]);
    expect(types(must(room.apply({ type: "track_lost", track_id: "t-a-cam" }, T0)))).toEqual(["track.removed"]);
    expect(must(room.apply({ type: "track_lost", track_id: "t-a-cam" }, T0))).toEqual([]);
    expect(room.tracks()).toEqual([]);
  });

  it("track_layers goes only to the subscriber and changes no state", () => {
    const room = seeded();
    const events = must(
      room.apply({ type: "track_layers", participant_id: B, track_id: "t-a-cam", layers: 1 }, T0),
    );
    expect(events[0]?.event).toMatchObject({
      type: "track.updated",
      payload: { track_id: "t-a-cam", patch: { layers: 1 } },
    });
    expect(events[0]?.target).toEqual({ kind: "only", participant_ids: [B] });
    expect(room.takeDirty().size).toBe(0);
    expect(must(room.apply({ type: "track_layers", participant_id: B, track_id: "gone", layers: 1 }, T0))).toEqual(
      [],
    );
  });

  it("set_media_state patches only what changed and pauses the matching tracks", () => {
    const room = seeded();
    const muted = must(room.apply({ type: "set_media_state", participant_id: A, muted: true }, T0));
    expect(types(muted)).toEqual(["participant.updated", "track.updated"]);
    expect(muted[1]?.event.payload).toEqual({ track_id: "t-a-mic", patch: { paused: true } });
    expect(must(room.apply({ type: "set_media_state", participant_id: A, muted: true }, T0))).toEqual([]);
    const video = must(
      room.apply({ type: "set_media_state", participant_id: A, muted: true, video_off: true }, T0),
    );
    expect(video[0]?.event.payload).toEqual({ participant_id: A, patch: { video_off: true } });
    expect(video[1]?.event.payload).toEqual({ track_id: "t-a-cam", patch: { paused: true } });
    const both = must(
      room.apply({ type: "set_media_state", participant_id: A, muted: false, video_off: false }, T0),
    );
    expect(both[0]?.event.payload).toEqual({
      participant_id: A,
      patch: { muted: false, video_off: false },
    });
    expect(types(both)).toEqual(["participant.updated", "track.updated", "track.updated"]);
    expect(must(room.apply({ type: "set_media_state", participant_id: A }, T0))).toEqual([]);
  });

  it("a track published while muted keeps the paused flag it was given", () => {
    const room = seeded();
    must(room.apply({ type: "set_media_state", participant_id: B, muted: true }, T0));
    expect(room.rosterEntry(B)?.muted).toBe(true);
    must(room.apply({ type: "publish", participant_id: B, track: { ...track(B, "t-b-mic"), paused: true } }, T0));
    expect(room.track("t-b-mic")?.paused).toBe(true);
    const unmute = must(room.apply({ type: "set_media_state", participant_id: B, muted: false }, T0));
    expect(unmute[1]?.event.payload).toEqual({ track_id: "t-b-mic", patch: { paused: false } });
  });
});

describe("Room: hand, chat, reactions, active speakers", () => {
  it("hand emits the hand event only when the flag changes", () => {
    const room = seeded();
    const up = must(room.apply({ type: "hand", participant_id: A, raised: true }, T0));
    expect(up.map((e) => e.event)).toEqual([{ type: "hand", seq: 6, payload: { participant_id: A, raised: true } }]);
    expect(must(room.apply({ type: "hand", participant_id: A, raised: true }, T0))).toEqual([]);
    expect(room.rosterEntry(A)?.hand).toBe(true);
  });

  it("chat broadcasts to all, direct messages reach sender and recipient, unknown recipients fail", () => {
    const room = seeded();
    const all = must(room.apply({ type: "chat", from: A, body: "hi" }, T0));
    expect(all[0]?.event.payload).toEqual({ from: A, body: "hi", sent_at: "2026-09-10T10:00:00.000Z" });
    expect(all[0]?.target).toEqual({ kind: "all" });
    const dm = must(room.apply({ type: "chat", from: A, body: "psst", to: B }, T0));
    expect(dm[0]?.event.payload).toMatchObject({ from: A, to: B, body: "psst" });
    expect(dm[0]?.target).toEqual({ kind: "only", participant_ids: [A, B] });
    expect(mustFail(room.apply({ type: "chat", from: A, body: "x", to: W }, T0)).code).toBe("NOT_FOUND");
    expect(mustFail(room.apply({ type: "chat", from: W, body: "x" }, T0)).code).toBe("NOT_FOUND");
  });

  it("reactions and active_speakers fan to all; active_speakers dirties nothing", () => {
    const room = seeded();
    room.takeDirty();
    const reaction = must(room.apply({ type: "reaction", from: A, emoji: "clap" }, T0));
    expect(reaction[0]?.event.payload).toEqual({ from: A, emoji: "clap" });
    const speakers = must(room.apply({ type: "active_speakers", participant_ids: [A] }, T0));
    expect(speakers[0]?.event).toMatchObject({ type: "active_speakers", payload: { participant_ids: [A] } });
    expect(speakers[0]?.target).toEqual({ kind: "all" });
    expect(room.takeDirty().size).toBe(0);
  });
});

describe("Room: end", () => {
  it("emits room.ended to everyone, is idempotent, and blocks every later command with 4004", () => {
    const room = seeded();
    const events = must(room.apply({ type: "end", reason: "host_end" }, T0));
    expect(events.map((e) => e.event)).toEqual([
      { type: "room.ended", seq: 6, payload: { reason: "host_end" } },
    ]);
    expect(room.status).toBe("ended");
    expect(room.endReason).toBe("host_end");
    expect(must(room.apply({ type: "end", reason: "api_end" }, T0))).toEqual([]);
    expect(room.endReason).toBe("host_end");
    const error = mustFail(room.apply({ type: "reaction", from: A, emoji: "x" }, T0));
    expect(error.code).toBe("FORBIDDEN");
    expect(error.close).toBe(CloseCode.ROOM_ENDED);
  });
});

describe("Room: seq, replay and welcome", () => {
  it("seq is monotonic across commands and welcome carries the current value", () => {
    const room = seeded();
    expect(room.seq).toBe(5);
    must(room.apply({ type: "reaction", from: A, emoji: "x" }, T0));
    expect(room.seq).toBe(6);
    expect(room.welcomeFor(A).seq).toBe(6);
  });

  it("replays only the events addressed to the participant since the cursor", () => {
    const room = fresh();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0)); // 1
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0)); // 2 all_except A
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0)); // 3 hosts
    must(room.apply({ type: "reaction", from: HOST, emoji: "x" }, T0)); // 4 all
    must(room.apply({ type: "chat", from: HOST, body: "dm", to: A }, T0)); // 5 only [HOST, A]
    expect(room.replay(A, 1, T0)?.map((e) => e.seq)).toEqual([4, 5]);
    expect(room.replay(HOST, 1, T0)?.map((e) => e.seq)).toEqual([2, 3, 4, 5]);
    expect(room.replay(A, 5, T0)).toEqual([]);
    expect(room.replay(A, 9, T0)).toBeNull();
  });

  it("forces a resync once the window (500 events or 60 s) no longer covers the cursor", () => {
    const room = seeded();
    for (let i = 0; i < 500; i++) must(room.apply({ type: "reaction", from: A, emoji: "x" }, T0 + i));
    expect(room.replay(B, 5, T0 + 500)).toBeNull();
    expect(room.replay(B, 6, T0 + 500)).toHaveLength(499);
    expect(room.replay(B, 6, T0 + 500 + 60_000)).toBeNull();
    expect(room.replay(B, room.seq, T0 + 500 + 60_000)).toEqual([]);
  });

  it("welcome: joined members get roster, tracks and meta, hosts also the lobby, waiters only ids", () => {
    const room = seeded();
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    const host = room.welcomeFor(HOST);
    expect(host).toMatchObject({ participant_id: HOST, role: "host", epoch: 1, seq: 6, state: "joined" });
    expect(host.roster?.map((r) => r.participant_id)).toEqual([HOST, A, B]);
    expect(host.tracks?.map((t) => t.track_id)).toEqual(["t-a-mic", "t-a-cam"]);
    expect(host.lobby?.map((l) => l.participant_id)).toEqual([W]);
    expect(host.room_meta).toEqual({
      session_id: S,
      locked: false,
      lobby_enabled: true,
      recording: false,
      host_ids: [HOST],
      max_participants: 4,
    });
    expect(host.media).toBeUndefined();
    const attendee = room.welcomeFor(A);
    expect(attendee.lobby).toBeUndefined();
    expect(room.welcomeFor(W)).toEqual({ participant_id: W, role: "attendee", epoch: 1, seq: 6, state: "lobby" });
    expect(() => room.welcomeFor("nobody")).toThrow();
  });
});

describe("Room: snapshot, dirty tracking, departed expiry", () => {
  it("round-trips through a snapshot; rehydrating bumps the epoch and disconnects everyone", () => {
    const room = seeded();
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    must(room.apply({ type: "lock", actor: HOST, locked: true }, T0));
    must(room.apply({ type: "remove", actor: HOST, participant_id: B }, T0));
    const snapshot = room.toSnapshot();
    expect(snapshot).toMatchObject({
      session_id: S,
      home_sfu: "sfu-local-1",
      epoch: 1,
      seq: room.seq,
      status: "live",
      end_reason: null,
      locked: true,
      lobby_enabled: true,
      recording: false,
      max_participants: 4,
      host_ids: [HOST],
      peak: 3,
    });
    expect(snapshot.departed[B]).toMatchObject({ reason: "removed" });
    const same = Room.fromSnapshot(snapshot, { bumpEpoch: false });
    expect(same.toSnapshot()).toEqual(snapshot);
    const rehydrated = Room.fromSnapshot(snapshot, { bumpEpoch: true });
    expect(rehydrated.epoch).toBe(2);
    expect(rehydrated.roster().every((r) => !r.connected)).toBe(true);
    expect(rehydrated.seq).toBe(snapshot.seq);
    expect(rehydrated.replay(A, snapshot.seq - 1, T0)).toBeNull();
    expect(rehydrated.departed(B)).toBe("removed");
    expect(rehydrated.inLobby(W)).toBe(true);
  });

  it("tracks dirty sections per command and clears them on takeDirty", () => {
    const room = fresh();
    room.takeDirty();
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    expect([...room.takeDirty()].sort()).toEqual(["meta", "roster"]);
    must(room.apply({ type: "lobby_request", participant_id: W, name: "W" }, T0));
    expect([...room.takeDirty()]).toEqual(["lobby"]);
    must(room.apply({ type: "publish", participant_id: HOST, track: track(HOST, "t") }, T0));
    expect([...room.takeDirty()]).toEqual(["tracks"]);
    must(room.apply({ type: "deny", actor: HOST, participant_id: W }, T0));
    expect([...room.takeDirty()].sort()).toEqual(["departed", "lobby"]);
    must(room.apply({ type: "reaction", from: HOST, emoji: "x" }, T0));
    expect(room.takeDirty().size).toBe(0);
    room.markAllDirty();
    expect(room.takeDirty().size).toBe(5);
  });

  it("forgets departed participants after the ttl", () => {
    const room = Room.create(
      { session_id: S, home_sfu: "sfu-local-1", lobby_enabled: false, max_participants: 4 },
      { ringSize: 500, ringMs: 60_000, departedTtlMs: 1_000 },
    );
    must(room.apply({ type: "join", participant_id: HOST, name: "H", role: "host" }, T0));
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0));
    must(room.apply({ type: "remove", actor: HOST, participant_id: A }, T0));
    expect(mustFail(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0 + 999)).close).toBe(
      CloseCode.REMOVED,
    );
    must(room.apply({ type: "join", participant_id: A, name: "A", role: "attendee" }, T0 + 1_000));
    expect(room.departed(A)).toBeUndefined();
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- room.test`
Expected: FAIL (`./room` not found).

- [ ] **Step 2: Implement the Room**

`services/signaling/src/room/room.ts`:

```ts
import {
  CloseCode,
  HOST_ROLES,
  type LobbyEntry,
  type MediaSource,
  type Role,
  type RoomEvent,
  type RoomMeta,
  type RosterEntry,
  type TrackInfo,
  type Welcome,
  type WsErrorCode,
} from "@zoomclone/protocol";
import { RingBuffer } from "./ring-buffer";
import type {
  Command,
  Departed,
  DepartedReason,
  Emitted,
  Membership,
  Outcome,
  RoomError,
  RoomSnapshot,
  Section,
  Target,
} from "./types";

export type RoomOptions = { ringSize: number; ringMs: number; departedTtlMs: number };
export const DEFAULT_ROOM_OPTIONS: RoomOptions = {
  ringSize: 500,
  ringMs: 60_000,
  departedTtlMs: 600_000,
};

export type RoomInit = {
  session_id: string;
  home_sfu: string;
  lobby_enabled: boolean;
  max_participants: number;
  epoch?: number;
};

type Ctx = { now: number; iso: string; events: Emitted[] };
type EventOf<T extends RoomEvent["type"]> = Extract<RoomEvent, { type: T }>;

const CLOSE_BY_DEPARTED: Record<DepartedReason, number> = {
  removed: CloseCode.REMOVED,
  denied: CloseCode.LOBBY_DENIED,
  grace: CloseCode.REJOIN_REQUIRED,
};

function fail(code: WsErrorCode, message: string, close?: number): Outcome {
  return { ok: false, error: close === undefined ? { code, message } : { code, message, close } };
}

function ok(ctx: Ctx): Outcome {
  return { ok: true, events: ctx.events };
}

/**
 * Pure, synchronous room state (design doc "room/Room.ts"): roster, lobby, tracks, departed,
 * seq and the replay ring buffer. No I/O, no timers; the controller sequences SFU calls before
 * applying commands and fans the returned events out.
 */
export class Room {
  private readonly ring: RingBuffer;
  private readonly rosterMap = new Map<string, RosterEntry>();
  private readonly lobbyMap = new Map<string, LobbyEntry>();
  private readonly trackMap = new Map<string, TrackInfo>();
  private readonly departedMap = new Map<string, Departed>();
  private dirty = new Set<Section>();
  private _seq = 0;
  private _status: "live" | "ended" = "live";
  private _endReason: string | null = null;
  private _locked = false;
  private _recording = false;
  private _peak = 0;

  private constructor(
    readonly sessionId: string,
    readonly homeSfu: string,
    private _epoch: number,
    private readonly _lobbyEnabled: boolean,
    private readonly _maxParticipants: number,
    private readonly opts: RoomOptions,
  ) {
    this.ring = new RingBuffer({ maxSize: opts.ringSize, maxAgeMs: opts.ringMs });
  }

  static create(init: RoomInit, opts: RoomOptions = DEFAULT_ROOM_OPTIONS): Room {
    const room = new Room(
      init.session_id,
      init.home_sfu,
      init.epoch ?? 1,
      init.lobby_enabled,
      init.max_participants,
      opts,
    );
    room.markAllDirty();
    return room;
  }

  /** bumpEpoch: rehydrate on a new controller (nobody is connected to it yet). */
  static fromSnapshot(
    s: RoomSnapshot,
    { bumpEpoch }: { bumpEpoch: boolean },
    opts: RoomOptions = DEFAULT_ROOM_OPTIONS,
  ): Room {
    const room = new Room(
      s.session_id,
      s.home_sfu,
      bumpEpoch ? s.epoch + 1 : s.epoch,
      s.lobby_enabled,
      s.max_participants,
      opts,
    );
    room._seq = s.seq;
    room._status = s.status;
    room._endReason = s.end_reason;
    room._locked = s.locked;
    room._recording = s.recording;
    room._peak = s.peak;
    for (const entry of s.roster) {
      room.rosterMap.set(entry.participant_id, bumpEpoch ? { ...entry, connected: false } : { ...entry });
    }
    for (const entry of s.lobby) room.lobbyMap.set(entry.participant_id, { ...entry });
    for (const track of s.tracks) room.trackMap.set(track.track_id, { ...track });
    for (const [id, departed] of Object.entries(s.departed)) room.departedMap.set(id, { ...departed });
    room.markAllDirty();
    return room;
  }

  // ---- accessors ----

  get epoch(): number {
    return this._epoch;
  }
  get seq(): number {
    return this._seq;
  }
  get status(): "live" | "ended" {
    return this._status;
  }
  get endReason(): string | null {
    return this._endReason;
  }
  get locked(): boolean {
    return this._locked;
  }
  get lobbyEnabled(): boolean {
    return this._lobbyEnabled;
  }
  get recording(): boolean {
    return this._recording;
  }
  get maxParticipants(): number {
    return this._maxParticipants;
  }
  get peak(): number {
    return this._peak;
  }

  hostIds(): string[] {
    return [...this.rosterMap.values()]
      .filter((r) => HOST_ROLES.has(r.role))
      .map((r) => r.participant_id);
  }
  roster(): RosterEntry[] {
    return [...this.rosterMap.values()].map((r) => ({ ...r }));
  }
  rosterEntry(id: string): RosterEntry | undefined {
    const entry = this.rosterMap.get(id);
    return entry ? { ...entry } : undefined;
  }
  inRoster(id: string): boolean {
    return this.rosterMap.has(id);
  }
  rosterIds(): string[] {
    return [...this.rosterMap.keys()];
  }
  lobby(): LobbyEntry[] {
    return [...this.lobbyMap.values()].map((l) => ({ ...l }));
  }
  inLobby(id: string): boolean {
    return this.lobbyMap.has(id);
  }
  lobbyIds(): string[] {
    return [...this.lobbyMap.keys()];
  }
  tracks(): TrackInfo[] {
    return [...this.trackMap.values()].map((t) => ({ ...t }));
  }
  track(id: string): TrackInfo | undefined {
    const track = this.trackMap.get(id);
    return track ? { ...track } : undefined;
  }
  tracksOf(owner: string, source?: MediaSource): TrackInfo[] {
    return this.tracks().filter((t) => t.owner === owner && (source === undefined || t.source === source));
  }
  departed(id: string): DepartedReason | undefined {
    return this.departedMap.get(id)?.reason;
  }
  isHost(id: string): boolean {
    const entry = this.rosterMap.get(id);
    return entry !== undefined && HOST_ROLES.has(entry.role);
  }
  isIdle(): boolean {
    return this.rosterMap.size === 0 && this.lobbyMap.size === 0;
  }
  membership(): Membership {
    return {
      inRoster: (id) => this.rosterMap.has(id),
      isHost: (id) => this.isHost(id),
      inLobby: (id) => this.lobbyMap.has(id),
    };
  }

  // ---- snapshot and dirty tracking ----

  toSnapshot(): RoomSnapshot {
    return {
      session_id: this.sessionId,
      home_sfu: this.homeSfu,
      epoch: this._epoch,
      seq: this._seq,
      status: this._status,
      end_reason: this._endReason,
      locked: this._locked,
      lobby_enabled: this._lobbyEnabled,
      recording: this._recording,
      max_participants: this._maxParticipants,
      host_ids: this.hostIds(),
      peak: this._peak,
      roster: this.roster(),
      lobby: this.lobby(),
      tracks: this.tracks(),
      departed: Object.fromEntries([...this.departedMap].map(([id, d]) => [id, { ...d }])),
    };
  }

  takeDirty(): Set<Section> {
    const taken = this.dirty;
    this.dirty = new Set();
    return taken;
  }

  markAllDirty(): void {
    this.dirty = new Set<Section>(["meta", "roster", "lobby", "tracks", "departed"]);
  }

  // ---- welcome and replay ----

  /** Snapshot for one participant (design doc: exactly one welcome per connection). No media. */
  welcomeFor(participantId: string): Welcome {
    if (this.lobbyMap.has(participantId)) {
      return {
        participant_id: participantId,
        role: "attendee",
        epoch: this._epoch,
        seq: this._seq,
        state: "lobby",
      };
    }
    const entry = this.rosterMap.get(participantId);
    if (!entry) throw new Error(`unknown participant ${participantId}`);
    const welcome: Welcome = {
      participant_id: participantId,
      role: entry.role,
      epoch: this._epoch,
      seq: this._seq,
      state: "joined",
      roster: this.roster(),
      tracks: this.tracks(),
      room_meta: this.meta(),
    };
    if (HOST_ROLES.has(entry.role)) welcome.lobby = this.lobby();
    return welcome;
  }

  meta(): RoomMeta {
    return {
      session_id: this.sessionId,
      locked: this._locked,
      lobby_enabled: this._lobbyEnabled,
      recording: this._recording,
      host_ids: this.hostIds(),
      max_participants: this._maxParticipants,
    };
  }

  replay(participantId: string, afterSeq: number, now: number = Date.now()): RoomEvent[] | null {
    this.ring.evict(now);
    return this.ring.replay(participantId, afterSeq, this._seq, this.membership());
  }

  /** Hello-time pre-check so the controller can refuse before spending SFU calls. Pure. */
  canJoin(participantId: string, role: Role): RoomError | null {
    if (this._status === "ended") {
      return { code: "FORBIDDEN", message: "room ended", close: CloseCode.ROOM_ENDED };
    }
    const rejected = this.rejectEntry(participantId, role);
    if (rejected && !rejected.ok) return rejected.error;
    if (this.rosterMap.size >= this._maxParticipants) {
      return { code: "CAPACITY", message: "meeting is full", close: CloseCode.CAPACITY };
    }
    return null;
  }

  // ---- commands ----

  apply(command: Command, now: number = Date.now()): Outcome {
    this.pruneDeparted(now);
    const ctx: Ctx = { now, iso: new Date(now).toISOString(), events: [] };
    if (this._status === "ended" && command.type !== "end") {
      return fail("FORBIDDEN", "room ended", CloseCode.ROOM_ENDED);
    }
    switch (command.type) {
      case "join":
        return this.join(ctx, command.participant_id, command.name, command.role);
      case "lobby_request":
        return this.lobbyRequest(ctx, command.participant_id, command.name);
      case "lobby_leave":
        return this.lobbyLeave(ctx, command.participant_id);
      case "admit":
        return this.admit(ctx, command.actor, command.participant_id);
      case "deny":
        return this.deny(ctx, command.actor, command.participant_id);
      case "disconnect":
        return this.setConnected(ctx, command.participant_id, false);
      case "reconnect":
        return this.setConnected(ctx, command.participant_id, true);
      case "leave":
        return this.leave(ctx, command.participant_id);
      case "remove":
        return this.remove(ctx, command.actor, command.participant_id);
      case "publish":
        return this.publish(ctx, command.participant_id, command.track);
      case "unpublish":
        return this.unpublish(ctx, command.participant_id, command.track_id);
      case "track_lost":
        return this.trackLost(ctx, command.track_id);
      case "track_layers":
        return this.trackLayers(ctx, command.participant_id, command.track_id, command.layers);
      case "set_media_state":
        return this.setMediaState(ctx, command.participant_id, command.muted, command.video_off);
      case "host_mute":
        return this.hostMute(ctx, command.actor, command.participant_id);
      case "hand":
        return this.hand(ctx, command.participant_id, command.raised);
      case "chat":
        return this.chat(ctx, command.from, command.body, command.to);
      case "reaction":
        return this.reaction(ctx, command.from, command.emoji);
      case "lock":
        return this.lock(ctx, command.actor, command.locked);
      case "active_speakers":
        this.emit(ctx, "active_speakers", { participant_ids: command.participant_ids }, { kind: "all" });
        return ok(ctx);
      case "end":
        return this.end(ctx, command.reason);
    }
  }

  private join(ctx: Ctx, participantId: string, name: string, role: Role): Outcome {
    const rejected = this.rejectEntry(participantId, role);
    if (rejected) return rejected;
    if (this.rosterMap.size >= this._maxParticipants) {
      return fail("CAPACITY", "meeting is full", CloseCode.CAPACITY);
    }
    const entry = this.addToRoster(ctx, participantId, name, role);
    this.emit(ctx, "participant.joined", { participant: entry }, { kind: "all_except", participant_id: participantId });
    return ok(ctx);
  }

  private lobbyRequest(ctx: Ctx, participantId: string, name: string): Outcome {
    const rejected = this.rejectEntry(participantId, "attendee");
    if (rejected) return rejected;
    const entry: LobbyEntry = { participant_id: participantId, name, requested_at: ctx.iso };
    this.lobbyMap.set(participantId, entry);
    this.dirty.add("lobby");
    this.emit(ctx, "lobby.request", { participant_id: participantId, name }, { kind: "hosts" });
    return ok(ctx);
  }

  private lobbyLeave(ctx: Ctx, participantId: string): Outcome {
    if (this.lobbyMap.delete(participantId)) {
      this.dirty.add("lobby");
      this.emit(ctx, "lobby.left", { participant_id: participantId }, { kind: "hosts" });
    }
    return ok(ctx);
  }

  private admit(ctx: Ctx, actor: string, participantId: string): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    const waiter = this.lobbyMap.get(participantId);
    if (!waiter) return fail("NOT_FOUND", "not in the lobby");
    if (this.rosterMap.size >= this._maxParticipants) return fail("CAPACITY", "meeting is full");
    this.lobbyMap.delete(participantId);
    this.dirty.add("lobby");
    this.addToRoster(ctx, participantId, waiter.name, "attendee");
    this.emit(ctx, "lobby.result", { admitted: true }, { kind: "only", participant_ids: [participantId] });
    const entry = this.rosterMap.get(participantId)!;
    this.emit(ctx, "participant.joined", { participant: { ...entry } }, { kind: "all_except", participant_id: participantId });
    return ok(ctx);
  }

  private deny(ctx: Ctx, actor: string, participantId: string): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    if (!this.lobbyMap.has(participantId)) return fail("NOT_FOUND", "not in the lobby");
    this.denyWaiter(ctx, participantId);
    return ok(ctx);
  }

  private denyWaiter(ctx: Ctx, participantId: string): void {
    this.lobbyMap.delete(participantId);
    this.departedMap.set(participantId, { reason: "denied", at: ctx.iso });
    this.dirty.add("lobby");
    this.dirty.add("departed");
    this.emit(ctx, "lobby.result", { admitted: false }, { kind: "only", participant_ids: [participantId] });
    this.emit(ctx, "lobby.left", { participant_id: participantId }, { kind: "hosts" });
  }

  private setConnected(ctx: Ctx, participantId: string, connected: boolean): Outcome {
    const entry = this.rosterMap.get(participantId);
    if (!entry) return fail("NOT_FOUND", "not in the room");
    if (entry.connected === connected) return ok(ctx);
    entry.connected = connected;
    this.dirty.add("roster");
    this.emit(
      ctx,
      "participant.updated",
      { participant_id: participantId, patch: { connected } },
      { kind: "all_except", participant_id: participantId },
    );
    return ok(ctx);
  }

  private leave(ctx: Ctx, participantId: string): Outcome {
    if (!this.rosterMap.has(participantId)) return ok(ctx);
    this.dropParticipant(ctx, participantId, "timeout", "grace");
    return ok(ctx);
  }

  private remove(ctx: Ctx, actor: string, participantId: string): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    if (participantId === actor) return fail("INVALID", "cannot remove yourself");
    if (this.rosterMap.has(participantId)) {
      if (this.isHost(participantId)) return fail("FORBIDDEN", "cannot remove a host");
      this.dropParticipant(ctx, participantId, "removed", "removed");
      return ok(ctx);
    }
    if (this.lobbyMap.has(participantId)) {
      this.denyWaiter(ctx, participantId);
      return ok(ctx);
    }
    return fail("NOT_FOUND", "not in the room");
  }

  private publish(ctx: Ctx, participantId: string, track: TrackInfo): Outcome {
    if (!this.rosterMap.has(participantId)) return fail("NOT_FOUND", "not in the room");
    if (track.owner !== participantId) return fail("INVALID", "track owner mismatch");
    if (this.trackMap.has(track.track_id)) return fail("INVALID", "duplicate track id");
    this.trackMap.set(track.track_id, { ...track });
    this.dirty.add("tracks");
    this.emit(ctx, "track.added", { track: { ...track } }, { kind: "all" });
    return ok(ctx);
  }

  private unpublish(ctx: Ctx, participantId: string, trackId: string): Outcome {
    const track = this.trackMap.get(trackId);
    if (!track) return fail("NOT_FOUND", "unknown track");
    if (track.owner !== participantId) return fail("FORBIDDEN", "not your track");
    this.removeTrack(ctx, trackId);
    return ok(ctx);
  }

  private trackLost(ctx: Ctx, trackId: string): Outcome {
    if (this.trackMap.has(trackId)) this.removeTrack(ctx, trackId);
    return ok(ctx);
  }

  private trackLayers(ctx: Ctx, participantId: string, trackId: string, layers: number): Outcome {
    if (!this.trackMap.has(trackId)) return ok(ctx);
    this.emit(
      ctx,
      "track.updated",
      { track_id: trackId, patch: { layers } },
      { kind: "only", participant_ids: [participantId] },
    );
    return ok(ctx);
  }

  private setMediaState(ctx: Ctx, participantId: string, muted?: boolean, videoOff?: boolean): Outcome {
    const entry = this.rosterMap.get(participantId);
    if (!entry) return fail("NOT_FOUND", "not in the room");
    this.applyMediaState(ctx, entry, muted, videoOff);
    return ok(ctx);
  }

  private hostMute(ctx: Ctx, actor: string, participantId: string): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    const entry = this.rosterMap.get(participantId);
    if (!entry) return fail("NOT_FOUND", "not in the room");
    this.applyMediaState(ctx, entry, true, undefined);
    return ok(ctx);
  }

  private hand(ctx: Ctx, participantId: string, raised: boolean): Outcome {
    const entry = this.rosterMap.get(participantId);
    if (!entry) return fail("NOT_FOUND", "not in the room");
    if (entry.hand === raised) return ok(ctx);
    entry.hand = raised;
    this.dirty.add("roster");
    this.emit(ctx, "hand", { participant_id: participantId, raised }, { kind: "all" });
    return ok(ctx);
  }

  private chat(ctx: Ctx, from: string, body: string, to?: string): Outcome {
    if (!this.rosterMap.has(from)) return fail("NOT_FOUND", "not in the room");
    if (to !== undefined && !this.rosterMap.has(to)) return fail("NOT_FOUND", "unknown recipient");
    const payload = to === undefined ? { from, body, sent_at: ctx.iso } : { from, to, body, sent_at: ctx.iso };
    const target: Target = to === undefined ? { kind: "all" } : { kind: "only", participant_ids: [from, to] };
    this.emit(ctx, "chat", payload, target);
    return ok(ctx);
  }

  private reaction(ctx: Ctx, from: string, emoji: string): Outcome {
    if (!this.rosterMap.has(from)) return fail("NOT_FOUND", "not in the room");
    this.emit(ctx, "reaction", { from, emoji }, { kind: "all" });
    return ok(ctx);
  }

  private lock(ctx: Ctx, actor: string, locked: boolean): Outcome {
    const denied = this.requireHost(actor);
    if (denied) return denied;
    if (this._locked === locked) return ok(ctx);
    this._locked = locked;
    this.dirty.add("meta");
    this.emit(ctx, "room.updated", { locked }, { kind: "all" });
    return ok(ctx);
  }

  private end(ctx: Ctx, reason: string): Outcome {
    if (this._status === "ended") return ok(ctx);
    this._status = "ended";
    this._endReason = reason;
    this.dirty.add("meta");
    this.emit(ctx, "room.ended", { reason }, { kind: "everyone" });
    return ok(ctx);
  }

  // ---- helpers ----

  /** Hello-time checks shared by join and lobby_request. */
  private rejectEntry(participantId: string, role: Role): Outcome | null {
    const departed = this.departedMap.get(participantId);
    if (departed) {
      return fail("FORBIDDEN", `departed: ${departed.reason}`, CLOSE_BY_DEPARTED[departed.reason]);
    }
    if (this.rosterMap.has(participantId) || this.lobbyMap.has(participantId)) {
      return fail("INVALID", "already present");
    }
    if (this._locked && !HOST_ROLES.has(role)) {
      return fail("LOCKED", "meeting is locked", CloseCode.LOCKED);
    }
    return null;
  }

  private requireHost(actor: string): Outcome | null {
    return this.isHost(actor) ? null : fail("FORBIDDEN", "host role required");
  }

  private addToRoster(ctx: Ctx, participantId: string, name: string, role: Role): RosterEntry {
    const entry: RosterEntry = {
      participant_id: participantId,
      name,
      role,
      muted: false,
      video_off: false,
      hand: false,
      connected: true,
      joined_at: ctx.iso,
    };
    this.rosterMap.set(participantId, entry);
    this._peak = Math.max(this._peak, this.rosterMap.size);
    this.dirty.add("roster");
    this.dirty.add("meta");
    return { ...entry };
  }

  private dropParticipant(
    ctx: Ctx,
    participantId: string,
    leaveReason: "timeout" | "removed",
    departedReason: DepartedReason,
  ): void {
    this.rosterMap.delete(participantId);
    this.departedMap.set(participantId, { reason: departedReason, at: ctx.iso });
    this.dirty.add("roster");
    this.dirty.add("departed");
    this.dirty.add("meta");
    for (const track of this.tracks()) {
      if (track.owner === participantId) this.removeTrack(ctx, track.track_id);
    }
    this.emit(ctx, "participant.left", { participant_id: participantId, reason: leaveReason }, { kind: "all" });
  }

  private removeTrack(ctx: Ctx, trackId: string): void {
    this.trackMap.delete(trackId);
    this.dirty.add("tracks");
    this.emit(ctx, "track.removed", { track_id: trackId }, { kind: "all" });
  }

  private applyMediaState(ctx: Ctx, entry: RosterEntry, muted?: boolean, videoOff?: boolean): void {
    const patch: { muted?: boolean; video_off?: boolean } = {};
    const pauses: Array<{ source: MediaSource; paused: boolean }> = [];
    if (muted !== undefined && muted !== entry.muted) {
      entry.muted = muted;
      patch.muted = muted;
      pauses.push({ source: "mic", paused: muted });
    }
    if (videoOff !== undefined && videoOff !== entry.video_off) {
      entry.video_off = videoOff;
      patch.video_off = videoOff;
      pauses.push({ source: "camera", paused: videoOff });
    }
    if (pauses.length === 0) return;
    this.dirty.add("roster");
    this.emit(ctx, "participant.updated", { participant_id: entry.participant_id, patch }, { kind: "all" });
    for (const { source, paused } of pauses) {
      for (const track of this.trackMap.values()) {
        if (track.owner !== entry.participant_id || track.source !== source || track.paused === paused) continue;
        track.paused = paused;
        this.dirty.add("tracks");
        this.emit(ctx, "track.updated", { track_id: track.track_id, patch: { paused } }, { kind: "all" });
      }
    }
  }

  private pruneDeparted(now: number): void {
    for (const [id, departed] of this.departedMap) {
      if (Date.parse(departed.at) + this.opts.departedTtlMs <= now) {
        this.departedMap.delete(id);
        this.dirty.add("departed");
      }
    }
  }

  private emit<T extends RoomEvent["type"]>(
    ctx: Ctx,
    type: T,
    payload: EventOf<T>["payload"],
    target: Target,
  ): void {
    // The payload parameter is typed per event; the cast only erases the generic for the union.
    const event = { type, seq: ++this._seq, payload } as unknown as RoomEvent;
    const emitted: Emitted = { event, target, at: ctx.now };
    this.ring.push(emitted);
    ctx.events.push(emitted);
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test -- room.test`
Expected: PASS (all Room tests).

- [ ] **Step 3: Full check and commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(signaling): add the pure room state machine with replay and snapshots

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 3: Active speaker tracker

**Files:**
- Create: `services/signaling/src/room/active-speakers.ts`, `services/signaling/src/room/active-speakers.test.ts`

**Interfaces:**
- Produces: `class ActiveSpeakerTracker` with `constructor(emit: (ids: string[]) => void, opts?: TrackerOptions)`, `onSample(speakers: SpeakerSample[], now: number)`, `onSilence(now: number)`, `tick(now: number)`, `current: string[]`; `TrackerOptions = { riseMs; fallMs; minIntervalMs }`, `DEFAULT_TRACKER_OPTIONS = { riseMs: 300, fallMs: 1000, minIntervalMs: 300 }`, `SpeakerSample = { participant_id: string; volume: number }`.
- The controller feeds `dominant_speakers` into `onSample`, `silence` into `onSilence`, and calls `tick` every 300 ms; `emit` receives the sorted set of active participant ids whenever it changes (rate limited), and `[]` at once on silence.

- [ ] **Step 1: Failing tests**

`services/signaling/src/room/active-speakers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ActiveSpeakerTracker } from "./active-speakers";

const A = "a";
const B = "b";

function tracker() {
  const emitted: string[][] = [];
  const t = new ActiveSpeakerTracker((ids) => emitted.push(ids), {
    riseMs: 300,
    fallMs: 1000,
    minIntervalMs: 300,
  });
  return { t, emitted };
}

describe("ActiveSpeakerTracker", () => {
  it("activates a speaker after riseMs of consecutive samples", () => {
    const { t, emitted } = tracker();
    t.onSample([{ participant_id: A, volume: -20 }], 0);
    expect(emitted).toEqual([]);
    t.onSample([{ participant_id: A, volume: -20 }], 300);
    expect(emitted).toEqual([[A]]);
    expect(t.current).toEqual([A]);
  });

  it("ages a speaker out fallMs after its last sample, even without new samples", () => {
    const { t, emitted } = tracker();
    t.onSample([{ participant_id: A, volume: -20 }], 0);
    t.onSample([{ participant_id: A, volume: -20 }], 300);
    t.tick(1_200);
    expect(emitted).toEqual([[A]]);
    t.tick(1_300);
    expect(emitted).toEqual([[A], []]);
  });

  it("clears at once on silence", () => {
    const { t, emitted } = tracker();
    t.onSample([{ participant_id: A, volume: -20 }], 0);
    t.onSample([{ participant_id: A, volume: -20 }], 300);
    t.onSilence(350);
    expect(emitted).toEqual([[A], []]);
    t.onSample([{ participant_id: A, volume: -20 }], 400);
    expect(emitted).toEqual([[A], []]);
    t.onSample([{ participant_id: A, volume: -20 }], 700);
    expect(emitted).toEqual([[A], [], [A]]);
  });

  it("emits at most once per minIntervalMs and flushes the pending change on the next tick", () => {
    const { t, emitted } = tracker();
    t.onSample([{ participant_id: A, volume: -20 }], 0);
    t.onSample(
      [
        { participant_id: A, volume: -20 },
        { participant_id: B, volume: -30 },
      ],
      300,
    );
    expect(emitted).toEqual([[A]]);
    t.onSample(
      [
        { participant_id: A, volume: -20 },
        { participant_id: B, volume: -30 },
      ],
      500,
    );
    expect(emitted).toEqual([[A]]);
    expect(t.current).toEqual([A, B]);
    t.tick(600);
    expect(emitted).toEqual([[A], [A, B]]);
  });

  it("does not emit when the set is unchanged and sorts ids", () => {
    const { t, emitted } = tracker();
    const both = [
      { participant_id: B, volume: -10 },
      { participant_id: A, volume: -20 },
    ];
    t.onSample(both, 0);
    t.onSample(both, 300);
    t.onSample(both, 600);
    t.tick(900);
    expect(emitted).toEqual([[A, B]]);
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- active-speakers`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement**

`services/signaling/src/room/active-speakers.ts`:

```ts
export type SpeakerSample = { participant_id: string; volume: number };
export type TrackerOptions = { riseMs: number; fallMs: number; minIntervalMs: number };
export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  riseMs: 300,
  fallMs: 1000,
  minIntervalMs: 300,
};

/**
 * Hysteresis over the SFU's dominant_speakers samples (design doc): a participant is active
 * after riseMs of consecutive presence and stays active until fallMs without a sample. Wall-clock
 * aging (tick) handles the SFU going quiet without a silence event; silence clears at once.
 */
export class ActiveSpeakerTracker {
  private readonly firstSeen = new Map<string, number>();
  private readonly lastSeen = new Map<string, number>();
  private active: string[] = [];
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private pending = false;

  constructor(
    private readonly emit: (ids: string[]) => void,
    private readonly opts: TrackerOptions = DEFAULT_TRACKER_OPTIONS,
  ) {}

  get current(): string[] {
    return [...this.active];
  }

  onSample(speakers: SpeakerSample[], now: number): void {
    for (const { participant_id } of speakers) {
      if (!this.firstSeen.has(participant_id)) this.firstSeen.set(participant_id, now);
      this.lastSeen.set(participant_id, now);
    }
    this.tick(now);
  }

  onSilence(now: number): void {
    this.firstSeen.clear();
    this.lastSeen.clear();
    this.pending = false;
    if (this.active.length === 0) return;
    this.active = [];
    this.lastEmitAt = now;
    this.emit([]);
  }

  tick(now: number): void {
    for (const [id, seen] of this.lastSeen) {
      if (now - seen >= this.opts.fallMs) {
        this.lastSeen.delete(id);
        this.firstSeen.delete(id);
      }
    }
    const next = [...this.firstSeen]
      .filter(([, since]) => now - since >= this.opts.riseMs)
      .map(([id]) => id)
      .sort();
    if (next.length !== this.active.length || next.some((id, i) => id !== this.active[i])) {
      this.active = next;
      this.pending = true;
    }
    if (this.pending && now - this.lastEmitAt >= this.opts.minIntervalMs) {
      this.pending = false;
      this.lastEmitAt = now;
      this.emit([...this.active]);
    }
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test -- active-speakers`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(signaling): add the active speaker tracker with rise and fall hysteresis

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 4: Redis checkpoint, loader and owner lease

**Files:**
- Create: `services/signaling/src/room/checkpoint.ts`, `services/signaling/src/room/checkpoint.test.ts`, `services/signaling/test/helpers.ts` (first slice: `testRedisUrl`, `testEnv`, `connectRedis`, `flushTestRedis`)

**Interfaces:**
- Consumes: `Room` (Task 2), `RoomSnapshot`, `Section` (Task 1).
- Produces: `roomKeys(sessionId) -> { meta, roster, lobby, tracks, departed, seq, owner, data: string[] }`, `ROOM_TTL_SECONDS = 3600`, `ENDED_TTL_SECONDS = 60`; `loadSnapshot(redis, sessionId) -> Promise<LoadedRoom>` with `LoadedRoom = { kind: "none" } | { kind: "ended"; reason: string | null } | { kind: "live"; snapshot: RoomSnapshot }`; `class Checkpoint` (`constructor(redis, room, { windowMs, ttlSeconds?, onLag?, onError? })`, `schedule()`, `flush()`, `writeAll()`, `refreshTtl()`, `markEnded(reason)`, `stop()`); `class OwnerLease` (`constructor(redis, sessionId, ttlMs)`, `token`, `acquire()`, `refresh()`, `release()`).
- Redis layout is the Global Constraints one; `meta.status` / `meta.end_reason` / `meta.locked` and the roster hash length are what meeting-api's `RoomStateReader` reads.

- [ ] **Step 1: Test helpers (first slice)**

`services/signaling/test/helpers.ts`:

```ts
import Redis from "ioredis";
import { loadEnv, type Env } from "../src/env";

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? "redis://localhost:56379/1";
}

/** Short timers so grace, idle, hello and ping paths run in tens of milliseconds. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ?? "postgres://zoomclone:zoomclone@localhost:55432/zoomclone_test",
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
```

- [ ] **Step 2: Failing tests**

`services/signaling/src/room/checkpoint.test.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import type Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, flushTestRedis } from "../../test/helpers";
import {
  Checkpoint,
  ENDED_TTL_SECONDS,
  OwnerLease,
  ROOM_TTL_SECONDS,
  loadSnapshot,
  roomKeys,
} from "./checkpoint";
import { Room } from "./room";

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const W = "44444444-4444-4444-8444-444444444444";

let redis: Redis;

beforeAll(() => {
  redis = connectRedis();
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(async () => {
  await flushTestRedis(redis);
});

function seededRoom(): Room {
  const room = Room.create({ session_id: S, home_sfu: "sfu-local-1", lobby_enabled: true, max_participants: 10 });
  room.apply({ type: "join", participant_id: HOST, name: "Host", role: "host" });
  room.apply({ type: "join", participant_id: A, name: "Ann", role: "attendee" });
  room.apply({ type: "lobby_request", participant_id: W, name: "Wren" });
  room.apply({
    type: "publish",
    participant_id: A,
    track: { track_id: "t1", owner: A, kind: "audio", source: "mic", paused: false, layers: 1 },
  });
  return room;
}

describe("Checkpoint", () => {
  it("writeAll writes the spec 4.2 layout with a one hour ttl", async () => {
    const room = seededRoom();
    const checkpoint = new Checkpoint(redis, room, { windowMs: 20 });
    await checkpoint.writeAll();
    const keys = roomKeys(S);
    expect(keys.meta).toBe(`{room:${S}}:meta`);
    const meta = await redis.hgetall(keys.meta);
    expect(meta).toEqual({
      status: "live",
      home_sfu: "sfu-local-1",
      host_ids: JSON.stringify([HOST]),
      locked: "false",
      lobby_enabled: "true",
      recording: "false",
      epoch: "1",
      peak: "2",
      max_participants: "10",
      session_id: S,
    });
    expect(await redis.hlen(keys.roster)).toBe(2);
    expect(JSON.parse((await redis.hget(keys.roster, A)) ?? "null")).toMatchObject({ name: "Ann", role: "attendee" });
    expect(JSON.parse((await redis.hget(keys.lobby, W)) ?? "null")).toMatchObject({ name: "Wren" });
    expect(JSON.parse((await redis.hget(keys.tracks, "t1")) ?? "null")).toMatchObject({ owner: A });
    expect(await redis.get(keys.seq)).toBe(String(room.seq));
    for (const key of [keys.meta, keys.roster, keys.lobby, keys.tracks, keys.seq]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(ROOM_TTL_SECONDS - 100);
      expect(ttl).toBeLessThanOrEqual(ROOM_TTL_SECONDS);
    }
    expect(await redis.exists(keys.departed)).toBe(0);
    await checkpoint.stop();
  });

  it("schedule coalesces within the window and rewrites only dirty sections", async () => {
    const room = seededRoom();
    const lags: number[] = [];
    const checkpoint = new Checkpoint(redis, room, { windowMs: 20, onLag: (ms) => lags.push(ms) });
    await checkpoint.writeAll();
    const keys = roomKeys(S);
    await redis.del(keys.tracks);
    room.apply({ type: "hand", participant_id: A, raised: true });
    checkpoint.schedule();
    room.apply({ type: "lobby_leave", participant_id: W });
    checkpoint.schedule();
    await sleep(80);
    expect(lags).toHaveLength(1);
    expect(JSON.parse((await redis.hget(keys.roster, A)) ?? "null")).toMatchObject({ hand: true });
    expect(await redis.exists(keys.lobby)).toBe(0);
    expect(await redis.exists(keys.tracks)).toBe(0);
    expect(await redis.get(keys.seq)).toBe(String(room.seq));
    await checkpoint.stop();
  });

  it("loadSnapshot round-trips a live room and reports ended rooms", async () => {
    const room = seededRoom();
    room.apply({ type: "remove", actor: HOST, participant_id: A });
    const checkpoint = new Checkpoint(redis, room, { windowMs: 20 });
    expect(await loadSnapshot(redis, S)).toEqual({ kind: "none" });
    await checkpoint.writeAll();
    const loaded = await loadSnapshot(redis, S);
    expect(loaded.kind).toBe("live");
    if (loaded.kind !== "live") throw new Error("expected live");
    expect(loaded.snapshot).toEqual(room.toSnapshot());
    expect(loaded.snapshot.departed[A]).toMatchObject({ reason: "removed" });

    room.apply({ type: "end", reason: "host_end" });
    await checkpoint.markEnded("host_end");
    expect(await loadSnapshot(redis, S)).toEqual({ kind: "ended", reason: "host_end" });
    const keys = roomKeys(S);
    expect(await redis.hgetall(keys.meta)).toMatchObject({ status: "ended", end_reason: "host_end" });
    expect(await redis.exists(keys.roster, keys.lobby, keys.tracks, keys.departed, keys.seq)).toBe(0);
    expect(await redis.ttl(keys.meta)).toBeLessThanOrEqual(ENDED_TTL_SECONDS);
    checkpoint.schedule();
    await checkpoint.flush();
    expect(await redis.exists(keys.roster)).toBe(0);
    expect(await redis.ttl(keys.meta)).toBeLessThanOrEqual(ENDED_TTL_SECONDS);
    await checkpoint.stop();
  });

  it("stop flushes pending dirty sections and refreshTtl extends every key", async () => {
    const room = seededRoom();
    const checkpoint = new Checkpoint(redis, room, { windowMs: 5_000 });
    await checkpoint.writeAll();
    const keys = roomKeys(S);
    await redis.expire(keys.roster, 10);
    await checkpoint.refreshTtl();
    expect(await redis.ttl(keys.roster)).toBeGreaterThan(ROOM_TTL_SECONDS - 100);
    room.apply({ type: "lock", actor: HOST, locked: true });
    checkpoint.schedule();
    await checkpoint.stop();
    expect((await redis.hgetall(keys.meta)).locked).toBe("true");
  });
});

describe("OwnerLease", () => {
  it("is exclusive, refreshable only by its holder, and released explicitly", async () => {
    const first = new OwnerLease(redis, S, 2_000);
    const second = new OwnerLease(redis, S, 2_000);
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(await second.refresh()).toBe(false);
    expect(await first.refresh()).toBe(true);
    const ttl = await redis.pttl(roomKeys(S).owner);
    expect(ttl).toBeGreaterThan(1_000);
    await second.release();
    expect(await redis.get(roomKeys(S).owner)).toBe(first.token);
    await first.release();
    expect(await second.acquire()).toBe(true);
    await second.release();
  });

  it("expires on its own", async () => {
    const lease = new OwnerLease(redis, S, 50);
    expect(await lease.acquire()).toBe(true);
    await sleep(120);
    expect(await lease.refresh()).toBe(false);
    expect(await new OwnerLease(redis, S, 50).acquire()).toBe(true);
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- checkpoint`
Expected: FAIL (module not found). Requires `pnpm infra:up` (Redis on 56379).

- [ ] **Step 3: Implement**

`services/signaling/src/room/checkpoint.ts`:

```ts
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { ChainableCommander } from "ioredis";
import { z } from "zod";
import { LobbyEntrySchema, RosterEntrySchema, TrackInfoSchema } from "@zoomclone/protocol";
import type { Room } from "./room";
import type { RoomSnapshot, Section } from "./types";

export const ROOM_TTL_SECONDS = 3600;
export const ENDED_TTL_SECONDS = 60;

export type RoomKeys = {
  meta: string;
  roster: string;
  lobby: string;
  tracks: string;
  departed: string;
  seq: string;
  owner: string;
  /** Every key except the owner lease (the lease has its own ttl). */
  data: string[];
};

/** Spec 4.2 hash-tag layout so all of a room's keys share a cluster slot. */
export function roomKeys(sessionId: string): RoomKeys {
  const p = `{room:${sessionId}}`;
  const keys = {
    meta: `${p}:meta`,
    roster: `${p}:roster`,
    lobby: `${p}:lobby`,
    tracks: `${p}:tracks`,
    departed: `${p}:departed`,
    seq: `${p}:seq`,
    owner: `${p}:owner`,
  };
  return { ...keys, data: [keys.meta, keys.roster, keys.lobby, keys.tracks, keys.departed, keys.seq] };
}

const DepartedSchema = z.object({ reason: z.enum(["removed", "denied", "grace"]), at: z.string() });

export type LoadedRoom =
  | { kind: "none" }
  | { kind: "ended"; reason: string | null }
  | { kind: "live"; snapshot: RoomSnapshot };

export async function loadSnapshot(redis: Redis, sessionId: string): Promise<LoadedRoom> {
  const keys = roomKeys(sessionId);
  const meta = await redis.hgetall(keys.meta);
  if (Object.keys(meta).length === 0) return { kind: "none" };
  if (meta["status"] === "ended") return { kind: "ended", reason: meta["end_reason"] ?? null };
  const [roster, lobby, tracks, departed, seq] = await Promise.all([
    redis.hgetall(keys.roster),
    redis.hgetall(keys.lobby),
    redis.hgetall(keys.tracks),
    redis.hgetall(keys.departed),
    redis.get(keys.seq),
  ]);
  const parseAll = <T>(hash: Record<string, string>, schema: z.ZodType<T>): T[] =>
    Object.values(hash).map((raw) => schema.parse(JSON.parse(raw)));
  return {
    kind: "live",
    snapshot: {
      session_id: sessionId,
      home_sfu: meta["home_sfu"] ?? "",
      epoch: Number(meta["epoch"] ?? "1"),
      seq: Number(seq ?? "0"),
      status: "live",
      end_reason: null,
      locked: meta["locked"] === "true",
      lobby_enabled: meta["lobby_enabled"] === "true",
      recording: meta["recording"] === "true",
      max_participants: Number(meta["max_participants"] ?? "500"),
      host_ids: JSON.parse(meta["host_ids"] ?? "[]") as string[],
      peak: Number(meta["peak"] ?? "0"),
      roster: parseAll(roster, RosterEntrySchema),
      lobby: parseAll(lobby, LobbyEntrySchema),
      tracks: parseAll(tracks, TrackInfoSchema),
      departed: Object.fromEntries(
        Object.entries(departed).map(([id, raw]) => [id, DepartedSchema.parse(JSON.parse(raw))]),
      ),
    },
  };
}

function metaFields(s: RoomSnapshot): Record<string, string> {
  const fields: Record<string, string> = {
    status: s.status,
    home_sfu: s.home_sfu,
    host_ids: JSON.stringify(s.host_ids),
    locked: String(s.locked),
    lobby_enabled: String(s.lobby_enabled),
    recording: String(s.recording),
    epoch: String(s.epoch),
    peak: String(s.peak),
    max_participants: String(s.max_participants),
    session_id: s.session_id,
  };
  if (s.end_reason !== null) fields["end_reason"] = s.end_reason;
  return fields;
}

function rewriteHash(multi: ChainableCommander, key: string, entries: Record<string, string>): void {
  multi.del(key);
  if (Object.keys(entries).length > 0) multi.hset(key, entries);
}

export type CheckpointOptions = {
  windowMs: number;
  ttlSeconds?: number;
  onLag?: (ms: number) => void;
  onError?: (error: unknown) => void;
};

/**
 * Write-behind checkpoint (design doc "room/checkpoint.ts"): schedule() coalesces changes for
 * windowMs, then one MULTI rewrites the dirty sections plus seq and refreshes every ttl. Writes
 * are chained so two flushes never interleave. After markEnded nothing is written again.
 */
export class Checkpoint {
  private timer: NodeJS.Timeout | null = null;
  private scheduledAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly keys: RoomKeys;
  private readonly ttl: number;

  constructor(
    private readonly redis: Redis,
    private readonly room: Room,
    private readonly opts: CheckpointOptions,
  ) {
    this.keys = roomKeys(room.sessionId);
    this.ttl = opts.ttlSeconds ?? ROOM_TTL_SECONDS;
  }

  schedule(): void {
    if (this.stopped || this.timer) return;
    this.scheduledAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.windowMs);
  }

  flush(): Promise<void> {
    this.chain = this.chain
      .then(() => this.write(this.room.takeDirty()))
      .catch((error: unknown) => this.opts.onError?.(error));
    return this.chain;
  }

  writeAll(): Promise<void> {
    this.room.markAllDirty();
    return this.flush();
  }

  async refreshTtl(): Promise<void> {
    if (this.stopped) return;
    const pipeline = this.redis.pipeline();
    for (const key of this.keys.data) pipeline.expire(key, this.ttl);
    await pipeline.exec();
  }

  /** Terminal write: only meta survives, for 60 s, so /join never reuses a dying session. */
  async markEnded(reason: string): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.chain.catch(() => undefined);
    const multi = this.redis.multi();
    multi.hset(this.keys.meta, { status: "ended", end_reason: reason });
    multi.del(this.keys.roster, this.keys.lobby, this.keys.tracks, this.keys.departed, this.keys.seq);
    multi.expire(this.keys.meta, ENDED_TTL_SECONDS);
    await multi.exec();
  }

  /** Final flush of whatever is dirty (graceful shutdown keeps the room rehydratable). */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    await this.flush();
    this.stopped = true;
  }

  private async write(dirty: Set<Section>): Promise<void> {
    if (this.stopped) return;
    const s = this.room.toSnapshot();
    if (s.status === "ended") return;
    const multi = this.redis.multi();
    if (dirty.has("meta")) multi.hset(this.keys.meta, metaFields(s));
    if (dirty.has("roster")) rewriteHash(multi, this.keys.roster, toHash(s.roster, (r) => r.participant_id));
    if (dirty.has("lobby")) rewriteHash(multi, this.keys.lobby, toHash(s.lobby, (l) => l.participant_id));
    if (dirty.has("tracks")) rewriteHash(multi, this.keys.tracks, toHash(s.tracks, (t) => t.track_id));
    if (dirty.has("departed")) {
      rewriteHash(
        multi,
        this.keys.departed,
        Object.fromEntries(Object.entries(s.departed).map(([id, d]) => [id, JSON.stringify(d)])),
      );
    }
    multi.set(this.keys.seq, String(s.seq));
    for (const key of this.keys.data) multi.expire(key, this.ttl);
    await multi.exec();
    if (this.scheduledAt > 0) {
      this.opts.onLag?.(Date.now() - this.scheduledAt);
      this.scheduledAt = 0;
    }
  }
}

function toHash<T>(items: T[], key: (item: T) => string): Record<string, string> {
  return Object.fromEntries(items.map((item) => [key(item), JSON.stringify(item)]));
}

const REFRESH_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

/** Controller ownership of one room: SET NX PX, refreshed by the heartbeat (design doc). */
export class OwnerLease {
  readonly token = randomUUID();
  private readonly key: string;

  constructor(
    private readonly redis: Redis,
    sessionId: string,
    private readonly ttlMs: number,
  ) {
    this.key = roomKeys(sessionId).owner;
  }

  async acquire(): Promise<boolean> {
    const result = await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX");
    return result === "OK";
  }

  /** False when the lease expired or another controller holds it. */
  async refresh(): Promise<boolean> {
    const result = await this.redis.eval(REFRESH_LUA, 1, this.key, this.token, String(this.ttlMs));
    return result === 1;
  }

  async release(): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, this.key, this.token);
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test -- checkpoint`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(signaling): add the write-behind Redis checkpoint, loader and owner lease

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 5: SFU client side (codec, directory, stats consumer) and the fake SFU test double

**Files:**
- Create: `services/signaling/src/sfu/codec.ts`, `services/signaling/src/sfu/directory.ts`, `services/signaling/src/sfu/stats-consumer.ts`, `services/signaling/src/sfu/stats-consumer.test.ts`, `services/signaling/test/fake-sfu.ts`

**Interfaces:**
- Consumes: `@zoomclone/sfu-proto` (`SfuService`, enums, message types), `@connectrpc/connect` (`Client`, `Code`, `ConnectError`, `createClient`), `@connectrpc/connect-node` (`createGrpcTransport`, `connectNodeAdapter`).
- Produces:
  - `codec.ts`: `parseObject(json, what) -> Record<string, unknown>` and `parseArray(json, what) -> Record<string, unknown>[]` (throw `RoomFailure`-compatible `{ code: "SFU_ERROR" }` errors via `SfuPayloadError`), `kindToPb`, `kindFromPb`, `sourceToPb`, `sourceFromPb`, `describeSfuError(error: unknown) -> string`, `isNotFound(error) -> boolean`.
  - `directory.ts`: `class SfuDirectory` (`constructor(endpoints: Record<string, string>)`, `get(sfuId) -> Client<typeof SfuService>` (cached, throws `UnknownSfuError` for unknown ids), `has(sfuId)`, `ids()`).
  - `stats-consumer.ts`: `class StatsConsumer` (`constructor(client, sessionId, handlers: StatsHandlers, log, retryMs = 1000)`, `start(timeoutMs = 5000) -> Promise<void>` resolving after the first snapshot, `stop()`, `done: Promise<void>`); `StatsHandlers = { beforeOpen?: () => Promise<void>; onSnapshot(snapshot: Snapshot): void; onEvent(event: StatsEvent): void }`. Every (re)open calls `beforeOpen` first (the controller passes its `AllocateRoom` call, idempotent), so a room the SFU lost is recreated before `Stats` is called.
  - `test/fake-sfu.ts`: `class FakeSfu` (`start() -> Promise<string>` baseUrl, `stop()`, `calls`, `callsTo(method)`, `failNext(method, code, skip = 0)`, `emit(sessionId, event)`, `dropStreams(sessionId)`, `room(sessionId)`, `seedRoom(sessionId, seed)`, `reset()`), `FAKE_RTP_CAPABILITIES`. Ids are `t1, t2, ...` for transports, `p1, ...` producers, `trk1, ...` tracks, `c1, ...` consumers, one global counter each.

- [ ] **Step 1: Codec and directory**

`services/signaling/src/sfu/codec.ts`:

```ts
import { Code, ConnectError } from "@connectrpc/connect";
import type { MediaKind, MediaSource } from "@zoomclone/protocol";
import { MediaKind as PbKind, MediaSource as PbSource } from "@zoomclone/sfu-proto";

/** A blob from the SFU that is not the JSON shape the contract promises. */
export class SfuPayloadError extends Error {
  constructor(what: string) {
    super(`SFU returned malformed ${what}`);
    this.name = "SfuPayloadError";
  }
}

export function parseObject(json: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SfuPayloadError(what);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SfuPayloadError(what);
  return value as Record<string, unknown>;
}

export function parseArray(json: string, what: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SfuPayloadError(what);
  }
  if (!Array.isArray(value)) throw new SfuPayloadError(what);
  return value as Record<string, unknown>[];
}

export function kindToPb(kind: MediaKind): PbKind {
  return kind === "audio" ? PbKind.AUDIO : PbKind.VIDEO;
}

export function kindFromPb(kind: PbKind): MediaKind {
  if (kind === PbKind.AUDIO) return "audio";
  if (kind === PbKind.VIDEO) return "video";
  throw new SfuPayloadError("media kind");
}

const SOURCE_TO_PB: Record<MediaSource, PbSource> = {
  mic: PbSource.MIC,
  camera: PbSource.CAMERA,
  screen: PbSource.SCREEN,
  screen_audio: PbSource.SCREEN_AUDIO,
};

export function sourceToPb(source: MediaSource): PbSource {
  return SOURCE_TO_PB[source];
}

export function sourceFromPb(source: PbSource): MediaSource {
  for (const [name, value] of Object.entries(SOURCE_TO_PB)) {
    if (value === source) return name as MediaSource;
  }
  throw new SfuPayloadError("media source");
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.NotFound;
}

/** Short human-readable form for error frames and logs. */
export function describeSfuError(error: unknown): string {
  if (error instanceof ConnectError) return `${Code[error.code]}: ${error.rawMessage}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
```

`services/signaling/src/sfu/directory.ts`:

```ts
import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SfuService } from "@zoomclone/sfu-proto";

export class UnknownSfuError extends Error {
  constructor(sfuId: string) {
    super(`unknown sfu ${sfuId}`);
    this.name = "UnknownSfuError";
  }
}

/** sfu_id -> Connect client (design doc: static map from env now, registry-backed later). */
export class SfuDirectory {
  private readonly clients = new Map<string, Client<typeof SfuService>>();

  constructor(private readonly endpoints: Record<string, string>) {}

  has(sfuId: string): boolean {
    return sfuId in this.endpoints;
  }

  ids(): string[] {
    return Object.keys(this.endpoints);
  }

  get(sfuId: string): Client<typeof SfuService> {
    const cached = this.clients.get(sfuId);
    if (cached) return cached;
    const baseUrl = this.endpoints[sfuId];
    if (!baseUrl) throw new UnknownSfuError(sfuId);
    // Keepalive pings: an idle room's Stats stream carries no frames, so without them a NAT or
    // proxy could drop the h2 connection unnoticed.
    const client = createClient(SfuService, createGrpcTransport({ baseUrl, pingIntervalMs: 10_000 }));
    this.clients.set(sfuId, client);
    return client;
  }
}
```

- [ ] **Step 2: Fake SFU test double**

`services/signaling/test/fake-sfu.ts`:

```ts
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  MediaKind,
  MediaSource,
  SfuService,
  TransportDirection,
  type StatsEventSchema,
  type StatsRequest,
} from "@zoomclone/sfu-proto";

export type StatsEventInit = NonNullable<MessageInitShape<typeof StatsEventSchema>["event"]>;

export const FAKE_RTP_CAPABILITIES = {
  codecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }],
  headerExtensions: [],
};

export type FakeTransport = {
  id: string;
  participantId: string;
  direction: TransportDirection;
  connected: boolean;
  iceParameters: Record<string, unknown>;
  iceCandidates: Record<string, unknown>[];
  dtlsParameters: Record<string, unknown>;
};
export type FakeProducer = {
  id: string;
  trackId: string;
  participantId: string;
  transportId: string;
  kind: MediaKind;
  source: MediaSource;
  paused: boolean;
  layerCount: number;
};
export type FakeConsumer = {
  id: string;
  producerId: string;
  participantId: string;
  transportId: string;
  paused: boolean;
  preferredSpatialLayer?: number;
  priority: number;
};
export type FakeRoom = {
  transports: Map<string, FakeTransport>;
  producers: Map<string, FakeProducer>;
  consumers: Map<string, FakeConsumer>;
};
export type FakeCall = { method: string; request: Record<string, unknown> };

class Queue<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }
  end(): void {
    this.ended = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  async *drain(signal: AbortSignal): AsyncGenerator<T> {
    const onAbort = () => this.end();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        if (this.items.length > 0) {
          yield this.items.shift()!;
          continue;
        }
        if (this.ended || signal.aborted) return;
        await new Promise<void>((resolve) => (this.waiter = resolve));
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * In-process SfuService over h2c: records every call, hands out predictable ids, keeps per-room
 * entity maps for snapshots, lets tests inject failures and push Stats events.
 */
export class FakeSfu {
  readonly calls: FakeCall[] = [];
  baseUrl = "";
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly streams = new Map<string, Set<Queue<StatsEventInit>>>();
  private readonly failures = new Map<string, { code: Code; skip: number }>();
  private counters = { t: 0, p: 0, c: 0 };
  private server: http2.Http2Server | null = null;

  async start(): Promise<string> {
    const server = http2.createServer(connectNodeAdapter({ routes: (router) => this.routes(router) }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const set of this.streams.values()) for (const q of set) q.end();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  reset(): void {
    this.calls.length = 0;
    this.failures.clear();
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Fails the (skip + 1)th upcoming call of `method` with `code`. */
  failNext(method: string, code: Code, skip = 0): void {
    this.failures.set(method, { code, skip });
  }

  room(sessionId: string): FakeRoom | undefined {
    return this.rooms.get(sessionId);
  }

  /** Pre-populates a room as if a previous controller had created these entities. */
  seedRoom(
    sessionId: string,
    seed: {
      transports?: Array<{ participantId: string; direction: "send" | "recv" }>;
      producers?: Array<{
        participantId: string;
        trackId: string;
        kind: "audio" | "video";
        source: "mic" | "camera" | "screen" | "screen_audio";
        paused?: boolean;
      }>;
    },
  ): { transportIds: string[]; producerIds: string[] } {
    const room = this.ensureRoom(sessionId);
    const transportIds: string[] = [];
    const producerIds: string[] = [];
    for (const t of seed.transports ?? []) {
      const transport = this.newTransport(
        t.participantId,
        t.direction === "send" ? TransportDirection.SEND : TransportDirection.RECV,
      );
      transport.connected = true;
      room.transports.set(transport.id, transport);
      transportIds.push(transport.id);
    }
    for (const p of seed.producers ?? []) {
      const send = [...room.transports.values()].find(
        (t) => t.participantId === p.participantId && t.direction === TransportDirection.SEND,
      );
      if (!send) throw new Error(`seedRoom: ${p.participantId} has no send transport`);
      const id = `p${++this.counters.p}`;
      room.producers.set(id, {
        id,
        trackId: p.trackId,
        participantId: p.participantId,
        transportId: send.id,
        kind: p.kind === "audio" ? MediaKind.AUDIO : MediaKind.VIDEO,
        source: {
          mic: MediaSource.MIC,
          camera: MediaSource.CAMERA,
          screen: MediaSource.SCREEN,
          screen_audio: MediaSource.SCREEN_AUDIO,
        }[p.source],
        paused: p.paused ?? false,
        layerCount: p.kind === "video" ? 3 : 1,
      });
      producerIds.push(id);
    }
    return { transportIds, producerIds };
  }

  emit(sessionId: string, event: StatsEventInit): void {
    for (const q of this.streams.get(sessionId) ?? []) q.push(event);
  }

  /** Ends every open Stats stream for the session (simulates a dropped connection). */
  dropStreams(sessionId: string): void {
    for (const q of this.streams.get(sessionId) ?? []) q.end();
    this.streams.delete(sessionId);
  }

  // ---- internals ----

  private guard(method: string, request: object): void {
    this.calls.push({ method, request: { ...request } as Record<string, unknown> });
    const failure = this.failures.get(method);
    if (!failure) return;
    if (failure.skip > 0) {
      failure.skip--;
      return;
    }
    this.failures.delete(method);
    throw new ConnectError(`injected ${method} failure`, failure.code);
  }

  private ensureRoom(sessionId: string): FakeRoom {
    let room = this.rooms.get(sessionId);
    if (!room) {
      room = { transports: new Map(), producers: new Map(), consumers: new Map() };
      this.rooms.set(sessionId, room);
    }
    return room;
  }

  private requireRoom(sessionId: string): FakeRoom {
    const room = this.rooms.get(sessionId);
    if (!room) throw new ConnectError(`room ${sessionId} not found`, Code.NotFound);
    return room;
  }

  private findTransport(transportId: string): { room: FakeRoom; transport: FakeTransport } {
    for (const room of this.rooms.values()) {
      const transport = room.transports.get(transportId);
      if (transport) return { room, transport };
    }
    throw new ConnectError(`transport ${transportId} not found`, Code.NotFound);
  }

  private findProducer(producerId: string): { room: FakeRoom; producer: FakeProducer } {
    for (const room of this.rooms.values()) {
      const producer = room.producers.get(producerId);
      if (producer) return { room, producer };
    }
    throw new ConnectError(`producer ${producerId} not found`, Code.NotFound);
  }

  private findConsumer(consumerId: string): { room: FakeRoom; consumer: FakeConsumer } {
    for (const room of this.rooms.values()) {
      const consumer = room.consumers.get(consumerId);
      if (consumer) return { room, consumer };
    }
    throw new ConnectError(`consumer ${consumerId} not found`, Code.NotFound);
  }

  private newTransport(participantId: string, direction: TransportDirection): FakeTransport {
    const n = ++this.counters.t;
    return {
      id: `t${n}`,
      participantId,
      direction,
      connected: false,
      iceParameters: { usernameFragment: `ufrag${n}`, password: `pwd${n}`, iceLite: true },
      iceCandidates: [
        { foundation: "udpcandidate", ip: "127.0.0.1", port: 40000 + n, priority: 1, protocol: "udp", type: "host" },
      ],
      dtlsParameters: { role: "auto", fingerprints: [{ algorithm: "sha-256", value: `AA:${n}` }] },
    };
  }

  private snapshot(sessionId: string, room: FakeRoom): StatsEventInit {
    return {
      case: "snapshot",
      value: {
        transports: [...room.transports.values()].map((t) => ({
          transportId: t.id,
          participantId: t.participantId,
          direction: t.direction,
          iceState: t.connected ? "connected" : "new",
          dtlsState: t.connected ? "connected" : "new",
          iceParametersJson: JSON.stringify(t.iceParameters),
          iceCandidatesJson: JSON.stringify(t.iceCandidates),
          dtlsParametersJson: JSON.stringify(t.dtlsParameters),
        })),
        producers: [...room.producers.values()].map((p) => ({
          producerId: p.id,
          meta: {
            sfuId: "fake-sfu",
            sessionId,
            participantId: p.participantId,
            trackId: p.trackId,
            kind: p.kind,
            source: p.source,
            origin: "local",
          },
          paused: p.paused,
          layerCount: p.layerCount,
          transportId: p.transportId,
        })),
        consumers: [...room.consumers.values()].map((c) => ({
          consumerId: c.id,
          producerId: c.producerId,
          participantId: c.participantId,
          transportId: c.transportId,
          paused: c.paused,
          producerPaused: room.producers.get(c.producerId)?.paused ?? false,
          preferredSpatialLayer: c.preferredSpatialLayer,
          priority: c.priority,
        })),
      },
    };
  }

  private async *statsStream(req: StatsRequest, ctx: HandlerContext): AsyncGenerator<{ event: StatsEventInit }> {
    this.guard("stats", req);
    const room = this.requireRoom(req.sessionId);
    const queue = new Queue<StatsEventInit>();
    let set = this.streams.get(req.sessionId);
    if (!set) {
      set = new Set();
      this.streams.set(req.sessionId, set);
    }
    set.add(queue);
    try {
      yield { event: this.snapshot(req.sessionId, room) };
      for await (const event of queue.drain(ctx.signal)) yield { event };
    } finally {
      set.delete(queue);
    }
  }

  private routes(router: ConnectRouter): void {
    router.service(SfuService, {
      allocateRoom: (req) => {
        this.guard("allocateRoom", req);
        this.ensureRoom(req.sessionId);
        return { rtpCapabilitiesJson: JSON.stringify(FAKE_RTP_CAPABILITIES), sfuId: "fake-sfu" };
      },
      closeRoom: (req) => {
        this.guard("closeRoom", req);
        this.rooms.delete(req.sessionId);
        this.dropStreams(req.sessionId);
        return {};
      },
      createTransport: (req) => {
        this.guard("createTransport", req);
        const room = this.requireRoom(req.sessionId);
        const transport = this.newTransport(req.participantId, req.direction);
        room.transports.set(transport.id, transport);
        return {
          transportId: transport.id,
          iceParametersJson: JSON.stringify(transport.iceParameters),
          iceCandidatesJson: JSON.stringify(transport.iceCandidates),
          dtlsParametersJson: JSON.stringify(transport.dtlsParameters),
        };
      },
      connectTransport: (req) => {
        this.guard("connectTransport", req);
        const { transport } = this.findTransport(req.transportId);
        if (transport.connected) throw new ConnectError("already connected", Code.FailedPrecondition);
        transport.connected = true;
        return {};
      },
      closeTransport: (req) => {
        this.guard("closeTransport", req);
        const { room, transport } = this.findTransport(req.transportId);
        room.transports.delete(transport.id);
        for (const [id, p] of room.producers) if (p.transportId === transport.id) room.producers.delete(id);
        for (const [id, c] of room.consumers) if (c.transportId === transport.id) room.consumers.delete(id);
        return {};
      },
      restartIce: (req) => {
        this.guard("restartIce", req);
        const { transport } = this.findTransport(req.transportId);
        return { iceParametersJson: JSON.stringify({ ...transport.iceParameters, usernameFragment: "restarted" }) };
      },
      publish: (req) => {
        this.guard("publish", req);
        const room = this.requireRoom(req.sessionId);
        const transport = room.transports.get(req.transportId);
        if (!transport) throw new ConnectError("transport not found", Code.NotFound);
        if (transport.participantId !== req.participantId) {
          throw new ConnectError("not your transport", Code.PermissionDenied);
        }
        if (transport.direction !== TransportDirection.SEND) {
          throw new ConnectError("wrong direction", Code.FailedPrecondition);
        }
        const n = ++this.counters.p;
        const producer: FakeProducer = {
          id: `p${n}`,
          trackId: `trk${n}`,
          participantId: req.participantId,
          transportId: req.transportId,
          kind: req.kind,
          source: req.source,
          paused: req.paused,
          layerCount: req.kind === MediaKind.VIDEO ? 3 : 1,
        };
        room.producers.set(producer.id, producer);
        return { producerId: producer.id, trackId: producer.trackId, layerCount: producer.layerCount };
      },
      unpublish: (req) => {
        this.guard("unpublish", req);
        const { room, producer } = this.findProducer(req.producerId);
        room.producers.delete(producer.id);
        for (const [id, c] of room.consumers) if (c.producerId === producer.id) room.consumers.delete(id);
        return {};
      },
      setProducerPaused: (req) => {
        this.guard("setProducerPaused", req);
        this.findProducer(req.producerId).producer.paused = req.paused;
        return {};
      },
      subscribe: (req) => {
        this.guard("subscribe", req);
        const room = this.requireRoom(req.sessionId);
        const transport = room.transports.get(req.transportId);
        if (!transport) throw new ConnectError("transport not found", Code.NotFound);
        if (transport.direction !== TransportDirection.RECV) {
          throw new ConnectError("wrong direction", Code.FailedPrecondition);
        }
        const producer = room.producers.get(req.producerId);
        if (!producer) throw new ConnectError("producer not found", Code.NotFound);
        const n = ++this.counters.c;
        const consumer: FakeConsumer = {
          id: `c${n}`,
          producerId: producer.id,
          participantId: req.participantId,
          transportId: req.transportId,
          paused: true,
          preferredSpatialLayer: req.maxSpatialLayer,
          priority: req.priority ?? 1,
        };
        room.consumers.set(consumer.id, consumer);
        return {
          consumerId: consumer.id,
          kind: producer.kind,
          rtpParametersJson: JSON.stringify({ codecs: [], encodings: [{ ssrc: 5_000_000 + n }] }),
          producerPaused: producer.paused,
        };
      },
      setConsumerPaused: (req) => {
        this.guard("setConsumerPaused", req);
        this.findConsumer(req.consumerId).consumer.paused = req.paused;
        return {};
      },
      unsubscribe: (req) => {
        this.guard("unsubscribe", req);
        const { room, consumer } = this.findConsumer(req.consumerId);
        room.consumers.delete(consumer.id);
        return {};
      },
      setLayer: (req) => {
        this.guard("setLayer", req);
        const { consumer } = this.findConsumer(req.consumerId);
        consumer.preferredSpatialLayer = req.spatialLayer;
        if (req.priority !== undefined) consumer.priority = req.priority;
        return {};
      },
      cascade: (req) => {
        this.guard("cascade", req);
        throw new ConnectError("cascade is not implemented", Code.Unimplemented);
      },
      stats: (req, ctx) => this.statsStream(req, ctx),
    });
  }
}
```

- [ ] **Step 3: Stats consumer (failing test first)**

`services/signaling/src/sfu/stats-consumer.test.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SfuService, type Snapshot, type StatsEvent } from "@zoomclone/sfu-proto";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSfu } from "../../test/fake-sfu";
import { StatsConsumer } from "./stats-consumer";
import { SfuDirectory, UnknownSfuError } from "./directory";

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const log = pino({ level: "silent" });

let fake: FakeSfu;
beforeEach(async () => {
  fake = new FakeSfu();
  await fake.start();
});
afterEach(async () => {
  await fake.stop();
});

describe("SfuDirectory", () => {
  it("caches one client per sfu id and rejects unknown ids", () => {
    const directory = new SfuDirectory({ "sfu-a": fake.baseUrl });
    expect(directory.ids()).toEqual(["sfu-a"]);
    expect(directory.get("sfu-a")).toBe(directory.get("sfu-a"));
    expect(directory.has("sfu-b")).toBe(false);
    expect(() => directory.get("sfu-b")).toThrow(UnknownSfuError);
  });
});

describe("StatsConsumer", () => {
  it("opens after beforeOpen, delivers the snapshot first, then events, and reopens after a drop", async () => {
    const client = createClient(SfuService, createGrpcTransport({ baseUrl: fake.baseUrl }));
    const snapshots: Snapshot[] = [];
    const events: StatsEvent[] = [];
    let opens = 0;
    const consumer = new StatsConsumer(
      client,
      S,
      {
        beforeOpen: async () => {
          opens++;
          await client.allocateRoom({ sessionId: S });
        },
        onSnapshot: (s) => snapshots.push(s),
        onEvent: (e) => events.push(e),
      },
      log,
      50,
    );
    await consumer.start();
    expect(opens).toBe(1);
    expect(snapshots).toHaveLength(1);
    fake.emit(S, { case: "silence", value: {} });
    await sleep(50);
    expect(events.map((e) => e.event.case)).toEqual(["silence"]);

    fake.dropStreams(S);
    await sleep(300);
    expect(opens).toBe(2);
    expect(snapshots).toHaveLength(2);
    fake.emit(S, { case: "silence", value: {} });
    await sleep(50);
    expect(events).toHaveLength(2);

    consumer.stop();
    await consumer.done;
    expect(fake.callsTo("stats")).toHaveLength(2);
  });

  it("start rejects when no snapshot arrives in time and stops cleanly", async () => {
    const client = createClient(SfuService, createGrpcTransport({ baseUrl: fake.baseUrl }));
    const consumer = new StatsConsumer(
      client,
      S,
      { onSnapshot: () => undefined, onEvent: () => undefined },
      log,
      50,
    );
    // No allocateRoom: the fake answers NOT_FOUND and the consumer keeps retrying.
    await expect(consumer.start(200)).rejects.toThrow(/no stats snapshot/);
    consumer.stop();
    await consumer.done;
    expect(fake.callsTo("stats").length).toBeGreaterThanOrEqual(2);
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- stats-consumer`
Expected: FAIL (`./stats-consumer` not found).

- [ ] **Step 4: Implement the stats consumer**

`services/signaling/src/sfu/stats-consumer.ts`:

```ts
import type { Client } from "@connectrpc/connect";
import type { SfuService, Snapshot, StatsEvent } from "@zoomclone/sfu-proto";
import type { Logger } from "pino";
import { describeSfuError } from "./codec";

export type StatsHandlers = {
  /** Runs before every open (the controller's idempotent AllocateRoom, so a lost room is recreated). */
  beforeOpen?: () => Promise<void>;
  onSnapshot: (snapshot: Snapshot) => void;
  onEvent: (event: StatsEvent) => void;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Consumes the SFU Stats stream for one room with reconnect (design doc "sfu-client/"): every
 * open yields a snapshot first, which the controller reconciles both ways, then live events.
 */
export class StatsConsumer {
  readonly done: Promise<void>;
  private readonly abort = new AbortController();
  private stopped = false;
  private firstSnapshot: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private resolveDone!: () => void;

  constructor(
    private readonly client: Client<typeof SfuService>,
    private readonly sessionId: string,
    private readonly handlers: StatsHandlers,
    private readonly log: Logger,
    private readonly retryMs = 1000,
  ) {
    this.done = new Promise<void>((resolve) => (this.resolveDone = resolve));
  }

  /** Resolves once the first snapshot has been handled; rejects after timeoutMs without one. */
  start(timeoutMs = 5000): Promise<void> {
    const first = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firstSnapshot = null;
        reject(new Error(`no stats snapshot for ${this.sessionId} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.firstSnapshot = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    void this.run();
    return first;
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.firstSnapshot?.reject(new Error("stats consumer stopped"));
    this.firstSnapshot = null;
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopped) {
        try {
          await this.handlers.beforeOpen?.();
          for await (const event of this.client.stats(
            { sessionId: this.sessionId },
            { signal: this.abort.signal },
          )) {
            if (event.event.case === "snapshot") {
              this.handlers.onSnapshot(event.event.value);
              this.firstSnapshot?.resolve();
              this.firstSnapshot = null;
            } else {
              this.handlers.onEvent(event);
            }
          }
          if (!this.stopped) this.log.warn({ sessionId: this.sessionId }, "stats stream ended, reopening");
        } catch (error) {
          if (this.stopped) return;
          this.log.warn({ sessionId: this.sessionId, error: describeSfuError(error) }, "stats stream failed, retrying");
        }
        if (this.stopped) return;
        await sleep(this.retryMs, this.abort.signal);
      }
    } finally {
      this.resolveDone();
    }
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test -- stats-consumer`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(signaling): add the SFU client side and an in-process fake SFU for tests

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 6: Media bindings and the room controller

**Files:**
- Create: `services/signaling/src/gateway/link.ts` (interface only; the ws implementation comes in Task 9), `services/signaling/src/room/media-bindings.ts`, `services/signaling/src/room/controller.ts`, `services/signaling/src/room/controller.test.ts`
- Modify: `services/signaling/test/helpers.ts` (replace with the full version below)

**Interfaces:**
- Consumes: `Room` (Task 2, including `canJoin`), `Checkpoint` / `OwnerLease` (Task 4), `ActiveSpeakerTracker` (Task 3), `StatsConsumer`, codec helpers and `FakeSfu` (Task 5), `endSession` from `@zoomclone/db`, `EventBus` from `@zoomclone/events`.
- Produces:
  - `link.ts`: `interface ParticipantLink { readonly id: string; send(message: ServerMessage): void; close(code: number, reason?: string): void }`.
  - `media-bindings.ts`: `class MediaBindings` (`transportsOf(pid)`, `transport(pid, "send" | "recv")`, `setTransports(pid, { send, recv })`, `removeTransport(transportId)`, `clearParticipant(pid)`, `addProducer(trackId, producerId, owner)`, `producerOf(trackId)`, `trackOf(producerId)`, `removeProducer(producerId)`, `addConsumer(binding)`, `consumerOf(pid, trackId)`, `consumerById(consumerId)`, `consumersOf(pid) -> Map<trackId, ConsumerBinding>`, `removeConsumer(consumerId)`, `setCapabilities(pid, caps)`, `capabilities(pid)`, `replaceFromSnapshot(snapshot)`); `ConsumerBinding = { consumer_id; track_id; participant_id; producer_id; ready: boolean; paused_pref: boolean; max_layer: number; priority: number }` (prefs normalized: `max_layer` defaults to 2, `priority` to 1).
  - `controller.ts`: `class RoomController` (`constructor(deps: ControllerDeps)`, `start()`, `attach(link, claims, hello) -> Promise<string | null>`, `handle(link, participantId, message: ControllerMessage) -> Promise<void>`, `detach(link, participantId)`, `endRoom(reason: EndReason) -> Promise<void>`, `close(code?, reason?) -> Promise<void>`, `sessionId`, `room`, `connectionCount`, `isGone`); `ControllerDeps = { room; sfu: Client<typeof SfuService>; checkpoint; lease; db; bus; log; timings: ControllerTimings; metrics?: ControllerMetrics; onGone(sessionId) }`; `ControllerTimings = { graceMs; idleMs; heartbeatMs; speakerTickMs; statsRetryMs }`; `ControllerMetrics = { resync(); replay() }`; `ControllerMessage = Exclude<ClientMessage, { type: "hello" | "ping" }>`; `HelloPayload = { id: string; resume_seq?: number; epoch?: number }`; `class RoomFailure extends Error { failure: RoomError }`; `toWsError(error) -> { code, message }`.
  - Hello reply contract: `ack {id, payload: HelloAck}` first, then `welcome` / `resync` (with `media` for joined participants) or the replayed events. Rejections send `error {id, code, message}` then close with the mapped code (4009 locked, 4007 capacity, 4002 / 4003 / 4008 departed, 4004 ended, 1011 SFU failure, 1008 otherwise).
  - `host.end` is acked before the room ends (the `after` hook of the reply).

- [ ] **Step 1: Link interface and media bindings**

`services/signaling/src/gateway/link.ts`:

```ts
import type { ServerMessage } from "@zoomclone/protocol";

/**
 * The controller's view of one socket (design doc: the seam for the later gateway split).
 * send never throws and drops frames once the socket is gone; close is idempotent.
 */
export interface ParticipantLink {
  readonly id: string;
  send(message: ServerMessage): void;
  close(code: number, reason?: string): void;
}
```

`services/signaling/src/room/media-bindings.ts`:

```ts
import type { TransportParams } from "@zoomclone/protocol";
import { TransportDirection, type Snapshot } from "@zoomclone/sfu-proto";
import { parseArray, parseObject } from "../sfu/codec";

export type ConsumerBinding = {
  consumer_id: string;
  track_id: string;
  participant_id: string;
  producer_id: string;
  /** The client sent consumer_ready (or the consumer predates this controller). */
  ready: boolean;
  paused_pref: boolean;
  max_layer: number;
  priority: number;
};
export type Transports = { send?: TransportParams; recv?: TransportParams };
export type Direction = "send" | "recv";

export const DEFAULT_MAX_LAYER = 2;
export const DEFAULT_PRIORITY = 1;

/**
 * SFU ids and client-facing parameters for one room (design doc "MediaBindings"). Never
 * checkpointed: a restarted controller rebuilds it from the Stats snapshot.
 */
export class MediaBindings {
  private readonly transports = new Map<string, Transports>();
  private readonly transportOwners = new Map<string, { participant_id: string; direction: Direction }>();
  private readonly producersByTrack = new Map<string, { producer_id: string; owner: string }>();
  private readonly tracksByProducer = new Map<string, string>();
  private readonly consumersById = new Map<string, ConsumerBinding>();
  private readonly caps = new Map<string, Record<string, unknown>>();

  transportsOf(participantId: string): Transports {
    return { ...(this.transports.get(participantId) ?? {}) };
  }

  transport(participantId: string, direction: Direction): TransportParams | undefined {
    return this.transports.get(participantId)?.[direction];
  }

  setTransports(participantId: string, t: { send: TransportParams; recv: TransportParams }): void {
    this.transports.set(participantId, { send: t.send, recv: t.recv });
    this.transportOwners.set(t.send.id, { participant_id: participantId, direction: "send" });
    this.transportOwners.set(t.recv.id, { participant_id: participantId, direction: "recv" });
  }

  removeTransport(transportId: string): void {
    const owner = this.transportOwners.get(transportId);
    if (!owner) return;
    this.transportOwners.delete(transportId);
    const entry = this.transports.get(owner.participant_id);
    if (entry) delete entry[owner.direction];
  }

  /** Everything owned by the participant: transports, producers, consumers, capabilities. */
  clearParticipant(participantId: string): void {
    const entry = this.transports.get(participantId);
    for (const t of [entry?.send, entry?.recv]) if (t) this.transportOwners.delete(t.id);
    this.transports.delete(participantId);
    for (const [trackId, p] of this.producersByTrack) {
      if (p.owner === participantId) this.removeProducer(p.producer_id);
      void trackId;
    }
    for (const [id, c] of this.consumersById) if (c.participant_id === participantId) this.consumersById.delete(id);
    this.caps.delete(participantId);
  }

  addProducer(trackId: string, producerId: string, owner: string): void {
    this.producersByTrack.set(trackId, { producer_id: producerId, owner });
    this.tracksByProducer.set(producerId, trackId);
  }

  producerOf(trackId: string): string | undefined {
    return this.producersByTrack.get(trackId)?.producer_id;
  }

  trackOf(producerId: string): string | undefined {
    return this.tracksByProducer.get(producerId);
  }

  /** Also forgets consumers of that producer (the SFU closes them with it). */
  removeProducer(producerId: string): void {
    const trackId = this.tracksByProducer.get(producerId);
    this.tracksByProducer.delete(producerId);
    if (trackId !== undefined) this.producersByTrack.delete(trackId);
    for (const [id, c] of this.consumersById) if (c.producer_id === producerId) this.consumersById.delete(id);
  }

  addConsumer(binding: ConsumerBinding): void {
    this.consumersById.set(binding.consumer_id, binding);
  }

  consumerOf(participantId: string, trackId: string): ConsumerBinding | undefined {
    for (const c of this.consumersById.values()) {
      if (c.participant_id === participantId && c.track_id === trackId) return c;
    }
    return undefined;
  }

  consumerById(consumerId: string): ConsumerBinding | undefined {
    return this.consumersById.get(consumerId);
  }

  consumersOf(participantId: string): Map<string, ConsumerBinding> {
    const out = new Map<string, ConsumerBinding>();
    for (const c of this.consumersById.values()) if (c.participant_id === participantId) out.set(c.track_id, c);
    return out;
  }

  removeConsumer(consumerId: string): void {
    this.consumersById.delete(consumerId);
  }

  setCapabilities(participantId: string, caps: Record<string, unknown>): void {
    this.caps.set(participantId, caps);
  }

  capabilities(participantId: string): Record<string, unknown> | undefined {
    return this.caps.get(participantId);
  }

  /** Rebuild from the SFU's view. Client capabilities survive (they never leave the controller). */
  replaceFromSnapshot(snapshot: Snapshot): void {
    this.transports.clear();
    this.transportOwners.clear();
    this.producersByTrack.clear();
    this.tracksByProducer.clear();
    this.consumersById.clear();
    for (const t of snapshot.transports) {
      const direction: Direction | null =
        t.direction === TransportDirection.SEND ? "send" : t.direction === TransportDirection.RECV ? "recv" : null;
      if (!direction) continue;
      const params: TransportParams = {
        id: t.transportId,
        ice_parameters: parseObject(t.iceParametersJson, "ice parameters"),
        ice_candidates: parseArray(t.iceCandidatesJson, "ice candidates"),
        dtls_parameters: parseObject(t.dtlsParametersJson, "dtls parameters"),
      };
      const entry = this.transports.get(t.participantId) ?? {};
      entry[direction] = params;
      this.transports.set(t.participantId, entry);
      this.transportOwners.set(t.transportId, { participant_id: t.participantId, direction });
    }
    for (const p of snapshot.producers) {
      if (!p.meta) continue;
      this.addProducer(p.meta.trackId, p.producerId, p.meta.participantId);
    }
    for (const c of snapshot.consumers) {
      const trackId = this.tracksByProducer.get(c.producerId);
      if (trackId === undefined) continue;
      this.addConsumer({
        consumer_id: c.consumerId,
        track_id: trackId,
        participant_id: c.participantId,
        producer_id: c.producerId,
        ready: true,
        paused_pref: c.paused,
        max_layer: c.preferredSpatialLayer ?? DEFAULT_MAX_LAYER,
        priority: c.priority || DEFAULT_PRIORITY,
      });
    }
  }
}
```

- [ ] **Step 2: Test helpers (full file) and the failing controller tests**

Replace `services/signaling/test/helpers.ts` with:

```ts
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
import { Room } from "../src/room/room";
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
export async function createTestInfra(envOverrides: Record<string, string> = {}): Promise<TestInfra> {
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

export function mintClaims(overrides: Partial<SignalingClaims> & { session_id: string }): SignalingClaims {
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
    if (!found) throw new Error(`no ${type} within ${timeoutMs} ms; got ${this.sent.map((m) => m.type).join(",")}`);
    return found;
  }
}

/** Polls until the getter returns a truthy value or the timeout elapses (returns undefined). */
export async function waitFor<T>(getter: () => T | undefined | false, timeoutMs = 2000): Promise<T | undefined> {
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
    Room.create({ session_id: sessionId, home_sfu: "fake-sfu", lobby_enabled: true, max_participants: 10 });
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
```

`services/signaling/src/room/controller.test.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { Code } from "@connectrpc/connect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloseCode, type ClientMessage } from "@zoomclone/protocol";
import { TransportDirection } from "@zoomclone/sfu-proto";
import { FakeSfu, FAKE_RTP_CAPABILITIES } from "../../test/fake-sfu";
import {
  FakeLink,
  createTestController,
  createTestInfra,
  mintClaims,
  seedSession,
  type TestController,
  type TestInfra,
} from "../../test/helpers";
import { roomKeys } from "./checkpoint";
import { Room } from "./room";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const W = "44444444-4444-4444-8444-444444444444";

let infra: TestInfra;
let sfu: FakeSfu;
let live: TestController[] = [];

beforeAll(async () => {
  infra = await createTestInfra();
});
afterAll(async () => {
  await infra.close();
});
beforeEach(async () => {
  await infra.redis.flushdb();
  sfu = new FakeSfu();
  await sfu.start();
});
afterEach(async () => {
  for (const t of live) await t.controller.close();
  live = [];
  await sfu.stop();
});

async function startRoom(sessionId?: string, room?: Room): Promise<TestController> {
  const t = await createTestController({ infra, sfu, sessionId, room });
  live.push(t);
  return t;
}

const CAPS = { codecs: [{ mimeType: "video/VP8", clockRate: 90000 }], headerExtensions: [] };

function msg<T extends ClientMessage["type"]>(
  type: T,
  payload: Extract<ClientMessage, { type: T }>["payload"],
  id = `${type}-${Math.random().toString(36).slice(2, 8)}`,
): Extract<ClientMessage, { type: T }> {
  return { type, id, payload } as Extract<ClientMessage, { type: T }>;
}

/** Joins with a fresh link; returns the link once the welcome arrived. */
async function join(
  t: TestController,
  overrides: { participant_id: string; role?: "host" | "attendee"; display_name?: string; lobby?: boolean },
): Promise<FakeLink> {
  const link = new FakeLink();
  const claims = mintClaims({ session_id: t.room.sessionId, ...overrides });
  const pid = await t.controller.attach(link, claims, { id: `hello-${overrides.participant_id.slice(0, 4)}` });
  if (pid === null) throw new Error(`attach closed the link: ${JSON.stringify(link.closedWith)}`);
  return link;
}

async function request<T extends ClientMessage["type"]>(
  t: TestController,
  link: FakeLink,
  pid: string,
  type: T,
  payload: Extract<ClientMessage, { type: T }>["payload"],
) {
  const m = msg(type, payload);
  await t.controller.handle(link, pid, m as never);
  const reply = link.sent.find((s) => (s.type === "ack" || s.type === "error") && s.id === m.id);
  if (!reply) throw new Error(`no reply for ${type}`);
  return reply;
}

describe("RoomController: joining", () => {
  it("creates both transports first, then welcome with media, and tells the others", async () => {
    const t = await startRoom();
    const joined: unknown[] = [];
    infra.bus.subscribe("participant.joined", (e) => {
      joined.push(e.payload);
    });
    const host = await join(t, { participant_id: HOST, role: "host", display_name: "Host" });
    expect(sfu.callsTo("createTransport").map((c) => c.request["direction"])).toEqual([
      TransportDirection.SEND,
      TransportDirection.RECV,
    ]);
    expect(host.sent[0]).toEqual({ type: "ack", id: "hello-1111", payload: { mode: "welcome", epoch: 1, seq: 1 } });
    expect(host.sent[1]).toMatchObject({
      type: "welcome",
      payload: {
        participant_id: HOST,
        role: "host",
        state: "joined",
        seq: 1,
        lobby: [],
        media: {
          rtp_capabilities: FAKE_RTP_CAPABILITIES,
          send_transport: { id: "t1", ice_parameters: { usernameFragment: "ufrag1" } },
          recv_transport: { id: "t2" },
        },
      },
    });
    const ann = await join(t, { participant_id: A, display_name: "Ann" });
    expect(host.last()).toMatchObject({
      type: "participant.joined",
      seq: 2,
      payload: { participant: { participant_id: A, name: "Ann", role: "attendee" } },
    });
    expect(ann.ofType("participant.joined")).toEqual([]);
    expect(ann.ofType("welcome")[0]?.payload.lobby).toBeUndefined();
    await infra.bus.drain();
    expect(joined).toHaveLength(2);
    expect(joined[1]).toMatchObject({ participant_id: A, display_name: "Ann", role: "attendee", user_id: null });
    await sleep(60);
    expect(await infra.redis.hlen(roomKeys(t.room.sessionId).roster)).toBe(2);
    expect(t.controller.connectionCount).toBe(2);
  });

  it("rolls the first transport back when the second CreateTransport fails and keeps the roster clean", async () => {
    const t = await startRoom();
    sfu.failNext("createTransport", Code.Internal, 1);
    const link = new FakeLink();
    const pid = await t.controller.attach(link, mintClaims({ session_id: t.room.sessionId, participant_id: A }), { id: "h" });
    expect(pid).toBeNull();
    expect(link.ofType("error")[0]?.payload.code).toBe("SFU_ERROR");
    expect(link.closedWith?.code).toBe(1011);
    expect(t.room.inRoster(A)).toBe(false);
    expect(sfu.callsTo("closeTransport").map((c) => c.request["transportId"])).toEqual(["t1"]);
    expect(t.controller.connectionCount).toBe(0);
  });

  it("refuses locked, full, ended and departed participants with the mapped close codes", async () => {
    const t = await startRoom();
    const host = await join(t, { participant_id: HOST, role: "host" });
    await request(t, host, HOST, "host.lock", { locked: true });
    const locked = new FakeLink();
    expect(await t.controller.attach(locked, mintClaims({ session_id: t.room.sessionId, participant_id: A }), { id: "h" })).toBeNull();
    expect(locked.closedWith?.code).toBe(CloseCode.LOCKED);
    expect(sfu.callsTo("createTransport")).toHaveLength(2);
    await request(t, host, HOST, "host.lock", { locked: false });
    const ann = await join(t, { participant_id: A });
    await request(t, host, HOST, "host.remove", { participant_id: A });
    expect(ann.closedWith?.code).toBe(CloseCode.REMOVED);
    const again = new FakeLink();
    expect(await t.controller.attach(again, mintClaims({ session_id: t.room.sessionId, participant_id: A }), { id: "h" })).toBeNull();
    expect(again.closedWith?.code).toBe(CloseCode.REMOVED);
  });
});

describe("RoomController: lobby", () => {
  it("waiters get a lobby welcome, hosts get lobby.request; admit sends lobby.result then resync with media", async () => {
    const t = await startRoom();
    const host = await join(t, { participant_id: HOST, role: "host" });
    const waiter = await join(t, { participant_id: W, lobby: true, display_name: "Wren" });
    expect(waiter.sent).toEqual([
      { type: "ack", id: "hello-4444", payload: { mode: "welcome", epoch: 1, seq: 2 } },
      { type: "welcome", payload: { participant_id: W, role: "attendee", epoch: 1, seq: 2, state: "lobby" } },
    ]);
    expect(host.last()).toMatchObject({ type: "lobby.request", payload: { participant_id: W, name: "Wren" } });
    expect(sfu.callsTo("createTransport")).toHaveLength(2);

    const reply = await request(t, host, HOST, "host.admit", { participant_id: W });
    expect(reply.type).toBe("ack");
    expect(waiter.sent.slice(2).map((m) => m.type)).toEqual(["lobby.result", "resync"]);
    expect(waiter.ofType("resync")[0]?.payload).toMatchObject({
      state: "joined",
      media: { send_transport: { id: "t3" }, recv_transport: { id: "t4" } },
    });
    expect(host.last()).toMatchObject({ type: "participant.joined", payload: { participant: { participant_id: W } } });
    expect(t.room.inRoster(W)).toBe(true);
  });

  it("deny answers the waiter, closes 4003, tells hosts lobby.left; a waiter's disconnect also leaves the lobby", async () => {
    const t = await startRoom();
    const host = await join(t, { participant_id: HOST, role: "host" });
    const waiter = await join(t, { participant_id: W, lobby: true });
    await request(t, host, HOST, "host.deny", { participant_id: W });
    expect(waiter.ofType("lobby.result")[0]?.payload).toEqual({ admitted: false });
    expect(waiter.closedWith?.code).toBe(CloseCode.LOBBY_DENIED);
    expect(host.ofType("lobby.left")[0]?.payload).toEqual({ participant_id: W });
    expect(t.room.departed(W)).toBe("denied");

    const other = await join(t, { participant_id: A, lobby: true });
    t.controller.detach(other, A);
    expect(host.ofType("lobby.left")).toHaveLength(2);
    expect(t.room.inLobby(A)).toBe(false);
    expect(t.room.departed(A)).toBeUndefined();
  });
});

describe("RoomController: media", () => {
  it("publish honours the mute state, subscribe diffs consumers, consumer_ready resumes, prefs call SetLayer", async () => {
    const t = await startRoom();
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    await request(t, ann, A, "connect_transport", { transport: "send", dtls_parameters: { role: "client" } });
    expect(sfu.callsTo("connectTransport")[0]?.request["transportId"]).toBe("t1");

    await request(t, ann, A, "set_media_state", { muted: true });
    expect(bob.last()).toMatchObject({ type: "participant.updated", payload: { participant_id: A, patch: { muted: true } } });
    const mic = await request(t, ann, A, "publish", { kind: "audio", source: "mic", rtp_parameters: { codecs: [] }, paused: false });
    expect(mic).toMatchObject({ type: "ack", payload: { track_id: "trk1" } });
    expect(sfu.callsTo("publish")[0]?.request["paused"]).toBe(true);
    expect(bob.last()).toMatchObject({ type: "track.added", payload: { track: { track_id: "trk1", owner: A, paused: true, layers: 1 } } });
    const cam = await request(t, ann, A, "publish", { kind: "video", source: "camera", rtp_parameters: { codecs: [] }, paused: false });
    expect(cam).toMatchObject({ type: "ack", payload: { track_id: "trk2" } });

    const noCaps = await request(t, bob, B, "subscribe", { track_ids: ["trk1", "trk2"], prefs: {} });
    expect(noCaps).toMatchObject({ type: "error", payload: { code: "INVALID" } });
    const first = await request(t, bob, B, "subscribe", { rtp_capabilities: CAPS, track_ids: ["trk1", "trk2"], prefs: {} });
    expect(first).toMatchObject({
      type: "ack",
      payload: {
        consumers: [
          { track_id: "trk1", consumer_id: "c1", kind: "audio", producer_paused: true },
          { track_id: "trk2", consumer_id: "c2", kind: "video", producer_paused: false },
        ],
        removed: [],
      },
    });
    expect(sfu.room(t.room.sessionId)?.consumers.get("c2")?.paused).toBe(true);
    await request(t, bob, B, "consumer_ready", { track_id: "trk2" });
    expect(sfu.room(t.room.sessionId)?.consumers.get("c2")?.paused).toBe(false);

    const prefs = await request(t, bob, B, "subscribe", { track_ids: ["trk1", "trk2"], prefs: { trk2: { max_layer: 0 } } });
    expect(prefs).toMatchObject({ type: "ack", payload: { consumers: [], removed: [] } });
    expect(sfu.callsTo("setLayer")).toHaveLength(1);
    expect(sfu.callsTo("setLayer")[0]?.request).toMatchObject({ consumerId: "c2", spatialLayer: 0 });

    const drop = await request(t, bob, B, "subscribe", { track_ids: ["trk2"], prefs: { trk2: { max_layer: 0 } } });
    expect(drop).toMatchObject({ type: "ack", payload: { consumers: [], removed: ["trk1"] } });
    expect(sfu.callsTo("unsubscribe")[0]?.request["consumerId"]).toBe("c1");

    await request(t, ann, A, "set_media_state", { muted: false });
    expect(sfu.callsTo("setProducerPaused")[0]?.request).toMatchObject({ producerId: "p1", paused: false });
    expect(bob.ofType("track.updated").at(-1)?.payload).toEqual({ track_id: "trk1", patch: { paused: false } });

    const unpublish = await request(t, ann, A, "unpublish", { track_id: "trk2" });
    expect(unpublish.type).toBe("ack");
    expect(sfu.callsTo("unpublish")[0]?.request["producerId"]).toBe("p2");
    expect(bob.last()).toMatchObject({ type: "track.removed", payload: { track_id: "trk2" } });
    expect((await request(t, bob, B, "unpublish", { track_id: "trk1" })).type).toBe("error");
    expect((await request(t, bob, B, "restart_ice", { transport: "send" })).payload).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("stats events: layers reach only the subscriber, speakers become active_speakers, producer_closed drops the track", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    await request(t, ann, A, "publish", { kind: "video", source: "camera", rtp_parameters: {}, paused: false });
    await request(t, bob, B, "subscribe", { rtp_capabilities: CAPS, track_ids: ["trk1"], prefs: {} });

    sfu.emit(S, { case: "consumerLayers", value: { consumerId: "c1", active: true, spatialLayer: 1, temporalLayer: 2 } });
    const layers = await bob.waitFor("track.updated");
    expect(layers.payload).toEqual({ track_id: "trk1", patch: { layers: 2 } });
    expect(ann.ofType("track.updated")).toEqual([]);

    sfu.emit(S, { case: "dominantSpeakers", value: { speakers: [{ participantId: A, producerId: "p1", volume: -20 }] } });
    await sleep(320);
    sfu.emit(S, { case: "dominantSpeakers", value: { speakers: [{ participantId: A, producerId: "p1", volume: -20 }] } });
    const active = await bob.waitFor("active_speakers");
    expect(active.payload).toEqual({ participant_ids: [A] });
    expect(ann.ofType("active_speakers")[0]?.payload).toEqual({ participant_ids: [A] });
    sfu.emit(S, { case: "silence", value: {} });
    await bob.waitFor("active_speakers", (m) => m.payload.participant_ids.length === 0);

    sfu.emit(S, { case: "producerClosed", value: { producerId: "p1", trackId: "trk1", participantId: A } });
    const removed = await bob.waitFor("track.removed");
    expect(removed.payload).toEqual({ track_id: "trk1" });
    expect(t.room.tracks()).toEqual([]);
  });
});

describe("RoomController: presence and reconnects", () => {
  it("disconnect starts the grace; a reconnect with a valid cursor replays; grace expiry leaves and closes transports", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    const annSeq = t.room.seq;
    t.controller.detach(ann, A);
    expect(bob.last()).toMatchObject({ type: "participant.updated", payload: { participant_id: A, patch: { connected: false } } });
    await request(t, bob, B, "reaction", { emoji: "wave" });
    await request(t, bob, B, "chat", { body: "psst", to: A });

    const back = new FakeLink();
    const pid = await t.controller.attach(back, mintClaims({ session_id: S, participant_id: A }), {
      id: "re",
      resume_seq: annSeq,
      epoch: 1,
    });
    expect(pid).toBe(A);
    // The disconnect notice went to everyone except A, so A gets only the reaction and the DM.
    expect(back.sent.map((m) => m.type)).toEqual(["ack", "reaction", "chat"]);
    expect(back.sent[0]).toMatchObject({ payload: { mode: "replay" } });
    expect(sfu.callsTo("createTransport")).toHaveLength(4);
    expect(bob.last()).toMatchObject({ type: "participant.updated", payload: { participant_id: A, patch: { connected: true } } });

    const left: unknown[] = [];
    infra.bus.subscribe("participant.left", (e) => {
      left.push(e.payload);
    });
    t.controller.detach(back, A);
    await bob.waitFor("participant.left");
    expect(bob.ofType("participant.left")[0]?.payload).toEqual({ participant_id: A, reason: "timeout" });
    expect(sfu.callsTo("closeTransport").map((c) => c.request["transportId"]).sort()).toEqual(["t1", "t2"]);
    await infra.bus.drain();
    expect(left[0]).toMatchObject({ participant_id: A, reason: "timeout" });
    const late = new FakeLink();
    expect(await t.controller.attach(late, mintClaims({ session_id: S, participant_id: A }), { id: "x" })).toBeNull();
    expect(late.closedWith?.code).toBe(CloseCode.REJOIN_REQUIRED);
  });

  it("resyncs on an epoch mismatch or stale cursor, and a newer connection replaces the older one with 4005 and no grace", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    const stale = new FakeLink();
    await t.controller.attach(stale, mintClaims({ session_id: S, participant_id: A }), { id: "s", resume_seq: 0, epoch: 7 });
    expect(stale.sent.map((m) => m.type)).toEqual(["ack", "resync"]);
    expect(stale.sent[0]).toMatchObject({ payload: { mode: "resync" } });
    expect(stale.ofType("resync")[0]?.payload.media?.send_transport.id).toBe("t1");
    expect(ann.closedWith?.code).toBe(CloseCode.REPLACED);
    t.controller.detach(ann, A);
    expect(bob.ofType("participant.updated")).toEqual([]);
    expect(t.room.rosterEntry(A)?.connected).toBe(true);
  });
});

describe("RoomController: ending", () => {
  it("host.end acks first, then room.ended to everyone, closes 4004, CloseRoom, Redis ended, Postgres ended with peak", async () => {
    const { sessionId } = await seedSession(infra.db);
    const t = await startRoom(sessionId);
    const ended: unknown[] = [];
    infra.bus.subscribe("session.ended", (e) => {
      ended.push(e.payload);
    });
    const host = await join(t, { participant_id: HOST, role: "host" });
    const ann = await join(t, { participant_id: A });
    const waiter = await join(t, { participant_id: W, lobby: true });
    const attendee = await request(t, ann, A, "host.end", {});
    expect(attendee).toMatchObject({ type: "error", payload: { code: "FORBIDDEN" } });
    const m = msg("host.end", {});
    await t.controller.handle(host, HOST, m);
    expect(host.sent.map((x) => x.type).slice(-2)).toEqual(["ack", "room.ended"]);
    expect(host.ofType("room.ended")[0]?.payload).toEqual({ reason: "host_end" });
    expect(ann.ofType("room.ended")).toHaveLength(1);
    expect(waiter.ofType("room.ended")).toHaveLength(1);
    for (const link of [host, ann, waiter]) expect(link.closedWith?.code).toBe(CloseCode.ROOM_ENDED);
    expect(await t.gone).toBe(sessionId);
    expect(sfu.callsTo("closeRoom")).toHaveLength(1);
    expect(await infra.redis.hgetall(roomKeys(sessionId).meta)).toMatchObject({ status: "ended", end_reason: "host_end" });
    const [session] = await infra.db<{ endedAt: Date | null; peakParticipants: number | null }[]>`
      SELECT ended_at, peak_participants FROM meeting_sessions WHERE id = ${sessionId}`;
    expect(session?.endedAt).not.toBeNull();
    expect(session?.peakParticipants).toBe(2);
    const [meeting] = await infra.db<{ status: string }[]>`SELECT status FROM meetings`;
    expect(meeting?.status).toBe("ended");
    await infra.bus.drain();
    expect(ended[0]).toMatchObject({ session_id: sessionId, reason: "host_end", peak_participants: 2 });
    expect(await infra.redis.exists(roomKeys(sessionId).owner)).toBe(0);
  });

  it("an idle room ends with reason idle and the meeting returns to scheduled; endRoom runs once", async () => {
    const { sessionId } = await seedSession(infra.db);
    const t = await startRoom(sessionId);
    const ann = await join(t, { participant_id: A });
    await sleep(500);
    expect(t.controller.isGone).toBe(false);
    t.controller.detach(ann, A);
    expect(await t.gone).toBe(sessionId);
    const [meeting] = await infra.db<{ status: string }[]>`SELECT status FROM meetings`;
    expect(meeting?.status).toBe("scheduled");
    await Promise.all([t.controller.endRoom("api_end"), t.controller.endRoom("api_end")]);
    expect(sfu.callsTo("closeRoom")).toHaveLength(1);
  });

  it("api_end from the control plane ends the room even with nobody connected, and close keeps the room rehydratable", async () => {
    const { sessionId } = await seedSession(infra.db);
    const t = await startRoom(sessionId);
    await join(t, { participant_id: A });
    await t.controller.close();
    expect(await infra.redis.hget(roomKeys(sessionId).meta, "status")).toBe("live");
    expect(await infra.redis.exists(roomKeys(sessionId).owner)).toBe(0);
    const again = await startRoom(sessionId, Room.fromSnapshot(t.room.toSnapshot(), { bumpEpoch: true }));
    await again.controller.endRoom("api_end");
    expect(await infra.redis.hget(roomKeys(sessionId).meta, "end_reason")).toBe("api_end");
  });
});

describe("RoomController: rehydrate reconcile", () => {
  it("drops checkpointed tracks without producers, adds live producers, and reuses snapshot transports on resync", async () => {
    const S = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const { transportIds } = sfu.seedRoom(S, {
      transports: [
        { participantId: A, direction: "send" },
        { participantId: A, direction: "recv" },
      ],
      producers: [{ participantId: A, trackId: "live-cam", kind: "video", source: "camera" }],
    });
    const snapshot = Room.create({ session_id: S, home_sfu: "fake-sfu", lobby_enabled: true, max_participants: 10 });
    snapshot.apply({ type: "join", participant_id: A, name: "Ann", role: "attendee" });
    snapshot.apply({ type: "join", participant_id: B, name: "Bob", role: "attendee" });
    snapshot.apply({
      type: "publish",
      participant_id: A,
      track: { track_id: "stale-mic", owner: A, kind: "audio", source: "mic", paused: false, layers: 1 },
    });
    const room = Room.fromSnapshot(snapshot.toSnapshot(), { bumpEpoch: true });
    const t = await startRoom(undefined, room);
    expect(room.epoch).toBe(2);
    expect(room.tracks().map((x) => x.track_id)).toEqual(["live-cam"]);
    expect(room.track("live-cam")).toMatchObject({ owner: A, kind: "video", source: "camera", layers: 3 });

    const ann = new FakeLink();
    await t.controller.attach(ann, mintClaims({ session_id: S, participant_id: A }), { id: "h", resume_seq: 3, epoch: 1 });
    expect(ann.sent[0]).toMatchObject({ payload: { mode: "resync", epoch: 2 } });
    expect(ann.ofType("resync")[0]?.payload.media).toMatchObject({
      send_transport: { id: transportIds[0] },
      recv_transport: { id: transportIds[1] },
    });
    expect(sfu.callsTo("createTransport")).toHaveLength(0);

    const bob = new FakeLink();
    await t.controller.attach(bob, mintClaims({ session_id: S, participant_id: B }), { id: "h2" });
    expect(bob.ofType("resync")[0]?.payload.media?.send_transport.id).toBe("t3");
    expect(sfu.callsTo("createTransport")).toHaveLength(2);
    await sleep(400);
    expect(t.room.inRoster(B)).toBe(true);
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- controller`
Expected: FAIL (`./controller` and `./media-bindings` not found).

- [ ] **Step 3: Implement the controller**

`services/signaling/src/room/controller.ts`:

```ts
import { ConnectError, type Client } from "@connectrpc/connect";
import { endSession, type Db, type EndReason } from "@zoomclone/db";
import type { EventBus } from "@zoomclone/events";
import {
  CloseCode,
  type ClientMessage,
  type ConsumerParams,
  type HelloAck,
  type MediaParams,
  type MediaSource,
  type RoomEvent,
  type RosterEntry,
  type SignalingClaims,
  type SubscriptionPref,
  type TrackInfo,
  type TransportParams,
  type Welcome,
  type WsErrorCode,
} from "@zoomclone/protocol";
import { TransportDirection, type SfuService, type Snapshot, type StatsEvent } from "@zoomclone/sfu-proto";
import type { Logger } from "pino";
import type { ParticipantLink } from "../gateway/link";
import {
  SfuPayloadError,
  describeSfuError,
  isNotFound,
  kindFromPb,
  kindToPb,
  parseArray,
  parseObject,
  sourceFromPb,
  sourceToPb,
} from "../sfu/codec";
import { StatsConsumer } from "../sfu/stats-consumer";
import { ActiveSpeakerTracker } from "./active-speakers";
import type { Checkpoint, OwnerLease } from "./checkpoint";
import { DEFAULT_MAX_LAYER, DEFAULT_PRIORITY, MediaBindings, type ConsumerBinding } from "./media-bindings";
import type { Room } from "./room";
import type { Command, Emitted, RoomError, Target } from "./types";

export class RoomFailure extends Error {
  constructor(readonly failure: RoomError) {
    super(failure.message);
    this.name = "RoomFailure";
  }
}

export type ControllerTimings = {
  graceMs: number;
  idleMs: number;
  heartbeatMs: number;
  speakerTickMs: number;
  statsRetryMs: number;
};

export type ControllerMetrics = { resync(): void; replay(): void };

export type ControllerDeps = {
  room: Room;
  sfu: Client<typeof SfuService>;
  checkpoint: Checkpoint;
  lease: OwnerLease;
  db: Db;
  bus: EventBus;
  log: Logger;
  timings: ControllerTimings;
  metrics?: ControllerMetrics;
  /** Called once the controller is gone (room ended or controller closed); the registry drops it. */
  onGone: (sessionId: string) => void;
};

export type ControllerMessage = Exclude<ClientMessage, { type: "hello" | "ping" }>;
export type HelloPayload = { id: string; resume_seq?: number; epoch?: number };
type PayloadOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>["payload"];
type Reply = { ack: Record<string, unknown>; after?: () => Promise<void> };

const CLOSE_BY_DEPARTED = {
  removed: CloseCode.REMOVED,
  denied: CloseCode.LOBBY_DENIED,
  grace: CloseCode.REJOIN_REQUIRED,
} as const;

export function toWsError(error: unknown): { code: WsErrorCode; message: string } {
  if (error instanceof RoomFailure) return { code: error.failure.code, message: error.failure.message };
  if (error instanceof ConnectError || error instanceof SfuPayloadError) {
    return { code: "SFU_ERROR", message: describeSfuError(error) };
  }
  return { code: "INTERNAL", message: "internal error" };
}

/**
 * One live session (design doc "room/RoomController.ts"): turns socket messages into SFU calls
 * plus Room commands (SFU first, Room after), fans events to links, publishes bus events,
 * schedules checkpoints, runs the grace and idle timers and consumes the SFU Stats stream.
 */
export class RoomController {
  readonly room: Room;
  private readonly links = new Map<string, ParticipantLink>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly bindings = new MediaBindings();
  private readonly tracker: ActiveSpeakerTracker;
  private readonly stats: StatsConsumer;
  private rtpCapabilities: Record<string, unknown> = {};
  private idleTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private speakerTimer: NodeJS.Timeout | null = null;
  private ending: Promise<void> | null = null;
  private gone = false;

  constructor(private readonly deps: ControllerDeps) {
    this.room = deps.room;
    this.tracker = new ActiveSpeakerTracker((ids) => this.onActiveSpeakers(ids));
    this.stats = new StatsConsumer(
      deps.sfu,
      this.room.sessionId,
      {
        beforeOpen: () => this.allocate(),
        onSnapshot: (snapshot) => this.reconcile(snapshot),
        onEvent: (event) => this.onStatsEvent(event),
      },
      deps.log,
      deps.timings.statsRetryMs,
    );
  }

  get sessionId(): string {
    return this.room.sessionId;
  }
  get connectionCount(): number {
    return this.links.size;
  }
  get isGone(): boolean {
    return this.gone;
  }

  /** AllocateRoom, first Stats snapshot (reconciled), initial checkpoint, timers. */
  async start(): Promise<void> {
    await this.stats.start();
    await this.deps.checkpoint.writeAll();
    this.heartbeat = setInterval(() => void this.heartbeatTick(), this.deps.timings.heartbeatMs);
    this.speakerTimer = setInterval(() => this.tracker.tick(Date.now()), this.deps.timings.speakerTickMs);
    for (const entry of this.room.roster()) {
      if (!entry.connected) this.startGrace(entry.participant_id);
    }
    this.armIdle();
  }

  // ---- hello ----

  /** Returns the participant id once the link is attached, or null when the link was closed. */
  attach(link: ParticipantLink, claims: SignalingClaims, hello: HelloPayload): Promise<string | null> {
    return this.withLock(claims.participant_id, () => this.doAttach(link, claims, hello));
  }

  private async doAttach(link: ParticipantLink, claims: SignalingClaims, hello: HelloPayload): Promise<string | null> {
    const pid = claims.participant_id;
    if (this.gone || this.room.status === "ended") {
      link.close(CloseCode.ROOM_ENDED, "room ended");
      return null;
    }
    const departed = this.room.departed(pid);
    if (departed) {
      link.close(CLOSE_BY_DEPARTED[departed], `departed: ${departed}`);
      return null;
    }
    this.cancelGrace(pid);
    try {
      if (this.room.inRoster(pid)) return await this.resume(link, pid, hello);
      if (this.room.inLobby(pid)) {
        this.takeover(pid, link);
        this.sendSnapshot(link, hello.id, "welcome", this.room.welcomeFor(pid));
        return pid;
      }
      return await this.freshJoin(link, claims, hello.id);
    } catch (error) {
      this.deps.log.warn({ sessionId: this.sessionId, participantId: pid, error: describeSfuError(error) }, "hello failed");
      link.send({ type: "error", id: hello.id, payload: toWsError(error) });
      link.close(error instanceof RoomFailure ? (error.failure.close ?? 1008) : 1011, "hello failed");
      if (this.room.inRoster(pid) && !this.links.has(pid)) this.startGrace(pid);
      return null;
    }
  }

  private async resume(link: ParticipantLink, pid: string, hello: HelloPayload): Promise<string> {
    const media = await this.ensureTransports(pid);
    if (!this.room.inRoster(pid)) {
      await this.closeTransports(pid);
      throw new RoomFailure({ code: "NOT_FOUND", message: "left the room during hello", close: CloseCode.REJOIN_REQUIRED });
    }
    this.takeover(pid, link);
    this.applyOrThrow({ type: "reconnect", participant_id: pid });
    const replay =
      hello.resume_seq !== undefined && hello.epoch === this.room.epoch
        ? this.room.replay(pid, hello.resume_seq)
        : null;
    if (replay) {
      this.sendAck(link, hello.id, "replay");
      for (const event of replay) link.send(event);
      this.deps.metrics?.replay();
    } else {
      this.sendSnapshot(link, hello.id, "resync", { ...this.room.welcomeFor(pid), media });
      this.deps.metrics?.resync();
    }
    return pid;
  }

  private async freshJoin(link: ParticipantLink, claims: SignalingClaims, helloId: string): Promise<string | null> {
    const pid = claims.participant_id;
    if (claims.lobby) {
      const outcome = this.room.apply({ type: "lobby_request", participant_id: pid, name: claims.display_name });
      if (!outcome.ok) {
        this.reject(link, helloId, outcome.error);
        return null;
      }
      this.takeover(pid, link);
      this.afterApply(outcome.events);
      this.sendSnapshot(link, helloId, "welcome", this.room.welcomeFor(pid));
      return pid;
    }
    const early = this.room.canJoin(pid, claims.role);
    if (early) {
      this.reject(link, helloId, early);
      return null;
    }
    const media = await this.createTransports(pid);
    const outcome = this.room.apply({ type: "join", participant_id: pid, name: claims.display_name, role: claims.role });
    if (!outcome.ok) {
      await this.closeTransports(pid);
      this.reject(link, helloId, outcome.error);
      return null;
    }
    this.takeover(pid, link);
    this.afterApply(outcome.events);
    this.sendSnapshot(link, helloId, "welcome", { ...this.room.welcomeFor(pid), media });
    return pid;
  }

  /** Newest socket wins: the previous one closes 4005 and its close callback is ignored. */
  private takeover(pid: string, link: ParticipantLink): void {
    const previous = this.links.get(pid);
    this.links.set(pid, link);
    if (previous && previous !== link) previous.close(CloseCode.REPLACED, "replaced by a newer connection");
  }

  private reject(link: ParticipantLink, helloId: string, error: RoomError): void {
    link.send({ type: "error", id: helloId, payload: { code: error.code, message: error.message } });
    link.close(error.close ?? 1008, error.message);
  }

  private sendAck(link: ParticipantLink, id: string, mode: HelloAck["mode"]): void {
    const payload: HelloAck = { mode, epoch: this.room.epoch, seq: this.room.seq };
    link.send({ type: "ack", id, payload });
  }

  private sendSnapshot(link: ParticipantLink, id: string, mode: "welcome" | "resync", payload: Welcome): void {
    this.sendAck(link, id, mode);
    link.send({ type: mode, payload });
  }

  // ---- requests ----

  async handle(link: ParticipantLink, pid: string, message: ControllerMessage): Promise<void> {
    if (this.links.get(pid) !== link) return;
    let reply: Reply;
    try {
      reply = await this.dispatch(pid, message);
    } catch (error) {
      if (!(error instanceof RoomFailure)) {
        this.deps.log.warn(
          { sessionId: this.sessionId, participantId: pid, type: message.type, error: describeSfuError(error) },
          "request failed",
        );
      }
      link.send({ type: "error", id: message.id, payload: toWsError(error) });
      return;
    }
    link.send({ type: "ack", id: message.id, payload: reply.ack });
    if (reply.after) await reply.after();
  }

  private async dispatch(pid: string, message: ControllerMessage): Promise<Reply> {
    switch (message.type) {
      case "connect_transport": {
        const transport = this.bindings.transport(pid, message.payload.transport);
        if (!transport) throw new RoomFailure({ code: "NOT_FOUND", message: "no such transport" });
        await this.deps.sfu.connectTransport({
          transportId: transport.id,
          dtlsParametersJson: JSON.stringify(message.payload.dtls_parameters),
        });
        return { ack: {} };
      }
      case "publish":
        return { ack: await this.publish(pid, message.payload) };
      case "unpublish":
        await this.unpublish(pid, message.payload.track_id);
        return { ack: {} };
      case "subscribe":
        return { ack: await this.subscribe(pid, message.payload) };
      case "consumer_ready":
        await this.consumerReady(pid, message.payload.track_id);
        return { ack: {} };
      case "set_media_state":
        await this.setMediaState(pid, message.payload.muted, message.payload.video_off);
        return { ack: {} };
      case "raise_hand":
        this.applyOrThrow({ type: "hand", participant_id: pid, raised: true });
        return { ack: {} };
      case "lower_hand":
        this.applyOrThrow({ type: "hand", participant_id: pid, raised: false });
        return { ack: {} };
      case "reaction":
        this.applyOrThrow({ type: "reaction", from: pid, emoji: message.payload.emoji });
        return { ack: {} };
      case "chat":
        this.applyOrThrow(
          message.payload.to === undefined
            ? { type: "chat", from: pid, body: message.payload.body }
            : { type: "chat", from: pid, body: message.payload.body, to: message.payload.to },
        );
        return { ack: {} };
      case "host.admit":
        await this.admit(pid, message.payload.participant_id);
        return { ack: {} };
      case "host.deny":
        this.deny(pid, message.payload.participant_id);
        return { ack: {} };
      case "host.mute":
        await this.hostMute(pid, message.payload.participant_id);
        return { ack: {} };
      case "host.remove":
        await this.remove(pid, message.payload.participant_id);
        return { ack: {} };
      case "host.lock":
        this.requireHost(pid);
        this.applyOrThrow({ type: "lock", actor: pid, locked: message.payload.locked });
        this.audit(pid, message.payload.locked ? "lock" : "unlock");
        return { ack: {} };
      case "host.end":
        this.requireHost(pid);
        this.audit(pid, "end");
        return { ack: {}, after: () => this.endRoom("host_end") };
      case "restart_ice":
        throw new RoomFailure({ code: "NOT_IMPLEMENTED", message: "restart_ice is not implemented" });
    }
  }

  private requireHost(pid: string): void {
    if (!this.room.isHost(pid)) throw new RoomFailure({ code: "FORBIDDEN", message: "host role required" });
  }

  private requireJoined(pid: string): RosterEntry {
    const entry = this.room.rosterEntry(pid);
    if (!entry) throw new RoomFailure({ code: "NOT_FOUND", message: "not in the room" });
    return entry;
  }

  private applyOrThrow(command: Command): Emitted[] {
    const outcome = this.room.apply(command);
    if (!outcome.ok) throw new RoomFailure(outcome.error);
    this.afterApply(outcome.events);
    return outcome.events;
  }

  // ---- media ----

  private async createTransport(pid: string, direction: "send" | "recv"): Promise<TransportParams> {
    const res = await this.deps.sfu.createTransport({
      sessionId: this.sessionId,
      participantId: pid,
      direction: direction === "send" ? TransportDirection.SEND : TransportDirection.RECV,
    });
    return {
      id: res.transportId,
      ice_parameters: parseObject(res.iceParametersJson, "ice parameters"),
      ice_candidates: parseArray(res.iceCandidatesJson, "ice candidates"),
      dtls_parameters: parseObject(res.dtlsParametersJson, "dtls parameters"),
    };
  }

  /** Both transports or none (design doc ordering rule): a failed second call closes the first. */
  private async createTransports(pid: string): Promise<MediaParams> {
    const send = await this.createTransport(pid, "send");
    let recv: TransportParams;
    try {
      recv = await this.createTransport(pid, "recv");
    } catch (error) {
      await this.deps.sfu
        .closeTransport({ transportId: send.id })
        .catch((e: unknown) => this.warn("rollback closeTransport failed", e));
      throw error;
    }
    this.bindings.setTransports(pid, { send, recv });
    return { rtp_capabilities: this.rtpCapabilities, send_transport: send, recv_transport: recv };
  }

  private async ensureTransports(pid: string): Promise<MediaParams> {
    const existing = this.bindings.transportsOf(pid);
    if (existing.send && existing.recv) {
      return { rtp_capabilities: this.rtpCapabilities, send_transport: existing.send, recv_transport: existing.recv };
    }
    await this.closeTransports(pid);
    return this.createTransports(pid);
  }

  private async closeTransports(pid: string): Promise<void> {
    const { send, recv } = this.bindings.transportsOf(pid);
    this.bindings.clearParticipant(pid);
    for (const transport of [send, recv]) {
      if (!transport) continue;
      await this.deps.sfu.closeTransport({ transportId: transport.id }).catch((error: unknown) => {
        if (!isNotFound(error)) this.warn("closeTransport failed", error);
      });
    }
  }

  private async publish(pid: string, payload: PayloadOf<"publish">): Promise<{ track_id: string }> {
    const entry = this.requireJoined(pid);
    const send = this.bindings.transport(pid, "send");
    if (!send) throw new RoomFailure({ code: "NOT_FOUND", message: "no send transport" });
    const paused =
      payload.paused ||
      (payload.source === "mic" && entry.muted) ||
      (payload.source === "camera" && entry.video_off);
    const res = await this.deps.sfu.publish({
      sessionId: this.sessionId,
      participantId: pid,
      transportId: send.id,
      kind: kindToPb(payload.kind),
      source: sourceToPb(payload.source),
      rtpParametersJson: JSON.stringify(payload.rtp_parameters),
      paused,
    });
    const track: TrackInfo = {
      track_id: res.trackId,
      owner: pid,
      kind: payload.kind,
      source: payload.source,
      paused,
      layers: res.layerCount,
    };
    const outcome = this.room.apply({ type: "publish", participant_id: pid, track });
    if (!outcome.ok) {
      await this.deps.sfu
        .unpublish({ producerId: res.producerId })
        .catch((e: unknown) => this.warn("rollback unpublish failed", e));
      throw new RoomFailure(outcome.error);
    }
    this.bindings.addProducer(track.track_id, res.producerId, pid);
    this.afterApply(outcome.events);
    return { track_id: track.track_id };
  }

  private async unpublish(pid: string, trackId: string): Promise<void> {
    const track = this.room.track(trackId);
    if (!track) throw new RoomFailure({ code: "NOT_FOUND", message: "unknown track" });
    if (track.owner !== pid) throw new RoomFailure({ code: "FORBIDDEN", message: "not your track" });
    const producerId = this.bindings.producerOf(trackId);
    if (producerId) {
      await this.deps.sfu.unpublish({ producerId }).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
      this.bindings.removeProducer(producerId);
    }
    this.applyOrThrow({ type: "unpublish", participant_id: pid, track_id: trackId });
  }

  /** Declarative full set (design doc): create missing consumers, drop extra ones, diff prefs. */
  private async subscribe(
    pid: string,
    payload: PayloadOf<"subscribe">,
  ): Promise<{ consumers: ConsumerParams[]; removed: string[] }> {
    this.requireJoined(pid);
    const recv = this.bindings.transport(pid, "recv");
    if (!recv) throw new RoomFailure({ code: "NOT_FOUND", message: "no recv transport" });
    if (payload.rtp_capabilities) this.bindings.setCapabilities(pid, payload.rtp_capabilities);
    const caps = this.bindings.capabilities(pid);
    if (!caps) throw new RoomFailure({ code: "INVALID", message: "rtp_capabilities required on the first subscribe" });
    const desired = new Set(
      payload.track_ids.filter((id) => {
        const track = this.room.track(id);
        return track !== undefined && track.owner !== pid;
      }),
    );
    const consumers: ConsumerParams[] = [];
    const removed: string[] = [];
    for (const [trackId, binding] of this.bindings.consumersOf(pid)) {
      if (desired.has(trackId)) continue;
      await this.deps.sfu.unsubscribe({ consumerId: binding.consumer_id }).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
      this.bindings.removeConsumer(binding.consumer_id);
      removed.push(trackId);
    }
    for (const trackId of desired) {
      const pref: SubscriptionPref = payload.prefs[trackId] ?? {};
      const existing = this.bindings.consumerOf(pid, trackId);
      if (existing) {
        await this.updatePrefs(existing, pref);
        continue;
      }
      const producerId = this.bindings.producerOf(trackId);
      if (!producerId) continue;
      const res = await this.deps.sfu.subscribe({
        sessionId: this.sessionId,
        participantId: pid,
        transportId: recv.id,
        producerId,
        rtpCapabilitiesJson: JSON.stringify(caps),
        maxSpatialLayer: pref.max_layer,
        priority: pref.priority,
      });
      this.bindings.addConsumer({
        consumer_id: res.consumerId,
        track_id: trackId,
        participant_id: pid,
        producer_id: producerId,
        ready: false,
        paused_pref: pref.paused ?? false,
        max_layer: pref.max_layer ?? DEFAULT_MAX_LAYER,
        priority: pref.priority ?? DEFAULT_PRIORITY,
      });
      consumers.push({
        track_id: trackId,
        consumer_id: res.consumerId,
        kind: kindFromPb(res.kind),
        rtp_parameters: parseObject(res.rtpParametersJson, "rtp parameters"),
        producer_paused: res.producerPaused,
      });
    }
    return { consumers, removed };
  }

  private async updatePrefs(binding: ConsumerBinding, pref: SubscriptionPref): Promise<void> {
    const maxLayer = pref.max_layer ?? DEFAULT_MAX_LAYER;
    const priority = pref.priority ?? DEFAULT_PRIORITY;
    const isVideo = this.room.track(binding.track_id)?.kind === "video";
    if (isVideo && (maxLayer !== binding.max_layer || priority !== binding.priority)) {
      await this.deps.sfu.setLayer({ consumerId: binding.consumer_id, spatialLayer: maxLayer, priority });
      binding.max_layer = maxLayer;
      binding.priority = priority;
    }
    const paused = pref.paused ?? false;
    if (paused !== binding.paused_pref) {
      binding.paused_pref = paused;
      if (binding.ready) await this.deps.sfu.setConsumerPaused({ consumerId: binding.consumer_id, paused });
    }
  }

  private async consumerReady(pid: string, trackId: string): Promise<void> {
    const binding = this.bindings.consumerOf(pid, trackId);
    if (!binding) throw new RoomFailure({ code: "NOT_FOUND", message: "no consumer for that track" });
    if (binding.ready) return;
    binding.ready = true;
    if (!binding.paused_pref) {
      await this.deps.sfu.setConsumerPaused({ consumerId: binding.consumer_id, paused: false });
    }
  }

  private async setMediaState(pid: string, muted?: boolean, videoOff?: boolean): Promise<void> {
    const entry = this.requireJoined(pid);
    await this.pauseProducers(entry, muted, videoOff);
    const command: Command = { type: "set_media_state", participant_id: pid };
    if (muted !== undefined) command.muted = muted;
    if (videoOff !== undefined) command.video_off = videoOff;
    this.applyOrThrow(command);
  }

  /** SFU first: pause or resume the producers the room will mark afterwards. */
  private async pauseProducers(entry: RosterEntry, muted?: boolean, videoOff?: boolean): Promise<void> {
    const changes: Array<{ source: MediaSource; paused: boolean }> = [];
    if (muted !== undefined && muted !== entry.muted) changes.push({ source: "mic", paused: muted });
    if (videoOff !== undefined && videoOff !== entry.video_off) changes.push({ source: "camera", paused: videoOff });
    for (const { source, paused } of changes) {
      for (const track of this.room.tracksOf(entry.participant_id, source)) {
        if (track.paused === paused) continue;
        const producerId = this.bindings.producerOf(track.track_id);
        if (producerId) await this.deps.sfu.setProducerPaused({ producerId, paused });
      }
    }
  }

  // ---- host controls ----

  private async admit(actor: string, target: string): Promise<void> {
    this.requireHost(actor);
    if (!this.room.inLobby(target)) throw new RoomFailure({ code: "NOT_FOUND", message: "not in the lobby" });
    if (this.room.roster().length >= this.room.maxParticipants) {
      throw new RoomFailure({ code: "CAPACITY", message: "meeting is full" });
    }
    const media = await this.createTransports(target);
    const outcome = this.room.apply({ type: "admit", actor, participant_id: target });
    if (!outcome.ok) {
      await this.closeTransports(target);
      throw new RoomFailure(outcome.error);
    }
    this.afterApply(outcome.events);
    this.links.get(target)?.send({ type: "resync", payload: { ...this.room.welcomeFor(target), media } });
    this.audit(actor, "admit", target);
  }

  private deny(actor: string, target: string): void {
    this.requireHost(actor);
    this.applyOrThrow({ type: "deny", actor, participant_id: target });
    const link = this.links.get(target);
    if (link) {
      this.links.delete(target);
      link.close(CloseCode.LOBBY_DENIED, "denied by host");
    }
    this.audit(actor, "deny", target);
  }

  private async hostMute(actor: string, target: string): Promise<void> {
    this.requireHost(actor);
    const entry = this.requireJoined(target);
    await this.pauseProducers(entry, true, undefined);
    this.applyOrThrow({ type: "host_mute", actor, participant_id: target });
    this.audit(actor, "mute", target);
  }

  private async remove(actor: string, target: string): Promise<void> {
    this.requireHost(actor);
    const wasInRoster = this.room.inRoster(target);
    this.applyOrThrow({ type: "remove", actor, participant_id: target });
    this.cancelGrace(target);
    const link = this.links.get(target);
    if (link) {
      this.links.delete(target);
      link.close(wasInRoster ? CloseCode.REMOVED : CloseCode.LOBBY_DENIED, "removed by host");
    }
    if (wasInRoster) await this.closeTransports(target);
    this.audit(actor, "remove", target);
  }

  // ---- presence ----

  detach(link: ParticipantLink, pid: string): void {
    if (this.links.get(pid) !== link) return;
    this.links.delete(pid);
    if (this.gone || this.room.status === "ended") return;
    if (this.room.inLobby(pid)) {
      const outcome = this.room.apply({ type: "lobby_leave", participant_id: pid });
      if (outcome.ok) this.afterApply(outcome.events);
      return;
    }
    if (this.room.inRoster(pid)) {
      const outcome = this.room.apply({ type: "disconnect", participant_id: pid });
      if (outcome.ok) this.afterApply(outcome.events);
      this.startGrace(pid);
    }
  }

  private startGrace(pid: string): void {
    this.cancelGrace(pid);
    this.graceTimers.set(
      pid,
      setTimeout(() => {
        this.graceTimers.delete(pid);
        void this.expireGrace(pid);
      }, this.deps.timings.graceMs),
    );
  }

  private cancelGrace(pid: string): void {
    const timer = this.graceTimers.get(pid);
    if (!timer) return;
    clearTimeout(timer);
    this.graceTimers.delete(pid);
  }

  private expireGrace(pid: string): Promise<void> {
    return this.withLock(pid, async () => {
      if (this.gone || this.links.has(pid) || !this.room.inRoster(pid)) return;
      const outcome = this.room.apply({ type: "leave", participant_id: pid });
      if (outcome.ok) this.afterApply(outcome.events);
      await this.closeTransports(pid);
    });
  }

  private armIdle(): void {
    if (this.gone) return;
    if (this.room.isIdle()) {
      if (this.idleTimer) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        void this.endRoom("idle");
      }, this.deps.timings.idleMs);
    } else if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Serializes hello and grace expiry per participant so they never interleave. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const settled: Promise<unknown> = run.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  // ---- fanout and bus ----

  private afterApply(events: Emitted[]): void {
    this.fanout(events);
    this.deps.checkpoint.schedule();
    this.armIdle();
  }

  private fanout(events: Emitted[]): void {
    for (const { event, target } of events) {
      for (const pid of this.resolve(target)) this.links.get(pid)?.send(event);
      this.publishBusEvent(event);
    }
  }

  private resolve(target: Target): string[] {
    switch (target.kind) {
      case "all":
        return this.room.rosterIds();
      case "hosts":
        return this.room.rosterIds().filter((id) => this.room.isHost(id));
      case "everyone":
        return [...this.room.rosterIds(), ...this.room.lobbyIds()];
      case "only":
        return target.participant_ids;
      case "all_except":
        return this.room.rosterIds().filter((id) => id !== target.participant_id);
    }
  }

  private publishBusEvent(event: RoomEvent): void {
    const session_id = this.sessionId;
    switch (event.type) {
      case "participant.joined": {
        const p = event.payload.participant;
        this.deps.bus.publish("participant.joined", session_id, {
          session_id,
          participant_id: p.participant_id,
          user_id: null,
          display_name: p.name,
          role: p.role,
          joined_at: p.joined_at,
        });
        return;
      }
      case "participant.left":
        this.deps.bus.publish("participant.left", session_id, {
          session_id,
          participant_id: event.payload.participant_id,
          left_at: new Date().toISOString(),
          reason: event.payload.reason,
        });
        return;
      case "participant.updated":
        this.deps.bus.publish("participant.updated", session_id, {
          session_id,
          participant_id: event.payload.participant_id,
          patch: event.payload.patch,
        });
        return;
      default:
        return;
    }
  }

  private audit(actor: string, action: string, target?: string): void {
    const session_id = this.sessionId;
    this.deps.bus.publish(
      "host.action",
      session_id,
      target === undefined
        ? { session_id, actor_id: actor, action }
        : { session_id, actor_id: actor, action, target_id: target },
    );
  }

  // ---- SFU stats ----

  private async allocate(): Promise<void> {
    const res = await this.deps.sfu.allocateRoom({ sessionId: this.sessionId });
    this.rtpCapabilities = parseObject(res.rtpCapabilitiesJson, "rtp capabilities");
  }

  /** Both-way reconcile with the SFU's view (design doc "RoomRegistry" rehydrate). */
  private reconcile(snapshot: Snapshot): void {
    if (this.gone) return;
    this.bindings.replaceFromSnapshot(snapshot);
    const live = new Map<string, Snapshot["producers"][number]>();
    for (const p of snapshot.producers) {
      if (p.meta && p.meta.origin !== "pipe" && p.meta.trackId) live.set(p.meta.trackId, p);
    }
    for (const track of this.room.tracks()) {
      if (live.has(track.track_id)) continue;
      const outcome = this.room.apply({ type: "track_lost", track_id: track.track_id });
      if (outcome.ok) this.fanout(outcome.events);
    }
    for (const [trackId, p] of live) {
      if (this.room.track(trackId) || !p.meta) continue;
      if (!this.room.inRoster(p.meta.participantId)) {
        void this.deps.sfu.unpublish({ producerId: p.producerId }).catch((e: unknown) => this.warn("orphan unpublish failed", e));
        this.bindings.removeProducer(p.producerId);
        continue;
      }
      const track: TrackInfo = {
        track_id: trackId,
        owner: p.meta.participantId,
        kind: kindFromPb(p.meta.kind),
        source: sourceFromPb(p.meta.source),
        paused: p.paused,
        layers: p.layerCount,
      };
      const outcome = this.room.apply({ type: "publish", participant_id: p.meta.participantId, track });
      if (outcome.ok) this.fanout(outcome.events);
    }
    this.deps.checkpoint.schedule();
    this.armIdle();
  }

  private onStatsEvent(event: StatsEvent): void {
    if (this.gone) return;
    const now = Date.now();
    const e = event.event;
    switch (e.case) {
      case "dominantSpeakers":
        this.tracker.onSample(
          e.value.speakers.map((s) => ({ participant_id: s.participantId, volume: s.volume })),
          now,
        );
        return;
      case "silence":
        this.tracker.onSilence(now);
        return;
      case "consumerLayers": {
        const binding = this.bindings.consumerById(e.value.consumerId);
        if (!binding) return;
        const layers = e.value.active ? e.value.spatialLayer + 1 : 0;
        const outcome = this.room.apply({
          type: "track_layers",
          participant_id: binding.participant_id,
          track_id: binding.track_id,
          layers,
        });
        if (outcome.ok) this.fanout(outcome.events);
        return;
      }
      case "producerClosed": {
        this.bindings.removeProducer(e.value.producerId);
        const outcome = this.room.apply({ type: "track_lost", track_id: e.value.trackId });
        if (outcome.ok && outcome.events.length > 0) this.afterApply(outcome.events);
        return;
      }
      case "consumerClosed":
        this.bindings.removeConsumer(e.value.consumerId);
        return;
      case "transportClosed":
        this.bindings.removeTransport(e.value.transportId);
        return;
      case "iceState":
        this.deps.log.debug({ sessionId: this.sessionId, transportId: e.value.transportId, state: e.value.state }, "ice state");
        return;
      case "qos":
        this.deps.log.debug(
          {
            sessionId: this.sessionId,
            transportId: e.value.transportId,
            sendBitrate: e.value.sendBitrate,
            recvBitrate: e.value.recvBitrate,
            lossSent: e.value.rtpPacketLossSent,
          },
          "qos",
        );
        return;
      default:
        return;
    }
  }

  private onActiveSpeakers(ids: string[]): void {
    if (this.gone || this.room.status === "ended") return;
    const outcome = this.room.apply({ type: "active_speakers", participant_ids: ids });
    if (outcome.ok) this.fanout(outcome.events);
  }

  // ---- lifecycle ----

  private async heartbeatTick(): Promise<void> {
    if (this.gone) return;
    try {
      if (!(await this.deps.lease.refresh())) {
        this.deps.log.error({ sessionId: this.sessionId }, "owner lease lost, closing controller");
        await this.close(1012, "controller lost ownership");
        return;
      }
      await this.deps.checkpoint.refreshTtl();
    } catch (error) {
      this.warn("heartbeat failed", error);
    }
  }

  /** host.end, ctl end and idle all run this once: fanout, close links, CloseRoom, endSession. */
  endRoom(reason: EndReason): Promise<void> {
    if (!this.ending) this.ending = this.doEnd(reason);
    return this.ending;
  }

  private async doEnd(reason: EndReason): Promise<void> {
    if (this.gone) return;
    this.gone = true;
    this.stopTimers();
    const outcome = this.room.apply({ type: "end", reason });
    if (outcome.ok) this.fanout(outcome.events);
    for (const link of this.links.values()) link.close(CloseCode.ROOM_ENDED, reason);
    this.links.clear();
    this.stats.stop();
    const sessionId = this.sessionId;
    await this.deps.sfu.closeRoom({ sessionId }).catch((e: unknown) => this.warn("closeRoom failed", e));
    await this.deps.checkpoint.markEnded(reason).catch((e: unknown) => this.warn("markEnded failed", e));
    try {
      await endSession(this.deps.db, { sessionId, reason, peakParticipants: this.room.peak });
    } catch (error) {
      this.deps.log.error({ sessionId, error }, "endSession failed, the writer's session.ended handler is the backup");
    }
    this.deps.bus.publish("session.ended", sessionId, { session_id: sessionId, reason, peak_participants: this.room.peak });
    await this.deps.lease.release().catch((e: unknown) => this.warn("lease release failed", e));
    this.deps.onGone(sessionId);
  }

  /** Graceful stop without ending the room: flush the checkpoint, release the lease, drop sockets. */
  async close(code = 1012, reason = "controller restarting"): Promise<void> {
    if (this.ending) return this.ending;
    if (this.gone) return;
    this.gone = true;
    this.stopTimers();
    for (const link of this.links.values()) link.close(code, reason);
    this.links.clear();
    this.stats.stop();
    await this.deps.checkpoint.stop().catch((e: unknown) => this.warn("checkpoint stop failed", e));
    await this.deps.lease.release().catch((e: unknown) => this.warn("lease release failed", e));
    this.deps.onGone(this.sessionId);
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.speakerTimer) clearInterval(this.speakerTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.heartbeat = null;
    this.speakerTimer = null;
    this.idleTimer = null;
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  private warn(message: string, error: unknown): void {
    this.deps.log.warn({ sessionId: this.sessionId, error: describeSfuError(error) }, message);
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test -- controller`
Expected: PASS (13 tests). If the "ending" tests fail on `endSession`, confirm `seedSession` ran (the session row must exist).

- [ ] **Step 4: Full check and commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(signaling): add the room controller with media bindings, grace, idle and stats handling

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 7: Room registry (lease, rehydrate, ctl channel)

**Files:**
- Create: `services/signaling/src/room/registry.ts`, `services/signaling/src/room/registry.test.ts`
- Modify: `services/signaling/test/helpers.ts` (append `createTestRegistry`)

**Interfaces:**
- Consumes: `RoomController` (Task 6), `Checkpoint` / `OwnerLease` / `loadSnapshot` (Task 4), `SfuDirectory` (Task 5), `Room`, `isEndReason` from `@zoomclone/db`.
- Produces: `class RoomRegistry` (`constructor(deps: RegistryDeps)`, `get(sessionId, seed: RegistrySeed) -> Promise<RoomController>`, `peek(sessionId)`, `size`, `closeAll()`), `ControllerBusyError`, `RoomEndedError` (with `reason`), `ctlChannel(sessionId)`; `RegistrySeed = { sfu_hint; lobby_enabled; max_participants }`; `RegistryDeps = { redis; subscriber; sfus; db; bus; log; timings: RegistryTimings; roomOptions: RoomOptions; metrics?: RegistryMetrics }`; `RegistryTimings = ControllerTimings & { checkpointWindowMs; leaseMs }`; `RegistryMetrics = ControllerMetrics & { failover(): void; checkpointLag(ms: number): void }`.
- `get` coalesces concurrent callers per session; on the rehydrate path the controller's `start()` performs the SFU snapshot reconcile (Task 6); a room whose Redis meta says `ended` is refused with `RoomEndedError` (the gateway closes 4004); a lease held elsewhere raises `ControllerBusyError` (the gateway answers `error CONTROLLER_BUSY` and closes 1013).
- The ctl subscriber connection is a dedicated ioredis instance in subscriber mode; `{"cmd":"end","reason":<EndReason>}` on `room:<session_id>:ctl` ends the room with that reason (`api_end` when the reason is missing or unknown).

- [ ] **Step 1: Failing tests**

Append to `services/signaling/test/helpers.ts`:

```ts
import { RoomRegistry } from "../src/room/registry";
import { SfuDirectory } from "../src/sfu/directory";
import { DEFAULT_ROOM_OPTIONS } from "../src/room/room";

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
```

(Move the three imports to the top of the file with the others and add `import type { RegistryTimings } from "../src/room/registry";`.)

`services/signaling/src/room/registry.test.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloseCode } from "@zoomclone/protocol";
import { SfuService } from "@zoomclone/sfu-proto";
import { FakeSfu } from "../../test/fake-sfu";
import {
  FakeLink,
  createTestInfra,
  createTestRegistry,
  mintClaims,
  seedSession,
  waitFor,
  type TestInfra,
} from "../../test/helpers";
import { Checkpoint, roomKeys } from "./checkpoint";
import {
  ControllerBusyError,
  RoomEndedError,
  RoomRegistry,
  ctlChannel,
  type RegistryTimings,
} from "./registry";
import { Room } from "./room";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const SEED = { sfu_hint: "fake-sfu", lobby_enabled: true, max_participants: 10 };

let infra: TestInfra;
let sfu: FakeSfu;
let registries: RoomRegistry[] = [];

beforeAll(async () => {
  infra = await createTestInfra();
});
afterAll(async () => {
  await infra.close();
});
beforeEach(async () => {
  await infra.redis.flushdb();
  sfu = new FakeSfu();
  await sfu.start();
});
afterEach(async () => {
  for (const r of registries) await r.closeAll();
  registries = [];
  await sfu.stop();
});

function registry(overrides: Partial<RegistryTimings> = {}): RoomRegistry {
  const r = createTestRegistry(infra, sfu.baseUrl, overrides);
  registries.push(r);
  return r;
}

async function attach(controller: Awaited<ReturnType<RoomRegistry["get"]>>, participantId: string, role: "host" | "attendee" = "attendee", hello: { resume_seq?: number; epoch?: number } = {}) {
  const link = new FakeLink();
  const pid = await controller.attach(link, mintClaims({ session_id: controller.sessionId, participant_id: participantId, role }), { id: `h-${participantId.slice(0, 4)}`, ...hello });
  return { link, pid };
}

describe("RoomRegistry", () => {
  it("builds a fresh room once for concurrent callers, subscribes ctl, publishes room.created", async () => {
    const { sessionId } = await seedSession(infra.db);
    const created: unknown[] = [];
    infra.bus.subscribe("room.created", (e) => {
      created.push(e.payload);
    });
    const r = registry();
    const [c1, c2] = await Promise.all([r.get(sessionId, SEED), r.get(sessionId, SEED)]);
    expect(c1).toBe(c2);
    expect(r.size).toBe(1);
    expect(r.peek(sessionId)).toBe(c1);
    expect(sfu.callsTo("allocateRoom")).toHaveLength(1);
    expect(c1.room.epoch).toBe(1);
    expect(await infra.redis.hget(roomKeys(sessionId).meta, "status")).toBe("live");
    expect(await infra.redis.exists(roomKeys(sessionId).owner)).toBe(1);
    await infra.bus.drain();
    expect(created).toEqual([{ session_id: sessionId, home_sfu: "fake-sfu", epoch: 1 }]);
  });

  it("refuses a room another controller owns until that owner lets go, then rehydrates it", async () => {
    const { sessionId } = await seedSession(infra.db);
    const first = registry();
    const controller = await first.get(sessionId, SEED);
    await attach(controller, HOST, "host");
    const second = registry();
    await expect(second.get(sessionId, SEED)).rejects.toBeInstanceOf(ControllerBusyError);
    await first.closeAll();
    expect(first.size).toBe(0);
    expect(await infra.redis.hget(roomKeys(sessionId).meta, "status")).toBe("live");
    const again = await second.get(sessionId, SEED);
    expect(again.room.epoch).toBe(2);
    expect(again.room.rosterEntry(HOST)).toMatchObject({ connected: false });
    expect(sfu.callsTo("allocateRoom")).toHaveLength(2);
  });

  it("refuses a session whose room already ended", async () => {
    const { sessionId } = await seedSession(infra.db);
    const room = Room.create({ session_id: sessionId, home_sfu: "fake-sfu", lobby_enabled: true, max_participants: 10 });
    const checkpoint = new Checkpoint(infra.redis, room, { windowMs: 20 });
    await checkpoint.writeAll();
    await checkpoint.markEnded("host_end");
    const r = registry();
    await expect(r.get(sessionId, SEED)).rejects.toBeInstanceOf(RoomEndedError);
    expect(r.size).toBe(0);
    expect(await infra.redis.exists(roomKeys(sessionId).owner)).toBe(0);
  });

  it("ends the room on a ctl end command and drops it from the registry", async () => {
    const { sessionId } = await seedSession(infra.db);
    const r = registry();
    const controller = await r.get(sessionId, SEED);
    const { link } = await attach(controller, A);
    await infra.redis.publish(ctlChannel(sessionId), JSON.stringify({ cmd: "end", reason: "api_end" }));
    await waitFor(() => r.size === 0);
    expect(link.ofType("room.ended")[0]?.payload).toEqual({ reason: "api_end" });
    expect(link.closedWith?.code).toBe(CloseCode.ROOM_ENDED);
    expect(await infra.redis.hgetall(roomKeys(sessionId).meta)).toMatchObject({ status: "ended", end_reason: "api_end" });
    const [meeting] = await infra.db<{ status: string }[]>`SELECT status FROM meetings`;
    expect(meeting?.status).toBe("ended");
  });

  it("rehydrates from Redis plus the SFU snapshot: both-way reconcile, transports reused, and new ones when the SFU lost the room", async () => {
    const { sessionId } = await seedSession(infra.db);
    const first = registry();
    const c1 = await first.get(sessionId, SEED);
    const { link: host } = await attach(c1, HOST, "host");
    const { link: ann } = await attach(c1, A);
    await c1.handle(ann, A, { type: "publish", id: "p", payload: { kind: "audio", source: "mic", rtp_parameters: {}, paused: false } });
    expect(ann.ofType("ack").some((m) => m.id === "p")).toBe(true);
    const annSeq = c1.room.seq;
    await sleep(60);
    await first.closeAll();
    expect(host.closedWith?.code).toBe(1012);

    // While no controller runs: the SFU lost A's producer and gained one for the host.
    sfu.room(sessionId)?.producers.delete("p1");
    sfu.seedRoom(sessionId, { producers: [{ participantId: HOST, trackId: "host-cam", kind: "video", source: "camera" }] });

    // A long grace so neither rehydrated member times out while the test drives reconnects.
    const second = registry({ graceMs: 5000 });
    const c2 = await second.get(sessionId, SEED);
    expect(c2.room.epoch).toBe(2);
    expect(c2.room.tracks().map((t) => t.track_id)).toEqual(["host-cam"]);
    expect(c2.room.track("host-cam")).toMatchObject({ owner: HOST, kind: "video", layers: 3 });

    const { link: annBack } = await attach(c2, A, "attendee", { resume_seq: annSeq, epoch: 1 });
    expect(annBack.sent[0]).toMatchObject({ type: "ack", payload: { mode: "resync", epoch: 2 } });
    const resync = annBack.ofType("resync")[0]?.payload;
    expect(resync?.media?.send_transport.id).toBe("t3");
    expect(resync?.media?.recv_transport.id).toBe("t4");
    expect(resync?.tracks?.map((t) => t.track_id)).toEqual(["host-cam"]);
    expect(sfu.callsTo("createTransport")).toHaveLength(4);
    expect(c2.room.rosterEntry(A)?.connected).toBe(true);

    // The SFU restarts: the room vanishes, the stats stream ends, the controller reopens and reconciles.
    const client = createClient(SfuService, createGrpcTransport({ baseUrl: sfu.baseUrl }));
    await client.closeRoom({ sessionId });
    const removed = await annBack.waitFor("track.removed");
    expect(removed.payload).toEqual({ track_id: "host-cam" });
    expect(c2.room.tracks()).toEqual([]);
    const { link: hostBack } = await attach(c2, HOST, "host");
    expect(hostBack.ofType("resync")[0]?.payload.media?.send_transport.id).toBe("t5");
    expect(sfu.callsTo("createTransport")).toHaveLength(6);
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- registry`
Expected: FAIL (`./registry` not found).

- [ ] **Step 2: Implement the registry**

`services/signaling/src/room/registry.ts`:

```ts
import type Redis from "ioredis";
import type { Logger } from "pino";
import { isEndReason, type Db, type EndReason } from "@zoomclone/db";
import type { EventBus } from "@zoomclone/events";
import type { SfuDirectory } from "../sfu/directory";
import { Checkpoint, OwnerLease, loadSnapshot } from "./checkpoint";
import { RoomController, type ControllerMetrics, type ControllerTimings } from "./controller";
import { Room, type RoomOptions } from "./room";

export class ControllerBusyError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} is owned by another controller`);
    this.name = "ControllerBusyError";
  }
}

export class RoomEndedError extends Error {
  constructor(
    sessionId: string,
    readonly reason: string | null,
  ) {
    super(`session ${sessionId} has ended`);
    this.name = "RoomEndedError";
  }
}

export type RegistrySeed = { sfu_hint: string; lobby_enabled: boolean; max_participants: number };
export type RegistryTimings = ControllerTimings & { checkpointWindowMs: number; leaseMs: number };
export type RegistryMetrics = ControllerMetrics & { failover(): void; checkpointLag(ms: number): void };
export type RegistryDeps = {
  redis: Redis;
  /** Dedicated connection in subscriber mode for the ctl channels. */
  subscriber: Redis;
  sfus: SfuDirectory;
  db: Db;
  bus: EventBus;
  log: Logger;
  timings: RegistryTimings;
  roomOptions: RoomOptions;
  metrics?: RegistryMetrics;
};

/** Control plane to controller channel (meeting-api's room-control.ts publishes here). */
export function ctlChannel(sessionId: string): string {
  return `room:${sessionId}:ctl`;
}
const CTL_CHANNEL = /^room:([0-9a-f-]{36}):ctl$/;

/**
 * One controller per live session in this process (design doc "room/RoomRegistry.ts"):
 * in-memory, else owner lease + Redis checkpoint rehydrate (the controller's start() reconciles
 * against the SFU snapshot), else a fresh room seeded from the hello claims.
 */
export class RoomRegistry {
  private readonly controllers = new Map<string, RoomController>();
  private readonly pending = new Map<string, Promise<RoomController>>();
  private closing = false;

  constructor(private readonly deps: RegistryDeps) {
    deps.subscriber.on("message", (channel: string, message: string) => this.onCtl(channel, message));
  }

  get size(): number {
    return this.controllers.size;
  }

  peek(sessionId: string): RoomController | undefined {
    return this.controllers.get(sessionId);
  }

  get(sessionId: string, seed: RegistrySeed): Promise<RoomController> {
    const existing = this.controllers.get(sessionId);
    if (existing) return Promise.resolve(existing);
    const inflight = this.pending.get(sessionId);
    if (inflight) return inflight;
    if (this.closing) return Promise.reject(new Error("registry is closing"));
    const promise = this.build(sessionId, seed).finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, promise);
    return promise;
  }

  /** Graceful shutdown: controllers flush and release without ending their rooms. */
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.controllers.values()].map((c) => c.close()));
  }

  private async build(sessionId: string, seed: RegistrySeed): Promise<RoomController> {
    const { redis, timings, log, metrics } = this.deps;
    const lease = new OwnerLease(redis, sessionId, timings.leaseMs);
    if (!(await lease.acquire())) throw new ControllerBusyError(sessionId);
    let controller: RoomController | null = null;
    try {
      const loaded = await loadSnapshot(redis, sessionId);
      if (loaded.kind === "ended") throw new RoomEndedError(sessionId, loaded.reason);
      const rehydrated = loaded.kind === "live";
      const room = rehydrated
        ? Room.fromSnapshot(loaded.snapshot, { bumpEpoch: true }, this.deps.roomOptions)
        : Room.create(
            {
              session_id: sessionId,
              home_sfu: seed.sfu_hint,
              lobby_enabled: seed.lobby_enabled,
              max_participants: seed.max_participants,
            },
            this.deps.roomOptions,
          );
      const checkpoint = new Checkpoint(redis, room, {
        windowMs: timings.checkpointWindowMs,
        onLag: (ms) => metrics?.checkpointLag(ms),
        onError: (error) => log.error({ sessionId, error }, "checkpoint write failed"),
      });
      controller = new RoomController({
        room,
        sfu: this.deps.sfus.get(room.homeSfu),
        checkpoint,
        lease,
        db: this.deps.db,
        bus: this.deps.bus,
        log,
        timings,
        metrics,
        onGone: (id) => this.drop(id),
      });
      await controller.start();
      await this.deps.subscriber.subscribe(ctlChannel(sessionId));
      this.controllers.set(sessionId, controller);
      if (rehydrated) {
        metrics?.failover();
        log.info({ sessionId, epoch: room.epoch, roster: room.roster().length }, "room rehydrated");
      } else {
        this.deps.bus.publish("room.created", sessionId, { session_id: sessionId, home_sfu: room.homeSfu, epoch: room.epoch });
        log.info({ sessionId, homeSfu: room.homeSfu }, "room created");
      }
      return controller;
    } catch (error) {
      if (controller) await controller.close(1011, "start failed").catch(() => undefined);
      else await lease.release().catch(() => undefined);
      throw error;
    }
  }

  private drop(sessionId: string): void {
    this.controllers.delete(sessionId);
    void this.deps.subscriber
      .unsubscribe(ctlChannel(sessionId))
      .catch((error: unknown) => this.deps.log.warn({ sessionId, error }, "ctl unsubscribe failed"));
  }

  private onCtl(channel: string, message: string): void {
    const match = CTL_CHANNEL.exec(channel);
    if (!match) return;
    const controller = this.controllers.get(match[1]!);
    if (!controller) return;
    let command: { cmd?: unknown; reason?: unknown };
    try {
      command = JSON.parse(message) as { cmd?: unknown; reason?: unknown };
    } catch {
      this.deps.log.warn({ channel, message }, "malformed ctl message");
      return;
    }
    if (command.cmd !== "end") return;
    const reason: EndReason = isEndReason(command.reason) ? command.reason : "api_end";
    void controller.endRoom(reason);
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test -- registry`
Expected: PASS (5 tests).

- [ ] **Step 3: Full check and commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(signaling): add the room registry with owner lease, rehydrate and ctl channel

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 8: Postgres writer

**Files:**
- Create: `services/signaling/src/writer/postgres-writer.ts`, `services/signaling/src/writer/postgres-writer.test.ts`

**Interfaces:**
- Consumes: `EventBus`, `EventEnvelope` (`@zoomclone/events`), `endSession`, `isEndReason` (`@zoomclone/db`).
- Produces: `class PostgresWriter` (`constructor(db, bus, log, opts?: WriterOptions)`, `start()`, `flush() -> Promise<void>`, `stop() -> Promise<void>`, `pending: number`); `WriterOptions = { flushMs?: number (100); maxAttempts?: number (5); retryMs?: number (500) }`.
- Semantics: `participant.joined` upserts the `participants` row (idempotent), `participant.left` sets `left_at` / `leave_reason` once, `session.ended` calls `endSession` (idempotent backup for the controller's synchronous call). Items are written in order, never awaited on the message path; a failing item is retried `maxAttempts` times `retryMs` apart, then dropped with an error log so one poison event cannot block attendance forever.

- [ ] **Step 1: Failing tests**

`services/signaling/src/writer/postgres-writer.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "@zoomclone/db/testing";
import { createTestInfra, seedSession, silentLog, type TestInfra } from "../../test/helpers";
import { PostgresWriter } from "./postgres-writer";

let infra: TestInfra;
beforeAll(async () => {
  infra = await createTestInfra();
});
afterAll(async () => {
  await infra.close();
});
beforeEach(async () => {
  await truncateAll(infra.db);
});

function joined(sessionId: string, participantId: string) {
  return {
    session_id: sessionId,
    participant_id: participantId,
    user_id: null,
    display_name: "Ann",
    role: "attendee" as const,
    joined_at: "2026-09-10T10:00:00.000Z",
  };
}

describe("PostgresWriter", () => {
  it("upserts joined and left rows and tolerates duplicate deliveries", async () => {
    const { sessionId } = await seedSession(infra.db);
    const writer = new PostgresWriter(infra.db, infra.bus, silentLog, { flushMs: 10 });
    writer.start();
    const pid = randomUUID();
    infra.bus.publish("participant.joined", sessionId, joined(sessionId, pid));
    infra.bus.publish("participant.joined", sessionId, { ...joined(sessionId, pid), display_name: "Ann R" });
    infra.bus.publish("participant.left", sessionId, { session_id: sessionId, participant_id: pid, left_at: "2026-09-10T10:05:00.000Z", reason: "timeout" });
    infra.bus.publish("participant.left", sessionId, { session_id: sessionId, participant_id: pid, left_at: "2026-09-10T10:09:00.000Z", reason: "removed" });
    await infra.bus.drain();
    await writer.flush();
    const rows = await infra.db<{ id: string; displayName: string; leftAt: Date | null; leaveReason: string | null }[]>`
      SELECT id, display_name, left_at, leave_reason FROM participants`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pid, displayName: "Ann R", leaveReason: "timeout" });
    expect(rows[0]?.leftAt?.toISOString()).toBe("2026-09-10T10:05:00.000Z");
    await writer.stop();
  });

  it("ends the session as a backup path, idempotently", async () => {
    const { sessionId } = await seedSession(infra.db);
    const writer = new PostgresWriter(infra.db, infra.bus, silentLog, { flushMs: 10 });
    writer.start();
    infra.bus.publish("session.ended", sessionId, { session_id: sessionId, reason: "host_end", peak_participants: 4 });
    infra.bus.publish("session.ended", sessionId, { session_id: sessionId, reason: "idle", peak_participants: 9 });
    await infra.bus.drain();
    await writer.flush();
    const [session] = await infra.db<{ endedAt: Date | null; peakParticipants: number | null }[]>`
      SELECT ended_at, peak_participants FROM meeting_sessions WHERE id = ${sessionId}`;
    expect(session?.endedAt).not.toBeNull();
    expect(session?.peakParticipants).toBe(4);
    const [meeting] = await infra.db<{ status: string }[]>`SELECT status FROM meetings`;
    expect(meeting?.status).toBe("ended");
    await writer.stop();
  });

  it("retries a failing item a bounded number of times, then drops it and keeps going", async () => {
    const { sessionId } = await seedSession(infra.db);
    const writer = new PostgresWriter(infra.db, infra.bus, silentLog, { flushMs: 10, maxAttempts: 2, retryMs: 10 });
    writer.start();
    const poison = joined(randomUUID(), randomUUID()); // unknown session: foreign key violation
    const good = joined(sessionId, randomUUID());
    infra.bus.publish("participant.joined", poison.session_id, poison);
    infra.bus.publish("participant.joined", sessionId, good);
    await infra.bus.drain();
    await writer.flush();
    expect(writer.pending).toBe(0);
    const rows = await infra.db<{ id: string }[]>`SELECT id FROM participants`;
    expect(rows.map((r) => r.id)).toEqual([good.participant_id]);
    await writer.stop();
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- postgres-writer`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement**

`services/signaling/src/writer/postgres-writer.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import { endSession, isEndReason, type Db } from "@zoomclone/db";
import type { EventBus, EventEnvelope } from "@zoomclone/events";

export type WriterOptions = { flushMs?: number; maxAttempts?: number; retryMs?: number };

type Item =
  | EventEnvelope<"participant.joined">
  | EventEnvelope<"participant.left">
  | EventEnvelope<"session.ended">;

/**
 * Bus consumer for attendance rows (design doc "writer/PostgresWriter.ts"). Every write is
 * idempotent (at-least-once delivery), ordered per process, and never awaited on the message
 * path. A poison item is retried a bounded number of times and then dropped with an error log.
 */
export class PostgresWriter {
  private readonly queue: Item[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private readonly flushMs: number;
  private readonly maxAttempts: number;
  private readonly retryMs: number;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly log: Logger,
    opts: WriterOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 100;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.retryMs = opts.retryMs ?? 500;
  }

  get pending(): number {
    return this.queue.length;
  }

  start(): void {
    this.unsubscribers.push(
      this.bus.subscribe("participant.joined", (e) => this.enqueue(e)),
      this.bus.subscribe("participant.left", (e) => this.enqueue(e)),
      this.bus.subscribe("session.ended", (e) => this.enqueue(e)),
    );
  }

  /** Drains the queue (retries included); resolves once every queued item is written or dropped. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  private enqueue(item: Item): void {
    if (this.stopped) return;
    this.queue.push(item);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue[0]!;
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          await this.write(item);
          break;
        } catch (error) {
          if (attempt >= this.maxAttempts) {
            this.log.error({ error, type: item.type, key: item.key, attempt }, "attendance write dropped");
            break;
          }
          this.log.warn({ error, type: item.type, key: item.key, attempt }, "attendance write failed, retrying");
          await sleep(this.retryMs);
        }
      }
      this.queue.shift();
    }
  }

  private async write(item: Item): Promise<void> {
    switch (item.type) {
      case "participant.joined": {
        const p = item.payload;
        await this.db`
          INSERT INTO participants (id, session_id, user_id, display_name, role, joined_at)
          VALUES (${p.participant_id}, ${p.session_id}, ${p.user_id}, ${p.display_name}, ${p.role}, ${p.joined_at})
          ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role`;
        return;
      }
      case "participant.left": {
        const p = item.payload;
        await this.db`
          UPDATE participants SET left_at = ${p.left_at}, leave_reason = ${p.reason}
          WHERE id = ${p.participant_id} AND left_at IS NULL`;
        return;
      }
      case "session.ended": {
        const p = item.payload;
        await endSession(this.db, {
          sessionId: p.session_id,
          reason: isEndReason(p.reason) ? p.reason : "idle",
          peakParticipants: p.peak_participants,
        });
        return;
      }
    }
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test -- postgres-writer`
Expected: PASS (3 tests).

- [ ] **Step 3: Full check and commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(signaling): add the Postgres attendance writer

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 9: WebSocket gateway, http app, metrics, entrypoint

**Files:**
- Create: `services/signaling/src/gateway/auth.ts`, `services/signaling/src/gateway/rate-limit.ts`, `services/signaling/src/gateway/server.ts`, `services/signaling/src/metrics.ts`, `services/signaling/src/app.ts`, `services/signaling/src/main.ts`, `services/signaling/src/gateway/gateway.test.ts`
- Modify: `services/signaling/test/helpers.ts` (append `mintToken`, `TestClient`, `startTestSignaling`)

**Interfaces:**
- Consumes: `RoomRegistry` (Task 7), `RoomController.attach / handle / detach` (Task 6), `verifySignalingToken` + `jwks` (`@zoomclone/tokens`), `ClientMessageSchema`, `CloseCode`, `REACTION_RATE_PER_SECOND` (`@zoomclone/protocol`), `ws`.
- Produces:
  - `auth.ts`: `interface TokenVerifier { verify(token): Promise<SignalingClaims> }`, `remoteTokenVerifier(jwksUrl, issuer)`, `localTokenVerifier(keys: SigningKeys, issuer)`.
  - `rate-limit.ts`: `class TokenBucket` (`constructor(ratePerSecond, burst = ratePerSecond, now?)`, `take(now?) -> boolean`).
  - `server.ts`: `attachGateway(server: http.Server, deps: GatewayDeps) -> WebSocketServer`, `class WsLink implements ParticipantLink`; `GatewayDeps = { registry; verifier; env: Pick<Env, "HELLO_TIMEOUT_MS" | "PING_TIMEOUT_MS" | "MAX_BUFFERED_BYTES">; log; metrics?: { connections: { inc(): void; dec(): void } } }`.
  - `metrics.ts`: `createMetrics(roomCount: () => number) -> Metrics` with `registry`, `connections` (Gauge `ws_connections`), `rooms` (Gauge `room_count`, collected from `roomCount`), `checkpointLag` (Histogram `checkpoint_lag_ms`), `resyncTotal`, `replayTotal`, `failoverTotal` (Counters), and `forRegistry() -> RegistryMetrics`.
  - `app.ts`: `createApp(deps: AppDeps) -> { server: http.Server; wss: WebSocketServer }` serving `/healthz` (`{ ok: true, rooms }`), `/metrics`, 404 otherwise, ws upgrades on `/rooms/:session_id`; `AppDeps = { registry; verifier; env; log; metrics }`. (Plan 4 adds the `/dev/` harness here.)
  - Socket protocol as the design doc: `hello` within `HELLO_TIMEOUT_MS` or close 4006; token via the verifier (4001 on failure or session mismatch); `ping` answered with `pong` at any time, silence beyond `PING_TIMEOUT_MS` closes 4000; every frame zod-validated (invalid before hello: close 4006; after: `error INVALID`); per-connection reaction bucket (`REACTION_RATE_PER_SECOND`, `error RATE_LIMITED`); `bufferedAmount > MAX_BUFFERED_BYTES` closes 1008; `ControllerBusyError` answers `error CONTROLLER_BUSY` + close 1013; `RoomEndedError` closes 4004.

- [ ] **Step 1: Auth, rate limit, metrics**

`services/signaling/src/gateway/auth.ts`:

```ts
import { createLocalJWKSet, createRemoteJWKSet } from "jose";
import type { SignalingClaims } from "@zoomclone/protocol";
import { jwks, verifySignalingToken, type SigningKeys } from "@zoomclone/tokens";

export interface TokenVerifier {
  verify(token: string): Promise<SignalingClaims>;
}

/** Production: keys from meeting-api's /.well-known/jwks.json (cached and refetched on unknown kid by jose). */
export function remoteTokenVerifier(jwksUrl: string, issuer: string): TokenVerifier {
  const keys = createRemoteJWKSet(new URL(jwksUrl));
  return { verify: (token) => verifySignalingToken(token, keys, issuer) };
}

/** Tests: verify against an in-process key pair. */
export function localTokenVerifier(keys: SigningKeys, issuer: string): TokenVerifier {
  const set = createLocalJWKSet(jwks(keys));
  return { verify: (token) => verifySignalingToken(token, set, issuer) };
}
```

`services/signaling/src/gateway/rate-limit.ts`:

```ts
/** Token bucket: `ratePerSecond` refills, `burst` capacity. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = ratePerSecond,
    now: number = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
```

`services/signaling/src/metrics.ts`:

```ts
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
  const connections = new Gauge({ name: "ws_connections", help: "Open signaling sockets", registers: [registry] });
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
  const resyncTotal = new Counter({ name: "resync_total", help: "Reconnects answered with a full resync", registers: [registry] });
  const replayTotal = new Counter({ name: "replay_total", help: "Reconnects answered with a replay", registers: [registry] });
  const failoverTotal = new Counter({ name: "failover_total", help: "Rooms rehydrated from Redis", registers: [registry] });
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
```

- [ ] **Step 2: Test helpers (token minting, socket client, test server)**

Append to `services/signaling/test/helpers.ts`:

```ts
import { signSignalingToken } from "@zoomclone/tokens";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { ClientMessage, RoomEvent } from "@zoomclone/protocol";
import { createApp } from "../src/app";
import { localTokenVerifier } from "../src/gateway/auth";
import { createMetrics } from "../src/metrics";

export const TEST_ISSUER = "meeting-api";

export function mintToken(infra: TestInfra, claims: SignalingClaims): Promise<string> {
  return signSignalingToken(infra.keys, TEST_ISSUER, claims);
}

type Reply = Extract<ServerMessage, { type: "ack" | "error" }>;

/** Minimal signaling client over a real socket; every received frame must satisfy ServerMessageSchema. */
export class TestClient {
  readonly received: ServerMessage[] = [];
  closeEvent: { code: number; reason: string } | null = null;
  private counter = 0;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.received.push(ServerMessageSchema.parse(JSON.parse(data.toString())));
    });
    ws.on("close", (code, reason) => {
      this.closeEvent = { code, reason: reason.toString() };
    });
    ws.on("error", () => undefined);
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new TestClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade failed: ${res.statusCode}`)));
    });
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Sends a request and resolves with its ack or error frame. */
  async request<T extends ClientMessage["type"]>(
    type: T,
    payload: Extract<ClientMessage, { type: T }>["payload"],
    timeoutMs = 2000,
  ): Promise<Reply> {
    const id = `${type}-${++this.counter}`;
    this.send({ type, id, payload } as ClientMessage);
    const reply = await waitFor(
      () => this.received.find((m): m is Reply => (m.type === "ack" || m.type === "error") && m.id === id),
      timeoutMs,
    );
    if (!reply) throw new Error(`no reply to ${type} (${id}); closed=${JSON.stringify(this.closeEvent)}`);
    return reply;
  }

  ofType<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  events(): RoomEvent[] {
    return this.received.filter((m): m is RoomEvent => "seq" in m);
  }

  async waitFor<T extends ServerMessage["type"]>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const found = await waitFor(() => this.ofType(type).find(predicate), timeoutMs);
    if (!found) throw new Error(`no ${type} within ${timeoutMs} ms; got ${this.received.map((m) => m.type).join(",")}`);
    return found;
  }

  async waitForClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    const closed = await waitFor(() => this.closeEvent, timeoutMs);
    if (!closed) throw new Error("socket still open");
    return closed;
  }

  close(): void {
    this.ws.close(1000);
  }

  /** Drops the TCP connection without a close frame (a crashed client or lost network). */
  terminate(): void {
    this.ws.terminate();
  }
}

export type TestSignaling = {
  url: string;
  httpUrl: string;
  registry: RoomRegistry;
  close: () => Promise<void>;
};

export async function startTestSignaling(
  infra: TestInfra,
  sfuBaseUrl: string,
  opts: { timings?: Partial<RegistryTimings>; env?: Partial<Env> } = {},
): Promise<TestSignaling> {
  const registry = createTestRegistry(infra, sfuBaseUrl, opts.timings ?? {});
  const metrics = createMetrics(() => registry.size);
  const { server, wss } = createApp({
    registry,
    verifier: localTokenVerifier(infra.keys, TEST_ISSUER),
    env: { ...infra.env, ...opts.env },
    log: silentLog,
    metrics,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    registry,
    close: async () => {
      await registry.closeAll();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

(Hoist the imports to the top of the file.)

- [ ] **Step 3: Failing gateway tests**

`services/signaling/src/gateway/gateway.test.ts`:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloseCode, type SignalingClaims } from "@zoomclone/protocol";
import { FakeSfu } from "../../test/fake-sfu";
import {
  TestClient,
  createTestInfra,
  createTestRegistry,
  mintClaims,
  mintToken,
  seedSession,
  startTestSignaling,
  waitFor,
  type TestInfra,
  type TestSignaling,
} from "../../test/helpers";
import { ctlChannel } from "../room/registry";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

let infra: TestInfra;
let sfu: FakeSfu;
let signaling: TestSignaling;
let sessionId: string;
const clients: TestClient[] = [];

beforeAll(async () => {
  infra = await createTestInfra();
});
afterAll(async () => {
  await infra.close();
});
beforeEach(async () => {
  await infra.redis.flushdb();
  sfu = new FakeSfu();
  await sfu.start();
  signaling = await startTestSignaling(infra, sfu.baseUrl);
  ({ sessionId } = await seedSession(infra.db));
});
afterEach(async () => {
  for (const c of clients) c.terminate();
  clients.length = 0;
  await signaling.close();
  await sfu.stop();
});

async function connect(session = sessionId): Promise<TestClient> {
  const client = await TestClient.connect(`${signaling.url}/rooms/${session}`);
  clients.push(client);
  return client;
}

async function joined(overrides: Partial<SignalingClaims> & { participant_id: string }) {
  const client = await connect();
  const token = await mintToken(infra, mintClaims({ session_id: sessionId, ...overrides }));
  const reply = await client.request("hello", { token });
  expect(reply.type).toBe("ack");
  await client.waitFor("welcome");
  return client;
}

describe("gateway: handshake", () => {
  it("closes 4006 without a hello in time, or when the first frame is not a hello", async () => {
    const silent = await connect();
    const closed = await silent.waitForClose();
    expect(closed.code).toBe(CloseCode.PROTOCOL_ERROR);
    const eager = await connect();
    eager.send({ type: "raise_hand", id: "1", payload: {} });
    expect((await eager.waitForClose()).code).toBe(CloseCode.PROTOCOL_ERROR);
    const garbage = await connect();
    garbage.sendRaw("{not json");
    expect((await garbage.waitForClose()).code).toBe(CloseCode.PROTOCOL_ERROR);
  });

  it("refuses bad tokens and tokens for another session with 4001, unknown paths with 404", async () => {
    const bad = await connect();
    const reply = await bad.request("hello", { token: "nope" });
    expect(reply).toMatchObject({ type: "error", payload: { code: "UNAUTHORIZED" } });
    expect((await bad.waitForClose()).code).toBe(CloseCode.AUTH_FAILED);
    const other = await connect();
    const token = await mintToken(infra, mintClaims({ session_id: "99999999-9999-4999-8999-999999999999", participant_id: A }));
    await other.request("hello", { token });
    expect((await other.waitForClose()).code).toBe(CloseCode.AUTH_FAILED);
    await expect(TestClient.connect(`${signaling.url}/nope`)).rejects.toThrow(/upgrade failed: 404/);
  });

  it("answers CONTROLLER_BUSY and closes 1013 while another controller owns the room", async () => {
    const other = createTestRegistry(infra, sfu.baseUrl);
    await other.get(sessionId, { sfu_hint: "fake-sfu", lobby_enabled: true, max_participants: 10 });
    const client = await connect();
    const token = await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: A }));
    const reply = await client.request("hello", { token });
    expect(reply).toMatchObject({ type: "error", payload: { code: "CONTROLLER_BUSY" } });
    expect((await client.waitForClose()).code).toBe(1013);
    await other.closeAll();
  });
});

describe("gateway: sessions", () => {
  it("runs the join flow end to end and fans room events between sockets", async () => {
    const host = await joined({ participant_id: HOST, role: "host" });
    expect(host.ofType("ack")[0]?.payload).toEqual({ mode: "welcome", epoch: 1, seq: 1 });
    expect(host.ofType("welcome")[0]?.payload.media?.send_transport.id).toBe("t1");
    const ann = await joined({ participant_id: A });
    await host.waitFor("participant.joined", (m) => m.payload.participant.participant_id === A);

    const pong = await (async () => {
      ann.send({ type: "ping", id: "p", payload: { ts: 42 } });
      return ann.waitFor("pong");
    })();
    expect(pong.payload).toEqual({ ts: 42 });

    expect(await ann.request("connect_transport", { transport: "send", dtls_parameters: { role: "client" } })).toMatchObject({ type: "ack" });
    const publish = await ann.request("publish", { kind: "video", source: "camera", rtp_parameters: { codecs: [] }, paused: false });
    expect(publish).toMatchObject({ type: "ack", payload: { track_id: "trk1" } });
    await host.waitFor("track.added", (m) => m.payload.track.track_id === "trk1");
    const subscribe = await host.request("subscribe", { rtp_capabilities: { codecs: [] }, track_ids: ["trk1"], prefs: {} });
    expect(subscribe).toMatchObject({ type: "ack", payload: { consumers: [{ track_id: "trk1", consumer_id: "c1" }] } });
    expect(await host.request("consumer_ready", { track_id: "trk1" })).toMatchObject({ type: "ack" });

    expect(await ann.request("chat", { body: "hello" })).toMatchObject({ type: "ack" });
    await host.waitFor("chat", (m) => m.payload.body === "hello");
    const invalid = await ann.request("chat", { body: "" } as never);
    expect(invalid).toMatchObject({ type: "error", payload: { code: "INVALID" } });
    expect(await ann.request("host.lock", { locked: true })).toMatchObject({ type: "error", payload: { code: "FORBIDDEN" } });
    expect(await host.request("host.lock", { locked: true })).toMatchObject({ type: "ack" });
    await ann.waitFor("room.updated", (m) => m.payload.locked === true);

    const health = await fetch(`${signaling.httpUrl}/healthz`);
    expect(await health.json()).toEqual({ ok: true, rooms: 1 });
    const metrics = await fetch(`${signaling.httpUrl}/metrics`);
    const body = await metrics.text();
    expect(body).toMatch(/ws_connections 2/);
    expect(body).toMatch(/room_count 1/);
    expect((await fetch(`${signaling.httpUrl}/nope`)).status).toBe(404);
  });

  it("limits reactions per connection and closes silent sockets with 4000", async () => {
    // A second server with a short ping timeout; the shared one keeps the default so other tests
    // are not cut off mid-flow.
    const quick = await startTestSignaling(infra, sfu.baseUrl, { env: { PING_TIMEOUT_MS: 400 } });
    try {
      const ann = await TestClient.connect(`${quick.url}/rooms/${sessionId}`);
      clients.push(ann);
      const token = await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: A }));
      expect((await ann.request("hello", { token })).type).toBe("ack");
      const replies = [];
      for (let i = 0; i < 4; i++) replies.push(await ann.request("reaction", { emoji: "clap" }));
      expect(replies.map((r) => r.type)).toEqual(["ack", "ack", "error", "error"]);
      expect(replies[2]).toMatchObject({ payload: { code: "RATE_LIMITED" } });
      const closed = await ann.waitForClose(1500);
      expect(closed.code).toBe(CloseCode.PING_TIMEOUT);
    } finally {
      await quick.close();
    }
  });

  it("replaces an older socket with 4005, replays after a dropped connection, and closes 4004 on a ctl end", async () => {
    const host = await joined({ participant_id: HOST, role: "host" });
    const ann = await joined({ participant_id: A });
    const annSeq = ann.ofType("welcome")[0]!.payload.seq;
    const token = await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: A }));

    const second = await connect();
    await second.request("hello", { token, resume_seq: annSeq, epoch: 1 });
    expect((await ann.waitForClose()).code).toBe(CloseCode.REPLACED);
    expect(second.ofType("ack")[0]?.payload).toMatchObject({ mode: "replay" });
    expect(host.ofType("participant.updated")).toEqual([]);

    second.terminate();
    await host.waitFor("participant.updated", (m) => m.payload.patch.connected === false);
    await host.request("reaction", { emoji: "wave" });
    const third = await connect();
    const seqBefore = second.events().at(-1)?.seq ?? annSeq;
    await third.request("hello", { token, resume_seq: seqBefore, epoch: 1 });
    expect(third.ofType("ack")[0]?.payload).toMatchObject({ mode: "replay" });
    await third.waitFor("reaction", (m) => m.payload.emoji === "wave");
    await host.waitFor("participant.updated", (m) => m.payload.patch.connected === true);

    await infra.redis.publish(ctlChannel(sessionId), JSON.stringify({ cmd: "end", reason: "api_end" }));
    expect((await host.waitForClose()).code).toBe(CloseCode.ROOM_ENDED);
    expect((await third.waitForClose()).code).toBe(CloseCode.ROOM_ENDED);
    expect(host.ofType("room.ended")[0]?.payload).toEqual({ reason: "api_end" });
    await waitFor(() => signaling.registry.size === 0);
    await sleep(20);
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- gateway`
Expected: FAIL (`../src/app` not found).

- [ ] **Step 4: Implement the gateway, app and main**

`services/signaling/src/gateway/server.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ClientMessageSchema,
  CloseCode,
  REACTION_RATE_PER_SECOND,
  type ClientMessage,
  type ServerMessage,
  type SignalingClaims,
} from "@zoomclone/protocol";
import type { Env } from "../env";
import type { HelloPayload, RoomController } from "../room/controller";
import { ControllerBusyError, RoomEndedError, type RoomRegistry } from "../room/registry";
import type { TokenVerifier } from "./auth";
import type { ParticipantLink } from "./link";
import { TokenBucket } from "./rate-limit";

export type GatewayDeps = {
  registry: RoomRegistry;
  verifier: TokenVerifier;
  env: Pick<Env, "HELLO_TIMEOUT_MS" | "PING_TIMEOUT_MS" | "MAX_BUFFERED_BYTES">;
  log: Logger;
  metrics?: { connections: { inc(): void; dec(): void } };
};

const ROOM_PATH = /^\/rooms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_FRAME_BYTES = 64 * 1024;

/** The controller-facing wrapper around one socket. */
export class WsLink implements ParticipantLink {
  readonly id = randomUUID();

  constructor(
    private readonly socket: WebSocket,
    private readonly maxBuffered: number,
    private readonly log: Logger,
  ) {}

  send(message: ServerMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > this.maxBuffered) {
      this.log.warn({ link: this.id, buffered: this.socket.bufferedAmount }, "slow consumer, closing");
      this.socket.close(1008, "slow consumer");
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  close(code: number, reason?: string): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }
}

/** Upgrades /rooms/:session_id and runs one Connection per socket. */
export function attachGateway(server: Server, deps: GatewayDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const match = ROOM_PATH.exec(pathname);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = match[1]!;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      new Connection(ws, sessionId, deps);
    });
  });
  return wss;
}

class Connection {
  private readonly link: WsLink;
  private readonly reactions = new TokenBucket(REACTION_RATE_PER_SECOND);
  private readonly pingWatchdog: NodeJS.Timeout;
  private helloTimer: NodeJS.Timeout | null;
  private controller: RoomController | null = null;
  private participantId: string | null = null;
  private attaching = false;
  private closed = false;
  private lastPingAt = Date.now();

  constructor(
    private readonly ws: WebSocket,
    private readonly sessionId: string,
    private readonly deps: GatewayDeps,
  ) {
    deps.metrics?.connections.inc();
    this.link = new WsLink(ws, deps.env.MAX_BUFFERED_BYTES, deps.log);
    this.helloTimer = setTimeout(
      () => this.link.close(CloseCode.PROTOCOL_ERROR, "hello timeout"),
      deps.env.HELLO_TIMEOUT_MS,
    );
    // Three missed pings (design doc): checked a few times per timeout window.
    this.pingWatchdog = setInterval(
      () => {
        if (Date.now() - this.lastPingAt > deps.env.PING_TIMEOUT_MS) {
          this.link.close(CloseCode.PING_TIMEOUT, "ping timeout");
        }
      },
      Math.max(50, Math.floor(deps.env.PING_TIMEOUT_MS / 3)),
    );
    ws.on("message", (data) => void this.onMessage(data));
    ws.on("close", () => this.onClose());
    ws.on("error", (error) => deps.log.debug({ link: this.link.id, error }, "socket error"));
  }

  private async onMessage(data: RawData): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      this.link.close(CloseCode.PROTOCOL_ERROR, "invalid json");
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      if (this.participantId === null) {
        this.link.close(CloseCode.PROTOCOL_ERROR, "expected hello");
        return;
      }
      const id = typeof json === "object" && json !== null && typeof (json as { id?: unknown }).id === "string"
        ? (json as { id: string }).id
        : undefined;
      const issue = parsed.error.issues[0];
      this.link.send({
        type: "error",
        ...(id === undefined ? {} : { id }),
        payload: { code: "INVALID", message: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid message" },
      });
      return;
    }
    const message = parsed.data;
    try {
      if (message.type === "ping") {
        this.lastPingAt = Date.now();
        this.link.send({ type: "pong", payload: { ts: message.payload.ts } });
        return;
      }
      if (message.type === "hello") {
        await this.onHello(message);
        return;
      }
      if (this.participantId === null || this.controller === null) {
        this.link.close(CloseCode.PROTOCOL_ERROR, "hello first");
        return;
      }
      if (message.type === "reaction" && !this.reactions.take()) {
        this.link.send({ type: "error", id: message.id, payload: { code: "RATE_LIMITED", message: "too many reactions" } });
        return;
      }
      await this.controller.handle(this.link, this.participantId, message);
    } catch (error) {
      this.deps.log.error({ link: this.link.id, type: message.type, error }, "unhandled gateway error");
      this.link.send({ type: "error", id: message.id, payload: { code: "INTERNAL", message: "internal error" } });
    }
  }

  private async onHello(message: Extract<ClientMessage, { type: "hello" }>): Promise<void> {
    if (this.participantId !== null || this.attaching) {
      this.link.close(CloseCode.PROTOCOL_ERROR, "duplicate hello");
      return;
    }
    this.attaching = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    let claims: SignalingClaims;
    try {
      claims = await this.deps.verifier.verify(message.payload.token);
    } catch {
      this.link.send({ type: "error", id: message.id, payload: { code: "UNAUTHORIZED", message: "invalid token" } });
      this.link.close(CloseCode.AUTH_FAILED, "auth failed");
      return;
    }
    if (claims.session_id !== this.sessionId) {
      this.link.send({ type: "error", id: message.id, payload: { code: "UNAUTHORIZED", message: "token is for another session" } });
      this.link.close(CloseCode.AUTH_FAILED, "auth failed");
      return;
    }
    let controller: RoomController;
    try {
      controller = await this.deps.registry.get(claims.session_id, {
        sfu_hint: claims.sfu_hint,
        lobby_enabled: claims.lobby_enabled,
        max_participants: claims.max_participants,
      });
    } catch (error) {
      if (error instanceof ControllerBusyError) {
        this.link.send({ type: "error", id: message.id, payload: { code: "CONTROLLER_BUSY", message: "room is owned elsewhere, retry" } });
        this.link.close(1013, "try again later");
      } else if (error instanceof RoomEndedError) {
        this.link.close(CloseCode.ROOM_ENDED, "room ended");
      } else {
        this.deps.log.error({ sessionId: this.sessionId, error }, "room lookup failed");
        this.link.send({ type: "error", id: message.id, payload: { code: "INTERNAL", message: "internal error" } });
        this.link.close(1011, "room lookup failed");
      }
      return;
    }
    const hello: HelloPayload = { id: message.id };
    if (message.payload.resume_seq !== undefined) hello.resume_seq = message.payload.resume_seq;
    if (message.payload.epoch !== undefined) hello.epoch = message.payload.epoch;
    const participantId = await controller.attach(this.link, claims, hello);
    this.attaching = false;
    if (participantId === null) return;
    this.controller = controller;
    this.participantId = participantId;
    // The socket may have closed while attach was in flight; give the controller its detach now.
    if (this.closed) controller.detach(this.link, participantId);
  }

  private onClose(): void {
    this.closed = true;
    this.deps.metrics?.connections.dec();
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    clearInterval(this.pingWatchdog);
    if (this.controller && this.participantId !== null) this.controller.detach(this.link, this.participantId);
  }
}
```

`services/signaling/src/app.ts`:

```ts
import * as http from "node:http";
import type { Logger } from "pino";
import type { WebSocketServer } from "ws";
import type { Env } from "./env";
import { attachGateway } from "./gateway/server";
import type { TokenVerifier } from "./gateway/auth";
import type { Metrics } from "./metrics";
import type { RoomRegistry } from "./room/registry";

export type AppDeps = {
  registry: RoomRegistry;
  verifier: TokenVerifier;
  env: Env;
  log: Logger;
  metrics: Metrics;
};

/** Plain http for /healthz and /metrics; WebSocket upgrades on /rooms/:session_id. */
export function createApp(deps: AppDeps): { server: http.Server; wss: WebSocketServer } {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: deps.registry.size }));
      return;
    }
    if (pathname === "/metrics") {
      void deps.metrics.registry.metrics().then(
        (body) => {
          res.writeHead(200, { "content-type": deps.metrics.registry.contentType });
          res.end(body);
        },
        (error: unknown) => {
          res.writeHead(500);
          res.end(String(error));
        },
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
  });
  const wss = attachGateway(server, {
    registry: deps.registry,
    verifier: deps.verifier,
    env: deps.env,
    log: deps.log,
    metrics: { connections: deps.metrics.connections },
  });
  return { server, wss };
}
```

`services/signaling/src/main.ts`:

```ts
import Redis from "ioredis";
import pino from "pino";
import { createDb } from "@zoomclone/db";
import { InMemoryEventBus } from "@zoomclone/events";
import { createApp } from "./app";
import { loadEnv } from "./env";
import { remoteTokenVerifier } from "./gateway/auth";
import { createMetrics } from "./metrics";
import { RoomRegistry } from "./room/registry";
import { SfuDirectory } from "./sfu/directory";
import { PostgresWriter } from "./writer/postgres-writer";

const env = loadEnv();
const log = pino(
  env.NODE_ENV === "development"
    ? { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } }
    : { level: env.LOG_LEVEL },
);
const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL);
const subscriber = new Redis(env.REDIS_URL);
const bus = new InMemoryEventBus((error, event) => log.error({ error, type: event.type }, "event handler failed"));
const metrics = createMetrics(() => registry.size);
const registry = new RoomRegistry({
  redis,
  subscriber,
  sfus: new SfuDirectory(env.SFU_ENDPOINTS),
  db,
  bus,
  log,
  timings: {
    graceMs: env.DISCONNECT_GRACE_MS,
    idleMs: env.ROOM_IDLE_TIMEOUT_MS,
    heartbeatMs: env.HEARTBEAT_MS,
    speakerTickMs: 300,
    statsRetryMs: 1000,
    checkpointWindowMs: env.CHECKPOINT_WINDOW_MS,
    leaseMs: env.OWNER_LEASE_MS,
  },
  roomOptions: { ringSize: env.RING_BUFFER_SIZE, ringMs: env.RING_BUFFER_MS, departedTtlMs: env.DEPARTED_TTL_MS },
  metrics: metrics.forRegistry(),
});
const writer = new PostgresWriter(db, bus, log);
writer.start();
const { server, wss } = createApp({
  registry,
  verifier: remoteTokenVerifier(env.MEETING_API_JWKS_URL, env.TOKEN_ISSUER),
  env,
  log,
  metrics,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  setTimeout(() => process.exit(1), 10_000).unref();
  try {
    // Controllers flush their checkpoints and release their leases; rooms stay live in Redis so
    // the next process rehydrates them. Sockets close 1012 and clients reconnect.
    await registry.closeAll();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writer.stop();
    await subscriber.quit();
    await redis.quit();
    await db.end();
    process.exit(0);
  } catch (error) {
    log.error(error, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(env.SIGNALING_PORT, "0.0.0.0", () => {
  log.info({ port: env.SIGNALING_PORT, sfus: Object.keys(env.SFU_ENDPOINTS), jwks: env.MEETING_API_JWKS_URL }, "signaling listening");
});
```

Run: `pnpm --filter @zoomclone/signaling test -- gateway`
Expected: PASS (6 tests). Then `pnpm --filter @zoomclone/signaling test` (every signaling test file green).

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(signaling): add the WebSocket gateway, http app, metrics and entrypoint

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 10: Real-SFU integration test, env example, README

**Files:**
- Create: `services/signaling/src/sfu-integration.test.ts`
- Modify: `.env.example`, `README.md`

**Interfaces:**
- Consumes: `startTestSfu`, `audioRtpParameters`, `CLIENT_DTLS_PARAMETERS` from `@zoomclone/sfu/testing` (Task 0), `startTestSignaling` + `TestClient` (Task 9).
- Produces: proof that the transport, producer and consumer parameters flowing through the gateway are valid mediasoup shapes end to end (design doc Phase 5: "one integration test against the real sfu service").

- [ ] **Step 1: Integration test**

`services/signaling/src/sfu-integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_DTLS_PARAMETERS, audioRtpParameters, startTestSfu, type TestSfu } from "@zoomclone/sfu/testing";
import { TestClient, createTestInfra, mintClaims, mintToken, seedSession, startTestSignaling, type TestInfra, type TestSignaling } from "../test/helpers";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

let infra: TestInfra;
let sfu: TestSfu;
let signaling: TestSignaling;

beforeAll(async () => {
  infra = await createTestInfra();
  sfu = await startTestSfu();
  signaling = await startTestSignaling(infra, sfu.baseUrl);
});
afterAll(async () => {
  await signaling.close();
  await sfu.stop();
  await infra.close();
});

describe("signaling against the real SFU", () => {
  it("hands out real transport parameters, publishes and subscribes with mediasoup shapes, and closes the SFU room on end", async () => {
    const { sessionId } = await seedSession(infra.db);
    const host = await TestClient.connect(`${signaling.url}/rooms/${sessionId}`);
    const ann = await TestClient.connect(`${signaling.url}/rooms/${sessionId}`);
    await host.request("hello", { token: await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: HOST, role: "host" })) });
    const welcome = await host.waitFor("welcome");
    const media = welcome.payload.media;
    if (!media) throw new Error("expected media");
    expect(media.rtp_capabilities["codecs"]).toBeInstanceOf(Array);
    expect(media.send_transport.ice_parameters["usernameFragment"]).toBeTypeOf("string");
    expect(media.send_transport.ice_candidates.length).toBeGreaterThan(0);
    expect(media.send_transport.dtls_parameters["fingerprints"]).toBeInstanceOf(Array);
    expect(media.recv_transport.id).not.toBe(media.send_transport.id);

    await ann.request("hello", { token: await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: A })) });
    const annWelcome = await ann.waitFor("welcome");

    expect(await host.request("connect_transport", { transport: "send", dtls_parameters: CLIENT_DTLS_PARAMETERS as unknown as Record<string, unknown> })).toMatchObject({ type: "ack" });
    const publish = await host.request("publish", {
      kind: "audio",
      source: "mic",
      rtp_parameters: audioRtpParameters() as unknown as Record<string, unknown>,
      paused: false,
    });
    expect(publish.type).toBe("ack");
    const trackId = (publish.payload as { track_id: string }).track_id;
    await ann.waitFor("track.added", (m) => m.payload.track.track_id === trackId);

    const subscribe = await ann.request("subscribe", {
      rtp_capabilities: annWelcome.payload.media!.rtp_capabilities,
      track_ids: [trackId],
      prefs: {},
    });
    expect(subscribe.type).toBe("ack");
    const consumers = (subscribe.payload as { consumers: Array<{ consumer_id: string; kind: string; rtp_parameters: Record<string, unknown> }> }).consumers;
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.kind).toBe("audio");
    expect(consumers[0]?.rtp_parameters["codecs"]).toBeInstanceOf(Array);
    expect(await ann.request("consumer_ready", { track_id: trackId })).toMatchObject({ type: "ack" });
    expect(sfu.manager.size).toBe(1);

    await host.request("host.end", {});
    expect((await ann.waitForClose()).code).toBe(4004);
    expect((await host.waitForClose()).code).toBe(4004);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sfu.manager.size).toBe(0);
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- sfu-integration`
Expected: PASS (1 test, real mediasoup worker spawned by `startTestSfu`).

- [ ] **Step 2: Env example and README**

Append to `.env.example`:

```
# signaling
SIGNALING_PORT=8081
MEETING_API_JWKS_URL=http://localhost:8080/.well-known/jwks.json
SFU_ENDPOINTS=sfu-local-1=http://localhost:9090
DISCONNECT_GRACE_MS=30000
ROOM_IDLE_TIMEOUT_MS=300000
DEV_HARNESS=false
```

(`DATABASE_URL`, `REDIS_URL` and `TOKEN_ISSUER` are already present in the meeting-api block and are shared.)

Append to `README.md`:

````markdown
## Signaling (ws :8081)

The signaling gateway and room controller run in one process (`services/signaling`). Clients
connect to `ws://localhost:8081/rooms/{session_id}` with the token from `POST /v1/join` and
speak the protocol in `packages/protocol/src/ws` (every request is answered by `ack` or `error`;
`hello` is answered by `ack {mode}` followed by `welcome`, `resync` or replayed events).

```sh
pnpm --filter @zoomclone/signaling start   # or: pnpm dev (all services)
curl -s localhost:8081/healthz              # {"ok":true,"rooms":0}
```

Room state is checkpointed to Redis (`{room:<session_id>}:*`) within 50 ms of every change and an
owner lease keeps one controller per room. Kill and restart the process: clients reconnect, the
room rehydrates from Redis plus the SFU snapshot with a new `epoch`, and they receive a `resync`.
Attendance rows and session end are written to Postgres by the bus consumer in `src/writer`.
Verify the JWT issuer: `TOKEN_ISSUER` must match meeting-api's value (default `meeting-api`).
````

- [ ] **Step 3: Full check and commit**

Run: `pnpm check`
Expected: every workspace green (signaling now includes the real-SFU integration test).

```sh
git add .env.example README.md services/signaling
git commit -F - <<'EOF'
test(signaling): prove the join flow against the real SFU and document the service

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

## Self-review notes (writer's pass)

- Spec coverage (Phases 4 and 5 of the design doc): Room state machine with every listed scenario (Task 2); checkpoint keys per spec 4.2 plus `departed` and `owner` (Task 4); registry lease, rehydrate with both-way reconcile and the SFU-room-missing path, `Stats` drop and re-snapshot (Tasks 5, 7); gRPC failure mid-join leaves no roster state, `:end` via the ctl channel, ping timeout, grace and replace semantics, replay vs resync (Tasks 6, 9); tracker hysteresis and silence (Task 3); writer duplicate tolerance and `endSession` on host end and idle (Tasks 6, 8); one test against the real SFU (Task 10). `restart_ice` stays `NOT_IMPLEMENTED` on the socket side even though the SFU implements `RestartIce` (design doc: names reserved).
- Type consistency: `ControllerTimings` (Task 6) is extended by `RegistryTimings` (Task 7) and built by `createTestRegistry` / `main.ts` (Tasks 7, 9); `RegistryMetrics` (Task 7) is produced by `createMetrics().forRegistry()` (Task 9); `HelloPayload`, `ControllerMessage` (Task 6) are what the gateway passes (Task 9); `ParticipantLink` (Task 6) is implemented by `WsLink` (Task 9) and `FakeLink` (helpers).
- Deliberately out of scope here and owned by Plan 4: the `/dev/` harness bundle, Playwright scenarios, transport rebuild on the client when `resync.media` ids change.
