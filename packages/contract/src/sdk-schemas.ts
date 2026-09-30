import { z } from "zod";

/**
 * What the RevenueCat SDK decoders require, as the union of iOS (CustomerInfoResponse) and Android (CustomerInfoFactory).
 * Source: the SDK decoders; see docs/compatibility in the private research. If our response fails these, a real SDK fails to decode it.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const store = z.enum(["app_store", "mac_app_store", "play_store", "stripe", "promotional", "amazon", "rc_billing", "external", "paddle", "test_store", "galaxy", "roku"]);
const price = z.object({ amount: z.number(), currency: z.string() }).strict();

export const SubscriptionSchema = z.object({
  purchase_date: isoDate,
  original_purchase_date: isoDate,
  expires_date: isoDate.nullable(),
  store,
  is_sandbox: z.boolean(),
  period_type: z.enum(["normal", "trial", "intro", "promotional", "prepaid"]),
  unsubscribe_detected_at: isoDate.nullable().optional(),
  billing_issues_detected_at: isoDate.nullable().optional(),
  grace_period_expires_date: isoDate.nullable().optional(),
  refunded_at: isoDate.nullable().optional(),
  auto_resume_date: isoDate.nullable().optional(),
  ownership_type: z.enum(["PURCHASED", "FAMILY_SHARED"]).optional(),
  store_transaction_id: z.string().nullable().optional(),
  product_plan_identifier: z.string().optional(),
  display_name: z.string().nullable().optional(),
  management_url: z.string().url().nullable().optional(),
  price: price.optional(),
});

export const NonSubscriptionSchema = z.object({
  id: z.string(),
  purchase_date: isoDate,
  original_purchase_date: isoDate.optional(),
  store,
  is_sandbox: z.boolean(),
  store_transaction_id: z.string(),
  display_name: z.string().nullable().optional(),
  price: price.optional(),
});

export const CustomerInfoSchema = z.object({
  request_date: isoDate,
  request_date_ms: z.number().int(),
  subscriber: z.object({
    original_app_user_id: z.string(),
    first_seen: isoDate,
    last_seen: isoDate.optional(),
    original_application_version: z.string().nullable().optional(),
    original_purchase_date: isoDate.nullable().optional(),
    management_url: z.string().url().nullable().optional(),
    subscriptions: z.record(SubscriptionSchema),
    non_subscriptions: z.record(z.array(NonSubscriptionSchema)),
    other_purchases: z.record(z.unknown()).optional(),
    entitlements: z.record(z.object({
      product_identifier: z.string(),
      purchase_date: isoDate,
      expires_date: isoDate.nullable(),
      grace_period_expires_date: isoDate.nullable().optional(),
      product_plan_identifier: z.string().optional(),
    })),
    subscriber_attributes: z.record(z.object({ value: z.string().nullable(), updated_at_ms: z.number() })).optional(),
  }).superRefine((s, ctx) => {
    // An entitlement whose product_identifier is not a key of subscriptions/non_subscriptions is silently dropped by both SDKs.
    for (const [k, e] of Object.entries(s.entitlements)) {
      if (!(e.product_identifier in s.subscriptions) && !(e.product_identifier in s.non_subscriptions)) {
        ctx.addIssue({ code: "custom", path: ["entitlements", k], message: `product ${e.product_identifier} missing from subscriptions/non_subscriptions` });
      }
    }
  }),
});

export const OfferingsSchema = z.object({
  current_offering_id: z.string().nullable(),
  offerings: z.array(z.object({
    identifier: z.string(),
    description: z.string(),
    metadata: z.record(z.unknown()).nullable().optional(),
    packages: z.array(z.object({
      identifier: z.string(),
      platform_product_identifier: z.string(),
      platform_product_plan_identifier: z.string().optional(),
      web_checkout_url: z.string().url().optional(),
    })),
  })),
  placements: z.object({ fallback_offering_id: z.string().nullable().optional(), offering_ids_by_placement: z.record(z.string().nullable()) }).optional(),
  targeting: z.object({ revision: z.number().int(), rule_id: z.string() }).optional(),
});

export const ProductEntitlementMappingSchema = z.object({
  product_entitlement_mapping: z.record(z.object({ product_identifier: z.string(), base_plan_id: z.string().optional(), entitlements: z.array(z.string()) })),
});

export const ErrorSchema = z.object({ code: z.number().int().positive(), message: z.string() });

export const WebhookEventSchema = z.object({
  api_version: z.literal("1.0"),
  event: z.object({
    id: z.string(), type: z.string(), event_timestamp_ms: z.number(), app_id: z.string().nullable(), app_user_id: z.string(),
    original_app_user_id: z.string(), aliases: z.array(z.string()), product_id: z.string(), period_type: z.string(),
    purchased_at_ms: z.number(), expiration_at_ms: z.number().nullable(), environment: z.enum(["PRODUCTION", "SANDBOX"]),
    entitlement_ids: z.array(z.string()).nullable(), transaction_id: z.string().nullable(), original_transaction_id: z.string().nullable(),
    is_family_share: z.boolean(), store: z.string(), subscriber_attributes: z.record(z.object({ value: z.string().nullable(), updated_at_ms: z.number() })),
    currency: z.string().nullable(), price: z.number().nullable(), price_in_purchased_currency: z.number().nullable(),
    takehome_percentage: z.number(), commission_percentage: z.number(), tax_percentage: z.number(), country_code: z.string().nullable(),
  }),
});
