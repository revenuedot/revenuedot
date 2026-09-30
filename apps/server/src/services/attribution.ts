import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { setAttributes } from "../repo/customers.js";

type Attr = { value: unknown; updated_at_ms?: number };
type Attrs = Record<string, Attr>;
type Req = { header: (k: string) => string | undefined };

/**
 * The client's IP address, for the `$ip` attribute. Behind Cloudflare or a proxy it is the first forwarded address; on
 * the bare Node server it is the socket's peer (`c.env.incoming` is Node's IncomingMessage under @hono/node-server).
 */
export function clientIp(c: { req: Req; env?: unknown }): string | null {
  const fwd = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? c.req.header("x-real-ip");
  if (fwd?.trim()) return fwd.trim();
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return socket?.remoteAddress?.replace(/^::ffff:/, "") ?? null;
}

/**
 * `collectDeviceIdentifiers()` in both SDKs sets `$ip` and `$deviceVersion` to the string "true", asking the server to
 * fill in the real values (iOS `SubscriberAttributesManager.collectDeviceIdentifiers`, Android
 * `DeviceIdentifiersFetcher`). The IP comes from the request, the device from the SDK's headers.
 */
export function resolveDeviceAttributes(attrs: Attrs, c: { req: Req; env?: unknown }): Attrs {
  const out = { ...attrs };
  if (String(out.$ip?.value) === "true") {
    const ip = clientIp(c);
    out.$ip = { ...out.$ip!, value: ip };
    if (!ip) delete out.$ip;
  }
  if (String(out.$deviceVersion?.value) === "true") {
    const device = c.req.header("x-platform-device")?.trim();
    const os = [c.req.header("x-platform")?.trim(), c.req.header("x-platform-version")?.trim()].filter(Boolean).join(" ");
    const value = [device, os].filter(Boolean).join(", ");
    if (value) out.$deviceVersion = { ...out.$deviceVersion!, value: value.slice(0, 500) };
    else delete out.$deviceVersion;
  }
  return out;
}

/** Keys the SDK's `AttributionKey` puts in `POST .../attribution` data, and the reserved attributes they become. */
const ATTRIBUTION_IDS: Record<string, string> = { rc_idfa: "$idfa", rc_idfv: "$idfv", rc_gps_adid: "$gpsAdId", rc_ip_address: "$ip" };
/** Legacy iAd (Apple Search Ads, network 0) keys, inside a "Version3.1" object or at the top level. */
const IAD_KEYS: Record<string, string> = {
  "iad-campaign-name": "$campaign", "iad-adgroup-name": "$adGroup", "iad-keyword": "$keyword", "iad-creativeset-name": "$creative",
  "iad-campaign-id": "$appleAdsCampaignId", "iad-adgroup-id": "$appleAdsAdGroupId", "iad-keyword-id": "$appleAdsKeywordId", "iad-org-id": "$appleAdsOrgId",
  "iad-country-or-region": "$appleAdsCountryOrRegion", "iad-conversion-type": "$conversionType",
};
const APPLE_SEARCH_ADS = "Apple Search Ads";

/**
 * `POST /v1/subscribers/{id}/attribution` (iOS `addAttributionData`, deprecated): `{network, data}`. The advertising
 * identifiers become `$idfa`, `$idfv`, `$gpsAdId` and `$ip`; Apple Search Ads (network 0) iAd data becomes
 * `$mediaSource` and the campaign attributes. Other networks send their ids as attributes directly.
 */
export function attributionDataToAttributes(body: { network?: unknown; data?: unknown }, nowMs: number): Attrs {
  const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
  const out: Attrs = {};
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "" || typeof v === "object") return;
    out[k] = { value: String(v).slice(0, 500), updated_at_ms: nowMs };
  };
  for (const [from, to] of Object.entries(ATTRIBUTION_IDS)) put(to, data[from]);
  if (Number(body.network) === 0) {
    const iad = (typeof data["Version3.1"] === "object" && data["Version3.1"] ? data["Version3.1"] : data) as Record<string, unknown>;
    if (String(iad["iad-attribution"]) === "true") {
      put("$mediaSource", APPLE_SEARCH_ADS);
      for (const [from, to] of Object.entries(IAD_KEYS)) put(to, iad[from]);
    }
  }
  return out;
}

