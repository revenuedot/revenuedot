import { sql } from "drizzle-orm";
import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const ts = (n: string) => timestamp(n, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();

/** A project groups apps across stores that share one catalog and one set of customers. */
export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** What happens when a receipt already owned by another non-anonymous user is posted. */
  transferBehavior: text("transfer_behavior").notNull().default("transfer"),
  sandboxTransferBehavior: text("sandbox_transfer_behavior"),
  /** Customer Center configuration (appearance, screens, support, localization) merged over the built-in default. */
  customerCenter: jsonb("customer_center").$type<Record<string, unknown>>(),
  /** Refund Control settings: { default_preference, customer_consented } (prd/lifecycle/PRD.md). */
  refundSettings: jsonb("refund_settings").$type<{ default_preference?: string; customer_consented?: boolean }>(),
  createdAt: created(),
});

/** One app per store. `publicKey` is what the SDK sends as its API key (appl_, goog_, rcb_, test_ ...). */
export const apps = pgTable("apps", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  bundleId: text("bundle_id"),
  publicKey: text("public_key").notNull(),
  /** Store credentials (App Store in-app purchase key, Google service account, shared secret). Encrypted at rest in the cloud. */
  credentials: jsonb("credentials").$type<Record<string, unknown>>().notNull().default({}),
  /**
   * Amazon and Stripe secrets (shared key, restricted key, webhook signing secret), sealed with AES-GCM like integration
   * secrets (services/secrets.ts); `secretHints` is what the dashboard may show (set, and a Stripe key's mode and last four).
   */
  secrets: text("secrets"),
  secretHints: jsonb("secret_hints").$type<Record<string, string>>().notNull().default({}),
  notificationForwardUrl: text("notification_forward_url"),
  /** Last notification that was processed for a purchase we know (what "Ready" in setup health means). */
  lastNotificationAt: ts("last_notification_at"),
  /** Google Play: when the daily voided-purchases scan last ran for this app. */
  voidedPurchasesCheckedAt: ts("voided_purchases_checked_at"),
  /** Whether the store accepted the credentials the last time we knew: "ok", "failing", or null (not checked yet). */
  credentialsStatus: text("credentials_status"),
  credentialsError: text("credentials_error"),
  credentialsCheckedAt: ts("credentials_checked_at"),
  /** App Store apps: Apple Retention Messaging configuration (messages, defaults, real-time rules); see services/retention.ts. */
  retentionMessaging: jsonb("retention_messaging").$type<Record<string, unknown>>(),
  createdAt: created(),
}, (t) => [uniqueIndex("apps_public_key").on(t.publicKey), index("apps_project").on(t.projectId)]);

/** Secret API keys (sk_...) for the REST API. Only the hash is stored. */
export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  version: integer("version").notNull().default(2),
  hash: text("hash").notNull(),
  prefix: text("prefix").notNull(),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  lastUsedAt: ts("last_used_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("api_keys_hash").on(t.hash)]);

/**
 * Subscriber access tokens from `POST /v2/projects/{id}/apps/{id}/authenticate`: short-lived, bound to one app and one app
 * user id, stored only as a SHA-256 hash. The SDK endpoints accept them in place of the app's public key.
 */
export const subscriberTokens = pgTable("subscriber_tokens", {
  hash: text("hash").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  appUserId: text("app_user_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: created(),
}, (t) => [index("subscriber_tokens_expiry").on(t.expiresAt)]);

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  storeIdentifier: text("store_identifier").notNull(),
  type: text("type").notNull().default("subscription"),
  displayName: text("display_name"),
  /** ISO 8601 period for subscriptions (P1W, P1M, P1Y); used by the Test Store and MRR normalisation. */
  duration: text("duration"),
  /** Test Store price (what the SDK shows for Test Store products); amount in micros of `test_store_price_currency`. */
  testStorePriceMicros: bigint("test_store_price_micros", { mode: "number" }),
  testStorePriceCurrency: text("test_store_price_currency"),
  state: text("state").notNull().default("active"),
  createdAt: created(),
}, (t) => [uniqueIndex("products_app_store_id").on(t.appId, t.storeIdentifier)]);

export const entitlements = pgTable("entitlements", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  lookupKey: text("lookup_key").notNull(),
  displayName: text("display_name").notNull(),
  state: text("state").notNull().default("active"),
  createdAt: created(),
}, (t) => [uniqueIndex("entitlements_lookup").on(t.projectId, t.lookupKey)]);

export const entitlementProducts = pgTable("entitlement_products", {
  entitlementId: text("entitlement_id").notNull().references(() => entitlements.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.entitlementId, t.productId] })]);

export const offerings = pgTable("offerings", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  lookupKey: text("lookup_key").notNull(),
  displayName: text("display_name").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  state: text("state").notNull().default("active"),
  createdAt: created(),
}, (t) => [uniqueIndex("offerings_lookup").on(t.projectId, t.lookupKey)]);

export const packages = pgTable("packages", {
  id: text("id").primaryKey(),
  offeringId: text("offering_id").notNull().references(() => offerings.id, { onDelete: "cascade" }),
  lookupKey: text("lookup_key").notNull(),
  displayName: text("display_name").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: created(),
}, (t) => [uniqueIndex("packages_lookup").on(t.offeringId, t.lookupKey)]);

export const packageProducts = pgTable("package_products", {
  packageId: text("package_id").notNull().references(() => packages.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  eligibilityCriteria: text("eligibility_criteria").notNull().default("all"),
}, (t) => [primaryKey({ columns: [t.packageId, t.productId] })]);

/** A customer. `id` is internal; the first app user id seen is `originalAppUserId`. */
export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  originalAppUserId: text("original_app_user_id").notNull(),
  firstSeen: ts("first_seen").notNull().defaultNow(),
  lastSeen: ts("last_seen").notNull().defaultNow(),
  lastSeenAppVersion: text("last_seen_app_version"),
  lastSeenPlatform: text("last_seen_platform"),
  lastSeenCountry: text("last_seen_country"),
  /** SDK headers of the customer's last request: X-Version, X-Platform-Flavor, X-Platform-Version, X-Client-Build-Version. */
  lastSeenSdkVersion: text("last_seen_sdk_version"),
  lastSeenSdkFlavor: text("last_seen_sdk_flavor"),
  lastSeenPlatformVersion: text("last_seen_platform_version"),
  lastSeenAppBuild: text("last_seen_app_build"),
  originalApplicationVersion: text("original_application_version"),
  originalPurchaseDate: ts("original_purchase_date"),
  /** Offering forced for this customer by the REST API (overrides the current offering). */
  offeringOverrideId: text("offering_override_id"),
}, (t) => [index("customers_project").on(t.projectId, t.lastSeen), index("customers_project_first_seen").on(t.projectId, t.firstSeen, t.id)]);

