import { afterEach, describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "../src/services/auth.js";
import type { FetchFn } from "../src/stores/apple/api.js";
import { APP_ID, BUNDLE, appleHarness, makeP8, type AppleHarness } from "./apple-fixtures.js";

/**
 * The App Store Connect API key check (POST …/apps/{app_id}/actions/verify_app_store_connect_key) against a fake App Store
 * Connect that answers in Apple's documented shapes: 401 NOT_AUTHORIZED for any authentication failure, 403
 * FORBIDDEN_ERROR for a missing role, and an empty list for a bundle ID the key's team does not have.
 */
const CHECK = `/v2/projects/proj1/apps/${APP_ID}/actions/verify_app_store_connect_key`;
const ISSUER = "69a6de70-79a7-47e3-e053-5b8c7c11a4d1";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOT_AUTHORIZED = { errors: [{ status: "401", code: "NOT_AUTHORIZED", title: "Authentication credentials are missing or invalid.", detail: "Provide a properly configured and signed bearer token, and make sure that it has not expired." }] };
const FORBIDDEN = { errors: [{ status: "403", code: "FORBIDDEN_ERROR", title: "This request is forbidden for security reasons", detail: "The API key in use does not allow this request" }] };

/** A fake App Store Connect for one team: which key ID and issuer it accepts, its apps, and which reads the key's role allows. */
function fakeConnect(o: { keyId?: string; issuer?: string; apps?: { id: string; bundleId: string; name: string }[]; forbid?: "apps" | "products" | "agreements" | null; down?: boolean | 429 } = {}) {
  const calls: { method: string; path: string; kid: string | null; iss: string | null }[] = [];
  const apps = o.apps ?? [{ id: "6400000001", bundleId: BUNDLE, name: "Scanner" }];
  const fetchFn: FetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host !== "api.appstoreconnect.apple.com") throw new Error(`unexpected fetch ${url}`);
    const token = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    const kid = token ? String(decodeProtectedHeader(token).kid) : null;
    const iss = token ? String(decodeJwt(token).iss) : null;
    calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, kid, iss });
    if (o.down === 429) return json(429, { errors: [{ status: "429", code: "RATE_LIMIT_EXCEEDED", title: "The request rate limit has been reached." }] });
    if (o.down) return new Response("", { status: 503 });
    if (o.forbid === "agreements") return json(403, { errors: [{ status: "403", code: "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED", title: "A required agreement is missing or has expired.", detail: "This request requires an in-effect agreement that has not been signed or has expired." }] });
    if (kid !== (o.keyId ?? "2X9R4HXF34") || iss !== (o.issuer ?? ISSUER)) return json(401, NOT_AUTHORIZED);
    if (u.pathname === "/v1/apps") {
      if (o.forbid === "apps") return json(403, FORBIDDEN);
      const want = u.searchParams.get("filter[bundleId]");
      const list = want ? apps.filter((a) => a.bundleId === want) : apps;
      const limit = Number(u.searchParams.get("limit") ?? 50);
      return json(200, { data: list.slice(0, limit).map((a) => ({ type: "apps", id: a.id, attributes: { bundleId: a.bundleId, name: a.name } })), links: { self: url }, meta: { paging: { total: list.length, limit } } });
    }
    const m = /^\/v1\/apps\/(\d+)\/(subscriptionGroups|inAppPurchasesV2)$/.exec(u.pathname);
    if (m && apps.some((a) => a.id === m[1])) {
      if (o.forbid === "products") return json(403, FORBIDDEN);
      const total = m[2] === "subscriptionGroups" ? 2 : 5;
      return json(200, { data: [{ type: m[2] === "subscriptionGroups" ? "subscriptionGroups" : "inAppPurchases", id: "1", attributes: {} }], links: { self: url }, meta: { paging: { total, limit: 1 } } });
    }
    return json(404, { errors: [{ status: "404", code: "NOT_FOUND", title: "The specified resource does not exist" }] });
  };
  return { fetchFn, calls };
}

const creds = async (over: Record<string, unknown> = {}) => ({ app_store_connect_api_key: await makeP8(), app_store_connect_api_key_id: "2X9R4HXF34", app_store_connect_api_key_issuer: ISSUER, ...over });

