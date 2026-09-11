# Plan 4: The Gallery Client and End-to-End Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the browser client served at `/dev/` by the signaling service (vanilla TypeScript, CSS and mediasoup-client, bundled by esbuild at startup) with a distinctive visual identity ("the gallery": a broadcast control room), and the Playwright suite that drives three services and Chromium with fake devices through the design doc's nine end-to-end scenarios.

**Architecture:** `services/signaling/src/dev/client/` is a small browser app with four layers: `signaling.ts` (socket client: hello with resume, request/ack promises, event stream, reconnect with backoff, pings), `state.ts` (a reducer that applies `welcome` / `resync` snapshots and the seq'd events to a `RoomView`), `media.ts` (mediasoup-client `Device`, send/recv transports built from `welcome.media`, produce with simulcast, declarative subscribe, consumer readiness, transport rebuild when a resync carries new transport ids) and `ui.ts` (DOM rendering of the gallery: stage of monitor tiles with tally lamps and audio meters, the rack with roster / green room / talk, the control strip, the tape). `app.ts` wires them and exposes `window.__harness` for Playwright. `src/dev/build.ts` bundles the client with esbuild in memory when `DEV_HARNESS=true` and `app.ts` serves it. `e2e/` is a Playwright workspace whose worker fixture spawns meeting-api, sfu and signaling with short timers, mints a dev host token, creates meetings through the API and opens one browser context per participant.

**Tech Stack:** mediasoup-client 3.23.2, esbuild 0.28.2, @playwright/test 1.63.0 (Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`), Archivo (Google Fonts, variable width axis) with a system fallback, vitest 4.1.11 for the Node-side client tests, TypeScript 5.9.3.

**Spec:** `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md` (sections "WebSocket signaling", "Components > services/signaling > dev/", "Core flows", Phase 6 and 7, "Verification"). Plans 1 to 3 built everything this client talks to. The visual direction below is the design plan produced with the frontend-design skill and is binding for Task 3.

## Global Constraints

- Everything in Plans 1 to 3's Global Constraints still applies: Node `>=24`, pnpm 9.15.9, ESM, TypeScript strict with `moduleResolution: bundler` and `noUncheckedIndexedAccess`, no build step for services (the client bundle is built in memory at startup), `pnpm check` green before every commit (`pnpm check` never runs Playwright: the e2e package exposes `test:e2e`, not `test`), Conventional Commits with the two trailer lines (`Co-Authored-By: <model> <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY`), no em dashes anywhere (code, comments, UI copy, docs, commit messages), branch `feat/mvp-vertical-slice`.
- Pinned versions for this plan: mediasoup-client 3.23.2, esbuild 0.28.2, @playwright/test 1.63.0.
- The client speaks exactly the protocol in `packages/protocol/src/ws`: every request carries an `id` and waits for its `ack` or `error`; `hello` is answered by `ack {mode, epoch, seq}` and then `welcome`, `resync` or replayed events; `ping` every `PING_INTERVAL_MS` (10 s) answered by `pong`; close codes per `CloseCode`. The client never invents fields; anything it needs and cannot get is a protocol change made in Task 0 (this plan adds `producer_id` to `ConsumerParams`).
- The client keeps mediasoup transports across signaling reconnects and rebuilds them only when a `resync.media` carries different transport ids (design doc "Reconnect"); after a rebuild it re-publishes its local tracks and re-subscribes.
- UI copy: sentence case, plain verbs, the same name for an action through its whole flow ("Join" produces a room, "Leave room" leaves it), no all-caps labels, no icons other than the lamps and meters, no emoji in the chrome (reactions are the users' own emoji).
- Accessibility floor: every control is a real `<button>` or `<input>` with a visible label, focus is a 2 px amber outline, `prefers-reduced-motion` disables the tally pulse and meter animation, text contrast at least 4.5:1 against its panel, the page works down to 400 px wide (the rack stacks under the stage).
- e2e timings are set through the spawned services' env: `DISCONNECT_GRACE_MS=10000`, `ROOM_IDLE_TIMEOUT_MS=3000`, `OWNER_LEASE_MS=2000`, `HEARTBEAT_MS=500`, `JOIN_RATE_LIMIT=1000`, `JOIN_RATE_LIMIT_PER_CODE=6`, `AUTH_DEV_ISSUER=true`, `DEV_HARNESS=true`, `SFU_WORKERS=1`, `SFU_MEDIA_PORT_BASE=43000`; ports `8080` / `8081` / `9090` are the real ones (the e2e run owns them; it refuses to start if one is busy). Postgres and Redis are the docker containers on 55432 / 56379 with the `zoomclone` database (migrated by the fixture), not the test database.
- Playwright: `workers: 1`, `fullyParallel: false`, one browser context per participant, Chromium only, `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required`, trace on first retry, screenshots on failure. Chromium is installed once with `pnpm --filter @zoomclone/e2e exec playwright install chromium`.

## Design direction (binding for Task 3)

Subject: a live multi-party video room as seen from a broadcast gallery (a TV control room). The product under test is an SFU pipeline: tracks, layers, active speakers, paused producers, epochs and sequence numbers are the real content of the page, and a gallery is the one place where those things are on screen as a matter of course: monitor walls with tally lamps, audio meters under every source, a running log of what went to air. Audience today: the engineers exercising the backend (and Playwright). Primary job: join fast, see every feed with its live state at a glance, drive every host control, expose the protocol truthfully.

Tokens:
- Color (matte studio surfaces, functional lamps, nothing decorative): `--desk` #2E3236 (matte gunmetal page background), `--panel` #3B4046 (raised modules), `--ink` #E9E5DC (warm off-white text and outlines), `--tally` #E23A2E (on-air red: only the speaking tile's lamp and outline, and the "on air" lamp), `--amber` #F0A63A (caution: muted, camera off, waiting, reconnecting), `--meter` #6FCF6A (meter segments and "connected"), `--well` #1C1F22 (bezel insets and the tape).
- Type: one family, two widths. Archivo (variable, `wdth` axis) from Google Fonts with `"Arial Narrow", Arial, sans-serif` fallbacks. Narrow (`font-stretch: 75%`, weight 600) for tile legends, lamps, counters and buttons; normal width (weight 400) for chat, roster names and prose. Scale 12 / 14 / 17 / 22 / 34 px; line-height 1.35 for legends, 1.5 for prose; `font-variant-numeric: tabular-nums` wherever numbers change. Sentence case everywhere.
- Layout (left-aligned, dense, four bands): tally bar (on-air lamp, timer, room code, epoch, seq, host lock/end buttons), stage (responsive grid of monitor tiles, the local feed labelled "you" and mirrored), rack (roster with the green room on top for hosts, then talk), control strip (five wide rocker-style buttons whose label states the current state: "mic on" / "mic off", "camera on" / "camera off", "raise hand" / "lower hand", reactions, "leave room"), tape (one-line ticker of the last signaling events with seq numbers, newest on the left). Below 900 px the rack stacks under the stage; below 600 px the control strip wraps.
- Tiles are monitor feeds: 1 px ink outline, legend strip under the picture (name, role, source, layer badge "L1" to "L3"), a ten-segment audio meter driven by the local audio level (Web Audio analyser on the received track, on the local mic track for "you"), a tally lamp in the top-left corner lit red while that participant is an active speaker (the outline goes red with it), an amber "camera off" lamp on a black picture when video is paused, a hand marker on the legend when a hand is up, floating reaction emoji over the tile for two seconds.
- Join screen: one panel centred on the desk with "Room code", "Your name", an optional "Host token" field, and one button "Join". Green room (waiting as an attendee): the same panel, the tally bar reads "waiting for the host" in amber with a quiet pulse. Errors are sentences that say what happened and what to do ("That room has ended. Ask the host for a new code.").
- Principles: every color means something operational and the desk stays quiet; type does the labelling; one motion moment (the tally lamp switching on); the protocol is visible (seq, epoch, tape) and not a debug overlay; keyboard focus amber, reduced motion respected, contrast above 4.5:1.
- Checked against the generic default (near-black page, rounded cards, one brand accent, icon toolbar, avatar circles, Inter): the desk is a mid-dark warm grey, accents are three operational lamps, buttons are wide labelled rockers, tiles have legend strips and meters, Archivo in two widths, and the tape has no equivalent in any meeting app. Kept the grid-plus-sidebar arrangement because the content is a wall of feeds plus a list. Removed: scanline texture, numbered tile markers, an all-caps "ON AIR".

## File structure (what this plan creates)

```
packages/protocol/src/ws/common.ts           + producer_id on ConsumerParams (Task 0)
services/signaling/
  package.json                                + mediasoup-client, esbuild; typecheck:client script
  src/env.ts                                  + MEETING_API_PUBLIC_URL
  src/app.ts                                  + /dev/ routes when DEV_HARNESS=true
  src/dev/build.ts                            esbuild in-memory bundle of the client
  src/dev/harness.test.ts                     serves /dev/ (Node test)
  src/dev/client/tsconfig.json                DOM lib, browser-only typecheck
  src/dev/client/index.html                   the page shell (script/css links, config)
  src/dev/client/signaling.ts                 SignalingClient
  src/dev/client/state.ts                     RoomView reducer
  src/dev/client/media.ts                     MediaSession (mediasoup-client)
  src/dev/client/ui.ts                        render(view) into the DOM
  src/dev/client/styles.css                   the gallery
  src/dev/client/app.ts                       entry: wiring + window.__harness
  src/dev/client/signaling.test.ts            Node tests against startTestSignaling (main tsconfig via src/dev/client-node.test.ts)
e2e/
  package.json tsconfig.json playwright.config.ts
  src/services.ts                             spawn/stop/restart the three services, wait for healthz
  src/api.ts                                  dev token, create meeting, join (REST)
  src/fixtures.ts                             test = base.extend({ services, room })
  src/gallery.ts                              page driver: open, join, harness readers
  specs/01-call.spec.ts ... 09-join-errors.spec.ts
README.md                                     + client and e2e sections
```

---

### Task 0: Protocol addition, client build pipeline and `/dev/` serving

**Files:**
- Modify: `packages/protocol/src/ws/common.ts`, `packages/protocol/src/ws/messages.test.ts`, `services/signaling/src/room/controller.ts`, `services/signaling/src/room/controller.test.ts`, `services/signaling/package.json`, `services/signaling/tsconfig.json`, `services/signaling/src/env.ts`, `services/signaling/src/env.test.ts`, `services/signaling/src/app.ts`, `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md`
- Create: `services/signaling/src/dev/build.ts`, `services/signaling/src/dev/harness.test.ts`, `services/signaling/src/dev/client/tsconfig.json`, `services/signaling/src/dev/client/index.html`, `services/signaling/src/dev/client/app.ts` (placeholder entry, replaced in Task 3), `services/signaling/src/dev/client/styles.css` (placeholder, replaced in Task 3)

**Interfaces:**
- Produces: `ConsumerParams.producer_id: string` (protocol) and the controller's subscribe ack filling it; `Env.MEETING_API_PUBLIC_URL` (default `http://localhost:8080`); `buildHarness(opts: { apiBase: string }) -> Promise<HarnessBundle>` with `HarnessBundle = { html: string; js: string; css: string }` (`build.ts`); `createApp` serving `GET /dev/` (html), `/dev/app.js`, `/dev/app.css` when `env.DEV_HARNESS` is true (404 otherwise); `AppDeps.harness?: HarnessBundle` (built by `main.ts` when `DEV_HARNESS=true`).
- mediasoup-client's `transport.consume` requires the producer id, which is why `producer_id` joins `ConsumerParams`.

- [ ] **Step 1: Protocol field (failing test first)**

In `packages/protocol/src/ws/messages.test.ts` add to the server-message tests:

```ts
  it("requires producer_id on consumer params", () => {
    const base = {
      track_id: "t1",
      consumer_id: "c1",
      kind: "audio",
      rtp_parameters: {},
      producer_paused: false,
    };
    expect(ConsumerParamsSchema.safeParse(base).success).toBe(false);
    expect(ConsumerParamsSchema.safeParse({ ...base, producer_id: "p1" }).success).toBe(true);
  });
```

(add `ConsumerParamsSchema` to the existing import). Run: `pnpm --filter @zoomclone/protocol test` -> FAIL.

In `packages/protocol/src/ws/common.ts`, `ConsumerParamsSchema` becomes:

```ts
export const ConsumerParamsSchema = z.object({
  track_id: TrackIdSchema,
  consumer_id: z.string(),
  /** mediasoup-client needs the producer id to build its Consumer. */
  producer_id: z.string(),
  kind: MediaKindSchema,
  rtp_parameters: OpaqueSchema,
  producer_paused: z.boolean(),
});
```

In `services/signaling/src/room/controller.ts`, where `subscribe` pushes onto `consumers`, add `producer_id: producerId,`. In `services/signaling/src/room/controller.test.ts`, in the media test's first subscribe assertion, add `producer_id: "p1"` to the first consumer object and `producer_id: "p2"` to the second. Run: `pnpm --filter @zoomclone/protocol test && pnpm --filter @zoomclone/signaling test -- controller` -> PASS.

In the design doc, table row `subscribe`, change `{consumers: [{track_id, consumer_id, kind, rtp_parameters, producer_paused}], removed: [track_id]}` to `{consumers: [{track_id, consumer_id, producer_id, kind, rtp_parameters, producer_paused}], removed: [track_id]}`.

- [ ] **Step 2: Dependencies, env, client tsconfig**

`services/signaling/package.json`: add to `dependencies` `"esbuild": "0.28.2"` and `"mediasoup-client": "3.23.2"`; change the `typecheck` script to `"tsc -p tsconfig.json && tsc -p src/dev/client/tsconfig.json"`. `services/signaling/tsconfig.json` becomes:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"],
  "exclude": ["src/dev/client"]
}
```

`services/signaling/src/dev/client/tsconfig.json`:

```json
{
  "extends": "../../../../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": []
  },
  "include": ["."]
}
```

`services/signaling/src/env.ts`: add after `MEETING_API_JWKS_URL`:

```ts
  /** Where the browser client posts /v1/join (same origin the API's CORS_ORIGINS allows). */
  MEETING_API_PUBLIC_URL: z.string().default("http://localhost:8080"),
```

and in `env.test.ts` add `expect(env.MEETING_API_PUBLIC_URL).toBe("http://localhost:8080");` to the defaults test. Run `pnpm install`.

- [ ] **Step 3: Build pipeline and serving (failing test first)**

`services/signaling/src/dev/harness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildHarness } from "./build";

describe("dev harness bundle", () => {
  it("bundles the client for the browser and injects the api base", async () => {
    const bundle = await buildHarness({ apiBase: "http://api.test:8080" });
    expect(bundle.html).toContain('<script type="module" src="/dev/app.js">');
    expect(bundle.html).toContain('href="/dev/app.css"');
    expect(bundle.html).toContain("http://api.test:8080");
    expect(bundle.js.length).toBeGreaterThan(1000);
    expect(bundle.js).not.toContain("require(");
    expect(bundle.css).toContain("--desk");
  }, 30_000);
});
```

Run: `pnpm --filter @zoomclone/signaling test -- harness` -> FAIL (`./build` not found).

`services/signaling/src/dev/build.ts`:

```ts
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export type HarnessBundle = { html: string; js: string; css: string };

const clientDir = join(dirname(fileURLToPath(import.meta.url)), "client");

/**
 * Bundles the gallery client in memory (design doc: esbuild bundle served at /dev). One entry,
 * one CSS import, browser platform; the api base is injected into the page shell as config.
 */
