import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { endSession } from "./end-session";
import type { MeetingRow, SessionRow } from "./rows";
import { ensureTestDatabase, testDatabaseUrl, truncateAll } from "./testing";

let db: Db;

beforeAll(async () => {
  await ensureTestDatabase();
  db = createDb(testDatabaseUrl(), { max: 2 });
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await truncateAll(db);
});

async function liveMeeting(peak: number | null = null, status = "live") {
  const meetingId = randomUUID();
  const sessionId = randomUUID();
  await db`
    INSERT INTO meetings (id, code, org_id, organizer_id, region, settings, status)
    VALUES (${meetingId}, ${meetingId.slice(0, 3) + "-" + meetingId.slice(4, 8) + "-" + meetingId.slice(9, 12)},
            ${randomUUID()}, ${randomUUID()}, 'local', ${db.json({ lobby: true, max_participants: 500 })}, ${status})`;
  await db`
    INSERT INTO meeting_sessions (id, meeting_id, started_at, peak_participants)
    VALUES (${sessionId}, ${meetingId}, now(), ${peak})`;
  return { meetingId, sessionId };
}

async function meeting(id: string): Promise<MeetingRow> {
  const [row] = await db<MeetingRow[]>`SELECT * FROM meetings WHERE id = ${id}`;
  return row!;
}

async function session(id: string): Promise<SessionRow> {
  const [row] = await db<SessionRow[]>`SELECT * FROM meeting_sessions WHERE id = ${id}`;
  return row!;
}

describe("endSession", () => {
  it("host_end ends the session and makes the meeting terminal", async () => {
    const { meetingId, sessionId } = await liveMeeting();
    const result = await endSession(db, { sessionId, reason: "host_end", peakParticipants: 7 });
    expect(result).toEqual({ ended: true, meetingId, meetingStatus: "ended" });
    const s = await session(sessionId);
    expect(s.endedAt).toBeInstanceOf(Date);
    expect(s.peakParticipants).toBe(7);
    const m = await meeting(meetingId);
    expect(m.status).toBe("ended");
    expect(m.endedAt).toBeInstanceOf(Date);
  });

  it("api_end is terminal too", async () => {
    const { meetingId, sessionId } = await liveMeeting();
    await endSession(db, { sessionId, reason: "api_end" });
    expect((await meeting(meetingId)).status).toBe("ended");
  });

  it("idle ends the session but returns the meeting to scheduled", async () => {
    const { meetingId, sessionId } = await liveMeeting();
    const result = await endSession(db, { sessionId, reason: "idle" });
    expect(result.meetingStatus).toBe("scheduled");
    const m = await meeting(meetingId);
    expect(m.status).toBe("scheduled");
    expect(m.endedAt).toBeNull();
    expect((await session(sessionId)).endedAt).toBeInstanceOf(Date);
  });

  it("is idempotent", async () => {
    const { meetingId, sessionId } = await liveMeeting();
    await endSession(db, { sessionId, reason: "idle" });
    const second = await endSession(db, { sessionId, reason: "host_end" });
    expect(second).toEqual({ ended: false, meetingId, meetingStatus: null });
    expect((await meeting(meetingId)).status).toBe("scheduled");
  });

  it("keeps an existing peak when none is given", async () => {
    const { sessionId } = await liveMeeting(3);
    await endSession(db, { sessionId, reason: "idle" });
    expect((await session(sessionId)).peakParticipants).toBe(3);
  });

  it("returns ended:false for an unknown session", async () => {
    expect(await endSession(db, { sessionId: randomUUID(), reason: "idle" })).toEqual({
      ended: false,
      meetingId: null,
      meetingStatus: null,
    });
  });

  it("reports meetingStatus:null when the meeting was not live", async () => {
    const { meetingId, sessionId } = await liveMeeting(null, "scheduled");
    const result = await endSession(db, { sessionId, reason: "host_end" });
    expect(result).toEqual({ ended: true, meetingId, meetingStatus: null });
    expect((await session(sessionId)).endedAt).toBeInstanceOf(Date);
    const m = await meeting(meetingId);
    expect(m.status).toBe("scheduled");
    expect(m.endedAt).toBeNull();
  });
});
