import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ClientMessageSchema,
  CloseCode,
  REACTION_RATE_PER_SECOND,
  type ClientMessage,
  type ServerMessage,
  type SignalingClaims,
} from "@zoomclone/protocol";
import type { Env } from "../env";
import type { HelloPayload, RoomController } from "../room/controller";
import { ControllerBusyError, RoomEndedError, type RoomRegistry } from "../room/registry";
import type { TokenVerifier } from "./auth";
import type { ParticipantLink } from "./link";
import { TokenBucket } from "./rate-limit";

export type GatewayDeps = {
  registry: RoomRegistry;
  verifier: TokenVerifier;
  env: Pick<Env, "HELLO_TIMEOUT_MS" | "PING_TIMEOUT_MS" | "MAX_BUFFERED_BYTES">;
  log: Logger;
  metrics?: { connections: { inc(): void; dec(): void } };
};

const ROOM_PATH = /^\/rooms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_FRAME_BYTES = 64 * 1024;

/** The controller-facing wrapper around one socket. */
export class WsLink implements ParticipantLink {
  readonly id = randomUUID();

  constructor(
    private readonly socket: WebSocket,
    private readonly maxBuffered: number,
    private readonly log: Logger,
  ) {}

  send(message: ServerMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > this.maxBuffered) {
      this.log.warn(
        { link: this.id, buffered: this.socket.bufferedAmount },
        "slow consumer, closing",
      );
      this.socket.close(1008, "slow consumer");
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  close(code: number, reason?: string): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(code, reason);
    }
  }
}

/** Upgrades /rooms/:session_id and runs one Connection per socket. */
export function attachGateway(server: Server, deps: GatewayDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const match = ROOM_PATH.exec(pathname);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = match[1]!;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      new Connection(ws, sessionId, deps);
    });
  });
  return wss;
}

class Connection {
  private readonly link: WsLink;
  private readonly reactions = new TokenBucket(REACTION_RATE_PER_SECOND);
  private readonly pingWatchdog: NodeJS.Timeout;
  private helloTimer: NodeJS.Timeout | null;
  private controller: RoomController | null = null;
  private participantId: string | null = null;
  private attaching = false;
  private closed = false;
  private lastPingAt = Date.now();

  constructor(
    private readonly ws: WebSocket,
    private readonly sessionId: string,
    private readonly deps: GatewayDeps,
  ) {
    deps.metrics?.connections.inc();
    this.link = new WsLink(ws, deps.env.MAX_BUFFERED_BYTES, deps.log);
    this.helloTimer = setTimeout(
      () => this.link.close(CloseCode.PROTOCOL_ERROR, "hello timeout"),
      deps.env.HELLO_TIMEOUT_MS,
    );
    // Three missed pings (design doc): checked a few times per timeout window.
    this.pingWatchdog = setInterval(
      () => {
        if (Date.now() - this.lastPingAt > deps.env.PING_TIMEOUT_MS) {
          this.link.close(CloseCode.PING_TIMEOUT, "ping timeout");
        }
      },
      Math.max(50, Math.floor(deps.env.PING_TIMEOUT_MS / 3)),
    );
    ws.on("message", (data) => void this.onMessage(data));
    ws.on("close", () => this.onClose());
    ws.on("error", (error) => deps.log.debug({ link: this.link.id, error }, "socket error"));
  }

  private async onMessage(data: RawData): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      this.link.close(CloseCode.PROTOCOL_ERROR, "invalid json");
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      if (this.participantId === null) {
        this.link.close(CloseCode.PROTOCOL_ERROR, "expected hello");
        return;
      }
      const id =
        typeof json === "object" &&
        json !== null &&
        typeof (json as { id?: unknown }).id === "string"
          ? (json as { id: string }).id
          : undefined;
      const issue = parsed.error.issues[0];
      this.link.send({
        type: "error",
        ...(id === undefined ? {} : { id }),
        payload: {
          code: "INVALID",
          message: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid message",
        },
      });
      return;
    }
    const message = parsed.data;
    try {
      if (message.type === "ping") {
        this.lastPingAt = Date.now();
        this.link.send({ type: "pong", payload: { ts: message.payload.ts } });
        return;
      }
      if (message.type === "hello") {
        await this.onHello(message);
        return;
      }
      if (this.participantId === null || this.controller === null) {
        this.link.close(CloseCode.PROTOCOL_ERROR, "hello first");
        return;
      }
      if (message.type === "reaction" && !this.reactions.take()) {
        this.link.send({
          type: "error",
          id: message.id,
          payload: { code: "RATE_LIMITED", message: "too many reactions" },
        });
        return;
      }
      await this.controller.handle(this.link, this.participantId, message);
    } catch (error) {
      this.deps.log.error(
        { link: this.link.id, type: message.type, error },
        "unhandled gateway error",
      );
      this.link.send({
        type: "error",
        id: message.id,
        payload: { code: "INTERNAL", message: "internal error" },
      });
    }
  }

  private async onHello(message: Extract<ClientMessage, { type: "hello" }>): Promise<void> {
    if (this.participantId !== null || this.attaching) {
      this.link.close(CloseCode.PROTOCOL_ERROR, "duplicate hello");
      return;
    }
    this.attaching = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    let claims: SignalingClaims;
    try {
      claims = await this.deps.verifier.verify(message.payload.token);
    } catch {
      this.link.send({
        type: "error",
        id: message.id,
        payload: { code: "UNAUTHORIZED", message: "invalid token" },
      });
      this.link.close(CloseCode.AUTH_FAILED, "auth failed");
      return;
    }
    if (claims.session_id !== this.sessionId) {
      this.link.send({
        type: "error",
        id: message.id,
        payload: { code: "UNAUTHORIZED", message: "token is for another session" },
      });
      this.link.close(CloseCode.AUTH_FAILED, "auth failed");
      return;
    }
    let controller: RoomController;
    try {
      controller = await this.deps.registry.get(claims.session_id, {
        sfu_hint: claims.sfu_hint,
        lobby_enabled: claims.lobby_enabled,
        max_participants: claims.max_participants,
      });
    } catch (error) {
      if (error instanceof ControllerBusyError) {
        this.link.send({
          type: "error",
          id: message.id,
          payload: { code: "CONTROLLER_BUSY", message: "room is owned elsewhere, retry" },
        });
        this.link.close(1013, "try again later");
      } else if (error instanceof RoomEndedError) {
        this.link.close(CloseCode.ROOM_ENDED, "room ended");
      } else {
        this.deps.log.error({ sessionId: this.sessionId, error }, "room lookup failed");
        this.link.send({
          type: "error",
          id: message.id,
          payload: { code: "INTERNAL", message: "internal error" },
        });
        this.link.close(1011, "room lookup failed");
      }
      return;
    }
    const hello: HelloPayload = { id: message.id };
    if (message.payload.resume_seq !== undefined) hello.resume_seq = message.payload.resume_seq;
    if (message.payload.epoch !== undefined) hello.epoch = message.payload.epoch;
    const participantId = await controller.attach(this.link, claims, hello);
    this.attaching = false;
    if (participantId === null) return;
    this.controller = controller;
    this.participantId = participantId;
    // The socket may have closed while attach was in flight; give the controller its detach now.
    if (this.closed) controller.detach(this.link, participantId);
  }

  private onClose(): void {
    this.closed = true;
    this.deps.metrics?.connections.dec();
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    clearInterval(this.pingWatchdog);
    if (this.controller && this.participantId !== null)
      this.controller.detach(this.link, this.participantId);
  }
}