export async function buildHarness(opts: { apiBase: string }): Promise<HarnessBundle> {
  const result = await build({
    entryPoints: [join(clientDir, "app.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: "inline",
    outdir: "/dev",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  let js = "";
  let css = "";
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".js")) js = file.text;
    else if (file.path.endsWith(".css")) css = file.text;
  }
  const shell = await readFile(join(clientDir, "index.html"), "utf8");
  const html = shell.replace("__API_BASE__", JSON.stringify(opts.apiBase));
  return { html, js, css };
}
```

`services/signaling/src/dev/client/index.html` (the shell; Task 3 fills the markup but the links and config stay):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>The gallery</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75,600;100,400;100,600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/dev/app.css" />
    <script>
      window.__config = { apiBase: __API_BASE__ };
    </script>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/dev/app.js"></script>
  </body>
</html>
```

Placeholder `services/signaling/src/dev/client/app.ts` (replaced in Task 3):

```ts
import "./styles.css";

const config = (window as unknown as { __config: { apiBase: string } }).__config;
document.getElementById("app")!.textContent = `gallery client placeholder (api ${config.apiBase})`;
```

Placeholder `services/signaling/src/dev/client/styles.css` (replaced in Task 3):

```css
:root {
  --desk: #2e3236;
}
body {
  background: var(--desk);
}
```

`services/signaling/src/app.ts`: add `harness?: HarnessBundle` to `AppDeps` (import the type from `./dev/build`), and before the `/healthz` branch:

```ts
    if (deps.harness && (pathname === "/dev" || pathname === "/dev/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(deps.harness.html);
      return;
    }
    if (deps.harness && pathname === "/dev/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(deps.harness.js);
      return;
    }
    if (deps.harness && pathname === "/dev/app.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(deps.harness.css);
      return;
    }
```

`services/signaling/src/main.ts`: before `createApp`, `const harness = env.DEV_HARNESS ? await buildHarness({ apiBase: env.MEETING_API_PUBLIC_URL }) : undefined;` and pass `harness` into `createApp`; log `{ devHarness: env.DEV_HARNESS }` in the listening line.

Add to `harness.test.ts` a second test that starts the app with the bundle and fetches it:

```ts
import { createTestInfra, silentLog, startTestSignaling } from "../../test/helpers";
import { FakeSfu } from "../../test/fake-sfu";
```

```ts
  it("serves the page, the script and the stylesheet under /dev when enabled", async () => {
    const infra = await createTestInfra();
    const sfu = new FakeSfu();
    await sfu.start();
    const harness = await buildHarness({ apiBase: "http://127.0.0.1:1" });
    const signaling = await startTestSignaling(infra, sfu.baseUrl, { harness });
    try {
      expect((await fetch(`${signaling.httpUrl}/dev/`)).headers.get("content-type")).toContain("text/html");
      expect(await (await fetch(`${signaling.httpUrl}/dev/app.js`)).text()).toBe(harness.js);
      expect((await fetch(`${signaling.httpUrl}/dev/app.css`)).status).toBe(200);
      expect((await fetch(`${signaling.httpUrl}/dev/nope`)).status).toBe(404);
    } finally {
      await signaling.close();
      await sfu.stop();
      await infra.close();
    }
  }, 30_000);
```

In `test/helpers.ts`, extend `startTestSignaling`'s options with `harness?: HarnessBundle` and pass it to `createApp`. Run: `pnpm --filter @zoomclone/signaling test -- harness` -> PASS (2 tests). `pnpm --filter @zoomclone/signaling typecheck` must pass both configs.

- [ ] **Step 4: Full check and commit**

Run: `pnpm check`

```sh
git add packages/protocol services/signaling docs/superpowers/specs pnpm-lock.yaml
git commit -F - <<'EOF'
feat(signaling): bundle and serve the gallery client, add producer_id to consumer params

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 1: Client protocol layer (socket client and room view reducer)

**Files:**
- Create: `services/signaling/src/dev/client/signaling.ts`, `services/signaling/src/dev/client/state.ts`, `services/signaling/src/dev/client/state.test.ts`, `services/signaling/src/dev/client-node.test.ts`

**Interfaces:**
- Consumes: `@zoomclone/protocol` (`ClientMessage`, `ServerMessage`, `ServerMessageSchema`, `RoomEvent`, `Welcome`, `HelloAck`, `HelloAckSchema`, `CloseCode`, `PING_INTERVAL_MS`, `RosterEntry`, `TrackInfo`, `LobbyEntry`, `RoomMeta`, `Role`).
- Produces (`signaling.ts`): `class SignalingClient` with `constructor(opts: { url: string; token: string; onSnapshot(kind: "welcome" | "resync", welcome: Welcome): void; onEvent(event: RoomEvent): void; onStatus(status: ConnectionStatus): void; onClosed(info: CloseInfo): void; log?(line: string): void })`, `connect()`, `request<T extends RequestType>(type: T, payload: PayloadOf<T>): Promise<Record<string, unknown>>` (resolves the ack payload, rejects with `RequestError { code, message }`), `leave()` (close 1000, no reconnect), `drop()` (close 4900 "test drop", reconnects at once with resume), `seq`, `epoch`, `participantId`, `status`, `lastAck: HelloAck | null`, `rtt: number | null`; `ConnectionStatus = "connecting" | "hello" | "lobby" | "joined" | "reconnecting" | "closed"`; `CloseInfo = { code: number; reason: string; terminal: boolean }`; `RequestType = Exclude<ClientMessage["type"], "hello" | "ping">`; `TERMINAL_CLOSE_CODES` (4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 1000).
- Produces (`state.ts`): `RoomView` type, `emptyView()`, `applySnapshot(view, welcome) -> RoomView`, `applyEvent(view, event, now) -> RoomView` (pure, returns new objects), `expireReactions(view, now)`; `RoomView = { participantId: string | null; role: Role | null; epoch: number; seq: number; state: "idle" | "lobby" | "joined" | "ended"; endReason: string | null; roster: RosterEntry[]; tracks: TrackInfo[]; lobby: LobbyEntry[]; meta: RoomMeta | null; activeSpeakers: string[]; layers: Record<string, number>; chat: ChatLine[]; reactions: Reaction[] }`, `ChatLine = { from: string; to?: string; body: string; sentAt: string }`, `Reaction = { from: string; emoji: string; until: number }`.
- Reconnect contract: any close whose code is not terminal (network 1006, server restart 1012, busy 1013, slow consumer 1008, ping timeout 4000, the test drop 4900) reconnects after a backoff (500 ms doubling to 5 s) with `hello { token, resume_seq: seq, epoch }`; the server answers `ack {mode}` then either replayed events (mode `replay`) or a `resync` snapshot; the client emits `onSnapshot("resync", ...)` only for the snapshot case. Terminal codes emit `onClosed({ terminal: true })` and stop.

- [ ] **Step 1: Reducer (failing tests first)**

`services/signaling/src/dev/client/state.test.ts` (typechecked under the client tsconfig; imports only the protocol types and the reducer):

```ts
import { describe, expect, it } from "vitest";
import type { RoomEvent, Welcome } from "@zoomclone/protocol";
import { applyEvent, applySnapshot, emptyView, expireReactions } from "./state";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

const entry = (id: string, role: "host" | "attendee") => ({
  participant_id: id,
  name: id === HOST ? "Host" : "Ann",
  role,
  muted: false,
  video_off: false,
  hand: false,
  connected: true,
  joined_at: "2026-09-10T10:00:00.000Z",
});

const welcome: Welcome = {
  participant_id: A,
  role: "attendee",
  epoch: 1,
  seq: 4,
  state: "joined",
  roster: [entry(HOST, "host"), entry(A, "attendee")],
  tracks: [{ track_id: "t1", owner: HOST, kind: "video", source: "camera", paused: false, layers: 3 }],
  room_meta: {
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    locked: false,
    lobby_enabled: true,
    recording: false,
    host_ids: [HOST],
    max_participants: 10,
  },
};

function ev(seq: number, type: RoomEvent["type"], payload: unknown): RoomEvent {
  return { type, seq, payload } as RoomEvent;
}

describe("room view reducer", () => {
  it("applies a snapshot and ignores events at or below its seq", () => {
    const view = applySnapshot(emptyView(), welcome);
    expect(view.state).toBe("joined");
    expect(view.roster.map((r) => r.participant_id)).toEqual([HOST, A]);
    expect(view.tracks).toHaveLength(1);
    expect(view.seq).toBe(4);
    const stale = applyEvent(view, ev(4, "reaction", { from: HOST, emoji: "x" }), 0);
    expect(stale).toBe(view);
  });

  it("tracks roster, tracks, hands, chat, reactions, speakers, layers and room meta", () => {
    let view = applySnapshot(emptyView(), welcome);
    view = applyEvent(view, ev(5, "participant.joined", { participant: entry("33333333-3333-4333-8333-333333333333", "attendee") }), 0);
    expect(view.roster).toHaveLength(3);
    view = applyEvent(view, ev(6, "participant.updated", { participant_id: A, patch: { muted: true, connected: false } }), 0);
    expect(view.roster.find((r) => r.participant_id === A)).toMatchObject({ muted: true, connected: false });
    view = applyEvent(view, ev(7, "track.added", { track: { track_id: "t2", owner: A, kind: "audio", source: "mic", paused: true, layers: 1 } }), 0);
    view = applyEvent(view, ev(8, "track.updated", { track_id: "t2", patch: { paused: false } }), 0);
    expect(view.tracks.find((t) => t.track_id === "t2")?.paused).toBe(false);
    view = applyEvent(view, ev(9, "track.updated", { track_id: "t1", patch: { layers: 2 } }), 0);
    expect(view.layers["t1"]).toBe(2);
    view = applyEvent(view, ev(10, "track.removed", { track_id: "t2" }), 0);
    expect(view.tracks.map((t) => t.track_id)).toEqual(["t1"]);
    view = applyEvent(view, ev(11, "hand", { participant_id: A, raised: true }), 0);
    expect(view.roster.find((r) => r.participant_id === A)?.hand).toBe(true);
    view = applyEvent(view, ev(12, "chat", { from: HOST, body: "hi", sent_at: "2026-09-10T10:01:00.000Z" }), 0);
    expect(view.chat).toEqual([{ from: HOST, body: "hi", sentAt: "2026-09-10T10:01:00.000Z" }]);
    view = applyEvent(view, ev(13, "reaction", { from: HOST, emoji: "clap" }), 1_000);
    expect(view.reactions).toEqual([{ from: HOST, emoji: "clap", until: 3_000 }]);
    expect(expireReactions(view, 3_001).reactions).toEqual([]);
    view = applyEvent(view, ev(14, "active_speakers", { participant_ids: [HOST] }), 0);
    expect(view.activeSpeakers).toEqual([HOST]);
    view = applyEvent(view, ev(15, "room.updated", { locked: true }), 0);
    expect(view.meta?.locked).toBe(true);
    view = applyEvent(view, ev(16, "participant.left", { participant_id: A, reason: "removed" }), 0);
    expect(view.roster.map((r) => r.participant_id)).not.toContain(A);
    view = applyEvent(view, ev(17, "room.ended", { reason: "host_end" }), 0);
    expect(view.state).toBe("ended");
    expect(view.endReason).toBe("host_end");
    expect(view.seq).toBe(17);
  });

  it("keeps the lobby list for hosts and handles lobby events", () => {
    const hostWelcome: Welcome = {
      ...welcome,
      participant_id: HOST,
      role: "host",
      lobby: [{ participant_id: A, name: "Ann", requested_at: "2026-09-10T10:00:00.000Z" }],
    };
    let view = applySnapshot(emptyView(), hostWelcome);
    expect(view.lobby).toHaveLength(1);
    view = applyEvent(view, ev(5, "lobby.request", { participant_id: "44444444-4444-4444-8444-444444444444", name: "Wren" }), 0);
    expect(view.lobby).toHaveLength(2);
    view = applyEvent(view, ev(6, "lobby.left", { participant_id: A }), 0);
    expect(view.lobby.map((l) => l.participant_id)).toEqual(["44444444-4444-4444-8444-444444444444"]);
    const waiter = applySnapshot(emptyView(), { participant_id: A, role: "attendee", epoch: 1, seq: 2, state: "lobby" });
    expect(waiter.state).toBe("lobby");
    expect(applyEvent(waiter, ev(3, "lobby.result", { admitted: false }), 0).state).toBe("lobby");
  });
});
```

Run: `pnpm --filter @zoomclone/signaling test -- state.test` -> FAIL (`./state` not found).

`services/signaling/src/dev/client/state.ts`:

```ts
import type { LobbyEntry, Role, RoomEvent, RoomMeta, RosterEntry, TrackInfo, Welcome } from "@zoomclone/protocol";

export type ChatLine = { from: string; to?: string; body: string; sentAt: string };
export type Reaction = { from: string; emoji: string; until: number };

export type RoomView = {
  participantId: string | null;
  role: Role | null;
  epoch: number;
  seq: number;
  state: "idle" | "lobby" | "joined" | "ended";
  endReason: string | null;
  roster: RosterEntry[];
  tracks: TrackInfo[];
  lobby: LobbyEntry[];
  meta: RoomMeta | null;
  activeSpeakers: string[];
  /** Spatial layers delivered to this client per track (track.updated {layers}). */
  layers: Record<string, number>;
  chat: ChatLine[];
  reactions: Reaction[];
};

export const REACTION_MS = 2_000;
const CHAT_KEEP = 200;

export function emptyView(): RoomView {
  return {
    participantId: null,
    role: null,
    epoch: 0,
    seq: 0,
    state: "idle",
    endReason: null,
    roster: [],
    tracks: [],
    lobby: [],
    meta: null,
    activeSpeakers: [],
    layers: {},
    chat: [],
    reactions: [],
  };
}

/** welcome and resync replace everything the snapshot carries; chat and reactions are kept. */
export function applySnapshot(view: RoomView, welcome: Welcome): RoomView {
  return {
    ...view,
    participantId: welcome.participant_id,
    role: welcome.role,
    epoch: welcome.epoch,
    seq: welcome.seq,
    state: welcome.state,
    endReason: null,
    roster: welcome.roster ?? [],
    tracks: welcome.tracks ?? [],
    lobby: welcome.lobby ?? [],
    meta: welcome.room_meta ?? null,
    activeSpeakers: [],
    layers: {},
  };
}

export function expireReactions(view: RoomView, now: number): RoomView {
  if (view.reactions.every((r) => r.until > now)) return view;
  return { ...view, reactions: view.reactions.filter((r) => r.until > now) };
}

/** Applies one seq'd event; events at or below the view's seq are duplicates and are ignored. */
export function applyEvent(view: RoomView, event: RoomEvent, now: number): RoomView {
  if (event.seq <= view.seq) return view;
  const next: RoomView = { ...view, seq: event.seq };
  switch (event.type) {
    case "participant.joined":
      next.roster = [...view.roster.filter((r) => r.participant_id !== event.payload.participant.participant_id), event.payload.participant];
      next.lobby = view.lobby.filter((l) => l.participant_id !== event.payload.participant.participant_id);
      return next;
    case "participant.left":
      next.roster = view.roster.filter((r) => r.participant_id !== event.payload.participant_id);
      next.tracks = view.tracks.filter((t) => t.owner !== event.payload.participant_id);
      next.activeSpeakers = view.activeSpeakers.filter((id) => id !== event.payload.participant_id);
      return next;
    case "participant.updated":
      next.roster = view.roster.map((r) =>
        r.participant_id === event.payload.participant_id ? { ...r, ...event.payload.patch } : r,
      );
      return next;
    case "track.added":
      next.tracks = [...view.tracks.filter((t) => t.track_id !== event.payload.track.track_id), event.payload.track];
      return next;
    case "track.removed": {
      next.tracks = view.tracks.filter((t) => t.track_id !== event.payload.track_id);
      const { [event.payload.track_id]: _dropped, ...layers } = view.layers;
      next.layers = layers;
      return next;
    }
    case "track.updated":
      if (event.payload.patch.paused !== undefined) {
        const paused = event.payload.patch.paused;
        next.tracks = view.tracks.map((t) => (t.track_id === event.payload.track_id ? { ...t, paused } : t));
      }
      if (event.payload.patch.layers !== undefined) {
        next.layers = { ...view.layers, [event.payload.track_id]: event.payload.patch.layers };
      }
      return next;
    case "active_speakers":
      next.activeSpeakers = event.payload.participant_ids;
      return next;
    case "lobby.request":
      next.lobby = [
        ...view.lobby.filter((l) => l.participant_id !== event.payload.participant_id),
        { participant_id: event.payload.participant_id, name: event.payload.name, requested_at: new Date(now).toISOString() },
      ];
      return next;
    case "lobby.left":
      next.lobby = view.lobby.filter((l) => l.participant_id !== event.payload.participant_id);
      return next;
    case "lobby.result":
      // The snapshot that follows an admit carries the room; a denial is followed by close 4003.
      return next;
    case "chat": {
      const line: ChatLine =
        event.payload.to === undefined
          ? { from: event.payload.from, body: event.payload.body, sentAt: event.payload.sent_at }
          : { from: event.payload.from, to: event.payload.to, body: event.payload.body, sentAt: event.payload.sent_at };
      next.chat = [...view.chat, line].slice(-CHAT_KEEP);
      return next;
    }
    case "reaction":
      next.reactions = [...view.reactions, { from: event.payload.from, emoji: event.payload.emoji, until: now + REACTION_MS }];
      return next;
    case "hand":
      next.roster = view.roster.map((r) =>
        r.participant_id === event.payload.participant_id ? { ...r, hand: event.payload.raised } : r,
      );
      return next;
    case "room.updated":
      next.meta = view.meta ? { ...view.meta, ...stripUndefined(event.payload) } : view.meta;
      return next;
    case "room.ended":
      next.state = "ended";
      next.endReason = event.payload.reason;
      return next;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
```

Run: `pnpm --filter @zoomclone/signaling test -- state.test` -> PASS (3 tests).

- [ ] **Step 2: Socket client (failing Node test first)**

`services/signaling/src/dev/client-node.test.ts` (under the main tsconfig; Node 24's global `WebSocket` stands in for the browser's):

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloseCode, type RoomEvent, type Welcome } from "@zoomclone/protocol";
import { FakeSfu } from "../../test/fake-sfu";
import { createTestInfra, mintClaims, mintToken, seedSession, startTestSignaling, waitFor, type TestInfra, type TestSignaling } from "../../test/helpers";
import { SignalingClient, type CloseInfo, type ConnectionStatus } from "./client/signaling";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

let infra: TestInfra;
let sfu: FakeSfu;
let signaling: TestSignaling;
let sessionId: string;
const clients: SignalingClient[] = [];

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
  for (const c of clients) c.leave();
  clients.length = 0;
  await signaling.close();
  await sfu.stop();
});

type Recorder = {
  client: SignalingClient;
  snapshots: Array<{ kind: "welcome" | "resync"; welcome: Welcome }>;
  events: RoomEvent[];
  statuses: ConnectionStatus[];
  closes: CloseInfo[];
};

async function open(participantId: string, role: "host" | "attendee" = "attendee", lobby = false): Promise<Recorder> {
  const token = await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: participantId, role, lobby }));
  const rec: Recorder = { client: null as unknown as SignalingClient, snapshots: [], events: [], statuses: [], closes: [] };
  rec.client = new SignalingClient({
    url: `${signaling.url}/rooms/${sessionId}`,
    token,
    onSnapshot: (kind, welcome) => rec.snapshots.push({ kind, welcome }),
    onEvent: (event) => rec.events.push(event),
    onStatus: (status) => rec.statuses.push(status),
    onClosed: (info) => rec.closes.push(info),
  });
  clients.push(rec.client);
  rec.client.connect();
  await waitFor(() => rec.snapshots.length > 0 || rec.closes.length > 0);
  return rec;
}

describe("SignalingClient", () => {
  it("joins with hello, receives the welcome, and answers requests with acks and errors", async () => {
    const host = await open(HOST, "host");
    expect(host.snapshots[0]).toMatchObject({ kind: "welcome", welcome: { state: "joined", role: "host" } });
    expect(host.client.status).toBe("joined");
    expect(host.client.lastAck).toMatchObject({ mode: "welcome", epoch: 1 });
    await expect(host.client.request("raise_hand", {})).resolves.toEqual({});
    await expect(host.client.request("host.admit", { participant_id: A })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ann = await open(A);
    await waitFor(() => host.events.some((e) => e.type === "participant.joined"));
    expect(ann.client.seq).toBe(ann.snapshots[0]!.welcome.seq);
    await ann.client.request("chat", { body: "hello" });
    const chat = await waitFor(() => host.events.find((e) => e.type === "chat"));
    expect(chat).toBeDefined();
    expect(host.client.seq).toBe(chat!.seq);
  });

  it("reports the lobby state and the admission resync", async () => {
    const host = await open(HOST, "host");
    const waiter = await open(A, "attendee", true);
    expect(waiter.snapshots[0]).toMatchObject({ kind: "welcome", welcome: { state: "lobby" } });
    expect(waiter.client.status).toBe("lobby");
    await host.client.request("host.admit", { participant_id: A });
    await waitFor(() => waiter.snapshots.length === 2);
    expect(waiter.snapshots[1]).toMatchObject({ kind: "resync", welcome: { state: "joined" } });
    expect(waiter.client.status).toBe("joined");
  });

  it("reconnects after a dropped socket with a replay, and resyncs after the server restarts", async () => {
    const host = await open(HOST, "host");
    const ann = await open(A);
    ann.client.drop();
    await host.client.request("reaction", { emoji: "wave" });
    await waitFor(() => ann.client.lastAck?.mode === "replay");
    await waitFor(() => ann.events.some((e) => e.type === "reaction"));
    expect(ann.snapshots).toHaveLength(1);
    expect(ann.statuses).toContain("reconnecting");
    expect(ann.client.status).toBe("joined");

    // The controller goes away (as on a process restart) while the registry stays: the next hello
    // rehydrates the room from Redis with a new epoch, so the client is answered with a resync.
    await signaling.registry.peek(sessionId)!.close();
    await waitFor(() => ann.snapshots.length === 2, 5_000);
    expect(ann.snapshots[1]).toMatchObject({ kind: "resync", welcome: { epoch: 2 } });
    expect(ann.client.epoch).toBe(2);
  });

  it("stops on terminal closes and rejects pending requests", async () => {
    const host = await open(HOST, "host");
    const ann = await open(A);
    await host.client.request("host.remove", { participant_id: A });
    await waitFor(() => ann.closes.length > 0);
    expect(ann.closes[0]).toMatchObject({ code: CloseCode.REMOVED, terminal: true });
    expect(ann.client.status).toBe("closed");
    await expect(ann.client.request("raise_hand", {})).rejects.toMatchObject({ code: "CLOSED" });
    const late = await open(A);
    expect(late.closes[0]?.code).toBe(CloseCode.REMOVED);
  });

  it("measures pings and leaves cleanly", async () => {
    const host = await open(HOST, "host");
    await waitFor(() => host.client.rtt !== null, 3_000);
    host.client.leave();
    await waitFor(() => host.closes.length > 0);
    expect(host.closes[0]).toMatchObject({ code: 1000, terminal: true });
  });
});
```

The ping test needs the client to send its first ping right after the hello ack (then every `PING_INTERVAL_MS`), so `rtt` is measured within a few milliseconds.

Run: `pnpm --filter @zoomclone/signaling test -- client-node` -> FAIL (`./client/signaling` not found).

`services/signaling/src/dev/client/signaling.ts`:

```ts
import {
  CloseCode,
  HelloAckSchema,
  PING_INTERVAL_MS,
  ServerMessageSchema,
  type ClientMessage,
  type HelloAck,
  type RoomEvent,
  type ServerMessage,
  type Welcome,
} from "@zoomclone/protocol";

export type ConnectionStatus = "connecting" | "hello" | "lobby" | "joined" | "reconnecting" | "closed";
export type CloseInfo = { code: number; reason: string; terminal: boolean };
export type RequestType = Exclude<ClientMessage["type"], "hello" | "ping">;
export type PayloadOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>["payload"];

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/** Closes after which a reconnect is pointless (design doc close codes plus a normal leave). */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  1000,
  CloseCode.AUTH_FAILED,
  CloseCode.REMOVED,
  CloseCode.LOBBY_DENIED,
  CloseCode.ROOM_ENDED,
  CloseCode.REPLACED,
  CloseCode.PROTOCOL_ERROR,
  CloseCode.CAPACITY,
  CloseCode.REJOIN_REQUIRED,
  CloseCode.LOCKED,
]);

const DROP_CODE = 4900;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5_000;

export type SignalingClientOptions = {
  url: string;
  token: string;
  onSnapshot: (kind: "welcome" | "resync", welcome: Welcome) => void;
  onEvent: (event: RoomEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  onClosed: (info: CloseInfo) => void;
  log?: (line: string) => void;
};

type Pending = { resolve: (payload: Record<string, unknown>) => void; reject: (error: RequestError) => void };

/**
 * The browser side of the signaling protocol: one socket at a time, hello with resume on every
 * (re)connect, request/ack correlation by id, pings, and reconnect with backoff on any close
 * that is not terminal. Media is someone else's job (media.ts); this class only moves frames.
 */
export class SignalingClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private hello: { id: string; mode: HelloAck["mode"] | null } | null = null;
  private _status: ConnectionStatus = "connecting";
  private _seq = 0;
  private _epoch: number | null = null;
  private _participantId: string | null = null;
  private _lastAck: HelloAck | null = null;
  private _rtt: number | null = null;

  constructor(private readonly opts: SignalingClientOptions) {}

  get status(): ConnectionStatus {
    return this._status;
  }
  get seq(): number {
    return this._seq;
  }
  get epoch(): number | null {
    return this._epoch;
  }
  get participantId(): string | null {
    return this._participantId;
  }
  get lastAck(): HelloAck | null {
    return this._lastAck;
  }
  get rtt(): number | null {
    return this._rtt;
  }

  connect(): void {
    if (this.stopped || this.socket) return;
    const socket = new WebSocket(this.opts.url);
    this.socket = socket;
    socket.addEventListener("open", () => this.onOpen(socket));
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    socket.addEventListener("close", (event) => this.onClose(socket, event.code, event.reason));
    socket.addEventListener("error", () => undefined);
  }

  /** Sends a request and resolves with its ack payload. */
  request<T extends RequestType>(type: T, payload: PayloadOf<T>): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || (this._status !== "joined" && this._status !== "lobby")) {
      return Promise.reject(new RequestError("CLOSED", "not connected"));
    }
    const id = this.nextId(type);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type, id, payload } satisfies ClientMessage));
    });
  }

  /** Intentional leave: no reconnect. */
  leave(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, "leaving");
    if (!this.socket) this.setStatus("closed");
  }

  /** Test hook: closes the socket like a lost network would and reconnects at once. */
  drop(): void {
    this.socket?.close(DROP_CODE, "test drop");
  }

  private onOpen(socket: WebSocket): void {
    this.setStatus("hello");
    const id = this.nextId("hello");
    this.hello = { id, mode: null };
    const payload: PayloadOf<"hello"> =
      this._epoch === null ? { token: this.opts.token } : { token: this.opts.token, resume_seq: this._seq, epoch: this._epoch };
    socket.send(JSON.stringify({ type: "hello", id, payload } satisfies ClientMessage));
  }

  private onMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.opts.log?.(`unparsable frame: ${raw.slice(0, 80)}`);
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.opts.log?.(`frame failed the schema: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "ack":
        return this.onAck(message.id, message.payload);
      case "error":
        return this.onError(message.id, message.payload);
      case "pong":
        this._rtt = Date.now() - message.payload.ts;
        return;
      case "welcome":
      case "resync":
        return this.onSnapshot(message.type, message.payload);
      default:
        return this.onEvent(message);
    }
  }

  private onAck(id: string, payload: Record<string, unknown>): void {
    if (this.hello && id === this.hello.id) {
      const ack = HelloAckSchema.safeParse(payload);
      if (!ack.success) {
        this.opts.log?.("hello ack failed the schema");
        return;
      }
      this.hello.mode = ack.data.mode;
      this._lastAck = ack.data;
      this._epoch = ack.data.epoch;
      this.backoff = BACKOFF_MIN_MS;
      if (ack.data.mode === "replay") {
        // Nothing else announces the resumed session: the state is whatever it was, plus the
        // replayed events. The server's cursor is authoritative for the next resume.
        this._seq = Math.max(this._seq, ack.data.seq);
        this.setStatus(this._status === "lobby" ? "lobby" : "joined");
        this.hello = null;
      }
      this.startPings();
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(payload);
  }

  private onError(id: string | undefined, payload: { code: string; message: string }): void {
    if (id === undefined) {
      this.opts.log?.(`server error: ${payload.code} ${payload.message}`);
      return;
    }
    if (this.hello && id === this.hello.id) {
      this.opts.log?.(`hello refused: ${payload.code} ${payload.message}`);
      return; // the close that follows carries the code
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(new RequestError(payload.code, payload.message));
  }

  private onSnapshot(kind: "welcome" | "resync", welcome: Welcome): void {
    this._seq = welcome.seq;
    this._epoch = welcome.epoch;
    this._participantId = welcome.participant_id;
    this.hello = null;
    this.setStatus(welcome.state === "lobby" ? "lobby" : "joined");
    this.opts.onSnapshot(kind, welcome);
  }

  private onEvent(event: RoomEvent): void {
    if (event.seq > this._seq) this._seq = event.seq;
    this.opts.onEvent(event);
  }

  private onClose(socket: WebSocket, code: number, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.hello = null;
    this.clearTimers();
    for (const pending of this.pending.values()) pending.reject(new RequestError("CLOSED", `socket closed (${code})`));
    this.pending.clear();
    const terminal = this.stopped || TERMINAL_CLOSE_CODES.has(code);
    if (terminal) {
      this.stopped = true;
      this.setStatus("closed");
      this.opts.onClosed({ code, reason, terminal: true });
      return;
    }
    this.opts.onClosed({ code, reason, terminal: false });
    this.setStatus("reconnecting");
    const delay = code === DROP_CODE ? 0 : this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const ping = () => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "ping", id: this.nextId("ping"), payload: { ts: Date.now() } } satisfies ClientMessage));
    };
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.opts.onStatus(status);
  }

  private nextId(type: string): string {
    return `${type}-${++this.counter}`;
  }
}
```

Run: `pnpm --filter @zoomclone/signaling test -- client-node state.test` -> PASS (5 + 3 tests). `pnpm --filter @zoomclone/signaling typecheck` passes both configs (the client tsconfig typechecks `signaling.ts` against the DOM `WebSocket`, the main one against Node's).

- [ ] **Step 3: Full check and commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(client): add the signaling client and the room view reducer

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 2: Media layer (mediasoup-client session)

**Files:**
- Create: `services/signaling/src/dev/client/media.ts`

**Interfaces:**
- Consumes: `SignalingClient.request` (Task 1), `mediasoup-client` (`Device`, `types`), protocol types `MediaParams`, `ConsumerParams`, `SubscriptionPref`, `MediaKind`, `MediaSource`.
- Produces: `class MediaSession` with `constructor(signaling: SignalingClient, events: MediaEvents)`, `applyMedia(media: MediaParams, iceServers: RTCIceServer[]) -> Promise<"created" | "kept" | "rebuilt">`, `captureLocal() -> Promise<LocalTracks>`, `publishLocal(state: { muted: boolean; videoOff: boolean }) -> Promise<void>`, `setMuted(muted) -> Promise<void>`, `setVideoOff(off) -> Promise<void>`, `syncPaused(state)`, `subscribe(trackIds: string[], prefs?: Record<string, SubscriptionPref>) -> Promise<void>` (declarative full set), `consumerFor(trackId) -> Consumer | undefined`, `feeds() -> RemoteFeed[]`, `localTrackIds() -> { audio: string | null; video: string | null }`, `stats(trackId) -> Promise<FeedStats>`, `close()`; `MediaEvents = { onFeed(feed: RemoteFeed): void; onFeedRemoved(trackId: string): void; log?(line: string): void }`; `RemoteFeed = { trackId: string; kind: "audio" | "video"; consumerId: string; track: MediaStreamTrack }`; `LocalTracks = { audio: MediaStreamTrack | null; video: MediaStreamTrack | null }`; `FeedStats = { packetsReceived: number; framesDecoded: number; bytesReceived: number }`; `SIMULCAST_ENCODINGS` (180p/150k, 360p/500k, 720p/1.5M per the design doc).
- No Node test (WebRTC needs a browser); Task 4's e2e covers every method. Keep the module free of DOM access apart from `navigator.mediaDevices`.

- [ ] **Step 1: Implement**

`services/signaling/src/dev/client/media.ts`:

```ts
import { Device, type types as msc } from "mediasoup-client";
import type { ConsumerParams, MediaKind, MediaParams, SubscriptionPref } from "@zoomclone/protocol";
import { RequestError, type SignalingClient } from "./signaling";

