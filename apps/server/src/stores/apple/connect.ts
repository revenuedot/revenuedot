import { SignJWT, importPKCS8 } from "jose";
import type { AppRow } from "../types.js";
import type { FetchFn } from "./api.js";
import { outboundUrlProblem } from "../../services/outbound.js";

/**
 * App Store Connect API (https://developer.apple.com/documentation/appstoreconnectapi), used to create products in the
 * store. It needs the app's App Store Connect API key (`app_store_connect_api_key` .p8, `_id`, `_issuer`), a team key with
 * the App Manager role. This is a different key from the In-App Purchase key the App Store Server API uses.
 */
export const ASC_HOST = "https://api.appstoreconnect.apple.com";
const TIMEOUT_MS = 15_000;

export interface ConnectCredentials { keyId: string; issuerId: string; privateKey: string }

/** The App Store Connect API key, or null when any of its three fields is missing. */
export function connectCredentials(app: Pick<AppRow, "credentials">): ConnectCredentials | null {
  const c = app.credentials ?? {};
  const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string).trim() : "");
  const privateKey = str("app_store_connect_api_key").replace(/\\n/g, "\n");
  const keyId = str("app_store_connect_api_key_id");
  const issuerId = str("app_store_connect_api_key_issuer");
  return privateKey && keyId && issuerId ? { keyId, issuerId, privateKey } : null;
}

/** Why App Store Connect refused: our key (credentials), the product already exists (conflict), bad input (invalid) or Apple is down (unavailable). */
export class ConnectError extends Error {
  constructor(public kind: "credentials" | "conflict" | "invalid" | "unavailable", message: string, public status = 0) { super(message); }
}

export interface Resource { id: string; type: string; attributes?: Record<string, unknown> }

export class AppStoreConnectApi {
  private token: Promise<string> | null = null;
  constructor(private creds: ConnectCredentials, private fetchFn: FetchFn, private now: () => Date) {}