/** Every app user id that points at a customer (the original id is an alias too). */
export const customerAliases = pgTable("customer_aliases", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appUserId: text("app_user_id").notNull(),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.projectId, t.appUserId] }), index("aliases_customer").on(t.customerId)]);

export const customerAttributes = pgTable("customer_attributes", {
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value"),
  updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.customerId, t.key] })]);

/** Current state of one subscription chain (Apple original transaction id, Google purchase token). */
export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),
  store: text("store").notNull(),
  /** Stable store key for the chain: Apple original_transaction_id, Google purchase token, or a promotional id. */
  storeKey: text("store_key").notNull(),
  productIdentifier: text("product_identifier").notNull(),
  productPlanIdentifier: text("product_plan_identifier"),
  isSandbox: boolean("is_sandbox").notNull().default(false),
  purchaseDate: ts("purchase_date").notNull(),
  originalPurchaseDate: ts("original_purchase_date").notNull(),
  expiresDate: ts("expires_date"),
  periodType: text("period_type").notNull().default("normal"),
  ownershipType: text("ownership_type").notNull().default("PURCHASED"),
  unsubscribeDetectedAt: ts("unsubscribe_detected_at"),
  billingIssuesDetectedAt: ts("billing_issues_detected_at"),
  gracePeriodExpiresDate: ts("grace_period_expires_date"),
  refundedAt: ts("refunded_at"),
  autoResumeDate: ts("auto_resume_date"),
  storeTransactionId: text("store_transaction_id"),
  originalTransactionId: text("original_transaction_id"),
  priceAmount: doublePrecision("price_amount"),
  priceCurrency: text("price_currency"),
  priceUsd: doublePrecision("price_usd"),
  countryCode: text("country_code"),
  autoRenewProductId: text("auto_renew_product_id"),
  /** Promotional grants: the entitlement they unlock. */
  entitlementIdentifier: text("entitlement_identifier"),
  /** Why auto-renew is off when the store says more than "the customer turned it off": PRICE_INCREASE, DEVELOPER_INITIATED, BILLING_ERROR. */
  cancelReason: text("cancel_reason"),
  /** Price increase consent: "pending" (consent required, no answer yet), "accepted", or null (none outstanding). */
  priceIncreaseStatus: text("price_increase_status"),
  /** Set when EXPIRATION was recorded for the current period; cleared on renewal. */
  expiredEventAt: ts("expired_event_at"),
  /** Offering identifier the SDK sent with the purchase (presented_offering_identifier); the first one seen stays. */
  presentedOfferingId: text("presented_offering_id"),
  /** Google Play: the customer's answer to the cancel survey (`cancelSurveyResult.reason`), for the cancel reasons chart. */
  cancelSurveyReason: text("cancel_survey_reason"),
  /** Offer of the current period: free_trial, introductory, promotional, offer_code, win_back or unspecified (null: none). */
  offerType: text("offer_type"),
  /** The store's offer id (Apple offerIdentifier, Google offerId). */
  offerId: text("offer_id"),
  /** App Store: the win-back offers Apple says this customer may redeem (renewal info `eligibleWinBackOfferIds`), best first. */
  eligibleWinBackOfferIds: jsonb("eligible_win_back_offer_ids").$type<string[]>(),
  /** When `eligibleWinBackOfferIds` was last read from Apple. */
  winBackOffersAt: ts("win_back_offers_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("subscriptions_store_key").on(t.projectId, t.store, t.storeKey), index("subscriptions_customer").on(t.customerId), index("subscriptions_project_updated").on(t.projectId, t.updatedAt, t.id)]);

export const nonSubscriptions = pgTable("non_subscriptions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),
  store: text("store").notNull(),
  productIdentifier: text("product_identifier").notNull(),
  storeTransactionId: text("store_transaction_id").notNull(),
  isSandbox: boolean("is_sandbox").notNull().default(false),
  isConsumable: boolean("is_consumable").notNull().default(false),
  purchaseDate: ts("purchase_date").notNull(),
  refundedAt: ts("refunded_at"),
  priceAmount: doublePrecision("price_amount"),
  priceCurrency: text("price_currency"),
  priceUsd: doublePrecision("price_usd"),
  countryCode: text("country_code"),
  /** Offering identifier the SDK sent with the purchase (presented_offering_identifier). */
  presentedOfferingId: text("presented_offering_id"),
}, (t) => [uniqueIndex("non_subs_store_tx").on(t.projectId, t.store, t.storeTransactionId), index("non_subs_customer").on(t.customerId)]);

/** Every billing event (purchase, renewal, refund) for revenue charts and the transaction feed. */
export const transactions = pgTable("transactions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  appId: text("app_id"),
  store: text("store").notNull(),
  storeTransactionId: text("store_transaction_id").notNull(),
  productIdentifier: text("product_identifier").notNull(),
  kind: text("kind").notNull(),
  isSandbox: boolean("is_sandbox").notNull().default(false),
  purchasedAt: ts("purchased_at").notNull(),
  expiresAt: ts("expires_at"),
  revenueUsd: doublePrecision("revenue_usd").notNull().default(0),
  priceAmount: doublePrecision("price_amount"),
  priceCurrency: text("price_currency"),
  countryCode: text("country_code"),
  /** Offer used for this transaction (see subscriptions.offerType) and the store's offer id. */
  offerType: text("offer_type"),
  offerId: text("offer_id"),
  /** When RevenueDot recorded the row (incremental data exports read this; rows from before migration 0013 carry its run time). */
  createdAt: created(),
}, (t) => [uniqueIndex("transactions_store_tx").on(t.projectId, t.store, t.storeTransactionId, t.kind), index("transactions_time").on(t.projectId, t.purchasedAt), index("transactions_project_created").on(t.projectId, t.createdAt, t.id), index("transactions_customer").on(t.customerId, t.purchasedAt)]);

