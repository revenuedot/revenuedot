import { and, eq, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../mail/index.js";
import { journeyEmail, JOURNEY_FROM, JOURNEY_REPLY_TO, type JourneyCtx, type StepId } from "../mail/journeys.js";
import { issueToken, linkBase, randomToken, retireTokens } from "./account-email.js";
import { sha256Hex } from "./auth.js";
import { billCents, monthOf, planOf, plansFrom } from "./billing/plans.js";
import { rowsOf } from "./archive/tables.js";

/**
 * Onboarding and growth emails to RevenueDot Cloud accounts (prd/onboarding-emails/PRD.md). A rules pass in the cron
 * tick: read each candidate's facts fresh from Postgres, pick the highest-priority step that is due and allowed, claim it
 * in journey_sends, send it. Every send re-checks the facts, so nobody gets a nudge for a step they just finished, and a
 * change to the plan below applies to everyone in flight.
 */

const H = 3_600_000, D = 24 * H;

export interface JourneyConfig {
  /** Onboarding steps go only to accounts created at or after this time (the launch); event steps go to everyone. */
  since: Date;
  /** Domains ("circo.so") and addresses never emailed. */
  exclude: string[];
  plansJson?: string | null;
}
export interface JourneyDeps { db: DB; mailer?: Mailer; publicUrl?: string; config: JourneyConfig }
export const JOURNEY_LIMITS = { emails: 25, budgetMs: 15_000, chunk: 200 };
/** At most one journey email per person every 44 hours, and three in any 7 days. */
export const MIN_GAP_MS = 44 * H;
export const WEEK_MAX = 3;
export const DEFAULT_TIME_ZONE = "America/New_York";

/** Everything the rules read about one account, across the projects it owns. Times are epoch ms or null. */
export interface Facts {
  userId: string; email: string; name: string | null; createdAt: number; verified: boolean; timeZone: string | null;
  path: "new" | "revenuecat" | null; referralCode: string | null; productEmails: boolean;
  /** The owned project to link to: the one with the most activity, else the oldest. */
  projectId: string | null; projectName: string | null; ownsProjects: boolean;
  memberOf: { projectId: string; projectName: string; inviter: string | null } | null;
  firstAppAt: number | null; testPurchaseAt: number | null;
  sdkFirstAt: number | null; sdkLastAt: number | null; sdk: { platform: string; version: string } | null;
  storeConnected: boolean; liveAt: number | null; lastSaleAt: number | null;
  /** The first live sale; `existing` means the app already had subscribers before RevenueDot saw it. */
  firstSale: { product: string; amount: number | null; currency: string | null; country: string | null; existing?: boolean } | null;
  rcImportAt: number | null; importedCustomers: number;
  paywallPublishedAt: number | null; experimentStartedAt: number | null;
  teammates: number; recoveryOn: boolean; assistantConnected: boolean;
  plan: string; planSince: number | null; canceledAt: number | null; tracked: number; free100At: number | null;
  /** The tracked revenue of the month the free_100 email was about. */
  overTracked: number;
  alertAt: number | null; lastNotificationAt: number | null;
  /** Switchers waiting for the cutover email: customers whose app called RevenueDot, counted up to 25 (else 0). */
  sdkCustomers: number; referralJoinedAt: number | null;
  sent: Map<StepId, number>;
}

interface Step {
  id: StepId;
  /** Onboarding steps only go to accounts created after the launch (config.since). */
  onboarding?: boolean;
  /** Celebrations and the welcome may go out on weekends and in the evening. */
  anyDay?: boolean;
  /** Any hour of any day (the welcome follows the sign-up right away). */
  anyHour?: boolean;
  /** Not held back by the 44-hour and weekly caps. */
  uncapped?: boolean;
  /** When the step becomes due (epoch ms), or null when it does not apply to this account now. */
  due: (f: Facts, now: number) => number | null;
  /** Not sent when it became due longer ago than this (stale celebrations, missed nudges). */
  freshFor: number;
}

const after = (t: number | null, ms: number) => (t === null ? null : t + ms);
const notYet = (f: Facts, ...steps: StepId[]) => steps.every((s) => !f.sent.has(s));
const migrating = (f: Facts) => f.path === "revenuecat" || f.rcImportAt !== null;
/** The plan, in priority order: when two steps are due, the first one wins and the other waits. */
export const STEPS: Step[] = [
  { id: "welcome", onboarding: true, anyHour: true, uncapped: true, freshFor: 2 * D, due: (f) => (f.ownsProjects ? f.createdAt + 5 * 60_000 : null) },
  { id: "teammate_welcome", anyDay: true, freshFor: 3 * D, due: (f) => (!f.ownsProjects && f.memberOf ? f.createdAt + 10 * 60_000 : null) },
  { id: "verify_reminder", onboarding: true, anyDay: true, uncapped: true, freshFor: 3 * D, due: (f) => (f.ownsProjects && !f.verified ? f.createdAt + D : null) },
  // Celebrations and receipts answer something that just happened, so they skip the caps.
  { id: "first_sale", anyDay: true, uncapped: true, freshFor: 3 * D, due: (f) => f.liveAt },
  { id: "standard_welcome", anyDay: true, uncapped: true, freshFor: 3 * D, due: (f) => (f.plan === "standard" ? f.planSince : null) },
  // Switching from RevenueCat: the cutover, after a week of live sales and once the app update reaches real customers
  // (25 customers seen through the SDK; a test build brings one or two). The rollout can take weeks, so it stays fresh for 60 days.
  { id: "cutover", freshFor: 60 * D, due: (f, now) => (migrating(f) && f.liveAt && f.sdkCustomers >= 25 && f.lastSaleAt && now - f.lastSaleAt < 3 * D ? f.liveAt + 7 * D : null) },
  { id: "side_by_side", onboarding: true, freshFor: 7 * D, due: (f) => (f.rcImportAt && !f.liveAt ? f.rcImportAt + D : null) },
  // Building an app (or already selling with your own code): the next missing step.
  { id: "store_keys", onboarding: true, freshFor: 10 * D, due: (f) => (f.sdkFirstAt && !f.storeConnected && !f.liveAt ? f.sdkFirstAt + D : null) },
  { id: "connect_app", onboarding: true, freshFor: 10 * D,
    due: (f) => (!migrating(f) && !f.sdkFirstAt && (f.testPurchaseAt || f.firstAppAt) ? (f.testPurchaseAt ? f.testPurchaseAt + 20 * H : f.createdAt + 3 * D) : null) },
  { id: "paywall", onboarding: true, freshFor: 10 * D,
    due: (f) => (!migrating(f) && f.sdkFirstAt && f.storeConnected && !f.paywallPublishedAt && !f.liveAt ? Math.max(f.sdkFirstAt + 3 * D, f.createdAt + 3 * D, (f.sent.get("store_keys") ?? 0) + 2 * D) : null) },
  // One email to anyone stuck, at the first step where they stall: no SDK call (day 5), no store five days after the store
  // email; for switchers, no import (day 3), or no store notifications five days after the side-by-side email.
  { id: "need_hand", onboarding: true, freshFor: 6 * D, due: (f) => {
    if (f.liveAt) return null;
    if (migrating(f)) {
      if (!f.rcImportAt) return f.createdAt + 3 * D;
      const forwarding = f.lastNotificationAt !== null && f.lastNotificationAt >= f.rcImportAt;
      return forwarding ? null : (f.sent.get("side_by_side") ?? f.rcImportAt + D) + 5 * D;
    }
    if (!f.sdkFirstAt) return f.createdAt + 5 * D;
    return f.storeConnected ? null : (f.sent.get("store_keys") ?? f.sdkFirstAt + D) + 5 * D;
  } },
];

/** Hour (0–23) and weekday (0 = Sunday) in a time zone; an unknown zone falls back to the default. */
export function localTime(at: number, timeZone: string | null): { hour: number; weekday: number } {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(at));
  let parts: Intl.DateTimeFormatPart[];
  try { parts = fmt(timeZone || DEFAULT_TIME_ZONE); } catch { parts = fmt(DEFAULT_TIME_ZONE); }
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "Mon");
  return { hour, weekday };
}

