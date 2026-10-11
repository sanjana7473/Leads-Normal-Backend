// src/index.ts
import { serve } from "@hono/node-server";
import { Hono as Hono11 } from "hono";
import { cors } from "hono/cors";

// src/routes/auth.ts
import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { verify as argon2Verify } from "@node-rs/argon2";

// src/db.ts
import { createClient } from "@libsql/client";

// src/lib/conversations.ts
var SLA_RESPONSE_HOURS = (() => {
  const v = Number(process.env.SLA_RESPONSE_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 4;
})();
function slaDueAfter(from) {
  const d = new Date(from);
  d.setTime(d.getTime() + SLA_RESPONSE_HOURS * 3600 * 1e3);
  return d.toISOString();
}
function computeSlaStatus(dueAt, now = /* @__PURE__ */ new Date()) {
  if (!dueAt) return "none";
  return new Date(dueAt).getTime() < now.getTime() ? "breached" : "within_sla";
}
async function getOrCreateConversation(db, leadId) {
  const id = `conv-${leadId}`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO conversations (id, lead_id, status, sla_status, created_at)
          VALUES (?, ?, 'new', 'none', ?)`,
    args: [id, leadId, (/* @__PURE__ */ new Date()).toISOString()]
  });
  const row = (await db.execute({ sql: "SELECT * FROM conversations WHERE id = ?", args: [id] })).rows[0];
  if (!row) throw new Error("Failed to load conversation");
  row.sla_due_at = row.sla_due_at ?? null;
  row.sla_status = computeSlaStatus(row.sla_due_at);
  return row;
}
async function touchConversation(db, ev) {
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const conv = (await db.execute({ sql: "SELECT status, sla_due_at FROM conversations WHERE id = ?", args: [ev.conversation_id] })).rows[0];
  if (!conv) return;
  let dueAt = conv.sla_due_at;
  let status = conv.status;
  const inbound = ev.direction === "inbound";
  const isReply = ev.direction === "outbound" || (ev.handledBy === "human" || ev.handledBy === "ai") && ev.direction !== "internal";
  if (inbound && ev.handledBy === "unhandled") {
    const due = slaDueAfter(ev.createdAt);
    if (!dueAt || new Date(due).getTime() < new Date(dueAt).getTime()) dueAt = due;
    if (status !== "resolved" && status !== "archived") status = "awaiting_reply";
  } else if (isReply) {
    dueAt = null;
    if (status === "awaiting_reply") status = "active";
  }
  await db.execute({
    sql: `UPDATE conversations SET
      first_event_at = COALESCE(first_event_at, ?),
      last_event_at = CASE WHEN last_event_at IS NULL OR ? > last_event_at THEN ? ELSE last_event_at END,
      sla_due_at = ?, sla_status = ?, status = ?, updated_at = ?
      WHERE id = ?`,
    args: [ev.createdAt, ev.createdAt, ev.createdAt, dueAt, computeSlaStatus(dueAt), status, nowIso, ev.conversation_id]
  });
}
async function setConversationStatus(db, conversationId, status) {
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: "UPDATE conversations SET status = ?, sla_due_at = NULL, sla_status = 'none', updated_at = ? WHERE id = ?",
    args: [status, nowIso, conversationId]
  });
}

// src/db.ts
var client;
var initPromise;
function getClient() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error(
        "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set. Add them to your Vercel project environment variables (and locally) to connect to the hosted Turso database."
      );
    }
    client = createClient({ url, authToken });
  }
  return client;
}
var TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    gmail_email TEXT,
    gmail_app_password TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    source TEXT,
    status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','meeting','proposal','closed','lost')),
    score INTEGER DEFAULT 0,
    value REAL,
    city TEXT,
    notes TEXT,
    last_activity TEXT,
    interest TEXT,
    category TEXT,
    budget_min REAL,
    budget_max REAL,
    region TEXT,
    urgency TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS email_messages (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    subject TEXT,
    body TEXT,
    tone TEXT,
    goal TEXT,
    status TEXT DEFAULT 'draft',
    sent_at TEXT,
    delivered_at TEXT,
    opened_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    body TEXT,
    status TEXT DEFAULT 'draft',
    sent_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    goal TEXT,
    voice TEXT,
    status TEXT DEFAULT 'pending',
    outcome TEXT,
    transcript TEXT,
    summary TEXT,
    duration_sec INTEGER DEFAULT 0,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    call_id TEXT,
    title TEXT,
    scheduled_at TEXT,
    duration_min INTEGER DEFAULT 30,
    status TEXT DEFAULT 'confirmed',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    citations TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','active','awaiting_reply','resolved','archived')),
    sla_due_at TEXT,
    sla_status TEXT NOT NULL DEFAULT 'none' CHECK(sla_status IN ('none','within_sla','breached')),
    first_event_at TEXT,
    last_event_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE (lead_id),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    lead_id TEXT,
    type TEXT,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'internal',
    content TEXT,
    handled_by TEXT NOT NULL DEFAULT 'unhandled',
    status TEXT,
    action TEXT NOT NULL,
    summary TEXT,
    source_ref TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events(channel, source_ref) WHERE source_ref IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)`,
  // ---- Per-user Knowledge Base --------------------------------------------
  // Each user has one published business profile that doubles as the grounding
  // source for their AI features. Strictly tenant-scoped (user_id).
  `CREATE TABLE IF NOT EXISTS knowledge_bases (
    id TEXT PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT UNIQUE,
    title TEXT,
    tagline TEXT,
    description TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    contact_website TEXT,
    contact_address TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
    published_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS kb_sections (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL,
    kind TEXT DEFAULT 'custom',
    title TEXT,
    body TEXT,
    position INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS kb_entries (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    tags TEXT,
    position INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS kb_sources (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'file' CHECK(type IN ('file','url')),
    name TEXT,
    status TEXT DEFAULT 'ready',
    fetched_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL,
    source_id TEXT,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    FOREIGN KEY (source_id) REFERENCES kb_sources(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS kb_crawl_jobs (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL,
    source_id TEXT,
    source_url TEXT NOT NULL,
    host TEXT,
    limit_pages INTEGER DEFAULT 100,
    max_depth INTEGER DEFAULT 3,
    include_paths TEXT,
    exclude_paths TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','done','failed','cancelled')),
    pages_found INTEGER DEFAULT 0,
    pages_done INTEGER DEFAULT 0,
    frontier TEXT,
    visited TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kb_sections ON kb_sections(kb_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kb_entries ON kb_entries(kb_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kb_sources ON kb_sources(kb_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kb_chunks ON kb_chunks(kb_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kb_crawl_jobs ON kb_crawl_jobs(kb_id)`
];
var EMAIL_MESSAGE_MIGRATIONS = [
  `ALTER TABLE email_messages ADD COLUMN direction TEXT DEFAULT 'outbound'`,
  `ALTER TABLE email_messages ADD COLUMN from_email TEXT`,
  `ALTER TABLE email_messages ADD COLUMN to_email TEXT`,
  // Column names kept from the original AgentMail integration (now Gmail
  // SMTP/IMAP, see lib/mailer.ts) to avoid a data migration — they hold the
  // provider message/thread id regardless of which mail provider wrote them.
  `ALTER TABLE email_messages ADD COLUMN agentmail_message_id TEXT`,
  `ALTER TABLE email_messages ADD COLUMN agentmail_thread_id TEXT`,
  `ALTER TABLE email_messages ADD COLUMN labels TEXT`
];
var WHATSAPP_MESSAGE_MIGRATIONS = [
  `ALTER TABLE whatsapp_messages ADD COLUMN direction TEXT DEFAULT 'outbound'`,
  `ALTER TABLE whatsapp_messages ADD COLUMN from_number TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN to_number TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN provider_message_id TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN acknowledged_at TEXT`
];
var ATTACHMENT_MIGRATIONS = [
  `ALTER TABLE email_messages ADD COLUMN attachments TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN attachments TEXT`
];
var USER_ACCESS_MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`
];
var TENANCY_MIGRATIONS = [
  `ALTER TABLE leads ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE chat_messages ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE users ADD COLUMN gmail_email TEXT`,
  `ALTER TABLE users ADD COLUMN gmail_app_password TEXT`
];
var CALL_LOG_MIGRATIONS = [
  `ALTER TABLE call_logs ADD COLUMN provider TEXT`,
  `ALTER TABLE call_logs ADD COLUMN phlo_id TEXT`,
  `ALTER TABLE call_logs ADD COLUMN prompt_used TEXT`,
  `ALTER TABLE call_logs ADD COLUMN from_number TEXT`,
  `ALTER TABLE call_logs ADD COLUMN to_number TEXT`,
  // Plivo returns a *static* flow UUID as phlo_id (verified: identical across
  // runs), so it cannot identify a single call. api_id is unique per run and
  // is the only reliable handle for matching Agentflow callbacks.
  `ALTER TABLE call_logs ADD COLUMN plivo_api_id TEXT`
];
var DEMO_USER_HASH = "$2b$10$/ixfDGIckZ5KISPFS5y7puGhS4MGJkUJHkrdgDMG.si2aBQtWHy2u";
async function initDb(c) {
  await c.batch(
    [
      ...TABLE_DDL,
      {
        sql: "INSERT OR IGNORE INTO users (id, name, email, password_hash) VALUES (1, ?, ?, ?)",
        args: ["Test User", "testuser@gmail.com", DEMO_USER_HASH]
      }
    ],
    "write"
  );
  for (const sql of [...EMAIL_MESSAGE_MIGRATIONS, ...WHATSAPP_MESSAGE_MIGRATIONS, ...ATTACHMENT_MIGRATIONS, ...USER_ACCESS_MIGRATIONS, ...TENANCY_MIGRATIONS, ...CALL_LOG_MIGRATIONS]) {
    try {
      await c.execute(sql);
    } catch {
    }
  }
  await c.execute(`UPDATE users SET is_admin = 1 WHERE id = 1`);
  await c.execute(`UPDATE leads SET user_id = 1 WHERE user_id IS NULL`);
  await c.execute(`UPDATE chat_messages SET user_id = 1 WHERE user_id IS NULL`);
  await c.execute(`
    INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at)
    SELECT 'evt-' || id, lead_id, 'email', COALESCE(status, 'sent'), subject, id, created_at
    FROM email_messages WHERE COALESCE(direction, 'outbound') = 'outbound'
  `);
  await c.execute(`
    INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at)
    SELECT 'evt-' || id, lead_id, 'whatsapp',
           CASE WHEN direction = 'inbound' THEN 'received' ELSE COALESCE(status, 'sent') END,
           body, id, created_at
    FROM whatsapp_messages
  `);
  await c.execute(`
    INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at)
    SELECT 'evt-' || id, lead_id, 'call', COALESCE(status, 'pending'), goal, id, created_at
    FROM call_logs
  `);
  await c.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_plivo_api ON call_logs(plivo_api_id) WHERE plivo_api_id IS NOT NULL`);
  await migrateLeadsToGenericPipeline(c);
  await migrateEventsToConversations(c);
  try {
    await c.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(chunk_id UNINDEXED, kb_id UNINDEXED, text)`);
  } catch {
  }
}
async function migrateLeadsToGenericPipeline(c) {
  const cols = (await c.execute(`SELECT name FROM pragma_table_info('leads')`)).rows.map(
    (r) => r.name
  );
  if (cols.includes("interest")) return;
  const has = (name) => cols.includes(name);
  const selectOr = (legacy) => has(legacy) ? legacy : "NULL";
  await c.batch(
    [
      `CREATE TABLE leads_generic (
        id TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        source TEXT,
        status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','meeting','proposal','closed','lost')),
        score INTEGER DEFAULT 0,
        value REAL,
        city TEXT,
        notes TEXT,
        last_activity TEXT,
        interest TEXT,
        category TEXT,
        budget_min REAL,
        budget_max REAL,
        region TEXT,
        urgency TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `INSERT INTO leads_generic (id, user_id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at, interest, category, budget_min, budget_max, region, urgency)
         SELECT id,
                ${has("user_id") ? "user_id" : "NULL"},
                name, email, phone, company, source,
                CASE WHEN status IN ('booked','viewing') THEN 'meeting' WHEN status = 'offer' THEN 'proposal' ELSE status END,
                score, value, city, notes, last_activity, created_at,
                ${selectOr("property_interest")},
                ${selectOr("property_type")},
                ${selectOr("budget_min")},
                ${selectOr("budget_max")},
                ${selectOr("area")},
                ${selectOr("urgency")}
         FROM leads`,
      `DROP TABLE leads`,
      `ALTER TABLE leads_generic RENAME TO leads`,
      `CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)`,
      `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)`
    ],
    "write"
  );
}
async function migrateEventsToConversations(c) {
  if (!await tableHasColumn(c, "events", "conversation_id")) {
    await c.batch(
      [
        `CREATE TABLE events_foundation (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          lead_id TEXT,
          type TEXT,
          channel TEXT NOT NULL,
          direction TEXT NOT NULL DEFAULT 'internal',
          content TEXT,
          handled_by TEXT NOT NULL DEFAULT 'unhandled',
          status TEXT,
          action TEXT NOT NULL,
          summary TEXT,
          source_ref TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        )`,
        `INSERT INTO events_foundation (id, lead_id, channel, action, summary, source_ref, metadata, created_at)
           SELECT id, lead_id, channel, action, summary, source_ref, metadata, created_at FROM events`,
        `DROP TABLE events`,
        `ALTER TABLE events_foundation RENAME TO events`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events(channel, source_ref) WHERE source_ref IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id)`,
        `CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)`
      ],
      "write"
    );
  }
  await c.batch(
    [
      `CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)`
    ],
    "write"
  );
  await c.execute(`
    INSERT OR IGNORE INTO conversations (id, lead_id, status, sla_status, created_at)
    SELECT 'conv-' || id, id, 'new', 'none', datetime('now') FROM leads
  `);
  await c.execute(`
    UPDATE events SET conversation_id = 'conv-' || lead_id
    WHERE conversation_id IS NULL AND lead_id IS NOT NULL
  `);
  await c.execute(`
    UPDATE events SET type = COALESCE(type, channel), content = COALESCE(content, summary)
    WHERE type IS NULL OR content IS NULL
  `);
  await c.execute(`
    UPDATE events SET
      direction = CASE
        WHEN COALESCE(action,'') IN ('received','inbound','auto-acknowledged') THEN 'inbound'
        WHEN channel = 'call' THEN 'outbound' ELSE 'outbound' END,
      handled_by = CASE WHEN channel = 'call' THEN 'ai'
        WHEN COALESCE(action,'') IN ('received','inbound','auto-acknowledged') THEN 'unhandled'
        ELSE 'human' END
    WHERE direction = 'internal' AND channel IN ('email','whatsapp','call') AND source_ref IS NOT NULL
  `);
  await c.execute(`
    UPDATE conversations SET
      first_event_at = (SELECT MIN(created_at) FROM events WHERE conversation_id = conversations.id),
      last_event_at  = (SELECT MAX(created_at) FROM events WHERE conversation_id = conversations.id)
  `);
  const rows = (await c.execute(`
    SELECT conversation_id, MIN(created_at) AS due0, MAX(created_at) AS last0
    FROM events
    WHERE direction = 'inbound' AND handled_by = 'unhandled' AND conversation_id IS NOT NULL
    GROUP BY conversation_id
  `)).rows;
  for (const r of rows) {
    const due = slaDueAfter(r.due0);
    await c.execute({
      sql: `UPDATE conversations SET sla_due_at = ?, sla_status = ?,
            status = CASE WHEN status IN ('new','active') THEN 'awaiting_reply' ELSE status END
            WHERE id = ? AND (sla_due_at IS NULL OR ? < sla_due_at)`,
      args: [due, computeSlaStatus(due), r.conversation_id, due]
    });
  }
}
async function tableHasColumn(c, table, column) {
  const r = await c.execute(`SELECT name FROM pragma_table_info('${table}') WHERE name = '${column}' LIMIT 1`);
  return r.rows.length > 0;
}
async function getDb() {
  const c = getClient();
  if (!initPromise) {
    initPromise = initDb(c).catch((err) => {
      initPromise = void 0;
      throw err;
    });
  }
  await initPromise;
  return c;
}
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/middleware/auth.ts
async function authenticate(c) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT u.id, u.name, u.email, u.is_admin, u.disabled FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    args: [token]
  });
  const row = result.rows[0];
  if (!row) return null;
  if (row.disabled) return null;
  return { id: row.id, name: row.name, email: row.email, is_admin: !!row.is_admin };
}
async function authenticateAdmin(c) {
  const user = await authenticate(c);
  if (!user || !user.is_admin) return null;
  return user;
}

// src/routes/auth.ts
var router = new Hono();
var registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6)
});
var loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
async function verifyPassword(db, password, storedHash, userId) {
  if (storedHash.startsWith("$argon2")) {
    const ok = await argon2Verify(storedHash, password);
    if (ok) {
      const newHash = await bcrypt.hash(password, 10);
      await db.execute({
        sql: "UPDATE users SET password_hash = ? WHERE id = ?",
        args: [newHash, userId]
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
    const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [data.email.toLowerCase().trim()] })).rows[0];
    if (existing) return c.json({ error: "Email already registered" }, 409);
    const hash = await bcrypt.hash(data.password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
      args: [data.name.trim() || null, data.email.toLowerCase().trim(), hash]
    });
    const userId = Number(result.lastInsertRowid);
    const token = generateToken();
    await db.execute({ sql: "INSERT INTO sessions (id, user_id) VALUES (?, ?)", args: [token, userId] });
    const user = (await db.execute({ sql: "SELECT id, name, email, is_admin FROM users WHERE id = ?", args: [userId] })).rows[0];
    return c.json({ token, user: { ...user, is_admin: !!user.is_admin } });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router.post("/login", async (c) => {
  try {
    const data = loginSchema.parse(await c.req.json());
    const db = await getDb();
    const user = (await db.execute({
      sql: "SELECT id, name, email, password_hash, is_admin, disabled FROM users WHERE email = ?",
      args: [data.email.toLowerCase().trim()]
    })).rows[0];
    if (!user) return c.json({ error: "Invalid email or password" }, 401);
    if (user.disabled) return c.json({ error: "This account has been disabled. Contact your administrator." }, 403);
    const valid = await verifyPassword(db, data.password, user.password_hash, user.id);
    if (!valid) return c.json({ error: "Invalid email or password" }, 401);
    const token = generateToken();
    await db.execute({ sql: "INSERT INTO sessions (id, user_id) VALUES (?, ?)", args: [token, user.id] });
    return c.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin } });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router.post("/logout", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const authHeader = c.req.header("Authorization");
  const token = authHeader.slice(7);
  await (await getDb()).execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [token] });
  return c.json({ success: true });
});
router.get("/me", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ user: null });
  return c.json({ user });
});
var auth_default = router;

// src/routes/leads.ts
import { Hono as Hono2 } from "hono";
import { z as z2 } from "zod";
var router2 = new Hono2();
router2.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({ sql: "SELECT * FROM leads WHERE user_id = ? ORDER BY created_at DESC", args: [user.id] })).rows;
  return c.json(rows);
});
var LEAD_STATUSES = ["new", "contacted", "qualified", "meeting", "proposal", "closed", "lost"];
var leadSchema = z2.object({
  name: z2.string(),
  email: z2.string().nullable().optional(),
  phone: z2.string().nullable().optional(),
  company: z2.string().nullable().optional(),
  source: z2.string().nullable().optional(),
  status: z2.enum(LEAD_STATUSES).optional(),
  score: z2.number().optional(),
  value: z2.number().nullable().optional(),
  city: z2.string().nullable().optional(),
  notes: z2.string().nullable().optional(),
  // Lead detail fields
  interest: z2.string().nullable().optional(),
  category: z2.string().nullable().optional(),
  budget_min: z2.number().nullable().optional(),
  budget_max: z2.number().nullable().optional(),
  region: z2.string().nullable().optional(),
  urgency: z2.string().nullable().optional()
});
var updateLeadSchema = z2.object({
  name: z2.string().optional(),
  email: z2.string().nullable().optional(),
  phone: z2.string().nullable().optional(),
  company: z2.string().nullable().optional(),
  source: z2.string().nullable().optional(),
  status: z2.enum(LEAD_STATUSES).optional(),
  score: z2.number().optional(),
  value: z2.number().nullable().optional(),
  city: z2.string().nullable().optional(),
  notes: z2.string().nullable().optional(),
  // Lead detail fields
  interest: z2.string().nullable().optional(),
  category: z2.string().nullable().optional(),
  budget_min: z2.number().nullable().optional(),
  budget_max: z2.number().nullable().optional(),
  region: z2.string().nullable().optional(),
  urgency: z2.string().nullable().optional()
});
var SCORE_FIELDS = [
  "email",
  "phone",
  "company",
  "city",
  "notes",
  "value",
  "interest",
  "category",
  "region",
  "urgency"
];
function computeLeadScore(r) {
  let present = 0;
  for (const f of SCORE_FIELDS) {
    const v = r[f];
    if (v !== void 0 && v !== null && String(v).trim() !== "") present++;
  }
  return Math.round(present / SCORE_FIELDS.length * 100);
}
router2.post("/bulk", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z2.array(leadSchema).parse(await c.req.json());
  const db = await getDb();
  const inserted = [];
  const statements = [];
  for (const r of data) {
    const id = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    statements.push({
      sql: "INSERT OR REPLACE INTO leads (id, user_id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at, interest, category, budget_min, budget_max, region, urgency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, user.id, r.name, r.email ?? null, r.phone ?? null, r.company ?? null, r.source ?? "import", r.status ?? "new", computeLeadScore(r), r.value ?? null, r.city ?? null, r.notes ?? null, now, now, r.interest ?? null, r.category ?? null, r.budget_min ?? null, r.budget_max ?? null, r.region ?? null, r.urgency ?? null]
    });
    inserted.push({ ...r, id, status: r.status ?? "new", score: computeLeadScore(r), last_activity: now, created_at: now });
  }
  if (statements.length) await db.batch(statements, "write");
  return c.json(inserted);
});
router2.post("/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id, status } = z2.object({ id: z2.string(), status: z2.enum(LEAD_STATUSES) }).parse(await c.req.json());
  await (await getDb()).execute({
    sql: "UPDATE leads SET status = ?, last_activity = ? WHERE id = ? AND user_id = ?",
    args: [status, (/* @__PURE__ */ new Date()).toISOString(), id, user.id]
  });
  return c.json({ success: true });
});
router2.get("/activity/counts", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM email_messages m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS emails,
      (SELECT COUNT(*) FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS whatsapps,
      (SELECT COUNT(*) FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS calls,
      (SELECT COUNT(*) FROM appointments m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS appts`,
    args: [user.id, user.id, user.id, user.id]
  })).rows;
  const row = rows[0];
  return c.json({ emails: row.emails, whatsapps: row.whatsapps, calls: row.calls, appts: row.appts });
});
router2.get("/activity/feed", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const rows = (await db.execute({
    sql: `SELECT e.id, e.type, e.channel, e.direction, e.action, e.summary, e.content, e.created_at
          FROM events e JOIN leads l ON l.id = e.lead_id
          WHERE e.channel IN ('email','whatsapp','call') AND l.user_id = ?
          ORDER BY e.created_at DESC LIMIT 20`,
    args: [user.id]
  })).rows;
  const items = rows.map((e) => {
    const dir = e.direction === "inbound" ? "inbound" : "outbound";
    const body = e.content ?? e.summary ?? "";
    return {
      id: e.id,
      type: e.type ?? e.channel,
      text: e.channel === "email" ? `${dir === "inbound" ? "Inbound" : "Sent"} email \u2014 ${e.action}: "${e.summary ?? ""}"` : e.channel === "whatsapp" ? `${dir === "inbound" ? "Inbound WhatsApp" : "Outbound WhatsApp"} \u2014 ${body.slice(0, 80)}` : `Call \u2014 ${e.action}${e.summary ? `: ${e.summary}` : ""}`,
      when: e.created_at
    };
  });
  return c.json(items.slice(0, 8));
});
router2.get("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const row = (await (await getDb()).execute({ sql: "SELECT * FROM leads WHERE id = ? AND user_id = ?", args: [c.req.param("id"), user.id] })).rows[0];
  if (!row) return c.json({ error: "Lead not found" }, 404);
  return c.json(row);
});
router2.put("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const data = updateLeadSchema.parse(await c.req.json());
  const db = await getDb();
  const existing = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] })).rows[0];
  if (!existing) return c.json({ error: "Lead not found" }, 404);
  const score = computeLeadScore({ ...existing, ...data });
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "score") continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push("score = ?");
  vals.push(score);
  sets.push("last_activity = ?");
  vals.push((/* @__PURE__ */ new Date()).toISOString());
  vals.push(id, user.id);
  await db.execute({ sql: `UPDATE leads SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, args: vals });
  const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0];
  return c.json(row);
});
router2.delete("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  await (await getDb()).execute({ sql: "DELETE FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] });
  return c.json({ success: true });
});
router2.post("/bulk-delete", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { ids } = z2.object({ ids: z2.array(z2.string()).min(1) }).parse(await c.req.json());
  const db = await getDb();
  const statements = ids.map((id) => ({ sql: "DELETE FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] }));
  await db.batch(statements, "write");
  return c.json({ success: true, deleted: ids.length });
});
var leads_default = router2;

// src/routes/messages.ts
import { Hono as Hono3 } from "hono";
import { z as z3 } from "zod";

// src/lib/mailer.ts
import nodemailer from "nodemailer";
function mailerConfig() {
  const user = process.env.GMAIL_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com"
  };
}
var transporters = /* @__PURE__ */ new Map();
function getTransporter(cfg) {
  let t = transporters.get(cfg.user);
  if (!t) {
    t = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: 465,
      secure: true,
      auth: { user: cfg.user, pass: cfg.appPassword }
    });
    transporters.set(cfg.user, t);
  }
  return t;
}
async function sendMessage(args, cfg = mailerConfig()) {
  const info = await getTransporter(cfg).sendMail({
    from: cfg.user,
    to: args.to,
    subject: args.subject,
    text: args.text,
    ...args.html ? { html: args.html } : {},
    ...args.attachments && args.attachments.length ? { attachments: args.attachments } : {}
  });
  return { message_id: info.messageId ?? null, thread_id: null };
}

// src/lib/plivo-agentflow.ts
function brief(value, max = 400) {
  const s = (value ?? "").trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}
function normalizePhone(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const base = trimmed.replace(/\s*(?:ext|ext\.|x|extension|#)\s*\d+\s*$/i, "").trim();
  const plus = base.startsWith("+") ? "+" : "";
  const digits = base.replace(/\D/g, "");
  if (!digits) return null;
  const e164 = `${plus}${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return e164;
}
function buildAgentBrief(lead, goal) {
  const budget = lead.budget_min != null && lead.budget_max != null ? `${lead.budget_min}\u2013${lead.budget_max}` : lead.budget_max != null ? `up to ${lead.budget_max}` : lead.budget_min != null ? `from ${lead.budget_min}` : null;
  const facts = [
    `Lead name: ${lead.name}`,
    lead.company ? `Company: ${lead.company}` : null,
    lead.city ? `Location: ${lead.city}` : null,
    lead.region ? `Region: ${lead.region}` : null,
    lead.interest ? `Requirement / interest: ${lead.interest}` : null,
    lead.category ? `Category: ${lead.category}` : null,
    budget ? `Budget: ${budget}` : null,
    lead.urgency ? `Urgency: ${lead.urgency}` : null,
    lead.value != null ? `Deal value: ${lead.value}` : null,
    `Pipeline status: ${lead.status}`,
    goal ? `Call goal: ${goal}` : null,
    lead.notes ? `Notes: ${brief(lead.notes, 800)}` : null
  ].filter(Boolean);
  return [
    "You are calling a sales lead on behalf of GradLeadAI. Use ONLY the details below when speaking to them.",
    "",
    ...facts,
    "",
    "Open by identifying yourself and referring to their stated requirement. Confirm the details, answer their questions, and aim to move them to the next step. If something is not in these details, say so and offer to follow up \u2014 do not invent facts, prices, or dates."
  ].join("\n");
}
async function triggerAgentflow(payload) {
  const url = process.env.PLIVO_AGENTFLOW_URL?.trim();
  if (!url) {
    throw new Error("AI voice agent is not configured \u2014 set PLIVO_AGENTFLOW_URL in the environment.");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Voice agent rejected the request (${res.status}): ${text.slice(0, 300)}`);
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
  }
  return {
    phlo_id: data.phlo_id ?? null,
    api_id: data.api_id ?? null,
    message: data.message ?? null
  };
}
function buildTriggerPayload(args) {
  const { leadId, callId, toNumber, leadName, brief: brief2, company, interest, goal } = args;
  return {
    // Destination — matches whichever name the flow's Screen Contact node uses.
    to: toNumber,
    to_number: toNumber,
    phone: toNumber,
    phone_number: toNumber,
    destination: toNumber,
    destination_number: toNumber,
    number: toNumber,
    lead_phone: toNumber,
    // Who we're calling.
    name: leadName,
    lead_name: leadName,
    contact_name: leadName,
    first_name: leadName.split(" ")[0],
    company,
    // What the agent should talk about.
    prompt: brief2,
    context: brief2,
    requirements: brief2,
    details: brief2,
    brief: brief2,
    system_prompt: brief2,
    instructions: brief2,
    notes: brief2,
    message: brief2,
    description: brief2,
    lead_context: brief2,
    conversation_brief: brief2,
    summary: brief2,
    // Goal + correlation ids so the flow can branch and we can match callbacks.
    goal: goal ?? null,
    call_goal: goal ?? null,
    objective: goal ?? null,
    interest,
    requirement: interest,
    // Correlation. `call_id` must be OUR call-log id, not the lead id, so a
    // callback matches exactly one row. Plivo's own phlo_id is flow-level and
    // identical for every run, so it cannot identify a single call.
    call_id: callId,
    reference_id: callId,
    call_uuid: callId,
    call_ref: callId,
    lead_id: leadId
  };
}

// src/lib/events.ts
async function insertEvent(db, e) {
  const id = crypto.randomUUID();
  const createdAt = e.created_at ?? (/* @__PURE__ */ new Date()).toISOString();
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
      e.metadata !== void 0 ? JSON.stringify(e.metadata) : null,
      createdAt,
      type,
      direction,
      content,
      handledBy
    ]
  });
  if (e.lead_id) {
    const conv = await getOrCreateConversation(db, e.lead_id);
    await touchConversation(db, {
      conversation_id: conv.id,
      createdAt,
      direction,
      handledBy
    });
  }
  return id;
}

// src/lib/knowledge.ts
var RESERVED_SLUGS = /* @__PURE__ */ new Set([
  "app",
  "auth",
  "api",
  "kb",
  "admin",
  "blogs",
  "blog",
  "pricing",
  "marketing",
  "all-blogs",
  "industries",
  "new",
  "settings",
  "public",
  "assets",
  "favicon.ico"
]);
function slugify(input) {
  return (input ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug);
}
async function uniqueSlug(db, base) {
  let slug = slugify(base) || `kb-${crypto.randomUUID().slice(0, 6)}`;
  if (RESERVED_SLUGS.has(slug)) slug = `${slug}-1`;
  let candidate = slug;
  for (let i = 2; i < 60; i++) {
    const hit = (await db.execute({ sql: "SELECT id FROM knowledge_bases WHERE slug = ?", args: [candidate] })).rows[0];
    if (!hit) return candidate;
    candidate = `${slug}-${i}`;
  }
  return `${slug}-${crypto.randomUUID().slice(0, 6)}`;
}
var ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&rsquo;": "\u2019",
  "&lsquo;": "\u2018",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D"
};
function htmlToText(html) {
  let s = (html ?? "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<head[\s\S]*?<\/head>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, "\n").replace(/<[^>]+>/g, " ");
  for (const [entity, char] of Object.entries(ENTITIES)) {
    s = s.split(entity).join(char);
  }
  s = s.replace(/&#(x?)([0-9a-f]+);/gi, (_, hex, num) => {
    const code = parseInt(num, hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
  return s.split("\n").map((line) => line.replace(/[ \t\f\v]+/g, " ").trim()).filter((line, i, arr) => line !== "" || i > 0 && arr[i - 1] !== "").join("\n").trim();
}
function chunkText(text, maxLen = 1200, overlap = 150) {
  const clean = (text ?? "").replace(/\r/g, "").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const chunks = [];
  let cur = "";
  for (const para of clean.split(/\n{2,}/)) {
    if ((cur ? cur.length + 2 : 0) + para.length <= maxLen) {
      cur = cur ? `${cur}

${para}` : para;
      continue;
    }
    if (cur) chunks.push(cur);
    if (para.length <= maxLen) {
      cur = para;
    } else {
      for (let i = 0; i < para.length; i += maxLen - overlap) chunks.push(para.slice(i, i + maxLen));
      cur = "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length > 0);
}
async function getOrCreateKb(db, userId, fallbackName) {
  const existing = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE user_id = ?", args: [userId] })).rows[0];
  if (existing) return existing;
  const id = crypto.randomUUID();
  const title = (fallbackName ?? "").trim() || "My Business";
  const slug = await uniqueSlug(db, title);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: "INSERT INTO knowledge_bases (id, user_id, slug, title, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)",
    args: [id, userId, slug, title, now]
  });
  return (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [id] })).rows[0];
}
async function addChunks(db, kbId, sourceId, texts) {
  const clean = texts.map((t) => t.trim()).filter(Boolean);
  if (!clean.length) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const rows = clean.map((text) => ({ id: crypto.randomUUID(), text }));
  await db.batch(
    rows.map(
      (r) => ({
        sql: "INSERT INTO kb_chunks (id, kb_id, source_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
        args: [r.id, kbId, sourceId, r.text, now]
      })
    ),
    "write"
  );
  try {
    await db.batch(
      rows.map(
        (r) => ({
          sql: "INSERT INTO kb_chunks_fts (chunk_id, kb_id, text) VALUES (?, ?, ?)",
          args: [r.id, kbId, r.text]
        })
      ),
      "write"
    );
  } catch {
  }
}
async function deleteSourceChunks(db, kbId, sourceId) {
  try {
    await db.execute({
      sql: "DELETE FROM kb_chunks_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE kb_id = ? AND source_id = ?)",
      args: [kbId, sourceId]
    });
  } catch {
  }
  await db.execute({ sql: "DELETE FROM kb_chunks WHERE kb_id = ? AND source_id = ?", args: [kbId, sourceId] });
}
async function deleteSource(db, kbId, sourceId) {
  await deleteSourceChunks(db, kbId, sourceId);
  await db.execute({ sql: "DELETE FROM kb_crawl_jobs WHERE kb_id = ? AND source_id = ?", args: [kbId, sourceId] });
  await db.execute({ sql: "DELETE FROM kb_sources WHERE id = ? AND kb_id = ?", args: [sourceId, kbId] });
}
function ftsMatch(query) {
  const tokens = Array.from(new Set((query ?? "").toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])).slice(0, 12);
  return tokens.map((t) => `${t}*`).join(" OR ");
}
async function searchChunks(db, kbId, query, k = 6) {
  const match = ftsMatch(query);
  if (match) {
    try {
      const rows = (await db.execute({
        sql: `SELECT c.text AS text, c.source_id AS source_id
              FROM kb_chunks_fts f JOIN kb_chunks c ON c.id = f.chunk_id
              WHERE f.kb_id = ? AND kb_chunks_fts MATCH ?
              ORDER BY bm25(kb_chunks_fts) LIMIT ?`,
        args: [kbId, match, k]
      })).rows;
      if (rows.length) return rows;
    } catch {
    }
  }
  const like = match && query.trim() ? `%${query.trim().slice(0, 40)}%` : "%";
  return (await db.execute({
    sql: "SELECT text, source_id FROM kb_chunks WHERE kb_id = ? AND text LIKE ? ORDER BY created_at DESC LIMIT ?",
    args: [kbId, like, k]
  })).rows;
}
async function getKnowledgeContext(db, userId, query, opts = {}) {
  const kb = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE user_id = ?", args: [userId] })).rows[0];
  if (!kb) return "";
  const sections = (await db.execute({
    sql: "SELECT kind, title, body FROM kb_sections WHERE kb_id = ? ORDER BY position ASC, created_at ASC",
    args: [kb.id]
  })).rows;
  const entries = (await db.execute({
    sql: "SELECT question, answer FROM kb_entries WHERE kb_id = ? ORDER BY position ASC, created_at ASC LIMIT 40",
    args: [kb.id]
  })).rows;
  const chunks = await searchChunks(db, kb.id, query, opts.chunks ?? 6);
  const parts = [];
  const header = [kb.title, kb.tagline].filter(Boolean).join(" \u2014 ");
  if (header) parts.push(`Business: ${header}`);
  if (kb.description) parts.push(`About: ${kb.description}`);
  const contact = [kb.contact_email, kb.contact_phone, kb.contact_website, kb.contact_address].filter(Boolean);
  if (contact.length) parts.push(`Contact: ${contact.join(" \xB7 ")}`);
  for (const s of sections) {
    const body = (s.body ?? "").trim();
    if (body) parts.push(`${s.title ?? s.kind ?? "Section"}: ${body}`);
  }
  if (entries.length) {
    parts.push("FAQ:\n" + entries.map((e) => `Q: ${e.question}
A: ${e.answer}`).join("\n"));
  }
  if (chunks.length) {
    parts.push("Details:\n" + chunks.map((c) => c.text).join("\n---\n"));
  }
  let out = parts.join("\n\n").trim();
  const maxChars = opts.maxChars ?? 6e3;
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\u2026`;
  return out;
}
async function getPublicKb(db, slug) {
  const kb = (await db.execute({
    sql: "SELECT * FROM knowledge_bases WHERE slug = ? AND status = 'published'",
    args: [slug]
  })).rows[0];
  if (!kb) return null;
  const sections = (await db.execute({
    sql: "SELECT kind, title, body FROM kb_sections WHERE kb_id = ? ORDER BY position ASC, created_at ASC",
    args: [kb.id]
  })).rows;
  const faqs = (await db.execute({
    sql: "SELECT question, answer FROM kb_entries WHERE kb_id = ? ORDER BY position ASC, created_at ASC LIMIT 100",
    args: [kb.id]
  })).rows;
  return {
    slug: kb.slug ?? slug,
    title: kb.title,
    tagline: kb.tagline,
    description: kb.description,
    contact: {
      email: kb.contact_email,
      phone: kb.contact_phone,
      website: kb.contact_website,
      address: kb.contact_address
    },
    sections: sections.map((s) => ({ kind: s.kind, title: s.title, body: s.body })),
    faqs,
    published_at: kb.published_at,
    updated_at: kb.updated_at
  };
}

// src/lib/whatsapp.ts
var DEFAULT_SESSION = "default";
function env(name) {
  return (process.env[name] ?? "").trim();
}
function whatsappConfig() {
  const apiKey = env("RELAYX_API_KEY");
  return {
    enabled: Boolean(apiKey),
    base: (env("RELAYX_BASE_URL") || "").replace(/\/+$/, ""),
    apiKey,
    session: env("RELAYX_SESSION") || DEFAULT_SESSION,
    fromNumber: env("RELAYX_FROM_NUMBER"),
    webhookSecret: env("RELAYX_WEBHOOK_SECRET")
  };
}
function normalizePhone2(raw) {
  return (raw ?? "").replace(/[^\d]/g, "");
}
function phoneMatches(a, b) {
  const na = normalizePhone2(a);
  const nb = normalizePhone2(b);
  if (!na || !nb) return false;
  const len = Math.min(10, Math.min(na.length, nb.length));
  if (len === 0) return false;
  return na.slice(-len) === nb.slice(-len);
}
function authorizeWebhook(authHeader) {
  const cfg = whatsappConfig();
  if (!cfg.webhookSecret) return { ok: true };
  if (!authHeader) return { ok: false };
  return { ok: authHeader === cfg.webhookSecret };
}
function normalizeInbound(body) {
  const out = [];
  const b = body ?? {};
  if (b.event === "message" && b.data) {
    const m = fromWaWebJs(b.data);
    if (m) out.push(m);
    return out;
  }
  if (Array.isArray(b.messages)) {
    for (const raw of b.messages) {
      const m = fromWaWebJs(raw);
      if (m) out.push(m);
    }
    if (out.length) return out;
  }
  if (b.object === "whatsapp_business_account") {
    const entries = Array.isArray(b.entry) ? b.entry : [];
    for (const entry of entries) {
      const changes = entry?.changes;
      if (!Array.isArray(changes)) continue;
      for (const ch of changes) {
        const msgs = ch?.value?.messages;
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
          const n = fromMeta(m);
          if (n) out.push(n);
        }
      }
    }
    if (out.length) return out;
  }
  if (typeof b.from === "string") {
    out.push({
      from: b.from,
      body: typeof b.body === "string" ? b.body : "",
      contactName: typeof b.pushName === "string" ? b.pushName : typeof b.contactName === "string" ? b.contactName : null,
      fromMe: Boolean(b.fromMe),
      timestamp: typeof b.timestamp === "number" ? new Date(b.timestamp * 1e3).toISOString() : null,
      providerMessageId: String(b.id ?? b.providerMessageId ?? `${b.from}-${Date.now()}`),
      messageType: typeof b.messageType === "string" ? b.messageType : "text"
    });
    return out;
  }
  return out;
}
function fromWaWebJs(m) {
  const key = m?.key ?? m;
  const remoteJid = typeof key?.remoteJid === "string" ? key.remoteJid : typeof key?.jid === "string" ? key.jid : void 0;
  if (!remoteJid) return null;
  const phone = remoteJid.split("@")[0]?.trim() ?? remoteJid;
  const fromMe = Boolean(key?.fromMe);
  const msg = m?.message ?? {};
  let text = "";
  const conv = msg.conversation;
  if (typeof conv === "string") text = conv;
  else {
    const ext = msg.extendedTextMessage;
    if (typeof ext?.text === "string") text = ext.text;
    else {
      const txt = msg.text;
      if (typeof txt?.body === "string") text = txt.body;
      else {
        const img = msg.imageMessage;
        if (typeof img?.caption === "string") text = `[image] ${img.caption}`;
        else {
          const vid = msg.videoMessage;
          if (typeof vid?.caption === "string") text = `[video] ${vid.caption}`;
          else if (msg.audioMessage && typeof msg.audioMessage === "object") text = "[audio]";
          else if (msg.documentMessage && typeof msg.documentMessage === "object") text = "[document]";
          else if (msg.stickerMessage && typeof msg.stickerMessage === "object") text = "[sticker]";
          else if (msg.locationMessage && typeof msg.locationMessage === "object") text = "[location]";
        }
      }
    }
  }
  const tsNum = typeof m?.messageTimestamp === "number" ? m.messageTimestamp : typeof m?.timestamp === "number" ? m.timestamp : NaN;
  return {
    from: phone,
    body: text,
    contactName: typeof m?.pushName === "string" ? m.pushName : null,
    fromMe,
    timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1e3).toISOString() : null,
    providerMessageId: String(key?.id ?? m?.id ?? `${phone}-${Date.now()}`),
    messageType: guessMessageType(msg)
  };
}
function fromMeta(m) {
  if (typeof m?.from !== "string") return null;
  const tsNum = typeof m?.timestamp === "number" ? m.timestamp : NaN;
  let text = "";
  const txt2 = m.text;
  if (typeof txt2?.body === "string") text = txt2.body;
  else if (m?.type === "image") text = "[image]";
  else if (m?.type === "audio") text = "[audio]";
  else if (m?.type === "document") text = "[document]";
  else if (m?.type === "sticker") text = "[sticker]";
  else if (m?.type === "location") text = "[location]";
  else if (m?.type === "contacts") text = "[contact]";
  else text = "";
  return {
    from: m.from,
    body: text,
    contactName: typeof m?.pushName === "string" ? m.pushName : null,
    fromMe: false,
    timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1e3).toISOString() : null,
    providerMessageId: String(m?.id ?? `${m.from}-${Date.now()}`),
    messageType: typeof m?.type === "string" ? m.type : "text"
  };
}
function guessMessageType(msg) {
  if (msg.conversation) return "text";
  const ext = msg.extendedTextMessage;
  if (typeof ext?.text === "string") return "text";
  const txt = msg.text;
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
async function sendText(to, text) {
  const cfg = whatsappConfig();
  if (!cfg.enabled) return { ok: false, providerMessageId: null, error: "WhatsApp provider is not configured (RELAYX_API_KEY)" };
  if (!cfg.base) return { ok: false, providerMessageId: null, error: "RELAYX_BASE_URL is not set" };
  const chatId = `${normalizePhone2(to)}@c.us`;
  const url = `${cfg.base}/api/sendText`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey
      },
      body: JSON.stringify({
        session: cfg.session,
        chatId,
        text
      })
    });
  } catch (e) {
    return { ok: false, providerMessageId: null, error: `WhatsApp provider unreachable: ${e.message}` };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, providerMessageId: null, error: `WhatsApp send failed (${res.status}): ${detail.slice(0, 500)}` };
  }
  const json = await res.json().catch(() => ({}));
  const providerMessageId = json?.message?.id ?? json?.messages?.[0]?.id ?? json?.id ?? null;
  return { ok: true, providerMessageId };
}
async function sendMedia(to, file) {
  const cfg = whatsappConfig();
  if (!cfg.enabled) return { ok: false, providerMessageId: null, error: "WhatsApp provider is not configured (RELAYX_API_KEY)" };
  if (!cfg.base) return { ok: false, providerMessageId: null, error: "RELAYX_BASE_URL is not set" };
  const chatId = `${normalizePhone2(to)}@c.us`;
  const url = `${cfg.base}/api/sendMedia`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey
      },
      body: JSON.stringify({
        session: cfg.session,
        chatId,
        base64: file.base64,
        mimetype: file.mimetype,
        filename: file.filename,
        ...file.caption ? { caption: file.caption } : {}
      })
    });
  } catch (e) {
    return { ok: false, providerMessageId: null, error: `WhatsApp provider unreachable: ${e.message}` };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, providerMessageId: null, error: `Media send failed (${res.status}): ${detail.slice(0, 300)}` };
  }
  const json = await res.json().catch(() => ({}));
  const providerMessageId = json?.message?.id ?? json?.messages?.[0]?.id ?? json?.id ?? null;
  return { ok: true, providerMessageId };
}
function workingHoursConfig() {
  return {
    start: env("RELAYX_WORKING_HOURS_START") || "09:00",
    // 24h "HH:MM"
    end: env("RELAYX_WORKING_HOURS_END") || "18:00",
    tz: env("RELAYX_WORKING_TZ") || "America/New_York"
  };
}
function isWithinWorkingHours(date) {
  const { start, end, tz } = workingHoursConfig();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "0";
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + (sm || 0);
  const e = eh * 60 + (em || 0);
  return mins >= s && mins < e;
}
function autoAckText() {
  return "Thanks for reaching out \u2014 we got your message. Our team will get back to you shortly. \u{1F64C}";
}

