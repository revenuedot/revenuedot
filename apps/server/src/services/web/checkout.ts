import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { ANON_PREFIX, buildCustomerInfo, isAnonymous, newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { AppRecord, Deps } from "../../context.js";
import { Codes, RCError } from "../../errors.js";
import { trySend } from "../../mail/index.js";
import { esc } from "../../mail/templates.js";
import { entitlementMap, productInfo } from "../../repo/catalog.js";
import { findCustomer, getOrCreateCustomer, loadState, mergeCustomers, setAttributes, aliasesOf } from "../../repo/customers.js";
import { applyPurchases } from "../purchases.js";
import { withStoreSecrets } from "../store-secrets.js";
import { sha256Hex } from "../auth.js";
import { recordCredentialFailure } from "../credential-health.js";
import { mergeStoredState, rowPrice, subRowOf } from "../../stores/rows.js";
import { stripeClientFor, purchasesForToken } from "../../stores/stripe/index.js";
import { StripeApiError, type StripeCheckoutSession } from "../../stores/stripe/api.js";
import { StripeNotYetPaid } from "../../stores/stripe/map.js";
import { webConfigOf } from "./config.js";
import { webPackages, type WebPackage } from "./catalog.js";
import { CAPPED_CHECKOUT_MINUTES, countRedemption, DiscountRefused, discountForCheckout, pendingUses, USED_UP } from "./discounts.js";
import { recordFunnelEvent } from "./funnels.js";

/**
 * Hosted checkout and redemption links (prd/web-billing/PRD.md §2 and §4). A checkout is a `web_checkouts` row plus a Stripe
 * Checkout Session created with the developer's own key. Completion goes through the Stripe store path (the same
 * verification and purchase pipeline as `POST /v1/receipts` with `X-Platform: stripe`), so the usual events fire.
 */

export type CheckoutRow = typeof schema.webCheckouts.$inferSelect;

export class CheckoutError extends Error {
  constructor(public status: 400 | 404 | 409 | 410 | 503, message: string) { super(message); }
}

export const newAnonymousId = () => `${ANON_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;

export interface StartInput {
  app: AppRecord;
  offering: typeof schema.offerings.$inferSelect;
  packageKey: string;
  source: { type: "purchase_link" | "funnel" | "sdk"; id: string | null; discountId?: string | null };
  appUserId?: string | null;
  /** The page's anonymous visitor id (`$RCAnonymousID:…`), used when no app user id is given. */
  visitorId?: string | null;
  email?: string | null;
  code?: string | null;
  funnelSessionId?: string | null;
  attributes?: Record<string, string>;
  /** The page's URL: success is `<page>/success?…`, cancel `<page>?canceled=1` unless the web config has a cancel URL. */
  pageUrl: string;
  successUrl?: string;
  cancelUrl?: string;
}

export async function startCheckout(deps: Deps, o: StartInput): Promise<{ checkout: CheckoutRow; url: string; pkg: WebPackage }> {
  const { db } = deps;
  const now = deps.now();
  const pkgs = await webPackages(db, o.app.projectId, o.app.id, o.offering.id);
  const pkg = pkgs.find((p) => p.key === o.packageKey || p.packageId === o.packageKey);
  if (!pkg) throw new CheckoutError(400, "This plan is not for sale on the web.");
  let appUserId = o.appUserId?.trim() || null;
  if (appUserId && appUserId.length > 100) throw new CheckoutError(400, "app_user_id is too long.");
  const anonymous = !appUserId;
  // A funnel visitor's anonymous id from the page, so their events and their purchase share one id. The page sends it, so
  // it is used only while no customer has it: an id that is already someone's (an app's anonymous user, a buyer who has
  // redeemed) would put the purchase on that customer, and redeeming it would move all of theirs.
  const visitor = !appUserId && o.visitorId && /^\$RCAnonymousID:[0-9a-f]{32}$/.test(o.visitorId) && !(await findCustomer(db, o.app.projectId, o.visitorId)) ? o.visitorId : null;
  appUserId ??= visitor ?? newAnonymousId();
  const email = o.email?.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email.trim()) ? o.email.trim().slice(0, 254) : null;
  let applied;
  try {
    applied = await discountForCheckout(db, { projectId: o.app.projectId, appId: o.app.id, code: o.code, discountId: o.code ? null : o.source.discountId, product: pkg.product, currency: pkg.web.currency, appUserId: anonymous ? null : appUserId, now, deps });
  } catch (e) {
    if (e instanceof DiscountRefused) throw new CheckoutError(400, e.message);
    throw e;
  }
  const id = newId("wco_", 16);
  const attributes = { ...(o.attributes ?? {}), ...(email ? { $email: email } : {}) };
  const values = {
    id, projectId: o.app.projectId, appId: o.app.id, sourceType: o.source.type, sourceId: o.source.id, offeringId: o.offering.id, packageId: pkg.packageId, productId: pkg.product.id,
    appUserId, anonymous, email, discountId: applied?.discount.id ?? null, discountCode: applied?.code?.codeKey ?? null, funnelSessionId: o.funnelSessionId ?? null, attributes, createdAt: now,
  };
  const capped = applied?.discount.maxRedemptions ?? null;
  // A capped discount: the check and the checkout row that holds one use are one step, with the discount row locked, so
  // checkouts started at the same moment cannot all take the last use.
  const [row] = capped === null ? await db.insert(schema.webCheckouts).values(values).returning() : await db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    const [d] = await t.select({ used: schema.discounts.timesRedeemed }).from(schema.discounts).where(eq(schema.discounts.id, applied!.discount.id)).for("update");
    if (!d || d.used + (await pendingUses(t, applied!.discount.id, now)) >= capped) throw new CheckoutError(400, USED_UP);
    return t.insert(schema.webCheckouts).values(values).returning();
  });
  const storeApp = await withStoreSecrets(deps, o.app);
  const { config } = await webConfigOf(db, o.app);
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  const metaKey = typeof storeApp.credentials?.app_user_id_metadata_key === "string" && storeApp.credentials.app_user_id_metadata_key.trim() ? storeApp.credentials.app_user_id_metadata_key.trim() : "app_user_id";
  const metadata = { [metaKey]: appUserId, rd_app_user_id: appUserId, rd_checkout: id, rd_source: `${o.source.type}:${o.source.id ?? ""}`, rd_offering: o.offering.lookupKey };
  const sep = o.pageUrl.includes("?") ? "&" : "?";
  const params: Record<string, unknown> = {
    mode: pkg.web.interval ? "subscription" : "payment",
    line_items: [{ price: pkg.web.stripePriceId, quantity: 1 }],
    success_url: o.successUrl ?? `${o.pageUrl.split("?")[0]}/success?co=${id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: o.cancelUrl ?? config.cancel_url ?? `${o.pageUrl}${sep}canceled=1`,
    client_reference_id: id,
    metadata,
    customer_email: email ?? undefined,
    discounts: applied ? [applied.stripe] : undefined,
  };
  // The session must end before the hold on a capped discount's use does (discounts.ts).
  if (capped !== null) params.expires_at = Math.floor(now.getTime() / 1000) + CAPPED_CHECKOUT_MINUTES * 60;
  if (pkg.web.interval) params.subscription_data = { metadata, ...(pkg.web.trialDays ? { trial_period_days: pkg.web.trialDays } : {}) };
  else params.payment_intent_data = { metadata };
  let session: StripeCheckoutSession & { url?: string };
  try {
    session = await client.post(storeApp, "/v1/checkout/sessions", params, `rd-checkout-${id}`);
  } catch (e) {
    await db.update(schema.webCheckouts).set({ status: "failed" }).where(eq(schema.webCheckouts.id, id));
    if (e instanceof StripeApiError) {
      if (e.kind === "credentials") { await recordCredentialFailure(db, o.app.id, e.message, now).catch(() => {}); throw new CheckoutError(503, "Checkout is not available right now. The seller has been told."); }
      if (e.kind === "transient") throw new CheckoutError(503, "Checkout is busy right now. Try again in a moment.");
      throw new CheckoutError(400, `Checkout could not start: ${e.message}`);
    }
    throw e;
  }
  const [saved] = await db.update(schema.webCheckouts).set({ stripeSessionId: session.id, isSandbox: !session.livemode }).where(eq(schema.webCheckouts.id, id)).returning();
  if (o.source.type === "funnel" && o.source.id && o.funnelSessionId) {
    const [f] = await db.select().from(schema.funnels).where(eq(schema.funnels.id, o.source.id)).limit(1);
    if (f) await recordFunnelEvent(db, { projectId: o.app.projectId, funnel: f, sessionId: o.funnelSessionId, type: "checkout_started", appUserId, sandbox: !session.livemode, now, extra: { package: pkg.key } });
  }
  if (!session.url) throw new CheckoutError(503, "Stripe did not return a checkout page.");
  return { checkout: saved ?? row!, url: session.url, pkg };
}