export type LocalTracks = { audio: MediaStreamTrack | null; video: MediaStreamTrack | null };
export type RemoteFeed = { trackId: string; kind: MediaKind; consumerId: string; track: MediaStreamTrack };
export type FeedStats = { packetsReceived: number; framesDecoded: number; bytesReceived: number };
export type MediaEvents = {
  onFeed: (feed: RemoteFeed) => void;
  onFeedRemoved: (trackId: string) => void;
  log?: (line: string) => void;
};

/** Design doc: 180p/150k, 360p/500k, 720p/1.5M. */
export const SIMULCAST_ENCODINGS: RTCRtpEncodingParameters[] = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
];

type Opaque = Record<string, unknown>;

/**
 * mediasoup-client glue: transports from welcome.media, local producers, declarative consumers.
 * Transports survive signaling reconnects; a resync whose transport ids differ rebuilds them and
 * republishes / resubscribes (design doc "Reconnect").
 */
export class MediaSession {
  private device: Device | null = null;
  private send: msc.Transport | null = null;
  private recv: msc.Transport | null = null;
  private transportIds: { send: string; recv: string } | null = null;
  private producers = new Map<MediaKind, { producer: msc.Producer; trackId: string }>();
  private consumers = new Map<string, msc.Consumer>();
  private desired: string[] = [];
  private prefs: Record<string, SubscriptionPref> = {};
  private local: LocalTracks = { audio: null, video: null };
  private state = { muted: false, videoOff: false };
  private published = false;

  constructor(
    private readonly signaling: SignalingClient,
    private readonly events: MediaEvents,
  ) {}

  /** Creates the transports on the first snapshot; on a resync keeps them unless the ids changed. */
  async applyMedia(media: MediaParams, iceServers: RTCIceServer[]): Promise<"created" | "kept" | "rebuilt"> {
    const ids = { send: media.send_transport.id, recv: media.recv_transport.id };
    if (this.transportIds && this.transportIds.send === ids.send && this.transportIds.recv === ids.recv) {
      return "kept";
    }
    const rebuilt = this.transportIds !== null;
    this.teardownTransports();
    if (!this.device) {
      this.device = new Device();
      await this.device.load({ routerRtpCapabilities: media.rtp_capabilities as msc.RtpCapabilities });
    }
    this.send = this.device.createSendTransport({ ...transportOptions(media.send_transport), iceServers });
    this.recv = this.device.createRecvTransport({ ...transportOptions(media.recv_transport), iceServers });
    this.wireTransport(this.send, "send");
    this.wireTransport(this.recv, "recv");
    this.transportIds = ids;
    if (rebuilt) {
      this.events.log?.("transports rebuilt, republishing and resubscribing");
      if (this.published) await this.publishLocal(this.state);
      await this.subscribe(this.desired, this.prefs);
      return "rebuilt";
    }
    return "created";
  }

