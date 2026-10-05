// Subscription glossary: /glossary/<slug>. Writing rules: apps/site/CONTENT.md. Store facts come from Apple's and Google's
// public documentation (checked October 2026); RevenueDot behavior comes from the public guides in revenuedot/docs and docs/STATUS.md.
import type { Source } from "./types";
import type { Faq } from "../site";

export type Term = {
  slug: string; // e.g. "billing-grace-period"
  term: string; // e.g. "Billing grace period"
  /** One sentence, max 160 characters: meta description and card text. */
  short: string;
  /** 40 to 70 words: a quotable definition with no marketing. */
  answer: string;
  /** 2 to 4 paragraphs: App Store and Google Play differences, what developers must do, how RevenueDot handles it. */
  body: string[];
  /** One concrete illustration with round numbers. */
  example?: string;
  faq: Faq[];
  /** Official documentation checked in October 2026. */
  sources: Source[];
  /** Site paths: /glossary/x, /charts/x, /features/x, /stores/x, /docs/..., /blog/... */
  related: string[];
  category: "Billing" | "Offers and trials" | "Metrics" | "Store notifications" | "Paywalls and growth" | "Platform";
};

const src = (label: string, url: string): Source => ({ label, url });

// Apple
const APPLE_SUBS = src("Apple: Auto-renewable subscriptions", "https://developer.apple.com/app-store/subscriptions/");
const APPLE_IAP_TYPES = src("App Store Connect Help: In-App Purchase types", "https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-types");
const APPLE_IAP = src("Apple: Apple In-App Purchase (StoreKit)", "https://developer.apple.com/documentation/storekit/in-app-purchase");
const APPLE_INTRO = src("App Store Connect Help: Set up introductory offers", "https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-introductory-offers-for-auto-renewable-subscriptions");
const APPLE_PROMO = src("Apple: Implementing promotional offers in your app", "https://developer.apple.com/documentation/storekit/implementing-promotional-offers-in-your-app");
const APPLE_WINBACK = src("Apple: Supporting win-back offers in your app", "https://developer.apple.com/documentation/storekit/supporting-win-back-offers-in-your-app");
const APPLE_OFFER_CODES = src("Apple: Supporting offer codes in your app", "https://developer.apple.com/documentation/storekit/supporting-offer-codes-in-your-app");
const APPLE_OFFER_CODES_HELP = src("App Store Connect Help: Set up offer codes", "https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-offer-codes");
const APPLE_GRACE = src("App Store Connect Help: Enable billing grace period", "https://developer.apple.com/help/app-store-connect/manage-subscriptions/enable-billing-grace-period-for-auto-renewable-subscriptions");
const APPLE_CHURN = src("Apple: Reducing involuntary subscriber churn", "https://developer.apple.com/documentation/storekit/reducing-involuntary-subscriber-churn");
const APPLE_NTYPE = src("Apple: notificationType", "https://developer.apple.com/documentation/appstoreservernotifications/notificationtype");
const APPLE_SUBTYPE = src("Apple: subtype", "https://developer.apple.com/documentation/appstoreservernotifications/subtype");
const APPLE_SEND_CONSUMPTION = src("Apple: Send Consumption Information", "https://developer.apple.com/documentation/appstoreserverapi/send-consumption-information");
const APPLE_SEND_CONSUMPTION_V1 = src("Apple: Send Consumption Information V1", "https://developer.apple.com/documentation/appstoreserverapi/send-consumption-information-v1");
const APPLE_RESPOND = src("Apple: Responding to App Store Server Notifications", "https://developer.apple.com/documentation/appstoreservernotifications/responding-to-app-store-server-notifications");
const APPLE_REFUND_NOTIF = src("Apple: Handling refund notifications", "https://developer.apple.com/documentation/storekit/handling-refund-notifications");
const APPLE_FAMILY = src("Apple: Supporting Family Sharing in your app", "https://developer.apple.com/documentation/storekit/supporting-family-sharing-in-your-app");
const APPLE_ENABLE_ASSN = src("Apple: Enabling App Store Server Notifications", "https://developer.apple.com/documentation/appstoreservernotifications/enabling-app-store-server-notifications");
const APPLE_ASSN = src("Apple: App Store Server Notifications", "https://developer.apple.com/documentation/appstoreservernotifications");
const APPLE_API = src("Apple: App Store Server API", "https://developer.apple.com/documentation/appstoreserverapi");
const APPLE_JWS_TX = src("Apple: JWSTransaction", "https://developer.apple.com/documentation/appstoreserverapi/jwstransaction");
const APPLE_ORIGINAL_ID = src("Apple: originalTransactionId", "https://developer.apple.com/documentation/appstoreserverapi/originaltransactionid");
const APPLE_VERIFICATION = src("Apple: VerificationResult", "https://developer.apple.com/documentation/storekit/verificationresult");
const APPLE_RECEIPTS = src("Apple: App Store Receipts", "https://developer.apple.com/documentation/appstorereceipts");
const APPLE_SANDBOX = src("Apple: Testing Apple In-App Purchases with sandbox", "https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox");
const APPLE_SMALL_BUSINESS = src("Apple: App Store Small Business Program", "https://developer.apple.com/app-store/small-business-program/");
const APPLE_GUIDELINES = src("Apple: App Review Guidelines", "https://developer.apple.com/app-store/review/guidelines/");
const APPLE_EXTERNAL = src("Apple: External Purchase", "https://developer.apple.com/documentation/storekit/external-purchase");
const APPLE_MANAGE = src("Apple: showManageSubscriptions(in:)", "https://developer.apple.com/documentation/storekit/appstore/showmanagesubscriptions(in:)");
const APPLE_TRANSACTION = src("Apple: Transaction", "https://developer.apple.com/documentation/storekit/transaction");
const APPLE_PRODUCT = src("Apple: Product", "https://developer.apple.com/documentation/storekit/product");
const APPLE_TESTING_STAGES = src("Apple: Testing at all stages of development with Xcode and the sandbox", "https://developer.apple.com/documentation/storekit/testing-at-all-stages-of-development-with-xcode-and-the-sandbox");
const APPLE_LOOKUP_ORDER = src("Apple: Look Up Order ID", "https://developer.apple.com/documentation/appstoreserverapi/look-up-order-id");

// Google
const GOOGLE_SUBS = src("Android Developers: Subscriptions", "https://developer.android.com/google/play/billing/subscriptions");
const GOOGLE_LIFECYCLE = src("Android Developers: Subscription lifecycle", "https://developer.android.com/google/play/billing/lifecycle/subscriptions");
const GOOGLE_RTDN = src("Android Developers: Real-time developer notifications reference", "https://developer.android.com/google/play/billing/rtdn-reference");
const GOOGLE_READY = src("Android Developers: Prepare your app and backend for billing", "https://developer.android.com/google/play/billing/getting-ready");
const GOOGLE_SECURITY = src("Android Developers: Fight fraud and abuse", "https://developer.android.com/google/play/billing/security");
const GOOGLE_TEST = src("Android Developers: Test your Play Billing Library integration", "https://developer.android.com/google/play/billing/test");
const GOOGLE_PRICE = src("Android Developers: Change subscription prices", "https://developer.android.com/google/play/billing/price-changes");
const GOOGLE_INTEGRATE = src("Android Developers: Integrate the Play Billing Library", "https://developer.android.com/google/play/billing/integrate");
const GOOGLE_BILLING = src("Android Developers: Google Play's billing system", "https://developer.android.com/google/play/billing");
const GOOGLE_DEPRECATION = src("Android Developers: Play Billing Library version deprecation", "https://developer.android.com/google/play/billing/deprecation-faq");
const GOOGLE_VOIDED = src("Google Play Developer API: Voided Purchases API", "https://developers.google.com/android-publisher/voided-purchases");
const GOOGLE_HELP_UNDERSTAND = src("Play Console Help: Understanding subscriptions", "https://support.google.com/googleplay/android-developer/answer/12154973");
const GOOGLE_HELP_CREATE = src("Play Console Help: Create and manage subscriptions", "https://support.google.com/googleplay/android-developer/answer/140504");
const GOOGLE_HELP_FEES = src("Play Console Help: Service fees", "https://support.google.com/googleplay/android-developer/answer/112622");
const GOOGLE_HELP_PROMO = src("Play Console Help: Create promotions", "https://support.google.com/googleplay/android-developer/answer/6321495");

// Others
const STRIPE_ANALYTICS = src("Stripe Docs: Billing analytics definitions", "https://docs.stripe.com/billing/subscriptions/analytics");
const RC_ACCOUNT = src("RevenueCat Docs: Account management (MTR)", "https://www.revenuecat.com/docs/welcome/set-up-revenuecat/account-management");
const RC_PRICING = src("RevenueCat: Pricing", "https://www.revenuecat.com/pricing/");
const RC_ENTITLEMENTS = src("RevenueCat Docs: Entitlements", "https://www.revenuecat.com/docs/getting-started/entitlements");
const RC_OFFERINGS = src("RevenueCat Docs: Offerings", "https://www.revenuecat.com/docs/offerings/overview");
const RC_CUSTOMER_CENTER = src("RevenueCat Docs: Customer Center", "https://www.revenuecat.com/docs/tools/customer-center");
const RC_BENCHMARKS = src("RevenueCat: Subscription app trends and benchmarks 2026", "https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026");
const RC_CHARTS = src("RevenueCat Docs: Charts", "https://www.revenuecat.com/docs/dashboard-and-metrics/charts");
const RC_REDEMPTION = src("RevenueCat Docs: Redemption Links", "https://www.revenuecat.com/docs/web/redemption-links");
const RC_PURCHASE_LINKS = src("RevenueCat Docs: Web Purchase Links", "https://www.revenuecat.com/docs/web/web-billing/web-purchase-links");

