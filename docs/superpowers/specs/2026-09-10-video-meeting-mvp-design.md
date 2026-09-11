# Design: video meeting backend MVP vertical slice (A + B + C)

Date: 2026-09-10. Status: approved. Source spec: `video-meeting-backend-spec.pdf` (Draft v1, 2026-09-01).
Implementation plan: `docs/superpowers/plans/2026-09-10-video-meeting-mvp-plan.md` (written next).

## Context

`C:\ZoomClone` holds one file: `video-meeting-backend-spec.pdf` (Draft v1, 2026-09-01), an 11-page
backend spec for a Google Meet / Zoom class system sized for ~12 engineers over 12 months. Repo has
no commits and no code.

The spec decomposes into ten sub-projects (A control plane, B signaling + room controller, C media
plane, D scheduler/registry, E recording, F breakouts, G cross-region cascade, H Kafka, I enterprise,
J observability/K8s). Decisions taken with the user in this session:

- Scope for this pass: **MVP vertical slice A + B + C**. Real multi-party WebRTC call end to end,
  single region, single SFU, local infra. Later slices stack on top without rewrites.
- Stack: **TypeScript (Node 24) + mediasoup** SFU behind the spec's gRPC contract.
- Verification: **client page served at `/dev/` + Playwright** with fake camera/mic. Per the user
  (mid-session): the client UI must be distinctive, not the generic AI-generated look; visual
  direction chosen with the `frontend-design` skill when that phase starts. Vanilla TS + CSS,
  no framework, so the esbuild bundle stays simple.
- After the MVP works end to end: push the repo to GitHub (remote to be confirmed with the user).
- Signaling Gateway and Room Controller: **one process, explicit module boundary**. Process
  restart still exercises the Redis rehydrate path (the hard failover case).

A design review (fable-advisor) was folded in: shared idempotent session end, `departed` set,
checkpoint `epoch` + owner lease, `kind`/`source` split with server-minted track ids, richer SFU
Stats stream, single `welcome` per connection, idempotent event consumers.

Outcome: a runnable monorepo where `docker compose up` (Postgres, Redis) + `pnpm dev` gives a working
meeting: create by API, join by code, lobby, publish/subscribe audio + video with simulcast, mute,
hand raise, chat, reactions, host controls, active speaker, reconnect with delta replay, controller
rehydrate after restart. All verified by unit, integration, and browser e2e tests.

## Architecture (MVP)

```
browser (harness / future clients)
   | HTTPS /v1               | WSS /rooms/{session_id}          | UDP/TCP SRTP
   v                         v                                  v
meeting-api (Fastify)     signaling (ws)                     sfu (mediasoup)
  auth (jose, OIDC)         gateway  -> RoomRegistry            N workers, 1 WebRtcServer each
  dev OIDC issuer           RoomController (per session)        gRPC Sfu service (Connect-ES, http2)
  jwks endpoint             Room (pure state machine)           Stats server stream
  StaticScheduler           Redis checkpoint (write-behind)
  join grant + JWT          PostgresWriter (async bus consumer)
  endSession (sync)         endSession (sync, on room end)
   |        \                 |         |     ^ gRPC
   v         v                v         v     |
Postgres    Redis  <------ Redis     Postgres |
(durable)   (room meta read) (room state)  (attendance async, session end sync)
```

Spec mapping: Meeting API + Auth/Token = `meeting-api`; Signaling Gateway + Room Controller =
`signaling`; SFU = `sfu`. Scheduler = `StaticScheduler` inside meeting-api. Registry (etcd), Kafka,
TURN server, Recorder, Compositor, Transcription: not in this slice (interfaces left where cheap).

## Repo layout (pnpm workspaces)

