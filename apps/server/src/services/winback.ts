import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { notMoving } from "./archive/moving.js";
import { isEmailAddress, oneClickUnsubscribeHeaders, trySend, type Mailer } from "../mail/index.js";
import { winbackEmail } from "../mail/templates.js";
import { subActive, type LoadedContext } from "./customer-context.js";
import { exactCount } from "./customer-counts.js";
import { contextPages, firstMatches, type ScanFilter } from "./customer-scan.js";
import { supportSettingsFor } from "./customer-center.js";
import { rulesMatch, type Rules } from "./targeting.js";

/**
 * Win-back campaigns (prd/lifecycle/PRD.md): email subscribers who churned an offer, once per customer per campaign, with
 * click (and optionally open) tracking, a one-click unsubscribe, and "reactivated" counted from real transactions.
 */

export type CampaignRow = typeof schema.winbackCampaigns.$inferSelect;
export interface WinbackAudience { churned_min_days: number; churned_max_days: number; product_ids: string[]; stores: string[]; audience_id: string | null }
export interface WinbackEmailContent { subject: string; heading: string; body: string; button_label: string; sender_name?: string | null; link_base?: string | null }
export interface WinbackOffer { type: "store" | "url"; url?: string | null }

export const DEFAULT_AUDIENCE: WinbackAudience = { churned_min_days: 3, churned_max_days: 60, product_ids: [], stores: [], audience_id: null };
const DAY = 86_400_000;
/** At most this many emails per campaign per day (and per "Send now"). */
export const MAX_PER_RUN = 500;
/** One tick sends at most this many win-back emails and looks at most at this many due campaigns; the rest wait a minute. */
export const SENDS_PER_TICK = 100;
export const CAMPAIGNS_PER_TICK = 5;
/** All of a project's campaigns together send at most this many emails in 24 hours (abuse cap for a shared mailer). */
export const PROJECT_DAILY_MAX = 2_000;
/** A purchase this long after the email counts as won back. */
export const REACTIVATION_WINDOW_MS = 30 * DAY;

export const audienceOf = (c: CampaignRow): WinbackAudience => ({ ...DEFAULT_AUDIENCE, ...(c.audience as Partial<WinbackAudience>) });
export const emailOf = (c: CampaignRow) => c.email as unknown as WinbackEmailContent;
export const offerOf = (c: CampaignRow) => c.offer as unknown as WinbackOffer;

export interface Candidate { customerId: string; appUserId: string; email: string; churnedAt: number; productId: string; store: string; bundleId: string | null }

/**
 * Who a campaign would email now (pure): production subscribers with no active subscription whose last subscription ended
 * between `churned_min_days` and `churned_max_days` ago, limited to the campaign's products, stores and saved audience,
 * with an `$email`, not unsubscribed and not emailed by this campaign before.
 */
export function selectCandidates(items: LoadedContext[], a: WinbackAudience, now: number, o: { suppressed: Set<string>; alreadySent: Set<string>; audienceRules?: Rules | null; bundleIds?: Map<string, string | null> }): Candidate[] {
  const out: Candidate[] = [];
  for (const { data, ctx } of items) {
    const email = data.attributes.$email?.trim();
    if (!email || !isEmailAddress(email) || o.suppressed.has(email.toLowerCase()) || o.alreadySent.has(data.customer.id)) continue;
    const subs = data.subs.filter((s) => s.store !== "promotional" && !s.isSandbox);
    if (!subs.length || subs.some((s) => subActive(s, new Date(now)))) continue;
    // Access ended at the refund, or else at expiry; the latest ending is when the customer churned.
    const ended = (x: (typeof subs)[number]) => (x.refundedAt && (!x.expiresDate || x.refundedAt < x.expiresDate) ? x.refundedAt : x.expiresDate);
    const last = subs.filter((x) => ended(x)).sort((x, y) => ended(y)!.getTime() - ended(x)!.getTime())[0];
    if (!last) continue;
    const churnedAt = ended(last)!.getTime();
    const age = now - churnedAt;
    if (age < a.churned_min_days * DAY || age > a.churned_max_days * DAY) continue;
    if (a.product_ids.length && !a.product_ids.includes(last.productIdentifier)) continue;
    if (a.stores.length && !a.stores.includes(last.store)) continue;
    if (o.audienceRules && !rulesMatch(ctx, o.audienceRules, now)) continue;
    const appUserId = data.aliases.find((x) => !x.startsWith("$RCAnonymousID:")) ?? data.customer.originalAppUserId;
    out.push({ customerId: data.customer.id, appUserId, email, churnedAt, productId: last.productIdentifier, store: last.store, bundleId: last.appId ? o.bundleIds?.get(last.appId) ?? null : null });
  }
  return out;
}

