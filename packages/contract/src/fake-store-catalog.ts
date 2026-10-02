/**
 * Stateful fakes of the App Store Connect API and the Google Play Developer API's monetization endpoints, for the store
 * prices and product editor tests (apps/server/test/store-prices.test.ts, product-editor.test.ts) and the e2e server
 * (apps/dashboard/e2e/store-fakes.ts). They answer in the shapes Apple and Google document: JSON:API resources with
 * `included` and `links.next` paging, price points whose ids encode product, territory and tier like Apple's, price
 * schedules that replace manual prices, base plans with `regionalConfigs` priced in Google's Money, `pageToken` paging,
 * the `regionsVersion.version` and `updateMask` parameters Play requires on writes, and each store's error bodies.
 * Failures can be injected per request. No real store is called.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s: string): Record<string, unknown> => { try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>; } catch { return {}; } };
const jwtPart = (token: string, i: number) => unb64(token.split(".")[i] ?? "");

/** Territories (App Store three-letter code, Play two-letter code), currency, and a rough rate to USD for price ladders. */
export const FAKE_TERRITORIES: { asc: string; play: string; currency: string; rate: number }[] = [
  { asc: "USA", play: "US", currency: "USD", rate: 1 }, { asc: "GBR", play: "GB", currency: "GBP", rate: 0.8 }, { asc: "DEU", play: "DE", currency: "EUR", rate: 0.93 },
  { asc: "FRA", play: "FR", currency: "EUR", rate: 0.93 }, { asc: "JPN", play: "JP", currency: "JPY", rate: 150 }, { asc: "CAN", play: "CA", currency: "CAD", rate: 1.36 },
  { asc: "AUS", play: "AU", currency: "AUD", rate: 1.5 }, { asc: "IND", play: "IN", currency: "INR", rate: 83 }, { asc: "BRA", play: "BR", currency: "BRL", rate: 5.4 },
  { asc: "CHE", play: "CH", currency: "CHF", rate: 0.9 }, { asc: "KOR", play: "KR", currency: "KRW", rate: 1350 }, { asc: "MEX", play: "MX", currency: "MXN", rate: 18 },
];
/** The App Store's USD ladder (customer prices of price tiers), which every territory follows at its rate. */
const LADDER = [0.29, 0.49, 0.99, 1.49, 1.99, 2.49, 2.99, 3.49, 3.99, 4.49, 4.99, 5.99, 6.99, 7.99, 8.99, 9.99, 10.99, 11.99, 12.99, 14.99, 19.99, 24.99, 29.99, 34.99, 39.99, 44.99, 49.99, 54.99, 59.99, 69.99, 79.99, 89.99, 99.99, 119.99, 149.99, 199.99, 249.99, 299.99, 499.99, 999.99];
const ZERO_DECIMAL = new Set(["JPY", "KRW"]);

/** The customer price of a tier in a territory: .99 endings, whole numbers in zero-decimal currencies. */
export function tierPrice(tier: number, currency: string, rate: number): string {
  const usd = LADDER[tier] ?? LADDER[LADDER.length - 1]!;
  const v = usd * rate;
  if (ZERO_DECIMAL.has(currency)) return String(Math.max(10, Math.round(v / 10) * 10));
  if (rate === 1) return usd.toFixed(2);
  return (Math.max(0, Math.floor(v)) + 0.99).toFixed(2);
}

export interface Injected { match: (method: string, path: string, body: any) => boolean; status: number; body: unknown; times: number }

// ---- App Store Connect ------------------------------------------------------------------------------------------------

interface AscSub { id: string; groupId: string; productId: string; name: string; subscriptionPeriod: string; state: string; groupLevel: number }
interface AscIap { id: string; appId: string; productId: string; name: string; inAppPurchaseType: string; state: string }
interface AscSubPrice { id: string; subscriptionId: string; territory: string; tier: number; startDate: string | null; preserved: boolean }

