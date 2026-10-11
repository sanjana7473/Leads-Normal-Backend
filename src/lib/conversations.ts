import type { Client } from "@libsql/client";

// Phase 0 — single Conversation model.
//
// Every contact has exactly one Conversation (the thread). All channel events
// (call, WhatsApp, email, DM, note) land in that conversation as ordered Events.
// SLA + status live HERE at the conversation level, not per-channel — this is
// what later powers the "nothing goes untouched" alerting.

export type ConversationStatus = "new" | "active" | "awaiting_reply" | "resolved" | "archived";
export type SlaStatus = "none" | "within_sla" | "breached";
export type HandledBy = "human" | "ai" | "unhandled";

export const CONVERSATION_STATUSES: ConversationStatus[] = ["new", "active", "awaiting_reply", "resolved", "archived"];

// How long a human/AI has to respond to an inbound message before the SLA
// "breaches". Configurable via SLA_RESPONSE_HOURS (default 4h).
const SLA_RESPONSE_HOURS = (() => {
  const v = Number(process.env.SLA_RESPONSE_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 4;
})();

export interface Conversation {
  id: string;
  lead_id: string;
  status: ConversationStatus;
  sla_due_at: string | null;
  sla_status: SlaStatus;
  first_event_at: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string | null;
}

/** The SLA deadline for a message received at `from`. */
export function slaDueAfter(from: string | Date): string {
  const d = new Date(from);
  d.setTime(d.getTime() + SLA_RESPONSE_HOURS * 3600 * 1000);
  return d.toISOString();
}

/** Evaluate SLA status against "now" (defaults to current time). */
export function computeSlaStatus(dueAt: string | null, now: Date = new Date()): SlaStatus {
  if (!dueAt) return "none";
  return new Date(dueAt).getTime() < now.getTime() ? "breached" : "within_sla";
}

/**
 * Return the conversation for a lead, creating it if absent. There is one
 * conversation per contact — the deterministic id keeps this idempotent.
 */
export async function getOrCreateConversation(db: Client, leadId: string): Promise<Conversation> {
  const id = `conv-${leadId}`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO conversations (id, lead_id, status, sla_status, created_at)
          VALUES (?, ?, 'new', 'none', ?)`,
    args: [id, leadId, new Date().toISOString()],
  });
  const row = (await db.execute({ sql: "SELECT * FROM conversations WHERE id = ?", args: [id] })).rows[0] as unknown as Conversation | undefined;
  if (!row) throw new Error("Failed to load conversation");
  row.sla_due_at = row.sla_due_at ?? null;
  row.sla_status = computeSlaStatus(row.sla_due_at);
  return row;
}

export interface TouchEvent {
  conversation_id: string;
  createdAt: string;
  direction?: string | null; // "inbound" | "outbound" | "internal"
  handledBy?: HandledBy | null;
}

/**
 * Update a conversation's timeline + SLA from a new event.
 *  - inbound & unhandled  → start/refresh the SLA timer (keeps the earliest due)
 *  - outbound or handled  → a response happened → SLA met, timer cleared
 */
export async function touchConversation(db: Client, ev: TouchEvent): Promise<void> {
  const nowIso = new Date().toISOString();
  const conv = (await db.execute({ sql: "SELECT status, sla_due_at FROM conversations WHERE id = ?", args: [ev.conversation_id] })).rows[0] as unknown as
    | { status: string; sla_due_at: string | null }
    | undefined;
  if (!conv) return;

  let dueAt: string | null = conv.sla_due_at;
  let status: string = conv.status;

  const inbound = ev.direction === "inbound";
  // A real response = an outbound message, or a human/AI handoff on a non-internal event.
  // Internal notes (handled_by human, direction internal) don't clear the SLA.
  const isReply = ev.direction === "outbound" || (ev.handledBy === "human" || ev.handledBy === "ai") && ev.direction !== "internal";

  if (inbound && ev.handledBy === "unhandled") {
    const due = slaDueAfter(ev.createdAt);
    if (!dueAt || new Date(due).getTime() < new Date(dueAt).getTime()) dueAt = due;
    if (status !== "resolved" && status !== "archived") status = "awaiting_reply";
  } else if (isReply) {
    dueAt = null; // SLA met — a human/AI has engaged
    if (status === "awaiting_reply") status = "active";
  }

  await db.execute({
    sql: `UPDATE conversations SET
      first_event_at = COALESCE(first_event_at, ?),
      last_event_at = CASE WHEN last_event_at IS NULL OR ? > last_event_at THEN ? ELSE last_event_at END,
      sla_due_at = ?, sla_status = ?, status = ?, updated_at = ?
      WHERE id = ?`,
    args: [ev.createdAt, ev.createdAt, ev.createdAt, dueAt, computeSlaStatus(dueAt), status, nowIso, ev.conversation_id],
  });
}

/** Set a conversation as resolved (clears any pending SLA) or reopen it. */
export async function setConversationStatus(db: Client, conversationId: string, status: ConversationStatus): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.execute({
    sql: "UPDATE conversations SET status = ?, sla_due_at = NULL, sla_status = 'none', updated_at = ? WHERE id = ?",
    args: [status, nowIso, conversationId],
  });
}