/**
 * Where the email's button leads. RevenueDot has no web checkout yet, so "store" opens the store's subscription page:
 * the App Store's account subscriptions (where Apple lists the win-back offers a lapsed customer is eligible for, with
 * Resubscribe) or the Play Store page for the product. Other stores, or a custom URL, use the campaign's URL.
 */
export function offerUrlFor(offer: WinbackOffer, c: Pick<Candidate, "store" | "productId" | "bundleId">): string | null {
  if (offer.type === "url") return offer.url ?? null;
  if (c.store === "app_store" || c.store === "mac_app_store") return "https://apps.apple.com/account/subscriptions";
  if (c.store === "play_store" && c.bundleId) {
    const q = new URLSearchParams({ sku: c.productId.split(":")[0]!, package: c.bundleId });
    return `https://play.google.com/store/account/subscriptions?${q}`;
  }
  return offer.url ?? null;
}

/** The token in a test email's links: it matches no send, and its unsubscribe page says nothing changed. */
export const TEST_EMAIL_TOKEN = "test-email-preview-token";

const token = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function suppressedOf(db: DB, projectId: string) {
  const rows = await db.select({ e: schema.emailSuppressions.email }).from(schema.emailSuppressions).where(eq(schema.emailSuppressions.projectId, projectId));
  return new Set(rows.map((r) => r.e.toLowerCase()));
}

/** What a campaign's eligible count depends on (services/customer-counts.ts keys stored counts by it). */
export interface WinbackCountSpec { campaign_id: string; audience: WinbackAudience; audience_rules: Rules | null }
interface WinbackPrep { suppressed: Set<string>; alreadySent: Set<string>; audienceRules: Rules | null; bundleIds: Map<string, string | null> }

/** Only customers with an `$email` and a production subscription can be candidates: the scan reads no one else. */
const CANDIDATE_FILTER: ScanFilter = {
  where: sql`EXISTS (SELECT 1 FROM customer_attributes x WHERE x.customer_id = c.id AND x.key = '$email' AND x.value IS NOT NULL)
    AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = c.id AND s.store <> 'promotional' AND NOT s.is_sandbox)`,
};

async function specOf(db: DB, c: CampaignRow): Promise<WinbackCountSpec> {
  const a = audienceOf(c);
  let audienceRules: Rules | null = null;
  if (a.audience_id) {
    const [aud] = await db.select().from(schema.audiences).where(and(eq(schema.audiences.projectId, c.projectId), eq(schema.audiences.id, a.audience_id))).limit(1);
    audienceRules = aud ? aud.rules as Rules : { groups: [{ conditions: [{ field: "customerId", operator: "is", value: "\u0000none" }] }] };
  }
  return { campaign_id: c.id, audience: a, audience_rules: audienceRules };
}

async function prepOf(db: DB, projectId: string, s: WinbackCountSpec): Promise<WinbackPrep> {
  const [suppressed, sent, apps] = await Promise.all([
    suppressedOf(db, projectId),
    db.select({ c: schema.winbackSends.customerId }).from(schema.winbackSends).where(eq(schema.winbackSends.campaignId, s.campaign_id)),
    db.select({ id: schema.apps.id, b: schema.apps.bundleId }).from(schema.apps).where(eq(schema.apps.projectId, projectId)),
  ]);
  return { suppressed, alreadySent: new Set(sent.map((x) => x.c).filter((x): x is string => !!x)), audienceRules: s.audience_rules, bundleIds: new Map(apps.map((x) => [x.id, x.b])) };
}

/** The eligible count, page by page (services/customer-counts.ts). */
export const winbackCounter = {
  filter: () => CANDIDATE_FILTER,
  prepare: (db: DB, projectId: string, s: WinbackCountSpec) => prepOf(db, projectId, s),
  empty: () => ({ eligible: 0 }),
  add(acc: { eligible: number }, i: LoadedContext, s: WinbackCountSpec, now: Date, p: WinbackPrep) { acc.eligible += selectCandidates([i], s.audience, now.getTime(), p).length; },
};

/** Everyone the campaign would email now, over every customer of the project, a page at a time. */
export async function candidatesFor(db: DB, c: CampaignRow, now: Date) {
  const spec = await specOf(db, c);
  const prep = await prepOf(db, c.projectId, spec);
  const candidates: Candidate[] = [];
  for await (const page of contextPages(db, c.projectId, now, CANDIDATE_FILTER)) candidates.push(...selectCandidates(page.items, spec.audience, now.getTime(), prep));
  return { candidates };
}

