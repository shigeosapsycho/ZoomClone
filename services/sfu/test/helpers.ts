import type { AddressInfo } from "node:net";
import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SfuService } from "@zoomclone/sfu-proto";
import type { types as ms } from "mediasoup";
import { createSfuServer } from "../src/app";
import { loadEnv, type Env } from "../src/env";
import { createMetrics } from "../src/metrics";
import { RoomManager, roomOptionsFrom } from "../src/rooms";
import { closeWorkers, createWorkers, type WorkerSlot } from "../src/workers";

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    SFU_WORKERS: "1",
    SFU_MEDIA_PORT_BASE: String(42000 + Math.floor(Math.random() * 900)),
    SFU_QOS_INTERVAL_MS: "250",
    SFU_AUDIO_LEVEL_INTERVAL_MS: "300",
    MEDIASOUP_LOG_LEVEL: "error",
    ...overrides,
  });
}

export async function createTestManager(overrides: Record<string, string> = {}) {
  const env = testEnv(overrides);
  const slots: WorkerSlot[] = await createWorkers(env);
  const manager = new RoomManager(slots, roomOptionsFrom(env));
  return {
    env,
    slots,
    manager,
    stop: async () => {
      await manager.closeAll();
      await closeWorkers(slots);
    },
  };
}

/** A syntactically valid client DTLS fingerprint; mediasoup stores it until the handshake. */
export const CLIENT_DTLS_PARAMETERS: ms.DtlsParameters = {
  role: "client",
  fingerprints: [
    {
      algorithm: "sha-256",
      value: Array.from({ length: 32 }, (_, i) =>
        (i * 7 + 3).toString(16).padStart(2, "0").toUpperCase(),
      ).join(":"),
    },
  ],
};

/**
 * Fresh SSRCs per call so tests that share one long-lived transport across many `publish()`
 * calls never collide in mediasoup's per-transport RTP listener (real worker-enforced
 * uniqueness, not something the SFU implementation can or should paper over).
 */
let nextSsrc = 10_000_000;

function takeSsrcs(count: number): number[] {
  const base = nextSsrc;
  nextSsrc += 10;
  return Array.from({ length: count }, (_, i) => base + i);
}

export function audioRtpParameters(): ms.RtpParameters {
  const ssrc = takeSsrcs(1)[0]!;
  return {
    // mid must be as fresh as the ssrc: mediasoup's per-transport RTP listener also rejects a
    // second live producer with a mid it has already seen, same as it does for ssrc, so a fixed
    // "0" would reintroduce the exact collision the ssrc factory exists to avoid.
    mid: String(ssrc),
    codecs: [
      {
        mimeType: "audio/opus",
        payloadType: 111,
        clockRate: 48000,
        channels: 2,
        parameters: { useinbandfec: 1 },
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc }],
    rtcp: { cname: "test-audio", reducedSize: true },
  };
}

export function videoSimulcastRtpParameters(): ms.RtpParameters {
  const [a, b, c, d, e, f] = takeSsrcs(6);
  return {
    mid: String(a), // see audioRtpParameters: mid collides per-transport in mediasoup too
    codecs: [
      {
        mimeType: "video/VP8",
        payloadType: 96,
        clockRate: 90000,
        rtcpFeedback: [
          { type: "nack" },
          { type: "nack", parameter: "pli" },
          { type: "ccm", parameter: "fir" },
          { type: "goog-remb" },
        ],
      },
      { mimeType: "video/rtx", payloadType: 97, clockRate: 90000, parameters: { apt: 96 } },
    ],
    headerExtensions: [],
    encodings: [
      { ssrc: a!, rtx: { ssrc: b! }, scalabilityMode: "L1T3", maxBitrate: 150_000 },
      { ssrc: c!, rtx: { ssrc: d! }, scalabilityMode: "L1T3", maxBitrate: 500_000 },
      { ssrc: e!, rtx: { ssrc: f! }, scalabilityMode: "L1T3", maxBitrate: 1_500_000 },
    ],
    rtcp: { cname: "test-video", reducedSize: true },
  };
}

export type TestSfu = {
  env: Env;
  manager: RoomManager;
  client: Client<typeof SfuService>;
  baseUrl: string;
  stop: () => Promise<void>;
};

export async function startTestSfu(overrides: Record<string, string> = {}): Promise<TestSfu> {
  const base = await createTestManager(overrides);
  const server = createSfuServer(base.manager, createMetrics(base.manager));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createClient(SfuService, createGrpcTransport({ baseUrl }));
  return {
    env: base.env,
    manager: base.manager,
    client,
    baseUrl,
    stop: async () => {
      await base.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Polls `predicate` every 10 ms until it is true; throws when `timeoutMs` elapse first. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Reads events from a server stream until `count` have arrived or `ms` elapse. */
export async function take<T>(iter: AsyncIterable<T>, count: number, ms = 5000): Promise<T[]> {
  const out: T[] = [];
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));
  const reader = (async () => {
    for await (const item of iter) {
      out.push(item);
      if (out.length >= count) break;
    }
    return "done" as const;
  })();
  await Promise.race([reader, timeout]);
  return out;
}