export class FakeAppStoreConnect {
  readonly host = "https://api.appstoreconnect.apple.com";
  /** Key ids whose tokens are accepted; others answer 401. Key ids in `forbidden` answer 403. */
  keyIds = new Set<string>();
  forbidden = new Set<string>();
  apps: { id: string; bundleId: string; name: string }[] = [];
  groups: { id: string; appId: string; referenceName: string }[] = [];
  subs: AscSub[] = [];
  iaps: AscIap[] = [];
  subPrices: AscSubPrice[] = [];
  /** In-app purchase price schedules: base territory and manual prices (tier per territory). */
  schedules = new Map<string, { baseTerritory: string; manual: Map<string, number> }>();
  /** Page sizes, to exercise `links.next` paging. */
  pageSize = { prices: 200, iaps: 200, subscriptions: 200, pricePoints: 8000 };
  calls: { method: string; path: string; body?: unknown }[] = [];
  private injected: Injected[] = [];
  private seq = 7_000_000_000;
  /** The fake's clock (tests share theirs): token expiry and the start date of new prices. */
  now: () => Date = () => new Date();
  today = () => this.now().toISOString().slice(0, 10);

  fail(match: Injected["match"], status: number, title: string, detail = "", times = Infinity, code = status === 409 ? "ENTITY_ERROR" : "ERROR") {
    this.injected.push({ match, status, body: { errors: [{ status: String(status), code, title, detail }] }, times });
  }
  clearFailures() { this.injected = []; }

  private nextId() { return String(++this.seq); }
  private territory(id: string) { return FAKE_TERRITORIES.find((t) => t.asc === id); }
  pricePointId(productRef: string, territory: string, tier: number) { return b64({ s: productRef, t: territory, p: String(10000 + tier) }); }
  private decodePoint(id: string) { const o = unb64(id); return { s: String(o.s ?? ""), t: String(o.t ?? ""), tier: Number(o.p) - 10000 }; }
  /** The tier whose USA price is this (seeding helper). */
  tierOf(usd: number) { const i = LADDER.findIndex((x) => Math.abs(x - usd) < 0.001); if (i < 0) throw new Error(`no tier at ${usd}`); return i; }
  customerPrice(territory: string, tier: number) { const t = this.territory(territory)!; return tierPrice(tier, t.currency, t.rate); }

  addApp(bundleId: string, name = "App") { const id = this.nextId(); this.apps.push({ id, bundleId, name }); return id; }
  addSubscription(appId: string, group: string, productId: string, name: string, period: string, state = "APPROVED", usd?: number, territories = FAKE_TERRITORIES.map((t) => t.asc)) {
    let g = this.groups.find((x) => x.appId === appId && x.referenceName === group);
    if (!g) { g = { id: this.nextId(), appId, referenceName: group }; this.groups.push(g); }
    const id = this.nextId();
    this.subs.push({ id, groupId: g.id, productId, name, subscriptionPeriod: period, state, groupLevel: this.subs.filter((s) => s.groupId === g!.id).length + 1 });
    if (usd !== undefined) for (const t of territories) this.subPrices.push({ id: this.nextId(), subscriptionId: id, territory: t, tier: this.tierOf(usd), startDate: null, preserved: false });
    return id;
  }
  addIap(appId: string, productId: string, name: string, type: string, state = "APPROVED", usd?: number, base = "USA") {
    const id = this.nextId();
    this.iaps.push({ id, appId, productId, name, inAppPurchaseType: type, state });
    if (usd !== undefined) this.schedules.set(id, { baseTerritory: base, manual: new Map([[base, this.tierOf(usd)]]) });
    return id;
  }
  /** The current price of a subscription in a territory (the latest started price), as its customer price. */
  currentSubPrice(subId: string, territory: string) {
    const today = this.today();
    const list = this.subPrices.filter((p) => p.subscriptionId === subId && p.territory === territory && (!p.startDate || p.startDate <= today)).sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
    const p = list[list.length - 1];
    return p ? this.customerPrice(territory, p.tier) : null;
  }
  /** An in-app purchase's price in a territory: its manual price, else the base price's tier (equalised). */
  currentIapPrice(iapId: string, territory: string) {
    const s = this.schedules.get(iapId);
    if (!s) return null;
    const tier = s.manual.get(territory) ?? s.manual.get(s.baseTerritory);
    return tier === undefined ? null : this.customerPrice(territory, tier);
  }

