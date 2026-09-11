import type { RoomEvent } from "@zoomclone/protocol";
import type { Emitted, Membership, Target } from "./types";

export function matchesTarget(target: Target, participantId: string, m: Membership): boolean {
  switch (target.kind) {
    case "all":
      return m.inRoster(participantId);
    case "hosts":
      return m.inRoster(participantId) && m.isHost(participantId);
    case "everyone":
      return m.inRoster(participantId) || m.inLobby(participantId);
    case "only":
      return target.participant_ids.includes(participantId);
    case "all_except":
      return participantId !== target.participant_id && m.inRoster(participantId);
  }
}

/**
 * Replay window for reconnects (design doc: last 500 events or 60 s). Entries are appended in
 * seq order; eviction drops from the head by size and by age.
 */
export class RingBuffer {
  private entries: Emitted[] = [];

  constructor(private readonly opts: { maxSize: number; maxAgeMs: number }) {}

  get size(): number {
    return this.entries.length;
  }

  /** Seq of the oldest retained event, or null when empty. */
  get oldestSeq(): number | null {
    return this.entries[0]?.event.seq ?? null;
  }

  push(e: Emitted): void {
    this.entries.push(e);
    this.evict(e.at);
  }

  evict(now: number): void {
    const cutoff = now - this.opts.maxAgeMs;
    let drop = 0;
    while (
      drop < this.entries.length &&
      (this.entries.length - drop > this.opts.maxSize || this.entries[drop]!.at < cutoff)
    ) {
      drop++;
    }
    if (drop > 0) this.entries = this.entries.slice(drop);
  }

  /**
   * Events with seq > afterSeq addressed to the participant, or null when the buffer no longer
   * covers afterSeq + 1 (the caller must resync). afterSeq === currentSeq means nothing missed.
   */
  replay(
    participantId: string,
    afterSeq: number,
    currentSeq: number,
    membership: Membership,
  ): RoomEvent[] | null {
    if (afterSeq > currentSeq) return null;
    if (afterSeq === currentSeq) return [];
    const oldest = this.oldestSeq;
    if (oldest === null || oldest > afterSeq + 1) return null;
    return this.entries
      .filter((e) => e.event.seq > afterSeq && matchesTarget(e.target, participantId, membership))
      .map((e) => e.event);
  }
}
