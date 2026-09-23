# Plan 2: SFU Service (mediasoup behind the spec gRPC contract) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `services/sfu`: mediasoup workers behind the design doc's gRPC `Sfu` contract (spec section 5.3 plus the MVP additions), with a `Stats` server stream the room controller (Plan 3) consumes, all verified against real mediasoup workers.

**Architecture:** One Node process hosts N mediasoup `Worker`s, each with one `WebRtcServer` (one UDP + TCP port per worker). `RoomManager` maps `session_id` to a `Room` (router + `AudioLevelObserver` + entity maps) and exposes plain async methods that throw `SfuError` with a gRPC code. `sfuRoutes` adapts those methods to the generated Connect service (`@zoomclone/sfu-proto`, protoc-gen-es v2) and maps errors to `ConnectError`. Rooms emit typed events into per-subscriber queues; the `Stats` RPC yields a snapshot first, then events, until the room closes or the client cancels. mediasoup parameter blobs cross the wire as JSON strings; ids, enums and flags are typed protobuf fields.

**Tech Stack:** mediasoup 3.26.0, @connectrpc/connect 2.2.0, @connectrpc/connect-node 2.2.0, @bufbuild/protobuf 2.14.1, @bufbuild/buf 1.72.0, @bufbuild/protoc-gen-es 2.14.1, prom-client 15.1.3, pino 10.3.1, zod 4.6.2, vitest 4.1.11, TypeScript 5.9.3, tsx 4.23.13.

**Spec:** `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md` (sections "gRPC Sfu", "Components > services/sfu", "Core flows"); this plan covers Phase 3. Plan 1 (`docs/superpowers/plans/2026-09-10-plan-1-foundation-control-plane.md`) established the workspace conventions reused here.

## Global Constraints

- Everything in Plan 1's Global Constraints still applies: Node `>=24`, pnpm 9.15.9, ESM, TypeScript strict with `moduleResolution: bundler`, extensionless relative imports, workspace packages export TypeScript source, no build step, tests against real infrastructure (here: real mediasoup workers, no mocks), `pnpm check` green before every commit, Conventional Commits with the two trailer lines (`Co-Authored-By: <model> <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY`), no em dashes in prose, branch `feat/mvp-vertical-slice`.
- Pinned versions for this plan: mediasoup 3.26.0, @connectrpc/connect 2.2.0, @connectrpc/connect-node 2.2.0, @bufbuild/protobuf 2.14.1, @bufbuild/buf 1.72.0, @bufbuild/protoc-gen-es 2.14.1, prom-client 15.1.3, pino 10.3.1, pino-pretty 13.1.3.
- Ports: gRPC `9090` (`SFU_GRPC_PORT`), media `40000 + worker index` UDP and TCP (`SFU_MEDIA_PORT_BASE`), announced address `127.0.0.1` locally (`SFU_ANNOUNCED_IP`). Tests use a random media port base in 42000-42999 so parallel invocations do not collide.
- Generated code lives in `packages/sfu-proto/src/gen/` and is committed; it is prettier-ignored (already listed in `.prettierignore`) but typechecked. Regenerate with `pnpm proto:gen` whenever `proto/sfu/v1/sfu.proto` changes; never hand-edit generated files.
- mediasoup JSON blobs (`rtpCapabilities`, `iceParameters`, `iceCandidates`, `dtlsParameters`, `rtpParameters`) are passed through untouched between the wire and mediasoup; the SFU validates only that they parse as JSON objects, mediasoup validates the rest.
- Error code mapping (design doc): unknown id `NOT_FOUND`; entity belongs to another room or participant `PERMISSION_DENIED`; wrong transport direction, transport not connected, incompatible capabilities, already connected `FAILED_PRECONDITION`; malformed JSON or mediasoup `TypeError` `INVALID_ARGUMENT`; `Cascade` `UNIMPLEMENTED`; anything else `INTERNAL` with the mediasoup message.
- Windows: mediasoup installs a prebuilt `mediasoup-worker` binary from npm. Task 1 verifies it before any other SFU code is written; if the download fails, set `MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true` only as a last resort (needs MSVC + Python) and report it.

## File structure (what this plan creates)

```
buf.yaml  buf.gen.yaml                       codegen config (repo root)
proto/sfu/v1/sfu.proto                       the contract
packages/sfu-proto/                          generated TS + barrel
  package.json tsconfig.json src/index.ts src/gen/sfu/v1/sfu_pb.ts (generated)
services/sfu/
  package.json tsconfig.json vitest.config.ts
  src/env.ts          zod env
  src/codecs.ts       router media codecs
  src/errors.ts       SfuError + code mapping helpers
  src/workers.ts      worker + WebRtcServer pool
  src/rooms.ts        Room + RoomManager (all mediasoup calls live here)
  src/events.ts       RoomEvent types + EventQueue (per-subscriber async queue)
  src/service.ts      Connect routes for SfuService (proto <-> RoomManager adapter)
  src/metrics.ts      prom-client registry and gauges
  src/app.ts          http2 server: /healthz, /metrics, Connect handler
  src/main.ts         entrypoint
  test/helpers.ts     startTestSfu(), fixtures for rtp parameters
  src/*.test.ts       tests next to the code
```

---

### Task 0: Proto contract and generated package

**Files:**
- Create: `buf.yaml`, `buf.gen.yaml`, `proto/sfu/v1/sfu.proto`, `packages/sfu-proto/package.json`, `packages/sfu-proto/tsconfig.json`, `packages/sfu-proto/src/index.ts`
- Modify: root `package.json` (devDependencies + `proto:gen` script)
- Generated: `packages/sfu-proto/src/gen/sfu/v1/sfu_pb.ts`
- Test: `packages/sfu-proto/src/proto.test.ts`

**Interfaces:**
- Produces `@zoomclone/sfu-proto` exporting the generated `SfuService`, every message schema (`AllocateRoomRequestSchema`, ..., `StatsEventSchema`) and type (`AllocateRoomRequest`, ..., `StatsEvent`), and the enums `MediaKind`, `MediaSource`, `TransportDirection` (TS enum members `AUDIO`, `VIDEO`; `MIC`, `CAMERA`, `SCREEN`, `SCREEN_AUDIO`; `SEND`, `RECV`; each with an `UNSPECIFIED = 0`).
- Field naming: proto `snake_case` becomes TS `camelCase` (`rtp_capabilities_json` -> `rtpCapabilitiesJson`). `optional` scalars become `field?: number`. The `StatsEvent.event` oneof is `{ case: "snapshot", value: Snapshot } | { case: "dominantSpeakers", value: DominantSpeakers } | ...` with `case` in camelCase.

- [ ] **Step 1: buf configuration and codegen script**

`buf.yaml`:

```yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD
breaking:
  use:
    - FILE
```

`buf.gen.yaml`:

```yaml
version: v2
clean: true
plugins:
  - local: protoc-gen-es
    out: packages/sfu-proto/src/gen
    opt:
      - target=ts
      - import_extension=none
inputs:
  - directory: proto
```

Root `package.json`: add to `devDependencies` `"@bufbuild/buf": "1.72.0"` and `"@bufbuild/protoc-gen-es": "2.14.1"`, and to `scripts` `"proto:gen": "buf generate"` and `"proto:lint": "buf lint"`.

- [ ] **Step 2: The contract**

`proto/sfu/v1/sfu.proto`:

```proto
syntax = "proto3";

package sfu.v1;

// Room Controller <-> SFU contract (design doc "gRPC Sfu": spec 5.3 plus MVP additions).
// mediasoup parameter blobs travel as JSON strings; ids, enums and flags are typed.
service Sfu {
  rpc AllocateRoom(AllocateRoomRequest) returns (AllocateRoomResponse);
  rpc CloseRoom(CloseRoomRequest) returns (CloseRoomResponse);
  rpc CreateTransport(CreateTransportRequest) returns (CreateTransportResponse);
  rpc ConnectTransport(ConnectTransportRequest) returns (ConnectTransportResponse);
  rpc CloseTransport(CloseTransportRequest) returns (CloseTransportResponse);
  rpc RestartIce(RestartIceRequest) returns (RestartIceResponse);
  rpc Publish(PublishRequest) returns (PublishResponse);
  rpc Unpublish(UnpublishRequest) returns (UnpublishResponse);
  rpc SetProducerPaused(SetProducerPausedRequest) returns (SetProducerPausedResponse);
  rpc Subscribe(SubscribeRequest) returns (SubscribeResponse);
  rpc SetConsumerPaused(SetConsumerPausedRequest) returns (SetConsumerPausedResponse);
  rpc Unsubscribe(UnsubscribeRequest) returns (UnsubscribeResponse);
  rpc SetLayer(SetLayerRequest) returns (SetLayerResponse);
  rpc Cascade(CascadeRequest) returns (CascadeResponse);
  rpc Stats(StatsRequest) returns (stream StatsEvent);
}

enum MediaKind {
  MEDIA_KIND_UNSPECIFIED = 0;
  MEDIA_KIND_AUDIO = 1;
  MEDIA_KIND_VIDEO = 2;
}

enum MediaSource {
  MEDIA_SOURCE_UNSPECIFIED = 0;
  MEDIA_SOURCE_MIC = 1;
  MEDIA_SOURCE_CAMERA = 2;
  MEDIA_SOURCE_SCREEN = 3;
  MEDIA_SOURCE_SCREEN_AUDIO = 4;
}

enum TransportDirection {
  TRANSPORT_DIRECTION_UNSPECIFIED = 0;
  TRANSPORT_DIRECTION_SEND = 1;
  TRANSPORT_DIRECTION_RECV = 2;
}

message AllocateRoomRequest {
  string session_id = 1;
}

message AllocateRoomResponse {
  string rtp_capabilities_json = 1;
  string sfu_id = 2;
}

message CloseRoomRequest {
  string session_id = 1;
}

message CloseRoomResponse {}

message CreateTransportRequest {
  string session_id = 1;
  string participant_id = 2;
  TransportDirection direction = 3;
}

message CreateTransportResponse {
  string transport_id = 1;
  string ice_parameters_json = 2;
  string ice_candidates_json = 3;
  string dtls_parameters_json = 4;
}

message ConnectTransportRequest {
  string transport_id = 1;
  string dtls_parameters_json = 2;
}

message ConnectTransportResponse {}

message CloseTransportRequest {
  string transport_id = 1;
}

message CloseTransportResponse {}

message RestartIceRequest {
  string transport_id = 1;
}

message RestartIceResponse {
  string ice_parameters_json = 1;
}

message PublishRequest {
  string session_id = 1;
  string participant_id = 2;
  string transport_id = 3;
  MediaKind kind = 4;
  MediaSource source = 5;
  string rtp_parameters_json = 6;
  bool paused = 7;
}

message PublishResponse {
  string producer_id = 1;
  string track_id = 2;
  uint32 layer_count = 3;
}

message UnpublishRequest {
  string producer_id = 1;
}

message UnpublishResponse {}

message SetProducerPausedRequest {
  string producer_id = 1;
  bool paused = 2;
}

message SetProducerPausedResponse {}

message SubscribeRequest {
  string session_id = 1;
  string participant_id = 2;
  string transport_id = 3;
  string producer_id = 4;
  string rtp_capabilities_json = 5;
  optional uint32 max_spatial_layer = 6;
  optional uint32 priority = 7;
}

message SubscribeResponse {
  string consumer_id = 1;
  MediaKind kind = 2;
  string rtp_parameters_json = 3;
  bool producer_paused = 4;
}

message SetConsumerPausedRequest {
  string consumer_id = 1;
  bool paused = 2;
}

message SetConsumerPausedResponse {}

message UnsubscribeRequest {
  string consumer_id = 1;
}

message UnsubscribeResponse {}

message SetLayerRequest {
  string consumer_id = 1;
  uint32 spatial_layer = 2;
  optional uint32 temporal_layer = 3;
  optional uint32 priority = 4;
}

message SetLayerResponse {}

message CascadeRequest {
  string session_id = 1;
  string remote_sfu_addr = 2;
}

message CascadeResponse {
  string pipe_transport_id = 1;
}

message StatsRequest {
  string session_id = 1;
}

// appData carried by every mediasoup entity, so a restarted controller can rebuild its bindings.
message EntityMeta {
  string sfu_id = 1;
  string session_id = 2;
  string participant_id = 3;
  string track_id = 4;
  MediaKind kind = 5;
  MediaSource source = 6;
  string origin = 7; // "local" | "pipe"
}

message TransportSnapshot {
  string transport_id = 1;
  string participant_id = 2;
  TransportDirection direction = 3;
  string ice_state = 4;
  string dtls_state = 5;
}

message ProducerSnapshot {
  string producer_id = 1;
  EntityMeta meta = 2;
  bool paused = 3;
  uint32 layer_count = 4;
  string transport_id = 5;
}

message ConsumerSnapshot {
  string consumer_id = 1;
  string producer_id = 2;
  string participant_id = 3;
  string transport_id = 4;
  bool paused = 5;
  bool producer_paused = 6;
  optional uint32 preferred_spatial_layer = 7;
  optional uint32 preferred_temporal_layer = 8;
  optional uint32 current_spatial_layer = 9;
  optional uint32 current_temporal_layer = 10;
  uint32 priority = 11;
}

message Snapshot {
  repeated TransportSnapshot transports = 1;
  repeated ProducerSnapshot producers = 2;
  repeated ConsumerSnapshot consumers = 3;
}

message SpeakerVolume {
  string participant_id = 1;
  string producer_id = 2;
  int32 volume = 3; // dBov, -127..0
}

message DominantSpeakers {
  repeated SpeakerVolume speakers = 1; // loudest first
}

message Silence {}

message ConsumerLayers {
  string consumer_id = 1;
  bool active = 2; // false when no layer is being sent
  uint32 spatial_layer = 3;
  uint32 temporal_layer = 4;
}

message ProducerScore {
  string producer_id = 1;
  uint32 score = 2; // lowest score across simulcast layers, 0..10
}

message ProducerClosed {
  string producer_id = 1;
  string track_id = 2;
  string participant_id = 3;
}

message ConsumerClosed {
  string consumer_id = 1;
  string reason = 2; // "producerclose" | "transportclose" | "unsubscribed"
}

message IceState {
  string transport_id = 1;
  string participant_id = 2;
  string state = 3;
}

message TransportClosed {
  string transport_id = 1;
  string participant_id = 2;
  string reason = 3; // "dtls_closed" | "dtls_failed" | "closed"
}

message Qos {
  string transport_id = 1;
  string participant_id = 2;
  uint64 bytes_sent = 3;
  uint64 bytes_received = 4;
  double send_bitrate = 5;
  double recv_bitrate = 6;
  double available_outgoing_bitrate = 7;
  double rtp_packet_loss_sent = 8;
  double rtp_packet_loss_received = 9;
}

message StatsEvent {
  oneof event {
    Snapshot snapshot = 1;
    DominantSpeakers dominant_speakers = 2;
    Silence silence = 3;
    ConsumerLayers consumer_layers = 4;
    ProducerScore producer_score = 5;
    ProducerClosed producer_closed = 6;
    ConsumerClosed consumer_closed = 7;
    IceState ice_state = 8;
    TransportClosed transport_closed = 9;
    Qos qos = 10;
  }
}
```

