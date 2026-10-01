// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (settings-auth), project settings and Auth (PR #12, prd/auth and prd/project-settings), on the real
// Node server and a fresh Railway development database:
//   - Auth: a developer turns Auth on and adds an OpenID Connect provider backed by a local test identity provider
//     (RSA keys generated here; its discovery document and JWKS are served by the capture server under the made-up host
//     idp.journeys.test, so no real identity provider is called). The app signs in anonymously, buys and sets
//     attributes, then signs in with an ID token (link_to_id merges the anonymous purchases), reads customer info,
//     attributes and balances with the access token, refreshes (rotation, replay ends the session) and revokes. A backend
//     reads the identity with a secret key; another project cannot. Every bad token is refused; the key cache refetches
//     an unknown kid at most once a minute; the dashboard's own sign-in on /auth/login still works.
//   - Blocked customers: entitlements vanish from the SDK (token and public key, every alias), v2, the identity read,
//     audiences and targeting; no currency is credited; a restore cannot move the purchase to a fresh id; unblock
//     restores everything.
//   - Sandbox testing access: nobody / allowlist (matched on every alias) / anybody, with real Test Store sandbox
//     purchases, the dashboard's test purchase tool and a Stripe test-mode purchase.
//   - Ownership transfer: a teammate joins as Admin through the emailed invite; they cannot remove, demote or replace
//     the owner; a secret key cannot transfer; the owner transfers and both get an email (SMTP sink).
//   - Brand presets reach the SDK's ui_config with the dark fallback; a font upload is served with a font type and CORS.
//   - Verified Metrics: a production (live mode) Stripe subscription, publish, the public page, JSON and OG image, slug
//     squatting and reserved names, escaping, the icon by slug, ETag, unpublish.
// Every state is checked through the API and SQL.
import { createHash, createPublicKey, createSign, generateKeyPairSync, verify as edVerify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { sleep, until } from "./lib/check.ts";
import { type Ctx, type Dev, anonId, sdkClient, signUp, standardCatalog } from "./lib/context.ts";
import { linksOf, type Captured } from "./lib/stack.ts";
import { FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.ts";

const IDP_HOST = "idp.journeys.test";
const ISSUER = `https://${IDP_HOST}`;
const AUD = "journey-ios-client";
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const decode = (jwt: string) => { const [h, p] = jwt.split("."); return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), payload: JSON.parse(Buffer.from(p!, "base64url").toString()) }; };
const sec = () => Math.floor(Date.now() / 1000);
const DAY = 86_400_000;