  async captureLocal(): Promise<LocalTracks> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.local = { audio: stream.getAudioTracks()[0] ?? null, video: stream.getVideoTracks()[0] ?? null };
    return this.local;
  }

  get localTracks(): LocalTracks {
    return this.local;
  }

  /** Produces mic and camera; paused flags travel with the publish so a muted join stays muted. */
  async publishLocal(state: { muted: boolean; videoOff: boolean }): Promise<void> {
    const send = this.requireTransport(this.send, "send");
    this.state = { ...state };
    this.published = true;
    for (const p of this.producers.values()) p.producer.close();
    this.producers.clear();
    if (this.local.audio) {
      const producer = await send.produce({
        track: this.local.audio,
        appData: { source: "mic", paused: state.muted },
      });
      if (state.muted) producer.pause();
      this.producers.set("audio", { producer, trackId: producer.id });
    }
    if (this.local.video) {
      const producer = await send.produce({
        track: this.local.video,
        encodings: SIMULCAST_ENCODINGS,
        codecOptions: { videoGoogleStartBitrate: 1000 },
        appData: { source: "camera", paused: state.videoOff },
      });
      if (state.videoOff) producer.pause();
      this.producers.set("video", { producer, trackId: producer.id });
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    this.state.muted = muted;
    const audio = this.producers.get("audio");
    if (audio) (muted ? audio.producer.pause() : audio.producer.resume());
    await this.signaling.request("set_media_state", { muted });
  }

  async setVideoOff(videoOff: boolean): Promise<void> {
    this.state.videoOff = videoOff;
    const video = this.producers.get("video");
    if (video) (videoOff ? video.producer.pause() : video.producer.resume());
    await this.signaling.request("set_media_state", { video_off: videoOff });
  }

  /** The roster is the truth (a host mute pauses the producer server side): mirror it locally. */
  syncPaused(state: { muted: boolean; videoOff: boolean }): void {
    this.state = { ...state };
    const audio = this.producers.get("audio");
    if (audio && audio.producer.paused !== state.muted) (state.muted ? audio.producer.pause() : audio.producer.resume());
    const video = this.producers.get("video");
    if (video && video.producer.paused !== state.videoOff) (state.videoOff ? video.producer.pause() : video.producer.resume());
  }

  /** Declarative: the full set of remote tracks to receive, with optional per-track prefs. */
  async subscribe(trackIds: string[], prefs: Record<string, SubscriptionPref> = {}): Promise<void> {
    this.desired = [...trackIds];
    this.prefs = { ...prefs };
    const recv = this.recv;
    const device = this.device;
    if (!recv || !device) return;
    const ack = (await this.signaling.request("subscribe", {
      rtp_capabilities: device.rtpCapabilities as Opaque,
      track_ids: trackIds,
      prefs,
    })) as { consumers: ConsumerParams[]; removed: string[] };
    for (const trackId of ack.removed) this.dropConsumer(trackId);
    for (const params of ack.consumers) {
      const consumer = await recv.consume({
        id: params.consumer_id,
        producerId: params.producer_id,
        kind: params.kind,
        rtpParameters: params.rtp_parameters as unknown as msc.RtpParameters,
        appData: { trackId: params.track_id },
      });
      this.consumers.set(params.track_id, consumer);
      consumer.on("transportclose", () => this.dropConsumer(params.track_id));
      this.events.onFeed({ trackId: params.track_id, kind: params.kind, consumerId: consumer.id, track: consumer.track });
      try {
        await this.signaling.request("consumer_ready", { track_id: params.track_id });
      } catch (error) {
        if (!(error instanceof RequestError && error.code === "NOT_FOUND")) throw error;
      }
    }
    // Tracks the server no longer knows (removed while we were away) get no consumer; drop stale ones.
    for (const trackId of [...this.consumers.keys()]) {
      if (!this.desired.includes(trackId)) this.dropConsumer(trackId);
    }
  }

  consumerFor(trackId: string): msc.Consumer | undefined {
    return this.consumers.get(trackId);
  }

  feeds(): RemoteFeed[] {
    return [...this.consumers].map(([trackId, c]) => ({ trackId, kind: c.kind as MediaKind, consumerId: c.id, track: c.track }));
  }

  localTrackIds(): { audio: string | null; video: string | null } {
    return { audio: this.producers.get("audio")?.trackId ?? null, video: this.producers.get("video")?.trackId ?? null };
  }

  async stats(trackId: string): Promise<FeedStats> {
    const consumer = this.consumers.get(trackId);
    const out: FeedStats = { packetsReceived: 0, framesDecoded: 0, bytesReceived: 0 };
    if (!consumer) return out;
    const report = await consumer.getStats();
    report.forEach((entry: { type?: string; packetsReceived?: number; framesDecoded?: number; bytesReceived?: number }) => {
      if (entry.type !== "inbound-rtp") return;
      out.packetsReceived += entry.packetsReceived ?? 0;
      out.framesDecoded += entry.framesDecoded ?? 0;
      out.bytesReceived += entry.bytesReceived ?? 0;
    });
    return out;
  }

  close(): void {
    this.teardownTransports();
    for (const track of [this.local.audio, this.local.video]) track?.stop();
    this.local = { audio: null, video: null };
    this.published = false;
  }

  private wireTransport(transport: msc.Transport, direction: "send" | "recv"): void {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      this.signaling
        .request("connect_transport", { transport: direction, dtls_parameters: dtlsParameters as unknown as Opaque })
        .then(() => callback())
        .catch((error: unknown) => errback(error instanceof Error ? error : new Error(String(error))));
    });
    if (direction === "send") {
      transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
        const data = appData as { source: "mic" | "camera"; paused: boolean };
        this.signaling
          .request("publish", {
            kind,
            source: data.source,
            rtp_parameters: rtpParameters as unknown as Opaque,
            paused: data.paused,
          })
          .then((ack) => callback({ id: String(ack["track_id"]) }))
          .catch((error: unknown) => errback(error instanceof Error ? error : new Error(String(error))));
      });
    }
    transport.on("connectionstatechange", (state) => this.events.log?.(`${direction} transport ${state}`));
  }

  private dropConsumer(trackId: string): void {
    const consumer = this.consumers.get(trackId);
    if (!consumer) return;
    this.consumers.delete(trackId);
    consumer.close();
    this.events.onFeedRemoved(trackId);
  }

  private teardownTransports(): void {
    for (const trackId of [...this.consumers.keys()]) this.dropConsumer(trackId);
    for (const p of this.producers.values()) p.producer.close();
    this.producers.clear();
    this.send?.close();
    this.recv?.close();
    this.send = null;
    this.recv = null;
    this.transportIds = null;
  }

  private requireTransport(transport: msc.Transport | null, direction: string): msc.Transport {
    if (!transport) throw new Error(`no ${direction} transport yet (waiting for welcome)`);
    return transport;
  }
}

function transportOptions(params: MediaParams["send_transport"]): msc.TransportOptions {
  return {
    id: params.id,
    iceParameters: params.ice_parameters as unknown as msc.IceParameters,
    iceCandidates: params.ice_candidates as unknown as msc.IceCandidate[],
    dtlsParameters: params.dtls_parameters as unknown as msc.DtlsParameters,
  };
}
```

Run: `pnpm --filter @zoomclone/signaling typecheck` (the client tsconfig typechecks `media.ts` against the DOM and mediasoup-client types; adjust only the casts if mediasoup-client's option types differ).

- [ ] **Step 2: Commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(client): add the mediasoup-client media session

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 3: The gallery (page shell, styles, renderer, app wiring, harness API)

**Files:**
- Modify: `services/signaling/src/dev/client/index.html`, `services/signaling/src/dev/client/app.ts`, `services/signaling/src/dev/client/styles.css`
- Create: `services/signaling/src/dev/client/ui.ts`, `services/signaling/src/dev/client/levels.ts`

**Interfaces:**
- Consumes: `SignalingClient`, `state.ts`, `MediaSession` (Tasks 1 and 2), `@zoomclone/protocol` types and `JoinResponseSchema` / `ErrorBodySchema` for the REST call.
- Produces: `window.__harness: Harness` with `Harness = { view(): RoomView; status(): ConnectionStatus; sessionId(): string | null; participantId(): string | null; epoch(): number | null; seq(): number; events: RoomEvent[]; closes: CloseInfo[]; snapshots: Array<{ kind: "welcome" | "resync"; seq: number; epoch: number }>; lastAck(): HelloAck | null; joinResponse(): JoinResponse | null; consumers(): Array<{ track_id: string; consumer_id: string; kind: string }>; localTracks(): { audio: string | null; video: string | null }; stats(trackId: string): Promise<FeedStats>; frames(trackId: string): number; levels(): Record<string, number>; dropSocket(): void; setLayer(trackId: string, maxLayer: number): Promise<void>; lastError(): string | null; joinError(): { status: number; code: string } | null }`. Every `data-testid` below is part of the contract with Task 4.
- `ui.ts` exports `createUi(root: HTMLElement, actions: UiActions) -> Ui` with `Ui.render(model: UiModel)`, `Ui.attachFeed(trackId, kind, track)`, `Ui.detachFeed(trackId)`, `Ui.attachLocal(tracks: LocalTracks)`, `Ui.frames(trackId)`; `UiModel = { screen: "join" | "waiting" | "room" | "ended" | "closed"; status: ConnectionStatus; view: RoomView; roomCode: string; sessionId: string | null; localState: { muted: boolean; videoOff: boolean }; levels: Record<string, number>; error: string | null; sinceMs: number | null }`; `UiActions = { join(input: { code: string; name: string; token: string }): void; leave(): void; toggleMic(): void; toggleCamera(): void; toggleHand(): void; react(emoji: string): void; chat(body: string): void; admit(pid: string): void; deny(pid: string): void; mute(pid: string): void; remove(pid: string): void; setLock(locked: boolean): void; end(): void; setLayer(trackId: string, maxLayer: number): void }`.
- `levels.ts` exports `class LevelMeter` (`attach(key: string, track: MediaStreamTrack)`, `detach(key)`, `read() -> Record<string, number>` in 0..1, `close()`): a Web Audio analyser per track, created lazily on the first attach (after the join click, so autoplay policy allows the AudioContext).

- [ ] **Step 1: Page shell and styles**

Replace `services/signaling/src/dev/client/index.html`'s body with:

```html
  <body>
    <main id="app" class="desk" data-screen="join"></main>
    <script type="module" src="/dev/app.js"></script>
  </body>
```

(head unchanged from Task 0). Replace `services/signaling/src/dev/client/styles.css` with the gallery stylesheet:

```css
:root {
  --desk: #2e3236;
  --panel: #3b4046;
  --ink: #e9e5dc;
  --ink-dim: #b9b4a8;
  --tally: #e23a2e;
  --amber: #f0a63a;
  --meter: #6fcf6a;
  --well: #1c1f22;
  --outline: 1px solid rgba(233, 229, 220, 0.55);
  --narrow: "Archivo", "Arial Narrow", Arial, sans-serif;
  --body: "Archivo", Arial, sans-serif;
  --stretch: 75%;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  height: 100%;
  background: var(--desk);
  color: var(--ink);
  font-family: var(--body);
  font-size: 14px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}

button,
input,
textarea {
  font: inherit;
  color: inherit;
}

:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 2px;
}

.legend {
  font-family: var(--narrow);
  font-stretch: var(--stretch);
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: 0.01em;
}

/* Bands */
.desk {
  min-height: 100%;
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  grid-template-areas:
    "tally tally"
    "stage rack"
    "strip strip"
    "tape tape";
  gap: 1px;
  padding: 1px;
}

.desk[data-screen="join"],
.desk[data-screen="waiting"],
.desk[data-screen="ended"],
.desk[data-screen="closed"] {
  grid-template-areas:
    "tally tally"
    "panel panel"
    "strip strip"
    "tape tape";
}

@media (max-width: 900px) {
  .desk {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "tally"
      "stage"
      "rack"
      "strip"
      "tape";
  }
}

/* Tally bar */
.tally-bar {
  grid-area: tally;
  background: var(--panel);
  padding: 10px 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 22px;
  font-size: 17px;
}

.lamp {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--well);
  background: var(--well);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.6);
  vertical-align: -2px;
  margin-right: 8px;
}

.lamp[data-on="tally"] {
  background: var(--tally);
  box-shadow: 0 0 10px rgba(226, 58, 46, 0.7);
}

.lamp[data-on="amber"] {
  background: var(--amber);
  box-shadow: 0 0 8px rgba(240, 166, 58, 0.6);
  animation: pulse 1.6s ease-in-out infinite;
}

.lamp[data-on="meter"] {
  background: var(--meter);
}

@keyframes pulse {
  50% {
    opacity: 0.45;
  }
}

.tally-bar .spacer {
  flex: 1;
}

.counter {
  color: var(--ink-dim);
}

.counter b {
  color: var(--ink);
  font-weight: 600;
}

/* Rocker buttons */
.rocker {
  font-family: var(--narrow);
  font-stretch: var(--stretch);
  font-weight: 600;
  font-size: 15px;
  background: var(--well);
  border: var(--outline);
  border-radius: 3px;
  color: var(--ink);
  padding: 9px 18px;
  cursor: pointer;
  min-width: 112px;
}

.rocker[aria-pressed="true"] {
  background: var(--ink);
  color: var(--well);
}

.rocker[data-tone="amber"][aria-pressed="true"] {
  background: var(--amber);
}

.rocker[data-tone="tally"] {
  border-color: var(--tally);
  color: var(--tally);
}

.rocker.small {
  min-width: 0;
  padding: 3px 9px;
  font-size: 13px;
}

.rocker:disabled {
  opacity: 0.45;
  cursor: default;
}

/* Stage and monitors */
.stage {
  grid-area: stage;
  background: var(--desk);
  padding: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  grid-auto-rows: min-content;
  gap: 12px;
  align-content: start;
  min-width: 0;
}

.monitor {
  background: var(--panel);
  border: var(--outline);
  border-radius: 3px;
  padding: 6px;
  position: relative;
  min-width: 0;
}

.monitor[data-speaking="true"] {
  border-color: var(--tally);
  box-shadow: 0 0 0 1px var(--tally);
}

.monitor .picture {
  position: relative;
  aspect-ratio: 16 / 9;
  background: var(--well);
  overflow: hidden;
}

.monitor video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  background: var(--well);
}

.monitor[data-mirror="true"] video {
  transform: scaleX(-1);
}

.monitor .picture .lamp {
  position: absolute;
  top: 8px;
  left: 8px;
  margin: 0;
}

.monitor .off-notice {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--ink-dim);
  font-size: 17px;
}

.monitor .reaction {
  position: absolute;
  right: 10px;
  bottom: 10px;
  font-size: 34px;
  line-height: 1;
  animation: float 2s ease-out forwards;
}

@keyframes float {
  to {
    transform: translateY(-40px);
    opacity: 0;
  }
}

.monitor .legend-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 2px 2px;
  font-size: 14px;
  min-width: 0;
}

.monitor .legend-strip .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  color: var(--ink-dim);
}

.badge[data-tone="amber"] {
  color: var(--amber);
}

.meter {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 2px;
  height: 8px;
  margin-top: 6px;
}

.meter i {
  display: block;
  background: var(--well);
  border-radius: 1px;
}

.meter i[data-lit="true"] {
  background: var(--meter);
}

.meter i:nth-child(n + 9)[data-lit="true"] {
  background: var(--amber);
}