// src/routes/messages.ts
var router3 = new Hono3();
async function ownedLeadIds(db, userId, leadIds) {
  const ids = Array.from(new Set(leadIds)).filter(Boolean);
  if (!ids.length) return /* @__PURE__ */ new Set();
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await db.execute({ sql: `SELECT id FROM leads WHERE user_id = ? AND id IN (${placeholders})`, args: [userId, ...ids] })).rows;
  return new Set(rows.map((r) => r.id));
}
async function userOwnsEmail(db, userId, emailId) {
  const row = (await db.execute({
    sql: `SELECT m.id FROM email_messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
    args: [emailId, userId]
  })).rows[0];
  return !!row;
}
async function userOwnsWhatsapp(db, userId, msgId) {
  const row = (await db.execute({
    sql: `SELECT m.id FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
    args: [msgId, userId]
  })).rows[0];
  return !!row;
}
async function userOwnsCall(db, userId, callId) {
  const row = (await db.execute({
    sql: `SELECT m.id FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
    args: [callId, userId]
  })).rows[0];
  return !!row;
}
async function userMailerConfig(db, userId) {
  const row = (await db.execute({ sql: "SELECT gmail_email, gmail_app_password FROM users WHERE id = ?", args: [userId] })).rows[0];
  const user = row?.gmail_email || process.env.GMAIL_USER;
  const appPassword = row?.gmail_app_password || process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("No email account configured for this user \u2014 ask your admin to set one in the Admin panel.");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com"
  };
}
var attachmentSchema = z3.array(
  z3.object({
    filename: z3.string().min(1).max(255),
    contentType: z3.string().max(120),
    data: z3.string().min(1)
  })
).max(6).optional();
function parseAttachments(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
router3.get("/chat", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({ sql: "SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 50", args: [user.id] })).rows;
  return c.json(rows);
});
router3.post("/chat", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { role, content, citations } = z3.object({ role: z3.enum(["user", "assistant"]), content: z3.string(), citations: z3.array(z3.string()).optional() }).parse(await c.req.json());
  const id = crypto.randomUUID();
  await (await getDb()).execute({
    sql: "INSERT INTO chat_messages (id, user_id, role, content, citations) VALUES (?, ?, ?, ?, ?)",
    args: [id, user.id, role, content, citations ? JSON.stringify(citations) : null]
  });
  return c.json({ id });
});
router3.get("/emails", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM email_messages m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? AND COALESCE(m.direction, 'outbound') = 'outbound'
          ORDER BY m.created_at DESC LIMIT 100`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/emails", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(
    z3.object({
      lead_id: z3.string(),
      subject: z3.string(),
      body: z3.string(),
      tone: z3.string().optional(),
      goal: z3.string().optional(),
      status: z3.string().optional(),
      attachments: attachmentSchema
    })
  ).parse(await c.req.json());
  const db = await getDb();
  const leadIds = Array.from(new Set(data.map((r) => r.lead_id)));
  const owned = await ownedLeadIds(db, user.id, leadIds);
  const items = [];
  const statements = [];
  for (const r of data) {
    if (!owned.has(r.lead_id)) continue;
    const id = crypto.randomUUID();
    items.push({ id, lead_id: r.lead_id });
    statements.push({
      sql: "INSERT INTO email_messages (id, lead_id, subject, body, tone, goal, status, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, r.lead_id, r.subject, r.body, r.tone ?? null, r.goal ?? null, r.status ?? "draft", r.attachments && r.attachments.length ? JSON.stringify(r.attachments) : null]
    });
  }
  if (statements.length) await db.batch(statements, "write");
  return c.json({ success: true, items });
});
router3.post("/emails/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string(), sent_at: z3.string().optional(), delivered_at: z3.string().optional(), opened_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!await userOwnsEmail(db, user.id, d.id)) return c.json({ error: "Email not found" }, 404);
  const sets = ["status = ?"];
  const vals = [d.status];
  if (d.sent_at) {
    sets.push("sent_at = ?");
    vals.push(d.sent_at);
  }
  if (d.delivered_at) {
    sets.push("delivered_at = ?");
    vals.push(d.delivered_at);
  }
  if (d.opened_at) {
    sets.push("opened_at = ?");
    vals.push(d.opened_at);
  }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE email_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  return c.json({ success: true });
});
router3.post("/emails/send", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id } = z3.object({ id: z3.string() }).parse(await c.req.json());
  const db = await getDb();
  const row = (await db.execute({ sql: "SELECT * FROM email_messages WHERE id = ?", args: [id] })).rows[0];
  if (!row) return c.json({ error: "Email not found" }, 404);
  if (!row.lead_id || !(await ownedLeadIds(db, user.id, [row.lead_id])).has(row.lead_id)) {
    return c.json({ error: "Email not found" }, 404);
  }
  const lead = (await db.execute({ sql: "SELECT email FROM leads WHERE id = ?", args: [row.lead_id] })).rows[0];
  if (!lead?.email) return c.json({ error: "Lead has no email address \u2014 add one before sending" }, 400);
  const attachments = parseAttachments(row.attachments).map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: Buffer.from(a.data, "base64")
  }));
  try {
    const mailCfg = await userMailerConfig(db, user.id);
    const sent = await sendMessage({ to: lead.email, subject: row.subject, text: row.body, attachments }, mailCfg);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.execute({
      sql: "UPDATE email_messages SET status = 'sent', sent_at = ?, from_email = ?, to_email = ?, agentmail_message_id = ?, agentmail_thread_id = ? WHERE id = ?",
      args: [now, mailCfg.user, lead.email, sent.message_id ?? null, sent.thread_id ?? null, id]
    });
    await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, row.lead_id] });
    await insertEvent(db, {
      lead_id: row.lead_id,
      channel: "email",
      type: "email",
      direction: "outbound",
      handled_by: "human",
      action: "sent",
      summary: row.subject,
      content: row.body,
      source_ref: id,
      metadata: { message_id: sent.message_id ?? null, thread_id: sent.thread_id ?? null, to: lead.email },
      created_at: now
    });
    const updated = (await db.execute({ sql: "SELECT * FROM email_messages WHERE id = ?", args: [id] })).rows[0];
    return c.json(updated);
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});
router3.get("/whatsapps", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 100`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/whatsapps", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), body: z3.string(), status: z3.string().optional(), attachments: attachmentSchema })).parse(await c.req.json());
  const db = await getDb();
  const owned = await ownedLeadIds(db, user.id, data.map((r) => r.lead_id));
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const items = [];
  const statements = data.filter((r) => owned.has(r.lead_id)).flatMap((r) => {
    const id = crypto.randomUUID();
    items.push({ id, lead_id: r.lead_id });
    return [
      { sql: "INSERT INTO whatsapp_messages (id, lead_id, body, status, attachments) VALUES (?, ?, ?, ?, ?)", args: [id, r.lead_id, r.body, r.status ?? "draft", r.attachments && r.attachments.length ? JSON.stringify(r.attachments) : null] },
      { sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'whatsapp', ?, ?, ?, ?)", args: [crypto.randomUUID(), r.lead_id, r.status ?? "draft", r.body.slice(0, 120), id, now] }
    ];
  });
  if (statements.length) await db.batch(statements, "write");
  return c.json({ success: true, items });
});
router3.post("/whatsapps/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string(), sent_at: z3.string().optional(), delivered_at: z3.string().optional(), read_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!await userOwnsWhatsapp(db, user.id, d.id)) return c.json({ error: "WhatsApp message not found" }, 404);
  const sets = ["status = ?"];
  const vals = [d.status];
  if (d.sent_at) {
    sets.push("sent_at = ?");
    vals.push(d.sent_at);
  }
  if (d.delivered_at) {
    sets.push("delivered_at = ?");
    vals.push(d.delivered_at);
  }
  if (d.read_at) {
    sets.push("read_at = ?");
    vals.push(d.read_at);
  }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE whatsapp_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const w = (await db.execute({ sql: "SELECT lead_id FROM whatsapp_messages WHERE id = ?", args: [d.id] })).rows[0];
  await insertEvent(db, { lead_id: w?.lead_id ?? null, channel: "whatsapp", action: d.status, source_ref: d.id });
  return c.json({ success: true });
});
router3.post("/whatsapps/send", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string().optional(), lead_id: z3.string().optional(), body: z3.string().optional(), attachments: attachmentSchema }).parse(await c.req.json());
  const db = await getDb();
  let messageId = d.id ?? "";
  let leadId = d.lead_id ?? null;
  let body = d.body ?? "";
  let fromNumber = null;
  let attachments = [];
  if (!messageId && (leadId && body)) {
    if (!(await ownedLeadIds(db, user.id, [leadId])).has(leadId)) return c.json({ error: "Lead not found" }, 404);
    const cfg = whatsappConfig();
    const newId = crypto.randomUUID();
    const lead2 = (await db.execute({ sql: "SELECT phone FROM leads WHERE id = ?", args: [leadId] })).rows[0];
    if (!lead2?.phone) return c.json({ error: "Lead has no phone number \u2014 add one before sending" }, 400);
    attachments = d.attachments ?? [];
    await db.execute({
      sql: "INSERT INTO whatsapp_messages (id, lead_id, body, direction, from_number, to_number, status, attachments) VALUES (?, ?, ?, 'outbound', ?, ?, 'draft', ?)",
      args: [newId, leadId, body, cfg.fromNumber || null, lead2.phone, attachments.length ? JSON.stringify(attachments) : null]
    });
    messageId = newId;
    fromNumber = cfg.fromNumber || null;
  } else if (messageId) {
    if (!await userOwnsWhatsapp(db, user.id, messageId)) return c.json({ error: "WhatsApp message not found" }, 404);
    const row = (await db.execute({ sql: "SELECT * FROM whatsapp_messages WHERE id = ?", args: [messageId] })).rows[0];
    if (!row) return c.json({ error: "WhatsApp message not found" }, 404);
    leadId = row.lead_id;
    body = row.body;
    fromNumber = row.from_number ?? whatsappConfig().fromNumber ?? null;
    attachments = parseAttachments(row.attachments);
  }
  if (!leadId) return c.json({ error: "Message is not linked to a lead" }, 400);
  if (!body) return c.json({ error: "Nothing to send \u2014 message body is empty" }, 400);
  const lead = (await db.execute({ sql: "SELECT phone FROM leads WHERE id = ?", args: [leadId] })).rows[0];
  if (!lead?.phone) return c.json({ error: "Lead has no phone number \u2014 add one before sending" }, 400);
  let send;
  try {
    send = await sendText(lead.phone, body);
  } catch (e) {
    console.error("SEND TEXT THREW:", e);
    send = { ok: false, providerMessageId: null, error: e.message };
  }
  if (!send.ok) return c.json({ error: send.error ?? "WhatsApp send failed" }, 502);
  const attachmentErrors = [];
  for (const a of attachments) {
    try {
      const media = await sendMedia(lead.phone, { base64: a.data, mimetype: a.contentType, filename: a.filename });
      if (!media.ok) attachmentErrors.push(`${a.filename}: ${media.error ?? "failed"}`);
    } catch (e) {
      attachmentErrors.push(`${a.filename}: ${e.message}`);
    }
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: "UPDATE whatsapp_messages SET status = 'sent', sent_at = ?, provider_message_id = ?, to_number = ?, from_number = ?, direction = 'outbound' WHERE id = ?",
    args: [now, send.providerMessageId, lead.phone, fromNumber, messageId]
  });
  await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, leadId] });
  await insertEvent(db, {
    lead_id: leadId,
    channel: "whatsapp",
    type: "whatsapp",
    direction: "outbound",
    handled_by: "human",
    action: "sent",
    summary: body.slice(0, 120),
    content: body,
    source_ref: messageId,
    metadata: { to: lead.phone, provider_message_id: send.providerMessageId, from: fromNumber, attachments: attachments.length },
    created_at: now
  });
  const updated = (await db.execute({ sql: "SELECT * FROM whatsapp_messages WHERE id = ?", args: [messageId] })).rows[0];
  if (attachmentErrors.length) {
    return c.json({ ...updated, warning: `Text sent, but ${attachmentErrors.length} attachment${attachmentErrors.length === 1 ? "" : "s"} failed: ${attachmentErrors.join("; ")}` });
  }
  return c.json(updated);
});
router3.get("/calls", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM call_logs m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 50`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/calls", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), goal: z3.string().optional(), voice: z3.string().optional(), status: z3.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const owned = await ownedLeadIds(db, user.id, data.map((r) => r.lead_id));
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const statements = data.filter((r) => owned.has(r.lead_id)).flatMap((r) => {
    const id = crypto.randomUUID();
    return [
      { sql: "INSERT INTO call_logs (id, lead_id, goal, voice, status) VALUES (?, ?, ?, ?, ?)", args: [id, r.lead_id, r.goal ?? null, r.voice ?? null, r.status ?? "queued"] },
      { sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'call', ?, ?, ?, ?)", args: [crypto.randomUUID(), r.lead_id, r.status ?? "queued", r.goal ?? null, id, now] }
    ];
  });
  if (statements.length) await db.batch(statements, "write");
  const rows = (await db.execute({
    sql: `SELECT m.* FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 50`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/calls/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string().optional(), outcome: z3.string().optional(), transcript: z3.any().optional(), summary: z3.string().optional(), duration_sec: z3.number().optional(), started_at: z3.string().optional(), ended_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!await userOwnsCall(db, user.id, d.id)) return c.json({ error: "Call not found" }, 404);
  const sets = [];
  const vals = [];
  if (d.status !== void 0) {
    sets.push("status = ?");
    vals.push(d.status);
  }
  if (d.outcome !== void 0) {
    sets.push("outcome = ?");
    vals.push(d.outcome);
  }
  if (d.transcript !== void 0) {
    sets.push("transcript = ?");
    vals.push(JSON.stringify(d.transcript));
  }
  if (d.summary !== void 0) {
    sets.push("summary = ?");
    vals.push(d.summary);
  }
  if (d.duration_sec !== void 0) {
    sets.push("duration_sec = ?");
    vals.push(d.duration_sec);
  }
  if (d.started_at !== void 0) {
    sets.push("started_at = ?");
    vals.push(d.started_at);
  }
  if (d.ended_at !== void 0) {
    sets.push("ended_at = ?");
    vals.push(d.ended_at);
  }
  if (!sets.length) return c.json({ success: true });
  vals.push(d.id);
  await db.execute({ sql: `UPDATE call_logs SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const cl = (await db.execute({ sql: "SELECT lead_id FROM call_logs WHERE id = ?", args: [d.id] })).rows[0];
  await insertEvent(db, { lead_id: cl?.lead_id ?? null, channel: "call", action: d.outcome ?? d.status ?? "updated", source_ref: d.id });
  return c.json({ success: true });
});
router3.post("/calls/dial", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  try {
    const data = z3.object({ lead_id: z3.string(), goal: z3.string().optional() }).parse(await c.req.json());
    const db = await getDb();
    const lead = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ? AND user_id = ?", args: [data.lead_id, user.id] })).rows[0];
    if (!lead) return c.json({ error: "Lead not found" }, 404);
    if (!lead.phone) return c.json({ error: `${lead.name} has no phone number \u2014 add one before calling.` }, 400);
    const toNumber = normalizePhone(lead.phone);
    if (!toNumber) {
      return c.json({ error: `${lead.name}'s number "${lead.phone}" isn't a usable international format. Save it as +countrycode followed by digits, e.g. +91 70146 07737.` }, 400);
    }
    const kbContext = await getKnowledgeContext(db, user.id, [lead.interest, lead.category, data.goal].filter(Boolean).join(" "));
    const brief2 = buildAgentBrief(lead, data.goal) + (kbContext ? `

Business knowledge base (answer questions about the business from this \u2014 do not invent facts):
${kbContext}` : "");
    const id = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let run;
    try {
      run = await triggerAgentflow(
        buildTriggerPayload({
          leadId: lead.id,
          callId: id,
          toNumber,
          leadName: lead.name,
          brief: brief2,
          company: lead.company,
          interest: lead.interest,
          goal: data.goal ?? null
        })
      );
    } catch (e) {
      await db.batch([
        {
          sql: "INSERT INTO call_logs (id, lead_id, goal, status, outcome, provider, from_number, to_number, created_at) VALUES (?, ?, ?, 'failed', ?, 'plivo', NULL, ?, ?)",
          args: [id, lead.id, data.goal ?? null, e.message.slice(0, 500), toNumber, now]
        },
        {
          sql: "INSERT INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'call', 'failed', ?, ?, ?)",
          args: [crypto.randomUUID(), lead.id, `Call to ${lead.name} failed to start`, id, now]
        }
      ], "write");
      return c.json({ error: e.message }, 502);
    }
    await db.batch([
      {
        sql: "INSERT INTO call_logs (id, lead_id, goal, status, provider, phlo_id, plivo_api_id, prompt_used, to_number, started_at, created_at) VALUES (?, ?, ?, 'in_progress', 'plivo', ?, ?, ?, ?, ?, ?)",
        args: [id, lead.id, data.goal ?? null, run.phlo_id, run.api_id, brief2, toNumber, now, now]
      },
      {
        sql: "INSERT INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'call', 'initiated', ?, ?, ?)",
        args: [crypto.randomUUID(), lead.id, `AI agent calling ${lead.name} about ${lead.interest ?? "their enquiry"}`, id, now]
      }
    ], "write");
    return c.json({ success: true, call_id: id, phlo_id: run.phlo_id, message: run.message, brief: brief2, to_number: toNumber });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router3.get("/appointments", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT a.id, a.title, a.scheduled_at, a.lead_id FROM appointments a JOIN leads l ON l.id = a.lead_id
          WHERE l.user_id = ? ORDER BY a.scheduled_at ASC LIMIT 20`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/appointments", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ lead_id: z3.string(), call_id: z3.string().optional(), title: z3.string(), scheduled_at: z3.string(), duration_min: z3.number().optional(), status: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!(await ownedLeadIds(db, user.id, [d.lead_id])).has(d.lead_id)) return c.json({ error: "Lead not found" }, 404);
  await db.execute({
    sql: "INSERT INTO appointments (id, lead_id, call_id, title, scheduled_at, duration_min, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), d.lead_id, d.call_id ?? null, d.title, d.scheduled_at, d.duration_min ?? 30, d.status ?? "confirmed"]
  });
  return c.json({ success: true });
});
var messages_default = router3;

// src/routes/ai.ts
import { Hono as Hono4 } from "hono";
import { z as z4 } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, tool, isStepCount } from "ai";
async function userMailerConfig2(db, userId) {
  const row = (await db.execute({ sql: "SELECT gmail_email, gmail_app_password FROM users WHERE id = ?", args: [userId] })).rows[0];
  const user = row?.gmail_email || process.env.GMAIL_USER;
  const appPassword = row?.gmail_app_password || process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("No email account configured for this user \u2014 ask your admin to set one in the Admin panel.");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com"
  };
}
var router4 = new Hono4();
var MODEL = process.env.AI_MODEL ?? "openai/gpt-5.6-luna";
function gateway() {
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) throw new Error("Missing AI_API_KEY or AI_BASE_URL");
  return createOpenAICompatible({ name: "ai-provider", apiKey, baseURL });
}
function leadsBlock(leads) {
  return leads.map((l) => {
    const budget = l.budget_max ? `$${Number(l.budget_max).toLocaleString()}` : "";
    const extras = [
      l.interest ? `interest=${l.interest}` : "",
      l.category ? `category=${l.category}` : "",
      l.region ? `region=${l.region}` : "",
      budget ? `budget=${budget}` : "",
      l.urgency ? `urgency=${l.urgency}` : "",
      l.notes ? `notes="${l.notes}"` : ""
    ].filter(Boolean).join(" \xB7 ");
    return `- [${l.id.slice(0, 8)}] ${l.name} \xB7 ${l.company ?? ""} \xB7 ${l.city ?? ""} \xB7 email=${l.email ?? "\u2014"} \xB7 phone=${l.phone ?? "\u2014"} \xB7 status=${l.status} \xB7 score=${l.score}${extras ? ` \xB7 ${extras}` : ""}`;
  }).join("\n");
}
var historySchema = z4.array(z4.object({ role: z4.enum(["user", "assistant"]), content: z4.string() }));
function buildChatTools(userId) {
  return {
    send_email: tool({
      description: "Send a real email to a lead through the connected inbox (SMTP). The email is delivered immediately and recorded in Email Studio. Call this when the user asks to send, email, or mail a lead \u2014 compose the subject and body yourself from the lead's details and requirements.",
      inputSchema: z4.object({
        lead_id: z4.string().describe("The lead's id \u2014 its full UUID or the first 8 characters shown in the leads list."),
        subject: z4.string().describe("Email subject line."),
        body: z4.string().describe("Plain-text email body. Personalize with the lead's name and their specific needs.")
      }),
      execute: async ({ lead_id, subject, body }) => {
        const db = await getDb();
        const lead = (await db.execute({ sql: "SELECT * FROM leads WHERE (id = ? OR substr(id, 1, 8) = ?) AND user_id = ? LIMIT 1", args: [lead_id, lead_id, userId] })).rows[0];
        if (!lead) return { ok: false, error: `No lead found with id ${lead_id}` };
        if (!lead.email) return { ok: false, error: `Lead ${lead.name ?? lead_id} has no email address on file \u2014 add one first` };
        let mailCfg;
        try {
          mailCfg = await userMailerConfig2(db, userId);
        } catch (e) {
          return { ok: false, error: e.message };
        }
        const id = crypto.randomUUID();
        await db.execute({
          sql: "INSERT INTO email_messages (id, lead_id, subject, body, direction, status, created_at) VALUES (?, ?, ?, ?, 'outbound', 'draft', ?)",
          args: [id, lead.id, subject, body, (/* @__PURE__ */ new Date()).toISOString()]
        });
        try {
          const sent = await sendMessage({ to: lead.email, subject, text: body }, mailCfg);
          const now = (/* @__PURE__ */ new Date()).toISOString();
          await db.execute({
            sql: "UPDATE email_messages SET status = 'sent', sent_at = ?, from_email = ?, to_email = ?, agentmail_message_id = ?, agentmail_thread_id = ? WHERE id = ?",
            args: [now, mailCfg.user, lead.email, sent.message_id ?? null, sent.thread_id ?? null, id]
          });
          await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, lead.id] });
          await insertEvent(db, {
            lead_id: lead.id,
            channel: "email",
            type: "email",
            direction: "outbound",
            handled_by: "human",
            action: "sent",
            summary: subject,
            content: body,
            source_ref: id,
            metadata: { to: lead.email, message_id: sent.message_id ?? null, via: "ai-chat" },
            created_at: now
          });
          return { ok: true, email_id: id, to: lead.email, subject };
        } catch (e) {
          await db.execute({ sql: "UPDATE email_messages SET status = 'draft' WHERE id = ?", args: [id] });
          return { ok: false, error: `Sending failed: ${e.message}. The email was saved as a draft in Email Studio.` };
        }
      }
    }),
    send_whatsapp: tool({
      description: "Send a real WhatsApp message to a lead. The message is delivered immediately and recorded in WhatsApp. Call this when the user asks to send a WhatsApp or message a lead.",
      inputSchema: z4.object({
        lead_id: z4.string().describe("The lead's id \u2014 its full UUID or the first 8 characters shown in the leads list."),
        body: z4.string().describe("WhatsApp message text, 1-3 sentences, personalized with the lead's name and needs.")
      }),
      execute: async ({ lead_id, body }) => {
        const db = await getDb();
        const lead = (await db.execute({ sql: "SELECT * FROM leads WHERE (id = ? OR substr(id, 1, 8) = ?) AND user_id = ? LIMIT 1", args: [lead_id, lead_id, userId] })).rows[0];
        if (!lead) return { ok: false, error: `No lead found with id ${lead_id}` };
        if (!lead.phone) return { ok: false, error: `Lead ${lead.name ?? lead_id} has no phone number on file \u2014 add one first` };
        const id = crypto.randomUUID();
        await db.execute({
          sql: "INSERT INTO whatsapp_messages (id, lead_id, body, direction, to_number, status, created_at) VALUES (?, ?, ?, 'outbound', ?, 'draft', ?)",
          args: [id, lead.id, body, lead.phone, (/* @__PURE__ */ new Date()).toISOString()]
        });
        try {
          const send = await sendText(lead.phone, body);
          if (!send.ok) throw new Error(send.error ?? "WhatsApp send failed");
          const now = (/* @__PURE__ */ new Date()).toISOString();
          await db.execute({
            sql: "UPDATE whatsapp_messages SET status = 'sent', sent_at = ?, provider_message_id = ? WHERE id = ?",
            args: [now, send.providerMessageId, id]
          });
          await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, lead.id] });
          await insertEvent(db, {
            lead_id: lead.id,
            channel: "whatsapp",
            type: "whatsapp",
            direction: "outbound",
            handled_by: "human",
            action: "sent",
            summary: body.slice(0, 120),
            content: body,
            source_ref: id,
            metadata: { to: lead.phone, provider_message_id: send.providerMessageId, via: "ai-chat" },
            created_at: now
          });
          return { ok: true, message_id: id, to: lead.phone };
        } catch (e) {
          await db.execute({ sql: "UPDATE whatsapp_messages SET status = 'draft' WHERE id = ?", args: [id] });
          return { ok: false, error: `Sending failed: ${e.message}. The message was saved as a draft in WhatsApp.` };
        }
      }
    })
  };
}
router4.post("/chat", async (c) => {
  const authedUser = await authenticate(c);
  if (!authedUser) return c.json({ error: "Unauthorized" }, 401);
  const { question, leads, history } = z4.object({ question: z4.string(), leads: z4.array(z4.any()), history: historySchema.optional() }).parse(await c.req.json());
  const ai = gateway();
  const kbContext = await getKnowledgeContext(await getDb(), authedUser.id, question);
  let text;
  try {
    const res = await generateText({
      model: ai(MODEL),
      system: `You are an assistant for a lead-management CRM (prospects, customers, deals). Answer ONLY using the provided leads data. Be concise. Cite leads as [lead:FULL_ID]. Do not invent leads or their data, and never substitute a different lead when the one being discussed lacks a field \u2014 say that field is missing instead. The conversation may reference a lead named earlier in the thread \u2014 use that context to resolve follow-up questions (e.g. "his email" or "show me his number" refers to the lead just discussed, not a different one). You have two real tools: send_email and send_whatsapp. Use them ONLY when the user explicitly asks you to send an email or WhatsApp message to a specific lead. Compose the content yourself from the lead's requirements. After a tool succeeds, confirm briefly what was sent and to whom. If a tool reports an error, tell the user what happened and what they can do (e.g. add the missing email/phone, or send from Email Studio).` + (kbContext ? `

The business has provided the following knowledge base \u2014 use it to answer questions about the business itself (products, services, hours, location, policies, FAQs). Do not invent facts beyond it:
${kbContext}` : ""),
      messages: [
        { role: "user", content: `Leads (${leads.length}):
${leadsBlock(leads)}` },
        ...history ?? [],
        { role: "user", content: question }
      ],
      tools: buildChatTools(authedUser.id),
      stopWhen: isStepCount(5),
      // The gateway rejects function tools combined with reasoning_effort on
      // this model (/v1/chat/completions) — explicitly disable reasoning so
      // tool calling is allowed.
      providerOptions: { "ai-provider": { reasoningEffort: "none" } }
    });
    text = res.text;
  } catch (e) {
    console.error("[ai/chat] generateText failed:", e);
    throw e;
  }
  const ids = Array.from(text.matchAll(/\[lead:([a-z0-9-]{8,})\]/gi)).map((m) => m[1]);
  const cited = Array.from(new Set(ids)).map((short) => leads.find((l) => l.id.startsWith(short))?.id).filter(Boolean);
  return c.json({ text, citations: cited });
});
router4.post("/email", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { lead, tone, goal, senderName } = z4.object({ lead: z4.any(), tone: z4.string(), goal: z4.string(), senderName: z4.string().optional() }).parse(await c.req.json());
  const ai = gateway();
  const kbContext = await getKnowledgeContext(await getDb(), user.id, `${goal} ${lead?.name ?? ""} ${lead?.interest ?? ""}`);
  const { text } = await generateText({
    model: ai(MODEL),
    system: `You write short, high-converting sales and outreach emails for a small business (introductions, proposals, follow-ups, check-ins). Reply as strict JSON: {"subject":"...","body":"..."}. Keep body under 110 words. Sign as ${senderName ?? "Jordan"}.${kbContext ? ` Use this knowledge base for accurate facts about the business; do not invent details:
${kbContext}` : ""}`,
    prompt: `Tone: ${tone}
Goal: ${goal}
Lead: ${JSON.stringify(lead)}`
  });
  try {
    const j = JSON.parse(text.replace(/```json|```/g, "").trim());
    return c.json({ subject: j.subject ?? "", body: j.body ?? "" });
  } catch {
    return c.json({ subject: "", body: text });
  }
});
router4.post("/whatsapp", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { lead, intent } = z4.object({ lead: z4.any(), intent: z4.string() }).parse(await c.req.json());
  const ai = gateway();
  const kbContext = await getKnowledgeContext(await getDb(), user.id, `${intent} ${lead?.name ?? ""} ${lead?.interest ?? ""}`);
  const { text } = await generateText({
    model: ai(MODEL),
    system: `Write a friendly, concise follow-up WhatsApp message (1-3 sentences, max 280 chars) \u2014 e.g. appointment reminders, quick check-ins, or next-step updates. Use the lead's first name. One emoji max. Return ONLY the message body.${kbContext ? ` Use these business details for accuracy; do not invent facts:
${kbContext}` : ""}`,
    prompt: `Intent: ${intent}
Lead: ${JSON.stringify(lead)}`
  });
  return c.json({ body: text.trim().replace(/^"|"$/g, "") });
});
router4.post("/call", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, goal } = z4.object({ lead: z4.any(), goal: z4.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: 'Design AI voice agent call flows for a sales team (qualify prospects, book meetings, discuss proposals). Return strict JSON: {"opening":"...","talking_points":["..."],"objection_handling":["..."],"closing":"...","mock_transcript":[{"speaker":"agent|lead","text":"..."}],"summary":"...","suggested_outcome":"booked|interested|callback|not_interested|voicemail","book_appointment":true|false}. Transcript should be 6-10 turns.',
    prompt: `Call goal: ${goal}
Lead: ${JSON.stringify(lead)}`
  });
  try {
    return c.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch {
    return c.json({ suggested_outcome: "callback", book_appointment: false, summary: text, mock_transcript: [] });
  }
});
router4.post("/post", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { topic, platform, audience, tone } = z4.object({ topic: z4.string().min(1), platform: z4.string().optional(), audience: z4.string().optional(), tone: z4.string().optional() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: 'You are a social media copywriter for a small business (product updates, launches, customer wins, industry insights). Return strict JSON: {"caption":"...","hashtags":["#tag","#tag"],"image_prompt":"..."}. The caption must be ready to post: 1-3 short paragraphs, 1-2 emojis, natural line breaks, tailored to the platform and audience. Hashtags: exactly 5-8 relevant tags as an array of strings including the # (e.g. #NewProduct, #BehindTheScenes, #CustomerStory, location tags). image_prompt: a detailed English visual prompt (150-220 words) describing a striking, on-brand image for this post \u2014 subject, composition, lighting, colors, mood, and any text/graphic elements.',
    prompt: `Topic: ${topic}
Platform: ${platform ?? "Instagram"}
Target audience: ${audience || "general"}
Tone: ${tone || "energetic and inspiring"}`
  });
  try {
    const j = JSON.parse(text.replace(/```json|```/g, "").trim());
    return c.json({
      caption: j.caption ?? "",
      hashtags: Array.isArray(j.hashtags) ? j.hashtags.map(String) : [],
      image_prompt: j.image_prompt ?? topic
    });
  } catch {
    return c.json({ caption: text, hashtags: [], image_prompt: topic });
  }
});
router4.post("/image", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { prompt, size } = z4.object({ prompt: z4.string(), size: z4.string().optional() }).parse(await c.req.json());
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) return c.json({ error: "Missing AI_API_KEY or AI_BASE_URL" }, 500);
  const model = process.env.AI_IMAGE_MODEL ?? "gpt-image-2";
  const endpoint = `${baseURL.replace(/\/+$/, "")}/images/generations`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1, size: size ?? "auto" })
  });
  if (!upstream.ok) {
    const detail = await upstream.text();
    return c.json({ error: `Image generation failed (${upstream.status}): ${detail.slice(0, 500)}` }, 502);
  }
  const json = await upstream.json();
  const item = json.data?.[0];
  if (item?.b64_json) return c.json({ image: `data:image/png;base64,${item.b64_json}` });
  if (item?.url) return c.json({ image: item.url });
  return c.json({ error: "No image returned by the model" }, 502);
});
var ai_default = router4;

