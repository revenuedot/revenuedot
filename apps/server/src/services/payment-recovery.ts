import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { newId, type DerivedEvent } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { isEmailAddress, trySend, type Mailer } from "../mail/index.js";
import { recoveryEmail } from "../mail/templates.js";
import { supportSettingsFor } from "./customer-center.js";
import { withStoreSecrets } from "./store-secrets.js";
import type { StripeConnectConfig } from "./stripe-connect-config.js";
import { idOf, StripeApiError } from "../stores/stripe/api.js";
import { stripeClientFor } from "../stores/stripe/index.js";
import type { StoreAdapter } from "../stores/types.js";

/**
 * Failed-payment recovery (prd/payment-recovery/PRD.md). A case opens when a subscription chain gets a billing issue (any
 * store), the tick emails the customer on the project's schedule with a link to fix the payment, and a renewal of the chain
 * within the window closes the case as recovered, attributed to RevenueDot when an email went out first.
 */

export interface RecoveryStep { day: number; subject: string; heading: string; body: string; button_label: string }
export interface RecoverySettings {
  enabled: boolean;
  steps: RecoveryStep[];
  window_days: number;
  include_sandbox: boolean;
  sender_name: string | null;
  /** Where links in emails point when the server has no REVENUEDOT_PUBLIC_URL (the origin the settings were saved from). */
  link_base?: string | null;
}

export const DEFAULT_STEPS: RecoveryStep[] = [
  { day: 0, subject: "Your payment for {app} didn't go through", heading: "Update your payment method", body: "We couldn't charge your payment method for your {app} subscription.\n\nUpdate your payment details to keep your access. It takes less than a minute.", button_label: "Update payment" },
  { day: 3, subject: "Action needed: keep your {app} subscription", heading: "Your subscription is at risk", body: "Your last payment for {app} still hasn't gone through.\n\nUpdate your payment method so you don't lose access.", button_label: "Update payment" },
  { day: 7, subject: "Last reminder: your {app} subscription", heading: "Don't lose your subscription", body: "We still can't process your payment for {app}.\n\nUpdate your payment method today to keep your subscription.", button_label: "Update payment" },
];
export const DEFAULT_SETTINGS: RecoverySettings = { enabled: false, steps: DEFAULT_STEPS, window_days: 30, include_sandbox: false, sender_name: null };

const DAY = 86_400_000;
/** One tick sends at most this many recovery emails; the rest go in the next minute. */
export const SENDS_PER_TICK = 100;
/** A project's recovery emails in 24 hours (abuse cap for a shared mailer). */
export const PROJECT_DAILY_MAX = 2_000;

export function settingsOf(raw: Record<string, unknown> | null | undefined): RecoverySettings {
  const r = (raw ?? {}) as Partial<RecoverySettings>;
  const steps = Array.isArray(r.steps) && r.steps.length ? r.steps : DEFAULT_STEPS;
  return {
    enabled: r.enabled === true, steps: [...steps].sort((a, b) => a.day - b.day),
    window_days: typeof r.window_days === "number" ? r.window_days : DEFAULT_SETTINGS.window_days,
    include_sandbox: r.include_sandbox === true, sender_name: typeof r.sender_name === "string" && r.sender_name.trim() ? r.sender_name.trim() : null,
    link_base: typeof r.link_base === "string" ? r.link_base : null,
  };
}

