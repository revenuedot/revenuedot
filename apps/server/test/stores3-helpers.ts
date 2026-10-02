/**
 * Test helpers for the Paddle, Roku and Galaxy Store adapters: the contract harness plus one app of the store with its
 * credentials sealed like the API seals them, a catalog, and the stateful store fakes from packages/contract/src
 * (fake-paddle.ts, fake-roku.ts, fake-galaxy.ts). No store is ever called.
 */
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { FAKE_PADDLE_KEY, FakePaddleAccount } from "../../../packages/contract/src/fake-paddle.js";
import { FAKE_ROKU_KEY, FakeRoku } from "../../../packages/contract/src/fake-roku.js";
import { FAKE_GALAXY_ACCOUNT, FakeGalaxy } from "../../../packages/contract/src/fake-galaxy.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { createPaddleStore } from "../src/stores/paddle/index.js";
import { createRokuStore } from "../src/stores/roku/index.js";
import { createGalaxyStore } from "../src/stores/galaxy/index.js";
import { clearRokuKeyCache } from "../src/stores/roku/push.js";
import { sealedColumns, setAppCredentials, TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";

export const DAY = 86_400_000;
export const T0 = new Date("2026-09-01T12:00:00Z");
export const at = (days: number) => new Date(T0.getTime() + days * DAY);

export type StoreType = "paddle" | "roku" | "galaxy";
const KEYS: Record<StoreType, string> = { paddle: "pdl_testkey123", roku: "roku_testkey123", galaxy: "galx_testkey123" };

/** Catalog per store: `pro` is unlocked by the two subscriptions and the lifetime product; coins are consumable. */
export const PADDLE_PRICES = { monthly: "pri_01monthly000000000000000", annual: "pri_01annual0000000000000000", coins: "pri_01coins00000000000000000", lifetime: "pri_01lifetime00000000000000" };
const CATALOG: Record<StoreType, Array<{ id: string; storeIdentifier: string; type: string; duration?: string | null; pro?: boolean }>> = {
  paddle: [
    { id: "pd_m", storeIdentifier: PADDLE_PRICES.monthly, type: "subscription", duration: "P1M", pro: true },
    { id: "pd_y", storeIdentifier: PADDLE_PRICES.annual, type: "subscription", duration: "P1Y", pro: true },
    { id: "pd_c", storeIdentifier: PADDLE_PRICES.coins, type: "consumable" },
    { id: "pd_l", storeIdentifier: PADDLE_PRICES.lifetime, type: "non_consumable", pro: true },
  ],
  roku: [
    { id: "rk_m", storeIdentifier: "scanner_monthly", type: "subscription", duration: "P1M", pro: true },
    { id: "rk_y", storeIdentifier: "scanner_yearly", type: "subscription", duration: "P1Y", pro: true },
    { id: "rk_l", storeIdentifier: "scanner_lifetime", type: "non_consumable", pro: true },
  ],
  galaxy: [
    { id: "gx_m", storeIdentifier: "premium_monthly", type: "subscription", duration: "P1M", pro: true },
    { id: "gx_y", storeIdentifier: "premium_yearly", type: "subscription", duration: "P1Y", pro: true },
    { id: "gx_c", storeIdentifier: "coins_100", type: "consumable" },
    { id: "gx_l", storeIdentifier: "lifetime", type: "non_consumable", pro: true },
  ],
};

export interface Env {
  h: Harness; type: StoreType; appId: string; key: string;
  paddle: FakePaddleAccount; roku: FakeRoku; galaxy: FakeGalaxy;
  /** Every outbound call that was not a store's (forwards). */
  forwarded: Array<{ url: string; body: string; headers: Headers }>;
  call: (path: string, init?: RequestInit & { json?: unknown; key?: string | null }) => Promise<Response>;
  /** POST /v1/receipts the way the store's SDK or backend does. */
  receipt: (body: Record<string, unknown>, headers?: Record<string, string>) => Promise<Response>;
  /** POST a raw notification body to the app's notification URL. */
  notify: (body: string, headers?: Record<string, string>, appId?: string) => Promise<Response>;
  v2: (method: string, path: string, json?: unknown) => Promise<Response>;
  events: (type?: string) => Promise<Array<Record<string, any>>>;
  setCredentials: (all: Record<string, unknown>) => Promise<void>;
}

export async function env(type: StoreType, credentials?: Record<string, unknown>, o: { bundleId?: string | null } = {}): Promise<Env> {
  clearRokuKeyCache();
  const h = await harness();
  h.setNow(T0);
  const paddle = new FakePaddleAccount({ now: h.now });
  const roku = new FakeRoku({ now: h.now });
  const galaxy = new FakeGalaxy({ now: h.now });
  const keys = await galaxy.keys();
  const forwarded: Env["forwarded"] = [];
  const fetchAll = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    if (host === "api.paddle.com" || host === "sandbox-api.paddle.com") return paddle.fetch(url, init);
    if (host === "apipub.roku.com" || host === "assets.cs.roku.com") return roku.fetch(url, init);
    if (host === "iap.samsungapps.com" || host === "devapi.samsungapps.com") return galaxy.fetch(url, init);
    if (host === "hooks.example.com") { forwarded.push({ url, body: typeof init.body === "string" ? init.body : "", headers: new Headers(init.headers) }); return new Response(null, { status: 200 }); }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const stores = {
    ...defaultStores(),
    paddle: createPaddleStore({ fetch: fetchAll, now: h.now, timeoutMs: 500 }),
    roku: createRokuStore({ fetch: fetchAll, now: h.now, timeoutMs: 500 }),
    galaxy: createGalaxyStore({ fetch: fetchAll, now: h.now, timeoutMs: 500 }),
  };
  const app = createApp({ db: h.db, now: h.now, stores, fetch: fetchAll, encryptionKey: TEST_ENCRYPTION_KEY });
  const defaults: Record<StoreType, Record<string, unknown>> = {
    paddle: { paddle_api_key: FAKE_PADDLE_KEY, paddle_webhook_secret: paddle.secret },
    roku: { roku_api_key: FAKE_ROKU_KEY, roku_channel_id: roku.channelId, roku_channel_name: roku.channelName },
    galaxy: { galaxy_service_account_id: FAKE_GALAXY_ACCOUNT, galaxy_service_account_private_key: keys.serviceAccountPrivateKey, galaxy_iap_public_key: keys.iapPublicKey },
  };
  const appId = `app_${type}`, key = KEYS[type];
  await h.db.insert(schema.apps).values({
    id: appId, projectId: h.ids.project, name: `Scanner ${type}`, type, publicKey: key, bundleId: type === "galaxy" ? (o.bundleId === undefined ? galaxy.packageName : o.bundleId) : null,
    ...(await sealedColumns(type, credentials ?? defaults[type])),
  });
  const prods = CATALOG[type];
  await h.db.insert(schema.products).values(prods.map((p) => ({ id: p.id, storeIdentifier: p.storeIdentifier, type: p.type, duration: p.duration ?? null, projectId: h.ids.project, appId, displayName: p.storeIdentifier })));
  await h.db.insert(schema.entitlementProducts).values(prods.filter((p) => p.pro).map((p) => ({ entitlementId: "ent_pro", productId: p.id })));
  const call: Env["call"] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set("Authorization", `Bearer ${init.key}`);
    let body = init.body;
    if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
    return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { ...init, headers, body })));
  };
  const platform: Record<StoreType, Record<string, string>> = {
    paddle: { "X-Platform": "paddle" },
    // The Roku SDK's headers (source/Purchases.brs).
    roku: { "X-Platform": "roku", "X-Platform-Flavor": "native", "X-Version": "0.0.2", "X-Client-Bundle-ID": "dev" },
    // The Android SDK built with purchases-store-galaxy sends X-Platform: android; the galx_ key names the store.
    galaxy: { "X-Platform": "android", "X-Platform-Flavor": "native", "X-Version": "10.24.0" },
  };
  return {
    h, type, appId, key, paddle, roku, galaxy, forwarded, call,
    receipt: (body, headers = {}) => call("/v1/receipts", { method: "POST", key, headers: { ...platform[type], ...headers }, json: body }),
    notify: (body, headers = {}, id = appId) => call(`/v1/notifications/${type}/${id}`, { method: "POST", headers: { "content-type": type === "paddle" ? "application/json" : "text/plain", ...headers }, body }),
    v2: (method, path, json) => call(`/v2/projects/${h.ids.project}${path}`, { method, key: h.ids.secretKey, ...(json !== undefined ? { json } : {}) }),
    events: async (t) => {
      const rows = await h.db.select().from(schema.events);
      return rows.map((r) => (r.payload as { event: Record<string, any> }).event).filter((ev) => (!t || ev.type === t) && ev.type !== "SUBSCRIBER_ALIAS");
    },
    setCredentials: (all) => setAppCredentials(h.db, appId, type, all),
  };
}

/** Event types in order, for the lifecycle assertions. */
export async function eventTypes(e: Env) {
  return (await e.events()).map((x) => x.type);
}