// src/routes/conversations.ts
import { Hono as Hono5 } from "hono";
import { z as z5 } from "zod";
var router5 = new Hono5();
function enrichSla(conv) {
  if (conv && typeof conv === "object") {
    conv.sla_status = computeSlaStatus(conv.sla_due_at ?? null);
  }
  return conv;
}
router5.get("/", async (c) => {
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
    args: [user.id]
  })).rows;
  rows = rows.map(enrichSla);
  if (status) rows = rows.filter((r) => r.status === status);
  if (sla) rows = rows.filter((r) => r.sla_status === sla);
  return c.json(rows);
});
router5.get("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.*, l.name AS lead_name, l.company, l.city, l.phone, l.email, l.source, l.status AS lead_status
          FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id]
  })).rows[0];
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const events = (await db.execute({
    sql: `SELECT id, type, channel, direction, content, handled_by, action, summary, source_ref, metadata, created_at
          FROM events WHERE conversation_id = ? ORDER BY created_at ASC`,
    args: [conv.id]
  })).rows;
  return c.json({ conversation: enrichSla(conv), events });
});
router5.post("/:id/events", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z5.object({ content: z5.string().min(1), handled_by: z5.enum(["human", "ai"]).optional() }).parse(await c.req.json());
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.lead_id FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id]
  })).rows[0];
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
    metadata: { note: true }
  });
  return c.json({ success: true });
});
router5.post("/:id/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z5.object({ status: z5.enum(["new", "active", "awaiting_reply", "resolved", "archived"]) }).parse(await c.req.json());
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.id FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id]
  })).rows[0];
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  await setConversationStatus(db, c.req.param("id"), d.status);
  return c.json({ success: true });
});
var conversations_default = router5;

