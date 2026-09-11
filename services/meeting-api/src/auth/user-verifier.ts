import type { webcrypto } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ApiError } from "@zoomclone/protocol";
import type { SigningKeys } from "@zoomclone/tokens";
import type { Env } from "../env";
import { isUuid, userIdFromSubject } from "./user-id";

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
    } catch {
      throw new ApiError("UNAUTHORIZED", "invalid bearer token");
    }
    if (!payload.sub) throw new ApiError("UNAUTHORIZED", "token has no subject");
    const orgClaim = payload["org_id"];
    const orgId =
      typeof orgClaim === "string" && isUuid(orgClaim) ? orgClaim : this.opts.defaultOrgId;
    const nameClaim = payload["name"];
    const name = typeof nameClaim === "string" && nameClaim.trim() ? nameClaim.trim() : "User";
    return { id: userIdFromSubject(payload.iss ?? issuer, payload.sub), orgId, name };
  }
}

export function createUserVerifier(env: Env, keys: SigningKeys): UserVerifier {
  if (env.AUTH_DEV_ISSUER) {
    return new OidcUserVerifier({
      key: keys.publicKey,
      issuer: env.DEV_ISSUER_URL,
      audience: env.OIDC_AUDIENCE,
      algorithms: ["ES256"],
      defaultOrgId: env.DEFAULT_ORG_ID,
    });
  }
  return new OidcUserVerifier({
    key: createRemoteJWKSet(new URL(env.OIDC_JWKS_URL as string)),
    issuer: env.OIDC_ISSUER as string,
    audience: env.OIDC_AUDIENCE,
    algorithms: env.OIDC_ALGORITHMS,
    defaultOrgId: env.DEFAULT_ORG_ID,
  });
}