- [ ] **Step 3: Package files**

`packages/sfu-proto/package.json`:

```json
{
  "name": "@zoomclone/sfu-proto",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@bufbuild/protobuf": "2.14.1"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/sfu-proto/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

`packages/sfu-proto/src/index.ts`:

```ts
export * from "./gen/sfu/v1/sfu_pb";
```

- [ ] **Step 4: Install and generate**

Run from the repo root:

```sh
pnpm install
pnpm proto:lint
pnpm proto:gen
ls packages/sfu-proto/src/gen/sfu/v1/
grep -c "export const SfuService" packages/sfu-proto/src/gen/sfu/v1/sfu_pb.ts
```

Expected: `buf lint` prints nothing; `buf generate` writes `sfu_pb.ts`; the grep prints `1`. If `buf` cannot find the `protoc-gen-es` plugin, run it through pnpm: `pnpm exec buf generate` (the plugin binary is `node_modules/.bin/protoc-gen-es`).

- [ ] **Step 5: Write the failing test**

`packages/sfu-proto/src/proto.test.ts`:

```ts
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  MediaKind,
  MediaSource,
  PublishRequestSchema,
  SfuService,
  StatsEventSchema,
  TransportDirection,
} from "./index";

describe("sfu proto", () => {
  it("exposes the fifteen RPCs of the contract", () => {
    const names = Object.keys(SfuService.method).sort();
    expect(names).toEqual(
      [
        "allocateRoom",
        "cascade",
        "closeRoom",
        "closeTransport",
        "connectTransport",
        "createTransport",
        "publish",
        "restartIce",
        "setConsumerPaused",
        "setLayer",
        "setProducerPaused",
        "stats",
        "subscribe",
        "unpublish",
        "unsubscribe",
      ].sort(),
    );
    expect(SfuService.method.stats.methodKind).toBe("server_streaming");
  });

  it("round-trips a publish request and the stats oneof", () => {
    const req = create(PublishRequestSchema, {
      sessionId: "s",
      participantId: "p",
      transportId: "t",
      kind: MediaKind.VIDEO,
      source: MediaSource.CAMERA,
      rtpParametersJson: "{}",
      paused: true,
    });
    const back = fromBinary(PublishRequestSchema, toBinary(PublishRequestSchema, req));
    expect(back.kind).toBe(MediaKind.VIDEO);
    expect(back.paused).toBe(true);

    const ev = create(StatsEventSchema, {
      event: { case: "consumerLayers", value: { consumerId: "c", active: true, spatialLayer: 1, temporalLayer: 2 } },
    });
    const evBack = fromBinary(StatsEventSchema, toBinary(StatsEventSchema, ev));
    expect(evBack.event.case).toBe("consumerLayers");
    expect(TransportDirection.RECV).toBe(2);
  });
});
```

- [ ] **Step 6: Run, then full check**

Run: `pnpm --filter @zoomclone/sfu-proto test`
Expected: PASS (2 tests). If `SfuService.method` is not the shape used above, inspect the generated file: protoc-gen-es v2 exposes `SfuService.method.<name>` with `methodKind`; adjust the test to the generated shape and note it in the report.

Run: `pnpm check`

- [ ] **Step 7: Commit**

```sh
git add buf.yaml buf.gen.yaml proto packages/sfu-proto package.json pnpm-lock.yaml
git commit -F - <<'EOF'
feat(sfu-proto): add the Sfu gRPC contract and generated TypeScript

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 1: `services/sfu` scaffold, env, codecs, workers (Windows worker smoke test)

**Files:**
- Create: `services/sfu/package.json`, `services/sfu/tsconfig.json`, `services/sfu/vitest.config.ts`, `services/sfu/src/env.ts`, `services/sfu/src/codecs.ts`, `services/sfu/src/errors.ts`, `services/sfu/src/workers.ts`
- Test: `services/sfu/src/env.test.ts`, `services/sfu/src/workers.test.ts`

**Interfaces:**
- `loadEnv(source?)`: `Env` with `NODE_ENV`, `LOG_LEVEL`, `SFU_ID` (default `sfu-local-1`), `SFU_GRPC_PORT` (9090), `SFU_WORKERS` (default `os.availableParallelism()`), `SFU_MEDIA_PORT_BASE` (40000), `SFU_LISTEN_IP` (`0.0.0.0`), `SFU_ANNOUNCED_IP` (`127.0.0.1`), `SFU_QOS_INTERVAL_MS` (5000), `SFU_AUDIO_LEVEL_INTERVAL_MS` (300), `SFU_INITIAL_OUTGOING_BITRATE` (1000000), `MEDIASOUP_LOG_LEVEL` (`warn`).
- `MEDIA_CODECS: RtpCodecCapability[]` (opus, VP8, H264 baseline).
- `class SfuError extends Error { code: SfuErrorCode }` with `SfuErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "FAILED_PRECONDITION" | "INVALID_ARGUMENT" | "UNIMPLEMENTED" | "INTERNAL"`, and `wrapMediasoupError(err): SfuError` (TypeError -> INVALID_ARGUMENT, mediasoup `InvalidStateError` -> FAILED_PRECONDITION, else INTERNAL).
- `createWorkers(env): Promise<WorkerSlot[]>`, `WorkerSlot = { index; worker; webRtcServer; rooms: number }`, `pickWorker(slots): WorkerSlot` (fewest rooms), `closeWorkers(slots)`.

- [ ] **Step 1: Package files**

`services/sfu/package.json`:

```json
{
  "name": "@zoomclone/sfu",
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
    "@zoomclone/sfu-proto": "workspace:*",
    "mediasoup": "3.26.0",
    "pino": "10.3.1",
    "prom-client": "15.1.3",
    "zod": "4.6.2"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "pino-pretty": "13.1.3",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`services/sfu/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`services/sfu/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
```

Run `pnpm install` from the repo root. Watch the mediasoup postinstall: it must print that it downloaded (or found) the prebuilt `mediasoup-worker`. Then verify the binary exists:

```sh
ls node_modules/.pnpm/mediasoup@3.26.0/node_modules/mediasoup/worker/out/Release/ 2>/dev/null || find node_modules/.pnpm/mediasoup@3.26.0 -name "mediasoup-worker*" | head
```

Expected: a `mediasoup-worker.exe` (Windows) or `mediasoup-worker` binary. If it is missing, `pnpm install` may have skipped the build script: check `pnpm.onlyBuiltDependencies` in the root `package.json` includes `mediasoup` (it does since Plan 1) and rerun `pnpm rebuild mediasoup`.

- [ ] **Step 2: Write the failing tests**

`services/sfu/src/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv({});
    expect(env.SFU_ID).toBe("sfu-local-1");
    expect(env.SFU_GRPC_PORT).toBe(9090);
    expect(env.SFU_MEDIA_PORT_BASE).toBe(40000);
    expect(env.SFU_LISTEN_IP).toBe("0.0.0.0");
    expect(env.SFU_ANNOUNCED_IP).toBe("127.0.0.1");
    expect(env.SFU_WORKERS).toBeGreaterThan(0);
    expect(env.SFU_QOS_INTERVAL_MS).toBe(5000);
    expect(env.SFU_AUDIO_LEVEL_INTERVAL_MS).toBe(300);
    expect(env.SFU_INITIAL_OUTGOING_BITRATE).toBe(1_000_000);
    expect(env.MEDIASOUP_LOG_LEVEL).toBe("warn");
  });

  it("parses overrides", () => {
    const env = loadEnv({ SFU_WORKERS: "2", SFU_MEDIA_PORT_BASE: "42000", SFU_ANNOUNCED_IP: "10.0.0.5" });
    expect(env.SFU_WORKERS).toBe(2);
    expect(env.SFU_MEDIA_PORT_BASE).toBe(42000);
    expect(env.SFU_ANNOUNCED_IP).toBe("10.0.0.5");
  });
});
```

`services/sfu/src/workers.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "./env";
import { closeWorkers, createWorkers, pickWorker, type WorkerSlot } from "./workers";

let slots: WorkerSlot[] = [];

beforeAll(async () => {
  const env = loadEnv({ SFU_WORKERS: "2", SFU_MEDIA_PORT_BASE: String(42000 + Math.floor(Math.random() * 900)) });
  slots = await createWorkers(env);
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @zoomclone/sfu test`
Expected: FAIL, unresolved imports `./env`, `./workers`.

- [ ] **Step 4: Implement**

`services/sfu/src/env.ts`:

```ts
import { availableParallelism } from "node:os";
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  SFU_ID: z.string().min(1).default("sfu-local-1"),
  SFU_GRPC_PORT: z.coerce.number().int().default(9090),
  SFU_WORKERS: z.coerce.number().int().min(1).default(availableParallelism()),
  SFU_MEDIA_PORT_BASE: z.coerce.number().int().min(1024).default(40000),
  SFU_LISTEN_IP: z.string().default("0.0.0.0"),
  SFU_ANNOUNCED_IP: z.string().default("127.0.0.1"),
  SFU_QOS_INTERVAL_MS: z.coerce.number().int().min(250).default(5000),
  SFU_AUDIO_LEVEL_INTERVAL_MS: z.coerce.number().int().min(100).default(300),
  SFU_INITIAL_OUTGOING_BITRATE: z.coerce.number().int().default(1_000_000),
  MEDIASOUP_LOG_LEVEL: z.enum(["debug", "warn", "error", "none"]).default("warn"),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
```

`services/sfu/src/codecs.ts`:

```ts
import type { types as ms } from "mediasoup";

/** Router codecs: opus, VP8 with simulcast, H264 constrained baseline (Safari). */
export const MEDIA_CODECS: ms.RtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
  },
];
```

`services/sfu/src/errors.ts`:

```ts
export type SfuErrorCode =
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "FAILED_PRECONDITION"
  | "INVALID_ARGUMENT"
  | "UNIMPLEMENTED"
  | "INTERNAL";

export class SfuError extends Error {
  constructor(
    readonly code: SfuErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SfuError";
  }
}

/** mediasoup throws TypeError for bad parameters and InvalidStateError for closed or misused entities. */
export function wrapMediasoupError(error: unknown): SfuError {
  if (error instanceof SfuError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) return new SfuError("INVALID_ARGUMENT", message);
  if (name === "InvalidStateError") return new SfuError("FAILED_PRECONDITION", message);
  return new SfuError("INTERNAL", message);
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw wrapMediasoupError(error);
  }
}
```

`services/sfu/src/workers.ts`:

```ts
import * as mediasoup from "mediasoup";
import type { types as ms } from "mediasoup";
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
export async function createWorkers(env: Env): Promise<WorkerSlot[]> {
  const slots: WorkerSlot[] = [];
  for (let index = 0; index < env.SFU_WORKERS; index++) {
    const worker = await mediasoup.createWorker({
      logLevel: env.MEDIASOUP_LOG_LEVEL,
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      appData: { index },
    });
    worker.on("died", (error) => {
      console.error(`mediasoup worker ${index} died`, error);
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
```

If the mediasoup typings reject `announcedAddress` (older API used `announcedIp`), check `node_modules/mediasoup/node/lib/WebRtcServerTypes.d.ts` for the field name in 3.26.0 and use that one; report which.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @zoomclone/sfu test`
Expected: PASS (5 tests). The worker test is the Windows prebuilt-binary smoke test: if `createWorker` rejects with a spawn error, the binary is missing; see Step 1.

- [ ] **Step 6: Full check and commit**

Run: `pnpm check`

```sh
git add services/sfu pnpm-lock.yaml
git commit -F - <<'EOF'
feat(sfu): add service scaffold, env, codecs and mediasoup worker pool

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 2: Events queue and Room/RoomManager transports

**Files:**
- Create: `services/sfu/src/events.ts`, `services/sfu/src/rooms.ts`, `services/sfu/test/helpers.ts`
- Test: `services/sfu/src/events.test.ts`, `services/sfu/src/rooms.transports.test.ts`

**Interfaces:**
- `RoomEvent` discriminated union (see code) and `EventQueue<T>` with `push`, `end`, `ended`, `drain(signal?)`.
- `RoomManager(slots, options)`: `sfuId`, `size`, `get(sessionId)`, `require(sessionId)` (throws `NOT_FOUND`), `allocate(sessionId)` (idempotent), `close(sessionId)` (idempotent), `findRoomByTransport(id)`, `findRoomByProducer(id)`, `findRoomByConsumer(id)`, `closeAll()`.
- `Room`: `sessionId`, `router`, `transports`/`producers`/`consumers` maps, `createTransport(participantId, direction)`, `connectTransport(transportId, dtlsParameters)`, `closeTransport(transportId)`, `restartIce(transportId)`, `snapshot()`, `events(signal?)` async generator, `close()`. Media methods arrive in Task 3 (the file is created here with the transport half; Task 3 adds the rest).
- Test helper `createTestManager()` returning `{ manager, slots, stop }` on a random media port base.

- [ ] **Step 1: Write the failing tests**

`services/sfu/src/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EventQueue } from "./events";

async function collect<T>(iter: AsyncIterable<T>, max: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

describe("EventQueue", () => {
  it("yields pushed items in order and returns after end()", async () => {
    const q = new EventQueue<number>();
    q.push(1);
    q.push(2);
    const drained = collect(q.drain(), 10);
    q.push(3);
    q.end();
    expect(await drained).toEqual([1, 2, 3]);
    expect(q.ended).toBe(true);
  });

  it("wakes a waiting consumer when an item arrives later", async () => {
    const q = new EventQueue<string>();
    const first = (async () => {
      for await (const item of q.drain()) return item;
      return "none";
    })();
    await new Promise((r) => setTimeout(r, 20));
    q.push("late");
    expect(await first).toBe("late");
  });

  it("ignores pushes after end and stops on abort", async () => {
    const q = new EventQueue<number>();
    const controller = new AbortController();
    const drained = collect(q.drain(controller.signal), 10);
    q.push(1);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    q.push(2);
    expect(await drained).toEqual([1]);
    expect(q.ended).toBe(true);
  });
});
```

`services/sfu/test/helpers.ts`:

```ts
import type { types as ms } from "mediasoup";
import { loadEnv, type Env } from "../src/env";
import { RoomManager, roomOptionsFrom } from "../src/rooms";
import { closeWorkers, createWorkers, type WorkerSlot } from "../src/workers";

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    SFU_WORKERS: "1",
    SFU_MEDIA_PORT_BASE: String(42000 + Math.floor(Math.random() * 900)),
    SFU_QOS_INTERVAL_MS: "250",
    SFU_AUDIO_LEVEL_INTERVAL_MS: "300",
    MEDIASOUP_LOG_LEVEL: "error",
    ...overrides,
  });
}

export async function createTestManager(overrides: Record<string, string> = {}) {
  const env = testEnv(overrides);
  const slots: WorkerSlot[] = await createWorkers(env);
  const manager = new RoomManager(slots, roomOptionsFrom(env));
  return {
    env,
    slots,
    manager,
    stop: async () => {
      await manager.closeAll();
      await closeWorkers(slots);
    },
  };
}

/** A syntactically valid client DTLS fingerprint; mediasoup stores it until the handshake. */
export const CLIENT_DTLS_PARAMETERS: ms.DtlsParameters = {
  role: "client",
  fingerprints: [
    {
      algorithm: "sha-256",
      value: Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).padStart(2, "0").toUpperCase()).join(":"),
    },
  ],
};

export const AUDIO_RTP_PARAMETERS: ms.RtpParameters = {
  mid: "0",
  codecs: [
    {
      mimeType: "audio/opus",
      payloadType: 111,
      clockRate: 48000,
      channels: 2,
      parameters: { useinbandfec: 1 },
    },
  ],
  headerExtensions: [],
  encodings: [{ ssrc: 11111111 }],
  rtcp: { cname: "test-audio", reducedSize: true },
};

export const VIDEO_SIMULCAST_RTP_PARAMETERS: ms.RtpParameters = {
  mid: "1",
  codecs: [
    {
      mimeType: "video/VP8",
      payloadType: 96,
      clockRate: 90000,
      rtcpFeedback: [
        { type: "nack" },
        { type: "nack", parameter: "pli" },
        { type: "ccm", parameter: "fir" },
        { type: "goog-remb" },
      ],
    },
    { mimeType: "video/rtx", payloadType: 97, clockRate: 90000, parameters: { apt: 96 } },
  ],
  headerExtensions: [],
  encodings: [
    { ssrc: 22222222, rtx: { ssrc: 22222223 }, scalabilityMode: "L1T3", maxBitrate: 150_000 },
    { ssrc: 22222224, rtx: { ssrc: 22222225 }, scalabilityMode: "L1T3", maxBitrate: 500_000 },
    { ssrc: 22222226, rtx: { ssrc: 22222227 }, scalabilityMode: "L1T3", maxBitrate: 1_500_000 },
  ],
  rtcp: { cname: "test-video", reducedSize: true },
};
```

`services/sfu/src/rooms.transports.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_DTLS_PARAMETERS, createTestManager } from "../test/helpers";
import type { RoomManager } from "./rooms";

let ctx: Awaited<ReturnType<typeof createTestManager>>;
let manager: RoomManager;

beforeAll(async () => {
  ctx = await createTestManager();
  manager = ctx.manager;
});
afterAll(async () => {
  await ctx.stop();
});

describe("RoomManager rooms", () => {
  it("allocates a room once per session with the configured codecs", async () => {
    const a = await manager.allocate("s1");
    const b = await manager.allocate("s1");
    expect(b).toBe(a);
    expect(manager.size).toBe(1);
    const mimes = a.router.rtpCapabilities.codecs?.map((c) => c.mimeType) ?? [];
    expect(mimes).toEqual(expect.arrayContaining(["audio/opus", "video/VP8", "video/H264"]));
    expect(ctx.slots[0]!.rooms).toBe(1);
  });

  it("close is idempotent and frees the worker slot", async () => {
    await manager.allocate("s2");
    await manager.close("s2");
    await manager.close("s2");
    expect(manager.get("s2")).toBeUndefined();
    expect(() => manager.require("s2")).toThrowError(/not found/);
    expect(ctx.slots[0]!.rooms).toBe(1);
  });
});

describe("Room transports", () => {
  it("creates send and recv transports with ICE and DTLS parameters", async () => {
    const room = await manager.allocate("s3");
    const send = await room.createTransport("p1", "send");
    const recv = await room.createTransport("p1", "recv");
    expect(send.transportId).not.toBe(recv.transportId);
    expect(send.iceParameters.usernameFragment).toBeTruthy();
    expect(send.iceParameters.password).toBeTruthy();
    expect(send.iceCandidates.length).toBeGreaterThan(0);
    expect(send.iceCandidates[0]?.ip ?? send.iceCandidates[0]?.address).toBe(ctx.env.SFU_ANNOUNCED_IP);
    expect(send.iceCandidates[0]?.port).toBe(ctx.env.SFU_MEDIA_PORT_BASE);
    expect(send.dtlsParameters.fingerprints.length).toBeGreaterThan(0);
    expect(room.transports.get(send.transportId)?.direction).toBe("send");
    expect(manager.findRoomByTransport(recv.transportId)).toBe(room);
  });

  it("connects a transport once and reports the second attempt as a precondition failure", async () => {
    const room = await manager.allocate("s4");
    const { transportId } = await room.createTransport("p1", "send");
    await room.connectTransport(transportId, CLIENT_DTLS_PARAMETERS);
    await expect(room.connectTransport(transportId, CLIENT_DTLS_PARAMETERS)).rejects.toMatchObject({
      code: "FAILED_PRECONDITION",
    });
  });

  it("restarts ICE with new parameters", async () => {
    const room = await manager.allocate("s5");
    const created = await room.createTransport("p1", "recv");
    const restarted = await room.restartIce(created.transportId);
    expect(restarted.usernameFragment).not.toBe(created.iceParameters.usernameFragment);
  });

  it("closes transports and emits transport_closed, unknown ids are NOT_FOUND", async () => {
    const room = await manager.allocate("s6");
    const events: unknown[] = [];
    const controller = new AbortController();
    const reader = (async () => {
      for await (const e of room.events(controller.signal)) events.push(e);
    })();
    const { transportId } = await room.createTransport("p2", "send");
    await room.closeTransport(transportId);
    await new Promise((r) => setTimeout(r, 20));
    expect(room.transports.has(transportId)).toBe(false);
    expect(events).toContainEqual({
      type: "transport_closed",
      transportId,
      participantId: "p2",
      reason: "closed",
    });
    await expect(room.closeTransport(transportId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    controller.abort();
    await reader;
  });

  it("snapshot lists transports with their states and closing the room ends event streams", async () => {
    const room = await manager.allocate("s7");
    await room.createTransport("p1", "send");
    const snap = room.snapshot();
    expect(snap.transports).toHaveLength(1);
    expect(snap.transports[0]).toMatchObject({ participantId: "p1", direction: "send", iceState: "new", dtlsState: "new" });
    const events: unknown[] = [];
    const reader = (async () => {
      for await (const e of room.events()) events.push(e);
    })();
    await manager.close("s7");
    await reader;
    expect(events).toEqual([{ type: "room_closed" }]);
    expect(room.router.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @zoomclone/sfu test`