/** The preview: the exact eligible count (counted now, or by the tick in a large project) and 10 recently seen candidates. */
export async function previewCampaign(db: DB, c: CampaignRow, now: Date, inlineLimit?: number) {
  const spec = await specOf(db, c);
  const prep = await prepOf(db, c.projectId, spec);
  const [count, sample] = await Promise.all([
    exactCount(db, c.projectId, "winback", spec, now, inlineLimit),
    firstMatches(db, c.projectId, now, CANDIDATE_FILTER, (i) => selectCandidates([i], spec.audience, now.getTime(), prep).length > 0, 10),
  ]);
  return { eligible: count.result.eligible, counting: count.counting, countedAt: count.countedAt, sample: selectCandidates(sample, spec.audience, now.getTime(), prep) };
}

export interface SendDeps { db: DB; mailer?: Mailer; now: () => Date }

/** Renders the email for one customer (also "Send test", with a sample customer). */
export function renderFor(c: CampaignRow, appName: string, base: string, tok: string, offerUrl: string) {
  const e = emailOf(c);
  return winbackEmail({
    appName: e.sender_name?.trim() || appName, subject: e.subject, heading: e.heading, body: e.body, buttonLabel: e.button_label,
    offerUrl: `${base}/v1/winback/c/${tok}`, unsubscribeUrl: `${base}/v1/winback/u/${tok}`, pixelUrl: c.trackOpens ? `${base}/v1/winback/o/${tok}` : null,
  });
}

/**
 * One run: email up to `limit` candidates (sent or failed; candidates without an offer link are skipped). Each customer
 * gets the email at most once per campaign. `done` is false when candidates are left for a later run.
 */
export async function runCampaign(deps: SendDeps, c: CampaignRow, base: string, limit = MAX_PER_RUN): Promise<{ sent: number; failed: number; skipped: number; done: boolean }> {
  const { db } = deps;
  const now = deps.now();
  const { candidates } = await candidatesFor(db, c, now);
  const [project] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, c.projectId));
  const support = await supportSettingsFor(db, c.projectId);
  const replyTo = isEmailAddress(support.email) && !support.email.endsWith("@example.com") ? support.email : undefined;
  const appName = emailOf(c).sender_name?.trim() || project?.name || "Your app";
  const [{ n: lastDay }] = await db.select({ n: count() }).from(schema.winbackSends)
    .where(and(eq(schema.winbackSends.projectId, c.projectId), gte(schema.winbackSends.sentAt, new Date(now.getTime() - DAY)))) as [{ n: number }];
  limit = Math.min(limit, PROJECT_DAILY_MAX - Number(lastDay));
  let sent = 0, failed = 0, skipped = 0, looked = 0;
  for (const cand of candidates) {
    if (sent + failed >= limit) break;
    looked++;
    const offerUrl = offerUrlFor(offerOf(c), cand);
    if (!offerUrl) { skipped++; continue; }
    const tok = token();
    const inserted = await db.insert(schema.winbackSends).values({ id: newId("wbs_", 16), campaignId: c.id, projectId: c.projectId, customerId: cand.customerId, email: cand.email, token: tok, offerUrl, sentAt: now })
      .onConflictDoNothing().returning({ id: schema.winbackSends.id });
    if (!inserted.length) { skipped++; continue; }
    const mail = renderFor(c, project?.name ?? "Your app", base, tok, offerUrl);
    const ok = await trySend(deps.mailer, {
      to: cand.email, ...mail, replyTo, fromName: appName,
      headers: oneClickUnsubscribeHeaders(`${base}/v1/winback/u/${tok}`),
    });
    if (ok) sent++;
    else { failed++; await db.update(schema.winbackSends).set({ error: "The mailer did not accept the email." }).where(eq(schema.winbackSends.id, inserted[0]!.id)); }
  }
  return { sent, failed, skipped, done: limit <= 0 || looked >= candidates.length };
}

/**
 * The tick: active campaigns run once a day, at or after their UTC hour. A run that has more candidates than the tick's
 * budget goes on in the next ticks, until everyone eligible got the email or the campaign sent MAX_PER_RUN that day.
 */
export async function runDueCampaigns(deps: SendDeps, publicUrl?: string): Promise<number> {
  const { db } = deps;
  const now = deps.now();
  const active = await db.select().from(schema.winbackCampaigns).where(and(eq(schema.winbackCampaigns.status, "active"), notMoving(schema.winbackCampaigns.projectId)))
    .orderBy(sql`${schema.winbackCampaigns.lastRunAt} asc nulls first`, asc(schema.winbackCampaigns.id));
  let total = 0, budget = SENDS_PER_TICK, looked = 0;
  for (const c of active) {
    if (budget <= 0 || looked >= CAMPAIGNS_PER_TICK) break;
    const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), c.sendHourUtc));
    if (now < slot || (c.lastRunAt && c.lastRunAt >= slot)) continue;
    const base = publicUrl ?? emailOf(c).link_base;
    if (!base) continue;
    looked++;
    const finish = () => db.update(schema.winbackCampaigns).set({ lastRunAt: now }).where(eq(schema.winbackCampaigns.id, c.id));
    try {
      const [{ n }] = await db.select({ n: count() }).from(schema.winbackSends).where(and(eq(schema.winbackSends.campaignId, c.id), gte(schema.winbackSends.sentAt, slot))) as [{ n: number }];
      const left = MAX_PER_RUN - Number(n);
      if (left <= 0) { await finish(); continue; }
      const r = await runCampaign(deps, c, base, Math.min(budget, left));
      budget -= r.sent + r.failed;
      total += r.sent;
      if (r.done || r.sent + r.failed >= left) await finish();
    } catch (e) {
      console.error(`win-back campaign ${c.id} failed`, e);
      await finish().catch(() => undefined);
    }
  }
  return total;
}

