import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildIceServers } from "./ice-servers";

const pid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12";
const now = new Date("2026-09-10T09:00:00Z");

describe("buildIceServers", () => {
  it("returns STUN only when TURN is not configured", () => {
    const servers = buildIceServers(
      { stunUrls: ["stun:s:3478"], turnUrls: [], turnTtlSeconds: 3600 },
      pid,
      now,
    );
    expect(servers).toEqual([{ urls: ["stun:s:3478"] }]);
  });

  it("adds time-limited TURN credentials in coturn use-auth-secret format", () => {
    const servers = buildIceServers(
      {
        stunUrls: [],
        turnUrls: ["turn:t:443?transport=tcp"],
        turnSecret: "s3cret",
        turnTtlSeconds: 3600,
      },
      pid,
      now,
    );
    const expiry = Math.floor(now.getTime() / 1000) + 3600;
    const username = `${expiry}:${pid}`;
    const credential = createHmac("sha1", "s3cret").update(username).digest("base64");
    expect(servers).toEqual([{ urls: ["turn:t:443?transport=tcp"], username, credential }]);
  });

  it("skips TURN when the secret is missing", () => {
    expect(
      buildIceServers({ stunUrls: [], turnUrls: ["turn:t:443"], turnTtlSeconds: 60 }, pid, now),
    ).toEqual([]);
  });
});
