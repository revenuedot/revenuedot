import { and, eq, inArray, sql } from "drizzle-orm";
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
  firstSale: { product: string; amount: number | null; currency: string | null; country: string | null } | null;
  rcImportAt: number | null; importedCustomers: number;
  paywallPublishedAt: number | null; experimentStartedAt: number | null;
  teammates: number; recoveryOn: boolean; assistantConnected: boolean;
  plan: string; planSince: number | null; canceledAt: number | null; tracked: number; free100At: number | null;
  alertAt: number | null; lastNotificationAt: number | null; referralJoinedAt: number | null;
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
/** Live and past the switch: everyone live, except migrators until their cutover email has gone out. */
const adopting = (f: Facts) => f.liveAt !== null && (!migrating(f) || f.sent.has("cutover"));

/** The plan, in priority order: when two steps are due, the first one wins and the other waits. */
export const STEPS: Step[] = [
  { id: "welcome", onboarding: true, anyHour: true, uncapped: true, freshFor: 2 * D, due: (f) => (f.ownsProjects ? f.createdAt + 5 * 60_000 : null) },
  { id: "teammate_welcome", anyDay: true, freshFor: 3 * D, due: (f) => (!f.ownsProjects && f.memberOf ? f.createdAt + 10 * 60_000 : null) },
  { id: "verify_reminder", onboarding: true, anyDay: true, uncapped: true, freshFor: 3 * D, due: (f) => (f.ownsProjects && !f.verified ? f.createdAt + D : null) },
  // Celebrations and replies to what just happened.
  { id: "first_sale", anyDay: true, freshFor: 3 * D, due: (f) => f.liveAt },
  { id: "standard_welcome", anyDay: true, freshFor: 3 * D, due: (f) => (f.plan === "standard" ? f.planSince : null) },
  { id: "standard_canceled", freshFor: 7 * D, due: (f) => (f.plan === "free" ? f.canceledAt : null) },
  { id: "referral_joined", anyDay: true, freshFor: 7 * D, due: (f) => f.referralJoinedAt },
  // Switching from RevenueCat: the cutover is the most valuable email of all, so it outranks the rest.
  { id: "cutover", freshFor: 14 * D, due: (f, now) => (migrating(f) && f.liveAt && f.lastSaleAt && now - f.lastSaleAt < 3 * D ? f.liveAt + 7 * D : null) },
  // Revenue.
  { id: "enterprise", freshFor: 20 * D, due: (f, now) => (f.plan !== "enterprise" && f.tracked >= 500_000 ? now : null) },
  { id: "upgrade_personal", freshFor: 10 * D, due: (f) => (f.plan === "free" && f.free100At !== null && f.sent.has("upgrade_nudge") ? f.free100At + 10 * D : null) },
  { id: "upgrade_nudge", freshFor: 10 * D, due: (f) => (f.plan === "free" && f.free100At !== null ? f.free100At + 3 * D : null) },
  { id: "pricing_explainer", freshFor: 20 * D, due: (f, now) => (f.plan === "free" && f.tracked >= 5_000 && f.free100At === null ? now : null) },
  // Switching from RevenueCat, before it is live.
  { id: "forwarding_check", onboarding: true, freshFor: 7 * D,
    due: (f) => (f.rcImportAt && !f.liveAt && (f.lastNotificationAt === null || f.lastNotificationAt < f.rcImportAt) ? f.rcImportAt + 5 * D : null) },
  { id: "side_by_side", onboarding: true, freshFor: 7 * D, due: (f) => (f.rcImportAt && !f.liveAt ? f.rcImportAt + D : null) },
  { id: "switch_plan", onboarding: true, freshFor: 7 * D, due: (f) => (migrating(f) && !f.liveAt && !f.rcImportAt ? f.createdAt + D : null) },
  { id: "import_help", onboarding: true, freshFor: 6 * D, due: (f) => (migrating(f) && !f.liveAt && !f.rcImportAt ? f.createdAt + 4 * D : null) },
  // Onboarding, by the next missing step.
  { id: "go_live", onboarding: true, freshFor: 10 * D,
    due: (f) => (f.storeConnected && !f.liveAt && f.sdkFirstAt ? Math.max(f.sdkFirstAt + 2 * D, f.createdAt + 4 * D, (f.sent.get("store_keys") ?? 0) + 2 * D) : null) },
  { id: "store_keys", onboarding: true, freshFor: 10 * D, due: (f) => (f.sdkFirstAt && !f.storeConnected && !f.liveAt ? f.sdkFirstAt + D : null) },
  { id: "connect_app", onboarding: true, freshFor: 10 * D,
    due: (f) => (!migrating(f) && !f.sdkFirstAt && !f.liveAt && (f.testPurchaseAt || f.firstAppAt) ? (f.testPurchaseAt ? f.testPurchaseAt + 20 * H : f.createdAt + 3 * D) : null) },
  { id: "first_purchase", onboarding: true, freshFor: 4 * D, due: (f) => (!migrating(f) && !f.testPurchaseAt && !f.sdkFirstAt && !f.liveAt ? f.createdAt + D : null) },
  { id: "checkin", onboarding: true, freshFor: 4 * D, due: (f) => (!f.firstAppAt && !f.liveAt ? f.createdAt + 3 * D : null) },
  { id: "ai_setup", onboarding: true, freshFor: 5 * D, due: (f) => (!migrating(f) && !f.sdkFirstAt && !f.liveAt ? f.createdAt + 6 * D : null) },
  { id: "need_hand", onboarding: true, freshFor: 6 * D, due: (f) => (!f.sdkFirstAt && !f.liveAt ? f.createdAt + 10 * D : null) },
  { id: "last_call", onboarding: true, freshFor: 9 * D, due: (f) => (!f.sdkFirstAt && !f.liveAt ? f.createdAt + 21 * D : null) },
  // Adoption, once live. Migrators start once the cutover email has gone out.
  { id: "paywalls", freshFor: 14 * D, due: (f) => (adopting(f) && !f.paywallPublishedAt ? f.liveAt! + 3 * D : null) },
  { id: "experiments", freshFor: 14 * D, due: (f) => (adopting(f) && f.paywallPublishedAt && !f.experimentStartedAt ? Math.max(f.paywallPublishedAt + 5 * D, f.liveAt! + 5 * D) : null) },
  { id: "recovery", freshFor: 14 * D, due: (f) => (adopting(f) && !f.recoveryOn ? f.liveAt! + 10 * D : null) },
  { id: "team", freshFor: 14 * D, due: (f) => (adopting(f) && f.verified && f.teammates === 0 ? f.liveAt! + 12 * D : null) },
  { id: "how_going", freshFor: 14 * D, due: (f, now) => (adopting(f) && f.lastSaleAt && now - f.lastSaleAt < 7 * D ? f.liveAt! + 14 * D : null) },
  { id: "assistant", freshFor: 14 * D, due: (f) => (adopting(f) && !f.assistantConnected && notYet(f, "ai_setup") ? f.liveAt! + 16 * D : null) },
  // Referral (after the "how is it going" note) and win-back.
  { id: "referral", freshFor: 30 * D,
    due: (f, now) => (adopting(f) && f.lastSaleAt && now - f.lastSaleAt < 7 * D && (!migrating(f) || (f.sent.get("cutover") ?? Infinity) + 14 * D <= now) ? f.liveAt! + 28 * D : null) },
  { id: "went_quiet", freshFor: 14 * D, due: (f, now) => (f.liveAt && f.sdkLastAt && now - f.sdkLastAt >= 7 * D && (!f.lastSaleAt || now - f.lastSaleAt >= 7 * D) ? f.sdkLastAt + 7 * D : null) },
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
export function pickStep(f: Facts, now: number, cfg: Pick<JourneyConfig, "since">): StepId | null {
  if (f.sent.has("last_call") && !f.sdkFirstAt && !f.liveAt) return null;
  // The welcome is sign-up mail: it neither waits for the caps nor counts towards them. The verification reminder skips the
  // caps but counts, so the day-1 nudge does not follow it minutes later.
  const times = [...f.sent.entries()].filter(([k]) => k !== "welcome").map(([, t]) => t);
  const last = times.length ? Math.max(...times) : 0;
  const capped = now - last < MIN_GAP_MS || times.filter((t) => now - t < 7 * D).length >= WEEK_MAX;
  const nearAlert = f.alertAt !== null && now - f.alertAt < D;
  for (const s of STEPS) {
    if (f.sent.has(s.id)) continue;
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
    WITH owned AS (SELECT p.id, p.name, p.owner_user_id AS uid, p.rc_import_at, p.recovery_settings, p.created_at FROM projects p WHERE p.owner_user_id IN (${ids}))
    SELECT u.id, u.email, u.name, u.created_at, u.email_verified_at, u.time_zone, u.journey_path, u.referral_code, u.product_emails,
      (SELECT count(*) FROM owned o WHERE o.uid = u.id) AS owned,
      -- The project to link to: the oldest one whose app has talked to RevenueDot, else the oldest.
      (SELECT o.id FROM owned o WHERE o.uid = u.id ORDER BY EXISTS (SELECT 1 FROM sdk_versions s WHERE s.project_id = o.id) DESC, o.created_at ASC LIMIT 1) AS project_id,
      (SELECT min(a.created_at) FROM apps a JOIN owned o ON o.id = a.project_id WHERE o.uid = u.id) AS first_app_at,
      (SELECT min(l.at) FROM owned o, LATERAL (SELECT t.created_at AS at FROM transactions t WHERE t.project_id = o.id AND t.is_sandbox ORDER BY t.created_at ASC LIMIT 1) l WHERE o.uid = u.id) AS test_purchase_at,
      (SELECT min(s.first_seen_at) FROM sdk_versions s JOIN owned o ON o.id = s.project_id WHERE o.uid = u.id) AS sdk_first_at,
      (SELECT max(s.last_seen_at) FROM sdk_versions s JOIN owned o ON o.id = s.project_id WHERE o.uid = u.id) AS sdk_last_at,
      (SELECT json_build_object('platform', s.platform_flavor, 'os', s.platform, 'version', s.sdk_version) FROM sdk_versions s JOIN owned o ON o.id = s.project_id WHERE o.uid = u.id ORDER BY s.first_seen_at ASC LIMIT 1) AS sdk,
      (SELECT EXISTS (SELECT 1 FROM apps a JOIN owned o ON o.id = a.project_id WHERE o.uid = u.id AND (
          (a.type IN ('app_store','mac_app_store','play_store','amazon') AND a.credentials IS NOT NULL AND a.credentials::text NOT IN ('{}','null'))
          OR a.last_notification_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM stripe_connections sc WHERE sc.app_id = a.id AND sc.status = 'connected')))) AS store_connected,
      -- Live: a paid production sale recorded within 2 days of the purchase (imported history is recorded much later).
      -- Each reads the (project_id, created_at) index in order and stops at the first match.
      (SELECT min(l.at) FROM owned o, LATERAL (SELECT t.created_at AS at FROM transactions t WHERE t.project_id = o.id AND NOT t.is_sandbox AND t.revenue_usd > 0
          AND t.kind IN ('purchase','renewal','one_time') AND t.created_at - t.purchased_at < interval '2 days' ORDER BY t.created_at ASC LIMIT 1) l WHERE o.uid = u.id) AS live_at,
      (SELECT max(l.at) FROM owned o, LATERAL (SELECT t.created_at AS at FROM transactions t WHERE t.project_id = o.id AND NOT t.is_sandbox AND t.revenue_usd > 0
          AND t.kind IN ('purchase','renewal','one_time') AND t.created_at - t.purchased_at < interval '2 days' ORDER BY t.created_at DESC LIMIT 1) l WHERE o.uid = u.id) AS last_sale_at,
      (SELECT json_build_object('product', t.product_identifier, 'amount', t.price_amount, 'currency', t.price_currency, 'country', t.country_code)
          FROM transactions t JOIN owned o ON o.id = t.project_id WHERE o.uid = u.id AND NOT t.is_sandbox AND t.revenue_usd > 0
          AND t.kind IN ('purchase','renewal','one_time') AND t.created_at - t.purchased_at < interval '2 days' ORDER BY t.created_at ASC LIMIT 1) AS first_sale,
      (SELECT min(o.rc_import_at) FROM owned o WHERE o.uid = u.id) AS rc_import_at,
      (SELECT count(*) FROM customers c JOIN owned o ON o.id = c.project_id WHERE o.uid = u.id AND o.rc_import_at IS NOT NULL) AS imported_customers,
      (SELECT min(pw.published_at) FROM paywalls pw JOIN owned o ON o.id = pw.project_id WHERE o.uid = u.id) AS paywall_published_at,
      (SELECT min(e.started_at) FROM experiments e JOIN owned o ON o.id = e.project_id WHERE o.uid = u.id) AS experiment_started_at,
      (SELECT count(*) FROM memberships m JOIN owned o ON o.id = m.project_id WHERE o.uid = u.id AND m.user_id <> u.id)
        + (SELECT count(*) FROM invites i JOIN owned o ON o.id = i.project_id WHERE o.uid = u.id AND i.revoked_at IS NULL) AS teammates,
      (SELECT EXISTS (SELECT 1 FROM owned o WHERE o.uid = u.id AND o.recovery_settings->>'enabled' = 'true')) AS recovery_on,
      (SELECT EXISTS (SELECT 1 FROM api_keys k WHERE k.created_by_user_id = u.id AND k.oauth_client_id IS NOT NULL)) AS assistant_connected,
      ba.plan AS ba_plan, ba.status AS ba_status, ba.updated_at AS ba_updated_at, ba.created_at AS ba_created_at, ba.stripe_subscription_id AS ba_sub,
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
  const projectNames = new Map<string, string>();
  const pids = rows.map((r) => r.project_id as string | null).filter((x): x is string => !!x);
  if (pids.length) for (const p of await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, pids))) projectNames.set(p.id, p.name);
  return rows.map((r): Facts => {
    const json = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (typeof v === "string" ? JSON.parse(v) : v) as T);
    const sdk = json<{ platform: string; os: string; version: string }>(r.sdk);
    const sale = json<{ product: string; amount: number | null; currency: string | null; country: string | null }>(r.first_sale);
    const member = json<{ project_id: string; project_name: string; inviter: string | null }>(r.member_of);
    const sent = new Map<StepId, number>(Object.entries(json<Record<string, string>>(r.sent) ?? {}).map(([k, v]) => [k as StepId, new Date(v).getTime()]));
    const paying = r.ba_plan === "standard" && ["active", "past_due"].includes(String(r.ba_status));
    const plan = r.ba_plan === "enterprise" ? "enterprise" : paying ? "standard" : "free";
    return {
      userId: String(r.id), email: String(r.email), name: (r.name as string | null) ?? null, createdAt: ts(r.created_at)!, verified: r.email_verified_at !== null,
      timeZone: (r.time_zone as string | null) ?? null, path: r.journey_path === "revenuecat" || r.journey_path === "new" ? r.journey_path : null,
      referralCode: (r.referral_code as string | null) ?? null, productEmails: r.product_emails !== false,
      projectId: (r.project_id as string | null) ?? null, projectName: r.project_id ? projectNames.get(String(r.project_id)) ?? null : null, ownsProjects: Number(r.owned) > 0,
      memberOf: member ? { projectId: member.project_id, projectName: member.project_name, inviter: member.inviter } : null,
      firstAppAt: ts(r.first_app_at), testPurchaseAt: ts(r.test_purchase_at), sdkFirstAt: ts(r.sdk_first_at), sdkLastAt: ts(r.sdk_last_at),
      sdk: sdk ? { platform: sdkLabel(sdk.platform, sdk.os), version: sdk.version } : null,
      storeConnected: r.store_connected === true, liveAt: ts(r.live_at), lastSaleAt: ts(r.last_sale_at), firstSale: sale,
      rcImportAt: ts(r.rc_import_at), importedCustomers: Number(r.imported_customers ?? 0),
      paywallPublishedAt: ts(r.paywall_published_at), experimentStartedAt: ts(r.experiment_started_at),
      teammates: Number(r.teammates ?? 0), recoveryOn: r.recovery_on === true, assistantConnected: r.assistant_connected === true,
      // Standard: the billing row's last change is when the subscription became active. Only accounts whose billing began
      // after the launch get the welcome, so long-time payers never get it on some later billing update.
      plan, planSince: plan === "standard" && (ts(r.ba_created_at) ?? 0) >= sinceMs ? ts(r.ba_updated_at) : null,
      canceledAt: plan === "free" && r.ba_sub && ["canceled", "unpaid", "incomplete_expired", "paused"].includes(String(r.ba_status)) ? ts(r.ba_updated_at) : null,
      tracked: Number(r.tracked ?? 0), free100At: ts(r.free100_at), alertAt: ts(r.alert_at),
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
export async function contextFor(db: DB, f: Facts, step: StepId, base: string, unsubscribeUrl: string, pathToken: string | null, now: Date, plansJson?: string | null): Promise<JourneyCtx> {
  const plans = plansFrom(plansJson);
  const std = planOf(plans, "standard");
  const rd = (r: number) => billCents(std, r) / 100;
  const rc = (r: number) => (r >= 2_500 ? Math.round(r) / 100 : 0);
  const member = !f.ownsProjects && f.memberOf;
  const c: JourneyCtx = {
    step, app: base, first: firstName(f.name), unsubscribeUrl,
    projectId: member ? f.memberOf!.projectId : f.projectId, projectName: member ? f.memberOf!.projectName : f.projectName,
    testPurchase: f.testPurchaseAt !== null, sdk: f.sdk, importedCustomers: f.importedCustomers, lastSaleAt: f.lastSaleAt ? new Date(f.lastSaleAt) : null,
    tracked: f.tracked, month: now.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }),
    priceRows: [10_000, 20_000, 50_000, 100_000, 250_000, 500_000].map((r) => [r, rd(r), rc(r)]),
    migrating: migrating(f),
    liveSince: f.liveAt ? new Date(f.liveAt).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : undefined,
    inviter: member ? f.memberOf!.inviter : null,
    sale: f.firstSale ? { product: f.firstSale.product, amount: money(f.firstSale.amount, f.firstSale.currency), country: COUNTRY(f.firstSale.country) } : null,
  };
  // The cutover compares a whole month at this month's pace; the upgrade emails quote the revenue so far.
  const day = now.getUTCDate(), days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  c.projected = Math.round((f.tracked / day) * days);
  const basis = step === "cutover" ? c.projected : f.tracked;
  c.bills = { revenuedot: rd(basis), revenuecat: rc(basis) };
  if (pathToken) c.pathUrl = (p) => `${base}/auth/journeys/path/${pathToken}?path=${p}`;
  if (step === "verify_reminder") {
    await retireTokens(db, "email_verify", f.userId, now);
    const token = await issueToken(db, "email_verify", { id: f.userId, email: f.email }, now);
    c.verifyUrl = `${base}/verify-email?token=${encodeURIComponent(token)}`;
  }
  if (step === "referral") {
    let code = f.referralCode;
    for (let i = 0; !code && i < 3; i++) {
      const candidate = randomToken().replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase();
      const [row] = await db.update(schema.users).set({ referralCode: candidate }).where(and(eq(schema.users.id, f.userId), sql`${schema.users.referralCode} IS NULL`)).returning({ c: schema.users.referralCode })
        .catch(() => [] as { c: string | null }[]);
      code = row?.c ?? (await db.select({ c: schema.users.referralCode }).from(schema.users).where(eq(schema.users.id, f.userId)))[0]?.c ?? null;
    }
    if (code) c.referralUrl = `${base}/signup?ref=${code}`;
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
  const candidates = rowsOf<{ id: string; email: string }>(await db.execute(sql`
    SELECT u.id, u.email FROM users u
    WHERE u.product_emails AND (u.created_at >= ${recent.toISOString()}::timestamptz
      OR NOT EXISTS (SELECT 1 FROM journey_sends js WHERE js.user_id = u.id AND js.sent_at >= ${gap.toISOString()}::timestamptz))
    ORDER BY u.created_at DESC`)).filter((u) => !excluded(u.email, config.exclude));
  if (!candidates.length) return out;
  const start = Math.floor(now.getTime() / 300_000) * limits.chunk % candidates.length;
  const order = [...candidates.slice(start), ...candidates.slice(0, start)];
  for (let i = 0; i < order.length && out.sent < limits.emails && Date.now() - t0 < limits.budgetMs; i += limits.chunk) {
    const facts = await loadFacts(db, order.slice(i, i + limits.chunk).map((u) => u.id), now, config.since);
    for (const f of facts) {
      if (out.sent >= limits.emails || Date.now() - t0 >= limits.budgetMs) break;
      out.checked++;
      if (!f.productEmails) continue;
      const step = pickStep(f, now.getTime(), config);
      if (!step) continue;
      if (await sendStep(deps, f, step, now, base)) out.sent++;
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
  const ctx = await contextFor(db, f, step, base, unsubscribe, step === "welcome" ? token : null, now, deps.config.plansJson);
  const mail = journeyEmail(ctx);
  return trySend(deps.mailer, {
    to: f.email, ...mail, from: JOURNEY_FROM, replyTo: JOURNEY_REPLY_TO,
    headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  });
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
