// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a client for the RevenueDot server the migration writes to (REST API v2 plus the import endpoints).
// Docs: https://revenuedot.app/docs/migrate
import { requestJson, type HttpOptions } from "./http.js";
import type { RcApp, RcList, RcOffering, RcPackage, RcProduct, RcSubscription } from "./revenuecat.js";
import type { ImportCustomer } from "./convert.js";

export interface RdEntitlement { id: string; lookup_key: string; display_name: string; state?: string; products?: RcList<RcProduct> }
export interface RdOffering extends RcOffering { packages?: RcList<RcPackage> }
export interface ImportResult {
  object: "import_result";
  customers: { id: string; status: "created" | "updated" | "merged"; subscriptions: number; purchases: number; needs_token_refresh: number; notes: string[] }[];
}
export interface ImportStatus { customers: number; subscriptions: number; needs_token_refresh: number; needs_token_refresh_by_app: Record<string, number> }

export class RevenueDotClient {
  readonly base: string;
  projectId: string | null;

  constructor(private o: { url: string; apiKey: string; projectId?: string | null; http?: HttpOptions }) {
    this.base = o.url.replace(/\/+$/, "");
    this.projectId = o.projectId ?? null;
  }

  private req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.o.apiKey}`, Accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return requestJson<T>(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, this.o.http);
  }

  private p(path = "") {
    if (!this.projectId) throw new Error("RevenueDot project is not resolved yet; call project() first.");
    return `/v2/projects/${encodeURIComponent(this.projectId)}${path}`;
  }

  /** A secret key belongs to one project; `GET /v2/projects` names it. */
  async project(): Promise<{ id: string; name: string }> {
    const list = await this.req<RcList<{ id: string; name: string }>>("GET", "/v2/projects");
    const hit = this.projectId ? list.items.find((x) => x.id === this.projectId) : list.items[0];
    if (!hit) throw new Error(this.projectId ? `The RevenueDot key cannot see project ${this.projectId}.` : "The RevenueDot key cannot see any project.");
    this.projectId = hit.id;
    return hit;
  }

  async all<T>(path: string, query = ""): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${this.p(path)}?limit=100${query ? `&${query}` : ""}`;
    while (url) {
      const page: RcList<T> = await this.req<RcList<T>>("GET", url);
      out.push(...page.items);
      url = page.next_page ? new URL(page.next_page, this.base).pathname + new URL(page.next_page, this.base).search : null;
    }
    return out;
  }

  get<T>(path: string) { return this.req<T>("GET", this.p(path)); }
  post<T>(path: string, body: unknown) { return this.req<T>("POST", this.p(path), body); }

  apps() { return this.all<RcApp & { id: string }>("/apps"); }
  products() { return this.all<RcProduct>("/products"); }
  entitlements() { return this.all<RdEntitlement>("/entitlements", "expand=items.product"); }
  offerings() { return this.all<RdOffering>("/offerings", "expand=items.package.product"); }
  importCustomers(customers: ImportCustomer[], opts: { emitEvents?: boolean } = {}) {
    return this.post<ImportResult>("/import/customers", { customers, emit_events: opts.emitEvents ?? false });
  }
  setPublicKey(appId: string, key: string) { return this.post(`/import/apps/${encodeURIComponent(appId)}/public_key`, { public_key: key }); }
  importStatus() { return this.get<ImportStatus>("/import/status"); }
  customer(id: string) { return this.get<{ id: string; active_entitlements: RcList<{ entitlement_id: string; expires_at: number | null }> }>(`/customers/${encodeURIComponent(id)}`); }
  subscriptions(id: string) { return this.all<RcSubscription>(`/customers/${encodeURIComponent(id)}/subscriptions`); }
  customersPage(after: string | null) {
    return this.req<RcList<{ id: string }>>("GET", `${this.p("/customers")}?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
  }
}