/** Customer lifecycle events; the source for webhooks and the customer history timeline. */
export const events = pgTable("events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  environment: text("environment").notNull(),
  appId: text("app_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  eventTimestampMs: bigint("event_timestamp_ms", { mode: "number" }).notNull(),
  createdAt: created(),
}, (t) => [index("events_project_time").on(t.projectId, t.eventTimestampMs), index("events_customer").on(t.customerId), index("events_project_created").on(t.projectId, t.createdAt, t.id)]);

export const webhooks = pgTable("webhooks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  authorizationHeader: text("authorization_header"),
  signingSecret: text("signing_secret").notNull(),
  environment: text("environment").notNull().default("both"),
  appId: text("app_id"),
  eventTypes: jsonb("event_types").$type<string[] | null>(),
  enabled: boolean("enabled").notNull().default(true),
  /** Delivery attempts in a row that failed; 0 after any success. 5 or more opens a "webhook failing" alert. */
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  createdAt: created(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  responseStatus: integer("response_status"),
  responseMs: integer("response_ms"),
  lastError: text("last_error"),
  createdAt: created(),
}, (t) => [index("deliveries_due").on(t.status, t.nextAttemptAt), uniqueIndex("deliveries_unique").on(t.webhookId, t.eventId)]);

/** Dashboard users. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  passwordHash: text("password_hash"),
  /** RevenueDot Cloud plan for this account. Every account is on "free" until billing plans ship (Tier 2). */
  plan: text("plan").notNull().default("free"),
  /** When the user proved they read this inbox (verification link, password reset or invite). Cloud gates secret keys and invites on it. */
  emailVerifiedAt: ts("email_verified_at"),
  /** Alert emails (failing notifications, webhooks, store credentials) for projects this user administers. */
  alertEmails: boolean("alert_emails").notNull().default(true),
  createdAt: created(),
}, (t) => [uniqueIndex("users_email").on(t.email)]);

/** A user's access to a project. `role`: "admin", "developer" or "viewer". */
export const memberships = pgTable("memberships", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("admin"),
}, (t) => [primaryKey({ columns: [t.userId, t.projectId] })]);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
});

/**
 * Which SDK builds call the SDK endpoints, per app: one row per platform, flavor (native or the hybrid SDK) and version.
 * Written at most once a minute per row; the dashboard's SDK compatibility panel reads it through setup_health.
 */
export const sdkVersions = pgTable("sdk_versions", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  /** "" when the request was not tied to an app. */
  appId: text("app_id").notNull().default(""),
  platform: text("platform").notNull(),
  platformFlavor: text("platform_flavor").notNull().default("native"),
  platformFlavorVersion: text("platform_flavor_version").notNull().default(""),
  sdkVersion: text("sdk_version").notNull(),
  lastPlatformVersion: text("last_platform_version"),
  lastAppVersion: text("last_app_version"),
  lastAppBuild: text("last_app_build"),
  lastBundleId: text("last_bundle_id"),
  lastAppUserId: text("last_app_user_id"),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
}, (t) => [primaryKey({ name: "sdk_versions_pk", columns: [t.projectId, t.appId, t.platform, t.platformFlavor, t.platformFlavorVersion, t.sdkVersion] })]);

/** Raw store notifications as received, for replay, forwarding and audit. */
export const storeNotifications = pgTable("store_notifications", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull(),
  store: text("store").notNull(),
  type: text("type"),
  subtype: text("subtype"),
  environment: text("environment"),
  body: text("body").notNull(),
  processedAt: ts("processed_at"),
  error: text("error"),
  forwardStatus: integer("forward_status"),
  receivedAt: created(),
}, (t) => [index("notifications_app_time").on(t.appId, t.receivedAt)]);

/**
 * OAuth 2.1 clients for MCP clients (Claude, ChatGPT, Cursor ...), registered with dynamic client registration (RFC 7591).
 * Public clients only: no secret, PKCE (S256) on every authorization.
 */
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  createdAt: created(),
});

/**
 * One-time authorization codes (only the hash is stored). Exchanging a code creates a secret API key (sk_...) scoped to
 * the project and permissions the user approved; that key is the OAuth access token and is revoked like any other key.
 */
export const oauthCodes = pgTable("oauth_codes", {
  hash: text("hash").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope").notNull(),
  permissions: jsonb("permissions").$type<string[]>().notNull(),
  /** RFC 8707 resource indicator the client asked for (the MCP server URL), if any. */
  resource: text("resource"),
  expiresAt: ts("expires_at").notNull(),
});

/**
 * Daily exchange rates by source, cached. `ecb`: ECB reference rates, units per 1 EUR (EUR included as 1).
 * `usd`: the fawazahmed0 currency-api (every ISO currency), units per 1 USD. Purchases convert to USD at the rate of
 * their purchase date, or the last day before it with rates; ECB first, `usd` for currencies the ECB does not publish.
 */
