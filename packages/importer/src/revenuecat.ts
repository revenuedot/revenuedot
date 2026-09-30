// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a read-only client for RevenueCat's REST API v2 (the source of a migration).
// Docs: https://revenuedot.app/docs/migrate
import { requestJson, type HttpOptions } from "./http.js";

/** The fields of RevenueCat's API v2 objects the importer reads (all timestamps are ms since epoch). */
export interface RcList<T> { object: "list"; items: T[]; next_page?: string | null; url?: string }
export interface RcApp {
  id: string; name: string; type: string; project_id?: string; created_at?: number;
  app_store?: { bundle_id?: string; subscription_key_configured?: boolean; app_store_connect_api_key_configured?: boolean } | null;
  mac_app_store?: { bundle_id?: string } | null;
  play_store?: { package_name?: string; play_service_account_credentials_configured?: boolean } | null;
  amazon?: { package_name?: string } | null;
  stripe?: { stripe_account_id?: string | null } | null;
  [k: string]: unknown;
}
export interface RcPublicKey { id: string; key: string; environment: "production" | "sandbox" | string; app_id: string }
export interface RcProduct {
  id: string; store_identifier: string; type: string; state?: string; display_name?: string | null; app_id: string;
  subscription?: { duration?: string | null } | null; one_time?: { is_consumable?: boolean | null } | null;
}
export interface RcEntitlement { id: string; lookup_key: string; display_name: string; state?: string }
export interface RcOffering { id: string; lookup_key: string; display_name: string; is_current: boolean; state?: string; metadata?: Record<string, unknown> | null }
export interface RcPackage {
  id: string; lookup_key: string; display_name: string; position?: number | null;
  products?: RcList<{ product: RcProduct; eligibility_criteria: string }>;
}
export interface RcCustomer {
  id: string; first_seen_at: number; last_seen_at?: number | null; last_seen_app_version?: string | null; last_seen_country?: string | null;
  last_seen_platform?: string | null; active_entitlements?: RcList<{ entitlement_id: string; expires_at: number | null }>;
  attributes?: RcList<RcAttribute>;
}
export interface RcAttribute { name: string; value: string | null; updated_at?: number }
export interface RcMoney { currency: string; gross: number; commission?: number; tax?: number; proceeds?: number }
export interface RcSubscription {
  id: string; customer_id: string; product_id: string | null; starts_at: number; current_period_starts_at: number;
  current_period_ends_at: number | null; ends_at?: number | null; gives_access: boolean; pending_payment?: boolean;
  auto_renewal_status: string; status: string; total_revenue_in_usd?: RcMoney | null; presented_offering_id?: string | null;
  entitlements?: RcList<RcEntitlement>; environment: "production" | "sandbox"; store: string; store_subscription_identifier: string;
  ownership: "purchased" | "family_shared"; country?: string | null;
}
export interface RcTransaction {
  id: string; purchased_at: number; product_store_identifier: string; revenue_in_local_currency?: RcMoney | null;
  revenue_in_usd?: RcMoney | null; expiration_date?: number | null; effective_expiration_date?: number | null;
}
export interface RcPurchase {
  id: string; customer_id: string; product_id: string; purchased_at: number; revenue_in_usd?: RcMoney | null; quantity?: number;
  status: "owned" | "refunded" | string; environment: "production" | "sandbox"; store: string; store_purchase_identifier: string;
  ownership?: string; country?: string | null; entitlements?: RcList<RcEntitlement>;
}

export const RC_API = "https://api.revenuecat.com";

export class RevenueCatClient {
  readonly base: string;
  constructor(private o: { apiKey: string; projectId: string; baseUrl?: string; http?: HttpOptions }) {
    this.base = (o.baseUrl ?? RC_API).replace(/\/+$/, "");
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    const u = new URL(`${this.base}/v2/projects/${encodeURIComponent(this.o.projectId)}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.href;
  }

  private getUrl<T>(url: string): Promise<T> {
    return requestJson<T>(url, { headers: { Authorization: `Bearer ${this.o.apiKey}`, Accept: "application/json" } }, this.o.http);
  }

  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.getUrl<T>(this.url(path, query));
  }

  /** One page; `next` is the absolute URL of the following page (only on RevenueCat's own host), or null. */
  async page<T>(pathOrUrl: string, query?: Record<string, string | number | undefined>): Promise<{ items: T[]; next: string | null }> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.url(pathOrUrl, { limit: 100, ...query });
    const body = await this.getUrl<RcList<T>>(url);
    return { items: body.items ?? [], next: this.nextUrl(body.next_page) };
  }

  /** Every item of a list, following `next_page`. */
  async all<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    let first = true;
    while (next) {
      const p: { items: T[]; next: string | null } = await this.page<T>(next, first ? query : undefined);
      out.push(...p.items);
      next = p.next;
      first = false;
    }
    return out;
  }

  /** Resolves `next_page` (absolute or relative). A next page on another host is refused: the API key must not leave RevenueCat. */
  nextUrl(next: string | null | undefined): string | null {
    if (!next) return null;
    const u = new URL(next, this.base);
    if (u.origin !== new URL(this.base).origin) throw new Error(`Refusing to follow next_page to another host (${u.origin}).`);
    return u.href;
  }

  apps() { return this.all<RcApp>("/apps"); }
  publicKeys(appId: string) { return this.all<RcPublicKey>(`/apps/${encodeURIComponent(appId)}/public_api_keys`); }
  products() { return this.all<RcProduct>("/products"); }
  entitlements() { return this.all<RcEntitlement>("/entitlements"); }
  entitlementProducts(id: string) { return this.all<RcProduct>(`/entitlements/${encodeURIComponent(id)}/products`); }
  offerings() { return this.all<RcOffering>("/offerings"); }
  packages(offeringId: string) { return this.all<RcPackage>(`/offerings/${encodeURIComponent(offeringId)}/packages`, { expand: "items.product" }); }
  packageProducts(packageId: string) { return this.all<{ product: RcProduct; eligibility_criteria: string }>(`/packages/${encodeURIComponent(packageId)}/products`); }

  customersPage(after: string | null, limit = 100) {
    return this.page<RcCustomer>("/customers", { limit, starting_after: after ?? undefined });
  }
  customer(id: string) { return this.get<RcCustomer>(`/customers/${encodeURIComponent(id)}`, { expand: "attributes" }); }
  attributes(id: string) { return this.all<RcAttribute>(`/customers/${encodeURIComponent(id)}/attributes`); }
  aliases(id: string) { return this.all<{ id: string; created_at?: number }>(`/customers/${encodeURIComponent(id)}/aliases`); }
  subscriptions(id: string) { return this.all<RcSubscription>(`/customers/${encodeURIComponent(id)}/subscriptions`); }
  purchases(id: string) { return this.all<RcPurchase>(`/customers/${encodeURIComponent(id)}/purchases`); }
  transactions(subscriptionId: string) {
    return this.all<RcTransaction>(`/subscriptions/${encodeURIComponent(subscriptionId)}/transactions`, { sort: "purchased_at", direction: "asc" });
  }
}
