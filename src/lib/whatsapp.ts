// Phase 2 — WhatsApp provider bridge.
//
// This module talks to WhatsApp via the **RelayX** HTTP API contract
// (https://whatssapi.vercel.app/api-docs). RelayX exposes a simple REST
// surface (POST /api/sendText, PUT /api/sessions/{name}, etc.) authenticated
// by a single X-Api-Key header, and delivers inbound messages to our
// webhook route in a WhatsApp-Web-JS-style payload (remoteJid, fromMe,
// message.conversation, messageTimestamp, pushName).
//
// Env vars (all OPTIONAL — features stay inert until set):
//   RELAYX_API_KEY        the bridge API key (sent as X-Api-Key)
//   RELAYX_BASE_URL       base URL of the RelayX instance
//                          (e.g. https://whatssapi.vercel.app or http://localhost:3000)
//   RELAYX_SESSION        session name on the bridge (default: "default")
//   RELAYX_FROM_NUMBER    our sending number in E.164 (e.g. "15551234567")
//   RELAYX_WEBHOOK_SECRET optional shared secret matched on inbound POSTs
//                          (checked against x-api-key header or x-webhook-secret header)
//   RELAYX_WORKING_*      working-hours window for off-hours auto-acks

const DEFAULT_SESSION = "default";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function whatsappConfig() {
  const apiKey = env("RELAYX_API_KEY");
  return {
    enabled: Boolean(apiKey),
    base: (env("RELAYX_BASE_URL") || "").replace(/\/+$/, ""),
    apiKey,
    session: env("RELAYX_SESSION") || DEFAULT_SESSION,
    fromNumber: env("RELAYX_FROM_NUMBER"),
    webhookSecret: env("RELAYX_WEBHOOK_SECRET"),
  };
}

// ---------------------------------------------------------------------------
// Phone normalization & matching
// ---------------------------------------------------------------------------

/** Strip everything but digits. */
export function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[^\d]/g, "");
}

/**
 * Two phone numbers "match" if they share the same significant trailing digits.
 * We compare on the last 10 digits (or the full shorter value), which tolerates
 * differences in country code / formatting so a caller and a WhatsApp contact
 * with the same number resolve to one lead.
 */
export function phoneMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  const len = Math.min(10, Math.min(na.length, nb.length));
  if (len === 0) return false;
  return na.slice(-len) === nb.slice(-len);
}

// ---------------------------------------------------------------------------
// Webhook authorization + inbound normalization (RelayX / WhatsApp-Web-JS)
// ---------------------------------------------------------------------------

export interface AuthResult {
  ok: boolean;
}

/**
 * Accept inbound webhook POSTs when:
 *  - RELAYX_WEBHOOK_SECRET is NOT set  → allow all (no auth; useful with IP allow-list)
 *  - RELAYX_WEBHOOK_SECRET IS set      → require x-api-key or x-webhook-secret header to match
 */
export function authorizeWebhook(authHeader: string | null | undefined): AuthResult {
  const cfg = whatsappConfig();
  if (!cfg.webhookSecret) return { ok: true };
  if (!authHeader) return { ok: false };
  return { ok: authHeader === cfg.webhookSecret };
}

export interface NormalizedMessage {
  from: string;
  body: string;
  contactName: string | null;
  fromMe: boolean;
  timestamp: string | null;
  providerMessageId: string;
  messageType: string;
}

/**
 * Parse inbound webhook payload into normalized messages.
 *
 * Accepted shapes (in priority order):
 *
 *  1) Wrapped event:
 *     { event: "message", data: { key: { remoteJid, fromMe, id }, message: {...}, messageTimestamp, pushName } }
 *
 *  2) Raw WA-WEB-JS object:
 *     { messages: [ { key: { remoteJid, fromMe, id }, message: {...}, messageTimestamp, pushName } ] }
 *
 *  3) Meta-style (still handled for safety):
 *     { object: "whatsapp_business_account", entry: [ { changes: [ { value: { messages: [ { from, id, timestamp, type, text: { body } } ] } } ] } ] }
 *
 *  4) Flat:
 *     { from, body, fromMe, timestamp, id }
 */
