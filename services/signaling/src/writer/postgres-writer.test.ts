import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "@zoomclone/db/testing";
import { createTestInfra, seedSession, silentLog, type TestInfra } from "../../test/helpers";
import { PostgresWriter } from "./postgres-writer";

let infra: TestInfra;
beforeAll(async () => {
  infra = await createTestInfra();
});
afterAll(async () => {
  await infra.close();
});
beforeEach(async () => {
  await truncateAll(infra.db);
});

function joined(sessionId: string, participantId: string) {
  return {
    session_id: sessionId,
    participant_id: participantId,
    user_id: null,
    display_name: "Ann",
    role: "attendee" as const,
    joined_at: "2026-09-10T10:00:00.000Z",
  };
}

describe("PostgresWriter", () => {
  it("upserts joined and left rows and tolerates duplicate deliveries", async () => {
    const { sessionId } = await seedSession(infra.db);
    const writer = new PostgresWriter(infra.db, infra.bus, silentLog, { flushMs: 10 });
    writer.start();
    const pid = randomUUID();
    infra.bus.publish("participant.joined", sessionId, joined(sessionId, pid));
    infra.bus.publish("participant.joined", sessionId, {
      ...joined(sessionId, pid),
      display_name: "Ann R",
    });
    infra.bus.publish("participant.left", sessionId, {
      session_id: sessionId,
      participant_id: pid,
      left_at: "2026-09-10T10:05:00.000Z",
      reason: "timeout",
    });
    infra.bus.publish("participant.left", sessionId, {
      session_id: sessionId,
      participant_id: pid,
      left_at: "2026-09-10T10:09:00.000Z",
      reason: "removed",
    });
    await infra.bus.drain();
    await writer.flush();
    const rows = await infra.db<
      { id: string; displayName: string; leftAt: Date | null; leaveReason: string | null }[]
    >`
      SELECT id, display_name, left_at, leave_reason FROM participants`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pid, displayName: "Ann R", leaveReason: "timeout" });
    expect(rows[0]?.leftAt?.toISOString()).toBe("2026-09-10T10:05:00.000Z");
    await writer.stop();
  });

  it("ends the session as a backup path, idempotently", async () => {
    const { sessionId } = await seedSession(infra.db);
    const writer = new PostgresWriter(infra.db, infra.bus, silentLog, { flushMs: 10 });
    writer.start();
    infra.bus.publish("session.ended", sessionId, {
      session_id: sessionId,
      reason: "host_end",
      peak_participants: 4,
    });
    infra.bus.publish("session.ended", sessionId, {
      session_id: sessionId,
      reason: "idle",
      peak_participants: 9,
    });
    await infra.bus.drain();
    await writer.flush();
    const [session] = await infra.db<{ endedAt: Date | null; peakParticipants: number | null }[]>`
      SELECT ended_at, peak_participants FROM meeting_sessions WHERE id = ${sessionId}`;
    expect(session?.endedAt).not.toBeNull();
    expect(session?.peakParticipants).toBe(4);
    const [meeting] = await infra.db<{ status: string }[]>`SELECT status FROM meetings`;
    expect(meeting?.status).toBe("ended");
    await writer.stop();
  });

  it("retries a failing item a bounded number of times, then drops it and keeps going", async () => {
    const { sessionId } = await seedSession(infra.db);
    const writer = new PostgresWriter(infra.db, infra.bus, silentLog, {
      flushMs: 10,
      maxAttempts: 2,
      retryMs: 10,
    });
    writer.start();
    const poison = joined(randomUUID(), randomUUID()); // unknown session: foreign key violation
    const good = joined(sessionId, randomUUID());
    infra.bus.publish("participant.joined", poison.session_id, poison);
    infra.bus.publish("participant.joined", sessionId, good);
    await infra.bus.drain();
    await writer.flush();
    expect(writer.pending).toBe(0);
    const rows = await infra.db<{ id: string }[]>`SELECT id FROM participants`;
    expect(rows.map((r) => r.id)).toEqual([good.participant_id]);
    await writer.stop();
  });
});
