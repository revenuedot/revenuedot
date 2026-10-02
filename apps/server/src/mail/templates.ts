/**
 * Email templates: text and HTML, in DESIGN.md's tokens (white, near-black ink, grey hairlines, square corners, the gold
 * dot). Inline styles only, no remote images, no tracking pixels. The footer names the product and links to
 * notification settings; it never carries a street address.
 */

export interface Rendered { subject: string; text: string; html: string }

const LOGO_URL = "https://revenuedot.app/brand/revenuedot-lockup-black@2x.png";
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
  /** Numbered sections under the paragraphs (the weekly insights digest): a title, lines of text and an optional link. */
  blocks?: { title: string; lines: string[]; link?: { label: string; url: string } }[];
  /** Small print under the button (plain text). */
  after?: string[];
  /** A hairline table of figures (label, value, change) between the paragraphs and the button: the weekly summary. */
  table?: { head?: [string, string, string]; rows: [string, string, string][] };
  /** Where "Notification settings" in the footer points. */
  settingsUrl: string;
  /** Opt-in emails (the weekly summary, experiment results, anomaly alerts): the one-click unsubscribe link. */
  unsubscribeUrl?: string;
  /** Why the reader got this email. */
  reason: string;
}

function layout(l: Layout): Rendered {
  const p = (t: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK};">${esc(t)}</p>`;
  const small = (t: string) => `<p style="margin:0 0 12px;font-size:13px;line-height:20px;color:${FG2};">${esc(t)}</p>`;
  const cell = (t: string, o: { right?: boolean; muted?: boolean; head?: boolean } = {}) =>
    `<td style="padding:${o.head ? "0 0 8px" : "10px 0"};border-bottom:1px solid ${BORDER};font-size:${o.head ? 11 : 14}px;line-height:20px;${o.head ? `font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${FG3};` : `color:${o.muted ? FG2 : INK};`}${o.right ? "text-align:right;font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;" : ""}">${esc(t)}</td>`;
  const table = l.table
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border-collapse:collapse;">` +
      (l.table.head ? `<tr>${cell(l.table.head[0], { head: true })}${cell(l.table.head[1], { head: true, right: true })}${cell(l.table.head[2], { head: true, right: true })}</tr>` : "") +
      l.table.rows.map(([a, b, c]) => `<tr>${cell(a)}${cell(b, { right: true })}${cell(c, { right: true, muted: true })}</tr>`).join("") +
      `</table>`
    : "";
  const blocks = (l.blocks ?? []).map((b, i) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-top:1px solid ${BORDER};"><tr><td style="padding:16px 0 0;">` +
    `<p style="margin:0 0 8px;font-size:15px;line-height:22px;font-weight:600;color:${INK};"><span style="font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;color:${FG3};">${i + 1}.</span> ${esc(b.title)}</p>` +
    b.lines.map((t) => `<p style="margin:0 0 8px;font-size:14px;line-height:22px;color:${FG2};">${esc(t)}</p>`).join("") +
    (b.link ? `<p style="margin:0;font-size:13px;line-height:20px;"><a href="${esc(b.link.url)}" style="color:${INK};font-weight:600;">${esc(b.link.label)} →</a></p>` : "") +
    `</td></tr></table>`).join("");
  const button = l.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="background:${INK};">` +
      `<a href="${esc(l.button.url)}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(l.button.label)}</a>` +
      `</td></tr></table>` +
      small("Or paste this link into your browser:") +
      `<p style="margin:0 0 20px;font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;word-break:break-all;"><a href="${esc(l.button.url)}" style="color:${INK};">${esc(l.button.url)}</a></p>`
    : "";
  // The brand lockup (rounded R with the gold dot, then the wordmark): brand/kit/wordmark, served from the site. Email
  // clients drop SVG, so it is the 2x PNG shown at 168x24. The alt text stands in while images are blocked.
  const mark = `<img src="${LOGO_URL}" width="168" height="24" alt="RevenueDot" style="display:block;border:0;outline:none;font-family:${FONT};font-size:15px;font-weight:600;color:${INK};">`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(l.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#FFFFFF;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(l.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${FONT};">` +
    `<tr><td style="padding:0 0 28px;">${mark}</td></tr>` +
    `<tr><td style="border-top:1px solid ${BORDER};padding:28px 0 8px;">` +
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.02em;color:${INK};">${esc(l.heading)}</h1>` +
    l.paragraphs.map(p).join("") + table + blocks + button + (l.after ?? []).map(small).join("") +
    `</td></tr>` +
    `<tr><td style="border-top:1px solid ${BORDER};padding:20px 0 0;font-size:12px;line-height:18px;color:${FG3};">` +
    `${esc(l.reason)}<br>RevenueDot · <a href="${esc(l.settingsUrl)}" style="color:${FG3};">Notification settings</a>` +
    (l.unsubscribeUrl ? ` · <a href="${esc(l.unsubscribeUrl)}" style="color:${FG3};">Unsubscribe</a>` : "") +
    `</td></tr></table></td></tr></table></body></html>`;
  const text = [
    l.heading, "",
    ...l.paragraphs.flatMap((t) => [t, ""]),
    ...(l.table ? [...l.table.rows.map(([a, b, c]) => `${a}: ${b}${c ? ` (${c})` : ""}`), ""] : []),
    ...(l.blocks ?? []).flatMap((b, i) => [`${i + 1}. ${b.title}`, ...b.lines, ...(b.link ? [`${b.link.label}: ${b.link.url}`] : []), ""]),
    ...(l.button ? [`${l.button.label}: ${l.button.url}`, ""] : []),
    ...(l.after ?? []).flatMap((t) => [t, ""]),
    "--",
    l.reason,
    `RevenueDot · Notification settings: ${l.settingsUrl}`,
    ...(l.unsubscribeUrl ? [`Unsubscribe: ${l.unsubscribeUrl}`] : []),
  ].join("\n");
  return { subject: l.subject, text, html };
}

export const settingsUrl = (base: string) => `${base}/account/notifications`;
/** Account settings → Security, where sessions, two-factor and the password live. */
export const securityUrl = (base: string) => `${base}/account/security`;

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

/** Project ownership changed (prd/project-settings §1): one email to the new owner, one to the previous owner. */
export function ownershipEmail(o: { base: string; url: string; projectName: string; from: string; to: string; you: "new" | "old" }): Rendered {
  const isNew = o.you === "new";
  return layout({
    subject: isNew ? `You now own ${o.projectName} on RevenueDot` : `${o.to} now owns ${o.projectName} on RevenueDot`,
    preheader: isNew ? `${o.from} transferred the project to you.` : `You transferred ${o.projectName} to ${o.to}.`,
    heading: isNew ? `You now own ${o.projectName}` : `${o.projectName} has a new owner`,
    paragraphs: isNew
      ? [`${o.from} transferred ownership of the project ${o.projectName} to you.`, "As the owner you can transfer the project again. Your role stays Admin."]
      : [`You transferred ownership of the project ${o.projectName} to ${o.to}.`, "You keep the Admin role. Only the new owner can transfer the project again."],
    button: { label: "Open project settings", url: o.url },
    after: ["If you did not expect this, contact the other person or reply to this email."],
    settingsUrl: settingsUrl(o.base),
    reason: `You received this because you are ${isNew ? "the new" : "the previous"} owner of a RevenueDot project.`,
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

/** A Customer Center support ticket, to the project's support address; Reply-To is the customer. */
export function supportTicketEmail(o: { base: string; projectName: string; appName: string | null; customerEmail: string; description: string; details: [string, string][]; url: string }): Rendered {
  return layout({
    subject: `Support request from ${o.customerEmail}${o.appName ? ` (${o.appName})` : ""}`,
    preheader: o.description.slice(0, 120),
    heading: `New support request in ${o.projectName}`,
    paragraphs: [`${o.customerEmail} wrote from the Customer Center${o.appName ? ` in ${o.appName}` : ""}:`, o.description, ...o.details.map(([k, v]) => `${k}: ${v}`)],
    button: { label: "Open the ticket", url: o.url },
    after: ["Reply to this email to answer the customer directly."],
    settingsUrl: settingsUrl(o.base),
    reason: `You received this because this address is the Customer Center support email of ${o.projectName}.`,
  });
}

/**
 * A win-back email to an app's customer. It speaks for the app, not for RevenueDot: the app's name on top, the developer's
 * text, one button, and an unsubscribe link. An open-tracking image is added only when the campaign asks for it.
 */
export function winbackEmail(o: { appName: string; subject: string; heading: string; body: string; buttonLabel: string; offerUrl: string; unsubscribeUrl: string; pixelUrl?: string | null; reason?: string }): Rendered {
  const paras = o.body.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#FFFFFF;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${FONT};">` +
    `<tr><td style="padding:0 0 20px;font-size:15px;font-weight:600;color:${INK};">${esc(o.appName)}</td></tr>` +
    `<tr><td style="border-top:1px solid ${BORDER};padding:28px 0 8px;">` +
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.02em;color:${INK};">${esc(o.heading)}</h1>` +
    paras.map((t) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK};">${esc(t)}</p>`).join("") +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="background:${INK};">` +
    `<a href="${esc(o.offerUrl)}" style="display:inline-block;padding:12px 20px;font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(o.buttonLabel)}</a>` +
    `</td></tr></table></td></tr>` +
    `<tr><td style="border-top:1px solid ${BORDER};padding:20px 0 0;font-size:12px;line-height:18px;color:${FG3};">` +
    `${esc(o.reason ?? `You received this because you subscribed to ${o.appName}.`)} <a href="${esc(o.unsubscribeUrl)}" style="color:${FG3};">Unsubscribe</a>` +
    `</td></tr></table></td></tr></table>` +
    (o.pixelUrl ? `<img src="${esc(o.pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">` : "") +
    `</body></html>`;
  const text = [o.heading, "", ...paras.flatMap((t) => [t, ""]), `${o.buttonLabel}: ${o.offerUrl}`, "", "--", `${o.reason ?? `You received this because you subscribed to ${o.appName}.`} Unsubscribe: ${o.unsubscribeUrl}`].join("\n");
  return { subject: o.subject, text, html };
}

/**
 * A payment recovery email (prd/payment-recovery/PRD.md): from the app, in the win-back layout, with the "Update payment"
 * link and an unsubscribe link. No tracking pixel.
 */
export function recoveryEmail(o: { appName: string; subject: string; heading: string; body: string; buttonLabel: string; linkUrl: string; unsubscribeUrl: string }): Rendered {
  return winbackEmail({
    appName: o.appName, subject: o.subject, heading: o.heading, body: o.body, buttonLabel: o.buttonLabel, offerUrl: o.linkUrl, unsubscribeUrl: o.unsubscribeUrl,
    reason: `You received this because a payment for your ${o.appName} subscription failed.`,
  });
}

/**
 * The one-time link a customer asked for from the Customer Center to update their payment (prd/payment-recovery/PRD.md,
 * "Customer Center path"). From the app, in the win-back layout.
 */
export function portalLinkEmail(o: { appName: string; linkUrl: string; unsubscribeUrl: string; minutes: number }): Rendered {
  return winbackEmail({
    appName: o.appName, subject: `Your link to update your payment for ${o.appName}`, heading: "Update your payment method",
    body: `You asked to update your payment method for ${o.appName}. Use the button below within ${o.minutes} minutes. It works once.\n\nIf you did not ask for this, you can ignore this email. Nothing changes.`,
    buttonLabel: "Update payment", offerUrl: o.linkUrl, unsubscribeUrl: o.unsubscribeUrl,
    reason: `You received this because you asked for it in ${o.appName}.`,
  });
}

/** The weekly AI growth insights digest (prd/attribution-benchmarks-insights §3): numbers from the data pack, no customer ids. */
export function insightsDigestEmail(o: {
  base: string; projectName: string; week: string; overviewUrl: string; unsubscribeUrl: string | null;
  insights: { title: string; finding: string; recommendation: string; numbers: string[]; url: string }[];
}): Rendered {
  const n = o.insights.length;
  const weekLabel = new Date(`${o.week}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  return layout({
    subject: `${o.projectName}: ${n} growth ideas for the week of ${weekLabel}`,
    preheader: o.insights[0]?.title ?? "This week's growth insights",
    heading: `${n} growth ideas for ${o.projectName}`,
    paragraphs: [`RevenueDot AI read your charts for the week of ${weekLabel} and picked what to act on. Every number below comes from your own data.`],
    blocks: o.insights.map((i) => ({ title: i.title, lines: [...(i.numbers.length ? [i.numbers.join(" · ")] : []), i.finding, `What to do: ${i.recommendation}`], link: { label: "Open the chart", url: i.url } })),
    button: { label: "Open the Overview", url: o.overviewUrl },
    after: [o.unsubscribeUrl ? `Stop the weekly digest: ${o.unsubscribeUrl}` : "Turn the weekly digest off in your notification settings."],
    settingsUrl: settingsUrl(o.base),
    reason: `You received this because you are an admin of ${o.projectName} and the weekly insights digest is on.`,
  });
}

/* ---- RevenueDot Cloud billing (prd/cloud-billing/PRD.md) ---- */

export const billingUrl = (base: string) => `${base}/account/billing`;

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 });

/** Usage thresholds: Free at 80% and 100% of its limit, Standard at its cap and near the Enterprise ceiling. */
export function billingUsageEmail(o: { base: string; kind: "free_80" | "free_100" | "cap" | "ceiling_80" | "ceiling_100"; month: string; tracked: number; limit: number; bill?: number }): Rendered {
  const monthName = new Date(`${o.month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const t = {
    free_80: { subject: `You have used 80% of RevenueDot Cloud Free for ${monthName}`, heading: "80% of your free tracked revenue is used", body: [`Your apps tracked ${usd(o.tracked)} in ${monthName}. Cloud Free covers up to ${usd(o.limit)} a month.`, "Nothing stops working when you pass it. Upgrade to Cloud Standard to keep growing: 0.5% of tracked revenue above $10,000, never more than $999 a month."], button: "See your usage" },
    free_100: { subject: `Your apps passed RevenueDot Cloud Free's ${usd(o.limit)} for ${monthName}`, heading: "Time to move to Cloud Standard", body: [`Your apps tracked ${usd(o.tracked)} in ${monthName}, above Cloud Free's ${usd(o.limit)}.`, "Everything keeps working: purchases, webhooks and the dashboard. Upgrade to Cloud Standard to stay on a plan that fits: 0.5% of tracked revenue above $10,000, capped at $999 a month."], button: "Upgrade to Standard" },
    cap: { subject: `Your RevenueDot bill for ${monthName} reached the $999 cap`, heading: "You will not pay more this month", body: [`Your apps tracked ${usd(o.tracked)} in ${monthName}, so your Cloud Standard bill reached its cap of ${usd(o.bill ?? 999)}.`, "Revenue above this point is free for the rest of the month."], button: "See your usage" },
    ceiling_80: { subject: `Your apps are near Cloud Standard's ${usd(o.limit)} a month`, heading: "Close to the Standard plan's ceiling", body: [`Your apps tracked ${usd(o.tracked)} in ${monthName}. Cloud Standard is for apps up to ${usd(o.limit)} a month.`, "Above that, RevenueDot Enterprise adds a support promise, single sign-on and data-location controls. Reply to this email to talk about it."], button: "See your usage" },
    ceiling_100: { subject: `Your apps passed ${usd(o.limit)} tracked revenue in ${monthName}`, heading: "Your apps outgrew Cloud Standard", body: [`Your apps tracked ${usd(o.tracked)} in ${monthName}, above Cloud Standard's ${usd(o.limit)} a month.`, "Nothing changes in your apps. Reply to this email and we will set up RevenueDot Enterprise with you."], button: "See your usage" },
  }[o.kind];
  return layout({
    subject: t.subject, preheader: t.body[0]!, heading: t.heading, paragraphs: t.body, button: { label: t.button, url: billingUrl(o.base) },
    settingsUrl: settingsUrl(o.base), reason: "You received this because you own projects on RevenueDot Cloud.",
  });
}

/** Dunning: a payment failed (Stripe retries), or the retries ran out and the account went back to Free. */
export function billingPaymentEmail(o: { base: string; kind: "failed" | "unpaid" | "recovered"; amount: number; invoiceUrl?: string | null }): Rendered {
  const t = {
    failed: { subject: "Your RevenueDot payment failed", heading: "We could not charge your card", body: [`The payment of ${usd(o.amount)} for RevenueDot Cloud did not go through. Stripe tries again over the next days.`, "Your apps keep working. Update your card to settle the invoice."], button: "Update payment method" },
    unpaid: { subject: "Your RevenueDot subscription moved to Cloud Free", heading: "Your account is back on Cloud Free", body: [`We could not collect ${usd(o.amount)} after several tries, so your account moved to Cloud Free.`, "Your apps keep working. Upgrade again from the Billing page whenever you are ready."], button: "Open billing" },
    recovered: { subject: "Your RevenueDot payment went through", heading: "Thanks, you are all set", body: [`We received your payment of ${usd(o.amount)}. Your Cloud Standard plan is active.`], button: "Open billing" },
  }[o.kind];
  return layout({
    subject: t.subject, preheader: t.body[0]!, heading: t.heading, paragraphs: t.body, button: { label: t.button, url: billingUrl(o.base) },
    after: o.invoiceUrl ? [`Invoice: ${o.invoiceUrl}`] : [], settingsUrl: settingsUrl(o.base), reason: "You received this because you pay for RevenueDot Cloud.",
  });
}

/* ---- Account settings (prd/account-settings/PRD.md) ---- */

/** To the new address: the link that moves the account to it. */
export function emailChangeConfirmEmail(o: { base: string; url: string; oldEmail: string; newEmail: string }): Rendered {
  return layout({
    subject: "Confirm your new email for RevenueDot",
    preheader: `Move your RevenueDot account from ${o.oldEmail} to this address.`,
    heading: "Confirm your new email address",
    paragraphs: [`Someone signed in to the RevenueDot account ${o.oldEmail} asked to change its email to ${o.newEmail}. Confirm that this address is yours and the account moves to it.`],
    button: { label: "Confirm new email", url: o.url },
    after: ["The link works once and expires in 24 hours. Until you confirm, the account keeps its old address.", "If you did not ask for this, ignore this email: nothing changes."],
    settingsUrl: settingsUrl(o.base),
    reason: "You received this because this address was entered as the new email of a RevenueDot account.",
  });
}

/** To the old address: a change was asked for, or has happened. */
export function emailChangeNoticeEmail(o: { base: string; oldEmail: string; newEmail: string; state: "requested" | "changed" }): Rendered {
  const asked = o.state === "requested";
  return layout({
    subject: asked ? "Your RevenueDot email is about to change" : "Your RevenueDot email was changed",
    preheader: asked ? `A change to ${o.newEmail} is waiting for confirmation.` : `Your account now signs in with ${o.newEmail}.`,
    heading: asked ? "Someone asked to change your email" : "Your email was changed",
    paragraphs: asked
      ? [`Someone signed in to your RevenueDot account asked to change its email from ${o.oldEmail} to ${o.newEmail}. The change happens only when the link we sent to ${o.newEmail} is used.`, "If this was not you, change your password now and sign out every other session in Account settings → Security."]
      : [`Your RevenueDot account now uses ${o.newEmail}. Sign in with that address from now on; this address gets no more email about the account.`, "If this was not you, reply to this email at once so we can lock the account."],
    button: { label: asked ? "Review security settings" : "Open the dashboard", url: asked ? securityUrl(o.base) : o.base },
    settingsUrl: settingsUrl(o.base),
    reason: "You received this because this address belongs, or belonged, to a RevenueDot account.",
  });
}

export function passwordChangedEmail(o: { base: string; email: string }): Rendered {
  return layout({
    subject: "Your RevenueDot password was changed",
    preheader: "Every other session was signed out.",
    heading: "Your password was changed",
    paragraphs: [`The password of the RevenueDot account ${o.email} was just changed, and every other signed-in browser was signed out.`, "If this was not you, reset your password now with \"Forgot password?\" on the sign-in page."],
    button: { label: "Review security settings", url: securityUrl(o.base) },
    settingsUrl: settingsUrl(o.base),
    reason: "You received this because the password of your RevenueDot account changed.",
  });
}

export type TwoFactorNotice = "enabled" | "disabled" | "recovery_used" | "codes_regenerated";
export function twoFactorEmail(o: { base: string; email: string; kind: TwoFactorNotice; remaining?: number }): Rendered {
  const t = {
    enabled: { subject: "Two-factor authentication is on", heading: "Two-factor authentication is on", body: [`Signing in to ${o.email} now also needs a code from your authenticator app.`, "Keep your recovery codes somewhere safe: each one signs you in once if you lose your phone."] },
    disabled: { subject: "Two-factor authentication is off", heading: "Two-factor authentication was turned off", body: [`Signing in to ${o.email} needs only the password again.`, "If this was not you, change your password now and turn two-factor authentication back on."] },
    recovery_used: { subject: "A recovery code was used to sign in", heading: "A recovery code was used", body: [`Someone signed in to ${o.email} with a recovery code instead of the authenticator app. ${o.remaining ?? 0} recovery code${o.remaining === 1 ? " is" : "s are"} left.`, "If you lost your phone, set up the authenticator app again and make new recovery codes. If this was not you, change your password now."] },
    codes_regenerated: { subject: "New two-factor recovery codes", heading: "You have new recovery codes", body: [`New recovery codes were made for ${o.email}. The old ones no longer work.`] },
  }[o.kind];
  return layout({
    subject: t.subject, preheader: t.body[0]!, heading: t.heading, paragraphs: t.body,
    button: { label: "Review security settings", url: securityUrl(o.base) },
    settingsUrl: settingsUrl(o.base), reason: "You received this because the security settings of your RevenueDot account changed.",
  });
}

export function accountDeletedEmail(o: { base: string; email: string; projects: string[] }): Rendered {
  return layout({
    subject: "Your RevenueDot account was deleted",
    preheader: "The account and its own projects are gone.",
    heading: "Your account was deleted",
    paragraphs: [
      `The RevenueDot account ${o.email} was deleted, with its sessions, keys and settings.`,
      o.projects.length ? `Projects deleted with it: ${o.projects.join(", ")}.` : "No project was deleted: every project you were in has other members.",
      "If you want to come back, sign up again any time.",
    ],
    settingsUrl: o.base,
    reason: "You received this because this address belonged to a RevenueDot account.",
  });
}

/** The weekly summary of one project (figures already formatted in the reader's currency). */
export function weeklySummaryEmail(o: { base: string; projectName: string; weekLabel: string; rows: [string, string, string][]; url: string; headline: string; unsubscribeUrl?: string }): Rendered {
  return layout({
    subject: `${o.projectName}: your week, ${o.weekLabel}`,
    preheader: o.headline,
    heading: `${o.projectName}, ${o.weekLabel}`,
    paragraphs: [o.headline],
    table: { head: ["Metric", "This week", "Vs last week"], rows: o.rows },
    button: { label: "Open the charts", url: o.url },
    after: ["Production purchases only, from the same numbers as the Charts page. Weeks start on the day you chose in Date and region."],
    settingsUrl: settingsUrl(o.base), unsubscribeUrl: o.unsubscribeUrl,
    reason: `You received this because you turned on the weekly summary for ${o.projectName}.`,
  });
}

export function experimentResultEmail(o: { base: string; projectName: string; experimentName: string; kind: "enough_data" | "ended"; rows: [string, string, string][]; verdict: string; url: string; unsubscribeUrl?: string }): Rendered {
  const enough = o.kind === "enough_data";
  return layout({
    subject: enough ? `${o.experimentName} has enough data to read` : `${o.experimentName} ended`,
    preheader: o.verdict,
    heading: enough ? `${o.experimentName} has enough data` : `${o.experimentName} ended`,
    paragraphs: [enough ? `Both variants of the experiment ${o.experimentName} in ${o.projectName} have at least 100 customers.` : `The experiment ${o.experimentName} in ${o.projectName} was stopped. These are its final results.`, o.verdict],
    table: { head: ["Variant", "Conversion", "Revenue per customer"], rows: o.rows },
    button: { label: "Open the experiment", url: o.url },
    settingsUrl: settingsUrl(o.base), unsubscribeUrl: o.unsubscribeUrl,
    reason: `You received this because you turned on experiment results for ${o.projectName}.`,
  });
}

export function anomalyEmail(o: { base: string; projectName: string; day: string; lines: { title: string; text: string }[]; url: string; sensitivity: string; unsubscribeUrl?: string }): Rendered {
  const first = o.lines[0]!;
  return layout({
    subject: `${o.projectName}: ${first.title.toLowerCase()} on ${o.day}`,
    preheader: first.text,
    heading: `${o.projectName}: unusual ${o.day}`,
    paragraphs: o.lines.map((l) => `${l.title}. ${l.text}`),
    button: { label: "Open the chart", url: o.url },
    after: [`Compared with the 28 days before, at ${o.sensitivity} sensitivity. A sudden drop often means a broken paywall, a failing store connection or an app update; a spike, a feature or a promotion.`],
    settingsUrl: settingsUrl(o.base), unsubscribeUrl: o.unsubscribeUrl,
    reason: `You received this because you turned on revenue anomaly alerts for ${o.projectName}.`,
  });
}
