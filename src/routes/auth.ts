import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { verify as argon2Verify } from "@node-rs/argon2";
import type { Client } from "@libsql/client";
import { getDb, generateToken } from "../db";
import { authenticate } from "../middleware/auth";

const router = new Hono();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

/**
 * Verify a password against a stored hash, supporting both bcrypt and
 * legacy argon2id hashes (created by Bun's `Bun.password.hash` default).
 * Returns true if the password matches; on a successful argon2 match the
 * hash is re-hashed to bcrypt so the account migrates automatically.
 */
async function verifyPassword(db: Client, password: string, storedHash: string, userId: number): Promise<boolean> {
  if (storedHash.startsWith("$argon2")) {
    const ok = await argon2Verify(storedHash, password);
    if (ok) {
      const newHash = await bcrypt.hash(password, 10);
      await db.execute({
        sql: "UPDATE users SET password_hash = ? WHERE id = ?",
        args: [newHash, userId],
      });
    }
    return ok;
  }
  return bcrypt.compare(password, storedHash);
}

router.post("/register", async (c) => {
  try {
    const data = registerSchema.parse(await c.req.json());
    const db = await getDb();
    const existing = (
      await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [data.email.toLowerCase().trim()] })
    ).rows[0];
    if (existing) return c.json({ error: "Email already registered" }, 409);

    const hash = await bcrypt.hash(data.password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
      args: [data.name.trim() || null, data.email.toLowerCase().trim(), hash],
    });
    const userId = Number(result.lastInsertRowid);
    const token = generateToken();
    await db.execute({ sql: "INSERT INTO sessions (id, user_id) VALUES (?, ?)", args: [token, userId] });
    const user = (await db.execute({ sql: "SELECT id, name, email, is_admin FROM users WHERE id = ?", args: [userId] }))
      .rows[0] as unknown as { id: number; name: string | null; email: string; is_admin: number };
    return c.json({ token, user: { ...user, is_admin: !!user.is_admin } });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.post("/login", async (c) => {
  try {
    const data = loginSchema.parse(await c.req.json());
    const db = await getDb();
    const user = (
      await db.execute({
        sql: "SELECT id, name, email, password_hash, is_admin, disabled FROM users WHERE email = ?",
        args: [data.email.toLowerCase().trim()],
      })
    ).rows[0] as unknown as
      | { id: number; name: string | null; email: string; password_hash: string; is_admin: number; disabled: number }
      | undefined;
    if (!user) return c.json({ error: "Invalid email or password" }, 401);
    if (user.disabled) return c.json({ error: "This account has been disabled. Contact your administrator." }, 403);
    const valid = await verifyPassword(db, data.password, user.password_hash, user.id);
    if (!valid) return c.json({ error: "Invalid email or password" }, 401);
    const token = generateToken();
    await db.execute({ sql: "INSERT INTO sessions (id, user_id) VALUES (?, ?)", args: [token, user.id] });
    return c.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin } });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.post("/logout", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const authHeader = c.req.header("Authorization")!;
  const token = authHeader.slice(7);
  await (await getDb()).execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [token] });
  return c.json({ success: true });
});

router.get("/me", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ user: null });
  return c.json({ user });
});

export default router;
