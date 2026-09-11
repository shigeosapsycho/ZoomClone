import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Spec 8: 10 alphanumeric chars (about 51.7 bits), displayed as xxx-xxxx-xxx. */
export const MEETING_CODE_RE = /^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$/;

/** Returns an index into the 36-char alphabet. Injectable for deterministic tests. */
export type CodeRng = () => number;

const defaultRng: CodeRng = () => randomInt(0, ALPHABET.length);

export function generateMeetingCode(rng: CodeRng = defaultRng): string {
  let raw = "";
  for (let i = 0; i < 10; i++) {
    raw += ALPHABET[rng() % ALPHABET.length];
  }
  return group(raw);
}

/** Accepts user input (any case, spaces, missing or misplaced dashes); canonical code or null. */
export function normalizeMeetingCode(input: string): string | null {
  const raw = input.toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z0-9]{10}$/.test(raw)) return null;
  return group(raw);
}

function group(raw: string): string {
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 10)}`;
}
