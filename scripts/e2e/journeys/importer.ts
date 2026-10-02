// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (j), moving from RevenueCat. A developer signs up, sets up their iOS app, an app build already
// talks to RevenueDot, and a webhook is configured. Then they run the real CLI the way the docs say
// (`pnpm --filter revenuedot cli import ...`, keys in REVENUECAT_API_KEY / REVENUEDOT_API_KEY) against the fake
// RevenueCat API v2 the importer tests use (packages/importer/test), served by the capture server and rebased to today.
// Every catalog object, customer, alias, attribute, subscription, purchase and transaction is compared field by field
// with the export, through SQL, the v2 API and the SDK's own wire calls with the imported SDK keys. The import fires no
// webhooks and records no events; a second import changes nothing; `import verify` finds no differences; `import plan`
// prints this server's URLs. Known gap kept visible: a refunded subscription imports as expired (RevenueCat's v2
// subscription object does not expose refunds).
// Docs: https://revenuedot.app/docs/migrate
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { sleep, until } from "./lib/check.ts";
import { type Ctx, eventsOf, sdkClient, secretClient, signUp } from "./lib/context.ts";
import { chromium } from "./onboarding.ts";
import { PORTS, ROOT, type Captured } from "./lib/stack.ts";
import { FakeRevenueCat, type RcModel } from "../../../packages/importer/test/fake-revenuecat.ts";
import { ANON, DAY, PROJECT, T0, TOKENS_CSV, rcModel } from "../../../packages/importer/test/fixtures.ts";
import { loadSpec } from "../../../packages/contract/src/openapi.ts";

type Obj = Record<string, any>;
const TIME_KEY = (k: string) => k.endsWith("_at") || k === "expiration_date" || k === "effective_expiration_date";

/** The fixture project moved from the tests' clock (2026-09-01) to now, so "active" means active today. */
function rebase<T>(v: T, by: number): T {
  if (Array.isArray(v)) return v.map((x) => rebase(x, by)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "number" && TIME_KEY(k) ? x + by : rebase(x, by)])) as T;
  return v;
}

/** The fixtures plus one customer whose annual subscription was refunded (RevenueCat shows it as expired at the refund). */
function sourceProject(shift: number): RcModel {
  const m = rcModel();
  const at = (d: number) => T0 + d * DAY;
  const usd = (g: number) => ({ currency: "USD", gross: g, commission: Math.round(g * 30) / 100, tax: 0, proceeds: Math.round(g * 70) / 100 });
  const base = m.customers.find((c) => c.id === "user_expired")!;
  m.customers.push({
    ...structuredClone(base), id: "user_refunded", first_seen_at: at(-20), aliases: [{ object: "customer.alias", id: "user_refunded", created_at: at(-20) }], active: [], purchases: [],
    attributes: [{ object: "customer.attribute", name: "$email", value: "refund@example.com", updated_at: at(-20) }],
    subscriptions: [{
      ...structuredClone(base.subscriptions[0]!), id: "sub_refunded", customer_id: "user_refunded", original_customer_id: "user_refunded",
      starts_at: at(-20), current_period_starts_at: at(-20), current_period_ends_at: at(-10), ends_at: at(-10), total_revenue_in_usd: usd(59.99),
      status: "expired", gives_access: false, auto_renewal_status: "will_not_renew", store_subscription_identifier: "9000000001",
      transactions: [{ object: "subscription_transaction", id: "9000000001", purchased_at: at(-20), product_store_identifier: "pro_annual", revenue_in_local_currency: usd(59.99), revenue_in_usd: usd(59.99), expiration_date: at(-10), effective_expiration_date: at(-10) }],
    }],
  });
  return rebase(m, shift);
}

