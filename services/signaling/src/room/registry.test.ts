import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloseCode, type SignalingClaims } from "@zoomclone/protocol";
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
const W = "44444444-4444-4444-8444-444444444444";
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

async function attach(
  controller: Awaited<ReturnType<RoomRegistry["get"]>>,
  participantId: string,
  role: "host" | "attendee" = "attendee",
  hello: { resume_seq?: number; epoch?: number } = {},
  claims: Partial<SignalingClaims> = {},
) {
  const link = new FakeLink();
  const pid = await controller.attach(
    link,
    mintClaims({
      session_id: controller.sessionId,
      participant_id: participantId,
      role,
      ...claims,
    }),
    { id: `h-${participantId.slice(0, 4)}`, ...hello },
  );
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
    const room = Room.create({
      session_id: sessionId,
      home_sfu: "fake-sfu",
      lobby_enabled: true,
      max_participants: 10,
    });
    const checkpoint = new Checkpoint(infra.redis, room, { windowMs: 20 });
    await checkpoint.writeAll();
    await checkpoint.markEnded("host_end");
    const r = registry();
    await expect(r.get(sessionId, SEED)).rejects.toBeInstanceOf(RoomEndedError);
    expect(r.size).toBe(0);
    expect(await infra.redis.exists(roomKeys(sessionId).owner)).toBe(0);
  });

  it("answers ControllerBusyError once closeAll has started, so clients retry elsewhere", async () => {
    const { sessionId } = await seedSession(infra.db);
    const r = registry();
    await r.closeAll();
    await expect(r.get(sessionId, SEED)).rejects.toBeInstanceOf(ControllerBusyError);
    expect(r.size).toBe(0);
  });

  it("ends the room on a ctl end command and drops it from the registry", async () => {
    const { meetingId, sessionId } = await seedSession(infra.db);
    const r = registry();
    const controller = await r.get(sessionId, SEED);
    const { link } = await attach(controller, A);
    await infra.redis.publish(
      ctlChannel(sessionId),
      JSON.stringify({ cmd: "end", reason: "api_end" }),
    );
    await waitFor(() => r.size === 0);
    expect(link.ofType("room.ended")[0]?.payload).toEqual({ reason: "api_end" });
    expect(link.closedWith?.code).toBe(CloseCode.ROOM_ENDED);
    expect(await infra.redis.hgetall(roomKeys(sessionId).meta)).toMatchObject({
      status: "ended",
      end_reason: "api_end",
    });
    // The database is truncated once per file, so earlier tests' meetings are still there.
    const [meeting] = await infra.db<{ status: string }[]>`
      SELECT status FROM meetings WHERE id = ${meetingId}`;
    expect(meeting?.status).toBe("ended");
  });

  it("rehydrates from Redis plus the SFU snapshot: both-way reconcile, transports reused, and new ones when the SFU lost the room", async () => {
    const { sessionId } = await seedSession(infra.db);
    const first = registry();
    const c1 = await first.get(sessionId, SEED);
    const { link: host } = await attach(c1, HOST, "host");
    const { link: ann } = await attach(c1, A);
    await c1.handle(ann, A, {
      type: "publish",
      id: "p",
      payload: { kind: "audio", source: "mic", rtp_parameters: {}, paused: false },
    });
    expect(ann.ofType("ack").some((m) => m.id === "p")).toBe(true);
    const annSeq = c1.room.seq;
    await sleep(60);
    await first.closeAll();
    expect(host.closedWith?.code).toBe(1012);

    // While no controller runs: the SFU lost A's producer and gained one for the host.
    sfu.room(sessionId)?.producers.delete("p1");
    sfu.seedRoom(sessionId, {
      producers: [{ participantId: HOST, trackId: "host-cam", kind: "video", source: "camera" }],
    });

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

    // The SFU restarts: the room vanishes, the stats stream ends, the controller reopens and
    // reconciles against an empty snapshot. A's socket was attached to dead media, so it is
    // bounced; its re-hello rebuilds the transports even though a replay would be possible.
    const client = createClient(SfuService, createGrpcTransport({ baseUrl: sfu.baseUrl }));
    await client.closeRoom({ sessionId });
    await waitFor(() => annBack.closed);
    expect(annBack.closedWith).toEqual({ code: 1012, reason: "media reset, reconnect" });
    expect(c2.room.tracks()).toEqual([]);
    expect(c2.room.rosterEntry(A)).toMatchObject({ connected: false });
    const { link: annAgain } = await attach(c2, A, "attendee", {
      resume_seq: c2.room.seq,
      epoch: 2,
    });
    expect(annAgain.sent[0]).toMatchObject({ type: "ack", payload: { mode: "resync" } });
    expect(annAgain.ofType("resync")[0]?.payload.media).toMatchObject({
      send_transport: { id: "t5" },
      recv_transport: { id: "t6" },
    });
    const { link: hostBack } = await attach(c2, HOST, "host");
    expect(hostBack.ofType("resync")[0]?.payload.media?.send_transport.id).toBe("t7");
    expect(sfu.callsTo("createTransport")).toHaveLength(8);
  });

  it("a rehydrated room drops its lobby waiters and ends by idle when nobody reconnects", async () => {
    const { sessionId } = await seedSession(infra.db);
    const first = registry();
    const c1 = await first.get(sessionId, SEED);
    await attach(c1, HOST, "host");
    const { pid } = await attach(c1, W, "attendee", {}, { lobby: true });
    expect(pid).toBe(W);
    expect(c1.room.lobbyIds()).toEqual([W]);
    await sleep(60);
    expect(await infra.redis.hlen(roomKeys(sessionId).lobby)).toBe(1);
    await first.closeAll();

    // The waiter's socket died with the old process and waiters have no grace: the rehydrated
    // room starts without it, so the host's grace expiry alone makes the room idle.
    const second = registry({ idleMs: 200 });
    const c2 = await second.get(sessionId, SEED);
    expect(c2.room.lobby()).toEqual([]);
    expect(c2.room.rosterEntry(HOST)).toMatchObject({ connected: false });
    expect(await infra.redis.hlen(roomKeys(sessionId).lobby)).toBe(0);
    await waitFor(() => second.size === 0, 3000);
    expect(second.size).toBe(0);
    expect(await infra.redis.hgetall(roomKeys(sessionId).meta)).toMatchObject({
      status: "ended",
      end_reason: "idle",
    });
  });
});
