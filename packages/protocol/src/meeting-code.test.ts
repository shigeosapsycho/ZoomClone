import { describe, expect, it } from "vitest";
import { MEETING_CODE_RE, generateMeetingCode, normalizeMeetingCode } from "./meeting-code";

describe("generateMeetingCode", () => {
  it("matches the spec format xxx-xxxx-xxx", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateMeetingCode()).toMatch(MEETING_CODE_RE);
    }
  });

  it("uses the injected rng (index into a-z0-9)", () => {
    let n = 0;
    const code = generateMeetingCode(() => n++ % 36);
    expect(code).toBe("abc-defg-hij");
  });

  it("produces distinct codes", () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateMeetingCode()));
    expect(codes.size).toBe(1000);
  });
});

describe("normalizeMeetingCode", () => {
  it("canonicalizes case, spaces and dashes", () => {
    expect(normalizeMeetingCode("ABC-DEFG-HIJ")).toBe("abc-defg-hij");
    expect(normalizeMeetingCode("abcdefghij")).toBe("abc-defg-hij");
    expect(normalizeMeetingCode(" abc defg hij ")).toBe("abc-defg-hij");
    expect(normalizeMeetingCode("a1b-2c3d-4e5")).toBe("a1b-2c3d-4e5");
  });

  it("rejects wrong length or characters", () => {
    expect(normalizeMeetingCode("abc-defg-hi")).toBeNull();
    expect(normalizeMeetingCode("abc-defg-hij1")).toBeNull();
    expect(normalizeMeetingCode("abc-defg-hi!")).toBeNull();
    expect(normalizeMeetingCode("")).toBeNull();
  });
});
