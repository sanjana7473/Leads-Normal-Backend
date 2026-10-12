import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import authRoutes from "./routes/auth";
import leadsRoutes from "./routes/leads";
import messagesRoutes from "./routes/messages";
import aiRoutes from "./routes/ai";
import conversationsRoutes from "./routes/conversations";
import whatsappWebhookRoutes from "./routes/whatsapp-webhook";
import plivoWebhookRoutes from "./routes/plivo-webhook";
import adminRoutes from "./routes/admin";
import knowledgeRoutes from "./routes/knowledge";
import publicRoutes from "./routes/public";
import apiKeysRoutes from "./routes/api-keys";
import externalRoutes from "./routes/external";
import voiceToolRoutes from "./routes/voice-tools";
import voiceDashboardRoutes from "./routes/voice-dashboard";

const extraOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = new Hono();

app.use("/*", cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://rosybrown-pig-742740.hostingersite.com",
    ...extraOrigins,
  ],
  credentials: true,
}));

app.route("/api/auth", authRoutes);
app.route("/api/leads", leadsRoutes);
app.route("/api/messages", messagesRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/conversations", conversationsRoutes);
app.route("/api/webhooks/whatsapp", whatsappWebhookRoutes); // public — Meta/bridge webhook
app.route("/api/webhooks/plivo", plivoWebhookRoutes); // public — Agentflow event callbacks
app.route("/api/admin", adminRoutes);
app.route("/api/knowledge", knowledgeRoutes); // authed — owner's own KB
app.route("/api/public", publicRoutes); // public — published KB, read-only
app.route("/api/keys", apiKeysRoutes); // dashboard — manage API keys (session auth)
app.route("/api/voice", voiceDashboardRoutes); // dashboard: callbacks, site visits, call transcripts — session auth
app.route("/api/v1/voice", voiceToolRoutes); // Agentflow voice-agent tools — API-key auth
app.route("/api/v1", externalRoutes); // external REST API — API-key auth (see API.md)

app.get("/api/health", (c) => c.json({ status: "ok" }));

// Log unhandled errors server-side; keep the client response generic.
app.onError((err, c) => {
  console.error("[onError]", err);
  return c.json({ error: "Internal Server Error" }, 500);
});

export default app;

// Local dev only. On Vercel the app is served as a serverless function via
// api/index.ts (see vercel.json), so no listener may be started here.
if (process.env.NODE_ENV !== "production") {
  const port = parseInt(process.env.PORT ?? "3001");
  console.log(`Backend running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
} else {
  console.log("GradLeadAI backend in serverless mode — no listener started.");
}
