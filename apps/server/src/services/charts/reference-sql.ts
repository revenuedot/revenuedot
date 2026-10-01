/**
 * Published PostgreSQL for the core charts, written against RevenueDot's own schema (packages/db/src/schema.ts).
 * The API computes the same numbers in TypeScript (packages/core/src/charts); packages/contract/test/charts-sql.test.ts
 * runs every query here on the test database and checks it returns what the API returns. The docs page
 * revenuedot.app/docs/guides/charts prints them.
 *
 * Run one with psql variables, for example:
 *   psql "$DATABASE_URL" -v project_id=proj_123 -v resolution=month -v start_date=2026-01-01 -v end_date=2026-07-01 \
 *     -v now="$(date -u +%FT%TZ)" -f revenue.sql
 * `end_date` is exclusive. Money is USD at the purchase-date rate (`revenue_usd`, `price_usd`). Sandbox purchases,
 * granted (promotional) access and Family Sharing are excluded, as in the API.
 */

const PERIODS = `periods AS (
  SELECT p AS period, LEAST(p + ('1 ' || :'resolution')::interval, :'end_date'::timestamptz AT TIME ZONE 'UTC', :'now'::timestamptz AT TIME ZONE 'UTC') AS period_end
  FROM generate_series(date_trunc(:'resolution', :'start_date'::timestamptz AT TIME ZONE 'UTC'),
                       (:'end_date'::timestamptz AT TIME ZONE 'UTC') - interval '1 microsecond',
                       ('1 ' || :'resolution')::interval) AS p
)`;

/** Ledger rows of production purchases, without granted access and Family Sharing. */
const LEDGER = `ledger AS (
  SELECT t.*, t.purchased_at AT TIME ZONE 'UTC' AS at
  FROM transactions t
  WHERE t.project_id = :'project_id' AND NOT t.is_sandbox AND t.store <> 'promotional'
    AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = t.customer_id AND s.store = t.store
                    AND s.product_identifier = t.product_identifier AND s.ownership_type = 'FAMILY_SHARED')
)`;

/**
 * Subscription periods with their effective end: expiry, cut short by a refund of the same store transaction (unless
 * reversed), extended by a grace period the store reports now. A customer's newest period in a store and app replaces
 * older ones (upgrades and downgrades).
 */
const PERIOD_ROWS = `refunds AS (
  SELECT store, store_transaction_id, max(purchased_at) AS refunded_at
  FROM ledger WHERE kind IN ('refund', 'refund_reversal')
  GROUP BY store, store_transaction_id
  HAVING count(*) FILTER (WHERE kind = 'refund') > count(*) FILTER (WHERE kind = 'refund_reversal')
),
sub_periods AS (
  SELECT l.customer_id, l.store, coalesce(l.app_id, '') AS app_id, l.product_identifier, l.kind, l.purchased_at AS starts_at,
         LEAST(GREATEST(coalesce(l.expires_at, 'infinity'),
                        CASE WHEN s.billing_issues_detected_at IS NOT NULL AND l.expires_at >= s.expires_date - interval '1 hour'
                             THEN s.grace_period_expires_date END),
               coalesce(r.refunded_at, 'infinity')) AS ends_at,
         l.revenue_usd,
         coalesce(
           CASE
             WHEN p.duration ~ '^P\\d+Y$' THEN 1.0 / (12 * substring(p.duration from '\\d+')::numeric)
             WHEN p.duration ~ '^P\\d+M$' THEN 1.0 / substring(p.duration from '\\d+')::numeric
             WHEN p.duration ~ '^P\\d+W$' THEN 4.0 / substring(p.duration from '\\d+')::numeric
             WHEN p.duration ~ '^P\\d+D$' THEN 30.0 / substring(p.duration from '\\d+')::numeric
           END,
           30.0 / GREATEST(1, extract(epoch FROM l.expires_at - l.purchased_at) / 86400)) AS monthly_factor
  FROM ledger l
  LEFT JOIN refunds r ON r.store = l.store AND r.store_transaction_id = l.store_transaction_id
  LEFT JOIN subscriptions s ON s.customer_id = l.customer_id AND s.store = l.store AND s.product_identifier = l.product_identifier
  LEFT JOIN LATERAL (
    SELECT duration FROM products p WHERE p.project_id = l.project_id
      AND (p.store_identifier = l.product_identifier OR split_part(p.store_identifier, ':', 1) = l.product_identifier)
    ORDER BY (p.app_id = l.app_id) DESC, (p.store_identifier = l.product_identifier) DESC LIMIT 1
  ) p ON true
  WHERE l.kind IN ('trial', 'purchase', 'renewal')
),
snapshot AS (
  SELECT DISTINCT ON (pe.period, sp.customer_id, sp.store, sp.app_id) pe.period, sp.kind, sp.revenue_usd * sp.monthly_factor AS mrr
  FROM periods pe
  JOIN sub_periods sp ON sp.starts_at <= (pe.period_end - interval '1 millisecond') AT TIME ZONE 'UTC'
                     AND sp.ends_at > (pe.period_end - interval '1 millisecond') AT TIME ZONE 'UTC'
  ORDER BY pe.period, sp.customer_id, sp.store, sp.app_id, sp.starts_at DESC
)`;

export interface ReferenceQuery { chart: string; title: string; sql: string }

