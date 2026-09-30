// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a RevenueCat project as API v2 objects (our own test data, shaped like RevenueCat's OpenAPI responses).
// Docs: https://revenuedot.app/docs/migrate
import type { RcModel } from "./fake-revenuecat.js";

/** The contract harness clock. */
export const T0 = Date.parse("2026-09-01T12:00:00Z");
export const DAY = 86_400_000;
export const PROJECT = "projRC1234";
export const ANON = "$RCAnonymousID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const at = (days: number) => T0 + days * DAY;
const usd = (gross: number) => ({ currency: "USD", gross, commission: Math.round(gross * 30) / 100, tax: 0, proceeds: Math.round(gross * 70) / 100 });

const app = (id: string, name: string, type: string, block: Record<string, unknown> | null) => ({
  object: "app", id, name, created_at: at(-400), type, project_id: PROJECT, custom_url_scheme: `rc-${id.slice(5)}`, ...(block ? { [type]: block } : {}),
});
const product = (id: string, app_id: string, store_identifier: string, type: string, extra: Record<string, unknown> = {}) => ({
  object: "product", id, store_identifier, type, state: "active", app_id, display_name: store_identifier, created_at: at(-399),
  ...(type === "subscription" ? { subscription: { duration: store_identifier.includes("annual") ? "P1Y" : "P1M", grace_period_duration: null, trial_duration: null } } : {}),
  ...(type === "consumable" || type === "non_consumable" ? { one_time: { is_consumable: type === "consumable" } } : {}),
  ...extra,
});
const customer = (id: string, first: number, extra: Record<string, unknown> = {}) => ({
  object: "customer", id, project_id: PROJECT, first_seen_at: at(first), last_seen_at: at(-1), last_seen_app_version: "2.4.0",
  last_seen_country: "US", last_seen_platform: "iOS", last_seen_platform_version: "18.2", experiment: null,
  aliases: [{ object: "customer.alias", id, created_at: at(first) }], attributes: [] as any[], active: [] as any[], subscriptions: [] as any[], purchases: [] as any[],
  ...extra,
});
const active = (entitlement_id: string, expires_at: number | null) => ({ object: "customer.active_entitlement", entitlement_id, expires_at });
const sub = (id: string, customer_id: string, o: Record<string, any>) => ({
  object: "subscription", id, customer_id, original_customer_id: customer_id, product_id: o.product_id ?? null,
  starts_at: o.starts_at, current_period_starts_at: o.current_period_starts_at, current_period_ends_at: o.current_period_ends_at, ends_at: o.current_period_ends_at,
  gives_access: o.gives_access ?? true, pending_payment: false, auto_renewal_status: o.auto_renewal_status ?? "will_renew", status: o.status ?? "active",
  total_revenue_in_usd: usd(o.revenue ?? 0), presented_offering_id: null, environment: o.environment ?? "production", store: o.store,
  store_subscription_identifier: o.store_subscription_identifier, ownership: "purchased", country: "US", management_url: null,
  entitlement_ids: o.entitlement_ids ?? ["entl_pro"], transactions: o.transactions,
});
const tx = (id: string, purchased_at: number, product: string, expiration_date: number, gross = 9.99, effective?: number) => ({
  object: "subscription_transaction", id, purchased_at, product_store_identifier: product, revenue_in_local_currency: usd(gross), revenue_in_usd: usd(gross),
  expiration_date, effective_expiration_date: effective ?? expiration_date,
});

