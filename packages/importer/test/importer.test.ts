// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: end-to-end tests of `revenuedot import` against a fake RevenueCat and the real RevenueDot server.
// Docs: https://revenuedot.app/docs/migrate
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { main, readIds } from "../src/cli.js";
import { PromptCancelled } from "../src/prompt.js";
import { buildPlan, formatPlan } from "../src/plan.js";
import { RevenueCatClient } from "../src/revenuecat.js";
import { RevenueDotClient } from "../src/revenuedot.js";
import { loadState } from "../src/state.js";
import { verifyImport } from "../src/verify.js";
import { formatReport } from "../src/run.js";
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
    // The customer a device created before the import is counted, not lost from the report.
    expect(formatReport(r)).toContain("14 customers imported (13 new, 1 already in RevenueDot)");

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
    expect(v.customers).toEqual({ revenuecat: 14, revenuedot: 14, checked: 14, missingInRevenueDot: 0, onlyInRevenueDot: 0, notListedByRevenueCat: 0 });
    expect(v.activeSubscriptions).toEqual({ revenuecat: 8, revenuedot: 8 });
    expect(v.activeEntitlements).toEqual({ revenuecat: 9, revenuedot: 9 });
  });

  it("is idempotent: a second run, and a run from scratch, leave the database unchanged", async () => {
    e = await setup();
    await e.run();
    const before = await dump(e.h.db);
    const again = await e.run();
    expect(again.customers).toMatchObject({ pass: 2, complete: true, imported: 14, created: 0 });
    expect(formatReport(again)).toContain("14 customers imported (0 new, 14 already in RevenueDot)");
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
    // Deleted in RevenueCat after the import: RevenueDot keeps it, and verify names it.
    m.customers = m.customers.filter((c) => c.id !== "user_plain_1");
    const v = await verify(e);
    expect(v.mismatchedCustomers).toBe(3);
    expect(v.mismatches.map((x) => [x.customer, x.kind])).toEqual([
      ["user_apple", "entitlement_expiry"],
      ["user_expired", "active_subscriptions"],
      ["user_expired", "entitlement_only_in_revenuecat"],
      ["user_late", "missing_customer"],
    ]);
    expect(v.customers).toMatchObject({ revenuecat: 14, revenuedot: 14, checked: 14, missingInRevenueDot: 1, onlyInRevenueDot: 1 });
    expect(v.onlyInRevenueDot).toEqual(["user_plain_1"]);
  });

  it("verify checks each customer once while RevenueCat's list order shifts under it", async () => {
    e = await setup();
    await e.run();
    const m = e.rc.model;
    e.rc.maxPage = 3;
    // Live activity: the first customer of each page served becomes the most recent and moves to the end of the list,
    // so a walk with starting_after meets it again.
    let shifts = 0;
    e.rc.onList = (template, items) => {
      if (!template.endsWith("/customers") || shifts++ >= 4 || !items.length) return;
      const i = m.customers.findIndex((c) => c.id === items[0]!.id);
      m.customers.push(...m.customers.splice(i, 1));
    };
    const reads = () => e!.rc.requests.filter((r) => /\/customers\/[^/]+$/.test(r.path)).length;
    const before = reads();
    const v = await verify(e);
    expect(v.customers).toEqual({ revenuecat: 14, revenuedot: 14, checked: 14, missingInRevenueDot: 0, onlyInRevenueDot: 0, notListedByRevenueCat: 0 });
    expect(v.mismatches).toEqual([]);
    expect(shifts).toBeGreaterThan(1);
    // One read per customer, though the walk met some of them twice.
    expect(reads() - before).toBe(14);
  });

  it("verify checks a RevenueDot customer RevenueCat's list leaves out by id, and counts it as RevenueCat's", async () => {
    e = await setup();
    await e.run();
    const m = e.rc.model;
    e.rc.unlisted.add("user_apple");
    m.customers.find((c) => c.id === "user_apple")!.active = [{ object: "customer.active_entitlement", entitlement_id: "entl_pro", expires_at: T0 + 55 * DAY }];
    const v = await verify(e);
    expect(v.customers).toEqual({ revenuecat: 14, revenuedot: 14, checked: 14, missingInRevenueDot: 0, onlyInRevenueDot: 0, notListedByRevenueCat: 1 });
    expect(v.mismatches.map((x) => [x.customer, x.kind])).toEqual([["user_apple", "entitlement_expiry"]]);
  });

  it("a customer RevenueCat's list order moves behind the cursor during the walk is imported by the catch-up", async () => {
    e = await setup();
    const m = e.rc.model;
    e.rc.maxPage = 4;
    const last = m.customers[m.customers.length - 1]!.id;
    let moved = false;
    e.rc.onList = (template) => {
      if (moved || !template.endsWith("/customers")) return;
      moved = true;
      m.customers.unshift(...m.customers.splice(m.customers.length - 1, 1));
    };
    const r = await e.run();
    expect(r.customers).toMatchObject({ pass: 1, imported: 14, caughtUp: 1, complete: true });
    expect(formatReport(r)).toContain("1 of them imported at the end");
    const [a] = await e.h.db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, last));
    expect(a).toBeDefined();
    expect((await verify(e)).mismatches).toEqual([]);
    // The next pass finds nothing to catch up.
    const again = await e.run();
    expect(again.customers).toMatchObject({ pass: 2, imported: 14, complete: true });
    expect(again.customers.caughtUp ?? 0).toBe(0);
  });

  it("--ids imports exactly the given customers by id, even ones RevenueCat's list leaves out, without touching the state file", async () => {
    e = await setup();
    e.rc.unlisted.add("user_apple");
    e.rc.unlisted.add("user_grace");
    const r = await e.run({ ids: ["user_apple", "user_grace", "user_apple", "nobody"] });
    expect(r.requestedIds).toBe(3);
    expect(r.customers).toMatchObject({ imported: 2 });
    expect(r.problems).toContainEqual({ kind: "skipped", message: "nobody: not found in RevenueCat" });
    expect(formatReport(r)).toContain("Customers (by id: 3 requested)");
    expect(existsSync(e.statePath)).toBe(false);
    const ids = (await e.h.db.select().from(schema.customerAliases)).map((a) => a.appUserId);
    expect(ids).toEqual(expect.arrayContaining(["user_apple", "user_grace"]));
    expect(await e.h.db.select().from(schema.customers)).toHaveLength(2);
    // Running it again changes nothing.
    const before = await dump(e.h.db);
    await e.run({ ids: ["user_apple", "user_grace"] });
    expect(await dump(e.h.db)).toEqual(before);
  });

  it("readIds takes a JSON id array, verify's mismatches, or one id per line", () => {
    expect(readIds('["a","b"]')).toEqual(["a", "b"]);
    expect(readIds('[{"customer":"a","kind":"missing_customer"},{"id":"b"}]')).toEqual(["a", "b"]);
    expect(readIds("a\n\n b \r\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("readIds takes the report `import verify --json` writes: the customers a re-import fixes, never onlyInRevenueDot", () => {
    // Same shape and pretty-printing as the real SuperScan report of 2026-10-02, with made-up ids.
    const text = readFileSync(new URL("./verify-report.json", import.meta.url), "utf8");
    expect(readIds(text)).toEqual([
      "13QLxxxxxxxxxxxxxxxxxxxxxx32",
      "328BE39F-0000-4E84-9D99-000000000000",
      "$RCAnonymousID:00000000000000000000000000000001",
      "late-renewal",
      "renewed-further",
    ]);
    expect(readIds(JSON.stringify({ ...JSON.parse(text), mismatches: [] }))).toEqual([]);
  });

  it("readIds rejects JSON it cannot read instead of treating each line as an id", () => {
    expect(() => readIds('{\n  "customers": {\n')).toThrow(/--ids: the file is not valid JSON/);
    expect(() => readIds('[\n  "a",\n')).toThrow(/--ids: the file is not valid JSON/);
    expect(() => readIds('{"customers": {}}')).toThrow(/no mismatches array/);
  });

  it("import --ids takes the file import verify --json wrote and fixes every re-importable mismatch", async () => {
    e = await setup();
    const server = await serveHarness(e.h);
    const dir = mkdtempSync(join(tmpdir(), "rd-cli-"));
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: { REVENUEDOT_API_KEY: e.h.ids.secretKey } };
    const common = ["--rc-key", RC_KEY, "--rc-project", PROJECT, "--rc-url", e.rc.url, "--to", server.url];
    try {
      expect(await main(["import", "--from-revenuecat", ...common, "--state", join(dir, "s.json")], io)).toBe(0);
      const m = e.rc.model;
      const find = (id: string) => m.customers.find((c) => c.id === id)!;
      // user_expired resubscribed in RevenueCat after the import; user_late is new; user_plain_1 was deleted there.
      const until = T0 + 10 * DAY;
      const s = find("user_expired").subscriptions[0]!;
      find("user_expired").active = [{ object: "customer.active_entitlement", entitlement_id: "entl_pro", expires_at: until }];
      Object.assign(s, { gives_access: true, status: "active", auto_renewal_status: "will_renew", current_period_starts_at: T0 - 20 * DAY, current_period_ends_at: until, ends_at: until });
      s.transactions!.push({ ...s.transactions![0]!, id: "3000000002", purchased_at: T0 - 20 * DAY, expiration_date: until, effective_expiration_date: until });
      m.customers.push({ ...find("user_plain_2"), id: "user_late", aliases: [] });
      m.customers = m.customers.filter((c) => c.id !== "user_plain_1");

      out.length = 0;
      expect(await main(["import", "verify", ...common, "--json"], io)).toBe(1);
      const file = join(dir, "verify.json");
      writeFileSync(file, out.join("\n"));
      const written = JSON.parse(readFileSync(file, "utf8"));
      expect(written.mismatches.map((x: { customer: string; kind: string }) => [x.customer, x.kind])).toEqual([
        ["user_expired", "active_subscriptions"],
        ["user_expired", "entitlement_only_in_revenuecat"],
        ["user_late", "missing_customer"],
      ]);
      expect(written.onlyInRevenueDot).toEqual(["user_plain_1"]);
      expect(readIds(readFileSync(file, "utf8"))).toEqual(["user_expired", "user_late"]);

      out.length = 0;
      expect(await main(["import", "--from-revenuecat", ...common, "--ids", file, "--json"], io)).toBe(0);
      const r = JSON.parse(out[out.length - 1]!);
      expect(r.requestedIds).toBe(2);
      expect(r.customers).toMatchObject({ imported: 2 });
      expect(r.problems.filter((p: { kind: string }) => p.kind === "skipped")).toEqual([]);

      out.length = 0;
      const code = await main(["import", "verify", ...common, "--json"], io);
      expect(JSON.parse(out.join("\n")).mismatches).toEqual([]);
      expect(code).toBe(0);

      const bad = join(dir, "bad.json");
      writeFileSync(bad, '{\n  "customers": {\n');
      err.length = 0;
      expect(await main(["import", "--from-revenuecat", ...common, "--ids", bad], io)).toBe(2);
      expect(err.join("\n")).toContain("--ids: the file is not valid JSON");

      const clean = join(dir, "clean.json");
      writeFileSync(clean, out.join("\n"));
      err.length = 0;
      expect(await main(["import", "--from-revenuecat", ...common, "--ids", clean], io)).toBe(0);
      expect(err.join("\n")).toContain("lists no customers to import");
    } finally {
      await server.close();
    }
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
    // Printed commands carry no keys: the CLI asks for them, so they stay out of shell history.
    expect(text).toContain(`Run: npx revenuedot import --from-revenuecat --rc-project ${PROJECT} --to https://rd.example.com (it asks for both secret keys)`);
    expect(text).toContain(`npx revenuedot import verify --rc-project ${PROJECT} --to https://rd.example.com`);
    expect(text).not.toMatch(/--rc-key|--to-key/);
  });
});

