import postgres from "postgres";
import { createDb, type Db } from "./client";
import { migrate } from "./migrate";

export function testDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ?? "postgres://zoomclone:zoomclone@localhost:55432/zoomclone_test"
  );
}

/** Creates the database named in the URL when missing, then applies migrations. */
export async function ensureTestDatabase(url: string = testDatabaseUrl()): Promise<void> {
  const name = new URL(url).pathname.replace(/^\//, "");
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const adminDb = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await adminDb`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (rows.length === 0) await adminDb.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await adminDb.end();
  }
  const db = createDb(url, { max: 1 });
  try {
    await migrate(db);
  } finally {
    await db.end();
  }
}

export async function truncateAll(db: Db): Promise<void> {
  await db`TRUNCATE participants, meeting_sessions, meetings`;
}