  private page(url: URL, all: unknown[], size: number, extra: (items: any[]) => Record<string, unknown> = () => ({})) {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? size) || size, size);
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    const items = all.slice(cursor, cursor + limit);
    const q = new URLSearchParams(url.search); q.set("cursor", String(cursor + limit));
    const next = cursor + limit < all.length ? `${this.host}${url.pathname}?${q}` : undefined;
    return json(200, { data: items, ...extra(items), links: { self: url.href, ...(next ? { next } : {}) }, meta: { paging: { total: all.length, limit } } });
  }
  private territoryResource(id: string) { return { type: "territories", id, attributes: { currency: this.territory(id)?.currency } }; }
  private error(status: number, title: string, detail = "", code = "ENTITY_ERROR") { return json(status, { errors: [{ status: String(status), code, title, detail }] }); }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== this.host) throw new Error(`FakeAppStoreConnect does not serve ${url.href}`);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    this.calls.push({ method, path: path + url.search, ...(body !== undefined ? { body } : {}) });
    const token = (new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    const kid = String(jwtPart(token, 0).kid ?? "");
    const claims = jwtPart(token, 1);
    if (this.forbidden.has(kid)) return this.error(403, "This request is forbidden for security reasons", "The API key in use does not allow this request", "FORBIDDEN_ERROR");
    if (!this.keyIds.has(kid) || claims.aud !== "appstoreconnect-v1" || Number(claims.exp) * 1000 < this.now().getTime()) return this.error(401, "Authentication credentials are missing or invalid.", "Provide a properly configured and signed bearer token, and make sure that it has not expired.", "NOT_AUTHORIZED");
    const inj = this.injected.find((x) => x.times > 0 && x.match(method, path + url.search, body));
    if (inj) { inj.times--; return json(inj.status, inj.body); }
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/v1/apps") return json(200, { data: this.apps.filter((a) => a.bundleId === url.searchParams.get("filter[bundleId]")).map((a) => ({ type: "apps", id: a.id, attributes: { bundleId: a.bundleId, name: a.name } })) });
    if (method === "GET" && path === "/v1/territories") return this.page(url, FAKE_TERRITORIES.map((t) => this.territoryResource(t.asc)), 200);
    if ((m = /^\/v1\/apps\/(\d+)\/subscriptionGroups$/.exec(path)) && method === "GET") {
      const ref = url.searchParams.get("filter[referenceName]");
      return this.page(url, this.groups.filter((g) => g.appId === m![1] && (!ref || g.referenceName === ref)).map((g) => ({ type: "subscriptionGroups", id: g.id, attributes: { referenceName: g.referenceName } })), 200);
    }
    if (method === "POST" && path === "/v1/subscriptionGroups") {
      const g = { id: this.nextId(), appId: body.data.relationships.app.data.id, referenceName: body.data.attributes.referenceName };
      this.groups.push(g);
      return json(201, { data: { type: "subscriptionGroups", id: g.id, attributes: { referenceName: g.referenceName } } });
    }
    if ((m = /^\/v1\/subscriptionGroups\/(\d+)\/subscriptions$/.exec(path)) && method === "GET") {
      return this.page(url, this.subs.filter((s) => s.groupId === m![1]).map((s) => ({ type: "subscriptions", id: s.id, attributes: { name: s.name, productId: s.productId, subscriptionPeriod: s.subscriptionPeriod, state: s.state, groupLevel: s.groupLevel } })), this.pageSize.subscriptions);
    }
    if (method === "POST" && path === "/v1/subscriptions") {
      const a = body.data.attributes;
      if (this.subs.some((s) => s.productId === a.productId) || this.iaps.some((i) => i.productId === a.productId)) return this.error(409, "The provided entity includes an attribute with a value that has already been used", "The product ID you entered has already been used.", "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE");
      const s: AscSub = { id: this.nextId(), groupId: body.data.relationships.group.data.id, productId: a.productId, name: a.name, subscriptionPeriod: a.subscriptionPeriod, state: "MISSING_METADATA", groupLevel: 1 };
      this.subs.push(s);
      return json(201, { data: { type: "subscriptions", id: s.id, attributes: { name: s.name, productId: s.productId, subscriptionPeriod: s.subscriptionPeriod, state: s.state } } });
    }
    if ((m = /^\/v1\/apps\/(\d+)\/inAppPurchasesV2$/.exec(path)) && method === "GET") {
      return this.page(url, this.iaps.filter((i) => i.appId === m![1]).map((i) => ({ type: "inAppPurchases", id: i.id, attributes: { name: i.name, productId: i.productId, inAppPurchaseType: i.inAppPurchaseType, state: i.state } })), this.pageSize.iaps);
    }
    if (method === "POST" && path === "/v2/inAppPurchases") {
      const a = body.data.attributes;
      if (this.subs.some((s) => s.productId === a.productId) || this.iaps.some((i) => i.productId === a.productId)) return this.error(409, "The provided entity includes an attribute with a value that has already been used", "The product ID you entered has already been used.", "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE");
      const i: AscIap = { id: this.nextId(), appId: body.data.relationships.app.data.id, productId: a.productId, name: a.name, inAppPurchaseType: a.inAppPurchaseType, state: "MISSING_METADATA" };
      this.iaps.push(i);
      return json(201, { data: { type: "inAppPurchases", id: i.id, attributes: { name: i.name, productId: i.productId, inAppPurchaseType: i.inAppPurchaseType, state: i.state } } });
    }
    if ((m = /^\/v1\/subscriptions\/(\d+)\/prices$/.exec(path)) && method === "GET") {
      if (!this.subs.some((s) => s.id === m![1])) return this.error(404, "The specified resource does not exist", "", "NOT_FOUND");
      const list = this.subPrices.filter((p) => p.subscriptionId === m![1]);
      return this.page(url, list.map((p) => ({
        type: "subscriptionPrices", id: p.id, attributes: { startDate: p.startDate, preserved: p.preserved },
        relationships: { territory: { data: { type: "territories", id: p.territory } }, subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: this.pricePointId(p.subscriptionId, p.territory, p.tier) } } },
      })), this.pageSize.prices, (items) => ({
        included: [
          ...[...new Set(items.map((i: any) => i.relationships.territory.data.id))].map((t) => this.territoryResource(t as string)),
          ...items.map((i: any) => { const d = this.decodePoint(i.relationships.subscriptionPricePoint.data.id); return { type: "subscriptionPricePoints", id: i.relationships.subscriptionPricePoint.data.id, attributes: { customerPrice: this.customerPrice(d.t, d.tier), proceeds: "0" } }; }),
        ],
      }));
    }
    if ((m = /^\/v1\/subscriptions\/(\d+)\/pricePoints$/.exec(path)) && method === "GET") {
      const t = url.searchParams.get("filter[territory]");
      if (!t) return this.error(400, "A parameter is required", "filter[territory] is required", "PARAMETER_ERROR.REQUIRED");
      if (!this.territory(t)) return this.error(400, "A parameter has an invalid value", `'${t}' is not a valid filter value`, "PARAMETER_ERROR.INVALID");
      return this.page(url, LADDER.map((_, tier) => ({ type: "subscriptionPricePoints", id: this.pricePointId(m![1]!, t, tier), attributes: { customerPrice: this.customerPrice(t, tier), proceeds: "0" } })), this.pageSize.pricePoints);
    }
    if (method === "POST" && path === "/v1/subscriptionPrices") {
      const r = body.data.relationships;
      const subId = r.subscription.data.id, territory = r.territory.data.id;
      const sub = this.subs.find((s) => s.id === subId);
      if (!sub) return this.error(404, "The specified resource does not exist", "", "NOT_FOUND");
      const d = this.decodePoint(r.subscriptionPricePoint.data.id);
      if (d.s !== subId || d.t !== territory || !(d.tier >= 0 && d.tier < LADDER.length)) return this.error(409, "The provided entity includes a relationship with an invalid value", "The price point is not valid for this subscription and territory.", "ENTITY_ERROR.RELATIONSHIP.INVALID");
      if (sub.state === "REMOVED_FROM_SALE" || sub.state === "DEVELOPER_REMOVED_FROM_SALE") return this.error(409, "The request cannot be fulfilled because of the state of another resource.", "Prices cannot change while the subscription is removed from sale.", "STATE_ERROR");
      const p: AscSubPrice = { id: this.nextId(), subscriptionId: subId, territory, tier: d.tier, startDate: body.data.attributes?.startDate ?? this.today(), preserved: !!body.data.attributes?.preserveCurrentPrice };
      this.subPrices.push(p);
      return json(201, { data: { type: "subscriptionPrices", id: p.id, attributes: { startDate: p.startDate, preserved: p.preserved } } });
    }
    if ((m = /^\/v2\/inAppPurchases\/(\d+)\/iapPriceSchedule$/.exec(path)) && method === "GET") {
      if (!this.iaps.some((i) => i.id === m![1])) return this.error(404, "The specified resource does not exist", "", "NOT_FOUND");
      if (!this.schedules.has(m[1]!)) return this.error(404, "The specified resource does not exist", "There is no price schedule for this in-app purchase.", "NOT_FOUND");
      return json(200, { data: { type: "inAppPurchasePriceSchedules", id: m[1], relationships: { baseTerritory: {}, manualPrices: {}, automaticPrices: {} } } });
    }
    if ((m = /^\/v1\/inAppPurchasePriceSchedules\/(\d+)\/baseTerritory$/.exec(path)) && method === "GET") {
      const s = this.schedules.get(m[1]!);
      return s ? json(200, { data: this.territoryResource(s.baseTerritory) }) : this.error(404, "The specified resource does not exist", "", "NOT_FOUND");
    }
    if ((m = /^\/v1\/inAppPurchasePriceSchedules\/(\d+)\/(manualPrices|automaticPrices)$/.exec(path)) && method === "GET") {
      const s = this.schedules.get(m[1]!);
      if (!s) return this.error(404, "The specified resource does not exist", "", "NOT_FOUND");
      const base = s.manual.get(s.baseTerritory)!;
      const entries = m[2] === "manualPrices" ? [...s.manual] : FAKE_TERRITORIES.filter((t) => !s.manual.has(t.asc)).map((t) => [t.asc, base] as [string, number]);
      const items = entries.map(([t, tier]) => ({
        type: "inAppPurchasePrices", id: b64({ i: m![1], t, p: tier, m: m![2] }), attributes: { startDate: null, endDate: null, manual: m![2] === "manualPrices" },
        relationships: { inAppPurchasePricePoint: { data: { type: "inAppPurchasePricePoints", id: this.pricePointId(m![1]!, t, tier) } }, territory: { data: { type: "territories", id: t } } },
      }));
      return this.page(url, items, this.pageSize.prices, (page) => ({
        included: [
          ...page.map((i: any) => this.territoryResource(i.relationships.territory.data.id)),
          ...page.map((i: any) => { const d = this.decodePoint(i.relationships.inAppPurchasePricePoint.data.id); return { type: "inAppPurchasePricePoints", id: i.relationships.inAppPurchasePricePoint.data.id, attributes: { customerPrice: this.customerPrice(d.t, d.tier), proceeds: "0" } }; }),
        ],
      }));
    }
    if ((m = /^\/v2\/inAppPurchases\/(\d+)\/pricePoints$/.exec(path)) && method === "GET") {
      const t = url.searchParams.get("filter[territory]");
      if (!t || !this.territory(t)) return this.error(400, "A parameter has an invalid value", `'${t}' is not a valid filter value`, "PARAMETER_ERROR.INVALID");
      return this.page(url, LADDER.map((_, tier) => ({ type: "inAppPurchasePricePoints", id: this.pricePointId(m![1]!, t, tier), attributes: { customerPrice: this.customerPrice(t, tier), proceeds: "0" } })), this.pageSize.pricePoints);
    }
    if (method === "POST" && path === "/v1/inAppPurchasePriceSchedules") {
      const r = body.data.relationships;
      const iapId = r.inAppPurchase.data.id, base = r.baseTerritory.data.id;
      if (!this.iaps.some((i) => i.id === iapId)) return this.error(404, "The specified resource does not exist", "", "NOT_FOUND");
      const refs = new Set((r.manualPrices.data as { id: string }[]).map((x) => x.id));
      const manual = new Map<string, number>();
      for (const inc of (body.included ?? []) as any[]) {
        if (inc.type !== "inAppPurchasePrices" || !refs.has(inc.id)) continue;
        const d = this.decodePoint(inc.relationships.inAppPurchasePricePoint.data.id);
        if (d.s !== iapId || !this.territory(d.t)) return this.error(409, "The provided entity includes a relationship with an invalid value", "A price point is not valid for this in-app purchase.", "ENTITY_ERROR.RELATIONSHIP.INVALID");
        if (manual.has(d.t)) return this.error(409, "The provided entity includes a relationship with an invalid value", `Two manual prices for ${d.t}.`, "ENTITY_ERROR.RELATIONSHIP.INVALID");
        manual.set(d.t, d.tier);
      }
      if (!manual.has(base)) return this.error(409, "The provided entity is missing a required relationship", "The base territory needs a manual price.", "ENTITY_ERROR.RELATIONSHIP.REQUIRED");
      this.schedules.set(iapId, { baseTerritory: base, manual });
      return json(201, { data: { type: "inAppPurchasePriceSchedules", id: iapId } });
    }
    return this.error(404, "The specified resource does not exist", `The path ${path} could not be found.`, "NOT_FOUND");
  };
}

