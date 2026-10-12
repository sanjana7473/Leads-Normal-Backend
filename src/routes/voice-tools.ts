import { Hono } from "hono";
import { z } from "zod";
import type { Client } from "@libsql/client";
import { getDb } from "../db";
import { authenticateApiKey, type ApiKeyContext } from "../middleware/api-key";
import { parseRequirements, serializeRequirements, formatRequirements, normalizeLeadRequirements } from "../lib/lead-requirements";
import { phoneMatches } from "../lib/whatsapp";
import { buildAgentBrief } from "../lib/plivo-agentflow";
import { getKnowledgeContext } from "../lib/knowledge";
import { insertEvent } from "../lib/events";
import { parseWhen, parseMoney, formatIst, type WhenError } from "../lib/when-parser";
import { LEAD_STATUSES, computeLeadScore } from "./leads";

// Tools the Plivo Agentflow AI voice agent calls *during* a call (`/api/v1/voice/*`).
//
// Design rules, because the caller on the other end is an LLM, not a program:
//   * The lead is identified by the caller's `phone` (the flow always has it), so
//     the agent never has to remember or pass an internal id.
//   * Times are sent as the caller's own words ("after 40 minutes", "tomorrow
//     5 pm") and resolved here, in IST — the LLM does no date arithmetic.
//   * Problems the agent can recover from ("what time?") come back as HTTP 200
//     with `ok: false` and a plain-language `message`; only bad auth is a 401.
//   * Every write is idempotent enough to survive the agent calling a tool twice.

const router = new Hono<{ Variables: { api: ApiKeyContext } }>();

router.use("/*", async (c, next) => {
  const api = await authenticateApiKey(c);
  if (!api) {
    return c.json({ ok: false, error: "Unauthorized", message: "Provide a valid API key via X-API-Key or Authorization: Bearer." }, 401);
  }
  c.set("api", api);
  await next();
});

type Row = Record<string, unknown>;

const MIN_PHONE_DIGITS = 7;
const MAX_CALLBACK_DAYS = 60;

const fail = (message: string, extra: Row = {}) => ({ ok: false, message, ...extra });

const WHEN_HELP: Record<WhenError, string> = {
  empty: "No time was given. Ask the caller when they would like it.",
  unparseable: "I couldn't understand that time. Ask the caller to say it again, for example 'tomorrow at 5 pm' or 'after 30 minutes'.",
  time_missing: "The caller gave a day but no time. Ask what time suits them.",
  in_past: "That time has already passed. Ask the caller for a time in the future.",
};

// ---- helpers --------------------------------------------------------------

// Values the flow can send when the AI had nothing to report: blanks, unfilled
// "{{placeholders}}", and the words an extractor uses for "no answer".
const EMPTY_WORDS = /^(null|undefined|none|nil|n\/a|na|unknown|not (?:mentioned|provided|specified|stated|given|available|applicable|discussed)|no (?:answer|information|data)|-+)$/i;
function isBlankValue(t: string): boolean {
  return !t || /\{\{.*\}\}/.test(t) || EMPTY_WORDS.test(t);
}

// Tolerant string: the flow templates values into JSON, so a field the agent left
// blank can arrive as "" or as an unfilled "{{placeholder}}" — treat those as absent
// rather than saving template text as caller data.
const looseString = z.preprocess((v) => {
  if (v == null) return undefined;
  const t = (typeof v === "string" ? v : String(v)).trim();
  return isBlankValue(t) ? undefined : t;
}, z.string().optional());

const idSchema = z.object({
  phone: looseString,
  lead_id: looseString,
  call_uuid: looseString,
});

