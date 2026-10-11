// Webhook for Plivo Agentflow "Event Callbacks". The flow posts call progress
// here (answered / no-answer / completed / transcription / summary) and we fold
// it back onto the matching call log + the conversation timeline.
//
// Correlates on the `phlo_id` we stored when dialling, or on the `call_id` /
// `lead_id` passed through the trigger payload — whichever the flow echoes back.
//
// Public + unauthenticated by design (Plivo cannot present our session token),
// so it must never leak data: unknown ids are ignored and only status-style
// fields are written.
import { Hono } from "hono";
import { getDb } from "../db";

const router = new Hono();

/** Pull the first present string among several possible key names. */
function pick(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** Plivo statuses we understand, mapped onto our call_logs vocabulary. */
function mapStatus(raw: string | null): { status: string; ended: boolean } | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/completed|answered|hangup|end/.test(s)) return { status: "completed", ended: true };
  if (/no.?answer|unanswered|missed/.test(s)) return { status: "no_answer", ended: true };
  if (/busy|rejected|failed|error|cancel/.test(s)) return { status: "failed", ended: true };
  if (/ringing|in.?progress|queued|initiated|answered_screen/.test(s)) return { status: "in_progress", ended: false };
  return null;
}

router.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return c.json({ ok: true, ignored: "non-JSON body" });
  }

  // Plivo nests the payload differently across flow versions — check the top
  // level first, then the common wrappers.
  const src = (body.payload ?? body.event ?? body.data ?? body) as Record<string, unknown>;

  // Verified against the live trigger: `phlo_id` is the *static flow UUID* (the
  // same value on every run), so it identifies the flow, not the call. `api_id`
  // is unique per run and is the only reliable correlation key.
  const apiId = pick(src, "api_id", "apiId", "request_id", "run_id");
  const phloId = pick(src, "phlo_id", "flow_run_id", "phloId");
  const callRef = pick(src, "call_id", "reference_id", "call_uuid", "callUUID");
  const rawStatus = pick(src, "status", "call_status", "event", "EventStatus", "state");
  const mapped = mapStatus(rawStatus);

  if (!apiId && !phloId && !callRef) return c.json({ ok: true, ignored: "no correlation id" });

  const db = await getDb();

  // 1) Unique run id — the only unambiguous match.
  let row: { id: string; lead_id: string | null } | undefined;
  if (apiId) {
    row = (await db.execute({ sql: "SELECT id, lead_id FROM call_logs WHERE plivo_api_id = ? LIMIT 1", args: [apiId] }))
      .rows[0] as unknown as { id: string; lead_id: string | null } | undefined;
  }
  // 2) Fall back to an id we supplied in the trigger payload.
  if (!row && callRef) {
    row = (await db.execute({ sql: "SELECT id, lead_id FROM call_logs WHERE id = ? LIMIT 1", args: [callRef] }))
      .rows[0] as unknown as { id: string; lead_id: string | null } | undefined;
  }
  // 3) Last resort: phlo_id, but ONLY if it resolves to exactly one call log.
  //    Matching "the first row" here would attach this transcript to an
  //    unrelated lead, so an ambiguous match is rejected instead.
  if (!row && phloId) {
    const hits = (await db.execute({ sql: "SELECT id, lead_id FROM call_logs WHERE phlo_id = ?", args: [phloId] }))
      .rows as unknown as { id: string; lead_id: string | null }[];
    if (hits.length === 1) row = hits[0];
    else if (hits.length > 1) {
      return c.json({ ok: true, ignored: "ambiguous phlo_id (flow-level id, not unique per call)", matches: hits.length });
    }
  }
  if (!row) return c.json({ ok: true, ignored: "unknown call" });

  // Remember the run id for any later callbacks on the same call.
  if (apiId) {
    await db.execute({
      sql: "UPDATE call_logs SET plivo_api_id = COALESCE(plivo_api_id, ?) WHERE id = ?",
      args: [apiId, row.id],
    });
  }

  const transcript = pick(src, "transcript", "conversation", "dialogue");
  const summary = pick(src, "summary", "call_summary");
  const outcome = pick(src, "outcome", "result", "disposition");
  const duration = Number(src["duration"] ?? src["duration_sec"] ?? NaN);

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (mapped) {
    sets.push("status = ?");
    vals.push(mapped.status);
    if (mapped.ended) {
      sets.push("ended_at = ?");
      vals.push(new Date().toISOString());
    }
  }
  if (transcript) { sets.push("transcript = ?"); vals.push(transcript); }
  if (summary) { sets.push("summary = ?"); vals.push(summary); }
  if (outcome) { sets.push("outcome = ?"); vals.push(outcome); }
  if (Number.isFinite(duration) && duration > 0) { sets.push("duration_sec = ?"); vals.push(Math.round(duration)); }

  if (sets.length) {
    vals.push(row.id);
    await db.execute({ sql: `UPDATE call_logs SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  }

  // Mirror onto the activity timeline so the conversation reflects the call.
  if (mapped) {
    await db.execute({
      sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'call', ?, ?, ?, ?)",
      args: [
        crypto.randomUUID(), row.lead_id, mapped.status,
        summary ?? `AI call ${mapped.status.replace("_", " ")}`, row.id, new Date().toISOString(),
      ],
    });
  }

  return c.json({ success: true, call_id: row.id, status: mapped?.status ?? null });
});

export default router;