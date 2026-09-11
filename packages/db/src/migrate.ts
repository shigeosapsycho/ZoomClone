import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
/**
 * Advisory lock so concurrent migrators (parallel test workers, several pods) serialize.
 * Also covers creating the schema_migrations bookkeeping table, so two first-run migrators
 * can't both see it absent and race on the catalog unique violation.
 */
const LOCK_ID = 727001;

/** Applies every migrations/*.sql not yet recorded in schema_migrations, in filename order. */
export async function migrate(db: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    const applied = new Set(
      (await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
    );
    const ran: string[] = [];
    for (const file of files) {
      const name = file.replace(/\.sql$/, "");
      if (applied.has(name)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await tx.unsafe(sql);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      ran.push(name);
    }
    return ran;
  });
}
