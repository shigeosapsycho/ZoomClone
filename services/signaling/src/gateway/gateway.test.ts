import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloseCode, type SignalingClaims } from "@zoomclone/protocol";
import { FakeSfu } from "../../test/fake-sfu";
import {
  TestClient,
  createTestInfra,
  createTestRegistry,
  mintClaims,
  mintToken,
  seedSession,
  startTestSignaling,
  waitFor,
  type TestInfra,
  type TestSignaling,
} from "../../test/helpers";
import { ctlChannel } from "../room/registry";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

let infra: TestInfra;
let sfu: FakeSfu;
let signaling: TestSignaling;
let sessionId: string;
const clients: TestClient[] = [];

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
  for (const c of clients) c.terminate();
  clients.length = 0;
  await signaling.close();
  await sfu.stop();
});

async function connect(session = sessionId): Promise<TestClient> {
  const client = await TestClient.connect(`${signaling.url}/rooms/${session}`);
  clients.push(client);
  return client;
}

async function joined(overrides: Partial<SignalingClaims> & { participant_id: string }) {
  const client = await connect();
  const token = await mintToken(infra, mintClaims({ session_id: sessionId, ...overrides }));
  const reply = await client.request("hello", { token });
  expect(reply.type).toBe("ack");
  await client.waitFor("welcome");
  return client;
}

/**
 * Sends one raw request whose target Node's parser accepts but the URL parser rejects, and
 * resolves with whatever the server answered once it closes the socket (or after 500 ms).
 */
function rawRequest(httpUrl: string, headers: string[]): Promise<string> {
  const { hostname, port } = new URL(httpUrl);
  return new Promise((resolve) => {
    let response = "";
    const socket = createConnection({ host: hostname, port: Number(port) }, () => {
      socket.write(["GET http://[ HTTP/1.1", "Host: x", ...headers, "", ""].join("\r\n"));
    });
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    const timer = setTimeout(done, 500);
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString();
    });
    socket.on("close", done);
    socket.on("error", done);
  });
}

describe("gateway: handshake", () => {
  it("closes 4006 without a hello in time, or when the first frame is not a hello", async () => {
    const silent = await connect();
    const closed = await silent.waitForClose();
    expect(closed.code).toBe(CloseCode.PROTOCOL_ERROR);
    const eager = await connect();
    eager.send({ type: "raise_hand", id: "1", payload: {} });
    expect((await eager.waitForClose()).code).toBe(CloseCode.PROTOCOL_ERROR);
    const garbage = await connect();
    garbage.sendRaw("{not json");
    expect((await garbage.waitForClose()).code).toBe(CloseCode.PROTOCOL_ERROR);
  });

  it("refuses bad tokens and tokens for another session with 4001, unknown paths with 404", async () => {
    const bad = await connect();
    const reply = await bad.request("hello", { token: "nope" });
    expect(reply).toMatchObject({ type: "error", payload: { code: "UNAUTHORIZED" } });
    expect((await bad.waitForClose()).code).toBe(CloseCode.AUTH_FAILED);
    const other = await connect();
    const token = await mintToken(
      infra,
      mintClaims({ session_id: "99999999-9999-4999-8999-999999999999", participant_id: A }),
    );
    await other.request("hello", { token });
    expect((await other.waitForClose()).code).toBe(CloseCode.AUTH_FAILED);
    await expect(TestClient.connect(`${signaling.url}/nope`)).rejects.toThrow(
      /upgrade failed: 404/,
    );
  });

  it("answers 400 and stays up when the request target defeats the URL parser, on both paths", async () => {
    expect(await rawRequest(signaling.httpUrl, ["Connection: close"])).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(`${signaling.httpUrl}/healthz`)).status).toBe(200);
    const upgrade = ["Connection: Upgrade", "Upgrade: websocket"];
    expect(await rawRequest(signaling.httpUrl, upgrade)).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(`${signaling.httpUrl}/healthz`)).status).toBe(200);
  });

  it("answers CONTROLLER_BUSY and closes 1013 while another controller owns the room", async () => {
    const other = createTestRegistry(infra, sfu.baseUrl);
    await other.get(sessionId, { sfu_hint: "fake-sfu", lobby_enabled: true, max_participants: 10 });
    const client = await connect();
    const token = await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: A }));
    const reply = await client.request("hello", { token });
    expect(reply).toMatchObject({ type: "error", payload: { code: "CONTROLLER_BUSY" } });
    expect((await client.waitForClose()).code).toBe(1013);
    await other.closeAll();
  });
});

