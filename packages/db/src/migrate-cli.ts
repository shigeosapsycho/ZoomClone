import { createDb } from "./client";
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = createDb(url, { max: 1 });
try {
  const ran = await migrate(db);
  console.log(ran.length ? `applied: ${ran.join(", ")}` : "no pending migrations");
} finally {
  await db.end();
}
