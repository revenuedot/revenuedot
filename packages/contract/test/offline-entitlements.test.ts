import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { computeEntitlements, isActive, type CustomerState } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { entitlementMap } from "@revenuedot/server/repo/catalog.js";
import { harness, type Harness } from "../src/harness.js";
import { ProductEntitlementMappingSchema } from "../src/sdk-schemas.js";
import { androidLookup, iosLookup, type Mapping } from "../src/offline-sdk.js";

/**
 * `GET /v1/product_entitlement_mapping` (prd/offline-entitlements/PRD.md): built from the SDK fixtures' catalogs, and run
 * through both SDKs' offline algorithms (re-implemented from purchases-ios Sources/OfflineEntitlements and purchases-android
 * common/offlineentitlements) to compare with the entitlements the server grants online.
 */
const fx = (p: string) => JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8")).product_entitlement_mapping as Mapping;

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const mappingFor = async (key: string): Promise<Mapping> => {
  const res = await h.fetch("/v1/product_entitlement_mapping", { key });
  expect(res.status).toBe(200);
  return ProductEntitlementMappingSchema.parse(await res.json()).product_entitlement_mapping;
};

/** One app with its products and entitlements, created in order so the mapping's ordering is deterministic. */
async function catalog(app: { id: string; type: string; key: string }, products: [string, string, string[]][]) {
  await h.db.insert(schema.apps).values({ id: app.id, projectId: "proj1", name: app.id, type: app.type, bundleId: `com.example.${app.id}`, publicKey: app.key });
  let t = Date.UTC(2026, 0, 1) + (await h.db.select().from(schema.products)).length * 1000;
  for (const [, , es] of products) for (const e of es) {
    await h.db.insert(schema.entitlements).values({ id: `ent_${e}`, projectId: "proj1", lookupKey: e, displayName: e, createdAt: new Date(t++) }).onConflictDoNothing();
  }
  const ents = new Map((await h.db.select().from(schema.entitlements)).map((e) => [e.lookupKey, e.id]));
  for (const [i, [storeId, type, es]] of products.entries()) {
    const id = `${app.id}_p${i}`;
    await h.db.insert(schema.products).values({ id, projectId: "proj1", appId: app.id, storeIdentifier: storeId, type, displayName: storeId, createdAt: new Date(t++) });
    for (const e of es) await h.db.insert(schema.entitlementProducts).values({ entitlementId: ents.get(e)!, productId: id });
  }
}

/** The entitlements the server grants online for one active purchase of a product (plan included). */
async function online(productId: string, plan: string | null, oneTime = false, store: "app_store" | "play_store" = "app_store"): Promise<string[]> {
  const now = h.now();
  const state: CustomerState = {
    originalAppUserId: "u", firstSeen: now, lastSeen: now, originalApplicationVersion: null, originalPurchaseDate: now, attributes: {},
    subscriptions: oneTime ? [] : [{ productIdentifier: productId, productPlanIdentifier: plan, store, isSandbox: false, purchaseDate: now, originalPurchaseDate: now, expiresDate: new Date(now.getTime() + 86_400_000), periodType: "normal" }],
    nonSubscriptions: oneTime ? [{ id: "n1", productIdentifier: productId, store: "app_store", isSandbox: false, purchaseDate: now, storeTransactionId: "t1", isConsumable: false }] : [],
  };
  return computeEntitlements(state, await entitlementMap(h.db, "proj1")).filter((e) => isActive(e, now)).map((e) => e.identifier).sort();
}

describe("product entitlement mapping from the SDK fixtures' catalogs", () => {
  it("an App Store catalog produces exactly the iOS fixture", async () => {
    await catalog({ id: "fx_ios", type: "app_store", key: "appl_fx" }, [
      ["com.revenuecat.foo_1", "subscription", ["pro_1"]], ["com.revenuecat.foo_2", "subscription", ["pro_1", "pro_2"]], ["com.revenuecat.foo_3", "subscription", ["pro_2"]],
    ]);
    expect(await mappingFor("appl_fx")).toEqual(fx("ios/resp-product-entitlement-mapping.json"));
  });

  it("a Play catalog produces the Android fixture, except that the bare subscription id carries every base plan's entitlements", async () => {
    await catalog({ id: "fx_play", type: "play_store", key: "goog_fx" }, [
      ["com.revenuecat.foo_1:p1m", "subscription", ["pro_1"]], ["com.revenuecat.foo_1:p1y", "subscription", ["pro_1", "pro_2"]], ["com.revenuecat.foo_2", "subscription", ["pro_3"]],
    ]);
    const ours = await mappingFor("goog_fx");
    const want = fx("android/product_entitlement_mapping.json");
    expect(Object.keys(ours).sort()).toEqual(Object.keys(want).sort());
    for (const k of Object.keys(want)) if (k !== "com.revenuecat.foo_1") expect(ours[k], k).toEqual(want[k]);
    expect(ours["com.revenuecat.foo_1"]).toEqual({ product_identifier: "com.revenuecat.foo_1", base_plan_id: "p1m", entitlements: ["pro_1", "pro_2"] });
    expect(want["com.revenuecat.foo_1"]!.entitlements).toEqual(["pro_1"]);
  });
});

