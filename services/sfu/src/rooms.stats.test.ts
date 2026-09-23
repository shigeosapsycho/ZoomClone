import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestManager, waitFor } from "../test/helpers";
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

describe("Room.openStats", () => {
  it("delivers events emitted after openStats but before the first pull", async () => {
    const room = await manager.allocate("stats-gap");
    const { transportId } = await room.createTransport("p1", "send");
    const opening = room.openStats();
    expect(opening.snapshot.transports.map((t) => t.transportId)).toEqual([transportId]);
    await room.closeTransport(transportId);
    const first = (await opening.events.next()).value;
    expect(first).toEqual({
      type: "transport_closed",
      transportId,
      participantId: "p1",
      reason: "closed",
    });
    await opening.events.return();
    expect(room.subscriberCount).toBe(0);
    await manager.close("stats-gap");
  });

  it("aborting the stream unregisters the subscriber, even when it was never pulled", async () => {
    const room = await manager.allocate("stats-abort");
    const controller = new AbortController();
    room.openStats(controller.signal);
    expect(room.subscriberCount).toBe(1);
    controller.abort();
    await waitFor(() => room.subscriberCount === 0);
    await manager.close("stats-abort");
  });

  it("opening stats on a closed room yields the snapshot and an already-ended stream", async () => {
    const room = await manager.allocate("stats-closed");
    await manager.close("stats-closed");
    const opening = room.openStats();
    expect(opening.snapshot).toEqual({ transports: [], producers: [], consumers: [] });
    expect((await opening.events.next()).done).toBe(true);
    expect(room.subscriberCount).toBe(0);
  });
});