/* ---------------- redemption tokens ---------------- */

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function tokenFor(seed: string, generation: number): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${seed}.${generation}`)));
  return `rdrt_${b64url(d)}`;
}
const randomSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/** `t***@e******e.com`: first letter of the name, first and last letters of the domain's first label. */
export function obfuscateEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  const parts = domain.split(".");
  const label = parts[0] ?? "";
  const hidden = label.length <= 2 ? `${label[0] ?? ""}*` : `${label[0]}${"*".repeat(label.length - 2)}${label[label.length - 1]}`;
  return `${name[0] ?? ""}***@${[hidden, ...parts.slice(1)].join(".")}`;
}

/**
 * Issues the next generation of the checkout's redemption token (a new one replaces an expired one). Only one of several
 * calls that start from the same generation writes; the others answer the token it wrote (`issued` false), so the success
 * page, the webhook and the email always agree on one token.
 */
async function issueToken(db: DB, row: CheckoutRow, hours: number, now: Date): Promise<{ token: string; row: CheckoutRow; issued: boolean }> {
  const seed = row.redemptionSeed ?? randomSeed();
  const generation = row.redemptionGeneration + 1;
  const token = await tokenFor(seed, generation);
  const [saved] = await db.update(schema.webCheckouts).set({
    redemptionSeed: seed, redemptionGeneration: generation, redemptionTokenHash: await sha256Hex(token), redemptionExpiresAt: new Date(now.getTime() + hours * 3_600_000),
    previousTokenHashes: row.redemptionTokenHash ? [...(row.previousTokenHashes ?? []), row.redemptionTokenHash].slice(-20) : row.previousTokenHashes ?? [],
  }).where(and(eq(schema.webCheckouts.id, row.id), eq(schema.webCheckouts.redemptionGeneration, row.redemptionGeneration))).returning();
  if (saved) return { token, row: saved, issued: true };
  const [cur] = await db.select().from(schema.webCheckouts).where(eq(schema.webCheckouts.id, row.id)).limit(1);
  return { token: await tokenFor(cur!.redemptionSeed!, cur!.redemptionGeneration), row: cur!, issued: false };
}

/** The token the success page shows: the current one, or a new one when it expired before redemption. */
export async function currentToken(deps: Deps, row: CheckoutRow, hours: number): Promise<string | null> {
  if (!row.anonymous || row.status !== "completed" || row.redeemedAt) return null;
  const now = deps.now();
  if (!row.redemptionSeed || !row.redemptionExpiresAt || row.redemptionExpiresAt <= now) return (await issueToken(deps.db, row, hours, now)).token;
  return tokenFor(row.redemptionSeed, row.redemptionGeneration);
}

export const deepLinkFor = (scheme: string, token: string) => `${scheme}://redeem_web_purchase?redemption_token=${encodeURIComponent(token)}`;
export const redeemUrlFor = (payBase: string, token: string) => `${payBase}/r/${encodeURIComponent(token)}`;

