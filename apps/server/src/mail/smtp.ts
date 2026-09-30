// SMTP driver for self-hosted servers (Node only; the Workers build never imports this file).
// REVENUEDOT_SMTP_URL=smtp://user:pass@host:587 (STARTTLS when the server offers it) or smtps://user:pass@host:465 (TLS).
// Docs: https://revenuedot.app/docs/guides/self-hosting#email
import nodemailer from "nodemailer";
import type { Mailer } from "./index.js";

export function smtpMailer(url: string, from: string, opts: { replyTo?: string; tls?: { rejectUnauthorized?: boolean } } = {}): Mailer {
  const u = new URL(url);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("REVENUEDOT_SMTP_URL must start with smtp:// or smtps://");
  const secure = u.protocol === "smtps:";
  const transport = nodemailer.createTransport({
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    secure,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    tls: opts.tls,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    driver: "smtp",
    async send(msg) {
      const r = await transport.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, replyTo: msg.replyTo ?? opts.replyTo });
      return { id: r.messageId };
    },
  };
}
