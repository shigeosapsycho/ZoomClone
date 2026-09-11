import {
  CloseCode,
  HelloAckSchema,
  PING_INTERVAL_MS,
  ServerMessageSchema,
  type ClientMessage,
  type HelloAck,
  type RoomEvent,
  type ServerMessage,
  type Welcome,
} from "@zoomclone/protocol";

export type ConnectionStatus =
  "connecting" | "hello" | "lobby" | "joined" | "reconnecting" | "closed";
/** chosen: the close follows leave(), whatever code the socket reports (1006 while connecting). */
export type CloseInfo = { code: number; reason: string; terminal: boolean; chosen: boolean };
export type RequestType = Exclude<ClientMessage["type"], "hello" | "ping">;
export type PayloadOf<T extends ClientMessage["type"]> = Extract<
  ClientMessage,
  { type: T }
>["payload"];

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/** Closes after which a reconnect is pointless (design doc close codes plus a normal leave). */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  1000,
  CloseCode.AUTH_FAILED,
  CloseCode.REMOVED,
  CloseCode.LOBBY_DENIED,
  CloseCode.ROOM_ENDED,
  CloseCode.REPLACED,
  CloseCode.PROTOCOL_ERROR,
  CloseCode.CAPACITY,
  CloseCode.REJOIN_REQUIRED,
  CloseCode.LOCKED,
]);

const DROP_CODE = 4900;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5_000;

export type SignalingClientOptions = {
  url: string;
  token: string;
  onSnapshot: (kind: "welcome" | "resync", welcome: Welcome) => void;
  onEvent: (event: RoomEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  onClosed: (info: CloseInfo) => void;
  log?: (line: string) => void;
};

type Pending = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: RequestError) => void;
};

/**
 * The browser side of the signaling protocol: one socket at a time, hello with resume on every
 * (re)connect, request/ack correlation by id, pings, and reconnect with backoff on any close
 * that is not terminal. Media is someone else's job (media.ts); this class only moves frames.
 */