/* Rack */
.rack {
  grid-area: rack;
  background: var(--panel);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.module h2 {
  margin: 0 0 8px;
  font-size: 17px;
}

.roster,
.green-room {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.roster li,
.green-room li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.roster li .name {
  flex: 1;
}

.talk .lines {
  background: var(--well);
  border-radius: 3px;
  padding: 8px 10px;
  height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.talk .lines .who {
  color: var(--ink-dim);
  margin-right: 6px;
}

.talk form {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.talk input,
.join input {
  flex: 1;
  background: var(--well);
  border: var(--outline);
  border-radius: 3px;
  padding: 8px 10px;
  min-width: 0;
}

/* Control strip */
.strip {
  grid-area: strip;
  background: var(--panel);
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.strip .spacer {
  flex: 1;
}

.reactions {
  display: flex;
  gap: 4px;
}

.reactions .rocker {
  min-width: 0;
  padding: 6px 12px;
}

/* Tape */
.tape {
  grid-area: tape;
  background: var(--well);
  color: var(--ink-dim);
  padding: 6px 14px;
  overflow-x: auto;
  white-space: nowrap;
  font-size: 12px;
}

.tape span {
  margin-right: 18px;
}

.tape b {
  color: var(--ink);
  font-weight: 600;
  margin-right: 6px;
}

/* Join panel and notices */
.panel-band {
  grid-area: panel;
  display: grid;
  place-items: center;
  padding: 40px 16px;
}

.join {
  background: var(--panel);
  border: var(--outline);
  border-radius: 3px;
  padding: 24px;
  width: min(100%, 420px);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.join h1 {
  margin: 0;
  font-size: 34px;
  line-height: 1.1;
}

.join label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.join .error,
.notice {
  color: var(--amber);
}

@media (prefers-reduced-motion: reduce) {
  .lamp[data-on="amber"],
  .monitor .reaction {
    animation: none;
  }
}
```

- [ ] **Step 2: Levels**

`services/signaling/src/dev/client/levels.ts`:

```ts
/** One analyser per track; read() returns a 0..1 level per key for the tile meters. */
export class LevelMeter {
  private context: AudioContext | null = null;
  private readonly nodes = new Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; data: Uint8Array }>();

  attach(key: string, track: MediaStreamTrack): void {
    if (track.kind !== "audio") return;
    this.detach(key);
    this.context ??= new AudioContext();
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.nodes.set(key, { source, analyser, data: new Uint8Array(analyser.frequencyBinCount) });
  }

  detach(key: string): void {
    const node = this.nodes.get(key);
    if (!node) return;
    node.source.disconnect();
    this.nodes.delete(key);
  }

  read(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, node] of this.nodes) {
      node.analyser.getByteTimeDomainData(node.data);
      let peak = 0;
      for (const sample of node.data) peak = Math.max(peak, Math.abs(sample - 128) / 128);
      out[key] = Math.min(1, peak * 1.5);
    }
    return out;
  }

  close(): void {
    for (const key of [...this.nodes.keys()]) this.detach(key);
    void this.context?.close();
    this.context = null;
  }
}
```

- [ ] **Step 3: Renderer**

`services/signaling/src/dev/client/ui.ts`:

```ts
import type { RosterEntry } from "@zoomclone/protocol";
import type { LocalTracks } from "./media";
import type { ConnectionStatus } from "./signaling";
import type { RoomView } from "./state";

export type UiModel = {
  screen: "join" | "waiting" | "room" | "ended" | "closed";
  status: ConnectionStatus;
  view: RoomView;
  roomCode: string;
  sessionId: string | null;
  localState: { muted: boolean; videoOff: boolean };
  levels: Record<string, number>;
  error: string | null;
  sinceMs: number | null;
};

export type UiActions = {
  join: (input: { code: string; name: string; token: string }) => void;
  leave: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleHand: () => void;
  react: (emoji: string) => void;
  chat: (body: string) => void;
  admit: (participantId: string) => void;
  deny: (participantId: string) => void;
  mute: (participantId: string) => void;
  remove: (participantId: string) => void;
  setLock: (locked: boolean) => void;
  end: () => void;
  setLayer: (trackId: string, maxLayer: number) => void;
};

export type Ui = {
  render: (model: UiModel) => void;
  attachFeed: (trackId: string, kind: "audio" | "video", track: MediaStreamTrack) => void;
  detachFeed: (trackId: string) => void;
  attachLocal: (tracks: LocalTracks) => void;
  frames: (trackId: string) => number;
};

const REACTIONS = ["👍", "👏", "👋"];
const LOCAL = "you";

type Tile = {
  root: HTMLElement;
  video: HTMLVideoElement;
  stream: MediaStream;
  lamp: HTMLElement;
  offNotice: HTMLElement;
  name: HTMLElement;
  badges: HTMLElement;
  meter: HTMLElement[];
  reaction: HTMLElement | null;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function rocker(label: string, onClick: () => void, opts: { pressed?: boolean; tone?: string; small?: boolean; testId?: string } = {}): HTMLButtonElement {
  const button = el("button", `rocker${opts.small ? " small" : ""}`, label);
  button.type = "button";
  if (opts.pressed !== undefined) button.setAttribute("aria-pressed", String(opts.pressed));
  if (opts.tone) button.dataset["tone"] = opts.tone;
  if (opts.testId) button.dataset["testid"] = opts.testId;
  button.addEventListener("click", onClick);
  return button;
}

function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Imperative renderer. Tiles are keyed by participant id and kept across renders so their
 * <video> elements never restart; everything else is rebuilt from the model on each render.
 */
export function createUi(root: HTMLElement, actions: UiActions): Ui {
  const tiles = new Map<string, Tile>();
  const feedOwner = new Map<string, string>();
  const frameCounts = new Map<string, number>();
  let localTracks: LocalTracks = { audio: null, video: null };
  let lastModel: UiModel | null = null;

  const tallyBar = el("header", "tally-bar legend");
  const panelBand = el("section", "panel-band");
  const stage = el("section", "stage");
  const rack = el("aside", "rack");
  const strip = el("footer", "strip");
  const tape = el("div", "tape legend");
  tape.dataset["testid"] = "tape";
  root.replaceChildren(tallyBar, panelBand, stage, rack, strip, tape);

  function tileFor(participantId: string, mirror: boolean): Tile {
    const existing = tiles.get(participantId);
    if (existing) return existing;
    const rootEl = el("article", "monitor");
    rootEl.dataset["testid"] = `tile-${participantId}`;
    rootEl.dataset["mirror"] = String(mirror);
    const picture = el("div", "picture");
    const video = el("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = mirror;
    const stream = new MediaStream();
    video.srcObject = stream;
    const lamp = el("span", "lamp");
    const offNotice = el("div", "off-notice legend", "camera off");
    offNotice.hidden = true;
    picture.append(video, lamp, offNotice);
    const legend = el("div", "legend-strip legend");
    const name = el("span", "name");
    const badges = el("span", "badges");
    legend.append(name, badges);
    const meterEl = el("div", "meter");
    const meter: HTMLElement[] = [];
    for (let i = 0; i < 10; i++) {
      const seg = el("i");
      meterEl.append(seg);
      meter.push(seg);
    }
    rootEl.append(picture, legend, meterEl);
    const tile: Tile = { root: rootEl, video, stream, lamp, offNotice, name, badges, meter, reaction: null };
    tiles.set(participantId, tile);
    return tile;
  }

  function trackVideoFrames(trackId: string, video: HTMLVideoElement): void {
    frameCounts.set(trackId, 0);
    const tick = () => {
      if (!feedOwner.has(trackId)) return;
      frameCounts.set(trackId, (frameCounts.get(trackId) ?? 0) + 1);
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  function renderTile(tile: Tile, entry: RosterEntry, model: UiModel, isLocal: boolean): void {
    const speaking = model.view.activeSpeakers.includes(entry.participant_id);
    tile.root.dataset["speaking"] = String(speaking);
    tile.lamp.dataset["on"] = speaking ? "tally" : entry.connected ? "" : "amber";
    tile.name.textContent = isLocal ? `${entry.name} (you)` : entry.name;
    const badges: Array<[string, string?]> = [];
    if (entry.role !== "attendee") badges.push([entry.role]);
    if (entry.hand) badges.push(["hand up", "amber"]);
    if (entry.muted) badges.push(["mic off", "amber"]);
    if (!entry.connected) badges.push(["reconnecting", "amber"]);
    const videoTrack = model.view.tracks.find((t) => t.owner === entry.participant_id && t.kind === "video");
    if (videoTrack) {
      const delivered = model.view.layers[videoTrack.track_id];
      if (!isLocal) badges.push([`L${delivered ?? videoTrack.layers}`]);
      if (!isLocal && videoTrack.layers > 1) {
        // Layer choice as a badge button: L1 asks for the lowest layer, L3 for everything.
      }
    }
    tile.badges.replaceChildren(
      ...badges.map(([text, tone]) => {
        const b = el("span", "badge", text);
        if (tone) b.dataset["tone"] = tone;
        return b;
      }),
    );
    const cameraOff = isLocal ? model.localState.videoOff : (videoTrack?.paused ?? true);
    tile.offNotice.hidden = !cameraOff;
    tile.offNotice.textContent = videoTrack || isLocal ? "camera off" : "no camera";
    const level = model.levels[isLocal ? LOCAL : entry.participant_id] ?? 0;
    const lit = Math.round(level * 10);
    tile.meter.forEach((seg, i) => (seg.dataset["lit"] = String(i < lit)));
    const reaction = model.view.reactions.filter((r) => r.from === entry.participant_id).at(-1);
    if (reaction && (!tile.reaction || tile.reaction.dataset["until"] !== String(reaction.until))) {
      tile.reaction?.remove();
      const bubble = el("span", "reaction", reaction.emoji);
      bubble.dataset["until"] = String(reaction.until);
      tile.root.querySelector(".picture")?.append(bubble);
      tile.reaction = bubble;
    } else if (!reaction && tile.reaction) {
      tile.reaction.remove();
      tile.reaction = null;
    }
  }

  function renderTallyBar(model: UiModel): void {
    const lamp = el("span", "lamp");
    const status = el("span");
    const spacer = el("span", "spacer");
    tallyBar.replaceChildren(lamp, status);
    if (model.screen === "room") {
      lamp.dataset["on"] = model.status === "joined" ? "tally" : "amber";
      status.textContent = model.status === "joined" ? `on air ${model.sinceMs === null ? "" : fmtClock(model.sinceMs)}` : "reconnecting";
      status.dataset["testid"] = "air-status";
      tallyBar.append(counter("room", model.roomCode), counter("epoch", String(model.view.epoch)), counter("seq", String(model.view.seq)), spacer);
      if (model.view.role === "host" || model.view.role === "cohost") {
        const locked = model.view.meta?.locked ?? false;
        tallyBar.append(
          rocker(locked ? "unlock room" : "lock room", () => actions.setLock(!locked), { pressed: locked, tone: "amber", small: true, testId: "lock" }),
          rocker("end for everyone", () => actions.end(), { tone: "tally", small: true, testId: "end" }),
        );
      }
    } else if (model.screen === "waiting") {
      lamp.dataset["on"] = "amber";
      status.textContent = "waiting for the host";
      status.dataset["testid"] = "air-status";
    } else if (model.screen === "ended") {
      status.textContent = "off air";
      status.dataset["testid"] = "air-status";
    } else {
      status.textContent = "the gallery";
    }
  }

  function counter(label: string, value: string): HTMLElement {
    const node = el("span", "counter", `${label} `);
    const b = el("b", undefined, value);
    b.dataset["testid"] = `counter-${label}`;
    node.append(b);
    return node;
  }

  function renderPanel(model: UiModel): void {
    panelBand.replaceChildren();
    panelBand.hidden = model.screen === "room";
    if (model.screen === "join") {
      const form = el("form", "join");
      form.dataset["testid"] = "join-form";
      const title = el("h1", "legend", "Join a room");
      const code = labelled("Room code", "code", "xxx-xxxx-xxx");
      const name = labelled("Your name", "name", "");
      const token = labelled("Host token (optional)", "token", "");
      const submit = rocker("Join", () => undefined, { testId: "join" });
      submit.type = "submit";
      form.append(title, code.label, name.label, token.label, submit);
      if (model.error) form.append(errorLine(model.error));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        actions.join({ code: code.input.value.trim(), name: name.input.value.trim(), token: token.input.value.trim() });
      });
      panelBand.append(form);
    } else if (model.screen === "waiting") {
      const box = el("div", "join");
      box.append(el("h1", "legend", "Green room"), el("p", undefined, "The host has been told you are here. This page updates on its own."));
      if (model.error) box.append(errorLine(model.error));
      box.append(rocker("Leave", () => actions.leave(), { testId: "leave" }));
      panelBand.append(box);
    } else if (model.screen === "ended" || model.screen === "closed") {
      const box = el("div", "join");
      box.dataset["testid"] = "ended-panel";
      box.append(el("h1", "legend", model.screen === "ended" ? "This room has ended" : "You left the room"));
      if (model.error) box.append(errorLine(model.error));
      box.append(rocker("Join another room", () => window.location.reload(), { testId: "again" }));
      panelBand.append(box);
    }
  }

  function labelled(text: string, testId: string, placeholder: string): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = el("label");
    label.append(el("span", "legend", text));
    const input = el("input");
    input.placeholder = placeholder;
    input.dataset["testid"] = `input-${testId}`;
    input.autocomplete = "off";
    label.append(input);
    return { label, input };
  }

  function errorLine(text: string): HTMLElement {
    const line = el("p", "error", text);
    line.dataset["testid"] = "error";
    return line;
  }

  function renderStage(model: UiModel): void {
    stage.hidden = model.screen !== "room";
    if (model.screen !== "room") return;
    const seen = new Set<string>();
    const me = model.view.participantId;
    const ordered = [...model.view.roster].sort((a, b) => (a.participant_id === me ? 1 : b.participant_id === me ? -1 : 0));
    for (const entry of ordered) {
      const isLocal = entry.participant_id === me;
      const tile = tileFor(entry.participant_id, isLocal);
      if (isLocal && localTracks.video && tile.stream.getVideoTracks().length === 0) {
        tile.stream.addTrack(localTracks.video);
        tile.video.srcObject = tile.stream;
      }
      renderTile(tile, entry, model, isLocal);
      seen.add(entry.participant_id);
      if (!tile.root.isConnected) stage.append(tile.root);
    }
    for (const [pid, tile] of tiles) {
      if (!seen.has(pid)) {
        tile.root.remove();
        tiles.delete(pid);
      }
    }
  }

  function renderRack(model: UiModel): void {
    rack.hidden = model.screen !== "room";
    if (model.screen !== "room") return;
    rack.replaceChildren();
    const isHost = model.view.role === "host" || model.view.role === "cohost";
    if (isHost) {
      const green = el("section", "module");
      green.append(el("h2", "legend", `Green room (${model.view.lobby.length})`));
      const list = el("ul", "green-room");
      list.dataset["testid"] = "green-room";
      for (const waiter of model.view.lobby) {
        const li = el("li");
        li.dataset["testid"] = `waiter-${waiter.participant_id}`;
        li.append(
          el("span", "name", waiter.name),
          rocker("let in", () => actions.admit(waiter.participant_id), { small: true, testId: `admit-${waiter.participant_id}` }),
          rocker("not now", () => actions.deny(waiter.participant_id), { small: true, tone: "amber", testId: `deny-${waiter.participant_id}` }),
        );
        list.append(li);
      }
      if (model.view.lobby.length === 0) list.append(el("li", "badge", "nobody waiting"));
      green.append(list);
      rack.append(green);
    }
    const roster = el("section", "module");
    roster.append(el("h2", "legend", `In the room (${model.view.roster.length})`));
    const list = el("ul", "roster");
    list.dataset["testid"] = "roster";
    for (const entry of model.view.roster) {
      const li = el("li");
      li.dataset["testid"] = `roster-${entry.participant_id}`;
      const lamp = el("span", "lamp");
      lamp.dataset["on"] = entry.connected ? "meter" : "amber";
      const flags: string[] = [];
      if (entry.role !== "attendee") flags.push(entry.role);
      if (entry.muted) flags.push("mic off");
      if (entry.hand) flags.push("hand up");
      li.append(lamp, el("span", "name", entry.name), el("span", "badge legend", flags.join(", ")));
      if (isHost && entry.participant_id !== model.view.participantId && entry.role === "attendee") {
        li.append(
          rocker("mute", () => actions.mute(entry.participant_id), { small: true, testId: `mute-${entry.participant_id}` }),
          rocker("remove", () => actions.remove(entry.participant_id), { small: true, tone: "tally", testId: `remove-${entry.participant_id}` }),
        );
      }
      list.append(li);
    }
    roster.append(list);
    const talk = el("section", "module talk");
    talk.append(el("h2", "legend", "Talk"));
    const lines = el("div", "lines");
    lines.dataset["testid"] = "chat-lines";
    const names = new Map(model.view.roster.map((r) => [r.participant_id, r.name]));
    for (const line of model.view.chat) {
      const p = el("div");
      const who = el("span", "who legend", `${names.get(line.from) ?? "someone"}${line.to ? ` to ${names.get(line.to) ?? "someone"}` : ""}`);
      p.append(who, document.createTextNode(line.body));
      lines.append(p);
    }
    const form = el("form");
    const input = el("input");
    input.placeholder = "Type a message";
    input.dataset["testid"] = "chat-input";
    const send = rocker("Send", () => undefined, { small: true, testId: "chat-send" });
    send.type = "submit";
    form.append(input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (input.value.trim()) actions.chat(input.value.trim());
      input.value = "";
    });
    talk.append(lines, form);
    rack.append(roster, talk);
    lines.scrollTop = lines.scrollHeight;
  }

  function renderStrip(model: UiModel): void {
    strip.replaceChildren();
    strip.hidden = model.screen !== "room";
    if (model.screen !== "room") return;
    const me = model.view.roster.find((r) => r.participant_id === model.view.participantId);
    strip.append(
      rocker(model.localState.muted ? "mic off" : "mic on", () => actions.toggleMic(), { pressed: !model.localState.muted, testId: "mic" }),
      rocker(model.localState.videoOff ? "camera off" : "camera on", () => actions.toggleCamera(), { pressed: !model.localState.videoOff, testId: "camera" }),
      rocker(me?.hand ? "lower hand" : "raise hand", () => actions.toggleHand(), { pressed: me?.hand ?? false, tone: "amber", testId: "hand" }),
    );
    const reactions = el("div", "reactions");
    for (const emoji of REACTIONS) reactions.append(rocker(emoji, () => actions.react(emoji), { small: true, testId: `react-${emoji}` }));
    strip.append(reactions, el("span", "spacer"), rocker("leave room", () => actions.leave(), { tone: "tally", testId: "leave" }));
  }

  function renderTape(model: UiModel): void {
    tape.replaceChildren();
    if (model.screen !== "room" && model.screen !== "waiting") return;
    const lines = model.view.chat.length; // keeps the tape honest about being event-driven
    void lines;
    for (const item of tapeItems) {
      const span = el("span");
      span.append(el("b", undefined, String(item.seq)), document.createTextNode(item.text));
      tape.append(span);
    }
  }

  const tapeItems: Array<{ seq: number; text: string }> = [];

  return {
    render(model) {
      lastModel = model;
      root.dataset["screen"] = model.screen;
      renderTallyBar(model);
      renderPanel(model);
      renderStage(model);
      renderRack(model);
      renderStrip(model);
      renderTape(model);
    },
    attachFeed(trackId, kind, track) {
      const owner = lastModel?.view.tracks.find((t) => t.track_id === trackId)?.owner;
      if (!owner) return;
      feedOwner.set(trackId, owner);
      const tile = tileFor(owner, false);
      for (const old of tile.stream.getTracks()) if (old.kind === kind) tile.stream.removeTrack(old);
      tile.stream.addTrack(track);
      tile.video.srcObject = tile.stream;
      if (kind === "video") trackVideoFrames(trackId, tile.video);
    },
    detachFeed(trackId) {
      const owner = feedOwner.get(trackId);
      feedOwner.delete(trackId);
      frameCounts.delete(trackId);
      const tile = owner ? tiles.get(owner) : undefined;
      if (!tile) return;
      for (const track of tile.stream.getTracks()) if (track.id !== localTracks.video?.id) tile.stream.removeTrack(track);
    },
    attachLocal(tracks) {
      localTracks = tracks;
    },
    frames(trackId) {
      return frameCounts.get(trackId) ?? 0;
    },
  };

  // The tape is fed by app.ts through this closure-level array; exposed via a property below.
  // (see app.ts: ui.tape.push)
}
```

The tape needs an input from `app.ts`: add to the `Ui` type `tape: (seq: number, text: string) => void` and implement it inside `createUi` as `tape(seq, text) { tapeItems.unshift({ seq, text }); if (tapeItems.length > 40) tapeItems.pop(); }` (then remove the two placeholder lines `const lines = ...; void lines;` from `renderTape` and the trailing comment). Remove the empty `if (!isLocal && videoTrack.layers > 1) {}` block in `renderTile`: layer prefs are set through `window.__harness` / the `setLayer` action, which Task 4 drives; the badge shows the delivered layer.

- [ ] **Step 4: App wiring and the harness API**

Replace `services/signaling/src/dev/client/app.ts` with:

```ts
import "./styles.css";
import { ErrorBodySchema, JoinResponseSchema, type HelloAck, type JoinResponse, type RoomEvent, type SubscriptionPref } from "@zoomclone/protocol";
import { LevelMeter } from "./levels";
import { MediaSession, type FeedStats } from "./media";
import { SignalingClient, type CloseInfo, type ConnectionStatus } from "./signaling";
import { applyEvent, applySnapshot, emptyView, expireReactions, type RoomView } from "./state";
import { createUi, type UiModel } from "./ui";

type Config = { apiBase: string };
const config = (window as unknown as { __config: Config }).__config;

export type Harness = {
  view: () => RoomView;
  status: () => ConnectionStatus;
  sessionId: () => string | null;
  participantId: () => string | null;
  epoch: () => number | null;
  seq: () => number;
  events: RoomEvent[];
  closes: CloseInfo[];
  snapshots: Array<{ kind: "welcome" | "resync"; seq: number; epoch: number }>;
  lastAck: () => HelloAck | null;
  joinResponse: () => JoinResponse | null;
  consumers: () => Array<{ track_id: string; consumer_id: string; kind: string }>;
  localTracks: () => { audio: string | null; video: string | null };
  stats: (trackId: string) => Promise<FeedStats>;
  frames: (trackId: string) => number;
  levels: () => Record<string, number>;
  dropSocket: () => void;
  setLayer: (trackId: string, maxLayer: number) => Promise<void>;
  lastError: () => string | null;
  joinError: () => { status: number; code: string } | null;
};

const root = document.getElementById("app")!;
let view: RoomView = emptyView();
let screen: UiModel["screen"] = "join";
let status: ConnectionStatus = "closed";
let roomCode = "";
let join: JoinResponse | null = null;
let signaling: SignalingClient | null = null;
let media: MediaSession | null = null;
let localState = { muted: false, videoOff: false };
let error: string | null = null;
let joinError: { status: number; code: string } | null = null;
let onAirSince: number | null = null;
let prefs: Record<string, SubscriptionPref> = {};
const meter = new LevelMeter();
const events: RoomEvent[] = [];
const closes: CloseInfo[] = [];
const snapshots: Array<{ kind: "welcome" | "resync"; seq: number; epoch: number }> = [];

const ui = createUi(root, {
  join: (input) => void doJoin(input),
  leave: () => {
    signaling?.leave();
    media?.close();
    screen = "closed";
    render();
  },
  toggleMic: () => void media?.setMuted(!localState.muted).then(() => ((localState = { ...localState, muted: !localState.muted }), render())).catch(report),
  toggleCamera: () => void media?.setVideoOff(!localState.videoOff).then(() => ((localState = { ...localState, videoOff: !localState.videoOff }), render())).catch(report),
  // The set_media_state ack precedes the participant.updated event; both paths converge in render().
  toggleHand: () => {
    const me = view.roster.find((r) => r.participant_id === view.participantId);
    void signaling?.request(me?.hand ? "lower_hand" : "raise_hand", {}).catch(report);
  },
  react: (emoji) => void signaling?.request("reaction", { emoji }).catch(report),
  chat: (body) => void signaling?.request("chat", { body }).catch(report),
  admit: (pid) => void signaling?.request("host.admit", { participant_id: pid }).catch(report),
  deny: (pid) => void signaling?.request("host.deny", { participant_id: pid }).catch(report),
  mute: (pid) => void signaling?.request("host.mute", { participant_id: pid }).catch(report),
  remove: (pid) => void signaling?.request("host.remove", { participant_id: pid }).catch(report),
  setLock: (locked) => void signaling?.request("host.lock", { locked }).catch(report),
  end: () => void signaling?.request("host.end", {}).catch(report),
  setLayer: (trackId, maxLayer) => void setLayer(trackId, maxLayer),
});

function report(err: unknown): void {
  error = err instanceof Error ? err.message : String(err);
  render();
}

function render(): void {
  view = expireReactions(view, Date.now());
  const me = view.roster.find((r) => r.participant_id === view.participantId);
  if (me && (me.muted !== localState.muted || me.video_off !== localState.videoOff)) {
    // A host mute lands as participant.updated on our own entry; the strip and the producers follow it.
    localState = { muted: me.muted, videoOff: me.video_off };
    media?.syncPaused(localState);
  }
  const model: UiModel = {
    screen,
    status,
    view,
    roomCode,
    sessionId: join?.session_id ?? null,
    localState,
    levels: meter.read(),
    error,
    sinceMs: onAirSince === null ? null : Date.now() - onAirSince,
  };
  ui.render(model);
}

async function doJoin(input: { code: string; name: string; token: string }): Promise<void> {
  error = null;
  joinError = null;
  roomCode = input.code;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.token) headers["authorization"] = `Bearer ${input.token}`;
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}/v1/join`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code: input.code, display_name: input.name || "Guest" }),
    });
  } catch {
    error = "Could not reach the meeting service. Is it running?";
    render();
    return;
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorBodySchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : "UNKNOWN";
    joinError = { status: response.status, code };
    error = joinMessage(response.status, code);
    render();
    return;
  }
  join = JoinResponseSchema.parse(body);
  startSession(join);
}

function joinMessage(status: number, code: string): string {
  if (status === 404) return "No room has that code. Check it with the host.";
  if (status === 410) return "That room has ended. Ask the host for a new code.";
  if (status === 403) return "The host has locked this room.";
  if (status === 429) return code === "CAPACITY" ? "This room is full." : "Too many attempts. Wait a minute and try again.";
  return `Could not join (${code}).`;
}

function startSession(joined: JoinResponse): void {
  media = new MediaSession(
    signalingRef(),
    {
      onFeed: (feed) => {
        ui.attachFeed(feed.trackId, feed.kind, feed.track);
        const owner = view.tracks.find((t) => t.track_id === feed.trackId)?.owner;
        if (owner && feed.kind === "audio") meter.attach(owner, feed.track);
      },
      onFeedRemoved: (trackId) => {
        ui.detachFeed(trackId);
      },
      log: (line) => ui.tape(view.seq, ` ${line}`),
    },
  );
  screen = joined.lobby ? "waiting" : "room";
  render();

  function signalingRef(): SignalingClient {
    signaling = new SignalingClient({
      url: joined.signaling_url,
      token: joined.signaling_token,
      onSnapshot: (kind, welcome) => void onSnapshot(kind, welcome).catch(report),
      onEvent: (event) => onEvent(event),
      onStatus: (next) => {
        status = next;
        if (next === "joined" && onAirSince === null) onAirSince = Date.now();
        render();
      },
      onClosed: (info) => {
        closes.push(info);
        ui.tape(view.seq, ` socket closed ${info.code} ${info.reason}`);
        if (info.terminal && info.code !== 1000) {
          screen = view.state === "ended" ? "ended" : "closed";
          error = closeMessage(info.code);
          media?.close();
        }
        render();
      },
      log: (line) => ui.tape(view.seq, ` ${line}`),
    });
    signaling.connect();
    return signaling;
  }
}

function closeMessage(code: number): string {
  switch (code) {
    case 4002:
      return "The host removed you from the room.";
    case 4003:
      return "The host did not let you in.";
    case 4004:
      return "The room has ended.";
    case 4005:
      return "You joined from another tab, so this one stopped.";
    case 4007:
      return "This room is full.";
    case 4008:
      return "You were away too long. Join again with a fresh code.";
    case 4009:
      return "The host has locked this room.";
    default:
      return `The connection closed (${code}).`;
  }
}

async function onSnapshot(kind: "welcome" | "resync", welcome: Parameters<typeof applySnapshot>[1]): Promise<void> {
  view = applySnapshot(view, welcome);
  snapshots.push({ kind, seq: welcome.seq, epoch: welcome.epoch });
  ui.tape(welcome.seq, ` ${kind} ${welcome.state} epoch ${welcome.epoch}`);
  if (welcome.state === "lobby") {
    screen = "waiting";
    render();
    return;
  }
  screen = "room";
  render();
  if (!media || !welcome.media || !join) return;
  const outcome = await media.applyMedia(welcome.media, join.ice_servers as RTCIceServer[]);
  if (outcome === "created") {
    const tracks = await media.captureLocal();
    ui.attachLocal(tracks);
    if (tracks.audio) meter.attach("you", tracks.audio);
    await media.publishLocal(localState);
  }
  await resubscribe();
  render();
}

function onEvent(event: RoomEvent): void {
  events.push(event);
  if (events.length > 1000) events.shift();
  view = applyEvent(view, event, Date.now());
  ui.tape(event.seq, ` ${event.type}${describe(event)}`);
  if (event.type === "track.added" || event.type === "track.removed" || event.type === "participant.left") {
    void resubscribe().catch(report);
  }
  if (event.type === "room.ended") screen = "ended";
  render();
}

function describe(event: RoomEvent): string {
  switch (event.type) {
    case "participant.joined":
      return ` ${event.payload.participant.name}`;
    case "track.added":
      return ` ${event.payload.track.source} ${event.payload.track.track_id.slice(0, 8)}`;
    case "track.updated":
      return ` ${event.payload.track_id.slice(0, 8)} ${JSON.stringify(event.payload.patch)}`;
    case "active_speakers":
      return ` ${event.payload.participant_ids.length}`;
    case "chat":
      return ` ${event.payload.body.slice(0, 24)}`;
    default:
      return "";
  }
}

async function resubscribe(): Promise<void> {
  if (!media || view.state !== "joined") return;
  const wanted = view.tracks.filter((t) => t.owner !== view.participantId).map((t) => t.track_id);
  await media.subscribe(wanted, prefs);
}

async function setLayer(trackId: string, maxLayer: number): Promise<void> {
  prefs = { ...prefs, [trackId]: { ...(prefs[trackId] ?? {}), max_layer: maxLayer } };
  await resubscribe();
}

const harness: Harness = {
  view: () => view,
  status: () => status,
  sessionId: () => join?.session_id ?? null,
  participantId: () => view.participantId,
  epoch: () => signaling?.epoch ?? null,
  seq: () => view.seq,
  events,
  closes,
  snapshots,
  lastAck: () => signaling?.lastAck ?? null,
  joinResponse: () => join,
  consumers: () => (media?.feeds() ?? []).map((f) => ({ track_id: f.trackId, consumer_id: f.consumerId, kind: f.kind })),
  localTracks: () => media?.localTrackIds() ?? { audio: null, video: null },
  stats: (trackId) => media?.stats(trackId) ?? Promise.resolve({ packetsReceived: 0, framesDecoded: 0, bytesReceived: 0 }),
  frames: (trackId) => ui.frames(trackId),
  levels: () => meter.read(),
  dropSocket: () => signaling?.drop(),
  setLayer,
  lastError: () => error,
  joinError: () => joinError,
};
(window as unknown as { __harness: Harness }).__harness = harness;

setInterval(() => {
  if (screen === "room") render();
}, 250);
render();
```

Notes for the implementer: `JoinResponseSchema`, `ErrorBodySchema` and `JoinResponse` come from `@zoomclone/protocol` (`rest.ts`); `join.ice_servers` is the REST shape (`{ urls, username?, credential? }`), which is assignable to `RTCIceServer`. `ui.tape` is the method added in Step 3. The 250 ms render tick refreshes the meters and the clock only while in a room.

Run: `pnpm --filter @zoomclone/signaling typecheck` (both configs) and `pnpm --filter @zoomclone/signaling test -- harness` (the bundle test must still pass; the bundle now includes mediasoup-client and zod).

- [ ] **Step 5: Manual look with the real services**

Start docker (`pnpm infra:up`), run `pnpm db:migrate`, then in three terminals `pnpm --filter @zoomclone/meeting-api start`, `pnpm --filter @zoomclone/sfu start`, `DEV_HARNESS=true pnpm --filter @zoomclone/signaling start` (or put `DEV_HARNESS=true` in `.env`). Mint a host token: `curl -s -X POST localhost:8080/dev/oidc/token -H 'content-type: application/json' -d '{"sub":"host","name":"Host"}'` and create a meeting: `curl -s -X POST localhost:8080/v1/meetings -H "authorization: Bearer <token>" -H 'content-type: application/json' -d '{"title":"gallery"}'` (the response carries `code`). Open `http://localhost:8081/dev/` in two browser windows, join as the host (with the token) and as a guest, and confirm: two monitors with live pictures, the tally lamp on the speaker, mute/camera/hand/reactions/chat, the green room flow with lobby enabled (the guest waits, the host lets them in), lock and end. Fix what is broken. Record what you saw in the report (a screenshot pasted into the scratchpad is welcome). Stop the services afterwards.

- [ ] **Step 6: Full check and commit**

Run: `pnpm check`

```sh
git add services/signaling
git commit -F - <<'EOF'
feat(client): render the gallery and expose the harness api

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---
### Task 4: Playwright workspace (services, fixtures, page driver, nine scenarios)

**Files:**
- Create: `e2e/package.json`, `e2e/tsconfig.json`, `e2e/playwright.config.ts`, `e2e/src/global-setup.ts`, `e2e/src/tone.ts`, `e2e/src/services.ts`, `e2e/src/api.ts`, `e2e/src/gallery.ts`, `e2e/src/fixtures.ts`, `e2e/specs/01-call.spec.ts`, `e2e/specs/02-lobby.spec.ts`, `e2e/specs/03-host-controls.spec.ts`, `e2e/specs/04-active-speakers.spec.ts`, `e2e/specs/05-layers.spec.ts`, `e2e/specs/06-reconnect-replay.spec.ts`, `e2e/specs/07-restart-signaling.spec.ts`, `e2e/specs/08-idle-end.spec.ts`, `e2e/specs/09-join-errors.spec.ts`, `e2e/.gitignore`
- Modify: root `package.json` (`test:e2e` script), root `.gitignore` (`e2e/.cache`, `e2e/test-results`, `e2e/playwright-report`)

**Interfaces:**
- Consumes: the harness API and `data-testid`s from Task 3, the REST API of meeting-api (`POST /dev/oidc/token`, `POST /v1/meetings`, `POST /v1/join`, `POST /v1/meetings/{id}::end`), the three services' env from their `env.ts` files.
- Produces: `test` and `expect` from `e2e/src/fixtures.ts` with fixtures `services: Services` (worker scoped) and `api: Api` (worker scoped); `Services = { restartSignaling(): Promise<void>; urls: { api: string; signaling: string } }`; `Api = { hostToken(name?): Promise<string>; createMeeting(token, settings?): Promise<{ id: string; code: string }>; join(code, name, token?): Promise<JoinResponse>; joinError(code, name, token?): Promise<{ status: number; code: string }>; endMeeting(token, id): Promise<number>; sessionEnded(sessionId): Promise<boolean> }`; `openGallery(context, input) -> Promise<Gallery>` with `Gallery = { page; harness<T>(fn): Promise<T>; waitJoined(); waitWaiting(); waitEnded(); remoteTracks(kind): Promise<string[]>; framesAdvancing(trackId): Promise<boolean>; packetsDelta(trackId, ms): Promise<number>; waitEvent(type, predicate?, timeoutMs?): Promise<RoomEvent>; click(testId): Promise<void>; participantId(): Promise<string>; token(): Promise<string> }`.
- Chromium is launched with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<e2e/.cache/tone.wav> --autoplay-policy=no-user-gesture-required`; the tone file (440 Hz sine, 48 kHz mono, 2 s, looped by Chromium) is generated by `global-setup.ts` so every participant produces continuous audio, which is what the active speaker scenario needs.

- [ ] **Step 1: Workspace files**

`e2e/package.json`:

```json
{
  "name": "@zoomclone/e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test:e2e": "playwright test",
    "install-browsers": "playwright install chromium"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@types/node": "24.13.4",
    "@zoomclone/protocol": "workspace:*",
    "postgres": "3.4.9",
    "typescript": "5.9.3"
  }
}
```

(no `test` script on purpose: `pnpm -r test` must not run Playwright.)

`e2e/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM"] },
  "include": ["src", "specs", "playwright.config.ts"]
}
```

`e2e/.gitignore`:

```
.cache/
test-results/
playwright-report/
```

Root `package.json` scripts: add `"test:e2e": "pnpm --filter @zoomclone/e2e test:e2e"` and `"e2e:install": "pnpm --filter @zoomclone/e2e install-browsers"`. Root `.gitignore`: add `e2e/.cache/`, `e2e/test-results/`, `e2e/playwright-report/`.

`e2e/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export const TONE_PATH = resolve(import.meta.dirname, ".cache/tone.wav");

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./src/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${TONE_PATH}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
```

Run `pnpm install` then `pnpm e2e:install` (downloads Chromium once).

- [ ] **Step 2: Global setup, tone, service manager, api, page driver, fixtures**

`e2e/src/tone.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 16-bit mono PCM WAV of a sine tone; Chromium loops it as the fake microphone. */
export function writeToneWav(path: string, opts = { hz: 440, seconds: 2, rate: 48_000 }): void {
  const samples = opts.seconds * opts.rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * opts.hz * i) / opts.rate) * 0.5 * 32767);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(opts.rate, 24);
  header.writeUInt32LE(opts.rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, data]));
}
```

`e2e/src/global-setup.ts`:

```ts
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { TONE_PATH } from "../playwright.config";
import { writeToneWav } from "./tone";

const ROOT = resolve(import.meta.dirname, "../..");

/** Infra must be up; migrations run against the docker database the services will use. */
export default function globalSetup(): void {
  writeToneWav(TONE_PATH);
  execSync("pnpm db:migrate", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: process.env["E2E_DATABASE_URL"] ?? DATABASE_URL },
  });
}

export const DATABASE_URL = "postgres://zoomclone:zoomclone@localhost:55432/zoomclone";
export const REDIS_URL = "redis://localhost:56379/0";
```

`e2e/src/services.ts`:

```ts
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as http2 from "node:http2";
import { resolve } from "node:path";
import { DATABASE_URL, REDIS_URL } from "./global-setup";

const ROOT = resolve(import.meta.dirname, "../..");
export const API_URL = "http://localhost:8080";
export const SIGNALING_URL = "http://localhost:8081";
const SFU_URL = "http://localhost:9090";

const SHARED_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "warn",
  DATABASE_URL,
  REDIS_URL,
  TOKEN_ISSUER: "meeting-api",
};

const SERVICE_ENV: Record<ServiceName, Record<string, string>> = {
  "meeting-api": {
    ...SHARED_ENV,
    MEETING_API_PORT: "8080",
    AUTH_DEV_ISSUER: "true",
    SIGNALING_PUBLIC_URL: "ws://localhost:8081",
    CORS_ORIGINS: SIGNALING_URL,
    JOIN_RATE_LIMIT: "1000",
    JOIN_RATE_LIMIT_PER_CODE: "6",
    STUN_URLS: "",
  },
  sfu: {
    ...SHARED_ENV,
    SFU_GRPC_PORT: "9090",
    SFU_WORKERS: "1",
    SFU_MEDIA_PORT_BASE: "43000",
    SFU_ANNOUNCED_IP: "127.0.0.1",
    MEDIASOUP_LOG_LEVEL: "error",
  },
  signaling: {
    ...SHARED_ENV,
    SIGNALING_PORT: "8081",
    MEETING_API_JWKS_URL: `${API_URL}/.well-known/jwks.json`,
    MEETING_API_PUBLIC_URL: API_URL,
    SFU_ENDPOINTS: `sfu-local-1=${SFU_URL}`,
    DEV_HARNESS: "true",
    // Grace outlasts the reconnect backoff a client goes through while the process restarts.
    DISCONNECT_GRACE_MS: "10000",
    ROOM_IDLE_TIMEOUT_MS: "3000",
    HEARTBEAT_MS: "500",
    OWNER_LEASE_MS: "2000",
  },
};

export type ServiceName = "meeting-api" | "sfu" | "signaling";

type Running = { name: ServiceName; child: ChildProcess };

/** Spawns the three services as plain node processes (tsx via --import) and waits for /healthz. */
export class ServiceManager {
  private readonly running = new Map<ServiceName, Running>();

  async startAll(): Promise<void> {
    for (const name of ["meeting-api", "sfu", "signaling"] as const) await this.start(name);
  }

  async start(name: ServiceName): Promise<void> {
    if (this.running.has(name)) return;
    const cwd = resolve(ROOT, "services", name);
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd,
      env: { ...minimalEnv(), ...SERVICE_ENV[name] },
      stdio: ["ignore", "inherit", "inherit"],
    });
    this.running.set(name, { name, child });
    await waitFor(() => this.healthy(name), 30_000, `${name} did not become healthy`);
  }

  async stop(name: ServiceName): Promise<void> {
    const running = this.running.get(name);
    if (!running) return;
    this.running.delete(name);
    await killTree(running.child);
  }

  async stopAll(): Promise<void> {
    for (const name of [...this.running.keys()].reverse()) await this.stop(name);
  }

  /** Scenario 7: the room controller dies and a fresh process rehydrates the room from Redis. */
  async restartSignaling(): Promise<void> {
    await this.stop("signaling");
    await this.start("signaling");
  }

  private async healthy(name: ServiceName): Promise<boolean> {
    try {
      if (name === "sfu") return await h2Healthy(SFU_URL);
      const url = name === "meeting-api" ? `${API_URL}/healthz` : `${SIGNALING_URL}/healthz`;
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  }
}

function minimalEnv(): Record<string, string> {
  const keep = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT"];
  const out: Record<string, string> = {};
  for (const key of keep) if (process.env[key]) out[key] = process.env[key]!;
  return out;
}

function h2Healthy(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const session = http2.connect(baseUrl);
    session.on("error", () => resolve(false));
    const req = session.request({ ":path": "/healthz" });
    req.on("response", (headers) => {
      resolve(headers[":status"] === 200);
      req.close();
      session.close();
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32" && child.pid) {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }
  await exited;
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} within ${timeoutMs} ms`);
}

