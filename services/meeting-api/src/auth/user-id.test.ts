import { describe, expect, it } from "vitest";
import { isUuid, orgIdFromClaim, userIdFromSubject, uuidV5 } from "./user-id";

describe("user ids", () => {
  it("passes UUID subjects through, lowercased", () => {
    expect(userIdFromSubject("https://idp", "2F6A2B6E-6F0B-4C1E-9A52-0C5D3F1A9B12")).toBe(
      "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
    );
  });

  it("maps non-UUID subjects to a stable v5 UUID scoped by issuer", () => {
    const a = userIdFromSubject("https://idp", "alice");
    expect(isUuid(a)).toBe(true);
    expect(a).toBe(userIdFromSubject("https://idp", "alice"));
    expect(a).not.toBe(userIdFromSubject("https://other", "alice"));
    expect(a.charAt(14)).toBe("5");
  });

  it("uuidV5 matches RFC 4122 test vector (DNS namespace, python.org)", () => {
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });
});

describe("org ids", () => {
  it("passes UUID org claims through, lowercased", () => {
    expect(orgIdFromClaim("https://idp", "2F6A2B6E-6F0B-4C1E-9A52-0C5D3F1A9B12")).toBe(
      "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12",
    );
  });

  it("maps non-UUID org claims to a stable v5 UUID scoped by issuer", () => {
    const a = orgIdFromClaim("https://idp", "org_abc");
    expect(isUuid(a)).toBe(true);
    expect(a).toBe(orgIdFromClaim("https://idp", "org_abc"));
    expect(a).not.toBe(orgIdFromClaim("https://other", "org_abc"));
  });
});
