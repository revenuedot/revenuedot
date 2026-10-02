// Top-level guide pages: /in-app-purchases, /add-in-app-purchases (first-time builders) and /do-i-need-revenuecat
// (the iOS-only question). Rules: apps/site/CONTENT.md. Apple, Google and Stripe facts link their docs, checked October 2026.
import type { Guide } from "./types";

const SIGNUP = "https://app.revenuedot.app/signup";

// ---- Sources (inline links) ------------------------------------------------------------------------------------------
const A = {
  types: "https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-types",
  subs: "https://developer.apple.com/app-store/subscriptions/",
  sbp: "https://developer.apple.com/app-store/small-business-program/",
  guidelines: "https://developer.apple.com/app-store/review/guidelines/",
  products: "https://developer.apple.com/documentation/storekit/product/products%28for:%29",
  entitlements: "https://developer.apple.com/documentation/storekit/transaction/currententitlements",
  updates: "https://developer.apple.com/documentation/storekit/transaction/updates",
  storeView: "https://developer.apple.com/documentation/storekit/subscriptionstoreview",
  notifications: "https://developer.apple.com/documentation/appstoreservernotifications",
  serverApi: "https://developer.apple.com/documentation/appstoreserverapi",
  consumption: "https://developer.apple.com/documentation/appstoreserverapi/send-consumption-information",
};
const G = {
  billing: "https://developer.android.com/google/play/billing",
  integrate: "https://developer.android.com/google/play/billing/integrate",
  subs: "https://developer.android.com/google/play/billing/subscriptions",
  rtdn: "https://developer.android.com/google/play/billing/rtdn-reference",
  fees: "https://support.google.com/googleplay/android-developer/answer/112622?hl=en",
  payments: "https://support.google.com/googleplay/android-developer/answer/9858738",
};
const STRIPE_PRICING = "https://stripe.com/pricing";

