export type SpeakerSample = { participant_id: string; volume: number };
export type TrackerOptions = { riseMs: number; fallMs: number; minIntervalMs: number };
export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  riseMs: 300,
  fallMs: 1000,
  minIntervalMs: 300,
};

/**
 * Hysteresis over the SFU's dominant_speakers samples (design doc): a participant is active
 * after riseMs of consecutive presence and stays active until fallMs without a sample. Wall-clock
 * aging (tick) handles the SFU going quiet without a silence event; silence clears at once.
 */
export class ActiveSpeakerTracker {
  private readonly firstSeen = new Map<string, number>();
  private readonly lastSeen = new Map<string, number>();
  private active: string[] = [];
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private pending = false;

  constructor(
    private readonly emit: (ids: string[]) => void,
    private readonly opts: TrackerOptions = DEFAULT_TRACKER_OPTIONS,
  ) {}

  get current(): string[] {
    return [...this.active];
  }

  onSample(speakers: SpeakerSample[], now: number): void {
    for (const { participant_id } of speakers) {
      if (!this.firstSeen.has(participant_id)) this.firstSeen.set(participant_id, now);
      this.lastSeen.set(participant_id, now);
    }
    this.tick(now);
  }

  onSilence(now: number): void {
    this.firstSeen.clear();
    this.lastSeen.clear();
    this.pending = false;
    if (this.active.length === 0) return;
    this.active = [];
    this.lastEmitAt = now;
    this.emit([]);
  }

  tick(now: number): void {
    for (const [id, seen] of this.lastSeen) {
      if (now - seen >= this.opts.fallMs) {
        this.lastSeen.delete(id);
        this.firstSeen.delete(id);
      }
    }
    const next = [...this.firstSeen]
      .filter(([, since]) => now - since >= this.opts.riseMs)
      .map(([id]) => id)
      .sort();
    if (next.length !== this.active.length || next.some((id, i) => id !== this.active[i])) {
      this.active = next;
      this.pending = true;
    }
    if (this.pending && now - this.lastEmitAt >= this.opts.minIntervalMs) {
      this.pending = false;
      this.lastEmitAt = now;
      this.emit([...this.active]);
    }
  }
}
