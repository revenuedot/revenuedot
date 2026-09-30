import { openDb, schema, type DB } from "@revenuedot/db";
import { createApp, defaultStores } from "@revenuedot/server";

export interface Harness {
  db: DB;
  fetch: (path: string, init?: RequestInit & { key?: string; json?: unknown }) => Promise<Response>;
  setNow: (d: Date) => void;
  now: () => Date;
  close: () => Promise<void>;
  ids: { project: string; app: string; iosKey: string; testKey: string; androidKey: string; androidApp: string };
}

/** Boots the server on an in-memory Postgres with one project, an App Store app, a Play app and a Test Store app. */
export async function harness(): Promise<Harness> {
  const { db, close } = await openDb("pglite://memory");
  let clock = new Date("2026-09-01T12:00:00Z");
  const app = createApp({ db, now: () => clock, stores: defaultStores() });
  const ids = { project: "proj1", app: "app_ios", iosKey: "appl_testkey123", testKey: "test_key123", androidKey: "goog_testkey123", androidApp: "app_play" };
  await db.insert(schema.projects).values({ id: ids.project, name: "Scanner" });
  await db.insert(schema.apps).values([
    { id: ids.app, projectId: ids.project, name: "Scanner iOS", type: "app_store", bundleId: "com.example.scanner", publicKey: ids.iosKey },
    { id: ids.androidApp, projectId: ids.project, name: "Scanner Android", type: "play_store", bundleId: "com.example.scanner", publicKey: ids.androidKey },
    { id: "app_test", projectId: ids.project, name: "Test Store", type: "test_store", publicKey: ids.testKey },
  ]);
  // Catalog: pro entitlement unlocked by monthly/annual (iOS, Play, Test Store) and lifetime; coins are consumable.
  const prods = [
    { id: "p1", appId: ids.app, storeIdentifier: "pro_monthly", type: "subscription", duration: "P1M" },
    { id: "p2", appId: ids.app, storeIdentifier: "pro_annual", type: "subscription", duration: "P1Y" },
    { id: "p3", appId: ids.androidApp, storeIdentifier: "pro:monthly", type: "subscription", duration: "P1M" },
    { id: "p4", appId: "app_test", storeIdentifier: "pro_monthly", type: "subscription", duration: "P1M" },
    { id: "p5", appId: "app_test", storeIdentifier: "lifetime", type: "non_consumable" },
    { id: "p6", appId: "app_test", storeIdentifier: "coins_100", type: "consumable" },
  ];
  await db.insert(schema.products).values(prods.map((p) => ({ ...p, projectId: ids.project, displayName: p.storeIdentifier })));
  await db.insert(schema.entitlements).values({ id: "ent_pro", projectId: ids.project, lookupKey: "pro", displayName: "Pro access" });
  await db.insert(schema.entitlementProducts).values(["p1", "p2", "p3", "p4", "p5"].map((productId) => ({ entitlementId: "ent_pro", productId })));
  await db.insert(schema.offerings).values({ id: "ofr_default", projectId: ids.project, lookupKey: "default", displayName: "The standard set of packages", isCurrent: true });
  await db.insert(schema.packages).values([
    { id: "pkg_m", offeringId: "ofr_default", lookupKey: "$rc_monthly", displayName: "Monthly", position: 0 },
    { id: "pkg_a", offeringId: "ofr_default", lookupKey: "$rc_annual", displayName: "Annual", position: 1 },
  ]);
  await db.insert(schema.packageProducts).values([
    { packageId: "pkg_m", productId: "p1" }, { packageId: "pkg_a", productId: "p2" }, { packageId: "pkg_m", productId: "p3" }, { packageId: "pkg_m", productId: "p4" },
  ]);
  return {
    db, ids, close,
    setNow: (d) => { clock = d; },
    now: () => clock,
    fetch: (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.key !== "") headers.set("Authorization", `Bearer ${init.key ?? ids.iosKey}`);
      let body = init.body;
      if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
      return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { ...init, headers, body })));
    },
  };
}
