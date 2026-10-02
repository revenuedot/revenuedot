/**
 * First-class attribution (prd/attribution-benchmarks-insights §1): the reserved attribution attributes a customer has
 * become one row of named fields. The attributes stay the source of truth; this is how they read.
 *
 * - `$mediaSource`, `$campaign`, `$adGroup`, `$ad`, `$keyword`, `$creative`: what the app, an attribution partner
 *   (AppsFlyer, Adjust, Branch …) or the REST API set.
 * - `$appleAds*`: Apple Search Ads ids from the AdServices token. AdServices gives ids only, so `$campaign` holds the
 *   campaign id there; with the project's Apple Search Ads names loaded the row carries the name and keeps the id.
 * - Partner device ids (`$appsflyerId` …) identify the device to the partner; they are not attribution by themselves.
 */

export const APPLE_SEARCH_ADS = "Apple Search Ads";

/** Reserved attributes that describe where a customer came from. */
export const ATTRIBUTION_KEYS = [
  "$mediaSource", "$campaign", "$adGroup", "$ad", "$keyword", "$creative",
  "$appleAdsCampaignId", "$appleAdsAdGroupId", "$appleAdsKeywordId", "$appleAdsAdId", "$appleAdsOrgId", "$appleAdsCountryOrRegion",
  "$claimType", "$conversionType",
] as const;

/** Attribution partners' device ids, as stored in `partner_ids`. */
export const PARTNER_ID_KEYS: Record<string, string> = {
  $appsflyerId: "appsflyer_id", $adjustId: "adjust_id", $branchId: "branch_id", $kochavaDeviceId: "kochava_device_id",
  $singularDeviceId: "singular_device_id", $tenjinId: "tenjin_id", $airbridgeDeviceId: "airbridge_device_id",
};

/** Every attribute key whose change rebuilds the attribution row. */
export const ATTRIBUTION_SOURCE_KEYS: string[] = [...ATTRIBUTION_KEYS, ...Object.keys(PARTNER_ID_KEYS)];
export const isAttributionKey = (k: string) => ATTRIBUTION_SOURCE_KEYS.includes(k);

export interface CustomerAttributionFields {
  mediaSource: string | null;
  campaign: string | null;
  campaignId: string | null;
  adGroup: string | null;
  adGroupId: string | null;
  ad: string | null;
  adId: string | null;
  keyword: string | null;
  keywordId: string | null;
  creative: string | null;
  claimType: string | null;
  conversionType: string | null;
  attributionCountry: string | null;
  partnerIds: Record<string, string>;
}

/** Apple Search Ads names the project's connection loaded: campaign id → name, ad group id → name. */
export interface AppleAdsNames { campaigns?: Record<string, string>; ad_groups?: Record<string, string> }

export const MAX_ATTRIBUTION_VALUE = 200;
const clean = (v: unknown): string | null => {
  if (v === null || v === undefined || typeof v === "object") return null;
  const s = String(v).trim();
  return s ? s.slice(0, MAX_ATTRIBUTION_VALUE) : null;
};

/**
 * The attribution row for a customer's attributes, or null when they have no attribution at all (no row is kept).
 * `names` resolves Apple Search Ads ids to the names the project's connection loaded.
 */
export function attributionFromAttributes(attrs: Record<string, string | null | undefined>, names: AppleAdsNames = {}): CustomerAttributionFields | null {
  const a = (k: string) => clean(attrs[k]);
  const campaignId = a("$appleAdsCampaignId"), adGroupId = a("$appleAdsAdGroupId"), keywordId = a("$appleAdsKeywordId"), adId = a("$appleAdsAdId");
  const apple = !!(campaignId || adGroupId || keywordId || adId);
  const named = (id: string | null, map: Record<string, string> | undefined) => (id && map?.[id] ? clean(map[id]) : null);
  // A name the app or a partner set wins, unless it is just the Apple id (what AdServices stores in $campaign).
  const pick = (set: string | null, id: string | null, map?: Record<string, string>) => {
    const name = named(id, map);
    if (name && (!set || set === id)) return name;
    return set ?? id;
  };
  const partnerIds: Record<string, string> = {};
  for (const [key, field] of Object.entries(PARTNER_ID_KEYS)) { const v = a(key); if (v) partnerIds[field] = v; }
  const row: CustomerAttributionFields = {
    mediaSource: a("$mediaSource") ?? (apple ? APPLE_SEARCH_ADS : null),
    campaign: pick(a("$campaign"), campaignId, names.campaigns), campaignId,
    adGroup: pick(a("$adGroup"), adGroupId, names.ad_groups), adGroupId,
    ad: a("$ad") ?? adId, adId,
    keyword: a("$keyword") ?? keywordId, keywordId,
    creative: a("$creative"),
    claimType: a("$claimType"),
    conversionType: a("$conversionType"),
    attributionCountry: a("$appleAdsCountryOrRegion")?.toUpperCase() ?? null,
    partnerIds,
  };
  const any = Object.entries(row).some(([k, v]) => (k === "partnerIds" ? Object.keys(v as object).length > 0 : v !== null));
  return any ? row : null;
}

/** The attribution dimensions charts, the report and audiences share. */
export type AttributionDim = "media_source" | "campaign" | "ad_group" | "keyword" | "ad" | "creative";
export const ATTRIBUTION_DIMS: AttributionDim[] = ["media_source", "campaign", "ad_group", "keyword", "ad", "creative"];
export const ATTRIBUTION_DIM_LABEL: Record<AttributionDim, string> = {
  media_source: "Media source", campaign: "Campaign", ad_group: "Ad group", keyword: "Keyword", ad: "Ad", creative: "Creative",
};
/** The label of a customer without a value for an attribution dimension. */
export const NO_ATTRIBUTION = "No attribution";

/** A chart customer's attribution, keyed by dimension. */
export type ChartAttribution = Partial<Record<AttributionDim, string | null>>;

export const attributionOfRow = (r: Pick<CustomerAttributionFields, "mediaSource" | "campaign" | "adGroup" | "keyword" | "ad" | "creative">): ChartAttribution => ({
  media_source: r.mediaSource, campaign: r.campaign, ad_group: r.adGroup, keyword: r.keyword, ad: r.ad, creative: r.creative,
});
