// Restore the documented demo/admin account password in the live Turso DB.
//   email:    testuser@gmail.com (id=1)
//   password: Str0ng!P9a
// The seed in db.ts / seed-demo.ts uses INSERT OR IGNORE, so a later password
// reset can leave the documented credentials stale. This script re-hashes the
// documented password and UPDATEs the row, then verifies the match.
//
// Usage: npx tsx --env-file=.env scripts/reset-demo-password.mts
import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing from .env");
  process.exit(1);
}

const EMAIL = "testuser@gmail.com";
const PASSWORD = "Str0ng!P9a";

const db = createClient({ url, authToken });

const hash = await bcrypt.hash(PASSWORD, 10);
const res = await db.execute({
  sql: "UPDATE users SET password_hash = ?, disabled = 0, is_admin = 1 WHERE email = ?",
  args: [hash, EMAIL],
});
console.log(`Rows updated for ${EMAIL}: ${res.rowsAffected}`);

const row = (
  await db.execute({ sql: "SELECT id, email, password_hash FROM users WHERE email = ?", args: [EMAIL] })
).rows[0] as { id: number; email: string; password_hash: string } | undefined;

if (!row) {
  console.error(`User ${EMAIL} not found.`);
  process.exit(1);
}

const ok = await bcrypt.compare(PASSWORD, row.password_hash);
console.log(ok ? `OK — ${row.email} now logs in with: ${PASSWORD}` : `WARNING: password check FAILED for ${row.email}`);
await db.close();
