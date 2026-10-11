import { getDb } from "../db";

export interface AuthedUser {
  id: number;
  name: string | null;
  email: string;
  is_admin: boolean;
}

export async function authenticate(c: { req: { header: (name: string) => string | undefined } }): Promise<AuthedUser | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT u.id, u.name, u.email, u.is_admin, u.disabled FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    args: [token],
  });
  const row = result.rows[0] as unknown as
    | { id: number; name: string | null; email: string; is_admin: number; disabled: number }
    | undefined;
  if (!row) return null;
  // Disabled accounts are rejected even with a valid session token.
  if (row.disabled) return null;

  return { id: row.id, name: row.name, email: row.email, is_admin: !!row.is_admin };
}

/** Requires an authenticated admin user; returns null (and the caller should 401/403) otherwise. */
export async function authenticateAdmin(c: { req: { header: (name: string) => string | undefined } }): Promise<AuthedUser | null> {
  const user = await authenticate(c);
  if (!user || !user.is_admin) return null;
  return user;
}
