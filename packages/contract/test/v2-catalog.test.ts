import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";
import { signup, spec, v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const APPS = "/v2/projects/{project_id}/apps";
const PRODUCTS = "/v2/projects/{project_id}/products";
const ENTS = "/v2/projects/{project_id}/entitlements";
const OFFS = "/v2/projects/{project_id}/offerings";
const PKGS = "/v2/projects/{project_id}/packages";
const HOOKS = "/v2/projects/{project_id}/integrations/webhooks";

describe("projects", () => {
  it("a secret key lists only its own project", async () => {
    const r = await call("GET", "/v2/projects");
    expect(r.status).toBe(200);
    expect(r.body.items.map((p: any) => p.id)).toEqual([h.ids.project]);
    expect(r.body).toMatchObject({ object: "list", next_page: null, url: "/v2/projects" });
  });
  it("a dashboard user creates a project with the session cookie; a secret key cannot", async () => {
    const cookie = await signup(h);
    const created = await call("POST", "/v2/projects", {}, { cookie, json: { name: "Second app" } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ object: "project", name: "Second app" });
    const list = await call("GET", "/v2/projects", {}, { cookie });
    expect(list.body.items.map((p: any) => p.name).sort()).toEqual(["Dashboard project", "Second app"]);
    expect((await call("POST", "/v2/projects", {}, { json: { name: "Nope" } })).status).toBe(403);
    expect((await call("POST", "/v2/projects", {}, { cookie, json: { name: "" } })).status).toBe(400);
  });
});

describe("apps", () => {
  it("lists, creates, gets, updates, lists public keys and deletes", async () => {
    const list = await call("GET", APPS);
    expect(list.body.items.map((a: any) => a.id).sort()).toEqual(["app_ios", "app_play", "app_test"]);
    const ios = list.body.items.find((a: any) => a.id === "app_ios");
    expect(ios.app_store).toMatchObject({ bundle_id: "com.example.scanner", subscription_key_configured: false });

    const created = await call("POST", APPS, {}, { json: { name: "Scanner Mac", type: "app_store", app_store: { bundle_id: "com.example.mac", shared_secret: "abc", subscription_private_key: "-----BEGIN PRIVATE KEY-----", subscription_key_id: "K1", subscription_key_issuer: "I1" } } });
    expect(created.status).toBe(201);
    expect(created.body.app_store).toMatchObject({ bundle_id: "com.example.mac", subscription_key_configured: true });
    expect(JSON.stringify(created.body)).not.toContain("BEGIN PRIVATE KEY");
    const id = created.body.id;
    expect(id).toMatch(/^app/);

    const play = await call("POST", APPS, {}, { json: { name: "Scanner Android 2", type: "play_store", play_store: { package_name: "com.example.two" } } });
    expect(play.body.play_store.play_service_account_credentials_configured).toBe(false);

    expect((await call("GET", `${APPS}/{app_id}`, { app_id: id })).body.name).toBe("Scanner Mac");
    const upd = await call("POST", `${APPS}/{app_id}`, { app_id: play.body.id }, { json: { name: "Renamed", play_store: { play_service_account_credentials_json: "{\"type\":\"service_account\"}" } } });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: "Renamed", play_store: { package_name: "com.example.two", play_service_account_credentials_configured: true } });
    expect((await call("POST", `${APPS}/{app_id}`, { app_id: play.body.id }, { json: { app_store: { bundle_id: "x" } } })).status).toBe(400);

    const keys = await call("GET", `${APPS}/{app_id}/public_api_keys`, { app_id: id });
    expect(keys.body.items[0]).toMatchObject({ object: "public_api_key", app_id: id, environment: "production" });
    expect(keys.body.items[0].key).toMatch(/^appl_/);
    // The new key works with the SDK endpoints right away.
    expect((await h.fetch("/v1/subscribers/someone", { key: keys.body.items[0].key })).status).toBe(201);
    expect((await call("GET", `${APPS}/{app_id}/public_api_keys`, { app_id: "app_test" })).body.items[0]).toMatchObject({ key: h.ids.testKey, environment: "sandbox" });

    const del = await call("DELETE", `${APPS}/{app_id}`, { app_id: id });
    expect(del.body).toMatchObject({ object: "app", id });
    expect((await call("GET", `${APPS}/{app_id}`, { app_id: id })).status).toBe(404);
  });

  it("validates create bodies", async () => {
    const r = await call("POST", APPS, {}, { json: { name: "No bundle", type: "app_store", app_store: {} } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ object: "error", type: "parameter_error", param: "app_store.bundle_id", retryable: false });
    expect((await call("POST", APPS, {}, { json: { name: "x", type: "nintendo" } })).body.param).toBe("type");
    const bad = await call("POST", APPS, {}, { body: "{not json" });
    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("invalid_request");
  });

  it("paginates with starting_after and clamps limit to 1..100", async () => {
    const p1 = await call("GET", APPS, {}, { query: "limit=2" });
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.next_page).toBe(`/v2/projects/proj1/apps?limit=2&starting_after=${p1.body.items[1].id}`);
    const p2 = await call("GET", p1.body.next_page.split("?")[0].replace("proj1", "{project_id}"), {}, { query: p1.body.next_page.split("?")[1] });
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.next_page).toBeNull();
    const all = [...p1.body.items, ...p2.body.items].map((a: any) => a.id);
    expect(new Set(all).size).toBe(3);
    expect((await call("GET", APPS, {}, { query: "limit=0" })).body.items).toHaveLength(1);
    expect((await call("GET", APPS, {}, { query: "limit=100000" })).body.items).toHaveLength(3);
    const bad = await call("GET", APPS, {}, { query: "starting_after=nope" });
    expect(bad.status).toBe(400);
    expect(bad.body.param).toBe("starting_after");
  });

  it("deleting an app deletes its products and their entitlement and package links", async () => {
    await call("DELETE", `${APPS}/{app_id}`, { app_id: "app_ios" });
    expect(await h.db.select().from(schema.products).where(eq(schema.products.appId, "app_ios"))).toHaveLength(0);
    const ent = await call("GET", `${ENTS}/{entitlement_id}/products`, { entitlement_id: "ent_pro" });
    expect(ent.body.items.map((p: any) => p.id).sort()).toEqual(["p3", "p4", "p5"]);
  });
});