/** Refuses to run when one of the fixed ports is already taken by something else. */
export async function assertPortsFree(): Promise<void> {
  for (const [name, url] of [["meeting-api", `${API_URL}/healthz`], ["signaling", `${SIGNALING_URL}/healthz`]] as const) {
    const busy = await fetch(url).then(() => true, () => false);
    if (busy) throw new Error(`${name} port is already in use (${url}); stop the running service first`);
  }
}
```

`e2e/src/api.ts`:

```ts
import postgres from "postgres";
import { JoinResponseSchema, type JoinResponse } from "@zoomclone/protocol";
import { DATABASE_URL } from "./global-setup";
import { API_URL } from "./services";

export type Api = {
  hostToken: (name?: string) => Promise<string>;
  createMeeting: (token: string, settings?: { lobby?: boolean; max_participants?: number }) => Promise<{ id: string; code: string }>;
  join: (code: string, name: string, token?: string) => Promise<JoinResponse>;
  joinError: (code: string, name: string, token?: string) => Promise<{ status: number; code: string }>;
  endMeeting: (token: string, id: string) => Promise<number>;
  sessionEnded: (sessionId: string) => Promise<boolean>;
  close: () => Promise<void>;
};

export function createApi(): Api {
  const sql = postgres(DATABASE_URL, { max: 2 });
  const headers = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });
  return {
    async hostToken(name = "Host") {
      const res = await fetch(`${API_URL}/dev/oidc/token`, { method: "POST", headers: headers(), body: JSON.stringify({ sub: `host-${Date.now()}`, name }) });
      const json = (await res.json()) as { access_token: string };
      return json.access_token;
    },
    async createMeeting(token, settings = {}) {
      const res = await fetch(`${API_URL}/v1/meetings`, { method: "POST", headers: headers(token), body: JSON.stringify({ title: "e2e", settings }) });
      if (!res.ok) throw new Error(`create meeting failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { id: string; code: string };
      return { id: json.id, code: json.code };
    },
    async join(code, name, token) {
      const res = await fetch(`${API_URL}/v1/join`, { method: "POST", headers: headers(token), body: JSON.stringify({ code, display_name: name }) });
      if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`);
      return JoinResponseSchema.parse(await res.json());
    },
    async joinError(code, name, token) {
      const res = await fetch(`${API_URL}/v1/join`, { method: "POST", headers: headers(token), body: JSON.stringify({ code, display_name: name }) });
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      return { status: res.status, code: json.error?.code ?? "" };
    },
    async endMeeting(token, id) {
      const res = await fetch(`${API_URL}/v1/meetings/${id}::end`, { method: "POST", headers: headers(token) });
      return res.status;
    },
    async sessionEnded(sessionId) {
      const [row] = await sql<{ endedAt: Date | null }[]>`SELECT ended_at AS "endedAt" FROM meeting_sessions WHERE id = ${sessionId}`;
      return row?.endedAt !== null && row?.endedAt !== undefined;
    },
    close: () => sql.end(),
  };
}
```

`e2e/src/gallery.ts`:

```ts
import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { JoinResponse, RoomEvent } from "@zoomclone/protocol";
import { SIGNALING_URL } from "./services";