export const REFERENCE_SQL: ReferenceQuery[] = [
  {
    chart: "revenue", title: "Revenue and transactions",
    sql: `-- Revenue: purchases, renewals and one-time purchases, minus refunds on the refund date, plus ad revenue reported in USD.
-- Transactions: paid purchases, renewals and one-time purchases (refunds do not reduce it).
WITH ${PERIODS},
${LEDGER},
money AS (
  SELECT at, revenue_usd AS usd, kind IN ('purchase', 'renewal', 'one_time') AS is_tx FROM ledger WHERE kind <> 'trial'
  UNION ALL
  SELECT occurred_at AT TIME ZONE 'UTC', (payload->>'revenue_micros')::numeric / 1000000, false FROM sdk_events
  WHERE project_id = :'project_id' AND NOT is_sandbox AND type = 'rc_ads_ad_revenue' AND coalesce(payload->>'currency', 'USD') = 'USD'
)
SELECT pe.period, round(coalesce(sum(m.usd), 0)::numeric, 2) AS revenue, count(m.*) FILTER (WHERE m.is_tx) AS transactions
FROM periods pe
LEFT JOIN money m ON m.at >= GREATEST(pe.period, :'start_date'::timestamptz AT TIME ZONE 'UTC') AND m.at < pe.period_end
GROUP BY pe.period ORDER BY pe.period;`,
  },
  {
    chart: "non-subscription_purchases", title: "Non-subscription purchases",
    sql: `-- One-time purchases (consumables, non-consumables, lifetime) per period.
WITH ${PERIODS},
${LEDGER}
SELECT pe.period, count(l.*) AS purchases
FROM periods pe
LEFT JOIN ledger l ON l.kind = 'one_time' AND l.at >= GREATEST(pe.period, :'start_date'::timestamptz AT TIME ZONE 'UTC') AND l.at < pe.period_end
GROUP BY pe.period ORDER BY pe.period;`,
  },
  {
    chart: "refunds", title: "Refunds",
    sql: `-- Money refunded and refunded transactions by refund date, net of reversed refunds.
WITH ${PERIODS},
${LEDGER}
SELECT pe.period,
       round(coalesce(-sum(l.revenue_usd), 0)::numeric, 2) AS refunded_revenue,
       count(l.*) FILTER (WHERE l.kind = 'refund') - count(l.*) FILTER (WHERE l.kind = 'refund_reversal') AS refunded_transactions
FROM periods pe
LEFT JOIN ledger l ON l.kind IN ('refund', 'refund_reversal') AND l.at >= GREATEST(pe.period, :'start_date'::timestamptz AT TIME ZONE 'UTC') AND l.at < pe.period_end
GROUP BY pe.period ORDER BY pe.period;`,
  },
  {
    chart: "trials_new", title: "New trials",
    sql: `-- Free trials started per period.
WITH ${PERIODS},
${LEDGER}
SELECT pe.period, count(l.*) AS new_trials
FROM periods pe
LEFT JOIN ledger l ON l.kind = 'trial' AND l.at >= GREATEST(pe.period, :'start_date'::timestamptz AT TIME ZONE 'UTC') AND l.at < pe.period_end
GROUP BY pe.period ORDER BY pe.period;`,
  },
  {
    chart: "customers_new", title: "New customers",
    sql: `-- Customers whose cohort date (the earlier of first seen and first purchase) falls in the period.
WITH ${PERIODS},
${LEDGER},
cohorts AS (
  SELECT c.id, LEAST(c.first_seen, (SELECT min(purchased_at) FROM ledger l WHERE l.customer_id = c.id)) AT TIME ZONE 'UTC' AS cohort_at
  FROM customers c WHERE c.project_id = :'project_id'
)
SELECT pe.period, count(c.*) AS new_customers
FROM periods pe
LEFT JOIN cohorts c ON c.cohort_at >= GREATEST(pe.period, :'start_date'::timestamptz AT TIME ZONE 'UTC') AND c.cohort_at < pe.period_end
GROUP BY pe.period ORDER BY pe.period;`,
  },
  {
    chart: "actives", title: "Active subscriptions",
    sql: `-- Paid subscriptions with access at the end of each period (cancelled ones count until they expire).
WITH ${PERIODS},
${LEDGER},
${PERIOD_ROWS}
SELECT pe.period, count(s.*) FILTER (WHERE s.kind <> 'trial') AS actives
FROM periods pe LEFT JOIN snapshot s ON s.period = pe.period
GROUP BY pe.period ORDER BY pe.period;`,
  },
  {
    chart: "trials", title: "Active trials",
    sql: `-- Free trials with access at the end of each period.
WITH ${PERIODS},
${LEDGER},
${PERIOD_ROWS}
SELECT pe.period, count(s.*) FILTER (WHERE s.kind = 'trial') AS trials
FROM periods pe LEFT JOIN snapshot s ON s.period = pe.period
GROUP BY pe.period ORDER BY pe.period;`,
  },
  {
    chart: "mrr", title: "MRR",
    sql: `-- Monthly recurring revenue at the end of each period: each active paid subscription's USD price times its
-- duration's factor (1 day ×30, 1 week ×4, 1 month ×1, 3 months ×1/3, 1 year ×1/12 …).
WITH ${PERIODS},
${LEDGER},
${PERIOD_ROWS}
SELECT pe.period, round(coalesce(sum(s.mrr) FILTER (WHERE s.kind <> 'trial'), 0)::numeric, 2) AS mrr
FROM periods pe LEFT JOIN snapshot s ON s.period = pe.period
GROUP BY pe.period ORDER BY pe.period;`,
  },
];

/** Fills the psql variables with quoted literals (tests and one-off scripts; the values are ours, never user input). */
export function fillReferenceSql(sqlText: string, vars: Record<string, string>): string {
  return sqlText.replace(/:'(\w+)'/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`Missing variable ${k}`);
    return `'${v.replace(/'/g, "''")}'`;
  });
}
