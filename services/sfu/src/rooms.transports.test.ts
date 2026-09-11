import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_DTLS_PARAMETERS, createTestManager, waitFor } from "../test/helpers";
import type { RoomEvent } from "./events";
import { RoomManager, roomOptionsFrom } from "./rooms";

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

  it("coalesces concurrent allocate calls for the same session", async () => {
    const sizeBefore = manager.size;
    const roomsBefore = ctx.slots[0]!.rooms;
    const rooms = await Promise.all([
      manager.allocate("race"),
      manager.allocate("race"),
      manager.allocate("race"),
    ]);
    expect(rooms[1]).toBe(rooms[0]);
    expect(rooms[2]).toBe(rooms[0]);
    expect(manager.size).toBe(sizeBefore + 1);
    expect(ctx.slots[0]!.rooms).toBe(roomsBefore + 1);
    await manager.close("race");
  });

  it("close waits for an in-flight allocation and closes the room it produced", async () => {
    const allocation = manager.allocate("pending-close");
    await manager.close("pending-close");
    const room = await allocation;
    expect(room.isClosed).toBe(true);
    expect(manager.get("pending-close")).toBeUndefined();
  });

  it("closeAllocated closes every allocated room synchronously", async () => {
    const a = await manager.allocate("sync-a");
    const b = await manager.allocate("sync-b");
    manager.closeAllocated();
    expect(a.isClosed).toBe(true);
    expect(b.isClosed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("closeAll waits for in-flight allocations so none survives it", async () => {
    const allocation = manager.allocate("pending-close-all");
    await manager.closeAll();
    expect((await allocation).isClosed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("closes the router when the audio level observer cannot be created", async () => {
    const slot = ctx.slots[0]!;
    const routersBefore = (await slot.worker.dump()).routerIds.length;
    const roomsBefore = slot.rooms;
    // mediasoup validates the interval's type in JS before talking to the worker; a non-number is
    // the one observer failure a test can provoke without mocks, hence the cast.
    const broken = new RoomManager(ctx.slots, {
      ...roomOptionsFrom(ctx.env),
      audioLevelIntervalMs: "soon" as unknown as number,
    });
    await expect(broken.allocate("no-observer")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(broken.size).toBe(0);
    expect(slot.rooms).toBe(roomsBefore);
    expect((await slot.worker.dump()).routerIds).toHaveLength(routersBefore);
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
    expect(send.iceCandidates[0]?.ip ?? send.iceCandidates[0]?.address).toBe(
      ctx.env.SFU_ANNOUNCED_IP,
    );
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
    const events: RoomEvent[] = [];
    const controller = new AbortController();
    const reader = (async () => {
      for await (const e of room.events(controller.signal)) events.push(e);
    })();
    const { transportId } = await room.createTransport("p2", "send");
    await room.closeTransport(transportId);
    await waitFor(() => events.some((e) => e.type === "transport_closed"));
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
    expect(snap.transports[0]).toMatchObject({
      participantId: "p1",
      direction: "send",
      iceState: "new",
      dtlsState: "new",
    });
    expect(snap.transports[0]?.iceParameters.usernameFragment).toBeTypeOf("string");
    expect(snap.transports[0]?.iceCandidates.length).toBeGreaterThan(0);
    expect(snap.transports[0]?.dtlsParameters.fingerprints.length).toBeGreaterThan(0);
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