export function normalizeInbound(body: unknown): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const b = (body as Record<string, unknown>) ?? {};

  // --- 1) Wrapped event { event, data } --------------------------------------
  if ((b.event as string) === "message" && b.data) {
    const m = fromWaWebJs(b.data as Record<string, unknown>);
    if (m) out.push(m);
    return out;
  }

  // --- 2) Raw WA-WEB-JS array { messages: [...] } ---------------------------
  if (Array.isArray(b.messages)) {
    for (const raw of b.messages) {
      const m = fromWaWebJs(raw as Record<string, unknown>);
      if (m) out.push(m);
    }
    if (out.length) return out;
  }

  // --- 3) Meta-style { object, entry } ---------------------------------------
  if ((b.object as string) === "whatsapp_business_account") {
    const entries = Array.isArray(b.entry) ? b.entry : [];
    for (const entry of entries) {
      const changes = (entry as Record<string, unknown>)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const ch of changes) {
        const msgs = ((ch as Record<string, unknown>)?.value as Record<string, unknown>)?.messages;
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
          const n = fromMeta(m as Record<string, unknown>);
          if (n) out.push(n);
        }
      }
    }
    if (out.length) return out;
  }

  // --- 4) Flat { from, body, ... } ------------------------------------------
  if (typeof b.from === "string") {
    out.push({
      from: b.from,
      body: typeof b.body === "string" ? b.body : "",
      contactName: typeof b.pushName === "string" ? b.pushName : typeof b.contactName === "string" ? b.contactName : null,
      fromMe: Boolean((b as Record<string, unknown>).fromMe),
      timestamp: typeof (b as Record<string, unknown>).timestamp === "number" ? new Date(((b as Record<string, unknown>).timestamp as number) * 1000).toISOString() : null,
      providerMessageId: String((b as Record<string, unknown>).id ?? (b as Record<string, unknown>).providerMessageId ?? `${b.from}-${Date.now()}`),
      messageType: typeof (b as Record<string, unknown>).messageType === "string" ? ((b as Record<string, unknown>).messageType as string) : "text",
    });
    return out;
  }

  return out;
}

function fromWaWebJs(m: Record<string, unknown>): NormalizedMessage | null {
  const key = (m?.key as Record<string, unknown>) ?? m;
  const remoteJid: string | undefined = typeof key?.remoteJid === "string" ? (key.remoteJid as string) : typeof key?.jid === "string" ? (key.jid as string) : undefined;
  if (!remoteJid) return null;

  const phone = remoteJid.split("@")[0]?.trim() ?? remoteJid;
  const fromMe = Boolean(key?.fromMe);
  const msg = (m?.message as Record<string, unknown>) ?? {};

  let text = "";
  const conv = msg.conversation;
  if (typeof conv === "string") text = conv as string;
  else {
    const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
    if (typeof ext?.text === "string") text = ext.text as string;
    else {
      const txt = msg.text as Record<string, unknown> | undefined;
      if (typeof txt?.body === "string") text = txt.body as string;
      else {
        const img = msg.imageMessage as Record<string, unknown> | undefined;
        if (typeof img?.caption === "string") text = `[image] ${img.caption as string}`;
        else {
          const vid = msg.videoMessage as Record<string, unknown> | undefined;
          if (typeof vid?.caption === "string") text = `[video] ${vid.caption as string}`;
          else if (msg.audioMessage && typeof msg.audioMessage === "object") text = "[audio]";
          else if (msg.documentMessage && typeof msg.documentMessage === "object") text = "[document]";
          else if (msg.stickerMessage && typeof msg.stickerMessage === "object") text = "[sticker]";
          else if (msg.locationMessage && typeof msg.locationMessage === "object") text = "[location]";
        }
      }
    }
  }

  const tsNum = typeof m?.messageTimestamp === "number" ? (m.messageTimestamp as number) : typeof m?.timestamp === "number" ? (m.timestamp as number) : NaN;

  return {
    from: phone,
    body: text,
    contactName: typeof m?.pushName === "string" ? (m.pushName as string) : null,
    fromMe,
    timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : null,
    providerMessageId: String(key?.id ?? m?.id ?? `${phone}-${Date.now()}`),
    messageType: guessMessageType(msg),
  };
}

function fromMeta(m: Record<string, unknown>): NormalizedMessage | null {
  if (typeof m?.from !== "string") return null;
  const tsNum = typeof m?.timestamp === "number" ? (m.timestamp as number) : NaN;
  let text = "";
  const txt2 = m.text as Record<string, unknown> | undefined;
  if (typeof txt2?.body === "string") text = txt2.body as string;
  else if ((m?.type as string) === "image") text = "[image]";
  else if ((m?.type as string) === "audio") text = "[audio]";
  else if ((m?.type as string) === "document") text = "[document]";
  else if ((m?.type as string) === "sticker") text = "[sticker]";
  else if ((m?.type as string) === "location") text = "[location]";
  else if ((m?.type as string) === "contacts") text = "[contact]";
  else text = "";

  return {
    from: m.from as string,
    body: text,
    contactName: typeof m?.pushName === "string" ? (m.pushName as string) : null,
    fromMe: false,
    timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : null,
    providerMessageId: String(m?.id ?? `${m.from}-${Date.now()}`),
    messageType: typeof m?.type === "string" ? (m.type as string) : "text",
  };
}