// src/routes/whatsapp-webhook.ts
import { Hono as Hono6 } from "hono";
var ACK_DEBOUNCE_MS = 5 * 60 * 1e3;
var router6 = new Hono6();
router6.get("/", (c) => c.text("ok"));
router6.post("/", async (c) => {
  const authHeader = c.req.header("x-webhook-secret") ?? c.req.header("x-api-key");
  const { ok } = authorizeWebhook(authHeader);
  if (!ok) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const inbound = normalizeInbound(body);
  if (!inbound.length) return c.json({ status: "ok", received: 0 });
  const db = await getDb();
  const cfg = whatsappConfig();
  let receivedCount = 0;
  for (const msg of inbound) {
    const dup = (await db.execute({
      sql: "SELECT id FROM whatsapp_messages WHERE provider_message_id = ? LIMIT 1",
      args: [msg.providerMessageId]
    })).rows[0];
    if (dup) continue;
    const leadId = await findOrCreateLead(db, msg);
    const now = msg.timestamp || (/* @__PURE__ */ new Date()).toISOString();
    const inboundId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO whatsapp_messages
        (id, lead_id, body, direction, from_number, to_number, provider_message_id, status, created_at)
        VALUES (?, ?, ?, 'inbound', ?, ?, ?, 'received', ?)`,
      args: [
        inboundId,
        leadId,
        msg.body,
        msg.from,
        cfg.fromNumber || null,
        msg.providerMessageId,
        now
      ]
    });
    await insertEvent(db, {
      lead_id: leadId,
      channel: "whatsapp",
      type: "whatsapp",
      direction: "inbound",
      handled_by: "unhandled",
      action: "received",
      summary: msg.body.slice(0, 120),
      content: msg.body,
      source_ref: msg.providerMessageId,
      metadata: { from: msg.from, to: cfg.fromNumber || null, message_type: msg.messageType, fromMe: msg.fromMe },
      created_at: now
    });
    let acknowledged = false;
    if (!isWithinWorkingHours(/* @__PURE__ */ new Date())) {
      acknowledged = await maybeAutoAck(db, msg, inboundId, cfg.fromNumber);
    }
    if (acknowledged) {
      await db.execute({
        sql: "UPDATE whatsapp_messages SET acknowledged_at = ? WHERE id = ?",
        args: [(/* @__PURE__ */ new Date()).toISOString(), inboundId]
      });
    }
    receivedCount++;
  }
  return c.json({ status: "ok", received: receivedCount });
});
async function findOrCreateLead(db, msg) {
  const rows = (await db.execute("SELECT id, phone FROM leads WHERE phone IS NOT NULL AND phone != ''")).rows;
  for (const r of rows) {
    if (phoneMatches(r.phone, msg.from)) return r.id;
  }
  const id = crypto.randomUUID();
  const name = msg.contactName?.trim() || msg.from;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: `INSERT INTO leads (id, name, phone, source, status, score, last_activity, created_at)
      VALUES (?, ?, ?, 'whatsapp inbound', 'new', 0, ?, ?)`,
    args: [id, name, normalizePhone2(msg.from), now, now]
  });
  return id;
}
async function maybeAutoAck(db, msg, inboundId, fromNumber) {
  if (!fromNumber) return false;
  const recent = (await db.execute({
    sql: `SELECT id FROM whatsapp_messages
        WHERE direction = 'outbound' AND to_number = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
    args: [msg.from, new Date(Date.now() - ACK_DEBOUNCE_MS).toISOString()]
  })).rows[0];
  if (recent) return false;
  const send = await sendText(msg.from, autoAckText());
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: `INSERT INTO whatsapp_messages
      (id, lead_id, body, direction, from_number, to_number, provider_message_id, status, created_at)
      VALUES (?, NULL, ?, 'outbound', ?, ?, ?, 'sent', ?)`,
    args: [
      crypto.randomUUID(),
      autoAckText(),
      fromNumber,
      normalizePhone2(msg.from),
      send.providerMessageId,
      now
    ]
  });
  await insertEvent(db, {
    lead_id: null,
    channel: "whatsapp",
    type: "whatsapp",
    direction: "outbound",
    handled_by: "human",
    action: "auto-acknowledged",
    summary: autoAckText().slice(0, 120),
    content: autoAckText(),
    source_ref: inboundId,
    metadata: { to: msg.from, provider_message_id: send.providerMessageId, off_hours: true },
    created_at: now
  });
  return send.ok;
}
var whatsapp_webhook_default = router6;