/** A local OpenID Connect provider: RSA keys, a discovery document and a JWKS answered on the capture server. */
function testIdp(ctx: Ctx) {
  const mk = (kid: string) => { const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } }; };
  const keys = [mk("k1")];
  const sign = (claims: Record<string, unknown>, o: { kid?: string; key?: KeyObject; header?: Record<string, unknown> } = {}) => {
    const k = keys[0]!;
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: o.kid ?? k.kid, ...o.header }));
    const body = b64url(JSON.stringify({ iss: ISSUER, aud: AUD, iat: sec(), exp: sec() + 600, ...claims }));
    return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(o.key ?? k.privateKey, "base64url")}`;
  };
  ctx.capture.handlers.push((c: Captured, res: ServerResponse) => {
    if (c.host !== IDP_HOST) return false;
    res.setHeader("content-type", "application/json");
    if (c.path === "/.well-known/openid-configuration") { res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, id_token_signing_alg_values_supported: ["RS256"] })); return true; }
    if (c.path === "/jwks") { res.setHeader("cache-control", "public, max-age=300"); res.end(JSON.stringify({ keys: keys.map((k) => k.jwk) })); return true; }
    res.statusCode = 404; res.end("{}"); return true;
  });
  const fetches = (path: string) => ctx.capture.of(IDP_HOST, path);
  return { keys, sign, fetches, rotate: () => keys.unshift(mk(`k${keys.length + 1}`)) };
}

const journey: Journey = {
  name: "settings-auth",
  title: "Auth (OIDC sign-in, refresh, revoke), blocked customers, sandbox testing access, ownership transfer, brand, Verified Metrics",
  async run(ctx: Ctx) {
    const { c, sql } = ctx;
    const dev = await signUp(ctx, "settings", "Scanner Pro");
    const P = dev.projectId;
    const cat = await standardCatalog(dev);
    const sdk = sdkClient(ctx, cat.testKey);
    await dev.v2("POST", "/virtual_currencies", { code: "GLD", name: "Gold", product_grants: [{ product_ids: [cat.products.coins.id], amount: 100 }] });
    const sk = await dev.v2("POST", "/api_keys", { name: "Backend" });
    const backend = (method: string, path: string, json?: unknown) => fetch(`${ctx.base}/v2/projects/${P}${path}`, { method, headers: { authorization: `Bearer ${sk.key}`, ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
    const customerIdOf = async (appUserId: string) => (await sql`SELECT a.customer_id FROM customer_aliases a JOIN customers c ON c.id = a.customer_id WHERE c.project_id = ${P} AND a.app_user_id = ${appUserId}`)[0]?.customer_id as string | undefined;
    const ents = (body: any) => Object.keys(body?.subscriber?.entitlements ?? {}).sort();
    const gold = async (id: string) => (await sdk.call("GET", `/v1/subscribers/${encodeURIComponent(id)}/virtual_currencies`)).body?.virtual_currencies?.GLD?.balance ?? 0;
    const buyWith = (token: string, user: string, product: string, fetchToken = `test_${Date.now()}_${crypto.randomUUID()}`) =>
      sdk.call("POST", "/v1/receipts", { app_user_id: user, fetch_token: fetchToken, product_id: product, price: product === "coins_100" ? 1.99 : 9.99, currency: "USD" }, { authorization: `Bearer ${token}` });

    // =================================================================================================================
    c.begin("Auth setup: a local OpenID Connect provider");
    const idp = testIdp(ctx);
    const login = (body: Record<string, unknown>, key = cat.testKey) => sdk.call("POST", "/auth/login", { scope: "openid offline_access", ...body }, { authorization: `Bearer ${key}` });
    const off = await login({ method: "anonymous" });
    c.check("sign-in is refused while Auth is off (403 · 7224)", off.status === 403 && off.body?.code === 7224, off);
    const settings = await dev.v2("POST", "/auth/settings", { enabled: true, allow_anonymous: true });
    c.has("Auth turned on with anonymous sign-in", settings, { enabled: true, allow_anonymous: true });
    const [projAuth] = await sql`SELECT auth_settings FROM projects WHERE id = ${P}`;
    c.eq("SQL: projects.auth_settings", projAuth?.auth_settings, { enabled: true, allow_anonymous: true });
    const prov = await dev.v2("POST", "/auth/providers", { kind: "oidc", name: "Journey IdP", issuer: ISSUER, audiences: [AUD], app_user_id_prefix: "idp:" });
    c.has("OIDC provider saved with discovery as its key source", prov, { kind: "oidc", issuer: ISSUER, audiences: [AUD], jwks_source: "discovery", app_user_id_claim: "sub", app_user_id_prefix: "idp:", enabled: true });
    const tested = await dev.v2("POST", `/auth/providers/${prov.id}/actions/test`, { id_token: idp.sign({ sub: "alice-1", email: "alice@journeys.test" }) });
    c.has("Test a token: valid, mapped app user id, not linked yet", tested, { valid: true, subject: "alice-1", app_user_id: "idp:alice-1", linked: false });
    c.check("the server fetched the discovery document and the JWKS from the provider", idp.fetches("/.well-known/openid-configuration").length === 1 && idp.fetches("/jwks").length === 1, ctx.capture.of(IDP_HOST).map((r) => r.path));
    c.eq("SQL: the test signed no one in (no identity link, no session)", (await sql`SELECT count(*)::int AS n FROM identity_links WHERE project_id = ${P}`)[0]!.n, 0);

    // =================================================================================================================
    c.begin("the app signs in anonymously, buys and sets attributes");
    const anon = await login({ method: "anonymous" });
    c.check("anonymous sign-in answers the token response", anon.status === 200 && anon.body.token_type === "Bearer" && anon.body.expires_in === 3600 && /^rdrf_[0-9a-f]{64}$/.test(anon.body.refresh_token), anon.status);
    const anonUser = decode(anon.body.access_token).payload["rc.app_user_id"] as string;
    c.check("the access token is a JWT the SDK decodes: rc.app_user_id is a new anonymous id, amr anonymous", /^\$RCAnonymousID:[0-9a-f]{32}$/.test(anonUser) && JSON.stringify(decode(anon.body.id_token).payload.amr) === '["anonymous"]', decode(anon.body.access_token).payload);
    const proBuy = await buyWith(anon.body.access_token, anonUser, "pro_monthly");
    c.check("a Test Store purchase with the access token unlocks pro", proBuy.status === 200 && ents(proBuy.body).includes("pro"), proBuy.body);
    const coinBuy = await buyWith(anon.body.access_token, anonUser, "coins_100");
    c.check("a coins purchase with the access token is accepted", coinBuy.status === 200, coinBuy.body);
    const setAttrs = await sdk.call("POST", "/v1/customer/attributes", { attributes: { $email: { value: "alice@journeys.test", updated_at_ms: Date.now() }, favourite: { value: "scanner", updated_at_ms: Date.now() } } }, { authorization: `Bearer ${anon.body.access_token}` });
    c.check("attributes set through /v1/customer/attributes with the token", setAttrs.status === 200, setAttrs);
    const someoneElse = await buyWith(anon.body.access_token, "someone_else", "pro_monthly");
    c.check("the token cannot post a receipt for another app user id (401 · 7224)", someoneElse.status === 401 && someoneElse.body.code === 7224, someoneElse);

    // =================================================================================================================
    c.begin("sign in with the identity provider; link_to_id merges the anonymous purchases");
    const aliceToken = idp.sign({ sub: "alice-1", email: "alice@journeys.test" });
    const alice = await login({ method: "oidc", id_token: aliceToken, link_to_id: anonUser });
    c.check("OIDC sign-in answers 200 with all three tokens", alice.status === 200 && alice.body.access_token && alice.body.id_token && alice.body.refresh_token, alice);
    const at = decode(alice.body.access_token), idt = decode(alice.body.id_token);
    c.has("access token: the claims the SDK reads", at, { header: { alg: "EdDSA", typ: "at+jwt" }, payload: { "rc.app_user_id": "idp:alice-1", sub: "idp:alice-1", amr: ["oidc"], iss: ctx.base, aud: cat.app.id } });
    c.has("ID token: amr, idp and the app user id", idt.payload, { "rc.app_user_id": "idp:alice-1", amr: ["oidc"], idp: prov.id });
    const jwks = (await fetch(`${ctx.base}/.well-known/jwks.json`).then((r) => r.json())) as any;
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwks.keys[0].x }, format: "jwk" });
    const [h1, p1, s1] = alice.body.id_token.split(".");
    c.check("the ID token verifies with GET /.well-known/jwks.json (Ed25519, matching kid)", jwks.keys.length === 1 && jwks.keys[0].kid === idt.header.kid && edVerify(null, Buffer.from(`${h1}.${p1}`), pub, Buffer.from(s1, "base64url")), jwks);
    const tokenHeaders = (t: string) => ({ authorization: `Bearer ${t}` });
    const info = await sdk.call("GET", "/v1/customer", undefined, tokenHeaders(alice.body.access_token));
    c.check("GET /v1/customer with the token: pro from the anonymous purchase, same customer", info.status === 200 && ents(info.body).includes("pro") && info.body.subscriber.original_app_user_id === anonUser, { status: info.status, ents: ents(info.body), original: info.body?.subscriber?.original_app_user_id });
    c.eq("SQL: the anonymous id and idp:alice-1 are one customer", await customerIdOf("idp:alice-1"), await customerIdOf(anonUser));
    const attrs = await sdk.call("GET", "/v1/customer/attributes", undefined, tokenHeaders(alice.body.access_token));
    c.check("GET /v1/customer/attributes: the attributes the app set, in the SDK's shape", attrs.status === 200 && attrs.body.subscriber_attributes?.$email?.value === "alice@journeys.test" && attrs.body.subscriber_attributes?.favourite?.value === "scanner" && typeof attrs.body.subscriber_attributes?.favourite?.updated_at_ms === "number", attrs.body);
    const bal = await sdk.call("GET", "/v1/customer/virtual_currencies", undefined, tokenHeaders(alice.body.access_token));
    c.eq("GET /v1/customer/virtual_currencies: 100 gold", bal.body?.virtual_currencies?.GLD?.balance, 100);
    const [link] = await sql`SELECT provider_id, subject, app_user_id, logins FROM identity_links WHERE project_id = ${P}`;
    c.has("SQL: identity link (provider, subject) → idp:alice-1", link, { provider_id: prov.id, subject: "alice-1", app_user_id: "idp:alice-1", logins: 1 });
    const tokRows = await sql`SELECT hash, session_id FROM subscriber_tokens WHERE app_user_id = 'idp:alice-1'`;
    c.check("SQL: the access token is stored only as its SHA-256, tied to its session", tokRows.length === 1 && tokRows[0]!.hash === sha256(alice.body.access_token) && !!tokRows[0]!.session_id, tokRows.map((r) => ({ session: r.session_id })));
    const [sess] = await sql`SELECT id, method, provider_id, subject, refresh_hash, revoked_at FROM identity_sessions WHERE app_user_id = 'idp:alice-1'`;
    c.has("SQL: the session stores the refresh token hashed", sess, { method: "oidc", provider_id: prov.id, subject: "alice-1", refresh_hash: sha256(alice.body.refresh_token), revoked_at: null });
    const aliasEvent = await sql`SELECT count(*)::int AS n FROM events WHERE project_id = ${P} AND type = 'SUBSCRIBER_ALIAS'`;
    c.check("SUBSCRIBER_ALIAS recorded for the merge", aliasEvent[0]!.n >= 1, aliasEvent[0]);

    c.begin("isolation of attributes and identities");
    const bob = await login({ method: "oidc", id_token: idp.sign({ sub: "bob-2" }), link_to_id: "idp:alice-1" });
    c.check("a non-anonymous link_to_id is ignored: bob signs in as himself, alice's customer untouched", bob.status === 200 && decode(bob.body.access_token).payload["rc.app_user_id"] === "idp:bob-2" && (await customerIdOf("idp:bob-2")) !== (await customerIdOf("idp:alice-1")), bob.status);
    const bobAttrs = await sdk.call("GET", "/v1/customer/attributes", undefined, tokenHeaders(bob.body.access_token));
    c.eq("bob's token reads only bob's (empty) attributes", bobAttrs.body, { subscriber_attributes: {} });
    const cross = await sdk.call("GET", `/v1/subscribers/${encodeURIComponent("idp:alice-1")}/attributes`, undefined, tokenHeaders(bob.body.access_token));
    c.check("bob's token cannot read alice's attributes by path (401 · 7224)", cross.status === 401 && cross.body.code === 7224, cross);
    const byKey = await sdk.call("GET", `/v1/subscribers/${encodeURIComponent("idp:alice-1")}/attributes`);
    c.check("the public SDK key cannot read attributes (401)", byKey.status === 401, byKey);
    const bobPro = await sdk.call("GET", "/v1/customer", undefined, tokenHeaders(bob.body.access_token));
    c.eq("bob has no entitlements", ents(bobPro.body), []);

    c.begin("a backend reads the identity with a secret key");
    const ident = await backend("GET", `/auth/identities/${prov.id}/alice-1`);
    c.check("identity read: app user id, pro and 100 gold", ident.status === 200 && ident.body.app_user_id === "idp:alice-1" && ident.body.active_entitlements.some((e: any) => e.lookup_key === "pro") && ident.body.virtual_currencies?.GLD?.balance === 100, ident.body);
    const listed = await backend("GET", `/auth/identities?app_user_id=${encodeURIComponent("idp:alice-1")}`);
    c.check("identity list filtered by app user id", listed.status === 200 && listed.body.items.length === 1 && listed.body.items[0].subject === "alice-1", listed.body);
    const cfgKey = await dev.v2("POST", "/api_keys", { name: "Config only", permissions: ["project_configuration:projects:read"] });
    const cfgRead = await fetch(`${ctx.base}/v2/projects/${P}/auth/identities/${prov.id}/alice-1`, { headers: { authorization: `Bearer ${cfgKey.key}` } });
    c.eq("a key without customer read scope cannot read identities (403)", cfgRead.status, 403);
    const other = await signUp(ctx, "other-project", "Other app");
    const otherKey = await other.v2("POST", "/api_keys", { name: "Theirs" });
    const foreign = await fetch(`${ctx.base}/v2/projects/${other.projectId}/auth/identities/${prov.id}/alice-1`, { headers: { authorization: `Bearer ${otherKey.key}` } });
    c.eq("another project cannot read this project's identity (404)", foreign.status, 404);
    const foreignKeyOnUs = await fetch(`${ctx.base}/v2/projects/${P}/auth/identities/${prov.id}/alice-1`, { headers: { authorization: `Bearer ${otherKey.key}` } });
    c.check("another project's key on this project's path is refused", foreignKeyOnUs.status === 401 || foreignKeyOnUs.status === 403 || foreignKeyOnUs.status === 404, foreignKeyOnUs.status);

    c.begin("tokens that fail any check are refused");
    const bad: [string, string][] = [
      ["expired", idp.sign({ sub: "alice-1", exp: sec() - 3600, iat: sec() - 7200 })],
      ["wrong audience", idp.sign({ sub: "alice-1", aud: "someone-else" })],
      ["wrong issuer", idp.sign({ sub: "alice-1", iss: "https://evil.journeys.test" })],
      ["issued in the future", idp.sign({ sub: "alice-1", iat: sec() + 3600 })],
      ["not valid yet", idp.sign({ sub: "alice-1", nbf: sec() + 3600 })],
      ["no subject", idp.sign({ sub: "" })],
      ["tampered payload", (() => { const [h, , s] = aliceToken.split("."); return `${h}.${b64url(JSON.stringify({ ...decode(aliceToken).payload, sub: "bob-2" }))}.${s}`; })()],
      ["alg none", `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(JSON.stringify({ iss: ISSUER, aud: AUD, sub: "alice-1", exp: sec() + 600 }))}.`],
      ["HS256 with the public key as the secret", (() => {
        const head = b64url(JSON.stringify({ alg: "HS256", kid: "k1" })), body = b64url(JSON.stringify({ iss: ISSUER, aud: AUD, sub: "alice-1", exp: sec() + 600 }));
        return `${head}.${body}.${createHash("sha256").update(JSON.stringify(idp.keys[0]!.jwk)).digest("base64url")}`;
      })()],
      ["signed by a stranger's key with a known kid", idp.sign({ sub: "alice-1" }, { key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey })],
    ];
    for (const [what, tok] of bad) {
      const r = await login({ method: "oidc", id_token: tok });
      c.check(`${what}: 401 · 7224`, r.status === 401 && r.body?.code === 7224, r.body);
    }
    const appKeyless = await fetch(`${ctx.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${sk.key}` }, body: JSON.stringify({ method: "oidc", id_token: aliceToken }) });
    c.eq("a secret key is not an app key for sign-in (401 · 7225)", (await appKeyless.json() as any).code, 7225);

    c.begin("the dashboard's own sign-in on /auth/login still works");
    const dash = await fetch(`${ctx.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: dev.email, password: dev.password }) });
    c.check("email and password without an Authorization header: 200 with a session cookie", dash.status === 200 && /rd_session=/.test(dash.headers.get("set-cookie") ?? ""), dash.status);
    const dashWithKey = await login({ email: dev.email, password: dev.password });
    c.check("the same body with an app key is an app sign-in (400 · method is required), never a dashboard session", dashWithKey.status === 400 && !(dashWithKey.headers.get("set-cookie") ?? "").includes("rd_session"), dashWithKey);

    // =================================================================================================================
    c.begin("refresh with rotation; a replayed refresh token ends the session");
    const refresh = (rt: string) => sdk.call("POST", "/auth/token", { grant_type: "refresh_token", refresh_token: rt });
    const r1 = await refresh(alice.body.refresh_token);
    c.check("refresh answers new access and refresh tokens", r1.status === 200 && r1.body.refresh_token !== alice.body.refresh_token && decode(r1.body.access_token).payload["rc.app_user_id"] === "idp:alice-1", r1.status);
    const [rot] = await sql`SELECT refresh_hash, previous_refresh_hash FROM identity_sessions WHERE id = ${sess!.id}`;
    c.check("SQL: the session rotated (new hash, the old one kept for replay detection)", rot?.refresh_hash === sha256(r1.body.refresh_token) && rot?.previous_refresh_hash === sha256(alice.body.refresh_token), rot);
    c.eq("the new access token reads customer info", (await sdk.call("GET", "/v1/customer", undefined, tokenHeaders(r1.body.access_token))).status, 200);
    const replay = await refresh(alice.body.refresh_token);
    c.check("replaying the old refresh token: 401 · 7224", replay.status === 401 && replay.body.code === 7224, replay.body);
    const afterReplay = await refresh(r1.body.refresh_token);
    c.eq("the replay ended the session: the current refresh token is refused too", afterReplay.status, 401);
    for (const [n, t] of [["first", alice.body.access_token], ["refreshed", r1.body.access_token]] as const) {
      const r = await sdk.call("GET", "/v1/customer", undefined, tokenHeaders(t));
      c.check(`the ${n} access token stops working (401 · 7224)`, r.status === 401 && r.body.code === 7224, r.status);
    }
    const [ended] = await sql`SELECT revoked_at FROM identity_sessions WHERE id = ${sess!.id}`;
    c.check("SQL: session revoked_at set, its access tokens deleted", ended?.revoked_at && (await sql`SELECT count(*)::int AS n FROM subscriber_tokens WHERE session_id = ${sess!.id}`)[0]!.n === 0, ended);

    c.begin("sign in again (the link is reused) and revoke");
    const again = await login({ method: "oidc", id_token: idp.sign({ sub: "alice-1", email: "alice@journeys.test" }) });
    c.eq("a later sign-in uses the link: idp:alice-1", decode(again.body.access_token).payload["rc.app_user_id"], "idp:alice-1");
    c.eq("SQL: logins counted on the link", (await sql`SELECT logins FROM identity_links WHERE provider_id = ${prov.id} AND subject = 'alice-1'`)[0]?.logins, 2);
    const rv = await sdk.call("POST", "/auth/revoke", { token: again.body.refresh_token, token_type_hint: "refresh_token" });
    c.check("revoke answers 200", rv.status === 200, rv);
    c.eq("the access token stops working at once", (await sdk.call("GET", "/v1/customer", undefined, tokenHeaders(again.body.access_token))).status, 401);
    c.eq("the revoked refresh token is refused", (await refresh(again.body.refresh_token)).status, 401);
    const [revoked] = await sql`SELECT revoked_at FROM identity_sessions WHERE refresh_hash = ${sha256(again.body.refresh_token)}`;
    c.check("SQL: revoked_at set", !!revoked?.revoked_at, revoked);

    c.begin("turning the provider off stops its sessions refreshing");
    const live = await login({ method: "oidc", id_token: idp.sign({ sub: "alice-1" }) });
    await dev.v2("POST", `/auth/providers/${prov.id}`, { enabled: false });
    const offRefresh = await refresh(live.body.refresh_token);
    c.check("provider disabled: refresh refused (403 · 7224) and sign-in refused", offRefresh.status === 403 && (await login({ method: "oidc", id_token: idp.sign({ sub: "alice-1" }) })).status === 403, offRefresh.body);
    await dev.v2("POST", `/auth/providers/${prov.id}`, { enabled: true });
    const backOn = await refresh(live.body.refresh_token);
    c.eq("provider enabled again: the session refreshes", backOn.status, 200);
    const alive = backOn.body as { access_token: string; refresh_token: string };

    // =================================================================================================================
    c.begin("blocked customers: entitlements vanish everywhere and come back on unblock");
    const promo = await dev.v2("POST", "/offerings", { lookup_key: "promo", display_name: "Promo" });
    const promoPkg = await dev.v2("POST", `/offerings/${promo.id}/packages`, { lookup_key: "$rc_annual", display_name: "Annual", position: 0 });
    await dev.v2("POST", `/packages/${promoPkg.id}/actions/attach_products`, { products: [{ product_id: cat.products.annual.id, eligibility_criteria: "all" }] });
    const aud = await dev.v2("POST", "/audiences", { name: "Pro customers", rules: { groups: [{ conditions: [{ field: "hasActiveEntitlement", operator: "is", value: "true" }] }] } });
    const rule = await dev.v2r("POST", "/targeting_rules", { name: "Pro sees promo", audience_id: aud.id, offering_id: promo.id, state: "active" });
    c.check("audience on active entitlements and a targeting rule created", rule.status < 300, rule.body);
    const audCount = async () => (await dev.v2("GET", `/audiences/${aud.id}?expand=stats`)).stats?.total_customers as number;
    const currentFor = async (id: string) => (await sdk.offerings(id)).body?.current_offering_id;
    const proBefore = await audCount();
    c.check("before the block: alice is in the audience and targeted to promo", proBefore >= 1 && (await currentFor("idp:alice-1")) === "promo", { count: proBefore, current: await currentFor("idp:alice-1") });
    const blk = await dev.v2r("POST", "/blocked_customers", { app_user_id: "idp:alice-1", note: "Chargeback fraud" });
    c.check("block answers 201 with who blocked it", blk.status === 201 && blk.body.customer_exists === true && blk.body.blocked_by?.type === "user", blk.body);
    const [blockRow] = await sql`SELECT app_user_id, note, blocked_by FROM blocked_customers WHERE project_id = ${P}`;
    c.check("SQL: the block row", blockRow?.app_user_id === "idp:alice-1" && blockRow?.note === "Chargeback fraud" && !!blockRow?.blocked_by, blockRow);
    const viaToken = await sdk.call("GET", "/v1/customer", undefined, tokenHeaders(alive.access_token));
    c.check("SDK (access token): no entitlements, the subscription still listed", viaToken.status === 200 && ents(viaToken.body).length === 0 && !!viaToken.body.subscriber.subscriptions?.pro_monthly, { ents: ents(viaToken.body) });
    const viaAlias = await sdk.customerInfo(anonUser);
    c.eq("SDK (public key, the anonymous alias): no entitlements", ents(viaAlias.body), []);
    const v2cust = await dev.v2("GET", `/customers/${encodeURIComponent("idp:alice-1")}`);
    c.eq("v2 customer: no active entitlements", v2cust.active_entitlements?.items, []);
    const v2subs = await dev.v2("GET", `/customers/${encodeURIComponent("idp:alice-1")}/subscriptions`);
    c.check("v2 subscriptions: still active at the store, gives_access false", v2subs.items.length >= 1 && v2subs.items.every((s: any) => s.gives_access === false), v2subs.items.map((s: any) => [s.status, s.gives_access]));
    const identBlocked = await backend("GET", `/auth/identities/${prov.id}/alice-1`);
    c.eq("identity read by the backend: no active entitlements", identBlocked.body.active_entitlements, []);
    c.check("audiences and targeting no longer see alice's entitlement", (await audCount()) === proBefore - 1 && (await currentFor("idp:alice-1")) === "default", { count: await audCount(), current: await currentFor("idp:alice-1") });
    const goldBefore = await gold("idp:alice-1");
    const coinsBlocked = await buyWith(alive.access_token, "idp:alice-1", "coins_100");
    c.check("a purchase while blocked is recorded but credits no gold", coinsBlocked.status === 200 && (await gold("idp:alice-1")) === goldBefore, { status: coinsBlocked.status, before: goldBefore, after: await gold("idp:alice-1") });
    const proToken = (await sql`SELECT store_key FROM subscriptions WHERE customer_id = ${(await customerIdOf("idp:alice-1"))!} AND product_identifier = 'pro_monthly'`)[0]?.store_key as string;
    const fresh = `fresh_${ctx.stamp}`;
    const restore = await sdk.purchase(fresh, "pro_monthly", { fetch_token: proToken, is_restore: true });
    c.check("restoring the blocked customer's purchase on a fresh id: 400 · 7102, nothing moves", restore.status === 400 && restore.body.code === 7102 && ents((await sdk.customerInfo(fresh)).body).length === 0, restore.body);
    c.eq("SQL: the subscription still belongs to alice's customer", (await sql`SELECT customer_id FROM subscriptions WHERE store_key = ${proToken}`)[0]?.customer_id, await customerIdOf("idp:alice-1"));
    const unblk = await dev.v2r("DELETE", `/blocked_customers/${encodeURIComponent("idp:alice-1")}`);
    c.check("unblock answers 200", unblk.status === 200, unblk.body);
    c.eq("SQL: the block row is gone", (await sql`SELECT count(*)::int AS n FROM blocked_customers WHERE project_id = ${P}`)[0]!.n, 0);
    c.check("after unblock: pro is back on the SDK, v2, the identity read, and targeting", ents((await sdk.call("GET", "/v1/customer", undefined, tokenHeaders(alive.access_token))).body).includes("pro")
      && (await dev.v2("GET", `/customers/${encodeURIComponent("idp:alice-1")}`)).active_entitlements.items.length >= 1
      && (await backend("GET", `/auth/identities/${prov.id}/alice-1`)).body.active_entitlements.length >= 1
      && (await currentFor("idp:alice-1")) === "promo");
    const audit = (await sql`SELECT action_type, target_identifier FROM audit_logs WHERE project_id = ${P}`).map((r) => `${r.action_type}:${r.target_identifier}`);
    c.check("audit log: blocked and unblocked", audit.includes("blocked_customer_created:idp:alice-1") && audit.includes("blocked_customer_deleted:idp:alice-1"), audit.filter((a) => a.startsWith("blocked")));
    await dev.v2("POST", `/targeting_rules/${rule.body.id}`, { state: "inactive" }).catch(() => null);

    // =================================================================================================================
    c.begin("sandbox testing access with real sandbox purchases");
    const setAccess = (body: Record<string, unknown>) => dev.v2("POST", "", body);
    const stripeApp = await dev.v2("POST", "/apps", { name: "Scanner Web", type: "stripe", stripe: { stripe_secret_key: FAKE_STRIPE_KEY, stripe_webhook_secret: `whsec_settings${ctx.stamp}` } });
    const stripeKey = (await dev.v2("GET", `/apps/${stripeApp.id}/public_api_keys`)).items[0].key as string;
    const stripeSdk = sdkClient(ctx, stripeKey, "stripe");
    const priceTest = { id: `price_test${ctx.stamp}`, object: "price", active: true, currency: "usd", product: `prod_test${ctx.stamp}`, recurring: { interval: "month", interval_count: 1 }, type: "recurring", unit_amount: 999, livemode: false };
    const priceLive = { ...priceTest, id: `price_live${ctx.stamp}`, product: `prod_live${ctx.stamp}`, livemode: true };
    for (const price of [priceTest, priceLive]) {
      const p = await dev.v2("POST", "/products", { store_identifier: price.id, app_id: stripeApp.id, type: "subscription", display_name: price.id, subscription: { duration: "P1M" } });
      await dev.v2("POST", `/entitlements/${cat.pro.id}/actions/attach_products`, { product_ids: [p.id] });
    }
    const stripeSub = (id: string, user: string, price: typeof priceTest) => {
      const start = Date.now() - DAY, end = start + 30 * DAY, live = price.livemode;
      ctx.capture.stripe.invoices.set(`in_${id}`, {
        id: `in_${id}`, object: "invoice", amount_due: 999, amount_paid: 999, amount_remaining: 0, attempt_count: 1, billing_reason: "subscription_create", collection_method: "charge_automatically",
        currency: "usd", customer: `cus_${id}`, customer_address: { country: "US" }, livemode: live, next_payment_attempt: null, period_start: Math.floor(start / 1000), period_end: Math.floor(start / 1000),
        paid: true, status: "paid", total: 999, subscription: id, status_transitions: { paid_at: Math.floor(start / 1000), finalized_at: Math.floor(start / 1000) },
        lines: { data: [{ period: { start: Math.floor(start / 1000), end: Math.floor(end / 1000) }, price }] },
      });
      ctx.capture.stripe.subscriptions.set(id, {
        id, object: "subscription", status: "active", livemode: live, customer: `cus_${id}`, created: Math.floor(start / 1000), start_date: Math.floor(start / 1000), billing_cycle_anchor: Math.floor(start / 1000),
        current_period_start: Math.floor(start / 1000), current_period_end: Math.floor(end / 1000), trial_start: null, trial_end: null, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
        cancellation_details: { comment: null, feedback: null, reason: null }, pause_collection: null, currency: "usd", metadata: { app_user_id: user }, latest_invoice: `in_${id}`, collection_method: "charge_automatically",
        items: { object: "list", data: [{ id: `si_${id}`, object: "subscription_item", price, quantity: 1 }] },
      });
      return stripeSdk.call("POST", "/v1/receipts", { app_user_id: user, fetch_token: id });
    };

    await setAccess({ sandbox_testing_access: "nobody" });
    c.eq("SQL: sandbox_testing_access nobody", (await sql`SELECT sandbox_testing_access FROM projects WHERE id = ${P}`)[0]?.sandbox_testing_access, "nobody");
    const nob = `nobody_${ctx.stamp}`;
    const nobBuy = await sdk.purchase(nob, "pro_monthly");
    c.check("Test Store purchase under nobody: recorded (200), no entitlement", nobBuy.status === 200 && ents(nobBuy.body).length === 0, nobBuy.body?.subscriber?.entitlements);
    await sdk.purchase(nob, "coins_100", { price: 1.99 });
    c.eq("Test Store coins under nobody: no gold credited", await gold(nob), 0);
    const tool = await dev.v2r("POST", "/test_purchases", { app_user_id: `tool_${ctx.stamp}`, product_id: "pro_monthly" });
    c.check("the dashboard's test purchase tool under nobody: recorded, the subscription gives no access", tool.status === 201 && tool.body.customer?.active_entitlements?.items?.length === 0 && tool.body.subscription?.gives_access === false, { status: tool.status, ents: tool.body?.customer?.active_entitlements, sub: tool.body?.subscription?.gives_access });
    const stTest = await stripeSub(`sub_sbx_${ctx.stamp}`, `stripe_${ctx.stamp}`, priceTest);
    c.check("a Stripe test-mode (web) purchase under nobody: recorded, no entitlement", stTest.status === 200 && ents(stTest.body).length === 0, stTest.body);
    const sbxRows = await sql`SELECT s.is_sandbox, s.store FROM subscriptions s JOIN customer_aliases a ON a.customer_id = s.customer_id WHERE a.app_user_id IN (${nob}, ${`stripe_${ctx.stamp}`})`;
    c.check("SQL: those purchases are stored as sandbox subscriptions", sbxRows.length === 2 && sbxRows.every((r) => r.is_sandbox), sbxRows);
    c.eq("v2 customer under nobody: no active entitlements", (await dev.v2("GET", `/customers/${nob}`)).active_entitlements.items, []);

    const anonTester = anonId(), tester = `tester_${ctx.stamp}`, outsider = `outsider_${ctx.stamp}`;
    await setAccess({ sandbox_testing_access: "allowlist", sandbox_testers: [tester, ` ${tester} `] });
    c.eq("SQL: allowlist saved trimmed, without duplicates", (await sql`SELECT sandbox_testers FROM projects WHERE id = ${P}`)[0]?.sandbox_testers, [tester]);
    await sdk.purchase(anonTester, "pro_monthly");
    c.eq("allowlist: an anonymous id that is not listed gets nothing", ents((await sdk.customerInfo(anonTester)).body), []);
    const loggedIn = await sdk.logIn(anonTester, tester);
    c.check("after logIn to an allowlisted id, the same purchase unlocks pro (every alias counts)", ents(loggedIn.body).includes("pro") && ents((await sdk.customerInfo(anonTester)).body).includes("pro"), ents(loggedIn.body));
    await sdk.purchase(tester, "coins_100", { price: 1.99 });
    c.eq("allowlisted tester: coins credit 100 gold", await gold(tester), 100);
    await sdk.purchase(outsider, "pro_monthly");
    c.eq("allowlist: an outsider's sandbox purchase gives nothing", ents((await sdk.customerInfo(outsider)).body), []);
    await setAccess({ sandbox_testing_access: "anybody" });
    c.check("anybody: the earlier purchases of nobody and the outsider unlock pro now", ents((await sdk.customerInfo(nob)).body).includes("pro") && ents((await sdk.customerInfo(outsider)).body).includes("pro") && ents((await stripeSdk.customerInfo(`stripe_${ctx.stamp}`)).body).includes("pro"));
    const project = await dev.v2("GET", "");
    c.has("GET project: sandbox settings", project, { sandbox_testing_access: "anybody", sandbox_testers: [tester] });

    // =================================================================================================================
    c.begin("brand presets reach the SDK, fonts are served safely");
    await dev.v2("POST", "/brand", { color_presets: [{ key: "primary", name: "Primary", light: "#0A0A0A" }, { key: "glass", name: "Glass", light: "#FFFFFF80", dark: "#00000080" }], gradient_presets: [{ key: "sunrise", name: "Sunrise", type: "linear", degrees: 90, points: [{ color: "#FF0000", percent: 0 }, { color: "#0000FF", percent: 100 }] }] });
    const offs = await sdk.offerings(`brand_${ctx.stamp}`);
    c.has("offerings ui_config.app.colors: dark falls back to light, alpha kept", offs.body?.ui_config?.app?.colors ?? {}, {
      primary: { light: { type: "hex", value: "#0a0a0aff" }, dark: { type: "hex", value: "#0a0a0aff" } },
      glass: { light: { type: "hex", value: "#ffffff80" }, dark: { type: "hex", value: "#00000080" } },
      sunrise: { dark: { type: "linear", degrees: 90 } },
    });
    c.eq("SQL: projects.brand stored", ((await sql`SELECT brand FROM projects WHERE id = ${P}`)[0]?.brand as any)?.color_presets?.length, 2);
    const fontFile = "/System/Library/Fonts/Supplemental/Andale Mono.ttf";
    if (existsSync(fontFile)) {
      const font = await dev.v2r("POST", "/fonts", { filename: "Andale Mono.ttf", content_type: "font/ttf", file_data_base64: readFileSync(fontFile).toString("base64") });
      c.check("font uploaded", font.status === 201 && /^font_/.test(font.body.font_key ?? ""), font.body);
      const served = await fetch(font.body.url, { headers: { origin: "https://app.example.com" } });
      c.check("the font is served as font/ttf with CORS *, nosniff and a sandbox CSP", served.status === 200 && served.headers.get("content-type") === "font/ttf" && served.headers.get("access-control-allow-origin") === "*" && served.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(served.headers.get("content-security-policy") ?? ""), Object.fromEntries(served.headers));
      const offs2 = await sdk.offerings(`brand2_${ctx.stamp}`);
      c.check("the SDK's ui_config lists the font", JSON.stringify(offs2.body?.ui_config?.app?.fonts ?? {}).includes(font.body.font_key), offs2.body?.ui_config?.app?.fonts);
      c.eq("deleting the font answers 200", (await dev.v2r("DELETE", `/fonts/${font.body.id}`)).status, 200);
      c.eq("the deleted font is no longer served", (await fetch(font.body.url)).status, 404);
    } else c.check("a TrueType font to upload is available on this machine", false, fontFile);

    // =================================================================================================================
    c.begin("Verified Metrics: a production purchase, publish, the public page and image");
    const liveSub = await stripeSub(`sub_live_${ctx.stamp}`, `paying_${ctx.stamp}`, priceLive);
    c.check("a live-mode Stripe subscription posted by the backend: production, pro", liveSub.status === 200 && ents(liveSub.body).includes("pro"), liveSub.body);
    c.check("SQL: the live subscription is production", (await sql`SELECT is_sandbox FROM subscriptions WHERE store_key = ${`sub_live_${ctx.stamp}`}`)[0]?.is_sandbox === false);
    const draft = await dev.v2("GET", "/verified_metrics");
    c.has("draft settings: never published, a slug from the project name", draft, { status: "never_published", slug: "scanner-pro", display_name: "Scanner Pro" });
    for (const [slug, why] of [["admin", "reserved"], ["ab", "too short"], ["a--b", "double dash"], ["Bad Slug", "spaces"]] as const) {
      const r = await dev.v2("GET", `/verified_metrics/slug_availability?slug=${encodeURIComponent(slug)}`);
      c.eq(`slug "${slug}" refused (${why})`, r.available, false);
    }
    const png1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const icon = await dev.v2("POST", "/media_assets", { filename: "icon.png", content_type: "image/png", file_data_base64: png1 });
    const name = `Scanner <script>alert(1)</script> "Pro"`;
    const pub2 = await dev.v2r("POST", "/verified_metrics/actions/publish", {
      slug: "scanner-pro", display_name: name, show_icon: true, icon_asset_id: icon.id, show_store_links: true, app_store_url: "https://apps.apple.com/app/id123456",
      metrics: [{ id: "revenue", visible: true }, { id: "mrr", visible: true }, { id: "active_subscriptions", visible: true }, { id: "active_trials", visible: false }, { id: "new_customers", visible: true }, { id: "active_users", visible: false }],
    });
    c.check("published", pub2.status === 200 && pub2.body.status === "published" && pub2.body.url === `${ctx.base}/verified/scanner-pro`, pub2.body);
    const [vp] = await sql`SELECT slug, status, published_at, display_name FROM verified_pages WHERE project_id = ${P}`;
    c.check("SQL: verified page published", vp?.status === "published" && vp?.slug === "scanner-pro" && !!vp?.published_at && vp?.display_name === name, vp);
    const page = await fetch(`${ctx.base}/verified/scanner-pro`);
    const html = await page.text();
    c.check("the public page answers 200, cacheable, with a strict CSP", page.status === 200 && page.headers.get("cache-control") === "public, max-age=300, s-maxage=900" && /default-src 'none'/.test(page.headers.get("content-security-policy") ?? ""), Object.fromEntries(page.headers));
    c.check("the display name is escaped, never markup", !html.includes("<script>alert(1)</script>") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &quot;Pro&quot;"), html.slice(0, 400));
    c.check("the page shows production revenue ($10) and the App Store link", html.includes("$10") && html.includes("https://apps.apple.com/app/id123456"));
    const leaks = [P, cat.app.id, stripeApp.id, "idp:alice-1", anonUser, `paying_${ctx.stamp}`, nob, tester, dev.email, "alice@journeys.test"];
    c.check("nothing about customers, the project or its apps leaks into the page", leaks.every((s) => !html.includes(s)), leaks.filter((s) => html.includes(s)));
    const metrics = await fetch(`${ctx.base}/verified/scanner-pro/metrics.json`).then((r) => r.json()) as any;
    const value = (id: string) => metrics.metrics.find((m: any) => m.id === id)?.value;
    c.eq("metrics.json: the visible metrics in order", metrics.metrics.map((m: any) => m.id), ["revenue", "mrr", "active_subscriptions", "new_customers"]);
    c.check("metrics.json: production numbers only (one live subscription at $9.99; the sandbox purchases are not counted)", value("revenue") === 9.99 && value("active_subscriptions") === 1 && Math.abs(value("mrr") - 9.99) < 0.01, metrics.metrics.map((m: any) => [m.id, m.value]));
    c.check("metrics.json leaks nothing either, and the icon is served by slug", leaks.every((s) => !JSON.stringify(metrics).includes(s)) && metrics.icon_url === `${ctx.base}/verified/scanner-pro/icon?v=${icon.id}`, metrics.icon_url);
    const iconRes = await fetch(metrics.icon_url);
    c.check("the icon answers image/png with nosniff", iconRes.status === 200 && iconRes.headers.get("content-type") === "image/png" && iconRes.headers.get("x-content-type-options") === "nosniff", iconRes.status);
    const og = await fetch(`${ctx.base}/verified/scanner-pro/og.png`);
    const ogBytes = Buffer.from(await og.arrayBuffer());
    c.check("og.png: a 1200×630 PNG", og.headers.get("content-type") === "image/png" && ogBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && ogBytes.readUInt32BE(16) === 1200 && ogBytes.readUInt32BE(20) === 630, { type: og.headers.get("content-type"), size: ogBytes.length });
    c.check("the page's og:image points at it", html.includes(`property="og:image" content="${ctx.base}/verified/scanner-pro/og.png"`));
    const etag = page.headers.get("etag")!;
    c.eq("If-None-Match with the ETag: 304", (await fetch(`${ctx.base}/verified/scanner-pro`, { headers: { "if-none-match": etag } })).status, 304);
    c.eq("the slug is case-insensitive", (await fetch(`${ctx.base}/verified/SCANNER-Pro`)).status, 200);
    c.eq("an unknown slug: 404", (await fetch(`${ctx.base}/verified/nobody-here`)).status, 404);
    const squat = await other.v2r("POST", "/verified_metrics/actions/publish", { slug: "scanner-pro" });
    c.check("another project cannot take the slug (409)", squat.status === 409, squat.body);
    c.eq("another project's slug check says it is taken", (await other.v2("GET", "/verified_metrics/slug_availability?slug=scanner-pro")).available, false);
    const saved = await dev.v2("POST", "/verified_metrics", { display_name: "Scanner Pro" });
    c.check("saving a published page keeps it published and the page shows the new name at once", saved.status === "published" && (await (await fetch(`${ctx.base}/verified/scanner-pro`)).text()).includes("<h1>Scanner Pro</h1>"));
    const unpub = await dev.v2("POST", "/verified_metrics/actions/unpublish", {});
    c.eq("unpublished: status inactive", unpub.status, "inactive");
    const gone = await Promise.all(["", "/metrics.json", "/og.png", "/icon"].map((p) => fetch(`${ctx.base}/verified/scanner-pro${p}`).then((r) => [r.status, r.headers.get("cache-control")])));
    c.check("after unpublishing every public path answers 404, not cached", gone.every(([s, cc]) => s === 404 && cc === "no-store"), gone);
    c.eq("SQL: verified page inactive", (await sql`SELECT status FROM verified_pages WHERE project_id = ${P}`)[0]?.status, "inactive");

    // =================================================================================================================
    c.begin("ownership transfer with the emailed invite and the mail sink");
    await ownership(ctx, dev, sk.key);

    // =================================================================================================================
    c.begin("the key cache picks up a rotated key, at most once a minute");
    const before = idp.fetches("/jwks").length;
    idp.rotate();
    const rotatedTok = idp.sign({ sub: "carol-3" });
    const early = await login({ method: "oidc", id_token: rotatedTok });
    const lastFetch = Math.max(...idp.fetches("/jwks").map((r) => r.at));
    if (Date.now() - lastFetch <= 60_000) {
      c.check("a new kid within a minute of the last fetch: refused without another fetch (401)", early.status === 401 && idp.fetches("/jwks").length === before, { status: early.status, fetches: idp.fetches("/jwks").length - before });
      await sleep(61_000 - (Date.now() - lastFetch));
    } else c.check("a new kid more than a minute after the last fetch is fetched at once", early.status === 200, early.body);
    const late = await login({ method: "oidc", id_token: idp.sign({ sub: "carol-3" }) });
    c.check("after a minute the new kid is fetched once and the sign-in works", late.status === 200 && idp.fetches("/jwks").length === before + 1, { status: late.status, fetches: idp.fetches("/jwks").length - before });
  },
};

