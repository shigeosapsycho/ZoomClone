import { describe, expect, it } from "vitest";
import { ActiveSpeakerTracker } from "./active-speakers";

const A = "a";
const B = "b";

function tracker() {
  const emitted: string[][] = [];
  const t = new ActiveSpeakerTracker((ids) => emitted.push(ids), {
    riseMs: 300,
    fallMs: 1000,
    minIntervalMs: 300,
  });
  return { t, emitted };
}

describe("ActiveSpeakerTracker", () => {
  it("activates a speaker after riseMs of consecutive samples", () => {
    const { t, emitted } = tracker();
    t.onSample([{ participant_id: A, volume: -20 }], 0);
    expect(emitted).toEqual([]);
    t.onSample([{ participant_id: A, volume: -20 }], 300);
    expect(emitted).toEqual([[A]]);
    expect(t.current).toEqual([A]);
  });

  it("ages a speaker out fallMs after its last sample, even without new samples", () => {
    const { t, emitted } = tracker();
    t.onSample([{ participant_id: A, volume: -20 }], 0);
    t.onSample([{ participant_id: A, volume: -20 }], 300);
    t.tick(1_200);
    expect(emitted).toEqual([[A]]);
    t.tick(1_300);
    expect(emitted).toEqual([[A], []]);
  });

  it("clears at once on silence", () => {
    const { t, emitted } = tracker();
    t.onSample([{ participant_id: A, volume: -20 }], 0);
    t.onSample([{ participant_id: A, volume: -20 }], 300);
    t.onSilence(350);
    expect(emitted).toEqual([[A], []]);
    t.onSample([{ participant_id: A, volume: -20 }], 400);
    expect(emitted).toEqual([[A], []]);
    t.onSample([{ participant_id: A, volume: -20 }], 700);
    expect(emitted).toEqual([[A], [], [A]]);
  });

  it("emits at most once per minIntervalMs and flushes the pending change on the next tick", () => {
    const { t, emitted } = tracker();
    t.onSample([{ participant_id: A, volume: -20 }], 0);
    t.onSample(
      [
        { participant_id: A, volume: -20 },
        { participant_id: B, volume: -30 },
      ],
      300,
    );
    expect(emitted).toEqual([[A]]);
    t.onSample(
      [
        { participant_id: A, volume: -20 },
        { participant_id: B, volume: -30 },
      ],
      500,
    );
    expect(emitted).toEqual([[A]]);
    // B's firstSeen is 300 (its first sample) and now is 500, so only 200ms of consecutive
    // presence has elapsed, short of riseMs (300ms). B has not risen yet: current is still [A].
    expect(t.current).toEqual([A]);
    t.tick(600);
    expect(emitted).toEqual([[A], [A, B]]);
  });

  it("does not emit when the set is unchanged and sorts ids", () => {
    const { t, emitted } = tracker();
    const both = [
      { participant_id: B, volume: -10 },
      { participant_id: A, volume: -20 },
    ];
    t.onSample(both, 0);
    t.onSample(both, 300);
    t.onSample(both, 600);
    t.tick(900);
    expect(emitted).toEqual([[A, B]]);
  });
});
