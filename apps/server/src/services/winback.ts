import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../mail/index.js";
import { winbackEmail } from "../mail/templates.js";
import { projectContexts, subActive, type LoadedContext } from "./customer-context.js";
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
/** At most this many emails per campaign run. */
export const MAX_PER_RUN = 500;
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
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || o.suppressed.has(email.toLowerCase()) || o.alreadySent.has(data.customer.id)) continue;
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

const token = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function suppressedOf(db: DB, projectId: string) {
  const rows = await db.select({ e: schema.emailSuppressions.email }).from(schema.emailSuppressions).where(eq(schema.emailSuppressions.projectId, projectId));
  return new Set(rows.map((r) => r.e.toLowerCase()));
}

/** Everyone the campaign would email now (and the share of the project looked at). */
export async function candidatesFor(db: DB, c: CampaignRow, now: Date) {
  const a = audienceOf(c);
  const [{ items, truncated }, suppressed, sent, apps] = await Promise.all([
    projectContexts(db, c.projectId, now), suppressedOf(db, c.projectId),
    db.select({ c: schema.winbackSends.customerId }).from(schema.winbackSends).where(eq(schema.winbackSends.campaignId, c.id)),
    db.select({ id: schema.apps.id, b: schema.apps.bundleId }).from(schema.apps).where(eq(schema.apps.projectId, c.projectId)),
  ]);
  let audienceRules: Rules | null = null;
  if (a.audience_id) {
    const [aud] = await db.select().from(schema.audiences).where(and(eq(schema.audiences.projectId, c.projectId), eq(schema.audiences.id, a.audience_id))).limit(1);
    audienceRules = aud ? aud.rules as Rules : { groups: [{ conditions: [{ field: "customerId", operator: "is", value: "\u0000none" }] }] };
  }
  const candidates = selectCandidates(items, a, now.getTime(), {
    suppressed, alreadySent: new Set(sent.map((s) => s.c).filter((x): x is string => !!x)), audienceRules, bundleIds: new Map(apps.map((x) => [x.id, x.b])),
  });
  return { candidates, truncated };
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

/** One run: email up to MAX_PER_RUN candidates. Each customer gets the email at most once per campaign. */
export async function runCampaign(deps: SendDeps, c: CampaignRow, base: string): Promise<{ sent: number; failed: number; skipped: number }> {
  const { db } = deps;
  const now = deps.now();
  const { candidates } = await candidatesFor(db, c, now);
  const [project] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, c.projectId));
  const support = await supportSettingsFor(db, c.projectId);
  const replyTo = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(support.email) && !support.email.endsWith("@example.com") ? support.email : undefined;
  let sent = 0, failed = 0, skipped = 0;
  for (const cand of candidates.slice(0, MAX_PER_RUN)) {
    const offerUrl = offerUrlFor(offerOf(c), cand);
    if (!offerUrl) { skipped++; continue; }
    const tok = token();
    const inserted = await db.insert(schema.winbackSends).values({ id: newId("wbs_", 16), campaignId: c.id, projectId: c.projectId, customerId: cand.customerId, email: cand.email, token: tok, offerUrl, sentAt: now })
      .onConflictDoNothing().returning({ id: schema.winbackSends.id });
    if (!inserted.length) { skipped++; continue; }
    const mail = renderFor(c, project?.name ?? "Your app", base, tok, offerUrl);
    const ok = await trySend(deps.mailer, {
      to: cand.email, ...mail, replyTo,
      headers: { "List-Unsubscribe": `<${base}/v1/winback/u/${tok}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    if (ok) sent++;
    else { failed++; await db.update(schema.winbackSends).set({ error: "The mailer did not accept the email." }).where(eq(schema.winbackSends.id, inserted[0]!.id)); }
  }
  await db.update(schema.winbackCampaigns).set({ lastRunAt: now }).where(eq(schema.winbackCampaigns.id, c.id));
  return { sent, failed, skipped };
}

/** The tick: active campaigns run once a day, at or after their UTC hour. */
export async function runDueCampaigns(deps: SendDeps, publicUrl?: string): Promise<number> {
  const now = deps.now();
  const active = await deps.db.select().from(schema.winbackCampaigns).where(eq(schema.winbackCampaigns.status, "active"));
  let total = 0;
  for (const c of active) {
    const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), c.sendHourUtc));
    if (now < slot || (c.lastRunAt && c.lastRunAt >= slot)) continue;
    const base = publicUrl ?? emailOf(c).link_base;
    if (!base) continue;
    try { total += (await runCampaign(deps, c, base)).sent; } catch (e) { console.error(`win-back campaign ${c.id} failed`, e); }
  }
  return total;
}

/** Campaign numbers: sent, opened, clicked, unsubscribed, and customers who bought again within 30 days of their email. */
export async function campaignStats(db: DB, campaignIds: string[]) {
  const out = new Map<string, { sent: number; failed: number; opened: number; clicked: number; unsubscribed: number; reactivated: number; reactivated_revenue_in_usd: number }>();
  for (const id of campaignIds) out.set(id, { sent: 0, failed: 0, opened: 0, clicked: 0, unsubscribed: 0, reactivated: 0, reactivated_revenue_in_usd: 0 });
  if (!campaignIds.length) return out;
  const sends = await db.select().from(schema.winbackSends).where(inArray(schema.winbackSends.campaignId, campaignIds));
  const customerIds = [...new Set(sends.map((s) => s.customerId).filter((x): x is string => !!x))];
  const earliest = sends.length ? new Date(Math.min(...sends.map((s) => s.sentAt.getTime()))) : new Date();
  const tx = customerIds.length ? await db.select().from(schema.transactions).where(and(inArray(schema.transactions.customerId, customerIds), gte(schema.transactions.purchasedAt, earliest),
    inArray(schema.transactions.kind, ["purchase", "renewal", "trial", "one_time"]), eq(schema.transactions.isSandbox, false))) : [];
  for (const s of sends) {
    const st = out.get(s.campaignId)!;
    if (s.error) st.failed++; else st.sent++;
    if (s.openedAt) st.opened++;
    if (s.clickedAt) st.clicked++;
    if (s.unsubscribedAt) st.unsubscribed++;
    const back = tx.filter((t) => t.customerId === s.customerId && t.purchasedAt >= s.sentAt && t.purchasedAt.getTime() <= s.sentAt.getTime() + REACTIVATION_WINDOW_MS);
    if (back.length && !s.error) { st.reactivated++; st.reactivated_revenue_in_usd = Math.round((st.reactivated_revenue_in_usd + back.reduce((x, t) => x + t.revenueUsd, 0)) * 100) / 100; }
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