function redemptionEmail(o: { appName: string; url: string; expiresInHours: number }) {
  const subject = `Your ${o.appName.replace(/[\u0000-\u001f\u007f]+/g, " ")} purchase is ready`;
  const text = [`Thanks for your purchase.`, "", `Open this link on the phone where ${o.appName} is installed to unlock it:`, o.url, "", `The link works for ${o.expiresInHours} hours. If it expires, open it anyway and we will send a new one.`].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0A0A0A">` +
    `<div style="max-width:480px;margin:0 auto"><h1 style="font-size:22px;line-height:30px;margin:0 0 16px">${esc(subject)}</h1>` +
    `<p style="font-size:15px;line-height:24px;margin:0 0 16px">Thanks for your purchase. Open this link on the phone where ${esc(o.appName)} is installed to unlock it.</p>` +
    `<p style="margin:0 0 24px"><a href="${esc(o.url)}" style="display:inline-block;padding:12px 20px;background:#0A0A0A;color:#FFFFFF;text-decoration:none;font-weight:600">Open ${esc(o.appName)}</a></p>` +
    `<p style="font-size:13px;line-height:20px;color:#525252;margin:0">The link works for ${o.expiresInHours} hours. If it expires, open it anyway and we will send a new one.</p></div></body></html>`;
  return { subject, text, html };
}

