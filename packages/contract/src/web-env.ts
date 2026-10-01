/**
 * A test server for web billing (prd/web-billing/PRD.md): the contract harness's database and catalog, plus a Stripe app
 * wired to the in-memory FakeStripeAccount, a fake DNS-over-HTTPS resolver, an in-memory mailer and optionally a fake AI
 * model. Nothing leaves the process. Used by apps/server/test/web-*.test.ts and packages/contract/test/{redemption,v2-discounts}.
 */
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createApp, defaultStores } from "@revenuedot/server";
import { memoryMailer } from "@revenuedot/server/mail/index.js";
import { secretKeyFrom } from "@revenuedot/server/services/secrets.js";
import { sealStoreSecrets, takeStoreSecrets } from "@revenuedot/server/services/store-secrets.js";
import { createStripeStore } from "@revenuedot/server/stores/stripe/index.js";
import { signStripePayload } from "@revenuedot/server/stores/stripe/signature.js";
import type { PaywallModel } from "@revenuedot/server/services/paywall-ai.js";
import { harness, type Harness } from "./harness.js";
import { FAKE_STRIPE_KEY, FakeStripeAccount } from "./fake-stripe.js";

export const WEB_WHSEC = "whsec_fakeonlywebbillingsigningsecret00";
export const WEB_APP_ID = "app_web";
export const WEB_APP_KEY = "strp_webtest123";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export interface WebEnv {
  h: Harness;
  stripe: FakeStripeAccount;
  mail: ReturnType<typeof memoryMailer>;
  dns: Record<string, { CNAME?: string[]; TXT?: string[] }>;
  /** Any URL (pages on custom hosts included); no Authorization header unless given. */
  raw: (url: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
  /** A v2 call with the project's secret key; answers the parsed body. */
  api: (method: string, path: string, json?: unknown) => Promise<{ status: number; body: any }>;
  webhook: (event: Record<string, unknown>) => Promise<Response>;
  events: (type?: string) => Promise<Array<Record<string, any>>>;
  /** Web config, three web products (monthly with a 7-day trial, annual, lifetime) and offering `web` with them. */
  setupWeb: () => Promise<{ monthly: string; annual: string; lifetime: string; offeringId: string; projectSlug: string }>;
}

export async function webEnv(opts: { ai?: PaywallModel; payUrl?: string; customDomainTarget?: string; credentials?: Record<string, unknown> } = {}): Promise<WebEnv> {
  const base = await harness();
  const stripe = new FakeStripeAccount();
  stripe.clock = base.now;
  const mail = memoryMailer();
  const dns: WebEnv["dns"] = {};
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.stripe.com/")) return stripe.fetch(url, init);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const u = new URL(url);
      const name = u.searchParams.get("name")!, type = u.searchParams.get("type") as "CNAME" | "TXT";
      const data = dns[name]?.[type] ?? [];
      return new Response(JSON.stringify({ Status: 0, Answer: data.map((d) => ({ name, type: type === "CNAME" ? 5 : 16, TTL: 60, data: type === "TXT" ? `"${d}"` : `${d}.` })) }), { headers: { "content-type": "application/dns-json" } });
    }
    if (url.startsWith("https://hooks.example.com/") || url.startsWith("https://api.exchangerate") || url.includes("currency-api")) return new Response("{}", { status: 200 });
    throw new Error(`web-env: unexpected fetch ${url}`);
  }) as typeof fetch;
  const app = createApp({
    db: base.db, now: base.now, stores: { ...defaultStores(), stripe: createStripeStore({ fetch: stripe.fetch, now: base.now, timeoutMs: 1000 }) },
    fetch: fetchFn, encryptionKey: ENCRYPTION_KEY, mailer: mail, ai: opts.ai, payUrl: opts.payUrl, customDomainTarget: opts.customDomainTarget,
  });
  const rest = { stripe_secret_key: FAKE_STRIPE_KEY, stripe_webhook_secret: WEB_WHSEC, ...(opts.credentials ?? {}) };
  const update = takeStoreSecrets("stripe", rest);
  const cols = await sealStoreSecrets({ type: "stripe", credentials: rest, secrets: null }, update, await secretKeyFrom(ENCRYPTION_KEY));
  await base.db.insert(schema.apps).values({ id: WEB_APP_ID, projectId: base.ids.project, name: "Scanner Web", type: "stripe", publicKey: WEB_APP_KEY, ...cols });

  const fetchApp = (url: string, init: RequestInit & { json?: unknown; key?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set("Authorization", `Bearer ${init.key}`);
    let body = init.body;
    if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
    return Promise.resolve(app.fetch(new Request(url.startsWith("http") ? url : `http://localhost${url}`, { ...init, headers, body })));
  };
  const h: Harness = {
    ...base,
    fetch: (path, init = {}) => fetchApp(path, { ...init, key: init.key === "" ? undefined : init.key ?? base.ids.iosKey }),
  };
  const api: WebEnv["api"] = async (method, path, json) => {
    const res = await fetchApp(path, { method, json, key: base.ids.secretKey });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const env: WebEnv = {
    h, stripe, mail, dns, api,
    raw: (url, init = {}) => fetchApp(url, init),
    webhook: async (event) => {
      const raw = JSON.stringify(event);
      const sig = await signStripePayload(WEB_WHSEC, raw, Math.floor(base.now().getTime() / 1000));
      return fetchApp(`/v1/notifications/stripe/${WEB_APP_ID}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: raw });
    },
    events: async (type) => {
      const rows = await base.db.select().from(schema.events);
      return rows.map((r) => (r.payload as { event: Record<string, any> }).event).filter((e) => !type || e.type === type);
    },
    setupWeb: async () => {
      const P = `/v2/projects/${base.ids.project}`;
      const cfg = await api("PUT", `${P}/apps/${WEB_APP_ID}/web_config`, {
        app_name: "Scanner", support_email: "help@scanner.example", terms_url: "https://scanner.example/terms", privacy_url: "https://scanner.example/privacy",
        app_scheme: "scanner", app_store_url: "https://apps.apple.com/app/id123", play_store_url: "https://play.google.com/store/apps/details?id=com.example.scanner",
      });
      if (cfg.status !== 200) throw new Error(`web config: ${JSON.stringify(cfg.body)}`);
      const mk = async (json: Record<string, unknown>) => {
        const r = await api("POST", `${P}/apps/${WEB_APP_ID}/web_products`, json);
        if (r.status !== 201) throw new Error(`web product: ${JSON.stringify(r.body)}`);
        return r.body.product.id as string;
      };
      const monthly = await mk({ display_name: "Pro monthly", type: "subscription", price: { amount: 9.99, currency: "USD" }, duration: "P1M", trial_days: 7, entitlement_ids: ["ent_pro"] });
      const annual = await mk({ display_name: "Pro annual", type: "subscription", price: { amount: 59.99, currency: "USD" }, duration: "P1Y", entitlement_ids: ["ent_pro"] });
      const lifetime = await mk({ display_name: "Lifetime", type: "non_consumable", price: { amount: 99, currency: "USD" }, entitlement_ids: ["ent_pro"] });
      const o = await api("POST", `${P}/offerings`, { lookup_key: "web", display_name: "Go Pro on the web" });
      if (o.status !== 201) throw new Error(`offering: ${JSON.stringify(o.body)}`);
      for (const [key, name, product, position] of [["$rc_monthly", "Monthly", monthly, 1], ["$rc_annual", "Annual", annual, 2], ["$rc_lifetime", "Lifetime", lifetime, 3]] as const) {
        const p = await api("POST", `${P}/offerings/${o.body.id}/packages`, { lookup_key: key, display_name: name, position });
        if (p.status !== 201) throw new Error(`package: ${JSON.stringify(p.body)}`);
        const a = await api("POST", `${P}/packages/${p.body.id}/actions/attach_products`, { products: [{ product_id: product, eligibility_criteria: "all" }] });
        if (a.status !== 200) throw new Error(`attach: ${JSON.stringify(a.body)}`);
      }
      const d = await api("GET", `${P}/web_domain`);
      return { monthly, annual, lifetime, offeringId: o.body.id as string, projectSlug: d.body.slug as string };
    },
  };
  void eq;
  return env;
}

/** The query parameters of a URL as an object. */
export const qs = (url: string) => Object.fromEntries(new URL(url).searchParams);