// ---- 1. In-app purchases: the guide for the generic search -----------------------------------------------------------
const IN_APP_PURCHASES: Guide = {
  path: "/in-app-purchases",
  name: "In-app purchases",
  card: "How in-app purchases work on iOS, Android and the web: the types, the store fees and what a backend does.",
  label: "Guide",
  title: "In-app purchases: how they work on iOS, Android and the web",
  metaTitle: "In-App Purchases: How They Work on iOS and Android",
  metaDescription:
    "How in-app purchases work: consumables, non-consumables and subscriptions, what Apple and Google charge, when you must use them, and what a backend does.",
  answer:
    "An in-app purchase is a payment inside a mobile app for digital content or features, charged by the App Store or Google Play instead of your own payment processor. Both stores sell one-time purchases and auto-renewing subscriptions. The store keeps a commission, usually 15% or 30%, and a backend checks each purchase and decides what the customer can use.",
  secondary: { href: "/add-in-app-purchases", label: "Add them to your app" },
  note: "RevenueDot is a free backend for in-app purchases, up to $10,000 a month in revenue.",
  points: [
    { title: "Four types", text: "Consumables, non-consumables, auto-renewable subscriptions and non-renewing subscriptions." },
    { title: "15% or 30% to the store", text: "Apple and Google keep a commission on each sale. Small developers and subscriptions after one year pay 15% on the App Store." },
    { title: "Required for digital goods", text: "Apple requires in-app purchase to unlock features in an iOS app. US storefront apps may also link to a web checkout." },
    { title: "A backend keeps it right", text: "A server validates purchases, tracks who has access, and hears about renewals and refunds while the app is closed." },
  ],
  blocks: [
    {
      h2: "The types of in-app purchase",
      label: "Types",
      paras: [
        "Apple lists four in-app purchase types in [App Store Connect](" + A.types + "). Google Play sells [one-time products and subscriptions](" + G.billing + "), which cover the same cases under different names.",
      ],
      table: {
        head: ["Type", "What the customer gets", "Example", "On Google Play"],
        rows: [
          ["Consumable", "Something used up, which they can buy again", "Coins, AI credits, extra lives", "A one-time product that your app consumes"],
          ["Non-consumable", "Something bought once and kept for good", "Remove ads, a lifetime unlock", "A one-time product that your app acknowledges"],
          ["Auto-renewable subscription", "Access that renews every period until they cancel", "Pro monthly or Pro yearly", "A subscription with base plans and offers"],
          ["Non-renewing subscription", "Access for a fixed time that does not renew", "A season pass", "A prepaid base plan, extended with top-ups"],
        ],
        caption: "Sources: [Apple: In-App Purchase types](" + A.types + ") · [Android Developers: Subscriptions](" + G.subs + "). More detail in the glossary: [consumable and non-consumable](/glossary/consumable-and-non-consumable-in-app-purchase), [auto-renewable subscription](/glossary/auto-renewable-subscription), [non-renewing subscription](/glossary/non-renewing-subscription).",
      },
    },
    {
      h2: "How an in-app purchase works, step by step",
      label: "How it works",
      steps: [
        { name: "Create the products in the store", text: "Add each product in App Store Connect or Google Play Console with an ID such as `pro_monthly` and a price. The store owns prices, taxes and currencies." },
        { name: "Load the products in the app", text: "The app asks the store for the products by ID and shows them, with the store's local prices, on a paywall." },
        { name: "The customer pays the store", text: "The store shows its own payment sheet and charges the customer's Apple or Google account. The app gets a signed transaction on iOS or a purchase token on Android." },
        { name: "Check the purchase and unlock access", text: "The app or a server verifies the transaction and gives access. Google refunds purchases that are not acknowledged within three days, and Apple expects the app to finish each transaction ([Google](" + G.integrate + "))." },
        { name: "Hear about renewals and refunds", text: "Renewals, billing problems, cancellations and refunds happen while the app is closed. Apple sends [App Store Server Notifications](" + A.notifications + ") and Google sends [real-time developer notifications](" + G.rtdn + ") to your server." },
      ],
    },
    {
      h2: "What Apple and Google charge",
      label: "Fees",
      paras: [
        "The store keeps a commission on every in-app purchase before it pays you. Web payments cost less per sale, but you then handle tax, refunds and chargebacks yourself.",
      ],
      table: {
        head: ["Where you sell", "Subscriptions", "One-time purchases"],
        rows: [
          ["App Store", "30% in a subscriber's first year, 15% after one year of paid service", "30%"],
          ["App Store Small Business Program", "15%", "15%, for developers who earned up to $1 million in the previous year"],
          ["Google Play", "15% in most markets", "15% on your first $1 million each year, 30% above that"],
          ["Your website with Stripe", "2.9% + 30¢ per US card charge, plus 0.7% for Stripe Billing", "2.9% + 30¢ per US card charge"],
        ],
        caption: "Sources: [Apple subscriptions](" + A.subs + ") · [Apple Small Business Program](" + A.sbp + ") · [Google Play service fees](" + G.fees + ") · [Stripe pricing](" + STRIPE_PRICING + "). Google is rolling out new fee tiers by market, so check its page for your countries. Try your own numbers in the [App Store and Google Play fee calculator](/tools/app-store-fee-calculator).",
      },
    },
    {
      h2: "When you must use in-app purchase",
      label: "Store rules",
      paras: [
        "Apple's App Review Guideline 3.1.1 says that if you want to unlock features or functionality within your app, such as subscriptions, in-game currencies or premium content, you must use in-app purchase ([Apple](" + A.guidelines + ")). Physical goods and services used outside the app, such as a ride or a meal, must use another payment method, such as Apple Pay or a card.",
        "On the United States storefront, apps may also include buttons and links to buy on your website. In other storefronts that needs a specific Apple entitlement. See [external purchase links](/glossary/external-purchase-link) and our guide to [selling iOS subscriptions on the web with Stripe](/blog/web-checkout-for-ios-apps-stripe).",
        "Google Play's [Payments policy](" + G.payments + ") requires Google Play's billing system for digital goods sold in apps, with exceptions for physical goods and for alternative billing programs in some countries.",
      ],
    },
    {
      h2: "What a backend does for in-app purchases",
      label: "Backend",
      paras: ["StoreKit 2 and the Google Play Billing Library run the purchase on the device. A server handles everything that happens after it, or on another device."],
      bullets: [
        "**Validates purchases** with Apple's [App Store Server API](" + A.serverApi + ") and Google's Play Developer API, so a tampered app cannot unlock access.",
        "**Keeps entitlements:** one answer to \"is this customer Pro?\" across iPhone, Android and the web. See [entitlement](/glossary/entitlement).",
        "**Receives store notifications** for renewals, billing retries, grace periods, refunds and cancellations, and acknowledges Google Play purchases in time.",
        "**Sends events** to your own backend with webhooks, and to analytics and messaging tools.",
        "**Measures revenue:** MRR, churn, trial conversion and refunds across stores. See [subscription charts](/charts).",
      ],
    },
    {
      h2: "How RevenueDot fits",
      label: "RevenueDot",
      paras: [
        "RevenueDot is an open-source backend for in-app purchases and subscriptions. Your app uses the RevenueCat SDK, an open-source library, pointed at RevenueDot with one line of code. RevenueDot validates App Store, Google Play, Amazon Appstore and Stripe purchases, keeps entitlements, receives store notifications and sends webhooks.",
        "RevenueDot Cloud is free up to $10,000 a month in revenue, and you can run the same code on your own servers. Start with [the step-by-step setup](/add-in-app-purchases), or read [whether an iOS-only app needs a backend at all](/do-i-need-revenuecat).",
      ],
    },
  ],
  howTo: "How an in-app purchase works, step by step",
  faq: [
    {
      q: "What is an in-app purchase?",
      a: "An in-app purchase is a payment made inside a mobile app for digital content or features, such as a subscription, coins or a lifetime unlock. The App Store or Google Play charges the customer and pays the developer after keeping a commission.",
    },
    {
      q: "How much do Apple and Google take from in-app purchases?",
      a: "Apple keeps 30% by default, 15% for subscriptions after one year of paid service, and 15% for developers in the Small Business Program. Google Play keeps 15% of subscriptions in most markets, and 15% of one-time purchases on your first $1 million each year. See the [fee calculator](/tools/app-store-fee-calculator).",
    },
    {
      q: "What is the difference between consumable and non-consumable in-app purchases?",
      a: "A consumable is used up and can be bought again, like coins or credits. A non-consumable is bought once and kept, like removing ads or a lifetime unlock. Neither renews on its own.",
    },
    {
      q: "Can I use Stripe instead of in-app purchases?",
      a: "Not for digital features unlocked inside an iOS app, which Apple says must use in-app purchase. On the US storefront you may link from the app to a web checkout, and you can sell on your website with Stripe. Physical goods must use a method other than in-app purchase. See [RevenueCat vs Stripe](/compare/revenuecat-vs-stripe).",
    },
    {
      q: "Do I need a server for in-app purchases?",
      a: "Not always. An iOS-only app can check purchases on the device with StoreKit 2. You need a server for Android and web customers, for events while the app is closed, for webhooks and charts, and when your backend must trust a purchase. See [Do I need RevenueCat for an iOS-only app?](/do-i-need-revenuecat).",
    },
  ],
  docs: [
    { href: "/docs/getting-started/quickstart", label: "Quickstart" },
    { href: "/docs/concepts/products-and-entitlements", label: "Products and entitlements" },
    { href: "/docs/guides/app-store", label: "Connect the App Store" },
    { href: "/docs/guides/google-play", label: "Connect Google Play" },
  ],
  related: ["/add-in-app-purchases", "/do-i-need-revenuecat", "/compare/revenuecat-vs-stripe", "/tools/app-store-fee-calculator", "/stores/app-store", "/stores/google-play"],
};

