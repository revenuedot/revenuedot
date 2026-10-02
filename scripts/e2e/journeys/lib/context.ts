// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: what a journey gets: the running stack plus clients that act like a real developer (dashboard session from
// the real /auth/signup), a real app (SDK wire calls with the app's public key) and a backend (secret key on v2), and
// direct SQL reads of the journey database.
import type { Checks } from "./check.ts";
import type { Capture, Mail, RdServer } from "./stack.ts";

export type Sql = import("postgres").Sql;
export interface Res<T = any> { status: number; body: T; headers: Headers }

export interface Ctx {
  name: string;
  c: Checks;
  server: RdServer;
  base: string;
  capture: Capture;
  mails: Mail[];
  sql: Sql;
  /** The journey database (never printed): for in-process code that runs on the same rows (the Cloud-only jobs). */
  databaseUrl: string;
  /** A folder for this journey's screenshots and logs. */
  out: string;
  stamp: string;
}

async function send(base: string, method: string, path: string, json: unknown, headers: Record<string, string>): Promise<Res> {
  const res = await fetch(base + path, {
    method, headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined, redirect: "manual",
  });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers };
}

export type Call = <T = any>(method: string, path: string, json?: unknown, headers?: Record<string, string>) => Promise<Res<T>>;

/** A developer signed in to the dashboard (session cookie), acting on their project with `P`-relative v2 paths. */
export interface Dev {
  email: string; password: string; cookie: string; projectId: string;
  /** Any request with the session cookie. */
  call: Call;
  /** v2 request on this project: `v2("GET", "/offerings")` → /v2/projects/<id>/offerings. Throws on a non-2xx answer. */
  v2: <T = any>(method: string, path: string, json?: unknown) => Promise<T>;
  /** v2 request that returns status and body without throwing. */
  v2r: <T = any>(method: string, path: string, json?: unknown) => Promise<Res<T>>;
}

export async function signUp(ctx: Ctx, who: string, projectName = "Journey app"): Promise<Dev> {
  const email = `${who}-${ctx.stamp}@journeys.test`.toLowerCase();
  const password = `journey-${ctx.stamp}-pw`;
  const r = await fetch(`${ctx.base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, name: who, project_name: projectName }) });
  if (r.status !== 201) throw new Error(`sign-up ${email}: ${r.status} ${await r.text()}`);
  const cookie = `rd_session=${/rd_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1]}`;
  const call: Call = (method, path, json, headers = {}) => send(ctx.base, method, path, json, { cookie, ...headers });
  const me = await call("GET", "/auth/me");
  const projectId = me.body.projects[0].id as string;
  const P = `/v2/projects/${projectId}`;
  const v2r = (method: string, path: string, json?: unknown) => call(method, P + path, json);
  const v2 = async (method: string, path: string, json?: unknown) => {
    const res = await v2r(method, path, json);
    if (res.status >= 300) throw new Error(`${method} ${P}${path} → ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
    return res.body;
  };
  return { email, password, cookie, projectId, call, v2: v2 as Dev["v2"], v2r: v2r as Dev["v2r"] };
}

/** A backend with a secret key (`Authorization: Bearer sk_…`). */
export function secretClient(ctx: Ctx, key: string, projectId: string) {
  const P = `/v2/projects/${projectId}`;
  return {
    r: (method: string, path: string, json?: unknown) => send(ctx.base, method, P + path, json, { authorization: `Bearer ${key}` }),
    raw: (method: string, path: string, json?: unknown) => send(ctx.base, method, path, json, { authorization: `Bearer ${key}` }),
  };
}