export const fxRates = pgTable("fx_rates", {
  source: text("source").notNull().default("ecb"),
  /** YYYY-MM-DD. */
  date: text("date").notNull(),
  rates: jsonb("rates").$type<Record<string, number>>().notNull(),
  fetchedAt: ts("fetched_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.source, t.date] })]);

/**
 * Single-use email links: password resets (1 hour) and email verification (24 hours). Only the SHA-256 of the token is
 * stored. `email` is the address the link was sent to, so a link stops working if the account's email changes.
 */
export const authTokens = pgTable("auth_tokens", {
  hash: text("hash").primaryKey(),
  kind: text("kind").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: created(),
}, (t) => [index("auth_tokens_user").on(t.userId, t.kind)]);

/** Invitations to a project by email. The link token is stored as a SHA-256; resending replaces it. */
export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
  expiresAt: ts("expires_at").notNull(),
  lastSentAt: ts("last_sent_at").notNull().defaultNow(),
  acceptedAt: ts("accepted_at"),
  acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
  revokedAt: ts("revoked_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("invites_token").on(t.tokenHash), index("invites_project").on(t.projectId, t.email)]);

/** Fixed-window counters for rate limits (password reset, verification resend, invites). Works on Workers and Node alike. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

/**
 * One row per thing that can break: kind "store_notifications" or "store_credentials" (subject = app id) or "webhook"
 * (subject = webhook id). The tick opens, reminds (at most once a day) and resolves it, and emails the project's admins.
 */
export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  subjectId: text("subject_id").notNull(),
  status: text("status").notNull(),
  message: text("message"),
  openedAt: ts("opened_at").notNull(),
  lastNotifiedAt: ts("last_notified_at"),
  resolvedAt: ts("resolved_at"),
}, (t) => [uniqueIndex("alerts_subject").on(t.kind, t.subjectId), index("alerts_project").on(t.projectId, t.status)]);

/** In-app currencies (virtual currencies). A purchase of a granting product credits the customer's balance. */
export const virtualCurrencies = pgTable("virtual_currencies", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  state: text("state").notNull().default("active"),
  /** [{ product_ids, amount, trial_amount, expire_at_cycle_end }] as set through the API. */
  productGrants: jsonb("product_grants").$type<{ product_ids: string[]; amount: number; trial_amount: number; expire_at_cycle_end: boolean }[]>().notNull().default([]),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.projectId, t.code] })]);

export const virtualCurrencyBalances = pgTable("virtual_currency_balances", {
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  balance: integer("balance").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.customerId, t.code] })]);

/** Ledger of balance changes. `sourceKey` makes a grant idempotent (a store transaction id or an API Idempotency-Key). */
export const virtualCurrencyTransactions = pgTable("virtual_currency_transactions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  amount: integer("amount").notNull(),
  /** `api` (adjustment through the REST API), `purchase` (product grant), `sdk` (spend from the app) or `ad_reward` (a verified rewarded ad, prd/ads/PRD.md). */
  source: text("source").notNull(),
  sourceKey: text("source_key"),
  reference: text("reference"),
  createdAt: created(),
}, (t) => [index("vc_tx_customer").on(t.customerId), uniqueIndex("vc_tx_source_key").on(t.projectId, t.customerId, t.code, t.sourceKey)]);

/** Who changed what in a project. Written by a middleware on every successful v2 write. */
export const auditLogs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  actionType: text("action_type").notNull(),
  targetType: text("target_type").notNull(),
  targetIdentifier: text("target_identifier").notNull(),
  actorType: text("actor_type").notNull(),
  actorIdentifier: text("actor_identifier").notNull(),
  additionalData: jsonb("additional_data").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
}, (t) => [index("audit_logs_project_time").on(t.projectId, t.occurredAt)]);

/**
 * Paywalls (paywall components, "Paywalls V2"). A paywall belongs to at most one offering. `draft` and `published` each hold one
 * version of the content: { components_config, components_localizations, default_locale, state_declarations, exit_offers,
 * play_store_product_change_mode, revision }. `revision` bumps on every draft write and rejects stale writes.
 */
export interface PaywallContent {
  components_config: Record<string, unknown> | null;
  components_localizations: Record<string, Record<string, unknown>>;
  default_locale: string | null;
  automatically_scale_font_size: boolean;
  exit_offers: Record<string, unknown> | null;
  state_declarations: Record<string, unknown> | null;
  play_store_product_change_mode: Record<string, unknown> | null;
  revision: number;
}

export const paywalls = pgTable("paywalls", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name"),
  offeringId: text("offering_id").references(() => offerings.id, { onDelete: "set null" }),
  automaticallyScaleFontSize: boolean("automatically_scale_font_size").notNull().default(true),
  revision: integer("revision").notNull().default(1),
  draft: jsonb("draft").$type<PaywallContent | null>(),
  published: jsonb("published").$type<PaywallContent | null>(),
  /** The dashboard template form that produced the draft (RevenueDot only), so the form can be reopened. */
  template: jsonb("template").$type<Record<string, unknown> | null>(),
  publishedAt: ts("published_at"),
  createdAt: created(),
}, (t) => [index("paywalls_project").on(t.projectId), uniqueIndex("paywalls_offering").on(t.offeringId)]);

/** A named snapshot of a paywall's draft. */
export const paywallVersions = pgTable("paywall_versions", {
  id: text("id").primaryKey(),
  paywallId: text("paywall_id").notNull().references(() => paywalls.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  revision: integer("revision").notNull(),
  content: jsonb("content").$type<PaywallContent>().notNull(),
  createdAt: created(),
});

/** Images and fonts uploaded for paywalls, served publicly at /assets/{project}/{object_name}. Bytes are kept as base64 text. */
export const mediaAssets = pgTable("media_assets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  objectName: text("object_name").notNull(),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  width: integer("width"),
  height: integer("height"),
  altText: text("alt_text"),
  /** Fonts: { name (PostScript), family_name, style, weight, hash (MD5 hex) }. */
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  dataBase64: text("data_base64").notNull(),
  createdAt: created(),
}, (t) => [index("media_assets_project").on(t.projectId), uniqueIndex("media_assets_object").on(t.projectId, t.objectName)]);

/** A chart view saved from the Charts page: the chart and its range, resolution, segment, filters, selectors, environment and compare switch. */
export const savedCharts = pgTable("saved_charts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  chartName: text("chart_name").notNull(),
  view: jsonb("view").$type<Record<string, unknown>>().notNull().default({}),
  createdBy: text("created_by"),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("saved_charts_project").on(t.projectId)]);