/** Emails the redemption link. `payBase` must come from configuration (mailPayBase), never from the request's host. */
async function sendRedemption(deps: Deps, row: CheckoutRow, token: string, payBase: string) {
  if (!row.email) return false;
  const [app] = await deps.db.select().from(schema.apps).where(eq(schema.apps.id, row.appId)).limit(1);
  if (!app) return false;
  const { config } = await webConfigOf(deps.db, app);
  const sent = await trySend(deps.mailer, { to: row.email, ...redemptionEmail({ appName: config.app_name, url: redeemUrlFor(payBase, token), expiresInHours: config.redemption_link_hours }), replyTo: config.support_email ?? undefined });
  if (sent) await deps.db.update(schema.webCheckouts).set({ redemptionSentAt: deps.now() }).where(eq(schema.webCheckouts.id, row.id));
  return sent;
}

/* ---------------- completion ---------------- */

export interface Completion { status: "completed" | "processing" | "expired"; row: CheckoutRow; token: string | null }

/**
 * Records a paid checkout, once, from the success page or the `checkout.session.completed` webhook (whichever comes first).
 * Reads the session from Stripe and posts it through the Stripe store path for the checkout's app user id. `ref.projectId`
 * and `ref.appId` scope the lookup to the page or the webhook's Stripe app. `mailBase` is where the redemption email's link
 * points (mailPayBase).
 */
