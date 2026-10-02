import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { ATTRIBUTION_SOURCE_KEYS, attributionFromAttributes, type AppleAdsNames, type CustomerAttributionFields } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

/**
 * Keeps `customer_attribution` in step with the reserved attribution attributes (prd/attribution-benchmarks-insights §1).
 * Every writer of attributes goes through `setAttributes` or the customer merge, and both call `syncCustomerAttribution`;
 * loading Apple Search Ads names calls `resyncAppleAdsNames`.
 */

const CA = schema.customerAttribution;

/** The Apple Search Ads campaign and ad group names the project's connection has loaded (empty without one). */
export async function appleAdsNames(db: DB, projectId: string): Promise<AppleAdsNames> {
  const [row] = await db.select({ settings: schema.integrations.settings }).from(schema.integrations)
    .where(and(eq(schema.integrations.projectId, projectId), eq(schema.integrations.kind, "apple_search_ads")))
    .orderBy(schema.integrations.createdAt).limit(1);
  const names = (row?.settings as { names?: AppleAdsNames } | undefined)?.names;
  return { campaigns: names?.campaigns ?? {}, ad_groups: names?.ad_groups ?? {} };
}

async function write(db: DB, customerId: string, projectId: string, row: CustomerAttributionFields | null, now: Date) {
  if (!row) { await db.delete(CA).where(eq(CA.customerId, customerId)); return; }
  const values = { ...row, updatedAt: now };
  await db.insert(CA).values({ customerId, projectId, ...values }).onConflictDoUpdate({ target: CA.customerId, set: { projectId, ...values } });
}

/** Rebuilds one customer's attribution row from their attributes (deletes it when nothing is left). */
export async function syncCustomerAttribution(db: DB, customerId: string, now = new Date(), names?: AppleAdsNames) {
  const [c] = await db.select({ projectId: schema.customers.projectId }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!c) return null;
  const rows = await db.select({ key: schema.customerAttributes.key, value: schema.customerAttributes.value }).from(schema.customerAttributes)
    .where(and(eq(schema.customerAttributes.customerId, customerId), inArray(schema.customerAttributes.key, ATTRIBUTION_SOURCE_KEYS)));
  const attrs = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const row = attributionFromAttributes(attrs, names ?? await appleAdsNames(db, c.projectId));
  await write(db, customerId, c.projectId, row, now);
  return row;
}

/** Customers per round of a batch rebuild: one read of their attributes, one multi-row upsert, one delete. */
const BATCH = 500;

/**
 * Rebuilds the attribution rows of many customers of one project with a fixed number of statements per BATCH customers
 * (the importer's pages and the Apple Search Ads name sync run on Workers, where every statement is a round trip).
 */
export async function syncAttributionBatch(db: DB, projectId: string, customerIds: string[], now = new Date(), names?: AppleAdsNames) {
  const ids = [...new Set(customerIds)];
  if (!ids.length) return 0;
  const n = names ?? await appleAdsNames(db, projectId);
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH);
    const rows = await db.select({ customerId: schema.customerAttributes.customerId, key: schema.customerAttributes.key, value: schema.customerAttributes.value })
      .from(schema.customerAttributes).where(and(inArray(schema.customerAttributes.customerId, part), inArray(schema.customerAttributes.key, ATTRIBUTION_SOURCE_KEYS)));
    const by = new Map<string, Record<string, string | null>>(part.map((id) => [id, {}]));
    for (const r of rows) by.get(r.customerId)![r.key] = r.value;
    const keep: (typeof CA.$inferInsert)[] = [], drop: string[] = [];
    for (const id of part) {
      const row = attributionFromAttributes(by.get(id)!, n);
      if (row) keep.push({ customerId: id, projectId, ...row, updatedAt: now }); else drop.push(id);
    }
    if (keep.length) {
      const cols = ["projectId", "mediaSource", "campaign", "campaignId", "adGroup", "adGroupId", "ad", "adId", "keyword", "keywordId", "creative", "claimType",
        "conversionType", "attributionCountry", "partnerIds", "updatedAt"] as const;
      await db.insert(CA).values(keep).onConflictDoUpdate({ target: CA.customerId, set: Object.fromEntries(cols.map((c) => [c, sql.raw(`excluded."${CA[c].name}"`)])) });
    }
    if (drop.length) await db.delete(CA).where(inArray(CA.customerId, drop));
  }
  return ids.length;
}

/**
 * After Apple Search Ads names were loaded: every customer of the project with an Apple Search Ads campaign or ad group
 * id gets the names. Returns how many rows were rebuilt.
 */
export async function resyncAppleAdsNames(db: DB, projectId: string, now = new Date()): Promise<number> {
  const names = await appleAdsNames(db, projectId);
  const ids = (await db.select({ id: CA.customerId }).from(CA).where(and(eq(CA.projectId, projectId), or(isNotNull(CA.campaignId), isNotNull(CA.adGroupId))))).map((r) => r.id);
  return syncAttributionBatch(db, projectId, ids, now, names);
}

export type CustomerAttributionRow = typeof CA.$inferSelect;

/** The API shape of an attribution row (null fields kept, so clients see every field). */
export function attributionShape(r: CustomerAttributionRow | undefined | null) {
  if (!r) return null;
  return {
    object: "customer_attribution" as const,
    media_source: r.mediaSource, campaign: r.campaign, campaign_id: r.campaignId, ad_group: r.adGroup, ad_group_id: r.adGroupId,
    ad: r.ad, ad_id: r.adId, keyword: r.keyword, keyword_id: r.keywordId, creative: r.creative, claim_type: r.claimType,
    conversion_type: r.conversionType, attribution_country: r.attributionCountry, partner_ids: r.partnerIds, updated_at: r.updatedAt.getTime(),
  };
}