// src/routes/plivo-webhook.ts
import { Hono as Hono7 } from "hono";
var router7 = new Hono7();
function pick(source, ...keys) {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}
function mapStatus(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/completed|answered|hangup|end/.test(s)) return { status: "completed", ended: true };
  if (/no.?answer|unanswered|missed/.test(s)) return { status: "no_answer", ended: true };
  if (/busy|rejected|failed|error|cancel/.test(s)) return { status: "failed", ended: true };
  if (/ringing|in.?progress|queued|initiated|answered_screen/.test(s)) return { status: "in_progress", ended: false };
  return null;
}
router7.post("/", async (c) => {
  let body;
  try {
    body = await c.req.json() ?? {};
  } catch {
    return c.json({ ok: true, ignored: "non-JSON body" });
  }
  const src = body.payload ?? body.event ?? body.data ?? body;
  const apiId = pick(src, "api_id", "apiId", "request_id", "run_id");
  const phloId = pick(src, "phlo_id", "flow_run_id", "phloId");
  const callRef = pick(src, "call_id", "reference_id", "call_uuid", "callUUID");
  const rawStatus = pick(src, "status", "call_status", "event", "EventStatus", "state");
  const mapped = mapStatus(rawStatus);
  if (!apiId && !phloId && !callRef) return c.json({ ok: true, ignored: "no correlation id" });
  const db = await getDb();
  let row;
  if (apiId) {
    row = (await db.execute({ sql: "SELECT id, lead_id FROM call_logs WHERE plivo_api_id = ? LIMIT 1", args: [apiId] })).rows[0];
  }
  if (!row && callRef) {
    row = (await db.execute({ sql: "SELECT id, lead_id FROM call_logs WHERE id = ? LIMIT 1", args: [callRef] })).rows[0];
  }
  if (!row && phloId) {
    const hits = (await db.execute({ sql: "SELECT id, lead_id FROM call_logs WHERE phlo_id = ?", args: [phloId] })).rows;
    if (hits.length === 1) row = hits[0];
    else if (hits.length > 1) {
      return c.json({ ok: true, ignored: "ambiguous phlo_id (flow-level id, not unique per call)", matches: hits.length });
    }
  }
  if (!row) return c.json({ ok: true, ignored: "unknown call" });
  if (apiId) {
    await db.execute({
      sql: "UPDATE call_logs SET plivo_api_id = COALESCE(plivo_api_id, ?) WHERE id = ?",
      args: [apiId, row.id]
    });
  }
  const transcript = pick(src, "transcript", "conversation", "dialogue");
  const summary = pick(src, "summary", "call_summary");
  const outcome = pick(src, "outcome", "result", "disposition");
  const duration = Number(src["duration"] ?? src["duration_sec"] ?? NaN);
  const sets = [];
  const vals = [];
  if (mapped) {
    sets.push("status = ?");
    vals.push(mapped.status);
    if (mapped.ended) {
      sets.push("ended_at = ?");
      vals.push((/* @__PURE__ */ new Date()).toISOString());
    }
  }
  if (transcript) {
    sets.push("transcript = ?");
    vals.push(transcript);
  }
  if (summary) {
    sets.push("summary = ?");
    vals.push(summary);
  }
  if (outcome) {
    sets.push("outcome = ?");
    vals.push(outcome);
  }
  if (Number.isFinite(duration) && duration > 0) {
    sets.push("duration_sec = ?");
    vals.push(Math.round(duration));
  }
  if (sets.length) {
    vals.push(row.id);
    await db.execute({ sql: `UPDATE call_logs SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  }
  if (mapped) {
    await db.execute({
      sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'call', ?, ?, ?, ?)",
      args: [
        crypto.randomUUID(),
        row.lead_id,
        mapped.status,
        summary ?? `AI call ${mapped.status.replace("_", " ")}`,
        row.id,
        (/* @__PURE__ */ new Date()).toISOString()
      ]
    });
  }
  return c.json({ success: true, call_id: row.id, status: mapped?.status ?? null });
});
var plivo_webhook_default = router7;

// src/routes/admin.ts
import { Hono as Hono8 } from "hono";
import { z as z6 } from "zod";
import bcrypt2 from "bcryptjs";
var router8 = new Hono8();
router8.use("/*", async (c, next) => {
  const admin = await authenticateAdmin(c);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  c.set("admin", admin);
  await next();
});
var createUserSchema = z6.object({
  name: z6.string().min(1).optional(),
  email: z6.string().email(),
  password: z6.string().min(6),
  is_admin: z6.boolean().optional(),
  gmail_email: z6.string().email().optional().or(z6.literal("")),
  gmail_app_password: z6.string().optional().or(z6.literal(""))
});
var updateEmailCredsSchema = z6.object({
  gmail_email: z6.string().email().optional().or(z6.literal("")),
  gmail_app_password: z6.string().optional().or(z6.literal(""))
});
var resetPasswordSchema = z6.object({ password: z6.string().min(6) });
var USER_COLUMNS = "id, name, email, is_admin, disabled, gmail_email, created_at";
function shapeUser(r) {
  return { ...r, is_admin: !!r.is_admin, disabled: !!r.disabled, has_gmail: !!r.gmail_email };
}
router8.get("/users", async (c) => {
  const db = await getDb();
  const rows = (await db.execute(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC`)).rows;
  return c.json(rows.map(shapeUser));
});
router8.post("/users", async (c) => {
  try {
    const data = createUserSchema.parse(await c.req.json());
    const db = await getDb();
    const email = data.email.toLowerCase().trim();
    const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0];
    if (existing) return c.json({ error: "Email already registered" }, 409);
    const hash = await bcrypt2.hash(data.password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (name, email, password_hash, is_admin, gmail_email, gmail_app_password) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        data.name?.trim() || null,
        email,
        hash,
        data.is_admin ? 1 : 0,
        data.gmail_email?.trim() || null,
        data.gmail_app_password?.trim() || null
      ]
    });
    const userId = Number(result.lastInsertRowid);
    const user = (await db.execute({ sql: `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, args: [userId] })).rows[0];
    return c.json(shapeUser(user));
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router8.post("/users/:id/email-credentials", async (c) => {
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
        args: [email, appPassword, id]
      });
      return c.json({ success: true });
    } else {
      await db.execute({ sql: "UPDATE users SET gmail_email = ? WHERE id = ?", args: [email, id] });
    }
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router8.delete("/users/:id", async (c) => {
  const admin = c.get("admin");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  if (id === admin.id) return c.json({ error: "You cannot delete your own account" }, 400);
  const db = await getDb();
  await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [id] });
  return c.json({ success: true });
});
router8.post("/users/:id/disable", async (c) => {
  const admin = c.get("admin");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  if (id === admin.id) return c.json({ error: "You cannot disable your own account" }, 400);
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET disabled = 1 WHERE id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
  return c.json({ success: true });
});
router8.post("/users/:id/enable", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET disabled = 0 WHERE id = ?", args: [id] });
  return c.json({ success: true });
});
router8.post("/users/:id/reset-password", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
    const data = resetPasswordSchema.parse(await c.req.json());
    const db = await getDb();
    const hash = await bcrypt2.hash(data.password, 10);
    await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, id] });
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router8.post("/users/:id/generate-password", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  const db = await getDb();
  const password = generateToken().slice(0, 12);
  const hash = await bcrypt2.hash(password, 10);
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, id] });
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
  return c.json({ success: true, password });
});
var admin_default = router8;

// src/routes/knowledge.ts
import { Hono as Hono9 } from "hono";
import { z as z7 } from "zod";

// src/lib/crawler.ts
var USER_AGENT = "GradLeadAI-KnowledgeBot/1.0";
var FETCH_TIMEOUT_MS = 8e3;
var ROBOTS_TIMEOUT_MS = 4e3;
var MAX_PAGE_BYTES = 2e6;
function clampLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 100;
  return Math.max(1, Math.min(500, Math.round(v)));
}
function clampDepth(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.max(0, Math.min(5, Math.round(v)));
}
function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]) {
      u.searchParams.delete(p);
    }
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}
function globToRegExp(pattern) {
  const escaped = pattern.trim().replace(/^\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}`);
}
function pathAllowed(pathname, include, exclude) {
  const p = pathname.replace(/^\//, "");
  if (exclude.some((pat) => globToRegExp(pat).test(p))) return false;
  if (include.length === 0) return true;
  return include.some((pat) => globToRegExp(pat).test(p));
}
function splitPaths(raw) {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,*/*" }
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchRobots(origin) {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`, ROBOTS_TIMEOUT_MS);
    if (!res || !res.ok) return [];
    const text = await res.text();
    const disallow = [];
    let applies = false;
    for (const line of text.split("\n")) {
      const l = line.replace(/#.*/, "").trim();
      if (!l) continue;
      const [key, ...rest] = l.split(":");
      const k = key.trim().toLowerCase();
      const v = rest.join(":").trim();
      if (k === "user-agent") applies = v === "*" || v.toLowerCase().includes("gradlead");
      else if (k === "disallow" && applies && v) disallow.push(v);
    }
    return disallow;
  } catch {
    return [];
  }
}
function extractLinks(html, base) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while (m = re.exec(html)) {
    const href = m[1] ?? m[2] ?? m[3] ?? "";
    const abs = normalizeUrl(href, base);
    if (abs) out.push(abs);
  }
  return out;
}
function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function getCrawlJob(db, jobId) {
  const row = (await db.execute({ sql: "SELECT * FROM kb_crawl_jobs WHERE id = ?", args: [jobId] })).rows[0];
  return row ?? null;
}
async function startCrawl(db, kbId, opts) {
  const startUrl = normalizeUrl(opts.sourceUrl);
  if (!startUrl) throw new Error("Enter a valid http(s) website URL.");
  const host = new URL(startUrl).host;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const prev = (await db.execute({
    sql: "SELECT id FROM kb_sources WHERE kb_id = ? AND type = 'url' AND name = ?",
    args: [kbId, host]
  })).rows;
  for (const p of prev) await deleteSourceChunks(db, kbId, p.id);
  await db.execute({ sql: "DELETE FROM kb_sources WHERE kb_id = ? AND type = 'url' AND name = ?", args: [kbId, host] });
  await db.execute({ sql: "DELETE FROM kb_crawl_jobs WHERE kb_id = ? AND host = ?", args: [kbId, host] });
  const sourceId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO kb_sources (id, kb_id, type, name, status, created_at) VALUES (?, ?, 'url', ?, 'crawling', ?)",
    args: [sourceId, kbId, host, now]
  });
  const frontier = [{ url: startUrl, depth: 0 }];
  await db.execute({
    sql: `INSERT INTO kb_crawl_jobs
      (id, kb_id, source_id, source_url, host, limit_pages, max_depth, include_paths, exclude_paths,
       status, pages_found, pages_done, frontier, visited, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 0, ?, '[]', ?, ?)`,
    args: [
      jobId,
      kbId,
      sourceId,
      startUrl,
      host,
      clampLimit(opts.limit),
      clampDepth(opts.maxDepth),
      (opts.includePaths ?? []).join(","),
      (opts.excludePaths ?? []).join(","),
      JSON.stringify(frontier),
      now,
      now
    ]
  });
  return { jobId, sourceId };
}
async function processCrawl(db, jobId, budgetMs = 25e3) {
  const job = await getCrawlJob(db, jobId);
  if (!job) throw new Error("Crawl job not found");
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job;
  if (!job.source_id) throw new Error("Crawl job has no source");
  const started = Date.now();
  const include = splitPaths(job.include_paths);
  const exclude = splitPaths(job.exclude_paths);
  const visited = new Set(parseJson(job.visited, []));
  const frontier = parseJson(job.frontier, []);
  const origin = new URL(job.source_url).origin;
  const robots = await fetchRobots(origin);
  const disallowed = (u) => {
    try {
      const p = new URL(u).pathname;
      return robots.includes("/") || robots.some((d) => d !== "/" && p.startsWith(d));
    } catch {
      return true;
    }
  };
  let done = job.pages_done;
  let status = "running";
  let error = null;
  await db.execute({ sql: "UPDATE kb_crawl_jobs SET status = 'running', updated_at = ? WHERE id = ?", args: [(/* @__PURE__ */ new Date()).toISOString(), jobId] });
  try {
    while (frontier.length && done < job.limit_pages && Date.now() - started < budgetMs) {
      const item = frontier.shift();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      const res = await fetchWithTimeout(item.url, FETCH_TIMEOUT_MS);
      if (!res || !res.ok) {
        done++;
        continue;
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (!/text\/html|text\/plain|application\/xhtml/i.test(ctype)) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_PAGE_BYTES) continue;
      const body = new TextDecoder().decode(buf);
      const isHtml = /html/i.test(ctype);
      const text = isHtml ? htmlToText(body) : body;
      if (text.length > 40) await addChunks(db, job.kb_id, job.source_id, chunkText(text));
      done++;
      if (isHtml && item.depth < job.max_depth) {
        for (const link of extractLinks(body, item.url)) {
          if (visited.has(link)) continue;
          let lhost;
          let lpath;
          try {
            const lu = new URL(link);
            lhost = lu.host;
            lpath = lu.pathname;
          } catch {
            continue;
          }
          if (lhost !== job.host) continue;
          if (!pathAllowed(lpath, include, exclude)) continue;
          if (disallowed(link)) continue;
          if (frontier.some((f) => f.url === link)) continue;
          frontier.push({ url: link, depth: item.depth + 1 });
        }
      }
      await db.execute({
        sql: "UPDATE kb_crawl_jobs SET pages_done = ?, pages_found = ?, frontier = ?, visited = ?, updated_at = ? WHERE id = ?",
        args: [done, done + frontier.length, JSON.stringify(frontier), JSON.stringify(Array.from(visited)), (/* @__PURE__ */ new Date()).toISOString(), jobId]
      });
    }
    status = frontier.length && done < job.limit_pages ? "paused" : "done";
  } catch (e) {
    status = "failed";
    error = e.message;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: "UPDATE kb_crawl_jobs SET status = ?, pages_done = ?, pages_found = ?, frontier = ?, visited = ?, error = ?, updated_at = ? WHERE id = ?",
    args: [status, done, done + frontier.length, JSON.stringify(frontier), JSON.stringify(Array.from(visited)), error, now, jobId]
  });
  await db.execute({
    sql: "UPDATE kb_sources SET status = ?, fetched_at = ? WHERE id = ?",
    args: [status === "done" ? "ready" : status, now, job.source_id]
  });
  return await getCrawlJob(db, jobId);
}
async function cancelCrawl(db, jobId) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({ sql: "UPDATE kb_crawl_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?", args: [now, jobId] });
  const job = await getCrawlJob(db, jobId);
  if (job?.source_id) {
    await db.execute({ sql: "UPDATE kb_sources SET status = 'ready', fetched_at = ? WHERE id = ?", args: [now, job.source_id] });
  }
  return job;
}

