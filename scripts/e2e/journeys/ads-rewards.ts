// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (ads), rewarded ads and ad revenue as a developer and their app use them (prd/ads/PRD.md).
//   - The developer makes an in-app currency (GEMS) and ordered reward rules: gems per AdMob reward on one ad unit, a day
//     of Pro on another, a fallback; "first matching rule" is shown with test rewards before and after a reorder.
//   - The app's flow: the SDK polls GET /v1/subscribers/{id}/ads/reward_verifications/{client_transaction_id} (pending),
//     Google's signed server-side verification callback hits the real GET /v1/ads/admob/ssv, the poll answers verified,
//     and the ledger (SQL), the SDK's balance, the VIRTUAL_CURRENCY_TRANSACTION event and its delivered webhook
//     (key-checked against RevenueCat's sample) and the entitlement in customer info all agree.
//   - Google is played by the capture server: the verifier keys JSON (https://www.gstatic.com/admob/reward/verifier-keys.json)
//     holds the public half of a P-256 key generated here, and each callback is signed with its private half the way
//     Google signs (the query before &signature=, ECDSA SHA-256, DER, base64url). The real gstatic URL is never fetched.
//   - Abuse: replays, a tampered query, a foreign key, unknown key ids (keys refetched at most once a minute, a rotation
//     is picked up), user mismatch, missing user, another publisher's ad unit, appended parameters.
//   - Ad events from the SDK (POST /v1/events) for two networks, three formats and placements, two currencies; the v2 Ads
//     Overview and the dashboard's Ads page show the same numbers in USD; the Sandbox switch shows the Test Store's.
//   - AdMob connect: Google's authorization URL with a single-use state (never followed to Google; the capture server
//     answers the token and AdMob API calls), forged and replayed states refused, ad unit names loaded.
import { generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { sleep, until } from "./lib/check.ts";
import { type Ctx, eventsOf, sdkClient, signUp, standardCatalog } from "./lib/context.ts";
import type { Captured } from "./lib/stack.ts";
import { ROOT } from "./lib/stack.ts";
import { chromium } from "./onboarding.ts";
import { BUNDLED_ECB } from "../../../apps/server/src/services/fx-bundled.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(ROOT, `packages/contract/fixtures/${name}`), "utf8"));
const KEYS_HOST = "www.gstatic.com";
const KEYS_PATH = "/admob/reward/verifier-keys.json";
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const usdText = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** AdMob test ad unit ids (Google's public sample units): rewarded (gems), rewarded (day pass), banner. */
const UNIT_GEMS = "ca-app-pub-3940256099942544/5224354917";
const UNIT_PASS = "ca-app-pub-3940256099942544/1712485313";
const UNIT_BANNER = "ca-app-pub-3940256099942544/6300978111";
const short = (unit: string) => unit.split("/")[1]!;

interface SigningKey { id: string; priv: KeyObject; spki: string }
const newKey = (id: string): SigningKey => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { id, priv: privateKey, spki: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64") };
};

const journey: Journey = {
  name: "ads-rewards",
  title: "Ads: reward rules, AdMob SSV with a generated key, SDK poll, ledger, abuse cases, ad events, overview, AdMob connect",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dev = await signUp(ctx, "adsdev", "Puzzle Quest");
    const cat = await standardCatalog(dev);
    const ios = await dev.v2("POST", "/apps", { name: "Puzzle Quest iOS", type: "app_store", app_store: { bundle_id: "com.example.puzzlequest" } });
    const iosKey = (await dev.v2("GET", `/apps/${ios.id}/public_api_keys`)).items[0].key as string;
    const app = sdkClient(ctx, iosKey);
    const testApp = sdkClient(ctx, cat.testKey);
    const hookPath = `/hooks/ads-${ctx.stamp}`;
    await dev.v2("POST", "/integrations/webhooks", { name: "Capture", url: `${ctx.capture.base}${hookPath}`, authorization_header: "Bearer ads-secret" });
    const u = (name: string) => `${name}_${ctx.stamp}`;

    // ---------- Google, played by the capture server ----------
    const k1 = newKey(String(3_000_000_000 + Math.floor(Math.random() * 999_999_999)));
    const k2 = newKey(String(Number(k1.id) + 1));
    const stranger = newKey(k1.id);
    let served: SigningKey[] = [k1];
    const keyFetches = () => ctx.capture.of(KEYS_HOST, KEYS_PATH).length;
    let lastKeyFetch = 0;
    ctx.capture.handlers.push((req: Captured, res: ServerResponse) => {
      if (req.host !== KEYS_HOST || req.path !== KEYS_PATH) return false;
      lastKeyFetch = Date.now();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: served.map((k) => ({ keyId: Number(k.id), pem: `-----BEGIN PUBLIC KEY-----\n${k.spki}\n-----END PUBLIC KEY-----`, base64: k.spki })) }));
      return true;
    });

    /** The SDK's reward verification token (iOS generateRewardVerificationToken): sorted keys, the app's public key. */
    const token = (tx: string, apiKey = iosKey) => JSON.stringify({ api_key: apiKey, client_transaction_id: tx, impression_id: `imp-${tx.slice(0, 8)}` });
    const newTx = () => crypto.randomUUID().toUpperCase();
    /** Google's SSV callback: parameters in Google's order, the query before &signature= signed with ECDSA SHA-256 (DER, base64url). */
    const signed = (o: { tx: string; user: string; unit?: string; item?: string; amount?: number; networkTx?: string; key?: SigningKey; keyId?: string; custom?: string }) => {
      const q = [
        "ad_network=5450213213286189855", `ad_unit=${short(o.unit ?? UNIT_GEMS)}`, `custom_data=${encodeURIComponent(o.custom ?? token(o.tx))}`,
        `reward_amount=${o.amount ?? 10}`, `reward_item=${o.item ?? "coins"}`, `timestamp=${Date.now()}`, `transaction_id=${o.networkTx ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`}`,
        `user_id=${encodeURIComponent(o.user)}`,
      ].join("&");
      const sig = signData("sha256", Buffer.from(q), (o.key ?? k1).priv).toString("base64url");
      return { q, query: `${q}&signature=${sig}&key_id=${o.keyId ?? (o.key ?? k1).id}` };
    };
    const ssv = async (query: string) => {
      const res = await fetch(`${ctx.base}/v1/ads/admob/ssv${query ? `?${query}` : ""}`);
      const text = await res.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, body };
    };
    const poll = async (user: string, tx: string) => (await app.call("GET", `/v1/subscribers/${encodeURIComponent(user)}/ads/reward_verifications/${tx}`)).body;
    const balances = async (user: string) => (await app.call("GET", `/v1/subscribers/${encodeURIComponent(user)}/virtual_currencies`)).body?.virtual_currencies ?? {};
    const ledgerOf = (user: string) => ctx.sql`SELECT t.code, t.amount, t.source, t.reference, t.source_key FROM virtual_currency_transactions t
      JOIN customer_aliases a ON a.customer_id = t.customer_id AND a.project_id = t.project_id WHERE t.project_id = ${dev.projectId} AND a.app_user_id = ${user} ORDER BY t.created_at`;
    const verificationsOf = (clientTx: string) => ctx.sql`SELECT * FROM ad_reward_verifications WHERE project_id = ${dev.projectId} AND client_transaction_id = ${clientTx}`;

    // ---------- 1. Currency and rules ----------
    c.begin("in-app currency and reward rules (v2)");
    const gems = await dev.v2r("POST", "/virtual_currencies", { code: "GEMS", name: "Gems", description: "Premium gems" });
    c.check("GEMS currency created (201)", gems.status === 201, gems.body);
    const badCur = await dev.v2r("POST", "/ads/reward_rules", { name: "Typo", kind: "virtual_currency", currency_code: "GEMZ", amount: 1 });
    c.check("a rule for a currency that does not exist is refused (400, param currency_code)", badCur.status === 400 && badCur.body.param === "currency_code", badCur.body);
    const noDur = await dev.v2r("POST", "/ads/reward_rules", { name: "Pro", kind: "entitlement", entitlement_id: "pro" });
    c.check("an entitlement rule without a duration is refused (400, param duration_minutes)", noDur.status === 400 && noDur.body.param === "duration_minutes", noDur.body);
    const fallback = await dev.v2("POST", "/ads/reward_rules", { name: "Any rewarded ad: 1 gem", kind: "virtual_currency", currency_code: "GEMS", amount: 1 });
    const gemsRule = await dev.v2("POST", "/ads/reward_rules", { name: "Gems video: 2 gems per coin", kind: "virtual_currency", currency_code: "GEMS", multiplier: 2, ad_unit_id: UNIT_GEMS, reward_item: "coins" });
    const passRule = await dev.v2("POST", "/ads/reward_rules", { name: "Day pass: a day of Pro", kind: "entitlement", entitlement_id: "pro", duration_minutes: 1440, ad_unit_id: UNIT_PASS });
    c.has("currency rule stored with the multiplier", gemsRule, { object: "ad_reward_rule", kind: "virtual_currency", currency_code: "GEMS", multiplier: 2, amount: null, ad_unit_id: UNIT_GEMS, reward_item: "coins", enabled: true, position: 1 });
    c.has("entitlement rule stored with the duration", passRule, { kind: "entitlement", entitlement_id: "pro", duration_minutes: 1440, currency_code: null, position: 2 });

    // First matching rule: the catch-all is first, so a test reward for the gems unit grants its 1 gem.
    const tester = u("rule_tester");
    const t1 = await dev.v2("POST", "/ads/reward_verifications/test", { app_user_id: tester, ad_unit_id: UNIT_GEMS, reward_item: "coins", reward_amount: 10 });
    c.has("order [catch-all, gems, pass]: the first matching rule (catch-all) grants 1 gem", t1, { network: "test", status: "verified", rule_id: fallback.id, rewards: [{ type: "virtual_currency", code: "GEMS", amount: 1 }] });
    const reordered = await dev.v2("POST", "/ads/reward_rules/actions/reorder", { rule_ids: [gemsRule.id, passRule.id, fallback.id] });
    c.eq("reorder: gems, pass, catch-all", reordered.items.map((x: any) => [x.id, x.position]), [[gemsRule.id, 0], [passRule.id, 1], [fallback.id, 2]]);
    const partial = await dev.v2r("POST", "/ads/reward_rules/actions/reorder", { rule_ids: [gemsRule.id] });
    c.check("a reorder that leaves rules out is refused (400)", partial.status === 400, partial.body);
    const listed = await dev.v2("GET", "/ads/reward_rules");
    c.eq("GET reward_rules returns the new order", listed.items.map((x: any) => x.name), ["Gems video: 2 gems per coin", "Day pass: a day of Pro", "Any rewarded ad: 1 gem"]);
    const t2 = await dev.v2("POST", "/ads/reward_verifications/test", { app_user_id: tester, ad_unit_id: UNIT_GEMS, reward_item: "coins", reward_amount: 10 });
    c.has("after the reorder the gems rule matches first: 10 coins × 2 = 20 gems", t2, { status: "verified", rule_id: gemsRule.id, rewards: [{ type: "virtual_currency", code: "GEMS", amount: 20 }] });
    c.eq("the tester's balance is 1 + 20 gems", (await balances(tester)).GEMS?.balance, 21);

    // ---------- 2. The app's rewarded-ad flow ----------
    c.begin("rewarded ad: SDK poll, Google's signed callback, grant");
    const player = u("player_1");
    await app.customerInfo(player);
    const tx1 = newTx();
    const p0 = await poll(player, tx1);
    c.eq("poll before the callback: pending (the Android fixture)", p0, fixture("android/reward_verification_pending.json"));
    const t0 = Date.now();
    const cb1 = signed({ tx: tx1, user: player, networkTx: `gtx-${ctx.stamp}-1` });
    const r1 = await ssv(cb1.query);
    c.eq("Google's callback answers 200 recorded", [r1.status, r1.body], [200, { ok: true, recorded: true }]);
    const keysHits = ctx.capture.of(KEYS_HOST, KEYS_PATH);
    c.eq("the server fetched the verifier keys once (from the capture server)", keysHits.length, 1);
    const outbound = ctx.server.outbound(t0 - 5000).filter((o) => o.host === KEYS_HOST);
    c.check("the gstatic key URL was routed to the capture server, never fetched for real", outbound.length >= 1 && outbound.every((o) => o.routed.startsWith("http://127.0.0.1:") && o.path === KEYS_PATH && o.status === 200), outbound);
    const p1 = await poll(player, tx1);
    c.eq("poll after the callback: verified with 20 gems", p1, { status: "verified", reward: { type: "virtual_currency", code: "GEMS", amount: 20 }, more_rewards: [] });
    c.eq("the verified answer has the keys both SDKs decode (iOS reward + Android more_rewards)", Object.keys(p1).sort(), [...new Set([...Object.keys(fixture("ios/resp-reward-verification-verified.json")), "more_rewards"])].sort());
    c.eq("the reward has the keys of the SDK fixture's reward", Object.keys(p1.reward ?? {}).sort(), Object.keys(fixture("android/reward_verification_verified_virtual_currency.json").reward).sort());
    const ledger1 = await ledgerOf(player);
    const [v1] = await verificationsOf(tx1);
    c.check("ledger (SQL): one row, GEMS +20, source ad_reward, keyed by the verification", ledger1.length === 1 && ledger1[0]!.code === "GEMS" && ledger1[0]!.amount === 20 && ledger1[0]!.source === "ad_reward" && ledger1[0]!.reference === `admob:gtx-${ctx.stamp}-1` && ledger1[0]!.source_key === v1?.id, ledger1);
    c.has("verification row (SQL): admob, the signed parameters, verified by the gems rule", v1, { network: "admob", network_transaction_id: `gtx-${ctx.stamp}-1`, app_user_id: player, ad_unit_id: short(UNIT_GEMS), reward_item: "coins", reward_amount: 10, status: "verified", rule_id: gemsRule.id, is_sandbox: false, app_id: ios.id });
    c.eq("SDK balance: GEMS 20", (await balances(player)).GEMS, { balance: 20, name: "Gems", code: "GEMS", description: "Premium gems" });
    const vcEvents = await eventsOf(ctx, dev.projectId, { type: "VIRTUAL_CURRENCY_TRANSACTION", appUserId: player });
    c.check("one VIRTUAL_CURRENCY_TRANSACTION event recorded for the grant", vcEvents.length === 1, vcEvents);
    c.has("the event: +20 GEMS, source ad_reward, production, the network transaction id", vcEvents[0], { source: "ad_reward", transaction_id: `gtx-${ctx.stamp}-1`, purchase_environment: "PRODUCTION", app_id: ios.id, store: null, product_id: null });
    c.eq("the event's adjustments", vcEvents[0]?.adjustments, [{ amount: 20, currency: { code: "GEMS", description: "Premium gems", name: "Gems" } }]);

    c.begin("entitlement reward: a day of Pro");
    const player2 = u("player_2");
    await app.customerInfo(player2);
    const tx2 = newTx();
    const before2 = Date.now();
    const r2res = await ssv(signed({ tx: tx2, user: player2, unit: UNIT_PASS, item: "day_pass", amount: 1 }).query);
    c.eq("callback for the day-pass unit answers 200", r2res.status, 200);
    const p2 = await poll(player2, tx2);
    const exp = Date.parse(p2?.reward?.expires_at ?? "");
    c.check("poll: verified with entitlement pro expiring a day later (ISO 8601, seconds)", p2?.status === "verified" && p2.reward?.type === "entitlement" && p2.reward.identifier === "pro" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(p2.reward.expires_at) && Math.abs(exp - before2 - DAY) < 120_000 && Array.isArray(p2.more_rewards) && p2.more_rewards.length === 0, p2);
    const info2 = (await app.customerInfo(player2)).body;
    const pro = info2?.subscriber?.entitlements?.pro;
    c.check("customer info: pro active, promotional product rc_promo_pro_ad_reward, same expiry", pro?.product_identifier === "rc_promo_pro_ad_reward" && Math.abs(Date.parse(pro.expires_date) - exp) < 1000 && Date.parse(pro.expires_date) > Date.now(), pro);
    c.eq("no currency granted for the day pass", (await balances(player2)).GEMS?.balance ?? 0, 0);

    c.begin("first matching rule on real callbacks");
    const tx3 = newTx();
    await ssv(signed({ tx: tx3, user: player, unit: UNIT_GEMS, item: "bonus", amount: 5 }).query);
    c.eq("gems unit, reward item 'bonus': the gems rule (coins only) does not match, the catch-all grants 1 gem", await poll(player, tx3), { status: "verified", reward: { type: "virtual_currency", code: "GEMS", amount: 1 }, more_rewards: [] });
    c.eq("player balance 20 + 1", (await balances(player)).GEMS?.balance, 21);

    // ---------- 3. Abuse ----------
    c.begin("abuse: replays, forged signatures, wrong users");
    const replay = await ssv(cb1.query);
    c.eq("the identical callback replayed answers 200 (Google stops retrying)", replay.status, 200);
    const resigned = await ssv(signed({ tx: newTx(), user: player, networkTx: `gtx-${ctx.stamp}-1`, amount: 50 }).query);
    c.eq("the same transaction_id re-signed with another token answers 200", resigned.status, 200);
    const sameNet = await ctx.sql`SELECT count(*)::int AS n FROM ad_reward_verifications WHERE network = 'admob' AND network_transaction_id = ${`gtx-${ctx.stamp}-1`}`;
    c.eq("one verification per network transaction id", sameNet[0]!.n, 1);
    c.eq("no double grant: player still has 21 gems and 2 ledger rows", [(await balances(player)).GEMS?.balance, (await ledgerOf(player)).length], [21, 2]);

    const txT = newTx();
    const good = signed({ tx: txT, user: player, networkTx: `gtx-${ctx.stamp}-tamper` });
    const tampered = await ssv(good.query.replace("reward_amount=10", "reward_amount=1000"));
    c.eq("a tampered query (reward_amount 10 → 1000) is refused 403 'The signature is not valid.'", [tampered.status, tampered.body?.error], [403, "The signature is not valid."]);
    const foreign = await ssv(signed({ tx: txT, user: player, key: stranger, networkTx: `gtx-${ctx.stamp}-foreign` }).query);
    c.eq("a callback signed with another key under Google's key id is refused 403", [foreign.status, foreign.body?.error], [403, "The signature is not valid."]);
    const appended = await ssv(`${good.query}&user_id=mallory`);
    c.eq("a parameter appended after key_id is refused 400", appended.status, 400);
    c.eq("nothing recorded for the forged callbacks", (await verificationsOf(txT)).length, 0);
    c.eq("the forged callbacks did not refetch keys", keyFetches(), 1);

    const noUser = u("player_4");
    const txM = newTx();
    const missing = await ssv(signed({ tx: txM, user: "" }).query);
    c.eq("a callback with no user_id answers 200 (recorded)", missing.status, 200);
    c.eq("poll: failed missing_user with the documented message", await poll(noUser, txM), { status: "failed", failure_reason: "missing_user", message: "The ad network's callback has no user id. Pass the app user id to the network's server-side verification options." });
    const [vm] = await verificationsOf(txM);
    c.check("missing user: verification failed, no customer, nothing granted", vm?.status === "failed" && vm.customer_id === null && (vm.rewards as unknown[]).length === 0, vm);

    const victim = u("player_5"), other = u("player_6");
    await app.customerInfo(other);
    const txU = newTx();
    await ssv(signed({ tx: txU, user: victim }).query);
    c.eq("user mismatch: another customer's poll answers failed user_mismatch", await poll(other, txU), { status: "failed", failure_reason: "user_mismatch", message: "The ad network's user id is not this customer." });
    c.check("the polling customer got nothing (balance 0, no ledger rows)", ((await balances(other)).GEMS?.balance ?? 0) === 0 && (await ledgerOf(other)).length === 0, await balances(other));
    c.has("the reward went to the user Google signed for, once", { ledger: (await ledgerOf(victim)).length, poll: await poll(victim, txU) }, { ledger: 1, poll: { status: "verified", reward: { amount: 20 } } });

    const txX = newTx();
    const mallory = u("mallory");
    const foreignUnit = await ssv(signed({ tx: txX, user: mallory, unit: "ca-app-pub-1111111111111111/8888888888" }).query);
    c.eq("another publisher's ad unit: 200 recorded", foreignUnit.status, 200);
    c.eq("poll: failed unknown_ad_unit", (await poll(mallory, txX))?.failure_reason, "unknown_ad_unit");
    const malloryCust = await ctx.sql`SELECT count(*)::int AS n FROM customer_aliases WHERE project_id = ${dev.projectId} AND app_user_id = ${mallory}`;
    c.check("no customer created and nothing granted for the foreign ad unit", malloryCust[0]!.n === 0 && (await ledgerOf(mallory)).length === 0, malloryCust);

    const unknownKey = await ssv(signed({ tx: newTx(), user: player, custom: token(newTx(), "appl_notarealkey0000000000") }).query);
    c.eq("a token with an API key that is not an app's: 200, not recorded (Google stops retrying)", unknownKey.body, { ok: true, recorded: false, reason: "unknown_api_key" });
    const verify = await ssv("");
    c.eq("AdMob's 'Verify URL' check (no parameters) answers 200", [verify.status, verify.body], [200, { ok: true }]);

    const failedList = await dev.v2("GET", "/ads/reward_verifications?status=failed");
    c.eq("the rewards ledger lists the two failed verifications with their reasons", failedList.items.map((x: any) => x.failure_reason).sort(), ["missing_user", "unknown_ad_unit"]);
    const playerList = await dev.v2("GET", `/ads/reward_verifications?app_user_id=${encodeURIComponent(player)}`);
    c.check("the ledger for player_1: two verified AdMob rewards (20 and 1 gems)", playerList.items.length === 2 && playerList.items.every((x: any) => x.status === "verified" && x.network === "admob"), playerList.items.map((x: any) => [x.status, x.rewards]));

    c.begin("VIRTUAL_CURRENCY_TRANSACTION webhook delivered and key-checked");
    const want = fixture("webhooks/in-app_currency_transaction.json").event as Record<string, unknown>;
    const delivered = await until(async () => {
      const got = ctx.capture.requests.filter((r) => r.host === "local" && r.path === hookPath).map((r) => ({ r, e: JSON.parse(r.body).event as Record<string, any> }));
      return got.find((x) => x.e.type === "VIRTUAL_CURRENCY_TRANSACTION" && x.e.transaction_id === `gtx-${ctx.stamp}-1`) ?? null;
    }, { timeoutMs: 90_000, everyMs: 1000 });
    c.check("the grant's event reached the webhook endpoint with the Authorization header and a signature", delivered && delivered.r.headers.authorization === "Bearer ads-secret" && /t=\d+,v1=[0-9a-f]{64}/.test(delivered.r.headers["x-revenuecat-webhook-signature"] ?? ""), delivered?.r.headers);
    c.eq("delivered event has exactly the keys of RevenueCat's in-app currency sample", Object.keys(delivered?.e ?? {}).sort(), Object.keys(want).sort());
    c.has("delivered event values", delivered?.e, { app_user_id: player, source: "ad_reward", purchase_environment: "PRODUCTION", adjustments: [{ amount: 20, currency: { code: "GEMS", name: "Gems", description: "Premium gems" } }] } as any);
    c.check("delivered event: virtual_currency_transaction_id vatx…, integer event_timestamp_ms", /^vatx/.test(delivered?.e.virtual_currency_transaction_id ?? "") && Number.isInteger(delivered?.e.event_timestamp_ms), delivered?.e);

    // ---------- 5. AdMob connect (before the overview, so ad unit names show) ----------
    c.begin("AdMob connect: Google OAuth start, single-use state, ad units");
    const clientId = `4242${ctx.stamp.slice(-6)}-adsjourney.apps.googleusercontent.com`;
    const access = `ya29.ads-journey-${ctx.stamp}`;
    const pub = "pub-3940256099942544";
    ctx.capture.handlers.push((req: Captured, res: ServerResponse) => {
      const json = (b: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); return true; };
      if (req.host === "oauth2.googleapis.com" && req.path === "/token" && new URLSearchParams(req.body).get("client_id") === clientId) {
        const p = new URLSearchParams(req.body);
        if (p.get("grant_type") === "authorization_code") return json({ access_token: access, refresh_token: `1//ads-journey-refresh-${ctx.stamp}`, expires_in: 3599, token_type: "Bearer" });
        return json({ access_token: access, expires_in: 3599, token_type: "Bearer" });
      }
      if (req.host === "admob.googleapis.com" && req.headers.authorization === `Bearer ${access}`) {
        if (req.path === "/v1/accounts") return json({ account: [{ name: `accounts/${pub}`, publisherId: pub, currencyCode: "USD", reportingTimeZone: "America/Los_Angeles" }] });
        if (req.path === `/v1/accounts/${pub}/adUnits`) return json({ adUnits: [
          { name: `accounts/${pub}/adUnits/5224354917`, adUnitId: UNIT_GEMS, appId: "ca-app-pub-3940256099942544~1458002511", displayName: "Gems video", adFormat: "REWARDED" },
          { name: `accounts/${pub}/adUnits/1712485313`, adUnitId: UNIT_PASS, appId: "ca-app-pub-3940256099942544~1458002511", displayName: "Day pass video", adFormat: "REWARDED" },
          { name: `accounts/${pub}/adUnits/6300978111`, adUnitId: UNIT_BANNER, appId: "ca-app-pub-3940256099942544~1458002511", displayName: "Feed banner", adFormat: "BANNER" },
        ] });
      }
      return false;
    });
    const notConfigured = await dev.v2r("POST", "/ads/admob/connect", {});
    c.check("without a server OAuth client, connect asks for the project's own client (422)", notConfigured.status === 422 && /OAuth client/.test(notConfigured.body.message ?? ""), notConfigured.body);
    const view0 = await dev.v2("GET", "/ads/admob");
    c.has("AdMob page: not connected, the SSV and redirect URLs on this server", view0, { connected: false, ssv_callback_url: `${ctx.base}/v1/ads/admob/ssv`, redirect_uri: `${ctx.base}/v1/ads/admob/oauth/callback` });
    const start = await dev.v2("POST", "/ads/admob/connect", { client_id: clientId, client_secret: `journey-client-secret-${ctx.stamp}` });
    const authUrl = new URL(start.url);
    const state = authUrl.searchParams.get("state") ?? "";
    c.eq("connect returns Google's authorization endpoint", authUrl.origin + authUrl.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    c.has("authorization URL parameters", Object.fromEntries(authUrl.searchParams), { client_id: clientId, redirect_uri: `${ctx.base}/v1/ads/admob/oauth/callback`, response_type: "code", scope: "https://www.googleapis.com/auth/admob.readonly", access_type: "offline", prompt: "consent" });
    c.check("state is the project id and a random value; a browser nonce is returned", state.startsWith(`${dev.projectId}.`) && state.length > dev.projectId.length + 20 && /^[0-9a-f]{64}$/.test(start.nonce), { state: state.slice(0, 20), nonce: String(start.nonce).length });
    c.check("Google was not called to start (the browser follows the URL, not the server)", ctx.capture.of("accounts.google.com").length === 0 && ctx.capture.of("oauth2.googleapis.com").filter((r) => r.body.includes(encodeURIComponent(clientId))).length === 0);
    const redirect = async (q: string) => {
      const res = await fetch(`${ctx.base}/v1/ads/admob/oauth/callback?${q}`, { redirect: "manual" });
      return { status: res.status, location: new URL(res.headers.get("location") ?? "about:blank") };
    };
    const forgedCb = await redirect("code=4%2Fforged&state=..%2Fevil");
    c.check("Google's redirect with a forged state goes to an error, not the AdMob page", forgedCb.status === 302 && forgedCb.location.searchParams.get("admob_error") === "This AdMob sign-in link is not valid. Start again from the AdMob page." && !forgedCb.location.hash, forgedCb.location.href);
    const unknownState = `${dev.projectId}.${"0".repeat(32)}`;
    const unknownCb = await redirect(`code=4%2Fforged&state=${encodeURIComponent(unknownState)}`);
    const forgedFinish = await dev.v2r("POST", "/ads/admob/finish", { code: "4/forged", state: unknownState, nonce: start.nonce });
    c.check("an unknown state for this project is refused on finish (400 'not valid'), nothing exchanged", unknownCb.status === 302 && forgedFinish.status === 400 && /not valid/.test(forgedFinish.body.message) && ctx.capture.of("oauth2.googleapis.com").filter((r) => new URLSearchParams(r.body).get("client_id") === clientId).length === 0, forgedFinish.body);
    const back = await redirect(`code=${encodeURIComponent("4/journey-code")}&state=${encodeURIComponent(state)}`);
    const frag = new URLSearchParams(back.location.hash.slice(1));
    c.check("Google's redirect with the real state goes to the AdMob page with the code in the fragment", back.status === 302 && back.location.pathname === `/projects/${dev.projectId}/integrations/admob` && frag.get("admob_code") === "4/journey-code" && frag.get("admob_state") === state, back.location.pathname);
    const finished = await dev.v2r("POST", "/ads/admob/finish", { code: frag.get("admob_code"), state, nonce: start.nonce });
    c.has("finish with the browser's nonce connects and loads the ad units", finished.body, { connected: true, oauth_client: "project", accounts: [{ id: pub, currency: "USD" }], last_sync_error: null });
    c.eq("ad units loaded with names and formats", (finished.body.ad_units ?? []).map((x: any) => [x.ad_unit_id, x.name, x.format]).sort(), [[UNIT_PASS, "Day pass video", "rewarded"], [UNIT_BANNER, "Feed banner", "banner"], [UNIT_GEMS, "Gems video", "rewarded"]].sort());
    c.check("the refresh token is sealed: never in the API answer or stored in plain text", !JSON.stringify(finished.body).includes("ads-journey-refresh") && !(await ctx.sql`SELECT secrets::text AS s FROM integrations WHERE project_id = ${dev.projectId} AND kind = 'admob'`)[0]?.s.includes("ads-journey-refresh"));
    const again = await dev.v2r("POST", "/ads/admob/finish", { code: "4/journey-code", state, nonce: start.nonce });
    c.check("the same state cannot be used twice (400)", again.status === 400 && /not valid/.test(again.body.message), again.body);
    const s2 = await dev.v2("POST", "/ads/admob/connect", {});
    const st2 = new URL(s2.url).searchParams.get("state")!;
    const wrongNonce = await dev.v2r("POST", "/ads/admob/finish", { code: "4/stolen", state: st2, nonce: "f".repeat(64) });
    const rightAfter = await dev.v2r("POST", "/ads/admob/finish", { code: "4/stolen", state: st2, nonce: s2.nonce });
    c.check("a sign-in finished from another browser (wrong nonce) is refused, and that state is used up", wrongNonce.status === 400 && /another browser/.test(wrongNonce.body.message) && rightAfter.status === 400, [wrongNonce.body, rightAfter.body]);
    c.eq("Google's token endpoint was called only for the one valid sign-in (code exchange + refresh)", ctx.capture.of("oauth2.googleapis.com", "/token").filter((r) => new URLSearchParams(r.body).get("client_id") === clientId).map((r) => new URLSearchParams(r.body).get("grant_type")), ["authorization_code", "refresh_token"]);

    // ---------- 4. Ad events and the overview ----------
    c.begin("ad events from the SDK");
    const now = Date.now();
    const today = now - 60_000, twoDaysAgo = now - 2 * DAY, previous = now - 30 * DAY;
    const viewers = [u("viewer_a"), u("viewer_b")];
    for (const v of viewers) await app.customerInfo(v);
    const session = crypto.randomUUID();
    const ev = (type: string, o: Record<string, unknown>) => ({
      id: crypto.randomUUID(), version: 1, type, app_user_id: viewers[0], app_session_id: session, timestamp_ms: today, capture_method: "adapter", impression_id: crypto.randomUUID(), ...o,
    });
    const admobRewarded = { network_name: "Google AdMob", mediator_name: "AdMob", ad_format: "rewarded", placement: "level_end", ad_unit_id: UNIT_GEMS };
    const admobBanner = { network_name: "Google AdMob", mediator_name: "AdMob", ad_format: "banner", placement: "feed", ad_unit_id: UNIT_BANNER, app_user_id: viewers[1] };
    const applovin = { network_name: "AppLovin", mediator_name: "AppLovin", ad_format: "interstitial", placement: "home_screen", ad_unit_id: "a1b2c3d4e5f60718", timestamp_ms: twoDaysAgo };
    const prod = [
      ev("rc_ads_ad_loaded", admobRewarded), ev("rc_ads_ad_loaded", admobRewarded), ev("rc_ads_ad_failed_to_load", { ...admobRewarded, mediator_error_code: 3 }),
      ev("rc_ads_ad_displayed", admobRewarded), ev("rc_ads_ad_displayed", admobRewarded), ev("rc_ads_ad_opened", admobRewarded),
      ev("rc_ads_ad_revenue", { ...admobRewarded, revenue_micros: 1_250_000, currency: "USD", precision: "exact" }),
      ev("rc_ads_ad_revenue", { ...admobRewarded, revenue_micros: 750_000, currency: "USD", precision: "estimated" }),
      ...Array.from({ length: 4 }, () => ev("rc_ads_ad_displayed", admobBanner)),
      ...Array.from({ length: 4 }, () => ev("rc_ads_ad_revenue", { ...admobBanner, revenue_micros: 100_000, currency: "USD", precision: "estimated" })),
      ...Array.from({ length: 3 }, () => ev("rc_ads_ad_displayed", applovin)), ev("rc_ads_ad_opened", applovin),
      ...Array.from({ length: 3 }, () => ev("rc_ads_ad_revenue", { ...applovin, revenue_micros: 1_000_000, currency: "EUR", precision: "publisher_defined" })),
      // The rewarded-ad SDK events are stored but are not impressions or revenue.
      ev("rc_ads_ad_reward_sdk_earned", { ...admobRewarded, reward_verification_enabled: true }),
      // Previous period.
      ev("rc_ads_ad_displayed", { ...admobRewarded, timestamp_ms: previous }), ev("rc_ads_ad_revenue", { ...admobRewarded, timestamp_ms: previous, revenue_micros: 500_000, currency: "USD", precision: "exact" }),
    ];
    const sent = await app.call("POST", "/v1/events", { events: prod }, { "x-is-sandbox": "false" });
    c.eq("production batch accepted (200 {})", [sent.status, sent.body], [200, {}]);
    const resent = await app.call("POST", "/v1/events", { events: prod.slice(0, 5) }, { "x-is-sandbox": "false" });
    c.eq("a resent batch (same event ids) is accepted", resent.status, 200);
    const sbx = [ev("rc_ads_ad_displayed", admobRewarded), ev("rc_ads_ad_revenue", { ...admobRewarded, revenue_micros: 9_000_000, currency: "USD", precision: "exact" })];
    c.eq("sandbox batch from the Test Store app accepted", (await testApp.call("POST", "/v1/events", { events: sbx })).status, 200);
    const stored = await ctx.sql`SELECT is_sandbox, count(*)::int AS n FROM sdk_events WHERE project_id = ${dev.projectId} AND type LIKE 'rc_ads_%' GROUP BY is_sandbox ORDER BY is_sandbox`;
    c.eq("sdk_events (SQL): every production event once, the sandbox ones marked sandbox", stored.map((r) => [r.is_sandbox, r.n]), [[false, prod.length], [true, sbx.length]]);
    const sandboxBuy = await dev.v2r("POST", "/test_purchases", { app_user_id: viewers[0], product_id: "pro_monthly", scenario: "purchase" });
    c.check("a Test Store purchase for sandbox subscription revenue", sandboxBuy.status === 201, sandboxBuy.body);

    c.begin("Ads Overview (v2) matches the events, in USD");
    const overview = await dev.v2("GET", "/ads/overview?range=28d");
    // The server converts at each event day's ECB rate (cached in fx_rates, else the bundled rates): the same rate here.
    const fxRows = await ctx.sql<{ date: string; rates: Record<string, number> }[]>`SELECT date, rates FROM fx_rates WHERE source = 'ecb' ORDER BY date`;
    const eurUsd = (at: number) => {
      const d = new Date(at).toISOString().slice(0, 10);
      const table = fxRows.length ? fxRows : [BUNDLED_ECB];
      const row = [...table].reverse().find((x) => x.date <= d) ?? table[0]!;
      return row.rates.USD! / row.rates.EUR!;
    };
    const ecbCalls = ctx.server.outbound(now - 5000).filter((o) => o.host === "data-api.ecb.europa.eu");
    c.check("EUR revenue made the overview ask the ECB for the period's rates (public endpoint, called for real)", ecbCalls.length >= 1 && ecbCalls.every((o) => o.routed === "real" && o.status === 200), ecbCalls);
    const eventDay = new Date(twoDaysAgo).toISOString().slice(0, 10);
    const rateDay = [...fxRows].reverse().find((x) => x.date <= eventDay)?.date ?? null;
    c.check("the EUR events are converted at an ECB day at most 4 days before the event's day, not the bundled rates", rateDay !== null && (Date.parse(eventDay) - Date.parse(rateDay)) / DAY <= 4, { eventDay, rateDay, ecbDays: fxRows.length });
    const eurUsdTotal = 3 * eurUsd(twoDaysAgo);
    const byDayUsd = new Map<string, { rev: number; imp: number }>();
    const addDay = (at: number, rev: number, imp: number) => { const k = new Date(at).toISOString().slice(0, 10); const x = byDayUsd.get(k) ?? { rev: 0, imp: 0 }; byDayUsd.set(k, { rev: x.rev + rev, imp: x.imp + imp }); };
    addDay(today, 2.0 + 0.4, 6); addDay(twoDaysAgo, eurUsdTotal, 3);
    const adRevenue = r2(2.0 + 0.4 + eurUsdTotal);
    c.has("overview header", overview, { object: "ads_overview", currency: "USD", range: "28d", environment: "production", has_ad_events: true, ad_units_loaded: 3, unconverted: [] });
    c.has("totals: revenue, 9 impressions, 2 clicks, fill rate 2/3, 2 ad customers, no production subscriptions", overview.totals, {
      ad_revenue: adRevenue, impressions: 9, clicks: 2, ctr: r4(2 / 9), loaded: 2, failed_to_load: 1, fill_rate: 0.6667, revenue_events: 9, ad_customers: 2, subscription_revenue: 0, total_revenue: adRevenue, ad_share: 1,
    });
    c.eq("eCPM = revenue / impressions × 1000", overview.totals.ecpm, r2((2.0 + 0.4 + eurUsdTotal) / 9 * 1000));
    c.has("previous period: 0.50 and 1 impression", overview.previous, { ad_revenue: 0.5, impressions: 1, clicks: 0 });
    c.eq("daily series: 28 days", overview.series.length, 28);
    const seriesProblems = overview.series.filter((s: any) => {
      const e = byDayUsd.get(s.date) ?? { rev: 0, imp: 0 };
      return Math.abs(s.ad_revenue - r2(e.rev)) > 0.0001 || s.impressions !== e.imp;
    });
    c.check("daily series: revenue and impressions on today and two days ago, zero elsewhere", seriesProblems.length === 0, seriesProblems);
    const rows = (list: any[]) => Object.fromEntries(list.map((r: any) => [r.key, [r.ad_revenue, r.impressions, r.clicks]]));
    c.eq("by network", rows(overview.by_network), { "Google AdMob": [2.4, 6, 1], AppLovin: [r2(eurUsdTotal), 3, 1] });
    c.eq("by format", rows(overview.by_format), { rewarded: [2, 2, 1], banner: [0.4, 4, 0], interstitial: [r2(eurUsdTotal), 3, 1] });
    c.eq("by placement", rows(overview.by_placement), { level_end: [2, 2, 1], feed: [0.4, 4, 0], home_screen: [r2(eurUsdTotal), 3, 1] });
    c.eq("by mediator", rows(overview.by_mediator), { AdMob: [2.4, 6, 1], AppLovin: [r2(eurUsdTotal), 3, 1] });
    c.eq("by ad unit, with the AdMob names", Object.fromEntries(overview.by_ad_unit.map((r: any) => [r.key, [r.ad_revenue, r.impressions, r.name]])), { [UNIT_GEMS]: [2, 2, "Gems video"], [UNIT_BANNER]: [0.4, 4, "Feed banner"], a1b2c3d4e5f60718: [r2(eurUsdTotal), 3, null] });
    c.eq("rewarded eCPM: $2.00 / 2 × 1000 = $1,000", overview.by_format.find((r: any) => r.key === "rewarded")?.ecpm, 1000);
    const sandbox = await dev.v2("GET", "/ads/overview?range=7d&environment=sandbox");
    c.has("sandbox overview: only the Test Store's ad events and its subscription revenue", sandbox.totals, { ad_revenue: 9, impressions: 1, subscription_revenue: 9.99, total_revenue: 18.99, ad_share: r4(9 / 18.99) });
    c.eq("app filter: the Test Store app has no production ad events", (await dev.v2("GET", `/ads/overview?range=28d&app_id=${cat.app.id}`)).totals.impressions, 0);
    const badRange = await dev.v2r("GET", "/ads/overview?range=3d");
    c.check("an unknown range is refused (400)", badRange.status === 400, badRange.body);

    c.begin("dashboard: Ads page");
    const browser = await chromium().launch();
    const errors: string[] = [];
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: "rd_session", value: dev.cookie.split("=")[1]!, url: ctx.base }]);
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`${ctx.base}/projects/${dev.projectId}/ads`);
      const card = (id: string) => page.locator(`article[data-metric="${id}"] .v`);
      const shown = await card("ad_revenue").waitFor({ timeout: 20_000 }).then(() => true, () => false);
      c.check("the Ads page shows the metric cards", shown, await page.locator("main").innerText().catch(() => ""));
      c.eq("card: ad revenue", (await card("ad_revenue").innerText().catch(() => "")).trim(), usdText(adRevenue));
      c.eq("card: impressions", (await card("impressions").innerText().catch(() => "")).trim(), "9");
      c.eq("card: eCPM", (await card("ecpm").innerText().catch(() => "")).trim(), usdText(overview.totals.ecpm));
      c.eq("card: clicks", (await card("clicks").innerText().catch(() => "")).trim(), "2");
      c.eq("card: ad share of revenue", (await card("share").innerText().catch(() => "")).trim(), "100%");
      const table = async () => (await page.locator("table").last().innerText().catch(() => "")).replace(/\s+/g, " ");
      const net = await table();
      c.check("network table: Google AdMob $2.40 / 6 and AppLovin with the converted revenue / 3", /Google AdMob \$2\.40 \S+ 6 \$400\.00 1/.test(net) && new RegExp(`AppLovin ${usdText(r2(eurUsdTotal)).replace(/[$.]/g, "\\$&")} \\S+ 3`).test(net), net);
      await page.getByRole("tab", { name: "Ad unit" }).click();
      await page.getByText("Gems video").first().waitFor({ timeout: 10_000 }).catch(() => {});
      const units = await table();
      c.check("ad unit table shows the AdMob names (Gems video, Feed banner) and the raw AppLovin id", units.includes("Gems video") && units.includes("Feed banner") && units.includes("a1b2c3d4e5f60718"), units);
      await page.getByRole("switch", { name: "Sandbox data" }).click();
      await page.waitForURL(/environment=sandbox/, { timeout: 10_000 }).catch(() => {});
      const sbxOk = await until(async () => ((await card("ad_revenue").innerText().catch(() => "")).trim() === "$9.00" ? true : null), { timeoutMs: 15_000 });
      c.check("Sandbox switch: ad revenue $9.00 and subscription revenue $9.99", sbxOk && (await card("subscription_revenue").innerText().catch(() => "")).trim() === "$9.99", [await card("ad_revenue").innerText().catch(() => ""), await card("subscription_revenue").innerText().catch(() => "")]);
      await page.screenshot({ path: join(ctx.out, "ads-overview-sandbox.png"), fullPage: true }).catch(() => {});
      await page.goto(`${ctx.base}/projects/${dev.projectId}/ads/rewards`);
      const ruleList = page.getByRole("list", { name: "Reward rules in priority order" });
      const listedOk = await ruleList.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const ruleText = listedOk ? (await ruleList.innerText()).replace(/\s+/g, " ") : "";
      const i1 = ruleText.indexOf("Gems video: 2 gems per coin"), i2 = ruleText.indexOf("Day pass: a day of Pro"), i3 = ruleText.indexOf("Any rewarded ad: 1 gem");
      c.check("Rewards page lists the rules in priority order", listedOk && i1 >= 0 && i1 < i2 && i2 < i3, ruleText.slice(0, 400));
      c.check("Rewards page shows the SSV callback URL to paste into AdMob", await page.getByText(`${ctx.base}/v1/ads/admob/ssv`).first().waitFor({ timeout: 10_000 }).then(() => true, () => false));
      await page.screenshot({ path: join(ctx.out, "ads-rewards.png"), fullPage: true }).catch(() => {});
      c.eq("no page errors on the Ads pages", errors, []);
    } finally { await browser.close(); }

    // ---------- 3b. Unknown key ids and Google's key rotation (needs a minute since the last key fetch) ----------
    c.begin("unknown key ids: keys refetched at most once a minute, a rotation is picked up");
    const wait = lastKeyFetch + 62_000 - Date.now();
    if (wait > 0) await sleep(wait);
    served = [k1, k2];
    const fetchesBefore = keyFetches();
    const txR = newTx();
    const rotated = await ssv(signed({ tx: txR, user: player, key: k2 }).query);
    c.eq("a callback signed with Google's new key (unknown id) refetches the keys once and is accepted", [rotated.status, keyFetches() - fetchesBefore], [200, 1]);
    c.eq("poll: verified with 20 gems", (await poll(player, txR))?.reward, { type: "virtual_currency", code: "GEMS", amount: 20 });
    const unk1 = await ssv(signed({ tx: newTx(), user: player, keyId: "999" }).query);
    const unk2 = await ssv(signed({ tx: newTx(), user: player, keyId: "998" }).query);
    c.eq("unknown key ids in the same minute: 403 'Unknown key_id.' with no further key fetch", [unk1.status, unk1.body?.error, unk2.status, keyFetches() - fetchesBefore], [403, "Unknown key_id.", 403, 1]);
    c.eq("player balance: 21 + 20, nothing from the unknown keys", (await balances(player)).GEMS?.balance, 41);
    const allKeyCalls = ctx.server.outbound().filter((o) => o.host === KEYS_HOST);
    c.check("every key fetch went to the capture server (none real, none refused)", allKeyCalls.length === keyFetches() && allKeyCalls.every((o) => o.routed.startsWith("http://127.0.0.1:")), allKeyCalls.map((o) => o.routed));
  },
};
export default journey;