/** The subset of window.__harness the tests read (structural copy of the client's Harness type). */
export type HarnessShape = {
  view: () => { participantId: string | null; role: string | null; epoch: number; seq: number; state: string; roster: Array<{ participant_id: string; name: string; muted: boolean; hand: boolean; connected: boolean }>; tracks: Array<{ track_id: string; owner: string; kind: string; source: string; paused: boolean; layers: number }>; lobby: Array<{ participant_id: string }>; activeSpeakers: string[]; layers: Record<string, number> };
  status: () => string;
  sessionId: () => string | null;
  participantId: () => string | null;
  epoch: () => number | null;
  seq: () => number;
  events: RoomEvent[];
  closes: Array<{ code: number; reason: string; terminal: boolean }>;
  snapshots: Array<{ kind: string; seq: number; epoch: number }>;
  lastAck: () => { mode: string; epoch: number; seq: number } | null;
  consumers: () => Array<{ track_id: string; consumer_id: string; kind: string }>;
  localTracks: () => { audio: string | null; video: string | null };
  stats: (trackId: string) => Promise<{ packetsReceived: number; framesDecoded: number; bytesReceived: number }>;
  frames: (trackId: string) => number;
  dropSocket: () => void;
  setLayer: (trackId: string, maxLayer: number) => Promise<void>;
  joinResponse: () => JoinResponse | null;
  lastError: () => string | null;
  joinError: () => { status: number; code: string } | null;
};

export type Gallery = {
  page: Page;
  harness: <T>(fn: (h: HarnessShape) => T | Promise<T>) => Promise<T>;
  waitJoined: () => Promise<void>;
  waitWaiting: () => Promise<void>;
  waitEnded: () => Promise<void>;
  waitClosed: (code: number) => Promise<void>;
  remoteTracks: (kind: "audio" | "video") => Promise<string[]>;
  framesAdvancing: (trackId: string, ms?: number) => Promise<boolean>;
  packetsDelta: (trackId: string, ms?: number) => Promise<number>;
  waitEvent: (type: RoomEvent["type"], predicate?: (e: RoomEvent) => boolean, timeoutMs?: number) => Promise<RoomEvent>;
  click: (testId: string) => Promise<void>;
  participantId: () => Promise<string>;
  token: () => Promise<string>;
};

export async function openGallery(
  context: BrowserContext,
  input: { code: string; name: string; token?: string },
): Promise<Gallery> {
  const page = await context.newPage();
  await page.goto(`${SIGNALING_URL}/dev/`);
  await page.getByTestId("input-code").fill(input.code);
  await page.getByTestId("input-name").fill(input.name);
  if (input.token) await page.getByTestId("input-token").fill(input.token);
  await page.getByTestId("join").click();
  const gallery: Gallery = {
    page,
    // The arrow's source runs in the page against window.__harness; keep the arrows self-contained
    // (no closures over test variables: pass values through page.evaluate instead).
    harness: <T>(fn: (h: HarnessShape) => T | Promise<T>) =>
      page.evaluate(
        ({ src }) =>
          (new Function("h", `return (${src})(h)`) as (h: unknown) => unknown)(
            (window as unknown as { __harness: unknown }).__harness,
          ),
        { src: fn.toString() },
      ) as Promise<T>,
    waitJoined: async () => {
      await expect.poll(() => page.evaluate(() => (window as unknown as { __harness: HarnessShape }).__harness.status()), { timeout: 30_000 }).toBe("joined");
    },
    waitWaiting: async () => {
      await expect(page.getByTestId("air-status")).toHaveText("waiting for the host");
    },
    waitEnded: async () => {
      await expect(page.getByTestId("ended-panel")).toBeVisible();
    },
    waitClosed: async (code) => {
      await expect.poll(() => page.evaluate(() => (window as unknown as { __harness: HarnessShape }).__harness.closes.map((c) => c.code)), { timeout: 30_000 }).toContain(code);
    },
    remoteTracks: async (kind) =>
      page.evaluate((k) => {
        const h = (window as unknown as { __harness: HarnessShape }).__harness;
        const me = h.participantId();
        return h.view().tracks.filter((t) => t.owner !== me && t.kind === k).map((t) => t.track_id);
      }, kind),
    framesAdvancing: async (trackId, ms = 1_500) => {
      const before = await page.evaluate((id) => (window as unknown as { __harness: HarnessShape }).__harness.frames(id), trackId);
      await page.waitForTimeout(ms);
      const after = await page.evaluate((id) => (window as unknown as { __harness: HarnessShape }).__harness.frames(id), trackId);
      return after > before;
    },
    packetsDelta: async (trackId, ms = 1_500) => {
      const before = await page.evaluate((id) => (window as unknown as { __harness: HarnessShape }).__harness.stats(id), trackId);
      await page.waitForTimeout(ms);
      const after = await page.evaluate((id) => (window as unknown as { __harness: HarnessShape }).__harness.stats(id), trackId);
      return after.packetsReceived - before.packetsReceived;
    },
    waitEvent: async (type, predicate = () => true, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = await page.evaluate(() => (window as unknown as { __harness: HarnessShape }).__harness.events);
        const found = events.find((e) => e.type === type && predicate(e));
        if (found) return found;
        await page.waitForTimeout(150);
      }
      throw new Error(`no ${type} event within ${timeoutMs} ms`);
    },
    click: (testId) => page.getByTestId(testId).click(),
    participantId: async () => (await page.evaluate(() => (window as unknown as { __harness: HarnessShape }).__harness.participantId())) ?? "",
    token: async () => (await page.evaluate(() => (window as unknown as { __harness: HarnessShape }).__harness.joinResponse()?.signaling_token)) ?? "",
  };
  return gallery;
}

/** Opens a raw socket from the test runner and returns the close code the server answers a hello with. */
export async function helloCloseCode(signalingUrl: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalingUrl);
    const timer = setTimeout(() => reject(new Error("no close within 10 s")), 10_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", id: "h", payload: { token } })));
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event.code);
    });
    ws.addEventListener("error", () => undefined);
  });
}
```

`e2e/src/fixtures.ts`:

```ts
import { test as base } from "@playwright/test";
import { createApi, type Api } from "./api";
import { ServiceManager, assertPortsFree, API_URL, SIGNALING_URL } from "./services";

export type Services = { restartSignaling: () => Promise<void>; urls: { api: string; signaling: string } };