  private jwt(): Promise<string> {
    this.token ??= (async () => {
      let key: Awaited<ReturnType<typeof importPKCS8>>;
      try { key = await importPKCS8(this.creds.privateKey, "ES256"); } catch {
        throw new ConnectError("credentials", "The App Store Connect API key is not a valid .p8 private key.");
      }
      const iat = Math.floor(this.now().getTime() / 1000);
      // App Store Connect accepts tokens of up to 20 minutes.
      return new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: this.creds.keyId, typ: "JWT" })
        .setIssuer(this.creds.issuerId).setIssuedAt(iat).setExpirationTime(iat + 19 * 60).setAudience("appstoreconnect-v1").sign(key);
    })();
    return this.token;
  }

  /** `path` is a path on App Store Connect, or a full URL there (the `links.next` of a list). */
  async send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("/") ? `${ASC_HOST}${path}` : path;
    // A paging link comes from Apple's answer: it must stay on App Store Connect, which gets the bearer token.
    if (!url.startsWith(`${ASC_HOST}/`) || outboundUrlProblem(url, true)) throw new ConnectError("invalid", "App Store Connect answered with a link to another host, which is not followed.");
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method, headers: { Authorization: `Bearer ${await this.jwt()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof ConnectError) throw e;
      throw new ConnectError("unavailable", "App Store Connect could not be reached. Try again later.");
    }
    const text = await res.text();
    let json: any = {};
    if (text) { try { json = JSON.parse(text); } catch { json = {}; } }
    if (res.ok) return json as T;
    const first = json?.errors?.[0] ?? {};
    const detail = [first.title, first.detail].filter(Boolean).join(": ") || `App Store Connect answered ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new ConnectError("credentials", `App Store Connect refused the API key (${detail}). It needs the App Manager role.`, res.status);
    if (res.status === 429 || res.status >= 500) throw new ConnectError("unavailable", `App Store Connect is not responding (${detail}). Try again later.`, res.status);
    // 409 is App Store Connect's answer for any entity rule, a duplicate product id among them.
    if (res.status === 409 && /DUPLICATE|already|in use|unique/i.test(`${first.code ?? ""} ${detail}`)) throw new ConnectError("conflict", detail, res.status);
    throw new ConnectError("invalid", detail, res.status);
  }

  /** The App Store Connect app record for a bundle id, or null. */
  async appByBundleId(bundleId: string): Promise<Resource | null> {
    const q = new URLSearchParams({ "filter[bundleId]": bundleId, "fields[apps]": "bundleId,name" });
    const r = await this.send<{ data?: Resource[] }>("GET", `/v1/apps?${q}`);
    return r.data?.find((a) => a.attributes?.bundleId === bundleId) ?? null;
  }

  /** The app's subscription group with this reference name, created when there is none. */
  async subscriptionGroup(appId: string, referenceName: string): Promise<string> {
    const q = new URLSearchParams({ "filter[referenceName]": referenceName, limit: "200" });
    const r = await this.send<{ data?: Resource[] }>("GET", `/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?${q}`);
    const found = r.data?.find((g) => g.attributes?.referenceName === referenceName);
    if (found) return found.id;
    const created = await this.send<{ data: Resource }>("POST", "/v1/subscriptionGroups", {
      data: { type: "subscriptionGroups", attributes: { referenceName }, relationships: { app: { data: { type: "apps", id: appId } } } },
    });
    return created.data.id;
  }

  createSubscription(groupId: string, a: { name: string; productId: string; subscriptionPeriod: string }) {
    return this.send<{ data: Resource }>("POST", "/v1/subscriptions", {
      data: { type: "subscriptions", attributes: a, relationships: { group: { data: { type: "subscriptionGroups", id: groupId } } } },
    });
  }

  createInAppPurchase(appId: string, a: { name: string; productId: string; inAppPurchaseType: "CONSUMABLE" | "NON_CONSUMABLE" | "NON_RENEWING_SUBSCRIPTION" }) {
    return this.send<{ data: Resource }>("POST", "/v2/inAppPurchases", {
      data: { type: "inAppPurchases", attributes: a, relationships: { app: { data: { type: "apps", id: appId } } } },
    });
  }

  /**
   * Every page of a list (`limit=200`, following `links.next`), up to `maxPages`. `truncated` is true when more pages
   * were left unread.
   */
  async listAll(path: string, maxPages = 25): Promise<{ data: Resource[]; truncated: boolean }> {
    const data: Resource[] = [];
    let next: string | undefined = path;
    for (let page = 0; next; page++) {
      if (page >= maxPages) return { data, truncated: true };
      const r: { data?: Resource[]; links?: { next?: string } } = await this.send("GET", next);
      data.push(...(r.data ?? []));
      next = r.links?.next || undefined;
    }
    return { data, truncated: false };
  }

  /** The app's in-app purchases (consumable, non-consumable, non-renewing), from the in-app purchases v2 API. */
  inAppPurchases(appId: string) {
    const q = new URLSearchParams({ limit: "200", "fields[inAppPurchases]": "name,productId,inAppPurchaseType,state" });
    return this.listAll(`/v1/apps/${encodeURIComponent(appId)}/inAppPurchasesV2?${q}`);
  }

  /** The app's subscription groups. */
  subscriptionGroups(appId: string) {
    const q = new URLSearchParams({ limit: "200", "fields[subscriptionGroups]": "referenceName" });
    return this.listAll(`/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?${q}`);
  }

  /** The auto-renewable subscriptions in one group. */
  subscriptions(groupId: string) {
    const q = new URLSearchParams({ limit: "200", "fields[subscriptions]": "name,productId,subscriptionPeriod,state,groupLevel" });
    return this.listAll(`/v1/subscriptionGroups/${encodeURIComponent(groupId)}/subscriptions?${q}`);
  }
}