describe("products", () => {
  it("creates, lists with filters and expand, gets, updates, archives and deletes", async () => {
    const created = await call("POST", PRODUCTS, {}, { json: { store_identifier: "pro_weekly", app_id: "app_test", type: "subscription", display_name: "Weekly", subscription: { duration: "P1W" } } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ object: "product", store_identifier: "pro_weekly", app_id: "app_test", state: "active", subscription: { duration: "P1W" } });
    const id = created.body.id;
    expect(id).toMatch(/^prod/);

    const dup = await call("POST", PRODUCTS, {}, { json: { store_identifier: "pro_weekly", app_id: "app_test", type: "subscription" } });
    expect(dup.status).toBe(409);
    expect(dup.body.type).toBe("resource_already_exists");
    // Same store id on another app is fine.
    expect((await call("POST", PRODUCTS, {}, { json: { store_identifier: "pro_weekly", app_id: "app_ios", type: "subscription" } })).status).toBe(201);
    expect((await call("POST", PRODUCTS, {}, { json: { store_identifier: "x", app_id: "nope", type: "subscription" } })).body.param).toBe("app_id");
    // RevenueDot keeps a duration for every store (RevenueCat ignores it outside the Test Store); custom ISO periods are allowed.
    const ios = await call("POST", PRODUCTS, {}, { json: { store_identifier: "x", app_id: "app_ios", type: "subscription", subscription: { duration: "P2W" } } });
    expect(ios.status).toBe(201);
    expect(ios.body.subscription.duration).toBe("P2W");
    const badDuration = await call("POST", PRODUCTS, {}, { json: { store_identifier: "y", app_id: "app_ios", type: "subscription", subscription: { duration: "monthly" } } });
    expect(badDuration.status).toBe(400);
    expect(badDuration.body.param).toBe("subscription.duration");
    const fixed = await call("POST", `${PRODUCTS}/{product_id}`, { product_id: ios.body.id }, { json: { subscription: { duration: "P1M" } } });
    expect(fixed.body.subscription.duration).toBe("P1M");
    expect((await call("POST", `${PRODUCTS}/{product_id}`, { product_id: ios.body.id }, { json: { subscription: { duration: "1 month" } } })).status).toBe(400);

    const filtered = await call("GET", PRODUCTS, {}, { query: "app_id=app_test&expand=items.app" });
    expect(filtered.body.items.every((p: any) => p.app_id === "app_test" && p.app.type === "test_store")).toBe(true);
    expect(filtered.body.items.find((p: any) => p.store_identifier === "coins_100").one_time).toEqual({ is_consumable: true });

    const got = await call("GET", `${PRODUCTS}/{product_id}`, { product_id: id }, { query: "expand=app" });
    expect(got.body.app.id).toBe("app_test");
    expect((await call("GET", `${PRODUCTS}/{product_id}`, { product_id: id })).body.app).toBeUndefined();

    expect((await call("POST", `${PRODUCTS}/{product_id}`, { product_id: id }, { json: { display_name: "Weekly pass" } })).body.display_name).toBe("Weekly pass");
    expect((await call("POST", `${PRODUCTS}/{product_id}/actions/archive`, { product_id: id })).body.state).toBe("inactive");
    expect((await call("POST", `${PRODUCTS}/{product_id}/actions/unarchive`, { product_id: id })).body.state).toBe("active");
    expect((await call("DELETE", `${PRODUCTS}/{product_id}`, { product_id: id })).body).toMatchObject({ object: "product", id });
    expect((await call("GET", `${PRODUCTS}/{product_id}`, { product_id: id })).status).toBe(404);
  });
});

