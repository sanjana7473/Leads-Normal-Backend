// Gmail SMTP mail client — replaces the earlier AgentMail integration.
//
// Sending: nodemailer over Gmail SMTP, authenticated with a Gmail App
// Password (NOT the account password — Gmail requires 2FA + an app-specific
// password for SMTP basic auth: https://support.google.com/mail/answer/185833).
//
// Receiving/inbox sync was removed from the product, so this module is
// send-only: no IMAP client and no mail parsing remain.
import nodemailer from "nodemailer";

export interface MailerConfig {
  user: string;
  appPassword: string;
  imapHost: string;
  smtpHost: string;
}

/** Falls back to the global GMAIL_USER/GMAIL_APP_PASSWORD env vars — used only
 * when no per-user config is supplied (e.g. scripts, or before multi-tenant
 * routing was added). Routes should pass each user's own config instead. */
export function mailerConfig(): MailerConfig {
  const user = process.env.GMAIL_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com",
  };
}

// One transporter per Gmail account (multi-tenant — each user sends from
// their own inbox), keyed by address. Small map, never evicted; the process
// only lives for the duration of a serverless invocation anyway.
const transporters = new Map<string, ReturnType<typeof nodemailer.createTransport>>();
function getTransporter(cfg: MailerConfig) {
  let t = transporters.get(cfg.user);
  if (!t) {
    t = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: 465,
      secure: true,
      auth: { user: cfg.user, pass: cfg.appPassword },
    });
    transporters.set(cfg.user, t);
  }
  return t;
}

export interface SentMessage {
  message_id: string | null;
  thread_id: string | null;
}

/** One file attached to an outbound email (nodemailer attachment shape). */
export interface MailAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
}

/** Send an email from the given (or global default) Gmail account. */
export async function sendMessage(
  args: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: MailAttachment[];
  },
  cfg: MailerConfig = mailerConfig()
): Promise<SentMessage> {
  const info = await getTransporter(cfg).sendMail({
    from: cfg.user,
    to: args.to,
    subject: args.subject,
    text: args.text,
    ...(args.html ? { html: args.html } : {}),
    ...(args.attachments && args.attachments.length ? { attachments: args.attachments } : {}),
  });
  // Gmail SMTP doesn't return a thread id at send time — messageId is the only
  // identifier available on the send path.
  return { message_id: info.messageId ?? null, thread_id: null };
}

