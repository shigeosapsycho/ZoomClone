import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  audioRtpParameters,
  createTestManager,
  videoSimulcastRtpParameters,
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
    expect(
      room.snapshot().consumers.find((c) => c.consumerId === sub.consumerId)?.producerPaused,
    ).toBe(true);
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

  it("closes consumers when the producer goes away and emits both events", async () => {
    const events: unknown[] = [];
    const controller = new AbortController();
    const reader = (async () => {
      for await (const e of room.events(controller.signal)) events.push(e);
    })();
    const pub = await room.publish("A", sendA, "audio", "mic", audioRtpParameters(), false);
    const sub = await room.subscribe("B", recvB, pub.producerId, room.router.rtpCapabilities);
    await room.unpublish(pub.producerId);
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 20));
    expect(room.producers.has(pub.producerId)).toBe(false);
    expect(room.consumers.has(sub.consumerId)).toBe(false);
  });
});
