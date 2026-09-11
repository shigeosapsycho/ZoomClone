import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalingClient, type CloseInfo, type ConnectionStatus } from "./signaling";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

type SocketEvent = { data?: string; code?: number; reason?: string };
type Listener = (event: SocketEvent) => void;

/**
 * Stands in for the browser's WebSocket: frames sent are parsed and kept, and close events are
 * delivered on a later tick like a real socket's, so a leave() while connecting reports 1006.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  readonly sent: Array<{ type: string; id?: string; payload: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as (typeof this.sent)[number]);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    const reported = this.readyState === FakeSocket.CONNECTING ? 1006 : (code ?? 1005);
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => this.emit("close", { code: reported, reason: reason ?? "" }));
  }

  // ---- the server's side ----
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** The peer or the network closes the socket. */
  drop(code: number, reason = ""): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  hellos(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === "hello").map((m) => m.payload);
  }

  private emit(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const welcome = (seq: number, epoch: number) => ({
  type: "welcome",
  payload: {
    participant_id: A,
    role: "attendee",
    epoch,
    seq,
    state: "joined",
    roster: [],
    tracks: [],
    room_meta: {
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      locked: false,
      lobby_enabled: true,
      recording: false,
      host_ids: [HOST],
      max_participants: 10,
    },
  },
});

const reaction = (seq: number) => ({ type: "reaction", seq, payload: { from: HOST, emoji: "x" } });

type Recorder = {
  client: SignalingClient;
  statuses: ConnectionStatus[];
  closes: CloseInfo[];
  events: number[];
};

function connect(): Recorder {
  const rec: Recorder = {
    client: null as unknown as SignalingClient,
    statuses: [],
    closes: [],
    events: [],
  };
  rec.client = new SignalingClient({
    url: "ws://test/rooms/x",
    token: "t",
    onSnapshot: () => undefined,
    onEvent: (event) => rec.events.push(event.seq),
    onStatus: (status) => rec.statuses.push(status),
    onClosed: (info) => rec.closes.push(info),
  });
  rec.client.connect();
  return rec;
}

/** The newest socket the client opened, once the reconnect timer has fired. */
function latest(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket");
  return socket;
}

async function joined(): Promise<Recorder> {
  const rec = connect();
  const socket = latest();
  socket.open();
  const hello = socket.sent[0]!;
  socket.receive({ type: "ack", id: hello.id, payload: { mode: "welcome", epoch: 1, seq: 3 } });
  socket.receive(welcome(3, 1));
  expect(rec.client.status).toBe("joined");
  return rec;
}

describe("SignalingClient over a fake socket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lets the replayed events move the cursor, not the replay ack's head seq", async () => {
    const rec = await joined();
    const first = latest();
    first.receive(reaction(4));
    expect(rec.client.seq).toBe(4);

    first.drop(4900, "test drop");
    await vi.advanceTimersByTimeAsync(0);
    const second = latest();
    expect(second).not.toBe(first);
    second.open();
    expect(second.hellos()).toEqual([{ token: "t", resume_seq: 4, epoch: 1 }]);
    const hello = second.sent[0]!;
    // The head (7) is past the last event addressed to this client (6).
    second.receive({ type: "ack", id: hello.id, payload: { mode: "replay", epoch: 1, seq: 7 } });
    expect(rec.client.status).toBe("joined");
    expect(rec.client.seq).toBe(4);
    second.receive(reaction(5));
    second.receive(reaction(6));
    expect(rec.client.seq).toBe(6);
    expect(rec.events).toEqual([4, 5, 6]);

    second.drop(4900, "test drop");
    await vi.advanceTimersByTimeAsync(0);
    const third = latest();
    third.open();
    expect(third.hellos()).toEqual([{ token: "t", resume_seq: 6, epoch: 1 }]);
  });

  it("sends a fresh hello when the socket closed between a hello ack and its snapshot", async () => {
    const rec = connect();
    const first = latest();
    first.open();
    first.receive({
      type: "ack",
      id: first.sent[0]!.id,
      payload: { mode: "welcome", epoch: 1, seq: 3 },
    });
    expect(rec.client.epoch).toBe(1);
    first.drop(1006);
    expect(rec.client.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(500);
    const second = latest();
    expect(second).not.toBe(first);
    second.open();
    expect(second.hellos()).toEqual([{ token: "t" }]);
    second.receive({
      type: "ack",
      id: second.sent[0]!.id,
      payload: { mode: "welcome", epoch: 1, seq: 3 },
    });
    second.receive(welcome(3, 1));
    expect(rec.client.status).toBe("joined");

    // The same after a resync ack whose snapshot never came.
    second.drop(4900);
    await vi.advanceTimersByTimeAsync(0);
    const third = latest();
    third.open();
    expect(third.hellos()).toEqual([{ token: "t", resume_seq: 3, epoch: 1 }]);
    third.receive({
      type: "ack",
      id: third.sent[0]!.id,
      payload: { mode: "resync", epoch: 2, seq: 9 },
    });
    third.drop(4900);
    await vi.advanceTimersByTimeAsync(0);
    const fourth = latest();
    fourth.open();
    expect(fourth.hellos()).toEqual([{ token: "t" }]);
  });

  it("marks a close that follows leave() as chosen, whatever code the socket reports", async () => {
    const rec = await joined();
    latest().drop(4900);
    await vi.advanceTimersByTimeAsync(0);
    const reconnecting = latest();
    expect(reconnecting.readyState).toBe(FakeSocket.CONNECTING);
    rec.client.leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(rec.closes).toEqual([
      { code: 4900, reason: "", terminal: false, chosen: false },
      { code: 1006, reason: "leaving", terminal: true, chosen: true },
    ]);
    expect(rec.client.status).toBe("closed");
    expect(FakeSocket.instances).toHaveLength(2);

    const other = await joined();
    latest().drop(4002, "removed by host");
    expect(other.closes).toEqual([
      { code: 4002, reason: "removed by host", terminal: true, chosen: false },
    ]);
    const third = await joined();
    third.client.leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(third.closes).toEqual([{ code: 1000, reason: "leaving", terminal: true, chosen: true }]);
  });
});