describe("Test Store prices", () => {
  it("are set on create and update, read as RevenueCat's indicative_price and shown to the SDK", async () => {
    const created = await call("POST", PRODUCTS, {}, { query: "expand=indicative_price", json: { store_identifier: "pro_weekly", app_id: "app_test", type: "subscription", subscription: { duration: "P1W" }, test_store_price: { amount_micros: 2_990_000, currency: "eur" } } });
    expect(created.status).toBe(201);
    expect(created.body.indicative_price).toEqual({ object: "indicative_price", currency: "EUR", country: null, amount_micros: 2_990_000 });
    const id = created.body.id;
    // Without the expand the product has RevenueCat's plain shape.
    expect((await call("GET", `${PRODUCTS}/{product_id}`, { product_id: id })).body.indicative_price).toBeUndefined();
    const upd = await call("POST", `${PRODUCTS}/{product_id}`, { product_id: "p6" }, { query: "expand=indicative_price", json: { test_store_price: { amount_micros: 990_000, currency: "USD" } } });
    expect(upd.body.indicative_price).toMatchObject({ amount_micros: 990_000, currency: "USD" });
    // A display name change keeps the price; lists expand items.indicative_price, and products without one report null.
    await call("POST", `${PRODUCTS}/{product_id}`, { product_id: id }, { json: { display_name: "Weekly" } });
    const list = (await call("GET", PRODUCTS, {}, { query: "app_id=app_test&expand=items.indicative_price" })).body.items;
    expect(list.find((p: any) => p.id === id).indicative_price.amount_micros).toBe(2_990_000);
    expect(list.find((p: any) => p.store_identifier === "lifetime").indicative_price).toBeNull();

    const rc = await h.fetch("/rcbilling/v1/subscribers/u1/products?id=pro_weekly&id=coins_100&id=lifetime", { key: h.ids.testKey });
    const details = (await rc.json() as { product_details: Array<Record<string, any>> }).product_details;
    const weekly = details.find((p) => p.identifier === "pro_weekly")!;
    expect(weekly.current_price).toEqual({ amount: 2.99, amount_micros: 2_990_000, currency: "EUR" });
    expect(weekly.purchase_options.base.base.price).toEqual({ amount: 2.99, amount_micros: 2_990_000, currency: "EUR" });
    expect(details.find((p) => p.identifier === "coins_100")!.purchase_options.base.base_price).toEqual({ amount: 0.99, amount_micros: 990_000, currency: "USD" });
    // A product without a price shows USD 0.
    expect(details.find((p) => p.identifier === "lifetime")!.current_price).toEqual({ amount: 0, amount_micros: 0, currency: "USD" });

    // null clears it.
    const cleared = await call("POST", `${PRODUCTS}/{product_id}`, { product_id: id }, { query: "expand=indicative_price", json: { test_store_price: null } });
    expect(cleared.body.indicative_price).toBeNull();
    // Only Test Store products take a price, and the amount and currency are validated.
    const ios = await call("POST", PRODUCTS, {}, { json: { store_identifier: "ios_weekly", app_id: "app_ios", type: "subscription", test_store_price: { amount_micros: 1, currency: "USD" } } });
    expect(ios.status).toBe(400);
    expect(ios.body.param).toBe("test_store_price");
    expect((await call("POST", `${PRODUCTS}/{product_id}`, { product_id: "p1" }, { json: { test_store_price: { amount_micros: 1, currency: "USD" } } })).body.param).toBe("test_store_price");
    expect((await call("POST", `${PRODUCTS}/{product_id}`, { product_id: id }, { json: { test_store_price: { amount_micros: 1.5, currency: "USD" } } })).status).toBe(400);
    expect((await call("POST", `${PRODUCTS}/{product_id}`, { product_id: id }, { json: { test_store_price: { amount_micros: 100, currency: "dollars" } } })).status).toBe(400);
    // A well-formed code that no exchange rate knows would record $0 of revenue for every test purchase: refused.
    const xyz = await call("POST", `${PRODUCTS}/{product_id}`, { product_id: id }, { json: { test_store_price: { amount_micros: 100, currency: "XYZ" } } });
    expect(xyz.status).toBe(400);
    expect(xyz.body).toMatchObject({ param: "test_store_price.currency", message: expect.stringContaining("convert to USD") });
    expect((await call("POST", `${PRODUCTS}/{product_id}`, { product_id: id }, { json: { test_store_price: { amount_micros: 1_199_000_000_000, currency: "idr" } } })).status).toBe(200);
  });
});

