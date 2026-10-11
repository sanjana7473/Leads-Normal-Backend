// Verify the wipe: prints row counts + whether each app table's schema exists.
// Usage: npx tsx --env-file=.env scripts/check-db.ts
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const tables = [
  "leads",
  "email_messages",
  "whatsapp_messages",
  "chat_messages",
  "call_logs",
  "appointments",
  "conversations",
  "events",
  "sessions",
  "users",
];

for (const t of tables) {
  const r = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
  const s = await db.execute(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${t}'`);
  console.log(`${t.padEnd(18)} rows=${(r.rows[0] as { n: number }).n}  schema=${s.rows.length ? "intact" : "MISSING"}`);
}
await db.close();
