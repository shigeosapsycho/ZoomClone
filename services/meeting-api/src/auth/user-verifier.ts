import type { webcrypto } from "node:crypto";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ApiError } from "@zoomclone/protocol";
import type { SigningKeys } from "@zoomclone/tokens";
import type { Env } from "../env";
import { orgIdFromClaim, userIdFromSubject } from "./user-id";

export type AuthUser = { id: string; orgId: string; name: string };

export interface UserVerifier {
  /** Throws ApiError("UNAUTHORIZED") for any invalid token. */
  verify(bearer: string): Promise<AuthUser>;
}

export class OidcUserVerifier implements UserVerifier {
  constructor(
    private readonly opts: {
      key: webcrypto.CryptoKey | JWTVerifyGetKey;
      issuer: string;
      audience: string;
      algorithms: string[];
      defaultOrgId: string;
      requireOrg: boolean;
      /** Logging hook for verification failures that are not the token's fault (see below). */
      onError?: (error: unknown) => void;
    },
  ) {}

  async verify(bearer: string): Promise<AuthUser> {
    const { key, issuer, audience, algorithms } = this.opts;
    let payload: JWTPayload;
    try {
      // Both branches call jwtVerify the same way; the split only exists so TS resolves
      // the right overload for the key union (a raw CryptoKey vs. a JWTVerifyGetKey resolver).
      ({ payload } =
        typeof key === "function"
          ? await jwtVerify(bearer, key, { issuer, audience, algorithms })
          : await jwtVerify(bearer, key, { issuer, audience, algorithms }));
    } catch (error) {
      // A JOSEError other than a JWKS fetch timeout means the token itself is bad (bad
      // signature, expired, wrong issuer/audience). Anything else, including a JWKS timeout or
      // a raw network failure reaching the identity provider, is an availability problem, not
      // the caller's fault.
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
        throw new ApiError("UNAUTHORIZED", "invalid bearer token");
      }
      this.opts.onError?.(error);
      throw new ApiError("UNAVAILABLE", "identity provider unreachable");
    }
    if (!payload.sub) throw new ApiError("UNAUTHORIZED", "token has no subject");
    const orgClaim = payload["org_id"];
    let orgId: string;
    if (typeof orgClaim === "string" && orgClaim.trim()) {
      orgId = orgIdFromClaim(payload.iss ?? issuer, orgClaim);
    } else if (this.opts.requireOrg) {
      throw new ApiError("UNAUTHORIZED", "token has no org_id claim");
    } else {
      orgId = this.opts.defaultOrgId;
    }
    const nameClaim = payload["name"];
    const name = typeof nameClaim === "string" && nameClaim.trim() ? nameClaim.trim() : "User";
    return { id: userIdFromSubject(payload.iss ?? issuer, payload.sub), orgId, name };
  }
}

export function createUserVerifier(
  env: Env,
  keys: SigningKeys,
  log?: { error(obj: unknown, msg: string): void },
): UserVerifier {
  const onError = (e: unknown) => log?.error(e, "jwks lookup failed");
  if (env.AUTH_DEV_ISSUER) {
    return new OidcUserVerifier({
      key: keys.publicKey,
      issuer: env.DEV_ISSUER_URL,
      audience: env.OIDC_AUDIENCE,
      algorithms: ["ES256"],
      defaultOrgId: env.DEFAULT_ORG_ID,
      requireOrg: false,
      onError,
    });
  }
  return new OidcUserVerifier({
    key: createRemoteJWKSet(new URL(env.OIDC_JWKS_URL as string)),
    issuer: env.OIDC_ISSUER as string,
    audience: env.OIDC_AUDIENCE,
    requireOrg: env.OIDC_REQUIRE_ORG,
    algorithms: env.OIDC_ALGORITHMS,
    defaultOrgId: env.DEFAULT_ORG_ID,
    onError,
  });
}