Expected: FAIL, unresolved imports `./events`, `./rooms`, `../test/helpers`.

- [ ] **Step 3: Implement**

`services/sfu/src/events.ts`:

```ts
/** Everything a room reports to its Stats subscribers (design doc "StatsEvent"). */
export type RoomEvent =
  | {
      type: "dominant_speakers";
      speakers: Array<{ participantId: string; producerId: string; volume: number }>;
    }
  | { type: "silence" }
  | {
      type: "consumer_layers";
      consumerId: string;
      active: boolean;
      spatialLayer: number;
      temporalLayer: number;
    }
  | { type: "producer_score"; producerId: string; score: number }
  | { type: "producer_closed"; producerId: string; trackId: string; participantId: string }
  | {
      type: "consumer_closed";
      consumerId: string;
      reason: "producerclose" | "transportclose" | "unsubscribed";
    }
  | { type: "ice_state"; transportId: string; participantId: string; state: string }
  | { type: "transport_closed"; transportId: string; participantId: string; reason: string }
  | {
      type: "qos";
      transportId: string;
      participantId: string;
      bytesSent: number;
      bytesReceived: number;
      sendBitrate: number;
      recvBitrate: number;
      availableOutgoingBitrate: number;
      rtpPacketLossSent: number;
      rtpPacketLossReceived: number;
    }
  | { type: "room_closed" };

/** One subscriber's buffer. push() never blocks the emitter; drain() yields in order until end(). */
export class EventQueue<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.done = true;
    this.wake();
  }

  get ended(): boolean {
    return this.done;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *drain(signal?: AbortSignal): AsyncGenerator<T, void, undefined> {
    const onAbort = () => this.end();
    if (signal?.aborted) this.end();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const next = this.items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (this.done) return;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.done = true;
    }
  }
}
```

`services/sfu/src/rooms.ts` (transport half; Task 3 appends the media methods where marked):

```ts
import type { types as ms } from "mediasoup";
import { MEDIA_CODECS } from "./codecs";
import type { Env } from "./env";
import { SfuError, guarded } from "./errors";
import { EventQueue, type RoomEvent } from "./events";
import { pickWorker, type WorkerSlot } from "./workers";

export type Direction = "send" | "recv";
export type Kind = "audio" | "video";
export type Source = "mic" | "camera" | "screen" | "screen_audio";

/** appData on every producer; lets a restarted controller rebuild its bindings from a snapshot. */
export type EntityMeta = {
  sfuId: string;
  sessionId: string;
  participantId: string;
  trackId: string;
  kind: Kind;
  source: Source;
  origin: "local" | "pipe";
};

export type TransportEntry = {
  transport: ms.WebRtcTransport;
  participantId: string;
  direction: Direction;
};
export type ProducerEntry = {
  producer: ms.Producer;
  meta: EntityMeta;
  transportId: string;
  layerCount: number;
};
export type ConsumerEntry = {
  consumer: ms.Consumer;
  participantId: string;
  transportId: string;
  producerId: string;
};

export type TransportParams = {
  transportId: string;
  iceParameters: ms.IceParameters;
  iceCandidates: ms.IceCandidate[];
  dtlsParameters: ms.DtlsParameters;
};

export type RoomSnapshot = {
  transports: Array<{
    transportId: string;
    participantId: string;
    direction: Direction;
    iceState: string;
    dtlsState: string;
  }>;
  producers: Array<{
    producerId: string;
    meta: EntityMeta;
    paused: boolean;
    layerCount: number;
    transportId: string;
  }>;
  consumers: Array<{
    consumerId: string;
    producerId: string;
    participantId: string;
    transportId: string;
    paused: boolean;
    producerPaused: boolean;
    preferredLayers: ms.ConsumerLayers | undefined;
    currentLayers: ms.ConsumerLayers | undefined;
    priority: number;
  }>;
};

export type RoomOptions = {
  sfuId: string;
  audioLevelIntervalMs: number;
  qosIntervalMs: number;
  initialAvailableOutgoingBitrate: number;
};

export function roomOptionsFrom(env: Env): RoomOptions {
  return {
    sfuId: env.SFU_ID,
    audioLevelIntervalMs: env.SFU_AUDIO_LEVEL_INTERVAL_MS,
    qosIntervalMs: env.SFU_QOS_INTERVAL_MS,
    initialAvailableOutgoingBitrate: env.SFU_INITIAL_OUTGOING_BITRATE,
  };
}

export class Room {
  readonly transports = new Map<string, TransportEntry>();
  readonly producers = new Map<string, ProducerEntry>();
  readonly consumers = new Map<string, ConsumerEntry>();
  private readonly queues = new Set<EventQueue<RoomEvent>>();
  private readonly qosTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly sessionId: string,
    readonly slot: WorkerSlot,
    readonly router: ms.Router,
    readonly audioLevelObserver: ms.AudioLevelObserver,
    readonly options: RoomOptions,
  ) {
    audioLevelObserver.on("volumes", (volumes) => {
      this.emit({
        type: "dominant_speakers",
        speakers: volumes.map((v) => ({
          participantId: String(v.producer.appData["participantId"] ?? ""),
          producerId: v.producer.id,
          volume: v.volume,
        })),
      });
    });
    audioLevelObserver.on("silence", () => this.emit({ type: "silence" }));
    this.qosTimer = setInterval(() => void this.sampleQos(), options.qosIntervalMs);
    this.qosTimer.unref();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---- transports ----

  async createTransport(participantId: string, direction: Direction): Promise<TransportParams> {
    this.assertOpen();
    const transport = await guarded(() =>
      this.router.createWebRtcTransport({
        webRtcServer: this.slot.webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: this.options.initialAvailableOutgoingBitrate,
        appData: { participantId, direction },
      }),
    );
    this.transports.set(transport.id, { transport, participantId, direction });
    transport.on("icestatechange", (state) =>
      this.emit({ type: "ice_state", transportId: transport.id, participantId, state }),
    );
    transport.on("dtlsstatechange", (state) => {
      if (state === "closed" || state === "failed") {
        this.dropTransport(transport.id, `dtls_${state}`);
      }
    });
    return {
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(transportId: string, dtlsParameters: ms.DtlsParameters): Promise<void> {
    const entry = this.requireTransport(transportId);
    await guarded(() => entry.transport.connect({ dtlsParameters }));
  }

  async restartIce(transportId: string): Promise<ms.IceParameters> {
    const entry = this.requireTransport(transportId);
    return guarded(() => entry.transport.restartIce());
  }

  async closeTransport(transportId: string): Promise<void> {
    this.requireTransport(transportId);
    this.dropTransport(transportId, "closed");
  }

  requireTransport(transportId: string): TransportEntry {
    const entry = this.transports.get(transportId);
    if (!entry) throw new SfuError("NOT_FOUND", `transport ${transportId} not found`);
    return entry;
  }

  /** Closing the mediasoup transport closes its producers and consumers, whose handlers emit their own events first. */
  private dropTransport(transportId: string, reason: string): void {
    const entry = this.transports.get(transportId);
    if (!entry) return;
    this.transports.delete(transportId);
    if (!entry.transport.closed) entry.transport.close();
    this.emit({ type: "transport_closed", transportId, participantId: entry.participantId, reason });
  }

  // ---- media (Task 3 adds publish/subscribe methods here) ----

  // ---- snapshot, events, lifecycle ----

  snapshot(): RoomSnapshot {
    return {
      transports: [...this.transports].map(([transportId, t]) => ({
        transportId,
        participantId: t.participantId,
        direction: t.direction,
        iceState: t.transport.iceState,
        dtlsState: t.transport.dtlsState,
      })),
      producers: [...this.producers].map(([producerId, p]) => ({
        producerId,
        meta: p.meta,
        paused: p.producer.paused,
        layerCount: p.layerCount,
        transportId: p.transportId,
      })),
      consumers: [...this.consumers].map(([consumerId, c]) => ({
        consumerId,
        producerId: c.producerId,
        participantId: c.participantId,
        transportId: c.transportId,
        paused: c.consumer.paused,
        producerPaused: c.consumer.producerPaused,
        preferredLayers: c.consumer.preferredLayers,
        currentLayers: c.consumer.currentLayers,
        priority: c.consumer.priority,
      })),
    };
  }

  /** Live event stream for one subscriber; ends on room close or when the signal aborts. */
  async *events(signal?: AbortSignal): AsyncGenerator<RoomEvent, void, undefined> {
    const queue = new EventQueue<RoomEvent>();
    this.queues.add(queue);
    if (this.closed) queue.end();
    try {
      yield* queue.drain(signal);
    } finally {
      this.queues.delete(queue);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.qosTimer);
    this.router.close();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
    this.slot.rooms -= 1;
    this.emit({ type: "room_closed" });
    for (const queue of this.queues) queue.end();
    this.queues.clear();
  }

  private emit(event: RoomEvent): void {
    if (this.closed && event.type !== "room_closed") return;
    for (const queue of this.queues) queue.push(event);
  }

  private assertOpen(): void {
    if (this.closed) throw new SfuError("FAILED_PRECONDITION", `room ${this.sessionId} is closed`);
  }

  private async sampleQos(): Promise<void> {
    if (this.closed || this.queues.size === 0) return;
    for (const [transportId, entry] of this.transports) {
      try {
        const [stats] = await entry.transport.getStats();
        if (!stats) continue;
        this.emit({
          type: "qos",
          transportId,
          participantId: entry.participantId,
          bytesSent: stats.bytesSent,
          bytesReceived: stats.bytesReceived,
          sendBitrate: stats.sendBitrate,
          recvBitrate: stats.recvBitrate,
          availableOutgoingBitrate: stats.availableOutgoingBitrate ?? 0,
          rtpPacketLossSent: stats.rtpPacketLossSent ?? 0,
          rtpPacketLossReceived: stats.rtpPacketLossReceived ?? 0,
        });
      } catch {
        // transport closed between the loop and getStats; its close event already fired
      }
    }
  }
}

export class RoomManager {
  private readonly roomsById = new Map<string, Room>();

  constructor(
    private readonly slots: WorkerSlot[],
    private readonly options: RoomOptions,
  ) {}

  get sfuId(): string {
    return this.options.sfuId;
  }

  get size(): number {
    return this.roomsById.size;
  }

  rooms(): IterableIterator<Room> {
    return this.roomsById.values();
  }

  get(sessionId: string): Room | undefined {
    return this.roomsById.get(sessionId);
  }

  require(sessionId: string): Room {
    const room = this.roomsById.get(sessionId);
    if (!room) throw new SfuError("NOT_FOUND", `room ${sessionId} not found`);
    return room;
  }

  /** Idempotent: a second allocate for the same session returns the existing room. */
  async allocate(sessionId: string): Promise<Room> {
    const existing = this.roomsById.get(sessionId);
    if (existing) return existing;
    const slot = pickWorker(this.slots);
    const router = await guarded(() =>
      slot.worker.createRouter({ mediaCodecs: MEDIA_CODECS, appData: { sessionId } }),
    );
    const audioLevelObserver = await guarded(() =>
      router.createAudioLevelObserver({
        maxEntries: 5,
        threshold: -60,
        interval: this.options.audioLevelIntervalMs,
      }),
    );
    slot.rooms += 1;
    const room = new Room(sessionId, slot, router, audioLevelObserver, this.options);
    this.roomsById.set(sessionId, room);
    return room;
  }

  async close(sessionId: string): Promise<void> {
    const room = this.roomsById.get(sessionId);
    if (!room) return;
    this.roomsById.delete(sessionId);
    room.close();
  }

  findRoomByTransport(transportId: string): Room | undefined {
    for (const room of this.roomsById.values()) if (room.transports.has(transportId)) return room;
    return undefined;
  }

  findRoomByProducer(producerId: string): Room | undefined {
    for (const room of this.roomsById.values()) if (room.producers.has(producerId)) return room;
    return undefined;
  }

  findRoomByConsumer(consumerId: string): Room | undefined {
    for (const room of this.roomsById.values()) if (room.consumers.has(consumerId)) return room;
    return undefined;
  }

  requireRoomByTransport(transportId: string): Room {
    const room = this.findRoomByTransport(transportId);
    if (!room) throw new SfuError("NOT_FOUND", `transport ${transportId} not found`);
    return room;
  }

  requireRoomByProducer(producerId: string): Room {
    const room = this.findRoomByProducer(producerId);
    if (!room) throw new SfuError("NOT_FOUND", `producer ${producerId} not found`);
    return room;
  }

  requireRoomByConsumer(consumerId: string): Room {
    const room = this.findRoomByConsumer(consumerId);
    if (!room) throw new SfuError("NOT_FOUND", `consumer ${consumerId} not found`);
    return room;
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.roomsById.keys()]) await this.close(sessionId);
  }
}
```