/** What Apple's AdServices attribution API returns for a token (https://developer.apple.com/documentation/adservices/aaattribution/attributiontoken()). */
interface AdServicesAttribution {
  attribution?: boolean; orgId?: number; campaignId?: number; adGroupId?: number; keywordId?: number; adId?: number;
  countryOrRegion?: string; conversionType?: string; claimType?: string;
}
export const ADSERVICES_URL = "https://api-adservices.apple.com/api/v1/";

/** Apple's attribution record as the reserved attributes RevenueCat documents for Apple Search Ads. */
export function adServicesToAttributes(a: AdServicesAttribution, nowMs: number): Attrs {
  if (a.attribution !== true) return {};
  const out: Attrs = {};
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== "") out[k] = { value: String(v), updated_at_ms: nowMs }; };
  put("$mediaSource", APPLE_SEARCH_ADS);
  put("$campaign", a.campaignId); put("$adGroup", a.adGroupId); put("$keyword", a.keywordId); put("$ad", a.adId);
  put("$appleAdsCampaignId", a.campaignId); put("$appleAdsAdGroupId", a.adGroupId); put("$appleAdsKeywordId", a.keywordId);
  put("$appleAdsAdId", a.adId); put("$appleAdsOrgId", a.orgId); put("$appleAdsCountryOrRegion", a.countryOrRegion);
  put("$claimType", a.claimType); put("$conversionType", a.conversionType);
  return out;
}

/** Attribution is write-once: a value the customer already has (from an earlier install or the app itself) is kept. */
export async function setAttributionOnce(db: DB, customerId: string, attrs: Attrs, now: Date) {
  const keys = Object.keys(attrs);
  if (!keys.length) return;
  const have = await db.select({ key: schema.customerAttributes.key }).from(schema.customerAttributes)
    .where(and(eq(schema.customerAttributes.customerId, customerId), inArray(schema.customerAttributes.key, keys)));
  const taken = new Set(have.filter((r) => r.key !== "$idfa" && r.key !== "$idfv" && r.key !== "$gpsAdId" && r.key !== "$ip").map((r) => r.key));
  // Advertising identifiers are device facts, not attribution, so the newest one wins like any attribute.
  const fresh = Object.fromEntries(Object.entries(attrs).filter(([k]) => !taken.has(k)));
  if (Object.keys(fresh).length) await setAttributes(db, customerId, fresh, now);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves an AdServices token (`POST .../adservices_attribution` or `aad_attribution_token` on a receipt) with Apple's
 * public attribution API, then stores the result as attributes. Apple answers 404 until the record is ready, so a 404 or
 * 5xx is retried up to 3 times, 5 seconds apart, as Apple recommends. Runs after the response (`deps.background`); a
 * failure is logged and dropped, because the SDK does not resend a token it has posted.
 */
export async function resolveAdServicesToken(deps: Deps, customerId: string, token: string, retryDelayMs = 5_000) {
  const fetchFn = deps.fetch ?? fetch;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(retryDelayMs);
    let res: Response;
    try {
      res = await fetchFn(ADSERVICES_URL, { method: "POST", headers: { "content-type": "text/plain" }, body: token, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      console.warn("AdServices attribution: Apple could not be reached", e);
      continue;
    }
    if (res.status === 404 || res.status >= 500) continue;
    if (!res.ok) { console.warn(`AdServices attribution: Apple refused the token (${res.status})`); return; }
    const body = await res.json().catch(() => ({})) as AdServicesAttribution;
    await setAttributionOnce(deps.db, customerId, adServicesToAttributes(body, deps.now().getTime()), deps.now());
    return;
  }
  console.warn("AdServices attribution: no record from Apple after 4 attempts");
}

/** Runs work after the response: Workers keep the request alive for it (`deps.background`), Node lets it run. */
export function inBackground(deps: Deps, task: () => Promise<unknown>) {
  const p = task().catch((e) => console.error("background task failed", e));
  if (deps.background) deps.background(p);
}
