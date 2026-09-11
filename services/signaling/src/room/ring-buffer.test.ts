import { describe, expect, it } from "vitest";
import type { RoomEvent } from "@zoomclone/protocol";
import { RingBuffer, matchesTarget } from "./ring-buffer";
import type { Emitted, Membership, Target } from "./types";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const HOST = "33333333-3333-4333-8333-333333333333";
const WAITER = "44444444-4444-4444-8444-444444444444";

const membership: Membership = {
  inRoster: (id) => [P1, P2, HOST].includes(id),
  isHost: (id) => id === HOST,
  inLobby: (id) => id === WAITER,
};

function emitted(seq: number, target: Target, at = 0): Emitted {
  const event: RoomEvent = { type: "reaction", seq, payload: { from: P1, emoji: "x" } };
  return { event, target, at };
}

describe("matchesTarget", () => {
  it("resolves every target kind against the membership", () => {
    expect(matchesTarget({ kind: "all" }, P1, membership)).toBe(true);
    expect(matchesTarget({ kind: "all" }, WAITER, membership)).toBe(false);
    expect(matchesTarget({ kind: "hosts" }, HOST, membership)).toBe(true);
    expect(matchesTarget({ kind: "hosts" }, P1, membership)).toBe(false);
    expect(matchesTarget({ kind: "everyone" }, WAITER, membership)).toBe(true);
    expect(matchesTarget({ kind: "everyone" }, "nobody", membership)).toBe(false);
    expect(matchesTarget({ kind: "only", participant_ids: [WAITER] }, WAITER, membership)).toBe(
      true,
    );
    expect(matchesTarget({ kind: "only", participant_ids: [WAITER] }, P1, membership)).toBe(false);
    expect(matchesTarget({ kind: "all_except", participant_id: P1 }, P1, membership)).toBe(false);
    expect(matchesTarget({ kind: "all_except", participant_id: P1 }, P2, membership)).toBe(true);
  });
});

describe("RingBuffer", () => {
  it("replays only the events after the cursor that target the participant", () => {
    const buffer = new RingBuffer({ maxSize: 500, maxAgeMs: 60_000 });
    buffer.push(emitted(1, { kind: "all" }));
    buffer.push(emitted(2, { kind: "hosts" }));
    buffer.push(emitted(3, { kind: "all_except", participant_id: P1 }));
    buffer.push(emitted(4, { kind: "only", participant_ids: [P1] }));
    const replay = buffer.replay(P1, 1, 4, membership);
    expect(replay?.map((e) => e.seq)).toEqual([4]);
    expect(buffer.replay(HOST, 0, 4, membership)?.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("returns an empty replay when the cursor is current and null when it is ahead", () => {
    const buffer = new RingBuffer({ maxSize: 500, maxAgeMs: 60_000 });
    buffer.push(emitted(1, { kind: "all" }));
    expect(buffer.replay(P1, 1, 1, membership)).toEqual([]);
    expect(buffer.replay(P1, 5, 1, membership)).toBeNull();
  });

  it("returns null once the needed events fell out of the size window", () => {
    const buffer = new RingBuffer({ maxSize: 3, maxAgeMs: 60_000 });
    for (let seq = 1; seq <= 5; seq++) buffer.push(emitted(seq, { kind: "all" }));
    expect(buffer.size).toBe(3);
    expect(buffer.oldestSeq).toBe(3);
    expect(buffer.replay(P1, 1, 5, membership)).toBeNull();
    expect(buffer.replay(P1, 2, 5, membership)?.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("evicts by age on push and on demand", () => {
    const buffer = new RingBuffer({ maxSize: 500, maxAgeMs: 1_000 });
    buffer.push(emitted(1, { kind: "all" }, 0));
    buffer.push(emitted(2, { kind: "all" }, 500));
    buffer.push(emitted(3, { kind: "all" }, 1_600));
    // Both entry 1 (age 1_600ms) and entry 2 (age 1_100ms) exceed maxAgeMs (1_000ms) by the
    // time entry 3 arrives, so push evicts them both in the same pass; only entry 3 remains.
    expect(buffer.oldestSeq).toBe(3);
    buffer.evict(3_000);
    expect(buffer.size).toBe(0);
    expect(buffer.replay(P1, 2, 3, membership)).toBeNull();
    expect(buffer.replay(P1, 3, 3, membership)).toEqual([]);
  });

  it("an empty buffer replays nothing when the cursor is current", () => {
    const buffer = new RingBuffer({ maxSize: 500, maxAgeMs: 60_000 });
    expect(buffer.replay(P1, 0, 0, membership)).toEqual([]);
    expect(buffer.replay(P1, 0, 3, membership)).toBeNull();
  });
});
