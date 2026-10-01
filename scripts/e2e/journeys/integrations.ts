// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (h), third-party integrations and scheduled data exports. A developer configures every partner in
// the catalogue through the v2 API with made-up credentials, then real events reach them:
//   A. a Test Store purchase from the iOS SDK (sandbox), with the attribution ids the partners need set first;
//   B. an Amazon Appstore purchase (production; Amazon's Receipt Verification Service is answered by the capture
//      server), the production path for partners that never take sandbox events (Asapty, Tenjin);
//   C. the "Send test event" button of every partner, through an App Store app (production).
// For each event and partner the journey rebuilds the request with the same core builder from the stored event, and
// compares it byte for byte with what reached the capture server, checks key fields by hand, the delivery log and the
// integrations row. Firebase and a Tag Manager integration pointed at www.google-analytics.com go to Google's real
// Measurement Protocol validation server (lib/outbound-preload.mjs), which must report no problems.
// Then retry and replay after partner errors, the Intercom inbox and Zendesk connections, and CSV and Parquet exports
// of all four tables to a MinIO bucket (Docker, ports base+4/+5), read back and checked.
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, verify as verifySig } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { until, sleep } from "./lib/check.ts";
import { type Ctx, sdkClient, signUp, standardCatalog } from "./lib/context.ts";
import { PORTS, ROOT, writeJson, type Captured } from "./lib/stack.ts";
import * as core from "../../../packages/core/src/integrations/index.ts";
import { signV4, sha256Hex } from "../../../apps/server/src/services/exports/sigv4.ts";
import { parseCsv } from "../../../apps/server/src/services/exports/files.ts";

type Settings = Record<string, unknown>;
interface Cfg {
  key: string; kind: string; name?: string; settings: Settings; hosts: string[];
  /** Sent to www.google-analytics.com (Google's validation server): the stream id the outbound log records. */
  realStream?: (sandbox: boolean) => string;
  connection?: boolean;
}
interface IntRow { id: string; kind: string; name: string; settings: Settings; secrets: string | null; secret_hints: Record<string, string>; event_names: Record<string, string>; last_delivered_at: Date | null; consecutive_failures: number; last_error: string | null }
interface EvRow { id: string; type: string; environment: string; app_id: string | null; customer_id: string | null; payload: { event: Record<string, any> } }
interface Parsed extends Captured { json: any; form: URLSearchParams; q: URLSearchParams; status: number }
type Outcome = { phase: string; status: string; detail: string };

const rnd = (n = 12) => randomBytes(n).toString("hex").slice(0, n);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tryJson = (s: string) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const GA = "www.google-analytics.com";
const TOKEN = "ya29.journey-fake";
/** RevenueCat's transaction export columns (prd/integrations/PRD.md "Tables"), plus app_id. */
const RC_TRANSACTION_COLUMNS = [
  "rc_original_app_user_id", "rc_last_seen_app_user_id_alias", "country", "country_source", "product_identifier", "product_display_name", "product_duration",
  "start_time", "end_time", "grace_period_end_time", "effective_end_time", "store", "is_auto_renewable", "is_trial_period", "is_in_intro_offer_period", "is_sandbox",
  "price_in_usd", "purchase_price_in_usd", "takehome_percentage", "tax_percentage", "commission_percentage", "store_transaction_id", "original_store_transaction_id",
  "refunded_at", "unsubscribe_detected_at", "billing_issues_detected_at", "purchased_currency", "price_in_purchased_currency", "purchase_price_in_purchased_currency",
  "entitlement_identifiers", "renewal_number", "is_trial_conversion", "presented_offering", "ownership_type", "reserved_subscriber_attributes",
  "custom_subscriber_attributes", "platform", "updated_at", "offer", "offer_type", "first_seen_time", "auto_resume_time", "app_id",
];

