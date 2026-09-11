import { createLocalJWKSet, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { jwks, loadSigningKeys } from "./keys";
import { signSignalingToken, verifySignalingToken } from "./signaling-token";

const claims = {
  session_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11",
  participant_id: "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
  role: "attendee" as const,
  sfu_hint: "sfu-local-1",
  display_name: "Ana",
  lobby_enabled: true,
  max_participants: 500,
};

describe("signaling token", () => {
  it("round-trips claims with a 5 minute expiry and kid header", async () => {
    const keys = await loadSigningKeys({ kid: "test-1" });
    const now = new Date("2026-09-10T09:00:00Z");
    const token = await signSignalingToken(keys, "meeting-api", claims, now);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "ES256", kid: "test-1" });
    const verified = await verifySignalingToken(token, keys.publicKey, "meeting-api", now);
    expect(verified).toMatchObject(claims);
    expect(verified.exp - verified.iat).toBe(300);
  });

  it("rejects expired tokens, wrong issuer and wrong audience", async () => {
    const keys = await loadSigningKeys({ kid: "test-1" });
    const issued = new Date("2026-09-10T09:00:00Z");
    const token = await signSignalingToken(keys, "meeting-api", claims, issued);
    await expect(
      verifySignalingToken(token, keys.publicKey, "meeting-api", new Date("2026-09-10T09:05:01Z")),
    ).rejects.toThrow();
    await expect(verifySignalingToken(token, keys.publicKey, "other", issued)).rejects.toThrow();
  });

  it("verifies through a JWKS resolver and rejects tokens from another key", async () => {
    const keys = await loadSigningKeys({ kid: "a" });
    const other = await loadSigningKeys({ kid: "b" });
    const token = await signSignalingToken(keys, "meeting-api", claims);
    const resolver = createLocalJWKSet(jwks(keys));
    await expect(verifySignalingToken(token, resolver, "meeting-api")).resolves.toMatchObject(
      claims,
    );
    await expect(verifySignalingToken(token, other.publicKey, "meeting-api")).rejects.toThrow();
  });

  it("loads a PKCS8 PEM and derives the matching public key", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const keys = await loadSigningKeys({ pem, kid: "pem-1" });
    const token = await signSignalingToken(keys, "meeting-api", claims);
    await expect(verifySignalingToken(token, keys.publicKey, "meeting-api")).resolves.toBeTruthy();
    expect(jwks(keys).keys[0]).toMatchObject({ kid: "pem-1", alg: "ES256", use: "sig", kty: "EC" });
    expect(jwks(keys).keys[0]).not.toHaveProperty("d");
  });
});
