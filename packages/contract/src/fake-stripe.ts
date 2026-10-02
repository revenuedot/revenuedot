/**
 * A stateful fake of one Stripe account for web billing tests (prd/web-billing/PRD.md): products, prices, Checkout Sessions,
 * subscriptions, invoices, coupons and promotion codes, in Stripe's documented shapes (https://docs.stripe.com/api). Writes are
 * form-encoded like Stripe's API. `complete(sessionId)` stands in for the customer paying on Stripe's checkout page.
 * Used by the server and contract tests and by the dashboard's e2e server. It never calls Stripe and accepts only its own keys.
 */

export const FAKE_STRIPE_KEY = "rk_test_51FakeOnlyRevenueDotWebBilling0000000000000000";

type Obj = Record<string, any>;
interface Call { method: string; path: string; params: Obj; auth: string | null; idempotencyKey: string | null; account: string | null }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, message: string, code?: string, param?: string) =>
  json(status, { error: { type: "invalid_request_error", message, ...(code ? { code } : {}), ...(param ? { param } : {}) } });

/** Parses Stripe's form encoding back into nested objects and arrays (`a[b][0][c]=v`). */
export function parseStripeForm(body: string): Obj {
  const out: Obj = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const parts = key.replace(/\]/g, "").split("[");
    let cur: any = out;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]!);
      if (last) { cur[p] = value; return; }
      cur[p] ??= nextIsIndex ? [] : {};
      cur = cur[p];
    });
  }
  return out;
}

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

export class FakeStripeAccount {
  keys = new Set([FAKE_STRIPE_KEY]);
  /** Set when this account is connected to a FakeStripePlatform: its keys act for it with `Stripe-Account: <id>`. */
  connect: { accountId: string; platform: FakeStripePlatform } | null = null;
  customers = new Map<string, Obj>();
  portalSessions = new Map<string, Obj>();
  /** Whether the customer portal is set up in this account (Stripe refuses sessions until it is). */
  portalConfigured = true;
  /** Where the fake customer portal page lives; `{id}` is the session id. */
  portalUrl = "https://billing.stripe.com/p/session/{id}";
  products = new Map<string, Obj>();
  prices = new Map<string, Obj>();
  sessions = new Map<string, Obj>();
  subscriptions = new Map<string, Obj>();
  invoices = new Map<string, Obj>();
  coupons = new Map<string, Obj>();
  promotionCodes = new Map<string, Obj>();
  calls: Call[] = [];
  /** Where the fake "Stripe Checkout" page lives (the e2e server serves one); `{id}` is the session id. */
  checkoutUrl = "https://checkout.stripe.com/c/pay/{id}";
  /** Answer this instead (outage tests); return undefined to continue. */
  override: ((method: string, path: string) => Response | undefined) | null = null;
  private seq = 0;
  private idem = new Map<string, Response>();
  clock: () => Date = () => new Date();
  /** Whether the current request uses a live key (a connected account reached with the platform's live key makes live objects). */
  private live = false;

