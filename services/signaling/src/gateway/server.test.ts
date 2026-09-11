import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { loadSigningKeys, signSignalingToken } from "@zoomclone/tokens";
import { TestClient, mintClaims } from "../../test/helpers";
import type { RoomController } from "../room/controller";
import type { RoomRegistry } from "../room/registry";
import { localTokenVerifier } from "./auth";
import { WsLink, attachGateway, pathnameOf } from "./server";

const silent = pino({ level: "silent" });
const SESSION = "33333333-3333-4333-8333-333333333333";

function socketStub(bufferedAmount: number) {
  return {
    readyState: WebSocket.OPEN as number,
    bufferedAmount,
    close: vi.fn(),
    send: vi.fn(),
    terminate: vi.fn(),
  };
}

describe("WsLink", () => {
  it("closes 1008 instead of queueing behind a slow consumer, then terminates a peer that never answers the close", async () => {
    const max = 1024;
    const stuck = socketStub(max + 1);
    const drained = socketStub(max + 1);
    for (const socket of [stuck, drained]) {
      const link = new WsLink(socket as unknown as WebSocket, max, silent);
      link.send({ type: "pong", payload: { ts: 1 } });
      expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
      expect(socket.send).not.toHaveBeenCalled();
    }
    drained.readyState = WebSocket.CLOSED;
    await sleep(1100);
    expect(stuck.terminate).toHaveBeenCalledTimes(1);
    expect(drained.terminate).not.toHaveBeenCalled();
  });
});

describe("pathnameOf", () => {
  it("drops the query and answers null for a target Node accepts but the URL parser rejects", () => {
    const req = (url: string | undefined) => ({ url }) as IncomingMessage;
    expect(pathnameOf(req("/rooms/abc?x=1"))).toBe("/rooms/abc");
    expect(pathnameOf(req(undefined))).toBe("/");
    expect(pathnameOf(req("http://["))).toBeNull();
  });
});

describe("Connection", () => {
  it("answers INTERNAL and closes 1011 when attach rejects, so no socket idles without a participant", async () => {
    const keys = await loadSigningKeys({ kid: "test" });
    const controller = {
      attach: vi.fn(() => Promise.reject(new Error("boom"))),
    } as unknown as RoomController;
    const registry = { get: vi.fn(() => Promise.resolve(controller)) } as unknown as RoomRegistry;
    const server = createServer();
    const wss = attachGateway(server, {
      registry,
      verifier: localTokenVerifier(keys, "meeting-api"),
      env: { HELLO_TIMEOUT_MS: 300, PING_TIMEOUT_MS: 5000, MAX_BUFFERED_BYTES: 1_048_576 },
      log: silent,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = await TestClient.connect(`ws://127.0.0.1:${port}/rooms/${SESSION}`);
      const token = await signSignalingToken(
        keys,
        "meeting-api",
        mintClaims({ session_id: SESSION }),
      );
      const reply = await client.request("hello", { token });
      expect(reply).toMatchObject({ type: "error", payload: { code: "INTERNAL" } });
      expect((await client.waitForClose()).code).toBe(1011);
      expect(controller.attach).toHaveBeenCalledTimes(1);
    } finally {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
