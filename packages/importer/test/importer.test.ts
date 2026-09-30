// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: end-to-end tests of `revenuedot import` against a fake RevenueCat and the real RevenueDot server.
// Docs: https://revenuedot.app/docs/migrate
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { main } from "../src/cli.js";
import { buildPlan, formatPlan } from "../src/plan.js";
import { RevenueCatClient } from "../src/revenuecat.js";
import { RevenueDotClient } from "../src/revenuedot.js";
import { loadState } from "../src/state.js";
import { verifyImport } from "../src/verify.js";
import { ANON, DAY, PROJECT, T0, TOKENS_CSV } from "./fixtures.js";
import { RC_KEY, TARGET, bridge, dump, serveHarness, setup, spec, type Env } from "./helpers.js";

let e: Env | undefined;
afterEach(async () => { await e?.close(); e = undefined; });

const verify = (env: Env, over: { limit?: number } = {}) => {
  const rc = new RevenueCatClient({ apiKey: RC_KEY, projectId: PROJECT, baseUrl: env.rc.url, http: { sleep: async () => {} } });
  const rd = new RevenueDotClient({ url: TARGET, apiKey: env.h.ids.secretKey, http: { fetch: bridge(env.h) } });
  return rd.project().then(() => verifyImport(rc, rd, { concurrency: 3, ...over }));
};
const subOf = async (env: Env, appUserId: string) => {
  const [a] = await env.h.db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, appUserId));
  return env.h.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.customerId, a!.customerId));
};