  private id(prefix: string) { return `${prefix}_test_${(++this.seq).toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 10)}`; }
  private now() { return Math.floor(this.clock().getTime() / 1000); }
  writes(path?: string | RegExp) { return this.calls.filter((c) => c.method !== "GET" && (!path || (typeof path === "string" ? c.path === path : path.test(c.path)))); }

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.stripe.com/v1/")) throw new Error(`FakeStripeAccount does not serve ${url}`);
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const params = method === "POST" ? parseStripeForm(typeof init.body === "string" ? init.body : "") : Object.fromEntries(u.searchParams);
    const auth = headers.get("authorization");
    const idempotencyKey = headers.get("idempotency-key");
    const account = headers.get("stripe-account");
    this.calls.push({ method, path: u.pathname, params, auth, idempotencyKey, account });
    const o = this.override?.(method, u.pathname);
    if (o) return o;
    const bearer = auth?.replace(/^Bearer /, "") ?? "";
    this.live = !!this.connect && /^(sk|rk)_live_/.test(bearer);
    // The account's own key, or the platform's key acting for this connected account (Stripe-Account).
    const own = this.keys.has(bearer);
    const viaPlatform = !!this.connect && account === this.connect.accountId && this.connect.platform.keys.has(bearer) && !this.connect.platform.deauthorized.has(this.connect.accountId);
    if (!own && !viaPlatform) {
      if (this.connect && account === this.connect.accountId && this.connect.platform.deauthorized.has(account)) return err(403, "The provided key does not have access to account '" + account + "' (or that account does not exist).", "account_invalid");
      return err(401, "Invalid API Key provided: rk_test_****0000");
    }
    if (idempotencyKey && method === "POST") {
      const prev = this.idem.get(idempotencyKey);
      if (prev) return prev.clone();
    }
    const res = this.route(method, u, params);
    if (idempotencyKey && method === "POST" && res.ok) this.idem.set(idempotencyKey, res.clone());
    return res;
  }) as typeof fetch;

  private route(method: string, u: URL, p: Obj): Response {
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["v1", resource, id, ...]
    const [, res, id, sub] = parts;
    const list = (data: unknown[]) => json(200, { object: "list", data, has_more: false, url: u.pathname });
    const expand = u.searchParams.getAll("expand[]");
    const missing = (what: string, x: string) => err(404, `No such ${what}: '${x}'`, "resource_missing");
    // Stripe's list paging: `active`, `limit` (default 10, at most 100) and `starting_after`.
    const page = (all: Obj[]) => {
      const active = u.searchParams.get("active");
      const rows = active === null ? all : all.filter((x) => String(x.active) === active);
      const limit = Math.min(100, Number(u.searchParams.get("limit") ?? 10) || 10);
      const after = u.searchParams.get("starting_after");
      const start = after ? rows.findIndex((x) => x.id === after) + 1 : 0;
      return json(200, { object: "list", data: rows.slice(start, start + limit), has_more: start + limit < rows.length, url: u.pathname });
    };

    if (res === "products") {
      if (method === "POST" && !id) {
        if (!p.name) return err(400, "Missing required param: name.", "parameter_missing", "name");
        const prod = { id: this.id("prod"), object: "product", active: true, created: this.now(), livemode: this.live, name: p.name, description: p.description ?? null, metadata: p.metadata ?? {}, default_price: null };
        this.products.set(prod.id, prod);
        return json(200, prod);
      }
      if (method === "GET" && id) return this.products.has(id) ? json(200, this.products.get(id)) : missing("product", id);
      if (method === "GET") return page([...this.products.values()]);
    }
    if (res === "prices") {
      if (method === "POST" && !id) {
        if (!p.product || !this.products.has(p.product)) return err(400, `No such product: '${p.product}'`, "resource_missing", "product");
        if (!p.currency) return err(400, "Missing required param: currency.", "parameter_missing", "currency");
        const price = {
          id: this.id("price"), object: "price", active: true, created: this.now(), livemode: this.live, currency: String(p.currency).toLowerCase(), product: p.product,
          unit_amount: Number(p.unit_amount), type: p.recurring ? "recurring" : "one_time", lookup_key: p.lookup_key ?? null, metadata: p.metadata ?? {},
          recurring: p.recurring ? { interval: p.recurring.interval, interval_count: Number(p.recurring.interval_count ?? 1), trial_period_days: null, usage_type: "licensed" } : null,
        };
        this.prices.set(price.id, price);
        return json(200, price);
      }
      if (method === "GET" && id) return this.prices.has(id) ? json(200, this.prices.get(id)) : missing("price", id);
      if (method === "GET") return page([...this.prices.values()].filter((x) => !u.searchParams.get("product") || x.product === u.searchParams.get("product")));
    }
    if (res === "coupons") {
      if (method === "POST" && !id) {
        if (!p.percent_off && !p.amount_off) return err(400, "You must specify either percent_off or amount_off.", "parameter_missing");
        if (p.duration === "repeating" && !p.duration_in_months) return err(400, "duration_in_months is required when duration is repeating.", "parameter_missing", "duration_in_months");
        const c = {
          id: p.id ?? this.id("cpn"), object: "coupon", created: this.now(), livemode: this.live, valid: true, times_redeemed: 0, name: p.name ?? null,
          percent_off: p.percent_off ? Number(p.percent_off) : null, amount_off: p.amount_off ? Number(p.amount_off) : null, currency: p.currency ?? null,
          currency_options: p.currency_options ?? null, duration: p.duration ?? "once", duration_in_months: p.duration_in_months ? Number(p.duration_in_months) : null,
          max_redemptions: p.max_redemptions ? Number(p.max_redemptions) : null, redeem_by: p.redeem_by ? Number(p.redeem_by) : null,
          applies_to: p.applies_to ? { products: p.applies_to.products ?? [] } : null, metadata: p.metadata ?? {},
        };
        this.coupons.set(c.id, c);
        return json(200, c);
      }
      if (id && method === "GET") return this.coupons.has(id) ? json(200, this.coupons.get(id)) : missing("coupon", id);
      if (id && method === "POST") {
        const c = this.coupons.get(id);
        if (!c) return missing("coupon", id);
        if (p.name !== undefined) c.name = p.name;
        if (p.metadata) c.metadata = { ...c.metadata, ...p.metadata };
        return json(200, c);
      }
      if (id && method === "DELETE") {
        if (!this.coupons.delete(id)) return missing("coupon", id);
        return json(200, { id, object: "coupon", deleted: true });
      }
    }
    if (res === "promotion_codes") {
      if (method === "POST" && !id) {
        // API 2025-09-30 moved the coupon under `promotion`; both shapes are accepted.
        const couponId = p.coupon ?? p.promotion?.coupon;
        if (!couponId || !this.coupons.has(couponId)) return err(400, `No such coupon: '${couponId}'`, "resource_missing", "coupon");
        if ([...this.promotionCodes.values()].some((x) => x.active && String(x.code).toUpperCase() === String(p.code).toUpperCase()))
          return err(400, "An active promotion code with `code: " + p.code + "` already exists.", "resource_already_exists", "code");
        const pc = {
          id: this.id("promo"), object: "promotion_code", active: p.active === undefined ? true : p.active === "true", code: p.code, coupon: this.coupons.get(couponId),
          created: this.now(), livemode: this.live, max_redemptions: p.max_redemptions ? Number(p.max_redemptions) : null, expires_at: p.expires_at ? Number(p.expires_at) : null,
          times_redeemed: 0, metadata: p.metadata ?? {}, restrictions: { first_time_transaction: p.restrictions?.first_time_transaction === "true" },
        };
        this.promotionCodes.set(pc.id, pc);
        return json(200, pc);
      }
      if (id && method === "POST") {
        const pc = this.promotionCodes.get(id);
        if (!pc) return missing("promotion_code", id);
        if (p.active !== undefined) pc.active = p.active === "true";
        return json(200, pc);
      }
      if (id && method === "GET") return this.promotionCodes.has(id) ? json(200, this.promotionCodes.get(id)) : missing("promotion_code", id);
    }
    if (res === "checkout" && id === "sessions") {
      const sid = sub;
      if (method === "POST" && !sid) return this.createSession(p);
      if (method === "GET" && !sid) return list([...this.sessions.values()].slice(0, 1));
      if (method === "GET" && sid) {
        const s = this.sessions.get(sid);
        if (!s) return missing("checkout.session", sid);
        const out = { ...s };
        if (!expand.includes("line_items")) delete out.line_items;
        return json(200, out);
      }
    }
    if (res === "subscriptions") {
      if (method === "GET" && !id) return list([...this.subscriptions.values()].slice(0, 1));
      if (method === "GET" && id) {
        const sub0 = this.subscriptions.get(id);
        if (!sub0) return missing("subscription", id);
        const out = { ...sub0 };
        if (expand.includes("latest_invoice") && typeof out.latest_invoice === "string") out.latest_invoice = this.invoices.get(out.latest_invoice) ?? out.latest_invoice;
        return json(200, out);
      }
    }
    if (res === "invoices" && id && method === "GET") return this.invoices.has(id) ? json(200, this.invoices.get(id)) : missing("invoice", id);
    if (res === "customers" && id && method === "GET") return this.customers.has(id) ? json(200, this.customers.get(id)) : missing("customer", id);
    if (res === "billing_portal" && id === "sessions" && method === "POST") {
      if (!this.portalConfigured) return err(400, "No configuration provided and your test mode default configuration has not been created. Provide a configuration or create your default by saving your customer portal settings in test mode at https://dashboard.stripe.com/test/settings/billing/portal.");
      if (!p.customer || !this.customers.has(p.customer)) return err(400, `No such customer: '${p.customer}'`, "resource_missing", "customer");
      const sid = this.id("bps");
      const ps = { id: sid, object: "billing_portal.session", customer: p.customer, return_url: p.return_url ?? null, flow: p.flow_data ? { type: p.flow_data.type } : null, livemode: this.live, created: this.now(), url: this.portalUrl.replace("{id}", sid) };
      this.portalSessions.set(sid, ps);
      return json(200, ps);
    }
    if (res === "invoice_payments") return list([]);
    return err(404, `Unrecognized request URL (${method}: ${u.pathname}).`);
  }

  private createSession(p: Obj): Response {
    const items: Obj[] = Array.isArray(p.line_items) ? p.line_items : [];
    if (!items.length) return err(400, "line_items is required.", "parameter_missing", "line_items");
    if (!p.success_url) return err(400, "Missing required param: success_url.", "parameter_missing", "success_url");
    const priceObjs = items.map((i) => this.prices.get(i.price));
    if (priceObjs.some((x) => !x)) return err(400, `No such price: '${items.find((i) => !this.prices.get(i.price))!.price}'`, "resource_missing", "line_items[0][price]");
    if (p.mode === "subscription" && priceObjs.some((x) => x!.type !== "recurring")) return err(400, "You must provide at least one recurring price in `subscription` mode.", "checkout_session_invalid_mode");
    if (p.mode === "payment" && priceObjs.some((x) => x!.type === "recurring")) return err(400, "You specified `payment` mode but passed a recurring price.", "checkout_session_invalid_mode");
    const discount = Array.isArray(p.discounts) ? p.discounts[0] : null;
    if (discount?.promotion_code) {
      const pc = this.promotionCodes.get(discount.promotion_code);
      if (!pc || !pc.active) return err(400, "This promotion code is not active.", "promotion_code_invalid");
    }
    if (discount?.coupon && !this.coupons.has(discount.coupon)) return err(400, `No such coupon: '${discount.coupon}'`, "resource_missing");
    const id = this.id("cs");
    const s: Obj = {
      id, object: "checkout.session", mode: p.mode, status: "open", payment_status: "unpaid", livemode: this.live, created: this.now(),
      url: this.checkoutUrl.replace("{id}", id), success_url: String(p.success_url).replace("{CHECKOUT_SESSION_ID}", id), cancel_url: p.cancel_url ?? null,
      client_reference_id: p.client_reference_id ?? null, customer: null, customer_email: p.customer_email ?? null, customer_details: null,
      metadata: p.metadata ?? {}, subscription: null, payment_intent: null, currency: priceObjs[0]!.currency, discounts: discount ? [discount] : [],
      amount_total: null, subscription_data: p.subscription_data ?? null, expires_at: this.now() + 86400,
      line_items: { object: "list", has_more: false, data: items.map((i, n) => ({ id: `li_${n}`, object: "item", price: priceObjs[n], quantity: Number(i.quantity ?? 1), currency: priceObjs[n]!.currency, amount_total: priceObjs[n]!.unit_amount * Number(i.quantity ?? 1) })) },
    };
    this.sessions.set(id, s);
    return json(200, s);
  }

  /** The amount after the session's discount, in minor units. */
  private discounted(s: Obj, amount: number, currency: string): number {
    const d = s.discounts?.[0];
    const coupon = d?.promotion_code ? this.promotionCodes.get(d.promotion_code)?.coupon : d?.coupon ? this.coupons.get(d.coupon) : null;
    if (!coupon) return amount;
    if (coupon.percent_off) return Math.round(amount * (1 - coupon.percent_off / 100));
    const off = coupon.currency === currency ? coupon.amount_off : coupon.currency_options?.[currency]?.amount_off;
    return Math.max(0, amount - Number(off ?? 0));
  }

  /** The customer pays on the checkout page: a subscription (with a paid first invoice) or a paid one-time payment. */
  complete(sessionId: string, o: { email?: string; country?: string } = {}): Obj {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    if (s.status === "complete") return s;
    const now = this.now();
    const customer = this.id("cus");
    const item = s.line_items.data[0];
    const price = item.price;
    const amount = this.discounted(s, price.unit_amount * item.quantity, price.currency);
    s.customer = customer;
    s.customer_details = { email: o.email ?? s.customer_email ?? "buyer@example.com", address: { country: o.country ?? "US" }, name: null };
    this.customers.set(customer, { id: customer, object: "customer", email: s.customer_details.email, livemode: !!s.livemode, created: now });
    s.amount_total = amount;
    item.amount_total = amount;
    const promo = s.discounts?.[0]?.promotion_code;
    if (promo) { const pc = this.promotionCodes.get(promo); if (pc) { pc.times_redeemed++; pc.coupon.times_redeemed++; } }
    if (s.mode === "subscription") {
      const subId = this.id("sub");
      const invId = this.id("in");
      const trialDays = Number(s.subscription_data?.trial_period_days ?? 0);
      const unit = price.recurring.interval as string, count = price.recurring.interval_count as number;
      const secs = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 }[unit] ?? 30 * 86400;
      const end = trialDays ? now + trialDays * 86400 : now + secs * count;
      const paid = trialDays ? 0 : amount;
      this.invoices.set(invId, {
        id: invId, object: "invoice", status: "paid", paid: true, amount_paid: paid, amount_due: paid, total: paid, currency: price.currency,
        billing_reason: "subscription_create", subscription: subId, customer, customer_address: { country: o.country ?? "US" }, livemode: !!s.livemode,
        period_start: now, period_end: now, status_transitions: { paid_at: now }, lines: { data: [{ period: { start: now, end }, price }] },
      });
      this.subscriptions.set(subId, {
        id: subId, object: "subscription", status: trialDays ? "trialing" : "active", livemode: !!s.livemode, customer, created: now, start_date: now,
        current_period_start: now, current_period_end: end, trial_start: trialDays ? now : null, trial_end: trialDays ? end : null,
        cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, cancellation_details: { reason: null }, pause_collection: null,
        currency: price.currency, metadata: { ...(s.subscription_data?.metadata ?? {}) }, latest_invoice: invId,
        items: { object: "list", data: [{ id: this.id("si"), price, quantity: item.quantity }] }, discount: s.discounts?.[0] ?? null,
      });
      s.subscription = subId;
    } else {
      s.payment_intent = this.id("pi");
    }
    s.status = "complete";
    s.payment_status = "paid";
    return s;
  }

  /**
   * The renewal charge fails: the subscription moves to its next period unpaid (`past_due`), with an open invoice Stripe will
   * retry at `next_payment_attempt` (a few days later). Returns the open invoice.
   */
  failRenewal(subId: string, o: { retryInDays?: number; /** The failed period's start (unix seconds); default the current period end. */ startAt?: number } = {}): Obj {
    const sub = this.subscriptions.get(subId);
    if (!sub) throw new Error(`no subscription ${subId}`);
    const now = this.now();
    const item = sub.items.data[0];
    const price = item.price;
    const secs = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 }[price.recurring.interval as string] ?? 30 * 86400;
    const start = o.startAt ?? (sub.current_period_end as number);
    const end = start + secs * price.recurring.interval_count;
    const invId = this.id("in");
    const amount = price.unit_amount * (item.quantity ?? 1);
    const inv = {
      id: invId, object: "invoice", status: "open", paid: false, amount_paid: 0, amount_due: amount, total: amount, currency: price.currency,
      billing_reason: "subscription_cycle", subscription: subId, customer: sub.customer, customer_address: { country: "US" }, livemode: sub.livemode,
      period_start: start, period_end: start, next_payment_attempt: now + (o.retryInDays ?? 3) * 86400, attempt_count: 1, status_transitions: { paid_at: null },
      hosted_invoice_url: `https://invoice.stripe.com/i/${invId}`, lines: { data: [{ period: { start, end }, price }] },
    };
    this.invoices.set(invId, inv);
    Object.assign(sub, { status: "past_due", current_period_start: start, current_period_end: end, latest_invoice: invId, trial_end: sub.trial_end && sub.trial_end > start ? sub.trial_end : sub.trial_end });
    return inv;
  }

  /** The customer fixed their card and Stripe's retry (or the hosted invoice page) collected the open invoice. */
  payInvoice(invId: string): Obj {
    const inv = this.invoices.get(invId);
    if (!inv) throw new Error(`no invoice ${invId}`);
    const now = this.now();
    Object.assign(inv, { status: "paid", paid: true, amount_paid: inv.amount_due, next_payment_attempt: null, status_transitions: { paid_at: now } });
    const sub = typeof inv.subscription === "string" ? this.subscriptions.get(inv.subscription) : null;
    if (sub) sub.status = "active";
    return inv;
  }

  /** A Stripe event of `type` about `object` (to sign and post to a webhook endpoint). */
  event(type: string, object: Obj, extra: Obj = {}): Obj {
    return { id: this.id("evt"), object: "event", api_version: "2024-06-20", created: this.now(), livemode: !!object.livemode, type, data: { object: { ...object } }, pending_webhooks: 1, ...(this.connect ? { account: this.connect.accountId } : {}), ...extra };
  }

  /** A `checkout.session.completed` event for a completed session (to sign and post to the webhook endpoint). */
  completedEvent(sessionId: string): Obj {
    const s = this.sessions.get(sessionId)!;
    const { line_items: _, ...object } = s;
    return { id: this.id("evt"), object: "event", api_version: "2024-06-20", created: this.now(), livemode: !!s.livemode, type: "checkout.session.completed", data: { object }, pending_webhooks: 1, ...(this.connect ? { account: this.connect.accountId } : {}) };
  }

  static minor(amount: number, currency: string) { return ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(amount) : Math.round(amount * 100); }
}