// ---- 2. First-time builders (avatar "Sam") ---------------------------------------------------------------------------
const ADD_IAP: Guide = {
  path: "/add-in-app-purchases",
  parents: [{ name: "In-app purchases", path: "/in-app-purchases" }],
  name: "Add in-app purchases",
  card: "New to in-app purchases? Add subscriptions to an iOS, Android, Flutter, React Native or web app, free until it makes $10K a month.",
  label: "New to in-app purchases",
  title: "Add subscriptions to your app for free until it makes $10K a month",
  metaTitle: "How to Add In-App Purchases and Subscriptions to an App",
  metaDescription:
    "Add in-app purchases and subscriptions to an iOS, Android, Flutter, React Native or web app with RevenueDot. No RevenueCat account needed. Free up to $10K a month.",
  answer:
    "RevenueDot is a free backend for in-app purchases and subscriptions. You install the RevenueCat SDK, an open-source library that needs no RevenueCat account, and point it at RevenueDot with one line of code. Then you sell on the App Store and Google Play, and on the web with Stripe. RevenueDot Cloud is free until your app makes $10,000 a month.",
  secondary: { href: "/docs/getting-started/quickstart", label: "Read the 5-minute quickstart" },
  note: "No RevenueCat account and no credit card needed. Test purchases work before you have an App Store or Google Play account.",
  points: [
    { title: "No RevenueCat account", text: "The RevenueCat SDK is open source under the MIT licence. RevenueDot gives each of your apps its own key." },
    { title: "Free until it earns", text: "RevenueDot Cloud costs nothing up to $10,000 a month in store revenue, counted before Apple and Google take their cut." },
    { title: "Test without a store account", text: "The built-in Test Store makes purchases that unlock access and send events like real ones, so you can build the paywall first." },
    { title: "Your AI tool can set it up", text: "Connect Claude Code or Cursor to RevenueDot's MCP server and paste the prompt below. It creates the products and writes the code." },
  ],
  blocks: [
    {
      h2: "Add subscriptions in five steps",
      label: "Setup",
      paras: ["This sets up one `pro` plan sold monthly and yearly. The same steps work for credits and lifetime purchases."],
      steps: [
        { name: "Create a free account", text: "Sign up at [app.revenuedot.app](" + SIGNUP + ") and name your first project. A project holds your apps, products and customers." },
        { name: "Add an app, a product and a plan", text: "Add a **Test Store** app. Add a product such as `pro_monthly`, an entitlement called `pro` that the product unlocks, and an offering called `default` that your paywall shows." },
        { name: "Install the SDK", text: "Install the RevenueCat SDK for your framework from the table below. RevenueDot also publishes MIT forks that point at RevenueDot by default: iOS on CocoaPods, Android on Maven Central and web on npm." },
        { name: "Point it at RevenueDot", text: "Before you configure the SDK, set its proxy URL to `https://api.revenuedot.app` and use the key RevenueDot shows for your app. With the stock SDK, also turn off its signature check, as in the code below." },
        { name: "Show the paywall and check access", text: "Load the current offering, show its packages, and buy one. Then check whether the customer has the `pro` entitlement. When it works with the Test Store, connect the App Store and Google Play in the dashboard." },
      ],
      code: {
        title: "Step 4 on iOS",
        label: "Swift",
        code: `// Set before configure. Nothing else in your purchase code is specific to RevenueDot.
Purchases.proxyURL = URL(string: "https://api.revenuedot.app")!
Purchases.configure(with: Configuration.Builder(withAPIKey: "test_...")
    .with(entitlementVerificationMode: .disabled)
    .build())`,
      },
    },
    {
      h2: "Pick your framework",
      label: "SDKs",
      paras: ["Each guide has the install line, the proxy setting and a full paywall example for that framework."],
      table: {
        head: ["Framework", "Install", "Guides"],
        rows: [
          ["iOS (Swift, SwiftUI)", "Swift Package Manager: `github.com/RevenueCat/purchases-ios-spm`. Fork: `RevenueDotPurchases` on CocoaPods", "[iOS SDK](/sdks/ios) · [SwiftUI tutorial](/blog/swiftui-subscriptions-tutorial)"],
          ["Android (Kotlin)", "Gradle: `com.revenuecat.purchases:purchases`. Fork: `app.revenuedot.purchases:purchases` on Maven Central", "[Android SDK](/sdks/android) · [Google Play Billing tutorial](/blog/android-google-play-billing-subscriptions)"],
          ["React Native and Expo", "`npm install react-native-purchases`", "[React Native SDK](/sdks/react-native) · [Expo tutorial](/blog/react-native-expo-subscriptions-tutorial)"],
          ["Flutter", "`purchases_flutter` in `pubspec.yaml`", "[Flutter SDK](/sdks/flutter) · [Flutter tutorial](/blog/flutter-in-app-purchases-tutorial)"],
          ["Web", "A hosted Stripe checkout page, or `@revenuedot/purchases-js` on npm", "[Web SDK](/sdks/web) · [Web checkout](/features/web-billing)"],
        ],
        caption: "Capacitor, Cordova, Kotlin Multiplatform and Unity work too. See [all SDKs](/sdks).",
      },
    },
    {
      h2: "The five words you need",
      label: "Words",
      paras: ["In-app purchase tools use a few words that confuse almost everyone at first. Here is what each one means in your app."],
      bullets: [
        "**Product:** one thing a customer can buy, created in App Store Connect or Google Play Console, such as `pro_monthly` at $4.99.",
        "**Entitlement:** what a purchase unlocks, such as `pro`. Your app checks the entitlement, never the product, so you can add plans later without an app update.",
        "**Offering:** the set of products your paywall shows right now. Change it in the dashboard to test prices without a release.",
        "**Paywall:** the screen that shows the offering and the buy button. RevenueDot has [ten templates and a visual editor](/features/paywalls).",
        "**Test Store:** RevenueDot's built-in store for testing. Its purchases are always sandbox data. See [Test Store](/stores/test-store).",
      ],
    },
    {
      h2: "What it costs",
      label: "Price",
      paras: [
        "RevenueDot Cloud is free until your app makes $10,000 a month, counted before Apple and Google take their cut. Above that, the planned price is 0.5% of the revenue above $10,000, capped at $999 a month. It is not charged yet. You can also run RevenueDot on your own servers for free. See [pricing](/pricing).",
        "The stores keep their own commission, usually 15%. See [what Apple and Google charge](/in-app-purchases#what-apple-and-google-charge).",
      ],
    },
  ],
  howTo: "Add subscriptions in five steps",
  faq: [
    {
      q: "Do I need a RevenueCat account to use RevenueDot?",
      a: "No. The RevenueCat SDK is an open-source library that you install from its usual package registry. RevenueDot gives each of your apps its own key, and the SDK talks only to RevenueDot once you set its proxy URL. RevenueDot is not affiliated with RevenueCat.",
    },
    {
      q: "Is the RevenueCat SDK free to use?",
      a: "Yes. RevenueCat publishes its SDKs under the MIT licence on [GitHub](https://github.com/RevenueCat/purchases-ios/blob/main/LICENSE), which allows anyone to use them. RevenueDot also publishes MIT forks that point at RevenueDot by default.",
    },
    {
      q: "Can I test purchases before I have an App Store or Google Play account?",
      a: "Yes. Add a Test Store app in RevenueDot and use its `test_` key. Its purchases unlock entitlements and send webhooks like real ones, and they are always sandbox data. You need the App Store and Google Play accounts when you sell for real.",
    },
    {
      q: "What does RevenueDot cost for a new app?",
      a: "Nothing until the app makes $10,000 a month in store revenue. Above that, the planned price is 0.5% of the revenue above $10,000, capped at $999 a month, and it is not charged yet. Self-hosting is free.",
    },
    {
      q: "Can Claude Code or Cursor add subscriptions for me?",
      a: "Yes. Connect the assistant to `https://mcp.revenuedot.app/mcp`, sign in, and paste the prompt on this page. The RevenueDot tools create the apps, products, entitlement and offering, and the assistant writes the SDK code. You enter store keys yourself in the dashboard.",
    },
  ],
  docs: [
    { href: "/docs/getting-started/quickstart", label: "Quickstart" },
    { href: "/docs/sdks", label: "SDK guides" },
    { href: "/docs/guides/test-store", label: "Test Store" },
    { href: "/docs/guides/connect-ai-assistants", label: "Connect AI assistants" },
  ],
  related: ["/in-app-purchases", "/do-i-need-revenuecat", "/solutions/ai-built-apps", "/features/paywalls", "/sdks", "/pricing"],
};