export class SignalingClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private hello: { id: string; mode: HelloAck["mode"] | null } | null = null;
  private _status: ConnectionStatus = "connecting";
  private _seq = 0;
  private _epoch: number | null = null;
  private _participantId: string | null = null;
  private _lastAck: HelloAck | null = null;
  private _rtt: number | null = null;

  constructor(private readonly opts: SignalingClientOptions) {}

  get status(): ConnectionStatus {
    return this._status;
  }
  get seq(): number {
    return this._seq;
  }
  get epoch(): number | null {
    return this._epoch;
  }
  get participantId(): string | null {
    return this._participantId;
  }
  get lastAck(): HelloAck | null {
    return this._lastAck;
  }
  get rtt(): number | null {
    return this._rtt;
  }

  connect(): void {
    if (this.stopped || this.socket) return;
    const socket = new WebSocket(this.opts.url);
    this.socket = socket;
    socket.addEventListener("open", () => this.onOpen(socket));
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    socket.addEventListener("close", (event) => this.onClose(socket, event.code, event.reason));
    socket.addEventListener("error", () => undefined);
  }

  /** Sends a request and resolves with its ack payload. */
  request<T extends RequestType>(type: T, payload: PayloadOf<T>): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      (this._status !== "joined" && this._status !== "lobby")
    ) {
      return Promise.reject(new RequestError("CLOSED", "not connected"));
    }
    const id = this.nextId(type);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // `satisfies` cannot distribute a generic T across ClientMessage's discriminated union
      // (TS1360); PayloadOf<T> already ties payload's shape to type, so the cast is sound.
      socket.send(JSON.stringify({ type, id, payload } as ClientMessage));
    });
  }

  /** Intentional leave: no reconnect. */
  leave(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, "leaving");
    if (!this.socket) this.setStatus("closed");
  }

  /** Test hook: closes the socket like a lost network would and reconnects at once. */
  drop(): void {
    this.socket?.close(DROP_CODE, "test drop");
  }

  private onOpen(socket: WebSocket): void {
    this.setStatus("hello");
    const id = this.nextId("hello");
    this.hello = { id, mode: null };
    const payload: PayloadOf<"hello"> =
      this._epoch === null
        ? { token: this.opts.token }
        : { token: this.opts.token, resume_seq: this._seq, epoch: this._epoch };
    socket.send(JSON.stringify({ type: "hello", id, payload } satisfies ClientMessage));
  }

  private onMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.opts.log?.(`unparsable frame: ${raw.slice(0, 80)}`);
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.opts.log?.(`frame failed the schema: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "ack":
        return this.onAck(message.id, message.payload);
      case "error":
        return this.onError(message.id, message.payload);
      case "pong":
        this._rtt = Date.now() - message.payload.ts;
        return;
      case "welcome":
      case "resync":
        return this.onSnapshot(message.type, message.payload);
      default:
        return this.onEvent(message);
    }
  }

  private onAck(id: string, payload: Record<string, unknown>): void {
    if (this.hello && id === this.hello.id) {
      const ack = HelloAckSchema.safeParse(payload);
      if (!ack.success) {
        this.opts.log?.("hello ack failed the schema");
        return;
      }
      this.hello.mode = ack.data.mode;
      this._lastAck = ack.data;
      this._epoch = ack.data.epoch;
      this.backoff = BACKOFF_MIN_MS;
      if (ack.data.mode === "replay") {
        // Nothing else announces the resumed session: the state is whatever it was, plus the
        // replayed events, which advance the cursor as they land. The ack's seq is the head and
        // must not move it: a second drop before the tail arrived would skip the rest.
        this.setStatus(this._status === "lobby" ? "lobby" : "joined");
        this.hello = null;
      }
      this.startPings();
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(payload);
  }

  private onError(id: string | undefined, payload: { code: string; message: string }): void {
    if (id === undefined) {
      this.opts.log?.(`server error: ${payload.code} ${payload.message}`);
      return;
    }
    if (this.hello && id === this.hello.id) {
      this.opts.log?.(`hello refused: ${payload.code} ${payload.message}`);
      return; // the close that follows carries the code
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(new RequestError(payload.code, payload.message));
  }

  private onSnapshot(kind: "welcome" | "resync", welcome: Welcome): void {
    this._seq = welcome.seq;
    this._epoch = welcome.epoch;
    this._participantId = welcome.participant_id;
    this.hello = null;
    this.setStatus(welcome.state === "lobby" ? "lobby" : "joined");
    this.opts.onSnapshot(kind, welcome);
  }

  private onEvent(event: RoomEvent): void {
    if (event.seq > this._seq) this._seq = event.seq;
    this.opts.onEvent(event);
  }

  private onClose(socket: WebSocket, code: number, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = null;
    // An ack whose welcome or resync never arrived: the client holds an epoch it has no state
    // for, so the next hello starts fresh and the server answers with a full snapshot, not a
    // replay (which carries no media).
    if (this.hello?.mode === "welcome" || this.hello?.mode === "resync") this._epoch = null;
    this.hello = null;
    this.clearTimers();
    for (const pending of this.pending.values())
      pending.reject(new RequestError("CLOSED", `socket closed (${code})`));
    this.pending.clear();
    const chosen = this.stopped;
    const terminal = chosen || TERMINAL_CLOSE_CODES.has(code);
    if (terminal) {
      this.stopped = true;
      this.setStatus("closed");
      this.opts.onClosed({ code, reason, terminal: true, chosen });
      return;
    }
    this.opts.onClosed({ code, reason, terminal: false, chosen: false });
    this.setStatus("reconnecting");
    const delay = code === DROP_CODE ? 0 : this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const ping = () => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: "ping",
          id: this.nextId("ping"),
          payload: { ts: Date.now() },
        } satisfies ClientMessage),
      );
    };
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.opts.onStatus(status);
  }

  private nextId(type: string): string {
    return `${type}-${++this.counter}`;
  }
}
