// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (j), the store events the Test Store cannot make, through each store's real entry points on the real
// server, with the stores answered by fakes at the network layer (the journey preload routes every outbound call to the
// capture server; nothing reaches Stripe, Amazon or Google, and Apple stays blocked):
//   - Stripe (the developer's own account = the fake Stripe account, packages/contract/src/fake-stripe.ts): the backend
//     posts sub_/cs_ ids to POST /v1/receipts; Stripe-signed webhooks for renewal, cancel at period end, resume, price
//     change, pause, past due with grace, refund and deletion. Bad signatures are refused.
//   - Amazon Appstore: RVS answered by a fake; Real-time Notifications through SNS signed with a throwaway certificate
//     served from the SNS host the server accepts: subscription confirmation, renewal, auto-renew off and on, a refund.
//   - Google Play: a made-up service account (RS256 token exchange checked by the fake token endpoint), the Play Developer
//     API answered by a fake (subscriptionsv2, v1 pause schedule, acknowledge, voided purchases), RTDN pushes with a
//     Pub/Sub OIDC token signed by a fake Google key: purchase + acknowledgement, renewal, cancellation, restart, price
//     increase consent, scheduled pause and the pause starting, a voided purchase.
// Checks: SQL events per customer, every delivered webhook key-checked against RevenueCat's samples
// (packages/contract/fixtures/webhooks), SDK customer info, v2 subscription state, setup health, and the outbound log.
// Renewals are sent a few seconds before the period end they continue (a store clock slightly ahead of ours), so the
// expiration job can never see the old period end first.
import { createSign, createVerify, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { sleep, until } from "./lib/check.ts";
import { type Ctx, eventsOf, sdkClient, signUp } from "./lib/context.ts";
import { OUTBOUND_ALLOW, ROOT, type Captured } from "./lib/stack.ts";
import { FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.ts";
import { signStripePayload } from "../../../apps/server/src/stores/stripe/signature.ts";

const DAY = 86_400_000;
const sec = (ms: number) => Math.floor(ms / 1000);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const addMonths = (ms: number, n: number) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); };
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const reply = (res: ServerResponse, status: number, body?: unknown, type = "application/json") => {
  res.statusCode = status;
  if (body === undefined) { res.end(); return true; }
  res.setHeader("content-type", type);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
  return true;
};

