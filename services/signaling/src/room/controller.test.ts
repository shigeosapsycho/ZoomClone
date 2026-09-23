import { setTimeout as sleep } from "node:timers/promises";
import { Code, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloseCode, type ClientMessage } from "@zoomclone/protocol";
import { SfuService, TransportDirection } from "@zoomclone/sfu-proto";
import { FakeSfu, FAKE_RTP_CAPABILITIES } from "../../test/fake-sfu";
import {
  FakeLink,
  createTestController,
  createTestInfra,
  mintClaims,
  seedSession,
  waitFor,
  type TestController,
  type TestInfra,
} from "../../test/helpers";
import { roomKeys } from "./checkpoint";
import type { ControllerHooks } from "./controller";
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
  overrides: {
    participant_id: string;
    role?: "host" | "attendee";
    display_name?: string;
    lobby?: boolean;
  },
): Promise<FakeLink> {
  const link = new FakeLink();
  const claims = mintClaims({ session_id: t.room.sessionId, ...overrides });
  const pid = await t.controller.attach(link, claims, {
    id: `hello-${overrides.participant_id.slice(0, 4)}`,
  });
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
  const m = msg(type, payload as never);
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
    expect(host.sent[0]).toEqual({
      type: "ack",
      id: "hello-1111",
      payload: { mode: "welcome", epoch: 1, seq: 1 },
    });
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
    expect(joined[1]).toMatchObject({
      participant_id: A,
      display_name: "Ann",
      role: "attendee",
      user_id: null,
    });
    await sleep(60);
    expect(await infra.redis.hlen(roomKeys(t.room.sessionId).roster)).toBe(2);
    expect(t.controller.connectionCount).toBe(2);
  });

  it("rolls the first transport back when the second CreateTransport fails and keeps the roster clean", async () => {
    const t = await startRoom();
    sfu.failNext("createTransport", Code.Internal, 1);
    const link = new FakeLink();
    const pid = await t.controller.attach(
      link,
      mintClaims({ session_id: t.room.sessionId, participant_id: A }),
      { id: "h" },
    );
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
    expect(
      await t.controller.attach(
        locked,
        mintClaims({ session_id: t.room.sessionId, participant_id: A }),
        { id: "h" },
      ),
    ).toBeNull();
    expect(locked.closedWith?.code).toBe(CloseCode.LOCKED);
    expect(sfu.callsTo("createTransport")).toHaveLength(2);
    await request(t, host, HOST, "host.lock", { locked: false });
    const ann = await join(t, { participant_id: A });
    await request(t, host, HOST, "host.remove", { participant_id: A });
    expect(ann.closedWith?.code).toBe(CloseCode.REMOVED);
    const again = new FakeLink();
    expect(
      await t.controller.attach(
        again,
        mintClaims({ session_id: t.room.sessionId, participant_id: A }),
        { id: "h" },
      ),
    ).toBeNull();
    expect(again.closedWith?.code).toBe(CloseCode.REMOVED);
    expect(again.sent).toEqual([
      { type: "error", id: "h", payload: { code: "FORBIDDEN", message: "departed: removed" } },
    ]);
  });

  it("after close, a hello is refused with 1012 (restarting), not 4004 (ended)", async () => {
    const t = await startRoom();
    await t.controller.close();
    const link = new FakeLink();
    expect(
      await t.controller.attach(
        link,
        mintClaims({ session_id: t.room.sessionId, participant_id: A }),
        { id: "h" },
      ),
    ).toBeNull();
    expect(link.closedWith).toEqual({ code: 1012, reason: "controller restarting" });
    expect(link.sent).toEqual([
      {
        type: "error",
        id: "h",
        payload: { code: "CONTROLLER_BUSY", message: "controller restarting, retry" },
      },
    ]);
  });

  it("a hello whose controller closes while its transports are being created closes 1012 and leaves nothing behind", async () => {
    const hooks: ControllerHooks = {};
    const t = await createTestController({ infra, sfu, hooks });
    live.push(t);
    hooks.beforeJoinApply = () => t.controller.close();
    const link = new FakeLink();
    expect(
      await t.controller.attach(
        link,
        mintClaims({ session_id: t.room.sessionId, participant_id: A }),
        { id: "h" },
      ),
    ).toBeNull();
    expect(link.ofType("error")[0]?.payload.code).toBe("CONTROLLER_BUSY");
    expect(link.closedWith).toEqual({ code: 1012, reason: "controller restarting" });
    expect(sfu.callsTo("closeTransport").map((c) => c.request["transportId"])).toEqual([
      "t1",
      "t2",
    ]);
    expect(t.room.inRoster(A)).toBe(false);
    expect(t.controller.connectionCount).toBe(0);
    expect(t.controller.isGone).toBe(true);
  });

  it("a resume whose controller closes while its transports are being rebuilt closes 1012 and drops the new transports", async () => {
    const hooks: ControllerHooks = {};
    const t = await createTestController({ infra, sfu, hooks });
    live.push(t);
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    await request(t, ann, A, "publish", {
      kind: "audio",
      source: "mic",
      rtp_parameters: {},
      paused: false,
    });
    sfu.emit(S, {
      case: "transportClosed",
      value: { transportId: "t1", participantId: A, reason: "dtls" },
    });
    // The producer close behind it proves both events were processed (track.removed reaches A).
    sfu.emit(S, {
      case: "producerClosed",
      value: { producerId: "p1", trackId: "trk1", participantId: A },
    });
    await ann.waitFor("track.removed");
    t.controller.detach(ann, A);
    hooks.beforeJoinApply = () => t.controller.close();
    const back = new FakeLink();
    expect(
      await t.controller.attach(back, mintClaims({ session_id: S, participant_id: A }), {
        id: "re",
      }),
    ).toBeNull();
    expect(back.ofType("error")[0]?.payload.code).toBe("CONTROLLER_BUSY");
    expect(back.closedWith).toEqual({ code: 1012, reason: "controller restarting" });
    expect(sfu.callsTo("createTransport")).toHaveLength(4);
    // t2 went when the rebuild started; t3 and t4 are the pair the closed controller must not keep.
    expect(sfu.callsTo("closeTransport").map((c) => c.request["transportId"])).toEqual([
      "t2",
      "t3",
      "t4",
    ]);
    expect(t.controller.connectionCount).toBe(0);
  });
});

