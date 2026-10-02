// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (import), moving customers from RevenueCat (prd/importer), on the real Node server and a fresh
// Railway development database:
//   - A developer signs up, makes an App Store app, a Play app, products and the pro entitlement through v2, and a
//     secret key. Their backend posts a page of 100 customers shaped like a RevenueCat export (aliases, attributes,
//     App Store chains with renewal history, Play, promotional grants, one-time purchases) to
//     POST /v2/projects/{id}/import/customers. The page must take under 5 seconds; every row is checked in SQL and
//     entitlements through the SDK's wire calls.
//   - The same page again changes nothing; a page whose customers the app already saw (some under two ids) merges them.
//   - A second developer runs the real `revenuedot import` CLI against a fake RevenueCat (the importer's test fake,
//     126 customers) into the real server: default pages of 50, the report, and `import verify`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "./run.ts";
import { type Ctx, type Dev, sdkClient, signUp } from "./lib/context.ts";
import { importPage, pageStats } from "../../bench/import-fixture.ts";
import { FakeRevenueCat } from "../../../packages/importer/test/fake-revenuecat.ts";
import { PROJECT, rcModel } from "../../../packages/importer/test/fixtures.ts";
import { main as cli } from "../../../packages/importer/src/cli.ts";

const NOW = Date.now();

