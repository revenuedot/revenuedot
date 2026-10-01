/**
 * Outgoing email. One interface, three drivers:
 * - cloudflare: the Workers `send_email` binding (RevenueDot Cloud), see entry.worker.ts.
 * - smtp: REVENUEDOT_SMTP_URL through nodemailer (self-host, Node only), see smtp.ts.
 * - log: nothing configured; the email, links included, goes to the server log.
 * Spec: prd/account-email/PRD.md
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /** Extra headers (List-Unsubscribe on win-back email). The SMTP driver sends them; the Cloudflare binding does not take any. */
  headers?: Record<string, string>;
}

export interface Mailer {
  readonly driver: "cloudflare" | "smtp" | "log" | "memory";
  send(msg: MailMessage): Promise<{ id?: string }>;
}

/** Cloud's sender: its own subdomain, so the hello@ inbox on the apex keeps its own reputation. */
export const CLOUD_FROM = "RevenueDot <no-reply@mail.revenuedot.app>";
export const CLOUD_REPLY_TO = "hello@revenuedot.app";

/** The Workers `send_email` binding (the structured builder). */
export interface SendEmailBinding {
  send(message: { to: string; from: string | { email: string; name?: string }; subject: string; text?: string; html?: string; replyTo?: string }): Promise<{ messageId: string }>;
}

/** Splits `Name <addr@x>` into its parts; a bare address has no name. */
export function parseAddress(from: string): { email: string; name?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return m[1] ? { email: m[2]!.trim(), name: m[1].trim() } : { email: m[2]!.trim() };
  return { email: from.trim() };
}

export function cloudflareMailer(binding: SendEmailBinding, from = CLOUD_FROM, replyTo = CLOUD_REPLY_TO): Mailer {
  return {
    driver: "cloudflare",
    async send(msg) {
      const r = await binding.send({ to: msg.to, from: parseAddress(from), subject: msg.subject, text: msg.text, html: msg.html, replyTo: msg.replyTo ?? replyTo });
      return { id: r.messageId };
    },
  };
}

/** Prints the text part, so a self-hoster without mail can copy a reset or invite link from the log. */
export function logMailer(log: (s: string) => void = (s) => console.log(s)): Mailer {
  return {
    driver: "log",
    async send(msg) {
      log(`[mail] No mail driver is configured (set REVENUEDOT_SMTP_URL to send email). This email was not sent:\n` +
        `To: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n[mail] end`);
      return {};
    },
  };
}

/** Keeps every message in memory: tests and the dashboard e2e server read them back. */
export function memoryMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { driver: "memory", sent, async send(msg) { sent.push(msg); return { id: `mem_${sent.length}` }; } };
}

/**
 * Sends without failing the caller: a mail outage must never break sign-up or the tick. Errors are logged.
 * Returns whether the message was accepted.
 */
export async function trySend(mailer: Mailer | undefined, msg: MailMessage): Promise<boolean> {
  try {
    await (mailer ?? logMailer()).send(msg);
    return true;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    console.error(`[mail] sending "${msg.subject}" to ${msg.to} failed${code ? ` (${code})` : ""}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