/** The SDK's wire calls with the app's public key, the headers the iOS SDK sends. */
export function sdkClient(ctx: Ctx, apiKey: string, platform = "iOS") {
  const headers = { authorization: `Bearer ${apiKey}`, "x-platform": platform, "x-platform-flavor": "native", "x-version": "5.92.0", "x-client-version": "1.0", "x-storefront": "USA", "x-is-sandbox": "true" };
  const call: Call = (method, path, json, extra = {}) => send(ctx.base, method, path, json, { ...headers, ...extra });
  return {
    call,
    customerInfo: (id: string) => call("GET", `/v1/subscribers/${encodeURIComponent(id)}`),
    offerings: (id: string) => call("GET", `/v1/subscribers/${encodeURIComponent(id)}/offerings`),
    /** A Test Store purchase the way the SDK posts it after the user confirms. */
    purchase: (id: string, productId: string, extra: Record<string, unknown> = {}) => call("POST", "/v1/receipts", {
      app_user_id: id, fetch_token: `test_${Date.now()}_${crypto.randomUUID()}`, product_id: productId, price: 9.99, currency: "USD", is_restore: false, ...extra,
    }),
    logIn: (current: string, next: string) => call("POST", "/v1/subscribers/identify", { app_user_id: current, new_app_user_id: next }),
    alias: (id: string, alias: string) => call("POST", `/v1/subscribers/${encodeURIComponent(id)}/alias`, { new_app_user_id: alias }),
    attributes: (id: string, attrs: Record<string, string | null>) => call("POST", `/v1/subscribers/${encodeURIComponent(id)}/attributes`, {
      attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v, updated_at_ms: Date.now() }])),
    }),
  };
}

export const anonId = () => `$RCAnonymousID:${crypto.randomUUID().replace(/-/g, "")}`;

/** A Test Store catalog made through v2 the way the dashboard makes it: pro (monthly, annual, lifetime), coins. */
export async function standardCatalog(dev: Dev) {
  const apps = await dev.v2("GET", "/apps?limit=100");
  const app = apps.items.find((a: any) => a.type === "test_store") ?? await dev.v2("POST", "/apps", { name: "Test Store", type: "test_store" });
  const keys = await dev.v2("GET", `/apps/${app.id}/public_api_keys`);
  const product = (store_identifier: string, type: string, price: number, duration?: string) =>
    dev.v2("POST", "/products", { store_identifier, app_id: app.id, type, display_name: store_identifier, ...(duration ? { subscription: { duration } } : {}), test_store_price: { amount_micros: Math.round(price * 1e6), currency: "USD" } });
  const monthly = await product("pro_monthly", "subscription", 9.99, "P1M");
  const annual = await product("pro_annual", "subscription", 59.99, "P1Y");
  const lifetime = await product("lifetime", "non_consumable", 149.99);
  const coins = await product("coins_100", "consumable", 1.99);
  const pro = await dev.v2("POST", "/entitlements", { lookup_key: "pro", display_name: "Pro access" });
  await dev.v2("POST", `/entitlements/${pro.id}/actions/attach_products`, { product_ids: [monthly.id, annual.id, lifetime.id] });
  const def = await dev.v2("POST", "/offerings", { lookup_key: "default", display_name: "Standard" });
  await dev.v2("POST", `/offerings/${def.id}`, { is_current: true });
  const pkgs: Record<string, any> = {};
  for (const [i, [lk, prod]] of ([["$rc_monthly", monthly], ["$rc_annual", annual], ["$rc_lifetime", lifetime]] as const).entries()) {
    const pkg = await dev.v2("POST", `/offerings/${def.id}/packages`, { lookup_key: lk, display_name: lk, position: i });
    await dev.v2("POST", `/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: prod.id, eligibility_criteria: "all" }] });
    pkgs[lk] = pkg;
  }
  return { app, testKey: keys.items[0].key as string, products: { monthly, annual, lifetime, coins }, pro, offering: def, packages: pkgs };
}

/** Webhook events the server recorded for a project (events table), oldest first. */
export async function eventsOf(ctx: Ctx, projectId: string, filter: { type?: string; appUserId?: string } = {}) {
  const rows = await ctx.sql<{ type: string; payload: any }[]>`SELECT type, payload FROM events WHERE project_id = ${projectId} ORDER BY event_timestamp_ms, created_at`;
  return rows.map((r) => r.payload.event as Record<string, any>).filter((e) => (!filter.type || e.type === filter.type) && (!filter.appUserId || e.app_user_id === filter.appUserId || (e.aliases ?? []).includes(filter.appUserId)));
}