const journey: Journey = {
  name: "integrations",
  title: "Integrations: every catalogue partner gets real events (exact payloads), Google's MP validation, retry and replay, S3 exports to MinIO",
  async run(ctx: Ctx) {
    const { c, sql } = ctx;
    const S = ctx.stamp;
    const outcomes: Record<string, Outcome[]> = {};
    const gaValidations: unknown[] = [];
    const note = (key: string, o: Outcome) => (outcomes[key] ??= []).push(o);

    // ---------- the partners' side: answers as each API documents them ----------
    const fails = new Map<string, { status: number; left: number }>();
    const bqTables = new Set<string>();
    const statusOf = new WeakMap<Captured, number>();
    const amazonReceipts = new Map<string, Record<string, unknown>>();
    const route = (r: Captured): { status: number; body: string; type?: string } | null => {
      const j = (o: unknown, status = 200) => ({ status, body: JSON.stringify(o), type: "application/json" });
      const f = fails.get(r.host);
      if (f && f.left > 0) { f.left--; return j({ error: "journey: injected partner error" }, f.status); }
      switch (r.host) {
        case "hooks.slack.com": return { status: 200, body: "ok", type: "text/plain" };
        case "api.segment.io": return j({ success: true });
        case "api2.amplitude.com": return j({ code: 200, events_ingested: 1, payload_size_bytes: r.body.length, server_upload_time: Date.now() });
        case "api.mixpanel.com": return j({ status: 1, error: null });
        case "us.i.posthog.com": return j({ status: "Ok" });
        case "bigquery.googleapis.com": {
          const m = /^(.*\/tables)\/([^/]+)\/insertAll$/.exec(r.path);
          if (m && !bqTables.has(r.path)) return j({ error: { code: 404, message: `Not found: Table journey:${m[2]}`, status: "NOT_FOUND" } }, 404);
          if (r.method === "POST" && /\/tables$/.test(r.path)) {
            const t = JSON.parse(r.body).tableReference;
            bqTables.add(`${r.path}/${t.tableId}/insertAll`);
            return j({ kind: "bigquery#table", tableReference: t });
          }
          return j({ kind: "bigquery#tableDataInsertAllResponse" });
        }
        case "api2.appsflyer.com": return { status: 200, body: "ok", type: "text/plain" };
        case "s2s.adjust.com": return j({ status: "OK" });
        case "graph.facebook.com": return j({ events_received: 1, messages: [], fbtrace_id: "AJourney" });
        case "s2s.us1.mparticle.com": return { status: 202, body: "" };
        case "events.statsigapi.net": return j({ success: true }, 202);
        case "nom.telemetrydeck.com": return { status: 200, body: "" };
        case "asapty.com": return j({ result: { status: "OK" } });
        case "api2.branch.io": return j({ branch_view_enabled: false });
        case "control.kochava.com": return j({ success: "1" });
        case "api.airbridge.io": return j({ message: "ok" });
        case "s2s.singular.net": return j({ status: "ok" });
        case "track.tenjin.com": return j({ code: 200 });
        case "go.urbanairship.com": return j({ ok: true, operation_id: randomUUID(), warnings: [] });
        case "rest.iad-01.braze.com": return j({ message: "success", attributes_processed: 1, events_processed: 2 }, 201);
        case "api.clevertap.com": return j({ status: "success", processed: 2, unprocessed: [] });
        case "track.customer.io": return j({});
        case "discord.com": return { status: 204, body: "" };
        case "api.intercom.io": return { status: 202, body: "" };
        case "api.iterable.com": return j({ msg: "", code: "Success", params: null });
        case "api.onesignal.com": return j({ properties: {} }, 202);
        case "superwall.com": case "api.event.appstack.tech": case "acquire.splitmetrics.com": case "receiver.solar-engine.com": case "sgtm.example.com": return j({ received: true });
        case "appstore-sdk.amazon.com": {
          const m = /\/receiptId\/([^/]+)$/.exec(r.path);
          const receipt = m ? amazonReceipts.get(decodeURIComponent(m[1]!)) : undefined;
          if (r.path.startsWith("/sandbox/") || !receipt) return j({ message: "Unknown receipt" }, 400);
          return j(receipt);
        }
        default: return null;
      }
    };
    const handler = async (r: Captured, res: ServerResponse) => {
      const a = route(r);
      if (!a) return false;
      statusOf.set(r, a.status);
      res.statusCode = a.status;
      if (a.type) res.setHeader("content-type", a.type);
      res.end(a.body);
      return true;
    };
    ctx.capture.handlers.unshift(handler);
    const capStart = ctx.capture.requests.length, outStart = ctx.server.outbound().length;
    const minio = `rd-journey-minio-${S}`;
    let minioStarted = false;
    try {
      // ---------- developer setup ----------
      c.begin("developer setup: catalogue, apps, products");
      const dev = await signUp(ctx, "integrations", "Integrations journey");
      const cat = await standardCatalog(dev);
      const iosApp = await dev.v2("POST", "/apps", { name: "Journey iOS", type: "app_store", app_store: { bundle_id: "com.revenuedot.journey" } });
      const amazonApp = await dev.v2("POST", "/apps", { name: "Journey Amazon", type: "amazon", amazon: { package_name: "com.revenuedot.journey.amazon", shared_secret: `2:${rnd(40)}` } });
      const amazonKey = (await dev.v2("GET", `/apps/${amazonApp.id}/public_api_keys`)).items[0].key as string;
      const amazonProduct = await dev.v2("POST", "/products", { store_identifier: "journey.pro.monthly", app_id: amazonApp.id, type: "subscription", display_name: "Pro monthly (Amazon)", subscription: { duration: "P1M" } });
      await dev.v2("POST", `/entitlements/${cat.pro.id}/actions/attach_products`, { product_ids: [amazonProduct.id] });
      c.check("Test Store, App Store and Amazon apps with their keys", /^test_/.test(cat.testKey) && iosApp.type === "app_store" && /^amzn_/.test(amazonKey), { test: cat.testKey.slice(0, 5), amazon: amazonKey.slice(0, 5) });

      const catalog = await dev.v2("GET", "/integrations/catalog");
      const specs = new Map<string, any>(catalog.items.map((s: any) => [s.type, s]));
      c.check(`the catalogue lists ${catalog.items.length} partners, each with fields and a docs link`, catalog.items.length >= 36 && catalog.items.every((s: any) => Array.isArray(s.fields) && /^https:\/\//.test(s.docs_url)), catalog.items.map((s: any) => s.type));

      // ---------- made-up credentials for every partner ----------
      const { privateKey: saKey, publicKey: saPub } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      const sa = { type: "service_account", project_id: "rd-journey-project", private_key_id: rnd(40), private_key: saKey, client_email: `rd-journey@rd-journey-project.iam.gserviceaccount.com`, client_id: "1234567890" };
      const asaKey = generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
      const fbIos = "1:1234567890:ios:0a1b2c3d4e5f6a7b", fbAndroid = "1:1234567890:android:0a1b2c3d4e5f6a7c";
      const CFGS: Cfg[] = [
        { key: "slack", kind: "slack", settings: { webhook_url: `https://hooks.slack.com/services/T0JOURNEY/B0JOURNEY/${rnd(24)}` }, hosts: ["hooks.slack.com"] },
        { key: "segment", kind: "segment", settings: { write_key: `seg_${rnd(24)}`, region: "us" }, hosts: ["api.segment.io"] },
        { key: "amplitude", kind: "amplitude", settings: { api_key: `amp_live_${rnd(20)}`, sandbox_api_key: `amp_sbx_${rnd(20)}`, region: "us" }, hosts: ["api2.amplitude.com"] },
        { key: "mixpanel", kind: "mixpanel", settings: { project_token: `mp_live_${rnd(20)}`, sandbox_project_token: `mp_sbx_${rnd(20)}`, region: "us" }, hosts: ["api.mixpanel.com"] },
        { key: "posthog", kind: "posthog", settings: { api_key: `phc_live_${rnd(20)}`, sandbox_api_key: `phc_sbx_${rnd(20)}`, region: "us" }, hosts: ["us.i.posthog.com"] },
        { key: "firebase", kind: "firebase", settings: { ios_firebase_app_id: fbIos, ios_api_secret: `gaIos${rnd(18)}`, android_firebase_app_id: fbAndroid, android_api_secret: `gaAnd${rnd(18)}`, currency: "usd" }, hosts: [], realStream: () => fbIos },
        { key: "bigquery", kind: "bigquery", settings: { service_account_json: JSON.stringify(sa), dataset_id: "revenuedot_journey", table_id: `events_${S}` }, hosts: ["bigquery.googleapis.com"] },
        { key: "appsflyer", kind: "appsflyer", settings: { dev_key: `afLive${rnd(16)}`, sandbox_dev_key: `afSbx${rnd(16)}`, ios_app_id: "id1234567890", android_app_id: "com.revenuedot.journey" }, hosts: ["api2.appsflyer.com"] },
        { key: "adjust", kind: "adjust", settings: { ios_app_token: "abc123iosapp", android_app_token: "abc123andapp", event_tokens: { initial_purchase: "ip1234", trial_started: "ts1234", renewal: "rn1234", test: "te1234" }, oauth_token: `adjS2S${rnd(20)}` }, hosts: ["s2s.adjust.com"] },
        { key: "meta", kind: "meta", settings: { dataset_id: "111222333444555", access_token: `EAAB${rnd(30)}`, sandbox_dataset_id: "555666777888999", sandbox_access_token: `EAAS${rnd(30)}`, test_event_code: "TEST12345" }, hosts: ["graph.facebook.com"] },
        { key: "mparticle", kind: "mparticle", settings: { api_key: `us1-${rnd(24)}`, api_secret: rnd(32), pod: "us1" }, hosts: ["s2s.us1.mparticle.com"] },
        { key: "statsig", kind: "statsig", settings: { server_secret: `secret-${rnd(30)}` }, hosts: ["events.statsigapi.net"] },
        { key: "superwall", kind: "superwall", settings: { webhook_url: `https://superwall.com/api/integrations/revenuecat/${rnd(20)}`, authorization: `Bearer sw_${rnd(20)}` }, hosts: ["superwall.com"] },
        { key: "telemetrydeck", kind: "telemetrydeck", settings: { app_id: "AAAA1111-BBBB-CCCC-DDDD-EEEEFFFF0000" }, hosts: ["nom.telemetrydeck.com"] },
        { key: "apple_search_ads", kind: "apple_search_ads", connection: true, settings: { org_id: "1234567", client_id: `SEARCHADS.${randomUUID()}`, team_id: `SEARCHADS.${randomUUID()}`, key_id: randomUUID(), private_key: asaKey }, hosts: [] },
        { key: "appstack", kind: "appstack", settings: { webhook_url: `https://api.event.appstack.tech/revenuecat/${rnd(16)}`, authorization: `Bearer as_${rnd(24)}` }, hosts: ["api.event.appstack.tech"] },
        { key: "asapty", kind: "asapty", settings: { asapty_id: `asapty${rnd(10)}` }, hosts: ["asapty.com"] },
        { key: "branch", kind: "branch", settings: { branch_key: `key_live_${rnd(24)}`, sandbox_branch_key: `key_test_${rnd(24)}` }, hosts: ["api2.branch.io"] },
        { key: "google_tag_manager", kind: "google_tag_manager", settings: { server_container_url: "https://sgtm.example.com", measurement_id: "G-JOURNEY01", api_secret: `gtm${rnd(18)}`, sandbox_measurement_id: "G-JOURNEYSB", sandbox_api_secret: `gtmSbx${rnd(18)}` }, hosts: ["sgtm.example.com"] },
        // A second Tag Manager integration whose "server container" is GA4 itself: the same Measurement Protocol payload,
        // checked by Google's validation server as a web stream hit.
        { key: "google_tag_manager_ga4", kind: "google_tag_manager", name: "GA4 web stream (Measurement Protocol)", settings: { server_container_url: "https://www.google-analytics.com", measurement_id: "G-RDJOURNEY1", api_secret: `ga4web${rnd(18)}`, sandbox_measurement_id: "G-RDJOURNEY2", sandbox_api_secret: `ga4sbx${rnd(18)}` }, hosts: [], realStream: (sb) => (sb ? "G-RDJOURNEY2" : "G-RDJOURNEY1") },
        { key: "kochava", kind: "kochava", settings: { ios_app_guid: "korevenuedot-journey-ios-x1", android_app_guid: "korevenuedot-journey-and-x1", sandbox_ios_app_guid: "korevenuedot-journey-ios-test", sandbox_android_app_guid: "korevenuedot-journey-and-test" }, hosts: ["control.kochava.com"] },
        { key: "airbridge", kind: "airbridge", settings: { app_name: "rdjourney", api_token: `ab${rnd(30)}`, sandbox_app_name: "rdjourneysandbox" }, hosts: ["api.airbridge.io"] },
        { key: "splitmetrics", kind: "splitmetrics", settings: { webhook_url: `https://acquire.splitmetrics.com/api/revenuecat/${rnd(20)}` }, hosts: ["acquire.splitmetrics.com"] },
        { key: "singular", kind: "singular", settings: { sdk_key: `sgLive${rnd(16)}`, sandbox_sdk_key: `sgSbx${rnd(16)}`, api_version: "v2" }, hosts: ["s2s.singular.net"] },
        { key: "solarengine", kind: "solarengine", settings: { webhook_url: `https://receiver.solar-engine.com/revenuecat/${rnd(20)}` }, hosts: ["receiver.solar-engine.com"] },
        { key: "tenjin", kind: "tenjin", settings: { ios_sdk_key: `TJIOS${rnd(24).toUpperCase()}`, android_sdk_key: `TJAND${rnd(24).toUpperCase()}` }, hosts: ["track.tenjin.com"] },
        { key: "airship", kind: "airship", settings: { app_key: "rdJourneyAppKey01", token: `MTpr${rnd(30)}`, sandbox_app_key: "rdJourneySbxKey01", sandbox_token: `MTps${rnd(30)}`, region: "us", set_attributes: true }, hosts: ["go.urbanairship.com"] },
        { key: "braze", kind: "braze", settings: { rest_endpoint: "https://rest.iad-01.braze.com", api_key: randomUUID(), sandbox_api_key: randomUUID(), app_id: "braze-journey-app", revenue_format: "ecommerce" }, hosts: ["rest.iad-01.braze.com"] },
        { key: "clevertap", kind: "clevertap", settings: { account_id: "RD-JOURNEY-ACCT", passcode: `RDP-${rnd(16)}`, sandbox_account_id: "RD-JOURNEY-SBX", sandbox_passcode: `RDS-${rnd(16)}`, region: "eu" }, hosts: ["api.clevertap.com"] },
        { key: "customerio", kind: "customerio", settings: { site_id: "rdjourneysite", api_key: rnd(20), sandbox_site_id: "rdjourneysbx", sandbox_api_key: rnd(20), region: "us" }, hosts: ["track.customer.io"] },
        { key: "discord", kind: "discord", settings: { webhook_url: `https://discord.com/api/webhooks/123456789012345678/${rnd(40)}` }, hosts: ["discord.com"] },
        { key: "intercom", kind: "intercom", settings: { access_token: `dG9r${rnd(40)}`, region: "us" }, hosts: ["api.intercom.io"] },
        { key: "iterable", kind: "iterable", settings: { api_key: rnd(32), sandbox_api_key: rnd(32), region: "us", track_purchases: true }, hosts: ["api.iterable.com"] },
        { key: "onesignal", kind: "onesignal", settings: { app_id: randomUUID(), api_key: `os_v2_app_${rnd(40)}` }, hosts: ["api.onesignal.com"] },
        { key: "admob", kind: "admob", connection: true, settings: { client_id: "1234-rdjourney.apps.googleusercontent.com", client_secret: `GOCSPX-${rnd(20)}` }, hosts: [] },
        { key: "intercom_inbox", kind: "intercom_inbox", connection: true, settings: { client_secret: rnd(32) }, hosts: [] },
        { key: "zendesk", kind: "zendesk", connection: true, settings: {}, hosts: [] },
      ];
      const missing = [...specs.keys()].filter((k) => !CFGS.some((x) => x.kind === k));
      c.must("the journey configures every partner in the catalogue", missing.length === 0, { missing });

      c.begin("create every integration through the v2 API");
      const secretKeysOf = (kind: string) => (specs.get(kind)!.fields as any[]).filter((f) => f.type === "secret").map((f) => f.key as string);
      const byId = new Map<string, Cfg>(), idOf = new Map<string, string>(), secretsOf = new Map<string, Record<string, string>>();
      const allSecrets: string[] = [];
      for (const cfg of CFGS) {
        const sk = secretKeysOf(cfg.kind);
        const secrets = Object.fromEntries(Object.entries(cfg.settings).filter(([k]) => sk.includes(k))) as Record<string, string>;
        const r = await dev.v2r("POST", "/integrations/partners", { type: cfg.kind, name: cfg.name, enabled: true, environment: null, settings: cfg.settings });
        const leaked = Object.values(secrets).filter((v) => JSON.stringify(r.body).includes(v));
        const ok = r.status === 201 && r.body.type === cfg.kind && r.body.environment === null && leaked.length === 0
          && sk.every((k) => r.body.secrets[k]?.configured === (k in secrets));
        c.check(`${cfg.key}: created (201), sandbox and production, secrets only as "configured"`, ok, { status: r.status, body: r.body, leaked: leaked.length });
        if (r.status !== 201) continue;
        byId.set(r.body.id, cfg); idOf.set(cfg.key, r.body.id); secretsOf.set(r.body.id, secrets); allSecrets.push(...Object.values(secrets));
      }
      c.must("every integration was created", idOf.size === CFGS.length, { created: idOf.size, of: CFGS.length });
      const listed = await dev.v2("GET", "/integrations/partners?limit=100");
      c.eq("the integrations list has every one, all enabled", listed.items.filter((x: any) => x.enabled).length, CFGS.length);

      // ---------- shared verification: rebuild each partner request from the stored event and compare ----------
      const intRow = async (id: string) => (await sql<IntRow[]>`SELECT * FROM integrations WHERE id = ${id}`)[0]!;
      const eventCtx = async (ev: EvRow): Promise<core.EventContext> => {
        const ec: core.EventContext = { projectId: dev.projectId, dashboardUrl: ctx.base };
        if (ev.app_id) ec.bundleId = (await sql`SELECT bundle_id FROM apps WHERE id = ${ev.app_id}`)[0]?.bundle_id ?? null;
        if (ev.customer_id) {
          const [cu] = await sql`SELECT last_seen_app_version, last_seen_platform, last_seen_platform_version FROM customers WHERE id = ${ev.customer_id}`;
          if (cu) { ec.appVersion = cu.last_seen_app_version; ec.platform = cu.last_seen_platform; ec.platformVersion = cu.last_seen_platform_version; }
        }
        return ec;
      };
      // services/integrations/deliver.ts lays the customer's current attributes over the recorded ones.
      const withAttrs = async (ev: EvRow) => {
        const e = { ...ev.payload.event };
        if (!ev.customer_id || ev.type === "TRANSFER") return e;
        const attrs = { ...(e.subscriber_attributes ?? {}) };
        for (const a of await sql`SELECT key, value, updated_at_ms FROM customer_attributes WHERE customer_id = ${ev.customer_id}`) {
          const had = attrs[a.key];
          if (!had || (had.updated_at_ms ?? 0) < Number(a.updated_at_ms)) attrs[a.key] = { value: a.value, updated_at_ms: Number(a.updated_at_ms) };
        }
        e.subscriber_attributes = attrs;
        return e;
      };
      const expected = async (i: IntRow, ev: EvRow) => {
        const settings = { ...i.settings };
        const ec = await eventCtx(ev);
        if (i.kind === "bigquery") { settings.project_id ??= sa.project_id; ec.accessToken = TOKEN; }
        const plan = await core.buildIntegration(i.kind as core.IntegrationKind, { event: await withAttrs(ev), settings, secrets: secretsOf.get(i.id)!, eventNames: i.event_names, context: ec, now: new Date() });
        return { plan, settings };
      };
      const scrubbed = (s: string, words: string[]) => { let o = s; for (const v of words) if (v && v.length >= 4) o = o.split(v).join("[redacted]"); return o; };
      const diff = (cap: Captured, r: core.OutRequest) => {
        const u = new URL(r.url);
        const p: string[] = [];
        if (cap.method !== r.method) p.push(`method ${cap.method} != ${r.method}`);
        if (cap.host !== u.hostname) p.push(`host ${cap.host} != ${u.hostname}`);
        if (cap.path !== u.pathname) p.push(`path ${cap.path} != ${u.pathname}`);
        if (cap.query !== u.search) p.push(`query ${cap.query} != ${u.search}`);
        for (const [k, v] of Object.entries(r.headers)) if (cap.headers[k.toLowerCase()] !== v) p.push(`header ${k}: ${JSON.stringify(cap.headers[k.toLowerCase()])} != ${JSON.stringify(v)}`);
        if (r.method !== "GET" && r.method !== "HEAD" && cap.body !== r.body) p.push(`body differs:\n got  ${cap.body.slice(0, 400)}\n want ${r.body.slice(0, 400)}`);
        return p;
      };
      const parse = (r: Captured): Parsed => ({ ...r, json: tryJson(r.body), form: new URLSearchParams(r.body), q: new URLSearchParams(r.query), status: statusOf.get(r) ?? 0 });
      const deliveriesOf = async (id: string) => (await dev.v2("GET", `/integrations/partners/${id}/deliveries?limit=100`)).items as any[];
      const settle = async (ids: string[], timeoutMs = 120_000) => until(async () => {
        const [r] = await sql`SELECT count(*)::int AS n FROM integration_deliveries WHERE event_id = ANY(${ids}) AND status = 'pending'`;
        return r!.n === 0;
      }, { timeoutMs, everyMs: 500 });
      // Purchase events of one customer (TEST events from the Send test button excluded); test events by id.
      const purchaseEvents = async (appUserId: string) =>
        sql<EvRow[]>`SELECT e.id, e.type, e.environment, e.app_id, e.customer_id, e.payload FROM events e JOIN customer_aliases al ON al.customer_id = e.customer_id
          WHERE e.project_id = ${dev.projectId} AND al.app_user_id = ${appUserId} AND e.type <> 'TEST' ORDER BY e.event_timestamp_ms`;
      const eventsById = async (eventIds: string[]) => sql<EvRow[]>`SELECT id, type, environment, app_id, customer_id, payload FROM events WHERE id = ANY(${eventIds}) ORDER BY created_at`;
      let bigQueryFirst = true;

      type Hand = (reqs: Parsed[], e: Record<string, any>) => Array<[string, unknown, unknown?]>;
      /** Verifies one event's delivery to every integration that got it. Returns the captured requests per integration. */
      const verifyEvent = async (phase: string, ev: EvRow, capFrom: number, outFrom: number, hand: Record<string, Hand> = {}, only?: string[]) => {
        const rows = await sql<{ integration_id: string }[]>`SELECT integration_id FROM integration_deliveries WHERE event_id = ${ev.id}`;
        const capAll = ctx.capture.requests.slice(capFrom), outAll = ctx.server.outbound().slice(outFrom);
        for (const { integration_id: id } of rows) {
          const cfg = byId.get(id);
          if (!cfg || (only && !only.includes(cfg.key))) continue;
          const i = await intRow(id);
          const { plan, settings } = await expected(i, ev);
          const d = (await deliveriesOf(id)).find((x) => x.event_id === ev.id);
          const L = `${phase} ${cfg.key}`;
          const mine = capAll.filter((r) => cfg.hosts.includes(r.host));
          if ("skip" in plan) {
            c.check(`${L}: skipped with the builder's reason "${plan.skip}"`, d?.status === "skipped" && d.last_error === plan.skip && d.attempts === 0, d);
            c.check(`${L}: nothing sent`, mine.length === 0, mine.map((r) => `${r.method} ${r.host}${r.path}`));
            note(cfg.key, { phase, status: "skipped", detail: plan.skip });
            continue;
          }
          const secrets = Object.values(secretsOf.get(id)!);
          const redact = [...plan.redact, ...secrets, ...(cfg.kind === "bigquery" ? [TOKEN] : [])];
          let lastStatus = 0;
          if (cfg.realStream) {
            const sb = ev.environment === "sandbox";
            const lines = outAll.filter((o: any) => o.host === GA && o.routed === "real-debug" && o.stream === cfg.realStream!(sb)) as any[];
            c.check(`${L}: ${plan.requests.length} request(s) went to Google's Measurement Protocol validation server`, lines.length === plan.requests.length, lines.map((o) => ({ status: o.status, stream: o.stream })));
            for (const [k, r] of plan.requests.entries()) {
              const o = lines[k];
              c.check(`${L}: the body Google validated is exactly the builder's`, o?.body === r.body, { got: o?.body, want: r.body });
              const msgs = o?.validation?.validationMessages;
              c.check(`${L}: Google's validation server answered 200 with no validation messages`, o?.status === 200 && Array.isArray(msgs) && msgs.length === 0, o?.validation);
              gaValidations.push({ phase, partner: cfg.key, stream: o?.stream, status: o?.status, validation: o?.validation, event: JSON.parse(r.body).events?.[0]?.name });
            }
            lastStatus = lines.length && lines.at(-1).status === 200 ? 204 : lines.at(-1)?.status;
            note(cfg.key, { phase, status: lines.length && lines.every((o) => o.status === 200 && o.validation?.validationMessages?.length === 0) ? "delivered (Google validation passed)" : "Google validation FAILED", detail: plan.name });
          } else {
            const want: core.OutRequest[] = [...plan.requests];
            if (cfg.kind === "bigquery" && bigQueryFirst) {
              // The table does not exist yet: insert answers 404, RevenueDot creates it with its schema and inserts again.
              want.splice(1, 0, core.bigQueryCreateTable(settings, TOKEN), plan.requests[0]!);
              bigQueryFirst = false;
            }
            c.check(`${L}: exactly ${want.length} request(s) reached ${cfg.hosts.join(", ")}`, mine.length === want.length, mine.map((r) => `${r.method} ${r.host}${r.path}${r.query}`));
            want.forEach((r, k) => {
              const p = mine[k] ? diff(mine[k]!, r) : ["missing"];
              c.check(`${L}: request ${k + 1} ${r.method} ${new URL(r.url).hostname}${new URL(r.url).pathname} is exactly the builder's (method, URL, headers, body)`, p.length === 0, p);
            });
            lastStatus = mine.length ? statusOf.get(mine.at(-1)!) ?? 0 : 0;
            if (hand[cfg.key]) for (const [n, ok, detail] of hand[cfg.key]!(mine.map(parse), ev.payload.event)) c.check(`${L}: ${n}`, ok, detail ?? mine.map((r) => r.body.slice(0, 600)));
            note(cfg.key, { phase, status: mine.length === want.length ? "delivered" : "MISMATCH", detail: `${plan.name}: ${want.map((r) => `${r.method} ${new URL(r.url).host}${new URL(r.url).pathname}`).join(" + ")}` });
          }
          c.check(`${L}: delivery log says delivered as "${plan.name}" with the partner's HTTP ${lastStatus}`, d?.status === "delivered" && d.response_status === lastStatus && d.sent_as === plan.name && d.attempts === 1 && d.last_error === null, d);
          c.eq(`${L}: the log keeps each request line with secrets redacted`, d?.request, plan.requests.map((r) => `${r.method} ${scrubbed(r.url, redact)}`).join("\n"));
          c.eq(`${L}: the log keeps the bodies with secrets redacted`, d?.request_body, plan.requests.map((r) => scrubbed(r.body, redact)).join("\n").slice(0, 4000));
          const leak = secrets.filter((v) => JSON.stringify(d).includes(v));
          c.check(`${L}: no credential in the delivery log`, leak.length === 0, { leaked: leak.length });
        }
        return rows.length;
      };
      const integrationRow = async (key: string, delivered: boolean) => {
        const id = idOf.get(key)!;
        const row = await intRow(id);
        const secrets = Object.values(secretsOf.get(id)!);
        const text = JSON.stringify(row);
        c.check(`${key}: integrations row has the secrets sealed (no plaintext credential in the row)`, secrets.every((v) => !text.includes(v)) && (secrets.length === 0 || (typeof row.secrets === "string" && row.secrets.length > 20)), { hints: row.secret_hints });
        c.check(`${key}: integrations row ${delivered ? "records the last delivery, no failures" : "has no delivery yet, no failures"}`, row.consecutive_failures === 0 && row.last_error === null && (delivered ? row.last_delivered_at instanceof Date : row.last_delivered_at === null), { last: row.last_delivered_at, failures: row.consecutive_failures, error: row.last_error });
      };

      // ---------- A. Test Store purchase from the iOS SDK (sandbox) ----------
      c.begin("A. Test Store purchase (sandbox) with the partners' attribution ids");
      const buyer = `buyer_${S}`;
      const ids = {
        $email: `buyer-${S}@journeys.test`, $appsflyerId: "1727000000000-1234567", $adjustId: `adj${rnd(13)}`, $idfa: randomUUID().toUpperCase(), $idfv: randomUUID().toUpperCase(),
        $attConsentStatus: "authorized", $fbAnonId: `XZ${rnd(14).toUpperCase()}`, $firebaseAppInstanceId: rnd(32), $mparticleId: "8675309123456789012".slice(0, 18),
        $amplitudeDeviceId: `amp-${rnd(10)}`, $mixpanelDistinctId: `mp-${rnd(10)}`, $posthogUserId: `ph-${rnd(10)}`, $brazeAliasName: `alias-${rnd(8)}`, $brazeAliasLabel: "revenuedot_journey",
        $clevertapId: `__${rnd(30)}`, $onesignalUserId: randomUUID(), $airshipChannelId: randomUUID(), $iterableUserId: `it-${rnd(8)}`, $customerioId: `cio-${rnd(8)}`,
        $tenjinId: randomUUID(), $kochavaDeviceId: `KA${rnd(20)}`, $branchId: `branch-${rnd(8)}`, $singularDeviceId: randomUUID(), $airbridgeDeviceId: randomUUID(),
        $telemetryDeckUserId: sha(`journey-${S}`), $appstackId: `appstack-${rnd(8)}`, $solarEngineDistinctId: `se-${rnd(10)}`,
        $appleAdsCampaignId: "1234567890", $appleAdsAdGroupId: "2234567890", $appleAdsKeywordId: "3234567890", $claimType: "Click",
      };
      const sdk = sdkClient(ctx, cat.testKey);
      const iosHeaders = { "x-platform-version": "Version 17.5 (Build 21F79)", "x-client-version": "2.3.0" };
      const seen = await sdk.call("GET", `/v1/subscribers/${buyer}`, undefined, iosHeaders);
      const setAttrs = await sdk.attributes(buyer, ids);
      c.check("the app sets the partner ids as customer attributes (POST /v1/subscribers/{id}/attributes)", (seen.status === 200 || seen.status === 201) && setAttrs.status === 200, { seen: seen.status, attrs: setAttrs.status, body: setAttrs.body });
      const stored = Object.fromEntries((await sql`SELECT a.key, a.value FROM customer_attributes a JOIN customer_aliases al ON al.customer_id = a.customer_id WHERE al.project_id = ${dev.projectId} AND al.app_user_id = ${buyer}`).map((r: any) => [r.key, r.value]));
      const notStored = Object.entries(ids).filter(([k, v]) => stored[k] !== v).map(([k]) => k);
      c.check("every attribute is stored on the customer", notStored.length === 0, { notStored, stored });
      let capFrom = ctx.capture.requests.length, outFrom = ctx.server.outbound().length;
      const purchase = await sdk.call("POST", "/v1/receipts", { app_user_id: buyer, fetch_token: `test_${Date.now()}_${randomUUID()}`, product_id: "pro_monthly", price: 9.99, currency: "USD", is_restore: false, presented_offering_identifier: "default" }, iosHeaders);
      c.must("Test Store purchase answers 200 with pro active", purchase.status === 200 && purchase.body.subscriber?.entitlements?.pro?.product_identifier === "pro_monthly", purchase.body);
      const evA = (await until(async () => { const e = await purchaseEvents(buyer); return e.length ? e : null; }))!;
      c.must("the purchase recorded one INITIAL_PURCHASE event (sandbox, TEST_STORE, $9.99)", evA?.length === 1 && evA[0]!.payload.event.type === "INITIAL_PURCHASE" && evA[0]!.payload.event.environment === "SANDBOX" && evA[0]!.payload.event.store === "TEST_STORE" && evA[0]!.payload.event.price === 9.99, evA?.map((e: EvRow) => e.payload.event));
      const queuedA = await sql`SELECT i.kind, i.name FROM integration_deliveries d JOIN integrations i ON i.id = d.integration_id WHERE d.event_id = ${evA[0]!.id}`;
      const eventPartners = CFGS.filter((x) => !x.connection);
      c.eq("the event was queued to every event partner (sandbox included) and to no connection", queuedA.length, eventPartners.length);
      c.check("all deliveries finished", await settle([evA[0]!.id]), null);
      await sleep(300);
      const eA = evA[0]!.payload.event;
      const userOf = (e: Record<string, any>) => e.app_user_id;
      const sb = (k: string) => CFGS.find((x) => x.key === k)!.settings as Record<string, any>;
      const handA: Record<string, Hand> = {
        slack: ([m]) => [["text names the customer, product and $9.99", m!.json.text === `Customer ${buyer} started a subscription: pro_monthly ($9.99).`], ["labelled Sandbox", m!.json.attachments[0].fields.some((f: any) => f.title === "Environment" && f.value === "Sandbox")]],
        segment: ([t, idn]) => [["track then identify, Basic auth with the write key", t!.path === "/v1/track" && idn!.path === "/v1/identify" && t!.headers.authorization === `Basic ${btoa(`${sb("segment").write_key}:`)}`],
          ["rc_initial_purchase_event for the buyer, $9.99 USD, deduplicated by the event id", t!.json.event === "rc_initial_purchase_event" && t!.json.userId === buyer && t!.json.properties.revenue === 9.99 && t!.json.properties.currency === "USD" && t!.json.properties.product_id === "pro_monthly" && t!.json.messageId === eA.id && t!.json.context.environment === "sandbox"],
          ["identify sets rc_subscription_status active", idn!.json.traits.rc_subscription_status === "active"]],
        amplitude: ([m]) => [["sandbox key, $amplitudeDeviceId as device_id", m!.json.api_key === sb("amplitude").sandbox_api_key && m!.json.events[0].device_id === ids.$amplitudeDeviceId],
          ["rc_initial_purchase_event with revenue 9.99 and the product", m!.json.events[0].event_type === "rc_initial_purchase_event" && m!.json.events[0].revenue === 9.99 && m!.json.events[0].productId === "pro_monthly" && m!.json.events[0].insert_id === eA.id]],
        mixpanel: ([t, en]) => [["/track with the sandbox token and $mixpanelDistinctId", t!.path === "/track" && t!.json[0].properties.token === sb("mixpanel").sandbox_project_token && t!.json[0].properties.distinct_id === ids.$mixpanelDistinctId],
          ["rc_initial_purchase_event, revenue 9.99, product", t!.json[0].event === "rc_initial_purchase_event" && t!.json[0].properties.revenue === 9.99 && t!.json[0].properties.product_id === "pro_monthly"],
          ["/engage sets the status and appends a $9.99 transaction", en!.path === "/engage" && en!.json[0].$set.rc_subscription_status === "active" && en!.json[1].$append.$transactions.$amount === 9.99]],
        posthog: ([m]) => [["sandbox key, $posthogUserId as distinct_id, event uuid", m!.json.api_key === sb("posthog").sandbox_api_key && m!.json.distinct_id === ids.$posthogUserId && m!.json.uuid === eA.id.toLowerCase()],
          ["rc_initial_purchase_event, revenue 9.99, product", m!.json.event === "rc_initial_purchase_event" && m!.json.properties.revenue === 9.99 && m!.json.properties.product_id === "pro_monthly"]],
        bigquery: (reqs) => { const ins = reqs.at(-1)!; const row = ins.json.rows[0]; return [["Bearer token from the service account", ins.headers.authorization === `Bearer ${TOKEN}`],
          ["table created with RevenueDot's schema after the 404", reqs[1]?.path === `/bigquery/v2/projects/rd-journey-project/datasets/revenuedot_journey/tables` && reqs[1]!.json.schema.fields.length === core.BIGQUERY_SCHEMA.length],
          ["one row: insertId = event id, INITIAL_PURCHASE, buyer, pro_monthly, $9.99, SANDBOX", row.insertId === eA.id && row.json.type === "INITIAL_PURCHASE" && row.json.app_user_id === buyer && row.json.product_id === "pro_monthly" && row.json.revenue_usd === 9.99 && row.json.environment === "SANDBOX"]]; },
        appsflyer: ([m]) => [["iOS app id, sandbox dev key in the authentication header", m!.path === "/inappevent/id1234567890" && m!.headers.authentication === sb("appsflyer").sandbox_dev_key],
          ["$appsflyerId, customer_user_id, rc_initial_purchase_event, af_revenue 9.99 USD, idfa", m!.json.appsflyer_id === ids.$appsflyerId && m!.json.customer_user_id === buyer && m!.json.eventName === "rc_initial_purchase_event" && JSON.parse(m!.json.eventValue).af_revenue === "9.99" && JSON.parse(m!.json.eventValue).af_content_id === "pro_monthly" && m!.json.eventCurrency === "USD" && m!.json.idfa === ids.$idfa]],
        adjust: ([m]) => [["iOS app token, the initial purchase token, $adjustId, sandbox", m!.form.get("app_token") === "abc123iosapp" && m!.form.get("event_token") === "ip1234" && m!.form.get("adid") === ids.$adjustId && m!.form.get("environment") === "sandbox"],
          ["revenue 9.99 USD, idfa, Bearer S2S token", m!.form.get("revenue") === "9.99" && m!.form.get("currency") === "USD" && m!.form.get("idfa") === ids.$idfa && m!.headers.authorization === `Bearer ${sb("adjust").oauth_token}`]],
        meta: ([m]) => { const d0 = m!.json.data[0]; return [["sandbox dataset and token, test event code", m!.path === "/v21.0/555666777888999/events" && m!.json.access_token === sb("meta").sandbox_access_token && m!.json.test_event_code === "TEST12345"],
          ["Subscribe, $9.99 USD, pro_monthly, app action source", d0.event_name === "Subscribe" && d0.custom_data.value === 9.99 && d0.custom_data.currency === "USD" && d0.custom_data.content_ids[0] === "pro_monthly" && d0.action_source === "app"],
          ["external_id and email SHA-256, madid = idfa, anon_id", d0.user_data.external_id[0] === sha(buyer) && d0.user_data.em[0] === sha(ids.$email) && d0.user_data.madid === ids.$idfa && d0.user_data.anon_id === ids.$fbAnonId]]; },
        mparticle: ([m]) => [["Basic key:secret, development environment", m!.headers.authorization === `Basic ${btoa(`${sb("mparticle").api_key}:${sb("mparticle").api_secret}`)}` && m!.json.environment === "development"],
          ["mpid as a JSON number, customer_id and email identities", m!.body.includes(`"mpid":${ids.$mparticleId}`) && m!.json.user_identities.customer_id === buyer && m!.json.user_identities.email === ids.$email],
          ["commerce purchase of $9.99 for pro_monthly", m!.json.events[0].event_type === "commerce_event" && m!.json.events[0].data.product_action.action === "purchase" && m!.json.events[0].data.product_action.total_amount === 9.99 && m!.json.events[0].data.product_action.products[0].id === "pro_monthly"]],
        statsig: ([m]) => [["statsig-api-key header", m!.headers["statsig-api-key"] === sb("statsig").server_secret],
          ["rc_initial_purchase_event for the buyer, value 9.99, development tier", m!.json.events[0].eventName === "rc_initial_purchase_event" && m!.json.events[0].user.userID === buyer && m!.json.events[0].value === 9.99 && m!.json.events[0].user.statsigEnvironment.tier === "development" && m!.json.events[0].metadata.product_id === "pro_monthly"]],
        superwall: ([m]) => [["RevenueCat's webhook body with the Authorization value", m!.headers.authorization === sb("superwall").authorization && m!.json.api_version === "1.0" && m!.json.event.id === eA.id && m!.json.event.app_user_id === buyer && m!.json.event.product_id === "pro_monthly" && m!.json.event.price === 9.99]],
        appstack: ([m]) => [["RevenueCat's webhook body with the Authorization header, $appstackId inside", m!.headers.authorization === sb("appstack").authorization && m!.json.event.type === "INITIAL_PURCHASE" && m!.json.event.subscriber_attributes.$appstackId.value === ids.$appstackId]],
        splitmetrics: ([m]) => [["RevenueCat's webhook body, Apple Ads attribution inside", m!.json.event.id === eA.id && m!.json.event.subscriber_attributes.$appleAdsCampaignId.value === "1234567890"]],
        solarengine: ([m]) => [["RevenueCat's webhook body, $solarEngineDistinctId inside", m!.json.event.id === eA.id && m!.json.event.subscriber_attributes.$solarEngineDistinctId.value === ids.$solarEngineDistinctId]],
        telemetrydeck: ([m]) => [["signal for $telemetryDeckUserId, test mode, floatValue 9.99", m!.json[0].clientUser === ids.$telemetryDeckUserId && m!.json[0].isTestMode === true && m!.json[0].floatValue === 9.99 && m!.json[0].type === "rc_initial_purchase_event" && m!.json[0].payload["RevenueCat.event.product_id"] === "pro_monthly"]],
        branch: ([m]) => [["SUBSCRIBE to /v2/event/standard with the test key", m!.path === "/v2/event/standard" && m!.json.name === "SUBSCRIBE" && m!.json.branch_key === sb("branch").sandbox_branch_key],
          ["idfa, idfv, $branchId as developer_identity, revenue 9.99 USD", m!.json.user_data.idfa === ids.$idfa && m!.json.user_data.idfv === ids.$idfv && m!.json.user_data.developer_identity === ids.$branchId && m!.json.event_data.revenue === 9.99 && m!.json.event_data.currency === "USD"]],
        google_tag_manager: ([m]) => [["sandbox measurement id and API secret in the query", m!.q.get("measurement_id") === "G-JOURNEYSB" && m!.q.get("api_secret") === sb("google_tag_manager").sandbox_api_secret],
          ["purchase for client_id = user_id = buyer, value 9.99 USD", m!.json.client_id === buyer && m!.json.user_id === buyer && m!.json.events[0].name === "purchase" && m!.json.events[0].params.value === 9.99 && m!.json.events[0].params.currency === "USD" && m!.json.events[0].params.items[0].item_id === "pro_monthly"]],
        kochava: ([m]) => [["sandbox iOS app GUID, $kochavaDeviceId, idfa and idfv", m!.json.kochava_app_id === "korevenuedot-journey-ios-test" && m!.json.kochava_device_id === ids.$kochavaDeviceId && m!.json.data.device_ids.idfa === ids.$idfa && m!.json.data.device_ids.idfv === ids.$idfv],
          ["Subscribe, sum 9.99 USD", m!.json.data.event_name === "Subscribe" && m!.json.data.event_data.sum === 9.99 && m!.json.data.currency === "USD"]],
        airship: ([ce, at]) => [["sandbox app key and Bearer token", ce!.headers["x-ua-appkey"] === "rdJourneySbxKey01" && ce!.headers.authorization === `Bearer ${sb("airship").sandbox_token}`],
          ["custom event on the iOS channel, value 9.99", ce!.json[0].user.ios_channel === ids.$airshipChannelId && ce!.json[0].body.name === "rc_initial_purchase_event" && ce!.json[0].body.value === 9.99 && ce!.json[0].body.transaction === eA.id],
          ["rc_subscription_status attribute set on the channel", at!.path === "/api/channels/attributes" && at!.json.attributes[0].value === "active"]],
        braze: ([m]) => [["Bearer sandbox key", m!.headers.authorization === `Bearer ${sb("braze").sandbox_api_key}`],
          ["custom event and ecommerce.order_placed $9.99 on the user alias", m!.json.events[0].user_alias.alias_name === ids.$brazeAliasName && m!.json.events[0].name === "rc_initial_purchase_event" && m!.json.events[1].name === "ecommerce.order_placed" && m!.json.events[1].properties.total_value === 9.99],
          ["rc_subscription_status active", m!.json.attributes[0].rc_subscription_status === "active"]],
        clevertap: ([m]) => [["sandbox account and passcode headers", m!.headers["x-clevertap-account-id"] === "RD-JOURNEY-SBX" && m!.headers["x-clevertap-passcode"] === sb("clevertap").sandbox_passcode],
          ["event and profile on $clevertapId, revenue 9.99", m!.json.d[0].objectId === ids.$clevertapId && m!.json.d[0].evtName === "rc_initial_purchase_event" && m!.json.d[0].evtData.revenue === 9.99 && m!.json.d[1].profileData.rc_subscription_status === "active"]],
        customerio: ([idn, ev]) => [["identify then event on $customerioId, Basic sandbox site:key", idn!.method === "PUT" && idn!.path === `/api/v1/customers/${ids.$customerioId}` && ev!.path === `/api/v1/customers/${ids.$customerioId}/events` && idn!.headers.authorization === `Basic ${btoa(`rdjourneysbx:${sb("customerio").sandbox_api_key}`)}`],
          ["email set, rc_initial_purchase_event with revenue 9.99 on iOS", idn!.json.email === ids.$email && ev!.json.name === "rc_initial_purchase_event" && ev!.json.data.revenue === 9.99 && ev!.json.data.platform === "ios"]],
        discord: ([m]) => [["embed names the buyer, $9.99 and Sandbox; no mentions", m!.json.embeds[0].description.includes("started a subscription") && m!.json.embeds[0].fields.some((f: any) => f.name === "Revenue" && f.value === "$9.99") && m!.json.embeds[0].fields.some((f: any) => f.value === "Sandbox") && m!.json.allowed_mentions.parse.length === 0]],
        intercom: ([m]) => [["Bearer token and Intercom-Version 2.11", m!.headers.authorization === `Bearer ${sb("intercom").access_token}` && m!.headers["intercom-version"] === "2.11"],
          ["data event for user_id = buyer, price 999 cents usd", m!.json.event_name === "rc_initial_purchase_event" && m!.json.user_id === buyer && m!.json.metadata.price.amount === 999 && m!.json.metadata.price.currency === "usd" && m!.json.metadata.product_identifier === "pro_monthly"]],
        iterable: ([p, u]) => [["Api-Key sandbox key", p!.headers["api-key"] === sb("iterable").sandbox_api_key],
          ["trackPurchase of $9.99 by email, then users/update with the status", p!.path === "/api/commerce/trackPurchase" && p!.json.user.email === ids.$email && p!.json.total === 9.99 && p!.json.items[0].id === "pro_monthly" && u!.path === "/api/users/update" && u!.json.dataFields.rc_subscription_status === "active"]],
        onesignal: ([m]) => [["PATCH the OneSignal user by onesignal_id with the Key header", m!.method === "PATCH" && m!.path === `/apps/${sb("onesignal").app_id}/users/by/onesignal_id/${ids.$onesignalUserId}` && m!.headers.authorization === `Key ${sb("onesignal").api_key}`],
          ["tags: product, active status, SANDBOX", m!.json.properties.tags.product_id === "pro_monthly" && m!.json.properties.tags.subscription_status === "active" && m!.json.properties.tags.environment === "SANDBOX" && m!.json.properties.tags.app_user_id === buyer]],
      };
      await verifyEvent("A", evA[0]!, capFrom, outFrom, handA);
      // The service account signed in to Google: one token request, an RS256 assertion for the BigQuery scope.
      const tok = ctx.capture.of("oauth2.googleapis.com", "/token").slice(-1)[0];
      const form = new URLSearchParams(tok?.body ?? "");
      const [h64, p64, s64] = (form.get("assertion") ?? "..").split(".");
      const claims = tryJson(Buffer.from(p64 ?? "", "base64url").toString());
      const sigOk = !!tok && verifySig("RSA-SHA256", Buffer.from(`${h64}.${p64}`), saPub, Buffer.from(s64 ?? "", "base64url"));
      c.check("BigQuery: the service account's JWT (RS256, signed with its private key) went to Google's token endpoint", form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && sigOk && claims?.iss === sa.client_email && claims?.scope === core.BIGQUERY_SCOPE && claims?.aud === "https://oauth2.googleapis.com/token", { claims, sigOk });
      for (const cfg of CFGS) await integrationRow(cfg.key, !cfg.connection && outcomes[cfg.key]?.some((o) => o.phase === "A" && o.status.startsWith("delivered")) === true);

      // ---------- B. Amazon purchase (production) ----------
      c.begin("B. Amazon Appstore purchase (production; RVS answered locally)");
      const buyerB = `amazon_${S}`;
      const sdkB = sdkClient(ctx, amazonKey, "android");
      const androidHeaders = { "x-platform-version": "14", "x-client-version": "2.3.0", "x-is-sandbox": "false" };
      await sdkB.call("GET", `/v1/subscribers/${buyerB}`, undefined, androidHeaders);
      const idsB = { ...ids, $email: `amazon-${S}@journeys.test`, $gpsAdId: randomUUID(), $idfa: null, $idfv: null, $airshipChannelId: randomUUID(), $onesignalUserId: randomUUID() } as Record<string, string | null>;
      await sdkB.call("POST", `/v1/subscribers/${buyerB}/attributes`, { attributes: Object.fromEntries(Object.entries(idsB).map(([k, v]) => [k, { value: v, updated_at_ms: Date.now() }])) }, androidHeaders);
      const receiptId = `amzn-receipt-${rnd(16)}`;
      amazonReceipts.set(receiptId, { receiptId, productId: "journey.pro", productType: "SUBSCRIPTION", termSku: "journey.pro.monthly", term: "1 Month", purchaseDate: Date.now() - 5000, renewalDate: Date.now() + 30 * 86400_000, cancelDate: null, autoRenewing: true, testTransaction: false, betaProduct: false, countryCode: "US", quantity: 1 });
      capFrom = ctx.capture.requests.length; outFrom = ctx.server.outbound().length;
      const amz = await sdkB.call("POST", "/v1/receipts", { app_user_id: buyerB, fetch_token: receiptId, product_id: "journey.pro.monthly", store_user_id: `amzn1.account.${rnd(20).toUpperCase()}`, price: 4.99, currency: "USD", is_restore: false }, androidHeaders);
      c.must("Amazon purchase answers 200 with pro active", amz.status === 200 && amz.body.subscriber?.entitlements?.pro, amz.body);
      const rvs = ctx.capture.of("appstore-sdk.amazon.com").slice(-1)[0];
      c.check("RevenueDot verified the receipt with Amazon's production RVS path", rvs?.path.startsWith("/version/1.0/verifyReceiptId/developer/") && rvs.path.endsWith(`/receiptId/${receiptId}`), rvs?.path);
      const evB = (await until(async () => { const e = await purchaseEvents(buyerB); return e.length ? e : null; }))!;
      c.must("one production INITIAL_PURCHASE from the AMAZON store", evB?.length === 1 && evB[0]!.payload.event.environment === "PRODUCTION" && evB[0]!.payload.event.store === "AMAZON", evB?.map((e: EvRow) => e.payload.event));
      c.check("all deliveries finished", await settle([evB[0]!.id]), null);
      await sleep(300);
      const eB = evB[0]!.payload.event;
      const handB: Record<string, Hand> = {
        asapty: ([m]) => [["GET mmpEvents with the Asapty id, initial_purchase_event, campaign and keyword ids", m!.method === "GET" && m!.path === "/_api/mmpEvents/" && m!.q.get("asaptyid") === sb("asapty").asapty_id && m!.q.get("event_name") === "initial_purchase_event" && m!.q.get("campaignid") === "1234567890" && m!.q.get("keywordid") === "3234567890"],
          ["json: revenue 4.99 USD, PRODUCTION, the product", JSON.parse(m!.q.get("json")!).revenue === eB.price.toFixed(2) && JSON.parse(m!.q.get("json")!).environment === "PRODUCTION" && JSON.parse(m!.q.get("json")!).vendor_product_id === "journey.pro.monthly"]],
        tenjin: ([m]) => [["/v0/purchase with Basic Android SDK key (Amazon)", m!.path === "/v0/purchase" && m!.headers.authorization === `Basic ${btoa(`${sb("tenjin").android_sdk_key}:`)}`],
          ["amazon platform, package name, $tenjinId, price in USD", m!.form.get("platform") === "amazon" && m!.form.get("bundle_id") === "com.revenuedot.journey.amazon" && m!.form.get("analytics_installation_id") === ids.$tenjinId && m!.form.get("price") === String(eB.price) && m!.form.get("currency") === "USD" && m!.form.get("advertising_id") === idsB.$gpsAdId]],
        singular: ([m]) => [["v2 form: production SDK key, sdid, Android, package, amount", m!.form.get("a") === sb("singular").sdk_key && m!.form.get("sdid") === ids.$singularDeviceId && m!.form.get("p") === "Android" && m!.form.get("i") === "com.revenuedot.journey.amazon" && m!.form.get("amt") === String(eB.price) && m!.form.get("n") === "rc_initial_purchase_event"]],
        amplitude: ([m]) => [["production key this time", m!.json.api_key === sb("amplitude").api_key]],
        meta: ([m]) => [["production dataset this time", m!.path === "/v21.0/111222333444555/events" && m!.json.access_token === sb("meta").access_token]],
      };
      await verifyEvent("B", evB[0]!, capFrom, outFrom, handB);

      // ---------- C. "Send test event" for every partner, through the App Store app (production) ----------
      c.begin("C. Send test event (App Store app, production) to every partner");
      capFrom = ctx.capture.requests.length; outFrom = ctx.server.outbound().length;
      const tests = new Map<string, string>();
      for (const cfg of eventPartners) {
        const r = await dev.v2r("POST", `/integrations/partners/${idOf.get(cfg.key)}/test`, { app_user_id: buyer, environment: "production" });
        c.check(`${cfg.key}: test event queued (201)`, r.status === 201 && r.body.event_type === "TEST", r);
        if (r.status === 201) tests.set(cfg.key, r.body.event_id);
      }
      c.check("all test deliveries finished", await settle([...tests.values()]), null);
      await sleep(300);
      const evC = await eventsById([...tests.values()]);
      c.eq("one TEST event per partner", evC.length, eventPartners.length);
      for (const ev of evC) {
        c.check(`test event ${ev.id.slice(0, 8)} is an App Store TEST event in production`, ev.payload.event.store === "APP_STORE" && ev.environment === "production" && ev.app_id === iosApp.id, ev.payload.event);
        await verifyEvent("C", ev, capFrom, outFrom, {
          airbridge: ([m]) => [["Bearer token, app name, bundle id, $airbridgeDeviceId with the OS version", m!.path === "/events/v2/apps/rdjourney/mobile-app/9360" && m!.headers.authorization === `Bearer ${sb("airbridge").api_token}` && m!.json.app.packageName === "com.revenuedot.journey" && m!.json.device.deviceUUID === ids.$airbridgeDeviceId && m!.json.device.osVersion === iosHeaders["x-platform-version"] && m!.json.user.externalUserID === buyer]],
          tenjin: ([m]) => [["/v0/event rc_test_event with the iOS SDK key and $tenjinId", m!.path === "/v0/event" && m!.form.get("event") === "rc_test_event" && m!.headers.authorization === `Basic ${btoa(`${sb("tenjin").ios_sdk_key}:`)}` && m!.form.get("analytics_installation_id") === ids.$tenjinId]],
        });
      }

      // ---------- D. partner errors: retry schedule, manual retry, replay ----------
      c.begin("D. partner errors, retry and replay");
      // Amplitude answers 500: a temporary error, retried on the webhook schedule (5 minutes first).
      fails.set("api2.amplitude.com", { status: 500, left: 1 });
      const ampId = idOf.get("amplitude")!;
      const t500 = await dev.v2("POST", `/integrations/partners/${ampId}/test`, { app_user_id: buyer });
      const d500 = await until(async () => (await deliveriesOf(ampId)).find((x) => x.id === t500.id && x.last_error), { timeoutMs: 60_000 });
      c.check("Amplitude HTTP 500: the delivery waits for its next attempt in 5 minutes, with the error logged", d500?.status === "pending" && d500.response_status === 500 && /^HTTP 500/.test(d500.last_error) && Math.abs(d500.next_attempt_at - Date.now() - 5 * 60_000) < 60_000, d500);
      let ampRow = await intRow(ampId);
      c.check("integrations row counts the failure and keeps the error", ampRow.consecutive_failures === 1 && /^HTTP 500/.test(ampRow.last_error ?? ""), { failures: ampRow.consecutive_failures, error: ampRow.last_error });
      // Segment answers 400: a permanent error, failed at once.
      const segId = idOf.get("segment")!;
      fails.set("api.segment.io", { status: 400, left: 1 });
      capFrom = ctx.capture.requests.length;
      const t400 = await dev.v2("POST", `/integrations/partners/${segId}/test`, { app_user_id: buyer });
      const d400 = await until(async () => (await deliveriesOf(segId)).find((x) => x.id === t400.id && x.status !== "pending"), { timeoutMs: 60_000 });
      c.check("Segment HTTP 400: the delivery failed at once (not retried), with the answer logged", d400?.status === "failed" && d400.response_status === 400 && d400.attempts === 1 && /^HTTP 400/.test(d400.last_error) && d400.response_body?.includes("injected"), d400);
      c.eq("only the track call was sent (the identify call stops after the error)", ctx.capture.requests.slice(capFrom).filter((r) => r.host === "api.segment.io").map((r) => r.path), ["/v1/track"]);
      const failedList = await dev.v2("GET", `/integrations/partners/${segId}/deliveries?status=failed`);
      c.check("the delivery log filters failed deliveries", failedList.items.length === 1 && failedList.items[0].id === t400.id, failedList.items.map((x: any) => x.id));
      c.check("integrations row records the failure", (await intRow(segId)).consecutive_failures === 1);
      capFrom = ctx.capture.requests.length; outFrom = ctx.server.outbound().length;
      const retried = await dev.v2r("POST", `/integrations/partners/${segId}/deliveries/${t400.id}/retry`);
      c.check("POST .../deliveries/{id}/retry queues it again (200, pending, attempts reset)", retried.status === 200 && retried.body.status === "pending" && retried.body.attempts === 0, retried.body);
      const dRetry = await until(async () => (await deliveriesOf(segId)).find((x) => x.id === t400.id && x.status !== "pending"), { timeoutMs: 60_000 });
      c.check("the retried delivery is delivered with HTTP 200", dRetry?.status === "delivered" && dRetry.response_status === 200, dRetry);
      const evRetry = (await eventsById([t400.event_id]))[0]!;
      await verifyEvent("D-retry", evRetry, capFrom, outFrom, {}, ["segment"]);
      c.check("a delivery clears the failure count", (await intRow(segId)).consecutive_failures === 0);
      fails.set("api.segment.io", { status: 400, left: 1 });
      const t400b = await dev.v2("POST", `/integrations/partners/${segId}/test`, { app_user_id: buyer });
      await until(async () => (await deliveriesOf(segId)).find((x) => x.id === t400b.id && x.status === "failed"), { timeoutMs: 60_000 });
      capFrom = ctx.capture.requests.length; outFrom = ctx.server.outbound().length;
      const replay = await dev.v2r("POST", `/integrations/partners/${segId}/actions/replay`, { status: "failed" });
      c.check("POST .../actions/replay queues the one failed delivery", replay.status === 200 && replay.body.queued === 1 && replay.body.statuses[0] === "failed", replay.body);
      const dReplay = await until(async () => (await deliveriesOf(segId)).find((x) => x.id === t400b.id && x.status !== "pending"), { timeoutMs: 60_000 });
      c.check("the replayed delivery is delivered with HTTP 200", dReplay?.status === "delivered" && dReplay.response_status === 200, dReplay);
      const evReplay = (await eventsById([t400b.event_id]))[0]!;
      await verifyEvent("D-replay", evReplay, capFrom, outFrom, {}, ["segment"]);
      ampRow = await intRow(ampId);
      note("amplitude", { phase: "D", status: "HTTP 500 → pending, retry in 5 min", detail: d500?.last_error ?? "" });
      note("segment", { phase: "D", status: "HTTP 400 → failed; retry and replay delivered", detail: "" });

      // ---------- E. connections that send no events ----------
      c.begin("E. connections: Intercom inbox, Zendesk, AdMob, Apple Search Ads");
      for (const k of ["admob", "apple_search_ads", "intercom_inbox", "zendesk"]) {
        const d = await deliveriesOf(idOf.get(k)!);
        c.check(`${k}: a connection, never sent an event`, d.length === 0 && specs.get(k).connection === true, d.length);
      }
      const canvasBody = JSON.stringify({ workspace_id: "journey", contact: { external_id: buyer, email: ids.$email }, context: { location: "conversation" } });
      const canvasSig = createHmac("sha256", sb("intercom_inbox").client_secret).update(canvasBody).digest("hex");
      const canvas = await fetch(`${ctx.base}/v1/support/intercom/${dev.projectId}/canvas`, { method: "POST", headers: { "content-type": "application/json", "x-body-signature": canvasSig }, body: canvasBody });
      const cv = await canvas.json() as any;
      const rowsCv = Object.fromEntries((cv.canvas?.content?.components?.find((x: any) => x.type === "data-table")?.items ?? []).map((x: any) => [x.field, x.value]));
      c.check("Intercom inbox: a signed Canvas Kit request gets the buyer's summary (Active, pro, pro_monthly)", canvas.status === 200 && rowsCv.Status === "Active" && rowsCv.Entitlements === "pro" && rowsCv.Plan === "pro_monthly" && rowsCv["App user ID"] === buyer, cv);
      const badCanvas = await fetch(`${ctx.base}/v1/support/intercom/${dev.projectId}/canvas`, { method: "POST", headers: { "content-type": "application/json", "x-body-signature": "00".repeat(32) }, body: canvasBody });
      c.eq("Intercom inbox: a wrong signature is refused (401)", badCanvas.status, 401);
      const zk = await dev.v2("POST", "/api_keys", { name: "Zendesk sidebar" });
      const zs = await fetch(`${ctx.base}/v2/projects/${dev.projectId}/support_summaries?email=${encodeURIComponent(ids.$email)}`, { headers: { authorization: `Bearer ${zk.key}` } });
      const zb = await zs.json() as any;
      c.check("Zendesk: the sidebar's call with a secret key finds the buyer by email with pro active", zs.status === 200 && zb.items?.length === 1 && zb.items[0].app_user_id === buyer && zb.items[0].active_entitlements.includes("pro"), zb);
      note("intercom_inbox", { phase: "E", status: "signed canvas answered", detail: "Active, pro_monthly" });
      note("zendesk", { phase: "E", status: "support summary by email answered", detail: "" });
      note("admob", { phase: "E", status: "connection saved, no events by design", detail: "" });
      note("apple_search_ads", { phase: "E", status: "connection saved, no events by design", detail: "" });

      // ---------- no stray outbound calls ----------
      c.begin("outbound traffic");
      const known = new Set([...CFGS.flatMap((x) => x.hosts), "oauth2.googleapis.com", "appstore-sdk.amazon.com"]);
      const myCaptured = ctx.capture.requests.slice(capStart);
      c.check("every outbound request of this journey went to a configured partner host", myCaptured.every((r) => known.has(r.host)), [...new Set(myCaptured.map((r) => r.host))]);
      const myOut = ctx.server.outbound().slice(outStart) as any[];
      const bad = myOut.filter((o) => o.routed === "refused" || o.routed === "blocked");
      c.check("no outbound call was refused or blocked (no Apple or Google Play call)", bad.length === 0, bad);
      const gaLines = myOut.filter((o) => o.host === GA);
      c.check("every Google Analytics hit went to the validation server, none to the real collector", gaLines.length > 0 && gaLines.every((o: any) => o.routed === "real-debug"), gaLines.map((o: any) => o.routed));

      // ---------- F. data exports to MinIO ----------
      c.begin("F. scheduled data exports to S3 (MinIO)");
      const minioUser = "rdjourney", minioPass = `rdjourney-${rnd(16)}`;
      const s3 = `http://127.0.0.1:${PORTS.minio}`;
      // Docker Hub no longer serves minio/minio (the repository is gone); Chainguard publishes the same MinIO server.
      // The data lives on a tmpfs, so removing the container leaves nothing on disk.
      const image = process.env.JOURNEY_MINIO_IMAGE ?? "cgr.dev/chainguard/minio:latest";
      execFileSync("docker", ["run", "-d", "--name", minio, "-p", `127.0.0.1:${PORTS.minio}:9000`, "-p", `127.0.0.1:${PORTS.minioConsole}:9001`, "--tmpfs", "/data:rw,uid=65532,gid=65532,size=256m",
        "-e", `MINIO_ROOT_USER=${minioUser}`, "-e", `MINIO_ROOT_PASSWORD=${minioPass}`, image, "server", "/data", "--console-address", ":9001"], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
      minioStarted = true;
      const live = await until(async () => { try { return (await fetch(`${s3}/minio/health/live`)).ok; } catch { return false; } }, { timeoutMs: 90_000, everyMs: 1000 });
      c.must("MinIO is up on 127.0.0.1:" + PORTS.minio, live);
      const s3fetch = async (method: string, url: string, body?: Uint8Array | string) => {
        const signed = await signV4({ method, url, payloadHash: await sha256Hex(body ?? ""), accessKeyId: minioUser, secretAccessKey: minioPass, region: "us-east-1", service: "s3", now: new Date(), contentSha256Header: true });
        return fetch(url, { method, headers: signed.headers, body: body as BodyInit | undefined });
      };
      const bucket = `rd-journey-${S}`;
      const mk = await s3fetch("PUT", `${s3}/${bucket}`);
      c.must("bucket created with a signed S3 CreateBucket", mk.status === 200, await mk.text());
      const tables = ["transactions", "customers", "subscriptions", "events"];
      const mkExport = (name: string, format: string, prefix: string, secret = minioPass) => dev.v2r("POST", "/integrations/exports", {
        name, destination: "s3", config: { bucket, prefix, region: "us-east-1", endpoint: s3, access_key_id: minioUser }, credentials: { secret_access_key: secret },
        format, compression: "gzip", schedule: "daily", hour_utc: 3, mode: "full", tables,
      });
      const csvJob = await mkExport("Journey CSV", "csv", "csv");
      const pqJob = await mkExport("Journey Parquet", "parquet", "parquet");
      const badJob = await mkExport("Journey wrong key", "csv", "bad", "not-the-secret");
      c.check("three S3 exports created (201) with the secret only as configured", [csvJob, pqJob, badJob].every((r) => r.status === 201 && r.body.credentials.secret_access_key.configured && !JSON.stringify(r.body).includes(minioPass)), [csvJob.body, pqJob.body]);
      const [jobRow] = await sql`SELECT * FROM export_jobs WHERE id = ${csvJob.body.id}`;
      c.check("export_jobs row keeps the secret sealed", !JSON.stringify(jobRow).includes(minioPass));
      const chk = await dev.v2("POST", `/integrations/exports/${csvJob.body.id}/actions/check`);
      c.check("check bucket: RevenueDot reaches the bucket", chk.ok === true && chk.message.includes(bucket), chk);
      const chkBad = await dev.v2("POST", `/integrations/exports/${badJob.body.id}/actions/check`);
      c.check("check bucket with a wrong secret explains the 403", chkBad.ok === false && /403/.test(chkBad.message) && /credentials/.test(chkBad.message), chkBad);
      const runJob = async (id: string) => {
        const run = await dev.v2r("POST", `/integrations/exports/${id}/actions/run`, { mode: "full" });
        c.check("run now queues a full run (201)", run.status === 201 && run.body.status === "queued" && run.body.trigger === "manual", run.body);
        return until(async () => { const r = (await dev.v2("GET", `/integrations/exports/${id}/runs`)).items[0]; return r && (r.status === "succeeded" || r.status === "failed") ? r : null; }, { timeoutMs: 120_000, everyMs: 1000 });
      };
      const csvRun = await runJob(csvJob.body.id);
      c.check("CSV run succeeded with one file per table", csvRun?.status === "succeeded" && csvRun.files.length === 4 && tables.every((t) => csvRun.files.some((f: any) => f.table === t && f.key.endsWith(".csv.gz"))), csvRun);
      const pqRun = await runJob(pqJob.body.id);
      c.check("Parquet run succeeded with one file per table", pqRun?.status === "succeeded" && pqRun.files.length === 4 && tables.every((t) => pqRun.files.some((f: any) => f.table === t && f.key.endsWith(".parquet"))), pqRun);
      const list = await (await s3fetch("GET", `${s3}/${bucket}?list-type=2`)).text();
      const keys = [...list.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
      const runKeys = [...(csvRun?.files ?? []), ...(pqRun?.files ?? [])].map((f: any) => f.key).sort();
      c.eq("the bucket holds exactly the files the runs report", keys.sort(), runKeys);
      const getObj = async (key: string) => new Uint8Array(await (await s3fetch("GET", `${s3}/${bucket}/${key}`)).arrayBuffer());
      const csvOf = async (t: string) => parseCsv(gunzipSync(await getObj(csvRun.files.find((f: any) => f.table === t).key)).toString("utf8"));
      const tx = await csvOf("transactions");
      c.eq("transactions CSV header = RevenueCat's transaction export columns (plus app_id)", tx[0], RC_TRANSACTION_COLUMNS);
      const col = (rows: string[][], name: string) => rows[0]!.indexOf(name);
      const rowOf = (rows: string[][], user: string) => { const r = rows.find((x) => x[col(rows, "rc_original_app_user_id")] === user); return r ? Object.fromEntries(rows[0]!.map((h, k) => [h, r[k]])) : null; };
      const [txA] = await sql`SELECT store, store_transaction_id FROM transactions t JOIN customers cu ON cu.id = t.customer_id WHERE cu.project_id = ${dev.projectId} AND cu.original_app_user_id = ${buyer}`;
      const ra = rowOf(tx, buyer);
      c.has("the Test Store purchase row: product, store, sandbox, $9.99 USD, the transaction id, entitlement", ra, { product_identifier: "pro_monthly", store: txA?.store, is_sandbox: "true", price_in_usd: "9.99", purchase_price_in_usd: "9.99", purchased_currency: "USD", store_transaction_id: txA?.store_transaction_id, is_auto_renewable: "true", entitlement_identifiers: '["pro"]', product_duration: "P1M", app_id: cat.app.id });
      const [txB] = await sql`SELECT store_transaction_id FROM transactions t JOIN customers cu ON cu.id = t.customer_id WHERE cu.project_id = ${dev.projectId} AND cu.original_app_user_id = ${buyerB}`;
      const rb = rowOf(tx, buyerB);
      c.has("the Amazon purchase row: production, $4.99, the transaction id", rb, { product_identifier: "journey.pro.monthly", store: "amazon", is_sandbox: "false", price_in_usd: "4.99", store_transaction_id: txB?.store_transaction_id, app_id: amazonApp.id });
      c.check("the Amazon transaction id is the receipt id plus the period start", String(txB?.store_transaction_id).startsWith(`${receiptId}.`), txB);
      c.eq("transactions CSV has the rows the run reports", tx.length - 1, csvRun.files.find((f: any) => f.table === "transactions").rows);
      for (const t of ["customers", "subscriptions", "events"]) {
        const rows = await csvOf(t);
        c.eq(`${t} CSV has its header and the rows the run reports`, [rows[0]!.length > 5, rows.length - 1], [true, csvRun.files.find((f: any) => f.table === t).rows]);
      }
      const evCsv = await csvOf("events");
      c.check("events CSV includes both purchases' events with their webhook payload", [eA.id, eB.id].every((id) => evCsv.some((r) => r[col(evCsv, "event_id")] === id && JSON.parse(r[col(evCsv, "payload")]!).id === id)), evCsv.length);
      const hp = await import(pathToFileURL(createRequire(join(ROOT, "apps/server/package.json")).resolve("hyparquet")).href) as { parquetReadObjects: (o: { file: ArrayBuffer }) => Promise<Record<string, unknown>[]> };
      for (const t of tables) {
        const bytes = await getObj(pqRun.files.find((f: any) => f.table === t).key);
        const rows = await hp.parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
        c.check(`${t} Parquet: ${bytes.length} bytes, ${rows.length} rows = the CSV's rows`, bytes.length > 100 && rows.length === pqRun.files.find((f: any) => f.table === t).rows && rows.length === csvRun.files.find((f: any) => f.table === t).rows, { bytes: bytes.length, rows: rows.length });
        if (t === "transactions") {
          const pa = rows.find((r: any) => r.rc_original_app_user_id === buyer) as any;
          c.check("transactions Parquet: the Test Store row has typed values ($9.99 DOUBLE, sandbox BOOLEAN, start_time a date)", pa && pa.price_in_usd === 9.99 && pa.is_sandbox === true && pa.start_time instanceof Date && pa.product_identifier === "pro_monthly", pa);
        }
      }
      const runsList = await dev.v2("GET", `/integrations/exports/${csvJob.body.id}/runs`);
      c.check("run history lists the run with rows and bytes", runsList.items.length === 1 && runsList.items[0].rows > 0 && runsList.items[0].bytes > 0, runsList.items);

      c.begin("G. list and delete");
      const exportsList = await dev.v2("GET", "/integrations/exports");
      c.check("GET exports lists the destinations made", [csvJob.body.id, badJob.body.id].every((id) => exportsList.items.some((x: any) => x.id === id)), exportsList.items.map((x: any) => x.id));
      await dev.v2("DELETE", `/integrations/exports/${badJob.body.id}`);
      c.check("a deleted export destination is gone", !(await dev.v2("GET", "/integrations/exports")).items.some((x: any) => x.id === badJob.body.id));
      const partners = await dev.v2("GET", "/integrations/partners?limit=100");
      const victim = partners.items.find((x: any) => x.type === "discord");
      await dev.v2("DELETE", `/integrations/partners/${victim.id}`);
      c.eq("a deleted partner integration answers 404", (await dev.v2r("GET", `/integrations/partners/${victim.id}`)).status, 404);
      const leftover = await ctx.sql`SELECT count(*)::int AS n FROM integration_deliveries WHERE integration_id = ${victim.id}`;
      c.eq("its delivery log went with it", leftover[0]!.n, 0);
    } finally {
      const at = ctx.capture.handlers.indexOf(handler);
      if (at >= 0) ctx.capture.handlers.splice(at, 1);
      if (minioStarted) {
        try { execFileSync("docker", ["rm", "-f", "-v", minio], { stdio: "ignore" }); } catch { /* already gone */ }
        let gone = false;
        try { gone = !execFileSync("docker", ["ps", "-a", "--filter", `name=${minio}`, "--format", "{{.Names}}"]).toString().trim(); } catch { gone = false; }
        c.check("MinIO container removed (its data was on a tmpfs, nothing left on disk)", gone);
      }
      writeJson(join(ctx.out, "partners.json"), { outcomes, gaValidations });
    }
  },
};
export default journey;