```
ZoomClone/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  .gitignore  .editorconfig  .env.example
  docker-compose.yml          postgres:16, redis:7
  buf.yaml  buf.gen.yaml      protoc-gen-es v2 codegen
  proto/sfu/v1/sfu.proto      spec section 5.3 contract (+ MVP additions, see Contracts)
  packages/
    protocol/    zod schemas for WS envelope + every message, REST DTOs, error codes, JWT claims,
                 meeting code generator/validator, WS close codes. Shared by all services + harness.
    db/          SQL migrations (spec 4.1 tables in use), postgres.js client factory,
                 migrate script, `endSession(session_id, reason, peak)` (idempotent, shared)
    events/      EventBus interface, event envelope, typed events, InMemoryEventBus
    sfu-proto/   generated TS from proto (committed output)
  services/
    meeting-api/ Fastify app: env, auth, jwks, dev issuer, scheduler, rate limit, routes, join
    signaling/   gateway, room (Room, RoomController, RoomRegistry, checkpoint, speakers), sfu-client,
                 writer (PostgresWriter), dev harness (esbuild bundle served at /dev)
    sfu/         workers, rooms, service (gRPC handlers), stats stream, env
  e2e/           Playwright config + specs + global setup (infra, migrations, service processes)
  docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md   design doc (from this plan)
```

Tooling: TypeScript strict (NodeNext, ES2022), `tsx` for dev, `vitest` for unit/integration,
`@playwright/test` for e2e, `prettier`, `pino` logging, `prom-client` metrics, `zod` env validation
per service. Root scripts: `dev` (all three services), `check` (typecheck + format + unit/integration),
`test:e2e`, `proto:gen`, `db:migrate`.

Ports: meeting-api 8080, signaling 8081, sfu gRPC 9090, sfu media 40000 + worker index (udp + tcp),
Postgres 5432, Redis 6379.

## Data model

Postgres (hand-written SQL migrations applied by a small runner, queried through postgres.js; only tables the slice writes): `meetings`, `meeting_sessions`,
`participants`. Addition to spec: `CREATE UNIQUE INDEX ON meeting_sessions (meeting_id) WHERE ended_at
IS NULL` so get-or-create of the live session is idempotent under join storms. `recordings` and
`chat_messages` arrive with their slices.

`meetings.settings` JSONB (MVP keys): `{ lobby: boolean (default true), max_participants: number
(default 500) }`. `meetings.status`: `scheduled | live | ended | cancelled`.

Session lifecycle (spec 4.1: "one row per live instance of a meeting", so a meeting may go live
several times): `endSession(session_id, reason, peak)` in `packages/db` is the single writer of
`meeting_sessions.ended_at` / `peak_participants` and of the meeting status transition:
`host_end` and `api_end` -> meeting `ended` (terminal, `/join` returns 410 from then on);
`idle` -> meeting back to `scheduled` (re-joinable, next `/join` creates a new session).
Idempotent (no-op when `ended_at` already set). Called synchronously by whoever ends the session
(controller or meeting-api); the bus event is a backup path for the writer.

Redis (spec 4.2 key layout under `{room:<session_id>}`): `meta` (status, home_sfu, host_ids,
locked, lobby_enabled, recording, plus MVP extensions `epoch`, `peak`), `roster`, `lobby`,
`tracks`, `breakouts` (empty), `seq`, and MVP additions `departed` (HASH participant_id ->
`{reason, at}`) and `owner` (`SET NX PX 15000`, controller lease, refreshed every 5 s). TTL 1 h
refreshed by the heartbeat. On session end `meta.status = ended` with a 60 s TTL so `/join` never
reuses a dying session. Pub/sub channel `room:{session_id}:ctl` carries control plane commands
(`{"cmd":"end"}`).

## Contracts

### REST (meeting-api, spec 5.1, all under /v1)

