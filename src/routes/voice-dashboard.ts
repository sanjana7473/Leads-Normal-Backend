import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import { authenticate, type AuthedUser } from "../middleware/auth";
import { insertEvent } from "../lib/events";
import { parseWhen, formatIst } from "../lib/when-parser";

// Dashboard (session-auth) endpoints for what the AI voice agent arranged:
// promised callbacks, site visits, and the transcript of each call.
// Everything is scoped to the signed-in user through the lead's owner.

const router = new Hono<{ Variables: { user: AuthedUser } }>();

const IST_MIN = 330;
const DAY = 86400000;

/** Start of the current IST day, as a UTC instant. */
function istDayStart(now: Date): Date {
  const shifted = new Date(now.getTime() + IST_MIN * 60000);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnight - IST_MIN * 60000);
}

router.use("/*", async (c, next) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
});

const uid = (c: { get: (k: "user") => AuthedUser }) => c.get("user").id;

type Row = Record<string, unknown>;

const CALLBACK_SQL = `SELECT cb.id, cb.lead_id, cb.due_at, cb.reason, cb.status, cb.attempts, cb.last_attempt_at,
    cb.source_call_id, cb.result_call_id, cb.created_at,
    l.name AS lead_name, l.phone AS lead_phone, l.interest AS lead_interest, l.status AS lead_status
  FROM callbacks cb JOIN leads l ON l.id = cb.lead_id`;

const VISIT_SQL = `SELECT a.id, a.lead_id, a.title, a.project, a.location, a.notes, a.scheduled_at, a.duration_min,
    a.status, a.source, a.call_id, a.created_at,
    l.name AS lead_name, l.phone AS lead_phone, l.interest AS lead_interest
  FROM appointments a JOIN leads l ON l.id = a.lead_id`;

function countsFrom(callbacks: Row[], visits: Row[], now: Date) {
  const start = istDayStart(now).getTime();
  const end = start + DAY;
  const t = now.getTime();
  const pending = callbacks.filter((c) => c.status === "pending" || c.status === "calling");
  const dueNow = pending.filter((c) => new Date(String(c.due_at)).getTime() <= t + 15 * 60000);
  const overdue = pending.filter((c) => new Date(String(c.due_at)).getTime() < t - 5 * 60000);
  const visitsToday = visits.filter((v) => {
    const s = new Date(String(v.scheduled_at)).getTime();
    return v.status === "confirmed" && s >= start && s < end;
  });
  const visitsUpcoming = visits.filter((v) => v.status === "confirmed" && new Date(String(v.scheduled_at)).getTime() >= t);
  return {
    callbacks_pending: pending.length,
    callbacks_due_now: dueNow.length,
    callbacks_overdue: overdue.length,
    callbacks_today: pending.filter((c) => {
      const d = new Date(String(c.due_at)).getTime();
      return d >= start && d < end;
    }).length,
    visits_today: visitsToday.length,
    visits_upcoming: visitsUpcoming.length,
    // What the sidebar badge shows: things that need attention right now.
    attention: dueNow.length + visitsToday.length,
  };
}

// ---- GET /schedule — everything the Voice Agent page and badge need --------
router.get("/schedule", async (c) => {
  const db = await getDb();
  const userId = uid(c);
  const now = new Date();
  const since = new Date(now.getTime() - 14 * DAY).toISOString();
  const [cbs, vis] = await Promise.all([
    db.execute({
      sql: `${CALLBACK_SQL} WHERE l.user_id = ? AND (cb.status IN ('pending','calling') OR cb.due_at >= ?)
            ORDER BY cb.due_at ASC LIMIT 400`,
      args: [userId, since],
    }),
    db.execute({
      sql: `${VISIT_SQL} WHERE l.user_id = ? AND (a.status = 'confirmed' OR a.scheduled_at >= ?)
            ORDER BY a.scheduled_at ASC LIMIT 400`,
      args: [userId, since],
    }),
  ]);
  const callbacks = cbs.rows as unknown as Row[];
  const visits = vis.rows as unknown as Row[];
  return c.json({ now: now.toISOString(), now_ist: formatIst(now), callbacks, visits, counts: countsFrom(callbacks, visits, now) });
});

// ---- GET /counts — light poll for the sidebar badge ------------------------
router.get("/counts", async (c) => {
  const db = await getDb();
  const userId = uid(c);
  const now = new Date();
  const [cbs, vis] = await Promise.all([
    db.execute({ sql: `${CALLBACK_SQL} WHERE l.user_id = ? AND cb.status IN ('pending','calling')`, args: [userId] }),
    db.execute({ sql: `${VISIT_SQL} WHERE l.user_id = ? AND a.status = 'confirmed' AND a.scheduled_at >= ?`, args: [userId, new Date(now.getTime() - DAY).toISOString()] }),
  ]);
  return c.json(countsFrom(cbs.rows as unknown as Row[], vis.rows as unknown as Row[], now));
});

