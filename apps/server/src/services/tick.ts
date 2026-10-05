import { and, eq, isNotNull, isNull, lte, or, type SQLWrapper } from "drizzle-orm";
import { expirationReasonOf } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { recordEvent } from "./events.js";
import { deliverDue, pruneAttemptLogs } from "./webhooks.js";
import { deliverDueIntegrations } from "./integrations/deliver.js";
import { refreshDueAdMob } from "./ads/admob.js";
import { purgeFunnelClientContext } from "./web/funnels.js";
import { processExportRuns, queueDueExports } from "./exports/run.js";
import { pruneEmailExportFiles } from "./exports/email.js";
import { linkBase } from "./account-email.js";
import { depsSecretKey } from "./secrets.js";
import { notMoving } from "./archive/moving.js";
import { processExports } from "./archive/export.js";
import { dbStore } from "./archive/store.js";
import { processServerMoves } from "./archive/server-move.js";
import { runBilling, runGate } from "./billing/meter.js";
import { pausedEvent, pausedProject } from "./billing/gate.js";
import { stripeProblem } from "./billing/stripe.js";
import { runAlerts } from "./alerts.js";
import { runAccountNotifications } from "./account-notifications.js";
import { runJourneys } from "./journeys.js";
import { retryDueConsumption } from "./refunds.js";
import { runDueCampaigns } from "./winback.js";
import { runCountJobs } from "./customer-counts.js";
import { runPaymentRecovery } from "./payment-recovery.js";
import type { StripeConnectConfig } from "./stripe-connect-config.js";
import { recheckDueCredentials } from "./credential-health.js";
import { refreshDueStorePrices } from "./store-prices.js";
import { sealStoredSecrets } from "./seal-backfill.js";
import type { Deps } from "../context.js";
import { ensureFirstSaleCards } from "./assistant/first-sale.js";
import { pruneStreams } from "./assistant/store.js";
import { pruneRejected } from "../stores/rejected.js";
import { pruneRateLimits } from "./rate-limit.js";
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
  /** Re-read App Store and Google Play prices of apps not refreshed in 24 hours (services/store-prices.ts). The entry points turn it on. */
  storePrices?: boolean;
  /** Keys that unseal integration and export credentials (services/secrets.ts); unset falls back to the environment. */
  encryptionKey?: string;
  signingKey?: string;
  /** Data exports run here unless false (the Worker skips them on request-kicked ticks). */
  exports?: boolean;
  /** Win-back campaigns send here unless false (the Worker sends them from the cron only, like exports). */
  winback?: boolean;
  /** Exact customer counts of large projects go on here unless false (the Worker counts from the cron only). */
  counts?: boolean;
  /** Wall-clock budget for those counts per tick (default 15 seconds; the Worker's cron has 30 seconds of CPU). */
  countBudgetMs?: number;
  /** Refund Control retries call the App Store here unless false (the Worker retries from the cron only). */
  consumption?: boolean;
  /** RevenueDot Cloud: integrations and exports refuse URLs on private networks too (services/outbound.ts). */
  strictUrls?: boolean;
  /** AdMob connections reload their ad units once a day here unless false (the Worker does it from the cron only). */
  admob?: boolean;
  googleOAuth?: { clientId?: string; clientSecret?: string };
  /** Payment recovery emails send here unless false (the Worker sends them from the cron only, like win-back). */
  recovery?: boolean;
  /** "Connect with Stripe" platform keys: recovery reads a connected Stripe customer's email with them. */
  stripeConnect?: StripeConnectConfig;
  /** Remove delivery attempt details older than 30 days here unless false (the Worker does it from the cron only). */
  pruneDeliveryLogs?: boolean;
  /** Remove funnel visitors' IP addresses and user agents older than 7 days now (default: at minute 7 of each hour). */
  purgeFunnelClients?: boolean;
  /** Enterprise extensions (extensions.ts) whose own periodic work runs last. None in the open-source build. */
  extensions?: import("../extensions.js").ServerExtension[];
  /** Full exports and the dashboard's moves run here unless false (prd/moves-export/PRD.md). */
  archives?: boolean;
  archiveStore?: import("./archive/store.js").ArchiveStore;
  edition?: "cloud" | "self-hosted";
  /** RevenueDot Cloud billing (prd/cloud-billing/PRD.md): metering, the Stripe meter and usage emails. Cloud only. */
  billing?: import("./billing/stripe.js").BillingConfig | null;
  /**
   * RevenueDot Cloud's go-live gate holds deliveries on this run even without `edition: "cloud"`: the Worker's
   * request-kicked runs send new deliveries at once, so they must hold a paused account's first (services/billing/gate.ts).
   */
  liveGate?: boolean;
  /** Weekly summaries, experiment results and anomaly alerts (prd/account-settings §4) run here unless false. */
  accountNotifications?: boolean;
  /** Onboarding and growth emails to Cloud accounts (prd/onboarding-emails/PRD.md), every 5 minutes; null or unset: off. Cloud only. */
  journeys?: import("./journeys.js").JourneyConfig | null;
  /** Aborted when this replica starts shutting down: the run stops sending webhooks after those in flight and skips the
   *  steps it has not started (each resumes on the next run, on any replica). */
  signal?: AbortSignal;
}

