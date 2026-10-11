import type { Client } from "@libsql/client";
import { getOrCreateConversation, touchConversation, type HandledBy } from "./conversations";

// Phase 0 — Unified, channel-agnostic Event model.
//
// One row per event in a conversation's timeline. Schema:
//   { type, channel, direction, timestamp (created_at), content, handled_by }
// Every channel (email, whatsapp, call, note, dm, chat…) writes events here so
// the dashboard / inbox / SLA all read from the same source of truth.

export type EventChannel = "email" | "whatsapp" | "call" | "note" | "dm" | "chat" | "system";
export type EventDirection = "inbound" | "outbound" | "internal";

// Map an operating channel to a channel-agnostic event type.
export function typeFromChannel(channel: EventChannel): EventChannel {
  return channel;
}

export interface NewEvent {
  lead_id?: string | null;
  channel: EventChannel;
  action: string;
  summary?: string | null;
  source_ref?: string | null;
  metadata?: unknown;
  created_at?: string;
  // Phase 0 unified fields
  type?: EventChannel; // defaults to channel
  direction?: EventDirection; // defaults to "internal"
  content?: string | null; // defaults to summary
  handled_by?: HandledBy; // defaults to "unhandled"
}

export async function insertEvent(db: Client, e: NewEvent): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = e.created_at ?? new Date().toISOString();
  const type = e.type ?? e.channel;
  const direction = e.direction ?? "internal";
  const content = e.content ?? e.summary ?? null;
  const handledBy = e.handled_by ?? "unhandled";

  await db.execute({
    sql: `INSERT INTO events
      (id, lead_id, channel, action, summary, source_ref, metadata, created_at,
       type, direction, content, handled_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      e.lead_id ?? null,
      e.channel,
      e.action,
      e.summary ?? null,
      e.source_ref ?? null,
      e.metadata !== undefined ? JSON.stringify(e.metadata) : null,
      createdAt,
      type,
      direction,
      content,
      handledBy,
    ],
  });

  // Keep the conversation timeline + SLA in sync (one thread per contact).
  if (e.lead_id) {
    const conv = await getOrCreateConversation(db, e.lead_id);
    await touchConversation(db, {
      conversation_id: conv.id,
      createdAt,
      direction,
      handledBy,
    });
  }

  return id;
}