// ---- GET /leads/:id — one lead's callbacks, visits and AI calls ------------
router.get("/leads/:id", async (c) => {
  const db = await getDb();
  const userId = uid(c);
  const leadId = c.req.param("id");
  const owned = (await db.execute({ sql: "SELECT id FROM leads WHERE id = ? AND user_id = ?", args: [leadId, userId] })).rows[0];
  if (!owned) return c.json({ error: "Lead not found" }, 404);
  const [cbs, vis, calls] = await Promise.all([
    db.execute({ sql: `${CALLBACK_SQL} WHERE cb.lead_id = ? ORDER BY cb.due_at DESC LIMIT 20`, args: [leadId] }),
    db.execute({ sql: `${VISIT_SQL} WHERE a.lead_id = ? ORDER BY a.scheduled_at DESC LIMIT 20`, args: [leadId] }),
    db.execute({
      sql: `SELECT id, direction, status, outcome, summary, duration_sec, started_at, created_at
            FROM call_logs WHERE lead_id = ? ORDER BY created_at DESC LIMIT 10`,
      args: [leadId],
    }),
  ]);
  return c.json({ callbacks: cbs.rows, visits: vis.rows, calls: calls.rows });
});

// ---- PATCH /callbacks/:id ---------------------------------------------------
const CALLBACK_STATUS = ["pending", "calling", "done", "missed", "cancelled"] as const;
router.patch("/callbacks/:id", async (c) => {
  try {
    const db = await getDb();
    const userId = uid(c);
    const id = c.req.param("id");
    const body = z.object({ status: z.enum(CALLBACK_STATUS).optional(), when: z.string().max(200).optional(), reason: z.string().max(500).optional() }).parse(await c.req.json());
    const row = (await db.execute({ sql: `${CALLBACK_SQL} WHERE cb.id = ? AND l.user_id = ?`, args: [id, userId] })).rows[0] as unknown as Row | undefined;
    if (!row) return c.json({ error: "Callback not found" }, 404);

    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    let summary = "";
    if (body.when) {
      const parsed = parseWhen(body.when);
      if (!parsed.ok) return c.json({ error: "Bad request", message: "Couldn't understand that date/time." }, 400);
      sets.push("due_at = ?", "status = ?", "attempts = 0");
      vals.push(parsed.value.at.toISOString(), "pending");
      summary = `Callback rescheduled to ${parsed.value.spoken}`;
    }
    if (body.status && !body.when) {
      sets.push("status = ?");
      vals.push(body.status);
      summary = `Callback marked ${body.status}`;
    }
    if (body.reason !== undefined) { sets.push("reason = ?"); vals.push(body.reason || null); }
    if (!sets.length) return c.json({ error: "Bad request", message: "Nothing to update." }, 400);
    vals.push(id);
    await db.execute({ sql: `UPDATE callbacks SET ${sets.join(", ")} WHERE id = ?`, args: vals });
    if (summary) {
      await insertEvent(db, { lead_id: String(row.lead_id), channel: "call", type: "call", direction: "internal", handled_by: "human", action: "callback-updated", summary });
    }
    const fresh = (await db.execute({ sql: `${CALLBACK_SQL} WHERE cb.id = ?`, args: [id] })).rows[0];
    return c.json(fresh);
  } catch (e) {
    return c.json({ error: "Bad request", message: (e as Error).message }, 400);
  }
});

// ---- PATCH /visits/:id ------------------------------------------------------
const VISIT_STATUS = ["confirmed", "completed", "cancelled", "no_show"] as const;
router.patch("/visits/:id", async (c) => {
  try {
    const db = await getDb();
    const userId = uid(c);
    const id = c.req.param("id");
    const body = z.object({ status: z.enum(VISIT_STATUS).optional(), when: z.string().max(200).optional(), location: z.string().max(300).optional(), notes: z.string().max(2000).optional() }).parse(await c.req.json());
    const row = (await db.execute({ sql: `${VISIT_SQL} WHERE a.id = ? AND l.user_id = ?`, args: [id, userId] })).rows[0] as unknown as Row | undefined;
    if (!row) return c.json({ error: "Visit not found" }, 404);

    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    let summary = "";
    if (body.when) {
      const parsed = parseWhen(body.when);
      if (!parsed.ok) return c.json({ error: "Bad request", message: "Couldn't understand that date/time." }, 400);
      sets.push("scheduled_at = ?", "status = ?");
      vals.push(parsed.value.at.toISOString(), "confirmed");
      summary = `Site visit rescheduled to ${parsed.value.spoken}`;
    }
    if (body.status && !body.when) {
      sets.push("status = ?");
      vals.push(body.status);
      summary = `Site visit marked ${body.status.replace("_", " ")}`;
    }
    if (body.location !== undefined) { sets.push("location = ?"); vals.push(body.location || null); }
    if (body.notes !== undefined) { sets.push("notes = ?"); vals.push(body.notes || null); }
    if (!sets.length) return c.json({ error: "Bad request", message: "Nothing to update." }, 400);
    vals.push(id);
    await db.execute({ sql: `UPDATE appointments SET ${sets.join(", ")} WHERE id = ?`, args: vals });
    if (summary) {
      await insertEvent(db, { lead_id: String(row.lead_id), channel: "call", type: "call", direction: "internal", handled_by: "human", action: "visit-updated", summary: `${summary} — ${row.project ?? row.title}` });
    }
    const fresh = (await db.execute({ sql: `${VISIT_SQL} WHERE a.id = ?`, args: [id] })).rows[0];
    return c.json(fresh);
  } catch (e) {
    return c.json({ error: "Bad request", message: (e as Error).message }, 400);
  }
});

