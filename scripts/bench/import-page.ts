// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: times POST /v2/projects/{id}/import/customers against a real Postgres (the Railway development server)
// and counts the SQL round trips it makes. Every round trip costs one network hop (Hyperdrive on Cloud), so the count
// is what decides the speed.
//
//   source ~/.config/revenuedot/dev.env && pnpm tsx scripts/bench/import-page.ts
//
// Creates the database rd_import_perf (BENCH_DB to change), drops it at the end (KEEP_DB=1 keeps it).
// Docs: https://revenuedot.app/docs/migrate
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { openDb, schema, type DB } from "../../packages/db/src/index.js";
import { createApp } from "../../apps/server/src/app.js";
import { defaultStores } from "../../apps/server/src/stores/index.js";
import { createSecretKey } from "../../apps/server/src/services/auth.js";
import { importPage, pageStats } from "./import-fixture.js";

// The workspace's own drizzle-orm (scripts/ has no node_modules of its own).
const { drizzle } = await import(new URL("../../packages/db/node_modules/drizzle-orm/postgres-js/index.js", import.meta.url).href) as typeof import("drizzle-orm/postgres-js");
const postgres = createRequire(new URL("../../packages/db/package.json", import.meta.url))("postgres") as typeof import("postgres");
const admin = process.env.REVENUEDOT_DEV_DATABASE_URL;
if (!admin) { console.error("Run `source ~/.config/revenuedot/dev.env` first."); process.exit(2); }
const name = process.env.BENCH_DB ?? "rd_import_perf";
const url = (() => { const u = new URL(admin); u.pathname = `/${name}`; return u.href; })();
const hide = (s: string) => s.replace(/postgres(ql)?:\/\/\S+/g, "postgres://…");

async function adminSql(q: string) {
  const sql = postgres(admin!, { max: 1, onnotice: () => {} });
  try { await sql.unsafe(q); } finally { await sql.end(); }
}