/** A saved set of conditions on customers (RevenueCat's audience rules: groups OR-ed, conditions in a group AND-ed). */
export const audiences = pgTable("audiences", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  rules: jsonb("rules").$type<{ groups: { conditions: { field: string; operator: string; value?: string; currency?: string }[] }[] }>().notNull(),
  createdAt: created(),
  updatedAt: ts("updated_at"),
});

/**
 * Targeting: rules evaluated in `position` order when the SDK fetches offerings. The first live rule whose audience matches
 * the customer decides the current offering and the offering per placement. No match: the project's current offering.
 */
export const targetingRules = pgTable("targeting_rules", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Null targets every customer. */
  audienceId: text("audience_id").references(() => audiences.id, { onDelete: "restrict" }),
  offeringId: text("offering_id").notNull().references(() => offerings.id, { onDelete: "cascade" }),
  /** Placement identifier → offering id (null shows no paywall for that placement). */
  placements: jsonb("placements").$type<Record<string, string | null>>().notNull().default({}),
  position: integer("position").notNull(),
  state: text("state").notNull().default("inactive"),
  startsAt: ts("starts_at"),
  endsAt: ts("ends_at"),
  revision: integer("revision").notNull().default(1),
  createdAt: created(),
}, (t) => [index("targeting_rules_project").on(t.projectId, t.position)]);

/** Offering A/B tests. Enrolled customers get variant a's or b's offering as their current offering. */
export const experiments = pgTable("experiments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  audienceId: text("audience_id").references(() => audiences.id, { onDelete: "restrict" }),
  /** Share of eligible new customers enrolled, 1 to 100. */
  enrollmentPercent: integer("enrollment_percent").notNull().default(100),
  offeringA: text("offering_a").notNull().references(() => offerings.id, { onDelete: "cascade" }),
  offeringB: text("offering_b").notNull().references(() => offerings.id, { onDelete: "cascade" }),
  startedAt: ts("started_at"),
  stoppedAt: ts("stopped_at"),
  createdAt: created(),
}, (t) => [index("experiments_project").on(t.projectId)]);

export const experimentEnrollments = pgTable("experiment_enrollments", {
  experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  variant: text("variant").notNull(),
  enrolledAt: ts("enrolled_at").notNull(),
}, (t) => [primaryKey({ columns: [t.experimentId, t.customerId] }), index("experiment_enrollments_customer").on(t.customerId)]);

/** Content-addressed blobs served to the SDKs' remote configuration (workflows, ui_config). `ref` = base64url(SHA-256(bytes)[0..24]). */
export const configBlobs = pgTable("config_blobs", {
  ref: text("ref").primaryKey(),
  data: text("data").notNull(),
  createdAt: created(),
});

/**
 * Paywall, Customer Center and ad events the SDKs post to /v1/events, for the paywall, ad and survey charts.
 * `id` is the SDK's event id, so a resent batch is stored once. `customerId` is resolved from `appUserId` when known.
 */
export const sdkEvents = pgTable("sdk_events", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  appId: text("app_id"),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "cascade" }),
  appUserId: text("app_user_id"),
  type: text("type").notNull(),
  isSandbox: boolean("is_sandbox").notNull().default(false),
  occurredAt: ts("occurred_at").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.projectId, t.id] }), index("sdk_events_project_time").on(t.projectId, t.occurredAt), index("sdk_events_customer").on(t.customerId),
  // The Ads Overview reads one project's ad events by type and time (prd/ads/PRD.md).
  index("sdk_events_project_type_time").on(t.projectId, t.type, t.occurredAt)]);

/** One row per customer per UTC day on which the SDK called us (the Active Customers chart). `day` is YYYY-MM-DD. */
export const customerActivity = pgTable("customer_activity", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  day: text("day").notNull(),
}, (t) => [primaryKey({ columns: [t.customerId, t.day] }), index("customer_activity_project_day").on(t.projectId, t.day)]);

/**
 * Third-party integrations (Slack, Segment, Amplitude, Mixpanel, PostHog, Firebase/GA4, BigQuery, AppsFlyer, Adjust, Meta).
 * Every event that webhooks get is also queued to each enabled integration whose filters match (services/events.ts).
 * `settings` holds the non-secret fields; `secrets` the API keys and tokens, sealed with AES-GCM (services/secrets.ts);
 * `secretHints` the last characters of each secret, for the dashboard. `eventNames` overrides the default event names.
 */
export const integrations = pgTable("integrations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  environment: text("environment").notNull().default("production"),
  appId: text("app_id"),
  eventTypes: jsonb("event_types").$type<string[] | null>(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  secrets: text("secrets"),
  secretHints: jsonb("secret_hints").$type<Record<string, string>>().notNull().default({}),
  eventNames: jsonb("event_names").$type<Record<string, string>>().notNull().default({}),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  lastDeliveredAt: ts("last_delivered_at"),
  createdAt: created(),
  updatedAt: ts("updated_at"),
}, (t) => [index("integrations_project").on(t.projectId)]);

