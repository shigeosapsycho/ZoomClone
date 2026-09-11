import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { ensureTestDatabase, testDatabaseUrl, truncateAll } from "./testing";

let db: Db;

beforeAll(async () => {
  await ensureTestDatabase();
  db = createDb(testDatabaseUrl());
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await truncateAll(db);
});

describe("createDb transform", () => {
  it("camelCases column names but leaves JSONB values untouched", async () => {
    const id = randomUUID();
    const orgId = randomUUID();
    const settings = { lobby: true, max_participants: 500 };
    await db`
      INSERT INTO meetings (id, code, org_id, organizer_id, region, settings, status)
      VALUES (${id}, 'abc-defg-hij', ${orgId}, ${randomUUID()}, 'local', ${db.json(settings)}, 'scheduled')`;

    const rows = await db<{ settings: Record<string, unknown>; orgId: string }[]>`
      SELECT settings, org_id FROM meetings WHERE id = ${id}`;
    expect(rows).toHaveLength(1);
    const [row] = rows;

    // JSONB value keys survive as written: still snake_case, not camelCased.
    expect(row?.settings).toEqual(settings);
    // SQL column name org_id is camelCased to orgId on the result row.
    expect(row?.orgId).toBe(orgId);
  });
});