describe("gateway: sessions", () => {
  it("runs the join flow end to end and fans room events between sockets", async () => {
    const host = await joined({ participant_id: HOST, role: "host" });
    expect(host.ofType("ack")[0]?.payload).toEqual({ mode: "welcome", epoch: 1, seq: 1 });
    expect(host.ofType("welcome")[0]?.payload.media?.send_transport.id).toBe("t1");
    const ann = await joined({ participant_id: A });
    await host.waitFor("participant.joined", (m) => m.payload.participant.participant_id === A);

    const pong = await (async () => {
      ann.send({ type: "ping", id: "p", payload: { ts: 42 } });
      return ann.waitFor("pong");
    })();
    expect(pong.payload).toEqual({ ts: 42 });

    expect(
      await ann.request("connect_transport", {
        transport: "send",
        dtls_parameters: { role: "client" },
      }),
    ).toMatchObject({ type: "ack" });
    const publish = await ann.request("publish", {
      kind: "video",
      source: "camera",
      rtp_parameters: { codecs: [] },
      paused: false,
    });
    expect(publish).toMatchObject({ type: "ack", payload: { track_id: "trk1" } });
    await host.waitFor("track.added", (m) => m.payload.track.track_id === "trk1");
    const subscribe = await host.request("subscribe", {
      rtp_capabilities: { codecs: [] },
      track_ids: ["trk1"],
      prefs: {},
    });
    expect(subscribe).toMatchObject({
      type: "ack",
      payload: { consumers: [{ track_id: "trk1", consumer_id: "c1" }] },
    });
    expect(await host.request("consumer_ready", { track_id: "trk1" })).toMatchObject({
      type: "ack",
    });

    expect(await ann.request("chat", { body: "hello" })).toMatchObject({ type: "ack" });
    await host.waitFor("chat", (m) => m.payload.body === "hello");
    const invalid = await ann.request("chat", { body: "" } as never);
    expect(invalid).toMatchObject({ type: "error", payload: { code: "INVALID" } });
    expect(await ann.request("host.lock", { locked: true })).toMatchObject({
      type: "error",
      payload: { code: "FORBIDDEN" },
    });
    expect(await host.request("host.lock", { locked: true })).toMatchObject({ type: "ack" });
    await ann.waitFor("room.updated", (m) => m.payload.locked === true);

    const health = await fetch(`${signaling.httpUrl}/healthz`);
    expect(await health.json()).toEqual({ ok: true, rooms: 1 });
    const metrics = await fetch(`${signaling.httpUrl}/metrics`);
    const body = await metrics.text();
    expect(body).toMatch(/ws_connections 2/);
    expect(body).toMatch(/room_count 1/);
    expect((await fetch(`${signaling.httpUrl}/nope`)).status).toBe(404);
  });

  it("limits reactions per connection and closes silent sockets with 4000", async () => {
    // A second server with a short ping timeout; the shared one keeps the default so other tests
    // are not cut off mid-flow.
    const quick = await startTestSignaling(infra, sfu.baseUrl, { env: { PING_TIMEOUT_MS: 400 } });
    try {
      const ann = await TestClient.connect(`${quick.url}/rooms/${sessionId}`);
      clients.push(ann);
      const token = await mintToken(
        infra,
        mintClaims({ session_id: sessionId, participant_id: A }),
      );
      expect((await ann.request("hello", { token })).type).toBe("ack");
      // The silence window starts after room creation, not during it.
      ann.send({ type: "ping", id: "p", payload: { ts: 1 } });
      await ann.waitFor("pong");
      const replies = [];
      for (let i = 0; i < 4; i++) replies.push(await ann.request("reaction", { emoji: "clap" }));
      expect(replies.map((r) => r.type)).toEqual(["ack", "ack", "error", "error"]);
      expect(replies[2]).toMatchObject({ payload: { code: "RATE_LIMITED" } });
      const closed = await ann.waitForClose(1500);
      expect(closed.code).toBe(CloseCode.PING_TIMEOUT);
    } finally {
      await quick.close();
    }
  });

  it("replaces an older socket with 4005, replays after a dropped connection, and closes 4004 on a ctl end", async () => {
    const host = await joined({ participant_id: HOST, role: "host" });
    const ann = await joined({ participant_id: A });
    const annSeq = ann.ofType("welcome")[0]!.payload.seq;
    const token = await mintToken(infra, mintClaims({ session_id: sessionId, participant_id: A }));

    const second = await connect();
    await second.request("hello", { token, resume_seq: annSeq, epoch: 1 });
    expect((await ann.waitForClose()).code).toBe(CloseCode.REPLACED);
    expect(second.ofType("ack")[0]?.payload).toMatchObject({ mode: "replay" });
    expect(host.ofType("participant.updated")).toEqual([]);

    second.terminate();
    await host.waitFor("participant.updated", (m) => m.payload.patch.connected === false);
    await host.request("reaction", { emoji: "wave" });
    const third = await connect();
    const seqBefore = second.events().at(-1)?.seq ?? annSeq;
    await third.request("hello", { token, resume_seq: seqBefore, epoch: 1 });
    expect(third.ofType("ack")[0]?.payload).toMatchObject({ mode: "replay" });
    await third.waitFor("reaction", (m) => m.payload.emoji === "wave");
    await host.waitFor("participant.updated", (m) => m.payload.patch.connected === true);

    await infra.redis.publish(
      ctlChannel(sessionId),
      JSON.stringify({ cmd: "end", reason: "api_end" }),
    );
    expect((await host.waitForClose()).code).toBe(CloseCode.ROOM_ENDED);
    expect((await third.waitForClose()).code).toBe(CloseCode.ROOM_ENDED);
    expect(host.ofType("room.ended")[0]?.payload).toEqual({ reason: "api_end" });
    await waitFor(() => signaling.registry.size === 0);
    await sleep(20);
  });
});