/** A fresh copy of the source project for each test. */
export function rcModel(): RcModel {
  return {
    project: PROJECT,
    apps: [
      app("appa_ios", "Scanner iOS", "app_store", { bundle_id: "com.example.scanner", subscription_key_configured: true, app_store_connect_api_key_configured: false }),
      app("appa_play", "Scanner Android", "play_store", { package_name: "com.example.scanner", play_service_account_credentials_configured: true }),
      app("appa_new", "Scanner Pro iOS", "app_store", { bundle_id: "com.example.scannerpro", subscription_key_configured: false, app_store_connect_api_key_configured: false }),
      app("appa_stripe", "Scanner Web", "stripe", { stripe_account_id: "acct_123" }),
      app("appa_test", "Test Store", "test_store", null),
    ],
    publicKeys: {
      appa_ios: [{ object: "public_api_key", id: "pk_ios", key: "appl_RCiosShippedKey", environment: "production", app_id: "appa_ios", created_at: at(-400) }],
      appa_play: [{ object: "public_api_key", id: "pk_play", key: "goog_RCplayShippedKey", environment: "production", app_id: "appa_play", created_at: at(-400) }],
      appa_new: [{ object: "public_api_key", id: "pk_new", key: "appl_RCnewShippedKey", environment: "production", app_id: "appa_new", created_at: at(-400) }],
    },
    products: [
      product("prod_ios_m", "appa_ios", "pro_monthly", "subscription"),
      product("prod_ios_y", "appa_ios", "pro_annual", "subscription"),
      product("prod_ios_life", "appa_ios", "lifetime", "non_consumable"),
      product("prod_ios_coins", "appa_ios", "coins_100", "consumable"),
      product("prod_ios_old", "appa_ios", "old_monthly", "subscription", { state: "inactive" }),
      product("prod_play_m", "appa_play", "pro:monthly", "subscription"),
      product("prod_new_m", "appa_new", "pro_monthly", "subscription"),
      product("prod_stripe", "appa_stripe", "prod_WebPro", "subscription"),
      product("prod_test_m", "appa_test", "pro_monthly", "subscription"),
    ],
    entitlements: [
      { object: "entitlement", id: "entl_pro", project_id: PROJECT, lookup_key: "pro", display_name: "Pro access", created_at: at(-398), state: "active",
        product_ids: ["prod_ios_m", "prod_ios_y", "prod_ios_life", "prod_play_m", "prod_new_m", "prod_stripe", "prod_test_m"] },
      { object: "entitlement", id: "entl_extra", project_id: PROJECT, lookup_key: "extra", display_name: "Extra storage", created_at: at(-397), state: "active", product_ids: [] },
    ],
    offerings: [
      { object: "offering", id: "ofrng_default", lookup_key: "default", display_name: "The standard set of packages", is_current: false, created_at: at(-396), project_id: PROJECT, state: "active", metadata: null, paywall_id: null,
        packages: [
          { object: "package", id: "pkge_m", lookup_key: "$rc_monthly", display_name: "Monthly", position: 0, created_at: at(-396), products: [{ product_id: "prod_ios_m", eligibility_criteria: "all" }, { product_id: "prod_play_m", eligibility_criteria: "all" }, { product_id: "prod_new_m", eligibility_criteria: "all" }] },
          { object: "package", id: "pkge_y", lookup_key: "$rc_annual", display_name: "Annual", position: 1, created_at: at(-396), products: [{ product_id: "prod_ios_y", eligibility_criteria: "all" }] },
          { object: "package", id: "pkge_l", lookup_key: "$rc_lifetime", display_name: "Lifetime", position: 2, created_at: at(-396), products: [{ product_id: "prod_ios_life", eligibility_criteria: "all" }] },
        ] },
      { object: "offering", id: "ofrng_sale", lookup_key: "sale", display_name: "Autumn sale", is_current: true, created_at: at(-30), project_id: PROJECT, state: "active", metadata: { discount: 50, headline: "Half price" }, paywall_id: null,
        packages: [{ object: "package", id: "pkge_sale_y", lookup_key: "$rc_annual", display_name: "Annual", position: 0, created_at: at(-30), products: [{ product_id: "prod_ios_y", eligibility_criteria: "all" }] }] },
    ],
    customers: [
      customer("user_apple", -120, {
        aliases: [{ object: "customer.alias", id: "user_apple", created_at: at(-100) }, { object: "customer.alias", id: ANON, created_at: at(-120) }],
        attributes: [{ object: "customer.attribute", name: "$email", value: "apple@example.com", updated_at: at(-100) }, { object: "customer.attribute", name: "plan", value: "gold", updated_at: at(-50) }],
        active: [active("entl_pro", at(25))],
        subscriptions: [sub("sub_apple", "user_apple", {
          product_id: "prod_ios_m", store: "app_store", starts_at: at(-65), current_period_starts_at: at(-5), current_period_ends_at: at(25), revenue: 29.97,
          store_subscription_identifier: "2000000003",
          transactions: [tx("2000000001", at(-65), "pro_monthly", at(-35)), tx("2000000002", at(-35), "pro_monthly", at(-5)), tx("2000000003", at(-5), "pro_monthly", at(25))],
        })],
      }),
      customer("user_expired", -500, {
        subscriptions: [sub("sub_expired", "user_expired", {
          product_id: "prod_ios_y", store: "app_store", starts_at: at(-400), current_period_starts_at: at(-400), current_period_ends_at: at(-35), revenue: 59.99,
          status: "expired", auto_renewal_status: "will_not_renew", gives_access: false, store_subscription_identifier: "3000000001",
          transactions: [tx("3000000001", at(-400), "pro_annual", at(-35), 59.99)],
        })],
      }),
      customer("user_play_token", -40, {
        last_seen_platform: "Android", active: [active("entl_pro", at(20))],
        subscriptions: [sub("sub_play1", "user_play_token", {
          product_id: "prod_play_m", store: "play_store", starts_at: at(-40), current_period_starts_at: at(-10), current_period_ends_at: at(20), revenue: 19.98,
          store_subscription_identifier: "GPA.1111-2222-3333-44444..0",
          transactions: [tx("GPA.1111-2222-3333-44444", at(-40), "pro:monthly", at(-10)), tx("GPA.1111-2222-3333-44444..0", at(-10), "pro:monthly", at(20))],
        })],
      }),
      customer("user_play_notoken", -15, {
        last_seen_platform: "Android", active: [active("entl_pro", at(15))],
        subscriptions: [sub("sub_play2", "user_play_notoken", {
          product_id: "prod_play_m", store: "play_store", starts_at: at(-15), current_period_starts_at: at(-15), current_period_ends_at: at(15), revenue: 9.99,
          store_subscription_identifier: "GPA.5555-6666-7777-88888", transactions: [tx("GPA.5555-6666-7777-88888", at(-15), "pro:monthly", at(15))],
        })],
      }),
      customer("user_promo", -10, {
        active: [active("entl_extra", at(29))],
        subscriptions: [sub("sub_promo", "user_promo", {
          product_id: null, store: "promotional", starts_at: at(-1), current_period_starts_at: at(-1), current_period_ends_at: at(29),
          auto_renewal_status: "will_not_renew", store_subscription_identifier: "promo_abc", entitlement_ids: ["entl_extra"],
        })],
      }),
      customer("user_lifetime", -9, {
        active: [active("entl_pro", null)],
        purchases: [
          { object: "purchase", id: "purch_life", customer_id: "user_lifetime", original_customer_id: "user_lifetime", product_id: "prod_ios_life", purchased_at: at(-3), revenue_in_usd: usd(49.99), quantity: 1, status: "owned", presented_offering_id: null, entitlement_ids: ["entl_pro"], environment: "production", store: "app_store", store_purchase_identifier: "4000000001", ownership: "purchased", country: "US" },
          { object: "purchase", id: "purch_coins", customer_id: "user_lifetime", original_customer_id: "user_lifetime", product_id: "prod_ios_coins", purchased_at: at(-4), revenue_in_usd: usd(0.99), quantity: 1, status: "refunded", presented_offering_id: null, entitlement_ids: [], environment: "production", store: "app_store", store_purchase_identifier: "4000000002", ownership: "purchased", country: "US" },
        ],
      }),
      customer("user_grace", -70, {
        active: [active("entl_pro", at(5))],
        subscriptions: [sub("sub_grace", "user_grace", {
          product_id: "prod_ios_m", store: "app_store", starts_at: at(-61), current_period_starts_at: at(-31), current_period_ends_at: at(-1), revenue: 19.98,
          status: "in_grace_period", store_subscription_identifier: "7000000002",
          transactions: [tx("7000000001", at(-61), "pro_monthly", at(-31)), tx("7000000002", at(-31), "pro_monthly", at(-1), 9.99, at(5))],
        })],
      }),
      customer("user_sandbox", -2, {
        active: [active("entl_pro", at(5))],
        subscriptions: [sub("sub_sandbox", "user_sandbox", {
          product_id: "prod_ios_m", store: "app_store", environment: "sandbox", starts_at: at(-2), current_period_starts_at: at(-2), current_period_ends_at: at(5),
          status: "trialing", store_subscription_identifier: "8000000001", transactions: [tx("8000000001", at(-2), "pro_monthly", at(5), 0)],
        })],
      }),
      customer("user_stripe", -3, {
        last_seen_platform: "web", active: [active("entl_pro", at(27))],
        subscriptions: [sub("sub_stripe", "user_stripe", {
          product_id: "prod_stripe", store: "stripe", starts_at: at(-3), current_period_starts_at: at(-3), current_period_ends_at: at(27), revenue: 12,
          store_subscription_identifier: "sub_1StripeABC",
        })],
      }),
      customer("user_new_app", -1, {
        active: [active("entl_pro", at(29))],
        subscriptions: [sub("sub_new", "user_new_app", {
          product_id: "prod_new_m", store: "app_store", starts_at: at(-1), current_period_starts_at: at(-1), current_period_ends_at: at(29), revenue: 9.99,
          store_subscription_identifier: "6000000001", transactions: [tx("6000000001", at(-1), "pro_monthly", at(29))],
        })],
      }),
      ...[1, 2, 3, 4].map((i) => customer(`user_plain_${i}`, -i)),
    ] as RcModel["customers"],
  };
}

export const TOKENS_CSV = "app_user_id,product_id,order_id,purchase_token\nuser_play_token,pro:monthly,GPA.1111-2222-3333-44444,tok_play_1\n";