// ---- POST /calls/:id/sync — pull the transcript from Plivo ------------------
// The Agentflow runner keeps the full per-turn transcript of every run. The
// flow can't push it to us, so on demand we find the run that matches this call
// (same phone number, started within a few minutes) and copy it onto the call log.
interface PlivoLog { sender?: string | null; text?: string | null; timestamp?: string; event_name?: string; current_node_type?: string; node_config?: Record<string, unknown> }

async function plivoGet(path: string): Promise<Record<string, unknown> | null> {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!id || !token) return null;
  const res = await fetch(`https://api.plivo.com/v1/Account/${id}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${token}`).toString("base64")}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const sameNumber = (a: unknown, b: unknown) => {
  const x = digits(a), y = digits(b);
  return x.length >= 7 && y.length >= 7 && x.slice(-10) === y.slice(-10);
};

export function buildTranscript(logs: PlivoLog[]): { speaker: "agent" | "user"; text: string }[] {
  const out: { speaker: "agent" | "user"; text: string }[] = [];
  for (const l of logs) {
    if (l.event_name !== "NODE_CHUNK_CREATED") continue;
    const text = (l.text ?? "").replace(/\[Language:[^\]]*\]/g, "").trim();
    if (!text) continue;
    const speaker = l.sender === "assistant" ? "agent" : l.sender === "user" ? "user" : null;
    if (!speaker) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === speaker && last.text === text) continue; // duplicate chunk
    out.push({ speaker, text });
  }
  return out;
}

router.post("/calls/:id/sync", async (c) => {
  const db = await getDb();
  const userId = uid(c);
  const callId = c.req.param("id");
  const call = (
    await db.execute({
      sql: `SELECT cl.id, cl.lead_id, cl.started_at, cl.created_at, cl.transcript, cl.to_number, cl.from_number, l.phone AS lead_phone
            FROM call_logs cl JOIN leads l ON l.id = cl.lead_id WHERE cl.id = ? AND l.user_id = ?`,
      args: [callId, userId],
    })
  ).rows[0] as unknown as Row | undefined;
  if (!call) return c.json({ error: "Call not found" }, 404);
  if (!process.env.PLIVO_AUTH_ID || !process.env.PLIVO_AUTH_TOKEN) return c.json({ ok: false, message: "Plivo credentials are not configured." });

  const started = new Date(String(call.started_at ?? call.created_at)).getTime();
  const flows = ((await plivoGet("/AgentFlow/?limit=20"))?.objects ?? []) as { agent_uuid: string; name: string; flow_type: string }[];
  const wanted = flows.filter((f) => /gradlead|^lead$/i.test(f.name) && (f.flow_type === "api_request" || f.flow_type === "incoming_call"));

  for (const flow of wanted) {
    const runs = ((await plivoGet(`/AgentFlow/${flow.agent_uuid}/Run/?limit=10`))?.objects ?? []) as { run_uuid: string; started_at: string; duration?: number }[];
    for (const r of runs) {
      const rs = new Date(r.started_at.replace(" ", "T")).getTime();
      if (Math.abs(rs - started) > 4 * 60000) continue;
      const detail = ((await plivoGet(`/AgentFlow/${flow.agent_uuid}/Run/${r.run_uuid}/`)) ?? {}) as { logs?: PlivoLog[]; duration?: number; ended_at?: string };
      const logs = detail.logs ?? [];
      const start = logs.find((l) => l.event_name === "NODE_EXECUTED" && l.current_node_type === "start");
      const cfg = (start?.node_config ?? {}) as Record<string, unknown>;
      const callInfo = (cfg.call ?? {}) as Record<string, unknown>;
      const party = cfg["http.params.phone_number"] ?? callInfo.from;
      if (!sameNumber(party, call.lead_phone)) continue;
      const transcript = buildTranscript(logs);
      if (!transcript.length) return c.json({ ok: false, message: "That call has no spoken transcript." });
      const dur = Math.round(Number(detail.duration ?? r.duration ?? 0));
      await db.execute({
        sql: "UPDATE call_logs SET transcript = ?, duration_sec = CASE WHEN ? > 0 THEN ? ELSE duration_sec END, ended_at = COALESCE(ended_at, ?), status = CASE WHEN status = 'in_progress' THEN 'completed' ELSE status END WHERE id = ?",
        args: [JSON.stringify(transcript), dur, dur, detail.ended_at ? new Date(detail.ended_at.replace(" ", "T")).toISOString() : null, callId],
      });
      return c.json({ ok: true, turns: transcript.length, duration_sec: dur });
    }
  }
  return c.json({ ok: false, message: "No matching Plivo call was found (it may still be in progress)." });
});

export default router;
