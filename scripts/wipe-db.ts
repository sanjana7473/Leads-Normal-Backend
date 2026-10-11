// One-shot data wipe: deletes every row from all app tables in the configured
// Turso database (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from .env). The schema
// itself is left alone — db.ts re-creates it idempotently on next boot.
//
// Usage: npx tsx --env-file=.env scripts/wipe-db.ts
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing from .env");
  process.exit(1);
}

const db = createClient({ url, authToken });

// Children first, then parents — safest even though FKs aren't enforced.
const TABLES = [
  "events",
  "conversations",
  "appointments",
  "call_logs",
  "email_messages",
  "whatsapp_messages",
  "chat_messages",
  "leads",
  "sessions",
  "users",
];

let total = 0;
for (const t of TABLES) {
  try {
    const r = await db.execute(`DELETE FROM ${t}`);
    const n = Number(r.rowsAffected ?? 0);
    total += n;
    console.log(`${t.padEnd(18)} ${n} rows deleted`);
  } catch (e) {
    console.log(`${t.padEnd(18)} skipped (${(e as Error).message})`);
  }
}

console.log(`\nDone — ${total} rows cleared. Schema stays; it re-creates idempotently on next boot.`);
await db.close();