/** One event queued to one integration: the same retry schedule as webhooks. `skipped` = nothing to send (no device id, unmapped event). */
export const integrationDeliveries = pgTable("integration_deliveries", {
  id: text("id").primaryKey(),
  integrationId: text("integration_id").notNull().references(() => integrations.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  /** The partner's event name (e.g. rc_initial_purchase_event) or Slack's message title. */
  sentAs: text("sent_as"),
  /** Method and URL of the last request, without credentials. */
  request: text("request"),
  /** The last request body with credentials scrubbed (first 4,000 characters), for the delivery log. */
  requestBody: text("request_body"),
  responseStatus: integer("response_status"),
  responseMs: integer("response_ms"),
  /** The first 1,000 characters of the partner's answer to the last attempt. */
  responseBody: text("response_body"),
  lastError: text("last_error"),
  createdAt: created(),
}, (t) => [index("integration_deliveries_due").on(t.status, t.nextAttemptAt), uniqueIndex("integration_deliveries_unique").on(t.integrationId, t.eventId), index("integration_deliveries_log").on(t.integrationId, t.createdAt)]);

/**
 * Scheduled data exports: CSV or Parquet files of customers, subscriptions, transactions and events, written to S3, R2
 * (S3-compatible) or Google Cloud Storage on a daily or weekly schedule. `cursor` holds each table's high-water mark for
 * incremental runs. `secrets` is sealed like integration secrets.
 */
export const exportJobs = pgTable("export_jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  destination: text("destination").notNull(),
  destinationConfig: jsonb("destination_config").$type<Record<string, unknown>>().notNull().default({}),
  secrets: text("secrets"),
  secretHints: jsonb("secret_hints").$type<Record<string, string>>().notNull().default({}),
  format: text("format").notNull().default("csv"),
  compression: text("compression").notNull().default("gzip"),
  schedule: text("schedule").notNull().default("daily"),
  hourUtc: integer("hour_utc").notNull().default(3),
  weekday: integer("weekday"),
  mode: text("mode").notNull().default("incremental"),
  tables: jsonb("tables").$type<string[]>().notNull(),
  environment: text("environment").notNull().default("both"),
  cursor: jsonb("cursor").$type<Record<string, number>>().notNull().default({}),
  nextRunAt: ts("next_run_at"),
  lastRunAt: ts("last_run_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  createdAt: created(),
  updatedAt: ts("updated_at"),
}, (t) => [index("export_jobs_project").on(t.projectId), index("export_jobs_due").on(t.enabled, t.nextRunAt)]);

export interface ExportFile { table: string; key: string; rows: number; bytes: number }
/** Where an unfinished run stopped: the index into the job's tables, the page cursor inside it, the last part written. */
export interface ExportProgress { table: number; cursor: { t: string; id: string } | null; part: number }

export const exportRuns = pgTable("export_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => exportJobs.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  trigger: text("trigger").notNull(),
  mode: text("mode").notNull(),
  /** Rows changed after windowStart and up to windowEnd (incremental); windowStart is null for a full export. */
  windowStart: ts("window_start"),
  windowEnd: ts("window_end").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  files: jsonb("files").$type<ExportFile[]>().notNull().default([]),
  /** Set while a run is spread over several ticks (services/exports/run.ts); null when it has not started or is done. */
  progress: jsonb("progress").$type<ExportProgress | null>(),
  rows: integer("rows").notNull().default(0),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  error: text("error"),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  createdAt: created(),
}, (t) => [index("export_runs_job").on(t.jobId, t.createdAt), index("export_runs_due").on(t.status, t.nextAttemptAt)]);

/**
 * Refund Control policies, evaluated in `position` order when Apple asks about a refund (CONSUMPTION_REQUEST): the first
 * policy whose rules match the customer decides the refund preference; no match uses the project's default.
 */
export const refundPolicies = pgTable("refund_policies", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** first_purchase_date, platform, recent_renewal or custom (the template the policy started from). */
  template: text("template").notNull().default("custom"),
  rules: jsonb("rules").$type<{ groups: { conditions: { field: string; operator: string; value?: string; currency?: string }[] }[] }>().notNull(),
  /** prefer_refund, prefer_no_refund, consumption_only or do_not_respond. */
  preference: text("preference").notNull(),
  position: integer("position").notNull(),
  createdAt: created(),
  updatedAt: ts("updated_at"),
}, (t) => [index("refund_policies_project").on(t.projectId, t.position)]);

/**
 * One refund request per store transaction: Apple's CONSUMPTION_REQUEST (answered with consumption information), or a
 * refund we learned of without a request (Apple REFUND, Google voided purchases and chargebacks).
 * `consumptionStatus`: pending, sent, skipped, failed, expired or not_applicable. `outcome`: pending, approved or declined.
 */
export const refundRequests = pgTable("refund_requests", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id"),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  appUserId: text("app_user_id"),
  store: text("store").notNull(),
  isSandbox: boolean("is_sandbox").notNull().default(false),
  transactionId: text("transaction_id").notNull(),
  originalTransactionId: text("original_transaction_id"),
  productId: text("product_id"),
  amountUsd: doublePrecision("amount_usd"),
  reason: text("reason"),
  requestedAt: ts("requested_at").notNull(),
  deadlineAt: ts("deadline_at"),
  policyId: text("policy_id"),
  policyName: text("policy_name"),
  preference: text("preference"),
  consumptionStatus: text("consumption_status").notNull(),
  consumption: jsonb("consumption").$type<Record<string, unknown>>(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at"),
  lastError: text("last_error"),
  sentAt: ts("sent_at"),
  outcome: text("outcome").notNull().default("pending"),
  outcomeAt: ts("outcome_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("refund_requests_tx").on(t.projectId, t.store, t.transactionId), index("refund_requests_project_time").on(t.projectId, t.requestedAt), index("refund_requests_due").on(t.consumptionStatus, t.nextAttemptAt), index("refund_requests_customer").on(t.customerId)]);

/** Customer Center retention offers: a promotional offer shown when a customer cancels (`cancel`) or asks for a refund (`refund`). */
export const retentionOffers = pgTable("retention_offers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  /** app_store or play_store: which SDK reads the offer ids. */
  store: text("store").notNull(),
  /** Store product id → store offer id (Apple promotional offer id, Google offer id). */
  productMapping: jsonb("product_mapping").$type<Record<string, string>>().notNull().default({}),
  active: boolean("active").notNull().default(true),
  createdAt: created(),
  updatedAt: ts("updated_at"),
}, (t) => [index("retention_offers_project").on(t.projectId)]);

/** Tickets customers send from the Customer Center (`POST /v1/customercenter/support/create-ticket`). */
export const supportTickets = pgTable("support_tickets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id"),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  appUserId: text("app_user_id").notNull(),
  customerEmail: text("customer_email").notNull(),
  description: text("description").notNull(),
  /** open or closed. */
  status: text("status").notNull().default("open"),
  /** The support address the ticket was emailed to, and whether the mailer accepted it. */
  emailedTo: text("emailed_to"),
  emailed: boolean("emailed").notNull().default(false),
  createdAt: created(),
  closedAt: ts("closed_at"),
}, (t) => [index("support_tickets_project").on(t.projectId, t.createdAt), index("support_tickets_customer").on(t.customerId)]);

