import type { Db } from "./client";

export type EndReason = "host_end" | "api_end" | "idle";
const END_REASONS: readonly string[] = ["host_end", "api_end", "idle"];

export function isEndReason(value: unknown): value is EndReason {
  return typeof value === "string" && END_REASONS.includes(value);
}

export type EndSessionResult = {
  ended: boolean;
  meetingId: string | null;
  meetingStatus: "ended" | "scheduled" | null;
};

/**
 * Single writer of session end and the meeting status transition. Idempotent.
 * host_end / api_end: meeting becomes "ended" (terminal, /join answers 410 from then on).
 * idle: meeting returns to "scheduled" so the next /join starts a new session (spec 4.1: one
 * meeting_sessions row per live instance).
 */
export async function endSession(
  db: Db,
  input: { sessionId: string; reason: EndReason; peakParticipants?: number },
): Promise<EndSessionResult> {
  return db.begin(async (tx) => {
    const [session] = await tx<{ id: string; meetingId: string; endedAt: Date | null }[]>`
      SELECT id, meeting_id, ended_at FROM meeting_sessions WHERE id = ${input.sessionId} FOR UPDATE`;
    if (!session) return { ended: false, meetingId: null, meetingStatus: null };
    if (session.endedAt) return { ended: false, meetingId: session.meetingId, meetingStatus: null };

    await tx`
      UPDATE meeting_sessions
      SET ended_at = now(),
          peak_participants = COALESCE(${input.peakParticipants ?? null}::int, peak_participants)
      WHERE id = ${session.id}`;

    const targetStatus = input.reason === "idle" ? "scheduled" : "ended";
    const [updated] =
      targetStatus === "ended"
        ? await tx<{ status: "ended" | "scheduled" }[]>`
            UPDATE meetings SET status = 'ended', ended_at = now()
            WHERE id = ${session.meetingId} AND status = 'live'
            RETURNING status`
        : await tx<{ status: "ended" | "scheduled" }[]>`
            UPDATE meetings SET status = 'scheduled'
            WHERE id = ${session.meetingId} AND status = 'live'
            RETURNING status`;
    return { ended: true, meetingId: session.meetingId, meetingStatus: updated?.status ?? null };
  });
}
