// Test server for store prices and the product editor (prd/catalog/PRD.md): the account test server with an App Store
// app and a Google Play app whose stores are the stateful fakes in packages/contract/src/fake-store-catalog.ts, seeded
// with subscriptions, in-app purchases, base plans and one-time products. No real store is called.
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { makeP8 } from "./apple-fixtures.js";
import { makeKeys } from "./google-helpers.js";
import { defaultStores } from "../src/stores/index.js";
import { createAppleStore } from "../src/stores/apple/index.js";
import { createGoogleStore } from "../src/stores/google/index.js";
import { FakeAppStoreConnect, FakePlayConsole } from "../../../packages/contract/src/fake-store-catalog.js";
import { sealedColumns, TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";

export const IOS_BUNDLE = "com.example.focus";
export const PLAY_PACKAGE = "com.example.focus.android";
export const ASC_KEY_ID = "ASCTEAM001";
export const PLAY_EMAIL = "editor@focus-project.iam.gserviceaccount.com";

export async function storeCatalogServer(o: { seed?: boolean } = {}) {
  const asc = new FakeAppStoreConnect();
  const play = new FakePlayConsole(PLAY_PACKAGE);
  asc.keyIds.add(ASC_KEY_ID);
  play.emails.add(PLAY_EMAIL);
  const route: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(asc.host)) return asc.fetch(input, init);
    if (url.startsWith("https://oauth2.googleapis.com/") || url.startsWith("https://androidpublisher.googleapis.com/")) return play.fetch(input, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  const s = await accountServer({ stores: { ...defaultStores(), app_store: createAppleStore({ fetch: route }), play_store: createGoogleStore({ fetch: route }) }, fetch: route, encryptionKey: TEST_ENCRYPTION_KEY });
  asc.now = s.now;
  const admin = await s.signup("kai@example.com", { name: "Kai" });
  const pid = admin.projectId!;
  const P = `/v2/projects/${pid}`;
  const keys = await makeKeys();
  const p8 = await makeP8();
  const ascCredentials = { app_store_connect_api_key: p8, app_store_connect_api_key_id: ASC_KEY_ID, app_store_connect_api_key_issuer: "57246542-96fe-1a63-e053-0824d011072a" };
  const sa = { ...keys.sa, client_email: PLAY_EMAIL };
  await s.db.insert(schema.apps).values([
    // Store keys sealed the way the API stores them (services/store-secrets.ts).
    { id: "app_ios", projectId: pid, name: "Focus iOS", type: "app_store", bundleId: IOS_BUNDLE, publicKey: "appl_focus", ...(await sealedColumns("app_store", ascCredentials)) },
    { id: "app_play", projectId: pid, name: "Focus Android", type: "play_store", bundleId: PLAY_PACKAGE, publicKey: "goog_focus", ...(await sealedColumns("play_store", { service_account: JSON.stringify(sa) })) },
    { id: "app_iap_only", projectId: pid, name: "Focus iOS (IAP key)", type: "app_store", bundleId: IOS_BUNDLE, publicKey: "appl_iaponly", credentials: { subscription_key_id: "IAPKEY0001", subscription_key: p8, subscription_key_issuer: "57246542-96fe-1a63-e053-0824d011072a" } },
    { id: "app_ts", projectId: pid, name: "Test Store", type: "test_store", publicKey: "test_focus" },
  ]);
  const ids = { ascApp: "", proMonthly: "", proAnnual: "", proWeekly: "", lifetime: "", coins: "" };
  if (o.seed !== false) {
    ids.ascApp = asc.addApp(IOS_BUNDLE, "Focus");
    ids.proMonthly = asc.addSubscription(ids.ascApp, "Focus Pro", "focus_pro_monthly", "Focus Pro Monthly", "ONE_MONTH", "APPROVED", 9.99);
    ids.proAnnual = asc.addSubscription(ids.ascApp, "Focus Pro", "focus_pro_annual", "Focus Pro Annual", "ONE_YEAR", "APPROVED", 59.99);
    ids.proWeekly = asc.addSubscription(ids.ascApp, "Focus Pro", "focus_pro_weekly", "Focus Pro Weekly", "ONE_WEEK", "READY_TO_SUBMIT");
    ids.lifetime = asc.addIap(ids.ascApp, "focus_lifetime", "Focus Lifetime", "NON_CONSUMABLE", "APPROVED", 99.99);
    ids.coins = asc.addIap(ids.ascApp, "focus_coins_100", "100 coins", "CONSUMABLE", "WAITING_FOR_REVIEW", 0.99);
    play.addSubscription("premium", "Focus Premium", [{ id: "monthly", period: "P1M", usd: 9.99 }, { id: "annual", period: "P1Y", usd: 59.99 }]);
    play.addSubscription("family", "Focus Family", [{ id: "yearly", period: "P1Y", usd: 79.99, state: "DRAFT" }]);
    play.addOneTime("focus_unlock", "Focus Unlock", 4.99);
  }
  // Catalog products for some of them, and a Test Store product with its own price.
  await s.db.insert(schema.products).values([
    { id: "prod_ios_m", projectId: pid, appId: "app_ios", storeIdentifier: "focus_pro_monthly", type: "subscription", duration: "P1M", displayName: "Focus Pro Monthly" },
    { id: "prod_ios_life", projectId: pid, appId: "app_ios", storeIdentifier: "focus_lifetime", type: "non_consumable", displayName: "Lifetime" },
    { id: "prod_play_m", projectId: pid, appId: "app_play", storeIdentifier: "premium:monthly", type: "subscription", duration: "P1M", displayName: "Premium monthly" },
    { id: "prod_ts_m", projectId: pid, appId: "app_ts", storeIdentifier: "pro_monthly", type: "subscription", duration: "P1M", displayName: "Pro monthly", testStorePriceMicros: 4_990_000, testStorePriceCurrency: "EUR" },
  ]);
  const member = async (email: string, role: "admin" | "developer" | "viewer") => {
    const m = await s.signup(email, { name: email.split("@")[0] });
    await s.db.insert(schema.memberships).values({ userId: m.userId, projectId: pid, role });
    return m;
  };
  return { ...s, asc, play, admin, pid, P, ids, member, api: admin.browser.call.bind(admin.browser) };
}

/** The CSV text a download answers, as rows of cells. */
export const csvRows = (text: string) => text.trim().split(/\r?\n/).map((l) => l.split(","));
