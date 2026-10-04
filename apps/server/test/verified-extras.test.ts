import { afterEach, describe, expect, it } from "vitest";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";

/**
 * Verified Metrics (prd/project-settings §4): the three chart types and the page's custom domain (DNS proof, routing by
 * host, the TLS certificate from Cloudflare for SaaS when configured, else the manual step on Cloud).
 */
let h: Harness;
afterEach(async () => { await h?.close(); });

const DOMAIN = "metrics.scanner.example";
const TARGET = "domains.revenuedot.app";
const P = () => `/v2/projects/${h.ids.project}`;
const v2 = async (method: string, path: string, json?: unknown) => {
  const res = await h.fetch(path, { method, key: h.ids.secretKey, ...(json === undefined ? {} : { json }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
/** A request as a visitor's browser sends it to the custom domain. */
const visit = (path: string, host = DOMAIN, method = "GET") => h.fetch(path, { key: "", method, headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" } });

/** DNS over HTTPS answers for the domain, and Cloudflare's custom hostname API, recorded. */
function world(o: { txt?: string[]; cname?: string[] } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let ssl = "pending_validation";
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const u = new URL(url);
      const type = u.searchParams.get("type");
      const data = type === "TXT" ? o.txt ?? [] : o.cname ?? [];
      return Response.json({ Status: 0, Answer: data.map((d) => ({ name: u.searchParams.get("name"), type: type === "TXT" ? 16 : 5, data: type === "TXT" ? `"${d}"` : `${d}.` })) });
    }
    if (url.startsWith("https://api.cloudflare.com/")) {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === "POST") return Response.json({ success: true, result: { id: "ch_1", hostname: DOMAIN, status: "pending", ssl: { status: ssl } } });
      if (init?.method === "DELETE") return Response.json({ success: true, result: { id: "ch_1" } });
      if (url.includes("/custom_hostnames/ch_1")) { ssl = "active"; return Response.json({ success: true, result: { id: "ch_1", hostname: DOMAIN, status: "active", ssl: { status: ssl } } }); }
      return Response.json({ success: true, result: [] });
    }
    return new Response("", { status: 404 });
  };
  return { fetchFn, calls, set: (x: { txt?: string[]; cname?: string[] }) => Object.assign(o, x) };
}

async function seedProduction() {
  const { getOrCreateCustomer } = await import("../src/repo/customers.js");
  const { customer } = await getOrCreateCustomer(h.db, h.ids.project, "buyer", h.now());
  // $10 a month since April: a paid period each month, the current one active now (2026-09-01).
  for (let m = 3; m <= 8; m++) {
    const at = new Date(Date.UTC(2026, m, 1, 12)), end = new Date(Date.UTC(2026, m + 1, 1, 12));
    await h.db.insert(schema.transactions).values({ id: `txn_${m}`, projectId: h.ids.project, customerId: customer.id, appId: h.ids.app, store: "app_store", storeTransactionId: `t${m}`, productIdentifier: "pro_monthly", kind: m === 3 ? "purchase" : "renewal", purchasedAt: at, expiresAt: end, revenueUsd: 10 });
  }
  await h.db.insert(schema.subscriptions).values({ id: "sub_1", projectId: h.ids.project, customerId: customer.id, appId: h.ids.app, store: "app_store", storeKey: "ot", productIdentifier: "pro_monthly", purchaseDate: new Date(Date.UTC(2026, 8, 1, 12)), originalPurchaseDate: new Date(Date.UTC(2026, 3, 1, 12)), expiresDate: new Date(Date.UTC(2026, 9, 1, 12)), priceAmount: 10, priceCurrency: "USD", priceUsd: 10 });
}

describe("chart types", () => {
  it("draws numbers only, sparklines or 12 monthly line charts", async () => {
    h = await harness();
    await seedProduction();
    expect((await v2("POST", `${P()}/verified_metrics/actions/publish`, { slug: "scanner", chart_type: "pie" })).status).toBe(400);

    const only = await v2("POST", `${P()}/verified_metrics/actions/publish`, { slug: "scanner", chart_type: "numbers_only" });
    expect(only.body).toMatchObject({ status: "published", chart_type: "numbers_only" });
    const plain = await (await h.fetch("/verified/scanner", { key: "" })).text();
    expect(plain).toContain('class="t-numbers_only"');
    expect(plain).not.toContain("<svg");
    expect((await (await h.fetch("/verified/scanner/metrics.json", { key: "" })).json() as any).metrics[0]).toMatchObject({ sparkline: [], history: [] });

    await v2("POST", `${P()}/verified_metrics/actions/publish`, { chart_type: "line" });
    const json = await (await h.fetch("/verified/scanner/metrics.json", { key: "" })).json() as any;
    expect(json.chart_type).toBe("line");
    const mrr = json.metrics.find((m: any) => m.id === "mrr");
    expect(mrr.history).toHaveLength(12);
    expect(mrr.history[0]).toEqual({ date: "2025-10", value: 0 });
    // MRR at the end of April … August, then the live value for September.
    expect(mrr.history.slice(6).map((p: any) => p.value)).toEqual([10, 10, 10, 10, 10, 10]);
    const revenue = json.metrics.find((m: any) => m.id === "revenue");
    expect(revenue.history.slice(6).map((p: any) => p.value)).toEqual([10, 10, 10, 10, 10, 10]);
    expect(json.metrics.find((m: any) => m.id === "active_users").history).toEqual([]);
    const page = await (await h.fetch("/verified/scanner", { key: "" })).text();
    expect(page).toContain('class="t-line"');
    expect(page).toContain('aria-label="MRR by month from Oct 25 to Sep 26');
    expect(page).toContain("No monthly history for this metric.");
    const png = await h.fetch("/verified/scanner/og.png", { key: "" });
    expect(png.headers.get("content-type")).toBe("image/png");

    const preview = await v2("GET", `${P()}/verified_metrics/monthly_history`);
    expect(preview.body.metrics.mrr).toEqual(mrr.history);
  });
});

describe("custom domain", () => {
  it("is proven by DNS, then serves the published page and nothing else on that host", async () => {
    const w = world();
    h = await harness({ fetch: w.fetchFn, customDomainTarget: TARGET, apiUrl: "https://api.example.com" });
    await seedProduction();
    expect((await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: "not a domain" })).status).toBe(400);
    expect((await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: "x.revenuedot.app" })).status).toBe(400);
    expect((await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: "api.example.com" })).status).toBe(400);
    expect((await v2("POST", `${P()}/verified_metrics/domain/actions/verify`)).status).toBe(400);

    const set = await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: `${DOMAIN.toUpperCase()}.` });
    expect(set.status).toBe(200);
    const cd = set.body.custom_domain;
    expect(cd).toMatchObject({ domain: DOMAIN, status: "pending", url: null, certificate: { managed: "self_hosted" } });
    expect(cd.dns[0]).toEqual({ type: "CNAME", name: DOMAIN, value: TARGET });
    const txt = cd.dns[1];
    expect(txt.name).toBe(`_revenuedot.${DOMAIN}`);
    expect(txt.value).toMatch(/^revenuedot-verify=/);

    // Not there yet.
    const miss = await v2("POST", `${P()}/verified_metrics/domain/actions/verify`);
    expect(miss.body.custom_domain).toMatchObject({ status: "failed", error: expect.stringContaining("TXT record") });
    w.set({ txt: [txt.value], cname: ["somewhere-else.example"] });
    expect((await v2("POST", `${P()}/verified_metrics/domain/actions/verify`)).body.custom_domain.error).toContain(`CNAME to ${TARGET}`);
    w.set({ cname: [TARGET] });
    const ok = await v2("POST", `${P()}/verified_metrics/domain/actions/verify`);
    expect(ok.body.custom_domain).toMatchObject({ status: "verified", url: `https://${DOMAIN}`, error: null });

    // Verified but not published: the host serves nothing.
    expect((await visit("/")).status).toBe(404);
    await v2("POST", `${P()}/verified_metrics/actions/publish`, { slug: "scanner" });
    const home = await visit("/");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain(`<link rel="canonical" href="https://${DOMAIN}">`);
    expect(html).toContain(`content="https://${DOMAIN}/og.png"`);
    const json = await (await visit("/metrics.json")).json() as any;
    expect(json).toMatchObject({ url: `https://${DOMAIN}`, slug: "scanner" });
    expect((await visit("/og.png")).headers.get("content-type")).toBe("image/png");
    // Never the API, sign-in, other pages or writes on a customer's domain.
    for (const path of ["/v1/subscribers/x", "/v2/projects", "/auth/login", "/verified/scanner", "/anything"]) expect((await visit(path)).status, path).toBe(404);
    expect((await visit("/", DOMAIN, "POST")).status).toBe(404);
    // The API host still serves the page at its slug.
    expect((await h.fetch("/verified/scanner", { key: "" })).status).toBe(200);

    // Another project cannot verify the same domain: only one verified claim per domain.
    await h.db.insert(schema.projects).values({ id: "projB", name: "B" });
    await expect(h.db.insert(schema.verifiedPages).values({ projectId: "projB", slug: "other", displayName: "B", metrics: [], customDomain: DOMAIN, domainStatus: "verified" })).rejects.toThrow();

    // Removing the domain stops serving it at once.
    expect((await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: null })).body.custom_domain).toBeNull();
    expect((await visit("/metrics.json")).status).toBe(404);
    expect(await (await visit("/")).text()).not.toContain("Verified by RevenueDot");
  });

  it("refuses a domain that serves hosted web pages", async () => {
    h = await harness({ customDomainTarget: TARGET });
    await h.db.insert(schema.webDomains).values({ projectId: h.ids.project, slug: "scanner", verificationToken: "t", customDomain: "pay.scanner.example", status: "verified" });
    const r = await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: "pay.scanner.example" });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("hosted web pages");
  });

  it("on Cloud without a Cloudflare for SaaS token, names the manual certificate step", async () => {
    h = await harness({ customDomainTarget: TARGET, edition: "cloud" });
    const r = await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: DOMAIN });
    expect(r.body.custom_domain.certificate).toMatchObject({ managed: "manual", status: null, note: expect.stringContaining("TLS certificate") });
  });

  it("with a Cloudflare for SaaS token, adds the custom hostname once DNS proves the domain and reports its certificate", async () => {
    const w = world();
    h = await harness({ fetch: w.fetchFn, customDomainTarget: TARGET, edition: "cloud", cloudflareSaas: { zoneId: "zone1", apiToken: "tok" } });
    const set = await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: DOMAIN });
    expect(set.body.custom_domain.certificate).toMatchObject({ managed: "automatic", status: null, note: null });
    // No hostname before DNS proves the domain.
    await v2("POST", `${P()}/verified_metrics/domain/actions/verify`);
    expect(w.calls).toHaveLength(0);
    w.set({ txt: [set.body.custom_domain.dns[1].value], cname: [TARGET] });
    const ok = await v2("POST", `${P()}/verified_metrics/domain/actions/verify`);
    expect(ok.body.custom_domain).toMatchObject({ status: "verified", certificate: { managed: "automatic", status: "pending_validation" } });
    expect(w.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(w.calls[1]).toMatchObject({ url: "https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames", body: { hostname: DOMAIN, ssl: { method: "http", type: "dv" } } });
    // Checking again reads the hostname's certificate status.
    const again = await v2("POST", `${P()}/verified_metrics/domain/actions/verify`);
    expect(again.body.custom_domain.certificate.status).toBe("active");
    // Removing the domain removes the hostname.
    await v2("PUT", `${P()}/verified_metrics/domain`, { custom_domain: null });
    expect(w.calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames/ch_1" });
  });
});
