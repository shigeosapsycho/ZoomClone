import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { errors } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { SignalingClaims } from "@zoomclone/protocol";
import { jwks, loadSigningKeys, signSignalingToken, type SigningKeys } from "@zoomclone/tokens";
import { mintClaims } from "../../test/helpers";
import { TokenUnavailableError, localTokenVerifier, remoteTokenVerifier } from "./auth";

const SESSION = "33333333-3333-4333-8333-333333333333";
const ISSUER = "meeting-api";

let keys: SigningKeys;
let other: SigningKeys;
let server: Server;
let jwksUrl: string;
let deadUrl: string;
/** What the fake JWKS endpoint answers next. */
let answer = { status: 503, body: "" };

beforeAll(async () => {
  keys = await loadSigningKeys({ kid: "a" });
  other = await loadSigningKeys({ kid: "b" });
  server = createServer((_req, res) => {
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/jwks.json`;
  // A port that was just released, so the connection is refused rather than answered.
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const free = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(free));
    });
  });
  deadUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function token(claims: Partial<SignalingClaims> = {}, signer = keys): Promise<string> {
  return signSignalingToken(signer, ISSUER, mintClaims({ session_id: SESSION, ...claims }));
}

describe("token verifiers", () => {
  it("rethrows token faults (expired, unknown key, malformed claims) so the gateway answers 4001", async () => {
    const local = localTokenVerifier(keys, ISSUER);
    await expect(local.verify(await token())).resolves.toMatchObject({ session_id: SESSION });
    const issued = new Date(Date.now() - 10 * 60_000);
    const expired = await signSignalingToken(
      keys,
      ISSUER,
      mintClaims({ session_id: SESSION }),
      issued,
    );
    await expect(local.verify(expired)).rejects.toBeInstanceOf(errors.JWTExpired);
    await expect(local.verify(await token({}, other))).rejects.toBeInstanceOf(
      errors.JWKSNoMatchingKey,
    );
    await expect(local.verify(await token({ role: "king" as never }))).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(local.verify("nope")).rejects.toBeInstanceOf(errors.JWSInvalid);
  });

  it("turns a JWKS endpoint that is unreachable, failing or malformed into TokenUnavailableError", async () => {
    const refused = remoteTokenVerifier(deadUrl, ISSUER);
    await expect(refused.verify(await token())).rejects.toBeInstanceOf(TokenUnavailableError);
    for (const broken of [
      { status: 503, body: "" },
      { status: 200, body: "{not json" },
      { status: 200, body: JSON.stringify({ keys: "nope" }) },
    ]) {
      answer = broken;
      const verifier = remoteTokenVerifier(jwksUrl, ISSUER);
      await expect(verifier.verify(await token())).rejects.toBeInstanceOf(TokenUnavailableError);
    }
    // A reachable endpoint with the right keys still reports a bad token as the client's fault.
    answer = { status: 200, body: JSON.stringify(jwks(keys)) };
    const remote = remoteTokenVerifier(jwksUrl, ISSUER);
    await expect(remote.verify(await token())).resolves.toMatchObject({ session_id: SESSION });
    await expect(remote.verify(await token({}, other))).rejects.toBeInstanceOf(
      errors.JWKSNoMatchingKey,
    );
  });
});