describe("revenuedot import", () => {
  it("brings over the catalog, SDK keys and every customer without events, and verify finds no differences", async () => {
    e = await setup();
    // A device already reached RevenueDot with the anonymous id before the import.
    await e.h.fetch(`/v1/subscribers/${encodeURIComponent(ANON)}`);
    e.rc.maxPage = 4;
    const r = await e.run();

    // Every response the fake served matched RevenueCat's published response schema for that operation.
    expect(e.rc.schemaErrors).toEqual([]);
    if (spec) {
      expect([...spec.checked]).toEqual(expect.arrayContaining([
        "GET /v2/projects/{project_id}/apps 200", "GET /v2/projects/{project_id}/apps/{app_id}/public_api_keys 200",
        "GET /v2/projects/{project_id}/offerings/{offering_id}/packages 200", "GET /v2/projects/{project_id}/customers 200",
        "GET /v2/projects/{project_id}/customers/{customer_id} 200", "GET /v2/projects/{project_id}/customers/{customer_id}/subscriptions 200",
        "GET /v2/projects/{project_id}/customers/{customer_id}/purchases 200", "GET /v2/projects/{project_id}/subscriptions/{subscription_id}/transactions 200",
      ]));
    }
    expect(r.catalog.apps).toEqual({ created: 2, matched: 3, updated: 0 });
    expect(r.catalog.publicKeys.updated).toBe(3);
    expect(r.catalog.products).toMatchObject({ created: 5, matched: 4 });
    expect(r.catalog.entitlements).toMatchObject({ created: 1, matched: 1 });
    expect(r.catalog.offerings).toMatchObject({ created: 1, matched: 1 });
    expect(r.customers).toMatchObject({ pass: 1, complete: true, imported: 14, created: 13, subscriptions: 9, purchases: 2, needsTokenRefresh: 1, pages: 4 });

    const db = e.h.db;
    const apps = await db.select().from(schema.apps);
    expect(apps.find((a) => a.id === "app_ios")!.publicKey).toBe("appl_RCiosShippedKey");
    expect(apps.find((a) => a.bundleId === "com.example.scannerpro")).toMatchObject({ type: "app_store", publicKey: "appl_RCnewShippedKey" });
    expect(apps.find((a) => a.type === "stripe")).toMatchObject({ name: "Scanner Web" });
    const offerings = await db.select().from(schema.offerings);
    expect(offerings.find((o) => o.lookupKey === "sale")).toMatchObject({ isCurrent: true, metadata: { discount: 50, headline: "Half price" } });
    expect(offerings.find((o) => o.lookupKey === "default")!.isCurrent).toBe(false);
    const pkgs = await db.select().from(schema.packages);
    expect(pkgs.map((p) => p.lookupKey).sort()).toEqual(["$rc_annual", "$rc_annual", "$rc_lifetime", "$rc_monthly"]);
    const old = (await db.select().from(schema.products)).find((p) => p.storeIdentifier === "old_monthly");
    expect(old!.state).toBe("inactive");

    // Credentials cannot be exported: the report names every app that needs them.
    const creds = r.problems.filter((p) => p.kind === "credentials").map((p) => p.message);
    expect(creds.some((m) => m.startsWith("Scanner iOS (app_store, com.example.scanner)") && m.includes("cannot be exported"))).toBe(true);
    expect(creds.some((m) => m.startsWith("Scanner Pro iOS"))).toBe(true);
    expect(creds.some((m) => m.startsWith("Scanner Android (play_store"))).toBe(true);
    expect(creds.some((m) => m.startsWith("Scanner Web (stripe"))).toBe(true);

    // Customers: dates, keys and access as in RevenueCat, and no lifecycle events.
    const [apple] = await subOf(e, "user_apple");
    expect(apple).toMatchObject({ store: "app_store", storeKey: "2000000001", storeTransactionId: "2000000003", appId: "app_ios", originalPurchaseDate: new Date(T0 - 65 * DAY) });
    expect((await db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, ANON)))[0]!.customerId).toBe(apple!.customerId);
    expect((await subOf(e, "user_play_token"))[0]).toMatchObject({ storeKey: "tok_play_1", productIdentifier: "pro", productPlanIdentifier: "monthly" });
    expect((await subOf(e, "user_play_notoken"))[0]!.storeKey).toBe("needs_token_refresh:GPA.5555-6666-7777-88888");
    expect((await subOf(e, "user_grace"))[0]).toMatchObject({ gracePeriodExpiresDate: new Date(T0 + 5 * DAY), billingIssuesDetectedAt: new Date(T0 - DAY) });
    expect((await subOf(e, "user_promo"))[0]).toMatchObject({ store: "promotional", entitlementIdentifier: "extra" });
    const [cust] = await db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, "user_expired"));
    expect(cust!.firstSeen).toEqual(new Date(T0 - 500 * DAY));
    expect(await db.select().from(schema.events)).toEqual([]);
    expect(existsSync(e.statePath)).toBe(true);

    const v = await verify(e);
    expect(v.mismatches).toEqual([]);
    expect(v.customers).toEqual({ revenuecat: 14, revenuedot: 14, checked: 14 });
    expect(v.activeSubscriptions).toEqual({ revenuecat: 8, revenuedot: 8 });
    expect(v.activeEntitlements).toEqual({ revenuecat: 9, revenuedot: 9 });
  });

  it("is idempotent: a second run, and a run from scratch, leave the database unchanged", async () => {
    e = await setup();
    await e.run();
    const before = await dump(e.h.db);
    const again = await e.run();
    expect(again.customers).toMatchObject({ pass: 2, complete: true, imported: 14, created: 0 });
    expect(await dump(e.h.db)).toEqual(before);
    await e.run({ restart: true });
    expect(await dump(e.h.db)).toEqual(before);
  });

  it("waits out 429 rate limits for the time in Retry-After", async () => {
    e = await setup();
    e.rc.rateLimit("/v2/projects/{project_id}/customers", 2, 3);
    e.rc.rateLimit("/v2/projects/{project_id}/customers/{customer_id}/subscriptions", 1, 1);
    const r = await e.run();
    expect(r.customers.imported).toBe(14);
    expect(e.sleeps.filter((ms) => ms === 3000)).toHaveLength(2);
    expect(e.sleeps).toContain(1000);
    expect(e.rc.schemaErrors).toEqual([]);
  });

  it("resumes after a failure at the page that failed, without refetching finished pages", async () => {
    e = await setup();
    e.rc.maxPage = 3;
    const clear = e.rc.fail("/v2/projects/{project_id}/customers/{customer_id}/subscriptions", (r) => r.path.includes("user_stripe"));
    await expect(e.run()).rejects.toThrow(/500/);
    const saved = loadState(e.statePath)!;
    expect(saved.customers).toMatchObject({ after: "user_lifetime", imported: 6, complete: false });
    expect(await e.h.db.select().from(schema.customers)).toHaveLength(6);

    clear();
    const fetchedBefore = e.rc.requests.filter((r) => r.path.endsWith("/customers/user_apple")).length;
    const r = await e.run();
    expect(r.customers).toMatchObject({ pass: 1, imported: 14, complete: true });
    expect(e.rc.requests.filter((r) => r.path.endsWith("/customers/user_apple")).length).toBe(fetchedBefore);
    expect(await e.h.db.select().from(schema.customers)).toHaveLength(14);
    expect((await verify(e)).mismatches).toEqual([]);
  });

  it("dry run reads everything and writes nothing", async () => {
    e = await setup();
    const before = await dump(e.h.db);
    const r = await e.run({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.catalog.apps).toMatchObject({ created: 2, matched: 3 });
    expect(r.customers).toMatchObject({ imported: 14, subscriptions: 9, purchases: 2 });
    expect(r.googleWithoutToken).toBe(1);
    expect(await dump(e.h.db)).toEqual(before);
    expect(existsSync(e.statePath)).toBe(false);
  });

  it("verify reports customers whose access differs, and missing customers", async () => {
    e = await setup();
    await e.run();
    const m = e.rc.model;
    const find = (id: string) => m.customers.find((c) => c.id === id)!;
    // RevenueCat now says: user_expired resubscribed; user_apple renewed further; a brand-new customer appeared.
    find("user_expired").active = [{ object: "customer.active_entitlement", entitlement_id: "entl_pro", expires_at: T0 + 10 * DAY }];
    find("user_expired").subscriptions[0]!.gives_access = true;
    find("user_apple").active = [{ object: "customer.active_entitlement", entitlement_id: "entl_pro", expires_at: T0 + 55 * DAY }];
    m.customers.push({ ...find("user_plain_1"), id: "user_late", aliases: [] });
    const v = await verify(e);
    expect(v.mismatchedCustomers).toBe(3);
    expect(v.mismatches.map((x) => [x.customer, x.kind])).toEqual([
      ["user_apple", "entitlement_expiry"],
      ["user_expired", "active_subscriptions"],
      ["user_expired", "entitlement_only_in_revenuecat"],
      ["user_late", "missing_customer"],
    ]);
    expect(v.customers).toMatchObject({ revenuecat: 15, revenuedot: 14 });
  });

  it("plan prints the cutover steps with this project's notification URLs and missing credentials", async () => {
    e = await setup();
    await e.run();
    const rd = new RevenueDotClient({ url: TARGET, apiKey: e.h.ids.secretKey, http: { fetch: bridge(e.h) } });
    const text = formatPlan(await buildPlan(rd, { to: "https://rd.example.com", rcProject: PROJECT }));
    expect(text).toContain("https://rd.example.com/v1/notifications/apple/app_ios");
    expect(text).toContain("https://rd.example.com/v1/notifications/google/app_play");
    expect(text).toContain("notification_forward_url");
    expect(text).toContain("1 Google Play subscriptions have no purchase token yet");
    expect(text).toMatch(/Scanner Pro iOS \(app_store, com\.example\.scannerpro, app id app\w+\): the App Store In-App Purchase key/);
    expect(text).toContain('Purchases.proxyURL = URL(string: "https://rd.example.com")!');
  });

  it("plan gives the proxy line for all nine RevenueCat SDKs, without a trailing slash (purchases-js rejects one)", async () => {
    e = await setup();
    const rd = new RevenueDotClient({ url: TARGET, apiKey: e.h.ids.secretKey, http: { fetch: bridge(e.h) } });
    const text = formatPlan(await buildPlan(rd, { to: "https://rd.example.com/", rcProject: PROJECT }));
    for (const line of [
      '- iOS (Swift): Purchases.proxyURL = URL(string: "https://rd.example.com")!',
      '- Android (Kotlin): Purchases.proxyURL = URL("https://rd.example.com")',
      '- React Native: await Purchases.setProxyURL("https://rd.example.com")',
      '- Flutter: await Purchases.setProxyURL("https://rd.example.com");',
      '- Web (purchases-js): Purchases.configure({ apiKey, appUserId, httpConfig: { proxyURL: "https://rd.example.com" }, flags: { collectAnalyticsEvents: false } })',
      '- Capacitor: await Purchases.setProxyURL({ url: "https://rd.example.com" });',
      '- Kotlin Multiplatform: Purchases.proxyURL = "https://rd.example.com"',
      '- Unity: on the Purchases component, set Proxy URL (under Advanced) to https://rd.example.com',
      '- Cordova: Purchases.setProxyURL("https://rd.example.com");',
    ]) expect(text).toContain(line);
    expect(text).not.toContain("https://rd.example.com/\"");
  });
});