async function ownership(ctx: Ctx, dev: Dev, secretKey: string) {
  const { c, sql } = ctx;
  const P = dev.projectId;
  const ownerId = (await sql`SELECT owner_user_id FROM projects WHERE id = ${P}`)[0]?.owner_user_id as string;
  const [me] = await sql`SELECT id FROM users WHERE email = ${dev.email}`;
  c.eq("SQL: the person who signed up owns the project", ownerId, me?.id);
  c.has("GET project names the owner", await dev.v2("GET", ""), { owner: { id: ownerId, email: dev.email } });
  const mate = `cofounder-${ctx.stamp}@journeys.test`;
  const inv = await dev.v2r("POST", "/invites", { email: mate, role: "admin" });
  c.check("an Admin invite is sent", inv.status === 201 && inv.body.email_sent === true, inv.body);
  const mail = await until(async () => ctx.mails.find((m) => m.to.includes(mate)));
  c.must("the invite email reached the mail sink", mail);
  const token = new URL(linksOf(mail!).find((l) => /\/invite\?/i.test(l))!).searchParams.get("token")!;
  const su = await fetch(`${ctx.base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: mate, password: `cofounder-${ctx.stamp}`, invite_token: token }) });
  c.check("the co-founder signs up from the invite and joins the project", su.status === 201 && ((await su.clone().json()) as any).project_id === P, su.status);
  const mateCookie = `rd_session=${/rd_session=([^;]+)/.exec(su.headers.get("set-cookie") ?? "")?.[1]}`;
  const asMate = (method: string, path: string, json?: unknown) => fetch(`${ctx.base}/v2/projects/${P}${path}`, { method, headers: { cookie: mateCookie, ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const [mateRow] = await sql`SELECT u.id, m.role FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = ${mate} AND m.project_id = ${P}`;
  c.eq("SQL: the co-founder is an admin member", mateRow?.role, "admin");
  const mateId = mateRow!.id as string;

  const removeOwner = await asMate("DELETE", `/collaborators/${ownerId}`);
  c.check("another admin cannot remove the owner (422)", removeOwner.status === 422 && /owner cannot be removed/.test(removeOwner.body?.message ?? ""), removeOwner);
  const demote = await asMate("POST", `/collaborators/${ownerId}`, { role: "developer" });
  c.check("another admin cannot demote the owner (422)", demote.status === 422, demote);
  const take = await asMate("POST", "/actions/transfer_ownership", { user_id: mateId });
  c.eq("another admin cannot transfer the project to themselves (403)", take.status, 403);
  const byKey = await fetch(`${ctx.base}/v2/projects/${P}/actions/transfer_ownership`, { method: "POST", headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" }, body: JSON.stringify({ user_id: mateId }) });
  c.eq("a secret API key cannot transfer ownership (403)", byKey.status, 403);
  const leave = await dev.v2r("DELETE", `/collaborators/${ownerId}`);
  c.check("the owner cannot leave while owning the project (422)", leave.status === 422 && /Transfer ownership/.test(leave.body?.message ?? ""), leave.body);

  const before = ctx.mails.length;
  const t = await dev.v2r("POST", "/actions/transfer_ownership", { user_id: mateId });
  c.check("the owner transfers to the admin co-founder; both emails sent", t.status === 200 && t.body.owner?.id === mateId && t.body.email_sent === true, t.body);
  const mails = await until(async () => { const m = ctx.mails.slice(before); return m.length >= 2 ? m : null; });
  const toNew = mails?.find((m) => m.to.includes(mate)), toOld = mails?.find((m) => m.to.includes(dev.email.toLowerCase()));
  c.check("the new owner's email: 'You now own Scanner Pro' with a link to project settings", !!toNew && /You now own Scanner Pro/.test(toNew.subject) && linksOf(toNew).some((l) => l.endsWith(`/projects/${P}/settings/general`)), toNew?.subject);
  c.check("the previous owner's email names the new owner", !!toOld && toOld.subject.includes("now owns Scanner Pro"), toOld?.subject);
  c.eq("SQL: owner_user_id is the co-founder", (await sql`SELECT owner_user_id FROM projects WHERE id = ${P}`)[0]?.owner_user_id, mateId);
  c.eq("SQL: the previous owner stays an admin", (await sql`SELECT role FROM memberships WHERE project_id = ${P} AND user_id = ${ownerId}`)[0]?.role, "admin");
  c.check("audit log: project_transfer_ownership", (await sql`SELECT count(*)::int AS n FROM audit_logs WHERE project_id = ${P} AND action_type = 'project_transfer_ownership'`)[0]!.n === 1);
  c.eq("the previous owner can no longer transfer (403)", (await dev.v2r("POST", "/actions/transfer_ownership", { user_id: ownerId })).status, 403);
  c.has("GET project names the new owner", (await asMate("GET", "")).body, { owner: { id: mateId, email: mate } });
}

export default journey;