/** Win-back campaigns: email churned subscribers an offer. Audience, email and offer are JSON (services/winback.ts). */
export const winbackCampaigns = pgTable("winback_campaigns", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** draft, active or paused. */
  status: text("status").notNull().default("draft"),
  audience: jsonb("audience").$type<Record<string, unknown>>().notNull(),
  email: jsonb("email").$type<Record<string, unknown>>().notNull(),
  offer: jsonb("offer").$type<Record<string, unknown>>().notNull(),
  sendHourUtc: integer("send_hour_utc").notNull().default(16),
  trackOpens: boolean("track_opens").notNull().default(false),
  lastRunAt: ts("last_run_at"),
  createdAt: created(),
  updatedAt: ts("updated_at"),
}, (t) => [index("winback_campaigns_project").on(t.projectId)]);

/** One win-back email to one customer. `token` (random) identifies the email in its tracking and unsubscribe links. */
export const winbackSends = pgTable("winback_sends", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => winbackCampaigns.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  email: text("email").notNull(),
  token: text("token").notNull(),
  offerUrl: text("offer_url").notNull(),
  sentAt: ts("sent_at").notNull(),
  openedAt: ts("opened_at"),
  clickedAt: ts("clicked_at"),
  unsubscribedAt: ts("unsubscribed_at"),
  error: text("error"),
}, (t) => [uniqueIndex("winback_sends_token").on(t.token), uniqueIndex("winback_sends_once").on(t.campaignId, t.customerId), index("winback_sends_project").on(t.projectId, t.sentAt), index("winback_sends_customer").on(t.customerId)]);

/** Addresses that unsubscribed from a project's marketing email (win-back). Lower-cased. */
export const emailSuppressions = pgTable("email_suppressions", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  reason: text("reason").notNull().default("unsubscribed"),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.projectId, t.email] })]);

/* ---- Web billing, purchase links, funnels, web discounts, domains (prd/web-billing/PRD.md, migration 0018) ---- */

/** Checkout look and redemption settings of one Stripe web provider (an app of type `stripe`). */
export const webConfigs = pgTable("web_configs", {
  appId: text("app_id").primaryKey().references(() => apps.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("web_configs_project").on(t.projectId)]);

/** A product sold on the web: the RevenueDot product and the Stripe product and price it was created with (or linked to). */
export const webProducts = pgTable("web_products", {
  productId: text("product_id").primaryKey().references(() => products.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  stripeProductId: text("stripe_product_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull(),
  /** Price in the currency's minor unit (cents; yen for zero-decimal currencies). */
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  /** day, week, month, year; null for one-time products. */
  interval: text("interval"),
  intervalCount: integer("interval_count"),
  trialDays: integer("trial_days"),
  createdAt: created(),
}, (t) => [index("web_products_project").on(t.projectId), uniqueIndex("web_products_price").on(t.appId, t.stripePriceId)]);

/** The project's web address: a slug on RevenueDot's pay host, and an optional custom domain proven by DNS. */
export const webDomains = pgTable("web_domains", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  customDomain: text("custom_domain"),
  verificationToken: text("verification_token").notNull(),
  /** none, pending, verified, failed. */
  status: text("status").notNull().default("none"),
  verifiedAt: ts("verified_at"),
  checkedAt: ts("checked_at"),
  error: text("error"),
  createdAt: created(),
}, (t) => [
  uniqueIndex("web_domains_slug").on(t.slug),
  // Only a verified domain is exclusive: a project that adds a domain it cannot prove never blocks the one that can.
  uniqueIndex("web_domains_custom").on(t.customDomain).where(sql`${t.status} = 'verified'`),
]);

/** A checkout link for one offering. `slug` shares the project's namespace with funnels. */
export const purchaseLinks = pgTable("purchase_links", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  offeringId: text("offering_id").notNull().references(() => offerings.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  /** Applied without a code. */
  discountId: text("discount_id"),
  expiresAt: ts("expires_at"),
  disabledAt: ts("disabled_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("purchase_links_slug").on(t.projectId, t.slug)]);

/** A no-code web-to-app funnel. `draft` is what the builder edits; `published` is what visitors see. */
export const funnels = pgTable("funnels", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  draft: jsonb("draft").$type<Record<string, unknown>>().notNull(),
  published: jsonb("published").$type<Record<string, unknown> | null>(),
  publishedAt: ts("published_at"),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("funnels_slug").on(t.projectId, t.slug)]);

/** What visitors did in a funnel: funnel_viewed, step_viewed, step_completed, checkout_started, purchase. */
export const funnelEvents = pgTable("funnel_events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  funnelId: text("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  type: text("type").notNull(),
  stepId: text("step_id"),
  stepIndex: integer("step_index"),
  appUserId: text("app_user_id"),
  properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
  revenueUsd: doublePrecision("revenue_usd"),
  createdAt: created(),
}, (t) => [index("funnel_events_funnel").on(t.funnelId, t.createdAt)]);

/**
 * One hosted checkout: the Stripe Checkout Session RevenueDot created, the purchase once paid, and the redemption token
 * that lets an anonymous web buyer attach the purchase to their app user id (only its SHA-256 is stored).
 */
export const webCheckouts = pgTable("web_checkouts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  /** purchase_link, funnel or sdk (the iOS paywall's hosted checkout). */
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  offeringId: text("offering_id"),
  packageId: text("package_id"),
  productId: text("product_id"),
  appUserId: text("app_user_id").notNull(),
  /** The buyer had no app user id: the purchase is redeemed in the app with a redemption link. */
  anonymous: boolean("anonymous").notNull().default(false),
  email: text("email"),
  discountId: text("discount_id"),
  discountCode: text("discount_code"),
  funnelSessionId: text("funnel_session_id"),
  stripeSessionId: text("stripe_session_id"),
  /** created, completed, expired. */
  status: text("status").notNull().default("created"),
  completedAt: ts("completed_at"),
  isSandbox: boolean("is_sandbox").notNull().default(false),
  amountUsd: doublePrecision("amount_usd"),
  /** Customer attributes to set when the purchase completes: funnel answers, `$email`. */
  attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
  /**
   * Redemption token = "rdrt_" + base64url(SHA-256(seed + "." + generation)). The success page and the email can show the
   * same token; an expired one is replaced by bumping the generation. Only the token's hash is looked up.
   */
  redemptionSeed: text("redemption_seed"),
  redemptionGeneration: integer("redemption_generation").notNull().default(0),
  redemptionTokenHash: text("redemption_token_hash"),
  /** Hashes of tokens this one replaced (expired links), so an old link still answers "expired" instead of "invalid". */
  previousTokenHashes: jsonb("previous_token_hashes").$type<string[]>().notNull().default([]),
  redemptionExpiresAt: ts("redemption_expires_at"),
  redemptionSentAt: ts("redemption_sent_at"),
  redeemedAt: ts("redeemed_at"),
  redeemedCustomerId: text("redeemed_customer_id"),
  redeemedAppUserId: text("redeemed_app_user_id"),
  createdAt: created(),
}, (t) => [uniqueIndex("web_checkouts_session").on(t.stripeSessionId), uniqueIndex("web_checkouts_token").on(t.redemptionTokenHash), index("web_checkouts_project").on(t.projectId, t.createdAt)]);

/** A web discount (RevenueCat's v2 `discount`), created as a Stripe coupon in every Stripe app of the project. */
export const discounts = pgTable("discounts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  identifier: text("identifier").notNull(),
  customerFacingName: text("customer_facing_name").notNull(),
  /** percentage or fixed_amount. */
  type: text("type").notNull(),
  percentage: integer("percentage"),
  /** Amounts by currency (major units), for fixed_amount. */
  fixedAmounts: jsonb("fixed_amounts").$type<Record<string, number> | null>(),
  /** one_time, time_window, forever. */
  durationMode: text("duration_mode").notNull(),
  timeWindow: text("time_window"),
  eligibility: text("eligibility").notNull().default("everyone"),
  productIdentifiers: jsonb("product_identifiers").$type<string[] | null>(),
  maxRedemptions: integer("max_redemptions"),
  expiresAt: ts("expires_at"),
  disabledAt: ts("disabled_at"),
  timesRedeemed: integer("times_redeemed").notNull().default(0),
  /** Stripe ids per Stripe app: { [appId]: { coupon: "…" } }. */
  stripe: jsonb("stripe").$type<Record<string, { coupon: string }>>().notNull().default({}),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("discounts_identifier").on(t.projectId, t.identifier)]);

/** A code customers type at checkout. `codeKey` is the upper-cased code, unique in the project. */
export const discountCodes = pgTable("discount_codes", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  codeKey: text("code_key").notNull(),
  code: text("code").notNull(),
  discountId: text("discount_id").notNull().references(() => discounts.id, { onDelete: "cascade" }),
  timesRedeemed: integer("times_redeemed").notNull().default(0),
  /** Stripe promotion code ids per Stripe app: { [appId]: "promo_…" }. */
  stripe: jsonb("stripe").$type<Record<string, string>>().notNull().default({}),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.projectId, t.codeKey] }), index("discount_codes_discount").on(t.discountId)]);