describe("the revenuedot command", () => {
  it("imports, verifies and plans over real HTTP, with usage errors as exit code 2", async () => {
    e = await setup();
    const server = await serveHarness(e.h);
    const dir = mkdtempSync(join(tmpdir(), "rd-cli-"));
    const csv = join(dir, "tokens.csv");
    writeFileSync(csv, TOKENS_CSV);
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: { REVENUEDOT_API_KEY: e.h.ids.secretKey } };
    const common = ["--rc-key", RC_KEY, "--rc-project", PROJECT, "--rc-url", e.rc.url, "--to", server.url];
    try {
      expect(await main(["import", "--from-revenuecat", ...common, "--state", join(dir, "s.json"), "--google-tokens", csv], io)).toBe(0);
      const report = out.join("\n");
      expect(report).toContain("Import finished");
      expect(report).toContain("14 customers imported (14 new, 0 merged with existing ones)");
      expect(report).toContain("Store credentials to re-enter in RevenueDot");
      expect(report).toContain("1 Google Play subscriptions need a purchase token");
      expect(err.some((l) => l.startsWith("customers: 14 imported"))).toBe(true);

      out.length = 0;
      expect(await main(["import", "verify", ...common], io)).toBe(0);
      expect(out.join("\n")).toContain("No differences: 14 customers match.");

      out.length = 0;
      expect(await main(["import", "plan", "--to", server.url], io)).toBe(0);
      expect(out.join("\n")).toContain(`${server.url}/v1/notifications/apple/app_ios`);

      expect(await main(["import", "--rc-project", PROJECT], { ...io, env: {} })).toBe(2);
      expect(await main(["import", ...common.slice(2), "--rc-key", "appl_public"], io)).toBe(2);
      expect(await main(["import", "--dry-run", ...common, "--json"], io)).toBe(0);
      expect(JSON.parse(out[out.length - 1]!)).toMatchObject({ dryRun: true, customers: { imported: 14 } });
    } finally {
      await server.close();
    }
  });
});
