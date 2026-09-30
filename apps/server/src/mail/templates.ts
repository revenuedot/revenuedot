/**
 * Email templates: text and HTML, in DESIGN.md's tokens (white, near-black ink, grey hairlines, square corners, the gold
 * dot). Inline styles only, no remote images, no tracking pixels. The footer names the product and links to
 * notification settings; it never carries a street address.
 */

export interface Rendered { subject: string; text: string; html: string }

const INK = "#0A0A0A", FG2 = "#525252", FG3 = "#737373", BORDER = "#E5E5E5", GOLD = "#F7B500";
const FONT = "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface Layout {
  subject: string;
  preheader: string;
  heading: string;
  /** Paragraphs of plain text (escaped for HTML). */
  paragraphs: string[];
  button?: { label: string; url: string };
  /** Small print under the button (plain text). */
  after?: string[];
  /** Where "Notification settings" in the footer points. */
  settingsUrl: string;
  /** Why the reader got this email. */
  reason: string;
}

function layout(l: Layout): Rendered {
  const p = (t: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK};">${esc(t)}</p>`;
  const small = (t: string) => `<p style="margin:0 0 12px;font-size:13px;line-height:20px;color:${FG2};">${esc(t)}</p>`;
  const button = l.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="background:${INK};">` +
      `<a href="${esc(l.button.url)}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(l.button.label)}</a>` +
      `</td></tr></table>` +
      small("Or paste this link into your browser:") +
      `<p style="margin:0 0 20px;font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;word-break:break-all;"><a href="${esc(l.button.url)}" style="color:${INK};">${esc(l.button.url)}</a></p>`
    : "";
  // The mark: a square ink tile with an R, finished by the gold dot.
  const mark = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="width:26px;height:26px;background:${INK};text-align:center;vertical-align:middle;font-family:${FONT};font-size:15px;font-weight:700;line-height:26px;color:#FFFFFF;">R</td>` +
    `<td style="padding:0 0 0 3px;vertical-align:bottom;"><div style="width:7px;height:7px;border-radius:50%;background:${GOLD};font-size:0;line-height:0;">&nbsp;</div></td>` +
    `<td style="padding:0 0 0 10px;font-family:${FONT};font-size:15px;font-weight:600;letter-spacing:-0.02em;color:${INK};">RevenueDot</td>` +
    `</tr></table>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(l.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#FFFFFF;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(l.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${FONT};">` +
    `<tr><td style="padding:0 0 28px;">${mark}</td></tr>` +
    `<tr><td style="border-top:1px solid ${BORDER};padding:28px 0 8px;">` +
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.02em;color:${INK};">${esc(l.heading)}</h1>` +
    l.paragraphs.map(p).join("") + button + (l.after ?? []).map(small).join("") +
    `</td></tr>` +
    `<tr><td style="border-top:1px solid ${BORDER};padding:20px 0 0;font-size:12px;line-height:18px;color:${FG3};">` +
    `${esc(l.reason)}<br>RevenueDot · <a href="${esc(l.settingsUrl)}" style="color:${FG3};">Notification settings</a>` +
    `</td></tr></table></td></tr></table></body></html>`;
  const text = [
    l.heading, "",
    ...l.paragraphs.flatMap((t) => [t, ""]),
    ...(l.button ? [`${l.button.label}: ${l.button.url}`, ""] : []),
    ...(l.after ?? []).flatMap((t) => [t, ""]),
    "--",
    l.reason,
    `RevenueDot · Notification settings: ${l.settingsUrl}`,
  ].join("\n");
  return { subject: l.subject, text, html };
}

export const settingsUrl = (base: string) => `${base}/account`;

export function passwordResetEmail(o: { base: string; url: string }): Rendered {
  return layout({
    subject: "Reset your RevenueDot password",
    preheader: "This link works once and expires in 1 hour.",
    heading: "Reset your password",
    paragraphs: ["Someone asked to reset the password of your RevenueDot account. Choose a new one with the button below."],
    button: { label: "Choose a new password", url: o.url },
    after: ["The link works once and expires in 1 hour. Setting a new password signs you out on every other device.", "If you did not ask for this, ignore this email: your password stays the same."],
    settingsUrl: settingsUrl(o.base),
    reason: "You received this because a password reset was requested for your account.",
  });
}

export function verifyEmail(o: { base: string; url: string }): Rendered {
  return layout({
    subject: "Confirm your email for RevenueDot",
    preheader: "Confirm your address to create secret API keys and invite your team.",
    heading: "Confirm your email address",
    paragraphs: ["Thanks for creating a RevenueDot account. Confirm that this address is yours, so you can create secret API keys, invite your team and get alerts when something breaks."],
    button: { label: "Confirm email", url: o.url },
    after: ["The link expires in 24 hours. If you did not create an account, ignore this email."],
    settingsUrl: settingsUrl(o.base),
    reason: "You received this because this address was used to sign up for RevenueDot.",
  });
}

const ROLE_TEXT: Record<string, string> = {
  admin: "Admin: everything, including inviting and removing people",
  developer: "Developer: apps, catalog, customers and integrations",
  viewer: "Viewer: can see everything and change nothing",
};

export function inviteEmail(o: { base: string; url: string; projectName: string; inviter: string; role: string; expiresInDays: number }): Rendered {
  return layout({
    subject: `${o.inviter} invited you to ${o.projectName} on RevenueDot`,
    preheader: `Join ${o.projectName} as ${o.role}.`,
    heading: `Join ${o.projectName} on RevenueDot`,
    paragraphs: [
      `${o.inviter} invited you to the project ${o.projectName}.`,
      `Your role: ${ROLE_TEXT[o.role] ?? o.role}.`,
    ],
    button: { label: "Accept invite", url: o.url },
    after: [`The invite expires in ${o.expiresInDays} days. If you do not have a RevenueDot account yet, you can create one from the link.`],
    settingsUrl: settingsUrl(o.base),
    reason: `You received this because ${o.inviter} invited this address to a RevenueDot project.`,
  });
}

export type AlertKind = "store_notifications" | "webhook" | "store_credentials";

export interface AlertInfo {
  kind: AlertKind;
  projectName: string;
  /** App or webhook name. */
  subjectName: string;
  /** What the store or the endpoint said, if anything. */
  detail?: string | null;
  /** Where to fix it in the dashboard. */
  url: string;
}

const ALERT_COPY: Record<AlertKind, { open: (a: AlertInfo) => { subject: string; heading: string; body: string[] }; resolved: (a: AlertInfo) => { subject: string; heading: string; body: string[] } }> = {
  store_notifications: {
    open: (a) => ({
      subject: `Store notifications are failing for ${a.subjectName}`,
      heading: `Store notifications are failing for ${a.subjectName}`,
      body: [`RevenueDot could not process the latest server notification for ${a.subjectName} in ${a.projectName}. Renewals, cancellations and refunds can arrive late until this is fixed.`],
    }),
    resolved: (a) => ({ subject: `Resolved: store notifications for ${a.subjectName}`, heading: `Store notifications work again for ${a.subjectName}`, body: [`The latest notification for ${a.subjectName} in ${a.projectName} was processed. Nothing else to do.`] }),
  },
  webhook: {
    open: (a) => ({
      subject: `Webhook ${a.subjectName} is failing`,
      heading: `Webhook ${a.subjectName} is failing`,
      body: [`The last 5 deliveries to the webhook ${a.subjectName} in ${a.projectName} failed. RevenueDot keeps retrying each event 5 times over about 2.5 hours, then gives up; you can resend failed deliveries from the delivery log.`],
    }),
    resolved: (a) => ({ subject: `Resolved: webhook ${a.subjectName}`, heading: `Webhook ${a.subjectName} works again`, body: [`A delivery to ${a.subjectName} in ${a.projectName} succeeded. Check the delivery log for events that failed earlier.`] }),
  },
  store_credentials: {
    open: (a) => ({
      subject: `The store rejected the credentials for ${a.subjectName}`,
      heading: `The store rejected the credentials for ${a.subjectName}`,
      body: [`${a.subjectName} in ${a.projectName} could not authenticate with the store, so RevenueDot cannot check purchases or read subscription changes for it. Upload a working key in the app's settings.`],
    }),
    resolved: (a) => ({ subject: `Resolved: store credentials for ${a.subjectName}`, heading: `The store accepts the credentials for ${a.subjectName} again`, body: [`${a.subjectName} in ${a.projectName} authenticates with the store again.`] }),
  },
};

export function alertEmail(o: AlertInfo & { base: string; state: "open" | "reminder" | "resolved" }): Rendered {
  const c = o.state === "resolved" ? ALERT_COPY[o.kind].resolved(o) : ALERT_COPY[o.kind].open(o);
  return layout({
    subject: o.state === "reminder" ? `Still failing: ${c.subject}` : c.subject,
    preheader: c.body[0]!,
    heading: c.heading,
    paragraphs: [...c.body, ...(o.detail && o.state !== "resolved" ? [`Last error: ${o.detail}`] : [])],
    button: { label: o.state === "resolved" ? "Open the dashboard" : "Fix it in the dashboard", url: o.url },
    after: o.state === "resolved" ? [] : ["You get at most one email a day while this stays broken, and one when it recovers."],
    settingsUrl: settingsUrl(o.base),
    reason: `You received this because you are an admin of ${o.projectName}. Turn these emails off in your notification settings.`,
  });
}
