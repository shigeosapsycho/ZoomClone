import postgres from "postgres";

/** postgres.js connection. Result columns are camelCased (meeting_id -> meetingId). */
export type Db = postgres.Sql;

export function createDb(url: string, options: { max?: number } = {}): Db {
  return postgres(url, {
    transform: postgres.camel,
    max: options.max ?? 10,
    onnotice: () => {},
  });
}