/** Nudges: 09:00–17:00 on weekdays. Welcome and celebrations: 08:00–21:00 any day. */
export function inWindow(step: Step, at: number, timeZone: string | null) {
  if (step.anyHour) return true;
  const { hour, weekday } = localTime(at, timeZone);
  if (step.anyDay) return hour >= 8 && hour < 21;
  return weekday >= 1 && weekday <= 5 && hour >= 9 && hour < 17;
}

/** The step to send now, or null. Pure: tests drive it with hand-made facts. */
export function pickStep(f: Facts, now: number, cfg: Pick<JourneyConfig, "since">, only?: StepId[]): StepId | null {
  // The welcome is sign-up mail: it neither waits for the caps nor counts towards them. The verification reminder skips the
  // caps but counts, so the day-1 nudge does not follow it minutes later.
  const times = [...f.sent.entries()].filter(([k]) => k !== "welcome").map(([, t]) => t);
  const last = times.length ? Math.max(...times) : 0;
  const capped = now - last < MIN_GAP_MS || times.filter((t) => now - t < 7 * D).length >= WEEK_MAX;
  const nearAlert = f.alertAt !== null && now - f.alertAt < D;
  for (const s of STEPS) {
    if (f.sent.has(s.id) || (only && !only.includes(s.id))) continue;
    // People who only joined someone else's project get the teammate welcome and nothing else.
    if (!f.ownsProjects && s.id !== "teammate_welcome") continue;
    if (s.onboarding && f.createdAt < cfg.since.getTime()) continue;
    const due = s.due(f, now);
    if (due === null || due > now || now - due > s.freshFor) continue;
    if (!s.uncapped && capped) continue;
    if (s.id !== "welcome" && nearAlert) continue;
    if (!inWindow(s, now, f.timeZone)) continue;
    return s.id;
  }
  return null;
}