// src/routes/knowledge.ts
var router9 = new Hono9();
async function loadKb(db, user) {
  return getOrCreateKb(db, user.id, user.name ?? user.email);
}
router9.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const sections = (await db.execute({
    sql: "SELECT * FROM kb_sections WHERE kb_id = ? ORDER BY position ASC, created_at ASC",
    args: [kb.id]
  })).rows;
  const entries = (await db.execute({
    sql: "SELECT * FROM kb_entries WHERE kb_id = ? ORDER BY position ASC, created_at ASC",
    args: [kb.id]
  })).rows;
  const sources = (await db.execute({
    sql: "SELECT id, type, name, status, fetched_at, created_at FROM kb_sources WHERE kb_id = ? ORDER BY created_at DESC",
    args: [kb.id]
  })).rows;
  const crawlJobs = (await db.execute({
    sql: "SELECT id, source_id, source_url, host, limit_pages, max_depth, status, pages_found, pages_done, error, created_at, updated_at FROM kb_crawl_jobs WHERE kb_id = ? ORDER BY created_at DESC LIMIT 10",
    args: [kb.id]
  })).rows;
  return c.json({ kb, sections, entries, sources, crawlJobs });
});
var profileSchema = z7.object({
  title: z7.string().max(200).optional(),
  tagline: z7.string().max(300).optional(),
  description: z7.string().max(4e3).optional(),
  contact_email: z7.string().max(200).optional(),
  contact_phone: z7.string().max(60).optional(),
  contact_website: z7.string().max(300).optional(),
  contact_address: z7.string().max(400).optional(),
  slug: z7.string().max(60).optional()
});
router9.put("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = profileSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  const sets = [];
  const vals = [];
  for (const key of ["title", "tagline", "description", "contact_email", "contact_phone", "contact_website", "contact_address"]) {
    if (data[key] !== void 0) {
      sets.push(`${key} = ?`);
      vals.push(data[key]?.trim() || null);
    }
  }
  if (data.slug !== void 0) {
    const slug = slugify(data.slug);
    if (!isValidSlug(slug)) return c.json({ error: "That URL slug is not allowed \u2014 use letters, numbers and dashes." }, 400);
    if (slug !== kb.slug) {
      const taken = (await db.execute({ sql: "SELECT id FROM knowledge_bases WHERE slug = ? AND id != ?", args: [slug, kb.id] })).rows[0];
      if (taken) return c.json({ error: "That URL is already taken." }, 409);
      sets.push("slug = ?");
      vals.push(slug);
    }
  }
  sets.push("updated_at = ?");
  vals.push((/* @__PURE__ */ new Date()).toISOString());
  vals.push(kb.id);
  await db.execute({ sql: `UPDATE knowledge_bases SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const row = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [kb.id] })).rows[0];
  return c.json(row);
});
var sectionSchema = z7.object({
  kind: z7.string().max(40).optional(),
  title: z7.string().max(200).optional(),
  body: z7.string().max(2e4).optional(),
  position: z7.number().optional()
});
router9.post("/sections", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = sectionSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  const id = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO kb_sections (id, kb_id, kind, title, body, position) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, kb.id, d.kind ?? "custom", d.title ?? null, d.body ?? null, d.position ?? 0]
  });
  const row = (await db.execute({ sql: "SELECT * FROM kb_sections WHERE id = ?", args: [id] })).rows[0];
  await touch(db, kb.id);
  return c.json(row);
});
router9.put("/sections/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = sectionSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!await ownsRow(db, "kb_sections", c.req.param("id"), kb.id)) return c.json({ error: "Not found" }, 404);
  const sets = [];
  const vals = [];
  if (d.kind !== void 0) {
    sets.push("kind = ?");
    vals.push(d.kind);
  }
  if (d.title !== void 0) {
    sets.push("title = ?");
    vals.push(d.title);
  }
  if (d.body !== void 0) {
    sets.push("body = ?");
    vals.push(d.body);
  }
  if (d.position !== void 0) {
    sets.push("position = ?");
    vals.push(d.position);
  }
  if (sets.length) {
    vals.push(c.req.param("id"));
    await db.execute({ sql: `UPDATE kb_sections SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  }
  await touch(db, kb.id);
  return c.json({ success: true });
});
router9.delete("/sections/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!await ownsRow(db, "kb_sections", c.req.param("id"), kb.id)) return c.json({ error: "Not found" }, 404);
  await db.execute({ sql: "DELETE FROM kb_sections WHERE id = ?", args: [c.req.param("id")] });
  await touch(db, kb.id);
  return c.json({ success: true });
});
var entrySchema = z7.object({
  question: z7.string().max(500).optional(),
  answer: z7.string().max(8e3).optional(),
  tags: z7.string().max(300).optional(),
  position: z7.number().optional()
});
router9.post("/entries", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = entrySchema.parse(await c.req.json());
  if (!d.question?.trim() || !d.answer?.trim()) return c.json({ error: "Question and answer are required" }, 400);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const id = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO kb_entries (id, kb_id, question, answer, tags, position) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, kb.id, d.question.trim(), d.answer.trim(), d.tags ?? null, d.position ?? 0]
  });
  const row = (await db.execute({ sql: "SELECT * FROM kb_entries WHERE id = ?", args: [id] })).rows[0];
  await touch(db, kb.id);
  return c.json(row);
});
router9.put("/entries/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = entrySchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!await ownsRow(db, "kb_entries", c.req.param("id"), kb.id)) return c.json({ error: "Not found" }, 404);
  const sets = [];
  const vals = [];
  if (d.question !== void 0) {
    sets.push("question = ?");
    vals.push(d.question);
  }
  if (d.answer !== void 0) {
    sets.push("answer = ?");
    vals.push(d.answer);
  }
  if (d.tags !== void 0) {
    sets.push("tags = ?");
    vals.push(d.tags);
  }
  if (d.position !== void 0) {
    sets.push("position = ?");
    vals.push(d.position);
  }
  if (sets.length) {
    vals.push(c.req.param("id"));
    await db.execute({ sql: `UPDATE kb_entries SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  }
  await touch(db, kb.id);
  return c.json({ success: true });
});
router9.delete("/entries/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!await ownsRow(db, "kb_entries", c.req.param("id"), kb.id)) return c.json({ error: "Not found" }, 404);
  await db.execute({ sql: "DELETE FROM kb_entries WHERE id = ?", args: [c.req.param("id")] });
  await touch(db, kb.id);
  return c.json({ success: true });
});
var MAX_FILE_BYTES = 2e6;
var fileSchema = z7.object({
  files: z7.array(z7.object({
    filename: z7.string().min(1).max(255),
    contentType: z7.string().max(120).optional(),
    data: z7.string().min(1)
  })).min(1).max(10)
});
function fileToText(filename, contentType, buffer) {
  const name = filename.toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  const isHtml = /\.(html?|xhtml)$/.test(name) || ct.includes("html");
  if (isHtml) return htmlToText(buffer.toString("utf8"));
  const textLike = /\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|log|rtf)$/.test(name) || /^text\//.test(ct) || /json|xml|csv|javascript|yaml/.test(ct);
  if (!textLike) return null;
  return buffer.toString("utf8");
}
router9.post("/files", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = fileSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  const indexed = [];
  const skipped = [];
  for (const f of d.files) {
    const buffer = Buffer.from(f.data, "base64");
    if (buffer.byteLength > MAX_FILE_BYTES) {
      skipped.push({ filename: f.filename, reason: "too large (max 2 MB)" });
      continue;
    }
    const text = fileToText(f.filename, f.contentType, buffer);
    if (text === null) {
      skipped.push({ filename: f.filename, reason: "unsupported file type (use text, Markdown, CSV, JSON, HTML)" });
      continue;
    }
    const chunks = chunkText(text);
    if (!chunks.length) {
      skipped.push({ filename: f.filename, reason: "no readable text found" });
      continue;
    }
    const sourceId = crypto.randomUUID();
    await db.execute({
      sql: "INSERT INTO kb_sources (id, kb_id, type, name, status, fetched_at) VALUES (?, ?, 'file', ?, 'ready', ?)",
      args: [sourceId, kb.id, f.filename, (/* @__PURE__ */ new Date()).toISOString()]
    });
    await addChunks(db, kb.id, sourceId, chunks);
    indexed.push({ filename: f.filename, chunks: chunks.length });
  }
  await touch(db, kb.id);
  return c.json({ success: true, indexed, skipped });
});
router9.delete("/sources/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!await ownsRow(db, "kb_sources", c.req.param("id"), kb.id)) return c.json({ error: "Not found" }, 404);
  await deleteSource(db, kb.id, c.req.param("id"));
  return c.json({ success: true });
});
router9.post("/publish", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!kb.slug || !isValidSlug(kb.slug)) return c.json({ error: "Set a valid URL slug before publishing" }, 400);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({ sql: "UPDATE knowledge_bases SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?", args: [now, now, kb.id] });
  const row = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [kb.id] })).rows[0];
  return c.json(row);
});
router9.post("/unpublish", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  await db.execute({ sql: "UPDATE knowledge_bases SET status = 'draft', updated_at = ? WHERE id = ?", args: [(/* @__PURE__ */ new Date()).toISOString(), kb.id] });
  const row = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [kb.id] })).rows[0];
  return c.json(row);
});
var crawlSchema = z7.object({
  source_url: z7.string().min(1).max(2e3),
  limit: z7.number().optional(),
  max_depth: z7.number().optional(),
  include_paths: z7.string().max(500).optional(),
  exclude_paths: z7.string().max(500).optional()
});
router9.post("/crawl", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = crawlSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  try {
    const { jobId } = await startCrawl(db, kb.id, {
      sourceUrl: d.source_url,
      limit: d.limit,
      maxDepth: d.max_depth,
      includePaths: (d.include_paths ?? "").split(","),
      excludePaths: (d.exclude_paths ?? "").split(",")
    });
    const job = await processCrawl(db, jobId, 2e4);
    return c.json(job);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router9.get("/crawl/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const job = await getCrawlJob(db, c.req.param("id"));
  if (!job || job.kb_id !== kb.id) return c.json({ error: "Not found" }, 404);
  return c.json(job);
});
router9.post("/crawl/:id/resume", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const job = await getCrawlJob(db, c.req.param("id"));
  if (!job || job.kb_id !== kb.id) return c.json({ error: "Not found" }, 404);
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return c.json(job);
  if (job.status === "paused") {
    await db.execute({ sql: "UPDATE kb_crawl_jobs SET status = 'queued' WHERE id = ?", args: [job.id] });
  }
  return c.json(await processCrawl(db, job.id, 2e4));
});
router9.post("/crawl/:id/cancel", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const job = await getCrawlJob(db, c.req.param("id"));
  if (!job || job.kb_id !== kb.id) return c.json({ error: "Not found" }, 404);
  return c.json(await cancelCrawl(db, job.id));
});
router9.post("/preview", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { query } = z7.object({ query: z7.string().max(500) }).parse(await c.req.json());
  const db = await getDb();
  const context = await getKnowledgeContext(db, user.id, query ?? "");
  return c.json({ context });
});
async function ownsRow(db, table, id, kbId) {
  const row = (await db.execute({ sql: `SELECT id FROM ${table} WHERE id = ? AND kb_id = ?`, args: [id, kbId] })).rows[0];
  return !!row;
}
async function touch(db, kbId) {
  await db.execute({ sql: "UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", args: [(/* @__PURE__ */ new Date()).toISOString(), kbId] });
}
var knowledge_default = router9;

// src/routes/public.ts
import { Hono as Hono10 } from "hono";
var router10 = new Hono10();
router10.get("/kb/:slug", async (c) => {
  const db = await getDb();
  const kb = await getPublicKb(db, c.req.param("slug"));
  if (!kb) return c.json({ error: "Knowledge base not found" }, 404);
  c.header("Cache-Control", "public, max-age=60");
  return c.json(kb);
});
var public_default = router10;

// src/index.ts
var extraOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
var app = new Hono11();
app.use("/*", cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://rosybrown-pig-742740.hostingersite.com",
    ...extraOrigins
  ],
  credentials: true
}));
app.route("/api/auth", auth_default);
app.route("/api/leads", leads_default);
app.route("/api/messages", messages_default);
app.route("/api/ai", ai_default);
app.route("/api/conversations", conversations_default);
app.route("/api/webhooks/whatsapp", whatsapp_webhook_default);
app.route("/api/webhooks/plivo", plivo_webhook_default);
app.route("/api/admin", admin_default);
app.route("/api/knowledge", knowledge_default);
app.route("/api/public", public_default);
app.get("/api/health", (c) => c.json({ status: "ok" }));
app.onError((err, c) => {
  console.error("[onError]", err);
  return c.json({ error: "Internal Server Error" }, 500);
});
var index_default = app;
if (process.env.NODE_ENV !== "production") {
  const port = parseInt(process.env.PORT ?? "3001");
  console.log(`Backend running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
} else {
  console.log("GradLeadAI backend in serverless mode \u2014 no listener started.");
}

// src/vercel.ts
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : void 0));
    req.on("error", reject);
  });
}
async function toWebRequest(req) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === void 0) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readBody(req);
  }
  return new Request(url, { method: req.method ?? "GET", headers, body });
}
async function sendNodeResponse(res, response) {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
  res.end(Buffer.from(await response.arrayBuffer()));
}
async function handler(req, res) {
  try {
    const response = await index_default.fetch(await toWebRequest(req));
    await sendNodeResponse(res, response);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
}
export {
  handler as default
};