// ---- Google Play -------------------------------------------------------------------------------------------------------

interface Money { currencyCode?: string; units?: string; nanos?: number }
const micros = (m?: Money) => (m ? Number(m.units ?? 0) * 1_000_000 + Math.round((m.nanos ?? 0) / 1000) : NaN);
export const money = (amount: number, currencyCode: string): Money => {
  const units = Math.floor(amount + 1e-9);
  const nanos = Math.round((amount - units) * 1e9);
  return { currencyCode, units: String(units), ...(nanos ? { nanos } : {}) };
};

export class FakePlayConsole {
  readonly api: string;
  /** Service account emails the token endpoint accepts; ones in `denied` get a token Play answers 403 for. */
  emails = new Set<string>();
  denied = new Set<string>();
  subscriptions: Record<string, any>[] = [];
  oneTimeProducts: Record<string, any>[] = [];
  defaultLanguage = "en-US";
  pageSize = 100;
  calls: { method: string; path: string; body?: any }[] = [];
  private tokens = new Map<string, string>();
  private injected: Injected[] = [];
  private edits = 0;

  constructor(public packageName: string) { this.api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}`; }

  fail(match: Injected["match"], status: number, message: string, times = Infinity, reason = status === 400 ? "badRequest" : status === 403 ? "permissionDenied" : "backendError") {
    this.injected.push({ match, status, body: { error: { code: status, message, status: status === 400 ? "INVALID_ARGUMENT" : status === 403 ? "PERMISSION_DENIED" : "UNAVAILABLE", errors: [{ reason, message }] } }, times });
  }
  clearFailures() { this.injected = []; }

  /** A subscription with one auto-renewing base plan priced in every region from a USD price (Play's conversion, rounded to .99). */
  addSubscription(productId: string, title: string, basePlans: { id: string; period: string; usd: number; state?: string; regions?: string[] }[]) {
    this.subscriptions.push({
      packageName: this.packageName, productId, listings: [{ languageCode: "en-US", title }],
      basePlans: basePlans.map((b) => ({
        basePlanId: b.id, state: b.state ?? "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: b.period, gracePeriodDuration: "P7D", legacyCompatible: true },
        regionalConfigs: FAKE_TERRITORIES.filter((t) => !b.regions || b.regions.includes(t.play)).map((t) => ({ regionCode: t.play, newSubscriberAvailability: true, price: this.converted(b.usd, t) })),
        otherRegionsConfig: { usdPrice: money(b.usd, "USD"), eurPrice: money(b.usd * 0.93, "EUR"), newSubscriberAvailability: true },
      })),
      taxAndComplianceSettings: { eeaWithdrawalRightType: "WITHDRAWAL_RIGHT_SERVICE" },
    });
  }
  addOneTime(productId: string, title: string, usd: number) {
    this.oneTimeProducts.push({
      packageName: this.packageName, productId, listings: [{ languageCode: "en-US", title }],
      purchaseOptions: [{ purchaseOptionId: "buy", state: "ACTIVE", buyOption: { legacyCompatible: true }, regionalPricingAndAvailabilityConfigs: FAKE_TERRITORIES.map((t) => ({ regionCode: t.play, price: this.converted(usd, t), availability: "AVAILABLE" })) }],
    });
  }
  private converted(usd: number, t: { currency: string; rate: number }): Money {
    if (t.rate === 1) return money(usd, t.currency);
    if (ZERO_DECIMAL.has(t.currency)) return { currencyCode: t.currency, units: String(Math.max(10, Math.round((usd * t.rate) / 10) * 10)) };
    return money(Math.floor(usd * t.rate) + 0.99, t.currency);
  }
  /** A base plan's price in a region, in micros, or null. */
  price(productId: string, basePlanId: string, region: string): number | null {
    const c = this.subscriptions.find((s) => s.productId === productId)?.basePlans?.find((b: any) => b.basePlanId === basePlanId)?.regionalConfigs?.find((r: any) => r.regionCode === region);
    return c ? micros(c.price) : null;
  }
  private err(status: number, message: string, reason = "badRequest") {
    return json(status, { error: { code: status, message, status: status === 400 ? "INVALID_ARGUMENT" : status === 404 ? "NOT_FOUND" : status === 409 ? "ALREADY_EXISTS" : "FAILED_PRECONDITION", errors: [{ reason, message }] } });
  }
  /** Play's price rules: the region's own currency, and a price inside the range Play allows (USD 0.49 to 999.99 at the region's rate). */
  private checkPlans(plans: any[]): string | null {
    for (const b of plans) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(b.basePlanId ?? ""))) return `Base plan ID ${b.basePlanId} is invalid.`;
      for (const r of b.regionalConfigs ?? []) {
        const t = FAKE_TERRITORIES.find((x) => x.play === r.regionCode);
        if (!t) return `Region code ${r.regionCode} is not supported in regions version 2022/02.`;
        if (r.price?.currencyCode !== t.currency) return `Price currency ${r.price?.currencyCode} does not match the currency ${t.currency} of region ${r.regionCode}.`;
        const v = micros(r.price) / 1_000_000;
        if (!(v >= 0.49 * t.rate && v <= 999.99 * t.rate)) return `Price for region ${r.regionCode} is out of the allowed range (${(0.49 * t.rate).toFixed(2)} to ${(999.99 * t.rate).toFixed(2)} ${t.currency}).`;
      }
    }
    return null;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    if (href === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(typeof init.body === "string" ? init.body : "").get("assertion") ?? "";
      const iss = String(jwtPart(assertion, 1).iss ?? "");
      if (!this.emails.has(iss) && !this.denied.has(iss)) return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      const token = `ya29.fake-${b64(iss).slice(0, 16)}-${this.tokens.size}`;
      this.tokens.set(token, iss);
      return json(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
    }
    if (!href.startsWith(this.api)) throw new Error(`FakePlayConsole does not serve ${href}`);
    const url = new URL(href);
    const path = url.pathname.slice(new URL(this.api).pathname.length);
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: path + url.search, ...(body !== undefined ? { body } : {}) });
    const who = this.tokens.get((new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer /, ""));
    if (!who) return this.err(401, "Request had invalid authentication credentials.", "authError");
    if (this.denied.has(who)) return this.err(403, "The caller does not have permission", "permissionDenied");
    const inj = this.injected.find((x) => x.times > 0 && x.match(method, path + url.search, body));
    if (inj) { inj.times--; return json(inj.status, inj.body); }
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/subscriptions") {
      const start = Number(url.searchParams.get("pageToken")?.replace("page-", "") ?? 0) || 0;
      const size = Math.min(Number(url.searchParams.get("pageSize") ?? this.pageSize), this.pageSize);
      const items = this.subscriptions.slice(start, start + size);
      return json(200, { subscriptions: items, ...(start + size < this.subscriptions.length ? { nextPageToken: `page-${start + size}` } : {}) });
    }
    if ((m = /^\/subscriptions\/([^/:]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]!);
      const i = this.subscriptions.findIndex((s) => s.productId === id);
      if (method === "GET") return i < 0 ? this.err(404, `Subscription ${id} not found.`, "notFound") : json(200, this.subscriptions[i]);
      if (method === "PATCH") {
        if (!url.searchParams.get("regionsVersion.version")) return this.err(400, "Required parameter: regionsVersion.version");
        const mask = url.searchParams.get("updateMask");
        if (!mask) return this.err(400, "Required parameter: updateMask");
        if (i < 0) return this.err(404, `Subscription ${id} not found.`, "notFound");
        if (mask.split(",").some((f) => !["basePlans", "listings", "taxAndComplianceSettings", "restrictedPaymentCountries"].includes(f))) return this.err(400, `Invalid update mask path: ${mask}`);
        if (body?.productId !== id) return this.err(400, "productId in the body must match the path.");
        const problem = this.checkPlans(body.basePlans ?? []);
        if (problem) return this.err(400, problem);
        const prev = this.subscriptions[i]!;
        const next = { ...prev };
        if (mask.includes("basePlans")) {
          // Existing base plans keep their state; new ones start as drafts.
          next.basePlans = (body.basePlans as any[]).map((b) => ({ ...b, state: prev.basePlans.find((x: any) => x.basePlanId === b.basePlanId)?.state ?? "DRAFT" }));
        }
        if (mask.includes("listings")) next.listings = body.listings;
        this.subscriptions[i] = next;
        return json(200, next);
      }
    }
    if (method === "POST" && path === "/subscriptions") {
      const id = url.searchParams.get("productId");
      if (!url.searchParams.get("regionsVersion.version")) return this.err(400, "Required parameter: regionsVersion.version");
      if (!id || body?.productId !== id) return this.err(400, "productId is required and must match the body.");
      if (this.subscriptions.some((s) => s.productId === id)) return this.err(409, `Subscription ${id} already exists.`, "alreadyExists");
      if (!/^[a-z0-9][a-z0-9._]{0,39}$/.test(id)) return this.err(400, `Product ID ${id} is invalid.`);
      const problem = this.checkPlans(body.basePlans ?? []);
      if (problem) return this.err(400, problem);
      const sub = { ...body, packageName: this.packageName, basePlans: (body.basePlans ?? []).map((b: any) => ({ ...b, state: "DRAFT" })) };
      this.subscriptions.push(sub);
      return json(200, sub);
    }
    if ((m = /^\/subscriptions\/([^/]+)\/basePlans\/([^/:]+):activate$/.exec(path)) && method === "POST") {
      const sub = this.subscriptions.find((s) => s.productId === decodeURIComponent(m![1]!));
      const b = sub?.basePlans?.find((x: any) => x.basePlanId === decodeURIComponent(m![2]!));
      if (!b) return this.err(404, "Base plan not found.", "notFound");
      if (!(b.regionalConfigs ?? []).length) return this.err(400, "The base plan needs a price in at least one region before it can be activated.");
      if (b.state === "ACTIVE") return this.err(400, "Base plan is already ACTIVE.");
      b.state = "ACTIVE";
      return json(200, sub);
    }
    if (method === "GET" && path === "/oneTimeProducts") return json(200, { oneTimeProducts: this.oneTimeProducts });
    if (method === "POST" && path === "/edits") return json(200, { id: `edit-${++this.edits}`, expiryTimeSeconds: String(Math.floor(Date.now() / 1000) + 3600) });
    if ((m = /^\/edits\/([^/]+)\/details$/.exec(path)) && method === "GET") return json(200, { defaultLanguage: this.defaultLanguage, contactEmail: "dev@example.com" });
    if ((m = /^\/edits\/([^/]+)$/.exec(path)) && method === "DELETE") return new Response("", { status: 204 });
    if (method === "POST" && path === "/pricing:convertRegionPrices") {
      const usd = micros(body?.price) / 1_000_000;
      return json(200, {
        convertedRegionPrices: Object.fromEntries(FAKE_TERRITORIES.map((t) => [t.play, { regionCode: t.play, price: this.converted(usd, t), taxAmount: money(0, t.currency) }])),
        convertedOtherRegionsPrice: { usdPrice: money(usd, "USD"), eurPrice: money(usd * 0.93, "EUR") }, regionVersion: { version: "2022/02" },
      });
    }
    if (method === "GET" && path.startsWith("/purchases/voidedpurchases")) return json(200, {});
    return this.err(404, `Not found: ${method} ${path}`, "notFound");
  };
}