export async function projectSettings(db: DB, projectId: string) {
  const [p] = await db.select({ s: schema.projects.recoverySettings, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return { settings: settingsOf(p?.s), projectName: p?.name ?? "Your app" };
}

const dueAt = (detected: Date, s: RecoverySettings, step: number) => (step < s.steps.length ? new Date(detected.getTime() + s.steps[step]!.day * DAY) : null);

const token = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type CaseRow = typeof schema.recoveryCases.$inferSelect;

/**
 * Called by the purchase pipeline after a subscription chain changed (services/purchases.ts): opens a case on BILLING_ISSUE,
 * closes the open one as recovered on RENEWAL, or as lost on a refund. Never throws into the purchase path.
 */
export async function trackRecovery(db: DB, o: {
  projectId: string; customerId: string; subscriptionId: string; appId: string | null; store: string; storeKey: string; productId: string; isSandbox: boolean;
  derived: DerivedEvent[]; billingIssuesDetectedAt: Date | null; gracePeriodExpiresAt: Date | null; priceUsd: number | null; transactionId: string; now: Date;
}) {
  try {
    const types = new Set(o.derived.map((d) => d.type));
    const refund = o.derived.some((d) => d.type === "CANCELLATION" && d.isRefund);
    const [open] = await db.select().from(schema.recoveryCases)
      .where(and(eq(schema.recoveryCases.projectId, o.projectId), eq(schema.recoveryCases.store, o.store), eq(schema.recoveryCases.storeKey, o.storeKey), eq(schema.recoveryCases.status, "open"))).limit(1);
    if (open && types.has("RENEWAL")) {
      const { settings } = await projectSettings(db, o.projectId);
      const inWindow = o.now.getTime() <= open.detectedAt.getTime() + settings.window_days * DAY;
      await db.update(schema.recoveryCases).set(inWindow ? {
        status: "recovered", resolvedAt: o.now, recoveredTransactionId: o.transactionId, recoveredUsd: o.priceUsd ?? 0,
        attributed: !!open.firstSentAt && open.firstSentAt <= o.now, nextStepAt: null, updatedAt: o.now,
      } : { status: "lost", lostReason: "window_passed", resolvedAt: o.now, nextStepAt: null, updatedAt: o.now }).where(eq(schema.recoveryCases.id, open.id));
    } else if (open && refund) {
      await db.update(schema.recoveryCases).set({ status: "lost", lostReason: "refunded", resolvedAt: o.now, nextStepAt: null, updatedAt: o.now }).where(eq(schema.recoveryCases.id, open.id));
    } else if (open && o.customerId !== open.customerId) {
      // The chain moved to another customer (a transfer or merge): the case follows it.
      await db.update(schema.recoveryCases).set({ customerId: o.customerId, updatedAt: o.now }).where(eq(schema.recoveryCases.id, open.id));
    }
    // A new billing issue in the same change as a recovery (rare) opens the next case.
    // A chain first seen already in a billing issue (an import, a first webhook) derives INITIAL_PURCHASE, not BILLING_ISSUE.
    const issueNow = types.has("BILLING_ISSUE") || (types.has("INITIAL_PURCHASE") && !!o.billingIssuesDetectedAt && !refund);
    if (issueNow && (!open || types.has("RENEWAL") || refund)) {
      const { settings } = await projectSettings(db, o.projectId);
      const detected = o.billingIssuesDetectedAt && o.billingIssuesDetectedAt <= o.now ? o.billingIssuesDetectedAt : o.now;
      // A billing issue already older than the window (imported history) can never be recovered: no case, so it never
      // shows up as a fresh loss in the numbers.
      if (detected.getTime() + settings.window_days * DAY < o.now.getTime()) return;
      await db.insert(schema.recoveryCases).values({
        id: newId("rcv_", 16), projectId: o.projectId, customerId: o.customerId, subscriptionId: o.subscriptionId, appId: o.appId, store: o.store, storeKey: o.storeKey,
        productId: o.productId, isSandbox: o.isSandbox, status: "open", detectedAt: detected, graceExpiresAt: o.gracePeriodExpiresAt, atRiskUsd: o.priceUsd,
        nextStepAt: dueAt(detected, settings, 0), token: token(), createdAt: o.now, updatedAt: o.now,
      }).onConflictDoNothing();
    } else if (open && !types.has("RENEWAL") && !refund && o.gracePeriodExpiresAt && (!open.graceExpiresAt || open.graceExpiresAt.getTime() !== o.gracePeriodExpiresAt.getTime())) {
      await db.update(schema.recoveryCases).set({ graceExpiresAt: o.gracePeriodExpiresAt, updatedAt: o.now }).where(eq(schema.recoveryCases.id, open.id));
    }
  } catch (e) {
    console.error(`payment recovery: tracking ${o.store} ${o.storeKey} failed`, e);
  }
}

/** Fills `{app}` in the copy with the app's name. */
export const fill = (s: string, app: string) => s.replace(/\{app\}/g, app);

export function renderStep(step: RecoveryStep, appName: string, base: string, tok: string) {
  return recoveryEmail({
    appName, subject: fill(step.subject, appName), heading: fill(step.heading, appName), body: fill(step.body, appName), buttonLabel: fill(step.button_label, appName),
    linkUrl: `${base}/v1/recovery/l/${tok}`, unsubscribeUrl: `${base}/v1/recovery/u/${tok}`,
  });
}

export interface RecoveryDeps {
  db: DB; mailer?: Mailer; now: () => Date; publicUrl?: string;
  /** For Stripe customers without an `$email`: read the Stripe customer's address. */
  stores?: Record<string, StoreAdapter>; fetch?: typeof fetch; encryptionKey?: string; signingKey?: string; stripeConnect?: StripeConnectConfig;
}

/** The customer's address: the case's, the `$email` attribute, or (Stripe) the Stripe customer's. */
async function emailFor(d: RecoveryDeps, c: CaseRow): Promise<string | null> {
  if (c.email && isEmailAddress(c.email)) return c.email;
  const [a] = await d.db.select({ v: schema.customerAttributes.value }).from(schema.customerAttributes)
    .where(and(eq(schema.customerAttributes.customerId, c.customerId), eq(schema.customerAttributes.key, "$email"))).limit(1);
  const attr = a?.v?.trim();
  if (attr && isEmailAddress(attr)) return attr;
  if (c.store !== "stripe" || !c.appId) return null;
  try {
    const [row] = await d.db.select().from(schema.apps).where(eq(schema.apps.id, c.appId)).limit(1);
    if (!row) return null;
    const app = await withStoreSecrets(d, row);
    const { client } = stripeClientFor(d.stores ?? {}, d.fetch);
    const sub = await client.subscription(app, c.storeKey);
    const customer = idOf(sub.customer);
    if (!customer) return null;
    const cus = await client.get<{ email?: string | null }>(app, `/v1/customers/${encodeURIComponent(customer)}`);
    const e = cus.email?.trim();
    return e && isEmailAddress(e) ? e : null;
  } catch (e) {
    console.warn(`payment recovery: reading the Stripe customer of ${c.storeKey} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function suppressed(db: DB, projectId: string, email: string) {
  const [s] = await db.select({ e: schema.emailSuppressions.email }).from(schema.emailSuppressions)
    .where(and(eq(schema.emailSuppressions.projectId, projectId), eq(schema.emailSuppressions.email, email.toLowerCase()))).limit(1);
  return !!s;
}

/**
 * Sends the due step of one case: the latest step whose day has come (earlier ones that were never sent are skipped). The
 * case is claimed first, so two ticks never send the same step. Returns "sent", "failed", "skipped" or "capped".
 */
export async function sendDueStep(d: RecoveryDeps, c: CaseRow, base: string, o: { settings: RecoverySettings; projectName: string; replyTo?: string }): Promise<"sent" | "failed" | "skipped" | "capped"> {
  const { db } = d;
  const now = d.now();
  const s = o.settings;
  const [{ n: lastDay }] = await db.select({ n: count() }).from(schema.recoveryMessages)
    .where(and(eq(schema.recoveryMessages.projectId, c.projectId), gte(schema.recoveryMessages.sentAt, new Date(now.getTime() - DAY)), isNull(schema.recoveryMessages.error))) as [{ n: number }];
  if (Number(lastDay) >= PROJECT_DAILY_MAX) return "capped";
  let step = c.stepsSent;
  while (step + 1 < s.steps.length && dueAt(c.detectedAt, s, step + 1)! <= now) step++;
  const next = dueAt(c.detectedAt, s, step + 1);
  // Claim: only the tick that moves next_step_at on sends.
  const claimed = await db.update(schema.recoveryCases).set({ nextStepAt: next, stepsSent: step + 1, updatedAt: now })
    .where(and(eq(schema.recoveryCases.id, c.id), eq(schema.recoveryCases.status, "open"), eq(schema.recoveryCases.stepsSent, c.stepsSent))).returning({ id: schema.recoveryCases.id });
  if (!claimed.length) return "skipped";
  const skip = async (reason: string, stop = false) => {
    await db.update(schema.recoveryCases).set({ skipReason: reason, ...(stop ? { nextStepAt: null } : {}), updatedAt: now }).where(eq(schema.recoveryCases.id, c.id));
    return "skipped" as const;
  };
  // The store may have settled the issue since the case opened; nothing goes out then.
  const [sub] = c.subscriptionId ? await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, c.subscriptionId)).limit(1) : [];
  if (!sub || !sub.billingIssuesDetectedAt || sub.refundedAt) return skip("issue_cleared", true);
  const email = await emailFor(d, c);
  if (!email) return skip("no_email");
  if (c.unsubscribedAt || await suppressed(db, c.projectId, email)) return skip("unsubscribed", true);
  const appName = s.sender_name ?? o.projectName;
  const mail = renderStep(s.steps[step]!, appName, base, c.token);
  const unsubscribe = `${base}/v1/recovery/u/${c.token}`;
  const ok = await trySend(d.mailer, {
    to: email, ...mail, replyTo: o.replyTo, fromName: appName,
    ...(unsubscribe.startsWith("https://") ? { headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
  });
  await db.insert(schema.recoveryMessages).values({ id: newId("rcm_", 16), caseId: c.id, projectId: c.projectId, step, email, sentAt: now, error: ok ? null : "The mailer did not accept the email." });
  await db.update(schema.recoveryCases).set(ok
    ? { email, firstSentAt: c.firstSentAt ?? now, lastSentAt: now, skipReason: null, updatedAt: now }
    : { email, skipReason: "mailer_failed", updatedAt: now }).where(eq(schema.recoveryCases.id, c.id));
  return ok ? "sent" : "failed";
}

/**
 * The tick: closes cases whose window passed, then sends due steps for projects with recovery on (at most SENDS_PER_TICK).
 * `onlyProject` runs one project now ("Run now").
 */
export async function runPaymentRecovery(d: RecoveryDeps, o: { onlyProject?: string; limit?: number } = {}) {
  const { db } = d;
  const now = d.now();
  const C = schema.recoveryCases, Pj = schema.projects;
  const closed = await db.execute(sql`UPDATE recovery_cases c SET status = 'lost', lost_reason = 'window_passed', resolved_at = ${now.toISOString()}::timestamptz, next_step_at = NULL, updated_at = ${now.toISOString()}::timestamptz
    FROM projects p WHERE p.id = c.project_id AND c.status = 'open'
      AND c.detected_at + make_interval(days => coalesce((p.recovery_settings->>'window_days')::int, 30)) < ${now.toISOString()}::timestamptz
      ${o.onlyProject ? sql`AND c.project_id = ${o.onlyProject}` : sql``}
    RETURNING c.id`);
  const closedCount = (Array.isArray(closed) ? closed : (closed as { rows: unknown[] }).rows).length;
  const limit = o.limit ?? SENDS_PER_TICK;
  // Cases that cannot go out now (their project hit its daily cap, or has no address for links) stay due but are not picked,
  // so they never fill the batch and hold back other projects' emails.
  const dayAgo = new Date(now.getTime() - DAY).toISOString();
  const underCap = sql`(SELECT count(*) FROM recovery_messages m WHERE m.project_id = "recovery_cases"."project_id" AND m.sent_at >= ${dayAgo}::timestamptz AND m.error IS NULL) < ${PROJECT_DAILY_MAX}`;
  const hasBase = d.publicUrl ? sql`TRUE` : sql`coalesce(${Pj.recoverySettings}->>'link_base', '') <> ''`;
  const due = await db.select({ c: C, s: Pj.recoverySettings, name: Pj.name }).from(C).innerJoin(Pj, eq(Pj.id, C.projectId))
    .where(and(eq(C.status, "open"), lte(C.nextStepAt, now), sql`(${Pj.recoverySettings}->>'enabled')::boolean IS TRUE`, underCap, hasBase,
      or(eq(C.isSandbox, false), sql`(${Pj.recoverySettings}->>'include_sandbox')::boolean IS TRUE`),
      ...(o.onlyProject ? [eq(C.projectId, o.onlyProject)] : [])))
    .orderBy(asc(C.nextStepAt)).limit(limit);
  let sent = 0, failed = 0, skipped = 0;
  const replyTos = new Map<string, string | undefined>();
  for (const row of due) {
    const settings = settingsOf(row.s);
    const base = d.publicUrl ?? settings.link_base;
    if (!base) { skipped++; continue; }
    if (!replyTos.has(row.c.projectId)) {
      const support = await supportSettingsFor(db, row.c.projectId);
      replyTos.set(row.c.projectId, isEmailAddress(support.email) && !support.email.endsWith("@example.com") ? support.email : undefined);
    }
    try {
      const r = await sendDueStep(d, row.c, base, { settings, projectName: row.name, replyTo: replyTos.get(row.c.projectId) });
      if (r === "sent") sent++; else if (r === "failed") failed++; else skipped++;
    } catch (e) {
      console.error(`payment recovery: case ${row.c.id} failed`, e);
      failed++;
    }
  }
  return { sent, failed, skipped, closed: closedCount };
}

// ---------- Links ----------

export async function caseByToken(db: DB, tok: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(tok)) return null;
  const [c] = await db.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.token, tok)).limit(1);
  return c ?? null;
}

export type Destination = { kind: "redirect"; url: string } | { kind: "page"; title: string; body: string };

/** Where the "Update payment" link leads for this case (prd/payment-recovery/PRD.md, "The link in the email"). */
export async function destinationFor(d: Pick<Deps, "db" | "stores" | "fetch" | "encryptionKey" | "signingKey" | "stripeConnect">, c: CaseRow, returnUrl: string): Promise<Destination> {
  if (c.store === "app_store" || c.store === "mac_app_store") return { kind: "redirect", url: "https://apps.apple.com/account/billing" };
  if (c.store === "amazon") return { kind: "redirect", url: "https://www.amazon.com/yourmembershipsandsubscriptions" };
  if (c.store === "play_store") {
    const [app] = c.appId ? await d.db.select({ b: schema.apps.bundleId }).from(schema.apps).where(eq(schema.apps.id, c.appId)).limit(1) : [];
    const q = new URLSearchParams({ sku: c.productId.split(":")[0]!, ...(app?.b ? { package: app.b } : {}) });
    return { kind: "redirect", url: `https://play.google.com/store/account/subscriptions?${q}` };
  }
  if (c.store === "test_store") return { kind: "page", title: "This is a test purchase", body: "The subscription was bought in the Test Store, so there is no payment method to update. In production this link opens the store's payment page." };
  if (c.store === "stripe" && c.appId) {
    const contact = { kind: "page" as const, title: "Update your payment method", body: "We could not open the payment page. Reply to the email you got, and the app's support team will help you." };
    const [row] = await d.db.select().from(schema.apps).where(eq(schema.apps.id, c.appId)).limit(1);
    if (!row) return contact;
    try {
      const app = await withStoreSecrets(d, row);
      const { client } = stripeClientFor(d.stores, d.fetch);
      const sub = await client.subscription(app, c.storeKey);
      const customer = idOf(sub.customer);
      if (!customer) return contact;
      try {
        const portal = await client.post<{ url: string }>(app, "/v1/billing_portal/sessions", { customer, return_url: returnUrl, flow_data: { type: "payment_method_update" } });
        if (portal.url) return { kind: "redirect", url: portal.url };
      } catch (e) {
        // The portal is not set up in the developer's account (or the key cannot open it): the open invoice's own page.
        if (!(e instanceof StripeApiError) || e.kind === "transient") throw e;
        console.warn(`payment recovery: Stripe portal for ${c.storeKey} failed: ${e.message}`);
      }
      const inv = sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice as { status?: string | null; hosted_invoice_url?: string | null } : null;
      if (inv?.status === "open" && inv.hosted_invoice_url) return { kind: "redirect", url: inv.hosted_invoice_url };
      return contact;
    } catch (e) {
      console.warn(`payment recovery: Stripe link for ${c.storeKey} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { kind: "page", title: "Try again in a minute", body: "The payment page could not be opened right now. Try the link again in a minute." };
    }
  }
  return { kind: "page", title: "Update your payment method", body: "Open the store you subscribed in and update your payment method there." };
}

export async function markClicked(db: DB, c: CaseRow, now: Date) {
  if (!c.clickedAt) await db.update(schema.recoveryCases).set({ clickedAt: now, updatedAt: now }).where(eq(schema.recoveryCases.id, c.id));
}

export async function unsubscribeCase(db: DB, c: CaseRow, now: Date) {
  const email = c.email?.toLowerCase();
  if (email) await db.insert(schema.emailSuppressions).values({ projectId: c.projectId, email, createdAt: now }).onConflictDoNothing();
  await db.update(schema.recoveryCases).set({ unsubscribedAt: c.unsubscribedAt ?? now, nextStepAt: null, skipReason: "unsubscribed", updatedAt: now }).where(eq(schema.recoveryCases.id, c.id));
}

/** The management URL for customer info while a customer has an open case (the SDKs' Customer Center opens it). */
export async function openCasesOf(db: DB, customerId: string) {
  return db.select({ subscriptionId: schema.recoveryCases.subscriptionId, token: schema.recoveryCases.token, detectedAt: schema.recoveryCases.detectedAt })
    .from(schema.recoveryCases).where(and(eq(schema.recoveryCases.customerId, customerId), eq(schema.recoveryCases.status, "open"))).orderBy(desc(schema.recoveryCases.detectedAt));
}

// ---------- Numbers ----------

export async function recoveryStats(db: DB, projectId: string, o: { days: number; sandbox: boolean; now: Date }) {
  const since = new Date(o.now.getTime() - o.days * DAY);
  const env = sql`c.is_sandbox = ${o.sandbox}`;
  const rows = await db.execute(sql`
    SELECT c.store,
      count(*) FILTER (WHERE c.status = 'open')::int AS at_risk,
      coalesce(sum(c.at_risk_usd) FILTER (WHERE c.status = 'open'), 0)::float8 AS at_risk_usd,
      count(*) FILTER (WHERE c.status = 'recovered' AND c.attributed AND c.resolved_at >= ${since.toISOString()}::timestamptz)::int AS recovered,
      coalesce(sum(c.recovered_usd) FILTER (WHERE c.status = 'recovered' AND c.attributed AND c.resolved_at >= ${since.toISOString()}::timestamptz), 0)::float8 AS recovered_usd,
      count(*) FILTER (WHERE c.status = 'recovered' AND NOT c.attributed AND c.resolved_at >= ${since.toISOString()}::timestamptz)::int AS self_recovered,
      coalesce(sum(c.recovered_usd) FILTER (WHERE c.status = 'recovered' AND NOT c.attributed AND c.resolved_at >= ${since.toISOString()}::timestamptz), 0)::float8 AS self_recovered_usd,
      count(*) FILTER (WHERE c.status = 'lost' AND c.resolved_at >= ${since.toISOString()}::timestamptz)::int AS lost,
      count(*) FILTER (WHERE c.detected_at >= ${since.toISOString()}::timestamptz)::int AS opened
    FROM recovery_cases c WHERE c.project_id = ${projectId} AND ${env} GROUP BY c.store`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as Array<Record<string, number | string>>;
  const [{ n: sent }] = await db.select({ n: count() }).from(schema.recoveryMessages).innerJoin(schema.recoveryCases, eq(schema.recoveryCases.id, schema.recoveryMessages.caseId))
    .where(and(eq(schema.recoveryMessages.projectId, projectId), gte(schema.recoveryMessages.sentAt, since), isNull(schema.recoveryMessages.error), eq(schema.recoveryCases.isSandbox, o.sandbox))) as [{ n: number }];
  const [{ n: clicked }] = await db.select({ n: count() }).from(schema.recoveryCases)
    .where(and(eq(schema.recoveryCases.projectId, projectId), eq(schema.recoveryCases.isSandbox, o.sandbox), gte(schema.recoveryCases.clickedAt, since))) as [{ n: number }];
  const sum = (k: string) => list.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const money = (v: number) => Math.round(v * 100) / 100;
  const recovered = sum("recovered"), selfRecovered = sum("self_recovered"), lost = sum("lost");
  const closed = recovered + selfRecovered + lost;
  return {
    object: "payment_recovery_stats" as const, days: o.days, environment: o.sandbox ? "sandbox" : "production",
    at_risk: { count: sum("at_risk"), revenue_in_usd: money(sum("at_risk_usd")) },
    opened: sum("opened"), messages_sent: Number(sent), clicked: Number(clicked),
    recovered: { count: recovered, revenue_in_usd: money(sum("recovered_usd")) },
    recovered_without_message: { count: selfRecovered, revenue_in_usd: money(sum("self_recovered_usd")) },
    lost: { count: lost },
    recovery_rate: closed ? (recovered + selfRecovered) / closed : null,
    by_store: list.map((r) => ({
      store: String(r.store), at_risk: Number(r.at_risk), recovered: Number(r.recovered), recovered_revenue_in_usd: money(Number(r.recovered_usd)),
      recovered_without_message: Number(r.self_recovered), lost: Number(r.lost),
    })).sort((a, b) => a.store.localeCompare(b.store)),
  };
}

export async function listCases(db: DB, projectId: string, o: { status?: "open" | "recovered" | "lost"; sandbox: boolean; limit: number; startingAfter?: string | null }) {
  const C = schema.recoveryCases;
  let cursor: CaseRow | undefined;
  if (o.startingAfter) [cursor] = await db.select().from(C).where(and(eq(C.projectId, projectId), eq(C.id, o.startingAfter))).limit(1);
  const rows = await db.select({ c: C, appUserId: schema.customers.originalAppUserId }).from(C).innerJoin(schema.customers, eq(schema.customers.id, C.customerId))
    .where(and(eq(C.projectId, projectId), eq(C.isSandbox, o.sandbox), ...(o.status ? [eq(C.status, o.status)] : []),
      ...(cursor ? [or(lt(C.detectedAt, cursor.detectedAt), and(eq(C.detectedAt, cursor.detectedAt), lt(C.id, cursor.id)))] : [])))
    .orderBy(desc(C.detectedAt), desc(C.id)).limit(o.limit + 1);
  const page = rows.slice(0, o.limit);
  const ids = page.map((r) => r.c.id);
  const msgs = ids.length ? await db.select({ caseId: schema.recoveryMessages.caseId, n: count() }).from(schema.recoveryMessages)
    .where(and(inArray(schema.recoveryMessages.caseId, ids), isNull(schema.recoveryMessages.error))).groupBy(schema.recoveryMessages.caseId) : [];
  const custIds = [...new Set(page.map((r) => r.c.customerId))];
  // A readable app user id: the customer's newest non-anonymous alias, else the original one.
  const aliases = custIds.length ? await db.select({ c: schema.customerAliases.customerId, a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(inArray(schema.customerAliases.customerId, custIds)) : [];
  const named = new Map<string, string>();
  for (const a of aliases) if (!a.a.startsWith("$RCAnonymousID:")) named.set(a.c, a.a);
  return {
    items: page.map(({ c, appUserId }) => caseShape(c, named.get(c.customerId) ?? appUserId, Number(msgs.find((m) => m.caseId === c.id)?.n ?? 0))),
    next: rows.length > o.limit ? page[page.length - 1]!.c.id : null,
  };
}

export function caseShape(c: CaseRow, appUserId: string, messages: number) {
  const t = (d: Date | null) => (d ? d.getTime() : null);
  return {
    object: "payment_recovery_case" as const, id: c.id, app_user_id: appUserId, customer_id: c.customerId, store: c.store, app_id: c.appId, product_id: c.productId,
    environment: c.isSandbox ? "sandbox" : "production", status: c.status, detected_at: c.detectedAt.getTime(), grace_period_expires_at: t(c.graceExpiresAt),
    at_risk_in_usd: c.atRiskUsd, email: c.email, messages_sent: messages, next_message_at: c.status === "open" ? t(c.nextStepAt) : null,
    last_message_at: t(c.lastSentAt), clicked_at: t(c.clickedAt), unsubscribed_at: t(c.unsubscribedAt), skip_reason: c.skipReason,
    resolved_at: t(c.resolvedAt), recovered_revenue_in_usd: c.recoveredUsd, attributed: c.attributed, lost_reason: c.lostReason,
  };
}
