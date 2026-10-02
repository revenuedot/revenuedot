import { eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

/**
 * Experiment results (GET …/experiments/{id}/results, and the experiment emails of prd/account-settings §4): per variant,
 * customers enrolled, how many converted (any purchase or trial after enrolling), revenue after enrolling (USD), and the
 * chance that b beats a on conversion (normal approximation of two proportions). Enough data: 100 customers per variant.
 */
export const ENOUGH_CUSTOMERS = 100;

export type Experiment = typeof schema.experiments.$inferSelect;

export async function experimentResults(db: DB, x: Experiment, env: "production" | "sandbox" | string = "production") {
  const rows = await db.select().from(schema.experimentEnrollments).where(eq(schema.experimentEnrollments.experimentId, x.id));
  const tx = rows.length ? await db.select().from(schema.transactions).where(inArray(schema.transactions.customerId, rows.map((r) => r.customerId))) : [];
  const variant = (v: "a" | "b") => {
    const mine = rows.filter((r) => r.variant === v);
    let converted = 0, trials = 0, paying = 0, revenue = 0;
    for (const e of mine) {
      const after = tx.filter((t) => t.customerId === e.customerId && t.purchasedAt >= e.enrolledAt && t.isSandbox === (env === "sandbox"));
      if (after.length) converted++;
      if (after.some((t) => t.kind === "trial")) trials++;
      if (after.some((t) => t.revenueUsd > 0)) paying++;
      revenue += after.reduce((s, t) => s + t.revenueUsd, 0);
    }
    const n = mine.length;
    return {
      id: v, offering_id: v === "a" ? x.offeringA : x.offeringB, customers: n, conversions: converted, trials, paying_customers: paying,
      conversion_rate: n ? Math.round((converted / n) * 10000) / 10000 : 0, revenue: Math.round(revenue * 100) / 100, revenue_per_customer: n ? Math.round((revenue / n) * 100) / 100 : 0,
    };
  };
  const a = variant("a"), b = variant("b");
  const p = (a.conversions + b.conversions) / Math.max(1, a.customers + b.customers);
  const se = Math.sqrt(p * (1 - p) * (1 / Math.max(1, a.customers) + 1 / Math.max(1, b.customers)));
  const z = se ? (b.conversion_rate - a.conversion_rate) / se : 0;
  return { a, b, chanceBBeatsA: Math.round(normalCdf(z) * 10000) / 10000, enoughData: a.customers >= ENOUGH_CUSTOMERS && b.customers >= ENOUGH_CUSTOMERS };
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26). */
export function normalCdf(z: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
