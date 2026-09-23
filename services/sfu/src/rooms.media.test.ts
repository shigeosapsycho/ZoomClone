import type { types as ms } from "mediasoup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  audioRtpParameters,
  createTestManager,
  videoSimulcastRtpParameters,
  waitFor,
} from "../test/helpers";
import type { RoomEvent } from "./events";
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
    const result = await room.publish("A", sendA, "audio", "mic", audioRtpParameters(), false);
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
    const result = await room.publish(
      "A",
      sendA,
      "video",
      "camera",
      videoSimulcastRtpParameters(),
      true,
    );
    expect(result.layerCount).toBe(3);
    expect(room.producers.get(result.producerId)?.producer.paused).toBe(true);
    expect(room.snapshot().producers.find((p) => p.producerId === result.producerId)?.paused).toBe(
      true,
    );
  });

  it("rejects the wrong participant, the wrong direction and unknown transports", async () => {
    await expect(
      room.publish("B", sendA, "audio", "mic", audioRtpParameters(), false),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      room.publish("B", recvB, "audio", "mic", audioRtpParameters(), false),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    await expect(
      room.publish("A", "nope", "audio", "mic", audioRtpParameters(), false),
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
    const pub = await room.publish(
      "A",
      sendA,
      "video",
      "camera",
      videoSimulcastRtpParameters(),
      false,
    );
    const sub = await room.subscribe(
      "B",
      recvB,
      pub.producerId,
      room.router.rtpCapabilities,
      1,
      10,
    );
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
    // The consumer learns of the pause from a worker notification that races the pause() reply.
    await waitFor(() => entry.consumer.producerPaused);
    expect(
      room.snapshot().consumers.find((c) => c.consumerId === sub.consumerId)?.producerPaused,
    ).toBe(true);
  });

  it("rejects capabilities that cannot consume the producer as FAILED_PRECONDITION", async () => {
    const pub = await room.publish(
      "A",
      sendA,
      "video",
      "camera",
      videoSimulcastRtpParameters(),
      false,
    );
    const routerCaps = room.router.rtpCapabilities;
    const audioOnly: ms.RtpCapabilities = {
      codecs: routerCaps.codecs?.filter((c) => c.mimeType === "audio/opus"),
      headerExtensions: routerCaps.headerExtensions,
    };
    expect(audioOnly.codecs).toHaveLength(1);
    await expect(room.subscribe("B", recvB, pub.producerId, audioOnly)).rejects.toMatchObject({
      code: "FAILED_PRECONDITION",
    });
  });

  it("rejects cross-room producers, unknown producers and send transports", async () => {
    const other = await manager.allocate("media-2");
    const otherSend = (await other.createTransport("Z", "send")).transportId;
    const pub = await other.publish("Z", otherSend, "audio", "mic", audioRtpParameters(), false);
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

  it("rejects another room's transport as PERMISSION_DENIED, not NOT_FOUND", async () => {
    const other = await manager.allocate("media-3");
    const pub = await room.publish("A", sendA, "audio", "mic", audioRtpParameters(), false);
    await expect(
      manager.publish("media-3", "A", sendA, "audio", "mic", audioRtpParameters(), false),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      manager.subscribe("media-3", "B", recvB, pub.producerId, other.router.rtpCapabilities),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      manager.publish("media-3", "A", "nope", "audio", "mic", audioRtpParameters(), false),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(other.producers.size).toBe(0);
    expect(other.consumers.size).toBe(0);
  });

  it("closes consumers when the producer goes away and emits both events", async () => {
    const events: RoomEvent[] = [];
    const controller = new AbortController();
    const reader = (async () => {
      for await (const e of room.events(controller.signal)) events.push(e);
    })();
    const pub = await room.publish("A", sendA, "audio", "mic", audioRtpParameters(), false);
    const sub = await room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities);
    await room.unpublish(pub.producerId);
    // producer_closed is emitted inline; consumer_closed follows the worker's producerclose.
    await waitFor(() => events.some((e) => e.type === "consumer_closed"));
    expect(room.producers.has(pub.producerId)).toBe(false);
    expect(room.consumers.has(sub.consumerId)).toBe(false);
    expect(events).toContainEqual({
      type: "consumer_closed",
      consumerId: sub.consumerId,
      reason: "producerclose",
    });
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
    const pub = await room.publish("A", sendA, "audio", "mic", audioRtpParameters(), false);
    const sub = await room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities);
    await room.unsubscribe(sub.consumerId);
    expect(room.consumers.has(sub.consumerId)).toBe(false);
    expect(room.producers.has(pub.producerId)).toBe(true);
    await expect(room.setConsumerPaused(sub.consumerId, false)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("closing a transport closes its producers and consumers", async () => {
    const sendC = (await room.createTransport("C", "send")).transportId;
    const pub = await room.publish("C", sendC, "audio", "mic", audioRtpParameters(), false);
    const sub = await room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities);
    await room.closeTransport(sendC);
    await waitFor(() => !room.consumers.has(sub.consumerId));
    expect(room.producers.has(pub.producerId)).toBe(false);
    expect(room.consumers.has(sub.consumerId)).toBe(false);
  });
});

describe("rollback", () => {
  it("rolls back a producer when the audio level observer rejects it", async () => {
    const failRoom = await manager.allocate("media-rollback-producer");
    const send = (await failRoom.createTransport("A", "send")).transportId;
    failRoom.audioLevelObserver.close();
    await expect(
      failRoom.publish("A", send, "audio", "mic", audioRtpParameters(), false),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(failRoom.producers.size).toBe(0);
    expect(failRoom.snapshot().producers).toEqual([]);
    await manager.close("media-rollback-producer");
  });

  it("rolls back a consumer when the priority is invalid", async () => {
    const pub = await room.publish(
      "A",
      sendA,
      "video",
      "camera",
      videoSimulcastRtpParameters(),
      false,
    );
    const sizeBefore = room.consumers.size;
    await expect(
      room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities, undefined, 0),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(room.consumers.size).toBe(sizeBefore);
    // The worker must agree: a consumer left alive but untracked would still show up in the dump.
    const dump = await room.requireTransport(recvB).transport.dump();
    const tracked = [...room.consumers.values()]
      .filter((c) => c.transportId === recvB)
      .map((c) => c.consumer.id);
    expect([...dump.consumerIds].sort()).toEqual(tracked.sort());
  });
});