describe("the revenuedot command", () => {
  it("asks RevenueCat for pages of 50 by default; a page that times out stops with advice to use a smaller --page-size", async () => {
    e = await setup();
    await e.run({ limit: 1, dryRun: true });
    expect(e.rc.requests.find((r) => r.template === "/v2/projects/{project_id}/customers")!.query.get("limit")).toBe("50");

    // The server takes longer than the client waits for any page of more than 4 customers.
    const base = bridge(e.h);
    let importCalls = 0;
    const slow: typeof base = async (url, init) => {
      if (url.endsWith("/import/customers")) {
        importCalls++;
        if (JSON.parse(String(init?.body)).customers.length > 4) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return base(url, init);
    };
    const target = { fetch: slow, sleep: async () => {}, timeoutMs: 60_000 };
    await expect(e.run({ targetHttp: target })).rejects.toThrow("RevenueDot did not finish importing a page of 14 customers within 60 s. Run the same command again with --page-size 7: it resumes at this page.");
    expect(importCalls).toBe(2);
    expect(loadState(e.statePath)!.customers).toMatchObject({ imported: 0, complete: false });
    const r = await e.run({ targetHttp: target, pageSize: 4 });
    expect(r.customers).toMatchObject({ imported: 14, complete: true, pages: 4 });
    expect((await verify(e)).mismatches).toEqual([]);
  });

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
      expect(report).toContain("14 customers imported (14 new, 0 already in RevenueDot)");
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
      err.length = 0;
      expect(await main(["import", ...common, "--page-size", "101"], io)).toBe(1);
      expect(err.join("\n")).toContain("--page-size must be 100 or less");
      expect(await main(["import", ...common.slice(2), "--rc-key", "appl_public"], io)).toBe(2);
      expect(await main(["import", "--dry-run", ...common, "--json"], io)).toBe(0);
      expect(JSON.parse(out[out.length - 1]!)).toMatchObject({ dryRun: true, customers: { imported: 14 } });
    } finally {
      await server.close();
    }
  });

  it("asks for missing keys on a terminal with hidden input, and never prints them", async () => {
    e = await setup();
    const server = await serveHarness(e.h);
    const dir = mkdtempSync(join(tmpdir(), "rd-cli-"));
    const rdKey = e.h.ids.secretKey;
    const RC_Q = "RevenueCat secret API key (v2, sk_...): ";
    const RD_Q = "RevenueDot secret API key for the target project: ";
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    let answers: (string | Error)[] = [];
    const prompt = async (q: string, o: { hidden: boolean }) => {
      asked.push(q);
      expect(o.hidden).toBe(true);
      const a = answers.shift();
      if (a === undefined || a instanceof Error) throw a ?? new Error("unexpected prompt");
      return a;
    };
    const tty = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {}, prompt };
    const base = ["--rc-project", PROJECT, "--rc-url", e.rc.url, "--to", server.url];
    const dryRun = ["import", "--from-revenuecat", ...base, "--state", join(dir, "s.json"), "--dry-run"];
    const reset = (next: (string | Error)[]) => { asked.length = 0; answers = next; };
    try {
      // Both keys missing on a terminal: asked for in order, then the import runs.
      reset([RC_KEY, rdKey]);
      expect(await main(dryRun, tty)).toBe(0);
      expect(asked).toEqual([RC_Q, RD_Q]);
      expect(out.join("\n")).toContain("Dry run: nothing was written to RevenueDot.");

      // plan needs only the RevenueDot key.
      reset([rdKey]);
      expect(await main(["import", "plan", "--to", server.url], tty)).toBe(0);
      expect(asked).toEqual([RD_Q]);

      // A flag or an environment variable skips the prompt.
      reset([]);
      // (verify runs and finds differences: the dry run above wrote nothing.)
      expect(await main(["import", "verify", "--rc-key", RC_KEY, ...base], { ...tty, env: { REVENUEDOT_API_KEY: rdKey } })).toBe(1);
      expect(out.join("\n")).toContain("Differences found");
      expect(await main(["import", "plan", "--to", server.url, "--to-key", rdKey], tty)).toBe(0);
      expect(await main(["import", "plan", "--to", server.url], { ...tty, env: { REVENUEDOT_API_KEY: rdKey } })).toBe(0);
      expect(asked).toEqual([]);

      // A public SDK key or an empty answer is refused and asked again; three bad answers end with a usage error.
      reset(["appl_public", "", RC_KEY, rdKey]);
      err.length = 0;
      expect(await main(dryRun, tty)).toBe(0);
      expect(asked).toEqual([RC_Q, RC_Q, RC_Q, RD_Q]);
      expect(err).toContain("The key must be a RevenueCat secret key (sk_...) or OAuth token (atk_...), not a public SDK key.");
      expect(err).toContain("No key entered.");
      reset(["", "goog_public", ""]);
      expect(await main(dryRun, tty)).toBe(2);
      expect(asked).toEqual([RC_Q, RC_Q, RC_Q]);

      // Ctrl+C at a prompt exits with 130 and asks nothing more.
      reset([new PromptCancelled()]);
      expect(await main(dryRun, tty)).toBe(130);
      expect(asked).toEqual([RC_Q]);

      // Other missing flags are reported before any key is asked for.
      reset([]);
      err.length = 0;
      expect(await main(["import", "--rc-project", PROJECT], tty)).toBe(2);
      expect(asked).toEqual([]);
      expect(err[0]).toMatch(/^Missing --to\.\n/);

      // Without a terminal: the old usage error naming the flags, plus where to type them instead.
      err.length = 0;
      expect(await main(["import", ...base], { out: tty.out, err: tty.err, env: {} })).toBe(2);
      expect(err[0]).toMatch(/^Missing --rc-key, --to-key\.\nOr run it in a terminal: the CLI then asks for each missing key and hides what you type\.\n/);
      err.length = 0;
      expect(await main(["import", "plan", "--to", server.url], { out: tty.out, err: tty.err, env: {} })).toBe(2);
      expect(err[0]).toMatch(/^Missing --to-key\.\nOr run it in a terminal/);

      // Nothing printed, on stdout or stderr, contains either key.
      const printed = [...out, ...err].join("\n");
      expect(printed).not.toContain(RC_KEY);
      expect(printed).not.toContain(rdKey);
    } finally {
      await server.close();
    }
  });
});
