/**
 * Makes the seeded demo project read like a real app for the README shots (docs/assets/readme): about 360 App Store
 * subscription chains over the last 120 days through the server's own purchase pipeline, like e2e/server.ts does for
 * its dozen seeded people. Run it against the e2e server's file-backed PGlite while the server is stopped (PGlite
 * allows one process at a time); see README.md in this folder for the order of operations.
 *   E2E_DATABASE_URL=pglite://<dir> npx tsx e2e/readme-assets/enrich.ts
 */
import { openDb, schema } from "@revenuedot/db";
import { getOrCreateCustomer, touch } from "@revenuedot/server/repo/customers.js";
import { applyPurchases } from "@revenuedot/server/services/purchases.js";
import type { VerifiedPurchase } from "@revenuedot/server/stores/types.js";
import { and, eq, sql } from "drizzle-orm";

const DAY = 86400_000;
const { db, close } = await openDb(process.env.E2E_DATABASE_URL!, { migrate: false });
const projectId = (await db.select().from(schema.projects).where(eq(schema.projects.name, "Scanner")))[0]!.id;
const ios = (await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.type, "app_store"))))[0]!;
console.log("project", projectId, "ios app", ios.id);

// Deterministic PRNG so a rerun on a fresh database gives the same numbers.
let seed = 20261003;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
const hex = (n: number) => Array.from({ length: n }, () => "0123456789ABCDEF"[Math.floor(rnd() * 16)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

const products: Record<string, { duration: string; price: number }> = {
  "scanner.pro.weekly": { duration: "P1W", price: 4.99 },
  "scanner.pro.monthly": { duration: "P1M", price: 9.99 },
  "scanner.pro.yearly": { duration: "P1Y", price: 39.99 },
};
const add = (d: Date, iso: string) => { const x = new Date(d); const n = Number(iso.slice(1, -1)); const u = iso.slice(-1); if (u === "W") x.setUTCDate(x.getUTCDate() + 7 * n); else if (u === "D") x.setUTCDate(x.getUTCDate() + n); else if (u === "M") x.setUTCMonth(x.getUTCMonth() + n); else x.setUTCFullYear(x.getUTCFullYear() + n); return x; };
const countries = ["US", "US", "US", "US", "GB", "DE", "CA", "AU", "FR", "BR", "JP", "MX", "IN", "ES", "IT", "NL", "SE", "KR"];
const versions = ["3.4.1", "3.4.1", "3.4.0", "3.3.2", "3.5.0"];

type Step = { at: Date; sub: Partial<VerifiedPurchase> & Record<string, unknown> };
async function chain(user: string, sid: string, start: Date, o: { trial: boolean; periods: number; country: string; cancelAt?: Date; refundAfter?: number; billingIssue?: boolean; lastSeen: Date }) {
  const prod = products[sid]!;
  const key = `2000000${Math.floor(rnd() * 1e9)}`;
  const { customer } = await getOrCreateCustomer(db, projectId, user, start);
  await touch(db, customer.id, start, { platform: "iOS", appVersion: pick(versions), country: o.country });
  const steps: Step[] = [];
  let periodStart = start, n = 0;
  const base = { kind: "subscription", store: "app_store", storeKey: key, productIdentifier: sid, isSandbox: false, originalPurchaseDate: start, originalTransactionId: key, countryCode: o.country } as const;
  if (o.trial) {
    const end = add(start, "P7D");
    steps.push({ at: start, sub: { ...base, purchaseDate: start, expiresDate: end, periodType: "trial", storeTransactionId: `${key}0`, price: { amount: 0, currency: "USD" } } });
    periodStart = end;
  }
  for (let i = 0; i < o.periods; i++) {
    const end = add(periodStart, prod.duration);
    if (periodStart.getTime() > Date.now()) break;
    n++;
    steps.push({ at: periodStart, sub: { ...base, purchaseDate: periodStart, expiresDate: end, periodType: "normal", storeTransactionId: `${key}${n}`, price: { amount: prod.price, currency: "USD" } } });
    periodStart = end;
  }
  let last = steps[steps.length - 1]!;
  for (const s of steps) await applyPurchases(db, customer, [s.sub as VerifiedPurchase], { projectId, appId: ios.id, appUserId: user, now: s.at, fromDevice: false });
  if (o.cancelAt && o.cancelAt.getTime() > last.at.getTime() && o.cancelAt.getTime() < Date.now()) {
    await applyPurchases(db, customer, [{ ...last.sub, unsubscribeDetectedAt: o.cancelAt } as VerifiedPurchase], { projectId, appId: ios.id, appUserId: user, now: o.cancelAt, fromDevice: false });
    last = { ...last, sub: { ...last.sub, unsubscribeDetectedAt: o.cancelAt } };
  }
  if (o.refundAfter !== undefined) { const at = new Date(last.at.getTime() + o.refundAfter * DAY); if (at.getTime() < Date.now()) await applyPurchases(db, customer, [{ ...last.sub, refundedAt: at } as VerifiedPurchase], { projectId, appId: ios.id, appUserId: user, now: at, fromDevice: false }); }
  if (o.billingIssue) { const at = new Date((last.sub.expiresDate as Date).getTime() + 3600_000); if (at.getTime() < Date.now()) await applyPurchases(db, customer, [{ ...last.sub, billingIssuesDetectedAt: at, gracePeriodExpiresDate: new Date(at.getTime() + 16 * DAY) } as VerifiedPurchase], { projectId, appId: ios.id, appUserId: user, now: at, fromDevice: false }); }
  if (o.lastSeen.getTime() < Date.now()) await touch(db, customer.id, o.lastSeen, { platform: "iOS", appVersion: pick(versions), country: o.country });
}

if (process.env.BACKDATE === "1") {
  // After prep.mjs and xp-more.mjs: the experiment's customers all joined today, so spread their first visit over
  // the last 27 days and the Overview's New customers card ramps instead of spiking.
  const r = await db.execute(sql`update customers set first_seen = now() - (floor(random() * 27) || ' days')::interval - (floor(random() * 86400) || ' seconds')::interval, last_seen = now() - (floor(random() * 5) || ' days')::interval where first_seen > now() - interval '3 hours' and original_app_user_id like '$RCAnonymousID:%'`);
  console.log("backdated", (r as any).rowCount ?? (r as any).affectedRows);
  await close();
  process.exit(0);
}

const N = Number(process.env.N ?? 360);
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  // Sign-ups ramp up over the last 120 days (more recent ones), with a few older cohorts.
  const agoDays = Math.floor(120 * Math.pow(rnd(), 1.6)) + rnd() * 0.9;
  const start = new Date(Date.now() - agoDays * DAY);
  const sid = pick(["scanner.pro.weekly", "scanner.pro.weekly", "scanner.pro.monthly", "scanner.pro.monthly", "scanner.pro.monthly", "scanner.pro.yearly", "scanner.pro.yearly"]);
  const trial = rnd() < 0.6;
  const r = rnd();
  // Of trials: 32% never convert; of paying: churn after a few periods, a few refunds and billing issues.
  const converts = !trial || r > 0.32;
  const periods = !converts ? 0 : sid === "scanner.pro.weekly" ? Math.floor(1 + rnd() * 18) : sid === "scanner.pro.monthly" ? Math.floor(1 + rnd() * 5) : 1;
  const churn = converts && rnd() < 0.22;
  const cancelAt = churn ? new Date(start.getTime() + (rnd() * agoDays) * DAY) : undefined;
  const refundAfter = converts && rnd() < 0.03 ? Math.floor(rnd() * 3) : undefined;
  const billingIssue = converts && rnd() < 0.04;
  const country = pick(countries);
  const user = rnd() < 0.7 ? `$RCAnonymousID:${uuid().toLowerCase().replace(/-/g, "")}` : `user_${hex(8).toLowerCase()}`;
  const lastSeen = new Date(Date.now() - (churn ? 10 + rnd() * 40 : rnd() * 9) * DAY);
  await chain(user, sid, start, { trial, periods, country, cancelAt, refundAfter, billingIssue, lastSeen });
  if (i % 60 === 0) console.log(`${i}/${N} (${Math.round((Date.now() - t0) / 1000)}s)`);
}
console.log("done", N, "customers in", Math.round((Date.now() - t0) / 1000), "s");
await close();
