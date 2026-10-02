import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { assignVariant, computeEntitlements, enrollBucket, isActive, variantDefaultName } from "@revenuedot/core";
import type { ExperimentVariant } from "@revenuedot/db";
import { entitlementMap } from "../repo/catalog.js";
import { loadState, type CustomerRow } from "../repo/customers.js";
import { buildContext, loadCustomerData } from "./customer-context.js";
import { recordRawEvent } from "./events.js";
import { alpha2 } from "../stores/apple/map.js";

/**
 * Targeting and experiments: which offering a customer gets. Audience rules follow RevenueCat's shape: condition groups
 * are OR-ed, conditions inside a group are AND-ed. Each condition compares one customer field with an operator and a
 * string value (multi-value operators take comma-separated values).
 */

export type Rules = { groups: { conditions: Condition[] }[] };
export type Condition = { field: string; operator: string; value?: string; currency?: string };

/** What a condition can look at. Dates are epoch ms; missing values are null. */
export interface CustomerContext {
  customerId: string | null; appUserIds: string[]; originalAppUserId: string | null;
  country: string | null; platform: string | null; appVersion: string | null; sdkVersion: string | null; sdkFlavor: string | null; platformVersion: string | null;
  storefront: string | null; locale: string | null; firstSeenAt: number | null; lastSeenAt: number | null;
  attributes: Record<string, string | null>; activeEntitlements: string[]; status: "active" | "trialing" | "expired" | "never";
  totalSpent: number; totalRenewals: number; latestProduct: string | null; latestStore: string | null; anyActiveStore: string[];
  isCurrentlyTrialing: boolean; hasMadeSandboxPurchase: boolean; hasMadeNonSubscriptionPurchase: boolean;
  firstPurchaseAt: number | null; mostRecentPurchaseAt: number | null; latestExpirationAt: number | null; allPurchasedProductIds: string[];
  /** Latest renewal, trial conversion included (Refund Control's "recent renewal" template). */
  lastRenewalAt: number | null;
  /** First-class attribution (customer_attribution): Apple Search Ads campaigns and ad groups by name when loaded. */
  attribution: Partial<Record<AttributionField, string | null>>;
}

/** Condition fields that read the customer's attribution row. */
export const ATTRIBUTION_FIELDS = ["mediaSource", "campaign", "adGroup", "ad", "keyword", "creative"] as const;
export type AttributionField = (typeof ATTRIBUTION_FIELDS)[number];

export const emptyContext = (): CustomerContext => ({
  customerId: null, appUserIds: [], originalAppUserId: null, country: null, platform: null, appVersion: null, sdkVersion: null, sdkFlavor: null, platformVersion: null,
  storefront: null, locale: null, firstSeenAt: null, lastSeenAt: null, attributes: {}, activeEntitlements: [], status: "never", totalSpent: 0, totalRenewals: 0,
  latestProduct: null, latestStore: null, anyActiveStore: [], isCurrentlyTrialing: false, hasMadeSandboxPurchase: false, hasMadeNonSubscriptionPurchase: false,
  firstPurchaseAt: null, mostRecentPurchaseAt: null, latestExpirationAt: null, allPurchasedProductIds: [], lastRenewalAt: null, attribution: {},
});

const ATTRIBUTE_FIELDS: Record<string, string> = {
  email: "$email", phoneNumber: "$phoneNumber", mediaSource: "$mediaSource", campaign: "$campaign", adGroup: "$adGroup", ad: "$ad", keyword: "$keyword", creative: "$creative",
  idfa: "$idfa", idfv: "$idfv", gpsAdId: "$gpsAdId",
};