// ---- 3. "Do I need RevenueCat if I only build for iOS?" --------------------------------------------------------------
const IOS_ONLY: Guide = {
  path: "/do-i-need-revenuecat",
  parents: [{ name: "In-app purchases", path: "/in-app-purchases" }],
  name: "Do I need RevenueCat?",
  card: "For an iOS-only app, StoreKit 2 can be enough. Here is when you need a backend, with a decision table.",
  label: "Honest answer",
  title: "Do you need RevenueCat if you only build for iOS?",
  metaTitle: "Do I Need RevenueCat for an iOS-Only App?",
  metaDescription:
    "For an iOS-only app, StoreKit 2 and Apple's server notifications can be enough. See when you need a backend like RevenueCat or RevenueDot, with a decision table.",
  answer:
    "For many iOS-only apps, StoreKit 2 is enough. It runs the purchase and tells the app what the customer owns, and Apple's server notifications tell your server about renewals and refunds. You need a backend such as RevenueCat or RevenueDot when you add Android or the web, need entitlements on a server, want webhooks, charts or paywall tests, or do not want to maintain Apple's edge cases.",
  secondary: { href: "/blog/storekit-2-vs-revenuecat", label: "StoreKit 2 vs RevenueCat in depth" },
  note: "We build a backend, so we link Apple's documentation for every fact about StoreKit.",
  points: [
    { title: "StoreKit 2 runs the purchase", text: "It loads products, charges the customer, verifies the transaction on the device and lists what the customer owns." },
    { title: "Apple can reach your server", text: "App Store Server Notifications tell a server about renewals, refunds and billing problems, even while the app is closed." },
    { title: "A backend joins the stores", text: "Android and web customers need a server that gives one customer one set of access across every store." },
    { title: "The edge cases cost the time", text: "Grace periods, refunds, family sharing and offer codes are where homemade setups break, not the first purchase." },
  ],
  blocks: [
    {
      h2: "What StoreKit 2 and Apple's servers give you",
      label: "Apple only",
      paras: ["Apple's own tools cover a complete iOS subscription app. Each item links to Apple's documentation."],
      bullets: [
        "**Products and prices:** `Product.products(for:)` loads your products from the App Store ([Apple](" + A.products + ")).",
        "**A ready-made paywall:** `SubscriptionStoreView` shows a subscription group with names, prices and a buy button ([Apple](" + A.storeView + ")).",
        "**What the customer owns:** `Transaction.currentEntitlements` lists the customer's active, verified purchases and leaves out refunded ones ([Apple](" + A.entitlements + ")).",
        "**Purchases made elsewhere:** `Transaction.updates` delivers renewals, offer codes and purchases from other devices while the app runs ([Apple](" + A.updates + ")).",
        "**Events while the app is closed:** App Store Server Notifications V2 send renewals, refunds and billing problems to a URL you choose ([Apple](" + A.notifications + ")).",
        "**Server checks:** the App Store Server API lets your server look up a customer's transactions and subscription status ([Apple](" + A.serverApi + ")).",
      ],
      code: {
        title: "Is this customer Pro?",
        label: "Swift · StoreKit 2",
        code: `func isPro() async -> Bool {
    for await result in Transaction.currentEntitlements {
        if case .verified(let transaction) = result, transaction.productID.hasPrefix("pro_") {
            return true
        }
    }
    return false
}`,
      },
    },
    {
      h2: "Decide in one table",
      label: "Decision table",
      paras: ["Find the row that matches your app. If every row you need says StoreKit 2 is enough, you do not need RevenueCat or RevenueDot yet."],
      table: {
        head: ["Your situation", "StoreKit 2 alone", "With a backend"],
        rows: [
          ["One iOS app that checks access on the device", "**Enough.** Use `currentEntitlements` and listen to `updates`", "Not needed yet"],
          ["You add an Android app or a web version", "Covers App Store purchases only", "One customer, one entitlement across App Store, Google Play and Stripe"],
          ["Your server or website must know who paid", "You build a server that calls the App Store Server API", "Server-side entitlements through a REST API"],
          ["You want purchase events in your backend, Slack or analytics", "No webhooks; you build a notification receiver", "Webhooks and integrations"],
          ["You want MRR, churn and trial conversion", "App Store Connect reports, Apple only", "Charts across every store"],
          ["You want to change paywalls or prices without a release", "You build remote config yourself", "Remote paywalls, offerings and A/B tests"],
          ["Apple asks for refund consumption data", "Your server must answer within 12 hours", "Answered for you ([Refund Control](/features/refund-control))"],
        ],
        caption: "Apple sources: [App Store Server API](" + A.serverApi + ") · [Send Consumption Information](" + A.consumption + ") · [App Store Server Notifications](" + A.notifications + ").",
      },
    },
    {
      h2: "The edge cases you maintain without a backend",
      label: "The real work",
      paras: ["The first purchase takes an afternoon. These cases take the weeks, because each one needs code, a test and a server that is always on."],
      bullets: [
        "**Billing problems:** [grace periods](/glossary/billing-grace-period) and [billing retry](/glossary/billing-retry), where access depends on the subscription state.",
        "**Refunds and revocations:** take access away when Apple sends a [refund](/glossary/refund), and answer [consumption requests](/glossary/consumption-request).",
        "**Upgrades and downgrades:** moves between plans in one [subscription group](/glossary/subscription-group).",
        "**Family Sharing:** purchases shared with family members, and taken back when they leave ([Family Sharing](/glossary/family-sharing)).",
        "**Offers:** [introductory offers](/glossary/introductory-offer), [offer codes](/glossary/offer-code) and [win-back offers](/glossary/win-back-offer), each with its own eligibility rules.",
        "**Accounts:** a customer who signs in on a second device, or restores purchases into a different app account.",
      ],
    },
    {
      h2: "If you need a backend, where RevenueDot fits",
      label: "RevenueDot",
      paras: [
        "RevenueDot is an open-source backend that works with the RevenueCat SDK, so you get the same SDK and paywalls without a RevenueCat account. It handles the App Store, Google Play, Amazon Appstore and Stripe in one customer record, with webhooks, 43 charts, paywalls and Refund Control. RevenueDot Cloud is free up to $10,000 a month, and you can self-host it.",
        "It is new: it launched in 2026, has far less production history than RevenueCat, and has no SOC 2 report. Test your app in Apple's sandbox before launch. You can also start with StoreKit 2 today and add a backend when you add Android. See [how to add subscriptions](/add-in-app-purchases).",
      ],
    },
  ],
  faq: [
    {
      q: "Is StoreKit 2 enough for an iOS subscription app?",
      a: "For an iOS-only app that checks access on the device, yes. StoreKit 2 loads products, runs the purchase, verifies transactions and lists what the customer owns. Add a backend when you need Android or web customers, server-side access checks, webhooks, charts or paywall tests.",
    },
    {
      q: "Do I need a server to validate StoreKit 2 purchases?",
      a: "Not for access inside the app, because StoreKit verifies signed transactions on the device. You need a server when something outside the app must trust the purchase, such as your API or website. Apple's App Store Server API and server notifications are built for that.",
    },
    {
      q: "When should an iOS-only app add RevenueCat or RevenueDot?",
      a: "When you add a second store or web checkout, when your backend must know who paid, when you want purchase events and revenue charts, or when the edge cases (grace periods, refunds, offer codes, Family Sharing) start costing more time than the backend costs money.",
    },
    {
      q: "Can I start with StoreKit 2 and add a backend later?",
      a: "Yes. Your products and subscribers stay in App Store Connect. When you add the RevenueCat SDK pointed at RevenueDot, call its restore or sync method so existing subscribers are recorded on the server, and set Apple's server notification URL to RevenueDot.",
    },
    {
      q: "Does RevenueDot need a RevenueCat account?",
      a: "No. RevenueDot uses the open-source RevenueCat SDK with its own keys and its own server. You never sign up with RevenueCat. RevenueDot is not affiliated with RevenueCat.",
    },
  ],
  docs: [
    { href: "/docs/guides/app-store", label: "Connect the App Store" },
    { href: "/docs/sdks/ios", label: "iOS SDK guide" },
    { href: "/docs/getting-started/quickstart", label: "Quickstart" },
  ],
  related: ["/blog/storekit-2-vs-revenuecat", "/in-app-purchases", "/add-in-app-purchases", "/glossary/storekit-2", "/compare/revenuedot-vs-revenuecat", "/tools/revenuecat-fee-calculator"],
};

export const GUIDES: Guide[] = [IN_APP_PURCHASES, ADD_IAP, IOS_ONLY];
export const guideByPath = (path: string) => GUIDES.find((g) => g.path === path)!;