function guessMessageType(msg: Record<string, unknown>): string {
  if (msg.conversation) return "text";
  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
  if (typeof ext?.text === "string") return "text";
  const txt = msg.text as Record<string, unknown> | undefined;
  if (typeof txt?.body === "string") return "text";
  if (msg.imageMessage) return "image";
  if (msg.videoMessage) return "video";
  if (msg.audioMessage) return "audio";
  if (msg.documentMessage) return "document";
  if (msg.stickerMessage) return "sticker";
  if (msg.locationMessage) return "location";
  if (msg.contactMessage) return "contact";
  return "text";
}

// ---------------------------------------------------------------------------
// Outbound send (RelayX)
// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  providerMessageId: string | null;
  error?: string;
}

/**
 * Send a text message to `to` (E.164) via RelayX.
 * Contract: POST {base}/api/sendText with X-Api-Key header and body
 * { session, chatId, text }.
 * chatId format: {phone}@c.us (country code without +).
 */
export async function sendText(to: string, text: string): Promise<SendResult> {
  const cfg = whatsappConfig();
  if (!cfg.enabled) return { ok: false, providerMessageId: null, error: "WhatsApp provider is not configured (RELAYX_API_KEY)" };
  if (!cfg.base) return { ok: false, providerMessageId: null, error: "RELAYX_BASE_URL is not set" };

  // RelayX expects chatId in WhatsApp-Web-JS format: phone@c.us
  const chatId = `${normalizePhone(to)}@c.us`;
  const url = `${cfg.base}/api/sendText`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey,
      },
      body: JSON.stringify({
        session: cfg.session,
        chatId,
        text,
      }),
    });
  } catch (e) {
    return { ok: false, providerMessageId: null, error: `WhatsApp provider unreachable: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, providerMessageId: null, error: `WhatsApp send failed (${res.status}): ${detail.slice(0, 500)}` };
  }

  const json = (await res.json().catch(() => ({}))) as any;
  // RelayX may return { success: true } or { message: { id: "..." } } — handle both.
  const providerMessageId =
    (json?.message?.id as string | undefined) ??
    (json?.messages?.[0]?.id as string | undefined) ??
    (json?.id as string | undefined) ??
    null;

  return { ok: true, providerMessageId };
}

/**
 * Send a media file (attachment) to `to` (E.164) via RelayX.
 * Contract: POST {base}/api/sendMedia with X-Api-Key header and body
 * { session, chatId, base64, mimetype, filename, caption } — the same shape
 * the common whatsapp-web.js REST wrappers accept. Not every RelayX instance
 * exposes this endpoint, so callers treat a failure as non-fatal (text still
 * goes out; the attachment error is surfaced as a warning).
 */
export async function sendMedia(
  to: string,
  file: { base64: string; mimetype: string; filename: string; caption?: string }
): Promise<SendResult> {
  const cfg = whatsappConfig();
  if (!cfg.enabled) return { ok: false, providerMessageId: null, error: "WhatsApp provider is not configured (RELAYX_API_KEY)" };
  if (!cfg.base) return { ok: false, providerMessageId: null, error: "RELAYX_BASE_URL is not set" };

  const chatId = `${normalizePhone(to)}@c.us`;
  const url = `${cfg.base}/api/sendMedia`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey,
      },
      body: JSON.stringify({
        session: cfg.session,
        chatId,
        base64: file.base64,
        mimetype: file.mimetype,
        filename: file.filename,
        ...(file.caption ? { caption: file.caption } : {}),
      }),
    });
  } catch (e) {
    return { ok: false, providerMessageId: null, error: `WhatsApp provider unreachable: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, providerMessageId: null, error: `Media send failed (${res.status}): ${detail.slice(0, 300)}` };
  }

  const json = (await res.json().catch(() => ({}))) as any;
  const providerMessageId =
    (json?.message?.id as string | undefined) ??
    (json?.messages?.[0]?.id as string | undefined) ??
    (json?.id as string | undefined) ??
    null;
  return { ok: true, providerMessageId };
}

// ---------------------------------------------------------------------------
// Working hours & auto-acknowledgement
// ---------------------------------------------------------------------------

export function workingHoursConfig() {
  return {
    start: env("RELAYX_WORKING_HOURS_START") || "09:00", // 24h "HH:MM"
    end: env("RELAYX_WORKING_HOURS_END") || "18:00",
    tz: env("RELAYX_WORKING_TZ") || "America/New_York",
  };
}

/** True when `date` falls inside the configured working-hours window (local tz). */
export function isWithinWorkingHours(date: Date): boolean {
  const { start, end, tz } = workingHoursConfig();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + (sm || 0);
  const e = eh * 60 + (em || 0);
  return mins >= s && mins < e;
}

/** The canned off-hours acknowledgement we send when a lead messages us late. */
export function autoAckText(): string {
  return "Thanks for reaching out — we got your message. Our team will get back to you shortly. 🙌";
}
