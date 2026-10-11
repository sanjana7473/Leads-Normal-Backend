import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getDb, generateToken } from "../db";
import { authenticateAdmin, type AuthedUser } from "../middleware/auth";

const router = new Hono<{ Variables: { admin: AuthedUser } }>();

// Every route here is admin-only.
router.use("/*", async (c, next) => {
  const admin = await authenticateAdmin(c);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  c.set("admin", admin);
  await next();
});

const createUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email(),
  password: z.string().min(6),
  is_admin: z.boolean().optional(),
  gmail_email: z.string().email().optional().or(z.literal("")),
  gmail_app_password: z.string().optional().or(z.literal("")),
});

const updateEmailCredsSchema = z.object({
  gmail_email: z.string().email().optional().or(z.literal("")),
  gmail_app_password: z.string().optional().or(z.literal("")),
});

const resetPasswordSchema = z.object({ password: z.string().min(6) });

const USER_COLUMNS = "id, name, email, is_admin, disabled, gmail_email, created_at";

function shapeUser(r: {
  id: number; name: string | null; email: string; is_admin: number; disabled: number; gmail_email: string | null; created_at: string;
}) {
  return { ...r, is_admin: !!r.is_admin, disabled: !!r.disabled, has_gmail: !!r.gmail_email };
}

router.get("/users", async (c) => {
  const db = await getDb();
  const rows = (
    await db.execute(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC`)
  ).rows as unknown as { id: number; name: string | null; email: string; is_admin: number; disabled: number; gmail_email: string | null; created_at: string }[];
  return c.json(rows.map(shapeUser));
});

router.post("/users", async (c) => {
  try {
    const data = createUserSchema.parse(await c.req.json());
    const db = await getDb();
    const email = data.email.toLowerCase().trim();
    const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0];
    if (existing) return c.json({ error: "Email already registered" }, 409);

    const hash = await bcrypt.hash(data.password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (name, email, password_hash, is_admin, gmail_email, gmail_app_password) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        data.name?.trim() || null,
        email,
        hash,
        data.is_admin ? 1 : 0,
        data.gmail_email?.trim() || null,
        data.gmail_app_password?.trim() || null,
      ],
    });
    const userId = Number(result.lastInsertRowid);
    const user = (
      await db.execute({ sql: `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, args: [userId] })
    ).rows[0] as unknown as { id: number; name: string | null; email: string; is_admin: number; disabled: number; gmail_email: string | null; created_at: string };

    return c.json(shapeUser(user));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// Set or clear this user's Gmail sending/receiving credentials.
// A blank gmail_email clears both fields (removes the account). A blank
// gmail_app_password otherwise keeps the existing one — the UI leaves it
// blank to mean "don't change" once a password is already on file.
router.post("/users/:id/email-credentials", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
    const data = updateEmailCredsSchema.parse(await c.req.json());
    const db = await getDb();
    const email = data.gmail_email?.trim() || "";
    if (!email) {
      await db.execute({ sql: "UPDATE users SET gmail_email = NULL, gmail_app_password = NULL WHERE id = ?", args: [id] });
      return c.json({ success: true });
    }
    const appPassword = data.gmail_app_password?.trim() || "";
    if (appPassword) {
      await db.execute({
        sql: "UPDATE users SET gmail_email = ?, gmail_app_password = ? WHERE id = ?",
        args: [email, appPassword, id],
      });
      return c.json({ success: true });
    } else {
      await db.execute({ sql: "UPDATE users SET gmail_email = ? WHERE id = ?", args: [email, id] });
    }
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.delete("/users/:id", async (c) => {
  const admin = c.get("admin");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  if (id === admin.id) return c.json({ error: "You cannot delete your own account" }, 400);
  const db = await getDb();
  await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [id] });
  return c.json({ success: true });
});

router.post("/users/:id/disable", async (c) => {
  const admin = c.get("admin");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  if (id === admin.id) return c.json({ error: "You cannot disable your own account" }, 400);
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET disabled = 1 WHERE id = ?", args: [id] });
  // Kick any active sessions immediately.
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
  return c.json({ success: true });
});

router.post("/users/:id/enable", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET disabled = 0 WHERE id = ?", args: [id] });
  return c.json({ success: true });
});

router.post("/users/:id/reset-password", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
    const data = resetPasswordSchema.parse(await c.req.json());
    const db = await getDb();
    const hash = await bcrypt.hash(data.password, 10);
    await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, id] });
    // Force re-login everywhere with the new password.
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.post("/users/:id/generate-password", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  const db = await getDb();
  // Random 12-char password using URL-safe hex from the same token generator as sessions.
  const password = generateToken().slice(0, 12);
  const hash = await bcrypt.hash(password, 10);
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, id] });
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
  return c.json({ success: true, password });
});

export default router;