export const test = base.extend<Record<never, never>, { services: Services; api: Api }>({
  services: [
    async ({}, use) => {
      await assertPortsFree();
      const manager = new ServiceManager();
      await manager.startAll();
      await use({ restartSignaling: () => manager.restartSignaling(), urls: { api: API_URL, signaling: SIGNALING_URL } });
      await manager.stopAll();
    },
    { scope: "worker" },
  ],
  api: [
    async ({ services }, use) => {
      void services;
      const api = createApi();
      await use(api);
      await api.close();
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
```

- [ ] **Step 3: The nine scenarios**

Common shape: every spec imports `{ test, expect }` from `../src/fixtures` and `openGallery` from `../src/gallery`, creates a meeting through `api`, opens one `browser.newContext()` per participant, and closes contexts in `finally` (or via `test.afterEach`). `browser` is Playwright's built-in fixture.

`e2e/specs/01-call.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("three participants see and hear each other", async ({ browser, api }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    const [host, ann, bob] = await Promise.all([
      openGallery(contexts[0]!, { code: meeting.code, name: "Host", token }),
      openGallery(contexts[1]!, { code: meeting.code, name: "Ann" }),
      openGallery(contexts[2]!, { code: meeting.code, name: "Bob" }),
    ]);
    for (const g of [host, ann, bob]) await g.waitJoined();
    for (const g of [host, ann, bob]) {
      await expect.poll(() => g.remoteTracks("video"), { timeout: 30_000 }).toHaveLength(2);
      await expect.poll(() => g.remoteTracks("audio"), { timeout: 30_000 }).toHaveLength(2);
      for (const trackId of await g.remoteTracks("video")) {
        await expect.poll(() => g.framesAdvancing(trackId), { timeout: 30_000 }).toBe(true);
      }
      for (const trackId of await g.remoteTracks("audio")) {
        await expect.poll(() => g.packetsDelta(trackId), { timeout: 30_000 }).toBeGreaterThan(0);
      }
      await expect(g.page.locator(".monitor")).toHaveCount(3);
    }
  } finally {
    for (const c of contexts) await c.close();
  }
});
```

`e2e/specs/02-lobby.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("guests wait in the green room until the host lets them in or turns them away", async ({ browser, api }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: true });
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    const ann = await openGallery(contexts[1]!, { code: meeting.code, name: "Ann" });
    await ann.waitWaiting();
    const host = await openGallery(contexts[0]!, { code: meeting.code, name: "Host", token });
    await host.waitJoined();
    const annId = await ann.participantId();
    await expect(host.page.getByTestId(`waiter-${annId}`)).toBeVisible();
    await host.click(`admit-${annId}`);
    await ann.waitJoined();
    await expect(host.page.getByTestId(`roster-${annId}`)).toBeVisible();
    await expect.poll(() => ann.remoteTracks("video"), { timeout: 30_000 }).toHaveLength(1);

    const bob = await openGallery(contexts[2]!, { code: meeting.code, name: "Bob" });
    await bob.waitWaiting();
    const bobId = await bob.participantId();
    await host.click(`deny-${bobId}`);
    await bob.waitClosed(4003);
    await expect(bob.page.getByTestId("error")).toContainText("did not let you in");
    await expect(host.page.getByTestId(`waiter-${bobId}`)).toHaveCount(0);
  } finally {
    for (const c of contexts) await c.close();
  }
});
```

`e2e/specs/03-host-controls.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";
import { helloCloseCode, openGallery } from "../src/gallery";

test("host mute, remove, lock and end", async ({ browser, api, services }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    const [host, ann, bob] = await Promise.all([
      openGallery(contexts[0]!, { code: meeting.code, name: "Host", token }),
      openGallery(contexts[1]!, { code: meeting.code, name: "Ann" }),
      openGallery(contexts[2]!, { code: meeting.code, name: "Bob" }),
    ]);
    for (const g of [host, ann, bob]) await g.waitJoined();
    const annId = await ann.participantId();
    const annAudio = (await bob.harness((h) => h.view().tracks.filter((t) => t.kind === "audio")))
      .find((t) => t.owner === annId)!.track_id;
    await expect.poll(() => bob.packetsDelta(annAudio), { timeout: 30_000 }).toBeGreaterThan(0);

    // mute: Ann's mic goes quiet for Bob and her tile says so
    await host.click(`mute-${annId}`);
    await expect(ann.page.getByTestId("mic")).toHaveText("mic off");
    await expect.poll(() => bob.packetsDelta(annAudio, 2_000), { timeout: 30_000 }).toBe(0);

    // remove: Ann is closed 4002 and a fresh hello with her token is refused the same way
    const annToken = await ann.token();
    await host.click(`remove-${annId}`);
    await ann.waitClosed(4002);
    await expect(ann.page.getByTestId("error")).toContainText("removed you");
    expect(await helloCloseCode(`${services.urls.signaling.replace("http", "ws")}/rooms/${(await host.harness((h) => h.sessionId()))!}`, annToken)).toBe(4002);
    await expect(host.page.getByTestId(`roster-${annId}`)).toHaveCount(0);

    // lock: /join refuses newcomers, a token minted before the lock is refused at hello with 4009
    const early = await api.join(meeting.code, "Early");
    await host.click("lock");
    await expect(host.page.getByTestId("lock")).toHaveText("unlock room");
    expect(await api.joinError(meeting.code, "Late")).toMatchObject({ status: 403, code: "LOCKED" });
    expect(await helloCloseCode(early.signaling_url, early.signaling_token)).toBe(4009);

    // end: everyone sees the room end, the session is closed in Postgres, /join answers 410
    const sessionId = (await host.harness((h) => h.sessionId()))!;
    await host.click("end");
    await host.waitEnded();
    await bob.waitEnded();
    await expect.poll(() => api.sessionEnded(sessionId), { timeout: 20_000 }).toBe(true);
    expect((await api.joinError(meeting.code, "Later")).status).toBe(410);
  } finally {
    for (const c of contexts) await c.close();
  }
});
```

`e2e/specs/04-active-speakers.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("active speakers follow the tone and clear when everyone mutes", async ({ browser, api }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, ann] = await Promise.all([
      openGallery(contexts[0]!, { code: meeting.code, name: "Host", token }),
      openGallery(contexts[1]!, { code: meeting.code, name: "Ann" }),
    ]);
    await host.waitJoined();
    await ann.waitJoined();
    const ids = [await host.participantId(), await ann.participantId()];
    const speaking = await host.waitEvent("active_speakers", (e) => e.type === "active_speakers" && e.payload.participant_ids.length > 0, 30_000);
    if (speaking.type !== "active_speakers") throw new Error("unreachable");
    for (const id of speaking.payload.participant_ids) expect(ids).toContain(id);
    await expect(host.page.locator('.monitor[data-speaking="true"]').first()).toBeVisible();

    await host.click("mic");
    await ann.click("mic");
    await host.waitEvent("active_speakers", (e) => e.type === "active_speakers" && e.payload.participant_ids.length === 0, 30_000);
    await expect(host.page.locator('.monitor[data-speaking="true"]')).toHaveCount(0);
  } finally {
    for (const c of contexts) await c.close();
  }
});
```

`e2e/specs/05-layers.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("a subscriber asking for the lowest layer is told which layer it gets", async ({ browser, api }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, ann] = await Promise.all([
      openGallery(contexts[0]!, { code: meeting.code, name: "Host", token }),
      openGallery(contexts[1]!, { code: meeting.code, name: "Ann" }),
    ]);
    await host.waitJoined();
    await ann.waitJoined();
    await expect.poll(() => ann.remoteTracks("video"), { timeout: 30_000 }).toHaveLength(1);
    const [hostCam] = await ann.remoteTracks("video");
    await expect.poll(() => ann.framesAdvancing(hostCam!), { timeout: 30_000 }).toBe(true);
    await ann.page.evaluate((id) => (window as unknown as { __harness: { setLayer: (t: string, l: number) => Promise<void> } }).__harness.setLayer(id, 0), hostCam!);
    const updated = await ann.waitEvent("track.updated", (e) => e.type === "track.updated" && e.payload.track_id === hostCam && e.payload.patch.layers !== undefined, 30_000);
    if (updated.type !== "track.updated") throw new Error("unreachable");
    expect(updated.payload.patch.layers).toBeLessThanOrEqual(1);
    await expect(ann.page.getByTestId(`tile-${await host.participantId()}`)).toContainText("L1");
  } finally {
    for (const c of contexts) await c.close();
  }
});
```

`e2e/specs/06-reconnect-replay.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("a dropped socket comes back with a replay and the video keeps flowing", async ({ browser, api }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, ann] = await Promise.all([
      openGallery(contexts[0]!, { code: meeting.code, name: "Host", token }),
      openGallery(contexts[1]!, { code: meeting.code, name: "Ann" }),
    ]);
    await host.waitJoined();
    await ann.waitJoined();
    const [hostCam] = await ann.remoteTracks("video");
    await expect.poll(() => ann.framesAdvancing(hostCam!), { timeout: 30_000 }).toBe(true);
    const snapshotsBefore = await ann.harness((h) => h.snapshots.length);

    await ann.harness((h) => h.dropSocket());
    await host.page.getByTestId("chat-input").fill("still here?");
    await host.click("chat-send");
    await ann.waitEvent("chat", (e) => e.type === "chat" && e.payload.body === "still here?", 30_000);
    await expect.poll(() => ann.harness((h) => h.lastAck()?.mode), { timeout: 30_000 }).toBe("replay");
    expect(await ann.harness((h) => h.snapshots.length)).toBe(snapshotsBefore);
    expect(await ann.harness((h) => h.closes.some((c) => c.code === 4900 && !c.terminal))).toBe(true);
    await expect.poll(() => ann.framesAdvancing(hostCam!), { timeout: 30_000 }).toBe(true);
    await expect(ann.page.getByTestId("air-status")).toContainText("on air");
  } finally {
    for (const c of contexts) await c.close();
  }
});
```

`e2e/specs/07-restart-signaling.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("a restarted signaling process rehydrates the room and the clients resync", async ({ browser, api, services }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, ann] = await Promise.all([
      openGallery(contexts[0]!, { code: meeting.code, name: "Host", token }),
      openGallery(contexts[1]!, { code: meeting.code, name: "Ann" }),
    ]);
    await host.waitJoined();
    await ann.waitJoined();
    const [hostCam] = await ann.remoteTracks("video");
    await expect.poll(() => ann.framesAdvancing(hostCam!), { timeout: 30_000 }).toBe(true);
    const before = await ann.harness((h) => ({
      roster: h.view().roster.map((r) => r.participant_id).sort(),
      tracks: h.view().tracks.map((t) => t.track_id).sort(),
      epoch: h.epoch(),
    }));

    await services.restartSignaling();
    await expect.poll(() => ann.harness((h) => h.epoch()), { timeout: 60_000 }).toBe((before.epoch ?? 1) + 1);
    await expect.poll(() => host.harness((h) => h.status()), { timeout: 60_000 }).toBe("joined");
    const after = await ann.harness((h) => ({
      roster: h.view().roster.map((r) => r.participant_id).sort(),
      tracks: h.view().tracks.map((t) => t.track_id).sort(),
      lastSnapshot: h.snapshots.at(-1)?.kind,
    }));
    expect(after.lastSnapshot).toBe("resync");
    expect(after.roster).toEqual(before.roster);
    expect(after.tracks).toEqual(before.tracks);
    await expect.poll(() => ann.framesAdvancing(hostCam!), { timeout: 30_000 }).toBe(true);
    await expect(host.page.getByTestId("counter-epoch")).toHaveText(String((before.epoch ?? 1) + 1));
  } finally {
    for (const c of contexts) await c.close();
  }
});
```

`e2e/specs/08-idle-end.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";
import { openGallery } from "../src/gallery";

test("an empty room ends by itself and the next join starts a new session", async ({ browser, api }) => {
  const token = await api.hostToken();
  const meeting = await api.createMeeting(token, { lobby: false });
  const context = await browser.newContext();
  try {
    const host = await openGallery(context, { code: meeting.code, name: "Host", token });
    await host.waitJoined();
    const first = await host.harness((h) => h.sessionId());
    await host.click("leave");
    await expect(host.page.getByTestId("ended-panel")).toBeVisible();
    // grace (10 s) then idle (3 s): the controller ends the session with reason idle
    await expect.poll(() => api.sessionEnded(first!), { timeout: 40_000 }).toBe(true);
    const again = await api.join(meeting.code, "Host again", token);
    expect(again.session_id).not.toBe(first);
  } finally {
    await context.close();
  }
});
```

`e2e/specs/09-join-errors.spec.ts`:

```ts
import { expect, test } from "../src/fixtures";

test("join answers 404, 410 and 429 the way the spec says", async ({ api }) => {
  expect(await api.joinError("zzz-zzzz-zzz", "Nobody")).toMatchObject({ status: 404, code: "MEETING_NOT_FOUND" });

  const token = await api.hostToken();
  const ended = await api.createMeeting(token, { lobby: false });
  await api.join(ended.code, "Host", token);
  expect(await api.endMeeting(token, ended.id)).toBe(200);
  expect(await api.joinError(ended.code, "Late")).toMatchObject({ status: 410, code: "ENDED" });

  const busy = await api.createMeeting(token, { lobby: false });
  for (let i = 0; i < 6; i++) await api.join(busy.code, `Guest ${i}`);
  expect(await api.joinError(busy.code, "Guest 7")).toMatchObject({ status: 429, code: "RATE_LIMITED" });
});
```

- [ ] **Step 4: Run, watch, fix**

Run: `pnpm typecheck` (the e2e workspace typechecks too), then `pnpm test:e2e`. Expect all nine to pass with the three services spawned by the worker fixture (first run downloads nothing more; Chromium was installed in Step 1). Investigate every failure against the services' logs (they inherit stdout) before touching a test: a red test is either a test-side timing assumption (widen a `timeout`, poll instead of sleeping) or a real defect in the client or the services; fix small client defects here and report service defects precisely. Then run the suite twice more to catch flakes; report the timings of the three runs.

Look at the page while you are here: with the services still up (`pnpm dev` or the fixture's env), take screenshots with Playwright (`page.screenshot({ path: "e2e/.cache/join.png" })` from a scratch script, and one of a three-party room) at 1280x800 and at 400x800, and check the design plan's floor: tiles have legend strips and meters, the tally lamp lights on the speaker, the rack stacks under the stage at 400 px, no horizontal scroll, focus ring visible with keyboard navigation, text contrast (ink on panel is 9:1, dim ink on panel is above 4.5:1). Fix what the screenshots show; note in the report what changed after looking.

- [ ] **Step 5: Commit**

Run: `pnpm check` (unit and integration only) and `pnpm test:e2e` once more.

```sh
git add e2e package.json .gitignore pnpm-lock.yaml services/signaling
git commit -F - <<'EOF'
test(e2e): drive the gallery through the nine end-to-end scenarios with Playwright

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

### Task 5: Docs and the verification pass

**Files:**
- Modify: `README.md`, `.env.example`, `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md`

- [ ] **Step 1: README**

Append to `README.md`:

````markdown
## Client (the gallery) and end-to-end tests

With `DEV_HARNESS=true` the signaling service serves the browser client at
`http://localhost:8081/dev/`: a broadcast-gallery view of the room (monitor tiles with tally lamps
and audio meters, the green room, talk, the control strip, and a tape of the signaling events).
Create a meeting with a dev host token, then join from two browser windows with the room code:

```sh
pnpm dev                                                    # all three services
TOKEN=$(curl -s -X POST localhost:8080/dev/oidc/token -H 'content-type: application/json' \
  -d '{"sub":"host","name":"Host"}' | jq -r .access_token)
curl -s -X POST localhost:8080/v1/meetings -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"hello"}' | jq .code
```

Paste the token into "Host token" on the join screen to join as the host (the green room,
mute, remove, lock and end are host controls).

The Playwright suite spawns the three services itself (ports 8080, 8081, 9090, media 43000) and
drives Chromium with fake devices through nine scenarios: a three-party call, the green room,
host controls, active speakers, layer preferences, reconnect with replay, a signaling restart
with rehydrate, idle end, and the `/join` error codes.

```sh
pnpm infra:up
pnpm e2e:install            # once: downloads Chromium
pnpm test:e2e
```

`pnpm check` never runs the browser suite.
````

Append to `.env.example` under the signaling block: `MEETING_API_PUBLIC_URL=http://localhost:8080` and change `DEV_HARNESS=false` to `DEV_HARNESS=true` with a comment `# serves the browser client at /dev/; set false in production`.

- [ ] **Step 2: Design doc**

In the design doc's "Verification" section, replace the `pnpm test:e2e` line with `- \`pnpm test:e2e\` spawns the three services and runs the nine Playwright scenarios headless on Chromium with fake devices (a generated 440 Hz tone as the microphone).` and in "Components > services/signaling > dev/" append: `Shipped as "the gallery": monitor tiles with tally lamps and audio meters, a green room, talk, a control strip and a tape of signaling events; \`window.__harness\` exposes the room view, events, consumers, stats, frame counters and a socket drop for Playwright.`

- [ ] **Step 3: Full verification and commit**

Run: `pnpm check` and `pnpm test:e2e`. Both green.

```sh
git add README.md .env.example docs/superpowers/specs
git commit -F - <<'EOF'
docs: describe the gallery client and the end-to-end suite

Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UMwPMKYDSNxehrDdPBLbxY
EOF
```

---

## Self-review notes (writer's pass)

- Spec coverage: Phase 6 (harness bundle, Playwright global setup, the nine specs) is Tasks 0 to 4; Phase 7's docs are Task 5 (the final review and the GitHub push happen outside the plan, with the user).
- Type consistency: `Harness` (Task 3 plus the Task 4 additions) is mirrored by `HarnessShape` in `e2e/src/gallery.ts`; `SignalingClient` (Task 1) is what `MediaSession` (Task 2) and `app.ts` (Task 3) use; `ConsumerParams.producer_id` (Task 0) is what `MediaSession.subscribe` reads; the `data-testid`s in `ui.ts` are the ones the specs click and read (`input-code`, `input-name`, `input-token`, `join`, `air-status`, `counter-epoch`, `lock`, `end`, `mic`, `camera`, `hand`, `react-*`, `leave`, `chat-input`, `chat-send`, `chat-lines`, `green-room`, `waiter-*`, `admit-*`, `deny-*`, `roster`, `roster-*`, `mute-*`, `remove-*`, `tile-*`, `tape`, `ended-panel`, `error`).
- Known fragility: scenario 5 depends on the browser actually sending three simulcast layers (it does with the fake camera at 1280x720); scenario 4 depends on the tone file (generated in global setup) and the tracker's 300 ms rise.