/** The fields this server evaluates. Others are refused when an audience is saved, so a rule never silently matches nothing. */
export const SUPPORTED_FIELDS = new Set([
  "country", "customerId", "originalAppUserId", "status", "platform", "storefront", "locale", "appVersion", "sdkVersion", "sdkFlavor", "platformVersion",
  "lastSeenAt", "firstSeenAt", "firstPurchaseAt", "mostRecentPurchaseAt", "latestExpirationAt", "totalRenewals", "totalSpent", "latestProduct", "latestStore",
  "anyActiveStore", "hasActiveEntitlement", "activeEntitlements", "isCurrentlyTrialing", "hasMadeSandboxPurchase", "hasMadeNonSubscriptionPurchase",
  "allPurchasedProductIds", "lastRenewalAt", ...Object.keys(ATTRIBUTE_FIELDS),
]);
export const OPERATORS = new Set(["is", "isNot", "isAnyOf", "isNotAnyOf", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "equal", "notEqual",
  "contains", "doesNotContain", "containsAnyOf", "before", "beforeOrOn", "on", "after", "afterOrOn", "within", "between", "notBetween", "isEmpty", "isNotEmpty"]);
export const fieldSupported = (f: string) => SUPPORTED_FIELDS.has(f) || /^customAttribute:[a-zA-Z][a-zA-Z0-9_-]*$/.test(f);

type Value = string | number | boolean | string[] | null;
function fieldValue(ctx: CustomerContext, field: string): Value {
  if (field.startsWith("customAttribute:")) return ctx.attributes[field.slice(16)] ?? null;
  if ((ATTRIBUTION_FIELDS as readonly string[]).includes(field) && ctx.attribution[field as AttributionField] !== undefined) return ctx.attribution[field as AttributionField] ?? null;
  if (ATTRIBUTE_FIELDS[field]) return ctx.attributes[ATTRIBUTE_FIELDS[field]!] ?? null;
  switch (field) {
    case "customerId": return ctx.appUserIds.length ? ctx.appUserIds : null;
    case "hasActiveEntitlement": return ctx.activeEntitlements.length > 0;
    case "activeEntitlements": return ctx.activeEntitlements;
    default: return (ctx as unknown as Record<string, Value>)[field] ?? null;
  }
}

/** Dotted versions compare part by part ("1.10.0" > "1.9.2"); other text compares as text. */
function compareVersions(a: string, b: string) {
  const pa = a.split(/[.-]/).map((x) => Number(x)), pb = b.split(/[.-]/).map((x) => Number(x));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}
const DATE_FIELDS = new Set(["lastSeenAt", "firstSeenAt", "firstPurchaseAt", "mostRecentPurchaseAt", "latestExpirationAt", "lastRenewalAt"]);
const VERSION_FIELDS = new Set(["appVersion", "sdkVersion", "platformVersion"]);
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const lc = (x: unknown) => String(x).toLowerCase();