describe("RoomController: lobby", () => {
  it("waiters get a lobby welcome, hosts get lobby.request; admit sends lobby.result then resync with media", async () => {
    const t = await startRoom();
    const host = await join(t, { participant_id: HOST, role: "host" });
    const waiter = await join(t, { participant_id: W, lobby: true, display_name: "Wren" });
    expect(waiter.sent).toEqual([
      { type: "ack", id: "hello-4444", payload: { mode: "welcome", epoch: 1, seq: 2 } },
      {
        type: "welcome",
        payload: { participant_id: W, role: "attendee", epoch: 1, seq: 2, state: "lobby" },
      },
    ]);
    expect(host.last()).toMatchObject({
      type: "lobby.request",
      payload: { participant_id: W, name: "Wren" },
    });
    expect(sfu.callsTo("createTransport")).toHaveLength(2);

    const reply = await request(t, host, HOST, "host.admit", { participant_id: W });
    expect(reply.type).toBe("ack");
    expect(waiter.sent.slice(2).map((m) => m.type)).toEqual(["lobby.result", "resync"]);
    expect(waiter.ofType("resync")[0]?.payload).toMatchObject({
      state: "joined",
      media: { send_transport: { id: "t3" }, recv_transport: { id: "t4" } },
    });
    // The fanout runs inside dispatch, so the host sees the join notice right before its own ack.
    expect(host.sent.at(-2)).toMatchObject({
      type: "participant.joined",
      payload: { participant: { participant_id: W } },
    });
    expect(host.last()?.type).toBe("ack");
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

  it("a double admit yields one join and one NOT_FOUND, and the waiter keeps working transports", async () => {
    const t = await startRoom();
    const host = await join(t, { participant_id: HOST, role: "host" });
    const waiter = await join(t, { participant_id: W, lobby: true });
    await Promise.all([
      t.controller.handle(host, HOST, msg("host.admit", { participant_id: W }, "admit-1")),
      t.controller.handle(host, HOST, msg("host.admit", { participant_id: W }, "admit-2")),
    ]);
    const replies = host.sent.filter(
      (m) => (m.type === "ack" || m.type === "error") && (m.id === "admit-1" || m.id === "admit-2"),
    );
    expect(replies.map((m) => m.type).sort()).toEqual(["ack", "error"]);
    expect(host.ofType("error")[0]?.payload.code).toBe("NOT_FOUND");
    expect(waiter.ofType("resync")).toHaveLength(1);
    expect(t.room.inRoster(W)).toBe(true);
    // The loser queued behind the winner on the waiter's lock and never reached the SFU.
    expect(sfu.callsTo("createTransport")).toHaveLength(4);
    expect(sfu.callsTo("closeTransport")).toHaveLength(0);
    const connect = await request(t, waiter, W, "connect_transport", {
      transport: "send",
      dtls_parameters: {},
    });
    expect(connect.type).toBe("ack");
    expect(sfu.callsTo("connectTransport")[0]?.request["transportId"]).toBe("t3");
  });

  it("an admit whose controller closes while its transports are being created fails CONTROLLER_BUSY and closes them", async () => {
    const hooks: ControllerHooks = {};
    const t = await createTestController({ infra, sfu, hooks });
    live.push(t);
    const host = await join(t, { participant_id: HOST, role: "host" });
    const waiter = await join(t, { participant_id: W, lobby: true });
    hooks.beforeJoinApply = () => t.controller.close();
    const reply = await request(t, host, HOST, "host.admit", { participant_id: W });
    expect(reply).toMatchObject({ type: "error", payload: { code: "CONTROLLER_BUSY" } });
    expect(sfu.callsTo("closeTransport").map((c) => c.request["transportId"])).toEqual([
      "t3",
      "t4",
    ]);
    expect(t.room.inRoster(W)).toBe(false);
    expect(t.room.inLobby(W)).toBe(true);
    expect(waiter.ofType("resync")).toEqual([]);
    expect(host.closedWith?.code).toBe(1012);
    expect(waiter.closedWith?.code).toBe(1012);
  });

  it("an admit whose waiter is denied mid-flight fails NOT_FOUND and closes only the transports it created", async () => {
    const t = await startRoom();
    const host = await join(t, { participant_id: HOST, role: "host" });
    const waiter = await join(t, { participant_id: W, lobby: true });
    const admit = t.controller.handle(
      host,
      HOST,
      msg("host.admit", { participant_id: W }, "admit-1"),
    );
    // Only microtasks pass here, so the admit is parked on its CreateTransport calls when the deny lands.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await t.controller.handle(host, HOST, msg("host.deny", { participant_id: W }, "deny-1"));
    await admit;
    expect(host.sent.find((m) => m.type === "ack" && m.id === "deny-1")).toBeDefined();
    expect(host.sent.find((m) => m.type === "error" && m.id === "admit-1")?.payload).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(waiter.closedWith?.code).toBe(CloseCode.LOBBY_DENIED);
    expect(t.room.inRoster(W)).toBe(false);
    expect(sfu.callsTo("createTransport").map((c) => c.request["participantId"])).toEqual([
      HOST,
      HOST,
      W,
      W,
    ]);
    expect(sfu.callsTo("closeTransport").map((c) => c.request["transportId"])).toEqual([
      "t3",
      "t4",
    ]);
    expect(sfu.room(t.room.sessionId)?.transports.size).toBe(2);
  });
});

describe("RoomController: media", () => {
  it("publish honours the mute state, subscribe diffs consumers, consumer_ready resumes, prefs call SetLayer", async () => {
    const t = await startRoom();
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    await request(t, ann, A, "connect_transport", {
      transport: "send",
      dtls_parameters: { role: "client" },
    });
    expect(sfu.callsTo("connectTransport")[0]?.request["transportId"]).toBe("t1");

    await request(t, ann, A, "set_media_state", { muted: true });
    expect(bob.last()).toMatchObject({
      type: "participant.updated",
      payload: { participant_id: A, patch: { muted: true } },
    });
    const mic = await request(t, ann, A, "publish", {
      kind: "audio",
      source: "mic",
      rtp_parameters: { codecs: [] },
      paused: false,
    });
    expect(mic).toMatchObject({ type: "ack", payload: { track_id: "trk1" } });
    expect(sfu.callsTo("publish")[0]?.request["paused"]).toBe(true);
    expect(bob.last()).toMatchObject({
      type: "track.added",
      payload: { track: { track_id: "trk1", owner: A, paused: true, layers: 1 } },
    });
    const cam = await request(t, ann, A, "publish", {
      kind: "video",
      source: "camera",
      rtp_parameters: { codecs: [] },
      paused: false,
    });
    expect(cam).toMatchObject({ type: "ack", payload: { track_id: "trk2" } });

    const noCaps = await request(t, bob, B, "subscribe", {
      track_ids: ["trk1", "trk2"],
      prefs: {},
    });
    expect(noCaps).toMatchObject({ type: "error", payload: { code: "INVALID" } });
    const first = await request(t, bob, B, "subscribe", {
      rtp_capabilities: CAPS,
      track_ids: ["trk1", "trk2"],
      prefs: {},
    });
    expect(first).toMatchObject({
      type: "ack",
      payload: {
        consumers: [
          {
            track_id: "trk1",
            consumer_id: "c1",
            producer_id: "p1",
            kind: "audio",
            producer_paused: true,
          },
          {
            track_id: "trk2",
            consumer_id: "c2",
            producer_id: "p2",
            kind: "video",
            producer_paused: false,
          },
        ],
        removed: [],
      },
    });
    expect(sfu.room(t.room.sessionId)?.consumers.get("c2")?.paused).toBe(true);
    await request(t, bob, B, "consumer_ready", { track_id: "trk2" });
    expect(sfu.room(t.room.sessionId)?.consumers.get("c2")?.paused).toBe(false);

    const prefs = await request(t, bob, B, "subscribe", {
      track_ids: ["trk1", "trk2"],
      prefs: { trk2: { max_layer: 0 } },
    });
    expect(prefs).toMatchObject({ type: "ack", payload: { consumers: [], removed: [] } });
    expect(sfu.callsTo("setLayer")).toHaveLength(1);
    expect(sfu.callsTo("setLayer")[0]?.request).toMatchObject({
      consumerId: "c2",
      spatialLayer: 0,
    });

    const drop = await request(t, bob, B, "subscribe", {
      track_ids: ["trk2"],
      prefs: { trk2: { max_layer: 0 } },
    });
    expect(drop).toMatchObject({ type: "ack", payload: { consumers: [], removed: ["trk1"] } });
    expect(sfu.callsTo("unsubscribe")[0]?.request["consumerId"]).toBe("c1");

    await request(t, ann, A, "set_media_state", { muted: false });
    expect(sfu.callsTo("setProducerPaused")[0]?.request).toMatchObject({
      producerId: "p1",
      paused: false,
    });
    expect(bob.ofType("track.updated").at(-1)?.payload).toEqual({
      track_id: "trk1",
      patch: { paused: false },
    });

    const unpublish = await request(t, ann, A, "unpublish", { track_id: "trk2" });
    expect(unpublish.type).toBe("ack");
    expect(sfu.callsTo("unpublish")[0]?.request["producerId"]).toBe("p2");
    expect(bob.last()).toMatchObject({ type: "track.removed", payload: { track_id: "trk2" } });
    expect((await request(t, bob, B, "unpublish", { track_id: "trk1" })).type).toBe("error");
    expect((await request(t, bob, B, "restart_ice", { transport: "send" })).payload).toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("host.mute pauses the target's mic and audits; a host muting themselves is a plain media state change", async () => {
    const t = await startRoom();
    const audits: unknown[] = [];
    infra.bus.subscribe("host.action", (e) => {
      audits.push(e.payload);
    });
    const host = await join(t, { participant_id: HOST, role: "host" });
    const ann = await join(t, { participant_id: A });
    await request(t, ann, A, "publish", {
      kind: "audio",
      source: "mic",
      rtp_parameters: {},
      paused: false,
    });
    expect(await request(t, ann, A, "host.mute", { participant_id: HOST })).toMatchObject({
      type: "error",
      payload: { code: "FORBIDDEN" },
    });
    expect((await request(t, host, HOST, "host.mute", { participant_id: A })).type).toBe("ack");
    expect(sfu.callsTo("setProducerPaused").map((c) => c.request)).toMatchObject([
      { producerId: "p1", paused: true },
    ]);
    expect(t.room.rosterEntry(A)?.muted).toBe(true);
    expect(ann.ofType("participant.updated").at(-1)?.payload).toEqual({
      participant_id: A,
      patch: { muted: true },
    });
    expect((await request(t, host, HOST, "host.mute", { participant_id: HOST })).type).toBe("ack");
    expect(t.room.rosterEntry(HOST)?.muted).toBe(true);
    await infra.bus.drain();
    expect(audits).toEqual([
      { session_id: t.room.sessionId, actor_id: HOST, action: "mute", target_id: A },
    ]);
  });

  it("a chat to yourself arrives once", async () => {
    const t = await startRoom();
    const ann = await join(t, { participant_id: A });
    expect((await request(t, ann, A, "chat", { body: "note to self", to: A })).type).toBe("ack");
    expect(ann.ofType("chat")).toHaveLength(1);
    expect(ann.ofType("chat")[0]?.payload).toMatchObject({ from: A, to: A, body: "note to self" });
  });

  it("stats events: layers reach only the subscriber, speakers become active_speakers, producer_closed drops the track", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    await request(t, ann, A, "publish", {
      kind: "video",
      source: "camera",
      rtp_parameters: {},
      paused: false,
    });
    await request(t, bob, B, "subscribe", {
      rtp_capabilities: CAPS,
      track_ids: ["trk1"],
      prefs: {},
    });

    sfu.emit(S, {
      case: "consumerLayers",
      value: { consumerId: "c1", active: true, spatialLayer: 1, temporalLayer: 2 },
    });
    const layers = await bob.waitFor("track.updated");
    expect(layers.payload).toEqual({ track_id: "trk1", patch: { layers: 2 } });
    expect(ann.ofType("track.updated")).toEqual([]);

    sfu.emit(S, {
      case: "dominantSpeakers",
      value: { speakers: [{ participantId: A, producerId: "p1", volume: -20 }] },
    });
    await sleep(320);
    sfu.emit(S, {
      case: "dominantSpeakers",
      value: { speakers: [{ participantId: A, producerId: "p1", volume: -20 }] },
    });
    const active = await bob.waitFor("active_speakers");
    expect(active.payload).toEqual({ participant_ids: [A] });
    expect(ann.ofType("active_speakers")[0]?.payload).toEqual({ participant_ids: [A] });
    sfu.emit(S, { case: "silence", value: {} });
    await bob.waitFor("active_speakers", (m) => m.payload.participant_ids.length === 0);

    sfu.emit(S, {
      case: "producerClosed",
      value: { producerId: "p1", trackId: "trk1", participantId: A },
    });
    const removed = await bob.waitFor("track.removed");
    expect(removed.payload).toEqual({ track_id: "trk1" });
    expect(t.room.tracks()).toEqual([]);
  });

  it("subscribe rolls back the consumers it created when a later Subscribe fails", async () => {
    const t = await startRoom();
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    await request(t, ann, A, "publish", {
      kind: "audio",
      source: "mic",
      rtp_parameters: {},
      paused: false,
    });
    await request(t, ann, A, "publish", {
      kind: "video",
      source: "camera",
      rtp_parameters: {},
      paused: false,
    });
    sfu.failNext("subscribe", Code.Internal, 1);
    const failed = await request(t, bob, B, "subscribe", {
      rtp_capabilities: CAPS,
      track_ids: ["trk1", "trk2"],
      prefs: {},
    });
    expect(failed).toMatchObject({ type: "error", payload: { code: "SFU_ERROR" } });
    expect(sfu.callsTo("unsubscribe").map((c) => c.request["consumerId"])).toEqual(["c1"]);
    expect(sfu.room(t.room.sessionId)?.consumers.size).toBe(0);
    const retry = await request(t, bob, B, "subscribe", {
      rtp_capabilities: CAPS,
      track_ids: ["trk1", "trk2"],
      prefs: {},
    });
    expect(retry).toMatchObject({
      type: "ack",
      payload: {
        consumers: [
          { track_id: "trk1", consumer_id: "c2" },
          { track_id: "trk2", consumer_id: "c3" },
        ],
        removed: [],
      },
    });
  });

  it("consumer_ready marks the consumer ready only once the SFU unpaused it, so a retry works", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    await request(t, ann, A, "publish", {
      kind: "video",
      source: "camera",
      rtp_parameters: {},
      paused: false,
    });
    await request(t, bob, B, "subscribe", {
      rtp_capabilities: CAPS,
      track_ids: ["trk1"],
      prefs: {},
    });
    sfu.failNext("setConsumerPaused", Code.Internal);
    const failed = await request(t, bob, B, "consumer_ready", { track_id: "trk1" });
    expect(failed).toMatchObject({ type: "error", payload: { code: "SFU_ERROR" } });
    expect(sfu.room(S)?.consumers.get("c1")?.paused).toBe(true);
    const retry = await request(t, bob, B, "consumer_ready", { track_id: "trk1" });
    expect(retry.type).toBe("ack");
    expect(sfu.callsTo("setConsumerPaused").map((c) => c.request)).toMatchObject([
      { consumerId: "c1", paused: false },
      { consumerId: "c1", paused: false },
    ]);
    expect(sfu.room(S)?.consumers.get("c1")?.paused).toBe(false);
  });

  it("a stats reopen keeps a consumer that is not ready yet, so consumer_ready still unpauses it", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    await request(t, ann, A, "publish", {
      kind: "video",
      source: "camera",
      rtp_parameters: {},
      paused: false,
    });
    await request(t, bob, B, "subscribe", {
      rtp_capabilities: CAPS,
      track_ids: ["trk1"],
      prefs: {},
    });
    // A producer that appeared while the stream was down makes the reconcile observable (track.added).
    sfu.seedRoom(S, {
      producers: [{ participantId: A, trackId: "extra", kind: "audio", source: "mic" }],
    });
    sfu.dropStreams(S);
    await bob.waitFor("track.added", (m) => m.payload.track.track_id === "extra");
    // The snapshot reports c1 paused (nobody unpaused it yet); that must not become the client's preference.
    await request(t, bob, B, "consumer_ready", { track_id: "trk1" });
    expect(sfu.callsTo("setConsumerPaused").map((c) => c.request)).toMatchObject([
      { consumerId: "c1", paused: false },
    ]);
    expect(sfu.room(S)?.consumers.get("c1")?.paused).toBe(false);
  });

  it("publish re-checks the mute state after the SFU call and pauses a producer muted mid-flight", async () => {
    const t = await startRoom();
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    const publish = t.controller.handle(
      ann,
      A,
      msg("publish", { kind: "audio", source: "mic", rtp_parameters: {}, paused: false }, "pub-1"),
    );
    // Only microtasks pass here, so Publish is still in flight at the SFU when the mute lands.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await request(t, ann, A, "set_media_state", { muted: true });
    await publish;
    expect(ann.sent.find((m) => m.type === "ack" && m.id === "pub-1")?.payload).toEqual({
      track_id: "trk1",
    });
    expect(sfu.callsTo("publish")[0]?.request["paused"]).toBe(false);
    expect(sfu.callsTo("setProducerPaused").map((c) => c.request)).toMatchObject([
      { producerId: "p1", paused: true },
    ]);
    expect(sfu.room(t.room.sessionId)?.producers.get("p1")?.paused).toBe(true);
    expect(t.room.track("trk1")?.paused).toBe(true);
    expect(bob.ofType("track.added")[0]?.payload.track).toMatchObject({
      track_id: "trk1",
      paused: true,
    });
  });

  it("publishing a source again replaces its live track: the old producer is unpublished and the others see removed then added", async () => {
    const t = await startRoom();
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    const mic = { kind: "audio", source: "mic", rtp_parameters: {}, paused: false } as const;
    expect(await request(t, ann, A, "publish", mic)).toMatchObject({
      type: "ack",
      payload: { track_id: "trk1" },
    });
    expect(await request(t, ann, A, "publish", mic)).toMatchObject({
      type: "ack",
      payload: { track_id: "trk2" },
    });
    expect(sfu.callsTo("unpublish").map((c) => c.request["producerId"])).toEqual(["p1"]);
    expect(sfu.room(t.room.sessionId)?.producers.size).toBe(1);
    expect(t.room.tracksOf(A, "mic").map((x) => x.track_id)).toEqual(["trk2"]);
    expect(bob.sent.slice(-2).map((m) => m.type)).toEqual(["track.removed", "track.added"]);
    expect(bob.ofType("track.removed")[0]?.payload).toEqual({ track_id: "trk1" });
    expect(bob.ofType("track.added").at(-1)?.payload.track.track_id).toBe("trk2");
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
    expect(bob.last()).toMatchObject({
      type: "participant.updated",
      payload: { participant_id: A, patch: { connected: false } },
    });
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
    expect(bob.last()).toMatchObject({
      type: "participant.updated",
      payload: { participant_id: A, patch: { connected: true } },
    });

    const left: unknown[] = [];
    infra.bus.subscribe("participant.left", (e) => {
      left.push(e.payload);
    });
    t.controller.detach(back, A);
    await bob.waitFor("participant.left");
    expect(bob.ofType("participant.left")[0]?.payload).toEqual({
      participant_id: A,
      reason: "timeout",
    });
    // The leave is fanned out before the transports are closed; give the two SFU calls time to land.
    await waitFor(() => sfu.callsTo("closeTransport").length === 2);
    expect(
      sfu
        .callsTo("closeTransport")
        .map((c) => c.request["transportId"])
        .sort(),
    ).toEqual(["t1", "t2"]);
    await infra.bus.drain();
    expect(left[0]).toMatchObject({ participant_id: A, reason: "timeout" });
    const late = new FakeLink();
    expect(
      await t.controller.attach(late, mintClaims({ session_id: S, participant_id: A }), {
        id: "x",
      }),
    ).toBeNull();
    expect(late.closedWith?.code).toBe(CloseCode.REJOIN_REQUIRED);
  });

  it("resyncs on an epoch mismatch or stale cursor, and a newer connection replaces the older one with 4005 and no grace", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    const stale = new FakeLink();
    await t.controller.attach(stale, mintClaims({ session_id: S, participant_id: A }), {
      id: "s",
      resume_seq: 0,
      epoch: 7,
    });
    expect(stale.sent.map((m) => m.type)).toEqual(["ack", "resync"]);
    expect(stale.sent[0]).toMatchObject({ payload: { mode: "resync" } });
    expect(stale.ofType("resync")[0]?.payload.media?.send_transport.id).toBe("t1");
    expect(ann.closedWith?.code).toBe(CloseCode.REPLACED);
    t.controller.detach(ann, A);
    expect(bob.ofType("participant.updated")).toEqual([]);
    expect(t.room.rosterEntry(A)?.connected).toBe(true);
  });

  it("a resume that has to rebuild transports keeps the client's rtp capabilities", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    await request(t, ann, A, "publish", {
      kind: "video",
      source: "camera",
      rtp_parameters: {},
      paused: false,
    });
    await request(t, bob, B, "subscribe", {
      rtp_capabilities: CAPS,
      track_ids: ["trk1"],
      prefs: {},
    });
    // The SFU drops B's recv transport; the layers event behind it proves both events were processed.
    sfu.emit(S, {
      case: "transportClosed",
      value: { transportId: "t4", participantId: B, reason: "dtls" },
    });
    sfu.emit(S, {
      case: "consumerLayers",
      value: { consumerId: "c1", active: true, spatialLayer: 0, temporalLayer: 0 },
    });
    await bob.waitFor("track.updated");
    t.controller.detach(bob, B);
    const back = new FakeLink();
    expect(
      await t.controller.attach(back, mintClaims({ session_id: S, participant_id: B }), {
        id: "re",
      }),
    ).toBe(B);
    expect(back.ofType("resync")[0]?.payload.media).toMatchObject({
      send_transport: { id: "t5" },
      recv_transport: { id: "t6" },
    });
    expect(sfu.callsTo("closeTransport").map((c) => c.request["transportId"])).toEqual(["t3"]);
    const again = await request(t, back, B, "subscribe", { track_ids: ["trk1"], prefs: {} });
    expect(again).toMatchObject({
      type: "ack",
      payload: { consumers: [{ track_id: "trk1", consumer_id: "c2" }], removed: [] },
    });
    expect(sfu.callsTo("subscribe").at(-1)?.request["transportId"]).toBe("t6");
  });

  it("a resume that had to rebuild transports answers resync with the new media even when a replay would be possible", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    await request(t, ann, A, "publish", {
      kind: "audio",
      source: "mic",
      rtp_parameters: {},
      paused: false,
    });
    for (const transportId of ["t1", "t2"]) {
      sfu.emit(S, {
        case: "transportClosed",
        value: { transportId, participantId: A, reason: "dtls" },
      });
    }
    // The producer close behind them proves all three events were processed (track.removed reaches A).
    sfu.emit(S, {
      case: "producerClosed",
      value: { producerId: "p1", trackId: "trk1", participantId: A },
    });
    await ann.waitFor("track.removed");
    const seq = t.room.seq;
    t.controller.detach(ann, A);
    const back = new FakeLink();
    expect(
      await t.controller.attach(back, mintClaims({ session_id: S, participant_id: A }), {
        id: "re",
        resume_seq: seq,
        epoch: 1,
      }),
    ).toBe(A);
    expect(back.sent.map((m) => m.type)).toEqual(["ack", "resync"]);
    expect(back.sent[0]).toMatchObject({ payload: { mode: "resync" } });
    expect(back.ofType("resync")[0]?.payload.media).toMatchObject({
      send_transport: { id: "t3" },
      recv_transport: { id: "t4" },
    });
    expect(sfu.callsTo("createTransport")).toHaveLength(4);
  });

  it("a reopened stats stream whose snapshot lost the transports closes those sockets 1012, and the re-hello gets new media", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    const bob = await join(t, { participant_id: B });
    const seq = t.room.seq;
    // The SFU restarted: the room vanishes, the stream ends, the consumer reopens after an
    // AllocateRoom and the new snapshot carries no transports for anyone.
    const client = createClient(SfuService, createGrpcTransport({ baseUrl: sfu.baseUrl }));
    await client.closeRoom({ sessionId: S });
    await waitFor(() => ann.closed && bob.closed);
    for (const link of [ann, bob]) {
      expect(link.closedWith).toEqual({ code: 1012, reason: "media reset, reconnect" });
    }
    expect(t.controller.connectionCount).toBe(0);
    expect(t.room.rosterEntry(A)?.connected).toBe(false);
    expect(t.room.rosterEntry(B)?.connected).toBe(false);
    const back = new FakeLink();
    expect(
      await t.controller.attach(back, mintClaims({ session_id: S, participant_id: A }), {
        id: "re",
        resume_seq: seq,
        epoch: 1,
      }),
    ).toBe(A);
    expect(back.sent[0]).toMatchObject({ type: "ack", payload: { mode: "resync" } });
    expect(back.ofType("resync")[0]?.payload.media).toMatchObject({
      send_transport: { id: "t5" },
      recv_transport: { id: "t6" },
    });
    expect(sfu.callsTo("createTransport")).toHaveLength(6);
    expect(sfu.callsTo("closeTransport")).toHaveLength(0);
    expect(t.room.rosterEntry(A)?.connected).toBe(true);
  });
});

