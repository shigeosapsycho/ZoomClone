import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const base = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", AUTH_DEV_ISSUER: "true" };

describe("loadEnv", () => {
  it("applies defaults and parses lists and booleans", () => {
    const env = loadEnv({ ...base, STUN_URLS: "stun:a:3478, stun:b:3478", TURN_URLS: "" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.MEETING_API_PORT).toBe(8080);
    expect(env.AUTH_DEV_ISSUER).toBe(true);
    expect(env.STUN_URLS).toEqual(["stun:a:3478", "stun:b:3478"]);
    expect(env.TURN_URLS).toEqual([]);
    expect(env.DEFAULT_ORG_ID).toBe("11111111-1111-4111-8111-111111111111");
    expect(env.JOIN_RATE_LIMIT).toBe(10);
    expect(env.JOIN_RATE_LIMIT_PER_CODE).toBe(120);
    expect(env.JOIN_RATE_WINDOW_MS).toBe(60_000);
    expect(env.OIDC_ALGORITHMS).toEqual(["RS256", "ES256"]);

    const singleAlgorithm = loadEnv({ ...base, OIDC_ALGORITHMS: "RS256" });
    expect(singleAlgorithm.OIDC_ALGORITHMS).toEqual(["RS256"]);
  });

  it("requires OIDC settings unless the dev issuer is on", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" })).toThrow(
      /OIDC_ISSUER/,
    );
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      OIDC_ISSUER: "https://idp.example.com",
      OIDC_JWKS_URL: "https://idp.example.com/jwks",
    });
    expect(env.AUTH_DEV_ISSUER).toBe(false);
  });

  it("refuses the dev issuer and a missing signing key in production", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production", SIGNING_KEY_PEM: "pem" })).toThrow(
      /AUTH_DEV_ISSUER/,
    );
    expect(() =>
      loadEnv({
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
        NODE_ENV: "production",
        OIDC_ISSUER: "https://idp.example.com",
        OIDC_JWKS_URL: "https://idp.example.com/jwks",
      }),
    ).toThrow(/SIGNING_KEY_PEM/);
  });
});
