// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: measures a full daily-rollup build of a large seeded project (prd/charts/PRD.md "Daily rollups").
// Run against a scratch database you can drop: DATABASE_URL=postgres://…/rd_rollups_bench npx tsx scripts/bench/rollups.ts [customers]
// It migrates that database, seeds one project with `customers` customers (default 200,000), each with a monthly
// subscription of 1 to 24 paid periods over three years (a fifth with a trial first), then builds the rollups with the
// job's 20-second budget per run and reports the runs, the time and the memory, and a live chart for comparison.
import { openDb, schema } from "../../packages/db/src/index.js";
import { chartDef, runChart } from "../../packages/core/src/index.js";
import { refreshRollups } from "../../apps/server/src/services/charts/rollups.js";
import { loadChartInput } from "../../apps/server/src/services/charts/load.js";
import { sql } from "../../packages/db/node_modules/drizzle-orm/index.js";

const n = Number(process.argv[2] ?? 200_000);
const { db, close } = await openDb(process.env.DATABASE_URL);
const P = "proj_bench";
const now = new Date();
const mb = () => Math.round(process.memoryUsage().rss / 1e6);

await db.delete(schema.projects).where(sql`${schema.projects.id} = ${P}`);
await db.insert(schema.projects).values({ id: P, name: "Bench" });
await db.insert(schema.apps).values({ id: "app_bench", projectId: P, name: "Bench iOS", type: "app_store", bundleId: "com.example.bench", publicKey: "appl_bench" });
await db.insert(schema.products).values({ id: "prod_bench", projectId: P, appId: "app_bench", storeIdentifier: "monthly", type: "subscription", duration: "P1M", displayName: "Monthly" });
let t = Date.now();
// Server-side generation: customers, then each one's periods, then the subscription rows.
await db.execute(sql`INSERT INTO customers (id, project_id, original_app_user_id, first_seen, last_seen, last_seen_country, last_seen_platform)
  SELECT 'c' || g, ${P}, 'u' || g, now() - (random() * interval '1095 days'), now(), (ARRAY['US','DE','GB','JP','BR'])[1 + (g % 5)], 'iOS' FROM generate_series(1, ${n}) g`);
await db.execute(sql`INSERT INTO transactions (id, project_id, customer_id, app_id, store, store_transaction_id, product_identifier, kind, is_sandbox, purchased_at, expires_at, revenue_usd, price_amount, price_currency, country_code)
  SELECT 't' || c.id || '_' || k, ${P}, c.id, 'app_bench', 'app_store', c.id || '_' || k, 'monthly',
    CASE WHEN k = 0 AND (abs(hashtext(c.id)) % 5) = 0 THEN 'trial' WHEN k = 0 THEN 'purchase' ELSE 'renewal' END, false,
    c.first_seen + k * interval '1 month', c.first_seen + (k + 1) * interval '1 month',
    CASE WHEN k = 0 AND (abs(hashtext(c.id)) % 5) = 0 THEN 0 ELSE 9.99 END, 9.99, 'USD', c.last_seen_country
  FROM customers c CROSS JOIN LATERAL generate_series(0, abs(hashtext(c.id || 'n')) % 24) k
  WHERE c.project_id = ${P} AND c.first_seen + k * interval '1 month' < now()`);
await db.execute(sql`INSERT INTO subscriptions (id, project_id, customer_id, app_id, store, store_key, product_identifier, is_sandbox, purchase_date, original_purchase_date, expires_date, price_amount, price_currency, price_usd)
  SELECT 's' || c.id, ${P}, c.id, 'app_bench', 'app_store', c.id || '_key', 'monthly', false, max(t.purchased_at), min(t.purchased_at), max(t.expires_at), 9.99, 'USD', 9.99
  FROM customers c JOIN transactions t ON t.customer_id = c.id WHERE c.project_id = ${P} GROUP BY c.id`);
const [{ txs }] = (await db.execute(sql`SELECT count(*)::int AS txs FROM transactions WHERE project_id = ${P}`)) as unknown as [{ txs: number }];
console.log(JSON.stringify({ seeded: { customers: n, transactions: txs }, seed_s: Math.round((Date.now() - t) / 1000) }));

// The job's budget per run: 20 seconds.
t = Date.now();
let runs = 0, done = false, peak = mb();
const perRun: number[] = [];
while (!done && runs < 200) {
  const r0 = Date.now();
  runs++;
  done = (await refreshRollups(db, P, false, now, Date.now() + 20_000, { force: runs === 1 })).done;
  perRun.push(Date.now() - r0);
  peak = Math.max(peak, mb());
}
const build = { runs, total_s: +((Date.now() - t) / 1000).toFixed(1), per_run_s: perRun.map((x) => +(x / 1000).toFixed(1)), peak_rss_mb: peak };
// One live chart (MRR, 12 months), for comparison: loading the rows and computing.
t = Date.now();
const input = await loadChartInput(db, { projectId: P, sandbox: false, now, currency: "USD", fetch: null, sources: { sdkTypes: [], activity: null, refundRequests: false } });
const loadMs = Date.now() - t;
t = Date.now();
runChart(chartDef("mrr")!, input, { resolution: "month", rangeStart: Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 1), rangeEnd: Math.floor(now.getTime() / 86_400_000) * 86_400_000 + 86_400_000, expand: false, selectors: {} });
console.log(JSON.stringify({ build, live_chart: { load_ms: loadMs, compute_ms: Date.now() - t }, rss_mb: mb() }));
await close();
process.exit(0);