describe("entitlements", () => {
  it("full lifecycle: create, duplicate, update, attach, detach, archive, products, delete", async () => {
    const created = await call("POST", ENTS, {}, { json: { lookup_key: "premium", display_name: "Premium" } });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(id).toMatch(/^entl/);
    expect((await call("POST", ENTS, {}, { json: { lookup_key: "premium", display_name: "Again" } })).status).toBe(409);
    expect((await call("POST", ENTS, {}, { json: { lookup_key: "x" } })).body.param).toBe("display_name");

    expect((await call("POST", `${ENTS}/{entitlement_id}`, { entitlement_id: id }, { json: { display_name: "Premium+" } })).body.display_name).toBe("Premium+");
    const att = await call("POST", `${ENTS}/{entitlement_id}/actions/attach_products`, { entitlement_id: id }, { json: { product_ids: ["p1", "p2"] } });
    expect(att.body.products.items.map((p: any) => p.id).sort()).toEqual(["p1", "p2"]);
    expect((await call("POST", `${ENTS}/{entitlement_id}/actions/attach_products`, { entitlement_id: id }, { json: { product_ids: ["nope"] } })).status).toBe(400);
    const det = await call("POST", `${ENTS}/{entitlement_id}/actions/detach_products`, { entitlement_id: id }, { json: { product_ids: ["p2"] } });
    expect(det.body.products.items.map((p: any) => p.id)).toEqual(["p1"]);
    expect((await call("GET", `${ENTS}/{entitlement_id}/products`, { entitlement_id: id })).body.items.map((p: any) => p.id)).toEqual(["p1"]);

    const list = await call("GET", ENTS, {}, { query: "expand=items.product" });
    expect(list.body.items.find((e: any) => e.id === "ent_pro").products.items).toHaveLength(5);
    expect((await call("GET", `${ENTS}/{entitlement_id}`, { entitlement_id: id }, { query: "expand=product" })).body.products.items).toHaveLength(1);

    expect((await call("POST", `${ENTS}/{entitlement_id}/actions/archive`, { entitlement_id: id })).body.state).toBe("inactive");
    expect((await call("POST", `${ENTS}/{entitlement_id}/actions/unarchive`, { entitlement_id: id })).body.state).toBe("active");
    expect((await call("DELETE", `${ENTS}/{entitlement_id}`, { entitlement_id: id })).body).toMatchObject({ object: "entitlement", id });
    expect(await h.db.select().from(schema.entitlementProducts).where(eq(schema.entitlementProducts.entitlementId, id))).toHaveLength(0);
  });

  it("archiving an entitlement removes it from the SDK's product mapping", async () => {
    await call("POST", `${ENTS}/{entitlement_id}/actions/archive`, { entitlement_id: "ent_pro" });
    const m = await (await h.fetch("/v1/product_entitlement_mapping")).json();
    expect(m.product_entitlement_mapping).toEqual({});
  });
});

