// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a fake RevenueCat REST API v2 (read endpoints) on a local port, serving fixture data, for importer tests.
// Docs: https://revenuedot.app/docs/migrate
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Spec } from "../../contract/src/openapi.js";

type Obj = Record<string, any>;

/** The project a test serves. Objects are RevenueCat API v2 shapes; the extra keys below are not serialized. */
export interface RcModel {
  project: string;
  apps: Obj[];
  publicKeys: Record<string, Obj[]>;
  products: Obj[];
  entitlements: (Obj & { product_ids: string[] })[];
  offerings: (Obj & { packages: (Obj & { products: { product_id: string; eligibility_criteria: string }[] })[] })[];
  customers: (Obj & { aliases: Obj[]; attributes: Obj[]; active: Obj[]; subscriptions: (Obj & { transactions?: Obj[] })[]; purchases: Obj[] })[];
}

export interface Req { method: string; path: string; query: URLSearchParams; template: string }
export type Hook = (r: Req) => { status: number; headers?: Record<string, string>; body: unknown } | undefined;

const strip = (o: Obj, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/**
 * Serves the model like api.revenuecat.com/v2: Bearer auth, `limit` + `starting_after` pagination with absolute
 * `next_page` URLs, `expand` where the importer asks for it, RevenueCat error bodies. Every body it sends is checked
 * against RevenueCat's OpenAPI response schema (when the private spec is available) and failures are collected.
 */
export class FakeRevenueCat {
  server: Server | null = null;
  url = "";
  requests: Req[] = [];
  schemaErrors: string[] = [];
  hooks: Hook[] = [];
  /** Largest page served, whatever `limit` asks for (small values exercise pagination). */
  maxPage = 100;

  constructor(public model: RcModel, public key: string, private spec: Spec | null) {}

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() { return new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())); }

  count(template: string) { return this.requests.filter((r) => r.template === template).length; }

  private send(res: ServerResponse, req: Req, status: number, body: unknown, headers: Record<string, string> = {}) {
    if (this.spec && req.template) {
      const err = this.spec.check(req.method, req.template, status, body);
      if (err) this.schemaErrors.push(`${req.method} ${req.template} ${status}: ${err}`);
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private error(status: number, type: string, message: string, extra: Obj = {}) {
    return { object: "error", type, message, retryable: status === 429 || status >= 500, doc_url: "https://example.invalid/errors", ...extra };
  }

  private list(req: Req, all: Obj[], key: (o: Obj) => string = (o) => o.id) {
    const limit = Math.min(Number(req.query.get("limit") ?? 20) || 20, 100, this.maxPage);
    const after = req.query.get("starting_after");
    const start = after ? all.findIndex((o) => key(o) === after) + 1 : 0;
    const items = all.slice(start, start + limit);
    const url = `/v2${req.template.replace("{project_id}", this.model.project)}`;
    let next: string | null = null;
    if (start + limit < all.length && items.length) {
      const q = new URLSearchParams(req.query);
      q.set("starting_after", key(items[items.length - 1]!));
      next = `${this.url}${req.path}?${q}`;
    }
    return { object: "list", items, next_page: next, url: `${this.url}${url}` };
  }

  private route(method: string, path: string): { template: string; params: string[] } | null {
    const P = `/v2/projects/${this.model.project}`;
    const routes: [string, RegExp][] = [
      ["/v2/projects/{project_id}/apps", /^\/apps$/],
      ["/v2/projects/{project_id}/apps/{app_id}/public_api_keys", /^\/apps\/([^/]+)\/public_api_keys$/],
      ["/v2/projects/{project_id}/products", /^\/products$/],
      ["/v2/projects/{project_id}/entitlements", /^\/entitlements$/],
      ["/v2/projects/{project_id}/entitlements/{entitlement_id}/products", /^\/entitlements\/([^/]+)\/products$/],
      ["/v2/projects/{project_id}/offerings", /^\/offerings$/],
      ["/v2/projects/{project_id}/offerings/{offering_id}/packages", /^\/offerings\/([^/]+)\/packages$/],
      ["/v2/projects/{project_id}/packages/{package_id}/products", /^\/packages\/([^/]+)\/products$/],
      ["/v2/projects/{project_id}/customers", /^\/customers$/],
      ["/v2/projects/{project_id}/customers/{customer_id}", /^\/customers\/([^/]+)$/],
      ["/v2/projects/{project_id}/customers/{customer_id}/aliases", /^\/customers\/([^/]+)\/aliases$/],
      ["/v2/projects/{project_id}/customers/{customer_id}/attributes", /^\/customers\/([^/]+)\/attributes$/],
      ["/v2/projects/{project_id}/customers/{customer_id}/active_entitlements", /^\/customers\/([^/]+)\/active_entitlements$/],
      ["/v2/projects/{project_id}/customers/{customer_id}/subscriptions", /^\/customers\/([^/]+)\/subscriptions$/],
      ["/v2/projects/{project_id}/customers/{customer_id}/purchases", /^\/customers\/([^/]+)\/purchases$/],
      ["/v2/projects/{project_id}/subscriptions/{subscription_id}/transactions", /^\/subscriptions\/([^/]+)\/transactions$/],
    ];
    if (method !== "GET" || !path.startsWith(P)) return null;
    const rest = path.slice(P.length);
    for (const [template, re] of routes) {
      const m = re.exec(rest);
      if (m) return { template, params: m.slice(1).map(decodeURIComponent) };
    }
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? "/", this.url);
    const hit = this.route(req.method ?? "GET", u.pathname);
    const r: Req = { method: req.method ?? "GET", path: u.pathname, query: u.searchParams, template: hit?.template ?? "" };
    this.requests.push(r);
    if (req.headers.authorization !== `Bearer ${this.key}`) return this.send(res, r, 401, this.error(401, "authentication_error", "Invalid API key."));
    if (!hit) return this.send(res, { ...r, template: "" }, 404, this.error(404, "resource_missing", "Not found."));
    for (const h of this.hooks) {
      const o = h(r);
      if (o) return this.send(res, r, o.status, o.body, o.headers);
    }
    const m = this.model;
    const [a] = hit.params;
    const cust = () => m.customers.find((c) => c.id === a || c.aliases.some((x) => x.id === a));
    const ent = (id: string) => strip(m.entitlements.find((e) => e.id === id)!, "product_ids");
    const product = (id: string) => m.products.find((p) => p.id === id)!;
    const customerShape = (c: Obj, detail: boolean) => {
      const base = strip(c, "aliases", "attributes", "active", "subscriptions", "purchases");
      if (!detail) return base;
      const url = `/v2/projects/${m.project}/customers/${encodeURIComponent(c.id)}`;
      return {
        ...base,
        active_entitlements: { object: "list", items: c.active, next_page: null, url: `${url}/active_entitlements` },
        ...(u.searchParams.get("expand")?.includes("attributes") ? { attributes: { object: "list", items: c.attributes, next_page: null, url: `${url}/attributes` } } : {}),
      };
    };
    const subShape = (s: Obj) => ({ ...strip(s, "transactions", "entitlement_ids"), entitlements: { object: "list", items: (s.entitlement_ids ?? []).map(ent), next_page: null, url: `/v2/projects/${m.project}/subscriptions/${s.id}/entitlements` } });
    const purchaseShape = (p: Obj) => ({ ...strip(p, "entitlement_ids"), entitlements: { object: "list", items: (p.entitlement_ids ?? []).map(ent), next_page: null, url: `/v2/projects/${m.project}/purchases/${p.id}/entitlements` } });
    let body: unknown;
    switch (hit.template.replace("/v2/projects/{project_id}", "")) {
      case "/apps": body = this.list(r, m.apps); break;
      case "/apps/{app_id}/public_api_keys": body = this.list(r, m.publicKeys[a!] ?? []); break;
      case "/products": body = this.list(r, m.products); break;
      case "/entitlements": body = this.list(r, m.entitlements.map((e) => strip(e, "product_ids"))); break;
      case "/entitlements/{entitlement_id}/products": body = this.list(r, (m.entitlements.find((e) => e.id === a)?.product_ids ?? []).map(product)); break;
      case "/offerings": body = this.list(r, m.offerings.map((o) => strip(o, "packages"))); break;
      case "/offerings/{offering_id}/packages": {
        const pk = m.offerings.find((o) => o.id === a)?.packages ?? [];
        const expand = u.searchParams.get("expand") === "items.product";
        body = this.list(r, pk.map((p) => ({
          ...strip(p, "products"),
          ...(expand ? { products: { object: "list", items: p.products.map((x) => ({ product: product(x.product_id), eligibility_criteria: x.eligibility_criteria })), next_page: null, url: `/v2/projects/${m.project}/packages/${p.id}/products` } } : {}),
        })));
        break;
      }
      case "/packages/{package_id}/products": {
        const pk = m.offerings.flatMap((o) => o.packages).find((p) => p.id === a);
        body = this.list(r, (pk?.products ?? []).map((x) => ({ product: product(x.product_id), eligibility_criteria: x.eligibility_criteria })), (x) => x.product.id);
        break;
      }
      case "/customers": body = this.list(r, m.customers.map((c) => customerShape(c, false))); break;
      case "/customers/{customer_id}": { const c = cust(); if (!c) return this.send(res, r, 404, this.error(404, "resource_missing", "Customer not found.")); body = customerShape(c, true); break; }
      case "/customers/{customer_id}/aliases": body = this.list(r, cust()?.aliases ?? []); break;
      case "/customers/{customer_id}/attributes": body = this.list(r, cust()?.attributes ?? [], (x) => x.name); break;
      case "/customers/{customer_id}/active_entitlements": body = this.list(r, cust()?.active ?? [], (x) => x.entitlement_id); break;
      case "/customers/{customer_id}/subscriptions": body = this.list(r, (cust()?.subscriptions ?? []).map(subShape)); break;
      case "/customers/{customer_id}/purchases": body = this.list(r, (cust()?.purchases ?? []).map(purchaseShape)); break;
      case "/subscriptions/{subscription_id}/transactions": {
        const s = m.customers.flatMap((c) => c.subscriptions).find((x) => x.id === a);
        body = this.list(r, s?.transactions ?? []);
        break;
      }
    }
    this.send(res, r, 200, body);
  }

  /** A 429 like RevenueCat's for the next `times` requests matching `template`. */
  rateLimit(template: string, times: number, retryAfterSeconds = 2) {
    let left = times;
    this.hooks.push((r) => {
      if (r.template !== template || left <= 0) return undefined;
      left--;
      return { status: 429, headers: { "Retry-After": String(retryAfterSeconds), "RevenueCat-Rate-Limit-Current-Usage": "481", "RevenueCat-Rate-Limit-Current-Limit": "480" }, body: this.error(429, "rate_limit_error", "Rate limit exceeded.", { backoff_ms: retryAfterSeconds * 1000 }) };
    });
  }

  /** 500 for every request matching `template` and `when`, until the returned function is called. */
  fail(template: string, when: (r: Req) => boolean = () => true) {
    let on = true;
    this.hooks.push((r) => (on && r.template === template && when(r) ? { status: 500, body: this.error(500, "server_error", "There was an internal server error.") } : undefined));
    return () => { on = false; };
  }
}