export async function completeWebCheckout(deps: Deps, ref: { checkoutId?: string; sessionId?: string; projectId?: string; appId?: string }, mailBase: string | null): Promise<Completion | null> {
  const { db } = deps;
  const now = deps.now();
  const [row] = await db.select().from(schema.webCheckouts).where(ref.checkoutId ? eq(schema.webCheckouts.id, ref.checkoutId) : eq(schema.webCheckouts.stripeSessionId, ref.sessionId!)).limit(1);
  if (!row || !row.stripeSessionId || (ref.sessionId && row.stripeSessionId !== ref.sessionId)) return null;
  if ((ref.projectId && row.projectId !== ref.projectId) || (ref.appId && row.appId !== ref.appId)) return null;
  const [app] = await db.select().from(schema.apps).where(eq(schema.apps.id, row.appId)).limit(1);
  if (!app) return null;
  const { config } = await webConfigOf(db, app);
  if (row.status === "completed") return { status: "completed", row, token: await currentToken(deps, row, config.redemption_link_hours) };
  const storeApp = await withStoreSecrets(deps, app);
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  let found;
  try {
    found = await purchasesForToken(client, storeApp, row.stripeSessionId, {
      catalog: await productInfo(db, app.id), now,
      stored: async (subId) => { const r = await subRowOf(db, app.projectId, "stripe", subId); return r ? { storeTransactionId: r.storeTransactionId, purchaseDate: r.purchaseDate, price: rowPrice(r) } : null; },
    });
  } catch (e) {
    if (e instanceof StripeNotYetPaid) return { status: "processing", row, token: null };
    if (e instanceof StripeApiError && e.kind === "invalid" && /expired/i.test(e.message)) {
      const [x] = await db.update(schema.webCheckouts).set({ status: "expired" }).where(and(eq(schema.webCheckouts.id, row.id), ne(schema.webCheckouts.status, "completed"))).returning();
      return { status: "expired", row: x ?? row, token: null };
    }
    throw e;
  }
  const purchases = await mergeStoredState(db, app.projectId, found.purchases, now);
  const { customer, created } = await getOrCreateCustomer(db, app.projectId, row.appUserId, now);
  const [offering] = row.offeringId ? await db.select({ key: schema.offerings.lookupKey }).from(schema.offerings).where(eq(schema.offerings.id, row.offeringId)).limit(1) : [];
  const attrs: Record<string, string> = { ...(row.attributes ?? {}) };
  const session = await client.checkoutSession(storeApp, row.stripeSessionId).catch(() => null) as (StripeCheckoutSession & { customer_details?: { email?: string | null } | null }) | null;
  const email = row.email ?? session?.customer_details?.email ?? null;
  if (email && !attrs.$email) attrs.$email = email;
  if (!row.anonymous && !created && Object.keys(attrs).length) {
    // The buyer named an app user id that already exists (`?app_user_id=`): anyone can, so the checkout fills in what the
    // customer lacks and never overwrites what they have (their email, earlier answers).
    const have = await db.select({ key: schema.customerAttributes.key }).from(schema.customerAttributes)
      .where(and(eq(schema.customerAttributes.customerId, customer.id), inArray(schema.customerAttributes.key, Object.keys(attrs))));
    for (const h of have) delete attrs[h.key];
  }
  if (Object.keys(attrs).length) await setAttributes(db, customer.id, Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v }])), now);
  const owner = await applyPurchases(db, customer, purchases, { projectId: app.projectId, appId: app.id, appUserId: row.appUserId, now, presentedOfferingId: offering?.key ?? null, fromDevice: false, customerCreated: created, fetch: deps.fetch });
  deps.kick?.();
  // Only the call that flips the row does the one-time work. The discount use is counted in the same step, so the use the
  // checkout held (pendingUses) never looks free in between. An anonymous checkout gets its redemption seed here too.
  const won = await db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    const [w] = await t.update(schema.webCheckouts).set({ status: "completed", completedAt: now, email, isSandbox: purchases.some((p) => p.isSandbox), ...(row.anonymous ? { redemptionSeed: row.redemptionSeed ?? randomSeed() } : {}) })
      .where(and(eq(schema.webCheckouts.id, row.id), ne(schema.webCheckouts.status, "completed"))).returning();
    if (w?.discountId) await countRedemption(t, app.projectId, w.discountId, w.discountCode);
    return w;
  });
  if (!won) {
    const [cur] = await db.select().from(schema.webCheckouts).where(eq(schema.webCheckouts.id, row.id));
    return { status: "completed", row: cur!, token: await currentToken(deps, cur!, config.redemption_link_hours) };
  }
  let done = won;
  const first = purchases[0];
  if (first) {
    const [t] = await db.select({ usd: schema.transactions.revenueUsd }).from(schema.transactions).where(and(eq(schema.transactions.projectId, app.projectId), eq(schema.transactions.store, "stripe"), eq(schema.transactions.storeTransactionId, first.storeTransactionId))).limit(1);
    if (t) [done] = await db.update(schema.webCheckouts).set({ amountUsd: t.usd }).where(eq(schema.webCheckouts.id, row.id)).returning() as [CheckoutRow];
  }
  let token: string | null = null;
  if (done.anonymous) {
    const issued = await issueToken(db, done, config.redemption_link_hours, now);
    token = issued.token; done = issued.row;
    // The flip's winner sends the one email, with the token whichever call wrote it.
    if (mailBase) await sendRedemption(deps, done, token, mailBase);
  }
  if (done.sourceType === "funnel" && done.sourceId && done.funnelSessionId) {
    const [f] = await db.select().from(schema.funnels).where(eq(schema.funnels.id, done.sourceId)).limit(1);
    if (f) await recordFunnelEvent(db, { projectId: app.projectId, funnel: f, sessionId: done.funnelSessionId, type: "purchase", appUserId: done.appUserId, customerId: owner.id, revenueUsd: done.amountUsd ?? 0, sandbox: done.isSandbox, now, extra: { product_id: first?.productIdentifier ?? null } });
  }
  return { status: "completed", row: done, token };
}

/* ---------------- redemption (POST /v1/subscribers/redeem_purchase) ---------------- */

