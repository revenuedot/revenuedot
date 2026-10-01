import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createSecretKey } from "../src/services/auth.js";
import { memoryMailer } from "../src/mail/index.js";

/**
 * Project settings tabs (prd/project-settings): sandbox testing access enforced on customer info and currency grants,
 * ownership transfer with emails, the block list and what it takes away, brand presets in the SDK's ui_config, and the
 * public Verified Metrics page with its caching, image and the data it must never show.
 */

let h: Harness;
let mail: ReturnType<typeof memoryMailer>;
beforeEach(async () => { mail = memoryMailer(); h = await harness({ mailer: mail, publicUrl: "https://dash.example.com" }); });
afterEach(async () => { await h.close(); });

const P = () => `/v2/projects/${h.ids.project}`;
const v2 = async (method: string, path: string, json?: unknown, o: { key?: string; cookie?: string } = {}) => {
  const res = await h.fetch(path, { method, key: o.cookie ? "" : o.key ?? h.ids.secretKey, headers: o.cookie ? { cookie: o.cookie } : {}, ...(json === undefined ? {} : { json }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};
/** A Test Store purchase (always sandbox). */
const buy = (user: string, product = "pro_monthly") => h.fetch("/v1/receipts", {
  method: "POST", key: h.ids.testKey, json: { app_user_id: user, fetch_token: `test_${h.now().getTime()}_${crypto.randomUUID()}`, product_id: product, price: 9.99, currency: "USD" },
});
const info = async (user: string) => (await (await h.fetch(`/v1/subscribers/${encodeURIComponent(user)}`, { key: h.ids.iosKey })).json() as any).subscriber;
const signup = async (email: string, project = "Mine") => {
  const res = await h.fetch("/auth/signup", { method: "POST", key: "", json: { email, password: "correct horse battery", project_name: project } });
  expect(res.status).toBe(201);
  return `rd_session=${/rd_session=([^;]+)/.exec(res.headers.get("set-cookie")!)![1]}`;
};

describe("sandbox testing access", () => {
  it("anybody (default), allowlisted app user ids, or nobody unlock entitlements and currency with sandbox purchases", async () => {
    await v2("POST", `${P()}/virtual_currencies`, { code: "GEMS", name: "Gems", product_grants: [{ product_ids: ["p4"], amount: 10 }] });
    const g = await v2("GET", P());
    expect(g.body).toMatchObject({ sandbox_testing_access: "anybody", sandbox_testers: [] });
    await buy("tester_1"); await buy("stranger");
    expect(Object.keys((await info("stranger")).entitlements)).toEqual(["pro"]);

    const u = await v2("POST", P(), { sandbox_testing_access: "allowlist", sandbox_testers: [" tester_1 ", "tester_1", "qa_2"] });
    expect(u.body).toMatchObject({ sandbox_testing_access: "allowlist", sandbox_testers: ["tester_1", "qa_2"] });
    // Customer info, the v2 customer and the receipt answer all leave sandbox purchases out for non-testers.
    expect((await info("stranger")).entitlements).toEqual({});
    expect(Object.keys((await info("stranger")).subscriptions)).toEqual(["pro_monthly"]);
    expect(Object.keys((await info("tester_1")).entitlements)).toEqual(["pro"]);
    const r = await buy("stranger_2");
    expect((await r.json() as any).subscriber.entitlements).toEqual({});
    const cust = await v2("GET", `${P()}/customers/stranger`);
    expect(cust.body.active_entitlements.items).toEqual([]);
    // No currency for the non-tester's sandbox purchase; the tester's next one credits.
    const bal = async (u: string) => (await v2("GET", `${P()}/customers/${u}/virtual_currencies`)).body.items.find((x: any) => x.currency_code === "GEMS")?.balance ?? 0;
    expect(await bal("stranger_2")).toBe(0);
    await buy("qa_2");
    expect(await bal("qa_2")).toBe(10);
    // An alias of an allowlisted id counts (logIn from the anonymous id the purchase was made on).
    const anon = "$RCAnonymousID:00000000000000000000000000000001";
    await buy(anon);
    expect((await info(anon)).entitlements).toEqual({});
    await h.fetch("/v1/subscribers/identify", { method: "POST", key: h.ids.iosKey, json: { app_user_id: anon, new_app_user_id: "tester_1" } });
    expect(Object.keys((await info("tester_1")).entitlements)).toEqual(["pro"]);

    await v2("POST", P(), { sandbox_testing_access: "nobody" });
    expect((await info("tester_1")).entitlements).toEqual({});
    // Production purchases are never affected: a promotional grant still unlocks.
    await v2("POST", `${P()}/customers/stranger/actions/grant_entitlement`, { entitlement_id: "ent_pro", expires_at: h.now().getTime() + 86400_000 });
    expect(Object.keys((await info("stranger")).entitlements)).toEqual(["pro"]);
    expect((await v2("POST", P(), { sandbox_testing_access: "some" })).status).toBe(400);
  });
});

describe("transfer project ownership", () => {
  it("the owner hands the project to an admin collaborator; both get an email", async () => {
    const owner = await signup("owner@example.com");
    const me = await (await h.fetch("/auth/me", { key: "", headers: { cookie: owner } })).json() as any;
    const pid = me.projects[0].id as string;
    const proj = await v2("GET", `/v2/projects/${pid}`, undefined, { cookie: owner });
    expect(proj.body.owner).toMatchObject({ email: "owner@example.com" });
    // A second user joins as developer through an invite.
    const dev = await signup("dev@example.com", "Other");
    const devId = (await (await h.fetch("/auth/me", { key: "", headers: { cookie: dev } })).json() as any).user.id as string;
    await h.db.insert(schema.memberships).values({ userId: devId, projectId: pid, role: "developer" });
    const notAdmin = await v2("POST", `/v2/projects/${pid}/actions/transfer_ownership`, { user_id: devId }, { cookie: owner });
    expect(notAdmin.status).toBe(422);
    expect(notAdmin.body.message).toMatch(/Admin role/);
    // Only the owner may transfer; a secret key never may.
    await h.db.update(schema.memberships).set({ role: "admin" }).where(and(eq(schema.memberships.userId, devId), eq(schema.memberships.projectId, pid)));
    expect((await v2("POST", `/v2/projects/${pid}/actions/transfer_ownership`, { user_id: devId }, { cookie: dev })).status).toBe(403);
    const { key } = await createSecretKey(h.db, pid, "k");
    expect((await v2("POST", `/v2/projects/${pid}/actions/transfer_ownership`, { user_id: devId }, { key })).status).toBe(403);
    const t = await v2("POST", `/v2/projects/${pid}/actions/transfer_ownership`, { user_id: devId }, { cookie: owner });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ owner: { id: devId, email: "dev@example.com" }, email_sent: true });
    const sent = mail.sent.filter((m) => /owns|own /.test(m.subject));
    expect(sent.map((m) => m.to).sort()).toEqual(["dev@example.com", "owner@example.com"]);
    expect(sent.find((m) => m.to === "dev@example.com")!.text).toContain(`https://dash.example.com/projects/${pid}/settings/general`);
    // The old owner stays an admin but can no longer transfer.
    expect((await v2("POST", `/v2/projects/${pid}/actions/transfer_ownership`, { user_id: devId }, { cookie: owner })).status).toBe(403);
    const logs = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.projectId, pid));
    expect(logs.map((l) => l.actionType)).toContain("project_transfer_ownership");
  });
});