/** Campaign numbers: sent, opened, clicked, unsubscribed, and customers who bought again within 30 days of their email. */
export async function campaignStats(db: DB, campaignIds: string[]) {
  const out = new Map<string, { sent: number; failed: number; opened: number; clicked: number; unsubscribed: number; reactivated: number; reactivated_revenue_in_usd: number }>();
  for (const id of campaignIds) out.set(id, { sent: 0, failed: 0, opened: 0, clicked: 0, unsubscribed: 0, reactivated: 0, reactivated_revenue_in_usd: 0 });
  if (!campaignIds.length) return out;
  // Counted in Postgres: a campaign can have sent to many thousands of customers.
  const rows = await db.execute(sql`
    SELECT s.campaign_id AS id,
      count(*) FILTER (WHERE s.error IS NULL)::int AS sent,
      count(*) FILTER (WHERE s.error IS NOT NULL)::int AS failed,
      count(*) FILTER (WHERE s.opened_at IS NOT NULL)::int AS opened,
      count(*) FILTER (WHERE s.clicked_at IS NOT NULL)::int AS clicked,
      count(*) FILTER (WHERE s.unsubscribed_at IS NOT NULL)::int AS unsubscribed,
      count(*) FILTER (WHERE s.error IS NULL AND r.n > 0)::int AS reactivated,
      coalesce(sum(r.usd) FILTER (WHERE s.error IS NULL AND r.n > 0), 0)::float8 AS revenue
    FROM winback_sends s
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, coalesce(sum(t.revenue_usd), 0) AS usd FROM transactions t
      WHERE t.customer_id = s.customer_id AND t.purchased_at >= s.sent_at AND t.purchased_at <= s.sent_at + make_interval(secs => ${REACTIVATION_WINDOW_MS / 1000})
        AND t.kind IN ('purchase', 'renewal', 'trial', 'one_time') AND t.is_sandbox = false
    ) r ON true
    WHERE s.campaign_id IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY s.campaign_id`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { id: string; sent: number; failed: number; opened: number; clicked: number; unsubscribed: number; reactivated: number; revenue: number }[];
  for (const r of list) {
    out.set(r.id, {
      sent: Number(r.sent), failed: Number(r.failed), opened: Number(r.opened), clicked: Number(r.clicked), unsubscribed: Number(r.unsubscribed),
      reactivated: Number(r.reactivated), reactivated_revenue_in_usd: Math.round(Number(r.revenue) * 100) / 100,
    });
  }
  return out;
}

// ---------- Public links ----------

export async function sendByToken(db: DB, tok: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(tok)) return null;
  const [s] = await db.select().from(schema.winbackSends).where(eq(schema.winbackSends.token, tok)).limit(1);
  return s ?? null;
}

export async function markClicked(db: DB, tok: string, now: Date) {
  const s = await sendByToken(db, tok);
  if (!s) return null;
  if (!s.clickedAt) await db.update(schema.winbackSends).set({ clickedAt: now, openedAt: s.openedAt ?? now }).where(eq(schema.winbackSends.id, s.id));
  return s.offerUrl;
}

export async function markOpened(db: DB, tok: string, now: Date) {
  const s = await sendByToken(db, tok);
  if (s && !s.openedAt) await db.update(schema.winbackSends).set({ openedAt: now }).where(eq(schema.winbackSends.id, s.id));
}

export async function unsubscribe(db: DB, tok: string, now: Date): Promise<boolean> {
  const s = await sendByToken(db, tok);
  if (!s) return false;
  await db.insert(schema.emailSuppressions).values({ projectId: s.projectId, email: s.email.toLowerCase(), createdAt: now }).onConflictDoNothing();
  if (!s.unsubscribedAt) await db.update(schema.winbackSends).set({ unsubscribedAt: now }).where(eq(schema.winbackSends.id, s.id));
  return true;
}

/** Sends of one campaign, newest first (the campaign page's log). */
export async function recentSends(db: DB, campaignId: string, limit = 50) {
  return db.select().from(schema.winbackSends).where(eq(schema.winbackSends.campaignId, campaignId)).orderBy(desc(schema.winbackSends.sentAt)).limit(limit);
}