/* ---------- Stripe Connect (prd/web-billing/PRD.md §8) ---------- */

export const FAKE_CONNECT_CLIENT_ID = "ca_FakeOnlyRevenueDotConnect0000";
export const FAKE_PLATFORM_KEY = "sk_live_fake-only-revenuedot-platform";
export const FAKE_PLATFORM_TEST_KEY = "sk_test_fake-only-revenuedot-platform";
export const FAKE_CONNECT_WHSEC = "whsec_fakeonlyrevenuedotconnectsecret00";

/**
 * A fake of RevenueDot's Stripe Connect platform: OAuth (`connect.stripe.com/oauth/token` and `/deauthorize`), platform
 * calls (`/v1/accounts`, `/v1/account_links`), and connected accounts, each a FakeStripeAccount that the platform's keys
 * reach with `Stripe-Account`. `approve(...)` stands in for the developer clicking "Connect" on Stripe's page.
 * It never calls Stripe.
 */
export class FakeStripePlatform {
  keys = new Set([FAKE_PLATFORM_KEY, FAKE_PLATFORM_TEST_KEY]);
  clientId = FAKE_CONNECT_CLIENT_ID;
  accounts = new Map<string, FakeStripeAccount>();
  accountInfo = new Map<string, Obj>();
  codes = new Map<string, { account: string; used: boolean }>();
  deauthorized = new Set<string>();
  calls: Array<{ host: string; method: string; path: string; params: Obj; auth: string | null; account: string | null }> = [];
  override: ((method: string, path: string) => Response | undefined) | null = null;
  /** Where the onboarding page of an account link lives; `{account}` is the account id. */
  onboardingUrl = "https://connect.stripe.com/setup/s/{account}";
  /** Checkout and portal page URLs for new connected accounts (the e2e server and journeys serve fake pages). */
  accountDefaults: { checkoutUrl?: string; portalUrl?: string } = {};
  clock: () => Date = () => new Date();
  private seq = 0;

