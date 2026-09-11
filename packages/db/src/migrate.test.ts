import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { migrate } from "./migrate";
import { ensureTestDatabase, testDatabaseUrl } from "./testing";

let db: Db;

beforeAll(async () => {
  await ensureTestDatabase();
  db = createDb(testDatabaseUrl(), { max: 2 });
  await db`DROP TABLE IF EXISTS participants, meeting_sessions, meetings, schema_migrations CASCADE`;
});

afterAll(async () => {
  await db.end();
});

describe("migrate", () => {
  it("applies pending migrations once", async () => {
    expect(await migrate(db)).toEqual(["0001_init"]);
    expect(await migrate(db)).toEqual([]);
    const tables = await db<{ tableName: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.tableName)).toEqual([
      "meeting_sessions",
      "meetings",
      "participants",
      "schema_migrations",
    ]);
  });

  it("allows only one live session per meeting", async () => {
    const meetingId = "11111111-1111-4111-8111-111111111111";
    await db`
      INSERT INTO meetings (id, code, org_id, organizer_id, region, settings, status)
      VALUES (${meetingId}, 'abc-defg-hij', ${meetingId}, ${meetingId}, 'local',
              ${db.json({ lobby: true, max_participants: 500 })}, 'scheduled')`;
    await db`
      INSERT INTO meeting_sessions (id, meeting_id, started_at)
      VALUES ('22222222-2222-4222-8222-222222222222', ${meetingId}, now())`;
    await expect(
      db`
        INSERT INTO meeting_sessions (id, meeting_id, started_at)
        VALUES ('33333333-3333-4333-8333-333333333333', ${meetingId}, now())`,
    ).rejects.toMatchObject({ code: "23505" });

    await db`UPDATE meeting_sessions SET ended_at = now() WHERE meeting_id = ${meetingId}`;
    await db`
      INSERT INTO meeting_sessions (id, meeting_id, started_at)
      VALUES ('33333333-3333-4333-8333-333333333333', ${meetingId}, now())`;
    const live = await db`
      SELECT id FROM meeting_sessions WHERE meeting_id = ${meetingId} AND ended_at IS NULL`;
    expect(live.length).toBe(1);
  });
});
