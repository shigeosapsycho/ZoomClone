import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Fixed namespace for mapping external OIDC subjects to internal user UUIDs. */
export const USER_ID_NAMESPACE = "0d2a6c5e-5b1e-4f1a-9c3d-2e7f8a9b0c1d";
/** Fixed namespace for mapping external OIDC org_id claims to internal org UUIDs. */
export const ORG_ID_NAMESPACE = "5f6b3d2a-1c4e-4a7b-9d8e-0f1a2b3c4d5e";

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** RFC 4122 version 5 (SHA-1) UUID. */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The schema stores organizer_id / user_id as UUIDs while OIDC subjects are arbitrary strings.
 * UUID subjects pass through; anything else maps deterministically, scoped by issuer.
 */
export function userIdFromSubject(issuer: string, sub: string): string {
  return isUuid(sub) ? sub.toLowerCase() : uuidV5(USER_ID_NAMESPACE, `${issuer}|${sub}`);
}

/**
 * Real identity providers rarely hand out org_id as a UUID. UUID claims pass through; anything
 * else maps deterministically, scoped by issuer, so the same claim always resolves to the same
 * internal org id.
 */
export function orgIdFromClaim(issuer: string, claim: string): string {
  return isUuid(claim) ? claim.toLowerCase() : uuidV5(ORG_ID_NAMESPACE, `${issuer}|${claim}`);
}
