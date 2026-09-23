import { createLocalJWKSet, createRemoteJWKSet, errors } from "jose";
import { ZodError } from "zod";
import type { SignalingClaims } from "@zoomclone/protocol";
import { jwks, verifySignalingToken, type SigningKeys } from "@zoomclone/tokens";

export interface TokenVerifier {
  verify(token: string): Promise<SignalingClaims>;
}

/** The check itself could not run (JWKS unreachable, timed out or malformed): the client retries. */
export class TokenUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("token check unavailable", cause === undefined ? undefined : { cause });
    this.name = "TokenUnavailableError";
  }
}

/**
 * jose raises JOSEError subclasses for bad tokens and for a broken JWKS fetch alike; only the
 * former are the client's fault. A timeout, a non-200 or an unparsable key set (JWKSTimeout,
 * JWKSInvalid and the bare JOSEError the fetch path throws) and anything outside jose (fetch or
 * DNS failures) mean the verifier could not decide. Malformed claims inside a validly signed
 * token (ZodError) are the token's fault.
 */
export function isTokenFault(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  if (!(error instanceof errors.JOSEError)) return false;
  return !(
    error.code === errors.JOSEError.code ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid
  );
}

function classify(verify: (token: string) => Promise<SignalingClaims>): TokenVerifier {
  return {
    verify: async (token) => {
      try {
        return await verify(token);
      } catch (error) {
        if (isTokenFault(error)) throw error;
        throw new TokenUnavailableError(error);
      }
    },
  };
}

/** Production: keys from meeting-api's /.well-known/jwks.json (cached and refetched on unknown kid by jose). */
export function remoteTokenVerifier(jwksUrl: string, issuer: string): TokenVerifier {
  const keys = createRemoteJWKSet(new URL(jwksUrl));
  return classify((token) => verifySignalingToken(token, keys, issuer));
}

/** Tests: verify against an in-process key pair. */
export function localTokenVerifier(keys: SigningKeys, issuer: string): TokenVerifier {
  const set = createLocalJWKSet(jwks(keys));
  return classify((token) => verifySignalingToken(token, set, issuer));
}
