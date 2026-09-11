import { createLocalJWKSet, createRemoteJWKSet } from "jose";
import type { SignalingClaims } from "@zoomclone/protocol";
import { jwks, verifySignalingToken, type SigningKeys } from "@zoomclone/tokens";

export interface TokenVerifier {
  verify(token: string): Promise<SignalingClaims>;
}

/** Production: keys from meeting-api's /.well-known/jwks.json (cached and refetched on unknown kid by jose). */
export function remoteTokenVerifier(jwksUrl: string, issuer: string): TokenVerifier {
  const keys = createRemoteJWKSet(new URL(jwksUrl));
  return { verify: (token) => verifySignalingToken(token, keys, issuer) };
}

/** Tests: verify against an in-process key pair. */
export function localTokenVerifier(keys: SigningKeys, issuer: string): TokenVerifier {
  const set = createLocalJWKSet(jwks(keys));
  return { verify: (token) => verifySignalingToken(token, set, issuer) };
}
