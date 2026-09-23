import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv({});
    expect(env.SFU_ID).toBe("sfu-local-1");
    expect(env.SFU_GRPC_PORT).toBe(9090);
    expect(env.SFU_MEDIA_PORT_BASE).toBe(40000);
    expect(env.SFU_LISTEN_IP).toBe("0.0.0.0");
    expect(env.SFU_ANNOUNCED_IP).toBe("127.0.0.1");
    expect(env.SFU_WORKERS).toBeGreaterThan(0);
    expect(env.SFU_QOS_INTERVAL_MS).toBe(5000);
    expect(env.SFU_AUDIO_LEVEL_INTERVAL_MS).toBe(300);
    expect(env.SFU_INITIAL_OUTGOING_BITRATE).toBe(1_000_000);
    expect(env.MEDIASOUP_LOG_LEVEL).toBe("warn");
  });

  it("parses overrides", () => {
    const env = loadEnv({
      SFU_WORKERS: "2",
      SFU_MEDIA_PORT_BASE: "42000",
      SFU_ANNOUNCED_IP: "10.0.0.5",
    });
    expect(env.SFU_WORKERS).toBe(2);
    expect(env.SFU_MEDIA_PORT_BASE).toBe(42000);
    expect(env.SFU_ANNOUNCED_IP).toBe("10.0.0.5");
  });
});