describe("offline entitlements match what the server grants online", () => {
  beforeEach(async () => {
    await catalog({ id: "mix_ios", type: "app_store", key: "appl_mix" }, [
      ["basic_monthly", "subscription", ["basic"]], ["pro_yearly", "subscription", ["pro", "basic"]], ["lifetime_pro", "non_consumable", ["pro"]],
      ["gems_500", "consumable", ["basic"]], ["max:monthly", "subscription", ["max"]], ["max:upFront", "subscription", ["max", "pro"]],
      ["plus", "subscription", ["plus"]], ["plus:monthly", "subscription", ["plus_extra"]],
    ]);
    await catalog({ id: "mix_play", type: "play_store", key: "goog_mix" }, [
      ["team:monthly", "subscription", ["team"]], ["team:annual", "subscription", ["team", "pro"]], ["solo:monthly", "subscription", ["basic"]], ["legacy_sub", "subscription", ["basic"]],
    ]);
  });

  it("iOS gets the same entitlements offline as online for every App Store product without a billing plan", async () => {
    const m = await mappingFor("appl_mix");
    for (const p of ["basic_monthly", "pro_yearly"]) expect(iosLookup(m, p), p).toEqual(await online(p, null));
    expect(iosLookup(m, "lifetime_pro")).toEqual(await online("lifetime_pro", null, true));
    // Consumables never unlock an entitlement online, so they are not in the mapping (iOS also stops offline mode for them).
    expect(Object.values(m).some((e) => e.product_identifier === "gems_500")).toBe(false);
  });

  it("App Store billing plans are keyed the way iOS files them: monthly under product:monthly, up-front under the bare product id", async () => {
    const m = await mappingFor("appl_mix");
    expect(m["max:monthly"]).toEqual({ product_identifier: "max", base_plan_id: "monthly", entitlements: ["max"] });
    expect(m["max"]).toEqual({ product_identifier: "max", base_plan_id: "upFront", entitlements: ["max", "pro"] });
    expect(iosLookup(m, "max", "monthly")).toEqual(["max"]);
    expect(iosLookup(m, "max", "upFront")).toEqual(["max", "pro"]);
    expect(iosLookup(m, "max")).toEqual(["max", "pro"]);
  });

  it("iOS gets the same entitlements offline as online for App Store billing plans (the App Store adapter records Apple's MONTHLY as plan monthly)", async () => {
    const m = await mappingFor("appl_mix");
    // Stored only as max:monthly and max:upFront: a monthly purchase unlocks max, an up-front or older purchase max:upFront.
    expect(await online("max", "monthly")).toEqual(iosLookup(m, "max", "monthly"));
    expect(await online("max", null)).toEqual(iosLookup(m, "max", "upFront"));
    expect(await online("max", null)).toEqual(["max", "pro"]);
    // Bare plus and plus:monthly: online a monthly purchase also matches the bare product, so the plan key carries both.
    expect(m["plus:monthly"]).toEqual({ product_identifier: "plus", base_plan_id: "monthly", entitlements: ["plus_extra", "plus"] });
    expect(await online("plus", "monthly")).toEqual(iosLookup(m, "plus", "monthly"));
    expect(await online("plus", null)).toEqual(iosLookup(m, "plus"));
    // A product stored only bare and bought on the monthly plan unlocks online; iOS looks up basic_monthly:monthly offline
    // and finds nothing. Store the product as basic_monthly:monthly too to keep it offline (docs: offline entitlements).
    expect(await online("basic_monthly", "monthly")).toEqual(["basic"]);
    expect(iosLookup(m, "basic_monthly", "monthly")).toEqual([]);
  });

  it("Android: equal for a single base plan, a superset for several (the bare id holds the union, so nobody loses access)", async () => {
    const m = await mappingFor("goog_mix");
    expect(androidLookup(m, "solo")).toEqual(await online("solo", "monthly", false, "play_store"));
    expect(androidLookup(m, "legacy_sub")).toEqual(await online("legacy_sub", null, false, "play_store"));
    for (const plan of ["monthly", "annual"]) {
      const on = await online("team", plan, false, "play_store");
      expect(androidLookup(m, "team"), plan).toEqual(expect.arrayContaining(on));
    }
    expect(androidLookup(m, "team")).toEqual(["pro", "team"]);
    expect(m["team:monthly"]!.entitlements).toEqual(["team"]);
    expect(m["team"]!.base_plan_id).toBe("monthly");
  });

  it("each app gets only its own products; a secret key gets the whole project", async () => {
    const ios = await mappingFor("appl_mix");
    const play = await mappingFor("goog_mix");
    expect(Object.keys(ios).some((k) => k.startsWith("team") || k.startsWith("solo"))).toBe(false);
    expect(Object.keys(play).some((k) => k.startsWith("max") || k.startsWith("basic"))).toBe(false);
    const all = ProductEntitlementMappingSchema.parse(await (await h.fetch("/v1/product_entitlement_mapping", { key: h.ids.secretKey })).json()).product_entitlement_mapping;
    expect(all["team"]).toBeDefined();
    expect(all["pro_yearly"]).toBeDefined();
  });

  it("archived entitlements unlock nothing, archived products keep mapping", async () => {
    await h.db.update(schema.products).set({ state: "archived" }).where(eq(schema.products.id, "mix_ios_p0"));
    await h.db.update(schema.entitlements).set({ state: "archived" }).where(eq(schema.entitlements.lookupKey, "max"));
    const m = await mappingFor("appl_mix");
    expect(m["basic_monthly"]!.entitlements).toEqual(["basic"]);
    expect(m["max:monthly"]).toBeUndefined();
    expect(m["max"]!.entitlements).toEqual(["pro"]);
  });
});
