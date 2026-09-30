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
  notificationForwardUrl: text("notification_forward_url"),
  lastNotificationAt: ts("last_notification_at"),
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

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  storeIdentifier: text("store_identifier").notNull(),
  type: text("type").notNull().default("subscription"),
  displayName: text("display_name"),
  /** ISO 8601 period for subscriptions (P1W, P1M, P1Y); used by the Test Store and MRR normalisation. */
  duration: text("duration"),
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
  originalApplicationVersion: text("original_application_version"),
  originalPurchaseDate: ts("original_purchase_date"),
}, (t) => [index("customers_project").on(t.projectId, t.lastSeen)]);

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
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("subscriptions_store_key").on(t.projectId, t.store, t.storeKey), index("subscriptions_customer").on(t.customerId)]);

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
}, (t) => [uniqueIndex("transactions_store_tx").on(t.projectId, t.store, t.storeTransactionId, t.kind), index("transactions_time").on(t.projectId, t.purchasedAt)]);

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
}, (t) => [index("events_project_time").on(t.projectId, t.eventTimestampMs), index("events_customer").on(t.customerId)]);

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
  createdAt: created(),
}, (t) => [uniqueIndex("users_email").on(t.email)]);

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
