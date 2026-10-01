import { and, eq, gte, lt, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { guardedFetch, OutboundRefused } from "../outbound.js";
import { unseal, type SecretKey } from "../secrets.js";

/**
 * Apple Search Ads (prd/integrations/PRD.md, "Apple Search Ads"). Attribution needs no setup: the SDK's AdServices token
 * is resolved with Apple and stored as `$appleAdsCampaignId`, `$appleAdsAdGroupId` … (services/attribution.ts).
 * This adds campaign reporting:
 * - `appleAdsReport`: customers first seen in a period, grouped by their Apple Search Ads campaign, with paying
 *   customers and revenue (USD, production) to date.
 * - `syncAppleAdsNames`: campaign and ad group names from the Apple Search Ads Campaign Management API
 *   (https://developer.apple.com/documentation/apple_search_ads/implementing_oauth_for_the_apple_search_ads_api),
 *   signed in with the API user's ES256 client secret, kept on the project's `apple_search_ads` connection.
 */

export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/oauth2/token";
export const APPLE_ADS_API = "https://api.searchads.apple.com/api/v5";
const MAX_CAMPAIGNS = 200;

const I = schema.integrations;

export class AppleAdsError extends Error {}

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, n >> 8, n & 0xff];
}

/**
 * Apple's key file is SEC1 ("BEGIN EC PRIVATE KEY", from `openssl ecparam -genkey`); WebCrypto imports PKCS #8. A SEC1
 * key is wrapped as PrivateKeyInfo { version 0, { id-ecPublicKey, prime256v1 }, OCTET STRING(sec1) }.
 */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der: Uint8Array;
  try { der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0)); } catch { throw new AppleAdsError("The private key is not a PEM file."); }
  if (!/BEGIN EC PRIVATE KEY/.test(pem)) return Uint8Array.from(der);
  const algo = [0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
  const octet = [0x04, ...derLen(der.length), ...der];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  return Uint8Array.from([0x30, ...derLen(inner.length), ...inner]);
}

