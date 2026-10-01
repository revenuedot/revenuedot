import { DOCS, REPORTING, attr, conceptOf, isSandbox, nameFor, revenueUsd, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";

/**
 * Asapty: Apple Search Ads revenue by keyword, through Asapty's MMP events endpoint, `GET
 * https://asapty.com/_api/mmpEvents/` with query parameters and a URL-encoded `json` parameter. The request is the one
 * RevenueCat and Adapty document for Asapty (https://www.revenuecat.com/docs/integrations/attribution/reference/asapty,
 * https://adapty.io/docs/asapty); Asapty answers 200 with `result.status` = OK when it accepted the event.
 * Settings: `asapty_id` (Asapty dashboard, Settings → General), `reporting`. No secrets.
 * Identity: the customer's Apple Search Ads attribution, which RevenueDot stores from the SDK's AdServices token:
 * `$appleAdsCampaignId` (required, else the event is skipped), `$appleAdsAdGroupId`, `$appleAdsKeywordId`,
 * `$appleAdsAdId`, `$claimType`, `$appleAdsCountryOrRegion`. Apple's -1 placeholder ids are left out.
 * Sent: RevenueCat's Asapty names (<step>_event, non_renewing_purchase_event), revenue as a two-decimal USD string.
 * Asapty takes no negative revenue, so refunds go with revenue 0.00.
 * Sandbox: Asapty takes production events only; sandbox events are skipped.
 */

export const ASAPTY_URL = "https://asapty.com/_api/mmpEvents/";

export const ASAPTY_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change",
];

export const asaptyName = (c: Concept): string | null =>
  !ASAPTY_EVENTS.includes(c) ? null : c === "non_subscription_purchase" ? "non_renewing_purchase_event" : `${c}_event`;

const id = (v: string | null) => (v && v.trim() !== "-1" ? v.trim() : null);

export async function buildAsapty(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !ASAPTY_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Asapty.`);
  if (isSandbox(e)) return skip("Asapty takes production events only, so sandbox events are not sent.");
  const asaptyId = typeof i.settings.asapty_id === "string" ? i.settings.asapty_id.trim() : "";
  if (!asaptyId) return skip("No Asapty ID is saved.");
  const campaign = id(attr(e, "$appleAdsCampaignId"));
  if (!campaign) return skip("The customer has no Apple Search Ads attribution ($appleAdsCampaignId), so Asapty cannot attribute the event.");
  const name = nameFor(c, asaptyName, i.eventNames)!;
  const q = new URLSearchParams({ source: "revenuedot", asaptyid: asaptyId, event_name: name, conversiondate: String(e.event_timestamp_ms ?? i.now.getTime()), campaignid: campaign });
  const optional: [string, string][] = [["$appleAdsAdGroupId", "adgroupid"], ["$appleAdsKeywordId", "keywordid"], ["$appleAdsAdId", "ad_id"]];
  for (const [a, k] of optional) { const v = id(attr(e, a)); if (v) q.set(k, v); }
  const claim = attr(e, "$claimType");
  if (claim) q.set("claim_type", claim);
  const revenue = Math.max(0, revenueUsd(e, i.settings.reporting));
  const payload: Record<string, unknown> = {
    revenue: revenue.toFixed(2), af_currency: "USD", transaction_id: e.transaction_id ?? null, original_transaction_id: e.original_transaction_id ?? null,
    purchase_date: e.purchased_at_ms ?? null, environment: "PRODUCTION", vendor_product_id: e.product_id ?? null, store_country: e.country_code ?? null,
  };
  const country = attr(e, "$appleAdsCountryOrRegion");
  if (country) payload.profile_country = country;
  q.set("json", JSON.stringify(payload));
  return { name, requests: [{ method: "GET", url: `${ASAPTY_URL}?${q.toString()}`, headers: {}, body: "" }], redact: [] };
}

export const ASAPTY: PartnerDef = {
  spec: {
    kind: "asapty", name: "Asapty", category: "attribution", environment: "production", eventNames: true, docs: `${DOCS}#asapty`, api: "documented",
    text: "Send subscription revenue to Asapty to see what each Apple Search Ads keyword and campaign earned.",
    fields: [
      { key: "asapty_id", label: "Asapty ID", type: "text", required: true, hint: "In Asapty, Settings → General." },
      REPORTING,
    ],
  },
  events: ASAPTY_EVENTS,
  build: buildAsapty,
  defaultName: asaptyName,
  answerError: (body, j) => {
    const status = j?.result?.status;
    return status === "OK" ? null : `Asapty did not accept the event: ${body ? body.slice(0, 300) : "empty answer"}`;
  },
};