export async function tick(db: DB, now: Date, fetchImpl: typeof fetch = fetch, opts: TickOptions = {}) {
  const expired = await recordDueExpirations(db, now);
  // One-time backfill (migration 0041): plain store secrets are sealed in place, and values of an older key re-sealed.
  // Only an error code is logged: a database error can quote the value it was given.
  let secretsSealed = 0;
  try { const r = await sealStoredSecrets({ db, now: () => now, encryptionKey: opts.encryptionKey, signingKey: opts.signingKey, columns: (opts.extensions ?? []).flatMap((x) => x.sealedColumns?.() ?? []) }); secretsSealed = r.moved + r.resealed; } catch (e) {
    console.error(`tick: secrets backfill failed (${(e as { code?: string })?.code ?? (e instanceof Error ? e.name : "error")})`);
  }
  const voided = await scanDueVoidedPurchases(db, now, opts.stores ?? {}, fetchImpl, { encryptionKey: opts.encryptionKey, signingKey: opts.signingKey });
  // Refund Control answers that failed for a passing reason, inside Apple's 12-hour window.
  let consumption = 0;
  if (opts.consumption !== false) {
    try { consumption = await retryDueConsumption({ db, stores: opts.stores ?? {}, fetch: fetchImpl, now: () => now, encryptionKey: opts.encryptionKey, signingKey: opts.signingKey }); } catch (e) { console.error("tick: consumption information retries failed", e); }
  }
  // Cloud's go-live gate holds production deliveries of paused accounts and sends held ones once Pro starts, before anything
  // goes out. Request-kicked runs (liveGate without the cloud edition) only hold; the cron does the rest. The senders also
  // skip a paused account's deliveries, so one queued while this run sends is never sent before a run holds it.
  let gate = 0;
  const gated = (opts.edition === "cloud" || opts.liveGate === true) && !stripeProblem(opts.billing);
  if (gated) {
    try { gate = await runGate({ db, now, mailer: opts.mailer, publicUrl: opts.publicUrl, config: opts.billing ?? null, holdOnly: opts.edition !== "cloud" }); } catch (e) { console.error("tick: go-live gate failed", e); }
  }
  const skip = gated ? (eventId: SQLWrapper) => pausedEvent(eventId, now) : undefined;
  const sent = await deliverDue(db, fetchImpl, now, 50, 20_000, opts.signal, skip);
  // Draining (SIGTERM): the long steps below (integrations, exports, AdMob, full exports and moves) wait for the next run.
  const draining = () => opts.signal?.aborted === true;
  // A bad REVENUEDOT_ENCRYPTION_KEY leaves deliveries and exports queued (not failed) until the key is fixed.
  const secretKey = await depsSecretKey(opts).then((k) => ({ ok: true as const, k }), (e) => { console.error("tick: integration secrets key", e); return { ok: false as const }; });
  let integrations = 0;
  if (secretKey.ok && !draining()) {
    try {
      integrations = await deliverDueIntegrations(db, { fetch: fetchImpl, now, secretKey: secretKey.k, publicUrl: opts.publicUrl, strictUrls: opts.strictUrls, skip });
    } catch (e) {
      console.error("tick: integration deliveries failed", e);
    }
  }
  const credentialsChecked = opts.checkCredentials ? await recheckDueCredentials({ db, fetch: fetchImpl, now: () => now, stores: opts.stores ?? {}, encryptionKey: opts.encryptionKey, signingKey: opts.signingKey, stripeConnect: opts.stripeConnect }, now) : 0;
  let storePrices = 0;
  // Store prices call App Store Connect and Google Play: a long step, skipped while draining like the others.
  if (opts.storePrices && !draining()) {
    try { storePrices = await refreshDueStorePrices({ db, now: () => now, stores: opts.stores ?? {}, fetch: fetchImpl, encryptionKey: opts.encryptionKey, signingKey: opts.signingKey } as Deps); } catch (e) { console.error("tick: store prices failed", e); }
  }
  const alerts = await runAlerts({ db, mailer: opts.mailer, publicUrl: opts.publicUrl }, now);
  // Account notification emails (weekly summary, experiment results, revenue anomalies): bounded per tick, idempotent.
  let notifications = 0;
  if (opts.accountNotifications !== false && !draining()) {
    try {
      const n = await runAccountNotifications({ db, mailer: opts.mailer, publicUrl: opts.publicUrl, fetch: fetchImpl }, now);
      notifications = n.weekly + n.experiments + n.anomalies;
    } catch (e) { console.error("tick: account notifications failed", e); }
  }
  // Win-back campaigns that are due today (each runs once a day at its UTC hour).
  let winback = 0;
  if (opts.winback !== false) {
    try { winback = await runDueCampaigns({ db, mailer: opts.mailer, now: () => now }, opts.publicUrl); } catch (e) { console.error("tick: win-back campaigns failed", e); }
  }
  // Exact counts of large projects' lists, previews and policies (services/customer-counts.ts), within a time budget.
  let counts = 0;
  if (opts.counts !== false && !draining()) {
    try { counts = (await runCountJobs(db, now, { budgetMs: opts.countBudgetMs })).pages; } catch (e) { console.error("tick: customer counts failed", e); }
  }
  // Payment recovery: close cases whose window passed, email the due steps (prd/payment-recovery/PRD.md).
  let recovery = { sent: 0, failed: 0, skipped: 0, closed: 0 };
  if (opts.recovery !== false) {
    try {
      recovery = await runPaymentRecovery({ db, mailer: opts.mailer, now: () => now, publicUrl: opts.publicUrl, stores: opts.stores, fetch: fetchImpl, encryptionKey: opts.encryptionKey, signingKey: opts.signingKey, stripeConnect: opts.stripeConnect });
    } catch (e) { console.error("tick: payment recovery failed", e); }
  }
  // RevenueDot AI: the first-sale card for projects whose first paid production purchase just arrived, and old stream chunks.
  let firstSales = 0;
  try { firstSales = await ensureFirstSaleCards(db, now); await pruneStreams(db, now); } catch (e) { console.error("tick: first-sale cards failed", e); }
  // Once an hour: rejected store notification requests older than a week, and rate-limit windows older than two days.
  if (now.getUTCMinutes() === 7 && lastRejectedPruneHour !== Math.floor(now.getTime() / 3_600_000)) {
    lastRejectedPruneHour = Math.floor(now.getTime() / 3_600_000);
    try { await pruneRejected(db, now); await pruneRateLimits(db, now); } catch (e) { console.error("tick: pruning rejected notifications failed", e); }
  }
  let exports = 0;
  if (opts.exports !== false && secretKey.ok && !draining()) {
    try {
      await queueDueExports(db, now, gated ? (projectId: SQLWrapper) => pausedProject(projectId, now) : undefined);
      // Email exports keep their files where full-export archives go, and sign the download links with the same keys.
      const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
      const store = opts.archiveStore ?? dbStore(db);
      exports = await processExportRuns(db, {
        fetch: fetchImpl, now, secretKey: secretKey.k, strictUrls: opts.strictUrls, store, mailer: opts.mailer, publicUrl: linkBase({ publicUrl: opts.publicUrl }),
        linkMaterial: opts.encryptionKey || opts.signingKey || env.REVENUEDOT_ENCRYPTION_KEY || env.REVENUEDOT_SIGNING_KEY || undefined,
      });
      await pruneEmailExportFiles(db, store, now);
    } catch (e) {
      console.error("tick: data exports failed", e);
    }
  }
  let admob = 0;
  if (opts.admob !== false && secretKey.ok && !draining()) {
    try { admob = await refreshDueAdMob({ db, fetch: fetchImpl, now: () => now, secretKey: secretKey.k, googleOAuth: opts.googleOAuth }); } catch (e) { console.error("tick: AdMob refresh failed", e); }
  }
  // Funnel visitors' IP addresses and user agents (kept for Meta and Branch) are removed after 7 days, once an hour.
  let funnelClientsPurged = 0;
  const hour = Math.floor(now.getTime() / 3_600_000);
  if (opts.purgeFunnelClients ?? (now.getUTCMinutes() === 7 && lastFunnelPurgeHour !== hour)) {
    lastFunnelPurgeHour = hour;
    try { funnelClientsPurged = await purgeFunnelClientContext(db, now); } catch (e) { console.error("tick: funnel visitor purge failed", e); }
  }
  // Delivery attempt details (answers, signatures) are removed 30 days after each attempt.
  let attemptLogsPruned = 0;
  if (opts.pruneDeliveryLogs !== false) {
    try { attemptLogsPruned = await pruneAttemptLogs(db, now); } catch (e) { console.error("tick: pruning delivery attempt details failed", e); }
  }
  // Full exports and server-run moves (bounded; the rest waits for the next tick), then Cloud billing.
  let archives = 0, moves = 0, billing = 0;
  if (opts.archives !== false && !draining()) {
    const deps = { db, now: () => now, fetch: fetchImpl, stores: opts.stores ?? {}, encryptionKey: opts.encryptionKey, signingKey: opts.signingKey, edition: opts.edition, archiveStore: opts.archiveStore };
    try {
      archives = await processExports({ db, store: opts.archiveStore ?? dbStore(db), now, serverKey: secretKey.ok ? secretKey.k : null, budgetMs: 15_000 });
      moves = await processServerMoves(deps, 10_000);
    } catch (e) { console.error("tick: exports and moves failed", e); }
  }
  let journeys = 0;
  if (opts.edition === "cloud" && opts.journeys && now.getUTCMinutes() % 5 === 0 && !draining()) {
    try { journeys = (await runJourneys({ db, mailer: opts.mailer, publicUrl: opts.publicUrl, config: opts.journeys }, now)).sent; } catch (e) { console.error("tick: journey emails failed", e); }
  }
  if (opts.edition === "cloud") {
    try { billing = await runBilling({ db, now, fetch: fetchImpl, mailer: opts.mailer, publicUrl: opts.publicUrl, config: opts.billing ?? null }); } catch (e) { console.error("tick: billing failed", e); }
  }
  const extensions: Record<string, number> = {};
  for (const x of opts.extensions ?? []) {
    try { Object.assign(extensions, (await x.tick?.(db, now)) ?? {}); } catch (e) { console.error(`tick: ${x.name} failed`, e); }
  }
  return { expired, secretsSealed, voided, consumption, sent, integrations, exports, credentialsChecked, storePrices, alerts, notifications, winback, counts, recovery, admob, funnelClientsPurged, attemptLogsPruned, firstSales, archives, moves, billing, gate, journeys, ...(opts.extensions?.length ? { extensions } : {}) };
}