describe("blocked customers", () => {
  it("a blocked app user id loses entitlements everywhere, gets no currency, keeps its purchases and webhooks; unblock restores it", async () => {
    await v2("POST", `${P()}/virtual_currencies`, { code: "GEMS", name: "Gems", product_grants: [{ product_ids: ["p4"], amount: 10 }] });
    await buy("bad_actor");
    expect(Object.keys((await info("bad_actor")).entitlements)).toEqual(["pro"]);
    const b = await v2("POST", `${P()}/blocked_customers`, { app_user_id: "bad_actor", note: "Chargeback fraud" });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ object: "blocked_customer", app_user_id: "bad_actor", note: "Chargeback fraud", customer_exists: true, blocked_by: { type: "api_key" } });
    expect((await v2("POST", `${P()}/blocked_customers`, { app_user_id: "bad_actor" })).status).toBe(200);
    // Every path: SDK customer info, v1 REST with a secret key, API v2, a new receipt.
    expect((await info("bad_actor")).entitlements).toEqual({});
    expect(Object.keys((await info("bad_actor")).subscriptions)).toEqual(["pro_monthly"]);
    expect((await (await h.fetch("/v1/subscribers/bad_actor", { key: h.ids.secretKey })).json() as any).subscriber.entitlements).toEqual({});
    expect((await v2("GET", `${P()}/customers/bad_actor`)).body.active_entitlements.items).toEqual([]);
    const again = await buy("bad_actor");
    expect((await again.json() as any).subscriber.entitlements).toEqual({});
    expect((await v2("GET", `${P()}/customers/bad_actor/virtual_currencies`)).body.items.find((x: any) => x.currency_code === "GEMS")?.balance ?? 0).toBe(10);
    // Webhooks still record the store events (two purchases).
    const evs = await h.db.select().from(schema.events).where(and(eq(schema.events.projectId, h.ids.project), eq(schema.events.type, "INITIAL_PURCHASE")));
    expect(evs.length).toBeGreaterThanOrEqual(1);
    // A blocked alias blocks the whole customer.
    await buy("$RCAnonymousID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await h.fetch("/v1/subscribers/identify", { method: "POST", key: h.ids.iosKey, json: { app_user_id: "$RCAnonymousID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", new_app_user_id: "second" } });
    await v2("POST", `${P()}/blocked_customers`, { app_user_id: "$RCAnonymousID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect((await info("second")).entitlements).toEqual({});
    // Not-yet-seen ids can be blocked; list, search and lookup.
    await v2("POST", `${P()}/blocked_customers`, { app_user_id: "future_user" });
    const list = await v2("GET", `${P()}/blocked_customers?limit=2`);
    // Newest first; ties (same clock here) by app user id, descending.
    expect(list.body.items.map((x: any) => x.app_user_id)).toEqual(["future_user", "bad_actor"]);
    expect(list.body.next_page).toContain("starting_after=");
    expect((await v2("GET", `${P()}/blocked_customers?search=bad_`)).body.items.map((x: any) => x.app_user_id)).toEqual(["bad_actor"]);
    expect((await v2("GET", `${P()}/blocked_customers/future_user`)).body.customer_exists).toBe(false);
    expect((await v2("GET", `${P()}/blocked_customers/nobody`)).status).toBe(404);
    // Unblock.
    expect((await v2("DELETE", `${P()}/blocked_customers/bad_actor`)).status).toBe(200);
    expect(Object.keys((await info("bad_actor")).entitlements)).toEqual(["pro"]);
    const logs = (await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.projectId, h.ids.project))).map((l) => `${l.actionType}:${l.targetIdentifier}`);
    expect(logs).toEqual(expect.arrayContaining(["blocked_customer_created:bad_actor", "blocked_customer_deleted:bad_actor"]));
    // Read-only keys cannot block.
    const { key } = await createSecretKey(h.db, h.ids.project, "ro", ["customer_information:customers:read"]);
    expect((await v2("POST", `${P()}/blocked_customers`, { app_user_id: "x" }, { key })).status).toBe(403);
    expect((await v2("GET", `${P()}/blocked_customers`, undefined, { key })).status).toBe(200);
  });
});