/**
 * Redeems a web purchase for the app user id the SDK sends. The anonymous web buyer is aliased into that app user (their
 * purchases and attributes move over), as RevenueCat's `redemption_outcome: alias`. Answers with the SDK's error codes.
 */
export async function redeemWebPurchase(deps: Deps, app: { id: string | null; projectId: string }, o: { appUserId: string; token: string; platform: string | null; payBase: string }) {
  const { db } = deps;
  const now = deps.now();
  const invalid = () => new RCError(400, Codes.INVALID_WEB_REDEMPTION_TOKEN, "Invalid redemption token.");
  if (!/^rdrt_[A-Za-z0-9_-]{20,100}$/.test(o.token)) throw invalid();
  const hash = await sha256Hex(o.token);
  let [row] = await db.select().from(schema.webCheckouts).where(and(eq(schema.webCheckouts.projectId, app.projectId), eq(schema.webCheckouts.redemptionTokenHash, hash))).limit(1);
  let replaced = false;
  if (!row) {
    // A link that a newer one replaced: still "expired" (with a new email, rate-limited), never "invalid".
    [row] = await db.select().from(schema.webCheckouts).where(and(eq(schema.webCheckouts.projectId, app.projectId), sql`${schema.webCheckouts.previousTokenHashes} @> ${JSON.stringify([hash])}::jsonb`)).limit(1);
    replaced = !!row;
  }
  if (!row || row.status !== "completed" || !row.anonymous) throw invalid();
  const target = await findCustomer(db, app.projectId, o.appUserId);
  if (row.redeemedAt) return alreadyRedeemed(db, row, o.appUserId, target);
  if (replaced || !row.redemptionExpiresAt || row.redemptionExpiresAt <= now) {
    const [webApp] = await db.select().from(schema.apps).where(eq(schema.apps.id, row.appId)).limit(1);
    if (webApp && row.email && (!row.redemptionSentAt || now.getTime() - row.redemptionSentAt.getTime() > 3_600_000)) {
      const { config } = await webConfigOf(db, webApp);
      const issued = await issueToken(db, row, config.redemption_link_hours, now);
      // Two expired redeems at once send one email.
      if (issued.issued) await sendRedemption(deps, issued.row, issued.token, o.payBase);
    }
    throw new RCError(400, 7853, "The link has expired.", row.email ? { purchase_redemption_error_info: { obfuscated_email: obfuscateEmail(row.email) } } : {});
  }
  // Claim the purchase before moving anything: of two redeems at once (two app users, or one user's retries) exactly one
  // moves it and sends PURCHASE_REDEEMED; the other answers 7852 or, for the same app user id, the same customer.
  const [claim] = await db.update(schema.webCheckouts).set({ redeemedAt: now, redeemedAppUserId: o.appUserId })
    .where(and(eq(schema.webCheckouts.id, row.id), isNull(schema.webCheckouts.redeemedAt))).returning();
  if (!claim) {
    const [cur] = await db.select().from(schema.webCheckouts).where(eq(schema.webCheckouts.id, row.id)).limit(1);
    return alreadyRedeemed(db, cur!, o.appUserId, target);
  }
  let owner: typeof schema.customers.$inferSelect;
  try {
    const web = await findCustomer(db, app.projectId, row.appUserId);
    if (!web) owner = target ?? (await getOrCreateCustomer(db, app.projectId, o.appUserId, now)).customer;
    else if (target && target.id !== web.id) { await mergeCustomers(db, web.id, target.id); owner = target; }
    else if (target) owner = target;
    else {
      const added = await db.insert(schema.customerAliases).values({ projectId: app.projectId, appUserId: o.appUserId, customerId: web.id }).onConflictDoNothing().returning();
      // The app user id was created meanwhile (the app's own request): move the purchase into it instead.
      const raced = added.length ? null : await findCustomer(db, app.projectId, o.appUserId);
      if (raced && raced.id !== web.id) await mergeCustomers(db, web.id, raced.id);
      owner = raced ?? web;
    }
    await db.update(schema.webCheckouts).set({ redeemedCustomerId: owner.id }).where(eq(schema.webCheckouts.id, row.id));
  } catch (e) {
    // Nothing was redeemed: free the claim so the buyer can try again.
    await db.update(schema.webCheckouts).set({ redeemedAt: null, redeemedAppUserId: null, redeemedCustomerId: null })
      .where(and(eq(schema.webCheckouts.id, row.id), eq(schema.webCheckouts.redeemedAppUserId, o.appUserId), isNull(schema.webCheckouts.redeemedCustomerId)));
    throw e;
  }
  await purchaseRedeemedEvent(db, { row, appUserId: o.appUserId, customerId: owner.id, platform: o.platform, now });
  deps.kick?.();
  return owner;
}