  /** A connected account (a new one, or `id`'s) with its own fake data. */
  account(id?: string, o: { email?: string; chargesEnabled?: boolean } = {}): FakeStripeAccount {
    const acct = id ?? `acct_1Fake${(++this.seq).toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 10)}`;
    let a = this.accounts.get(acct);
    if (!a) {
      a = new FakeStripeAccount();
      a.keys = new Set();
      a.connect = { accountId: acct, platform: this };
      a.clock = () => this.clock();
      if (this.accountDefaults.checkoutUrl) a.checkoutUrl = this.accountDefaults.checkoutUrl;
      if (this.accountDefaults.portalUrl) a.portalUrl = this.accountDefaults.portalUrl;
      this.accounts.set(acct, a);
      this.accountInfo.set(acct, { id: acct, object: "account", type: "standard", email: o.email ?? "owner@example.com", charges_enabled: o.chargesEnabled ?? true, details_submitted: o.chargesEnabled ?? true, livemode: false });
    }
    return a;
  }

  /** The developer approves the connection on Stripe's page: Stripe redirects to `redirect_uri` with a code and the state. */
  approve(authorizeUrl: string, accountId?: string): { redirect: string; account: string } {
    const u = new URL(authorizeUrl);
    if (u.searchParams.get("client_id") !== this.clientId) throw new Error(`unknown client_id ${u.searchParams.get("client_id")}`);
    const account = this.account(accountId).connect!.accountId;
    this.deauthorized.delete(account);
    const code = `ac_${Math.random().toString(36).slice(2, 14)}`;
    this.codes.set(code, { account, used: false });
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", u.searchParams.get("state")!);
    return { redirect: back.toString(), account };
  }

