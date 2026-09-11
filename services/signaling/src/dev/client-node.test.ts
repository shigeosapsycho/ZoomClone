import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloseCode, type RoomEvent, type Welcome } from "@zoomclone/protocol";
import { FakeSfu } from "../../test/fake-sfu";
import {
  createTestInfra,
  mintClaims,
  mintToken,
  seedSession,
  startTestSignaling,
  waitFor,
  type TestInfra,
  type TestSignaling,
} from "../../test/helpers";
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

async function open(
  participantId: string,
  role: "host" | "attendee" = "attendee",
  lobby = false,
): Promise<Recorder> {
  const token = await mintToken(
    infra,
    mintClaims({ session_id: sessionId, participant_id: participantId, role, lobby }),
  );
  const rec: Recorder = {
    client: null as unknown as SignalingClient,
    snapshots: [],
    events: [],
    statuses: [],
    closes: [],
  };
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
    expect(host.snapshots[0]).toMatchObject({
      kind: "welcome",
      welcome: { state: "joined", role: "host" },
    });
    expect(host.client.status).toBe("joined");
    expect(host.client.lastAck).toMatchObject({ mode: "welcome", epoch: 1 });
    await expect(host.client.request("raise_hand", {})).resolves.toEqual({});
    await expect(host.client.request("host.admit", { participant_id: A })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
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