export const GLOSSARY: Term[] = [
  // ---------------------------------------------------------------------------------------------------------------
  // Billing
  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "auto-renewable-subscription",
    term: "Auto-renewable subscription",
    category: "Billing",
    short: "An auto-renewable subscription charges the customer again at the end of every billing period until they cancel. Apple and Google sell it under different rules.",
    answer:
      "An auto-renewable subscription is an in-app purchase that gives access for a fixed period, such as a week, a month or a year, and charges the customer again at the end of each period until they cancel. Apple calls it an auto-renewable subscription. Google Play sells it as a subscription with one or more auto-renewing base plans.",
    body: [
      "On the App Store, each subscription lives in a subscription group, and the duration is one of 1 week, 1 month, 2 months, 3 months, 6 months or 1 year. A customer can hold one subscription per group at a time. Apple keeps the same original transaction ID across every renewal, so that ID identifies the subscription for its whole life. On Google Play, one subscription product holds base plans and offers, and the purchase token identifies the purchase. A customer who resubscribes after expiry gets a new purchase token.",
      "Your app must do three things. Give access only while the store says the subscription is paid or in a grace period. Verify purchases on your server or rely on StoreKit's own verification on Apple platforms. On Google Play, acknowledge every new purchase within three days or Google refunds it. Then listen to server notifications, because a renewal, a failed charge or a refund can happen while your app is closed.",
      "RevenueDot keeps one record per subscription, keyed by the original transaction ID on the App Store and by the purchase token on Google Play. Every receipt from the device and every store notification updates that record, and each change becomes an event such as `INITIAL_PURCHASE`, `RENEWAL` or `CANCELLATION`.",
    ],
    example:
      "A $10 monthly subscription bought on March 1 renews on April 1 and May 1. If the customer turns off auto-renew on April 15, the subscription keeps working until May 1 and then expires without a new charge.",
    faq: [
      { q: "How long can an auto-renewable subscription last on the App Store?", a: "App Store Connect offers 1 week, 1 month, 2 months, 3 months, 6 months and 1 year. You pick one duration per subscription product." },
      { q: "What is the difference between an auto-renewable and a non-renewing subscription?", a: "An auto-renewable subscription charges again by itself until the customer cancels. A non-renewing subscription gives access for a fixed time and never charges again unless the customer buys it again." },
      { q: "Do I need a server to sell auto-renewable subscriptions?", a: "Not to start. StoreKit can verify transactions on the device. A server lets you receive store notifications, share access across iOS, Android and web, and keep records that survive reinstalls." },
    ],
    sources: [APPLE_SUBS, APPLE_IAP_TYPES, GOOGLE_HELP_UNDERSTAND, GOOGLE_LIFECYCLE],
    related: ["/glossary/subscription-group", "/glossary/non-renewing-subscription", "/glossary/entitlement", "/docs/concepts/subscriptions-and-events", "/charts/active-subscriptions", "/stores/app-store"],
  },
  {
    slug: "non-renewing-subscription",
    term: "Non-renewing subscription",
    category: "Billing",
    short: "A non-renewing subscription gives access for a fixed time and never charges again on its own. On Google Play the closest match is a prepaid plan with top-ups.",
    answer:
      "A non-renewing subscription is an in-app purchase that gives access for a limited time and does not renew by itself. The app must sell it again when the time ends. Apple offers it as its own product type. On Google Play the closest match is a prepaid base plan, which customers extend by buying a top-up.",
    body: [
      "Apple describes a non-renewing subscription as a product that allows users to purchase a service with a limited duration and does not renew automatically. Apple records the purchase and sends a `ONE_TIME_CHARGE` notification, but it runs no renewal cycle for it. Your own logic decides when access ends, and your app or server must sell it again.",
      "Google Play has no product type with this name. A prepaid base plan inside a subscription gives access for a set period without auto-renewal, and the customer can buy a top-up from the same subscription to extend the end date. Prepaid purchases and each top-up must be acknowledged: within three days for plans of one week or longer, and within half the plan duration for shorter plans.",
      "In RevenueDot you create a product of type `non_renewing_subscription`, and each purchase is recorded as a `NON_RENEWING_PURCHASE` event. RevenueDot does not run a renewal cycle for it either.",
    ],
    faq: [
      { q: "When should I use a non-renewing subscription?", a: "Use it when you sell a fixed season or pass, such as a one-year archive or a 90-day course, and you do not want to charge again without the customer choosing to. You give up predictable renewals and must build the re-purchase prompt yourself." },
      { q: "Can a non-renewing subscription renew automatically?", a: "No. The App Store never charges again for it. If the customer wants more time, they buy it again." },
      { q: "What is Google Play's equivalent?", a: "A prepaid base plan on a subscription product. The customer tops up to extend access, and each top-up is charged at the full price of the plan they choose." },
    ],
    sources: [APPLE_IAP_TYPES, APPLE_NTYPE, GOOGLE_HELP_UNDERSTAND, GOOGLE_SUBS],
    related: ["/glossary/auto-renewable-subscription", "/glossary/consumable-and-non-consumable-in-app-purchase", "/glossary/product-identifier", "/docs/concepts/products-and-entitlements", "/charts/one-time-purchases"],
  },
  {
    slug: "consumable-and-non-consumable-in-app-purchase",
    term: "Consumable and non-consumable in-app purchase",
    category: "Billing",
    short: "A consumable in-app purchase is used up and can be bought again, like coins. A non-consumable is bought once and kept for good, like a lifetime purchase.",
    answer:
      "A consumable in-app purchase is used up when the customer spends it, such as coins or credits, and can be bought again. A non-consumable in-app purchase is bought once and does not expire or wear out, such as a lifetime purchase or an ad-free upgrade. Neither type renews on its own.",
    body: [
      "Apple defines a consumable as a product that is used once, after which it becomes depleted and must be purchased again, and a non-consumable as a product that is purchased once and does not expire or decrease with use. Google Play sells both as one-time products. The difference shows up in the code: on Google Play a consumable must be consumed before the customer can buy it again, and consuming also acknowledges the purchase. A non-consumable is acknowledged but not consumed.",
      "Acknowledge every Google Play purchase within three days or Google refunds it and revokes access. On Apple platforms, finish each transaction after you deliver the product. If you keep a balance on your server, such as coins, listen for refund notifications so you can take the coins back. Apple sends a `REFUND` notification for both types.",
      "In RevenueDot a product has type `consumable` or `non_consumable`. A consumable never grants an entitlement, and the Android SDK consumes it when RevenueDot answers `should_consume: true`. A non-consumable counts as a lifetime purchase, and a lifetime purchase wins over every other purchase for the same entitlement unless it is refunded.",
    ],
    faq: [
      { q: "Is a lifetime purchase a consumable or a non-consumable?", a: "A non-consumable. The customer buys it once and keeps it. It does not renew, so it does not count as recurring revenue." },
      { q: "Does a one-time purchase count toward MRR?", a: "No. MRR counts only active paid subscriptions, normalized to one month. One-time purchases show up in revenue and in the One-time Purchases chart." },
      { q: "Why does Google Play refund a purchase I did not acknowledge?", a: "Google refunds purchases that the app has not acknowledged or consumed within three days, so a customer is never charged for something the app did not deliver." },
    ],
    sources: [APPLE_IAP_TYPES, APPLE_REFUND_NOTIF, GOOGLE_INTEGRATE],
    related: ["/glossary/non-renewing-subscription", "/glossary/entitlement", "/glossary/mrr", "/charts/one-time-purchases", "/docs/concepts/products-and-entitlements"],
  },
  {
    slug: "product-identifier",
    term: "Product identifier",
    category: "Billing",
    short: "A product identifier is the unique ID you give an in-app product in App Store Connect or Play Console. Your app, server and reports all match purchases by it.",
    answer:
      "A product identifier is the unique string that names one in-app product in a store, such as pro_monthly. You choose it in App Store Connect or Google Play Console. Your app asks the store for the product by this ID, and every purchase, transaction and notification names it, so your app and server must use the same IDs.",
    body: [
      "On the App Store the product ID is set when you create the in-app purchase or subscription, and it appears as `productId` in the signed transaction. On Google Play a subscription has its own ID, and the customer's choice of base plan and offer is passed in the billing flow as an offer token. One-time products have a plain product ID.",
      "Keep one naming scheme across both stores, for example `pro_monthly` and `pro_annual`. Your app code should not branch on product IDs. Map products to an entitlement or an offering instead, so that adding a plan later does not need an app update.",
      "RevenueDot matches each purchase to a product by `store_identifier`. For a Google Play subscription you enter `subscriptionId:basePlanId`, for example `pro:monthly`, and a plain subscription ID also matches every base plan of that subscription. A purchase of an unknown product is saved but grants nothing.",
    ],
    faq: [
      { q: "Should the product ID be the same on iOS and Android?", a: "It is easier to reason about when the names match, but the stores do not require it. Map each store's ID to one entitlement so the app never depends on the ID itself." },
      { q: "Where do I find a product's ID?", a: "In App Store Connect it is on the in-app purchase or subscription page. In Play Console it is on the subscription or one-time product page." },
      { q: "What happens if a purchase has a product ID I did not set up?", a: "In RevenueDot the purchase is saved and shown in customer info, but it grants no entitlement until you create a product with that store ID and attach it." },
    ],
    sources: [APPLE_LOOKUP_ORDER, GOOGLE_INTEGRATE, GOOGLE_SUBS],
    related: ["/glossary/entitlement", "/glossary/offering", "/glossary/base-plan-and-offer", "/docs/concepts/products-and-entitlements", "/docs/concepts/offerings-and-packages"],
  },
  {
    slug: "subscription-group",
    term: "Subscription group",
    category: "Billing",
    short: "An App Store subscription group holds the plans a customer can switch between, and a customer can have only one active plan in it at a time.",
    answer:
      "A subscription group is an App Store container for the auto-renewable subscriptions of one service, such as monthly and yearly Pro. A customer can hold only one subscription in a group at a time, and moving between its levels is an upgrade, a downgrade or a crossgrade. An introductory offer can be used once per group.",
    body: [
      "Apple requires every auto-renewable subscription to belong to a group and to have a level inside it. You rank the subscriptions from the one that offers the most (level 1) to the one that offers the least, and you can put equal plans on the same level. Apple's advice is a single group for most apps, because people can buy only one subscription in a group and the group prevents accidental double purchases. If your app sells separate services, such as two streaming channels, use one group per service. Customers with subscriptions in two groups are billed separately for each.",
      "The group also controls offers and revenue. Each person can redeem one introductory offer per group, even if several products in the group have one. Days of paid service, which decide when Apple's 85% rate starts, are counted per group.",
      "Google Play has no group. A single subscription product holds several base plans, and plan changes work through replacement modes. In RevenueDot a package in an offering holds one product per app, so the group matters only when you create products in App Store Connect. RevenueDot can create the subscription and reuse a group by name.",
    ],
    faq: [
      { q: "How many subscription groups should my app have?", a: "One, unless you sell separate services that a customer may want to buy at the same time. Apple names a single group as the best practice for most apps." },
      { q: "Can I move a subscription to a different group later?", a: "Plan this before you launch. Moving products changes how upgrades, crossgrades and introductory offer eligibility work, so test it in the sandbox before you change a live group." },
      { q: "Does Google Play have subscription groups?", a: "No. Google Play puts base plans and offers under one subscription product, and customers switch plans with a replacement mode." },
    ],
    sources: [APPLE_SUBS, APPLE_INTRO],
    related: ["/glossary/upgrade-downgrade-crossgrade", "/glossary/introductory-offer", "/glossary/base-plan-and-offer", "/docs/guides/app-store", "/stores/app-store"],
  },
  {
    slug: "base-plan-and-offer",
    term: "Base plan and offer (Google Play)",
    category: "Billing",
    short: "On Google Play a base plan sets a subscription's billing period and price, and an offer adds a free trial or discount for eligible customers on top of it.",
    answer:
      "On Google Play, a subscription product holds one or more base plans. A base plan defines the billing period, the renewal type (auto-renewing, prepaid or installments) and the price in each region. An offer sits on a base plan and gives eligible customers a free trial or an introductory price through one or more phases.",
    body: [
      "A subscription can have several base plans, for example a monthly auto-renewing plan, a yearly auto-renewing plan and a monthly prepaid plan. Each subscription can hold up to 250 base plans and offers in total, with at most 50 active at once. A base plan can be bought without an offer. An offer is only available to customers who meet its eligibility rule: new customer acquisition, an upgrade from another plan, or a rule that you check yourself in your app (a developer-determined offer).",
      "An offer has one or more phases. A free trial phase can last from 3 days to 3 years. An introductory price phase can be one payment or up to 52 recurring payments at a lower price. After the last phase the subscription renews at the base plan price. In the billing flow, your app picks the base plan or offer through its offer token.",
      "RevenueDot stores a Google Play subscription as `subscriptionId:basePlanId`, for example `pro:monthly`. It records each period's offer id and an offer type of `free_trial`, `introductory` or `unspecified`, and it sends the offer id as `offer_code` in webhooks.",
    ],
    faq: [
      { q: "What is the difference between a base plan and an offer?", a: "A base plan is the standard price and billing period that anyone can buy. An offer is a discount or trial on a base plan that only eligible customers can use." },
      { q: "How many offers can one subscription have?", a: "Up to 250 base plans and offers combined, with a maximum of 50 active at the same time." },
      { q: "Can I build a win-back offer on Google Play?", a: "Yes, with a developer-determined offer. You decide in your app which lapsed customers qualify, and Google Play does not check eligibility for that type." },
    ],
    sources: [GOOGLE_HELP_UNDERSTAND, GOOGLE_HELP_CREATE, GOOGLE_SUBS],
    related: ["/glossary/introductory-offer", "/glossary/free-trial", "/glossary/win-back-offer", "/glossary/product-identifier", "/docs/guides/google-play", "/stores/google-play"],
  },
  {
    slug: "upgrade-downgrade-crossgrade",
    term: "Upgrade, downgrade and crossgrade",
    category: "Billing",
    short: "Upgrades move a subscriber to a higher level now, downgrades move them to a lower level at the next renewal, and crossgrades move them between equal levels.",
    answer:
      "An upgrade moves a subscriber to a higher-level plan, a downgrade to a lower-level plan, and a crossgrade to a plan at the same level. On the App Store an upgrade starts immediately with a prorated refund, and a downgrade starts at the next renewal. A crossgrade starts immediately only if the duration is the same. Google Play uses replacement modes instead.",
    body: [
      "Apple ranks the plans in a subscription group by level. The server notification `DID_CHANGE_RENEWAL_PREF` carries the result: subtype `UPGRADE` means the customer upgraded or crossgraded to a plan with the same duration, and it takes effect immediately, starting a new billing period with a prorated refund of the unused time. Subtype `DOWNGRADE` means a downgrade or a crossgrade to a different duration, and it takes effect at the next renewal date. An empty subtype means the customer went back to the current plan, which cancels a pending downgrade.",
      "Google Play lets you pick the effect with a replacement mode, described in the proration entry. You can also let customers switch tiers, switch from monthly to annual billing, or move between auto-renewing and prepaid plans, and you can attach an offer to encourage the change.",
      "RevenueDot records an upgrade that applies now, or a change scheduled for the next renewal, as a `PRODUCT_CHANGE` event with the new product ID. For revenue charts, a change from one paid plan to another ends one subscription and starts another.",
    ],
    example:
      "A customer on a $5 monthly plan taps a $10 monthly plan one level higher. On the App Store the new plan starts immediately and the unused part of the $5 month is refunded in proportion. If the customer instead moves from the $10 plan down to the $5 plan, the $10 plan runs until its renewal date and the $5 plan starts then.",
    faq: [
      { q: "When does an App Store downgrade take effect?", a: "At the next renewal date. The current plan keeps working until then and does not change." },
      { q: "What is a crossgrade?", a: "A move between two plans at the same level in a subscription group, such as a monthly plan and a yearly plan. If the duration is the same it starts now. If the duration differs, it starts at the next renewal date." },
      { q: "How do I control proration on Google Play?", a: "Set a replacement mode when you launch the billing flow, or set a default in Play Console. The modes are time proration, charge prorated price, charge full price, without proration and deferred." },
    ],
    sources: [APPLE_NTYPE, APPLE_SUBTYPE, APPLE_SUBS, GOOGLE_SUBS],
    related: ["/glossary/proration", "/glossary/subscription-group", "/glossary/auto-renewable-subscription", "/docs/concepts/subscriptions-and-events", "/charts/mrr-movement"],
  },
  {
    slug: "proration",
    term: "Proration (Google Play replacement modes)",
    category: "Billing",
    short: "Proration decides how the unused value of a paid period is credited when a subscriber changes plan. Google Play sets it with a replacement mode.",
    answer:
      "Proration credits the unused part of a paid subscription period when a customer changes plan. On Google Play you choose the effect with a replacement mode: with time proration, charge prorated price, charge full price, without proration, or deferred. The mode decides when the change starts and what the customer pays at once.",
    body: [
      "Google Play documents five modes for changing a subscription. `WITH_TIME_PRORATION` is the default: the change is immediate and the remaining value is turned into time on the new plan, which moves the next billing date. `CHARGE_PRORATED_PRICE` upgrades immediately, keeps the billing date and charges the price difference for the rest of the period. `CHARGE_FULL_PRICE` changes immediately and charges the full new price. `WITHOUT_PRORATION` changes immediately and charges the new price at the next renewal. `DEFERRED` changes only when the subscription renews.",
      "Pick `CHARGE_PRORATED_PRICE` or `WITH_TIME_PRORATION` for upgrades to a higher tier, `CHARGE_FULL_PRICE` when moving from a shorter to a longer billing period, and `DEFERRED` for downgrades. You can set the default in Play Console and override it per purchase. On the App Store you do not choose: Apple prorates an upgrade with a refund and applies a downgrade at the next renewal.",
      "A deferred change creates a new purchase straight away, with the old item set to expire at the end of the current period. Acknowledge that new purchase as you do any other. RevenueDot reports an applied change, or a change scheduled for the next renewal, as a `PRODUCT_CHANGE` event.",
    ],
    faq: [
      { q: "Which replacement mode is the default on Google Play?", a: "With time proration: the change is immediate, and the remaining time is credited toward the new plan by moving the next billing date." },
      { q: "Which mode should I use for a downgrade?", a: "Deferred. The customer keeps what they paid for, and the lower plan starts at the next renewal." },
      { q: "Does the App Store have proration modes?", a: "No. Apple fixes the behavior: an upgrade starts immediately with a prorated refund, and a downgrade starts at the next renewal." },
    ],
    sources: [GOOGLE_SUBS, APPLE_SUBTYPE],
    related: ["/glossary/upgrade-downgrade-crossgrade", "/glossary/base-plan-and-offer", "/glossary/purchase-token", "/docs/guides/google-play", "/stores/google-play"],
  },
  {
    slug: "billing-grace-period",
    term: "Billing grace period",
    category: "Billing",
    short: "A billing grace period lets a subscriber keep access while the store retries a failed renewal charge. Apple sets 3, 16 or 28 days. Google Play lets you set it.",
    answer:
      "A billing grace period is a window after a failed renewal charge in which the subscriber keeps full access while the store tries to collect payment. If the charge succeeds in that window, the subscriber sees no gap and the developer loses no revenue. On the App Store you can choose 3, 16 or 28 days. Google Play lets you set the length.",
    body: [
      "Apple's grace period is opt-in in App Store Connect. The choices are 3, 16 or 28 days for monthly and longer plans, and weekly plans are capped at 6 days. You pick whether it applies to all renewals or only paid-to-paid renewals, and a change can take up to 24 hours to apply. When a renewal fails, Apple sends `DID_FAIL_TO_RENEW` with the subtype `GRACE_PERIOD`, and later `GRACE_PERIOD_EXPIRED` if the period ends unpaid. Your app must keep serving the subscription until then.",
      "On Google Play every auto-renewing base plan has a grace period by default, and you can change its length or turn it off. Google sends `SUBSCRIPTION_IN_GRACE_PERIOD` when a subscription enters it. If you set 0 days, Play still waits at least one day, called a silent grace period, before it moves the subscription on. If the payment is not fixed, the subscription moves to account hold.",
      "RevenueDot grants access until the end of the grace period when the store reports one, and shows it as `in_grace_period` in REST API v2. The `BILLING_ISSUE` event carries `grace_period_expiration_at_ms`. An `EXPIRATION` event is recorded after the grace period ends without a successful renewal.",
    ],
    faq: [
      { q: "How long is Apple's billing grace period?", a: "3, 16 or 28 days, as you choose for the app. Weekly subscriptions are limited to 3 or 6 days. Without a grace period, Apple still retries billing for up to 60 days, but the customer should not have access during that time." },
      { q: "Should I enable a grace period?", a: "Yes for most apps. Apple says that recovery inside the grace period causes no break in the days of paid service and no lost revenue, and the customer never notices the failure." },
      { q: "What does the customer see during a grace period?", a: "Full access. Both stores also prompt them to fix their payment method, and your app can show its own message." },
    ],
    sources: [APPLE_GRACE, APPLE_CHURN, APPLE_NTYPE, GOOGLE_LIFECYCLE],
    related: ["/glossary/billing-retry", "/glossary/account-hold", "/glossary/churn", "/docs/concepts/subscriptions-and-events", "/charts/subscription-status", "/blog/server-side-receipt-validation"],
  },
  {
    slug: "billing-retry",
    term: "Billing retry",
    category: "Billing",
    short: "Billing retry is the period in which the App Store keeps trying to collect a failed subscription renewal charge. Apple retries for up to 60 days.",
    answer:
      "Billing retry is the state a subscription enters when a renewal charge fails, such as an expired card. The App Store keeps trying to collect payment for up to 60 days, or until the customer fixes the problem or cancels. If a retry works, the new billing date is the day of recovery. If none works, the subscription expires.",
    body: [
      "Apple's retry runs in the background and does not depend on your app. You learn about it through server notifications: `DID_FAIL_TO_RENEW` when the charge first fails, `DID_RENEW` with the subtype `BILLING_RECOVERY` when a retry succeeds, and `EXPIRED` with the subtype `BILLING_RETRY` when the 60 days end without payment. In the subscription status you can read `expirationIntent` and the billing retry flag.",
      "A billing grace period sits at the start of the retry. During the grace period the customer keeps access. After it ends, the retry continues but access stops. Apple resumes counting days of paid service from the recovery date if the renewal happens within 60 days. You can deep link customers to their payment settings and show an in-app message that asks them to update their billing details.",
      "Google Play uses a different structure: a grace period, then an account hold, for a total that defaults to 60 days. RevenueDot shows a subscription whose access ended while the store still retries as `in_billing_retry` in REST API v2, and sends `BILLING_ISSUE` when the charge first fails.",
    ],
    faq: [
      { q: "How long does the App Store retry a failed renewal?", a: "Up to 60 days, or until the customer fixes the billing problem or cancels, whichever comes first." },
      { q: "Does the customer keep access during billing retry?", a: "Only during the billing grace period, if you enabled one. After that, access should stop until the payment succeeds." },
      { q: "How do I tell voluntary cancellation from a billing failure?", a: "Apple's `expirationIntent` field and the `EXPIRED` notification subtype separate them. Subtype `VOLUNTARY` means the customer turned off renewal. Subtype `BILLING_RETRY` means retries ended without payment." },
    ],
    sources: [APPLE_CHURN, APPLE_NTYPE, APPLE_SUBS],
    related: ["/glossary/billing-grace-period", "/glossary/account-hold", "/glossary/churn", "/docs/concepts/subscriptions-and-events", "/charts/subscription-status"],
  },
  {
    slug: "account-hold",
    term: "Account hold (Google Play)",
    category: "Billing",
    short: "Account hold is the Google Play state after a grace period ends with the payment still unpaid. The customer has no access, and Google keeps retrying.",
    answer:
      "Account hold is the Google Play state that follows a payment decline and any grace period. The customer loses access to the subscription while Google keeps trying to collect payment. If the payment is fixed, the subscription becomes active again. If the hold ends with the problem unresolved, the subscription expires. By default the hold lasts 60 days minus the grace period.",
    body: [
      "Google's recovery period has two parts: a grace period, where the customer keeps access, and then an account hold, where they do not. By default every auto-renewing base plan has account hold enabled, and its length is 60 days minus the grace period. You can shorten it or turn it off in Play Console, but shorter lengths can reduce the number of subscriptions recovered. Google sends the real-time notification `SUBSCRIPTION_ON_HOLD` when a subscription enters the hold, and `SUBSCRIPTION_RECOVERED` when it is fixed.",
      "During the hold your app must block access, but it should still handle cancellations. If the customer repurchases during the hold, Google issues a new purchase token for the new purchase. If they fix the payment method instead, the purchase token stays the same and the billing date moves to the day of recovery.",
      "For testing, Google shortens the hold to 10 minutes for license testers. RevenueDot reads the purchase from the Google Play Developer API after each notification, so the hold appears as access ended with a billing issue, which REST API v2 reports as `in_billing_retry`.",
    ],
    faq: [
      { q: "What is the difference between grace period and account hold?", a: "In a grace period the customer keeps access while Google retries payment. In account hold they lose access, and Google keeps retrying. The grace period comes first." },
      { q: "How long is the default account hold?", a: "60 days minus the length of the grace period. You can change it in Play Console." },
      { q: "Does the App Store have an account hold?", a: "No. Apple calls the retry phase billing retry, and the customer has no access in it unless you enabled a billing grace period." },
    ],
    sources: [GOOGLE_LIFECYCLE, GOOGLE_HELP_CREATE, GOOGLE_RTDN, GOOGLE_TEST],
    related: ["/glossary/billing-grace-period", "/glossary/billing-retry", "/glossary/real-time-developer-notifications", "/docs/guides/google-play", "/stores/google-play"],
  },
  {
    slug: "paused-subscription",
    term: "Paused subscription (Google Play)",
    category: "Billing",
    short: "A paused Google Play subscription stops charging and access for one week to three months, then resumes. It is a way to keep a customer who would cancel.",
    answer:
      "A paused subscription is a Google Play subscription that the customer has suspended for a set time instead of canceling. The pause starts when the current billing period ends. During it the customer has no access and pays nothing. When the pause ends, the subscription resumes and Google tries to renew it.",
    body: [
      "Pause is on by default for every subscription, and you can turn it off in Play Console. The customer chooses a length from one week to three months, depending on the plan: weekly plans offer 1 to 4 weeks, and monthly and longer plans offer 1, 2 or 3 months. Google notes that these lengths can change. The pause takes effect only after the current billing period ends, so the customer keeps what they paid for.",
      "Your app must stop giving access when the pause starts. Google sends `SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED` when the customer sets up a pause, while access continues, and `SUBSCRIPTION_PAUSED` when the pause takes effect. The subscription state is `SUBSCRIPTION_STATE_PAUSED`. If the customer resumes early, or the pause ends, Google sends `SUBSCRIPTION_RECOVERED`. If the renewal then fails, the subscription moves to account hold.",
      "RevenueDot reports `SUBSCRIPTION_PAUSED` events with `auto_resume_at_ms`, and REST API v2 shows the subscription as `paused` with no access. A scheduled pause appears as `will_pause` in `auto_renewal_status`.",
    ],
    faq: [
      { q: "Does Apple have paused subscriptions?", a: "No. This is a Google Play feature. On the App Store a customer either keeps the subscription or turns off auto-renew." },
      { q: "Does the customer keep access during a pause?", a: "No. A pause takes effect after the paid period ends, and the customer has no access and pays nothing until it ends." },
      { q: "Can I turn pause off?", a: "Yes, in Play Console. Pause is enabled by default for all subscriptions." },
    ],
    sources: [GOOGLE_LIFECYCLE, GOOGLE_HELP_CREATE, GOOGLE_RTDN],
    related: ["/glossary/account-hold", "/glossary/churn", "/glossary/real-time-developer-notifications", "/charts/subscription-status", "/docs/concepts/subscriptions-and-events"],
  },
  {
    slug: "refund",
    term: "Refund",
    category: "Billing",
    short: "A refund returns a customer's payment after the store approves it. Apple decides on its own with your input, and Google Play lets you refund and revoke access.",
    answer:
      "A refund is a payment returned to a customer for an in-app purchase. On the App Store, the customer asks Apple, and Apple decides, using consumption data that you may send. On Google Play, the customer can ask for one, and you can also refund and revoke access from your own backend. In both stores, a refund ends access to what was bought.",
    body: [
      "On the App Store customers ask Apple Support, use Apple's self-service request tool, or ask their card issuer. Apple sends your server a `REFUND` notification when it refunds a purchase, `REFUND_DECLINED` when it turns down an in-app request, and `REFUND_REVERSED` when a granted refund is reversed after a dispute. Before the decision, Apple can send a `CONSUMPTION_REQUEST` that lets you share usage data.",
      "On Google Play a refund can start with the customer, the developer or Google. A developer refund through the Orders API can set the revoke option, which also removes access. A refund with revoke, a cancellation or a chargeback shows up in the Voided Purchases API, and a subscription revocation sends `SUBSCRIPTION_REVOKED`. Your system must stop access for voided purchases.",
      "RevenueDot records a store refund as a `CANCELLATION` event with `cancel_reason: CUSTOMER_SUPPORT` and a negative price, ends access at the refund time, and sends `REFUND_REVERSED` when a refund is undone. The Refunds and Refund Rate charts count them on the refund date and on the purchase date respectively.",
    ],
    faq: [
      { q: "Who decides an App Store refund?", a: "Apple. You can influence the decision by answering the consumption request with usage data and a refund preference, but Apple makes the call." },
      { q: "Can I refund a customer myself?", a: "On Google Play yes, through the Play Developer API, with the revoke option if you also want to end access. On the App Store, customers request refunds from Apple, and Apple decides." },
      { q: "Does a refund count in MRR?", a: "A refunded subscription stops counting from the refund time, and the refund is counted on its own in the refund charts." },
    ],
    sources: [APPLE_REFUND_NOTIF, APPLE_NTYPE, APPLE_SEND_CONSUMPTION, GOOGLE_VOIDED, GOOGLE_SECURITY],
    related: ["/glossary/consumption-request", "/glossary/chargeback-and-voided-purchase", "/charts/refund-rate", "/charts/refunds", "/features/refund-control", "/blog/apple-refund-requests-consumption-info"],
  },
  {
    slug: "chargeback-and-voided-purchase",
    term: "Chargeback and voided purchase",
    category: "Billing",
    short: "A chargeback is a payment reversal forced by the customer's card issuer. Google Play lists these as voided purchases, and your app must revoke the access.",
    answer:
      "A chargeback is a payment the customer's bank reverses after a dispute. On Google Play, a voided purchase is any order that was refunded, canceled or charged back and needs access revoked. Google's Voided Purchases API lists them. Apple reports a reversed payment as a refund notification instead of a separate type.",
    body: [
      "Google says a purchase can be voided when the user asks for a refund, the user cancels, the order is charged back, or the developer or Google cancels or refunds it with revoke on. The Voided Purchases API covers one-time orders and subscriptions, needs permission to view financial data, and returns the last 30 days at most. A refund without the revoke option is not returned. Use the API as a backup to real-time notifications, which also send voided-purchase messages.",
      "Apple sends `REFUND` when it refunds a transaction and `REFUND_REVERSED` when it reverses a previously granted refund after a dispute that the customer raised. There is no separate chargeback notification to build around. Your server must treat `REFUND` as the end of access.",
      "RevenueDot reads Google's voided purchases through real-time notifications and also once a day for the last 30 days as a backup. It records each one as a refund, and in Refund Control it counts a Google Play refund or chargeback as an approved refund request, because Google has no consumption API to answer.",
    ],
    faq: [
      { q: "What is a voided purchase?", a: "A Google Play order that was refunded, canceled or charged back, and that you should treat as no longer paid." },
      { q: "How far back does the Voided Purchases API go?", a: "30 days. Older voided purchases are not returned, even if you ask for an earlier start time." },
      { q: "Does Apple tell me about chargebacks?", a: "Apple reports them as refund notifications. A refund that is later reversed after a dispute arrives as `REFUND_REVERSED`." },
    ],
    sources: [GOOGLE_VOIDED, GOOGLE_RTDN, APPLE_NTYPE],
    related: ["/glossary/refund", "/glossary/real-time-developer-notifications", "/charts/refund-rate", "/features/refund-control", "/docs/guides/refund-control"],
  },
  {
    slug: "family-sharing",
    term: "Family Sharing",
    category: "Billing",
    short: "Apple Family Sharing lets one subscriber share a subscription or a non-consumable with up to five family members, each with their own receipts.",
    answer:
      "Family Sharing is an Apple feature that lets a customer share an auto-renewable subscription or a non-consumable purchase with up to five family members across their Apple devices. The developer turns it on per product in App Store Connect, and once it is on it cannot be turned off. Each family member gets their own receipts and transactions.",
    body: [
      "You enable Family Sharing for each product in App Store Connect, and customers choose whether to share. Each family member's transaction carries an ownership type that tells you whether the person bought the product or received it through sharing. You process shared purchases the same way as normal ones, and you must handle a family member losing access. Apple sends a `REVOKE` notification to your server then. A first-time shared subscription arrives as `SUBSCRIBED`, and a shared non-consumable arrives as `ONE_TIME_CHARGE`.",
      "Because family members do not pay, shared access should not count as revenue. A subscription that is shared can also change your subscriber counts, so decide whether you count family members as subscribers.",
      "RevenueDot stores the ownership type, and it excludes Family Sharing purchases from every money and subscription chart, so MRR and active subscriptions count only the people who pay.",
    ],
    faq: [
      { q: "How many people can share one subscription?", a: "Up to five family members, as Apple states in its Family Sharing documentation." },
      { q: "Can I turn Family Sharing off after I enable it?", a: "No. Apple says that once it is on for a product, it cannot be turned off." },
      { q: "Does shared access count as revenue?", a: "No. Family members do not pay, so RevenueDot leaves Family Sharing purchases out of its money and subscription charts." },
    ],
    sources: [APPLE_FAMILY, APPLE_SUBS, APPLE_NTYPE],
    related: ["/glossary/auto-renewable-subscription", "/glossary/mrr", "/glossary/original-transaction-id", "/charts/active-subscriptions", "/docs/guides/charts"],
  },
  {
    slug: "price-increase-consent",
    term: "Price increase consent",
    category: "Billing",
    short: "When you raise a subscription price, the store may need each subscriber to agree. Without consent, Apple lets the subscription expire and Google cancels it.",
    answer:
      "Price increase consent is a subscriber's agreement to a higher subscription price. Some increases need it and some only need notice, depending on size and region. If a subscriber does not agree to an increase that needs consent, Apple lets the subscription expire at the end of the billing cycle, and Google Play cancels the subscription before the first charge at the new price.",
    body: [
      "On the App Store, some increases need the subscriber to opt in, while smaller, infrequent ones only send notifications. You can keep any number of existing subscribers at their old price while you raise it for new ones. Before the system sheet appears, you can show an in-app message that explains the value. The notification type `PRICE_INCREASE` tells you whether the customer consented or was only informed, and `EXPIRED` with subtype `PRICE_INCREASE` tells you the customer did not consent.",
      "On Google Play, increases are opt-in by default. Customers must accept before the first charge at the higher price, or the subscription is canceled. Google notifies them 30 days before the charge, which is a 37-day lead time overall, and you get seven days from the start to tell your own subscribers first. In some places you can use an opt-out increase with advance notice instead, with limits on the size and frequency, and you must show an in-app notice. Google sends `SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED` and price change updates as RTDNs.",
      "RevenueDot records `PRICE_INCREASE_CONSENT_REQUIRED` and `PRICE_INCREASE_CONSENT_APPROVED` events when the store asks for or receives consent. A cancellation that comes from a refused increase carries the cancel reason `PRICE_INCREASE`.",
    ],
    faq: [
      { q: "What happens if a subscriber ignores a price increase?", a: "If it requires consent, an Apple subscription expires at the end of its billing cycle, and a Google Play subscription is canceled before the first charge at the new price." },
      { q: "How much notice does Google Play give?", a: "For default opt-in increases, 37 days before the first charge at the new price, with direct notices to subscribers starting 30 days before the charge." },
      { q: "Can I raise prices for new subscribers only?", a: "Yes. Apple lets you keep the price of existing subscribers, and Google Play uses legacy price cohorts so that you decide when to migrate them." },
    ],
    sources: [APPLE_SUBS, APPLE_SUBTYPE, APPLE_NTYPE, GOOGLE_PRICE, GOOGLE_RTDN],
    related: ["/glossary/churn", "/glossary/auto-renewable-subscription", "/glossary/mrr", "/docs/concepts/subscriptions-and-events", "/charts/mrr-movement"],
  },
  // ---------------------------------------------------------------------------------------------------------------
  // Offers and trials
  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "introductory-offer",
    term: "Introductory offer",
    category: "Offers and trials",
    short: "An introductory offer gives a new subscriber a free trial or a lower price for a first period. Apple allows one per subscription group for each person.",
    answer:
      "An introductory offer is a limited-time free trial or discounted price for the first period of a subscription, meant for people who have not subscribed before. The App Store has three types: free trial, pay as you go and pay up front. Each person can use one per subscription group. On Google Play an introductory price is an offer phase.",
    body: [
      "Apple's three types differ in when the customer pays. A free trial costs nothing for the offer period. Pay as you go charges a discounted price each billing period, for example $1.99 a month for three months on a $9.99 plan. Pay up front charges one discounted amount for the whole offer, for example $9.99 for the first six months of a $39.99 yearly plan. After the offer the subscription renews at the standard price. The allowed lengths depend on the subscription duration, and you can have one current and one future introductory offer per storefront. Once created, an introductory offer cannot be edited. You delete it and create a new one.",
      "Eligibility is per subscription group, not per product. If a customer used a free trial and then moves to another product in the same group that also has a trial, they do not get a second one. Check eligibility before you show offer text in your app, because the App Store product page shows the offer only to people who qualify.",
      "On Google Play an offer holds one or more phases. An introductory price phase must be the same as or lower than the base plan price. It can be one payment or from 1 to 52 recurrences of the billing period, and a free trial phase can come first. RevenueDot records each period's offer type: `free_trial` for a free offer and `introductory` for a paid one.",
    ],
    faq: [
      { q: "How many introductory offers can one customer use?", a: "On the App Store, one per subscription group, even if several products in the group have an offer. Google Play applies the eligibility rule that you set on each offer." },
      { q: "What is the difference between pay as you go and pay up front?", a: "Pay as you go charges a discounted price every billing period during the offer. Pay up front charges one discounted amount at the start for the whole offer period." },
      { q: "Can I edit an introductory offer after I create it?", a: "Not on the App Store. You delete the offer and create a new one. Overlapping offers overwrite each other, and the latest action wins." },
    ],
    sources: [APPLE_INTRO, APPLE_SUBS, GOOGLE_HELP_UNDERSTAND],
    related: ["/glossary/free-trial", "/glossary/promotional-offer", "/glossary/subscription-group", "/glossary/base-plan-and-offer", "/charts/initial-conversion-rate", "/charts/trial-conversion-rate"],
  },
  {
    slug: "free-trial",
    term: "Free trial",
    category: "Offers and trials",
    short: "A free trial gives full access at no charge for a set time, then bills the standard price unless the customer cancels. Apple allows 3 days to 1 year.",
    answer:
      "A free trial is a subscription offer that gives full access for a set time at no charge, then bills the standard price unless the customer cancels first. On the App Store a trial runs from 3 days to 1 year. On Google Play a free trial phase runs from 3 days to 3 years. The customer is only billed when the trial ends.",
    body: [
      "On the App Store the free trial is one of the three introductory offer types. The subscription begins at once, and billing starts when the offer period ends. Apple's allowed lengths are 3 days, 1 or 2 weeks, 1, 2, 3 or 6 months, and 1 year. Free trial time is not counted as days of paid service for Apple's 85% rate. On Google Play a free trial is a pricing phase inside an offer, and promo codes for subscriptions can give a free trial of 3 to 90 days.",
      "A trial customer is not a paying customer yet, so count them apart. Trial starts, trials still running, conversions and cancellations are separate numbers, and the trial conversion rate is conversions divided by trial starts. Tell people the trial end date and the price that follows, because surprise charges drive refunds.",
      "In RevenueDot a trial start is an `INITIAL_PURCHASE` with a price of 0, and the first paid period is a `RENEWAL` with `is_trial_conversion: true`. Trials count zero in MRR, and the Active Trials, New Trials, Trial Cancellation Rate and Trial Conversion Rate charts follow them.",
    ],
    example:
      "100 customers start a 7-day trial on a $10 monthly plan. After day 7, 40 are charged $10. The trial conversion rate is 40 percent, and the 60 who canceled paid nothing.",
    faq: [
      { q: "How long can a free trial be on the App Store?", a: "3 days, 1 or 2 weeks, 1, 2, 3 or 6 months, or 1 year. Each person can use one introductory offer per subscription group." },
      { q: "How long can a free trial be on Google Play?", a: "From 3 days to 3 years. Subscription promo codes give a free trial of 3 to 90 days." },
      { q: "Does a free trial count as revenue?", a: "No. A trial carries no money. Revenue and MRR begin when the first paid period starts." },
    ],
    sources: [APPLE_INTRO, APPLE_SUBS, GOOGLE_HELP_UNDERSTAND, GOOGLE_HELP_PROMO],
    related: ["/glossary/introductory-offer", "/glossary/trial-conversion-rate", "/charts/active-trials", "/charts/trial-conversion-rate", "/blog/free-trial-timeline-paywall", "/blog/apple-free-trial-toggle-rejection"],
  },
  {
    slug: "promotional-offer",
    term: "Promotional offer",
    category: "Offers and trials",
    short: "A promotional offer is an App Store discount or free period for current or lapsed subscribers. You pick who qualifies, and your server signs each redemption.",
    answer:
      "A promotional offer is an App Store discount or free period for people who already subscribe or used to. You decide who qualifies. Your server signs each redemption with your in-app purchase key, and your app passes the signed offer to StoreKit. Redeeming an introductory offer does not affect a customer's eligibility for a promotional offer.",
    body: [
      "Apple treats every customer with an existing or expired subscription in your app as eligible, and you add your own rules on top, such as a cancel reason or the length of their subscription. A useful trigger is the `DID_CHANGE_RENEWAL_STATUS` notification, which tells you the moment a customer turns off auto-renew. When an active subscriber redeems one, your server receives `OFFER_REDEEMED`. Customers can redeem promotional offers on iOS 12.2, macOS 10.14.4 and tvOS 12.2 or later.",
      "The signature is what makes it a server feature. Your server generates a signature from set parameters and your private key, and your app includes it with the purchase request. Without a valid signature the offer is refused, so the app cannot invent a discount.",
      "Google Play has no separate type. You build the same idea with a developer-determined offer and check eligibility in your app. RevenueDot already signs promotional offers with the app's In-App Purchase key for its Customer Center retention offers, records `promotional` as the offer type, and sends the offer identifier as `offer_code` in webhooks.",
    ],
    faq: [
      { q: "What is the difference between a promotional offer and an introductory offer?", a: "An introductory offer is for people who have never subscribed, and Apple checks eligibility. A promotional offer is for current or lapsed subscribers, and you decide who qualifies and sign each redemption on your server." },
      { q: "Does a promotional offer need a server?", a: "Yes. Your server must create the signature with your private key. The app cannot do it safely." },
      { q: "Is a win-back offer the same thing?", a: "No. A win-back offer is a separate type for lapsed subscribers. Apple checks its eligibility in App Store Connect, and it needs no signature from your server." },
    ],
    sources: [APPLE_PROMO, APPLE_SUBS, APPLE_NTYPE],
    related: ["/glossary/introductory-offer", "/glossary/win-back-offer", "/glossary/offer-code", "/features/customer-center", "/docs/guides/retention", "/blog/paywall-exit-offers"],
  },
  {
    slug: "offer-code",
    term: "Offer code (promo code)",
    category: "Offers and trials",
    short: "An offer code gives a customer a free period or a discount on an in-app purchase. Apple calls it an offer code and Google Play calls it a promo code.",
    answer:
      "An offer code is a code that gives a customer a free period or a discount on an in-app purchase. Apple offer codes work for subscriptions and one-time products and come as one-time-use or custom codes. Google Play calls them promo codes. Customers redeem them through a link, in the store, or in your app.",
    body: [
      "On the App Store there are three types: one-time-use codes, custom codes such as SPRINGPROMO, and sandbox codes for testing. You can have up to 10 active offers at a time and up to 1,000,000 codes per app per quarter. For subscriptions you choose who may use the code: new subscribers, existing subscribers or expired subscribers in the group. One-time-use codes come in batches of 500 to 25,000 and are valid for at most six months. Subscriptions support offer codes from iOS 14.2, and other product types from iOS 16.3.",
      "When someone redeems a code, your app receives a normal transaction. Your server receives `OFFER_REDEEMED` for an active subscriber, `SUBSCRIBED` for a first purchase or resubscribe, or `ONE_TIME_CHARGE` for a one-time product. The transaction's offer type is 3 for an offer code.",
      "Google Play promo codes cover paid apps, one-time products and subscriptions. One-time-use codes can be redeemed in Google Play or in the app. Custom codes work only in the app, only for subscriptions, and only for people who never subscribed before. A subscription promo code gives a free trial of 3 to 90 days. RevenueDot records an App Store offer code with the type `offer_code` and sends its identifier as `offer_code` in webhooks.",
    ],
    faq: [
      { q: "Are offer codes and promo codes the same?", a: "They do the same job under different names: Apple's offer codes and Google Play's promo codes both give a free period or discount through a code." },
      { q: "How many offer codes can I create on the App Store?", a: "Up to 1,000,000 per app per quarter, shared across one-time-use and custom codes. A one-time-use batch is 500 to 25,000 codes." },
      { q: "Can I test offer codes before launch?", a: "Yes. Apple provides sandbox codes that you can redeem through the Sandbox Account settings on iOS 16.3 and later." },
    ],
    sources: [APPLE_OFFER_CODES, APPLE_OFFER_CODES_HELP, APPLE_SUBS, GOOGLE_HELP_PROMO],
    related: ["/glossary/promotional-offer", "/glossary/introductory-offer", "/glossary/win-back-offer", "/glossary/sandbox-testing", "/docs/guides/win-back-offers"],
  },
  {
    slug: "win-back-offer",
    term: "Win-back offer",
    category: "Offers and trials",
    short: "A win-back offer is a free or discounted offer for lapsed subscribers, available on iOS 18 and later. Google Play uses developer-determined offers instead.",
    answer:
      "A win-back offer is a free or discounted offer for people whose auto-renewable subscription has lapsed. On the App Store you set the eligibility in App Store Connect, such as how long the customer paid and how long ago they left, and Apple shows the offer in the App Store, in Apple account settings and in your app. Google Play uses developer-determined offers.",
    body: [
      "Apple's eligibility rules cover the length of the customer's paid subscription, the time since it expired and the time that must pass between redeemed offers. You also pick the discount type and the regions. A win-back offer has a direct link, `https://apps.apple.com/win-back/<offer Apple ID>`, that you can send by email, and your server can ask the App Store Server API which offers a customer is eligible for before you send it. StoreKit adds a win-back offer to the purchase options on iOS 18 and later.",
      "With the default setting, Streamlined Purchasing, the customer finishes the purchase outside your app, and your app receives a completed transaction. It must listen for transaction updates from launch so it can give the customer the product. If you turn Streamlined Purchasing off, your app gets a purchase intent first and completes the purchase itself.",
      "On Google Play, an offer with developer-determined eligibility can serve lapsed subscribers, because you decide in your app who qualifies. Customers can also resubscribe from the Play subscriptions center for up to one year after expiry. RevenueDot works with the RevenueCat SDK's win-back calls unchanged. It records the offer as `win_back`, sends its identifier as `offer_code`, and stores the offers Apple says a customer may redeem.",
    ],
    faq: [
      { q: "Which iOS version supports win-back offers?", a: "iOS 18 and later, and visionOS 2 and later. That is where StoreKit adds win-back offers to the purchase options." },
      { q: "How is a win-back offer different from a promotional offer?", a: "Apple evaluates win-back eligibility from rules you set in App Store Connect, and the purchase needs no server signature. A promotional offer needs your own eligibility logic and a signature from your server." },
      { q: "Does Google Play have win-back offers?", a: "Not as a separate type. Use a developer-determined offer for lapsed subscribers, and let customers resubscribe from the Play subscriptions center." },
    ],
    sources: [APPLE_WINBACK, APPLE_SUBS, GOOGLE_HELP_UNDERSTAND, GOOGLE_SUBS],
    related: ["/glossary/promotional-offer", "/glossary/offer-code", "/glossary/churn", "/features/win-back", "/docs/guides/win-back-offers", "/docs/guides/win-back-campaigns"],
  },
  // ---------------------------------------------------------------------------------------------------------------
  // Store notifications and server APIs
  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "consumption-request",
    term: "CONSUMPTION_REQUEST",
    category: "Store notifications",
    short: "CONSUMPTION_REQUEST is the App Store notification that asks your server for usage data when a customer requests a refund. You have 12 hours to answer.",
    answer:
      "CONSUMPTION_REQUEST is an App Store Server Notification that Apple sends when a customer asks for a refund. It asks your server for consumption data, such as how much of the purchase the customer used. If the customer agreed to share it, you answer within 12 hours through the Send Consumption Information endpoint of the App Store Server API.",
    body: [
      "Apple uses your answer as one of several inputs when it decides the refund, so a good answer can reduce wrongful refunds. The request covers any product type: consumable, non-consumable, non-renewing subscription and auto-renewable subscription. Your answer includes whether the customer consented, how much they consumed, whether you delivered the product, the account age, the total spent and refunded in USD, the platform, play time, whether you offered a free sample, the user status and your refund preference. Apple currently documents two versions of the endpoint, and the older V1 version is still documented.",
      "Consent is the part to get right. Apple says you are solely responsible for obtaining valid consent before you share a customer's data, and if the customer did not consent you must not respond. Put the sharing in your terms or privacy policy, and keep a record of it. The deadline is firm: respond within 12 hours of the notification.",
      "RevenueDot's Refund Control sends the answer for you, using ordered policies on customer conditions such as first purchase date, platform or recent renewal. It builds the request from its own records, sends nothing until you confirm customer consent, retries after 5 minutes, 15 minutes and then hourly, and stops 5 minutes before the 12-hour deadline. Apple's `REFUND` and `REFUND_DECLINED` notifications then show the outcome.",
    ],
    faq: [
      { q: "How long do I have to answer a CONSUMPTION_REQUEST?", a: "12 hours from the notification. Answer later and Apple decides without your data." },
      { q: "Do I have to respond?", a: "No, and you must not respond if the customer did not consent to share their data. If they consented, Apple asks you to respond with the consumption data." },
      { q: "Can I influence whether Apple grants the refund?", a: "You can state a preference, such as prefer full refund or prefer no refund. Apple says your preference is one of several factors in its decision." },
    ],
    sources: [APPLE_SEND_CONSUMPTION, APPLE_SEND_CONSUMPTION_V1, APPLE_NTYPE],
    related: ["/glossary/refund", "/glossary/app-store-server-notifications-v2", "/features/refund-control", "/docs/guides/refund-control", "/charts/refund-requests", "/blog/apple-refund-requests-consumption-info"],
  },
  {
    slug: "app-store-server-notifications-v2",
    term: "App Store Server Notifications V2",
    category: "Store notifications",
    short: "App Store Server Notifications V2 are signed messages Apple posts to your server when a purchase, renewal, refund or billing event happens in your app.",
    answer:
      "App Store Server Notifications V2 is Apple's server-to-server service that sends signed JSON messages to an HTTPS URL you configure whenever an in-app purchase event happens, such as a renewal, a failed charge, a refund or an offer redemption. Each message has a notification type, an optional subtype, and signed transaction and renewal data.",
    body: [
      "You set the URL in App Store Connect and can use separate URLs for production and sandbox, or the same one. Your server must support TLS 1.2 or later, and a custom port must be 443 or 1024 and above. Answer with an HTTP code from 200 to 206 when you accepted the message. A 40x or 50x answer makes Apple retry: for version 2, five more times, at 1, 12, 24, 48 and 72 hours after the previous attempt, in production only (the sandbox sends once). Apple deprecated version 1 notifications, so new work should use version 2. To test, call the Request a Test Notification endpoint, and use Get Notification History to fetch messages you missed in the past 180 days (30 days in the sandbox).",
      "The payload carries a `notificationType` and sometimes a `subtype`. Common types are `SUBSCRIBED`, `DID_RENEW`, `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED`, `DID_CHANGE_RENEWAL_STATUS`, `DID_CHANGE_RENEWAL_PREF`, `EXPIRED`, `REFUND`, `REFUND_REVERSED`, `REVOKE`, `OFFER_REDEEMED`, `PRICE_INCREASE`, `ONE_TIME_CHARGE` and `CONSUMPTION_REQUEST`. The transaction and renewal data inside are JWS strings that you must verify.",
      "RevenueDot gives each App Store app a notification URL. It answers 200 for every verified message, 400 for a bad signature or the wrong bundle ID, and 500 when it fails so that Apple retries. It stores messages about purchases it has not seen and applies them only when you turn on tracking of new purchases from notifications. The dashboard shows each app's notification status.",
    ],
    faq: [
      { q: "What is the difference between V1 and V2 notifications?", a: "Version 2 sends signed JWS data with a notification type and subtype, and Apple deprecated version 1. Use version 2 for any new integration." },
      { q: "How do I test App Store notifications?", a: "Call the Request a Test Notification endpoint of the App Store Server API. Apple sends a `TEST` notification to your URL, and you can look up how your server answered." },
      { q: "What if my server was down?", a: "Apple retries a version 2 notification five times over three days, at 1, 12, 24, 48 and 72 hours after the previous attempt. Get Notification History returns the past 180 days in production (30 days in the sandbox), so you can recover what you missed." },
    ],
    sources: [APPLE_ASSN, APPLE_ENABLE_ASSN, APPLE_RESPOND, APPLE_NTYPE, APPLE_API],
    related: ["/glossary/jws-signed-transaction", "/glossary/app-store-server-api", "/glossary/consumption-request", "/docs/guides/app-store", "/docs/help/store-notifications-not-arriving", "/blog/app-store-server-notifications-v2"],
  },
  {
    slug: "real-time-developer-notifications",
    term: "Real-time developer notifications (RTDN)",
    category: "Store notifications",
    short: "Real-time developer notifications are Google Play messages, sent through Pub/Sub, that tell your server a purchase or subscription changed state.",
    answer:
      "Real-time developer notifications (RTDN) are messages that Google Play publishes to a Cloud Pub/Sub topic when a subscription or one-time purchase changes, such as a renewal, a payment decline or a refund. A notification names the event and the purchase token only. Your server must then call the Google Play Developer API to get the full state.",
    body: [
      "You create a Pub/Sub topic, let Google's publisher account post to it, add a push subscription that points at your server (or poll with a client library), and enter the topic in Play Console. A subscription notification has a type such as `SUBSCRIPTION_PURCHASED`, `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_IN_GRACE_PERIOD`, `SUBSCRIPTION_ON_HOLD`, `SUBSCRIPTION_PAUSED`, `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_REVOKED` or `SUBSCRIPTION_EXPIRED`. One-time product and voided purchase notifications are separate message kinds.",
      "A notification does not carry the complete purchase. Google tells you to call `purchases.subscriptionsv2.get` with the purchase token and treat that response as the source of truth. Do not store state from the message alone. Because a message can arrive late or twice, make your handler safe to run more than once.",
      "RevenueDot gives each Google Play app a notification URL for a Pub/Sub push subscription. For every message it stores the raw payload once by message ID and re-reads the purchase from the Play Developer API. It answers 200 for handled, duplicate and invalid-token messages, and 500 or 503 for temporary failures so that Pub/Sub delivers again. A daily voided-purchases check backs up refund messages.",
    ],
    faq: [
      { q: "Do RTDN replace calling the Google Play Developer API?", a: "No. A notification only says that something changed. You still call the API with the purchase token to read the full state." },
      { q: "Do I need Pub/Sub?", a: "Yes. Google Play delivers RTDN through Cloud Pub/Sub, either pushed to a URL you set or polled with a client library." },
      { q: "Which Apple feature is the equivalent?", a: "App Store Server Notifications V2. Apple's messages already contain signed transaction data, while Google's contain only the purchase token and type." },
    ],
    sources: [GOOGLE_RTDN, GOOGLE_READY, GOOGLE_LIFECYCLE],
    related: ["/glossary/purchase-token", "/glossary/account-hold", "/glossary/app-store-server-notifications-v2", "/docs/guides/google-play", "/docs/help/store-notifications-not-arriving", "/stores/google-play"],
  },
  {
    slug: "app-store-server-api",
    term: "App Store Server API",
    category: "Store notifications",
    short: "The App Store Server API is Apple's REST API for reading a customer's transactions and subscription status from your server, plus refunds and extensions.",
    answer:
      "The App Store Server API is a REST API that your server calls to read and manage a customer's in-app purchases. It returns signed transaction and renewal data for a single customer, based on a transaction identifier you provide. It covers transaction history, subscription status, refund history, order lookup, notification history and subscription renewal date extensions.",
    body: [
      "Calls use a JSON Web Token as a bearer token, signed with a key you create in App Store Connect. Apple provides the open-source App Store Server Library in four languages, which creates the tokens and verifies the signed data. The API works whether or not the customer has your app installed, because it answers from the customer's purchase history. Every endpoint except one is available in the sandbox at a separate base URL, and a transaction identifier must be sent to the environment that created it.",
      "Typical uses: get all subscription statuses to learn whether a subscriber is active, in a grace period or in billing retry; get the transaction history; send consumption information after a refund request; extend a subscription's renewal date to make up for an outage; look up an order from the ID on a customer's receipt email; and request a test notification.",
      "RevenueDot uses the API with the app's In-App Purchase key to confirm each StoreKit 2 purchase, read the full history and renewal state, and extend subscriptions. It can also look up an order ID for a support restore. Without the key RevenueDot still verifies signed transactions against Apple's root certificate, but it knows only what the device sent.",
    ],
    faq: [
      { q: "What do I need to call the App Store Server API?", a: "A key from App Store Connect (Users and Access, Integrations, In-App Purchase), its key ID and your issuer ID. You sign a short-lived token with the key for each request or reuse it until it expires." },
      { q: "Can I call it from the app?", a: "Call it from your server. The key is a secret, and the endpoints are made for backend use." },
      { q: "Does it work in the sandbox?", a: "Yes. All endpoints except the order lookup work in the sandbox, using the sandbox base URL." },
    ],
    sources: [APPLE_API, APPLE_LOOKUP_ORDER, APPLE_SEND_CONSUMPTION],
    related: ["/glossary/jws-signed-transaction", "/glossary/original-transaction-id", "/glossary/app-store-server-notifications-v2", "/glossary/receipt-validation", "/docs/guides/app-store", "/stores/app-store"],
  },
  {
    slug: "jws-signed-transaction",
    term: "JWS signed transaction",
    category: "Store notifications",
    short: "A JWS signed transaction is purchase data that Apple signs, as three Base64URL parts, so your server can prove it came from the App Store and was not changed.",
    answer:
      "A JWS signed transaction is transaction data that the App Store signs in JSON Web Signature format. It is one string of three Base64URL parts separated by periods: a header, a payload and a signature. Your server decodes the payload to read the purchase, and verifies the signature against Apple's certificates to prove that Apple issued it.",
    body: [
      "StoreKit 2 returns each transaction, each renewal info and each app transaction as a signed value, and StoreKit verifies them for you on the device. You can also send the raw JWS string to your server and verify it there for the most control. Apple recommends the App Store Server Library, whose functions `verifyAndDecodeTransaction`, `verifyAndDecodeRenewalInfo` and `verifyAndDecodeAppTransaction` check the signature and decode the payload. The header holds the certificate chain that you use to verify.",
      "The decoded payload has fields such as `transactionId`, `originalTransactionId`, `productId`, `bundleId`, `purchaseDate`, `expiresDate`, `environment`, `ownershipType` and the offer details. App Store Server Notifications V2 and the App Store Server API also return signed transactions in this format.",
      "RevenueDot verifies a StoreKit 2 signed transaction against Apple's root certificate, checks that the bundle ID matches the app, and uses the original transaction ID as the subscription key. With the In-App Purchase key it then asks Apple for the full history. A signature that does not verify gets a 4xx answer, so the SDK drops the bad purchase.",
    ],
    faq: [
      { q: "What does JWS stand for?", a: "JSON Web Signature. It is a standard way to sign JSON so that anyone with the right certificate can check the data was not changed." },
      { q: "Do I still need server validation if StoreKit verifies on the device?", a: "StoreKit's check is enough to give access on the device. Verify on your server when you share entitlements across devices or platforms, when you issue server-side rewards, or when you need the data for your records." },
      { q: "What is the difference between JWSTransaction and JWSRenewalInfo?", a: "A JWSTransaction describes one purchase or renewal. A JWSRenewalInfo describes what happens at the next renewal, such as the auto-renew status or eligible win-back offers." },
    ],
    sources: [APPLE_JWS_TX, APPLE_VERIFICATION, APPLE_IAP, APPLE_API],
    related: ["/glossary/original-transaction-id", "/glossary/storekit-2", "/glossary/receipt-validation", "/docs/help/receipt-errors-4xx-vs-5xx", "/blog/server-side-receipt-validation"],
  },
  {
    slug: "original-transaction-id",
    term: "Original transaction ID",
    category: "Store notifications",
    short: "The original transaction ID is the App Store identifier of a customer's first purchase of a subscription. It stays the same across every renewal.",
    answer:
      "The original transaction ID is the identifier that the App Store generates when a customer first buys an in-app purchase. For a subscription, every later renewal has its own transaction ID, but all of them point back to this one original ID. Apple tells developers to save it to identify an auto-renewable subscription, and most App Store Server API endpoints accept it.",
    body: [
      "You can read it in the app from the `Transaction` object, in every signed transaction and notification (`originalTransactionId`), and in the App Store Server API. Pass it as the identifier when you call endpoints such as Get All Subscription Statuses or Get Transaction History. If you maintain your own subscriber database, make it the key for each auto-renewable subscription, so renewals update one row.",
      "Use it together with the environment. A transaction identifier belongs to either production or the sandbox, and you must call the same environment that created it. The App Store Server API also returns the original purchase date, and the `appAccountToken`, a UUID you create, can tie the transaction to your own user.",
      "RevenueDot keys each App Store subscription by `original_transaction_id`, so every renewal updates the same record and one webhook stream follows it. The Google Play equivalent is the purchase token.",
    ],
    faq: [
      { q: "What is the difference between transactionId and originalTransactionId?", a: "The transaction ID identifies one charge, including each renewal. The original transaction ID identifies the first purchase and does not change as the subscription renews." },
      { q: "Where can I read the original transaction ID?", a: "In the app, from the `originalID` property of the `Transaction` object. On your server, from `originalTransactionId` in the decoded payload of any signed transaction or notification, and in App Store Server API responses." },
      { q: "Where do I find it for support?", a: "Ask for the order ID from the customer's receipt email and call Look Up Order ID, which returns signed transactions that contain the original transaction ID." },
    ],
    sources: [APPLE_ORIGINAL_ID, APPLE_LOOKUP_ORDER, APPLE_TRANSACTION],
    related: ["/glossary/purchase-token", "/glossary/jws-signed-transaction", "/glossary/app-store-server-api", "/docs/concepts/subscriptions-and-events", "/docs/concepts/customers-and-app-user-ids"],
  },
  {
    slug: "purchase-token",
    term: "Purchase token (Google Play)",
    category: "Store notifications",
    short: "A purchase token is the unique string Google Play gives a purchase. Your server uses it to verify the purchase, read its state and acknowledge it.",
    answer:
      "A purchase token is the string that Google Play issues to the device when a customer buys a product or subscription. It is globally unique, so you can use it as a primary key. Your server sends it to the Google Play Developer API to verify the purchase, read its current state and acknowledge it.",
    body: [
      "Send the token from the app to your backend, record every token you see, and check that it has not been used before. Then call `purchases.subscriptionsv2.get` for a subscription or `purchases.products.get` for a one-time product to confirm the purchase with Google. Only after those checks should you grant access, and then acknowledge the purchase within three days or Google refunds it.",
      "For subscriptions the token stays the same through renewals, grace period, account hold and a restore. A new token appears when the customer repurchases after expiry, or when a plan change creates a new purchase, as a deferred replacement does. When a subscription has a `linkedPurchaseToken`, remove the old token from your database and revoke the access you granted under it, so two users are never entitled to one purchase. The token is valid from signup until 60 days after expiry.",
      "RevenueDot keys each Google Play subscription by its purchase token. It verifies the purchase with the service account you add, acknowledges it within Google's 3-day limit, and answers 400 to the SDK when Google says the token is not valid.",
    ],
    faq: [
      { q: "Is the purchase token the same as the order ID?", a: "No. An order ID names one order, and the Developer API returns the latest one for a subscription. The purchase token names the purchase itself and stays the same through renewals." },
      { q: "How long is a purchase token valid?", a: "From signup until 60 days after the subscription expires. After that you can no longer call the Developer API with it." },
      { q: "Can I trust a token that my app sends me?", a: "Treat it as a claim. Verify it with Google before you grant access, because the app can send anything." },
    ],
    sources: [GOOGLE_SECURITY, GOOGLE_LIFECYCLE, GOOGLE_INTEGRATE],
    related: ["/glossary/original-transaction-id", "/glossary/real-time-developer-notifications", "/glossary/receipt-validation", "/docs/guides/google-play", "/stores/google-play"],
  },
  {
    slug: "receipt-validation",
    term: "Receipt validation",
    category: "Store notifications",
    short: "Receipt validation checks with Apple or Google that a purchase is real before you grant access. Apple now signs the data, and Google checks a purchase token.",
    answer:
      "Receipt validation is the check that a purchase is genuine before your app or server grants access. On Apple platforms you verify the signed transaction, either with StoreKit on the device or with the App Store Server Library on your server. On Google Play you send the purchase token to the Play Developer API. Never trust the app's own claim.",
    body: [
      "Apple's older receipt endpoint, `verifyReceipt`, is deprecated. For new work, verify the JWS signed transactions that StoreKit 2 returns, and use the App Store Server API when you need history or renewal state. Apple notes that you can verify transactions on your server or rely on StoreKit's verification.",
      "On Google Play, send the purchase token to your backend, check that it is new, confirm it with `purchases.subscriptionsv2.get` or `purchases.products.get`, apply your own abuse checks, then grant access and acknowledge. If a purchase fails your checks, Google advises refunding it explicitly with the revoke option rather than letting the 3-day auto-refund happen.",
      "RevenueDot takes the receipt from the SDK at `POST /v1/receipts` and uses the status code to steer the SDK. A 4xx means the purchase can never be accepted, so the SDK finishes the transaction. A 5xx means try again later, so the SDK keeps it and retries. RevenueDot never answers 4xx for its own failures, and a missing App Store key or Google service account answers 5xx, so a setup mistake never loses a paid customer's purchase.",
    ],
    faq: [
      { q: "Is verifyReceipt still supported?", a: "Apple has marked it deprecated. Use signed transactions and the App Store Server API instead." },
      { q: "Do I have to validate on a server?", a: "Not to give access on one device, because StoreKit verifies the signed data. You need a server to share access across platforms, to handle refunds and renewals when the app is closed, and to keep reliable records." },
      { q: "What should I do when validation fails?", a: "Do not grant access. On Google Play, refund the purchase with the revoke option if it is clearly invalid. On the App Store, log the failure and check that the bundle ID and environment match." },
    ],
    sources: [APPLE_RECEIPTS, APPLE_VERIFICATION, APPLE_JWS_TX, GOOGLE_SECURITY],
    related: ["/glossary/jws-signed-transaction", "/glossary/purchase-token", "/glossary/storekit-2", "/docs/help/receipt-errors-4xx-vs-5xx", "/blog/server-side-receipt-validation"],
  },
  // ---------------------------------------------------------------------------------------------------------------
  // Platform
  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "storekit-2",
    term: "StoreKit 2",
    category: "Platform",
    short: "StoreKit 2 is Apple's Swift API for in-app purchases. It returns App Store-signed transactions and entitlements, so many apps need far less receipt code.",
    answer:
      "StoreKit 2 is Apple's Swift-based in-app purchase API, available from iOS 15. It uses async code, returns transactions signed by the App Store in JWS format, and has an API for current entitlements and ready-made SwiftUI store views. The older StoreKit 1 relies on a receipt file that you parse and validate yourself.",
    body: [
      "With StoreKit 2 you fetch products with `Product`, buy with `purchase`, and listen for changes with `Transaction.updates`. You iterate `Transaction.currentEntitlements` to learn what a customer may use. StoreKit verifies each signed value and hands it back as verified or unverified, and you can also verify the JWS string yourself on a server. Start the transaction listener when the app launches, because purchases can finish outside the app, for example an offer code or a win-back offer redeemed in the App Store.",
      "Apple's store views, such as the subscription store view from iOS 17, can draw a complete paywall in a few lines. You can also test without App Store Connect, because a StoreKit configuration file in Xcode lets you configure products locally, offline, in the simulator or on a device. Apple's server side pairs with it: App Store Server Notifications V2 and the App Store Server API return the same signed format.",
      "RevenueDot works with the RevenueCat SDKs, which post StoreKit 2 signed transactions to `POST /v1/receipts`. RevenueDot verifies the signature against Apple's root certificate, and with the In-App Purchase key it reads the full history. StoreKit 1 receipts need the key. Without it RevenueDot answers 500 with code 7234, so the SDK keeps the purchase and retries once you add the key.",
    ],
    faq: [
      { q: "What is the difference between StoreKit 1 and StoreKit 2?", a: "StoreKit 2 is a Swift concurrency API that returns signed transactions and entitlements. StoreKit 1 hands you a receipt file that your code or server has to parse and check." },
      { q: "Does StoreKit 2 verify purchases for me?", a: "Yes. StoreKit verifies the signed transaction, renewal and app transaction values automatically and reports verified or unverified. You can also verify them yourself, on the device or on a server." },
      { q: "Can I test StoreKit 2 without App Store Connect?", a: "Yes. A StoreKit configuration file in Xcode lets you test locally, without a network connection, before you create products in App Store Connect." },
    ],
    sources: [APPLE_IAP, APPLE_VERIFICATION, APPLE_PRODUCT, APPLE_TESTING_STAGES],
    related: ["/glossary/jws-signed-transaction", "/glossary/receipt-validation", "/glossary/sandbox-testing", "/glossary/app-store-server-api", "/sdks/ios", "/docs/guides/sandbox-testing"],
  },
  {
    slug: "google-play-billing-library",
    term: "Google Play Billing Library",
    category: "Platform",
    short: "The Google Play Billing Library is the Android library that connects your app to Google Play for purchases. Google sets a minimum version every year.",
    answer:
      "The Google Play Billing Library is the Android library that connects your app to Google Play's billing system. It loads product details, launches the purchase flow, reports the result and lets you acknowledge or consume purchases. As of October 2026, new apps and updates must use version 8 or later, and an extension runs to November 1, 2026.",
    body: [
      "Google pairs the library with a backend integration. The app uses the library for the purchase flow, and your server uses the Google Play Developer API and real-time developer notifications to manage purchases, with Cloud Pub/Sub carrying the notifications. Google calls the backend essential for efficient and secure purchase management and for entitlements that work across platforms.",
      "Every version has a two-year deprecation cycle, with a deadline for new apps and updates and a later extension deadline. The current rule is version 8 or later by August 31, 2026, with an extension available until November 1, 2026. Check the deprecation page before each release, because the minimum moves every year.",
      "For testing, Google recommends license testers and Play Billing Lab. For payment problems, the library can show an in-app message with `showInAppMessages` when a payment fails or a price increase is waiting. The RevenueCat Android SDK uses the library in your app and posts the purchase token to RevenueDot, which reads the purchase from the Play Developer API and acknowledges it within Google's 3-day limit.",
    ],
    faq: [
      { q: "Which Play Billing Library version must I use?", a: "As of October 2026, version 8 or later for new apps and updates, unless you were granted an extension to November 1, 2026. Google publishes the exact dates on its deprecation page." },
      { q: "How long is a version supported?", a: "Each version has a two-year deprecation cycle." },
      { q: "Can I skip the backend?", a: "You can sell without one, but Google says a backend integration is essential for secure purchase management and cross-platform entitlements." },
    ],
    sources: [GOOGLE_BILLING, GOOGLE_DEPRECATION, GOOGLE_INTEGRATE, GOOGLE_TEST],
    related: ["/glossary/purchase-token", "/glossary/real-time-developer-notifications", "/glossary/sandbox-testing", "/sdks/android", "/docs/guides/google-play", "/blog/android-google-play-billing-subscriptions"],
  },
  {
    slug: "sandbox-testing",
    term: "Sandbox testing (TestFlight and license testers)",
    category: "Platform",
    short: "Sandbox testing runs real store purchase flows without real charges. Apple uses Sandbox Apple Accounts and TestFlight, and Google Play uses license testers.",
    answer:
      "Sandbox testing means buying through the real store flow without paying. On the App Store, apps run from Xcode or TestFlight use the sandbox with a Sandbox Apple Account. On Google Play, license testers get test payment methods. Test subscriptions renew on a short clock: a monthly Google Play test plan renews every 5 minutes.",
    body: [
      "Apple's sandbox works with development-signed apps and with TestFlight builds, which always run in the sandbox. You create Sandbox Apple Accounts in App Store Connect and sign in on the device. The settings let you change the subscription renewal rate, clear purchase history, which also makes the account eligible for introductory offers again, and simulate win-back offers. Apple also offers StoreKit testing in Xcode, which runs on a local configuration file with no network. Those transactions are signed by Xcode, not by Apple, so your server needs Xcode's certificate to accept them.",
      "On Google Play you add license testers in Play Console. Testers see test payment methods, a notice on the purchase dialog, and no tax. Test subscriptions renew faster: 5 minutes for a week or a month, 10 for three months, 15 for six months and 30 for a year, with at most six renewals. A free trial lasts 3 minutes, a grace period 5 minutes and an account hold 10 minutes. A test purchase that your app does not acknowledge is refunded after 3 minutes. Play Billing Lab can move a test subscription into grace period or account hold.",
      "RevenueDot takes the environment from the store, so these purchases are stored as sandbox. They grant entitlements, and webhooks carry `environment: SANDBOX`, but charts and metrics count production only unless you ask for sandbox. For quick tests with no store account, use the Test Store.",
    ],
    faq: [
      { q: "Do sandbox purchases cost money?", a: "No. Apple's sandbox simulates successful transactions without processing payments, and Google's license testers use test payment methods that do not charge." },
      { q: "Do TestFlight purchases use the sandbox?", a: "Yes. Apps that you download from TestFlight always run in the sandbox environment." },
      { q: "How fast do test subscriptions renew?", a: "On Google Play a monthly plan renews in about 5 minutes, up to six times. On the App Store you control the renewal rate in the sandbox settings." },
    ],
    sources: [APPLE_SANDBOX, APPLE_TESTING_STAGES, GOOGLE_TEST],
    related: ["/glossary/storekit-2", "/glossary/account-hold", "/glossary/billing-grace-period", "/docs/guides/sandbox-testing", "/docs/concepts/sandbox", "/docs/guides/test-store"],
  },
  {
    slug: "entitlement",
    term: "Entitlement",
    category: "Platform",
    short: "An entitlement is the access your app checks, like pro, that a purchase grants. Check the entitlement, not the product, to add plans without an app update.",
    answer:
      "An entitlement is a level of access, such as pro, that a customer gets by buying one or more products. Your app asks whether the entitlement is active instead of checking product IDs, so a monthly plan, a yearly plan and a lifetime purchase can give the same access, and you can add products without shipping an app update.",
    body: [
      "The word is used two ways. In StoreKit 2, current entitlements are the transactions that are giving a customer access right now. In RevenueCat's model, an entitlement is your own named access level that products attach to. Most apps have one, for example `pro`. If you sell two tiers, such as Gold and Platinum, you have two. A customer's entitlements are shared across all apps in the same project, so a purchase on iOS can give access on Android and the web.",
      "Check the entitlement in your code and never a product ID. That is what lets you add a yearly plan, a Google Play product or a lifetime purchase later with no app change. Treat an expired entitlement as inactive by comparing its expiry with the server time, and remember that refunds, grace periods and promotional grants change the end date.",
      "RevenueDot decides each entitlement from every purchase the customer owns. A subscription's access ends at the refund time if refunded, else at the end of the grace period if the store gave one, else at the store's expiry. A lifetime purchase wins over everything unless refunded. Otherwise the purchase that ends last wins. Consumables never grant an entitlement, and expired entitlements stay listed with their `expires_date`.",
    ],
    faq: [
      { q: "What is the difference between a product and an entitlement?", a: "A product is one thing a store sells, such as pro_monthly. An entitlement is the access it grants, such as pro. Many products can grant one entitlement." },
      { q: "Can one entitlement have several products?", a: "Yes. Attach the monthly, yearly and lifetime products to `pro`, and any of them grants it." },
      { q: "What happens to an entitlement after a refund?", a: "Access ends at the refund time, even if the paid period had not finished." },
    ],
    sources: [RC_ENTITLEMENTS, APPLE_IAP],
    related: ["/glossary/product-identifier", "/glossary/offering", "/docs/concepts/products-and-entitlements", "/docs/help/entitlement-not-active", "/features/offline-entitlements", "/features/trusted-entitlements"],
  },
  {
    slug: "small-business-program",
    term: "Small Business Program (15%)",
    category: "Platform",
    short: "Apple's Small Business Program cuts the App Store commission to 15% for developers with up to $1 million in proceeds in the prior calendar year.",
    answer:
      "The App Store Small Business Program is an Apple program that reduces the commission on paid apps and in-app purchases to 15%. Developers qualify if their proceeds across all their apps were up to $1 million USD in the prior calendar year, or if they are new to the App Store. If proceeds pass $1 million in the current year, the standard rate applies to later sales.",
    body: [
      "You enroll as the Account Holder: accept the latest Paid Applications agreement in App Store Connect and list every Associated Developer Account, so Apple can add up the proceeds of related accounts. The new rate applies fifteen days after the end of the fiscal month in which Apple approves your enrollment. If you cross the threshold in a year, the standard commission applies to future sales, and you can re-qualify the year after your proceeds fall back under $1 million.",
      "For subscriptions the program changes less than it first seems. Without it, you receive 70% of the subscription price (minus taxes) in a subscriber's first year of paid service, and 85% after the subscriber has accumulated one year of paid service. Members of the Small Business Program receive 85% from the first billing cycle, whether or not the subscription has reached a year of paid service.",
      "Google Play sets its service fees separately and updates them by region, so read its service fee page for the current rates rather than assuming they match Apple's.",
    ],
    faq: [
      { q: "What is the revenue limit for the Small Business Program?", a: "$1 million USD in proceeds in the prior calendar year across all your apps and associated accounts. New developers can qualify too." },
      { q: "What happens if I pass $1 million?", a: "The standard commission applies to future sales in that calendar year. You can re-qualify for the 15% rate in a later year when your proceeds are back under the threshold." },
      { q: "Is enrollment automatic?", a: "No. The Account Holder enrolls in App Store Connect and lists associated developer accounts." },
    ],
    sources: [APPLE_SMALL_BUSINESS, APPLE_SUBS, GOOGLE_HELP_FEES],
    related: ["/glossary/auto-renewable-subscription", "/glossary/mrr", "/glossary/monthly-tracked-revenue", "/tools/app-store-fee-calculator", "/stores/app-store"],
  },
  // ---------------------------------------------------------------------------------------------------------------
  // Paywalls and growth
  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "offering",
    term: "Offering",
    category: "Paywalls and growth",
    short: "An offering is the set of products a paywall shows. You change the offering on the server to change plans, order or prices without shipping an app update.",
    answer:
      "An offering is a named group of products that your app shows on a paywall, such as Monthly and Yearly packages. The app asks the server for the current offering and displays it, so you can change plans, their order or the prices shown from the server without shipping an app update. The term comes from RevenueCat.",
    body: [
      "Neither store has this concept. Apple has subscription groups, which control which plans a customer can switch between, and Google Play has base plans and offers. An offering sits above them and decides what your paywall shows. RevenueCat says offerings are optional but they enable paywalls, experiments and targeting.",
      "In RevenueDot an offering holds packages such as `$rc_monthly` and `$rc_annual`, and each package holds one product per app, so one offering serves your iOS and Android apps. The SDK shows the current offering. You can make another offering current, show one customer a different offering, or retire an old one by archiving it. Free-form metadata on the offering can carry paywall copy or flags. Because the offering is data on the server, it is also what RevenueDot paywalls and offering experiments work on: a paywall is attached to an offering, and an A/B test shows different customers different offerings.",
    ],
    faq: [
      { q: "What is the difference between an offering and an entitlement?", a: "An offering is what you sell on the paywall. An entitlement is the access a purchase grants. Products in an offering grant entitlements." },
      { q: "Can iOS and Android share one offering?", a: "Yes. Each package holds one product per app, so the same offering can show the App Store product on iOS and the Google Play product on Android." },
      { q: "How do I change prices without an app update?", a: "Make another offering current on the server, or change the products in the current offering. The app picks it up on its next call for offerings." },
    ],
    sources: [RC_OFFERINGS, APPLE_SUBS, GOOGLE_HELP_UNDERSTAND],
    related: ["/glossary/entitlement", "/glossary/product-identifier", "/features/paywalls", "/features/experiments", "/docs/concepts/offerings-and-packages"],
  },
  {
    slug: "external-purchase-link",
    term: "External purchase link (US storefront)",
    category: "Paywalls and growth",
    short: "On the US App Store, an app can link to your website to buy digital goods without an Apple entitlement. Other regions need a specific entitlement.",
    answer:
      "An external purchase link is a button or link in an iOS app that sends customers to your website to buy digital goods. On the United States storefront, App Review Guideline 3.1.1(a) lets apps include such links without an Apple entitlement. In other regions, an app needs a StoreKit External Purchase Link entitlement that Apple grants for specific storefronts.",
    body: [
      "Apple's guidelines say the entitlements for linking to a website are not required for apps on the United States storefront, and that in other storefronts, outside the entitlement regions, apps may not include buttons, external links or calls to action that direct customers to other purchase methods. Apple's External Purchase documentation describes the entitlements and the token reporting that apply in the EU, Brazil and Japan. These rules have changed several times, so read Guideline 3.1.1(a) and 3.1.3 as of the day you ship.",
      "Google Play has its own programs for external offers and alternative billing, and its service fee page lists the fees for them. Check the rule for each country where you sell before you add a link.",
      "RevenueDot builds the web side: web billing on your own Stripe account, hosted purchase links, funnels and a redemption link that opens your app and moves the purchase to the right customer. The product pages say to check the App Store and Google Play rules for external purchases in each country before you send buyers from the app to web checkout.",
    ],
    faq: [
      { q: "Do I need an entitlement to link to my website from a US iOS app?", a: "Not according to Guideline 3.1.1(a), which says the entitlements are not required for apps on the United States storefront." },
      { q: "Can I link to web checkout in other countries?", a: "Only where Apple gives the entitlement and you hold it. In other storefronts the guidelines still prohibit buttons and links that direct customers to other purchase methods." },
      { q: "Where do I read the current rule?", a: "In Apple's App Review Guidelines, sections 3.1.1(a) and 3.1.3, and in the External Purchase documentation." },
    ],
    sources: [APPLE_GUIDELINES, APPLE_EXTERNAL, GOOGLE_HELP_FEES],
    related: ["/glossary/web-to-app", "/features/web-billing", "/features/purchase-links", "/docs/guides/purchase-links", "/blog/web-checkout-for-ios-apps-stripe", "/solutions/web-to-app"],
  },
  {
    slug: "customer-center",
    term: "Customer Center and manage subscription URL",
    category: "Paywalls and growth",
    short: "A Customer Center is the in-app screen where subscribers manage or cancel a plan and get help. Both stores also have their own management page.",
    answer:
      "A Customer Center is a self-service screen in your app where subscribers see their plan, change or cancel it, restore purchases and contact support. It can show a retention offer before they cancel. Both stores also run a management page: Apple's manage subscriptions sheet and Google Play's subscriptions center, which has a link you can open from your app.",
    body: [
      "On iOS, call `showManageSubscriptions(in:)` to present Apple's sheet inside your app. It shows the customer's active subscription and lets them view, upgrade, downgrade or cancel. Apple says to avoid showing it in Mac Catalyst apps and in iOS apps running on Apple silicon Macs, because the sheet is not supported on macOS. On Android, open `https://play.google.com/store/account/subscriptions?sku=<product>&package=<package>`, where customers manage payment methods, cancel, resubscribe and pause.",
      "A Customer Center of your own adds what the stores' pages do not: a retention offer, an exit survey, and answers for common questions. RevenueCat describes its Customer Center as a self-service UI that can prevent churn with promotional offers, collect exit feedback and lower support volume. Apple's advice is to make it easy to reach the system management screen where people can cancel.",
      "RevenueDot serves the configuration for the RevenueCat SDK's Customer Center (`CustomerCenterView` on iOS, `CustomerCenter` on Android). You add a promotional offer to the cancel path or the refund path under Lifecycle, Retention, and RevenueDot signs the offer. It also answers Apple's Retention Messaging API in real time and stores support tickets that customers send from the screen.",
    ],
    faq: [
      { q: "How do I open the subscription management page from my app?", a: "On iOS call `showManageSubscriptions(in:)`. On Android open the Google Play subscriptions URL with your product ID and package name." },
      { q: "Does a Customer Center stop cancellations?", a: "It lets you show an offer first. The customer can still cancel in the store, and the store, not your app, ends the subscription." },
      { q: "Is a Customer Center required?", a: "No. Apple says to consider adding a manage subscriptions option, and your own screen is optional on both stores." },
    ],
    sources: [APPLE_MANAGE, APPLE_SUBS, GOOGLE_SUBS, RC_CUSTOMER_CENTER],
    related: ["/glossary/promotional-offer", "/glossary/churn", "/features/customer-center", "/docs/guides/retention", "/charts/customer-center-survey-responses", "/charts/app-store-save-outcomes"],
  },
  {
    slug: "hard-paywall",
    term: "Hard paywall (and soft paywall)",
    category: "Paywalls and growth",
    short: "A hard paywall blocks the app until the customer starts a trial or pays. A soft paywall, also called freemium, lets people use a free version first.",
    answer:
      "A hard paywall blocks the app until the customer starts a trial or pays. A soft paywall, also called freemium, lets people use a free version first and shows the offer later or at a limit. RevenueCat's 2026 data finds that hard paywalls convert about five times more users than freemium by day 35.",
    body: [
      "RevenueCat reports a median day-35 trial-to-paid conversion of 10.7% for hard-paywall apps against 2.1% for freemium apps, and revenue per install at day 60 of $3.09 against $0.38. One-year retention of yearly subscribers is almost the same, 27% for hard paywalls and 28% for freemium. Freemium apps keep converting into week six and beyond, so a freemium app is a slower path, not a failed one.",
      "The choice is a product decision, not only a conversion one. A hard paywall fits an app whose value is clear in the first minute. A soft paywall fits an app where people need to feel the value before they pay, or where a free tier brings in users and word of mouth. Whichever you pick, App Store rules still apply: say the price and terms clearly, provide a restore mechanism, and do not trick people into a subscription.",
      "RevenueDot measures both approaches with the Paywall Conversion Rate, Paywall Abandonment Rate and Paywall LTV charts, builds paywalls from a gallery of templates, and tests two offerings against each other with experiments.",
    ],
    faq: [
      { q: "What is a soft paywall?", a: "A paywall that lets people use a free version first. It appears later, or when the customer reaches a limit. It is the same idea as freemium." },
      { q: "Do hard paywalls retain worse?", a: "RevenueCat's data shows a negligible gap in one-year retention of yearly subscribers: 27% for hard paywalls and 28% for freemium." },
      { q: "Can App Review reject a paywall?", a: "Yes if it misleads people. Apple's guidelines remove apps that trick users into a subscription under false pretenses, and expect a restore mechanism for restorable purchases." },
    ],
    sources: [RC_BENCHMARKS, APPLE_GUIDELINES],
    related: ["/glossary/free-trial", "/glossary/offering", "/features/paywalls", "/charts/paywall-conversion-rate", "/charts/paywall-abandonment-rate", "/blog/hard-paywall-vs-freemium"],
  },
  {
    slug: "web-to-app",
    term: "Web-to-app",
    category: "Paywalls and growth",
    short: "Web-to-app sells a subscription on a web page or funnel first, then opens your app with the purchase already attached to the right user's account.",
    answer:
      "Web-to-app is a way to sell a subscription on the web before the customer opens your app. A person clicks an ad, answers a quiz or sees an offer on a web page, pays on a web checkout, and then opens the app through a link that attaches the purchase to their account. The payment goes through your web checkout instead of the store's billing.",
    body: [
      "Four pieces make it work: a landing page or funnel, a web checkout such as Stripe Checkout, a way to identify the customer, and a link back into the app. For a known user you add their app user ID to the checkout link. For an anonymous buyer, a redemption link lets them buy first and attach the purchase to an account inside the app afterwards. RevenueCat documents the same two paths in its Web Purchase Links and Redemption Links guides.",
      "The rules differ by store and country. On the US App Store, Apple's guidelines let apps link to web purchases without an entitlement, and other regions have their own conditions, so read the external purchase link entry before you add a link inside the app.",
      "RevenueDot sells on your own Stripe account. A hosted purchase link at `/pay/<project>/<link>` takes `?app_user_id=` for signed-in users, ends on a success page with a redemption link, and the SDK's `redeemWebPurchase` moves the purchase to the app user so the entitlement is active. Funnels, web discounts and custom domains are built in.",
    ],
    faq: [
      { q: "What is a redemption link?", a: "A link that opens your app after a web purchase and hands the purchase to the SDK, which attaches it to the app user so their entitlement turns on." },
      { q: "Do web purchases give the same access as store purchases?", a: "Yes, if the web product is attached to the same entitlement. The SDK treats the purchase like any other once it is redeemed." },
      { q: "Can I do web-to-app on iOS?", a: "It depends on the storefront and where the link sits. Read Apple's Guideline 3.1.1(a) and the External Purchase documentation for the countries where you sell." },
    ],
    sources: [RC_PURCHASE_LINKS, RC_REDEMPTION, APPLE_GUIDELINES],
    related: ["/glossary/external-purchase-link", "/features/web-billing", "/features/funnels", "/features/purchase-links", "/docs/guides/redemption-links", "/solutions/web-to-app"],
  },
  // ---------------------------------------------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "mrr",
    term: "MRR (monthly recurring revenue)",
    category: "Metrics",
    short: "MRR is monthly recurring revenue: the monthly-normalized value of every active paid subscription. A $60 yearly plan counts as $5, and free trials count zero.",
    answer:
      "MRR, or monthly recurring revenue, is the sum of every active paid subscription's price normalized to one month, measured at a point in time. A $60 yearly plan counts $5. Free trials count zero, and one-time purchases are left out. ARR is MRR times 12. Taxes, discounts and grace periods are handled differently by each tool.",
    body: [
      "Stripe defines MRR as the sum of the monthly-normalized value of all active and past-due subscriptions, excluding taxes, free plans and usage-based products, with trials excluded and canceled or unpaid subscriptions treated as churn. Its example is 100 subscribers on $100 a month and 50 on $600 a year, which gives $10,000 plus $2,500, so $12,500. Vendors differ on discounts, taxes and subscriptions in a billing problem, so compare numbers from one tool over time rather than across tools.",
      "On the App Store and Google Play the price a customer pays can differ from the price you receive after the store's commission. Decide whether you report the customer price or your proceeds, and say which. MRR also moves when customers change plan, which is why charts split it into new, expansion, contraction and churned MRR.",
      "RevenueDot takes the USD price of each paid subscription that has access at the end of the period and multiplies it by a factor from the product duration: 1 week ×4, 1 month ×1, 3 months ×⅓, 1 year ×1/12. A canceled subscription counts until it expires, one in a grace period counts, and a refund ends it. Trials, one-time purchases, ads, sandbox purchases, granted access and Family Sharing are excluded, and each subscription keeps the exchange rate of its purchase date.",
    ],
    example:
      "100 customers pay $10 a month and 50 customers pay $60 a year. MRR is 100 × $10 + 50 × ($60 ÷ 12), which is $1,000 + $250, or $1,250. ARR is $15,000.",
    faq: [
      { q: "How do I calculate MRR for annual plans?", a: "Divide the yearly price by 12 and add it to the monthly total. A $120 yearly plan adds $10 to MRR every month it is active." },
      { q: "Do free trials count in MRR?", a: "No. A trial carries no money, so MRR starts when the first paid period starts." },
      { q: "What is the difference between MRR and revenue?", a: "Revenue is money received in a period, including one-time purchases and annual payments in full. MRR is the monthly run rate of active subscriptions, so a $120 annual payment is $120 of revenue that month and $10 of MRR for each active month." },
    ],
    sources: [STRIPE_ANALYTICS, RC_CHARTS],
    related: ["/glossary/churn", "/glossary/arpu", "/glossary/monthly-tracked-revenue", "/charts/mrr", "/charts/arr", "/charts/mrr-movement"],
  },
  {
    slug: "churn",
    term: "Churn",
    category: "Metrics",
    short: "Churn is the share of subscribers or revenue lost in a period. At 5% monthly churn, a subscriber stays about 20 months. Failed payments cause involuntary churn.",
    answer:
      "Churn is the share of subscribers, or of revenue, that you lose in a period. Subscriber churn rate is the number of subscriptions that ended divided by the number active at the start. At 5% monthly churn, a subscriber stays about 20 months on average. Voluntary churn is a cancellation, and involuntary churn is a failed payment.",
    body: [
      "Tools define the denominator differently. Stripe divides subscribers who churned in the past 30 days by the active subscribers 30 days ago plus new subscribers in the past 30 days. Both count subscriptions or subscribers, not revenue. Churned revenue is a separate number that adds contraction from downgrades.",
      "Apple describes involuntary churn as customers who do not intend to leave but whose subscription fails to renew, usually for billing reasons, and says it is not related to customer satisfaction. You can cut it with a billing grace period, with the store's retry period, and with in-app messages that ask the customer to fix the payment method. Voluntary churn needs different tools: a retention offer in the Customer Center, a pause on Google Play, and win-back offers after the subscription ends.",
      "Segment before you act. Monthly and annual plans have different rhythms, because an annual plan has one decision point a year and a monthly plan has twelve. A single blended rate hides which plan, store or country is leaking. RevenueDot divides subscriptions that lost access, net of billing recoveries, by the paid subscriptions active at the start of the period, so its rate can be negative in a period with many recoveries, and its Churn chart can be filtered and segmented by app, store, product, product duration, offering, country, platform and app version.",
    ],
    example:
      "A subscription app has 1,000 active subscribers on May 1. During May, 80 subscriptions end, and 20 of them are billing problems that recover after a retry. Net churned subscriptions are 60, so churn is 6% for the month.",
    faq: [
      { q: "What is the difference between voluntary and involuntary churn?", a: "Voluntary churn is a customer choosing to cancel. Involuntary churn is a renewal that fails, usually for a billing reason such as an expired card, with no intent to leave." },
      { q: "How do I reduce churn?", a: "For involuntary churn, turn on a billing grace period and ask customers to fix their payment. For voluntary churn, offer a retention discount before cancel, let customers pause on Google Play, and send win-back offers." },
      { q: "Does a refund count as churn?", a: "In RevenueDot a refund that ended access counts, because the subscription lost access. Check how each tool treats refunds before you compare numbers." },
    ],
    sources: [STRIPE_ANALYTICS, APPLE_CHURN, RC_CHARTS],
    related: ["/glossary/billing-grace-period", "/glossary/win-back-offer", "/glossary/customer-center", "/charts/churn-rate", "/charts/subscription-retention", "/charts/active-subscriptions-movement"],
  },
  {
    slug: "ltv",
    term: "LTV (customer lifetime value)",
    category: "Metrics",
    short: "LTV is the revenue a customer brings over their lifetime. A simple estimate is ARPU divided by churn. Realized LTV is the money already collected.",
    answer:
      "LTV, or lifetime value, is the total revenue a customer brings before they stop paying. A common estimate divides average revenue per user by the churn rate, so $10 of monthly ARPU at 5% monthly churn gives $200. Realized LTV instead adds up the money already collected from a cohort in a fixed window, such as the first 90 days, minus refunds.",
    body: [
      "Stripe's subscriber lifetime value divides ARPU by subscriber churn rate, and calls it an estimate based on values at points in time. It is quick, but it assumes churn stays steady, which is often untrue for a young app. Realized LTV avoids the assumption by counting only money received, at the cost of waiting for the window to pass.",
      "RevenueDot's Realized LTV per Customer divides the revenue of a period's new customers inside a window (day 0, 7, 14, 30, 60, 90, 180 or 365, or unbounded), minus refunds, by all new customers, paying or not. Realized LTV per Paying Customer divides by only the customers who paid in the window. The newest periods stay incomplete until every customer's window has passed. A prediction chart extends realized LTV with the months ahead predicted from how older cohorts grew at the same age.",
      "Use LTV to cap what you pay to get a customer. If realized LTV at 90 days is $3.00, paying $5.00 per install does not pay back inside 90 days. Say whether your LTV is gross revenue or your proceeds after store commission, and keep the choice the same across reports.",
    ],
    example:
      "A subscription has $10 of monthly ARPU and 5% monthly churn. Estimated LTV is $10 ÷ 0.05 = $200. If 1,000 new customers bring $3,000 in their first 90 days, realized LTV per customer at day 90 is $3.",
    faq: [
      { q: "How do I calculate LTV for a subscription app?", a: "Estimate it as ARPU divided by churn rate. For a measured number, add up each cohort's revenue in a window and divide by the cohort size." },
      { q: "What is the difference between LTV per customer and per paying customer?", a: "Per customer divides by everyone who joined, including people who never paid. Per paying customer divides by only those who paid, so it shows what a payer is worth." },
      { q: "Should LTV include refunds?", a: "Yes. Realized LTV in RevenueDot subtracts refunds recorded in the window, so it reflects money you kept." },
    ],
    sources: [STRIPE_ANALYTICS, RC_CHARTS],
    related: ["/glossary/arpu", "/glossary/churn", "/charts/ltv-per-customer", "/charts/ltv-per-paying-customer", "/charts/ltv-prediction", "/charts/cohort-explorer"],
  },
  {
    slug: "arpu",
    term: "ARPU (average revenue per user)",
    category: "Metrics",
    short: "ARPU is average revenue per user. For subscriptions it is often total MRR divided by active paying subscribers, so $5,000 of MRR from 500 subscribers is $10.",
    answer:
      "ARPU is average revenue per user: revenue in a period divided by the number of users. For a subscription business it is often total MRR divided by active paying subscribers, so $5,000 of MRR from 500 subscribers gives $10. Divide by all users, including free ones, and you get a lower number under the same name.",
    body: [
      "Stripe defines ARPU as the average MRR per paid subscriber: total MRR divided by total active subscribers. Other teams divide by all active users, including people on a free plan. The first is sometimes called ARPPU, average revenue per paying user. Pick one definition, write it next to the number, and keep it the same over time.",
      "ARPU explains movement in MRR. If MRR grows while ARPU falls, you are adding cheaper subscribers, perhaps through a discount or a weekly plan. If ARPU rises while subscribers fall, price or plan mix is doing the work and you may be losing the low-price customers. ARPU is also half of the simple LTV formula, ARPU divided by churn.",
      "RevenueDot has no single ARPU chart. You can compute it from the MRR and Active Subscriptions charts. Realized LTV per Paying Customer shows revenue per payer inside a fixed window, and the Ad ARPDAU chart shows ad revenue per daily active user for apps that sell ads.",
    ],
    example:
      "A subscription app has $5,000 of MRR and 500 active paying subscribers. ARPU is $10. If 2,000 free users are counted too, revenue per user across all 2,500 people is $2.",
    faq: [
      { q: "What is the difference between ARPU and ARPPU?", a: "ARPU divides revenue by all users. ARPPU divides it by paying users only. Many subscription tools use the paying-subscriber definition and call it ARPU." },
      { q: "How is ARPU related to LTV?", a: "A simple LTV estimate is ARPU divided by the churn rate, so higher ARPU or lower churn raises LTV." },
      { q: "Should ARPU include trials?", a: "Not in the paying-subscriber version. A trial carries no revenue, and Stripe's active subscribers exclude trials." },
    ],
    sources: [STRIPE_ANALYTICS],
    related: ["/glossary/mrr", "/glossary/ltv", "/glossary/churn", "/charts/mrr", "/charts/active-subscriptions", "/charts/ltv-per-paying-customer"],
  },
  {
    slug: "trial-conversion-rate",
    term: "Trial conversion rate",
    category: "Metrics",
    short: "Trial conversion rate is the share of free trials that turn into paid subscriptions. Definitions differ in whether running trials count in the denominator.",
    answer:
      "Trial conversion rate is the share of free trials that turn into paid subscriptions. The usual formula is converted trials divided by trial starts, so 40 conversions from 100 trials is 40 percent. Tools differ in the denominator: some divide by trials that have already ended, to avoid counting trials that are still running.",
    body: [
      "Stripe divides the trials that converted to a paid plan in the last 30 days by the trials that ended in the last 30 days. RevenueCat separates three related rates: initial conversion (a trial start or a purchase over new customers), trial conversion, and conversion to paying.",
      "The rate decides what each new trial is worth. Test trial length, the reminder before the first charge and what the customer sees on day one against it. Segment by product duration to compare a 3-day, 7-day and 14-day trial. Beware that the Paywall Conversion chart also reports a trial conversion rate, but there it is divided by paywall viewers, not by trial starts.",
      "RevenueDot groups customers by the date their first trial started and divides customers whose trial converted by customers who started a trial, so trials still running sit in the denominator and the newest points are marked incomplete until their trials end. The first paid period after a trial is a `RENEWAL` with `is_trial_conversion: true`, and the Trial Conversion Rate, Trial Conversion Funnel, Active Trials and Trial Cancellation Rate charts follow it.",
    ],
    example:
      "In a week, 200 customers start a 7-day trial and 70 are charged when it ends. The trial conversion rate is 70 ÷ 200, or 35 percent. While 50 trials are still running, the rate so far is lower than the final rate.",
    faq: [
      { q: "How do I calculate trial conversion rate?", a: "Divide the number of trials that converted to paid by the number of trials that started. For a cleaner reading, use only trials whose period has ended." },
      { q: "What is the difference between trial conversion and initial conversion?", a: "Trial conversion starts from customers who began a trial. Initial conversion starts from all new customers and counts both trial starts and purchases." },
      { q: "Why does the newest period look low?", a: "Trials still running count as starts but not yet as conversions. The rate rises as those trials end." },
    ],
    sources: [STRIPE_ANALYTICS, RC_CHARTS],
    related: ["/glossary/free-trial", "/glossary/introductory-offer", "/charts/trial-conversion-rate", "/charts/trial-conversion-funnel", "/charts/initial-conversion-rate", "/blog/free-trial-timeline-paywall"],
  },
  {
    slug: "monthly-tracked-revenue",
    term: "Monthly tracked revenue (MTR)",
    category: "Metrics",
    short: "Monthly tracked revenue (MTR) is the revenue a billing platform counts to set your bill: all purchases and renewals before store fees and tax.",
    answer:
      "Monthly tracked revenue, or MTR, is the amount a subscription platform measures to set your bill. For RevenueCat it is the revenue from all purchases and renewals in a month, including non-subscription products, measured before store commission and taxes. RevenueCat charges nothing up to $2,500 of MTR and 1% of all MTR once it passes that.",
    body: [
      "RevenueCat's documentation says MTR is different from MRR and includes the revenue from all purchases and renewals, including non-subscription products. It is measured before store commission and taxes, so it reflects what the customer paid and not your net proceeds. As of October 2026, RevenueCat's pricing page says you pay nothing up to $2,500 in MTR and then 1% of MTR. Its account management documentation gives the example of $2,600 in MTR in the previous billing cycle, which means a $26 charge, and says that RevenueCat is free again if you fall below the limit in later months.",
      "That means the fee applies to all tracked revenue once you pass the limit, not only to the part above it. A one-time $49.99 lifetime purchase counts toward MTR, so an app that sells both subscriptions and one-time products has an MTR higher than its MRR.",
      "RevenueDot Cloud uses the same unit: production purchases and renewals in a calendar month, before store fees and taxes. Sandbox purchases, Test Store purchases, trials and refunds do not count. Its Pro plan is free until your apps make $10,000 a month, then charges 0.5% of revenue above $10,000, never more than $999 a month. The server is open source under the AGPL-3.0 license.",
    ],
    example:
      "An app with $2,600 of MTR pays RevenueCat $26, because the 1% applies to all $2,600. At $2,400 it pays nothing. On RevenueDot Cloud both months are free, because Pro costs $0 until your apps make $10,000 a month.",
    faq: [
      { q: "Is MTR the same as MRR?", a: "No. MTR counts all purchases and renewals, including one-time purchases, before store fees and taxes. MRR counts only the monthly value of active subscriptions." },
      { q: "How much does RevenueCat charge for MTR?", a: "As of October 2026, nothing up to $2,500 of MTR, then 1% of MTR on its Pro plan, according to its pricing page." },
      { q: "Does MTR include taxes?", a: "RevenueCat says MTR is measured before store commission and taxes, so it reflects the amount charged to the customer." },
    ],
    sources: [RC_ACCOUNT, RC_PRICING],
    related: ["/glossary/mrr", "/blog/revenuecat-pricing-explained", "/pricing", "/compare/revenuedot-vs-revenuecat", "/tools/revenuecat-fee-calculator"],
  },
];