/**
 * Ad reward rules (prd/ads/PRD.md): what a verified rewarded ad grants. Ordered by `position`; the first enabled rule
 * whose app, ad unit and reward item match wins. `kind` is `virtual_currency` (code, amount or the network's amount
 * times `multiplier`) or `entitlement` (lookup key for `durationMinutes`).
 */
export const adRewardRules = pgTable("ad_reward_rules", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  position: integer("position").notNull(),
  appId: text("app_id"),
  adUnitId: text("ad_unit_id"),
  rewardItem: text("reward_item"),
  kind: text("kind").notNull(),
  currencyCode: text("currency_code"),
  amount: integer("amount"),
  /** Use the network's `reward_amount` times this instead of `amount` (null: fixed amount). */
  multiplier: doublePrecision("multiplier"),
  entitlementId: text("entitlement_id"),
  durationMinutes: integer("duration_minutes"),
  createdAt: created(),
  updatedAt: ts("updated_at"),
}, (t) => [index("ad_reward_rules_project").on(t.projectId, t.position)]);

/**
 * The rewards ledger: one row per server-side verification callback (AdMob SSV) or test reward. `clientTransactionId`
 * is the SDK's id from `generateRewardVerificationToken`, which the SDK polls; `rewards` is what was granted, in the
 * SDK's reward shape.
 */
export const adRewardVerifications = pgTable("ad_reward_verifications", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id"),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "cascade" }),
  appUserId: text("app_user_id").notNull(),
  clientTransactionId: text("client_transaction_id").notNull(),
  network: text("network").notNull(),
  networkTransactionId: text("network_transaction_id").notNull(),
  adUnitId: text("ad_unit_id"),
  impressionId: text("impression_id"),
  rewardItem: text("reward_item"),
  rewardAmount: integer("reward_amount"),
  status: text("status").notNull(),
  failureReason: text("failure_reason"),
  ruleId: text("rule_id"),
  rewards: jsonb("rewards").$type<Record<string, unknown>[]>().notNull().default([]),
  isSandbox: boolean("is_sandbox").notNull().default(false),
  /** When the network says the reward happened (AdMob `timestamp`). */
  occurredAt: ts("occurred_at").notNull(),
  createdAt: created(),
}, (t) => [
  uniqueIndex("ad_reward_verifications_client_tx").on(t.projectId, t.clientTransactionId),
  uniqueIndex("ad_reward_verifications_network_tx").on(t.network, t.networkTransactionId),
  index("ad_reward_verifications_project").on(t.projectId, t.createdAt),
]);

/** Ad units loaded from a connected ad network (AdMob), for names and formats on the Ads Overview. */
export const adUnits = pgTable("ad_units", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  network: text("network").notNull(),
  adUnitId: text("ad_unit_id").notNull(),
  accountId: text("account_id"),
  networkAppId: text("network_app_id"),
  displayName: text("display_name").notNull(),
  format: text("format"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.projectId, t.network, t.adUnitId] })]);
