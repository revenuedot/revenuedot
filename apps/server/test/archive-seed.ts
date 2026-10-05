import { schema, type DB } from "@revenuedot/db";
import { seal, type SecretKey } from "../src/services/secrets.js";

/**
 * Puts at least one row in every table a full export carries (services/archive/tables.ts), with awkward values on
 * purpose: microsecond timestamps, unicode and quotes, nested JSON, text arrays, big integers and doubles, nulls and
 * every kind of secret. Starts from the contract harness's project (proj1 with three apps, products and an offering).
 */
export async function seedEverything(db: DB, key: SecretKey | null, o: { userId: string; projectId?: string }) {
  const P = o.projectId ?? "proj1";
  const T = new Date("2026-08-20T10:11:12.345Z");
  const s = schema;
  await db.update(s.projects).set({ customerCenter: { appearance: { accent: "#F7B500" } }, refundSettings: { default_preference: "prefer_no_refund" }, sandboxTestingAccess: "allowlist", sandboxTesters: ["qa \"one\"", "ünïcode"], brand: { color_presets: [{ name: "Gold", hex: "#F7B500" }] }, ownerUserId: o.userId }).where(eqId(s.projects.id, P));
  await db.insert(s.memberships).values({ userId: o.userId, projectId: P, role: "admin" }).onConflictDoNothing();
  // Secrets of every kind: plain credentials, sealed store secrets, a webhook signing secret and authorization header.
  await db.update(s.apps).set({ credentials: { issuer_id: "57246542-96fe-1a63-e053-0824d011072a", key_id: "ABC123DEF4", private_key: "-----BEGIN PRIVATE KEY-----\nMIGT…\n-----END PRIVATE KEY-----" } }).where(eqId(s.apps.id, "app_ios"));
  await db.insert(s.apps).values({ id: "app_stripe", projectId: P, name: "Web (Stripe)", type: "stripe", publicKey: "strp_seed_key_123", secrets: await seal({ stripe_secret_key: "rk_test_seedSecretKeyValue1234", stripe_webhook_secret: "whsec_seedwebhook" }, key), secretHints: { stripe_secret_key: "rk_test_…1234" } });
  await db.insert(s.subscriberTokens).values({ hash: "tokhash1", projectId: P, appId: "app_ios", appUserId: "u1", expiresAt: T });
  await db.insert(s.customers).values([
    { id: "cus_1", projectId: P, originalAppUserId: "u1", firstSeen: new Date("2026-08-01T00:00:00.123Z"), lastSeen: T, lastSeenCountry: "US", lastSeenPlatform: "iOS", originalPurchaseDate: T },
    { id: "cus_2", projectId: P, originalAppUserId: "$RCAnonymousID:abc", firstSeen: T, lastSeen: T },
  ]);
  await db.insert(s.customerAliases).values([{ projectId: P, appUserId: "u1", customerId: "cus_1" }, { projectId: P, appUserId: "u1-alias", customerId: "cus_1" }, { projectId: P, appUserId: "$RCAnonymousID:abc", customerId: "cus_2" }]);
  await db.insert(s.customerAttributes).values([{ customerId: "cus_1", key: "$email", value: "o'brien@example.com", updatedAtMs: 1_790_000_000_123 }, { customerId: "cus_1", key: "note", value: "line1\nline2 ☃ \"quoted\"", updatedAtMs: 1 }]);
  await db.insert(s.customerAttribution).values({ customerId: "cus_1", projectId: P, mediaSource: "Apple Search Ads", campaign: "Brand US", campaignId: "542370539", partnerIds: { appsflyer_id: "af-1" } });
  await db.insert(s.subscriptions).values({ id: "sub_1", projectId: P, customerId: "cus_1", appId: "app_ios", store: "app_store", storeKey: "orig_1", productIdentifier: "pro_monthly", purchaseDate: T, originalPurchaseDate: T, expiresDate: new Date(T.getTime() + 30 * 86400_000), priceAmount: 9.99, priceCurrency: "EUR", priceUsd: 10.723456789012345, eligibleWinBackOfferIds: ["wb1", "wb2"], countryCode: "DE" });
  await db.insert(s.nonSubscriptions).values({ id: "ns_1", projectId: P, customerId: "cus_1", appId: "app_test", store: "test_store", productIdentifier: "lifetime", storeTransactionId: "tx_life", purchaseDate: T, priceAmount: 149.99, priceUsd: 149.99 });
  await db.insert(s.transactions).values([
    { id: "txn_1", projectId: P, customerId: "cus_1", appId: "app_ios", store: "app_store", storeTransactionId: "tx_1", productIdentifier: "pro_monthly", kind: "purchase", purchasedAt: T, revenueUsd: 10.72, priceAmount: 9.99, priceCurrency: "EUR" },
    { id: "txn_2", projectId: P, customerId: "cus_1", appId: "app_ios", store: "app_store", storeTransactionId: "tx_1", productIdentifier: "pro_monthly", kind: "refund", purchasedAt: T, revenueUsd: -10.72 },
  ]);
  await db.insert(s.events).values({ id: "evt_1", projectId: P, customerId: "cus_1", type: "INITIAL_PURCHASE", environment: "PRODUCTION", appId: "app_ios", payload: { event: { id: "evt_1", type: "INITIAL_PURCHASE", nested: { a: [1, 2.5, null, "x"] } }, api_version: "1.0" }, eventTimestampMs: 1_790_000_000_999 });
  await db.insert(s.webhooks).values({ id: "wh_1", projectId: P, name: "Backend", url: "https://example.com/hook", authorizationHeader: "Bearer backend-token", signingSecret: "whsec_original_signing_secret", eventTypes: ["INITIAL_PURCHASE", "RENEWAL"] });
  await db.insert(s.webhookDeliveries).values({ id: "del_1", webhookId: "wh_1", eventId: "evt_1", status: "pending", nextAttemptAt: T });
  await db.insert(s.sdkVersions).values({ projectId: P, appId: "app_ios", platform: "iOS", sdkVersion: "5.92.0" });
  await db.insert(s.storeNotifications).values({ id: "sn_1", projectId: P, appId: "app_ios", store: "app_store", type: "DID_RENEW", body: "{\"signedPayload\":\"eyJ...\"}" });
  await db.insert(s.alerts).values({ id: "al_1", projectId: P, kind: "webhook", subjectId: "wh_1", status: "open", openedAt: T });
  await db.insert(s.virtualCurrencies).values({ projectId: P, code: "GEM", name: "Gems", productGrants: [{ product_ids: ["p6"], amount: 100, trial_amount: 0, expire_at_cycle_end: false }] });
  await db.insert(s.virtualCurrencyBalances).values({ customerId: "cus_1", code: "GEM", balance: 2_000_000_000 });
  await db.insert(s.virtualCurrencyTransactions).values({ id: "vct_1", projectId: P, customerId: "cus_1", code: "GEM", amount: 100, source: "purchase", sourceKey: "tx_coins" });
  await db.insert(s.auditLogs).values({ id: "aud_1", projectId: P, actionType: "created", targetType: "webhook", targetIdentifier: "wh_1", actorType: "user", actorIdentifier: o.userId, occurredAt: T });
  await db.insert(s.paywalls).values({ id: "pw_1", projectId: P, name: "Main", offeringId: "ofr_default", draft: { components_config: { base: { stack: { components: [] } } }, components_localizations: { en_US: { title: "Go Pro" } }, default_locale: "en_US", automatically_scale_font_size: true, exit_offers: null, state_declarations: null, play_store_product_change_mode: null, revision: 3 } });
  await db.insert(s.paywallVersions).values({ id: "pwv_1", paywallId: "pw_1", name: "v1", revision: 1, content: { components_config: null, components_localizations: {}, default_locale: null, automatically_scale_font_size: false, exit_offers: null, state_declarations: null, play_store_product_change_mode: null, revision: 1 } });
  await db.insert(s.mediaAssets).values({ id: "ma_1", projectId: P, kind: "image", objectName: "hero.png", originalName: "hero.png", contentType: "image/png", size: 8, dataBase64: "iVBORw0KGgo=" });
  await db.insert(s.savedCharts).values({ id: "sc_1", projectId: P, name: "MRR", chartName: "mrr", view: { range: "90d" }, createdBy: o.userId });
  await db.insert(s.chartAnnotations).values({ id: `chartannot_${P}`, projectId: P, startDate: "2026-09-01", endDate: "2026-09-03", title: "Launch", description: "Version 2.0", createdBy: o.userId });
  await db.insert(s.chartShares).values({ id: `chartshare_${P}`, projectId: P, token: `cs_${P}`, tokenHash: `hash_${P}`, chartName: "mrr", view: { range: "90d" }, snapshot: { v: 1, title: "MRR" }, image: "iVBORw0KGgo=", createdBy: o.userId });
  await db.insert(s.audiences).values({ id: "aud_us", projectId: P, name: "US", rules: { groups: [{ conditions: [{ field: "country", operator: "is", value: "US" }] }] } });
  await db.insert(s.targetingRules).values({ id: "tr_1", projectId: P, name: "US default", audienceId: "aud_us", offeringId: "ofr_default", placements: { home: "ofr_default", settings: null }, position: 0, state: "active" });
  await db.insert(s.experiments).values({ id: "ex_1", projectId: P, name: "Price test", offeringA: "ofr_default", offeringB: "ofr_default", status: "running", startedAt: T });
  await db.insert(s.experimentEnrollments).values({ experimentId: "ex_1", customerId: "cus_1", variant: "b", enrolledAt: T });
  await db.insert(s.sdkEvents).values({ projectId: P, id: "sdk_evt_1", appId: "app_ios", customerId: "cus_1", appUserId: "u1", type: "paywall_impression", occurredAt: T, payload: { paywall_id: "pw_1" } });
  await db.insert(s.customerActivity).values({ projectId: P, customerId: "cus_1", day: "2026-08-20" });
  await db.insert(s.integrations).values({ id: "int_1", projectId: P, kind: "slack", name: "Slack", settings: { channel: "#sales" }, secrets: await seal({ webhook_url: "https://hooks.slack.com/services/T000/B000/XXXX" }, key), secretHints: { webhook_url: "hooks.slack.com/…XXXX" } });
  await db.insert(s.integrationDeliveries).values({ id: "idl_1", integrationId: "int_1", eventId: "evt_1", status: "delivered", attempts: 1, sentAs: "Initial purchase" });
  await db.insert(s.exportJobs).values({ id: "ej_1", projectId: P, name: "Nightly", destination: "s3", destinationConfig: { bucket: "b", region: "eu-west-1", access_key_id: "AKIA" }, secrets: await seal({ secret_access_key: "s3-secret" }, key), secretHints: { secret_access_key: "••••cret" }, tables: ["transactions"], cursor: { transactions: 1_790_000_000_000 } });
  await db.insert(s.exportRuns).values({ id: "er_1", jobId: "ej_1", status: "succeeded", trigger: "manual", mode: "full", windowEnd: T, files: [{ table: "transactions", key: "k", rows: 1, bytes: 10 }] });
  await db.insert(s.refundPolicies).values({ id: "rp_1", projectId: P, name: "New buyers", rules: { groups: [] }, preference: "prefer_refund", position: 0 });
  await db.insert(s.refundRequests).values({ id: "rr_1", projectId: P, customerId: "cus_1", store: "app_store", transactionId: "tx_1", requestedAt: T, consumptionStatus: "sent", consumption: { customerConsented: true } });
  await db.insert(s.retentionOffers).values({ id: "ro_1", projectId: P, trigger: "cancel", name: "Stay", title: "50% off", store: "app_store", productMapping: { pro_monthly: "promo_50" } });
  await db.insert(s.supportTickets).values({ id: "st_1", projectId: P, customerId: "cus_1", appUserId: "u1", customerEmail: "u1@example.com", description: "Help ✋" });
  await db.insert(s.winbackCampaigns).values({ id: "wc_1", projectId: P, name: "Come back", audience: { days: 30 }, email: { subject: "Hi" }, offer: { kind: "code" } });
  await db.insert(s.winbackSends).values({ id: "ws_1", campaignId: "wc_1", projectId: P, customerId: "cus_1", email: "u1@example.com", token: "wbtok_seed_1", offerUrl: "https://example.com/o", sentAt: T });
  await db.insert(s.emailSuppressions).values({ projectId: P, email: "gone@example.com" });
  await db.insert(s.webConfigs).values({ appId: "app_stripe", projectId: P, config: { app_name: "Scanner", colors: { accent: "#000" } } });
  await db.insert(s.products).values({ id: "p_web", projectId: P, appId: "app_stripe", storeIdentifier: "price_X", type: "subscription" });
  await db.insert(s.products).values({ id: "p_prices", projectId: P, appId: "app_test", storeIdentifier: "pro_euro", type: "subscription", testStorePriceMicros: 9_990_000, testStorePriceCurrency: "USD" });
  await db.insert(s.productPrices).values([{ id: "prc_usd", productId: "p_prices", projectId: P, currency: "USD", amountMicros: 9_990_000 }, { id: "prc_eur", productId: "p_prices", projectId: P, currency: "EUR", amountMicros: 8_990_000 }]);
  await db.insert(s.webProducts).values({ productId: "p_web", projectId: P, appId: "app_stripe", stripeProductId: "prod_X", stripePriceId: "price_X", amountMinor: 999, currency: "usd", interval: "month", intervalCount: 1 });
  await db.insert(s.webDomains).values({ projectId: P, slug: `scanner-${P}`, verificationToken: "verify-me" });
  await db.insert(s.purchaseLinks).values({ id: "pl_1", projectId: P, appId: "app_stripe", offeringId: "ofr_default", name: "Launch", slug: "launch" });
  await db.insert(s.funnels).values({ id: "fn_1", projectId: P, appId: "app_stripe", name: "Quiz", slug: "quiz", draft: { steps: [{ id: "a" }] }, published: null });
  await db.insert(s.funnelEvents).values({ id: "fe_1", projectId: P, funnelId: "fn_1", sessionId: "sess", type: "funnel_viewed", properties: { utm: "x" }, revenueUsd: 0.1 + 0.2 });
  await db.insert(s.webCheckouts).values({ id: "wco_1", projectId: P, appId: "app_stripe", sourceType: "purchase_link", appUserId: "u1", stripeSessionId: "cs_seed", redemptionSeed: "seed-secret-value", redemptionTokenHash: "rthash", previousTokenHashes: ["old1"] });
  await db.insert(s.discounts).values({ id: "disc_1", projectId: P, identifier: "launch", customerFacingName: "Launch", type: "percentage", percentage: 20, durationMode: "once" });
  await db.insert(s.discountCodes).values({ projectId: P, codeKey: "LAUNCH20", code: "launch20", discountId: "disc_1" });
  await db.insert(s.adRewardRules).values({ id: "arr_1", projectId: P, name: "Gems", position: 0, kind: "virtual_currency", currencyCode: "GEM", amount: 5, multiplier: 1.5 });
  await db.insert(s.adRewardVerifications).values({ id: "arv_1", projectId: P, customerId: "cus_1", appUserId: "u1", clientTransactionId: "ctx_1", network: "admob", networkTransactionId: `ntx_${P}`, status: "verified", occurredAt: T, rewards: [{ type: "virtual_currency", code: "GEM", amount: 5 }] });
  await db.insert(s.adUnits).values({ projectId: P, network: "admob", adUnitId: "ca-app-pub-1/2", displayName: "Rewarded" });
  await db.insert(s.aiShareCards).values({ id: `card_${P}`, projectId: P, kind: "first_sale", data: { amount: 9.99 } });
  await db.insert(s.authProviders).values({ id: "ap_1", projectId: P, kind: "oidc", name: "Login", issuer: "https://idp.example.com", audiences: ["ios-client", "android-client"] });
  await db.insert(s.identityLinks).values({ projectId: P, providerId: "ap_1", subject: "sub-1", appUserId: "u1" });
  await db.insert(s.identitySessions).values({ id: "is_1", projectId: P, appId: "app_ios", appUserId: "u1", providerId: "ap_1", subject: "sub-1", method: "oidc", refreshHash: `rh_${P}`, expiresAt: T });
  await db.insert(s.blockedCustomers).values({ projectId: P, appUserId: "fraud_1", note: "chargebacks", blockedBy: o.userId });
  await db.insert(s.verifiedPages).values({ projectId: P, slug: `scanner-metrics-${P}`, displayName: "Scanner", metrics: [{ id: "mrr", visible: true }] });
  await db.insert(s.stripeConnections).values({ appId: "app_stripe", projectId: P, status: "disconnected", method: "oauth", mode: "test", disconnectedAt: T, disconnectReason: "Disconnected in Stripe", pendingStateHash: "pending-state", connectedBy: o.userId });
  await db.insert(s.recoveryCases).values({ id: `rcv_${P}`, projectId: P, customerId: "cus_1", subscriptionId: "sub_1", appId: "app_ios", store: "app_store", storeKey: "orig_1", productId: "pro_monthly", detectedAt: T, atRiskUsd: 10.72, email: "u1@example.com", stepsSent: 1, nextStepAt: T, firstSentAt: T, token: `rcvtok_${P}_0000000000000` });
  await db.insert(s.recoveryMessages).values({ id: `rcm_${P}`, caseId: `rcv_${P}`, projectId: P, step: 0, email: "u1@example.com", sentAt: T });
}

import { eq } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
const eqId = (c: AnyPgColumn, v: string) => eq(c, v);