let lastFunnelPurgeHour = -1;
let lastRejectedPruneHour = -1;

/** EXPIRATION for every subscription whose access (including any grace period) has ended; optionally one chain only. */
export async function recordDueExpirations(db: DB, now: Date, only?: { projectId: string; store: string; storeKey: string }) {
  const expired = await db.select().from(subscriptions).where(and(
    isNull(subscriptions.expiredEventAt), isNotNull(subscriptions.expiresDate), lte(subscriptions.expiresDate, now),
    or(isNull(subscriptions.gracePeriodExpiresDate), lte(subscriptions.gracePeriodExpiresDate, now)),
    // A moving project's expirations are recorded by the server that serves it when the move ends.
    ...(only ? [] : [notMoving(subscriptions.projectId)]),
    ...(only ? [eq(subscriptions.projectId, only.projectId), eq(subscriptions.store, only.store), eq(subscriptions.storeKey, only.storeKey)] : []),
  )).limit(500);
  let recorded = 0;
  for (const s of expired) {
    // One transaction marks the subscription (only if no other run has) and records the event, so two runs at once
    // (several replicas, or the Worker's cron and a request-kicked run) record one EXPIRATION; a failure records neither.
    if (await db.transaction(async (tx) => {
      const [claimed] = await tx.update(subscriptions).set({ expiredEventAt: now }).where(and(eq(subscriptions.id, s.id), isNull(subscriptions.expiredEventAt))).returning({ id: subscriptions.id });
      if (!claimed) return false;
      await recordExpiration(tx as unknown as DB, s, now);
      return true;
    })) recorded++;
  }
  return recorded;
}

async function recordExpiration(db: DB, s: typeof subscriptions.$inferSelect, now: Date) {
  const [customer] = await db.select().from(customers).where(eq(customers.id, s.customerId));
  if (!customer) return;
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
}
