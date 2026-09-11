import type { webcrypto } from "node:crypto";
import { SignJWT, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
  SIGNALING_AUDIENCE,
  SIGNALING_TOKEN_TTL_SECONDS,
  SignalingClaimsSchema,
  type SignalingClaims,
} from "@zoomclone/protocol";
import type { SigningKeys } from "./keys";

export async function signSignalingToken(
  keys: SigningKeys,
  issuer: string,
  claims: SignalingClaims,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "ES256", kid: keys.kid })
    .setIssuer(issuer)
    .setAudience(SIGNALING_AUDIENCE)
    .setSubject(claims.participant_id)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SIGNALING_TOKEN_TTL_SECONDS)
    .sign(keys.privateKey);
}

export type VerifiedSignalingToken = SignalingClaims & { exp: number; iat: number };

/** key: a public CryptoKey, or a jose resolver from createRemoteJWKSet / createLocalJWKSet. */
export async function verifySignalingToken(
  token: string,
  key: webcrypto.CryptoKey | JWTVerifyGetKey,
  issuer: string,
  now: Date = new Date(),
): Promise<VerifiedSignalingToken> {
  const options = {
    issuer,
    audience: SIGNALING_AUDIENCE,
    algorithms: ["ES256"],
    currentDate: now,
  };
  const { payload } =
    typeof key === "function"
      ? await jwtVerify(token, key, options)
      : await jwtVerify(token, key, options);
  const claims = SignalingClaimsSchema.parse(payload);
  return { ...claims, exp: payload.exp as number, iat: payload.iat as number };
}