/** `within` takes a duration such as "7d", "12h", "2w", "3m"; dates take epoch ms or ISO text. */
function toMs(v: string): number | null {
  if (/^\d{11,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
function durationMs(v: string): number | null {
  const m = /^(\d+)\s*([hdwmy])$/i.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * { h: 3600_000, d: 86400_000, w: 604800_000, m: 2592000_000, y: 31536000_000 }[m[2]!.toLowerCase() as "h"]!;
}

export function conditionMatches(ctx: CustomerContext, c: Condition, now: number): boolean {
  const v = fieldValue(ctx, c.field);
  const empty = v === null || v === "" || (Array.isArray(v) && !v.length);
  if (c.operator === "isEmpty") return empty;
  if (c.operator === "isNotEmpty") return !empty;
  const want = c.value ?? "";
  const values = list(want);
  if (Array.isArray(v)) {
    const have = v.map(lc);
    switch (c.operator) {
      case "is": case "equal": case "contains": return have.includes(lc(want));
      case "isNot": case "notEqual": case "doesNotContain": return !have.includes(lc(want));
      case "isAnyOf": case "containsAnyOf": return values.some((x) => have.includes(lc(x)));
      case "isNotAnyOf": return !values.some((x) => have.includes(lc(x)));
      default: return false;
    }
  }
  if (typeof v === "boolean") {
    const b = lc(want) === "true";
    return c.operator === "is" || c.operator === "equal" ? v === b : c.operator === "isNot" || c.operator === "notEqual" ? v !== b : false;
  }
  if (DATE_FIELDS.has(c.field)) {
    if (v === null) return false;
    const t = Number(v);
    if (c.operator === "within") { const d = durationMs(want); return d !== null && t >= now - d && t <= now; }
    if (c.operator === "between" || c.operator === "notBetween") {
      const [a, b] = values.map(toMs);
      if (a == null || b == null) return false;
      const inside = t >= a && t <= b;
      return c.operator === "between" ? inside : !inside;
    }
    const w = toMs(want);
    if (w === null) return false;
    const day = (x: number) => Math.floor(x / 86400_000);
    switch (c.operator) {
      case "before": return t < w; case "beforeOrOn": return day(t) <= day(w); case "after": return t > w; case "afterOrOn": return day(t) >= day(w); case "on": return day(t) === day(w);
      default: return false;
    }
  }
  if (typeof v === "number") {
    const n = Number(want);
    switch (c.operator) {
      case "greaterThan": return v > n; case "greaterThanOrEqual": return v >= n; case "lessThan": return v < n; case "lessThanOrEqual": return v <= n;
      case "is": case "equal": return v === n; case "isNot": case "notEqual": return v !== n;
      case "between": case "notBetween": { const [a, b] = values.map(Number); const inside = v >= a! && v <= b!; return c.operator === "between" ? inside : !inside; }
      default: return false;
    }
  }
  if (v === null) return c.operator === "isNot" || c.operator === "notEqual" || c.operator === "isNotAnyOf" || c.operator === "doesNotContain";
  const s = String(v);
  if (VERSION_FIELDS.has(c.field) && ["greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"].includes(c.operator)) {
    const d = compareVersions(s, want);
    return c.operator === "greaterThan" ? d > 0 : c.operator === "greaterThanOrEqual" ? d >= 0 : c.operator === "lessThan" ? d < 0 : d <= 0;
  }
  // A storefront is a country: "DEU" (the iOS SDK's storefront) and "DE" (what is stored as the customer's last country,
  // and what Android reports) are the same, so the customer page and the SDK agree on a storefront rule.
  const n = c.field === "storefront" ? (x: string) => lc(alpha2(x) ?? x) : lc;
  switch (c.operator) {
    case "is": case "equal": return n(s) === n(want);
    case "isNot": case "notEqual": return n(s) !== n(want);
    case "isAnyOf": return values.some((x) => n(x) === n(s));
    case "isNotAnyOf": return !values.some((x) => n(x) === n(s));
    case "contains": return lc(s).includes(lc(want));
    case "doesNotContain": return !lc(s).includes(lc(want));
    case "containsAnyOf": return values.some((x) => lc(s).includes(lc(x)));
    default: return false;
  }
}

export function rulesMatch(ctx: CustomerContext, rules: Rules, now: number): boolean {
  if (!rules.groups.length) return true;
  return rules.groups.some((g) => g.conditions.every((c) => conditionMatches(ctx, c, now)));
}

/** Lookup keys of the customer's active entitlements. */
export async function activeEntitlementKeys(db: DB, customer: CustomerRow, now: Date): Promise<string[]> {
  const state = await loadState(db, customer);
  return computeEntitlements(state, await entitlementMap(db, customer.projectId)).filter((e) => isActive(e, now)).map((e) => e.identifier);
}

/** Everything a condition can ask about one customer, from the database plus the current SDK request's headers. */
export async function contextFor(db: DB, customer: CustomerRow | null, headers: Record<string, string | undefined>, now: Date, entitlementsActive: string[] = []): Promise<CustomerContext> {
  const h: Partial<CustomerContext> = {
    platform: headers["x-platform"]?.toLowerCase() ?? null, appVersion: headers["x-client-version"] ?? null, sdkVersion: headers["x-version"] ?? null,
    sdkFlavor: headers["x-platform-flavor"] ?? null, platformVersion: headers["x-platform-version"] ?? null, storefront: headers["x-storefront"] ?? null,
    locale: headers["x-preferred-locales"]?.split(",")[0]?.trim() ?? null,
  };
  // Country conditions use two-letter codes; the iOS SDK sends the App Store storefront as alpha-3 (USA).
  h.country = alpha2(h.storefront);
  if (!customer) return { ...emptyContext(), ...Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null)) };
  const data = (await loadCustomerData(db, [customer])).get(customer.id)!;
  return buildContext(data, now, entitlementsActive, h);
}

export interface Resolution {
  currentOfferingId: string | null;
  placements: Record<string, string | null>;
  rule: { id: string; revision: number } | null;
  experiment: { id: string; variant: string; variantName: string; offeringId: string } | null;
}

type ExperimentRow = typeof schema.experiments.$inferSelect;

/** An experiment's variants; rows written before migration 0031 (or archives from older servers) only have offering_a/b. */
export function variantsOf(e: Pick<ExperimentRow, "variants" | "offeringA" | "offeringB">): ExperimentVariant[] {
  if (Array.isArray(e.variants) && e.variants.length) return e.variants;
  return [
    { id: "a", name: variantDefaultName("a"), offering_id: e.offeringA ?? "", placements: {} },
    { id: "b", name: variantDefaultName("b"), offering_id: e.offeringB ?? "", placements: {} },
  ];
}

/**
 * Running and paused experiments in enrollment order: priority 1 first, then the earliest started. Priority 0 is a row an
 * older server wrote during a deploy (the column default): it goes after the numbered ones, earliest started first, as
 * that server would have ordered it.
 */
const rank = (x: ExperimentRow) => (x.priority > 0 ? x.priority : Number.MAX_SAFE_INTEGER);
export const byPriority = (a: ExperimentRow, b: ExperimentRow) => rank(a) - rank(b) || (a.startedAt?.getTime() ?? Infinity) - (b.startedAt?.getTime() ?? Infinity) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/**
 * Whether a running experiment may enroll this customer now (prd/experiments/PRD.md §2): the enrollment mode, then the
 * audience (saved or inline), then the share. Exported for the dashboard's estimate and the tests.
 */
export async function admits(e: ExperimentRow, customer: CustomerRow, inAudience: (e: ExperimentRow) => boolean): Promise<boolean> {
  if (e.enrollment === "new" && (!e.startedAt || customer.firstSeen.getTime() < e.startedAt.getTime())) return false;
  if (!inAudience(e)) return false;
  return (await enrollBucket(e.id, customer.id)) < e.enrollmentPercent;
}

/**
 * The offering for this request: the experiment the customer is in (running or paused) wins, then a running experiment
 * that enrolls them now (checked by priority), then the first live targeting rule that matches, then the project's
 * current offering. A variant's placements overlay the rule's. Enrolling records EXPERIMENT_ENROLLMENT once;
 * `enroll: false` resolves the same way without enrolling anyone (the dashboard's customer page).
 */
export async function resolveOfferings(db: DB, projectId: string, customer: CustomerRow | null, ctx: CustomerContext, now: Date, defaultOfferingId: string | null, opts: { enroll?: boolean; appUserId?: string | null; sandbox?: boolean } = {}): Promise<Resolution> {
  const out: Resolution = { currentOfferingId: defaultOfferingId, placements: {}, rule: null, experiment: null };
  const audienceIds = new Set<string>();
  const rules = (await db.select().from(schema.targetingRules).where(and(eq(schema.targetingRules.projectId, projectId), eq(schema.targetingRules.state, "active"))).orderBy(asc(schema.targetingRules.position)))
    .filter((r) => (!r.startsAt || r.startsAt <= now) && (!r.endsAt || r.endsAt > now));
  // Paused experiments keep serving their enrolled customers but enroll nobody new.
  const exps = (await db.select().from(schema.experiments).where(and(eq(schema.experiments.projectId, projectId), inArray(schema.experiments.status, ["running", "paused"])))).sort(byPriority);
  for (const r of rules) if (r.audienceId) audienceIds.add(r.audienceId);
  for (const e of exps) if (e.audienceId) audienceIds.add(e.audienceId);
  const auds = audienceIds.size ? await db.select().from(schema.audiences).where(inArray(schema.audiences.id, [...audienceIds])) : [];
  const inAudience = (id: string | null) => {
    if (!id) return true;
    const a = auds.find((x) => x.id === id);
    return !!a && rulesMatch(ctx, a.rules as Rules, now.getTime());
  };
  const inExperimentAudience = (e: ExperimentRow) => (e.audienceRules ? rulesMatch(ctx, e.audienceRules as Rules, now.getTime()) : inAudience(e.audienceId));

  for (const r of rules) {
    if (!inAudience(r.audienceId)) continue;
    out.currentOfferingId = r.offeringId;
    out.placements = r.placements;
    out.rule = { id: r.id, revision: r.revision };
    break;
  }

  if (customer && exps.length) {
    const mine = await db.select().from(schema.experimentEnrollments).where(and(eq(schema.experimentEnrollments.customerId, customer.id), inArray(schema.experimentEnrollments.experimentId, exps.map((e) => e.id))));
    // Sticky: an enrollment in a running or paused experiment wins (the first by priority if there were ever two).
    const held = exps.find((e) => mine.some((m) => m.experimentId === e.id));
    let chosen = held ? { e: held, variant: mine.find((m) => m.experimentId === held.id)!.variant, isNew: false } : null;
    if (!chosen) {
      for (const e of exps) {
        if (e.status !== "running" || !(await admits(e, customer, inExperimentAudience))) continue;
        chosen = { e, variant: await assignVariant(e.id, customer.id, variantsOf(e).map((v) => v.id)), isNew: true };
        break;
      }
    }
    if (chosen) {
      const vs = variantsOf(chosen.e);
      const v = vs.find((x) => x.id === chosen!.variant) ?? vs[0]!;
      out.currentOfferingId = v.offering_id;
      out.placements = { ...out.placements, ...v.placements };
      out.experiment = { id: chosen.e.id, variant: chosen.variant, variantName: v.name, offeringId: v.offering_id };
      // A preview (the dashboard's customer page) shows the experiment the next SDK request would enroll them in, without enrolling.
      if (chosen.isNew && opts.enroll !== false) {
        const inserted = await db.insert(schema.experimentEnrollments).values({ experimentId: chosen.e.id, customerId: customer.id, variant: chosen.variant, enrolledAt: now, isSandbox: !!opts.sandbox }).onConflictDoNothing().returning();
        if (inserted.length) {
          const [o] = await db.select({ key: schema.offerings.lookupKey }).from(schema.offerings).where(eq(schema.offerings.id, v.offering_id));
          await recordRawEvent(db, {
            projectId, appId: null, customer, appUserId: opts.appUserId ?? ctx.appUserIds[0] ?? customer.originalAppUserId, type: "EXPERIMENT_ENROLLMENT", sandbox: !!opts.sandbox, now,
            shape: "experiment",
            fields: { original_app_user_id: customer.originalAppUserId, experiment_id: chosen.e.id, experiment_variant: chosen.variant, offering_id: o?.key ?? null, experiment_enrolled_at_ms: now.getTime() },
          });
        }
      }
    }
  }
  return out;
}

/** Experiments a customer is enrolled in, for the `experiments` field of lifecycle webhooks. */
export async function enrollmentsOf(db: DB, customerId: string) {
  const rows = await db.select().from(schema.experimentEnrollments).where(eq(schema.experimentEnrollments.customerId, customerId));
  return rows.map((r) => ({ experiment_id: r.experimentId, experiment_variant: r.variant, enrolled_at_ms: r.enrolledAt.getTime() }));
}
