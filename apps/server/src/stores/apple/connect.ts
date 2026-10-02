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

export interface Resource { id: string; type: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] | null }> }

/** The id of a to-one relationship, or null. */
export const relId = (r: Resource, name: string): string | null => {
  const d = r.relationships?.[name]?.data;
  return d && !Array.isArray(d) ? d.id : null;
};

/** A territory's price as App Store Connect reports it: the price point's customer price, in the territory's currency. */
export interface AscPrice { territory: string; currency: string | null; customerPrice: string; pricePointId: string | null; startDate: string | null; manual?: boolean }

/**
 * Today's date as App Store Connect counts it: price `startDate`s are days in US Pacific time, so between midnight UTC and
 * midnight in California a price starting on the UTC date has not started yet.
 */
export function ascToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

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
  async send<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
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
    const title = typeof first.title === "string" ? first.title.trim() : "";
    const detail = (title && first.detail ? `${title}${/[.!?]$/.test(title) ? " " : ": "}${first.detail}` : title || first.detail) || `App Store Connect answered ${res.status}`;
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

  /** Like listAll, and keeps the `included` resources of every page (territories, price points). */
  async listAllIncluded(path: string, maxPages = 25): Promise<{ data: Resource[]; included: Resource[]; truncated: boolean }> {
    const data: Resource[] = [];
    const included: Resource[] = [];
    let next: string | undefined = path;
    for (let page = 0; next; page++) {
      if (page >= maxPages) return { data, included, truncated: true };
      const r: { data?: Resource[]; included?: Resource[]; links?: { next?: string } } = await this.send("GET", next);
      data.push(...(r.data ?? []));
      included.push(...(r.included ?? []));
      next = r.links?.next || undefined;
    }
    return { data, included, truncated: false };
  }

  /**
   * A subscription's current price in every territory. App Store Connect lists past, current and scheduled prices; the
   * current one is the latest whose `startDate` is today or earlier (no date: since the start). Prices of Apple's monthly
   * plans for annual subscriptions (`planType` MONTHLY) are left out: the price of the product is the upfront one.
   */
  async subscriptionPrices(subscriptionId: string, today: string): Promise<AscPrice[]> {
    return (await this.subscriptionPriceSchedule(subscriptionId, today)).current;
  }

  /**
   * A subscription's current prices, and the territories with a price change scheduled after today. Apple keeps one
   * scheduled change per territory: a new price there replaces it, so writers must leave those territories alone.
   * `truncated` is true when App Store Connect had more pages than RevenueDot reads.
   */
  async subscriptionPriceSchedule(subscriptionId: string, today: string): Promise<{ current: AscPrice[]; scheduled: string[]; truncated: boolean }> {
    const q = new URLSearchParams({
      include: "territory,subscriptionPricePoint", limit: "200", "fields[subscriptionPrices]": "startDate,preserved,planType,territory,subscriptionPricePoint",
      "fields[subscriptionPricePoints]": "customerPrice,territory", "fields[territories]": "currency",
    });
    const r = await this.listAllIncluded(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/prices?${q}`, 50);
    const scheduled = [...new Set(r.data.filter((x) => typeof x.attributes?.startDate === "string" && (x.attributes.startDate as string) > today).map((x) => relId(x, "territory") ?? "?"))];
    return { current: currentPrices(r.data, r.included, "subscriptionPricePoint", today), scheduled, truncated: r.truncated };
  }

  /**
   * The price points of some territories for a subscription, by territory (`filter[territory]` takes a list). Throws when
   * App Store Connect has more pages than RevenueDot reads, so a price is never matched against part of the list.
   */
  subscriptionPricePoints(subscriptionId: string, territories: string[]) {
    return this.pricePointsOf(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/pricePoints`, "subscriptionPricePoints", territories);
  }

  private async pricePointsOf(path: string, type: string, territories: string[]): Promise<Map<string, { id: string; customerPrice: string }[]>> {
    const q = new URLSearchParams({ "filter[territory]": territories.join(","), include: "territory", limit: "8000", [`fields[${type}]`]: "customerPrice,territory" });
    const r = await this.listAll(`${path}?${q}`, 25);
    if (r.truncated) throw new ConnectError("unavailable", "App Store Connect has more price points than RevenueDot reads at once. Change fewer territories in one file.");
    const out = new Map<string, { id: string; customerPrice: string }[]>(territories.map((t) => [t, []]));
    for (const p of r.data) {
      const t = relId(p, "territory") ?? (territories.length === 1 ? territories[0]! : null);
      if (t) out.set(t, [...(out.get(t) ?? []), { id: p.id, customerPrice: String(p.attributes?.customerPrice ?? "") }]);
    }
    return out;
  }

  /** Schedules a subscription price in one territory (no start date: as soon as Apple allows). */
  createSubscriptionPrice(subscriptionId: string, territory: string, pricePointId: string, preserveCurrentPrice: boolean) {
    return this.send<{ data: Resource }>("POST", "/v1/subscriptionPrices", {
      data: {
        type: "subscriptionPrices", attributes: { preserveCurrentPrice },
        relationships: {
          subscription: { data: { type: "subscriptions", id: subscriptionId } },
          subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: pricePointId } },
          territory: { data: { type: "territories", id: territory } },
        },
      },
    });
  }

  /**
   * An in-app purchase's price schedule: its base territory and the current manual and automatic (equalised) prices.
   * Null when the product has no price yet.
   */
  async inAppPurchaseSchedule(iapId: string, today: string): Promise<{ id: string; baseTerritory: string | null; manual: AscPrice[]; automatic: AscPrice[]; scheduled: string[]; truncated: boolean } | null> {
    let schedule: { data?: Resource };
    try {
      schedule = await this.send("GET", `/v2/inAppPurchases/${encodeURIComponent(iapId)}/iapPriceSchedule`);
    } catch (e) {
      if (e instanceof ConnectError && e.status === 404) return null;
      throw e;
    }
    const id = schedule.data?.id;
    if (!id) return null;
    const base = await this.send<{ data?: Resource }>("GET", `/v1/inAppPurchasePriceSchedules/${encodeURIComponent(id)}/baseTerritory?fields[territories]=currency`).catch((e) => {
      if (e instanceof ConnectError && e.status === 404) return { data: undefined };
      throw e;
    });
    const q = new URLSearchParams({
      include: "inAppPurchasePricePoint,territory", limit: "200", "fields[inAppPurchasePrices]": "startDate,endDate,manual,inAppPurchasePricePoint,territory",
      "fields[inAppPurchasePricePoints]": "customerPrice,territory", "fields[territories]": "currency",
    });
    const manual = await this.listAllIncluded(`/v1/inAppPurchasePriceSchedules/${encodeURIComponent(id)}/manualPrices?${q}`, 25);
    const automatic = await this.listAllIncluded(`/v1/inAppPurchasePriceSchedules/${encodeURIComponent(id)}/automaticPrices?${q}`, 25);
    // Manual prices that start after today: a schedule written back without them would delete them.
    const scheduled = [...new Set(manual.data.filter((r) => typeof r.attributes?.startDate === "string" && (r.attributes.startDate as string) > today).map((r) => relId(r, "territory") ?? "?"))];
    return {
      id, baseTerritory: base.data?.id ?? null, scheduled, truncated: manual.truncated,
      manual: currentPrices(manual.data, manual.included, "inAppPurchasePricePoint", today).map((p) => ({ ...p, manual: true })),
      automatic: currentPrices(automatic.data, automatic.included, "inAppPurchasePricePoint", today).map((p) => ({ ...p, manual: false })),
    };
  }

  /** The price points of some territories for an in-app purchase, by territory. */
  inAppPurchasePricePoints(iapId: string, territories: string[]) {
    return this.pricePointsOf(`/v2/inAppPurchases/${encodeURIComponent(iapId)}/pricePoints`, "inAppPurchasePricePoints", territories);
  }

  /**
   * Replaces an in-app purchase's price schedule: the base territory and its manual prices (the base territory's price
   * among them). Territories without a manual price follow the base price (Apple's equalisation).
   */
  setInAppPurchaseSchedule(iapId: string, baseTerritory: string, manual: { pricePointId: string }[]) {
    const included = manual.map((m, i) => ({
      type: "inAppPurchasePrices", id: `\${price${i}}`, attributes: { startDate: null },
      relationships: { inAppPurchaseV2: { data: { type: "inAppPurchases", id: iapId } }, inAppPurchasePricePoint: { data: { type: "inAppPurchasePricePoints", id: m.pricePointId } } },
    }));
    return this.send<{ data: Resource }>("POST", "/v1/inAppPurchasePriceSchedules", {
      data: {
        type: "inAppPurchasePriceSchedules",
        relationships: {
          inAppPurchase: { data: { type: "inAppPurchases", id: iapId } },
          baseTerritory: { data: { type: "territories", id: baseTerritory } },
          manualPrices: { data: included.map((x) => ({ type: "inAppPurchasePrices", id: x.id })) },
        },
      },
      included,
    });
  }

  /** Every App Store territory with its currency. */
  async territories(): Promise<Map<string, string>> {
    const r = await this.listAll("/v1/territories?limit=200&fields[territories]=currency", 5);
    return new Map(r.data.map((t) => [t.id, String(t.attributes?.currency ?? "")]));
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

/** The current price per territory from a list of price resources and their included price points and territories. */
function currentPrices(data: Resource[], included: Resource[], pointRel: string, today: string): AscPrice[] {
  const byKey = new Map(included.map((x) => [`${x.type}:${x.id}`, x]));
  const best = new Map<string, { start: string | null; r: Resource }>();
  for (const r of data) {
    const a = r.attributes ?? {};
    if (a.planType === "MONTHLY") continue;
    const start = typeof a.startDate === "string" ? a.startDate : null;
    const end = typeof a.endDate === "string" ? a.endDate : null;
    if ((start && start > today) || (end && end <= today)) continue;
    const point = byKey.get(`${pointRel === "subscriptionPricePoint" ? "subscriptionPricePoints" : "inAppPurchasePricePoints"}:${relId(r, pointRel)}`);
    const territory = relId(r, "territory") ?? (point ? relId(point, "territory") : null);
    if (!territory) continue;
    const prev = best.get(territory);
    if (!prev || (prev.start ?? "") <= (start ?? "")) best.set(territory, { start, r });
  }
  const out: AscPrice[] = [];
  for (const [territory, { start, r }] of best) {
    const pointId = relId(r, pointRel);
    const point = byKey.get(`${pointRel === "subscriptionPricePoint" ? "subscriptionPricePoints" : "inAppPurchasePricePoints"}:${pointId}`);
    const price = point?.attributes?.customerPrice;
    if (typeof price !== "string" && typeof price !== "number") continue;
    const t = byKey.get(`territories:${territory}`);
    out.push({ territory, currency: typeof t?.attributes?.currency === "string" ? t.attributes.currency : null, customerPrice: String(price), pricePointId: pointId, startDate: start });
  }
  return out.sort((a, b) => a.territory.localeCompare(b.territory));
}