| Route | Notes |
| --- | --- |
| `POST /meetings` | OIDC bearer. Body: title?, scheduled_start?, scheduled_end?, settings?. Generates code `xxx-xxxx-xxx` from `[a-z0-9]`, retries on unique violation. Region from `DEFAULT_REGION`. |
| `GET /meetings/{id}` | Org-scoped. |
| `PATCH /meetings/{id}` | Organizer only. title, schedule, settings. |
| `DELETE /meetings/{id}` | Organizer only. status -> cancelled, 409 if live. |
| `POST /meetings/{id}::end` | Organizer only. Calls `endSession(api_end)` synchronously, then publishes `end` on `room:{S}:ctl`. Works with no controller alive. 409 `NOT_LIVE` if no live session. (Fastify literal colon spelled `::`.) |
| `POST /join` | Critical path, bearer optional (guest). Below. |
| `GET /.well-known/jwks.json` | Signaling JWT verification keys. |
| `GET /healthz`, `GET /metrics` | |
| `POST /dev/oidc/token`, `GET /dev/oidc/jwks.json` | Only when `AUTH_DEV_ISSUER=true`; process refuses to start with it in `NODE_ENV=production`. |

Recordings endpoints: deferred to slice E (not stubbed).

`POST /join` flow: rate limit per IP (10/min, spec) and per code (120/min default, separate
`JOIN_RATE_LIMIT_PER_CODE`; the spec's 10/min per code would cap a meeting at ten joins a minute),
in-memory limiter behind an interface -> 429 `RATE_LIMITED`; lookup by code -> 404 `MEETING_NOT_FOUND`; ended/cancelled -> 410 `ENDED`;
role = bearer.sub == organizer_id ? `host` : `attendee`; get-or-create live session in one
transaction (on create: `StaticScheduler.place()` -> region, sfu id, signaling url; write
`home_sfu_id`; meeting -> `live`); if session existed read Redis meta: `status == ended` ->
treat as no live session (end it in Postgres if not already, create a new one), `locked` and not
host -> 403 `LOCKED`, roster size >= max_participants -> 429 `CAPACITY`; `lobby` = settings.lobby
&& role != host && bearer.org_id != meeting.org_id; mint ES256 signaling JWT (5 min) with claims
`{iss, aud: "signaling", sub: participant_id, session_id, participant_id, role, sfu_hint,
display_name, exp}`; respond with the spec 5.1 body (session_id, participant_id, role, lobby,
signaling_url, signaling_token, ice_servers, region). `ice_servers` = configured STUN list plus
time-limited TURN credentials (HMAC, coturn `use-auth-secret` format) when `TURN_SECRET` is set.
503 `NO_CAPACITY` reserved for the scheduler (static scheduler never returns it).

Auth: user bearer verified with `jose` `jwtVerify` against `createRemoteJWKSet(OIDC_JWKS_URL)`,
issuer/audience from env. Claims used: `sub` (user_id), `org_id` (custom claim, fallback
`DEFAULT_ORG_ID` in dev), `name`. Guests carry no bearer. Roles in MVP: `host`, `attendee`
(`cohost` exists in the enum, no promotion flow).

### WebSocket signaling (spec 5.2 semantics, mediasoup payloads)

Envelope `{ type, seq?, id?, payload }`. Server pushes carry monotonic `seq`. Client requests carry
`id`; every request is answered by `ack {id, payload?}` or `error {id, code, message}`. Zod
schemas in `packages/protocol` are the source of truth.

Client -> server:

| Type | Payload | Ack payload |
| --- | --- | --- |
| `hello` | `{token, resume_seq?, epoch?}` | `{mode: welcome \| resync \| replay, epoch, seq}`, then push `welcome`, `resync` or the replayed events |
| `connect_transport` | `{transport: "send" \| "recv", dtls_parameters}` | `{}` |
| `publish` | `{kind: audio \| video, source: mic \| camera \| screen \| screen_audio, rtp_parameters, paused?}` | `{track_id}` (server-minted) |
| `unpublish` | `{track_id}` | `{}` |
| `subscribe` | `{rtp_capabilities?, track_ids: [], prefs: {track_id: {max_layer, priority, paused?}}}` declarative full set; `rtp_capabilities` required on first call, stored | `{consumers: [{track_id, consumer_id, kind, rtp_parameters, producer_paused}], removed: [track_id]}` |
| `consumer_ready` | `{track_id}` (client created its consumer; server unpauses it) | `{}` |
| `set_media_state` | `{muted?, video_off?}` (stored in roster; server pauses/resumes producers, applies to later publishes too) | `{}` |
| `raise_hand` / `lower_hand` | `{}` | `{}` |
| `reaction` | `{emoji}` rate limit 2/s | `{}` |
| `chat` | `{body <= 4 KB, to?: participant_id}` | `{}` |
| `host.admit` / `host.deny` | `{participant_id}` host/cohost | `{}` |
| `host.mute` / `host.remove` | `{participant_id}` host/cohost | `{}` |
| `host.lock` | `{locked: boolean}` | `{}` |
| `host.end` | `{}` | `{}` then push `room.ended` |
| `restart_ice` | reserved name, returns `error NOT_IMPLEMENTED` in MVP | |
| `ping` | `{ts}` every 10 s, 3 missed -> close 4000 | push `pong {ts}` |

Server -> client pushes (seq'd, replayable): `welcome`, `resync`,
`participant.joined/.left/.updated` (`connected`, `muted`, `video_off`, `hand`, `role`),
`track.added/.removed/.updated` (`paused` to everyone; `layers` only to the subscriber it concerns:
spatial layers being delivered, 0 none, 1 low, 2 medium, 3 high), `active_speakers
{participant_ids}`, `lobby.request {participant_id, name}` (hosts), `lobby.result {admitted}`
(waiter), `lobby.left {participant_id}` (hosts, when a waiter is denied or disconnects), `chat`,
`reaction`, `hand`, `room.updated {locked?, recording?}`, `room.ended {reason}`. `ack`, `error`,
`pong` are not seq'd. Fanout targets are resolved by a function over the roster (`all`, `hosts`,
`participant`, `all_except`), so group targets for breakouts are an addition later.

Exactly one `welcome` per connection: `{participant_id, role, epoch, seq, state: "joined" | "lobby",
roster?, tracks?, lobby?, room_meta?, media?}`. `state: "lobby"` carries only the ids. `lobby`
(waiting list) is included for hosts. `media = {rtp_capabilities, send_transport, recv_transport}`
(mediasoup transport params: id, ice_parameters, ice_candidates, dtls_parameters). On admit the
waiter receives `lobby.result {admitted: true}` then a `resync` with the full snapshot and media;
on deny `lobby.result {admitted: false}` then close 4003. Lobby waiters also receive `room.ended`.
Waiters count as activity for the idle timer. Waiters do not survive a controller restart: the
rehydrated room drops them and they re-request on their next hello.

Reconnect: `hello {resume_seq, epoch}` within the 30 s grace, with matching epoch, replays
events targeted to that participant with `seq > resume_seq` from the ring buffer (last 500
events or 60 s); otherwise `resync`. `epoch` increments on every fresh create or rehydrate,
because the write-behind checkpoint can lag the live `seq` by up to 50 ms and a restarted
controller could otherwise reissue numbers clients already saw. A newer connection for the same
participant closes the older one (4005) without starting the grace timer. Media transports are
untouched by signaling reconnect. After `resync`, the client compares transport ids with its
own and rebuilds transports if they changed (SFU room was recreated). A resume after the SFU had
to recreate transports is answered with `resync` (new `media`) even when a replay would otherwise
be possible. Lobby waiters have no grace: a waiter whose socket closes leaves the lobby at once
(hosts receive `lobby.left`) and re-requests on the next `hello`.

`departed` map (checkpointed): participant_id -> reason. A `hello` for a departed participant
closes with the matching code: 4002 removed by host, 4003 lobby denied, 4008 grace expired
("rejoin via /join", spec 7.3). Entries pruned after 10 min (token TTL is 5 min). A `hello` from a
non-host while the room is locked closes 4009.

Close codes: 4000 ping timeout, 4001 auth failed, 4002 removed by host, 4003 lobby denied, 4004
room ended, 4005 replaced by newer connection, 4006 protocol error, 4007 capacity, 4008 rejoin
required, 4009 locked.

Deviations from spec 5.2, forced by mediasoup (no SDP on the server) or by uniqueness:
`sdp_offer` / `sdp_answer` / trickle `ice_candidate` replaced by mediasoup parameter blobs;
`track_id` minted by the server and returned in the `publish` ack (client-chosen ids collide across
participants and, later, across cascaded SFUs); `kind` limited to audio/video with a separate
`source` (mediasoup has no screen kind and screen audio needs its own producer); added
`connect_transport`, `consumer_ready`, `ack`. Message semantics (two transports, declarative
subscribe, role from JWT only) unchanged.

### gRPC Sfu (proto/sfu/v1/sfu.proto, spec 5.3 plus MVP additions)

```
AllocateRoom(session_id) -> rtp_capabilities_json                        idempotent
CloseRoom(session_id)                                                     idempotent
CreateTransport(session_id, participant_id, direction) -> transport_id, ice_parameters_json, ice_candidates_json, dtls_parameters_json
ConnectTransport(transport_id, dtls_parameters_json)                     [added]
CloseTransport(transport_id)                                             [added]
RestartIce(transport_id) -> ice_parameters_json                          [added, implemented: mediasoup restartIce]
Publish(session_id, participant_id, transport_id, kind, source, rtp_parameters_json, paused) -> producer_id, track_id, layer_count
Unpublish(producer_id)
SetProducerPaused(producer_id, paused)                                   [added: mute / video off]
Subscribe(session_id, participant_id, transport_id, producer_id, rtp_capabilities_json, max_spatial_layer?, priority?) -> consumer_id, kind, rtp_parameters_json, producer_paused
SetConsumerPaused(consumer_id, paused)                                   [added: consumer_ready, offscreen tiles]
Unsubscribe(consumer_id)                                                 [added]
SetLayer(consumer_id, spatial_layer, temporal_layer, priority?)
Cascade(...) -> UNIMPLEMENTED in MVP (message types defined)
Stats(session_id) -> stream StatsEvent
```

`StatsEvent` oneof: `snapshot` (always first: transports with `direction`, `ice_state`,
`dtls_state` and their full client parameters (`ice_parameters`, `ice_candidates`,
`dtls_parameters` as JSON) so a rehydrated controller can reuse them; producers with `paused`,
`layer_count`; consumers with `preferred_layers`, `current_layers`, `priority`, `paused`,
`producer_paused`; every entity carries its appData `{sfu_id, session_id, participant_id, track_id,
kind, source, origin: local | pipe}`), `dominant_speakers` (every 300 ms, `[{participant_id,
volume}]`), `silence`, `consumer_layers` (on `layerschange`), `producer_score`, `producer_closed`,
`consumer_closed`, `ice_state`, `transport_closed`, `qos` (per transport every
`SFU_QOS_INTERVAL_MS`, default 5000: bytes, rtt, loss; logged only in MVP). mediasoup blobs travel
as JSON strings; ids and enums are typed fields. Error mapping: unknown ids `NOT_FOUND`; wrong room
`PERMISSION_DENIED`; wrong transport direction or incompatible capabilities `FAILED_PRECONDITION`
(Subscribe only needs the recv transport to exist; mediasoup-client connects it on the first
consume); mediasoup errors `INTERNAL` with message. `room_closed` is internal to the SFU; the
stream simply ends when the room closes.

## Components

### services/sfu

- `workers.ts`: `SFU_WORKERS` workers (default cpu count), each `createWebRtcServer` with udp + tcp
  `listenInfos` `{ip: "0.0.0.0", announcedAddress: SFU_ANNOUNCED_IP, port: SFU_MEDIA_PORT_BASE + i}`.
  Worker death -> log + exit (supervisor restarts in later slices).
- `rooms.ts`: `session_id -> {worker, router, audioLevelObserver, participants: Map<participant_id,
  {transports, producers, consumers}>}`. Router codecs: opus/48000/2, VP8 (simulcast), H264
  (packetization-mode 1, profile 42e01f). `AudioLevelObserver {interval: 300, threshold: -60,
  maxEntries: 5}`, every audio producer added on Publish. appData on every entity as above;
  `track_id` = uuid minted here.
- `service.ts`: Connect router implementing the proto. `Subscribe` refuses a producer whose
  appData.session_id differs from the transport's room (`PERMISSION_DENIED`), on top of mediasoup's
  own same-router check. Consumers created `paused: true`; `SetConsumerPaused(false)` after the
  client ack. `SetLayer` -> `setPreferredLayers` + `setPriority`. `SetProducerPaused` ->
  `pause()/resume()`. `Publish` honours `paused`.
- `stats.ts`: per-room async generator for the `Stats` stream: emit snapshot, then fan
  AudioLevelObserver `volumes`/`silence`, consumer `layerschange`, producer `score`, producer and
  consumer close, transport `icestatechange` / `dtlsstatechange`, periodic `getStats` sample.
- `main.ts`: http2 server + `connectNodeAdapter`, `/healthz`, prom metrics (`sfu_rooms`,
  `sfu_transports`).

### services/meeting-api

- `env.ts` (zod): DATABASE_URL, REDIS_URL, OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URL,
  AUTH_DEV_ISSUER, SIGNING_KEY_PEM (ES256, ephemeral if unset outside production), SIGNING_KID,
  DEFAULT_REGION, DEFAULT_ORG_ID, SFU_ID, SIGNALING_PUBLIC_URL, STUN_URLS, TURN_URLS, TURN_SECRET.
- `auth/`: `verifyUser(bearer)`, `signSignalingToken(claims)`, `jwks()`, `devIssuer` plugin.
- `scheduler.ts`: `Scheduler` interface `{place(meeting): Promise<Placement>}`, `StaticScheduler`.
- `meetings/`: repository (postgres.js SQL) + service (code gen, session get-or-create tx, status
  transitions, `:end` via `endSession`) + routes. `join/`: rate limiter interface + in-memory
  impl, join service, route.
- `roomState.ts`: read-only Redis reader for `{room:S}:meta` and roster size.
- `metrics.ts`: `join_latency_seconds`, `join_errors_total{code}`.

### services/signaling

- `gateway/`: `ws` server on `/rooms/:session_id`. Per connection: hello within 5 s or close 4006;
  verify JWT via `createRemoteJWKSet(MEETING_API_JWKS_URL)`, JWT `session_id` must equal path;
  zod-validate every frame; ping accounting; per-connection reaction limiter and chat size check;
  drop connection when `bufferedAmount > 1 MB`. Wraps the socket in a `ParticipantLink {send,
  close}` and hands `(claims, link, message)` to the `RoomController` from `RoomRegistry`. The
  controller never touches `ws`; this interface is the seam for the later gateway/controller split.
- `room/Room.ts`: pure, synchronous state machine. `apply(command): {ok, events, error?}`. Holds
  meta (incl. epoch), roster (with `connected`, `muted`, `video_off`, `hand`), lobby, tracks,
  departed, seq, ring buffer (events with target), peak participants. Authorizes host commands
  from the roster role (set from JWT at hello, never from client payload). Lock rejects non-host
  joins. No I/O, fully unit tested. `toSnapshot()` / `fromSnapshot()` for checkpoint and
  welcome/resync.
- `room/RoomController.ts`: one per live session. Translates WS messages into Room commands plus
  SFU calls. Ordering rule on join/admit: `CreateTransport` x2 first, mutate Room only after both
  succeed (a gRPC failure leaves no partial roster state). Handles `Publish` (with `paused` from
  roster mute state), `Subscribe` diff (create / `Unsubscribe` / `SetLayer` / `SetConsumerPaused`),
  `SetProducerPaused`, `CloseTransport` on leave/remove, `CloseRoom` + `endSession` on end. Fans
  events to links, publishes bus events, schedules the checkpoint. Holds `MediaBindings`
  (participant -> transport ids, track -> producer id, consumer ids), not checkpointed: rebuilt from
  the `Stats` snapshot on rehydrate. On link close: `participant.updated {connected: false}` at
  once, 30 s grace (`DISCONNECT_GRACE_MS`) then leave (`reason: timeout`) and `departed[grace]`.
  Idle room (no roster and no lobby entries for `ROOM_IDLE_TIMEOUT_MS`, default 5 min):
  `endSession(idle)`. Both `host.end` and ctl `end` run the same `endRoom(reason)`:
  `room.ended` fanout, close links 4004, `CloseRoom`, `endSession` (idempotent, so the API path
  having already written it is fine), release lease, drop from registry.
- `room/checkpoint.ts`: write-behind Redis writer, 50 ms coalescing window, pipelined MULTI of
  dirty hashes + `seq`, `EXPIRE 3600`; heartbeat every 5 s refreshes TTL and owner lease;
  `load(session_id)`; `markEnded(session_id)` (status ended, TTL 60 s).
- `room/RoomRegistry.ts`: `getOrCreate(session_id, sfu_hint)`: in-memory -> acquire owner lease
  (fail -> `error CONTROLLER_BUSY`, client retries) -> Redis checkpoint rehydrate (epoch++, every
  roster entry `connected: false` with grace timers; `AllocateRoom` (idempotent) then `Stats`
  snapshot reconciles both ways: checkpointed track with no live producer -> `track.removed`,
  live producer with no checkpointed track -> `track.added`; empty snapshot means the SFU room is
  gone, so transports are recreated on each reconnect and `resync.media` carries the new ids) ->
  fresh room (`AllocateRoom`, epoch 1). SFU client resolved through `SfuDirectory.get(sfu_id)`
  (static map from env now, registry later); `meta.home_sfu` is the source of truth after
  creation, JWT `sfu_hint` only seeds it. Subscribes `room:{S}:ctl`.
- `room/ActiveSpeakerTracker.ts`: hysteresis 300 ms rise / 1 s fall over `dominant_speakers`
  samples, wall-clock aging so a missing sample still ages out, `silence` clears at once; emits
  `active_speakers` on change, at most every 300 ms.
- `sfu-client/`: Connect gRPC clients per sfu_id + `Stats` stream consumer with reconnect and
  re-snapshot reconcile.
- `writer/PostgresWriter.ts`: bus consumer. `participant.joined` -> upsert `participants` by id;
  `participant.left` -> `left_at`, `leave_reason` (upsert); `session.ended` -> `endSession`
  (idempotent backup). Batched, retried, never awaited on the message path.
- `dev/`: client page (vanilla TS + CSS + mediasoup-client, esbuild bundle, distinctive visual
  design, see Context) served at `/dev/` when
  `DEV_HARNESS=true`. Flow: code + name (+ optional bearer) -> `/join` -> hello -> Device.load ->
  transports -> getUserMedia -> produce (video simulcast 180p/150k, 360p/500k, 720p/1.5M; join
  muted honoured via `paused`) -> declarative subscribe to every track in the roster -> tiles,
  mute / video off / hand / reaction / chat / host buttons, active speaker highlight, auto
  reconnect with `resume_seq` + `epoch`, transport rebuild when `resync.media` ids change. Exposes
  `window.__harness` (roster, tracks, seq, epoch, last events, consumer ids, per-consumer
  `getStats` helper) for Playwright.
- `metrics.ts`: `ws_connections`, `room_count`, `checkpoint_lag_ms`, `resync_total`,
  `failover_total`.

### packages/events

Envelope `{id, type, key: session_id, ts, payload}`; `EventBus { publish(event), subscribe(type,
handler) }` with async handlers; `InMemoryEventBus`. Consumers are idempotent (at-least-once
semantics from day one so Kafka slots in later). Event names mirror spec 4.4 topics:
`meeting.lifecycle` (`room.created`, `session.ended`, `host.*` audit) and `participant.events`
(`participant.joined`, `participant.left`, `participant.updated`).

## Core flows (MVP)

1. Join: `POST /join` -> token + urls -> WS `hello` -> lobby (`welcome {state: lobby}`,
   `lobby.request` to hosts) or direct: SFU `CreateTransport` x2 -> Room join -> `welcome {media}`
   -> client `connect_transport` x2 -> `publish` mic + camera -> `subscribe` (full set) ->
   `consumer_ready` per consumer -> media flowing. Fanout `participant.joined`, `track.added`.
   Admit = same transport creation, then `lobby.result` + `resync {media}`.
2. Adaptive subscription: client prefs -> `SetLayer` / `SetConsumerPaused`; SFU `layerschange`
   -> `Stats` -> `track.updated {layers}` fanout.
3. Active speaker: `AudioLevelObserver` -> `Stats dominant_speakers` / `silence` -> tracker ->
   `active_speakers` fanout.
4. Mute: `set_media_state {muted}` / `host.mute` -> `SetProducerPaused` -> `participant.updated` +
   `track.updated {paused}`. Mute state applies to later publishes (join muted).
5. Leave / remove / end: `CloseTransport` (or `CloseRoom`) -> `participant.left` / `track.removed`
   / `room.ended` -> `endSession` (sync) + bus -> PostgresWriter.
6. Signaling reconnect: replay or resync, media untouched. Signaling restart: lease, rehydrate from
   Redis + SFU snapshot (both-way reconcile), epoch bump, clients get `resync`.
7. Control plane end: `POST :end` -> `endSession(api_end)` in Postgres -> ctl publish -> controller
   (if alive) `endRoom(api_end)`.

## Out of scope for this slice (explicit)

Recording (E), breakouts (F), cascade (G, RPC stubbed), Kafka (H), SSO / domain restriction /
residency enforcement (I), etcd registry and real scheduler (D), TURN server deployment (credential
minting supported), ICE restart / media-path reconnection (names reserved), cohost promotion, polls,
chat persistence, OTel tracing, Dockerfiles / K8s, webinar mode, dead-media-path detection beyond
`ice_state` logging (tiles grey out on `connected: false`, tracks drop after grace).

## Verification

- `docker compose up -d` then `pnpm db:migrate` then `pnpm check` (typecheck, prettier, vitest
  unit + integration across all packages) must pass.
- `pnpm test:e2e` runs the nine Playwright scenarios headless on Chromium.
- Manual: `pnpm dev`, open `http://localhost:8081/dev/` in two browser windows, create a meeting
  with a dev token, join by code from both, confirm two-way video, mute, hand, chat, host controls,
  active speaker highlight; kill the signaling process and restart it, confirm both windows
  resync with video still flowing.

## Risks and mitigations

- mediasoup worker on Windows: prebuilt binary downloaded by npm; fallback is
  `MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD` local build (needs MSVC + Python). Verified as the
  first task of Phase 3.
- Fake media in Playwright produces video and a tone; active-speaker assertion checks event shape
  and membership, not who is loudest (hysteresis is unit tested).
- Join storm correctness rests on the partial unique index; covered by the 50-way concurrency test.
- Session end has two writers (controller, meeting-api); `endSession` idempotency plus the Redis
  `ended` flag keep them consistent, covered by Phase 2 and Phase 5 tests.
