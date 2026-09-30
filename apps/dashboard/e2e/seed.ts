/**
 * Seeds a project with realistic data through the public API only: a Test Store app and catalog, ~40 customers with
 * Test Store purchases spread over the last 90 days (subscriptions, lifetime and consumables), attributes, a
 * promotional grant and an offering override. Used by `scripts/seed-demo.ts` (the dev server) and `e2e/server.ts`.
 *
 * The Test Store only makes sandbox purchases with one period each, so trials, renewals and refunds cannot be created
 * through the API; e2e/server.ts adds those with App Store–shaped purchases through the server's purchase pipeline.
 */
export interface SeedResult { projectId: string; testKey: string; appId: string; entitlementId: string; offeringId: string; customers: string[] }

const DAY = 86400_000;

export function client(base: string, cookie: string) {
  return async function call<T = any>(method: string, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(base + path, { method, headers: { cookie, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: json !== undefined ? JSON.stringify(json) : undefined });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return body as T;
  };
}

/** Signs up (or signs in, if the account exists) and returns the session cookie. */
export async function session(base: string, email: string, password: string, projectName: string): Promise<string> {
  let res = await fetch(`${base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "Demo owner", project_name: projectName }) });
  if (res.status === 409) res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`sign in failed: ${res.status} ${await res.text()}`);
  const m = /rd_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error("no session cookie");
  return `rd_session=${m[1]}`;
}

// Deterministic pseudo-random numbers so every run makes the same shape of data.
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

const COUNTRIES = ["US", "US", "US", "GB", "DE", "FR", "BR", "MX", "CA", "JP", "IN", "AU", "ES", "NL"];
const FIRST = ["ava", "liam", "mia", "noah", "zoe", "leo", "ivy", "max", "ella", "omar", "lina", "kai", "nora", "eli", "sara", "tom", "yuki", "ana", "ben", "rosa"];

export async function seedProject(base: string, cookie: string, projectId: string, opts: { customers?: number; now?: number } = {}): Promise<SeedResult> {
  const call = client(base, cookie);
  const P = `/v2/projects/${projectId}`;
  const now = opts.now ?? Date.now();
  const rand = rng(42);

  const apps = await call<{ items: any[] }>("GET", `${P}/apps?limit=100`);
  const app = apps.items.find((a) => a.type === "test_store") ?? await call("POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const keys = await call<{ items: { key: string }[] }>("GET", `${P}/apps/${app.id}/public_api_keys`);
  const testKey = keys.items[0]!.key;

  const products = await call<{ items: any[] }>("GET", `${P}/products?limit=100`);
  const want = [
    { store_identifier: "pro_weekly", type: "subscription", display_name: "Pro weekly", subscription: { duration: "P1W" }, price: 4.99 },
    { store_identifier: "pro_monthly", type: "subscription", display_name: "Pro monthly", subscription: { duration: "P1M" }, price: 9.99 },
    { store_identifier: "pro_annual", type: "subscription", display_name: "Pro yearly", subscription: { duration: "P1Y" }, price: 39.99 },
    { store_identifier: "lifetime", type: "non_consumable", display_name: "Lifetime", price: 79.99 },
    { store_identifier: "coins_100", type: "consumable", display_name: "100 coins", price: 1.99 },
  ];
  const prod: Record<string, any> = {};
  for (const w of want) {
    // The catalog price is the Test Store price the SDK shows (and posts back with the purchase).
    const { price, ...bodyFields } = w;
    const test_store_price = { amount_micros: Math.round(price * 1_000_000), currency: "USD" };
    const existing = products.items.find((p) => p.app_id === app.id && p.store_identifier === w.store_identifier);
    prod[w.store_identifier] = existing
      ? await call("POST", `${P}/products/${existing.id}`, { test_store_price })
      : await call("POST", `${P}/products`, { ...bodyFields, app_id: app.id, test_store_price });
  }

  const ents = await call<{ items: any[] }>("GET", `${P}/entitlements?limit=100`);
  const pro = ents.items.find((e) => e.lookup_key === "pro") ?? await call("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro access" });
  await call("POST", `${P}/entitlements/${pro.id}/actions/attach_products`, { product_ids: ["pro_weekly", "pro_monthly", "pro_annual", "lifetime"].map((k) => prod[k].id) }).catch(() => undefined);
  const ents2 = await call<{ items: any[] }>("GET", `${P}/entitlements?limit=100`);
  if (!ents2.items.some((e) => e.lookup_key === "ad_free")) await call("POST", `${P}/entitlements`, { lookup_key: "ad_free", display_name: "No ads" });

  const offs = await call<{ items: any[] }>("GET", `${P}/offerings?limit=100`);
  let def = offs.items.find((o) => o.lookup_key === "default");
  if (!def) {
    def = await call("POST", `${P}/offerings`, { lookup_key: "default", display_name: "Standard plans" });
    await call("POST", `${P}/offerings/${def.id}`, { is_current: true });
    for (const [i, [lk, name, pk]] of ([["$rc_weekly", "Weekly", "pro_weekly"], ["$rc_monthly", "Monthly", "pro_monthly"], ["$rc_annual", "Yearly", "pro_annual"]] as const).entries()) {
      const pkg = await call("POST", `${P}/offerings/${def.id}/packages`, { lookup_key: lk, display_name: name, position: i });
      await call("POST", `${P}/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: prod[pk].id, eligibility_criteria: "all" }] });
    }
  }
  if (!offs.items.some((o) => o.lookup_key === "winback")) await call("POST", `${P}/offerings`, { lookup_key: "winback", display_name: "Win-back 50% off" });
  const winback = (await call<{ items: any[] }>("GET", `${P}/offerings?limit=100`)).items.find((o) => o.lookup_key === "winback");

  // Customers and purchases.
  const n = opts.customers ?? 40;
  const customers: string[] = [];
  const receipt = async (user: string, product: string, at: number, price: number, country: string, platform: string, attributes?: Record<string, string>) => {
    const res = await fetch(`${base}/v1/receipts`, {
      method: "POST",
      headers: { authorization: `Bearer ${testKey}`, "content-type": "application/json", "x-platform": platform, "x-storefront": country, "x-client-version": platform === "iOS" ? "3.4.1" : "3.4.0" },
      body: JSON.stringify({
        app_user_id: user, fetch_token: `test_${at}_${crypto.randomUUID()}`, product_id: product, price, currency: "USD", store_country: country,
        ...(attributes ? { attributes: Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, { value: v, updated_at_ms: now }])) } : {}),
      }),
    });
    if (!res.ok) throw new Error(`receipt ${user} ${product}: ${res.status} ${await res.text()}`);
  };
  for (let i = 0; i < n; i++) {
    const anon = rand() < 0.3;
    const name = FIRST[i % FIRST.length]!;
    const id = anon ? `$RCAnonymousID:${Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join("")}` : `${name}_${Math.floor(rand() * 90000 + 10000)}`;
    const country = COUNTRIES[Math.floor(rand() * COUNTRIES.length)]!;
    const platform = rand() < 0.62 ? "iOS" : "android";
    const at = now - Math.floor(rand() * 88 * DAY) - Math.floor(rand() * 3600_000);
    const r = rand();
    const product = r < 0.35 ? "pro_monthly" : r < 0.6 ? "pro_weekly" : r < 0.8 ? "pro_annual" : r < 0.9 ? "lifetime" : "coins_100";
    const price = want.find((w) => w.store_identifier === product)!.price;
    const attributes: Record<string, string> = anon ? {} : { $email: `${name}${i}@example.com`, $displayName: name[0]!.toUpperCase() + name.slice(1) };
    if (rand() < 0.4) Object.assign(attributes, { $mediaSource: rand() < 0.5 ? "Apple Search Ads" : "Meta Ads", $campaign: rand() < 0.5 ? "fall_launch" : "brand_search", $adGroup: "scanners_us", $keyword: "pdf scanner", $creative: "video_15s_b" });
    if (rand() < 0.5) attributes.onboarding_variant = rand() < 0.5 ? "short" : "long";
    await receipt(id, product, at, price, country, platform, Object.keys(attributes).length ? attributes : undefined);
    // Some customers buy again: the weekly plan monthly, coins, or upgrade to annual later.
    if (product === "pro_weekly" && rand() < 0.5) await receipt(id, "pro_weekly", Math.min(now - 3600_000, at + 7 * DAY), 4.99, country, platform);
    if (rand() < 0.25) await receipt(id, "coins_100", Math.min(now - 1800_000, at + Math.floor(rand() * 10) * DAY + 3600_000), 1.99, country, platform);
    customers.push(id);
  }

  // A customer with a promotional grant (production) and one with an offering override.
  const vip = "support_vip_1";
  await call("POST", `${P}/customers`, { id: vip, attributes: [{ name: "$email", value: "vip@example.com" }, { name: "$displayName", value: "Priya (support)" }] }).catch(() => undefined);
  await call("POST", `${P}/customers/${vip}/actions/grant_entitlement`, { entitlement_id: pro.id, expires_at: now + 30 * DAY });
  await call("POST", `${P}/customers/${encodeURIComponent(customers[1]!)}/actions/assign_offering`, { offering_id: winback.id });
  customers.push(vip);
  return { projectId, testKey, appId: app.id, entitlementId: pro.id, offeringId: def.id, customers };
}