function jwtRS256(payload: Record<string, unknown>, key: KeyObject, kid: string) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(key, "base64url")}`;
}
function verifyRS256(token: string, pub: KeyObject): Record<string, any> | null {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  if (!createVerify("RSA-SHA256").update(`${h}.${p}`).verify(pub, Buffer.from(s, "base64url"))) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
}

// ---------- RevenueCat's sample payloads ----------
const fixture = (name: string) => JSON.parse(readFileSync(join(ROOT, `packages/contract/fixtures/webhooks/${name}.json`), "utf8")).event as Record<string, unknown>;
/** As packages/contract/test/webhook-payloads.test.ts: keys RevenueCat sends that RevenueDot cannot have (Billing metadata) or only for experiments. */
const UNSUPPORTED = new Set(["experiments", "metadata"]);
/** Price-increase consent events: identity plus the documented price-consent fields (webhook-payloads.test.ts). */
const CONSENT_KEYS = ["aliases", "app_id", "app_user_id", "country_code", "currency", "environment", "event_timestamp_ms", "id", "original_app_user_id", "original_transaction_id", "product_id", "store", "subscriber_attributes", "transaction_id", "type"];
const FIXTURE_FOR = (e: Record<string, any>): string | null => {
  switch (e.type) {
    case "INITIAL_PURCHASE": return e.period_type === "TRIAL" ? "trial_started" : "initial_purchase";
    case "RENEWAL": return "renewal";
    case "CANCELLATION": return e.cancel_reason === "CUSTOMER_SUPPORT" ? "refund" : "cancellation";
    case "UNCANCELLATION": return "uncancellation";
    case "NON_RENEWING_PURCHASE": return "non_renewing_purchase";
    case "SUBSCRIPTION_PAUSED": return "subscription_paused";
    case "EXPIRATION": return "expiration";
    case "BILLING_ISSUE": return "billing_issue";
    case "PRODUCT_CHANGE": return "new_product_id" in e ? "product_change" : null;
    default: return null;
  }
};
function keyProblems(e: Record<string, any>): string[] {
  const out: string[] = [];
  let want: Set<string>;
  if (e.type === "PRICE_INCREASE_CONSENT_REQUIRED" || e.type === "PRICE_INCREASE_CONSENT_APPROVED") want = new Set(CONSENT_KEYS);
  else {
    const name = FIXTURE_FOR(e);
    if (!name) return [`${e.type}: no sample`];
    want = new Set(Object.keys(fixture(name)).filter((k) => !UNSUPPORTED.has(k)));
  }
  const got = new Set(Object.keys(e));
  const missing = [...want].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !want.has(k));
  if (missing.length || extra.length) out.push(`${e.type}: missing ${missing.join(",") || "-"} extra ${extra.join(",") || "-"}`);
  for (const [k, v] of Object.entries(e)) if (k.endsWith("_ms") && v !== null && !(Number.isInteger(v) && (v as number) > 1e12)) out.push(`${e.type}.${k} is not epoch ms`);
  return out;
}

const journey: Journey = {
  name: "stores",
  title: "Stores through real entry points with network fakes: Stripe webhooks, Amazon RVS + SNS, Google Play API + RTDN",
  async run(ctx: Ctx) {
    const { c, capture } = ctx;
    const S = ctx.stamp;
    const started = Date.now();
    const handlers: Array<(q: Captured, res: ServerResponse) => boolean | Promise<boolean>> = [];
    /** Fakes for this journey's hosts, tried before the capture server's defaults; removed at the end. */
    const fake = (h: (q: Captured, res: ServerResponse) => boolean | Promise<boolean>) => { handlers.push(h); capture.handlers.unshift(h); };
    const tmp = mkdtempSync(join(tmpdir(), "rd-stores-"));
    try {
      const dev = await signUp(ctx, "stores", "Stores app");
      const pro = await dev.v2("POST", "/entitlements", { lookup_key: "pro", display_name: "Pro access" });
      const hookPath = `/hooks/stores-${S}`;
      const hook = await dev.v2("POST", "/integrations/webhooks", { name: "Capture", url: `${capture.base}${hookPath}`, authorization_header: "Bearer stores-secret" });
      const product = async (appId: string, store_identifier: string, type: string, duration?: string) => {
        const p = await dev.v2("POST", "/products", { store_identifier, app_id: appId, type, display_name: store_identifier, ...(duration ? { subscription: { duration } } : {}) });
        await dev.v2("POST", `/entitlements/${pro.id}/actions/attach_products`, { product_ids: [p.id] });
        return p;
      };
      const keyOf = async (appId: string) => (await dev.v2("GET", `/apps/${appId}/public_api_keys`)).items[0].key as string;
      const v2subs = async (user: string) => (await dev.v2("GET", `/customers/${encodeURIComponent(user)}/subscriptions`)).items as Array<Record<string, any>>;
      const proOf = (info: any) => info?.subscriber?.entitlements?.pro as Record<string, any> | undefined;
      const active = (info: any) => { const p = proOf(info); return !!p && (p.expires_date === null || Date.parse(p.expires_date) > Date.now()); };
      const types = async (user: string) => (await eventsOf(ctx, dev.projectId, { appUserId: user })).map((e) => e.type as string);
      const eventsFor = (user: string, type?: string) => eventsOf(ctx, dev.projectId, { appUserId: user, type });
      const waitTypes = async (user: string, want: string[], timeoutMs = 45_000) =>
        (await until(async () => { const t = await types(user); return [...t].sort().join() === [...want].sort().join() ? t : null; }, { timeoutMs, everyMs: 500 })) ?? await types(user);
      const sameTypes = (name: string, got: string[], want: string[]) => c.eq(name, [...got].sort(), [...want].sort());

      // =====================================================================================================
      // Stripe: the developer's own account (the fake Stripe account on the capture server).
      // =====================================================================================================
      c.begin("Stripe: app with a restricted key and webhook secret, catalog");
      const stripe = capture.stripe;
      const WHSEC = `whsec_journeyStores${S}`;
      const stApp = await dev.v2("POST", "/apps", { name: "Scanner Web", type: "stripe", stripe: { stripe_secret_key: FAKE_STRIPE_KEY, stripe_webhook_secret: WHSEC } });
      const stKey = await keyOf(stApp.id);
      c.check("Stripe app created with a strp_ public key", stApp.type === "stripe" && stKey.startsWith("strp_"), { type: stApp.type, key: stKey.slice(0, 5) });
      const stCheck = await dev.v2r("POST", `/apps/${stApp.id}/actions/verify_credentials`, {});
      c.has("verify_credentials reads the account with the key (fake Stripe): valid, test mode", stCheck.body, { status: "valid", mode: "test" });
      const PRICE_M = { id: `price_m${S}`, object: "price", active: true, currency: "usd", product: `prod_m${S}`, recurring: { interval: "month", interval_count: 1 }, type: "recurring", unit_amount: 999, livemode: false };
      const PRICE_Y = { id: `price_y${S}`, object: "price", active: true, currency: "usd", product: `prod_y${S}`, recurring: { interval: "year", interval_count: 1 }, type: "recurring", unit_amount: 7999, livemode: false };
      await product(stApp.id, PRICE_M.id, "subscription", "P1M");
      await product(stApp.id, PRICE_Y.id, "subscription", "P1Y");
      const stSdk = sdkClient(ctx, stKey, "stripe");

      const stInvoice = (o: { id: string; sub: string; start: number; end: number; reason?: string; status?: string; amount?: number; nextAttempt?: number | null; price?: Record<string, unknown> }) => {
        const paid = (o.status ?? "paid") === "paid";
        const amount = o.amount ?? 999;
        const inv = {
          id: o.id, object: "invoice", amount_due: amount, amount_paid: paid ? amount : 0, amount_remaining: paid ? 0 : amount, attempt_count: paid ? 1 : 2,
          billing_reason: o.reason ?? "subscription_create", collection_method: "charge_automatically", currency: "usd", customer: `cus_${o.sub}`,
          customer_address: { country: "US" }, livemode: false, next_payment_attempt: o.nextAttempt ? sec(o.nextAttempt) : null,
          period_start: sec(o.start), period_end: sec(o.start), paid, status: o.status ?? "paid", total: amount, subscription: o.sub,
          status_transitions: { paid_at: paid ? sec(o.start) : null, finalized_at: sec(o.start) },
          lines: { data: [{ period: { start: sec(o.start), end: sec(o.end) }, price: o.price ?? PRICE_M }] },
        };
        stripe.invoices.set(inv.id, inv);
        return inv;
      };
      const stSub = (o: { id: string; user: string; origin: number; ps: number; pe: number; invoice: string; price?: Record<string, unknown>; status?: string; cancelAtPeriodEnd?: boolean; canceledAt?: number | null; endedAt?: number | null; cancelReason?: string | null; pause?: Record<string, unknown> | null }) => {
        const sub = {
          id: o.id, object: "subscription", status: o.status ?? "active", livemode: false, customer: `cus_${o.id}`, created: sec(o.origin), start_date: sec(o.origin),
          billing_cycle_anchor: sec(o.origin), current_period_start: sec(o.ps), current_period_end: sec(o.pe), trial_start: null, trial_end: null,
          cancel_at_period_end: o.cancelAtPeriodEnd ?? false, cancel_at: null, canceled_at: o.canceledAt ? sec(o.canceledAt) : null, ended_at: o.endedAt ? sec(o.endedAt) : null,
          cancellation_details: { comment: null, feedback: null, reason: o.cancelReason ?? null }, pause_collection: o.pause ?? null, currency: "usd",
          metadata: { app_user_id: o.user }, latest_invoice: o.invoice, collection_method: "charge_automatically",
          items: { object: "list", data: [{ id: `si_${o.id}`, object: "subscription_item", price: o.price ?? PRICE_M, quantity: 1 }] },
        };
        stripe.subscriptions.set(o.id, sub);
        return sub;
      };
      let evtSeq = 0;
      const stripeHook = async (type: string, object: unknown, o: { secret?: string; signature?: string | null; tamper?: boolean; id?: string } = {}) => {
        const event = { id: o.id ?? `evt_${S}_${++evtSeq}`, object: "event", api_version: "2024-06-20", created: sec(Date.now()), livemode: false, type, data: { object }, pending_webhooks: 1, request: { id: null, idempotency_key: null } };
        const raw = JSON.stringify(event);
        const sig = o.signature !== undefined ? o.signature : await signStripePayload(o.secret ?? WHSEC, raw);
        const res = await fetch(`${ctx.base}/v1/notifications/stripe/${stApp.id}`, { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) }, body: o.tamper ? raw.replace('"livemode":false', '"livemode":true') : raw });
        const text = await res.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* text */ }
        return { status: res.status, body };
      };
      const stReceipt = (user: string, token: string) => stSdk.call("POST", "/v1/receipts", { app_user_id: user, fetch_token: token });

      // =====================================================================================================
      // Amazon Appstore: RVS fake, SNS certificate on the SNS host.
      // =====================================================================================================
      c.begin("Amazon: app with a shared key, RVS fake, SNS signing certificate");
      const PKG_A = "com.example.storesjourney.fire";
      const SECRET = `2:journey-shared-key-${S}:Xg==`;
      const AMZ_USER = `amzn1.account.JOURNEY${S}`;
      const TOPIC = `arn:aws:sns:us-east-1:123456789012:amazon-rtn-journey-${S}`;
      const CERT_PATH = `/SimpleNotificationService-rdjourney${S}.pem`;
      const CERT_URL = `https://sns.us-east-1.amazonaws.com${CERT_PATH}`;
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(tmp, "sns.key"), "-out", join(tmp, "sns.pem"), "-days", "2", "-nodes", "-subj", "/CN=sns.amazonaws.com"], { stdio: "ignore" });
      const snsCertPem = readFileSync(join(tmp, "sns.pem"), "utf8");
      const snsKeyPem = readFileSync(join(tmp, "sns.key"), "utf8");
      const rvs = new Map<string, { r: Record<string, unknown>; user: string; env: "production" | "sandbox" }>();
      const snsConfirmations: string[] = [];
      let certFetches = 0;
      fake((q, res) => {
        if (q.host === "sns.us-east-1.amazonaws.com" && q.path === CERT_PATH) { certFetches++; return reply(res, 200, snsCertPem, "text/plain"); }
        if (q.host === "sns.us-east-1.amazonaws.com" && q.path === "/" && new URLSearchParams(q.query).get("TopicArn") === TOPIC) {
          snsConfirmations.push(q.query);
          return reply(res, 200, "<ConfirmSubscriptionResponse><ConfirmSubscriptionResult><SubscriptionArn>arn:aws:sns:us-east-1:123456789012:x</SubscriptionArn></ConfirmSubscriptionResult></ConfirmSubscriptionResponse>", "text/xml");
        }
        const m = q.host === "appstore-sdk.amazon.com" ? /^(\/sandbox)?\/version\/1\.0\/verifyReceiptId\/developer\/([^/]+)\/user\/([^/]+)\/receiptId\/([^/]+)$/.exec(q.path) : null;
        if (!m) return false;
        const [secret, user, id] = [m[2]!, m[3]!, m[4]!].map(decodeURIComponent);
        if (secret !== SECRET) return false;
        const x = rvs.get(id!);
        if (!x || x.env !== (m[1] ? "sandbox" : "production")) return reply(res, 400);
        if (x.user !== user) return reply(res, 497);
        return reply(res, 200, x.r);
      });
      const azApp = await dev.v2("POST", "/apps", { name: "Scanner Fire", type: "amazon", amazon: { package_name: PKG_A, shared_secret: SECRET } });
      const azKey = await keyOf(azApp.id);
      await product(azApp.id, "pro.monthly", "subscription", "P1M");
      await product(azApp.id, "lifetime.unlock", "non_consumable");
      const azCheck = await dev.v2r("POST", `/apps/${azApp.id}/actions/verify_credentials`, {});
      c.has("verify_credentials asks RVS with the shared key (fake RVS answers 400 for the probe receipt): valid", azCheck.body, { status: "valid" });
      const azSdk = sdkClient(ctx, azKey, "amazon");
      const amzReceipt = (over: Record<string, unknown>) => ({
        autoRenewing: true, betaProduct: false, cancelDate: null, cancelReason: null, countryCode: "US", deferredDate: null, deferredSku: null, freeTrialEndDate: null,
        gracePeriodEndDate: null, parentProductId: null, productId: "pro", productType: "SUBSCRIPTION", promotions: null, quantity: null, term: "1 Month", termSku: "pro.monthly",
        testTransaction: false, fulfillmentDate: null, fulfillmentResult: null, ...over,
      });
      const snsCanonical = (m: Record<string, string>) => (m.Type === "Notification"
        ? ["Message", "MessageId", ...(m.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
        : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]).map((k) => `${k}\n${m[k]}\n`).join("");
      const snsMessage = (o: { type?: string; message: unknown; version?: "1" | "2"; certUrl?: string; topic?: string }) => {
        const type = o.type ?? "Notification";
        const topic = o.topic ?? TOPIC;
        const token = randomUUID().replace(/-/g, "");
        const m: Record<string, string> = {
          Type: type, MessageId: randomUUID(), TopicArn: topic, Message: typeof o.message === "string" ? o.message : JSON.stringify(o.message),
          Timestamp: new Date().toISOString(), SignatureVersion: o.version ?? "1", Signature: "", SigningCertURL: o.certUrl ?? CERT_URL,
          ...(type === "SubscriptionConfirmation"
            ? { Token: token, SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=${token}` }
            : { UnsubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${topic}:journey` }),
        };
        m.Signature = createSign(m.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256").update(snsCanonical(m)).sign(snsKeyPem, "base64");
        return m;
      };
      const postSns = async (m: Record<string, string>) => {
        const res = await fetch(`${ctx.base}/v1/notifications/amazon/${azApp.id}`, { method: "POST", headers: { "content-type": "text/plain; charset=UTF-8", "x-amz-sns-message-type": m.Type! }, body: JSON.stringify(m) });
        const text = await res.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* text */ }
        return { status: res.status, body };
      };
      const rtn = (notificationType: string, receiptId: string, version: "1" | "2" = "1", extra: Record<string, unknown> = {}) => postSns(snsMessage({ version, message: {
        appPackageName: PKG_A, notificationType, appUserId: AMZ_USER, receiptId, relatedReceipts: {}, timestamp: Date.now(), betaProductTransaction: false, ...extra,
      } }));
      const azReceipt = (user: string, receiptId: string, productId: string, price: number) => azSdk.call("POST", "/v1/receipts", {
        app_user_id: user, fetch_token: receiptId, product_ids: [productId], price, currency: "USD", store_user_id: AMZ_USER, is_restore: false, observer_mode: false,
      }, { marketplace: "US" });

      // =====================================================================================================
      // Google Play: a made-up service account, the Play Developer API and Google's token endpoint and certs as fakes.
      // =====================================================================================================
      c.begin("Google Play: app with a service account and Pub/Sub push authentication, Play API fake");
      const PKG_G = `com.example.stores.j${S}`;
      const saKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pushKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const SA = {
        type: "service_account", project_id: "stores-journey", private_key_id: `kid${S}`, private_key: saKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        client_email: `rd-stores-${S}@stores-journey.iam.gserviceaccount.com`, client_id: "1234567890", token_uri: "https://oauth2.googleapis.com/token",
      };
      const ACCESS = `ya29.stores-journey-${S}`;
      const PUSH_SA = "play-rtdn-push@stores-journey.iam.gserviceaccount.com";
      const PUSH_KID = `push-${S}`;
      const API_PREFIX = `/androidpublisher/v3/applications/${PKG_G}`;
      const gSubs = new Map<string, Record<string, any>>();
      const gV1 = new Map<string, { autoResumeTimeMillis?: string }>();
      const gAcks: string[] = [];
      const tokenGrants: Array<Record<string, any>> = [];
      const gCalls: Array<{ method: string; path: string; auth: string }> = [];
      const gErr = (res: ServerResponse, status: number, message: string, reason: string) => reply(res, status, { error: { code: status, message, errors: [{ reason, message }] } });
      fake((q, res) => {
        if (q.host === "oauth2.googleapis.com" && q.path === "/token") {
          const assertion = new URLSearchParams(q.body).get("assertion") ?? "";
          let iss: unknown = null;
          try { iss = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf8")).iss; } catch { /* not a JWT */ }
          if (iss !== SA.client_email) return false;
          const claims = verifyRS256(assertion, saKeys.publicKey);
          tokenGrants.push({ grant_type: new URLSearchParams(q.body).get("grant_type"), claims, signatureOk: !!claims });
          if (!claims || claims.aud !== SA.token_uri) return reply(res, 400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
          return reply(res, 200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" });
        }
        if (q.host === "www.googleapis.com" && q.path === "/oauth2/v3/certs") {
          return reply(res, 200, { keys: [{ ...pushKeys.publicKey.export({ format: "jwk" }), kid: PUSH_KID, alg: "RS256", use: "sig" }] });
        }
        if (q.host !== "androidpublisher.googleapis.com" || !q.path.startsWith(`${API_PREFIX}/`)) return false;
        gCalls.push({ method: q.method, path: q.path.slice(API_PREFIX.length), auth: q.headers.authorization ?? "" });
        if (q.headers.authorization !== `Bearer ${ACCESS}`) return gErr(res, 401, "Request had invalid authentication credentials.", "authError");
        const p = q.path.slice(API_PREFIX.length).split("/").map(decodeURIComponent); // ["", "purchases", ...]
        if (p[1] === "purchases" && p[2] === "subscriptionsv2" && p[3] === "tokens" && q.method === "GET") {
          const s = gSubs.get(p[4]!);
          return s ? reply(res, 200, { etag: `etag-${s.latestOrderId}`, ...s }) : gErr(res, 404, "The purchase token was not found.", "notFound");
        }
        if (p[1] === "purchases" && p[2] === "subscriptions" && p[4] === "tokens") {
          const [token, action] = p[5]!.split(":");
          if (action === "acknowledge" && q.method === "POST") {
            const s = gSubs.get(token!);
            if (!s) return gErr(res, 404, "The purchase token was not found.", "notFound");
            if (s.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") return gErr(res, 400, "The subscription purchase is already acknowledged.", "invalid");
            gAcks.push(`${p[3]}/${token}`);
            s.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
            return reply(res, 204);
          }
          const v1 = gV1.get(token!);
          return v1 ? reply(res, 200, { kind: "androidpublisher#subscriptionPurchase", ...v1 }) : gErr(res, 404, "The purchase token was not found.", "notFound");
        }
        if (p[1] === "purchases" && p[2] === "voidedpurchases" && q.method === "GET") return reply(res, 200, { voidedPurchases: [] });
        return gErr(res, 404, "No such endpoint in the journey's Play API fake.", "notFound");
      });
      const gpApp = await dev.v2("POST", "/apps", { name: "Scanner Android", type: "play_store", play_store: { package_name: PKG_G, play_service_account_credentials_json: JSON.stringify(SA) } });
      const AUD = `${ctx.base}/v1/notifications/google/${gpApp.id}`;
      await dev.v2("POST", `/apps/${gpApp.id}`, { play_store: { pubsub_audience: AUD, pubsub_service_account: PUSH_SA } });
      const gpKey = await keyOf(gpApp.id);
      await product(gpApp.id, "pro:monthly", "subscription", "P1M");
      const gpCheck = await dev.v2r("POST", `/apps/${gpApp.id}/actions/verify_credentials`, {});
      c.has("verify_credentials exchanges the service account JWT and probes the Play API (fake): valid", gpCheck.body, { status: "valid" });
      c.check("the token endpoint got an RS256 JWT bearer grant signed with the service account key (iss, aud, scope)", tokenGrants.length >= 1 && tokenGrants.every((g) => g.signatureOk && g.grant_type === "urn:ietf:params:oauth:grant-type:jwt-bearer" && g.claims.aud === SA.token_uri && g.claims.scope === "https://www.googleapis.com/auth/androidpublisher"), tokenGrants.map((g) => ({ ...g, claims: g.claims && { iss: g.claims.iss, aud: g.claims.aud, scope: g.claims.scope } })));
      const gpSdk = sdkClient(ctx, gpKey, "android");
      const pushToken = (aud = AUD, email = PUSH_SA) => jwtRS256({ iss: "https://accounts.google.com", aud, sub: "1234567890", email, email_verified: true, iat: sec(Date.now()), exp: sec(Date.now()) + 3600 }, pushKeys.privateKey, PUSH_KID);
      const rtdn = async (n: Record<string, unknown>, o: { auth?: string | null; messageId?: string } = {}) => {
        const body = {
          message: { data: Buffer.from(JSON.stringify({ version: "1.0", packageName: PKG_G, eventTimeMillis: String(Date.now()), ...n })).toString("base64"), messageId: o.messageId ?? randomUUID(), publishTime: new Date().toISOString() },
          subscription: "projects/stores-journey/subscriptions/play-rtdn",
        };
        const auth = o.auth === undefined ? `Bearer ${pushToken()}` : o.auth;
        const res = await fetch(`${ctx.base}/v1/notifications/google/${gpApp.id}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
        const text = await res.text();
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch { /* text */ }
        return { status: res.status, body: parsed };
      };
      const subNote = (notificationType: number, purchaseToken: string) => ({ subscriptionNotification: { version: "1.0", notificationType, purchaseToken, subscriptionId: "pro" } });
      const order = () => `GPA.${[4, 4, 4, 5].map((n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("")).join("-")}`;
      const gSub = (o: { start: number; expiry: number; order: string; state?: string; ack?: boolean; cancelTime?: number; autoRenew?: boolean; autoResume?: number; priceChange?: string }) => ({
        kind: "androidpublisher#subscriptionPurchaseV2", regionCode: "US", startTime: new Date(o.start).toISOString(), subscriptionState: o.state ?? "SUBSCRIPTION_STATE_ACTIVE",
        latestOrderId: o.order, acknowledgementState: o.ack ? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" : "ACKNOWLEDGEMENT_STATE_PENDING", testPurchase: {},
        ...(o.cancelTime ? { canceledStateContext: { userInitiatedCancellation: { cancelTime: new Date(o.cancelTime).toISOString(), cancelSurveyResult: { reason: "CANCEL_SURVEY_REASON_COST_RELATED" } } } } : {}),
        ...(o.autoResume ? { pausedStateContext: { autoResumeTime: new Date(o.autoResume).toISOString() } } : {}),
        lineItems: [{
          productId: "pro", expiryTime: new Date(o.expiry).toISOString(), latestSuccessfulOrderId: o.order,
          autoRenewingPlan: {
            autoRenewEnabled: o.autoRenew ?? !o.cancelTime, recurringPrice: { currencyCode: "USD", units: "9", nanos: 990_000_000 },
            ...(o.priceChange ? { priceChangeDetails: { newPrice: { currencyCode: "USD", units: "12", nanos: 990_000_000 }, priceChangeMode: "PRICE_INCREASE", priceChangeState: o.priceChange, expectedNewPriceChargeTime: new Date(o.expiry).toISOString() } } : {}),
          },
          offerDetails: { basePlanId: "monthly", offerTags: [] },
        }],
      });
      const gpReceipt = (user: string, token: string) => gpSdk.call("POST", "/v1/receipts", {
        app_user_id: user, fetch_token: token, product_ids: ["pro"], platform_product_ids: [{ product_id: "pro", base_plan_id: "monthly" }], price: 9.99, currency: "USD", is_restore: false, observer_mode: false,
      });

      // =====================================================================================================
      // Purchases whose period ends at T_END: renewals and a failed renewal arrive just before it.
      // =====================================================================================================
      const T_END = Math.ceil((Date.now() + 90_000) / 1000) * 1000;
      const MONTH_BEFORE = addMonths(T_END, -1);
      const U = (name: string) => `${name}_${S}`;

      c.begin("Stripe: the backend posts subscriptions (sub_ and cs_ ids) to POST /v1/receipts");
      const stIds = { renew: `sub_renew${S}`, pastdue: `sub_pastdue${S}`, cancel: `sub_cancel${S}`, change: `sub_change${S}`, pause: `sub_pause${S}`, refund: `sub_refund${S}` };
      const now0 = Date.now();
      stInvoice({ id: `in_renew1${S}`, sub: stIds.renew, start: MONTH_BEFORE, end: T_END });
      stSub({ id: stIds.renew, user: U("st_renew"), origin: MONTH_BEFORE, ps: MONTH_BEFORE, pe: T_END, invoice: `in_renew1${S}` });
      stInvoice({ id: `in_pastdue1${S}`, sub: stIds.pastdue, start: MONTH_BEFORE, end: T_END });
      stSub({ id: stIds.pastdue, user: U("st_pastdue"), origin: MONTH_BEFORE, ps: MONTH_BEFORE, pe: T_END, invoice: `in_pastdue1${S}` });
      for (const k of ["cancel", "change", "pause", "refund"] as const) {
        const start = now0 - 2 * DAY;
        stInvoice({ id: `in_${k}1${S}`, sub: stIds[k], start, end: addMonths(start, 1) });
        stSub({ id: stIds[k], user: U(`st_${k}`), origin: start, ps: start, pe: addMonths(start, 1), invoice: `in_${k}1${S}` });
      }
      const csId = `cs_test_change${S}`;
      stripe.sessions.set(csId, {
        id: csId, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid", livemode: false, created: sec(now0), customer: `cus_${stIds.change}`,
        metadata: { app_user_id: U("st_change") }, subscription: stIds.change, payment_intent: null, currency: "usd", amount_total: 999, customer_details: { address: { country: "US" } },
        line_items: { object: "list", has_more: false, data: [{ id: "li_0", object: "item", price: PRICE_M, quantity: 1, currency: "usd", amount_total: 999 }] },
      });
      for (const k of ["renew", "pastdue", "cancel", "change", "pause", "refund"] as const) {
        const r = await stReceipt(U(`st_${k}`), k === "change" ? csId : stIds[k]);
        c.check(`${k}: receipt accepted with pro active (${k === "change" ? "Checkout Session cs_" : "sub_"} id)`, r.status === 200 && active(r.body), { status: r.status, body: r.body });
      }
      const stInitial = await eventsFor(U("st_renew"), "INITIAL_PURCHASE");
      c.has("INITIAL_PURCHASE from Stripe: the invoice id, the subscription as original id, price, sandbox", stInitial[0], { store: "STRIPE", environment: "SANDBOX", product_id: PRICE_M.id, transaction_id: `in_renew1${S}`, original_transaction_id: stIds.renew, price: 9.99, currency: "USD", purchased_at_ms: MONTH_BEFORE, expiration_at_ms: T_END });
      const subCalls = stripe.calls.filter((x) => x.path === `/v1/subscriptions/${stIds.renew}`);
      c.check("the server read the subscription from Stripe with the app's restricted key", subCalls.length >= 1 && subCalls.every((x) => x.auth === `Bearer ${FAKE_STRIPE_KEY}`), subCalls.map((x) => x.auth?.slice(0, 14)));
      c.check("the cs_ token was read as a Checkout Session, then its subscription", stripe.calls.some((x) => x.path === `/v1/checkout/sessions/${csId}`) && stripe.calls.some((x) => x.path === `/v1/subscriptions/${stIds.change}`));

      c.begin("Amazon: SNS subscription confirmation, then the device posts a receipt (RVS)");
      const conf = await postSns(snsMessage({ type: "SubscriptionConfirmation", message: "You have chosen to subscribe to the topic." }));
      c.eq("SubscriptionConfirmation is accepted and confirmed", conf.body, { status: "confirmed" });
      c.check("the server fetched the SubscribeURL (on the SNS host) for the topic", snsConfirmations.length === 1 && snsConfirmations[0]!.includes("Action=ConfirmSubscription"), snsConfirmations);
      c.check("the signing certificate was fetched from the SNS host", certFetches >= 1, certFetches);
      const [azRow] = await ctx.sql`SELECT credentials FROM apps WHERE id = ${azApp.id}`;
      c.eq("the first verified message pinned the app's SNS topic", azRow?.credentials?.sns_topic_arn, TOPIC);
      const RID = `q1YqVrJSSs7P1UvMTazKz9PLTCwoTswtyEktM8jLz0kpLQ1JTSlFMsjILCoQ:3:${S}`;
      const RID_LIFE = `q1YqVrJSSs7P1UvMTazKz9PLTCwoTswtyEktM8jLz0kpLQ1JTSlFMsjIL:1:${S}`;
      rvs.set(RID, { user: AMZ_USER, env: "sandbox", r: amzReceipt({ receiptId: RID, purchaseDate: MONTH_BEFORE, renewalDate: T_END }) });
      rvs.set(RID_LIFE, { user: AMZ_USER, env: "sandbox", r: amzReceipt({ receiptId: RID_LIFE, productId: "lifetime.unlock", productType: "ENTITLED", termSku: null, term: null, renewalDate: null, autoRenewing: false, purchaseDate: now0 - DAY }) });
      let r = await azReceipt(U("az_buyer"), RID, "pro.monthly", 4.99);
      c.check("subscription receipt accepted with pro active until the renewal date", r.status === 200 && proOf(r.body)?.expires_date === iso(T_END), { status: r.status, body: r.body });
      c.has("INITIAL_PURCHASE from Amazon: term SKU, receipt id, posted price, App Tester sandbox", (await eventsFor(U("az_buyer"), "INITIAL_PURCHASE"))[0], { store: "AMAZON", product_id: "pro.monthly", transaction_id: RID, original_transaction_id: RID, price: 4.99, environment: "SANDBOX", purchased_at_ms: MONTH_BEFORE, expiration_at_ms: T_END });
      r = await azReceipt(U("az_lifetime"), RID_LIFE, "lifetime.unlock", 19.99);
      c.check("one-time (ENTITLED) receipt accepted: lifetime pro", r.status === 200 && proOf(r.body)?.expires_date === null, r.body);
      const rvsHits = capture.of("appstore-sdk.amazon.com").filter((x) => x.path.includes(`/receiptId/${encodeURIComponent(RID)}`));
      c.check("RVS was asked in production first, then in the cloud sandbox, with the shared key and the Amazon user", rvsHits.length >= 2 && !rvsHits[0]!.path.startsWith("/sandbox") && rvsHits[1]!.path.startsWith("/sandbox/") && rvsHits.every((x) => x.path.includes(encodeURIComponent(SECRET)) && x.path.includes(encodeURIComponent(AMZ_USER))), rvsHits.map((x) => x.path.split("/developer/")[0]));

      c.begin("Google Play: Pub/Sub push authentication, then the device posts purchase tokens");
      let g = await rtdn({ testNotification: { version: "1.0" } }, { auth: null });
      c.eq("a push without the OIDC token is refused (401)", g.status, 401);
      g = await rtdn({ testNotification: { version: "1.0" } }, { auth: `Bearer ${pushToken("https://another.example.com/push")}` });
      c.eq("a push token for another audience is refused (401)", g.status, 401);
      g = await rtdn({ testNotification: { version: "1.0" } }, { auth: `Bearer ${pushToken(AUD, "someone@else.iam.gserviceaccount.com")}` });
      c.eq("a push token from another service account is refused (401)", g.status, 401);
      g = await rtdn({ packageName: "com.other.app", ...subNote(2, "tok_other") });
      c.eq("a notification for another package is acknowledged and ignored", g.body, { status: "ignored" });
      g = await rtdn({ testNotification: { version: "1.0" } });
      c.check("Google's test notification with a valid push token is processed", g.status === 200 && g.body.status === "processed", g);
      c.check("the push token was checked against Google's certs (fake on the capture server)", capture.of("www.googleapis.com", "/oauth2/v3/certs").length >= 1);
      const TOK = { buy: `tok_buy_${S}`, pause: `tok_pause_${S}`, refund: `tok_refund_${S}` };
      const ORD = { buy: order(), pause: order(), refund: order() };
      gSubs.set(TOK.buy, gSub({ start: MONTH_BEFORE, expiry: T_END, order: ORD.buy }));
      gSubs.set(TOK.pause, gSub({ start: MONTH_BEFORE, expiry: T_END, order: ORD.pause }));
      gSubs.set(TOK.refund, gSub({ start: now0 - DAY, expiry: addMonths(now0 - DAY, 1), order: ORD.refund }));
      for (const k of ["buy", "pause", "refund"] as const) {
        const res = await gpReceipt(U(`gp_${k}`), TOK[k]);
        c.check(`${k}: purchase token verified, pro active with the base plan`, res.status === 200 && active(res.body) && proOf(res.body)?.product_plan_identifier === "monthly", { status: res.status, body: res.body });
      }
      c.eq("each new subscription was acknowledged once (purchases.subscriptions.acknowledge)", [...gAcks].sort(), [`pro/${TOK.buy}`, `pro/${TOK.pause}`, `pro/${TOK.refund}`].sort());
      c.has("INITIAL_PURCHASE from Google Play: order id, license tester sandbox, price", (await eventsFor(U("gp_buy"), "INITIAL_PURCHASE"))[0], { store: "PLAY_STORE", product_id: "pro", transaction_id: ORD.buy, original_transaction_id: ORD.buy, environment: "SANDBOX", price: 9.99, purchased_at_ms: MONTH_BEFORE, expiration_at_ms: T_END });
      g = await rtdn(subNote(4, TOK.buy));
      c.check("SUBSCRIPTION_PURCHASED for a purchase already posted is processed and records nothing new", g.body?.status === "processed" && (await types(U("gp_buy"))).length === 1, { g, types: await types(U("gp_buy")) });
      c.eq("no second acknowledgement for the notification", gAcks.filter((x) => x.endsWith(TOK.buy)).length, 1);

      // =====================================================================================================
      // Events that need no clock: Stripe cancel/delete, price change, pause, refund; Amazon refund; Google pause schedule, refund.
      // =====================================================================================================
      c.begin("Stripe: refused webhooks change nothing");
      const before = (await eventsOf(ctx, dev.projectId)).length;
      const pauseSub = stripe.subscriptions.get(stIds.pause);
      let st = await stripeHook("customer.subscription.updated", pauseSub, { signature: null });
      c.check("no Stripe-Signature header: 400", st.status === 400 && /missing/.test(st.body?.message), st);
      st = await stripeHook("customer.subscription.updated", pauseSub, { secret: "whsec_someoneElse0000" });
      c.check("signed with another secret: 400", st.status === 400 && /No signature/.test(st.body?.message), st);
      st = await stripeHook("customer.subscription.updated", pauseSub, { tamper: true });
      c.eq("a body changed after signing: 400", st.status, 400);
      st = await stripeHook("customer.subscription.updated", pauseSub, { signature: `t=${sec(Date.now()) - 600},v1=${"0".repeat(64)}` });
      c.eq("a stale, wrong signature: 400", st.status, 400);
      c.eq("no event was recorded for refused webhooks", (await eventsOf(ctx, dev.projectId)).length, before);
      const rejected = await ctx.sql`SELECT count(*)::int AS n FROM store_notifications WHERE app_id = ${stApp.id} AND error LIKE 'rejected:%'`;
      c.eq("each refused webhook is kept with its reason (notification status shows why)", rejected[0]!.n, 4);

      c.begin("Stripe: cancel at period end and deletion (CANCELLATION, EXPIRATION)");
      const tCancel = Date.now();
      const cs = stripe.subscriptions.get(stIds.cancel);
      stSub({ id: stIds.cancel, user: U("st_cancel"), origin: cs.start_date * 1000, ps: cs.current_period_start * 1000, pe: cs.current_period_end * 1000, invoice: `in_cancel1${S}`, cancelAtPeriodEnd: true, canceledAt: tCancel, cancelReason: "cancellation_requested" });
      st = await stripeHook("customer.subscription.updated", stripe.subscriptions.get(stIds.cancel));
      c.eq("cancel at period end: processed", st.body, { status: "processed" });
      c.has("CANCELLATION (UNSUBSCRIBE)", (await eventsFor(U("st_cancel"), "CANCELLATION"))[0], { cancel_reason: "UNSUBSCRIBE", store: "STRIPE", price: 0 });
      let info = (await stSdk.customerInfo(U("st_cancel"))).body;
      c.check("customer info: unsubscribe_detected_at set, access continues to the period end", typeof info.subscriber?.subscriptions?.[PRICE_M.id]?.unsubscribe_detected_at === "string" && active(info), info.subscriber?.subscriptions?.[PRICE_M.id]);
      const tEnd = Date.now() - 1000;
      stSub({ id: stIds.cancel, user: U("st_cancel"), origin: cs.start_date * 1000, ps: cs.current_period_start * 1000, pe: cs.current_period_end * 1000, invoice: `in_cancel1${S}`, status: "canceled", canceledAt: tCancel, endedAt: tEnd, cancelReason: "cancellation_requested" });
      st = await stripeHook("customer.subscription.deleted", stripe.subscriptions.get(stIds.cancel));
      c.eq("deletion: processed", st.body, { status: "processed" });
      sameTypes("events: INITIAL_PURCHASE, CANCELLATION, EXPIRATION", await waitTypes(U("st_cancel"), ["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"]), ["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"]);
      c.has("EXPIRATION (UNSUBSCRIBE) at the end Stripe reported", (await eventsFor(U("st_cancel"), "EXPIRATION"))[0], { expiration_reason: "UNSUBSCRIBE", store: "STRIPE" });
      info = (await stSdk.customerInfo(U("st_cancel"))).body;
      c.check("customer info: pro ended at ended_at", proOf(info)?.expires_date === iso(sec(tEnd) * 1000) && !active(info), proOf(info));
      c.has("v2 subscription: expired, no access, will not renew", (await v2subs(U("st_cancel")))[0], { status: "expired", gives_access: false, auto_renewal_status: "will_not_renew", store: "stripe" });

      c.begin("Stripe: switching to the annual price (PRODUCT_CHANGE)");
      const ch = stripe.subscriptions.get(stIds.change);
      stInvoice({ id: `in_prorate${S}`, sub: stIds.change, start: Date.now(), end: Date.now(), reason: "subscription_update", amount: 5332, price: PRICE_Y });
      stSub({ id: stIds.change, user: U("st_change"), origin: ch.start_date * 1000, ps: ch.current_period_start * 1000, pe: ch.current_period_end * 1000, invoice: `in_prorate${S}`, price: PRICE_Y });
      st = await stripeHook("customer.subscription.updated", stripe.subscriptions.get(stIds.change));
      c.eq("price change: processed", st.body, { status: "processed" });
      c.has("PRODUCT_CHANGE from the monthly to the annual price", (await eventsFor(U("st_change"), "PRODUCT_CHANGE"))[0], { product_id: PRICE_M.id, new_product_id: PRICE_Y.id, store: "STRIPE", price: 0 });
      info = (await stSdk.customerInfo(U("st_change"))).body;
      c.check("customer info: the annual product gives pro, same period and transaction (proration is not a renewal)", proOf(info)?.product_identifier === PRICE_Y.id && info.subscriber?.subscriptions?.[PRICE_Y.id]?.store_transaction_id === `in_change1${S}` && active(info), info.subscriber);
      sameTypes("events: INITIAL_PURCHASE, PRODUCT_CHANGE (no RENEWAL)", await types(U("st_change")), ["INITIAL_PURCHASE", "PRODUCT_CHANGE"]);

      c.begin("Stripe: pausing collection (SUBSCRIPTION_PAUSED)");
      const ps = stripe.subscriptions.get(stIds.pause);
      const resumesAt = sec(Date.now() + 60 * DAY) * 1000;
      stSub({ id: stIds.pause, user: U("st_pause"), origin: ps.start_date * 1000, ps: ps.current_period_start * 1000, pe: ps.current_period_end * 1000, invoice: `in_pause1${S}`, pause: { behavior: "void", resumes_at: sec(resumesAt) } });
      st = await stripeHook("customer.subscription.paused", stripe.subscriptions.get(stIds.pause));
      c.eq("pause: processed", st.body, { status: "processed" });
      c.has("SUBSCRIPTION_PAUSED with the resume date", (await eventsFor(U("st_pause"), "SUBSCRIPTION_PAUSED"))[0], { auto_resume_at_ms: resumesAt, store: "STRIPE" });
      c.has("v2 subscription: access to the period end, will pause", (await v2subs(U("st_pause")))[0], { gives_access: true, auto_renewal_status: "will_pause" });

      c.begin("Stripe: a full refund of the latest invoice (CANCELLATION CUSTOMER_SUPPORT)");
      const charge = (refunded: number) => ({
        id: `ch_refund${S}`, object: "charge", amount: 999, amount_captured: 999, amount_refunded: refunded, captured: true, currency: "usd", customer: `cus_${stIds.refund}`, livemode: false, paid: true,
        payment_intent: `pi_refund${S}`, refunded: refunded >= 999, status: "succeeded", invoice: `in_refund1${S}`,
        refunds: { object: "list", data: [{ id: `re_${S}`, object: "refund", amount: refunded, created: sec(Date.now()), status: "succeeded" }], has_more: false },
      });
      st = await stripeHook("charge.refunded", charge(500));
      c.eq("a partial refund is ignored", st.body, { status: "ignored" });
      st = await stripeHook("charge.refunded", charge(999));
      c.eq("the full refund is processed", st.body, { status: "processed" });
      c.has("CANCELLATION (CUSTOMER_SUPPORT) with a negative price", (await eventsFor(U("st_refund"), "CANCELLATION"))[0], { cancel_reason: "CUSTOMER_SUPPORT", price: -9.99, store: "STRIPE", transaction_id: `in_refund1${S}` });
      info = (await stSdk.customerInfo(U("st_refund"))).body;
      c.check("customer info: refunded_at set and pro ended", typeof info.subscriber?.subscriptions?.[PRICE_M.id]?.refunded_at === "string" && !active(info), info.subscriber?.subscriptions?.[PRICE_M.id]);
      c.has("v2 subscription: expired, no access", (await v2subs(U("st_refund")))[0], { status: "expired", gives_access: false });
      const stLedger = await ctx.sql`SELECT t.kind, t.revenue_usd::float8 AS usd FROM transactions t JOIN customers cu ON cu.id = t.customer_id WHERE cu.project_id = ${dev.projectId} AND cu.original_app_user_id = ${U("st_refund")} ORDER BY t.purchased_at`;
      c.eq("ledger: the purchase and the refund", stLedger.map((x) => [x.kind, x.usd]), [["purchase", 9.99], ["refund", -9.99]]);
      st = await stripeHook("charge.refunded", charge(999), { id: `evt_${S}_${evtSeq}` });
      c.eq("Stripe redelivering the same event id is a duplicate", st.body, { status: "duplicate" });

      c.begin("Amazon: refused SNS messages change nothing");
      const azBefore = (await eventsOf(ctx, dev.projectId)).length;
      const good = snsMessage({ version: "2", message: { appPackageName: PKG_A, notificationType: "ENTITLEMENT_CANCELLED", appUserId: AMZ_USER, receiptId: RID_LIFE, timestamp: Date.now() } });
      let az = await postSns({ ...good, Message: good.Message!.replace("ENTITLEMENT_CANCELLED", "ENTITLEMENT_PURCHASED") });
      c.check("a message changed after signing: 400 (signature does not match)", az.status === 400 && /signature does not match/.test(az.body?.message), az);
      az = await postSns(snsMessage({ certUrl: "https://evil.example.com/SimpleNotificationService-x.pem", message: { notificationType: "ENTITLEMENT_CANCELLED", receiptId: RID_LIFE } }));
      c.check("a certificate outside the SNS hosts: 400, never fetched", az.status === 400 && capture.of("evil.example.com").length === 0, az);
      az = await postSns(snsMessage({ certUrl: `https://sns.s3.amazonaws.com${CERT_PATH}`, message: { notificationType: "ENTITLEMENT_CANCELLED", receiptId: RID_LIFE } }));
      c.check("a certificate on an S3 bucket named sns: 400, never fetched", az.status === 400 && capture.of("sns.s3.amazonaws.com").length === 0, az);
      az = await postSns(snsMessage({ topic: "arn:aws:sns:us-east-1:999999999999:someone-else", message: { appPackageName: PKG_A, notificationType: "ENTITLEMENT_CANCELLED", appUserId: AMZ_USER, receiptId: RID_LIFE } }));
      c.check("a correctly signed message from another topic: 400", az.status === 400 && /topic/i.test(az.body?.message), az);
      c.eq("no event was recorded for refused messages", (await eventsOf(ctx, dev.projectId)).length, azBefore);

      c.begin("Amazon: a refunded one-time purchase (ENTITLEMENT_CANCELLED)");
      const cancelAt = Date.now() - 1000;
      rvs.get(RID_LIFE)!.r = { ...rvs.get(RID_LIFE)!.r, cancelDate: cancelAt, cancelReason: 1 };
      az = await postSns(good);
      c.eq("the signed ENTITLEMENT_CANCELLED (SignatureVersion 2) is processed", az.body, { status: "processed" });
      c.has("CANCELLATION (CUSTOMER_SUPPORT) with the negative posted price", (await eventsFor(U("az_lifetime"), "CANCELLATION"))[0], { cancel_reason: "CUSTOMER_SUPPORT", price: -19.99, store: "AMAZON", product_id: "lifetime.unlock" });
      info = (await azSdk.customerInfo(U("az_lifetime"))).body;
      c.check("customer info: lifetime pro ended at the refund", !!proOf(info) && !active(info), proOf(info));
      const azPurchases = (await dev.v2("GET", `/customers/${U("az_lifetime")}/purchases`)).items;
      c.has("v2 purchase: refunded", azPurchases[0], { status: "refunded", store: "amazon" });

      c.begin("Google Play: scheduled pause (SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED)");
      const resumeG = sec(addMonths(T_END, 1)) * 1000;
      gSubs.get(TOK.pause)!.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
      gV1.set(TOK.pause, { autoResumeTimeMillis: String(resumeG) });
      g = await rtdn(subNote(11, TOK.pause));
      c.eq("the pause schedule is processed", g.body, { status: "processed" });
      c.check("the server read the resume date from the v1 subscriptions API", gCalls.some((x) => x.method === "GET" && x.path === `/purchases/subscriptions/pro/tokens/${TOK.pause}`));
      c.has("SUBSCRIPTION_PAUSED with auto_resume_at_ms", (await eventsFor(U("gp_pause"), "SUBSCRIPTION_PAUSED"))[0], { auto_resume_at_ms: resumeG, store: "PLAY_STORE" });
      info = (await gpSdk.customerInfo(U("gp_pause"))).body;
      c.check("customer info: access to the period end, auto_resume_date set", proOf(info)?.expires_date === iso(T_END) && info.subscriber?.subscriptions?.pro?.auto_resume_date === iso(resumeG), info.subscriber?.subscriptions?.pro);

      c.begin("Google Play: a voided purchase (refund)");
      const voidAt = Date.now();
      Object.assign(gSubs.get(TOK.refund)!, { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" });
      gSubs.get(TOK.refund)!.lineItems[0].expiryTime = new Date(voidAt).toISOString();
      g = await rtdn({ eventTimeMillis: String(voidAt), voidedPurchaseNotification: { purchaseToken: TOK.refund, orderId: ORD.refund, productType: 1, refundType: 1 } });
      c.eq("the voided purchase notification is processed", g.body, { status: "processed" });
      c.has("CANCELLATION (CUSTOMER_SUPPORT) with a negative price", (await eventsFor(U("gp_refund"), "CANCELLATION"))[0], { cancel_reason: "CUSTOMER_SUPPORT", price: -9.99, store: "PLAY_STORE", transaction_id: ORD.refund });
      g = await rtdn(subNote(12, TOK.refund));
      c.eq("SUBSCRIPTION_REVOKED for the same refund records nothing new", await types(U("gp_refund")), ["INITIAL_PURCHASE", "CANCELLATION"]);
      info = (await gpSdk.customerInfo(U("gp_refund"))).body;
      c.check("customer info: refunded_at set and pro ended", typeof info.subscriber?.subscriptions?.pro?.refunded_at === "string" && !active(info), info.subscriber?.subscriptions?.pro);
      c.has("v2 subscription: expired, no access", (await v2subs(U("gp_refund")))[0], { status: "expired", gives_access: false, store: "play_store" });

      // =====================================================================================================
      // Renewals and a failed renewal, a few seconds before the period end.
      // =====================================================================================================
      c.begin("renewals at the period end: Stripe invoice.paid and invoice.payment_failed, Amazon and Google renewals");
      const wait = T_END - 4000 - Date.now();
      c.check("the setup left time to renew before the period end", wait > 0, { msLeft: wait });
      if (wait > 0) await sleep(wait);
      const NEXT = addMonths(T_END, 1);
      stInvoice({ id: `in_renew2${S}`, sub: stIds.renew, start: T_END, end: NEXT, reason: "subscription_cycle" });
      stSub({ id: stIds.renew, user: U("st_renew"), origin: MONTH_BEFORE, ps: T_END, pe: NEXT, invoice: `in_renew2${S}` });
      const retryAt = T_END + 3 * DAY;
      stInvoice({ id: `in_pastdue2${S}`, sub: stIds.pastdue, start: T_END, end: NEXT, reason: "subscription_cycle", status: "open", nextAttempt: retryAt });
      stSub({ id: stIds.pastdue, user: U("st_pastdue"), origin: MONTH_BEFORE, ps: T_END, pe: NEXT, invoice: `in_pastdue2${S}`, status: "past_due" });
      const azRenewal = { ...rvs.get(RID)!.r, renewalDate: NEXT };
      rvs.get(RID)!.r = azRenewal;
      gSubs.set(TOK.buy, gSub({ start: MONTH_BEFORE, expiry: NEXT, order: `${ORD.buy}..0`, ack: true }));
      const [stRenew, stFailed, azRenew, gpRenew] = await Promise.all([
        stripeHook("invoice.paid", stripe.invoices.get(`in_renew2${S}`)),
        stripeHook("invoice.payment_failed", stripe.invoices.get(`in_pastdue2${S}`)),
        rtn("SUBSCRIPTION_RENEWED", RID, "1"),
        rtdn(subNote(2, TOK.buy)),
      ]);
      c.check("all four were processed before the period end", Date.now() < T_END && [stRenew, stFailed, azRenew, gpRenew].every((x) => x.status === 200 && x.body?.status === "processed"), { stRenew, stFailed, azRenew, gpRenew, msLeft: T_END - Date.now() });
      c.has("Stripe RENEWAL: the new invoice, its period and amount", (await eventsFor(U("st_renew"), "RENEWAL"))[0], { transaction_id: `in_renew2${S}`, original_transaction_id: stIds.renew, purchased_at_ms: T_END, expiration_at_ms: NEXT, price: 9.99, store: "STRIPE", is_trial_conversion: false });
      c.has("Stripe past due: BILLING_ISSUE with grace until the next payment attempt", (await eventsFor(U("st_pastdue"), "BILLING_ISSUE"))[0], { grace_period_expiration_at_ms: retryAt, store: "STRIPE" });
      c.has("Stripe past due: CANCELLATION (BILLING_ERROR)", (await eventsFor(U("st_pastdue"), "CANCELLATION"))[0], { cancel_reason: "BILLING_ERROR" });
      c.has("Amazon RENEWAL: the next period, the last price, transaction <receipt>.<period start>", (await eventsFor(U("az_buyer"), "RENEWAL"))[0], { transaction_id: `${RID}.${T_END}`, original_transaction_id: RID, purchased_at_ms: T_END, expiration_at_ms: NEXT, price: 4.99, store: "AMAZON" });
      c.has("Google RENEWAL: the renewal order, its period", (await eventsFor(U("gp_buy"), "RENEWAL"))[0], { transaction_id: `${ORD.buy}..0`, original_transaction_id: ORD.buy, purchased_at_ms: T_END, expiration_at_ms: NEXT, price: 9.99, store: "PLAY_STORE" });
      for (const [user, sdk, prod] of [[U("st_renew"), stSdk, PRICE_M.id], [U("az_buyer"), azSdk, "pro.monthly"], [U("gp_buy"), gpSdk, "pro"]] as const) {
        const ci = (await sdk.customerInfo(user)).body;
        c.check(`customer info (${user.split("_")[0]}): pro runs to the next period end`, proOf(ci)?.expires_date === iso(NEXT) && ci.subscriber?.subscriptions?.[prod]?.purchase_date === iso(T_END), ci.subscriber?.subscriptions?.[prod]);
      }
      info = (await stSdk.customerInfo(U("st_pastdue"))).body;
      c.check("customer info (Stripe past due): paid period kept, grace end and billing issue set, pro until the grace end", info.subscriber?.subscriptions?.[PRICE_M.id]?.expires_date === iso(T_END) && info.subscriber?.subscriptions?.[PRICE_M.id]?.grace_period_expires_date === iso(retryAt) && typeof info.subscriber?.subscriptions?.[PRICE_M.id]?.billing_issues_detected_at === "string" && proOf(info)?.expires_date === iso(retryAt), info.subscriber?.subscriptions?.[PRICE_M.id]);
      const ledger = await ctx.sql`SELECT cu.original_app_user_id AS u, t.kind, t.revenue_usd::float8 AS usd FROM transactions t JOIN customers cu ON cu.id = t.customer_id WHERE cu.project_id = ${dev.projectId} AND t.kind = 'renewal' ORDER BY u`;
      c.eq("ledger: one renewal each for Stripe, Amazon and Google, none for the failed payment", ledger.map((x) => [x.u, x.usd]), [[U("az_buyer"), 4.99], [U("gp_buy"), 9.99], [U("st_renew"), 9.99]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

      c.begin("after the renewal: cancel and undo it (Stripe, Amazon, Google), price increase consent (Google)");
      const tc = Date.now();
      stSub({ id: stIds.renew, user: U("st_renew"), origin: MONTH_BEFORE, ps: T_END, pe: NEXT, invoice: `in_renew2${S}`, cancelAtPeriodEnd: true, canceledAt: tc, cancelReason: "cancellation_requested" });
      st = await stripeHook("customer.subscription.updated", stripe.subscriptions.get(stIds.renew));
      c.has("Stripe cancel at period end: CANCELLATION (UNSUBSCRIBE)", (await eventsFor(U("st_renew"), "CANCELLATION"))[0], { cancel_reason: "UNSUBSCRIBE" });
      c.has("v2 subscription (Stripe): will not renew, still gives access", (await v2subs(U("st_renew")))[0], { auto_renewal_status: "will_not_renew", gives_access: true, status: "active" });
      stSub({ id: stIds.renew, user: U("st_renew"), origin: MONTH_BEFORE, ps: T_END, pe: NEXT, invoice: `in_renew2${S}` });
      st = await stripeHook("customer.subscription.updated", stripe.subscriptions.get(stIds.renew));
      c.eq("Stripe resume: processed", st.body, { status: "processed" });
      c.eq("Stripe resume: UNCANCELLATION", (await eventsFor(U("st_renew"), "UNCANCELLATION")).length, 1);
      c.has("v2 subscription (Stripe): will renew again", (await v2subs(U("st_renew")))[0], { auto_renewal_status: "will_renew", gives_access: true });

      rvs.get(RID)!.r = { ...azRenewal, autoRenewing: false };
      az = await rtn("SUBSCRIPTION_AUTO_RENEWAL_OFF", RID, "2");
      c.eq("Amazon auto-renew off: processed", az.body, { status: "processed" });
      c.has("Amazon: CANCELLATION (UNSUBSCRIBE)", (await eventsFor(U("az_buyer"), "CANCELLATION"))[0], { cancel_reason: "UNSUBSCRIBE", store: "AMAZON" });
      info = (await azSdk.customerInfo(U("az_buyer"))).body;
      c.check("customer info (Amazon): unsubscribe_detected_at set, access to the period end", typeof info.subscriber?.subscriptions?.["pro.monthly"]?.unsubscribe_detected_at === "string" && proOf(info)?.expires_date === iso(NEXT), info.subscriber?.subscriptions?.["pro.monthly"]);
      rvs.get(RID)!.r = { ...azRenewal, autoRenewing: true };
      az = await rtn("SUBSCRIPTION_AUTO_RENEWAL_ON", RID, "1");
      c.eq("Amazon auto-renew on: UNCANCELLATION", (await eventsFor(U("az_buyer"), "UNCANCELLATION")).length, 1);

      const cancelG = sec(Date.now() - 2000) * 1000;
      gSubs.set(TOK.buy, gSub({ start: MONTH_BEFORE, expiry: NEXT, order: `${ORD.buy}..0`, ack: true, state: "SUBSCRIPTION_STATE_CANCELED", cancelTime: cancelG }));
      g = await rtdn(subNote(3, TOK.buy));
      c.has("Google SUBSCRIPTION_CANCELED: CANCELLATION (UNSUBSCRIBE)", (await eventsFor(U("gp_buy"), "CANCELLATION"))[0], { cancel_reason: "UNSUBSCRIBE", store: "PLAY_STORE" });
      info = (await gpSdk.customerInfo(U("gp_buy"))).body;
      c.check("customer info (Google): unsubscribe_detected_at is the user's cancel time, access to the period end", info.subscriber?.subscriptions?.pro?.unsubscribe_detected_at === iso(cancelG) && proOf(info)?.expires_date === iso(NEXT), info.subscriber?.subscriptions?.pro);
      const [survey] = await ctx.sql`SELECT cancel_survey_reason FROM subscriptions WHERE store_key = ${TOK.buy}`;
      c.eq("the cancel survey answer is kept for the Cancel Reasons chart", survey?.cancel_survey_reason, "CANCEL_SURVEY_REASON_COST_RELATED");
      gSubs.set(TOK.buy, gSub({ start: MONTH_BEFORE, expiry: NEXT, order: `${ORD.buy}..0`, ack: true }));
      g = await rtdn(subNote(7, TOK.buy));
      c.eq("Google SUBSCRIPTION_RESTARTED: UNCANCELLATION", (await eventsFor(U("gp_buy"), "UNCANCELLATION")).length, 1);
      gSubs.set(TOK.buy, gSub({ start: MONTH_BEFORE, expiry: NEXT, order: `${ORD.buy}..0`, ack: true, priceChange: "OUTSTANDING" }));
      g = await rtdn(subNote(19, TOK.buy));
      c.eq("Google SUBSCRIPTION_PRICE_CHANGE_UPDATED (consent needed): processed", g.body, { status: "processed" });
      c.has("PRICE_INCREASE_CONSENT_REQUIRED", (await eventsFor(U("gp_buy"), "PRICE_INCREASE_CONSENT_REQUIRED"))[0], { store: "PLAY_STORE", product_id: "pro", transaction_id: `${ORD.buy}..0` });
      gSubs.set(TOK.buy, gSub({ start: MONTH_BEFORE, expiry: NEXT, order: `${ORD.buy}..0`, ack: true, priceChange: "CONFIRMED" }));
      g = await rtdn(subNote(8, TOK.buy));
      c.has("Google SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: PRICE_INCREASE_CONSENT_APPROVED", (await eventsFor(U("gp_buy"), "PRICE_INCREASE_CONSENT_APPROVED"))[0], { store: "PLAY_STORE", product_id: "pro" });
      c.has("v2 subscription (Google): active, will renew, gives access", (await v2subs(U("gp_buy")))[0], { status: "active", auto_renewal_status: "will_renew", gives_access: true, store: "play_store" });

      c.begin("past the period end: Stripe grace period, Google pause starts");
      const pastEnd = T_END + 1500 - Date.now();
      if (pastEnd > 0) await sleep(pastEnd);
      c.has("v2 subscription (Stripe past due): in grace period, access, pending payment", (await v2subs(U("st_pastdue")))[0], { status: "in_grace_period", gives_access: true, pending_payment: true, auto_renewal_status: "will_not_renew" });
      gSubs.set(TOK.pause, gSub({ start: MONTH_BEFORE, expiry: T_END, order: ORD.pause, ack: true, state: "SUBSCRIPTION_STATE_PAUSED", autoResume: resumeG }));
      g = await rtdn(subNote(10, TOK.pause));
      c.eq("Google SUBSCRIPTION_PAUSED (the pause started): processed", g.body, { status: "processed" });
      sameTypes("Google pause: INITIAL_PURCHASE, SUBSCRIPTION_PAUSED, EXPIRATION", await waitTypes(U("gp_pause"), ["INITIAL_PURCHASE", "SUBSCRIPTION_PAUSED", "EXPIRATION"]), ["INITIAL_PURCHASE", "SUBSCRIPTION_PAUSED", "EXPIRATION"]);
      c.has("EXPIRATION (SUBSCRIPTION_PAUSED) at the period end", (await eventsFor(U("gp_pause"), "EXPIRATION"))[0], { expiration_reason: "SUBSCRIPTION_PAUSED", expiration_at_ms: T_END });
      c.has("v2 subscription (Google pause): paused, no access, will pause", (await v2subs(U("gp_pause")))[0], { status: "paused", gives_access: false, auto_renewal_status: "will_pause" });

      c.begin("every customer's events (SQL)");
      const EXPECT: Record<string, string[]> = {
        st_renew: ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION"],
        st_pastdue: ["INITIAL_PURCHASE", "BILLING_ISSUE", "CANCELLATION"],
        st_cancel: ["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"],
        st_change: ["INITIAL_PURCHASE", "PRODUCT_CHANGE"],
        st_pause: ["INITIAL_PURCHASE", "SUBSCRIPTION_PAUSED"],
        st_refund: ["INITIAL_PURCHASE", "CANCELLATION"],
        az_buyer: ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION"],
        az_lifetime: ["NON_RENEWING_PURCHASE", "CANCELLATION"],
        gp_buy: ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION", "PRICE_INCREASE_CONSENT_REQUIRED", "PRICE_INCREASE_CONSENT_APPROVED"],
        gp_pause: ["INITIAL_PURCHASE", "SUBSCRIPTION_PAUSED", "EXPIRATION"],
        gp_refund: ["INITIAL_PURCHASE", "CANCELLATION"],
      };
      // One more expiration-job run (30 s) must add nothing: renewed periods do not expire at the old period end.
      await sleep(31_000);
      for (const [u, want] of Object.entries(EXPECT)) c.eq(`${u}: ${want.join(", ")}`, await types(U(u)), want);
      const all = await eventsOf(ctx, dev.projectId);
      c.eq("no other events in the project", all.length, Object.values(EXPECT).reduce((n, x) => n + x.length, 0));
      c.check("every event names its store and is sandbox data (test mode, App Tester, license tester)", all.every((e) => ["STRIPE", "AMAZON", "PLAY_STORE"].includes(e.store) && e.environment === "SANDBOX"), all.map((e) => [e.type, e.store, e.environment]));

      c.begin("every webhook delivered and key-checked against RevenueCat's samples");
      const delivered = await until(async () => {
        const got = capture.requests.filter((x) => x.host === "local" && x.path === hookPath);
        return got.length >= all.length ? got : null;
      }, { timeoutMs: 90_000, everyMs: 1000 }) ?? capture.requests.filter((x) => x.path === hookPath);
      c.eq(`${all.length} deliveries reached the endpoint`, delivered.length, all.length);
      c.check("every delivery carries the Authorization header and an HMAC signature", delivered.every((d) => d.headers.authorization === "Bearer stores-secret" && /t=\d+,v1=[0-9a-f]{64}/.test(d.headers["x-revenuecat-webhook-signature"] ?? "")));
      const bodies = delivered.map((d) => JSON.parse(d.body).event as Record<string, any>);
      c.eq("the delivered events are exactly the recorded ones", bodies.map((e) => e.id).sort(), all.map((e) => e.id).sort());
      const problems = bodies.flatMap(keyProblems);
      c.check("every delivered event has exactly the keys of RevenueCat's sample for its type", problems.length === 0, problems);
      c.check("money moves only on purchases, renewals and refunds (0 on the rest)", bodies.filter((e) => ["UNCANCELLATION", "SUBSCRIPTION_PAUSED", "EXPIRATION", "BILLING_ISSUE", "PRODUCT_CHANGE"].includes(e.type) || (e.type === "CANCELLATION" && e.cancel_reason !== "CUSTOMER_SUPPORT")).every((e) => e.price === 0), bodies.map((e) => [e.type, e.price]));
      const dels = await dev.v2("GET", `/webhooks/${hook.id}/deliveries?limit=100`);
      c.check("the delivery log marks every one delivered with HTTP 200", dels.items.length === all.length && dels.items.every((d: any) => d.status === "delivered" && d.response_status === 200), dels.items.map((d: any) => [d.event_type, d.status]));

      c.begin("setup health: notification URLs with their last received notification");
      const health = await dev.v2("GET", "/setup_health");
      for (const [app, store] of [[stApp, "stripe"], [azApp, "amazon"], [gpApp, "google"]] as const) {
        const a = health.apps.find((x: any) => x.id === app.id);
        c.check(`${store}: notification URL ${`/v1/notifications/${store}/<app>`}, status ready, last received during this run`,
          a?.notification_url === `${ctx.base}/v1/notifications/${store}/${app.id}` && a.notification_status === "ready" && a.last_notification_at >= started && a.last_notification_received_at >= a.last_notification_at && a.credentials_configured === true, a);
      }
      const stHealth = health.apps.find((x: any) => x.id === stApp.id);
      c.check("stripe: the last refused webhook is shown with its reason", /rejected: .*Stripe-Signature|rejected: No signature/.test(stHealth?.last_notification_error?.message ?? ""), stHealth?.last_notification_error);
      c.check("webhooks: all delivered in the last 24 hours, none failing", health.webhooks.delivered_24h === all.length && health.webhooks.failing.length === 0, health.webhooks);

      c.begin("no request reached a real store");
      const out = ctx.server.outbound(started);
      const captureOrigin = new URL(capture.base.replace("localhost", "127.0.0.1")).origin;
      const notCaptured = out.filter((o) => o.routed !== captureOrigin && !(o.routed === "real" && OUTBOUND_ALLOW.includes(o.host)));
      c.check("every outbound call went to the capture server (or a public exchange-rate host)", notCaptured.length === 0, notCaptured);
      const hosts = new Set(out.filter((o) => o.routed === captureOrigin).map((o) => o.host));
      c.check("the store adapters called Stripe, RVS, SNS, Google's token endpoint, certs and the Play API (all fakes)", ["api.stripe.com", "appstore-sdk.amazon.com", "sns.us-east-1.amazonaws.com", "oauth2.googleapis.com", "www.googleapis.com", "androidpublisher.googleapis.com"].every((h) => hosts.has(h)), [...hosts]);
      c.check("no Apple host was called, not even blocked", out.every((o) => !/apple\.com$/.test(o.host)), out.filter((o) => /apple/.test(o.host)));
      c.check("every Play API call carried the access token from the service account grant", gCalls.length > 0 && gCalls.every((x) => x.auth === `Bearer ${ACCESS}`), gCalls.filter((x) => x.auth !== `Bearer ${ACCESS}`));
    } finally {
      for (const h of handlers) { const i = capture.handlers.indexOf(h); if (i >= 0) capture.handlers.splice(i, 1); }
      rmSync(tmp, { recursive: true, force: true });
    }
  },
};
export default journey;