In `errors.ts`, extend `wrapMediasoupError` so mediasoup's plain `Error("connect() already called")` and "closed" messages map to `FAILED_PRECONDITION`:

```ts
  if (/already called|closed/i.test(message)) return new SfuError("FAILED_PRECONDITION", message);
```

placed before the final `INTERNAL` return.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @zoomclone/sfu test`
Expected: PASS. Notes if something fails:
- `iceCandidates[0].ip` vs `.address`: mediasoup 3.26 reports `address` (older builds `ip`); the test accepts either.
- If `transport.on("icestatechange")` typing complains about the handler parameter, annotate it as `(state: ms.IceState)`.
- If `getStats()` result fields differ in name, check `node_modules/mediasoup/node/lib/WebRtcTransportTypes.d.ts` (`WebRtcTransportStat`) and map the same quantities.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/sfu
git commit -F - <<'EOF'
feat(sfu): add room manager with transports, snapshot and event streams

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 3: Room media: publish, subscribe, pause, layers

**Files:**
- Modify: `services/sfu/src/rooms.ts`
- Test: `services/sfu/src/rooms.media.test.ts`

**Interfaces:**
- `Room.publish(participantId, transportId, kind, source, rtpParameters, paused): Promise<PublishResult>` with `PublishResult = { producerId; trackId; layerCount }`.
- `Room.unpublish(producerId)`, `Room.setProducerPaused(producerId, paused)`.
- `Room.subscribe(participantId, transportId, producerId, rtpCapabilities, maxSpatialLayer?, priority?): Promise<SubscribeResult>` with `SubscribeResult = { consumerId; kind; rtpParameters; producerPaused }`; consumers start paused.
- `Room.setConsumerPaused(consumerId, paused)`, `Room.unsubscribe(consumerId)`, `Room.setLayer(consumerId, spatialLayer, temporalLayer?, priority?)`.
- `RoomManager.subscribe(sessionId, ...)` wraps `Room.subscribe` and turns "producer exists in another room" into `PERMISSION_DENIED`.

- [ ] **Step 1: Write the failing test**

`services/sfu/src/rooms.media.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIO_RTP_PARAMETERS,
  VIDEO_SIMULCAST_RTP_PARAMETERS,
  createTestManager,
} from "../test/helpers";
import type { Room, RoomManager } from "./rooms";

let ctx: Awaited<ReturnType<typeof createTestManager>>;
let manager: RoomManager;
let room: Room;
let sendA: string;
let recvB: string;

beforeAll(async () => {
  ctx = await createTestManager();
  manager = ctx.manager;
  room = await manager.allocate("media-1");
  sendA = (await room.createTransport("A", "send")).transportId;
  recvB = (await room.createTransport("B", "recv")).transportId;
});
afterAll(async () => {
  await ctx.stop();
});