describe("offerings and packages", () => {
  it("offering lifecycle, current switching and expansion", async () => {
    const created = await call("POST", OFFS, {}, { json: { lookup_key: "sale", display_name: "Sale", metadata: { color: "gold" } } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ object: "offering", is_current: false, metadata: { color: "gold" }, paywall_id: null, state: "active" });
    const id = created.body.id;
    expect(id).toMatch(/^ofrng/);
    expect((await call("POST", OFFS, {}, { json: { lookup_key: "sale", display_name: "Dup" } })).status).toBe(409);

    const cur = await call("POST", `${OFFS}/{offering_id}`, { offering_id: id }, { json: { is_current: true, display_name: "Big sale" } });
    expect(cur.body).toMatchObject({ is_current: true, display_name: "Big sale" });
    expect((await call("GET", `${OFFS}/{offering_id}`, { offering_id: "ofr_default" })).body.is_current).toBe(false);
    expect((await (await h.fetch("/v1/subscribers/u/offerings")).json()).current_offering_id).toBe("sale");
    const arch = await call("POST", `${OFFS}/{offering_id}/actions/archive`, { offering_id: id });
    expect(arch.status).toBe(422);

    const list = await call("GET", OFFS, {}, { query: "expand=items.package.product" });
    const def = list.body.items.find((o: any) => o.id === "ofr_default");
    expect(def.packages.items.map((p: any) => p.lookup_key)).toEqual(["$rc_monthly", "$rc_annual"]);
    expect(def.packages.items[0].products.items.map((x: any) => x.product.id).sort()).toEqual(["p1", "p3", "p4"]);
    const one = await call("GET", `${OFFS}/{offering_id}`, { offering_id: "ofr_default" }, { query: "expand=package" });
    expect(one.body.packages.items[0].products).toBeUndefined();

    expect((await call("POST", `${OFFS}/{offering_id}/actions/archive`, { offering_id: "ofr_default" })).body.state).toBe("inactive");
    await h.db.update(schema.products).set({ state: "inactive" }).where(eq(schema.products.id, "p1"));
    const un = await call("POST", `${OFFS}/{offering_id}/actions/unarchive`, { offering_id: "ofr_default" }, { json: { unarchive_referenced_entities: true } });
    expect(un.body.state).toBe("active");
    expect((await h.db.select().from(schema.products).where(eq(schema.products.id, "p1")))[0]!.state).toBe("active");

    const del = await call("DELETE", `${OFFS}/{offering_id}`, { offering_id: "ofr_default" });
    expect(del.body).toMatchObject({ object: "offering", id: "ofr_default" });
    // Packages go with it.
    expect((await call("GET", `${PKGS}/{package_id}`, { package_id: "pkg_m" })).status).toBe(404);
  });

  it("package lifecycle with product attachment and eligibility criteria", async () => {
    const created = await call("POST", `${OFFS}/{offering_id}/packages`, { offering_id: "ofr_default" }, { json: { lookup_key: "$rc_weekly", display_name: "Weekly" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ object: "package", position: 2 });
    const id = created.body.id;
    expect(id).toMatch(/^pkge/);
    expect((await call("POST", `${OFFS}/{offering_id}/packages`, { offering_id: "ofr_default" }, { json: { lookup_key: "$rc_weekly", display_name: "x" } })).status).toBe(409);

    await h.db.insert(schema.products).values([
      { id: "pw_ios", projectId: "proj1", appId: "app_ios", storeIdentifier: "pro_weekly", duration: "P1W" },
      { id: "pw_old", projectId: "proj1", appId: "app_play", storeIdentifier: "pro:weekly-legacy", duration: "P1W" },
      { id: "pw_new", projectId: "proj1", appId: "app_play", storeIdentifier: "pro:weekly", duration: "P1W" },
    ]);
    const att = await call("POST", `${PKGS}/{package_id}/actions/attach_products`, { package_id: id }, { json: { products: [
      { product_id: "pw_ios", eligibility_criteria: "all" }, { product_id: "pw_old", eligibility_criteria: "google_sdk_lt_6" }, { product_id: "pw_new", eligibility_criteria: "google_sdk_ge_6" },
    ] } });
    expect(att.status).toBe(200);
    expect(att.body.products.items).toHaveLength(3);
    // A second iOS product in the same package conflicts.
    const clash = await call("POST", `${PKGS}/{package_id}/actions/attach_products`, { package_id: id }, { json: { products: [{ product_id: "p1", eligibility_criteria: "all" }] } });
    expect(clash.status).toBe(409);
    expect((await call("POST", `${PKGS}/{package_id}/actions/attach_products`, { package_id: id }, { json: { products: [{ product_id: "p1", eligibility_criteria: "sometimes" }] } })).status).toBe(400);

    const prods = await call("GET", `${PKGS}/{package_id}/products`, { package_id: id });
    expect(prods.body.items.find((x: any) => x.product.id === "pw_old").eligibility_criteria).toBe("google_sdk_lt_6");
    expect((await call("GET", `${OFFS}/{offering_id}/packages`, { offering_id: "ofr_default" }, { query: "expand=items.product" })).body.items.map((p: any) => p.lookup_key)).toEqual(["$rc_monthly", "$rc_annual", "$rc_weekly"]);
    expect((await call("GET", `${PKGS}/{package_id}`, { package_id: id }, { query: "expand=product" })).body.products.items).toHaveLength(3);
    // The SDK sees the new package for iOS.
    const offs = await (await h.fetch("/v1/subscribers/u/offerings")).json();
    expect(offs.offerings[0].packages.map((p: any) => p.identifier)).toContain("$rc_weekly");

    const det = await call("POST", `${PKGS}/{package_id}/actions/detach_products`, { package_id: id }, { json: { product_ids: ["pw_old"] } });
    expect(det.body.products.items.map((x: any) => x.product.id).sort()).toEqual(["pw_ios", "pw_new"]);
    expect((await call("POST", `${PKGS}/{package_id}`, { package_id: id }, { json: { display_name: "Week", position: 0 } })).body).toMatchObject({ display_name: "Week", position: 0 });
    expect((await call("DELETE", `${PKGS}/{package_id}`, { package_id: id })).body).toMatchObject({ object: "package", id });
    expect(await h.db.select().from(schema.packageProducts).where(eq(schema.packageProducts.packageId, id))).toHaveLength(0);
  });
});

describe("webhook integrations", () => {
  it("returns the signing secret once, maps event types and environment, updates and deletes", async () => {
    const created = await call("POST", HOOKS, {}, { json: { name: "Backend", url: "https://hooks.example.com/rd", authorization_header: "Bearer x", environment: "production", event_types: ["initial_purchase", "renewal"] } });
    expect(created.status).toBe(201);
    expect(created.body.signing_secret).toMatch(/^whsec_/);
    expect(created.body).toMatchObject({ object: "webhook_integration", environment: "production", event_types: ["initial_purchase", "renewal"], app_id: null });
    const id = created.body.id;
    const [row] = await h.db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id));
    expect(row!.eventTypes).toEqual(["INITIAL_PURCHASE", "RENEWAL"]);
    expect(row!.signingSecret).toBe(created.body.signing_secret);

    const got = await call("GET", `${HOOKS}/{webhook_integration_id}`, { webhook_integration_id: id });
    expect(got.body.signing_secret).toBeUndefined();
    expect(JSON.stringify(got.body)).not.toContain("Bearer x");
    expect((await call("GET", HOOKS)).body.items.every((w: any) => w.signing_secret === undefined)).toBe(true);

    const upd = await call("POST", `${HOOKS}/{webhook_integration_id}`, { webhook_integration_id: id }, { json: { environment: null, event_types: [], app_id: "app_ios" } });
    expect(upd.body).toMatchObject({ environment: null, event_types: [], app_id: "app_ios" });
    expect(upd.body.signing_secret).toBeUndefined();
    expect((await call("POST", `${HOOKS}/{webhook_integration_id}`, { webhook_integration_id: id }, { json: { url: "not a url" } })).body.param).toBe("url");
    expect((await call("POST", HOOKS, {}, { json: { name: "x", url: "https://x.io", event_types: ["nope"] } })).status).toBe(400);
    // `enabled` (a RevenueDot extension) is set with the update call and read from GET /v2/projects/{id}/webhooks.
    const states = async () => (await call("GET", "/v2/projects/{project_id}/webhooks", {}, { ext: true })).body.items;
    expect(await states()).toEqual([{ object: "webhook_state", id, enabled: true }]);
    const paused = await call("POST", `${HOOKS}/{webhook_integration_id}`, { webhook_integration_id: id }, { json: { enabled: false } });
    expect(paused.body.enabled).toBeUndefined();
    expect(await states()).toEqual([{ object: "webhook_state", id, enabled: false }]);
    expect((await call("POST", `${HOOKS}/{webhook_integration_id}`, { webhook_integration_id: id }, { json: { enabled: "no" } })).body.param).toBe("enabled");
    expect((await call("POST", HOOKS, {}, { json: { name: "x", url: "https://x.io", app_id: "appB" } })).body.param).toBe("app_id");

    expect((await call("DELETE", `${HOOKS}/{webhook_integration_id}`, { webhook_integration_id: id })).body).toMatchObject({ object: "webhook_integration", id });
    expect((await call("GET", `${HOOKS}/{webhook_integration_id}`, { webhook_integration_id: id })).status).toBe(404);
  });
});