interface Run { code: number | null; out: string; err: string }
/** The CLI exactly as the docs run it from a clone; the keys go in through the environment only. */
function cli(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn("pnpm", ["--silent", "--filter", "revenuedot", "cli", ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

const journey: Journey = {
  name: "importer",
  title: "Moving from RevenueCat: the real CLI imports catalog, customers and history, idempotent, no webhooks",
  async run(ctx: Ctx) {
    const { c } = ctx;
    const shift = Math.floor((Date.now() - T0) / 1000) * 1000;
    const at = (d: number) => T0 + d * DAY + shift;
    const model = sourceProject(shift);
    const spec = loadSpec();
    const RC_KEY = `sk_rcjourney_${ctx.stamp}`;
    const fake = new FakeRevenueCat(model, RC_KEY, spec);
    fake.url = ctx.capture.base;
    fake.maxPage = 4; // 15 customers over 4 pages: the importer follows next_page
    const rcHandler = async (q: Captured, res: ServerResponse) => {
      if (q.host !== "local" || !q.path.startsWith(`/v2/projects/${PROJECT}`)) return false;
      await (fake as any).handle({ url: q.path + q.query, method: q.method, headers: { authorization: q.headers.authorization } }, res);
      return true;
    };
    ctx.capture.handlers.push(rcHandler);
    try {
      c.begin("developer account, iOS app and a device that already talks to RevenueDot");
      const dev = await signUp(ctx, "migrator", "Scanner");
      const P = dev.projectId;
      const sk = await dev.v2("POST", "/api_keys", { name: "Importer" });
      c.check("secret key created for the import", /^sk_/.test(sk.key), { prefix: String(sk.key).slice(0, 3) });
      const backend = secretClient(ctx, sk.key, P);
      const ios = await dev.v2("POST", "/apps", { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.scanner" } });
      const iosKeyBefore = (await dev.v2("GET", `/apps/${ios.id}/public_api_keys`)).items[0]?.key as string;
      c.check("iOS app created with RevenueDot's own appl_ key", /^appl_/.test(iosKeyBefore) && iosKeyBefore !== "appl_RCiosShippedKey", iosKeyBefore);
      const pre = await sdkClient(ctx, iosKeyBefore).customerInfo(ANON);
      c.check("an app build reached RevenueDot first with the anonymous id (201: customer created)", pre.status === 201, pre.status);
      const appsBefore = await ctx.sql`SELECT id, type, name FROM apps WHERE project_id = ${P}`;
      const hook = await dev.v2("POST", "/integrations/webhooks", { name: "Backend", url: `http://localhost:${PORTS.capture}/local/importer-hook` });
      c.check("a webhook to the capture server is configured before the import", /^whsec_/.test(hook.signing_secret ?? ""), hook);

      const outDir = ctx.out;
      const state = join(outDir, "import-state.json");
      const tokens = join(outDir, "google-tokens.csv");
      writeFileSync(tokens, TOKENS_CSV);
      const env = { REVENUECAT_API_KEY: RC_KEY, REVENUEDOT_API_KEY: sk.key };
      const common = ["--rc-project", PROJECT, "--rc-url", ctx.capture.base, "--to", ctx.base];
      const noKeys = (r: Run) => !(r.out + r.err).includes(RC_KEY) && !(r.out + r.err).includes(sk.key);
      const since = Date.now();

      c.begin("dry run writes nothing");
      const counts = async () => (await ctx.sql`SELECT
        (SELECT count(*) FROM products WHERE project_id = ${P})::int AS products, (SELECT count(*) FROM entitlements WHERE project_id = ${P})::int AS entitlements,
        (SELECT count(*) FROM offerings WHERE project_id = ${P})::int AS offerings, (SELECT count(*) FROM customers WHERE project_id = ${P})::int AS customers,
        (SELECT count(*) FROM subscriptions WHERE project_id = ${P})::int AS subscriptions, (SELECT count(*) FROM non_subscriptions WHERE project_id = ${P})::int AS purchases,
        (SELECT count(*) FROM transactions WHERE project_id = ${P})::int AS transactions, (SELECT count(*) FROM apps WHERE project_id = ${P})::int AS apps`)[0]!;
      const before = await counts();
      const dry = await cli(["import", "--from-revenuecat", ...common, "--state", join(outDir, "dry-state.json"), "--dry-run"], env);
      c.check("`import --dry-run` exits 0 and says nothing was written", dry.code === 0 && dry.out.includes("Dry run: nothing was written to RevenueDot."), { code: dry.code, out: dry.out.slice(-800), err: dry.err.slice(-800) });
      c.check("the dry run reads all 15 customers", dry.out.includes("15 customers read"), dry.out.slice(-800));
      c.eq("the dry run changed no row", await counts(), before);

      c.begin("import with the real CLI");
      const first = await cli(["import", "--from-revenuecat", ...common, "--state", state, "--google-tokens", tokens], env);
      writeFileSync(join(outDir, "import-1.txt"), first.out + "\n--- stderr\n" + first.err);
      c.must("`revenuedot import` exits 0 with 'Import finished'", first.code === 0 && first.out.includes("Import finished"), { code: first.code, out: first.out.slice(-1500), err: first.err.slice(-1500) });
      c.check("the report counts 15 customers: 14 new, 1 already in RevenueDot (the device's anonymous customer)", first.out.includes("15 customers imported (14 new, 1 already in RevenueDot)"), first.out);
      c.check("the report counts 10 subscriptions and 2 one-time purchases", first.out.includes("10 subscriptions, 2 one-time purchases"), first.out);
      c.check("the report lists the store credentials to re-enter (App Store, Google Play, Stripe)", /Store credentials to re-enter/.test(first.out) && /Scanner iOS \(app_store, com\.example\.scanner\)/.test(first.out) && /Scanner Android \(play_store/.test(first.out) && /Scanner Web \(stripe/.test(first.out), first.out);
      c.check("the report names the Google subscription still waiting for a purchase token", first.out.includes("1 Google Play subscriptions need a purchase token"), first.out);
      c.check("3 shipped SDK keys kept", first.out.includes("3 kept"), first.out);
      c.check("no key appears in the CLI output", noKeys(dry) && noKeys(first));
      c.check("every RevenueCat response matched RevenueCat's OpenAPI schema" + (spec ? "" : " (spec not on this machine: not checked)"), fake.schemaErrors.length === 0, fake.schemaErrors.slice(0, 5));
      c.check("the importer followed RevenueCat's pagination (4 customer pages per pass)", fake.count("/v2/projects/{project_id}/customers") >= 8, fake.count("/v2/projects/{project_id}/customers"));

      c.begin("catalog matches the export");
      const apps = await ctx.sql`SELECT id, type, name, bundle_id, public_key FROM apps WHERE project_id = ${P} ORDER BY name`;
      const rdApp = new Map<string, Obj>();
      for (const a of model.apps) {
        const ident = a[a.type]?.bundle_id ?? a[a.type]?.package_name ?? null;
        const hit = apps.find((x) => x.type === a.type && (ident ? x.bundle_id === ident : x.name === a.name));
        if (hit) rdApp.set(a.id, hit);
      }
      c.eq("every RevenueCat app has a RevenueDot app of the same store and bundle id", model.apps.map((a) => [a.name, rdApp.get(a.id)?.type ?? null]), model.apps.map((a) => [a.name, a.type]));
      c.check("the iOS app made before the import was matched, not duplicated", rdApp.get("appa_ios")?.id === ios.id && apps.filter((a) => a.type === "app_store").length === 2, apps);
      const mapped = new Set([...rdApp.values()].map((a) => a.id));
      c.check("each RevenueCat app maps to its own RevenueDot app, and only unmatched ones were created", mapped.size === model.apps.length && apps.length === model.apps.length + appsBefore.filter((a) => !mapped.has(a.id)).length, { apps: apps.length, before: appsBefore.length });
      const keyOf = (rcApp: string) => rdApp.get(rcApp)?.public_key;
      c.eq("shipped SDK keys kept (production key per app)", [keyOf("appa_ios"), keyOf("appa_play"), keyOf("appa_new")], ["appl_RCiosShippedKey", "goog_RCplayShippedKey", "appl_RCnewShippedKey"]);
      const products = await ctx.sql`SELECT id, app_id, store_identifier, type, duration, state, display_name FROM products WHERE project_id = ${P}`;
      const rdProduct = new Map<string, Obj>();
      const productDiffs: string[] = [];
      for (const p of model.products) {
        const hit = products.find((x) => x.app_id === rdApp.get(p.app_id)?.id && x.store_identifier === p.store_identifier);
        if (!hit) { productDiffs.push(`${p.id} missing`); continue; }
        rdProduct.set(p.id, hit);
        const want = { type: p.type, duration: p.subscription?.duration ?? null, state: p.state, display_name: p.display_name };
        const got = { type: hit.type, duration: hit.duration, state: hit.state, display_name: hit.display_name };
        if (JSON.stringify(want) !== JSON.stringify(got)) productDiffs.push(`${p.id}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
      c.check(`all ${model.products.length} products with app, store id, type, duration, state (old_monthly archived) and name`, productDiffs.length === 0 && products.length === model.products.length, { productDiffs, rows: products.length });
      const ents = await ctx.sql`SELECT e.id, e.lookup_key, e.display_name, e.state, coalesce(array_agg(ep.product_id) FILTER (WHERE ep.product_id IS NOT NULL), '{}') AS products
        FROM entitlements e LEFT JOIN entitlement_products ep ON ep.entitlement_id = e.id WHERE e.project_id = ${P} GROUP BY e.id`;
      c.eq("entitlements with display names and attached products", ents.map((e) => [e.lookup_key, e.display_name, [...e.products].sort()]).sort(),
        model.entitlements.map((e) => [e.lookup_key, e.display_name, e.product_ids.map((id) => rdProduct.get(id)?.id).sort()]).sort());
      const offs = await ctx.sql`SELECT o.id, o.lookup_key, o.display_name, o.is_current, o.metadata FROM offerings o WHERE o.project_id = ${P}`;
      const pk = await ctx.sql`SELECT p.offering_id, p.lookup_key, p.display_name, p.position, pp.product_id, pp.eligibility_criteria
        FROM packages p JOIN offerings o ON o.id = p.offering_id LEFT JOIN package_products pp ON pp.package_id = p.id WHERE o.project_id = ${P}`;
      const offShape = (lk: string, dn: string, cur: boolean, meta: unknown, pkgs: [string, string, number, string[]][]) => ({ lk, dn, cur, meta, pkgs: pkgs.sort((a, b) => a[2] - b[2]) });
      c.eq("offerings: names, metadata, current flag, packages with positions and products",
        offs.map((o) => {
          const rows = pk.filter((r) => r.offering_id === o.id);
          const pkgs = [...new Set(rows.map((r) => r.lookup_key))].map((lk) => { const rs = rows.filter((r) => r.lookup_key === lk); return [lk, rs[0]!.display_name, rs[0]!.position, rs.map((r) => `${r.product_id}:${r.eligibility_criteria}`).sort()] as [string, string, number, string[]]; });
          return offShape(o.lookup_key, o.display_name, o.is_current, o.metadata, pkgs);
        }).sort((a, b) => a.lk.localeCompare(b.lk)),
        model.offerings.map((o) => offShape(o.lookup_key, o.display_name, o.is_current, o.metadata, o.packages.map((p) => [p.lookup_key, p.display_name, p.position, p.products.map((x) => `${rdProduct.get(x.product_id)?.id}:${x.eligibility_criteria}`).sort()]))).sort((a, b) => a.lk.localeCompare(b.lk)));
      const v2Offs = await backend.r("GET", "/offerings?expand=items.package.product");
      const v2Cur = v2Offs.body.items?.find((o: any) => o.is_current);
      c.check("v2 API: 'sale' is the current offering, with its annual package and product", v2Cur?.lookup_key === "sale" && v2Cur.packages?.items?.[0]?.products?.items?.[0]?.product?.store_identifier === "pro_annual", v2Cur);
      const sdkIos = sdkClient(ctx, "appl_RCiosShippedKey");
      const sdkOff = await sdkIos.offerings("user_apple");
      const sale = sdkOff.body.offerings?.find((o: any) => o.identifier === "sale");
      const def = sdkOff.body.offerings?.find((o: any) => o.identifier === "default");
      c.check("SDK with the shipped iOS key: current offering 'sale' and the default offering's three packages with the iOS products",
        sdkOff.status === 200 && sdkOff.body.current_offering_id === "sale" && sale?.metadata?.headline === "Half price"
        && JSON.stringify(def?.packages?.map((p: any) => [p.identifier, p.platform_product_identifier])) === JSON.stringify([["$rc_monthly", "pro_monthly"], ["$rc_annual", "pro_annual"], ["$rc_lifetime", "lifetime"]]),
        { status: sdkOff.status, current: sdkOff.body.current_offering_id, def: def?.packages });
      const oldKey = await sdkClient(ctx, iosKeyBefore).offerings("user_apple");
      c.check("RevenueDot's previous iOS key no longer works (the app has one key: the shipped one)", oldKey.status === 401 || oldKey.status === 403, oldKey.status);

      c.begin("customers, aliases and attributes match the export");
      const custRows = await ctx.sql`SELECT c.id, c.original_app_user_id, c.first_seen, c.last_seen, c.last_seen_app_version, c.last_seen_country, c.last_seen_platform,
        (SELECT array_agg(a.app_user_id ORDER BY a.app_user_id) FROM customer_aliases a WHERE a.customer_id = c.id) AS aliases,
        (SELECT json_agg(json_build_object('k', t.key, 'v', t.value, 'at', t.updated_at_ms) ORDER BY t.key) FROM customer_attributes t WHERE t.customer_id = c.id) AS attrs
        FROM customers c WHERE c.project_id = ${P}`;
      c.eq("one RevenueDot customer per RevenueCat customer (the device's anonymous customer merged into user_apple)", custRows.length, model.customers.length);
      const byAlias = (id: string) => custRows.find((r) => (r.aliases ?? []).includes(id));
      const custDiffs: string[] = [];
      for (const m of model.customers) {
        const r = byAlias(m.id);
        if (!r) { custDiffs.push(`${m.id}: missing`); continue; }
        const want = {
          original: m.id === "user_apple" ? ANON : m.id, first_seen: m.first_seen_at,
          // user_apple: the device was seen after RevenueCat's last-seen date, so its values win (app 1.0, storefront USA stored as US).
          last_seen: m.id === "user_apple" ? Math.max(r.last_seen.getTime(), since - 60_000) : m.last_seen_at,
          version: m.id === "user_apple" ? "1.0" : m.last_seen_app_version, country: m.last_seen_country, platform: m.last_seen_platform,
          aliases: [...new Set([m.id, ...m.aliases.map((a: Obj) => a.id)])].sort(),
          attrs: m.attributes.length ? m.attributes.map((a: Obj) => ({ k: a.name, v: a.value, at: a.updated_at })).sort((a: Obj, b: Obj) => a.k.localeCompare(b.k)) : null,
        };
        const got = { original: r.original_app_user_id, first_seen: r.first_seen.getTime(), last_seen: r.last_seen.getTime(), version: r.last_seen_app_version, country: r.last_seen_country, platform: r.last_seen_platform, aliases: r.aliases, attrs: r.attrs };
        if (JSON.stringify(got) !== JSON.stringify(want)) custDiffs.push(`${m.id}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
      c.check("first seen, last seen, app version, country (two-letter, also for the device's storefront USA), platform, every alias and every attribute (with its update time) per customer", custDiffs.length === 0, custDiffs);
      const apple = byAlias("user_apple");
      c.check("the merged customer keeps the device's anonymous id and the earlier RevenueCat first-seen date", apple?.aliases?.includes(ANON) && apple.first_seen.getTime() === at(-120), apple && { aliases: apple.aliases, first: apple.first_seen });

      c.begin("subscriptions, purchases and transactions match the export");
      const rcEntKey = new Map(model.entitlements.map((e) => [e.id, e.lookup_key]));
      const subDiffs: string[] = [];
      const purchaseDiffs: string[] = [];
      const pick = (s: Obj) => ({
        starts_at: s.starts_at, current_period_starts_at: s.current_period_starts_at, current_period_ends_at: s.current_period_ends_at, gives_access: s.gives_access,
        status: s.status, auto_renewal_status: s.auto_renewal_status, environment: s.environment, store: s.store, store_subscription_identifier: s.store_subscription_identifier,
        ownership: s.ownership, country: s.country ?? null, revenue: s.total_revenue_in_usd?.gross,
      });
      for (const m of model.customers) {
        const subs = await backend.r("GET", `/customers/${encodeURIComponent(m.id)}/subscriptions`);
        const items: Obj[] = subs.body?.items ?? [];
        if (items.length !== m.subscriptions.length) subDiffs.push(`${m.id}: ${items.length} subscriptions, want ${m.subscriptions.length}`);
        for (const s of m.subscriptions) {
          const got = items.find((x) => x.store_subscription_identifier === s.store_subscription_identifier);
          if (!got) { subDiffs.push(`${m.id} ${s.id}: missing`); continue; }
          const product = s.product_id ? products.find((p) => p.id === got.product_id)?.store_identifier : null;
          // RevenueDot's rule: while a renewal is failing, auto-renew counts as off (BILLING_ERROR), as the store adapters record it.
          const want = { ...pick(s), ...(s.status === "in_grace_period" ? { auto_renewal_status: "will_not_renew" } : {}), product: s.product_id ? model.products.find((p) => p.id === s.product_id)!.store_identifier : null, entitlements: (s.entitlement_ids ?? []).map((e: string) => rcEntKey.get(e)).sort() };
          const have = { ...pick(got), product: product ?? null, entitlements: (got.entitlements?.items ?? []).map((e: Obj) => e.lookup_key).sort() };
          if (m.id === "user_refunded") continue; // compared below (known gap)
          for (const k of Object.keys(want) as (keyof typeof want)[]) if (JSON.stringify(have[k]) !== JSON.stringify(want[k])) subDiffs.push(`${m.id} ${s.id} ${k}: ${JSON.stringify(have[k])} != ${JSON.stringify(want[k])}`);
        }
        const purch = await backend.r("GET", `/customers/${encodeURIComponent(m.id)}/purchases`);
        const pItems: Obj[] = purch.body?.items ?? [];
        if (pItems.length !== m.purchases.length) purchaseDiffs.push(`${m.id}: ${pItems.length} purchases, want ${m.purchases.length}`);
        for (const p of m.purchases) {
          const got = pItems.find((x) => x.store_purchase_identifier === p.store_purchase_identifier);
          if (!got) { purchaseDiffs.push(`${m.id} ${p.id}: missing`); continue; }
          const want = { purchased_at: p.purchased_at, status: p.status, store: p.store, environment: p.environment, revenue: p.revenue_in_usd.gross, product: model.products.find((x) => x.id === p.product_id)!.store_identifier, entitlements: p.entitlement_ids.map((e: string) => rcEntKey.get(e)).sort() };
          const have = { purchased_at: got.purchased_at, status: got.status, store: got.store, environment: got.environment, revenue: got.revenue_in_usd?.gross, product: products.find((x) => x.id === got.product_id)?.store_identifier ?? null, entitlements: (got.entitlements?.items ?? []).map((e: Obj) => e.lookup_key).sort() };
          if (JSON.stringify(have) !== JSON.stringify(want)) purchaseDiffs.push(`${m.id} ${p.id}: ${JSON.stringify(have)} != ${JSON.stringify(want)}`);
        }
      }
      c.check("v2 API: every subscription's dates, status, renewal, store, environment, ownership, ids, product, entitlements and revenue as in RevenueCat", subDiffs.length === 0, subDiffs);
      c.check("v2 API: every one-time purchase's date, status (refunded coins), store, product, entitlements and revenue as in RevenueCat", purchaseDiffs.length === 0, purchaseDiffs);

      const subRows = await ctx.sql`SELECT a.app_user_id, s.store, s.store_key, s.original_transaction_id, s.store_transaction_id, s.product_identifier, s.product_plan_identifier, s.app_id,
          s.original_purchase_date, s.purchase_date, s.expires_date, s.grace_period_expires_date, s.billing_issues_detected_at, s.is_sandbox, s.period_type, s.entitlement_identifier, s.refunded_at, s.expired_event_at
        FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN customer_aliases a ON a.customer_id = c.id AND a.app_user_id = c.original_app_user_id WHERE s.project_id = ${P}`;
      const sub = (u: string) => subRows.find((r) => r.app_user_id === u || (u === "user_apple" && r.app_user_id === apple?.original_app_user_id));
      c.has("App Store chain keyed by its first transaction, latest transaction kept, iOS app", sub("user_apple"), { store_key: "2000000001", store_transaction_id: "2000000003", app_id: ios.id, product_identifier: "pro_monthly" });
      c.check("App Store chain dates: original purchase 65 days ago, current period ends in 25 days", sub("user_apple")?.original_purchase_date.getTime() === at(-65) && sub("user_apple")?.expires_date.getTime() === at(25), sub("user_apple"));
      c.has("Google Play chain keyed by the purchase token from --google-tokens, product split into subscription and base plan", sub("user_play_token"), { store_key: "tok_play_1", product_identifier: "pro", product_plan_identifier: "monthly", app_id: rdApp.get("appa_play")?.id });
      c.has("Google Play chain without a token marked needs_token_refresh by its order id", sub("user_play_notoken"), { store_key: "needs_token_refresh:GPA.5555-6666-7777-88888" });
      c.check("grace period: billing issue at the period end, grace until the entitlement's end (in 5 days)", sub("user_grace")?.grace_period_expires_date?.getTime() === at(5) && sub("user_grace")?.billing_issues_detected_at?.getTime() === at(-1), sub("user_grace"));
      c.has("sandbox trial kept as sandbox and trial", sub("user_sandbox"), { is_sandbox: true, period_type: "trial" });
      c.has("promotional grant for the 'extra' entitlement", sub("user_promo"), { store: "promotional", entitlement_identifier: "extra", period_type: "promotional" });
      c.has("Stripe subscription keyed by the Stripe subscription id on the Stripe app", sub("user_stripe"), { store: "stripe", store_key: "sub_1StripeABC", app_id: rdApp.get("appa_stripe")?.id });
      c.has("the second iOS app's subscription sits on the app created by the import", sub("user_new_app"), { app_id: rdApp.get("appa_new")?.id, store_key: "6000000001" });
      c.check("history that already ended is marked expired at its end (the expiration job sends nothing for it)", sub("user_expired")?.expired_event_at?.getTime() === at(-35), sub("user_expired"));

      const txRows = await ctx.sql`SELECT t.store, t.store_transaction_id, t.kind, t.purchased_at, t.expires_at, t.revenue_usd, t.product_identifier FROM transactions t WHERE t.project_id = ${P}`;
      const txDiffs: string[] = [];
      let wantTx = 0;
      for (const m of model.customers) for (const s of m.subscriptions) {
        // Without store transactions (Stripe, promotional grants) the current period is one row, as a live grant records a $0 purchase.
        const txs = (s.transactions as Obj[] | undefined) ?? [{ id: s.store_subscription_identifier, purchased_at: s.current_period_starts_at, expiration_date: s.current_period_ends_at, revenue_in_usd: s.total_revenue_in_usd }];
        for (const [i, t] of [...txs].sort((a, b) => a.purchased_at - b.purchased_at).entries()) {
          wantTx++;
          const row = txRows.find((r) => r.store === s.store && r.store_transaction_id === t.id && r.kind !== "refund");
          const kind = i > 0 ? "renewal" : s.status === "trialing" && !t.revenue_in_usd?.gross ? "trial" : "purchase";
          const want = { purchased_at: t.purchased_at, expires_at: t.expiration_date ?? null, revenue: t.revenue_in_usd?.gross ?? 0, kind };
          const got = row && { purchased_at: row.purchased_at.getTime(), expires_at: row.expires_at?.getTime() ?? null, revenue: row.revenue_usd, kind: row.kind };
          if (JSON.stringify(got) !== JSON.stringify(want)) txDiffs.push(`${m.id} ${t.id}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
        }
      }
      for (const m of model.customers) for (const p of m.purchases) {
        wantTx += p.status === "refunded" ? 2 : 1;
        const one = txRows.find((r) => r.store_transaction_id === p.store_purchase_identifier && r.kind === "one_time");
        const refund = txRows.find((r) => r.store_transaction_id === p.store_purchase_identifier && r.kind === "refund");
        if (!one || one.revenue_usd !== p.revenue_in_usd.gross || one.purchased_at.getTime() !== p.purchased_at) txDiffs.push(`${m.id} ${p.id}: one_time ${JSON.stringify(one)}`);
        if ((p.status === "refunded") !== !!refund || (refund && refund.revenue_usd !== -p.revenue_in_usd.gross)) txDiffs.push(`${m.id} ${p.id}: refund ${JSON.stringify(refund)}`);
      }
      c.check("transactions: one row per store transaction (and per Stripe or promotional period) with its date, expiry, revenue and kind (purchase, renewal, trial); the refunded coins have a negative refund row", txDiffs.length === 0 && txRows.length === wantTx, { txDiffs, rows: txRows.length, want: wantTx });

      c.begin("current access is kept (SDK wire calls with the shipped keys)");
      const accessDiffs: string[] = [];
      const now = Date.now();
      for (const m of model.customers) {
        const platformKey = m.last_seen_platform === "Android" ? "goog_RCplayShippedKey" : "appl_RCiosShippedKey";
        const r = await sdkClient(ctx, platformKey, m.last_seen_platform === "Android" ? "Android" : "iOS").customerInfo(m.id);
        if (r.status !== 200) { accessDiffs.push(`${m.id}: GET /v1/subscribers ${r.status}`); continue; }
        const active = Object.entries((r.body.subscriber?.entitlements ?? {}) as Record<string, Obj>).flatMap(([k, e]) => {
          const end = Math.max(e.expires_date ? Date.parse(e.expires_date) : Infinity, e.grace_period_expires_date ? Date.parse(e.grace_period_expires_date) : 0);
          return end > now ? [[k, end === Infinity ? null : end]] : [];
        }).sort();
        const want = m.active.map((a: Obj) => [rcEntKey.get(a.entitlement_id), a.expires_at]).sort();
        if (JSON.stringify(active) !== JSON.stringify(want)) accessDiffs.push(`${m.id}: ${JSON.stringify(active)} != ${JSON.stringify(want)}`);
      }
      c.check("GET /v1/subscribers/{id}: every customer has exactly RevenueCat's active entitlements with the same expiry (lifetime: never)", accessDiffs.length === 0, accessDiffs);
      const anon = await sdkIos.customerInfo(ANON);
      c.check("the anonymous id the device used still resolves to the merged customer, with pro active", anon.status === 200 && anon.body.subscriber?.entitlements?.pro && Date.parse(anon.body.subscriber.entitlements.pro.expires_date) === at(25), anon.body?.subscriber?.entitlements);
      const life = await sdkIos.customerInfo("user_lifetime");
      c.check("lifetime purchase: non_subscriptions lists lifetime and the refunded coins", life.body.subscriber?.non_subscriptions?.lifetime?.length === 1 && life.body.subscriber?.non_subscriptions?.coins_100?.length === 1, life.body.subscriber?.non_subscriptions);
      const v2Apple = await backend.r("GET", `/customers/user_apple`);
      c.check("v2 customer: user_apple's active entitlement 'pro' until the period end", v2Apple.body.active_entitlements?.items?.length === 1 && v2Apple.body.active_entitlements.items[0].expires_at === at(25), v2Apple.body);

      c.begin("the imported data in the dashboard (Chromium)");
      {
        const browser = await chromium().launch();
        const errors: string[] = [];
        try {
          const bcx = await browser.newContext();
          await bcx.addCookies([{ name: "rd_session", value: dev.cookie.split("=")[1]!, url: ctx.base }]);
          const page = await bcx.newPage();
          page.on("pageerror", (e) => errors.push(String(e)));
          page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
          page.on("response", (r) => { if (r.url().startsWith(ctx.base) && r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
          await page.goto(`${ctx.base}/projects/${dev.projectId}/customers/user_apple`);
          await page.getByRole("heading", { name: "user_apple" }).waitFor({ timeout: 20_000 });
          await page.waitForLoadState("networkidle").catch(() => {});
          const body = await page.locator("body").innerText();
          c.check("user_apple's customer page shows the imported pro entitlement and its App Store subscription", /\bpro\b/.test(body) && /App Store/.test(body), body.slice(0, 600));
          await page.goto(`${ctx.base}/projects/${dev.projectId}/product-catalog/products`);
          await page.waitForLoadState("networkidle").catch(() => {});
          const prods = await page.locator("body").innerText();
          const archived = new Set(products.filter((x: any) => x.state === "inactive").map((x: any) => x.store_identifier as string));
          const missing = model.products.map((x: Obj) => x.store_identifier as string).filter((sid: string) => !archived.has(sid) && !prods.includes(sid));
          c.check("the Products page lists every active imported product", missing.length === 0, missing);
          await page.getByRole("group", { name: "Filter products" }).getByRole("button", { name: "Inactive" }).click();
          await page.waitForTimeout(300);
          const inactive = await page.locator("body").innerText();
          c.check(`the Inactive filter shows the archived import (${[...archived].join(", ")})`, archived.size > 0 && [...archived].every((sid) => inactive.includes(sid)), [...archived]);
          c.eq("no page errors, console errors or failed requests on those pages", errors, []);
        } finally { await browser.close(); }
      }

      c.begin("no webhooks and no events for imported history");
      const ev1 = await eventsOf(ctx, P);
      c.eq("no lifecycle events recorded by the import", ev1.length, 0);
      // The background job runs every 30 s: give it one full run over the imported rows.
      await sleep(33_000);
      const ev2 = await eventsOf(ctx, P);
      c.check("after a background job run: still no events (no EXPIRATION for old history, no RENEWAL for imported periods)", ev2.length === 0, ev2.map((e) => [e.type, e.app_user_id]));
      const deliveries = await ctx.sql`SELECT count(*)::int AS n FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE w.project_id = ${P}`;
      c.eq("no webhook deliveries queued", deliveries[0]!.n, 0);
      c.eq("nothing reached the webhook URL", ctx.capture.of("local", "/local/importer-hook").length, 0);
      const storeCalls = ctx.server.outbound(since).filter((o) => o.routed === "blocked" || /apple|googleapis/.test(o.host));
      c.eq("the import called neither Apple nor Google (no store credentials yet)", storeCalls, []);

      c.begin("a second import is idempotent");
      const dump = async () => {
        const q = {
          apps: ctx.sql`SELECT * FROM apps WHERE project_id = ${P}`,
          products: ctx.sql`SELECT * FROM products WHERE project_id = ${P}`,
          entitlements: ctx.sql`SELECT * FROM entitlements WHERE project_id = ${P}`,
          entitlement_products: ctx.sql`SELECT ep.* FROM entitlement_products ep JOIN entitlements e ON e.id = ep.entitlement_id WHERE e.project_id = ${P}`,
          offerings: ctx.sql`SELECT * FROM offerings WHERE project_id = ${P}`,
          packages: ctx.sql`SELECT p.* FROM packages p JOIN offerings o ON o.id = p.offering_id WHERE o.project_id = ${P}`,
          package_products: ctx.sql`SELECT pp.* FROM package_products pp JOIN packages p ON p.id = pp.package_id JOIN offerings o ON o.id = p.offering_id WHERE o.project_id = ${P}`,
          customers: ctx.sql`SELECT * FROM customers WHERE project_id = ${P}`,
          aliases: ctx.sql`SELECT * FROM customer_aliases WHERE project_id = ${P}`,
          attributes: ctx.sql`SELECT t.* FROM customer_attributes t JOIN customers c ON c.id = t.customer_id WHERE c.project_id = ${P}`,
          subscriptions: ctx.sql`SELECT * FROM subscriptions WHERE project_id = ${P}`,
          non_subscriptions: ctx.sql`SELECT * FROM non_subscriptions WHERE project_id = ${P}`,
          transactions: ctx.sql`SELECT * FROM transactions WHERE project_id = ${P}`,
          events: ctx.sql`SELECT * FROM events WHERE project_id = ${P}`,
        };
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(q)) out[k] = (await v).map((r) => JSON.stringify(r)).sort();
        return out;
      };
      const d1 = await dump();
      const second = await cli(["import", "--from-revenuecat", ...common, "--state", state, "--google-tokens", tokens], env);
      writeFileSync(join(outDir, "import-2.txt"), second.out + "\n--- stderr\n" + second.err);
      c.check("the second run is pass 2 and creates nothing (15 imported, 0 new)", second.code === 0 && second.out.includes("Customers (pass 2, complete)") && second.out.includes("15 customers imported (0 new, 15 already in RevenueDot)"), { code: second.code, out: second.out.slice(-1200), err: second.err.slice(-600) });
      c.check("the catalog report of the second run only matches (0 created)", /Apps\s+0 created, 5 already there/.test(second.out) && /Products\s+0 created, 9 already there/.test(second.out) && /Offerings\s+0 created, 2 already there/.test(second.out), second.out);
      const d2 = await dump();
      const changed = Object.keys(d1).filter((k) => JSON.stringify(d1[k]) !== JSON.stringify(d2[k]));
      c.check("every imported row is byte-for-byte unchanged after the second import (catalog, customers, aliases, attributes, subscriptions, purchases, transactions, events)", changed.length === 0,
        changed.map((k) => ({ table: k, before: d1[k]!.length, after: d2[k]!.length, diff: d2[k]!.filter((x) => !d1[k]!.includes(x)).slice(0, 2) })));

      c.begin("import verify and import plan");
      const verify = await cli(["import", "verify", ...common, "--json"], env);
      let vr: Obj | null = null;
      try { vr = JSON.parse(verify.out.slice(verify.out.indexOf("{"))); } catch { /* not JSON */ }
      c.check("`import verify` exits 0 with zero differences", verify.code === 0 && vr?.mismatches?.length === 0, { code: verify.code, out: verify.out.slice(-1500), err: verify.err.slice(-500) });
      const activeSubs = model.customers.reduce((n, m) => n + m.subscriptions.filter((s) => s.gives_access).length, 0);
      const activeEnts = model.customers.reduce((n, m) => n + m.active.length, 0);
      c.eq("verify totals: customers, subscriptions giving access and active entitlements equal on both sides", vr && { customers: vr.customers, subs: vr.activeSubscriptions, ents: vr.activeEntitlements },
        { customers: { revenuecat: 15, revenuedot: 15, checked: 15 }, subs: { revenuecat: activeSubs, revenuedot: activeSubs }, ents: { revenuecat: activeEnts, revenuedot: activeEnts } });
      const verifyText = await cli(["import", "verify", ...common], env);
      c.check("`import verify` (text) says 'No differences: 15 customers match.'", verifyText.code === 0 && verifyText.out.includes("No differences: 15 customers match."), verifyText.out.slice(-600));
      const plan = await cli(["import", "plan", "--to", ctx.base, "--rc-project", PROJECT], { REVENUEDOT_API_KEY: sk.key });
      c.check("`import plan` exits 0 and asks only for the RevenueDot key", plan.code === 0, { code: plan.code, err: plan.err.slice(-500) });
      c.check("the plan names this server's App Store and Google Play notification URLs for the imported apps",
        plan.out.includes(`${ctx.base}/v1/notifications/apple/${ios.id}`) && plan.out.includes(`${ctx.base}/v1/notifications/google/${rdApp.get("appa_play")?.id}`), plan.out.slice(0, 2000));
      c.check("the plan gives the SDK proxy URL line for this server", plan.out.includes(`Purchases.proxyURL = URL(string: "${ctx.base}")!`), plan.out.slice(0, 2000));
      c.check("the plan lists the Google subscription that still needs a purchase token", plan.out.includes("1 Google Play subscriptions have no purchase token yet"), plan.out.slice(0, 2000));
      c.check("no key appears in the output of the second import, verify or plan", noKeys(second) && noKeys(verify) && noKeys(verifyText) && noKeys(plan));
      const status = await backend.r("GET", "/import/status");
      c.has("GET /import/status counts customers, subscriptions and the one pending Google token", status.body, { customers: 15, subscriptions: 10, needs_token_refresh: 1 });

      c.begin("known gap (recorded, not fixed): refunded subscriptions");
      const refunded = sub("user_refunded");
      const refundedV2 = (await backend.r("GET", "/customers/user_refunded/subscriptions")).body.items?.[0];
      c.check("KNOWN GAP: a subscription refunded in RevenueCat imports as expired (status expired, no access, refunded_at empty, revenue not reversed), because RevenueCat's v2 subscription object does not expose refunds",
        refundedV2?.status === "expired" && refundedV2.gives_access === false && refunded?.refunded_at === null && !txRows.some((t) => t.store_transaction_id === "9000000001" && t.kind === "refund"),
        { refundedV2, refunded });

      c.begin("live traffic after the import still sends webhooks");
      const testApp = rdApp.get("appa_test");
      const testKey = testApp?.public_key as string;
      const buy = await sdkClient(ctx, testKey).purchase("user_plain_1", "pro_monthly", { price: 9.99 });
      c.check("an imported customer buys on the Test Store: pro active", buy.status === 200 && buy.body.subscriber?.entitlements?.pro?.product_identifier === "pro_monthly", buy.body);
      const hit = await until(async () => ctx.capture.of("local", "/local/importer-hook").find((r) => r.body.includes("INITIAL_PURCHASE")), { timeoutMs: 45_000 });
      c.check("the webhook receives INITIAL_PURCHASE for the new purchase only (so the silence above was the import's, not a broken webhook)", hit && ctx.capture.of("local", "/local/importer-hook").length === 1, ctx.capture.of("local", "/local/importer-hook").map((r) => r.body.slice(0, 200)));
    } finally {
      ctx.capture.handlers.splice(ctx.capture.handlers.indexOf(rcHandler), 1);
    }
  },
};
export default journey;
