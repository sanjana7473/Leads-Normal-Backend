import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import { authenticate } from "../middleware/auth";
import { insertEvent } from "../lib/events";
import { computeSlaStatus, setConversationStatus, type ConversationStatus } from "../lib/conversations";

// Phase 0 — Conversation API. One thread per contact: list conversations with
// status + SLA, view the ordered event timeline, add internal notes, and
// resolve/reopen.

const router = new Hono();

// Refresh the SLA status against "now" before returning a conversation row.
function enrichSla(conv: any) {
  if (conv && typeof conv === "object") {
    conv.sla_status = computeSlaStatus(conv.sla_due_at ?? null);
  }
  return conv;
}

router.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const status = c.req.query("status");
  const sla = c.req.query("sla");
  const db = await getDb();
  let rows = (await db.execute({
    sql: `
    SELECT c.id, c.lead_id, c.status, c.sla_due_at, c.sla_status,
           c.first_event_at, c.last_event_at, c.created_at,
           l.name AS lead_name, l.company, l.city, l.phone, l.email, l.source,
           (SELECT content FROM events e WHERE e.conversation_id = c.id ORDER BY e.created_at DESC LIMIT 1) AS last_content,
           (SELECT created_at FROM events e WHERE e.conversation_id = c.id ORDER BY e.created_at DESC LIMIT 1) AS last_event_created
    FROM conversations c JOIN leads l ON l.id = c.lead_id
    WHERE l.user_id = ?
    ORDER BY COALESCE(c.last_event_at, c.created_at) DESC
  `,
    args: [user.id],
  })).rows as any[];
  rows = rows.map(enrichSla);
  if (status) rows = rows.filter((r) => r.status === status);
  if (sla) rows = rows.filter((r) => r.sla_status === sla);
  return c.json(rows);
});

router.get("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.*, l.name AS lead_name, l.company, l.city, l.phone, l.email, l.source, l.status AS lead_status
          FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id],
  })).rows[0] as any;
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const events = (await db.execute({
    sql: `SELECT id, type, channel, direction, content, handled_by, action, summary, source_ref, metadata, created_at
          FROM events WHERE conversation_id = ? ORDER BY created_at ASC`,
    args: [conv.id],
  })).rows;
  return c.json({ conversation: enrichSla(conv), events });
});

// Add an internal note to the thread (type 'note', direction 'internal' — does
// NOT clear the SLA; handle via resolve or an outbound event).
router.post("/:id/events", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ content: z.string().min(1), handled_by: z.enum(["human", "ai"]).optional() }).parse(await c.req.json());
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.lead_id FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id],
  })).rows[0] as unknown as { lead_id: string } | undefined;
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  await insertEvent(db, {
    lead_id: conv.lead_id,
    channel: "note",
    type: "note",
    direction: "internal",
    handled_by: d.handled_by ?? "human",
    action: "note",
    summary: d.content.slice(0, 120),
    content: d.content,
    metadata: { note: true },
  });
  return c.json({ success: true });
});

// Resolve / reopen / set conversation status.
router.post("/:id/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ status: z.enum(["new", "active", "awaiting_reply", "resolved", "archived"]) }).parse(await c.req.json());
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.id FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id],
  })).rows[0];
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  await setConversationStatus(db, c.req.param("id"), d.status as ConversationStatus);
  return c.json({ success: true });
});

export default router;