describe("schema coverage", () => {
  it("the validator is live and rejects shapes that differ from RevenueCat's", () => {
    if (!spec) return;
    expect(spec.check("GET", `${APPS}/{app_id}`, 200, { object: "app", id: "x" })).not.toBeNull();
    expect(spec.check("GET", `${APPS}/{app_id}`, 404, { object: "error", type: "resource_missing", message: "x", retryable: false })).toBeNull();
    expect(spec.check("GET", `${APPS}/{app_id}`, 404, { object: "error", type: "parameter_error", message: "x", retryable: false })).not.toBeNull();
  });
  it("validated every catalog operation against RevenueCat's spec", () => {
    if (!spec) return;
    const want = [
      "GET /v2/projects 200", "POST /v2/projects 200",
      `GET ${APPS} 200`, `POST ${APPS} 201`, `GET ${APPS}/{app_id} 200`, `POST ${APPS}/{app_id} 200`, `DELETE ${APPS}/{app_id} 200`, `GET ${APPS}/{app_id}/public_api_keys 200`,
      `GET ${PRODUCTS} 200`, `POST ${PRODUCTS} 201`, `GET ${PRODUCTS}/{product_id} 200`, `POST ${PRODUCTS}/{product_id} 200`, `DELETE ${PRODUCTS}/{product_id} 200`,
      `POST ${PRODUCTS}/{product_id}/actions/archive 200`, `POST ${PRODUCTS}/{product_id}/actions/unarchive 200`,
      `GET ${ENTS} 200`, `POST ${ENTS} 201`, `GET ${ENTS}/{entitlement_id} 200`, `POST ${ENTS}/{entitlement_id} 200`, `DELETE ${ENTS}/{entitlement_id} 200`,
      `GET ${ENTS}/{entitlement_id}/products 200`, `POST ${ENTS}/{entitlement_id}/actions/attach_products 200`, `POST ${ENTS}/{entitlement_id}/actions/detach_products 200`,
      `POST ${ENTS}/{entitlement_id}/actions/archive 200`, `POST ${ENTS}/{entitlement_id}/actions/unarchive 200`,
      `GET ${OFFS} 200`, `POST ${OFFS} 201`, `GET ${OFFS}/{offering_id} 200`, `POST ${OFFS}/{offering_id} 200`, `DELETE ${OFFS}/{offering_id} 200`,
      `POST ${OFFS}/{offering_id}/actions/archive 200`, `POST ${OFFS}/{offering_id}/actions/unarchive 200`,
      `GET ${OFFS}/{offering_id}/packages 200`, `POST ${OFFS}/{offering_id}/packages 201`, `GET ${PKGS}/{package_id} 200`, `POST ${PKGS}/{package_id} 200`, `DELETE ${PKGS}/{package_id} 200`,
      `GET ${PKGS}/{package_id}/products 200`, `POST ${PKGS}/{package_id}/actions/attach_products 200`, `POST ${PKGS}/{package_id}/actions/detach_products 200`,
      `GET ${HOOKS} 200`, `POST ${HOOKS} 201`, `GET ${HOOKS}/{webhook_integration_id} 200`, `POST ${HOOKS}/{webhook_integration_id} 200`, `DELETE ${HOOKS}/{webhook_integration_id} 200`,
    ];
    expect(want.filter((w) => !spec!.checked.has(w))).toEqual([]);
  });
});