describe("publish", () => {
  it("creates an audio producer with meta, one layer, and registers it with the audio level observer", async () => {
    const result = await room.publish("A", sendA, "audio", "mic", AUDIO_RTP_PARAMETERS, false);
    expect(result.layerCount).toBe(1);
    expect(result.trackId).toMatch(/^[0-9a-f-]{36}$/);
    const entry = room.producers.get(result.producerId)!;
    expect(entry.meta).toEqual({
      sfuId: ctx.env.SFU_ID,
      sessionId: "media-1",
      participantId: "A",
      trackId: result.trackId,
      kind: "audio",
      source: "mic",
      origin: "local",
    });
    expect(entry.producer.appData["participantId"]).toBe("A");
    expect(entry.producer.paused).toBe(false);
  });

  it("creates a paused simulcast video producer with three layers", async () => {
    const result = await room.publish("A", sendA, "video", "camera", VIDEO_SIMULCAST_RTP_PARAMETERS, true);
    expect(result.layerCount).toBe(3);
    expect(room.producers.get(result.producerId)?.producer.paused).toBe(true);
    expect(room.snapshot().producers.find((p) => p.producerId === result.producerId)?.paused).toBe(true);
  });

  it("rejects the wrong participant, the wrong direction and unknown transports", async () => {
    await expect(
      room.publish("B", sendA, "audio", "mic", AUDIO_RTP_PARAMETERS, false),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      room.publish("B", recvB, "audio", "mic", AUDIO_RTP_PARAMETERS, false),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    await expect(
      room.publish("A", "nope", "audio", "mic", AUDIO_RTP_PARAMETERS, false),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects malformed rtp parameters as INVALID_ARGUMENT", async () => {
    await expect(
      room.publish("A", sendA, "audio", "mic", { codecs: [] } as never, false),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("subscribe", () => {
  it("consumes a producer paused, honours max layer and priority, and reports producer pause", async () => {
    const pub = await room.publish("A", sendA, "video", "camera", VIDEO_SIMULCAST_RTP_PARAMETERS, false);
    const sub = await room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities, 1, 10);
    expect(sub.kind).toBe("video");
    expect(sub.producerPaused).toBe(false);
    expect(sub.rtpParameters.codecs[0]?.mimeType).toBe("video/VP8");
    const entry = room.consumers.get(sub.consumerId)!;
    expect(entry.consumer.paused).toBe(true);
    expect(entry.consumer.preferredLayers).toMatchObject({ spatialLayer: 1 });
    expect(entry.consumer.priority).toBe(10);

    await room.setConsumerPaused(sub.consumerId, false);
    expect(entry.consumer.paused).toBe(false);
    await room.setLayer(sub.consumerId, 2, 1, 20);
    expect(entry.consumer.preferredLayers).toEqual({ spatialLayer: 2, temporalLayer: 1 });
    expect(entry.consumer.priority).toBe(20);

    await room.setProducerPaused(pub.producerId, true);
    expect(room.snapshot().consumers.find((c) => c.consumerId === sub.consumerId)?.producerPaused).toBe(true);
  });

  it("rejects cross-room producers, unknown producers and send transports", async () => {
    const other = await manager.allocate("media-2");
    const otherSend = (await other.createTransport("Z", "send")).transportId;
    const pub = await other.publish("Z", otherSend, "audio", "mic", AUDIO_RTP_PARAMETERS, false);
    await expect(
      manager.subscribe("media-1", "B", recvB, pub.producerId, room.router.rtpCapabilities),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      manager.subscribe("media-1", "B", recvB, "missing", room.router.rtpCapabilities),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      manager.subscribe("media-1", "A", sendA, pub.producerId, room.router.rtpCapabilities),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
  });

  it("closes consumers when the producer goes away and emits both events", async () => {
    const events: unknown[] = [];
    const controller = new AbortController();
    const reader = (async () => {
      for await (const e of room.events(controller.signal)) events.push(e);
    })();
    const pub = await room.publish("A", sendA, "audio", "mic", AUDIO_RTP_PARAMETERS, false);
    const sub = await room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities);
    await room.unpublish(pub.producerId);
    await new Promise((r) => setTimeout(r, 20));
    expect(room.producers.has(pub.producerId)).toBe(false);
    expect(room.consumers.has(sub.consumerId)).toBe(false);
    expect(events).toContainEqual({ type: "consumer_closed", consumerId: sub.consumerId, reason: "producerclose" });
    expect(events).toContainEqual({
      type: "producer_closed",
      producerId: pub.producerId,
      trackId: pub.trackId,
      participantId: "A",
    });
    await expect(room.unpublish(pub.producerId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    controller.abort();
    await reader;
  });

  it("unsubscribe closes only the consumer", async () => {
    const pub = await room.publish("A", sendA, "audio", "mic", AUDIO_RTP_PARAMETERS, false);
    const sub = await room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities);
    await room.unsubscribe(sub.consumerId);
    expect(room.consumers.has(sub.consumerId)).toBe(false);
    expect(room.producers.has(pub.producerId)).toBe(true);
    await expect(room.setConsumerPaused(sub.consumerId, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("closing a transport closes its producers and consumers", async () => {
    const sendC = (await room.createTransport("C", "send")).transportId;
    const pub = await room.publish("C", sendC, "audio", "mic", AUDIO_RTP_PARAMETERS, false);
    const sub = await room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities);
    await room.closeTransport(sendC);
    expect(room.producers.has(pub.producerId)).toBe(false);
    expect(room.consumers.has(sub.consumerId)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/sfu test`
Expected: FAIL, `room.publish is not a function`.

- [ ] **Step 3: Implement**

Add to `services/sfu/src/rooms.ts` (imports: `import { randomUUID } from "node:crypto";`), replacing the `// ---- media ----` marker:

```ts
  // ---- media ----

  async publish(
    participantId: string,
    transportId: string,
    kind: Kind,
    source: Source,
    rtpParameters: ms.RtpParameters,
    paused: boolean,
  ): Promise<PublishResult> {
    this.assertOpen();
    const entry = this.requireOwnedTransport(transportId, participantId, "send");
    const trackId = randomUUID();
    const meta: EntityMeta = {
      sfuId: this.options.sfuId,
      sessionId: this.sessionId,
      participantId,
      trackId,
      kind,
      source,
      origin: "local",
    };
    const producer = await guarded(() =>
      entry.transport.produce({ kind, rtpParameters, paused, appData: { ...meta } }),
    );
    const layerCount = rtpParameters.encodings?.length ?? 1;
    this.producers.set(producer.id, { producer, meta, transportId, layerCount });
    producer.on("score", (scores) =>
      this.emit({
        type: "producer_score",
        producerId: producer.id,
        score: scores.length ? Math.min(...scores.map((s) => s.score)) : 0,
      }),
    );
    producer.on("transportclose", () => this.dropProducer(producer.id));
    if (kind === "audio") {
      await guarded(() => this.audioLevelObserver.addProducer({ producerId: producer.id }));
    }
    return { producerId: producer.id, trackId, layerCount };
  }

  async unpublish(producerId: string): Promise<void> {
    const entry = this.requireProducer(producerId);
    entry.producer.close();
    this.dropProducer(producerId);
  }

  async setProducerPaused(producerId: string, paused: boolean): Promise<void> {
    const entry = this.requireProducer(producerId);
    await guarded(() => (paused ? entry.producer.pause() : entry.producer.resume()));
  }

  async subscribe(
    participantId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: ms.RtpCapabilities,
    maxSpatialLayer?: number,
    priority?: number,
  ): Promise<SubscribeResult> {
    this.assertOpen();
    const entry = this.requireOwnedTransport(transportId, participantId, "recv");
    this.requireProducer(producerId);
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new SfuError("FAILED_PRECONDITION", "rtp capabilities cannot consume this producer");
    }
    const consumer = await guarded(() =>
      entry.transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
        preferredLayers: maxSpatialLayer === undefined ? undefined : { spatialLayer: maxSpatialLayer },
        appData: { participantId, producerId },
      }),
    );
    if (priority !== undefined) await guarded(() => consumer.setPriority(priority));
    this.consumers.set(consumer.id, { consumer, participantId, transportId, producerId });
    consumer.on("layerschange", (layers) =>
      this.emit({
        type: "consumer_layers",
        consumerId: consumer.id,
        active: layers !== undefined,
        spatialLayer: layers?.spatialLayer ?? 0,
        temporalLayer: layers?.temporalLayer ?? 0,
      }),
    );
    consumer.on("producerclose", () => this.dropConsumer(consumer.id, "producerclose"));
    consumer.on("transportclose", () => this.dropConsumer(consumer.id, "transportclose"));
    return {
      consumerId: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerPaused: consumer.producerPaused,
    };
  }

  async setConsumerPaused(consumerId: string, paused: boolean): Promise<void> {
    const entry = this.requireConsumer(consumerId);
    await guarded(() => (paused ? entry.consumer.pause() : entry.consumer.resume()));
  }

  async unsubscribe(consumerId: string): Promise<void> {
    const entry = this.requireConsumer(consumerId);
    entry.consumer.close();
    this.dropConsumer(consumerId, "unsubscribed");
  }

  async setLayer(
    consumerId: string,
    spatialLayer: number,
    temporalLayer?: number,
    priority?: number,
  ): Promise<void> {
    const entry = this.requireConsumer(consumerId);
    await guarded(() => entry.consumer.setPreferredLayers({ spatialLayer, temporalLayer }));
    if (priority !== undefined) await guarded(() => entry.consumer.setPriority(priority));
  }

  requireProducer(producerId: string): ProducerEntry {
    const entry = this.producers.get(producerId);
    if (!entry) throw new SfuError("NOT_FOUND", `producer ${producerId} not found`);
    return entry;
  }

  requireConsumer(consumerId: string): ConsumerEntry {
    const entry = this.consumers.get(consumerId);
    if (!entry) throw new SfuError("NOT_FOUND", `consumer ${consumerId} not found`);
    return entry;
  }

  private requireOwnedTransport(
    transportId: string,
    participantId: string,
    direction: Direction,
  ): TransportEntry {
    const entry = this.requireTransport(transportId);
    if (entry.participantId !== participantId) {
      throw new SfuError("PERMISSION_DENIED", "transport belongs to another participant");
    }
    if (entry.direction !== direction) {
      throw new SfuError("FAILED_PRECONDITION", `operation needs a ${direction} transport`);
    }
    return entry;
  }

  private dropProducer(producerId: string): void {
    const entry = this.producers.get(producerId);
    if (!entry) return;
    this.producers.delete(producerId);
    this.emit({
      type: "producer_closed",
      producerId,
      trackId: entry.meta.trackId,
      participantId: entry.meta.participantId,
    });
  }

  private dropConsumer(
    consumerId: string,
    reason: "producerclose" | "transportclose" | "unsubscribed",
  ): void {
    if (!this.consumers.delete(consumerId)) return;
    this.emit({ type: "consumer_closed", consumerId, reason });
  }
```

Add the result types near the other exported types:

```ts
export type PublishResult = { producerId: string; trackId: string; layerCount: number };
export type SubscribeResult = {
  consumerId: string;
  kind: Kind;
  rtpParameters: ms.RtpParameters;
  producerPaused: boolean;
};
```

Add to `RoomManager`:

```ts
  /** Subscribe with the cross-room check: a producer that lives in another room is PERMISSION_DENIED. */
  async subscribe(
    sessionId: string,
    participantId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: ms.RtpCapabilities,
    maxSpatialLayer?: number,
    priority?: number,
  ): Promise<SubscribeResult> {
    const room = this.require(sessionId);
    if (!room.producers.has(producerId) && this.findRoomByProducer(producerId)) {
      throw new SfuError("PERMISSION_DENIED", "producer belongs to another room");
    }
    return room.subscribe(participantId, transportId, producerId, rtpCapabilities, maxSpatialLayer, priority);
  }
```

Note on the "malformed rtp parameters" test: mediasoup rejects `{ codecs: [] }` with a `TypeError` ("missing rtpParameters.codecs" or similar), which `wrapMediasoupError` maps to `INVALID_ARGUMENT`. If mediasoup throws a different error class for it, adjust `wrapMediasoupError` to also map errors whose message starts with "missing" or contains "invalid" to `INVALID_ARGUMENT`, and say so in the report.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/sfu test`
Expected: PASS. If `router.rtpCapabilities` is rejected by `canConsume` for the video producer (returns false), build the consumer capabilities in `test/helpers.ts` as `CONSUMER_RTP_CAPABILITIES`: the router capabilities filtered to opus, VP8 and its rtx codec (keep `preferredPayloadType`, `parameters`, `rtcpFeedback`) plus the router's `headerExtensions`, and use it in the tests instead; report it.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/sfu
git commit -F - <<'EOF'
feat(sfu): add publish, subscribe, pause and layer control to rooms

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 4: Connect service, http2 app, metrics, entrypoint, gRPC integration tests

**Files:**
- Create: `services/sfu/src/service.ts`, `services/sfu/src/metrics.ts`, `services/sfu/src/app.ts`, `services/sfu/src/main.ts`
- Modify: `services/sfu/test/helpers.ts` (add `startTestSfu`)
- Test: `services/sfu/src/service.test.ts`

**Interfaces:**
- `sfuRoutes(manager): (router: ConnectRouter) => void` implementing every `SfuService` method; JSON fields parsed with `parseJsonObject(field, text)` (`INVALID_ARGUMENT` on failure); enums mapped by `kindFromProto`, `sourceFromProto`, `directionFromProto`, `kindToProto`, `sourceToProto`, `directionToProto`; `SfuError` mapped to `ConnectError` by `toConnectError`.
- `Stats` yields a `snapshot` first, then room events until the room closes (`room_closed` ends the stream) or the client aborts.
- `createMetrics(manager)`: prom-client registry with gauges `sfu_rooms` and `sfu_transports` collected on scrape.
- `createSfuServer(manager, metrics)`: `http2.Http2Server` serving `/healthz` (`{ ok: true, rooms }`), `/metrics`, and the Connect handler for everything else.
- Test helper `startTestSfu()` returning `{ env, manager, client, stop }` where `client` is `createClient(SfuService, createGrpcTransport({ baseUrl }))` against an ephemeral port.

- [ ] **Step 1: Write the failing test**

Add to `services/sfu/test/helpers.ts`:

```ts
import type { AddressInfo } from "node:net";
import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SfuService } from "@zoomclone/sfu-proto";
import { createSfuServer } from "../src/app";
import { createMetrics } from "../src/metrics";

export type TestSfu = {
  env: Env;
  manager: RoomManager;
  client: Client<typeof SfuService>;
  baseUrl: string;
  stop: () => Promise<void>;
};

export async function startTestSfu(overrides: Record<string, string> = {}): Promise<TestSfu> {
  const base = await createTestManager(overrides);
  const server = createSfuServer(base.manager, createMetrics(base.manager));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createClient(SfuService, createGrpcTransport({ baseUrl }));
  return {
    env: base.env,
    manager: base.manager,
    client,
    baseUrl,
    stop: async () => {
      await base.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Reads events from a server stream until `count` have arrived or `ms` elapse. */
export async function take<T>(iter: AsyncIterable<T>, count: number, ms = 5000): Promise<T[]> {
  const out: T[] = [];
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));
  const reader = (async () => {
    for await (const item of iter) {
      out.push(item);
      if (out.length >= count) break;
    }
    return "done" as const;
  })();
  await Promise.race([reader, timeout]);
  return out;
}
```

(`createMetrics`/`createSfuServer` come from Step 3.)

`services/sfu/src/service.test.ts`:

```ts
import { Code, ConnectError } from "@connectrpc/connect";
import { MediaKind, MediaSource, TransportDirection, type StatsEvent } from "@zoomclone/sfu-proto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIO_RTP_PARAMETERS,
  CLIENT_DTLS_PARAMETERS,
  VIDEO_SIMULCAST_RTP_PARAMETERS,
  startTestSfu,
  take,
  type TestSfu,
} from "../test/helpers";

let sfu: TestSfu;

beforeAll(async () => {
  sfu = await startTestSfu();
});
afterAll(async () => {
  await sfu.stop();
});

async function codeOf(promise: Promise<unknown>): Promise<Code | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ConnectError.from(error).code;
  }
}

describe("Sfu gRPC service", () => {
  it("allocates rooms idempotently and returns router capabilities", async () => {
    const first = await sfu.client.allocateRoom({ sessionId: "g1" });
    const second = await sfu.client.allocateRoom({ sessionId: "g1" });
    expect(first.sfuId).toBe(sfu.env.SFU_ID);
    expect(second.rtpCapabilitiesJson).toBe(first.rtpCapabilitiesJson);
    const caps = JSON.parse(first.rtpCapabilitiesJson) as { codecs: Array<{ mimeType: string }> };
    expect(caps.codecs.map((c) => c.mimeType)).toEqual(expect.arrayContaining(["audio/opus", "video/VP8"]));
    expect(sfu.manager.size).toBe(1);
  });

  it("runs the publish and subscribe flow over gRPC", async () => {
    const { rtpCapabilitiesJson } = await sfu.client.allocateRoom({ sessionId: "g2" });
    const send = await sfu.client.createTransport({
      sessionId: "g2",
      participantId: "A",
      direction: TransportDirection.SEND,
    });
    const recv = await sfu.client.createTransport({
      sessionId: "g2",
      participantId: "B",
      direction: TransportDirection.RECV,
    });
    expect(JSON.parse(send.iceParametersJson)).toHaveProperty("usernameFragment");
    expect(JSON.parse(send.iceCandidatesJson)).toBeInstanceOf(Array);
    expect(JSON.parse(send.dtlsParametersJson)).toHaveProperty("fingerprints");

    await sfu.client.connectTransport({
      transportId: send.transportId,
      dtlsParametersJson: JSON.stringify(CLIENT_DTLS_PARAMETERS),
    });

    const pub = await sfu.client.publish({
      sessionId: "g2",
      participantId: "A",
      transportId: send.transportId,
      kind: MediaKind.VIDEO,
      source: MediaSource.CAMERA,
      rtpParametersJson: JSON.stringify(VIDEO_SIMULCAST_RTP_PARAMETERS),
      paused: false,
    });
    expect(pub.layerCount).toBe(3);
    expect(pub.trackId).toMatch(/^[0-9a-f-]{36}$/);

    const sub = await sfu.client.subscribe({
      sessionId: "g2",
      participantId: "B",
      transportId: recv.transportId,
      producerId: pub.producerId,
      rtpCapabilitiesJson,
      maxSpatialLayer: 1,
      priority: 5,
    });
    expect(sub.kind).toBe(MediaKind.VIDEO);
    expect(sub.producerPaused).toBe(false);
    expect(JSON.parse(sub.rtpParametersJson)).toHaveProperty("codecs");

    await sfu.client.setConsumerPaused({ consumerId: sub.consumerId, paused: false });
    await sfu.client.setLayer({ consumerId: sub.consumerId, spatialLayer: 2, temporalLayer: 2, priority: 9 });
    await sfu.client.setProducerPaused({ producerId: pub.producerId, paused: true });

    const room = sfu.manager.require("g2");
    const consumer = room.consumers.get(sub.consumerId)!.consumer;
    expect(consumer.paused).toBe(false);
    expect(consumer.preferredLayers).toEqual({ spatialLayer: 2, temporalLayer: 2 });
    expect(consumer.priority).toBe(9);
    expect(consumer.producerPaused).toBe(true);

    await sfu.client.unsubscribe({ consumerId: sub.consumerId });
    await sfu.client.unpublish({ producerId: pub.producerId });
    expect(room.consumers.size).toBe(0);
    expect(room.producers.size).toBe(0);
  });

  it("maps errors to gRPC codes", async () => {
    await sfu.client.allocateRoom({ sessionId: "g3" });
    await sfu.client.allocateRoom({ sessionId: "g4" });
    const sendA = await sfu.client.createTransport({ sessionId: "g3", participantId: "A", direction: TransportDirection.SEND });
    const recvB = await sfu.client.createTransport({ sessionId: "g3", participantId: "B", direction: TransportDirection.RECV });
    const sendZ = await sfu.client.createTransport({ sessionId: "g4", participantId: "Z", direction: TransportDirection.SEND });
    const pubZ = await sfu.client.publish({
      sessionId: "g4",
      participantId: "Z",
      transportId: sendZ.transportId,
      kind: MediaKind.AUDIO,
      source: MediaSource.MIC,
      rtpParametersJson: JSON.stringify(AUDIO_RTP_PARAMETERS),
      paused: false,
    });
    const caps = (await sfu.client.allocateRoom({ sessionId: "g3" })).rtpCapabilitiesJson;

    expect(await codeOf(sfu.client.createTransport({ sessionId: "missing", participantId: "A", direction: TransportDirection.SEND }))).toBe(Code.NotFound);
    expect(await codeOf(sfu.client.connectTransport({ transportId: "missing", dtlsParametersJson: "{}" }))).toBe(Code.NotFound);
    expect(await codeOf(sfu.client.connectTransport({ transportId: sendA.transportId, dtlsParametersJson: "not json" }))).toBe(Code.InvalidArgument);
    expect(await codeOf(sfu.client.publish({ sessionId: "g3", participantId: "B", transportId: sendA.transportId, kind: MediaKind.AUDIO, source: MediaSource.MIC, rtpParametersJson: JSON.stringify(AUDIO_RTP_PARAMETERS), paused: false }))).toBe(Code.PermissionDenied);
    expect(await codeOf(sfu.client.publish({ sessionId: "g3", participantId: "B", transportId: recvB.transportId, kind: MediaKind.AUDIO, source: MediaSource.MIC, rtpParametersJson: JSON.stringify(AUDIO_RTP_PARAMETERS), paused: false }))).toBe(Code.FailedPrecondition);
    expect(await codeOf(sfu.client.publish({ sessionId: "g3", participantId: "A", transportId: sendA.transportId, kind: MediaKind.UNSPECIFIED, source: MediaSource.MIC, rtpParametersJson: JSON.stringify(AUDIO_RTP_PARAMETERS), paused: false }))).toBe(Code.InvalidArgument);
    expect(await codeOf(sfu.client.subscribe({ sessionId: "g3", participantId: "B", transportId: recvB.transportId, producerId: pubZ.producerId, rtpCapabilitiesJson: caps }))).toBe(Code.PermissionDenied);
    expect(await codeOf(sfu.client.subscribe({ sessionId: "g3", participantId: "B", transportId: recvB.transportId, producerId: "missing", rtpCapabilitiesJson: caps }))).toBe(Code.NotFound);
    expect(await codeOf(sfu.client.cascade({ sessionId: "g3", remoteSfuAddr: "sfu-2:9090" }))).toBe(Code.Unimplemented);
    expect(await codeOf(sfu.client.stats({ sessionId: "missing" })[Symbol.asyncIterator]().next())).toBe(Code.NotFound);
  });

  it("streams a snapshot then live events, and ends when the room closes", async () => {
    const { rtpCapabilitiesJson } = await sfu.client.allocateRoom({ sessionId: "g5" });
    const send = await sfu.client.createTransport({ sessionId: "g5", participantId: "A", direction: TransportDirection.SEND });
    const recv = await sfu.client.createTransport({ sessionId: "g5", participantId: "B", direction: TransportDirection.RECV });
    const pub = await sfu.client.publish({
      sessionId: "g5",
      participantId: "A",
      transportId: send.transportId,
      kind: MediaKind.AUDIO,
      source: MediaSource.MIC,
      rtpParametersJson: JSON.stringify(AUDIO_RTP_PARAMETERS),
      paused: true,
    });
    const sub = await sfu.client.subscribe({ sessionId: "g5", participantId: "B", transportId: recv.transportId, producerId: pub.producerId, rtpCapabilitiesJson });

    const controller = new AbortController();
    const stream = sfu.client.stats({ sessionId: "g5" }, { signal: controller.signal });
    const [first] = await take(stream, 1);
    expect(first?.event.case).toBe("snapshot");
    if (first?.event.case !== "snapshot") throw new Error("expected snapshot");
    const snapshot = first.event.value;
    expect(snapshot.transports.map((t) => t.transportId).sort()).toEqual([send.transportId, recv.transportId].sort());
    expect(snapshot.producers[0]).toMatchObject({
      producerId: pub.producerId,
      paused: true,
      layerCount: 1,
      transportId: send.transportId,
    });
    expect(snapshot.producers[0]?.meta).toMatchObject({
      sfuId: sfu.env.SFU_ID,
      sessionId: "g5",
      participantId: "A",
      trackId: pub.trackId,
      kind: MediaKind.AUDIO,
      source: MediaSource.MIC,
      origin: "local",
    });
    expect(snapshot.consumers[0]).toMatchObject({
      consumerId: sub.consumerId,
      producerId: pub.producerId,
      participantId: "B",
      paused: true,
      producerPaused: true,
    });

    const rest: StatsEvent[] = [];
    const reader = (async () => {
      for await (const ev of stream) rest.push(ev);
    })();
    await sfu.client.unpublish({ producerId: pub.producerId });
    await sfu.client.closeTransport({ transportId: recv.transportId });
    await new Promise((r) => setTimeout(r, 600));
    await sfu.client.closeRoom({ sessionId: "g5" });
    await reader;

    const cases = rest.map((e) => e.event.case);
    expect(cases).toContain("producerClosed");
    expect(cases).toContain("consumerClosed");
    expect(cases).toContain("transportClosed");
    expect(cases).toContain("qos");
    const closed = rest.find((e) => e.event.case === "consumerClosed");
    expect(closed?.event.case === "consumerClosed" && closed.event.value.reason).toBe("producerclose");
    expect(sfu.manager.get("g5")).toBeUndefined();
    await sfu.client.closeRoom({ sessionId: "g5" });
  });

  it("serves health and metrics over plain http2", async () => {
    const client = (await import("node:http2")).connect(sfu.baseUrl);
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = client.request({ ":path": path, ":method": "GET" });
        let status = 0;
        let body = "";
        req.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => resolve({ status, body }));
        req.on("error", reject);
        req.end();
      });
    try {
      const health = await get("/healthz");
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toMatchObject({ ok: true });
      const metrics = await get("/metrics");
      expect(metrics.status).toBe(200);
      expect(metrics.body).toContain("sfu_rooms");
    } finally {
      client.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zoomclone/sfu test`
Expected: FAIL, unresolved `../src/app`, `../src/metrics`.

- [ ] **Step 3: Implement**

`services/sfu/src/service.ts`:

```ts
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  MediaKind,
  MediaSource,
  SfuService,
  TransportDirection,
  type StatsEvent,
} from "@zoomclone/sfu-proto";
import type { types as ms } from "mediasoup";
import { SfuError, type SfuErrorCode } from "./errors";
import type { RoomEvent } from "./events";
import type { Direction, Kind, RoomManager, RoomSnapshot, Source } from "./rooms";

const CODE_MAP: Record<SfuErrorCode, Code> = {
  NOT_FOUND: Code.NotFound,
  PERMISSION_DENIED: Code.PermissionDenied,
  FAILED_PRECONDITION: Code.FailedPrecondition,
  INVALID_ARGUMENT: Code.InvalidArgument,
  UNIMPLEMENTED: Code.Unimplemented,
  INTERNAL: Code.Internal,
};

export function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof SfuError) return new ConnectError(error.message, CODE_MAP[error.code]);
  return new ConnectError(error instanceof Error ? error.message : String(error), Code.Internal);
}

export function parseJsonObject<T>(field: string, text: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConnectError(`${field} is not valid JSON`, Code.InvalidArgument);
  }
  if (typeof value !== "object" || value === null) {
    throw new ConnectError(`${field} must be a JSON object`, Code.InvalidArgument);
  }
  return value as T;
}

export function kindFromProto(value: MediaKind): Kind {
  if (value === MediaKind.AUDIO) return "audio";
  if (value === MediaKind.VIDEO) return "video";
  throw new ConnectError("kind is required", Code.InvalidArgument);
}

export function kindToProto(kind: Kind): MediaKind {
  return kind === "audio" ? MediaKind.AUDIO : MediaKind.VIDEO;
}

const SOURCE_FROM_PROTO: Partial<Record<MediaSource, Source>> = {
  [MediaSource.MIC]: "mic",
  [MediaSource.CAMERA]: "camera",
  [MediaSource.SCREEN]: "screen",
  [MediaSource.SCREEN_AUDIO]: "screen_audio",
};
const SOURCE_TO_PROTO: Record<Source, MediaSource> = {
  mic: MediaSource.MIC,
  camera: MediaSource.CAMERA,
  screen: MediaSource.SCREEN,
  screen_audio: MediaSource.SCREEN_AUDIO,
};

export function sourceFromProto(value: MediaSource): Source {
  const source = SOURCE_FROM_PROTO[value];
  if (!source) throw new ConnectError("source is required", Code.InvalidArgument);
  return source;
}

export function sourceToProto(source: Source): MediaSource {
  return SOURCE_TO_PROTO[source];
}

export function directionFromProto(value: TransportDirection): Direction {
  if (value === TransportDirection.SEND) return "send";
  if (value === TransportDirection.RECV) return "recv";
  throw new ConnectError("direction is required", Code.InvalidArgument);
}

export function directionToProto(direction: Direction): TransportDirection {
  return direction === "send" ? TransportDirection.SEND : TransportDirection.RECV;
}

function snapshotToProto(snapshot: RoomSnapshot): StatsEvent["event"] {
  return {
    case: "snapshot",
    value: {
      transports: snapshot.transports.map((t) => ({
        transportId: t.transportId,
        participantId: t.participantId,
        direction: directionToProto(t.direction),
        iceState: t.iceState,
        dtlsState: t.dtlsState,
      })),
      producers: snapshot.producers.map((p) => ({
        producerId: p.producerId,
        meta: {
          sfuId: p.meta.sfuId,
          sessionId: p.meta.sessionId,
          participantId: p.meta.participantId,
          trackId: p.meta.trackId,
          kind: kindToProto(p.meta.kind),
          source: sourceToProto(p.meta.source),
          origin: p.meta.origin,
        },
        paused: p.paused,
        layerCount: p.layerCount,
        transportId: p.transportId,
      })),
      consumers: snapshot.consumers.map((c) => ({
        consumerId: c.consumerId,
        producerId: c.producerId,
        participantId: c.participantId,
        transportId: c.transportId,
        paused: c.paused,
        producerPaused: c.producerPaused,
        preferredSpatialLayer: c.preferredLayers?.spatialLayer,
        preferredTemporalLayer: c.preferredLayers?.temporalLayer,
        currentSpatialLayer: c.currentLayers?.spatialLayer,
        currentTemporalLayer: c.currentLayers?.temporalLayer,
        priority: c.priority,
      })),
    },
  };
}

/** Room events become StatsEvent oneof cases; room_closed ends the stream and is not sent. */
function eventToProto(event: RoomEvent): StatsEvent["event"] | undefined {
  switch (event.type) {
    case "dominant_speakers":
      return { case: "dominantSpeakers", value: { speakers: event.speakers } };
    case "silence":
      return { case: "silence", value: {} };
    case "consumer_layers":
      return {
        case: "consumerLayers",
        value: {
          consumerId: event.consumerId,
          active: event.active,
          spatialLayer: event.spatialLayer,
          temporalLayer: event.temporalLayer,
        },
      };
    case "producer_score":
      return { case: "producerScore", value: { producerId: event.producerId, score: event.score } };
    case "producer_closed":
      return {
        case: "producerClosed",
        value: { producerId: event.producerId, trackId: event.trackId, participantId: event.participantId },
      };
    case "consumer_closed":
      return { case: "consumerClosed", value: { consumerId: event.consumerId, reason: event.reason } };
    case "ice_state":
      return {
        case: "iceState",
        value: { transportId: event.transportId, participantId: event.participantId, state: event.state },
      };
    case "transport_closed":
      return {
        case: "transportClosed",
        value: { transportId: event.transportId, participantId: event.participantId, reason: event.reason },
      };
    case "qos":
      return {
        case: "qos",
        value: {
          transportId: event.transportId,
          participantId: event.participantId,
          bytesSent: BigInt(Math.round(event.bytesSent)),
          bytesReceived: BigInt(Math.round(event.bytesReceived)),
          sendBitrate: event.sendBitrate,
          recvBitrate: event.recvBitrate,
          availableOutgoingBitrate: event.availableOutgoingBitrate,
          rtpPacketLossSent: event.rtpPacketLossSent,
          rtpPacketLossReceived: event.rtpPacketLossReceived,
        },
      };
    case "room_closed":
      return undefined;
  }
}

function unary<I, O>(fn: (req: I) => Promise<O>): (req: I) => Promise<O> {
  return async (req) => {
    try {
      return await fn(req);
    } catch (error) {
      throw toConnectError(error);
    }
  };
}

export function sfuRoutes(manager: RoomManager): (router: ConnectRouter) => void {
  return (router) => {
    router.service(SfuService, {
      allocateRoom: unary(async (req) => {
        const room = await manager.allocate(req.sessionId);
        return { rtpCapabilitiesJson: JSON.stringify(room.router.rtpCapabilities), sfuId: manager.sfuId };
      }),
      closeRoom: unary(async (req) => {
        await manager.close(req.sessionId);
        return {};
      }),
      createTransport: unary(async (req) => {
        const room = manager.require(req.sessionId);
        const params = await room.createTransport(req.participantId, directionFromProto(req.direction));
        return {
          transportId: params.transportId,
          iceParametersJson: JSON.stringify(params.iceParameters),
          iceCandidatesJson: JSON.stringify(params.iceCandidates),
          dtlsParametersJson: JSON.stringify(params.dtlsParameters),
        };
      }),
      connectTransport: unary(async (req) => {
        const room = manager.requireRoomByTransport(req.transportId);
        const dtls = parseJsonObject<ms.DtlsParameters>("dtls_parameters_json", req.dtlsParametersJson);
        await room.connectTransport(req.transportId, dtls);
        return {};
      }),
      closeTransport: unary(async (req) => {
        const room = manager.requireRoomByTransport(req.transportId);
        await room.closeTransport(req.transportId);
        return {};
      }),
      restartIce: unary(async (req) => {
        const room = manager.requireRoomByTransport(req.transportId);
        const ice = await room.restartIce(req.transportId);
        return { iceParametersJson: JSON.stringify(ice) };
      }),
      publish: unary(async (req) => {
        const room = manager.require(req.sessionId);
        const kind = kindFromProto(req.kind);
        const source = sourceFromProto(req.source);
        const rtp = parseJsonObject<ms.RtpParameters>("rtp_parameters_json", req.rtpParametersJson);
        const result = await room.publish(req.participantId, req.transportId, kind, source, rtp, req.paused);
        return { producerId: result.producerId, trackId: result.trackId, layerCount: result.layerCount };
      }),
      unpublish: unary(async (req) => {
        const room = manager.requireRoomByProducer(req.producerId);
        await room.unpublish(req.producerId);
        return {};
      }),
      setProducerPaused: unary(async (req) => {
        const room = manager.requireRoomByProducer(req.producerId);
        await room.setProducerPaused(req.producerId, req.paused);
        return {};
      }),
      subscribe: unary(async (req) => {
        const caps = parseJsonObject<ms.RtpCapabilities>("rtp_capabilities_json", req.rtpCapabilitiesJson);
        const result = await manager.subscribe(
          req.sessionId,
          req.participantId,
          req.transportId,
          req.producerId,
          caps,
          req.maxSpatialLayer,
          req.priority,
        );
        return {
          consumerId: result.consumerId,
          kind: kindToProto(result.kind),
          rtpParametersJson: JSON.stringify(result.rtpParameters),
          producerPaused: result.producerPaused,
        };
      }),
      setConsumerPaused: unary(async (req) => {
        const room = manager.requireRoomByConsumer(req.consumerId);
        await room.setConsumerPaused(req.consumerId, req.paused);
        return {};
      }),
      unsubscribe: unary(async (req) => {
        const room = manager.requireRoomByConsumer(req.consumerId);
        await room.unsubscribe(req.consumerId);
        return {};
      }),
      setLayer: unary(async (req) => {
        const room = manager.requireRoomByConsumer(req.consumerId);
        await room.setLayer(req.consumerId, req.spatialLayer, req.temporalLayer, req.priority);
        return {};
      }),
      cascade: unary(async () => {
        throw new SfuError("UNIMPLEMENTED", "cascade arrives with the cross-region slice");
      }),
      async *stats(req, context) {
        let room;
        try {
          room = manager.require(req.sessionId);
        } catch (error) {
          throw toConnectError(error);
        }
        yield { event: snapshotToProto(room.snapshot()) };
        for await (const event of room.events(context.signal)) {
          if (event.type === "room_closed") return;
          const mapped = eventToProto(event);
          if (mapped) yield { event: mapped };
        }
      },
    });
  };
}
```

`services/sfu/src/metrics.ts`:

```ts
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
```

`services/sfu/src/app.ts`:

```ts
import * as http2 from "node:http2";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { Metrics } from "./metrics";
import type { RoomManager } from "./rooms";
import { sfuRoutes } from "./service";

/** gRPC (h2c) for the room controller, plus /healthz and /metrics on the same port. */
export function createSfuServer(manager: RoomManager, metrics: Metrics): http2.Http2Server {
  const rpc = connectNodeAdapter({ routes: sfuRoutes(manager) });
  return http2.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: manager.size }));
      return;
    }
    if (req.url === "/metrics") {
      void metrics.registry.metrics().then(
        (body) => {
          res.writeHead(200, { "content-type": metrics.registry.contentType });
          res.end(body);
        },
        (error: unknown) => {
          res.writeHead(500);
          res.end(String(error));
        },
      );
      return;
    }
    rpc(req, res);
  });
}
```

`services/sfu/src/main.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zoomclone/sfu test`
Expected: PASS. Known adjustment points, report whichever applies:
- protobuf-es v2 represents `uint64` as `bigint`; the `Qos` mapping above uses `BigInt(...)`. If the generated type uses `number` instead (it does not by default), drop the conversion.
- The `stats` handler signature in connect-es v2 is `(req, context) => AsyncIterable<...>`; `context.signal` aborts when the client cancels.
- If `ConnectError.from(error).code` for a rejected stream iterator is not `NotFound`, read the error from the first `next()` call as shown; connect surfaces server errors when the first message is awaited.
- The `/metrics` gauge `collect()` uses `this`; declare the callbacks as `collect(this: Gauge) {...}` if TypeScript complains about `this`.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add services/sfu
git commit -F - <<'EOF'
feat(sfu): serve the Sfu gRPC contract with a stats stream, health and metrics

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 5: Dev wiring, docs, design-doc notes

**Files:**
- Modify: `.env.example`, `README.md`, `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md`

**Interfaces:**
- `pnpm dev` now starts meeting-api and sfu together (`pnpm -r --parallel dev` already covers every workspace with a `dev` script; nothing to change in the root).

- [ ] **Step 1: Env example**

Append to `.env.example`:

```
# sfu
SFU_GRPC_PORT=9090
SFU_WORKERS=2
SFU_MEDIA_PORT_BASE=40000
SFU_LISTEN_IP=0.0.0.0
SFU_ANNOUNCED_IP=127.0.0.1
SFU_QOS_INTERVAL_MS=5000
SFU_AUDIO_LEVEL_INTERVAL_MS=300
SFU_INITIAL_OUTGOING_BITRATE=1000000
MEDIASOUP_LOG_LEVEL=warn
```

(`SFU_ID` is already present in the meeting-api block and is shared.)

- [ ] **Step 2: README**

Append to `README.md`:

````markdown
## SFU (gRPC :9090, media UDP/TCP :40000+)

mediasoup workers behind the `sfu.v1.Sfu` contract (`proto/sfu/v1/sfu.proto`). One `WebRtcServer`
per worker, so each worker uses exactly one UDP and one TCP port: `SFU_MEDIA_PORT_BASE + index`.
Set `SFU_ANNOUNCED_IP` to the address browsers can reach (the host's LAN IP when testing from
another device; `127.0.0.1` for a single machine).

```sh
pnpm proto:gen                       # regenerate packages/sfu-proto after editing the proto
pnpm --filter @zoomclone/sfu start   # or: pnpm dev (all services)
curl -s --http2-prior-knowledge localhost:9090/healthz
```

Errors map to gRPC codes: unknown ids `NOT_FOUND`, another room's or participant's entity
`PERMISSION_DENIED`, wrong transport direction or incompatible capabilities `FAILED_PRECONDITION`,
bad JSON `INVALID_ARGUMENT`, `Cascade` `UNIMPLEMENTED`.
````

- [ ] **Step 3: Design doc notes**

In `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md`, gRPC section: change `RestartIce(transport_id) -> ice_parameters_json                          [added, UNIMPLEMENTED in MVP]` to `[added, implemented: mediasoup restartIce]`, and replace `ResumeConsumer` wording if any remains with `SetConsumerPaused`. Add one sentence under the `StatsEvent` paragraph: "`room_closed` is internal to the SFU; the stream simply ends when the room closes."

- [ ] **Step 4: Smoke test**

From the repo root with `.env` present and infra up: `pnpm --filter @zoomclone/sfu start` in one terminal; in another, `curl -s --http2-prior-knowledge localhost:9090/healthz` prints `{"ok":true,"rooms":0}`. Stop the server (Ctrl+C or kill the PID) and confirm the port is free.

- [ ] **Step 5: Full check and commit**

Run: `pnpm check`

```sh
git add .env.example README.md docs/superpowers/specs
git commit -F - <<'EOF'
docs(sfu): document the SFU service and env

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

## Self-review against the design doc

- Phase 3 coverage: proto + codegen (Task 0), workers with one `WebRtcServer` each and the Windows prebuilt check (Task 1), rooms with transports, snapshot and per-subscriber event queues (Task 2), publish/subscribe/pause/layers with the same-room isolation check and `AudioLevelObserver` registration (Task 3), the Connect service with error-code mapping, `Stats` stream (snapshot first, ends on room close), health and metrics (Task 4), env/docs (Task 5).
- Deviations recorded: `RestartIce` implemented (one mediasoup call) instead of stubbed; `room_closed` is internal; QoS default interval 5 s; `Cascade` stubbed `UNIMPLEMENTED` as designed. Dominant-speaker events come from `AudioLevelObserver.volumes` (loudest first) and `silence`; no synthetic RTP in tests, so the speaker path is exercised end to end only in Plan 4.
- Handoff to Plan 3 (signaling): import `SfuService` and enums from `@zoomclone/sfu-proto`; `createClient(SfuService, createGrpcTransport({ baseUrl: SFU_ADDR }))`; call order for a join is `AllocateRoom` (idempotent), `CreateTransport` x2, `ConnectTransport` per transport, `Publish` (with `paused` from mute state), `Subscribe` (consumer starts paused) then `SetConsumerPaused(false)` after the client's `consumer_ready`; `Stats` gives a snapshot first, whose `producers[].meta` carries `participant_id`, `track_id`, `kind`, `source` for rehydrate.