const ts = (v: unknown): number | null => (v === null || v === undefined ? null : new Date(v as string).getTime());
const firstName = (name: string | null) => {
  const w = name?.trim().split(/\s+/)[0] ?? "";
  return /^[\p{L}][\p{L}'-]{0,23}$/u.test(w) ? w[0]!.toUpperCase() + w.slice(1) : null;
};

/** Facts for a set of users, one query. */
export async function loadFacts(db: DB, userIds: string[], now: Date, since: Date = new Date(0)): Promise<Facts[]> {
  const sinceMs = since.getTime();
  if (!userIds.length) return [];
  const month = monthOf(now);
  const ids = sql.join(userIds.map((id) => sql`${id}`), sql`, `);
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    WITH owned AS (SELECT p.id, p.name, p.owner_user_id AS uid, p.rc_import_at, p.recovery_settings, p.created_at FROM projects p WHERE p.owner_user_id IN (${ids})),
    -- Per project: the first test purchase and the first and last live sale. Each reads a partial index (transactions_sandbox,
    -- transactions_live_sales) and stops at its first row, so imported history is never read. A live sale is one RevenueDot
    -- recorded within 2 days of the purchase (a restored old receipt is not a sale).
    pm AS (SELECT o.id, o.uid,
      (SELECT t.created_at FROM transactions t WHERE t.project_id = o.id AND t.is_sandbox ORDER BY t.created_at ASC LIMIT 1) AS test_at,
      (SELECT t.id FROM transactions t WHERE t.project_id = o.id AND t.source IS NULL AND NOT t.is_sandbox AND t.revenue_usd > 0 AND t.kind IN ('purchase','renewal','one_time')
          AND t.created_at - t.purchased_at < interval '2 days' ORDER BY t.created_at ASC LIMIT 1) AS first_tx,
      (SELECT t.created_at FROM transactions t WHERE t.project_id = o.id AND t.source IS NULL AND NOT t.is_sandbox AND t.revenue_usd > 0 AND t.kind IN ('purchase','renewal','one_time')
          AND t.created_at - t.purchased_at < interval '2 days' ORDER BY t.created_at DESC LIMIT 1) AS last_at
      FROM owned o),
    firsts AS (SELECT pm.uid, t.project_id, t.customer_id, t.created_at, t.kind, t.product_identifier, t.price_amount, t.price_currency, t.country_code FROM pm JOIN transactions t ON t.id = pm.first_tx)
    SELECT u.id, u.email, u.name, u.created_at, u.email_verified_at, u.time_zone, u.journey_path, u.referral_code, u.product_emails,
      (SELECT count(*) FROM owned o WHERE o.uid = u.id) AS owned,
      -- The project to link to: the oldest one whose app has talked to RevenueDot, else the oldest.
      (SELECT o.id FROM owned o WHERE o.uid = u.id ORDER BY EXISTS (SELECT 1 FROM sdk_versions s WHERE s.project_id = o.id) DESC, o.created_at ASC LIMIT 1) AS project_id,
      (SELECT o.name FROM owned o WHERE o.uid = u.id ORDER BY EXISTS (SELECT 1 FROM sdk_versions s WHERE s.project_id = o.id) DESC, o.created_at ASC LIMIT 1) AS project_name,
      (SELECT min(a.created_at) FROM apps a JOIN owned o ON o.id = a.project_id WHERE o.uid = u.id) AS first_app_at,
      (SELECT min(pm.test_at) FROM pm WHERE pm.uid = u.id) AS test_purchase_at,
      (SELECT min(s.first_seen_at) FROM sdk_versions s JOIN owned o ON o.id = s.project_id WHERE o.uid = u.id) AS sdk_first_at,
      (SELECT max(s.last_seen_at) FROM sdk_versions s JOIN owned o ON o.id = s.project_id WHERE o.uid = u.id) AS sdk_last_at,
      (SELECT json_build_object('platform', s.platform_flavor, 'os', s.platform, 'version', s.sdk_version) FROM sdk_versions s JOIN owned o ON o.id = s.project_id WHERE o.uid = u.id ORDER BY s.first_seen_at ASC LIMIT 1) AS sdk,
      (SELECT EXISTS (SELECT 1 FROM apps a JOIN owned o ON o.id = a.project_id WHERE o.uid = u.id AND (
          -- Store secrets (the .p8 key, the Play service account) are sealed in apps.secrets since migration 0041.
          (a.type IN ('app_store','mac_app_store','play_store','amazon') AND (a.secrets IS NOT NULL OR a.credentials_status = 'ok'))
          OR a.last_notification_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM stripe_connections sc WHERE sc.app_id = a.id AND sc.status = 'connected')))) AS store_connected,
      -- Live: a paid production sale recorded within 2 days of the purchase (imported history is recorded much later).
      (SELECT min(f.created_at) FROM firsts f WHERE f.uid = u.id) AS live_at,
      (SELECT max(pm.last_at) FROM pm WHERE pm.uid = u.id) AS last_sale_at,
      (SELECT json_build_object('product', f.product_identifier, 'amount', f.price_amount, 'currency', f.price_currency, 'country', f.country_code,
          -- A renewal of a customer RevenueDot never saw before: the app already sold before it came to RevenueDot. A trial that
          -- converts is a renewal too, but its trial start is an earlier row for the same customer.
          'existing', f.kind = 'renewal' AND NOT EXISTS (SELECT 1 FROM transactions t2 WHERE t2.project_id = f.project_id AND t2.customer_id = f.customer_id AND t2.created_at < f.created_at))
          FROM firsts f WHERE f.uid = u.id ORDER BY f.created_at ASC LIMIT 1) AS first_sale,
      (SELECT min(o.rc_import_at) FROM owned o WHERE o.uid = u.id) AS rc_import_at,
      -- Only for switchers who have not had the cutover email: 25 customers seen through the SDK means the app update shipped.
      CASE WHEN (u.journey_path = 'revenuecat' OR EXISTS (SELECT 1 FROM owned o WHERE o.uid = u.id AND o.rc_import_at IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM journey_sends js WHERE js.user_id = u.id AND js.step = 'cutover')
        THEN (SELECT count(*) FROM (SELECT 1 FROM customers c JOIN owned o ON o.id = c.project_id WHERE o.uid = u.id AND c.last_seen_sdk_version IS NOT NULL LIMIT 25) x)
        ELSE 0 END AS sdk_customers,
      (SELECT min(pw.published_at) FROM paywalls pw JOIN owned o ON o.id = pw.project_id WHERE o.uid = u.id) AS paywall_published_at,
      (SELECT min(e.started_at) FROM experiments e JOIN owned o ON o.id = e.project_id WHERE o.uid = u.id) AS experiment_started_at,
      (SELECT count(*) FROM memberships m JOIN owned o ON o.id = m.project_id WHERE o.uid = u.id AND m.user_id <> u.id)
        + (SELECT count(*) FROM invites i JOIN owned o ON o.id = i.project_id WHERE o.uid = u.id AND i.revoked_at IS NULL) AS teammates,
      (SELECT EXISTS (SELECT 1 FROM owned o WHERE o.uid = u.id AND o.recovery_settings->>'enabled' = 'true')) AS recovery_on,
      (SELECT EXISTS (SELECT 1 FROM api_keys k WHERE k.created_by_user_id = u.id AND k.oauth_client_id IS NOT NULL)) AS assistant_connected,
      ba.plan AS ba_plan, ba.status AS ba_status, ba.updated_at AS ba_updated_at, ba.standard_started_at AS ba_started, ba.stripe_subscription_id AS ba_sub,
      (SELECT coalesce(sum(bu.tracked_revenue_usd), 0) FROM billing_usage bu WHERE bu.owner_user_id = u.id AND bu.month = (
          SELECT split_part(bn.key, ':', 1) FROM billing_notices bn WHERE bn.user_id = u.id AND bn.key LIKE '%:free_100' ORDER BY bn.sent_at DESC LIMIT 1)) AS over_tracked,
      (SELECT max(a.last_notification_at) FROM apps a JOIN owned o ON o.id = a.project_id WHERE o.uid = u.id) AS last_notification_at,
      (SELECT max(r.created_at) FROM users r WHERE u.referral_code IS NOT NULL AND r.referred_by = u.referral_code) AS referral_joined_at,
      (SELECT coalesce(sum(bu.tracked_revenue_usd), 0) FROM billing_usage bu WHERE bu.owner_user_id = u.id AND bu.month = ${month}) AS tracked,
      -- The latest "passed Cloud Free" email, also last month's: the follow-ups must survive the month boundary.
      (SELECT max(bn.sent_at) FROM billing_notices bn WHERE bn.user_id = u.id AND bn.key LIKE '%:free_100' AND bn.sent_at >= ${new Date(now.getTime() - 35 * D).toISOString()}::timestamptz) AS free100_at,
      (SELECT max(coalesce(al.last_notified_at, al.opened_at)) FROM alerts al JOIN owned o ON o.id = al.project_id WHERE o.uid = u.id) AS alert_at,
      (SELECT json_build_object('project_id', p.id, 'project_name', p.name, 'inviter', iu.name)
          FROM memberships m JOIN projects p ON p.id = m.project_id
          LEFT JOIN invites i ON i.project_id = p.id AND i.accepted_by = u.id LEFT JOIN users iu ON iu.id = i.invited_by
          WHERE m.user_id = u.id ORDER BY p.created_at ASC LIMIT 1) AS member_of,
      (SELECT json_object_agg(js.step, js.sent_at) FROM journey_sends js WHERE js.user_id = u.id) AS sent
    FROM users u LEFT JOIN billing_accounts ba ON ba.user_id = u.id
    WHERE u.id IN (${ids})`));
  return rows.map((r): Facts => {
    const json = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (typeof v === "string" ? JSON.parse(v) : v) as T);
    const sdk = json<{ platform: string; os: string; version: string }>(r.sdk);
    const sale = json<{ product: string; amount: number | null; currency: string | null; country: string | null; existing?: boolean }>(r.first_sale);
    const member = json<{ project_id: string; project_name: string; inviter: string | null }>(r.member_of);
    const sent = new Map<StepId, number>(Object.entries(json<Record<string, string>>(r.sent) ?? {}).map(([k, v]) => [k as StepId, new Date(v).getTime()]));
    const paying = r.ba_plan === "standard" && ["active", "past_due"].includes(String(r.ba_status));
    const plan = r.ba_plan === "enterprise" ? "enterprise" : paying ? "standard" : "free";
    return {
      userId: String(r.id), email: String(r.email), name: (r.name as string | null) ?? null, createdAt: ts(r.created_at)!, verified: r.email_verified_at !== null,
      timeZone: (r.time_zone as string | null) ?? null, path: r.journey_path === "revenuecat" || r.journey_path === "new" ? r.journey_path : null,
      referralCode: (r.referral_code as string | null) ?? null, productEmails: r.product_emails !== false,
      projectId: (r.project_id as string | null) ?? null, projectName: (r.project_name as string | null) ?? null, ownsProjects: Number(r.owned) > 0,
      memberOf: member ? { projectId: member.project_id, projectName: member.project_name, inviter: member.inviter } : null,
      firstAppAt: ts(r.first_app_at), testPurchaseAt: ts(r.test_purchase_at), sdkFirstAt: ts(r.sdk_first_at), sdkLastAt: ts(r.sdk_last_at),
      sdk: sdk ? { platform: sdkLabel(sdk.platform, sdk.os), version: sdk.version } : null,
      storeConnected: r.store_connected === true, liveAt: ts(r.live_at), lastSaleAt: ts(r.last_sale_at),
      // A brand-new app sells only through the SDK, so a first sale before any SDK call means the app sold before RevenueDot.
      firstSale: sale ? { ...sale, existing: sale.existing === true || ts(r.sdk_first_at) === null || ts(r.sdk_first_at)! > ts(r.live_at)! } : null,
      rcImportAt: ts(r.rc_import_at), importedCustomers: 0,
      paywallPublishedAt: ts(r.paywall_published_at), experimentStartedAt: ts(r.experiment_started_at),
      teammates: Number(r.teammates ?? 0), recoveryOn: r.recovery_on === true, assistantConnected: r.assistant_connected === true,
      // Standard: thanked once, from the first time it became active, and only when that was after the launch. Asked why only
      // after a real cancellation (a failed card is "unpaid", an unpaid checkout is "incomplete": neither is a choice).
      plan, planSince: plan === "standard" && (ts(r.ba_started) ?? 0) >= sinceMs ? ts(r.ba_started) : null,
      canceledAt: plan === "free" && r.ba_sub && r.ba_started && String(r.ba_status) === "canceled" ? ts(r.ba_updated_at) : null,
      overTracked: Number(r.over_tracked ?? 0),
      tracked: Number(r.tracked ?? 0), free100At: ts(r.free100_at), alertAt: ts(r.alert_at), sdkCustomers: Number(r.sdk_customers ?? 0),
      lastNotificationAt: ts(r.last_notification_at), referralJoinedAt: ts(r.referral_joined_at), sent,
    };
  });
}

const SDK_NAMES: Record<string, string> = { native: "", flutter: "Flutter", "react-native": "React Native", unity: "Unity", capacitor: "Capacitor", cordova: "Cordova", kmp: "Kotlin Multiplatform" };
function sdkLabel(flavor: string, os: string) {
  const f = SDK_NAMES[flavor.toLowerCase()] ?? flavor;
  if (f) return f;
  return /android/i.test(os) ? "Android" : /ios|mac|apple/i.test(os) ? "iOS" : os;
}

const money = (amount: number | null, currency: string | null) => {
  if (amount === null || !currency) return null;
  try { return amount.toLocaleString("en-US", { style: "currency", currency }); } catch { return `${currency} ${amount.toFixed(2)}`; }
};
const COUNTRY = (code: string | null) => {
  if (!code) return null;
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code; } catch { return code; }
};

/** The context a step's copy needs. Creates the verification token and referral code for the steps that show them. */
export async function contextFor(db: DB, f: Facts, step: StepId, base: string, unsubscribeUrl: string, token: string | null, now: Date, plansJson?: string | null): Promise<JourneyCtx> {
  const plans = plansFrom(plansJson);
  const std = planOf(plans, "standard");
  const rd = (r: number) => billCents(std, r) / 100;
  const rc = (r: number) => (r >= 2_500 ? Math.round(r) / 100 : 0);
  const member = !f.ownsProjects && f.memberOf;
  const c: JourneyCtx = {
    step, app: base, first: firstName(f.name), unsubscribeUrl, to: f.email,
    projectId: member ? f.memberOf!.projectId : f.projectId, projectName: member ? f.memberOf!.projectName : f.projectName,
    testPurchase: f.testPurchaseAt !== null, sdk: f.sdk, importedCustomers: f.importedCustomers, lastSaleAt: f.lastSaleAt ? new Date(f.lastSaleAt) : null,
    tracked: f.tracked, month: now.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }),
    priceRows: [10_000, 20_000, 50_000, 100_000, 250_000, 500_000].map((r) => [r, rd(r), rc(r)]),
    migrating: migrating(f),
    liveSince: f.liveAt ? new Date(f.liveAt).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : undefined,
    inviter: member ? f.memberOf!.inviter : null,
    sale: f.firstSale ? { product: f.firstSale.product, amount: money(f.firstSale.amount, f.firstSale.currency), country: COUNTRY(f.firstSale.country), existing: f.firstSale.existing === true } : null,
    appCreated: f.firstAppAt !== null,
    notificationsSeen: f.lastNotificationAt !== null && (f.rcImportAt === null || f.lastNotificationAt >= f.rcImportAt),
  };
  // The cutover compares a whole month at this month's pace; the upgrade emails quote the revenue so far.
  // The cutover prices a month at the last 7 days' pace (always at least 7 days live by then); the upgrade emails price the
  // month that passed $10,000, which may be last month.
  // Read only for the steps that show them: a big import's customers or a week of revenue are not counted every pass.
  if (step === "cutover") {
    const [w] = rowsOf<{ s: number | string | null }>(await db.execute(sql`SELECT coalesce(sum(t.revenue_usd), 0) AS s FROM transactions t JOIN projects p ON p.id = t.project_id
      WHERE p.owner_user_id = ${f.userId} AND NOT t.is_sandbox AND t.revenue_usd > 0 AND t.kind IN ('purchase','renewal','one_time')
        AND t.purchased_at >= ${new Date(now.getTime() - 7 * D).toISOString()}::timestamptz`));
    c.last7 = Number(w?.s ?? 0);
  }
  if (step === "side_by_side") {
    const [n] = rowsOf<{ n: number | string }>(await db.execute(sql`SELECT count(*) AS n FROM (SELECT 1 FROM customers c JOIN projects p ON p.id = c.project_id
      WHERE p.owner_user_id = ${f.userId} AND p.rc_import_at IS NOT NULL LIMIT 10000000) x`));
    c.importedCustomers = Number(n?.n ?? 0);
  }
  c.projected = Math.round(((c.last7 ?? 0) * 30) / 7);
  c.overTracked = f.overTracked || f.tracked;
  c.overMonth = f.free100At ? new Date(f.free100At).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) : c.month;
  const basis = step === "cutover" ? c.projected : step.startsWith("upgrade") ? c.overTracked : f.tracked;
  c.bills = { revenuedot: rd(basis), revenuecat: rc(basis) };
  c.importedOn = f.rcImportAt ? new Date(f.rcImportAt).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : undefined;
  // The send's token (the unsubscribe link's) also identifies the reader for the welcome's path links and one-click answers.
  if (token && step === "welcome") c.pathUrl = (p) => `${base}/auth/journeys/path/${token}?path=${p}`;
  if (token) c.feedbackUrl = (kind, value) => `${base}/auth/journeys/feedback/${token}?kind=${kind}&value=${encodeURIComponent(value)}`;
  c.progress = { testPurchase: f.testPurchaseAt !== null, app: f.sdkFirstAt !== null, store: f.storeConnected, live: f.liveAt !== null };
  if (step === "verify_reminder") {
    await retireTokens(db, "email_verify", f.userId, now);
    const token = await issueToken(db, "email_verify", { id: f.userId, email: f.email }, now);
    c.verifyUrl = `${base}/verify-email?token=${encodeURIComponent(token)}`;
  }
  return c;
}

/** Whether an address is internal (never emailed): a listed domain or address. */
export function excluded(email: string, list: string[]) {
  const e = email.toLowerCase();
  return list.some((x) => { const v = x.trim().toLowerCase(); return !!v && (v.includes("@") ? e === v : e.endsWith(`@${v}`)); });
}

/** One pass. Returns how many emails went out. */
export async function runJourneys(deps: JourneyDeps, now: Date, limits = JOURNEY_LIMITS): Promise<{ sent: number; checked: number }> {
  const { db, config } = deps;
  const t0 = Date.now();
  const base = linkBase(deps);
  const out = { sent: 0, checked: 0 };
  // Candidates: anyone who may get product email and was not emailed in the last 44 hours, plus brand-new accounts
  // (the welcome and the verification reminder ignore the cap). Rotated by the clock so a large list is covered in turn.
  const recent = new Date(now.getTime() - 3 * D);
  const gap = new Date(now.getTime() - MIN_GAP_MS);
  const candidates = rowsOf<{ id: string; email: string; created_at: string | Date }>(await db.execute(sql`
    SELECT u.id, u.email, u.created_at FROM users u
    WHERE (u.product_emails OR (u.email_verified_at IS NULL AND u.created_at >= ${recent.toISOString()}::timestamptz)) AND (u.created_at >= ${recent.toISOString()}::timestamptz
      OR NOT EXISTS (SELECT 1 FROM journey_sends js WHERE js.user_id = u.id AND js.sent_at >= ${gap.toISOString()}::timestamptz))
    ORDER BY u.created_at DESC`)).filter((u) => !excluded(u.email, config.exclude));
  if (!candidates.length) return out;
  // Every pass looks at the last 3 days' sign-ups (the welcome is due 5 minutes in) and one rotating slice of everyone else,
  // so the work per pass stays bounded however many accounts there are; each older account is looked at in turn.
  const fresh = candidates.filter((u) => new Date(u.created_at).getTime() >= recent.getTime());
  const older = candidates.filter((u) => new Date(u.created_at).getTime() < recent.getTime());
  const slices = Math.max(1, Math.ceil(older.length / limits.chunk));
  const slice = Math.floor(now.getTime() / 300_000) % slices;
  const order = [...fresh, ...older.slice(slice * limits.chunk, (slice + 1) * limits.chunk)];
  for (let i = 0; i < order.length && out.sent < limits.emails && Date.now() - t0 < limits.budgetMs; i += limits.chunk) {
    const facts = await loadFacts(db, order.slice(i, i + limits.chunk).map((u) => u.id), now, config.since);
    for (const f of facts) {
      if (out.sent >= limits.emails || Date.now() - t0 >= limits.budgetMs) break;
      out.checked++;
      // The verification reminder is account mail, not product mail: it goes even to people who turned tips off.
      const step = pickStep(f, now.getTime(), config, f.productEmails ? undefined : ["verify_reminder"]);
      if (!step) continue;
      try { if (await sendStep(deps, f, step, now, base)) out.sent++; }
      catch (e) { console.error(`journeys: ${step} to ${f.userId} failed`, e); }
    }
  }
  return out;
}

/** Claims the step in journey_sends, then sends it. A claim that loses (another tick sent it) sends nothing. */
export async function sendStep(deps: JourneyDeps, f: Facts, step: StepId, now: Date, base = linkBase(deps)): Promise<boolean> {
  const { db } = deps;
  const token = randomToken();
  const won = await db.insert(schema.journeySends).values({ userId: f.userId, step, tokenHash: await sha256Hex(token), sentAt: now }).onConflictDoNothing().returning({ s: schema.journeySends.step });
  if (!won.length) return false;
  const unsubscribe = `${base}/auth/journeys/unsubscribe/${token}`;
  // The welcome's two path links reuse the unsubscribe token's row to know whose path to record (routes/account.ts).
  // A send that fails (or throws) gives the claim back, so a later pass tries again and the caps are not used up.
  const release = () => db.delete(schema.journeySends).where(and(eq(schema.journeySends.userId, f.userId), eq(schema.journeySends.step, step), eq(schema.journeySends.sentAt, now)));
  try {
    const ctx = await contextFor(db, f, step, base, unsubscribe, token, now, deps.config.plansJson);
    const mail = journeyEmail(ctx);
    const ok = await trySend(deps.mailer, {
      to: f.email, ...mail, from: JOURNEY_FROM, replyTo: JOURNEY_REPLY_TO,
      headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    if (!ok) await release();
    return ok;
  } catch (e) {
    await release();
    throw e;
  }
}

/** Reads the journey settings from the environment (Cloud only; `REVENUEDOT_JOURNEYS=on` turns the emails on). */
export function journeyConfig(env: Record<string, string | undefined>): JourneyConfig | null {
  if ((env.REVENUEDOT_JOURNEYS ?? "").toLowerCase() !== "on") return null;
  const since = new Date(env.REVENUEDOT_JOURNEYS_SINCE ?? "2026-10-04T00:00:00Z");
  return {
    since: Number.isNaN(since.getTime()) ? new Date("2026-10-04T00:00:00Z") : since,
    exclude: (env.REVENUEDOT_JOURNEYS_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    plansJson: env.REVENUEDOT_BILLING_PLANS ?? null,
  };
}

/** Looks up the user of a journey email's token (unsubscribe and path links), or null. */
export async function journeyTokenUser(db: DB, token: string) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  const S = schema.journeySends;
  const [row] = await db.select({ userId: S.userId, email: schema.users.email }).from(S).innerJoin(schema.users, eq(schema.users.id, S.userId)).where(eq(S.tokenHash, await sha256Hex(token))).limit(1);
  return row ?? null;
}