describe("brand", () => {
  it("stores colour and gradient presets and serves them to the SDK as ui_config.app.colors", async () => {
    expect((await v2("GET", `${P()}/brand`)).body).toEqual({ object: "brand", color_presets: [], gradient_presets: [] });
    const saved = await v2("POST", `${P()}/brand`, {
      color_presets: [{ key: "primary", name: "Primary", light: "#0A0A0A", dark: "#FAFAFA" }, { key: "accent", name: "Gold", light: "#F7B500CC" }],
      gradient_presets: [{ key: "sunrise", name: "Sunrise", type: "linear", degrees: 90, points: [{ color: "#FF0000", percent: 0 }, { color: "#0000FF", percent: 100 }] }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.color_presets[1]).toEqual({ key: "accent", name: "Gold", light: "#f7b500cc", dark: null });
    expect((await v2("POST", `${P()}/brand`, { color_presets: [{ key: "Bad Key", name: "x", light: "#000" }] })).status).toBe(400);
    expect((await v2("POST", `${P()}/brand`, { gradient_presets: [{ key: "primary", name: "dup", type: "radial", points: [{ color: "#000000", percent: 0 }, { color: "#ffffff", percent: 100 }] }] })).status).toBe(400);
    const offerings = await (await h.fetch("/v1/subscribers/u1/offerings", { key: h.ids.iosKey })).json() as any;
    expect(offerings.ui_config.app.colors).toEqual({
      primary: { light: { type: "hex", value: "#0a0a0aff" }, dark: { type: "hex", value: "#fafafaff" } },
      accent: { light: { type: "hex", value: "#f7b500cc" }, dark: { type: "hex", value: "#f7b500cc" } },
      sunrise: { light: { type: "linear", degrees: 90, points: [{ color: "#ff0000ff", percent: 0 }, { color: "#0000ffff", percent: 100 }] }, dark: { type: "linear", degrees: 90, points: [{ color: "#ff0000ff", percent: 0 }, { color: "#0000ffff", percent: 100 }] } },
    });
    // Fonts: delete what was uploaded.
    expect((await v2("DELETE", `${P()}/fonts/fnt_missing`)).status).toBe(404);
  });
});

describe("verified metrics", () => {
  it("drafts a slug, validates it, publishes a cached public page with production numbers only, and unpublishes", async () => {
    // Production history: an App Store subscription with revenue; plus a sandbox purchase that must not show.
    const { getOrCreateCustomer } = await import("../src/repo/customers.js");
    const { customer } = await getOrCreateCustomer(h.db, h.ids.project, "secret_customer_42", h.now());
    await h.db.insert(schema.subscriptions).values({ id: "sub_prod", projectId: h.ids.project, customerId: customer.id, appId: h.ids.app, store: "app_store", storeKey: "ot1", productIdentifier: "pro_monthly", purchaseDate: h.now(), originalPurchaseDate: h.now(), expiresDate: new Date(h.now().getTime() + 20 * 86400_000), priceAmount: 9.99, priceCurrency: "USD", priceUsd: 9.99 });
    await h.db.insert(schema.transactions).values({ id: "txn_prod", projectId: h.ids.project, customerId: customer.id, store: "app_store", storeTransactionId: "t1", productIdentifier: "pro_monthly", kind: "purchase", purchasedAt: h.now(), revenueUsd: 9.99 });
    await buy("sandbox_buyer");

    const d = await v2("GET", `${P()}/verified_metrics`);
    expect(d.body).toMatchObject({ status: "never_published", slug: "scanner", display_name: "Scanner", chart_type: "number_sparkline", url: "http://localhost/verified/scanner" });
    expect(d.body.metrics.map((m: any) => m.id)).toEqual(["mrr", "revenue", "active_subscriptions", "active_trials", "new_customers", "active_users"]);
    expect((await h.fetch("/verified/scanner", { key: "" })).status).toBe(404);
    // Slug rules.
    for (const bad of ["ab", "Has Space", "-dash", "admin", "a--b"]) expect((await v2("GET", `${P()}/verified_metrics/slug_availability?slug=${encodeURIComponent(bad)}`)).body.available, bad).toBe(false);
    expect((await v2("POST", `${P()}/verified_metrics`, { slug: "admin" })).status).toBe(400);
    await h.db.insert(schema.projects).values({ id: "projB", name: "Taken" });
    await h.db.insert(schema.verifiedPages).values({ projectId: "projB", slug: "taken-slug", displayName: "B", metrics: [] });
    expect((await v2("POST", `${P()}/verified_metrics`, { slug: "taken-slug" })).status).toBe(409);
    expect((await v2("GET", `${P()}/verified_metrics/slug_availability?slug=taken-slug`)).body).toMatchObject({ available: false, reason: expect.stringMatching(/Another project/) });
    expect((await v2("POST", `${P()}/verified_metrics`, { app_store_url: "https://evil.example.com/app" })).status).toBe(400);

    const pub = await v2("POST", `${P()}/verified_metrics/actions/publish`, {
      slug: "scanner-app", display_name: "Scanner Pro", show_store_links: true, app_store_url: "https://apps.apple.com/app/id123",
      metrics: [{ id: "revenue", visible: true }, { id: "mrr", visible: true }, { id: "active_subscriptions", visible: true }, { id: "active_trials", visible: false }, { id: "new_customers", visible: false }, { id: "active_users", visible: false }],
    });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ status: "published", slug: "scanner-app", url: "http://localhost/verified/scanner-app" });

    const page = await h.fetch("/verified/scanner-app", { key: "" });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=900");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("Scanner Pro");
    expect(html).toContain("$10"); // production revenue and MRR, rounded
    expect(html).toContain("https://apps.apple.com/app/id123");
    expect(html).toContain('property="og:image" content="http://localhost/verified/scanner-app/og.png"');
    expect(html.indexOf("Revenue")).toBeLessThan(html.indexOf("MRR"));
    expect(html).not.toContain("Active trials");
    // Nothing about customers or the project leaks.
    for (const secret of ["secret_customer_42", "sandbox_buyer", h.ids.project, h.ids.app]) expect(html).not.toContain(secret);
    const etag = page.headers.get("etag")!;
    expect((await h.fetch("/verified/scanner-app", { key: "", headers: { "if-none-match": etag } })).status).toBe(304);

    const json = await (await h.fetch("/verified/scanner-app/metrics.json", { key: "" })).json() as any;
    expect(json.metrics.map((m: any) => [m.id, m.value])).toEqual([["revenue", 9.99], ["mrr", 9.99], ["active_subscriptions", 1]]);
    expect(json.metrics[0].sparkline).toHaveLength(28);
    expect(JSON.stringify(json)).not.toMatch(/secret_customer_42|proj1|app_ios/);

    const png = await h.fetch("/verified/scanner-app/og.png", { key: "" });
    expect(png.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(bytes.buffer);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([1200, 630]);

    // Saving keeps it published; unpublishing takes it down.
    expect((await v2("POST", `${P()}/verified_metrics`, { display_name: "Scanner" })).body.status).toBe("published");
    expect((await v2("POST", `${P()}/verified_metrics/actions/unpublish`, {})).body.status).toBe("inactive");
    const gone = await h.fetch("/verified/scanner-app", { key: "" });
    expect(gone.status).toBe(404);
    expect(gone.headers.get("cache-control")).toBe("no-store");
    expect((await v2("POST", `${P()}/verified_metrics/actions/unpublish`, {})).status).toBe(422);
  });
});

describe("review fixes", () => {
  it("keeps the owner: other admins can neither remove nor demote them, and the owner cannot leave without transferring", async () => {
    const owner = await signup("own@example.com");
    const pid = ((await (await h.fetch("/auth/me", { key: "", headers: { cookie: owner } })).json()) as any).projects[0].id as string;
    const ownerId = ((await (await h.fetch("/auth/me", { key: "", headers: { cookie: owner } })).json()) as any).user.id as string;
    const other = await signup("admin2@example.com", "Theirs");
    const otherId = ((await (await h.fetch("/auth/me", { key: "", headers: { cookie: other } })).json()) as any).user.id as string;
    await h.db.insert(schema.memberships).values({ userId: otherId, projectId: pid, role: "admin" });
    // The second admin tries to take over: remove the owner, or demote them.
    const remove = await v2("DELETE", `/v2/projects/${pid}/collaborators/${ownerId}`, undefined, { cookie: other });
    expect(remove.status).toBe(422);
    expect(remove.body.message).toMatch(/owner cannot be removed/);
    const demote = await v2("POST", `/v2/projects/${pid}/collaborators/${ownerId}`, { role: "developer" }, { cookie: other });
    expect(demote.status).toBe(422);
    expect((await v2("POST", `/v2/projects/${pid}/actions/transfer_ownership`, { user_id: otherId }, { cookie: other })).status).toBe(403);
    // The owner cannot leave while owning it, but can after handing it over.
    expect((await v2("DELETE", `/v2/projects/${pid}/collaborators/${ownerId}`, undefined, { cookie: owner })).body.message).toMatch(/Transfer ownership/);
    expect((await v2("POST", `/v2/projects/${pid}/actions/transfer_ownership`, { user_id: otherId }, { cookie: owner })).status).toBe(200);
    expect((await v2("DELETE", `/v2/projects/${pid}/collaborators/${ownerId}`, undefined, { cookie: owner })).status).toBe(200);
    const [p] = await h.db.select().from(schema.projects).where(eq(schema.projects.id, pid));
    expect(p!.ownerUserId).toBe(otherId);
  });

  it("a blocked customer's purchase cannot be restored onto another app user id, and its subscriptions give no access in API v2", async () => {
    const token = `test_${h.now().getTime()}_${crypto.randomUUID()}`;
    await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "blocked_one", fetch_token: token, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    await v2("POST", `${P()}/blocked_customers`, { app_user_id: "blocked_one" });
    const subs = await v2("GET", `${P()}/customers/blocked_one/subscriptions`);
    expect(subs.body.items[0]).toMatchObject({ status: "active", gives_access: false });
    // The dashboard's customer page shows the block.
    expect((await v2("GET", `${P()}/customer_summaries?ids=blocked_one`)).body.items[0]).toMatchObject({ blocked: true, active_entitlements: [] });
    // The project transfers purchases on restore (the default), but not away from a blocked customer.
    const restore = await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "fresh_id", fetch_token: token, product_id: "pro_monthly", price: 9.99, currency: "USD", is_restore: true } });
    expect(restore.status).toBe(400);
    expect(await restore.json()).toMatchObject({ code: 7102 });
    expect((await info("fresh_id")).entitlements).toEqual({});
    const [sub] = await h.db.select({ c: schema.customers.originalAppUserId }).from(schema.subscriptions).innerJoin(schema.customers, eq(schema.customers.id, schema.subscriptions.customerId)).where(eq(schema.subscriptions.storeKey, token));
    expect(sub!.c).toBe("blocked_one");
    // Unblocked, the same restore transfers as usual and access comes back.
    await v2("DELETE", `${P()}/blocked_customers/blocked_one`);
    expect((await v2("GET", `${P()}/customers/blocked_one/subscriptions`)).body.items[0].gives_access).toBe(true);
    expect((await v2("GET", `${P()}/customer_summaries?ids=blocked_one`)).body.items[0].blocked).toBe(false);
    const again = await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "fresh_id", fetch_token: token, product_id: "pro_monthly", price: 9.99, currency: "USD", is_restore: true } });
    expect(again.status).toBe(200);
    expect(Object.keys((await info("fresh_id")).entitlements)).toEqual(["pro"]);
  });

  it("logs blocked and unblocked anonymous ids decoded, and drops blank allowlist lines", async () => {
    const anon = "$RCAnonymousID:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await v2("POST", `${P()}/blocked_customers`, { app_user_id: anon });
    expect((await v2("DELETE", `${P()}/blocked_customers/${encodeURIComponent(anon)}`)).status).toBe(200);
    const logs = (await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.projectId, h.ids.project))).map((l) => `${l.actionType}:${l.targetIdentifier}`);
    expect(logs).toEqual(expect.arrayContaining([`blocked_customer_created:${anon}`, `blocked_customer_deleted:${anon}`]));
    const saved = await v2("POST", P(), { sandbox_testing_access: "allowlist", sandbox_testers: ["a", " a ", "", "  ", "b"] });
    expect(saved.body.sandbox_testers).toEqual(["a", "b"]);
  });

  it("sandbox subscriptions outside sandbox testing access give no access in API v2", async () => {
    await buy("tester_x");
    await v2("POST", P(), { sandbox_testing_access: "nobody" });
    expect((await v2("GET", `${P()}/customers/tester_x/subscriptions`)).body.items[0].gives_access).toBe(false);
    await v2("POST", P(), { sandbox_testing_access: "allowlist", sandbox_testers: ["tester_x"] });
    expect((await v2("GET", `${P()}/customers/tester_x/subscriptions`)).body.items[0].gives_access).toBe(true);
  });

  it("serves the verified page's icon by slug (never the project id), and a versioned edge cache never serves a saved or unpublished page stale", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await h.db.insert(schema.mediaAssets).values({ id: "ma_icon", projectId: h.ids.project, kind: "image", objectName: "ma_icon.png", originalName: "icon.png", contentType: "image/png", size: 68, width: 1, height: 1, dataBase64: png });
    // A Workers-style edge cache shared by the requests below.
    const store = new Map<string, Response>();
    const g = globalThis as unknown as { caches?: unknown };
    const before = g.caches;
    g.caches = { default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => { store.set(r.url, res.clone()); },
      delete: async (r: Request) => store.delete(r.url),
    } };
    try {
      await v2("POST", `${P()}/verified_metrics/actions/publish`, { slug: "icon-app", display_name: "First name", show_icon: true, icon_asset_id: "ma_icon" });
      const json = await (await h.fetch("/verified/icon-app/metrics.json", { key: "" })).json() as any;
      expect(json.icon_url).toBe("http://localhost/verified/icon-app/icon?v=ma_icon");
      const html = await (await h.fetch("/verified/icon-app", { key: "" })).text();
      expect(html).toContain('src="http://localhost/verified/icon-app/icon?v=ma_icon"');
      expect(html).not.toContain(h.ids.project);
      const icon = await h.fetch("/verified/icon-app/icon?v=ma_icon", { key: "" });
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/png");
      expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
      await new Promise((r) => setTimeout(r, 10));
      expect([...store.keys()].some((k) => k.includes("/verified/icon-app/html?v="))).toBe(true);
      // A save: the next request computes the new name, whatever copy a data centre kept.
      h.setNow(new Date(h.now().getTime() + 1000));
      await v2("POST", `${P()}/verified_metrics`, { display_name: "Second name" });
      expect(await (await h.fetch("/verified/icon-app", { key: "" })).text()).toContain("Second name");
      // Mixed case reaches the same page; unpublishing answers 404 at once despite the cached copies.
      expect((await h.fetch("/verified/ICON-App", { key: "" })).status).toBe(200);
      await v2("POST", `${P()}/verified_metrics/actions/unpublish`, {});
      expect((await h.fetch("/verified/icon-app", { key: "" })).status).toBe(404);
      expect((await h.fetch("/verified/icon-app/icon", { key: "" })).status).toBe(404);
    } finally { g.caches = before; }
  });
});