async function main() {
  await adminSql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await adminSql(`CREATE DATABASE "${name}"`);
  const migrated = await openDb(url);
  await migrated.close();

  // The Workers driver settings (packages/db/src/worker.ts), plus a counter of statements sent.
  let queries = 0;
  const client = postgres(url, { max: 5, fetch_types: false, prepare: false, onnotice: () => {}, debug: () => { queries++; } });
  const db = drizzle(client, { schema }) as unknown as DB;
  try {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) await client`select 1`;
    const rtt = (performance.now() - t0) / 10;

    await db.insert(schema.projects).values({ id: "projbench", name: "Bench" });
    await db.insert(schema.apps).values([
      { id: "app_ios", projectId: "projbench", name: "iOS", type: "app_store", bundleId: "com.bench.app", publicKey: "appl_bench", credentials: {} },
      { id: "app_play", projectId: "projbench", name: "Android", type: "play_store", bundleId: "com.bench.app", publicKey: "goog_bench", credentials: {} },
    ]);
    await db.insert(schema.products).values(["pro_monthly", "pro_annual", "lifetime", "coins_100"].map((s, i) => ({
      id: `p${i}`, projectId: "projbench", appId: "app_ios", storeIdentifier: s, displayName: s, type: s === "coins_100" ? "consumable" : s === "lifetime" ? "non_consumable" : "subscription",
    })));
    const { key } = await createSecretKey(db, "projbench", "bench");
    const app = createApp({ db, now: () => new Date(Date.UTC(2026, 9, 1)), stores: defaultStores() });
    const post = async (customers: unknown[]) => {
      const before = queries;
      const t = performance.now();
      const res = await app.fetch(new Request("http://bench/v2/projects/projbench/import/customers", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ customers }),
      }));
      const body = await res.json() as any;
      if (res.status !== 200) throw new Error(`import answered ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
      const statuses: Record<string, number> = {};
      for (const c of body.customers) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
      return { ms: Math.round(performance.now() - t), queries: queries - before, statuses };
    };
    const digest = async () => {
      const h = createHash("sha256");
      for (const t of ["customers", "customer_aliases", "customer_attributes", "subscriptions", "non_subscriptions", "transactions"]) {
        const rows = await client.unsafe(`SELECT * FROM ${t} ORDER BY 1, 2`);
        h.update(JSON.stringify(rows.map((r: any) => ({ ...r, id: t === "transactions" ? undefined : r.id }))));
      }
      return h.digest("hex").slice(0, 16);
    };

    const apps = { ios: "app_ios", play: "app_play" };
    const page = importPage(apps, { n: 100 });
    console.log(`Round trip to the database: ${rtt.toFixed(1)} ms. Page: ${JSON.stringify(pageStats(page))}`);
    const report = (label: string, r: Awaited<ReturnType<typeof post>>) =>
      console.log(`${label.padEnd(52)} ${String(r.ms).padStart(6)} ms  ${String(r.queries).padStart(5)} queries  ${JSON.stringify(r.statuses)}`);

    report("1. 100 new customers", await post(page));
    const d1 = await digest();
    report("2. the same 100 again (nothing changes)", await post(page));
    const d2 = await digest();
    console.log(`   database unchanged by the second run: ${d1 === d2}`);

    // Live SDK traffic before the import: 10 customers of the next page already exist under an alias, 5 of them twice.
    const next = importPage(apps, { n: 100, from: 100, seed: 7 });
    for (const [i, cu] of next.slice(0, 10).entries()) {
      const ids = i < 5 ? [cu.aliases[0]!, cu.id] : [cu.aliases[0]!];
      for (const [j, appUserId] of ids.entries()) {
        const id = `cus_pre_${i}_${j}`;
        await db.insert(schema.customers).values({ id, projectId: "projbench", originalAppUserId: appUserId, firstSeen: new Date(Date.UTC(2026, 8, 1)), lastSeen: new Date(Date.UTC(2026, 8, 30)) });
        await db.insert(schema.customerAliases).values({ projectId: "projbench", appUserId, customerId: id });
      }
    }
    report("3. 100 new customers, 10 already seen, 5 merged", await post(next));
    report("4. a page of 25", await post(importPage(apps, { n: 25, from: 200, seed: 9 })));
    if (process.env.BENCH_DUMP) {
      // Every imported row with generated ids replaced by what identifies it, to compare two builds of the import.
      const cust = new Map((await client`SELECT id, original_app_user_id FROM customers`).map((r: any) => [r.id, r.original_app_user_id]));
      const norm = (rows: any[], key: (r: any) => string, drop: string[]) => rows.map((r) => {
        const o: any = { ...r };
        for (const k of drop) delete o[k];
        if (o.customer_id) o.customer_id = cust.get(o.customer_id);
        return [key(r), o];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      const out = {
        customers: norm(await client`SELECT * FROM customers`, (r) => r.original_app_user_id, ["id"]),
        aliases: norm(await client`SELECT * FROM customer_aliases`, (r) => r.app_user_id, []),
        attributes: norm(await client`SELECT * FROM customer_attributes`, (r) => `${cust.get(r.customer_id)}/${r.key}`, []),
        subscriptions: norm(await client`SELECT * FROM subscriptions`, (r) => `${r.store}/${r.store_key}`, ["id"]),
        non_subscriptions: norm(await client`SELECT * FROM non_subscriptions`, (r) => `${r.store}/${r.store_transaction_id}`, ["id"]),
        transactions: norm(await client`SELECT * FROM transactions`, (r) => `${r.store}/${r.store_transaction_id}/${r.kind}`, ["id", "created_at"]),
      };
      (await import("node:fs")).writeFileSync(process.env.BENCH_DUMP, JSON.stringify(out, null, 1));
      console.log(`Wrote ${process.env.BENCH_DUMP}`);
    }
  } finally {
    await client.end();
    if (process.env.KEEP_DB === "1") console.log(`Kept database ${name}.`);
    else { await adminSql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); console.log(`Dropped ${name}.`); }
  }
}

main().catch((e) => { console.error(hide(String(e?.stack ?? e))); process.exit(1); });
