import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { openTestDb } from "../../../packages/contract/src/test-db.js";
import { secretKeyFrom, seal, unseal } from "../src/services/secrets.js";
import { resetSealBackfill, sealBackfillPending, sealStoredSecrets } from "../src/services/seal-backfill.js";
import { STORE_SECRET_FIELDS, withStoreSecrets } from "../src/services/store-secrets.js";
import { appleCredentials } from "../src/stores/apple/api.js";
import { connectCredentials } from "../src/stores/apple/connect.js";
import { serviceAccountOf } from "../src/stores/google/api.js";
import { sealedColumns, TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";
import { eeOrganizations, eeSsoConnections } from "../../../ee/server/schema.js";
import { createEnterprise } from "../../../ee/server/index.js";
import { appleHarness, makeReceipt } from "./apple-fixtures.js";

/** The Enterprise extension's sealed columns, as the tick collects them. */
const createEnterpriseColumns = () => [{ table: eeSsoConnections, id: eeSsoConnections.id, column: eeSsoConnections.secret }];

const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const P8 = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg-iap-secret\n-----END PRIVATE KEY-----";
const ASC = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg-asc-secret\n-----END PRIVATE KEY-----";
const SA = { type: "service_account", client_email: "rd@play-sandbox.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nplay-secret\n-----END PRIVATE KEY-----\n" };
/** A part of a secret that only the secret contains (PEM headers are shared). */
const frag = (v: string) => (v.length > 60 ? v.slice(30, 60) : v);
const SECRET_VALUES = [P8, ASC, SA.private_key, "apple-shared-secret-123", "amazon-shared-secret-456", "rk_test_notreal9876"];

let db: DB;
let close: () => Promise<void>;
const deps = (encryptionKey?: string) => ({ db, encryptionKey });
const app = async (id: string) => (await db.select().from(schema.apps).where(eq(schema.apps.id, id)))[0]!;

async function insertApp(id: string, type: string, values: Partial<typeof schema.apps.$inferInsert>) {
  await db.insert(schema.apps).values({ id, projectId: "proj1", name: id, type, bundleId: "com.example.app", publicKey: `pk_${id}`, ...values });
}

/** Production's shapes: the sandbox iOS app (App Store Connect key + IAP key), SuperScan (IAP key), the Play sandbox app. */
async function seedPlainRows() {
  await insertApp("app_ios_sandbox", "app_store", { credentials: {
    subscription_private_key: P8, subscription_key_id: "IAPKEY0001", subscription_key_issuer: "issuer-1",
    app_store_connect_api_key: ASC, app_store_connect_api_key_id: "ASCKEY0001", app_store_connect_api_key_issuer: "issuer-1",
    shared_secret: "apple-shared-secret-123", app_apple_id: "6700000001", track_new_purchases: true,
  } });
  await insertApp("app_superscan", "app_store", { credentials: { private_key: P8, key_id: "IAPKEY0002", issuer_id: "issuer-2", bundle_id: "com.superscan" } });
  await insertApp("app_play", "play_store", { credentials: { service_account: SA, pubsub_audience: "https://api.example.com/v1/notifications/google/app_play" } });
  await insertApp("app_play_json", "play_store", { credentials: { play_service_account_credentials_json: JSON.stringify(SA) } });
  await insertApp("app_amazon", "amazon", { credentials: { shared_secret: "amazon-shared-secret-456", sns_topic_arn: "arn:aws:sns:us-east-1:123456789012:t" } });
  await insertApp("app_stripe", "stripe", { credentials: { stripe_secret_key: "rk_test_notreal9876", app_user_id_source: "metadata" } });
  await insertApp("app_test", "test_store", { credentials: {} });
}

beforeEach(async () => {
  ({ db, close } = await openTestDb());
  await db.insert(schema.projects).values({ id: "proj1", name: "Backfill" });
  resetSealBackfill();
});
afterEach(async () => { await close(); });

describe("the store-secrets backfill", () => {
  it("seals plain Apple, Google, Amazon and Stripe secrets in place, keeps the non-secret fields, and the stores still read them", async () => {
    await seedPlainRows();
    expect(await sealBackfillPending(deps(TEST_ENCRYPTION_KEY))).toBe(6);
    const r = await sealStoredSecrets(deps(TEST_ENCRYPTION_KEY));
    expect(r).toEqual({ moved: 6, resealed: 0, unopenable: [] });
    expect(await sealBackfillPending(deps(TEST_ENCRYPTION_KEY))).toBe(0);
    const key = await secretKeyFrom(TEST_ENCRYPTION_KEY);

    const ios = await app("app_ios_sandbox");
    expect(ios.credentials).toEqual({ subscription_key_id: "IAPKEY0001", subscription_key_issuer: "issuer-1", app_store_connect_api_key_id: "ASCKEY0001", app_store_connect_api_key_issuer: "issuer-1", app_apple_id: "6700000001", track_new_purchases: true });
    expect(ios.secrets).toMatch(new RegExp(`^v1:${key!.id}:`));
    expect(ios.secretHints).toEqual({ subscription_private_key: "set", app_store_connect_api_key: "set", shared_secret: "set" });
    expect(await unseal(ios.secrets, key)).toEqual({ subscription_private_key: P8, app_store_connect_api_key: ASC, shared_secret: "apple-shared-secret-123" });
    const iosOpen = await withStoreSecrets(deps(TEST_ENCRYPTION_KEY), ios);
    expect(appleCredentials(iosOpen)).toMatchObject({ keyId: "IAPKEY0001", issuerId: "issuer-1", privateKey: P8 });
    expect(connectCredentials(iosOpen)).toEqual({ keyId: "ASCKEY0001", issuerId: "issuer-1", privateKey: ASC });

    const ss = await withStoreSecrets(deps(TEST_ENCRYPTION_KEY), await app("app_superscan"));
    expect(appleCredentials(ss)).toMatchObject({ keyId: "IAPKEY0002", privateKey: P8, bundleId: "com.superscan" });

    const play = await app("app_play");
    expect(play.credentials).toEqual({ pubsub_audience: "https://api.example.com/v1/notifications/google/app_play" });
    expect(play.secretHints).toEqual({ service_account: SA.client_email });
    expect(serviceAccountOf(await withStoreSecrets(deps(TEST_ENCRYPTION_KEY), play))).toMatchObject({ client_email: SA.client_email, private_key: SA.private_key });
    expect(serviceAccountOf(await withStoreSecrets(deps(TEST_ENCRYPTION_KEY), await app("app_play_json")))).toMatchObject({ client_email: SA.client_email });

    expect((await app("app_amazon")).credentials).toEqual({ sns_topic_arn: "arn:aws:sns:us-east-1:123456789012:t" });
    expect((await app("app_stripe")).secretHints).toEqual({ stripe_secret_key: "rk_test_…9876" });
    expect(await app("app_test")).toMatchObject({ credentials: {}, secrets: null });

    // Nothing secret is left in a plain column.
    for (const row of await db.select().from(schema.apps)) {
      const plain = JSON.stringify([row.credentials, row.secretHints, row.secrets]);
      for (const v of SECRET_VALUES) expect(plain).not.toContain(frag(v));
    }
  });

  it("an unopened app is refused loudly, never read as 'no key'", async () => {
    await seedPlainRows();
    await sealStoredSecrets(deps(TEST_ENCRYPTION_KEY));
    const sealed = await app("app_superscan");
    expect(() => appleCredentials(sealed)).toThrow(/sealed and were not opened/);
    const play = await app("app_play");
    expect(() => serviceAccountOf(play)).toThrow(/sealed and were not opened/);
  });

  it("is idempotent: a second run, and a run over rows sealed through the API, change nothing", async () => {
    await seedPlainRows();
    await insertApp("app_api", "app_store", await sealedColumns("app_store", { subscription_private_key: P8, subscription_key_id: "K3", subscription_key_issuer: "I3" }));
    await sealStoredSecrets(deps(TEST_ENCRYPTION_KEY));
    const before = await db.select().from(schema.apps);
    resetSealBackfill();
    expect(await sealStoredSecrets(deps(TEST_ENCRYPTION_KEY))).toEqual({ moved: 0, resealed: 0, unopenable: [] });
    expect(await db.select().from(schema.apps)).toEqual(before);
  });

  it("mixed rows: a plain copy joins what is sealed, the newer plain value wins a conflict, and empty plain fields are dropped", async () => {
    const key = await secretKeyFrom(TEST_ENCRYPTION_KEY);
    await insertApp("app_mixed", "app_store", {
      credentials: { subscription_private_key: P8, app_store_connect_api_key: ASC, app_store_connect_api_key_id: "A", app_store_connect_api_key_issuer: "I", shared_secret: "" },
      // An older sealed key: a plain value can only come back from a later writer (an archive import, an older server).
      secrets: await seal({ subscription_private_key: "older-sealed-key" }, key), secretHints: { subscription_private_key: "set" },
    });
    expect(await sealStoredSecrets(deps(TEST_ENCRYPTION_KEY))).toMatchObject({ moved: 1 });
    const row = await app("app_mixed");
    expect(row.credentials).toEqual({ app_store_connect_api_key_id: "A", app_store_connect_api_key_issuer: "I" });
    expect(await unseal(row.secrets, key)).toEqual({ subscription_private_key: P8, app_store_connect_api_key: ASC });
    expect(row.secretHints).toEqual({ subscription_private_key: "set", app_store_connect_api_key: "set" });
  });

  it("leaves a row it cannot open exactly as it is (sealed with another key), and logs only its id", async () => {
    const other = await secretKeyFrom(OTHER_KEY);
    const sealedElsewhere = await seal({ subscription_private_key: P8 }, other);
    await insertApp("app_foreign", "app_store", { credentials: { app_store_connect_api_key: ASC }, secrets: sealedElsewhere, secretHints: { subscription_private_key: "set" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await sealStoredSecrets(deps(TEST_ENCRYPTION_KEY));
    const printed = log.mock.calls.flat().join(" ");
    log.mockRestore();
    expect(r).toEqual({ moved: 0, resealed: 0, unopenable: ["app_foreign"] });
    expect(await app("app_foreign")).toMatchObject({ credentials: { app_store_connect_api_key: ASC }, secrets: sealedElsewhere });
    expect(printed).toContain("app_foreign");
    for (const v of SECRET_VALUES) expect(printed).not.toContain(frag(v));
  });

  it("without a key, follows the integration-secrets rule (plain: in apps.secrets), and seals those once a key is set", async () => {
    await seedPlainRows();
    expect(await sealStoredSecrets(deps(undefined))).toMatchObject({ moved: 6 });
    const plain = await app("app_superscan");
    expect(plain.secrets).toMatch(/^plain:/);
    expect(plain.credentials).toEqual({ key_id: "IAPKEY0002", issuer_id: "issuer-2", bundle_id: "com.superscan" });
    expect(appleCredentials(await withStoreSecrets(deps(undefined), plain))).toMatchObject({ privateKey: P8 });

    resetSealBackfill();
    expect(await sealStoredSecrets(deps(TEST_ENCRYPTION_KEY))).toMatchObject({ moved: 0, resealed: 6 });
    const key = await secretKeyFrom(TEST_ENCRYPTION_KEY);
    const now = await app("app_superscan");
    expect(now.secrets).toMatch(new RegExp(`^v1:${key!.id}:`));
    expect(await unseal(now.secrets, key)).toEqual({ private_key: P8 });
  });

  it("key rotation: with REVENUEDOT_ENCRYPTION_KEY=\"new,old\" every sealed value (apps, integrations, two-factor, archive keys, SSO secrets) is sealed again with the new key", async () => {
    const old = await secretKeyFrom(OTHER_KEY);
    await insertApp("app_rot", "play_store", { credentials: {}, secrets: await seal({ service_account: JSON.stringify(SA) }, old), secretHints: { service_account: SA.client_email } });
    await db.insert(schema.integrations).values({ id: "int1", projectId: "proj1", kind: "slack", name: "Slack", secrets: await seal({ webhook_url: "https://hooks.slack.com/services/T/B/x" }, old) });
    await db.insert(schema.users).values({ id: "u1", email: "kai@example.com", totpSecret: await seal({ totp: "JBSWY3DPEHPK3PXP" }, old) });
    await db.insert(schema.projectExports).values({ id: "exp1", projectId: "proj1", storage: "db", includeSecrets: true, secretKey: await seal({ k: "ZXhwb3J0LWtleQ==" }, old) });
    await db.insert(schema.projectImports).values({ id: "imp1", userId: "u1", tokenHash: "h", expiresAt: new Date("2026-10-05T00:00:00Z"), secretKey: await seal({ k: "aW1wb3J0LWtleQ==" }, old) });
    await db.insert(eeOrganizations).values({ id: "org1", name: "Acme" });
    await db.insert(eeSsoConnections).values({ id: "sso1", orgId: "org1", kind: "oidc", name: "Okta", config: { issuer: "https://acme.okta.com", client_id: "c" } as never, secret: await seal({ client_secret: "oidc-secret" }, old) });
    const both = `${TEST_ENCRYPTION_KEY},${OTHER_KEY}`;
    const columns = createEnterpriseColumns();
    expect(await sealStoredSecrets({ db, encryptionKey: both, columns })).toMatchObject({ moved: 0, resealed: 6, unopenable: [] });
    const fresh = await secretKeyFrom(TEST_ENCRYPTION_KEY);
    const rot = await app("app_rot");
    // After the rotation the old key can be removed: the new key alone opens everything.
    expect(await unseal(rot.secrets, fresh)).toEqual({ service_account: JSON.stringify(SA) });
    const [i] = await db.select().from(schema.integrations);
    expect(await unseal(i!.secrets, fresh)).toEqual({ webhook_url: "https://hooks.slack.com/services/T/B/x" });
    const [u] = await db.select().from(schema.users);
    expect(await unseal(u!.totpSecret, fresh)).toEqual({ totp: "JBSWY3DPEHPK3PXP" });
    expect(await unseal((await db.select().from(schema.projectExports))[0]!.secretKey, fresh)).toEqual({ k: "ZXhwb3J0LWtleQ==" });
    expect(await unseal((await db.select().from(schema.projectImports))[0]!.secretKey, fresh)).toEqual({ k: "aW1wb3J0LWtleQ==" });
    expect(await unseal((await db.select().from(eeSsoConnections))[0]!.secret, fresh)).toEqual({ client_secret: "oidc-secret" });
    resetSealBackfill();
    expect(await sealStoredSecrets({ db, encryptionKey: TEST_ENCRYPTION_KEY, columns })).toEqual({ moved: 0, resealed: 0, unopenable: [] });
  });

  it("a save between the read and the write wins (the write is conditional on the row being unchanged)", async () => {
    await seedPlainRows();
    const key = await secretKeyFrom(TEST_ENCRYPTION_KEY);
    // Simulates a dashboard save landing while the backfill runs: the backfill's update must not overwrite it.
    const realUpdate = db.update.bind(db);
    let raced = false;
    const spy = vi.spyOn(db, "update").mockImplementation(((table: unknown) => {
      if (!raced && table === schema.apps) {
        raced = true;
        return { set: (v: unknown) => ({ where: (w: unknown) => ({ returning: async (r: unknown) => {
          await realUpdate(schema.apps).set({ credentials: { key_id: "NEW", issuer_id: "NEW", bundle_id: "com.superscan" }, secrets: await seal({ private_key: "saved-by-user" }, key), secretHints: { private_key: "set" } }).where(eq(schema.apps.id, "app_ios_sandbox"));
          return (realUpdate(schema.apps).set(v as never).where(w as never) as unknown as { returning: (x: unknown) => Promise<unknown> }).returning(r);
        } }) }) } as never;
      }
      return realUpdate(table as never);
    }) as never);
    await sealStoredSecrets(deps(TEST_ENCRYPTION_KEY));
    spy.mockRestore();
    const row = await app("app_ios_sandbox");
    expect(await unseal(row.secrets, key)).toEqual({ private_key: "saved-by-user" });
  });

  it("covers every store that has secrets; Test Store and RevenueCat Billing have none", () => {
    expect(Object.keys(STORE_SECRET_FIELDS).sort()).toEqual(["amazon", "app_store", "galaxy", "mac_app_store", "paddle", "play_store", "roku", "stripe"]);
    expect(STORE_SECRET_FIELDS.test_store).toBeUndefined();
  });
});

describe("Apple and Google keys through the API", () => {
  it("are sealed on save, never stored plain, and never returned (app, app list, store settings)", async () => {
    const { harness } = await import("../../../packages/contract/src/harness.js");
    const h = await harness({ encryptionKey: TEST_ENCRYPTION_KEY });
    try {
      const v2 = async (method: string, path: string, json?: unknown) => {
        const res = await h.fetch(`/v2/projects/${h.ids.project}${path}`, { method, key: h.ids.secretKey, ...(json === undefined ? {} : { json }) });
        return { status: res.status, text: await res.text() };
      };
      let r = await v2("POST", "/apps", { name: "Sandbox iOS", type: "app_store", app_store: { bundle_id: "com.example.sandbox", subscription_private_key: P8, subscription_key_id: "IAPKEY0001", subscription_key_issuer: "issuer-1", shared_secret: "apple-shared-secret-123" } });
      expect(r.status).toBe(201);
      const ios = JSON.parse(r.text) as { id: string; app_store: Record<string, unknown> };
      expect(ios.app_store).toMatchObject({ subscription_key_configured: true });
      r = await v2("POST", `/apps/${ios.id}`, { app_store: { app_store_connect_api_key: ASC, app_store_connect_api_key_id: "ASCKEY0001", app_store_connect_api_key_issuer: "issuer-1" } });
      expect(JSON.parse(r.text).app_store).toMatchObject({ app_store_connect_api_key_configured: true, subscription_key_configured: true });
      r = await v2("POST", "/apps", { name: "Play sandbox", type: "play_store", play_store: { package_name: "com.example.play", play_service_account_credentials_json: JSON.stringify(SA) } });
      const play = JSON.parse(r.text) as { id: string; play_store: Record<string, unknown> };
      expect(play.play_store).toMatchObject({ play_service_account_credentials_configured: true });

      const iosRow = (await h.db.select().from(schema.apps).where(eq(schema.apps.id, ios.id)))[0]!;
      expect(iosRow.credentials).toEqual({ subscription_key_id: "IAPKEY0001", subscription_key_issuer: "issuer-1", app_store_connect_api_key_id: "ASCKEY0001", app_store_connect_api_key_issuer: "issuer-1" });
      expect(iosRow.secrets).toMatch(/^v1:/);
      const playRow = (await h.db.select().from(schema.apps).where(eq(schema.apps.id, play.id)))[0]!;
      expect(playRow.credentials).toEqual({});
      expect(playRow.secretHints).toEqual({ play_service_account_credentials_json: SA.client_email });

      const answers = [
        await v2("GET", "/apps"), await v2("GET", `/apps/${ios.id}`), await v2("GET", `/apps/${play.id}`),
        await v2("GET", `/apps/${ios.id}/store_settings`), await v2("GET", `/apps/${play.id}/store_settings`),
      ];
      for (const a of answers) {
        expect(a.status).toBe(200);
        for (const v of SECRET_VALUES) expect(a.text).not.toContain(frag(v));
      }
      const settings = JSON.parse(answers[4]!.text);
      expect(settings.credentials.play_service_account).toEqual({ configured: true, client_email: SA.client_email });
      const iosSettings = JSON.parse(answers[3]!.text);
      expect(iosSettings.credentials).toMatchObject({ subscription_key: { configured: true, key_id: "IAPKEY0001" }, app_store_connect_api_key: { configured: true }, shared_secret: { configured: true } });

      // Clearing a key removes it from the sealed value and its hint.
      r = await v2("POST", `/apps/${ios.id}`, { app_store: { shared_secret: null } });
      const cleared = (await h.db.select().from(schema.apps).where(eq(schema.apps.id, ios.id)))[0]!;
      expect(Object.keys(await unseal(cleared.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).sort()).toEqual(["app_store_connect_api_key", "subscription_private_key"]);
      expect(cleared.secretHints).not.toHaveProperty("shared_secret");
    } finally { await h.close(); }
  });
});

describe("review fixes", () => {
  it("the Enterprise extension declares the SSO client secret column for rotation, licensed or not", async () => {
    const ext = await createEnterprise({ env: {} });
    expect(ext.sealedColumns?.()).toEqual(createEnterpriseColumns());
  });

  it("after a run that finds nothing, the backfill checks again an hour later (rows an archive import or a move wrote plain)", async () => {
    let t = new Date("2026-10-04T00:00:00Z");
    const d = { db, encryptionKey: TEST_ENCRYPTION_KEY, now: () => t };
    expect(await sealStoredSecrets(d)).toEqual({ moved: 0, resealed: 0, unopenable: [] });
    await insertApp("app_late", "app_store", { credentials: { private_key: P8, key_id: "K", issuer_id: "I" } });
    t = new Date(t.getTime() + 59 * 60_000);
    expect((await sealStoredSecrets(d)).moved).toBe(0);
    t = new Date(t.getTime() + 2 * 60_000);
    expect((await sealStoredSecrets(d)).moved).toBe(1);
    expect((await app("app_late")).credentials).toEqual({ key_id: "K", issuer_id: "I" });
  });

  it("an empty REVENUEDOT_ENCRYPTION_KEY list is refused with a clear message", async () => {
    await expect(secretKeyFrom(" , ")).rejects.toThrow(/has no key in it/);
  });

  it("a save never drops sealed keys it cannot open: 422 until each one is entered again", async () => {
    const { harness } = await import("../../../packages/contract/src/harness.js");
    const h = await harness({ encryptionKey: TEST_ENCRYPTION_KEY });
    try {
      await h.db.update(schema.apps).set({ credentials: { subscription_key_id: "K", subscription_key_issuer: "I" }, secrets: await seal({ subscription_private_key: P8, shared_secret: "x" }, await secretKeyFrom(OTHER_KEY)), secretHints: { subscription_private_key: "set", shared_secret: "set" } }).where(eq(schema.apps.id, h.ids.app));
      const post = (json: unknown) => h.fetch(`/v2/projects/${h.ids.project}/apps/${h.ids.app}`, { method: "POST", key: h.ids.secretKey, json });
      let res = await post({ app_store: { subscription_private_key: ASC } });
      expect(res.status).toBe(422);
      expect((await res.json()).message).toMatch(/shared_secret could not be opened/);
      res = await post({ app_store: { subscription_private_key: ASC, shared_secret: null } });
      expect(res.status).toBe(200);
      const row = (await h.db.select().from(schema.apps).where(eq(schema.apps.id, h.ids.app)))[0]!;
      expect(await unseal(row.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).toEqual({ subscription_private_key: ASC });
    } finally { await h.close(); }
  });

  it("an App Store receipt never depends on the key: secrets this server cannot open are treated as no key", async () => {
    const h = await appleHarness({ credentials: { allow_unsigned_receipts: true, subscription_key_id: "K", subscription_key_issuer: "I", subscription_private_key: P8 } });
    try {
      await h.db.update(schema.apps).set({ secrets: await seal({ subscription_private_key: P8 }, await secretKeyFrom(OTHER_KEY)) }).where(eq(schema.apps.id, "app_ios"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const res = await h.postReceipt("user1", makeReceipt({ inApp: [{ productId: "pro_monthly", transactionId: "1000000001", purchaseDate: "2026-08-01T12:00:00Z", expiresDate: "2026-09-08T12:00:00Z" }] }), { product_id: "pro_monthly" });
      warn.mockRestore();
      expect(res.status).toBe(200);
      expect((await res.json()).subscriber.entitlements.pro).toBeDefined();
    } finally { await h.close(); }
  });
});