/**
 * A purchase that is redeemed (or being redeemed): the same app user id, or the customer it went to, gets that customer
 * (the SDK retries); anyone else gets 7852. A redeem still moving the purchase is waited for, briefly.
 */
async function alreadyRedeemed(db: DB, row: CheckoutRow, appUserId: string, target: typeof schema.customers.$inferSelect | null) {
  let cur = row;
  for (let i = 0; i < 30 && cur.redeemedAt && !cur.redeemedCustomerId && cur.redeemedAppUserId === appUserId; i++) {
    await new Promise((r) => setTimeout(r, 100));
    [cur] = await db.select().from(schema.webCheckouts).where(eq(schema.webCheckouts.id, row.id)).limit(1) as [CheckoutRow];
  }
  const mine = cur.redeemedAppUserId === appUserId || (!!target && target.id === cur.redeemedCustomerId);
  if (mine && cur.redeemedCustomerId) {
    const owner = (await findCustomer(db, row.projectId, appUserId)) ?? target;
    if (owner) return owner;
  }
  if (mine) throw new RCError(503, Codes.STORE_PROBLEM, "The purchase is being redeemed. Try again in a moment.");
  throw new RCError(400, 7852, "The purchase has already been redeemed.");
}

/** PURCHASE_REDEEMED with the fields of RevenueCat's sample (fixtures/webhooks/purchase_redeemed.json), plus app_user_id. */
async function purchaseRedeemedEvent(db: DB, o: { row: CheckoutRow; appUserId: string; customerId: string; platform: string | null; now: Date }) {
  const { queueDeliveries } = await import("../events.js");
  const [product] = o.row.productId ? await db.select().from(schema.products).where(eq(schema.products.id, o.row.productId)).limit(1) : [];
  const map = await entitlementMap(db, o.row.projectId);
  const pid = product?.storeIdentifier ?? null;
  const entitlementIds = pid ? Object.entries(map).filter(([, ps]) => ps.includes(pid)).map(([k]) => k) : [];
  const id = crypto.randomUUID().toUpperCase();
  const environment = o.row.isSandbox ? "SANDBOX" : "PRODUCTION";
  const platform = (o.platform ?? "").toLowerCase();
  const event = {
    app_id: o.row.appId, event_timestamp_ms: o.now.getTime(), id, store: "STRIPE", environment,
    redeemed_from: [o.row.appUserId], redeemed_by: [o.appUserId], redemption_outcome: "alias",
    redemption_platform: platform || null,
    product_id: pid, entitlement_ids: entitlementIds.length ? entitlementIds : null,
    workflow_id: o.row.sourceType === "funnel" ? o.row.sourceId : null, workflow_step_id: null, trace_id: o.row.id,
    app_user_id: o.appUserId, type: "PURCHASE_REDEEMED",
  };
  await db.insert(schema.events).values({ id, projectId: o.row.projectId, customerId: o.customerId, type: "PURCHASE_REDEEMED", environment: environment.toLowerCase(), appId: o.row.appId, payload: { api_version: "1.0", event }, eventTimestampMs: o.now.getTime(), createdAt: o.now });
  await queueDeliveries(db, o.row.projectId, id, "PURCHASE_REDEEMED", environment.toLowerCase(), o.row.appId, o.now, event);
}

export async function customerInfoOf(db: DB, projectId: string, customer: typeof schema.customers.$inferSelect, now: Date) {
  return buildCustomerInfo(await loadState(db, customer), await entitlementMap(db, projectId), now);
}

export { isAnonymous, aliasesOf };