function digitsOf(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** A lead created from a bare caller ID is named after the number until the caller says their name. */
function nameKnown(lead: Row): boolean {
  const name = String(lead.name ?? "").trim();
  return name.length > 0 && /[a-zऀ-ॿঀ-৿]/i.test(name);
}

async function findByPhone(db: Client, userId: number, phone: string): Promise<Row | undefined> {
  const tail = digitsOf(phone).slice(-7);
  const rows = (
    await db.execute({
      sql: `SELECT * FROM leads WHERE user_id = ? AND phone IS NOT NULL AND phone != ''
            AND replace(replace(replace(replace(replace(phone,' ',''),'-',''),'+',''),'(',''),')','') LIKE ?
            ORDER BY COALESCE(last_activity, created_at) DESC`,
      args: [userId, `%${tail}`],
    })
  ).rows as unknown as Row[];
  return rows.find((r) => phoneMatches(String(r.phone), phone));
}

async function resolveLead(db: Client, userId: number, ids: { phone?: string; lead_id?: string }): Promise<Row | undefined> {
  if (ids.lead_id) {
    const r = (
      await db.execute({
        sql: "SELECT * FROM leads WHERE user_id = ? AND (id = ? OR substr(id, 1, 8) = ?) LIMIT 1",
        args: [userId, ids.lead_id, ids.lead_id],
      })
    ).rows[0] as unknown as Row | undefined;
    if (r) return r;
  }
  if (ids.phone && digitsOf(ids.phone).length >= MIN_PHONE_DIGITS) return findByPhone(db, userId, ids.phone);
  return undefined;
}

const noLead = () =>
  fail("I couldn't find which caller this is. Call the lookup step first, or continue the conversation without saving.");

async function callLogIdFor(db: Client, callUuid: string | undefined, leadId?: string): Promise<string | null> {
  if (callUuid) {
    const r = (await db.execute({ sql: "SELECT id FROM call_logs WHERE plivo_call_uuid = ? LIMIT 1", args: [callUuid] })).rows[0] as unknown as
      | { id: string }
      | undefined;
    if (r) return r.id;
  }
  // Outbound flows have no call UUID: the call in progress for this lead is the one.
  if (leadId) {
    const r = (
      await db.execute({
        sql: "SELECT id FROM call_logs WHERE lead_id = ? AND provider = 'plivo' AND status = 'in_progress' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
        args: [leadId, new Date(Date.now() - 45 * 60000).toISOString()],
      })
    ).rows[0] as unknown as { id: string } | undefined;
    return r?.id ?? null;
  }
  return null;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function appendNote(existing: unknown, note: string, now: Date): string {
  const stamp = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(now);
  const line = `[Call ${stamp}] ${note.trim()}`;
  const prev = typeof existing === "string" ? existing.trim() : "";
  return prev ? `${prev}\n${line}` : line;
}

/** Make a tool-supplied label/value pair a clean requirement. */
function mergeRequirement(list: { label: string; value: string }[], label: string, value: string) {
  const key = label.trim().toLowerCase();
  const idx = list.findIndex((r) => r.label.trim().toLowerCase() === key);
  if (idx >= 0) list[idx] = { label: list[idx].label, value };
  else list.push({ label: label.trim(), value });
}

// ---- POST /voice/lookup ---------------------------------------------------
// Called first, as soon as the call connects. Finds the caller's lead (or
// creates one for an unknown number) and returns everything the agent needs to
// open the call: who they are, what they asked about last time, upcoming
// visits/callbacks, and the business knowledge base.
router.post("/lookup", async (c) => {
  const api = c.get("api");
  try {
    const body = idSchema.extend({ name: looseString, direction: looseString, include_knowledge: z.boolean().optional() }).parse(await c.req.json());
    const outbound = body.direction?.toLowerCase() === "outbound";
    const phone = body.phone ?? "";
    if (digitsOf(phone).length < MIN_PHONE_DIGITS) {
      return c.json(fail("The caller's number is missing or hidden. Ask for their phone number and continue.", { found: false, created: false }));
    }

    const db = await getDb();
    const now = new Date();
    const nowIso = now.toISOString();
    let lead = await findByPhone(db, api.userId, phone);
    const existed = Boolean(lead);

    if (lead) {
      await db.execute({ sql: "UPDATE leads SET last_activity = ? WHERE id = ? AND user_id = ?", args: [nowIso, String(lead.id), api.userId] });
    } else {
      const id = crypto.randomUUID();
      const name = body.name?.trim() || phone.trim();
      await db.execute({
        sql: `INSERT INTO leads (id, user_id, name, phone, source, status, score, last_activity, created_at)
              VALUES (?, ?, ?, ?, 'inbound-call', 'new', ?, ?, ?)`,
        args: [id, api.userId, name, phone.trim(), computeLeadScore({ name, phone, source: "inbound-call" }), nowIso, nowIso],
      });
      lead = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0] as unknown as Row;
    }
    const leadId = String(lead.id);

    // One call log per call. Inbound calls carry the Plivo call UUID; outbound flows
    // don't, so a lookup for the same lead and direction within 3 minutes is the same call.
    const direction = outbound ? "outbound" : "inbound";
    let callLogId = await callLogIdFor(db, body.call_uuid);
    if (!callLogId) {
      const reuse = (
        await db.execute({
          sql: `SELECT id FROM call_logs WHERE lead_id = ? AND direction = ? AND status = 'in_progress' AND provider = 'plivo'
                AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
          args: [leadId, direction, new Date(now.getTime() - 3 * 60000).toISOString()],
        })
      ).rows[0] as unknown as { id: string } | undefined;
      callLogId = reuse?.id ?? null;
    }
    if (!callLogId) {
      callLogId = crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO call_logs (id, lead_id, user_id, goal, status, provider, direction, plivo_call_uuid, from_number, to_number, started_at, created_at)
              VALUES (?, ?, ?, ?, 'in_progress', 'plivo', ?, ?, ?, ?, ?, ?)`,
        args: [callLogId, leadId, api.userId, outbound ? "AI outbound call" : "AI inbound call", direction, body.call_uuid ?? null,
               outbound ? process.env.PLIVO_NUMBER ?? null : phone.trim(), outbound ? phone.trim() : process.env.PLIVO_NUMBER ?? null, nowIso, nowIso],
      });
    }
    // Plivo retries a slow request, so don't log the same call twice within a minute.
    const recent = (
      await db.execute({
        sql: "SELECT 1 FROM events WHERE lead_id = ? AND action = ? AND created_at > ? LIMIT 1",
        args: [leadId, outbound ? "outbound-call" : "inbound-call", new Date(now.getTime() - 60000).toISOString()],
      })
    ).rows.length > 0;
    const logEvent = recent
      ? Promise.resolve()
      : insertEvent(db, {
          lead_id: leadId, channel: "call", type: "call", direction: outbound ? "outbound" : "inbound", handled_by: "ai",
          action: outbound ? "outbound-call" : "inbound-call",
          summary: outbound ? "Outbound AI call — answered" : existed ? "Inbound call — returning contact" : "Inbound call — new contact",
          metadata: { from: phone, identified: existed, call_uuid: body.call_uuid ?? null, call_log_id: callLogId },
        });

    // History the agent can refer to + the knowledge base: independent reads, run together.
    const [lastCallRes, visitsRes, callbacksRes, kb] = await Promise.all([
      db.execute({
        sql: `SELECT summary, outcome, created_at FROM call_logs
              WHERE lead_id = ? AND summary IS NOT NULL AND summary != '' AND (id != ? OR ? IS NULL)
              ORDER BY created_at DESC LIMIT 1`,
        args: [leadId, callLogId, callLogId],
      }),
      db.execute({
        sql: `SELECT id, title, project, location, scheduled_at FROM appointments
              WHERE lead_id = ? AND status = 'confirmed' AND scheduled_at >= ? ORDER BY scheduled_at ASC LIMIT 3`,
        args: [leadId, nowIso],
      }),
      db.execute({
        sql: `SELECT id, due_at, reason FROM callbacks WHERE lead_id = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 3`,
        args: [leadId],
      }),
      body.include_knowledge === false
        ? Promise.resolve("")
        : getKnowledgeContext(db, api.userId, [String(lead.interest ?? ""), String(lead.category ?? "")].filter(Boolean).join(" ")),
      logEvent,
    ]);
    const lastCall = lastCallRes.rows[0] as unknown as { summary: string; outcome: string | null; created_at: string } | undefined;
    const visits = visitsRes.rows as unknown as { title: string; project: string | null; location: string | null; scheduled_at: string }[];
    const callbacks = callbacksRes.rows as unknown as { due_at: string; reason: string | null }[];

    const normalized = normalizeLeadRequirements(lead) as Row & { requirements: { label: string; value: string }[] };
    const known = nameKnown(lead);
    const interest = [lead.interest, formatRequirements(normalized.requirements)].filter(Boolean).join(" — ");

    const lines: string[] = [
      `Current date and time: ${formatIst(now)}.`,
      existed && known
        ? `CALLER STATUS: Returning contact — ${lead.name}. Greet them by first name (${firstName(String(lead.name))}).`
        : `CALLER STATUS: ${existed ? "Known number but name not recorded" : "New caller"}. Their name is not known yet — ask for it politely early in the call and save it.`,
    ];
    if (existed && known && interest) {
      lines.push(`Last time they were interested in: ${interest}. Open by asking whether they are calling about that, or about something new.`);
    }
    if (lastCall) lines.push(`Summary of their previous call: ${lastCall.summary}`);
    if (visits.length) {
      lines.push(`Upcoming site visits: ${visits.map((v) => `${v.project ?? v.title}${v.location ? ` at ${v.location}` : ""} on ${formatIst(new Date(v.scheduled_at))}`).join("; ")}.`);
    }
    if (callbacks.length) {
      lines.push(`Promised callbacks: ${callbacks.map((cb) => `${formatIst(new Date(cb.due_at))}${cb.reason ? ` (${cb.reason})` : ""}`).join("; ")}.`);
    }

    const brief =
      buildAgentBrief(normalized as unknown as Parameters<typeof buildAgentBrief>[0], null, { inbound: !outbound }) +
      `\n\n${lines.join("\n")}` +
      (kb ? `\n\nBusiness knowledge base (answer questions about the business from this — do not invent facts):\n${kb}` : "");

    return c.json({
      ok: true,
      found: existed,
      created: !existed,
      lead_id: leadId,
      name: known ? String(lead.name) : "",
      name_known: known,
      is_returning: existed && known,
      last_interest: interest || "",
      now_ist: formatIst(now),
      call_log_id: callLogId,
      agent_brief: brief,
    }, existed ? 200 : 201);
  } catch (e) {
    return c.json(fail(`Lookup failed: ${(e as Error).message}`), 200);
  }
});

// ---- POST /voice/save-details --------------------------------------------
// One tool for everything the caller tells the agent about themselves or what
// they want. Send only the fields you learned; others are left untouched.
const saveSchema = idSchema.extend({
  name: looseString, email: looseString, city: looseString, region: looseString,
  interest: looseString, category: looseString, urgency: looseString,
  budget: looseString, budget_min: z.union([z.number(), z.string()]).optional(), budget_max: z.union([z.number(), z.string()]).optional(),
  note: looseString,
  requirement_label: looseString, requirement_value: looseString,
  requirements: z.array(z.object({ label: z.string().default(""), value: z.string().default("") })).max(50).optional(),
});

router.post("/save-details", async (c) => {
  const api = c.get("api");
  try {
    const d = saveSchema.parse(await c.req.json());
    const db = await getDb();
    const lead = await resolveLead(db, api.userId, d);
    if (!lead) return c.json(noLead());

    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const saved: string[] = [];
    const set = (col: string, v: string | number | null | undefined, label = col) => {
      if (v === undefined || v === null || v === "") return;
      sets.push(`${col} = ?`);
      vals.push(v);
      saved.push(label);
    };

    if (d.name && d.name.length >= 2 && !/^\+?\d[\d\s-]*$/.test(d.name)) set("name", d.name, "name");
    set("email", d.email?.toLowerCase());
    set("city", d.city);
    set("region", d.region);
    set("interest", d.interest);
    set("category", d.category);
    set("urgency", d.urgency);

    // Budget: explicit min/max, or free text such as "60 to 80 lakh" / "around 1.2 crore".
    let bMin = d.budget_min !== undefined ? parseMoney(d.budget_min) : null;
    let bMax = d.budget_max !== undefined ? parseMoney(d.budget_max) : null;
    if (d.budget) {
      const parts = d.budget.split(/\s*(?:to|-|–|—|se)\s*/i).filter(Boolean);
      const tail = d.budget.toLowerCase().match(/(crores?|cr|lakhs?|lacs?|lac|l|k)\b/)?.[1] ?? "";
      const nums = parts.map((p) => parseMoney(/[a-z]/i.test(p) ? p : `${p} ${tail}`)).filter((n): n is number => n != null);
      if (nums.length >= 2) { bMin = Math.min(nums[0], nums[1]); bMax = Math.max(nums[0], nums[1]); }
      else if (nums.length === 1) bMax = nums[0];
    }
    if (bMin != null) set("budget_min", bMin, "budget");
    if (bMax != null) set("budget_max", bMax, "budget");

    // Requirements: merge by label so repeating a detail updates it instead of duplicating.
    const reqs = parseRequirements(lead.requirements);
    let touchedReqs = false;
    if (d.requirement_label && d.requirement_value) { mergeRequirement(reqs, d.requirement_label, d.requirement_value); touchedReqs = true; saved.push(d.requirement_label); }
    for (const r of d.requirements ?? []) {
      if (r.label.trim() && !isBlankValue(r.value.trim())) { mergeRequirement(reqs, r.label, r.value); touchedReqs = true; saved.push(r.label); }
    }
    if (touchedReqs) { sets.push("requirements = ?"); vals.push(serializeRequirements(reqs)); }

    const now = new Date();
    if (d.note) { sets.push("notes = ?"); vals.push(appendNote(lead.notes, d.note, now)); saved.push("note"); }

    if (!sets.length) return c.json({ ok: true, saved: [], message: "Nothing new to save." });

    const merged: Row = { ...lead };
    sets.forEach((s, i) => { merged[s.split(" ")[0]] = vals[i]; });
    sets.push("score = ?"); vals.push(computeLeadScore(merged));
    sets.push("last_activity = ?"); vals.push(now.toISOString());
    // A named, engaged lead is at least "contacted".
    if (lead.status === "new") { sets.push("status = ?"); vals.push("contacted"); }
    vals.push(String(lead.id), api.userId);
    await db.execute({ sql: `UPDATE leads SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, args: vals });

    await insertEvent(db, {
      lead_id: String(lead.id), channel: "call", type: "call", direction: "inbound", handled_by: "ai",
      action: "details-saved", summary: `Caller details saved: ${[...new Set(saved)].join(", ")}`,
      metadata: { call_log_id: await callLogIdFor(db, d.call_uuid, String(lead.id)) },
    });

    const fresh = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [String(lead.id)] })).rows[0] as unknown as Row;
    return c.json({
      ok: true,
      saved: [...new Set(saved)],
      name: String(fresh.name),
      message: `Saved: ${[...new Set(saved)].join(", ")}.`,
    });
  } catch (e) {
    return c.json(fail(`Could not save details: ${(e as Error).message}`));
  }
});

// ---- POST /voice/site-visit ----------------------------------------------
const visitSchema = idSchema.extend({
  when: looseString, scheduled_at: looseString,
  project: looseString, location: looseString, notes: looseString,
});

router.post("/site-visit", async (c) => {
  const api = c.get("api");
  try {
    const d = visitSchema.parse(await c.req.json());
    const db = await getDb();
    const lead = await resolveLead(db, api.userId, d);
    if (!lead) return c.json(noLead());

    const parsed = parseWhen(d.when ?? d.scheduled_at ?? "");
    if (!parsed.ok) return c.json(fail(WHEN_HELP[parsed.error], { error: parsed.error }));
    const { at, spoken } = parsed.value;

    const leadId = String(lead.id);
    const project = d.project || String(lead.interest ?? "") || "Property";
    const title = `Site visit — ${project}`;

    // Same lead, within 30 minutes of an existing confirmed visit → update, don't duplicate.
    const dup = (
      await db.execute({
        sql: `SELECT id FROM appointments WHERE lead_id = ? AND status = 'confirmed'
              AND ABS(strftime('%s', scheduled_at) - strftime('%s', ?)) < 1800 LIMIT 1`,
        args: [leadId, at.toISOString()],
      })
    ).rows[0] as unknown as { id: string } | undefined;

    const callLogId = await callLogIdFor(db, d.call_uuid, String(lead.id));
    let appointmentId: string;
    if (dup) {
      appointmentId = dup.id;
      await db.execute({
        sql: "UPDATE appointments SET title = ?, scheduled_at = ?, project = ?, location = COALESCE(?, location), notes = COALESCE(?, notes) WHERE id = ?",
        args: [title, at.toISOString(), project, d.location ?? null, d.notes ?? null, dup.id],
      });
    } else {
      appointmentId = crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO appointments (id, lead_id, call_id, title, scheduled_at, duration_min, status, project, location, notes, source)
              VALUES (?, ?, ?, ?, ?, 60, 'confirmed', ?, ?, ?, 'voice-agent')`,
        args: [appointmentId, leadId, callLogId, title, at.toISOString(), project, d.location ?? null, d.notes ?? null],
      });
    }

    const nowIso = new Date().toISOString();
    if (["new", "contacted", "qualified"].includes(String(lead.status))) {
      await db.execute({ sql: "UPDATE leads SET status = 'meeting', last_activity = ? WHERE id = ? AND user_id = ?", args: [nowIso, leadId, api.userId] });
    } else {
      await db.execute({ sql: "UPDATE leads SET last_activity = ? WHERE id = ? AND user_id = ?", args: [nowIso, leadId, api.userId] });
    }
    await insertEvent(db, {
      lead_id: leadId, channel: "call", type: "call", direction: "inbound", handled_by: "ai",
      action: "site-visit-booked",
      summary: `Site visit booked: ${project} — ${spoken}`,
      metadata: { appointment_id: appointmentId, scheduled_at: at.toISOString(), call_log_id: callLogId },
    });

    return c.json({
      ok: true,
      appointment_id: appointmentId,
      scheduled_at: at.toISOString(),
      when_spoken: spoken,
      message: `Site visit for ${project} is booked for ${spoken}. Confirm this date and time back to the caller. Do not promise anything beyond this booking.`,
    });
  } catch (e) {
    return c.json(fail(`Could not book the visit: ${(e as Error).message}`));
  }
});

// ---- POST /voice/callback -------------------------------------------------
// "Call me after 30 minutes / tomorrow evening." The scheduler places the call.
const callbackSchema = idSchema.extend({ when: looseString, reason: looseString });

router.post("/callback", async (c) => {
  const api = c.get("api");
  try {
    const d = callbackSchema.parse(await c.req.json());
    const db = await getDb();
    const lead = await resolveLead(db, api.userId, d);
    if (!lead) return c.json(noLead());

    // A day without a time ("call me tomorrow") defaults to 10 AM, and the agent is told to confirm it.
    const parsed = parseWhen(d.when ?? "", { defaultHour: 10 });
    if (!parsed.ok) return c.json(fail(WHEN_HELP[parsed.error], { error: parsed.error }));
    const { at, spoken, timeAssumed } = parsed.value;

    const now = new Date();
    // Never schedule in the immediate past/now: give the scheduler at least a minute.
    const due = at.getTime() < now.getTime() + 60000 ? new Date(now.getTime() + 60000) : at;
    if (due.getTime() - now.getTime() > MAX_CALLBACK_DAYS * 86400000) {
      return c.json(fail(`That is more than ${MAX_CALLBACK_DAYS} days away. Ask the caller for a nearer date.`, { error: "too_far" }));
    }

    const leadId = String(lead.id);
    const callLogId = await callLogIdFor(db, d.call_uuid, String(lead.id));

    // An existing pending callback within 10 minutes of this one is the same promise — move it.
    const dup = (
      await db.execute({
        sql: `SELECT id FROM callbacks WHERE lead_id = ? AND status = 'pending'
              AND ABS(strftime('%s', due_at) - strftime('%s', ?)) < 600 LIMIT 1`,
        args: [leadId, due.toISOString()],
      })
    ).rows[0] as unknown as { id: string } | undefined;

    let callbackId: string;
    if (dup) {
      callbackId = dup.id;
      await db.execute({ sql: "UPDATE callbacks SET due_at = ?, reason = COALESCE(?, reason) WHERE id = ?", args: [due.toISOString(), d.reason ?? null, dup.id] });
    } else {
      callbackId = crypto.randomUUID();
      await db.execute({
        sql: "INSERT INTO callbacks (id, user_id, lead_id, due_at, reason, status, attempts, source_call_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
        args: [callbackId, api.userId, leadId, due.toISOString(), d.reason ?? null, callLogId, now.toISOString()],
      });
    }

    await db.execute({
      sql: "UPDATE leads SET last_activity = ?, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END WHERE id = ? AND user_id = ?",
      args: [now.toISOString(), leadId, api.userId],
    });
    const dueSpoken = formatIst(due);
    await insertEvent(db, {
      lead_id: leadId, channel: "call", type: "call", direction: "inbound", handled_by: "ai",
      action: "callback-scheduled",
      summary: `Callback requested for ${dueSpoken}${d.reason ? ` — ${d.reason}` : ""}`,
      metadata: { callback_id: callbackId, due_at: due.toISOString(), call_log_id: callLogId },
    });

    return c.json({
      ok: true,
      callback_id: callbackId,
      due_at: due.toISOString(),
      when_spoken: dueSpoken,
      time_assumed: timeAssumed,
      message: timeAssumed
        ? `Callback noted for ${dueSpoken}. The caller did not give an exact time, so confirm: "Is ${dueSpoken.split(" at ")[1]} okay?" and call this tool again with the exact time if they want a different one.`
        : `Callback is scheduled for ${dueSpoken}. Confirm this time back to the caller.`,
    });
  } catch (e) {
    return c.json(fail(`Could not schedule the callback: ${(e as Error).message}`));
  }
});

// ---- POST /voice/status ---------------------------------------------------
// Move the lead along the pipeline: qualified (wants to proceed), proposal,
// closed, or lost (not interested / do not contact).
const statusSchema = idSchema.extend({ status: looseString, reason: looseString });

router.post("/status", async (c) => {
  const api = c.get("api");
  try {
    const d = statusSchema.parse(await c.req.json());
    const wanted = (d.status ?? "").toLowerCase() as (typeof LEAD_STATUSES)[number];
    if (!LEAD_STATUSES.includes(wanted)) return c.json({ ok: true, changed: false, message: "No status change." });
    const db = await getDb();
    const lead = await resolveLead(db, api.userId, d);
    if (!lead) return c.json(noLead());
    const now = new Date();
    const notes = d.reason ? appendNote(lead.notes, `Status → ${wanted}: ${d.reason}`, now) : (lead.notes as string | null);
    await db.execute({
      sql: "UPDATE leads SET status = ?, notes = ?, last_activity = ? WHERE id = ? AND user_id = ?",
      args: [wanted, notes ?? null, now.toISOString(), String(lead.id), api.userId],
    });
    // A lost / do-not-contact lead must never get an automatic callback.
    if (wanted === "lost") {
      await db.execute({ sql: "UPDATE callbacks SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'", args: [String(lead.id)] });
    }
    await insertEvent(db, {
      lead_id: String(lead.id), channel: "call", type: "call", direction: "inbound", handled_by: "ai",
      action: "status-changed",
      summary: `Lead marked ${wanted}${d.reason ? ` — ${d.reason}` : ""}`,
      metadata: { call_log_id: await callLogIdFor(db, d.call_uuid, String(lead.id)) },
    });
    return c.json({ ok: true, changed: true, status: wanted, message: `Lead marked as ${wanted}.` });
  } catch (e) {
    return c.json(fail(`Could not update the status: ${(e as Error).message}`));
  }
});

// ---- POST /voice/call-log -------------------------------------------------
// Final step of a call: close the call log with the summary and outcome.
const callLogSchema = idSchema.extend({
  call_log_id: looseString, summary: looseString, outcome: looseString, status: looseString,
});

router.post("/call-log", async (c) => {
  const api = c.get("api");
  try {
    const d = callLogSchema.parse(await c.req.json());
    const db = await getDb();
    const lead = await resolveLead(db, api.userId, d);
    if (!lead) return c.json(noLead());
    const row = (
      d.call_log_id
        ? await db.execute({ sql: "SELECT id, started_at FROM call_logs WHERE id = ? AND lead_id = ?", args: [d.call_log_id, String(lead.id)] })
        : await db.execute({ sql: "SELECT id, started_at FROM call_logs WHERE lead_id = ? AND status = 'in_progress' AND provider = 'plivo' ORDER BY created_at DESC LIMIT 1", args: [String(lead.id)] })
    ).rows[0] as unknown as { id: string; started_at: string | null } | undefined;
    if (!row) return c.json({ ok: true, changed: false, message: "No open call to close." });

    const end = new Date();
    const dur = row.started_at ? Math.max(0, Math.round((end.getTime() - new Date(row.started_at).getTime()) / 1000)) : 0;
    await db.execute({
      sql: "UPDATE call_logs SET status = 'completed', outcome = COALESCE(?, outcome), summary = COALESCE(?, summary), ended_at = ?, duration_sec = ? WHERE id = ?",
      args: [d.outcome ?? null, d.summary ?? null, end.toISOString(), dur, row.id],
    });
    await insertEvent(db, {
      lead_id: String(lead.id), channel: "call", type: "call", direction: "internal", handled_by: "ai",
      action: "call-completed", summary: d.summary ? `Call summary: ${d.summary}` : "AI call completed",
      metadata: { call_log_id: row.id },
    });
    return c.json({ ok: true, changed: true, call_log_id: row.id });
  } catch (e) {
    return c.json(fail(`Could not close the call: ${(e as Error).message}`));
  }
});

export default router;
