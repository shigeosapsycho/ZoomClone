import { Code, ConnectError } from "@connectrpc/connect";
import { MediaKind, MediaSource, TransportDirection, type StatsEvent } from "@zoomclone/sfu-proto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLIENT_DTLS_PARAMETERS,
  audioRtpParameters,
  startTestSfu,
  take,
  videoSimulcastRtpParameters,
  waitFor,
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
    expect(caps.codecs.map((c) => c.mimeType)).toEqual(
      expect.arrayContaining(["audio/opus", "video/VP8"]),
    );
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
      rtpParametersJson: JSON.stringify(videoSimulcastRtpParameters()),
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
    await sfu.client.setLayer({
      consumerId: sub.consumerId,
      spatialLayer: 2,
      temporalLayer: 2,
      priority: 9,
    });
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
    const sendA = await sfu.client.createTransport({
      sessionId: "g3",
      participantId: "A",
      direction: TransportDirection.SEND,
    });
    const recvB = await sfu.client.createTransport({
      sessionId: "g3",
      participantId: "B",
      direction: TransportDirection.RECV,
    });
    const sendZ = await sfu.client.createTransport({
      sessionId: "g4",
      participantId: "Z",
      direction: TransportDirection.SEND,
    });
    const pubZ = await sfu.client.publish({
      sessionId: "g4",
      participantId: "Z",
      transportId: sendZ.transportId,
      kind: MediaKind.AUDIO,
      source: MediaSource.MIC,
      rtpParametersJson: JSON.stringify(audioRtpParameters()),
      paused: false,
    });
    const caps = (await sfu.client.allocateRoom({ sessionId: "g3" })).rtpCapabilitiesJson;

    expect(
      await codeOf(
        sfu.client.createTransport({
          sessionId: "missing",
          participantId: "A",
          direction: TransportDirection.SEND,
        }),
      ),
    ).toBe(Code.NotFound);
    expect(
      await codeOf(
        sfu.client.connectTransport({ transportId: "missing", dtlsParametersJson: "{}" }),
      ),
    ).toBe(Code.NotFound);
    expect(
      await codeOf(
        sfu.client.connectTransport({
          transportId: sendA.transportId,
          dtlsParametersJson: "not json",
        }),
      ),
    ).toBe(Code.InvalidArgument);
    expect(
      await codeOf(
        sfu.client.publish({
          sessionId: "g3",
          participantId: "B",
          transportId: sendA.transportId,
          kind: MediaKind.AUDIO,
          source: MediaSource.MIC,
          rtpParametersJson: JSON.stringify(audioRtpParameters()),
          paused: false,
        }),
      ),
    ).toBe(Code.PermissionDenied);
    expect(
      await codeOf(
        sfu.client.publish({
          sessionId: "g3",
          participantId: "B",
          transportId: recvB.transportId,
          kind: MediaKind.AUDIO,
          source: MediaSource.MIC,
          rtpParametersJson: JSON.stringify(audioRtpParameters()),
          paused: false,
        }),
      ),
    ).toBe(Code.FailedPrecondition);
    expect(
      await codeOf(
        sfu.client.publish({
          sessionId: "g3",
          participantId: "A",
          transportId: sendA.transportId,
          kind: MediaKind.UNSPECIFIED,
          source: MediaSource.MIC,
          rtpParametersJson: JSON.stringify(audioRtpParameters()),
          paused: false,
        }),
      ),
    ).toBe(Code.InvalidArgument);
    expect(
      await codeOf(
        sfu.client.subscribe({
          sessionId: "g3",
          participantId: "B",
          transportId: recvB.transportId,
          producerId: pubZ.producerId,
          rtpCapabilitiesJson: caps,
        }),
      ),
    ).toBe(Code.PermissionDenied);
    expect(
      await codeOf(
        sfu.client.subscribe({
          sessionId: "g3",
          participantId: "B",
          transportId: recvB.transportId,
          producerId: "missing",
          rtpCapabilitiesJson: caps,
        }),
      ),
    ).toBe(Code.NotFound);
    expect(
      await codeOf(
        sfu.client.publish({
          sessionId: "g4",
          participantId: "A",
          transportId: sendA.transportId,
          kind: MediaKind.AUDIO,
          source: MediaSource.MIC,
          rtpParametersJson: JSON.stringify(audioRtpParameters()),
          paused: false,
        }),
      ),
    ).toBe(Code.PermissionDenied);
    expect(await codeOf(sfu.client.cascade({ sessionId: "g3", remoteSfuAddr: "sfu-2:9090" }))).toBe(
      Code.Unimplemented,
    );
    expect(
      await codeOf(sfu.client.stats({ sessionId: "missing" })[Symbol.asyncIterator]().next()),
    ).toBe(Code.NotFound);
    expect(await codeOf(sfu.client.allocateRoom({ sessionId: "" }))).toBe(Code.InvalidArgument);
    expect(
      await codeOf(
        sfu.client.createTransport({
          sessionId: "g3",
          participantId: "",
          direction: TransportDirection.SEND,
        }),
      ),
    ).toBe(Code.InvalidArgument);
    expect(await codeOf(sfu.client.unsubscribe({ consumerId: "" }))).toBe(Code.InvalidArgument);
    expect(await codeOf(sfu.client.stats({ sessionId: "" })[Symbol.asyncIterator]().next())).toBe(
      Code.InvalidArgument,
    );
  });

  it("streams a snapshot then live events, and ends when the room closes", async () => {
    const { rtpCapabilitiesJson } = await sfu.client.allocateRoom({ sessionId: "g5" });
    const send = await sfu.client.createTransport({
      sessionId: "g5",
      participantId: "A",
      direction: TransportDirection.SEND,
    });
    const recv = await sfu.client.createTransport({
      sessionId: "g5",
      participantId: "B",
      direction: TransportDirection.RECV,
    });
    const pub = await sfu.client.publish({
      sessionId: "g5",
      participantId: "A",
      transportId: send.transportId,
      kind: MediaKind.AUDIO,
      source: MediaSource.MIC,
      rtpParametersJson: JSON.stringify(audioRtpParameters()),
      paused: true,
    });
    const sub = await sfu.client.subscribe({
      sessionId: "g5",
      participantId: "B",
      transportId: recv.transportId,
      producerId: pub.producerId,
      rtpCapabilitiesJson,
    });

    const controller = new AbortController();
    const stream = sfu.client.stats({ sessionId: "g5" }, { signal: controller.signal });
    const [first] = await take(stream, 1);
    expect(first?.event.case).toBe("snapshot");
    if (first?.event.case !== "snapshot") throw new Error("expected snapshot");
    const snapshot = first.event.value;
    expect(snapshot.transports.map((t) => t.transportId).sort()).toEqual(
      [send.transportId, recv.transportId].sort(),
    );
    const firstTransport = snapshot.transports[0];
    if (!firstTransport) throw new Error("expected a transport in the snapshot");
    expect(JSON.parse(firstTransport.iceParametersJson)).toMatchObject({
      usernameFragment: expect.any(String),
    });
    expect(JSON.parse(firstTransport.iceCandidatesJson)).toBeInstanceOf(Array);
    expect(JSON.parse(firstTransport.dtlsParametersJson)).toMatchObject({
      fingerprints: expect.any(Array),
    });
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
    const expectedCases: Array<StatsEvent["event"]["case"]> = [
      "producerClosed",
      "consumerClosed",
      "transportClosed",
      "qos",
    ];
    const seen = () => rest.map((e) => e.event.case);
    await waitFor(() => expectedCases.every((c) => seen().includes(c)), 5000);
    await sfu.client.closeRoom({ sessionId: "g5" });
    await reader;

    const cases = seen();
    expect(cases).toEqual(expect.arrayContaining(expectedCases));
    const closed = rest.find((e) => e.event.case === "consumerClosed");
    expect(closed?.event.case === "consumerClosed" && closed.event.value.reason).toBe(
      "producerclose",
    );
    expect(sfu.manager.get("g5")).toBeUndefined();
    await sfu.client.closeRoom({ sessionId: "g5" });
  });

  it("aborting a stats stream unregisters its subscriber", async () => {
    await sfu.client.allocateRoom({ sessionId: "g6" });
    const room = sfu.manager.require("g6");
    const controller = new AbortController();
    const stream = sfu.client.stats({ sessionId: "g6" }, { signal: controller.signal });
    const [first] = await take(stream, 1);
    expect(first?.event.case).toBe("snapshot");
    expect(room.subscriberCount).toBe(1);
    controller.abort();
    await waitFor(() => room.subscriberCount === 0);
    await sfu.client.closeRoom({ sessionId: "g6" });
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

describe("Sfu gRPC message log", () => {
  it("logs each handled call with method, ids and outcome at debug, and no payload blobs", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const log = pino(
      { level: "debug" },
      { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const logged = await startTestSfu({}, log);
    try {
      await logged.client.allocateRoom({ sessionId: "log-s1" });
      await codeOf(logged.client.closeTransport({ transportId: "missing" }));
      const created = await logged.client.createTransport({
        sessionId: "log-s1",
        participantId: "p1",
        direction: TransportDirection.SEND,
      });
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            msg: "grpc handled",
            method: "AllocateRoom",
            sessionId: "log-s1",
            code: "OK",
          }),
          expect.objectContaining({
            msg: "grpc handled",
            method: "CloseTransport",
            code: "NotFound",
          }),
          expect.objectContaining({
            msg: "grpc handled",
            method: "CreateTransport",
            sessionId: "log-s1",
            participantId: "p1",
            code: "OK",
          }),
        ]),
      );
      expect(JSON.stringify(lines)).not.toContain(created.dtlsParametersJson.slice(0, 40));
    } finally {
      await logged.stop();
    }
  });
});