/** The ES256 client secret Apple's token endpoint takes for an Apple Search Ads API user. */
export async function appleAdsClientSecret(o: { clientId: string; teamId: string; keyId: string; privateKeyPem: string; nowMs: number }): Promise<string> {
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(o.privateKeyPem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]); } catch (e) {
    if (e instanceof AppleAdsError) throw e;
    throw new AppleAdsError("The private key could not be read. Paste the P-256 key you generated for the API user (private-key.pem).");
  }
  const iat = Math.floor(o.nowMs / 1000);
  const input = `${b64url(JSON.stringify({ alg: "ES256", kid: o.keyId }))}.${b64url(JSON.stringify({ sub: o.clientId, aud: "https://appleid.apple.com", iat, exp: iat + 3600, iss: o.teamId }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

async function appleJson(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try { res = await guardedFetch(fetchFn, url, init); } catch (e) { throw new AppleAdsError(e instanceof OutboundRefused ? e.message : `Apple could not be reached: ${e instanceof Error ? e.message : String(e)}`); }
  const text = await res.text().catch(() => "");
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  if (!res.ok) throw new AppleAdsError(`Apple answered HTTP ${res.status}${j?.error_description ? `: ${j.error_description}` : j?.error?.errors?.[0]?.message ? `: ${j.error.errors[0].message}` : ""}.`);
  return j;
}

/** Loads campaign and ad group names into the connection. Returns how many campaigns were named. */
export async function syncAppleAdsNames(d: { db: DB; fetch: typeof fetch; now: () => Date; secretKey: SecretKey | null }, projectId: string): Promise<number> {
  const [row] = await d.db.select().from(I).where(and(eq(I.projectId, projectId), eq(I.kind, "apple_search_ads"))).limit(1);
  if (!row) throw new AppleAdsError("Apple Search Ads is not set up for this project.");
  const s = row.settings as Record<string, any>;
  const secrets = await unseal(row.secrets, d.secretKey);
  if (!s.org_id || !s.client_id || !s.team_id || !s.key_id || !secrets.private_key) throw new AppleAdsError("Enter the organization ID, client ID, team ID, key ID and private key of an Apple Search Ads API user to load campaign names.");
  const now = d.now();
  try {
    const clientSecret = await appleAdsClientSecret({ clientId: s.client_id, teamId: s.team_id, keyId: s.key_id, privateKeyPem: secrets.private_key, nowMs: now.getTime() });
    const q = new URLSearchParams({ grant_type: "client_credentials", client_id: s.client_id, client_secret: clientSecret, scope: "searchadsorg" });
    const tok = await appleJson(d.fetch, `${APPLE_TOKEN_URL}?${q}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
    if (typeof tok?.access_token !== "string") throw new AppleAdsError("Apple returned no access token.");
    const headers = { authorization: `Bearer ${tok.access_token}`, "x-ap-context": `orgId=${s.org_id}`, accept: "application/json" };
    const campaigns: Record<string, string> = {}, adGroups: Record<string, string> = {};
    const list = await appleJson(d.fetch, `${APPLE_ADS_API}/campaigns?limit=1000&offset=0`, { headers });
    for (const c of ((list?.data ?? []) as { id?: number; name?: string }[]).slice(0, MAX_CAMPAIGNS)) {
      if (c.id === undefined || !c.name) continue;
      campaigns[String(c.id)] = c.name;
      const groups = await appleJson(d.fetch, `${APPLE_ADS_API}/campaigns/${c.id}/adgroups?limit=1000&offset=0`, { headers });
      for (const g of (groups?.data ?? []) as { id?: number; name?: string }[]) if (g.id !== undefined && g.name) adGroups[String(g.id)] = g.name;
    }
    await d.db.update(I).set({ settings: { ...row.settings, names: { campaigns, ad_groups: adGroups }, last_sync_at: now.getTime(), last_sync_error: null }, lastError: null, consecutiveFailures: 0, lastDeliveredAt: now }).where(eq(I.id, row.id));
    return Object.keys(campaigns).length;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await d.db.update(I).set({ settings: { ...row.settings, last_sync_at: now.getTime(), last_sync_error: message.slice(0, 500) }, lastError: message.slice(0, 500) }).where(eq(I.id, row.id));
    throw e instanceof AppleAdsError ? e : new AppleAdsError(message);
  }
}

/**
 * Customers first seen in [start, end) with an Apple Search Ads campaign, by campaign: customers, paying customers and
 * production revenue to date (USD; refunds negative), with names when they have been loaded.
 */
export async function appleAdsReport(db: DB, projectId: string, start: Date, end: Date) {
  const A = schema.customerAttributes, C = schema.customers, T = schema.transactions;
  const rows = await db.select({
    campaignId: A.value, customers: sql<number>`count(distinct ${C.id})::int`,
    paying: sql<number>`count(distinct ${T.customerId}) filter (where ${T.revenueUsd} > 0)::int`,
    revenue: sql<number>`coalesce(sum(${T.revenueUsd}), 0)::float8`,
  }).from(A).innerJoin(C, eq(C.id, A.customerId)).leftJoin(T, and(eq(T.customerId, C.id), eq(T.isSandbox, false)))
    .where(and(eq(C.projectId, projectId), eq(A.key, "$appleAdsCampaignId"), gte(C.firstSeen, start), lt(C.firstSeen, end)))
    .groupBy(A.value);
  const [conn] = await db.select({ settings: I.settings }).from(I).where(and(eq(I.projectId, projectId), eq(I.kind, "apple_search_ads"))).limit(1);
  const names = ((conn?.settings as Record<string, any> | undefined)?.names?.campaigns ?? {}) as Record<string, string>;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return rows.filter((r) => r.campaignId).map((r) => ({
    campaign_id: r.campaignId!, name: names[r.campaignId!] ?? null, customers: Number(r.customers), paying_customers: Number(r.paying),
    revenue: r2(Number(r.revenue)), revenue_per_customer: Number(r.customers) ? r2(Number(r.revenue) / Number(r.customers)) : 0,
  })).sort((a, b) => b.revenue - a.revenue || b.customers - a.customers);
}
