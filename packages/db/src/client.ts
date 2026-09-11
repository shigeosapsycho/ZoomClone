import postgres from "postgres";

/**
 * postgres.js connection. Column names are camelCased (meeting_id -> meetingId). JSON/JSONB
 * values are never rewritten: postgres.camel's value transform recurses into JSON payloads and
 * would camelCase their keys too (max_participants -> maxParticipants), which does not match
 * what callers write into those columns. Only the column-name transform is applied.
 */
export type Db = postgres.Sql;

export function createDb(url: string, options: { max?: number } = {}): Db {
  return postgres(url, {
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } },
    max: options.max ?? 10,
    onnotice: () => {},
  });
}
