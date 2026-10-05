import { sql } from "drizzle-orm";
import type { DB } from "@revenuedot/db";

/**
 * Seeds `n` customers into a project with plain SQL (generate_series), fast enough for 10,000+ in PGlite and 50,000+
 * on real Postgres. Customer `k` (1..n) was last seen `k` minutes before `now`, so customer n is the least recently seen.
 * Its shape follows k (see `expected` for the same rules in JavaScript):
 * - k % 6: 0 active production subscription, 1 expired 10 days ago, 2 active trial, 3 active sandbox, 4 none, 5 active with auto-renew off
 * - a $9.99 transaction for kinds 0, 1 and 5 (production) and 3 (sandbox); a $49.99 one-time purchase when k % 10 = 0
 * - `$email` unless k % 5 = 0; country DE when k % 4 = 0, else US; the ID is anonymous when k % 13 = 0
 */
export async function seedMany(db: DB, projectId: string, n: number, now: Date) {
  const at = sql`${now.toISOString()}::timestamptz`;
  const id = sql.raw(`'${projectId}_c' || lpad(k::text, 7, '0')`);
  const user = sql.raw(`(CASE WHEN k % 13 = 0 THEN '$RCAnonymousID:' || md5(k::text) ELSE 'user' || k END)`);
  const run = (q: ReturnType<typeof sql>) => db.execute(q);
  await run(sql`INSERT INTO customers (id, project_id, original_app_user_id, first_seen, last_seen, last_seen_country, last_seen_platform)
    SELECT ${id}, ${projectId}, ${user}, ${at} - make_interval(mins => k + 100000), ${at} - make_interval(mins => k), CASE WHEN k % 4 = 0 THEN 'DE' ELSE 'US' END, 'iOS'
    FROM generate_series(1, ${n}) AS k`);
  await run(sql`INSERT INTO customer_aliases (project_id, app_user_id, customer_id) SELECT ${projectId}, ${user}, ${id} FROM generate_series(1, ${n}) AS k`);
  await run(sql`INSERT INTO customer_attributes (customer_id, key, value, updated_at_ms)
    SELECT ${id}, '$email', 'user' || k || '@example.com', 0 FROM generate_series(1, ${n}) AS k WHERE k % 5 <> 0`);
  await run(sql`INSERT INTO subscriptions (id, project_id, customer_id, app_id, store, store_key, product_identifier, is_sandbox, purchase_date, original_purchase_date, expires_date, period_type, unsubscribe_detected_at)
    SELECT ${id} || '_s', ${projectId}, ${id}, 'app_ios', 'app_store', ${id} || '_k', 'pro_monthly', k % 6 = 3,
      ${at} - make_interval(days => 20), ${at} - make_interval(days => 20),
      CASE WHEN k % 6 = 1 THEN ${at} - make_interval(days => 10) ELSE ${at} + make_interval(days => 10) END,
      CASE WHEN k % 6 = 2 THEN 'trial' ELSE 'normal' END, CASE WHEN k % 6 = 5 THEN ${at} - make_interval(days => 1) END
    FROM generate_series(1, ${n}) AS k WHERE k % 6 <> 4`);
  await run(sql`INSERT INTO transactions (id, project_id, customer_id, store, store_transaction_id, product_identifier, kind, purchased_at, revenue_usd, is_sandbox)
    SELECT ${id} || '_t', ${projectId}, ${id}, 'app_store', ${id} || '_t', 'pro_monthly', 'purchase', ${at} - make_interval(days => 20), 9.99, k % 6 = 3
    FROM generate_series(1, ${n}) AS k WHERE k % 6 IN (0, 1, 3, 5)`);
  await run(sql`INSERT INTO non_subscriptions (id, project_id, customer_id, store, store_transaction_id, product_identifier, purchase_date)
    SELECT ${id} || '_n', ${projectId}, ${id}, 'app_store', ${id} || '_n', 'lifetime', ${at} - make_interval(days => 5) FROM generate_series(1, ${n}) AS k WHERE k % 10 = 0`);
  await run(sql`INSERT INTO transactions (id, project_id, customer_id, store, store_transaction_id, product_identifier, kind, purchased_at, revenue_usd, is_sandbox)
    SELECT ${id} || '_o', ${projectId}, ${id}, 'app_store', ${id} || '_n', 'lifetime', 'one_time', ${at} - make_interval(days => 5), 49.99, false
    FROM generate_series(1, ${n}) AS k WHERE k % 10 = 0`);
  // Planner statistics, as autovacuum keeps them on a live database (without them a fresh bulk load gets nested loops).
  await run(sql`ANALYZE customers, customer_aliases, customer_attributes, subscriptions, transactions, non_subscriptions`);
}

/** What the seeded customers add up to, computed in JavaScript from the same rules. */
export function expected(n: number, pick: (k: number) => boolean = () => true) {
  let customers = 0, trialing = 0, paid = 0, revenue = 0, active = 0, trials = 0;
  for (let k = 1; k <= n; k++) {
    if (!pick(k)) continue;
    customers++;
    const kind = k % 6;
    if (kind === 2) trialing++;
    if (kind === 0 || kind === 5) paid++;
    if (kind === 0 || kind === 3 || kind === 5) active++;
    if (kind === 2) trials++;
    revenue += ([0, 1, 5].includes(kind) ? 9.99 : 0) + (k % 10 === 0 ? 49.99 : 0);
  }
  return { customers, trialing, paid, revenue: Math.round(revenue * 100) / 100, active, trials };
}

export const kindOf = (k: number) => k % 6;
export const hasEmail = (k: number) => k % 5 !== 0;
export const isDE = (k: number) => k % 4 === 0;
