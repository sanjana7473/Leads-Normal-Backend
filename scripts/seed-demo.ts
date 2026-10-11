// Seed the demo account used across dev/staging:
//   email:    testuser@gmail.com
//   password: Str0ng!P9a
// Uses the exact same bcrypt hash as db.ts's DEMO_USER_HASH, then verifies the
// password actually matches. Idempotent (INSERT OR IGNORE, id=1).
//
// Usage: npx tsx --env-file=.env scripts/seed-demo.ts
import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing from .env");
  process.exit(1);
}

// Mirrors db.ts — do NOT change; the login flow verifies against this.
const DEMO_USER_HASH = "$2b$10$/ixfDGIckZ5KISPFS5y7puGhS4MGJkUJHkrdgDMG.si2aBQtWHy2u";
const EMAIL = "testuser@gmail.com";
const PASSWORD = "Str0ng!P9a";

const db = createClient({ url, authToken });

await db.execute({
  sql: "INSERT OR IGNORE INTO users (id, name, email, password_hash) VALUES (1, ?, ?, ?)",
  args: ["Test User", EMAIL, DEMO_USER_HASH],
});

const row = (await db.execute({ sql: "SELECT id, name, email, password_hash FROM users WHERE email = ?", args: [EMAIL] })).rows[0] as
  | { id: number; name: string | null; email: string; password_hash: string }
  | undefined;

if (!row) {
  console.error("Insert failed — user not found after insert.");
  process.exit(1);
}

const ok = await bcrypt.compare(PASSWORD, row.password_hash);
console.log(`Demo account: ${row.email} (id=${row.id}, name=${row.name ?? "—"})`);
console.log(ok ? `Password verified: ${PASSWORD}` : `WARNING: password check FAILED for ${EMAIL}`);
await db.close();
