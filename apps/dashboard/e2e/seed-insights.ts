/**
 * Attribution, benchmarks and insights demo data for the e2e server (prd/attribution-benchmarks-insights):
 * - attribution on the demo project's App Store customers, set through the REST API like a backend or MMP would;
 * - 11 peer projects (one account, bench@revenuedot.test) with 12 months of App Store history written straight to the
 *   tables, all sharing benchmarks as Health & Fitness apps. The demo project does not share: insights.spec.ts turns it on.
 * Deterministic: every run makes the same rows.
 */
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { client, session } from "./seed.ts";

const DAY = 86_400_000;

/** Attribution for the demo project's production customers (wjqx8kd2rn1 already has Apple Search Ads "fall_launch"). */
export async function seedAttribution(call: ReturnType<typeof client>, P: string) {
  const set = (user: string, attrs: Record<string, string>) => call("POST", `${P}/customers/${user}/attributes`, { attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) });
  await set("ne45gd13", { $mediaSource: "Meta", $campaign: "Spring sale", $adGroup: "US 25-34", $ad: "Video 3", $creative: "blue" });
  await set("k2aa91qe", { $mediaSource: "Meta", $campaign: "Spring sale", $adGroup: "EU broad" });
  await set("zr7m0plw", { $mediaSource: "Meta", $campaign: "Retargeting" });
  await set("pbg6xs2d", { $mediaSource: "Google Ads", $campaign: "Brand search", $keyword: "pdf scanner" });
  // An AdServices-style customer whose campaign name came with the attribution.
  await set("c1tdha8u", { $mediaSource: "Apple Search Ads", $campaign: "Brand US", $appleAdsCampaignId: "542370539", $adGroup: "Exact", $appleAdsAdGroupId: "542317095", $keyword: "scanner app" });
  await set("oliver_ios", { $mediaSource: "TikTok", $campaign: "Launch", $appsflyerId: "1690000000000-1234567" });
  await set("sofia_ios", { $mediaSource: "Apple Search Ads", $campaign: "Brand US", $appleAdsCampaignId: "542370539", $adjustId: "adj-5f1c" });
}

/** 11 peer projects that share benchmarks (Health & Fitness), each with its own conversion, churn and prices. */
export async function seedPeers(db: DB, base: string) {
  const cookie = await session(base, "bench@revenuedot.test", "e2e-password-1", "Peer app 1");
  const call = client(base, cookie);
  const projects: string[] = [];
  const me = await call<{ projects: { id: string }[] }>("GET", "/auth/me");
  projects.push(me.projects[0]!.id);
  for (let n = 2; n <= 11; n++) projects.push((await call<{ id: string }>("POST", "/v2/projects", { name: `Peer app ${n}` })).id);
  const now = Date.now();
  for (const [n, projectId] of projects.entries()) {
    await ledger(db, projectId, now, { perMonth: 14 + n * 2, trialEvery: 2 + (n % 3), convertEvery: 1 + (n % 2), monthly: 6 + n, annual: 30 + 4 * n, annualEvery: 3, refundEvery: 4 + (n % 3), android: n % 2 === 0 });
    await call("POST", `/v2/projects/${projectId}/benchmarks/settings`, { share: true, category: "health_fitness" });
  }
  return projects;
}

async function ledger(db: DB, projectId: string, nowMs: number, o: { perMonth: number; trialEvery: number; convertEvery: number; monthly: number; annual: number; annualEvery: number; refundEvery: number; android: boolean }) {
  const appId = newId("app_", 10);
  await db.insert(schema.apps).values({ id: appId, projectId, name: "iOS", type: "app_store", bundleId: `com.example.peer.${appId}`, publicKey: `appl_${appId}` });
  await db.insert(schema.products).values([
    { id: newId("prod_", 10), projectId, appId, storeIdentifier: "monthly", type: "subscription", duration: "P1M", displayName: "Monthly" },
    { id: newId("prod_", 10), projectId, appId, storeIdentifier: "annual", type: "subscription", duration: "P1Y", displayName: "Annual" },
  ]);
  const now = new Date(nowMs);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const customers: (typeof schema.customers.$inferInsert)[] = [];
  const txs: (typeof schema.transactions.$inferInsert)[] = [];
  const countries = ["US", "US", "GB", "DE", "BR"];
  let i = 0;
  for (let m = 12; m >= 0; m--) {
    const d = new Date(end); d.setUTCMonth(d.getUTCMonth() - m);
    for (let k = 0; k < o.perMonth; k++, i++) {
      const at = d.getTime() + Math.floor(((k + 0.5) / o.perMonth) * 27 * DAY);
      if (at >= nowMs) continue;
      const id = `cus_${projectId}_${i}`;
      const country = countries[i % countries.length]!;
      customers.push({ id, projectId, originalAppUserId: `peer_user_${i}`, firstSeen: new Date(at), lastSeen: new Date(at), lastSeenPlatform: o.android && i % 2 ? "Android" : "iOS", lastSeenCountry: country });
      const tx = (kind: string, t: number, days: number | null, usd: number, product: string, storeTx = `${id}-${kind}-${t}`) => txs.push({
        id: newId("txn_", 14), projectId, customerId: id, appId, store: "app_store", storeTransactionId: storeTx, productIdentifier: product, kind, isSandbox: false,
        purchasedAt: new Date(t), expiresAt: days === null ? null : new Date(t + days * DAY), revenueUsd: usd, priceAmount: usd, priceCurrency: "USD", countryCode: country,
      });
      if (i % o.trialEvery === 0) {
        tx("trial", at, 7, 0, "monthly");
        if ((i / o.trialEvery) % o.convertEvery === 0) for (let r = 0, t = at + 7 * DAY; r < 4 && t < nowMs; r++, t += 30 * DAY) tx("renewal", t, 30, o.monthly, "monthly");
      } else if (i % o.annualEvery === 0) {
        tx("purchase", at, 365, o.annual, "annual", `${id}-annual`);
        if (i % (o.annualEvery * o.refundEvery) === 0) tx("refund", at + 2 * DAY, null, -o.annual, "annual", `${id}-annual`);
      }
    }
  }
  for (let j = 0; j < customers.length; j += 500) {
    const part = customers.slice(j, j + 500);
    await db.insert(schema.customers).values(part);
    await db.insert(schema.customerAliases).values(part.map((c) => ({ projectId, appUserId: c.originalAppUserId, customerId: c.id! })));
    await db.insert(schema.customerActivity).values(part.map((c) => ({ projectId, customerId: c.id!, day: c.firstSeen!.toISOString().slice(0, 10) })));
  }
  for (let j = 0; j < txs.length; j += 500) await db.insert(schema.transactions).values(txs.slice(j, j + 500));
}