  /** The developer cancels on Stripe's page. */
  deny(authorizeUrl: string): string {
    const u = new URL(authorizeUrl);
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "The user denied your request");
    back.searchParams.set("state", u.searchParams.get("state")!);
    return back.toString();
  }

  /** An event on a connected account, as Stripe sends it to the platform's Connect endpoint (with `account`). */
  connectEvent(account: string, type: string, object: Obj): Obj {
    return { id: `evt_c${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 10)}`, object: "event", api_version: "2024-06-20", created: Math.floor(this.clock().getTime() / 1000), livemode: !!object.livemode, type, account, data: { object }, pending_webhooks: 1 };
  }

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    const auth = headers.get("authorization");
    const account = headers.get("stripe-account");
    const params = method === "POST" ? parseStripeForm(typeof init.body === "string" ? init.body : "") : Object.fromEntries(u.searchParams);
    this.calls.push({ host: u.host, method, path: u.pathname, params, auth, account });
    const o = this.override?.(method, u.pathname);
    if (o) return o;
    const bearer = auth?.replace(/^Bearer /, "") ?? "";
    if (u.host === "connect.stripe.com") {
      if (!this.keys.has(bearer)) return json(401, { error: "invalid_client", error_description: "No such api key." });
      if (u.pathname === "/oauth/token") {
        const c = this.codes.get(params.code);
        if (params.grant_type !== "authorization_code" || !c || c.used) return json(400, { error: "invalid_grant", error_description: `Authorization code does not exist: ${params.code}` });
        c.used = true;
        return json(200, { access_token: `sk_test_conn${Math.random().toString(36).slice(2, 12)}`, livemode: !bearer.startsWith("sk_test_"), refresh_token: "rt_fake", scope: "read_write", stripe_publishable_key: "pk_test_fake", stripe_user_id: c.account, token_type: "bearer" });
      }
      if (u.pathname === "/oauth/deauthorize") {
        if (params.client_id !== this.clientId) return json(400, { error: "invalid_client", error_description: "No such application" });
        if (!this.accounts.has(params.stripe_user_id) || this.deauthorized.has(params.stripe_user_id)) return json(400, { error: "invalid_client", error_description: `No such application: '${this.clientId}' is not connected to ${params.stripe_user_id}` });
        this.deauthorized.add(params.stripe_user_id);
        return json(200, { stripe_user_id: params.stripe_user_id });
      }
      return json(404, { error: "not_found" });
    }
    if (u.host !== "api.stripe.com") throw new Error(`FakeStripePlatform does not serve ${url}`);
    if (account) {
      const a = this.accounts.get(account);
      if (!a) return err(403, `The provided key does not have access to account '${account}' (or that account does not exist).`, "account_invalid");
      return a.fetch(url, init);
    }
    if (!this.keys.has(bearer)) return err(401, "Invalid API Key provided: sk_live_****0000");
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[1] === "accounts" && method === "POST" && !parts[2]) {
      const a = this.account(undefined, { email: params.email, chargesEnabled: false });
      return json(200, this.accountInfo.get(a.connect!.accountId));
    }
    if (parts[1] === "accounts" && method === "GET" && parts[2]) {
      const info = this.accountInfo.get(parts[2]);
      return info && !this.deauthorized.has(parts[2]) ? json(200, info) : err(403, `The provided key does not have access to account '${parts[2]}'.`, "account_invalid");
    }
    if (parts[1] === "account_links" && method === "POST") {
      if (!params.account || !this.accountInfo.has(params.account)) return err(400, `No such account: '${params.account}'`, "resource_missing", "account");
      if (!params.return_url || !params.refresh_url) return err(400, "Missing required param: return_url.", "parameter_missing");
      return json(200, { object: "account_link", created: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + 300, url: this.onboardingUrl.replace("{account}", params.account) });
    }
    return err(404, `Unrecognized request URL (${method}: ${u.pathname}).`);
  }) as typeof fetch;

  /** Every account this fake knows that holds `pick`: the developer's own (`own`) first, then the connected ones. */
  find<T>(own: FakeStripeAccount | null, pick: (a: FakeStripeAccount) => T | undefined): { account: FakeStripeAccount; value: T } | null {
    for (const a of [...(own ? [own] : []), ...this.accounts.values()]) { const v = pick(a); if (v !== undefined) return { account: a, value: v }; }
    return null;
  }

  /** The developer finished Stripe's onboarding for an account created through Account Links. */
  finishOnboarding(account: string) {
    const info = this.accountInfo.get(account);
    if (info) Object.assign(info, { charges_enabled: true, details_submitted: true });
    return info;
  }
}