describe("RoomController: ending", () => {
  it("host.end acks first, then room.ended to everyone, closes 4004, CloseRoom, Redis ended, Postgres ended with peak", async () => {
    const { meetingId, sessionId } = await seedSession(infra.db);
    const t = await startRoom(sessionId);
    const ended: unknown[] = [];
    const busOrder: string[] = [];
    infra.bus.subscribe("session.ended", (e) => {
      ended.push(e.payload);
      busOrder.push(e.type);
    });
    const left: Array<{ participant_id: string; reason: string; left_at: string }> = [];
    infra.bus.subscribe("participant.left", (e) => {
      left.push(e.payload);
      busOrder.push(e.type);
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
    for (const link of [host, ann, waiter])
      expect(link.closedWith?.code).toBe(CloseCode.ROOM_ENDED);
    expect(await t.gone).toBe(sessionId);
    expect(sfu.callsTo("closeRoom")).toHaveLength(1);
    expect(await infra.redis.hgetall(roomKeys(sessionId).meta)).toMatchObject({
      status: "ended",
      end_reason: "host_end",
    });
    const [session] = await infra.db<{ endedAt: Date | null; peakParticipants: number | null }[]>`
      SELECT ended_at, peak_participants FROM meeting_sessions WHERE id = ${sessionId}`;
    expect(session?.endedAt).not.toBeNull();
    expect(session?.peakParticipants).toBe(2);
    const [meeting] = await infra.db<{ status: string }[]>`
      SELECT status FROM meetings WHERE id = ${meetingId}`;
    expect(meeting?.status).toBe("ended");
    await infra.bus.drain();
    expect(ended[0]).toMatchObject({
      session_id: sessionId,
      reason: "host_end",
      peak_participants: 2,
    });
    // Roster members get a participant.left (reason ended) before session.ended, so their
    // attendance rows receive left_at; the waiter never joined and gets none.
    expect(left.map((p) => p.participant_id).sort()).toEqual([HOST, A].sort());
    for (const p of left) {
      expect(p.reason).toBe("ended");
      expect(Date.parse(p.left_at)).not.toBeNaN();
    }
    expect(busOrder).toEqual(["participant.left", "participant.left", "session.ended"]);
    expect(await infra.redis.exists(roomKeys(sessionId).owner)).toBe(0);
    const late = new FakeLink();
    expect(
      await t.controller.attach(late, mintClaims({ session_id: sessionId, participant_id: B }), {
        id: "late",
      }),
    ).toBeNull();
    expect(late.sent).toEqual([
      { type: "error", id: "late", payload: { code: "FORBIDDEN", message: "room ended" } },
    ]);
    expect(late.closedWith?.code).toBe(CloseCode.ROOM_ENDED);
  });

  it("an idle room ends with reason idle and the meeting returns to scheduled; endRoom runs once", async () => {
    const { meetingId, sessionId } = await seedSession(infra.db);
    const t = await startRoom(sessionId);
    const ann = await join(t, { participant_id: A });
    await sleep(500);
    expect(t.controller.isGone).toBe(false);
    t.controller.detach(ann, A);
    expect(await t.gone).toBe(sessionId);
    // The database is truncated once per file, so earlier tests' meetings are still there.
    const [meeting] = await infra.db<{ status: string }[]>`
      SELECT status FROM meetings WHERE id = ${meetingId}`;
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
    const again = await startRoom(
      sessionId,
      Room.fromSnapshot(t.room.toSnapshot(), { bumpEpoch: true }),
    );
    await again.controller.endRoom("api_end");
    expect(await infra.redis.hget(roomKeys(sessionId).meta, "end_reason")).toBe("api_end");
  });

  it("a lost lease closes the controller without touching the checkpoint", async () => {
    const t = await startRoom();
    const S = t.room.sessionId;
    const ann = await join(t, { participant_id: A });
    await sleep(60);
    expect(await infra.redis.hget(roomKeys(S).meta, "epoch")).toBe("1");
    // Another controller took the room over: the lease is gone and its checkpoint is ahead (epoch
    // 99, seq 500). Dirty sections stand in for the write-behind window the old owner still had.
    await infra.redis.del(roomKeys(S).owner);
    await infra.redis.hset(roomKeys(S).meta, "epoch", "99");
    await infra.redis.set(roomKeys(S).seq, "500");
    t.room.markAllDirty();
    expect(await t.gone).toBe(S);
    expect(t.controller.isGone).toBe(true);
    expect(ann.closedWith).toEqual({ code: 1012, reason: "controller lost ownership" });
    expect(await infra.redis.hget(roomKeys(S).meta, "epoch")).toBe("99");
    expect(await infra.redis.get(roomKeys(S).seq)).toBe("500");
    expect(await infra.redis.hget(roomKeys(S).meta, "status")).toBe("live");
    expect(await infra.redis.exists(roomKeys(S).owner)).toBe(0);
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
    const snapshot = Room.create({
      session_id: S,
      home_sfu: "fake-sfu",
      lobby_enabled: true,
      max_participants: 10,
    });
    snapshot.apply({ type: "join", participant_id: A, name: "Ann", role: "attendee" });
    snapshot.apply({ type: "join", participant_id: B, name: "Bob", role: "attendee" });
    snapshot.apply({
      type: "publish",
      participant_id: A,
      track: {
        track_id: "stale-mic",
        owner: A,
        kind: "audio",
        source: "mic",
        paused: false,
        layers: 1,
      },
    });
    const room = Room.fromSnapshot(snapshot.toSnapshot(), { bumpEpoch: true });
    const t = await startRoom(undefined, room);
    expect(room.epoch).toBe(2);
    expect(room.tracks().map((x) => x.track_id)).toEqual(["live-cam"]);
    expect(room.track("live-cam")).toMatchObject({
      owner: A,
      kind: "video",
      source: "camera",
      layers: 3,
    });

    const ann = new FakeLink();
    await t.controller.attach(ann, mintClaims({ session_id: S, participant_id: A }), {
      id: "h",
      resume_seq: 3,
      epoch: 1,
    });
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
