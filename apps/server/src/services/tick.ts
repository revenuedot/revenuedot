import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { expirationReasonOf } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { recordEvent } from "./events.js";
import { deliverDue } from "./webhooks.js";
import { deliverDueIntegrations } from "./integrations/deliver.js";
import { processExportRuns, queueDueExports } from "./exports/run.js";
import { depsSecretKey } from "./secrets.js";
import { runAlerts } from "./alerts.js";
import { retryDueConsumption } from "./refunds.js";
import { runDueCampaigns } from "./winback.js";
import { recheckDueCredentials } from "./credential-health.js";
import type { Mailer } from "../mail/index.js";
import { subRowToDomain } from "../repo/customers.js";
import { scanDueVoidedPurchases } from "../stores/google/voided.js";
import type { StoreAdapter } from "../stores/types.js";

const { subscriptions, customers, customerAliases } = schema;

/**
 * The one periodic job (every minute: Workers cron in the cloud, an interval in Node):
 * record EXPIRATION for subscriptions whose access has ended, run the daily Google Play voided-purchases scan for apps
 * that are due, send due webhooks and integration deliveries, re-check store credentials that are due, open, remind and
 * resolve alert emails, then queue and run due data exports (last: they are the heaviest work).
 * Integrations and exports are fenced off: an error in either is logged and never stops the rest of the tick.
 * `stores` supplies the Play client (tests inject a fake Google).
 */
export interface TickOptions {
  stores?: Record<string, StoreAdapter>;
  /** Alert emails to project admins (services/alerts.ts); the log driver when unset. */
  mailer?: Mailer;
  /** Dashboard origin for links in alert emails (REVENUEDOT_PUBLIC_URL). */
  publicUrl?: string;
  /** Ask Apple and Google whether stored credentials still work (failing apps hourly, others daily). The entry points turn it on; tests leave it off. */
  checkCredentials?: boolean;
  /** Keys that unseal integration and export credentials (services/secrets.ts); unset falls back to the environment. */
  encryptionKey?: string;
  signingKey?: string;
  /** Data exports run here unless false (the Worker skips them on request-kicked ticks). */
  exports?: boolean;
  /** Win-back campaigns send here unless false (the Worker sends them from the cron only, like exports). */
  winback?: boolean;
  /** Refund Control retries call the App Store here unless false (the Worker retries from the cron only). */
  consumption?: boolean;
  /** RevenueDot Cloud: integrations and exports refuse URLs on private networks too (services/outbound.ts). */
  strictUrls?: boolean;
}

export async function tick(db: DB, now: Date, fetchImpl: typeof fetch = fetch, opts: TickOptions = {}) {
  const expired = await recordDueExpirations(db, now);
  const voided = await scanDueVoidedPurchases(db, now, opts.stores ?? {}, fetchImpl);
  // Refund Control answers that failed for a passing reason, inside Apple's 12-hour window.
  let consumption = 0;
  if (opts.consumption !== false) {
    try { consumption = await retryDueConsumption({ db, stores: opts.stores ?? {}, fetch: fetchImpl, now: () => now }); } catch (e) { console.error("tick: consumption information retries failed", e); }
  }
  const sent = await deliverDue(db, fetchImpl, now);
  // A bad REVENUEDOT_ENCRYPTION_KEY leaves deliveries and exports queued (not failed) until the key is fixed.
  const secretKey = await depsSecretKey(opts).then((k) => ({ ok: true as const, k }), (e) => { console.error("tick: integration secrets key", e); return { ok: false as const }; });
  let integrations = 0;
  if (secretKey.ok) {
    try {
      integrations = await deliverDueIntegrations(db, { fetch: fetchImpl, now, secretKey: secretKey.k, publicUrl: opts.publicUrl, strictUrls: opts.strictUrls });
    } catch (e) {
      console.error("tick: integration deliveries failed", e);
    }
  }
  const credentialsChecked = opts.checkCredentials ? await recheckDueCredentials({ db, fetch: fetchImpl, now: () => now, stores: opts.stores ?? {}, encryptionKey: opts.encryptionKey, signingKey: opts.signingKey }, now) : 0;
  const alerts = await runAlerts({ db, mailer: opts.mailer, publicUrl: opts.publicUrl }, now);
  // Win-back campaigns that are due today (each runs once a day at its UTC hour).
  let winback = 0;
  if (opts.winback !== false) {
    try { winback = await runDueCampaigns({ db, mailer: opts.mailer, now: () => now }, opts.publicUrl); } catch (e) { console.error("tick: win-back campaigns failed", e); }
  }
  let exports = 0;
  if (opts.exports !== false && secretKey.ok) {
    try {
      await queueDueExports(db, now);
      exports = await processExportRuns(db, { fetch: fetchImpl, now, secretKey: secretKey.k, strictUrls: opts.strictUrls });
    } catch (e) {
      console.error("tick: data exports failed", e);
    }
  }
  return { expired, voided, consumption, sent, integrations, exports, credentialsChecked, alerts, winback };
}

/** EXPIRATION for every subscription whose access (including any grace period) has ended; optionally one chain only. */
export async function recordDueExpirations(db: DB, now: Date, only?: { projectId: string; store: string; storeKey: string }) {
  const expired = await db.select().from(subscriptions).where(and(
    isNull(subscriptions.expiredEventAt), isNotNull(subscriptions.expiresDate), lte(subscriptions.expiresDate, now),
    or(isNull(subscriptions.gracePeriodExpiresDate), lte(subscriptions.gracePeriodExpiresDate, now)),
    ...(only ? [eq(subscriptions.projectId, only.projectId), eq(subscriptions.store, only.store), eq(subscriptions.storeKey, only.storeKey)] : []),
  )).limit(500);
  for (const s of expired) {
    const [customer] = await db.select().from(customers).where(eq(customers.id, s.customerId));
    if (!customer) continue;
    const aliases = await db.select({ a: customerAliases.appUserId }).from(customerAliases).where(eq(customerAliases.customerId, customer.id));
    const appUserId = aliases.find((a) => !a.a.startsWith("$RCAnonymousID:"))?.a ?? customer.originalAppUserId;
    const d = subRowToDomain(s);
    if (!s.refundedAt) {
      await recordEvent(db, {
        projectId: s.projectId, appId: s.appId, customer, appUserId,
        derived: { type: "EXPIRATION", expirationReason: expirationReasonOf(d) },
        subject: {
          store: d.store, productId: d.productIdentifier, productPlanId: d.productPlanIdentifier, periodType: d.periodType,
          purchasedAt: d.purchaseDate, expiresAt: d.expiresDate, transactionId: d.storeTransactionId ?? null,
          originalTransactionId: d.originalTransactionId ?? s.storeKey, isSandbox: d.isSandbox, isFamilyShare: d.ownershipType === "FAMILY_SHARED",
          countryCode: s.countryCode, price: d.price, priceUsd: s.priceUsd, presentedOfferingId: s.presentedOfferingId,
        },
        now,
      });
    }
    await db.update(subscriptions).set({ expiredEventAt: now }).where(eq(subscriptions.id, s.id));
  }
  return expired.length;
}
