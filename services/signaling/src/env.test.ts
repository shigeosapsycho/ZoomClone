import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const base = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://localhost:56379/1",
};

describe("signaling env", () => {
  it("applies defaults and parses the SFU endpoint list", () => {
    const env = loadEnv(base);
    expect(env.SIGNALING_PORT).toBe(8081);
    expect(env.TOKEN_ISSUER).toBe("meeting-api");
    expect(env.MEETING_API_JWKS_URL).toBe("http://localhost:8080/.well-known/jwks.json");
    expect(env.SFU_ENDPOINTS).toEqual({ "sfu-local-1": "http://localhost:9090" });
    expect(env.DISCONNECT_GRACE_MS).toBe(30_000);
    expect(env.ROOM_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(env.HELLO_TIMEOUT_MS).toBe(5_000);
    expect(env.PING_TIMEOUT_MS).toBe(30_000);
    expect(env.CHECKPOINT_WINDOW_MS).toBe(50);
    expect(env.HEARTBEAT_MS).toBe(5_000);
    expect(env.OWNER_LEASE_MS).toBe(15_000);
    expect(env.RING_BUFFER_SIZE).toBe(500);
    expect(env.RING_BUFFER_MS).toBe(60_000);
    expect(env.DEPARTED_TTL_MS).toBe(600_000);
    expect(env.MAX_BUFFERED_BYTES).toBe(1_048_576);
    expect(env.DEV_HARNESS).toBe(false);
  });

  it("parses several SFU endpoints and rejects malformed entries", () => {
    expect(
      loadEnv({ ...base, SFU_ENDPOINTS: "a=http://a:9090, b=http://b:9090" }).SFU_ENDPOINTS,
    ).toEqual({ a: "http://a:9090", b: "http://b:9090" });
    expect(() => loadEnv({ ...base, SFU_ENDPOINTS: "nonsense" })).toThrow();
  });

  it("requires the database and redis urls", () => {
    expect(() => loadEnv({ REDIS_URL: "redis://x" })).toThrow();
  });
});
