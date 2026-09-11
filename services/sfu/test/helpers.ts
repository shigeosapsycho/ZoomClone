import type { types as ms } from "mediasoup";
import { loadEnv, type Env } from "../src/env";
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

export const AUDIO_RTP_PARAMETERS: ms.RtpParameters = {
  mid: "0",
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
  encodings: [{ ssrc: 11111111 }],
  rtcp: { cname: "test-audio", reducedSize: true },
};

export const VIDEO_SIMULCAST_RTP_PARAMETERS: ms.RtpParameters = {
  mid: "1",
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
    { ssrc: 22222222, rtx: { ssrc: 22222223 }, scalabilityMode: "L1T3", maxBitrate: 150_000 },
    { ssrc: 22222224, rtx: { ssrc: 22222225 }, scalabilityMode: "L1T3", maxBitrate: 500_000 },
    { ssrc: 22222226, rtx: { ssrc: 22222227 }, scalabilityMode: "L1T3", maxBitrate: 1_500_000 },
  ],
  rtcp: { cname: "test-video", reducedSize: true },
};