async function catalog(dev: Dev) {
  const ios = await dev.v2("POST", "/apps", { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.journeys.scanner" } });
  const play = await dev.v2("POST", "/apps", { name: "Scanner Android", type: "play_store", play_store: { package_name: "com.journeys.scanner" } });
  const product = (app: any, store_identifier: string, type: string, duration?: string) =>
    dev.v2("POST", "/products", { store_identifier, app_id: app.id, type, display_name: store_identifier, ...(duration ? { subscription: { duration } } : {}) });
  const ps = [await product(ios, "pro_monthly", "subscription", "P1M"), await product(ios, "pro_annual", "subscription", "P1Y"), await product(ios, "lifetime", "non_consumable"),
    await product(ios, "coins_100", "consumable"), await product(play, "pro:monthly", "subscription", "P1M")];
  const pro = await dev.v2("POST", "/entitlements", { lookup_key: "pro", display_name: "Pro access" });
  await dev.v2("POST", `/entitlements/${pro.id}/actions/attach_products`, { product_ids: ps.filter((p) => p.store_identifier !== "coins_100").map((p) => p.id) });
  const keys = await dev.v2("GET", `/apps/${ios.id}/public_api_keys`);
  return { ios, play, iosKey: keys.items[0].key as string };
}

/** RevenueCat customers cloned `n` times with every customer, subscription, transaction and purchase id made unique. */
function moreCustomers(model: ReturnType<typeof rcModel>, n: number) {
  const out = [...model.customers];
  const idKeys = new Set(["id", "customer_id", "original_customer_id", "store_subscription_identifier", "store_purchase_identifier", "store_transaction_identifier"]);
  for (let k = 1; k <= n; k++) {
    for (const c of model.customers) {
      const ids = new Set<string>();
      const walk = (o: any) => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (!o || typeof o !== "object") return;
        for (const [key, v] of Object.entries(o)) {
          if (idKeys.has(key) && typeof v === "string" && !/^(prod|entl|app|proj)/.test(v)) ids.add(v);
          else walk(v);
        }
      };
      walk(c);
      let json = JSON.stringify(c);
      for (const id of [...ids].sort((a, b) => b.length - a.length)) json = json.split(JSON.stringify(id)).join(JSON.stringify(`${id}_${k}`));
      out.push(JSON.parse(json));
    }
  }
  return out;
}

const journey: Journey = {
  name: "import",
  title: "Import customers from RevenueCat: a 100-customer page in under 5 s, idempotent re-run, merges, the CLI end to end",
  async run(ctx: Ctx) {
    const { c, sql } = ctx;
    const dev = await signUp(ctx, "importer", "Scanner Pro");
    const P = dev.projectId;
    const cat = await catalog(dev);
    const sk = await dev.v2("POST", "/api_keys", { name: "Migration" });
    const post = async (customers: unknown[]) => {
      const t = performance.now();
      const res = await fetch(`${ctx.base}/v2/projects/${P}/import/customers`, { method: "POST", headers: { authorization: `Bearer ${sk.key}`, "content-type": "application/json" }, body: JSON.stringify({ customers }) });
      return { status: res.status, body: await res.json() as any, ms: Math.round(performance.now() - t) };
    };
    const count = async (q: string) => Number((await sql.unsafe(q, [P]))[0]!.n);
    const digest = async () => JSON.stringify(await Promise.all([
      sql`SELECT * FROM customers WHERE project_id = ${P} ORDER BY id`,
      sql`SELECT * FROM customer_aliases WHERE project_id = ${P} ORDER BY app_user_id`,
      sql`SELECT a.* FROM customer_attributes a JOIN customers c ON c.id = a.customer_id WHERE c.project_id = ${P} ORDER BY a.customer_id, a.key`,
      sql`SELECT * FROM subscriptions WHERE project_id = ${P} ORDER BY id`,
      sql`SELECT * FROM non_subscriptions WHERE project_id = ${P} ORDER BY id`,
      sql`SELECT * FROM transactions WHERE project_id = ${P} ORDER BY id`,
    ]));

    // =================================================================================================================
    c.begin("a page of 100 customers from a RevenueCat export");
    const apps = { ios: cat.ios.id, play: cat.play.id };
    const page = importPage(apps, { n: 100, now: NOW, prefix: "rc" });
    const stats = pageStats(page);
    const first = await post(page);
    c.must("POST /import/customers answers 200", first.status === 200, first.body);
    console.log(`    (100 customers, ${stats.subscriptions} subscriptions, ${stats.transactions} transactions: ${first.ms} ms)`);
    c.check(`the page takes under 5 s (${first.ms} ms)`, first.ms < 5000, first.ms);
    c.eq("every customer is created", first.body.customers.map((x: any) => x.status), page.map(() => "created"));
    c.eq("reported subscriptions and purchases match the page", first.body.customers.map((x: any) => [x.id, x.subscriptions, x.purchases]), page.map((x) => [x.id, x.subscriptions.length, x.purchases.length]));
    const playSubs = page.reduce((a, x) => a + x.subscriptions.filter((s) => s.store === "play_store").length, 0);
    c.eq("Play chains without a purchase token are counted as needing one", first.body.customers.reduce((a: number, x: any) => a + x.needs_token_refresh, 0), playSubs);
    c.eq("SQL: 100 customers", await count("SELECT count(*) n FROM customers WHERE project_id = $1"), 100);
    c.eq("SQL: every id and alias points at its customer", await count(`SELECT count(*) n FROM customer_aliases a JOIN customers c ON c.id = a.customer_id WHERE a.project_id = $1
      AND (a.app_user_id = c.original_app_user_id OR a.app_user_id LIKE '$RCAnonymousID:%')`), stats.customers + stats.aliases);
    const attrCount = page.reduce((a, x) => a + new Set(x.attributes.map((t) => t.name)).size, 0);
    c.eq("SQL: every attribute", await count("SELECT count(*) n FROM customer_attributes a JOIN customers c ON c.id = a.customer_id WHERE c.project_id = $1"), attrCount);
    const promoEnts = page.reduce((a, x) => a + x.subscriptions.filter((s) => s.store === "promotional").length, 0);
    c.eq("SQL: one subscription row per chain", await count("SELECT count(*) n FROM subscriptions WHERE project_id = $1"), stats.subscriptions);
    c.eq("SQL: Play chains are keyed by their order id until the token is known", await count("SELECT count(*) n FROM subscriptions WHERE project_id = $1 AND store_key LIKE 'needs_token_refresh:%'"), playSubs);
    const txnRows = page.reduce((a, x) => a + x.subscriptions.reduce((b, s) => b + (s.transactions?.length || 1), 0) + x.purchases.reduce((b, p) => b + (p.status === "refunded" ? 2 : 1), 0), 0);
    c.eq("SQL: one revenue row per store transaction (plus refunds)", await count("SELECT count(*) n FROM transactions WHERE project_id = $1"), txnRows);
    c.eq("SQL: purchases", await count("SELECT count(*) n FROM non_subscriptions WHERE project_id = $1"), stats.purchases);
    c.eq("SQL: no lifecycle events or webhooks for imported history", await count("SELECT count(*) n FROM events WHERE project_id = $1"), 0);
    const sample = page.find((x) => x.subscriptions.length === 1 && x.subscriptions[0]!.store === "app_store" && x.subscriptions[0]!.status === "active")!;
    const s0 = sample.subscriptions.find((s) => s.store === "app_store")!;
    const [row] = await sql`SELECT s.*, c.original_app_user_id FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE s.project_id = ${P} AND s.store_key = ${s0.original_transaction_id}`;
    c.has("SQL: an App Store chain keeps its dates, price and store ids", row, {
      original_app_user_id: sample.id, product_identifier: s0.product_identifier, store_transaction_id: s0.store_subscription_identifier,
      price_amount: 9.99, price_currency: "USD", country_code: s0.country, app_id: cat.ios.id,
    });
    c.eq("SQL: its purchase and original purchase dates", [row!.purchase_date.getTime(), row!.original_purchase_date.getTime()], [s0.current_period_starts_at, s0.starts_at]);
    const sdk = sdkClient(ctx, cat.iosKey);
    const info = await sdk.customerInfo(sample.aliases[0]!);
    c.check("the SDK reads pro through the customer's anonymous alias, with the imported expiry", info.status === 200 && info.body.subscriber.entitlements.pro?.expires_date === new Date(s0.current_period_ends_at).toISOString().replace(/\.\d{3}Z$/, "Z"), info.body?.subscriber?.entitlements);
    const lapsed = page.find((x) => x.subscriptions.length && x.subscriptions.every((s) => s.status === "expired"));
    if (lapsed) {
      const li = await sdk.customerInfo(lapsed.id);
      c.check("a lapsed customer has no active pro", li.status === 200 && !(li.body.subscriber.entitlements.pro && Date.parse(li.body.subscriber.entitlements.pro.expires_date) > Date.now()), li.body?.subscriber?.entitlements);
    }
    const promo = page.find((x) => x.subscriptions.some((s) => s.store === "promotional"));
    if (promo) {
      const pi = await sdk.customerInfo(promo.id);
      c.check("a promotional grant unlocks pro", pi.status === 200 && !!pi.body.subscriber.entitlements.pro, pi.body?.subscriber?.entitlements);
    }
    const status = await dev.v2("GET", "/import/status");
    c.has("GET /import/status", status, { customers: 100, subscriptions: stats.subscriptions, needs_token_refresh: playSubs });

    // =================================================================================================================
    c.begin("the same page again");
    const before = await digest();
    const again = await post(page);
    console.log(`    (re-run: ${again.ms} ms)`);
    c.check(`the re-run takes under 5 s (${again.ms} ms)`, again.status === 200 && again.ms < 5000, again.ms);
    c.eq("every customer is updated", again.body.customers.map((x: any) => x.status), page.map(() => "updated"));
    c.check("SQL: no row changed (customers, aliases, attributes, subscriptions, purchases, transactions)", (await digest()) === before);

    // =================================================================================================================
    c.begin("customers the app already saw");
    const next = importPage(apps, { n: 100, from: 100, now: NOW, seed: 7, prefix: "rc" });
    for (const [i, cu] of next.slice(0, 10).entries()) {
      // The app opened before the import: the device's anonymous id, and for five of them also the logged-in id.
      const ids = i < 5 ? [cu.aliases[0]!, cu.id] : [cu.aliases[0]!];
      const codes = [];
      for (const id of ids) codes.push((await sdk.customerInfo(id)).status);
      c.check(`the app reads ${ids.length} id(s) of customer ${cu.id} (a new customer each)`, codes.every((x) => x === 200 || x === 201), codes);
    }
    c.eq("SQL: 15 customers made by the app", await count("SELECT count(*) n FROM customers WHERE project_id = $1"), 115);
    const third = await post(next);
    console.log(`    (100 customers, 10 seen, 5 merged: ${third.ms} ms)`);
    c.check(`the page takes under 5 s (${third.ms} ms)`, third.status === 200 && third.ms < 5000, third.ms);
    c.eq("statuses: 5 merged, 5 updated, 90 created", third.body.customers.map((x: any) => x.status), next.map((_, i) => (i < 5 ? "merged" : i < 10 ? "updated" : "created")));
    c.eq("SQL: 200 customers, one per RevenueCat customer", await count("SELECT count(*) n FROM customers WHERE project_id = $1"), 200);
    const split = await sql`SELECT a.app_user_id, a.customer_id FROM customer_aliases a WHERE a.project_id = ${P} AND a.app_user_id IN ${sql(next.slice(0, 10).flatMap((x) => [x.id, ...x.aliases]))}`;
    const byUser = new Map(split.map((r) => [r.app_user_id, r.customer_id]));
    c.check("SQL: each customer's ids and aliases point at one customer", next.slice(0, 10).every((x) => x.aliases.every((a) => byUser.get(a) === byUser.get(x.id))), split);
    const kept = await sql`SELECT original_app_user_id, first_seen FROM customers WHERE id = ${byUser.get(next[0]!.id)!}`;
    c.eq("the merged customer keeps the earliest first-seen date (the export's)", kept[0]!.first_seen.getTime(), next[0]!.first_seen_at);

    // =================================================================================================================
    c.begin("the revenuedot CLI end to end");
    const dev2 = await signUp(ctx, "cli", "Scanner CLI");
    const sk2 = await dev2.v2("POST", "/api_keys", { name: "CLI" });
    const model = rcModel();
    model.customers = moreCustomers(model, 8);
    const rc = await new FakeRevenueCat(model, "sk_rc_journey", null).start();
    const dir = mkdtempSync(join(tmpdir(), "rd-import-journey-"));
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: { REVENUEDOT_API_KEY: sk2.key, REVENUECAT_API_KEY: "sk_rc_journey" } };
    const common = ["--rc-project", PROJECT, "--rc-url", rc.url, "--to", ctx.base];
    try {
      const t = performance.now();
      const code = await cli(["import", "--from-revenuecat", ...common, "--state", join(dir, "state.json")], io);
      const ms = Math.round(performance.now() - t);
      console.log(`    (CLI import of ${model.customers.length} customers: ${ms} ms)`);
      c.must("revenuedot import exits 0", code === 0, err.slice(-5));
      c.check(`the report says all ${model.customers.length} customers were imported`, out.join("\n").includes(`${model.customers.length} customers imported`), out.join("\n").slice(0, 600));
      const pages = rc.requests.filter((r) => r.template === "/v2/projects/{project_id}/customers");
      c.eq("RevenueCat is read in pages of 50", pages.map((r) => r.query.get("limit")), ["50", "50", "50"]);
      c.eq("SQL: every customer", Number((await sql`SELECT count(*) n FROM customers WHERE project_id = ${dev2.projectId}`)[0]!.n), model.customers.length);
      out.length = 0;
      const vcode = await cli(["import", "verify", ...common], io);
      c.check("revenuedot import verify runs and checks every customer", vcode <= 1 && out.join("\n").includes(`${model.customers.length} customers`), out.join("\n").slice(0, 800));
      // The fake RevenueCat's data is dated 2026-09-01; access that ended since then differs, nothing else may.
      const report = out.join("\n");
      c.check("verify: no customer is missing", !/missing/i.test(report), report.slice(0, 800));
      out.length = 0;
      const rerun = await cli(["import", "--from-revenuecat", ...common, "--state", join(dir, "state2.json")], io);
      c.check("a second full run (new state file) succeeds and creates nobody", rerun === 0 && out.join("\n").includes(`(0 new`), out.join("\n").slice(0, 600));
    } finally {
      await rc.stop();
    }
  },
};

export default journey;