describe("verify_app_store_connect_key", () => {
  let h: AppleHarness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  async function setup(fake: ReturnType<typeof fakeConnect>, credentials: Record<string, unknown> = {}) {
    h = await appleHarness({ credentials, fetch: fake.fetchFn });
    const { key } = await createSecretKey(h.db, "proj1", "setup");
    return async (body?: unknown, k = key) => {
      const res = await h!.request(CHECK, { method: "POST", headers: { Authorization: `Bearer ${k}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() as any };
    };
  }

  it("signs a JWT with the key, finds the app by bundle ID, reads one page of its products, and writes nothing", async () => {
    const asc = fakeConnect();
    const check = await setup(asc, await creds());
    const r = await check();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      object: "credentials_check", app_id: APP_ID, store: "app_store", key: "app_store_connect_api_key", status: "valid", valid: true,
      key_id: "2X9R4HXF34", app_store_app_id: "6400000001", app_name: "Scanner", subscription_groups: 2, in_app_purchases: 5,
    });
    expect(r.body.message).toMatch(/^Key 2X9R4HXF34 works: it sees Scanner \(Apple ID 6400000001\) and can read its 2 subscription groups and 5 in-app purchases\./);
    expect(r.body.message).toMatch(/App Manager or Admin role/);
    expect(asc.calls.map((c) => c.path.split("?")[0])).toEqual(["/v1/apps", "/v1/apps/6400000001/subscriptionGroups", "/v1/apps/6400000001/inAppPurchasesV2"]);
    expect(new URL(`https://x${asc.calls[0]!.path}`).searchParams.get("filter[bundleId]")).toBe(BUNDLE);
    expect(asc.calls.every((c) => c.method === "GET")).toBe(true);
    // A check changes nothing: no audit row, no credential change.
    expect(await h!.db.select().from(schema.auditLogs)).toHaveLength(0);
  });

  it("checks values in the body before they are saved, falling back to the stored ones", async () => {
    const asc = fakeConnect();
    const check = await setup(asc, {});
    expect((await check()).body.message).toBe("The App Store Connect API key is incomplete: add the .p8 file, the key ID and the issuer ID.");
    expect(asc.calls).toHaveLength(0);
    const r = await check(await creds());
    expect(r.body).toMatchObject({ status: "valid" });
    // Nothing was saved by the check.
    const [app] = await h!.db.select().from(schema.apps).where(eq(schema.apps.id, APP_ID));
    expect(app!.credentials).toEqual({});
    expect((await check({ app_store_connect_api_key_id: "2X9R4HXF34" })).body.message).toBe("The App Store Connect API key is incomplete: add the .p8 file and the issuer ID.");
  });

  it("names a malformed key ID or issuer ID without calling Apple", async () => {
    const asc = fakeConnect();
    const check = await setup(asc, await creds());
    const kid = await check({ app_store_connect_api_key_id: "abc" });
    expect(kid.body).toMatchObject({ status: "invalid", valid: false });
    expect(kid.body.message).toMatch(/^The key ID "abc" is not an App Store Connect key ID: those are 10 capital letters and digits/);
    const iss = await check({ app_store_connect_api_key_issuer: "my-team" });
    expect(iss.body.message).toMatch(/^The issuer ID "my-team" is not an App Store Connect issuer ID: that is a UUID/);
    const p8 = await check({ app_store_connect_api_key: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----" });
    expect(p8.body.message).toMatch(/not a valid \.p8 private key\. Upload the AuthKey_2X9R4HXF34\.p8 file/);
    expect(asc.calls).toHaveLength(0);
  });

  it("explains Apple's 401 for a wrong key ID, a wrong issuer ID, and the In-App Purchase key", async () => {
    const asc = fakeConnect();
    const check = await setup(asc, await creds());
    for (const over of [{ app_store_connect_api_key_id: "ZZZZZZZZZZ" }, { app_store_connect_api_key_issuer: "11111111-2222-3333-4444-555555555555" }]) {
      const r = await check(over);
      expect(r.body).toMatchObject({ status: "invalid", valid: false });
      expect(r.body.message).toMatch(/^Apple did not accept the key \(401\)\. The key ID, issuer ID and \.p8 file must belong to one team key/);
      expect(r.body.message).toMatch(/issuer ID is the one shown above the team keys list/);
    }
    expect(asc.calls.at(-2)).toMatchObject({ kid: "ZZZZZZZZZZ", iss: ISSUER });
    expect(asc.calls.at(-1)).toMatchObject({ kid: "2X9R4HXF34", iss: "11111111-2222-3333-4444-555555555555" });
    await h!.db.update(schema.apps).set({ credentials: { ...await creds({ app_store_connect_api_key_id: "SUBKEY0001" }), subscription_key_id: "SUBKEY0001" } }).where(eq(schema.apps.id, APP_ID));
    expect((await check()).body.message).toMatch(/^Key SUBKEY0001 is this app's In-App Purchase key, and App Store Connect does not accept In-App Purchase keys/);
  });

  it("names the missing role when Apple answers 403 to the app list or to the product reads", async () => {
    const forApps = await setup(fakeConnect({ forbid: "apps" }), await creds());
    expect((await forApps()).body.message).toBe("Apple accepted key 2X9R4HXF34 but refused to list apps (403). Give the key the App Manager or Admin role under Users and Access → Integrations → App Store Connect API.");
    await h!.close(); h = undefined;
    const forProducts = await setup(fakeConnect({ forbid: "products" }), await creds());
    expect((await forProducts()).body.message).toBe("Key 2X9R4HXF34 sees the app but cannot read its subscriptions and in-app purchases (403). Give the key the App Manager or Admin role under Users and Access → Integrations → App Store Connect API.");
  });

  it("names Apple's agreement 403 instead of the role, and checks a new .p8 with the stored key ID and issuer ID", async () => {
    const agreements = await setup(fakeConnect({ forbid: "agreements" }), await creds());
    const r = await agreements();
    expect(r.body.message).toMatch(/^Apple refused the request \(403 FORBIDDEN\.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED\): an agreement is missing or expired\./);
    expect(r.body.message).not.toMatch(/role/);
    await h!.close(); h = undefined;
    const asc = fakeConnect();
    const { app_store_connect_api_key: _, ...ids } = await creds();
    const check = await setup(asc, ids);
    expect((await check({ app_store_connect_api_key: await makeP8() })).body).toMatchObject({ status: "valid", key_id: "2X9R4HXF34" });
    expect(asc.calls[0]).toMatchObject({ kid: "2X9R4HXF34", iss: ISSUER });
  });

  it("tells a key of another team from a wrong bundle ID, and says when the app has no bundle ID", async () => {
    const other = await setup(fakeConnect({ apps: [{ id: "1", bundleId: "com.other.one", name: "One" }, { id: "2", bundleId: "com.other.two", name: "Two" }] }), await creds());
    expect((await other()).body.message).toBe(`Apple accepted key 2X9R4HXF34, but its team has no app with bundle ID ${BUNDLE} (the team has 2 apps). The key belongs to another team, or the bundle ID in App details is wrong. Create the key in the App Store Connect team that owns this app.`);
    // A bundle ID in the body is checked instead of the stored one.
    expect((await other({ bundle_id: "com.other.two" })).body).toMatchObject({ status: "valid", app_store_app_id: "2", app_name: "Two" });
    await h!.close(); h = undefined;
    const empty = await setup(fakeConnect({ apps: [] }), await creds());
    expect((await empty()).body.message).toMatch(/its team has no apps, so it cannot see bundle ID/);
    await h!.db.update(schema.apps).set({ bundleId: null }).where(eq(schema.apps.id, APP_ID));
    expect((await empty()).body.message).toBe("The app has no bundle ID. Add it in App details above, then check the key again.");
  });

  it("reports Apple being down as unreachable, refuses other app types, unknown apps and keys without the permission", async () => {
    const check = await setup(fakeConnect({ down: true }), await creds());
    const r = await check();
    expect(r.body).toMatchObject({ status: "unreachable", valid: false });
    expect(r.body.message).toMatch(/App Store Connect is not responding/);
    await h!.close(); h = undefined;
    const limited = await setup(fakeConnect({ down: 429 }), await creds());
    expect((await limited()).body).toMatchObject({ status: "unreachable", valid: false });
    await h!.db.update(schema.apps).set({ type: "mac_app_store" }).where(eq(schema.apps.id, APP_ID));
    expect((await limited()).body).toMatchObject({ store: "mac_app_store", status: "unreachable" });
    await h!.db.insert(schema.apps).values({ id: "app_play", projectId: "proj1", name: "Play", type: "play_store", bundleId: "com.x", publicKey: "goog_x", credentials: {} });
    const { key } = await createSecretKey(h!.db, "proj1", "k2");
    const play = await h!.request(CHECK.replace(APP_ID, "app_play"), { method: "POST", headers: { Authorization: `Bearer ${key}` } });
    expect(play.status).toBe(400);
    expect((await h!.request(CHECK.replace(APP_ID, "app_nope"), { method: "POST", headers: { Authorization: `Bearer ${key}` } })).status).toBe(404);
    const noScope = (await createSecretKey(h!.db, "proj1", "k3", ["customer_information:customers:read"])).key;
    expect((await check(undefined, noScope)).status).toBe(403);
    // Read access is not enough: the stored .p8 with another bundle ID would describe any app of the Apple team.
    const readOnly = (await createSecretKey(h!.db, "proj1", "k4", ["project_configuration:apps:read"])).key;
    expect((await check({ bundle_id: "com.other.app" }, readOnly)).status).toBe(403);
  });
});
