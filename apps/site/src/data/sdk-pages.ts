// SDK landing pages: /sdks/<slug>. Each page leads a new developer through installing the RevenueDot SDK with their key;
// switchers get one marked "Switch" block with the proxy-mode code. Install lines and versions match src/lib/sdks.ts;
// other facts come from the docs in docs/sdks/*.md (checked October 2026). Writing rules: apps/site/CONTENT.md.
import type { Landing } from "./types";

const SIGNUP = "https://app.revenuedot.app/signup";

export const SDK_PAGES: Landing[] = [
  {
    slug: "ios",
    section: "sdks",
    name: "iOS",
    card: "Add StoreKit 2 subscriptions to iOS, macOS, tvOS, watchOS and visionOS apps with the RevenueDot Swift SDK.",
    label: "SDK",
    title: "iOS in-app subscriptions with StoreKit 2 and the RevenueDot SDK",
    metaTitle: "iOS in-app subscriptions SDK for StoreKit 2",
    metaDescription:
      "Add iOS in-app subscriptions with StoreKit 2. Install the RevenueDot Swift SDK, pass your app's key and test with the Test Store. Free until $10K a month.",
    answer:
      "To add iOS in-app subscriptions, install the RevenueDot Swift SDK with Swift Package Manager or CocoaPods and call `Purchases.configure` with your app's `appl_` key. RevenueDot verifies each StoreKit 2 transaction with Apple and keeps each customer's access in sync. It covers iOS, iPadOS, macOS, tvOS, watchOS and visionOS. RevenueDot Cloud is free until your app makes $10,000 a month.",
    shot: {
      src: "paywalls-ios.png",
      alt: "A RevenueDot paywall rendered by the RevenueDot SDK on an iPhone simulator",
      caption: "A RevenueDot paywall rendered on an iPhone simulator.",
    },
    points: [
      { title: "One package", text: "Add `github.com/revenuedot/purchases-ios` at `5.91.0-revenuedot`, or the `RevenueDotPurchases` pod." },
      { title: "StoreKit 2 checked by the server", text: "RevenueDot verifies signed transactions against Apple's root certificate, and the App Store Server API supplies history." },
      { title: "Test Store first", text: "Buy with a `test_` key in a Debug build before you have an App Store account." },
      { title: "Paywalls and web purchases", text: "`RevenueCatUI` shows paywalls you design in the dashboard, and `redeemWebPurchase` gives buyers from a web purchase link access." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to an iOS app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project and an App Store app",
            text: `[Start free on Cloud](${SIGNUP}) and add an **App Store** app with your bundle ID. Copy its \`appl_\` public key.`,
          },
          {
            name: "Connect Apple",
            text: "Add an In-App Purchase key and paste the notification URL into App Store Connect as a Version 2 server notification URL. See [App Store setup](/stores/app-store).",
          },
          {
            name: "Create your catalog",
            text: "Add your products, an entitlement such as `pro` (the access your app checks) and an offering named `default` (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot SDK and configure it with your key",
            text: "Add the package with Swift Package Manager or CocoaPods, then call `Purchases.configure(withAPIKey:)` once at launch, as in the code below. On Cloud the SDK already points at RevenueDot, so your key is the only setting.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `purchase(package:)` and read `customerInfo.entitlements[\"pro\"]?.isActive`. RevenueDot verifies the purchase with Apple and updates the customer's access.",
          },
          {
            name: "Test with the Test Store, then the sandbox",
            text: "Use a `test_` key in a Debug build to buy with no App Store account. Before release, buy with a sandbox tester. See [the Test Store](/stores/test-store).",
          },
        ],
      },
      {
        h2: "Install the RevenueDot iOS SDK and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `RevenueCat` and calls `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account.",
          "For paywalls, add the `RevenueCatUI` product or the `RevenueDotPurchasesUI` pod. It shows the [paywalls](/features/paywalls) you design in the dashboard.",
          "Self-hosting? Set `Purchases.proxyURL` to your server's HTTPS URL before `configure`, and keep entitlement verification `.disabled`. Your server signs responses with its own key, which the SDK does not trust unless you build it with your public key. See [Trusted Entitlements](/docs/guides/trusted-entitlements).",
        ],
        code: {
          title: "Install, then configure at launch",
          label: "Swift",
          code: `// Swift Package Manager: Xcode > File > Add Package Dependencies
.package(url: "https://github.com/revenuedot/purchases-ios", exact: "5.91.0-revenuedot")
// Products: RevenueCat, plus RevenueCatUI for paywalls

// Or CocoaPods
pod "RevenueDotPurchases", "5.91.0"   // RevenueDotPurchasesUI for paywalls

// At launch, in your App initializer or app delegate
import RevenueCat

Purchases.configure(withAPIKey: "appl_...")`,
        },
      },
      {
        h2: "Check the entitlement, then buy a package",
        label: "Swift",
        code: {
          title: "Check access and buy",
          label: "Swift",
          code: `let customerInfo = try await Purchases.shared.customerInfo()
let isPro = customerInfo.entitlements["pro"]?.isActive == true

let offerings = try await Purchases.shared.offerings()
if let package = offerings.current?.availablePackages.first {
    let result = try await Purchases.shared.purchase(package: package)
    if !result.userCancelled, result.customerInfo.entitlements["pro"]?.isActive == true {
        // Show pro features.
    }
}`,
        },
      },
      {
        h2: "Check these iOS details before you ship",
        label: "Notes",
        bullets: [
          "**Test Store keys** work in Debug builds only. A Release build shows a Wrong API Key alert and stops on purpose. Ship with your `appl_` key.",
          "**Web checkout:** a RevenueCatUI paywall's web checkout button opens Stripe Checkout on your own Stripe account for the current user. See [web to app](/solutions/web-to-app).",
          "**Before you ship:** run a purchase with a sandbox tester and check it on the customer page.",
        ],
      },
      {
        h2: "Switching from RevenueCat? Keep your Swift SDK and change one line",
        label: "Switch",
        paras: [
          "If your app already ships the RevenueCat Swift SDK, you can keep it. Set `Purchases.proxyURL` to RevenueDot before `configure` and turn entitlement verification off. Then call `syncPurchases()` once on the first launch of the update, so current subscribers keep access. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        bullets: [
          "**Verification:** the stock SDK checks responses against RevenueCat's key, so set `.disabled`. Never use `.enforced` with the stock SDK: RevenueDot cannot sign with RevenueCat's key, so every request would fail.",
          "**Keys:** the importer keeps your RevenueCat `appl_` key working, so builds you already shipped keep their key.",
          "**Tested:** the unmodified RevenueCat iOS SDK 5.92 passes configure, offerings, a Test Store purchase and `logIn` against RevenueDot on an iPhone simulator.",
        ],
        code: {
          title: "Point the RevenueCat SDK at RevenueDot",
          label: "Swift",
          code: `import RevenueCat

// Before Purchases.configure
Purchases.proxyURL = URL(string: "https://api.revenuedot.app")!
Purchases.configure(
    with: Configuration.Builder(withAPIKey: "appl_...")
        // Default is .informational, which logs every RevenueDot response as a failed check.
        .with(entitlementVerificationMode: .disabled)
        .build()
)

// Once, on the first launch of this update
_ = try? await Purchases.shared.syncPurchases()`,
        },
      },
    ],
    howTo: "How to add subscriptions to an iOS app with RevenueDot",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot iOS SDK?",
        a: "No. The RevenueDot SDK is built from RevenueCat's open-source Swift SDK under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, copy your app's appl_ key and pass it to Purchases.configure.",
      },
      {
        q: "How do I add in-app subscriptions to an iOS app with StoreKit 2?",
        a: "Install the RevenueDot Swift SDK, configure it with your appl_ key, fetch offerings and call purchase(package:). RevenueDot verifies each StoreKit 2 transaction with Apple, using the In-App Purchase key and notification URL you add to the app.",
      },
      {
        q: "Why does the RevenueDot SDK use import RevenueCat?",
        a: "It keeps the module names of the open-source SDK it is built from, RevenueCat and RevenueCatUI. Only the package changes. The RevenueDot package points at RevenueDot Cloud and trusts RevenueDot's signing key.",
      },
      {
        q: "Does RevenueDot support StoreKit 2?",
        a: "Yes. It verifies signed transactions against Apple's root certificate and, with an In-App Purchase key, reads history and renewal state from the App Store Server API. StoreKit 1 receipts also work once the key is added.",
      },
      {
        q: "How do I test iOS purchases without an App Store account?",
        a: "Create a Test Store app in RevenueDot, pass its test_ key to configure in a Debug build and buy through the SDK's alert. For real sandbox purchases, use a sandbox tester or an Xcode StoreKit file with its test certificate saved on the app.",
      },
      {
        q: "I already ship the RevenueCat iOS SDK. Do I have to replace it?",
        a: "No. Set Purchases.proxyURL to https://api.revenuedot.app before configure, set entitlement verification to disabled and call syncPurchases() once after the update. You can move to the RevenueDot package later without changing your purchase code.",
      },
    ],
    docs: [
      { href: "/docs/sdks/ios", label: "iOS SDK guide" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
      { href: "/docs/guides/app-store", label: "Connect the App Store" },
      { href: "/docs/guides/paywalls", label: "Paywalls" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/add-in-app-purchases", "/stores/app-store", "/stores/test-store", "/features/paywalls", "/solutions/receipt-validation", "/migrate-from-revenuecat"],
  },

  {
    slug: "android",
    section: "sdks",
    name: "Android",
    card: "Add Google Play Billing subscriptions to Android apps with the RevenueDot Kotlin SDK and one Gradle line.",
    label: "SDK",
    title: "Android in-app subscriptions with Google Play Billing and the RevenueDot SDK",
    metaTitle: "Android in-app subscriptions SDK for Google Play Billing",
    metaDescription:
      "Add Android subscriptions with Google Play Billing. Install the RevenueDot Kotlin SDK from Maven Central and pass your app's key. Free until $10K a month.",
    answer:
      "To add Android in-app subscriptions, add `app.revenuedot.purchases:purchases:10.23.3` to Gradle and configure the RevenueDot SDK with your app's `goog_` key in `Application.onCreate()`. RevenueDot reads each purchase from the Google Play Developer API, acknowledges it and keeps each customer's access in sync through real-time developer notifications. RevenueDot Cloud is free until your app makes $10,000 a month.",
    points: [
      { title: "One Gradle line", text: "`app.revenuedot.purchases:purchases:10.23.3` from Maven Central, plus `purchases-ui` for paywalls." },
      { title: "Google Play checked server-side", text: "RevenueDot reads each purchase token from the Play Developer API and acknowledges it." },
      { title: "Test Store first", text: "Buy with a `test_` key in a debug build before you have a Google Play account." },
      { title: "Every request to RevenueDot", text: "The SDK sends purchases, diagnostics, paywall events and ad events to RevenueDot." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to an Android app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project and a Google Play app",
            text: `[Start free on Cloud](${SIGNUP}) and add a **Google Play** app with your package name. Copy its \`goog_\` public key.`,
          },
          {
            name: "Connect Google Play",
            text: "Upload a service account key and add a Pub/Sub push subscription for real-time developer notifications. See [Google Play setup](/stores/google-play).",
          },
          {
            name: "Create your catalog",
            text: "Add products with `store_identifier` as `subscriptionId:basePlanId`, an entitlement such as `pro` (the access your app checks) and a current offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot SDK and configure it with your key",
            text: "Add the Gradle dependency and call `Purchases.configure` in `Application.onCreate()`, as in the code below. On Cloud the SDK already points at RevenueDot, so your key is the only setting.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `awaitPurchase` and read `customerInfo.entitlements[\"pro\"]?.isActive`. RevenueDot checks the purchase token with Google and updates the customer's access.",
          },
          {
            name: "Test with the Test Store or a test track",
            text: "Use a `test_` key in a debug build, or a Play license tester on an internal test track. See [the Test Store](/stores/test-store).",
          },
        ],
      },
      {
        h2: "Install the RevenueDot Android SDK and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `com.revenuecat.purchases` and calls `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account.",
          "Self-hosting? Set `Purchases.proxyURL` to your server before `configure`, and configure with `EntitlementVerificationMode.DISABLED`, because your server signs with its own key. The Android emulator reaches your computer at `http://10.0.2.2:8787`, and plain `http` needs a network security config that allows cleartext traffic to that host. See [Trusted Entitlements](/docs/guides/trusted-entitlements).",
        ],
        code: {
          title: "Install, then configure in Application.onCreate()",
          label: "Gradle and Kotlin",
          code: `// build.gradle.kts
implementation("app.revenuedot.purchases:purchases:10.23.3")
implementation("app.revenuedot.purchases:purchases-ui:10.23.3")   // only for paywalls

// MainApplication.kt
import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.PurchasesConfiguration

class MainApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Purchases.configure(PurchasesConfiguration.Builder(this, "goog_...").build())
    }
}`,
        },
      },
      {
        h2: "Check the entitlement, then buy a package",
        label: "Kotlin",
        code: {
          title: "Check access and buy with the coroutine helpers",
          label: "Kotlin",
          code: `val customerInfo = Purchases.sharedInstance.awaitCustomerInfo()
val isPro = customerInfo.entitlements["pro"]?.isActive == true

val offerings = Purchases.sharedInstance.awaitOfferings()
val pkg = offerings.current?.availablePackages?.firstOrNull() ?: return
try {
    val result = Purchases.sharedInstance.awaitPurchase(PurchaseParams.Builder(activity, pkg).build())
    val nowPro = result.customerInfo.entitlements["pro"]?.isActive == true
} catch (e: PurchasesTransactionException) {
    if (e.userCancelled) return
}`,
        },
      },
      {
        h2: "Check these Android details before you ship",
        label: "Notes",
        bullets: [
          "**Test Store keys** work in debug builds only. A release build shows an error screen and stops on purpose. Ship with your `goog_` key.",
          "**Amazon:** the same SDK runs on Fire devices with `AmazonConfiguration`. See [Amazon Appstore setup](/stores/amazon-appstore).",
          "**Web purchases:** an intent filter for your redemption scheme plus `redeemWebPurchase` gives buyers from a RevenueDot purchase link access in the app.",
          "**Before you ship:** run a purchase with a license tester and check it on the customer page.",
        ],
      },
      {
        h2: "Switching from RevenueCat? Keep your Kotlin SDK and change one line",
        label: "Switch",
        paras: [
          "If your app already ships the RevenueCat Android SDK, you can keep it. Set `Purchases.proxyURL` to RevenueDot before `configure` and turn entitlement verification off. Then call `syncPurchases()` once on the first launch of the update, so current subscribers keep access. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        bullets: [
          "**Verification:** set `DISABLED`. The default, `INFORMATIONAL`, logs every RevenueDot response as a failed signature check. Never use `ENFORCED` with the stock SDK: every request would fail.",
          "**Diagnostics:** the stock SDK still sends diagnostics, paywall events and ad events to RevenueCat's hosts. The RevenueDot SDK sends them to RevenueDot.",
          "**Purchase tokens:** `syncPurchases()` also gives RevenueDot any Google purchase token the importer could not find.",
          "**Tested:** the unmodified RevenueCat Android SDK 10.24.0 passes a Test Store purchase against RevenueDot on an Android 15 emulator.",
        ],
        code: {
          title: "Point the RevenueCat SDK at RevenueDot",
          label: "Kotlin",
          code: `// Before Purchases.configure
Purchases.proxyURL = URL("https://api.revenuedot.app")
Purchases.configure(
    PurchasesConfiguration.Builder(this, "goog_...")
        // Default is INFORMATIONAL, which logs every response as a failed signature check.
        .entitlementVerificationMode(EntitlementVerificationMode.DISABLED)
        .build()
)

// Once, on the first launch of this update
Purchases.sharedInstance.syncPurchases()`,
        },
      },
    ],
    howTo: "How to add subscriptions to an Android app with RevenueDot",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot Android SDK?",
        a: "No. The RevenueDot SDK is built from RevenueCat's open-source Android SDK under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, copy your app's goog_ key and pass it to Purchases.configure.",
      },
      {
        q: "How do I add in-app subscriptions to an Android app with Google Play Billing?",
        a: "Add app.revenuedot.purchases:purchases to Gradle, configure it with your goog_ key, fetch offerings and call awaitPurchase. RevenueDot checks each purchase token with the Google Play Developer API, using the service account and Pub/Sub push subscription you add to the app.",
      },
      {
        q: "Do I need to acknowledge Google Play purchases myself?",
        a: "No. RevenueDot acknowledges each purchase after reading it from the Play Developer API, because Google refunds purchases left unacknowledged for 3 days.",
      },
      {
        q: "How do Google Play base plans map to RevenueDot products?",
        a: "Set the product's store_identifier to subscriptionId:basePlanId, for example pro:monthly. Use the product ID for one-time products.",
      },
      {
        q: "How do I test Android purchases without Play Console?",
        a: "Create a Test Store app, use its test_ key in a debug build and tap the successful purchase in the SDK's dialog. For real Google test purchases, add license testers and use an internal test track.",
      },
      {
        q: "I already ship the RevenueCat Android SDK. What changes?",
        a: "Set Purchases.proxyURL before configure, set verification to DISABLED and call syncPurchases() once after the update. Purchases, customer info and offerings then go to RevenueDot. The stock SDK still sends diagnostics to RevenueCat, and the RevenueDot SDK does not.",
      },
    ],
    docs: [
      { href: "/docs/sdks/android", label: "Android SDK guide" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
      { href: "/docs/guides/google-play", label: "Connect Google Play" },
      { href: "/docs/guides/paywalls", label: "Paywalls" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/add-in-app-purchases", "/stores/google-play", "/stores/amazon-appstore", "/stores/test-store", "/sdks/kotlin-multiplatform", "/migrate-from-revenuecat"],
  },

  {
    slug: "react-native",
    section: "sdks",
    name: "React Native and Expo",
    card: "Add subscriptions to React Native and Expo apps with the RevenueDot SDK. Expo Go buys with a Test Store key.",
    label: "SDK",
    title: "Expo and React Native in-app purchases with the RevenueDot SDK",
    metaTitle: "Expo and React Native in-app purchases and subscriptions",
    metaDescription:
      "Add Expo and React Native in-app purchases with the RevenueDot SDK. Install it from npm, pass your app's key and test in Expo Go. Free until $10K a month.",
    answer:
      "To add in-app purchases to a React Native or Expo app, install the RevenueDot SDK from npm under the name `react-native-purchases` and call `Purchases.configure` with your app's `appl_` or `goog_` key. RevenueDot checks each purchase with the App Store or Google Play and keeps each customer's access in sync. Expo Go and the web buy with a Test Store key. Cloud is free until $10,000 a month.",
    points: [
      { title: "One npm install", text: "An npm alias installs `@revenuedot/react-native-purchases` 10.10.2 as `react-native-purchases`." },
      { title: "Expo Go and web", text: "A `test_` key buys in Expo Go and on the web, with no store account." },
      { title: "Tested from npm", text: "Installed into the Expo example and run on the web, it loads offerings, buys through the Test Store and turns `pro` active." },
      { title: "Paywalls", text: "RevenueDot's `react-native-purchases-ui` shows paywalls you design in the dashboard." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to a React Native app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}). Add a **Test Store** app and copy its \`test_\` key. Add an App Store app and a Google Play app when you are ready to sell.`,
          },
          {
            name: "Connect the stores",
            text: "Add the App Store In-App Purchase key and the Google Play service account. See [App Store](/stores/app-store) and [Google Play](/stores/google-play).",
          },
          {
            name: "Create your catalog",
            text: "Add products, an entitlement such as `pro` (the access your app checks) and a current offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot SDK and configure it with your key",
            text: "Run the npm install below, then call `Purchases.configure` at app start with the `appl_` or `goog_` key for the platform. On Cloud the SDK already points at RevenueDot, so your key is the only setting.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `Purchases.purchasePackage(pkg)` and read `customerInfo.entitlements.active[\"pro\"]`.",
          },
          {
            name: "Test in Expo Go or on the web",
            text: "Use the `test_` key and tap **Test valid purchase** in the dialog. See [the Test Store](/stores/test-store).",
          },
        ],
      },
      {
        h2: "Install the RevenueDot React Native SDK and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license). The npm alias installs it under the name `react-native-purchases`, so your code imports that package and calls `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account.",
          "For real App Store and Google Play purchases, build a development build or a production app, as with any native purchase library. Expo Go and the web run the SDK in browser mode with a `test_` key.",
          "Self-hosting? Call `await Purchases.setProxyURL(...)` with your server's URL before `configure`, and leave entitlement verification at its default, `DISABLED`, because your server signs with its own key. See [Trusted Entitlements](/docs/guides/trusted-entitlements).",
        ],
        code: {
          title: "Install, then configure at app start",
          label: "Terminal and TypeScript",
          code: `npm install react-native-purchases@npm:@revenuedot/react-native-purchases@10.10.2
# Paywalls, optional
npm install react-native-purchases-ui@npm:@revenuedot/react-native-purchases-ui@10.10.2

// App start
import { Platform } from "react-native";
import Purchases from "react-native-purchases";

Purchases.configure({ apiKey: Platform.OS === "ios" ? "appl_..." : "goog_..." });`,
        },
      },
      {
        h2: "Check the entitlement, then buy a package",
        label: "TypeScript",
        code: {
          title: "Check access and buy",
          label: "TypeScript",
          code: `const customerInfo = await Purchases.getCustomerInfo();
const isPro = customerInfo.entitlements.active["pro"] !== undefined;

const offerings = await Purchases.getOfferings();
const pkg = offerings.current?.availablePackages[0];
if (pkg) {
  try {
    const { customerInfo: after } = await Purchases.purchasePackage(pkg);
    const nowPro = after.entitlements.active["pro"] !== undefined;
  } catch (e: any) {
    if (!e.userCancelled) throw e;
  }
}`,
        },
      },
      {
        h2: "Check these React Native and Expo details before you ship",
        label: "Notes",
        bullets: [
          "**Expo Go and web:** the SDK runs in browser mode and accepts `test_` and `rcb_` keys. RevenueDot accepts `test_` only today.",
          "**Native builds** accept `test_` keys in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Status:** the [Expo example](https://github.com/revenuedot/examples/tree/main/mobile/react-native-expo) ran on the web against RevenueDot. Native builds of it are not verified yet.",
        ],
      },
      {
        h2: "Switching from RevenueCat? Keep react-native-purchases and change one line",
        label: "Switch",
        paras: [
          "If your app already ships RevenueCat's `react-native-purchases`, you can keep it. Await `Purchases.setProxyURL` before `configure`. Entitlement verification is already `DISABLED` by default in this SDK, which is what RevenueDot needs. Then call `Purchases.syncPurchasesForResult()` once on the first launch of the update, so current subscribers keep access. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        bullets: [
          "**Await it:** `setProxyURL` returns a promise, so await it before `configure`.",
          "**Verification:** remove any `INFORMATIONAL` or `ENFORCED` setting. `ENFORCED` would fail every request, because RevenueDot cannot sign with RevenueCat's key.",
          "**Keys:** the importer keeps your RevenueCat `appl_` and `goog_` keys working, so builds you already shipped keep their keys.",
        ],
        code: {
          title: "Point the RevenueCat SDK at RevenueDot",
          label: "TypeScript",
          code: `import { Platform } from "react-native";
import Purchases from "react-native-purchases";

await Purchases.setProxyURL("https://api.revenuedot.app");
Purchases.configure({
  apiKey: Platform.OS === "ios" ? "appl_..." : "goog_...",
  // Leave entitlementVerificationMode unset: DISABLED is the React Native default.
});

// Once, on the first launch of this update
await Purchases.syncPurchasesForResult();`,
        },
      },
    ],
    howTo: "How to add subscriptions to a React Native app with RevenueDot",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot React Native SDK?",
        a: "No. The RevenueDot SDK is built from RevenueCat's open-source React Native SDK under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, copy your app's keys and pass them to Purchases.configure.",
      },
      {
        q: "How do I add in-app purchases to a React Native app?",
        a: "Install the RevenueDot SDK from npm under the name react-native-purchases, configure it with your appl_ or goog_ key, then call getOfferings and purchasePackage. RevenueDot checks each purchase with the store and keeps the customer's entitlements in sync.",
      },
      {
        q: "Does the RevenueDot SDK work with Expo?",
        a: "Yes. Expo Go and the web run the SDK in browser mode with a test_ key. For real store purchases you build a development or production app, as with any native purchase library, and use your appl_ and goog_ keys.",
      },
      {
        q: "Can I test React Native purchases without Apple or Google accounts?",
        a: "Yes. Create a Test Store app and use its test_ key. In Expo Go or on the web, tap a package and choose Test valid purchase.",
      },
      {
        q: "Why does the install line say react-native-purchases?",
        a: "The npm alias installs @revenuedot/react-native-purchases under the name react-native-purchases. Your code imports Purchases from react-native-purchases, and the native builds come from RevenueDot's packages on CocoaPods and Maven Central.",
      },
      {
        q: "I already use RevenueCat's react-native-purchases. What changes?",
        a: "Await Purchases.setProxyURL(\"https://api.revenuedot.app\") before configure and call syncPurchasesForResult once after the update. Verification is already DISABLED by default, which is what RevenueDot needs.",
      },
    ],
    docs: [
      { href: "/docs/sdks/react-native", label: "React Native and Expo guide" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
      { href: "/docs/guides/test-store", label: "Test Store" },
      { href: "/docs/guides/paywalls", label: "Paywalls" },
      { href: "/docs/sdks/hybrid-common", label: "Hybrid common" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/add-in-app-purchases", "/sdks/flutter", "/stores/test-store", "/solutions/ai-built-apps", "/features/paywalls", "/migrate-from-revenuecat"],
  },

  {
    slug: "flutter",
    section: "sdks",
    name: "Flutter",
    card: "Add Flutter in-app purchases and subscriptions on iOS, Android and web with the RevenueDot SDK.",
    label: "SDK",
    title: "Flutter in-app purchases and subscriptions with the RevenueDot SDK",
    metaTitle: "Flutter in-app purchases and subscriptions SDK",
    metaDescription:
      "Add Flutter in-app purchases with the RevenueDot SDK. Add purchases_flutter from git, pass your app's key and buy on iOS, Android and web. Free until $10K.",
    answer:
      "To add in-app purchases to a Flutter app, add the RevenueDot SDK to `pubspec.yaml` as `purchases_flutter` from the git tag `10.13.2-revenuedot`, then call `Purchases.configure` with your app's `appl_` or `goog_` key. RevenueDot checks each purchase with the App Store or Google Play and keeps each customer's access in sync. It runs on iOS, Android and Flutter web. Cloud is free until $10,000 a month.",
    points: [
      { title: "From git", text: "pub.dev names belong to RevenueCat, so `purchases_flutter` installs from the tag `10.13.2-revenuedot`. Imports stay `package:purchases_flutter`." },
      { title: "iOS, Android and web", text: "One Dart API covers all three. On Flutter web, Test Store keys buy today." },
      { title: "Tested on this tag", text: "A Flutter web build bought a Test Store subscription, and the server showed `pro` active." },
      { title: "Paywalls", text: "`purchases_ui_flutter` from the same tag shows paywalls you design in the dashboard." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to a Flutter app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}) and add a **Test Store** app for a first test. Add an App Store app and a Google Play app when you are ready to sell.`,
          },
          {
            name: "Connect the stores and create the catalog",
            text: "Add your store credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, an entitlement such as `pro` (the access your app checks) and a current offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot SDK and configure it with your key",
            text: "Add `purchases_flutter` from git to `pubspec.yaml`, run `flutter pub get`, then call `Purchases.configure` with the `appl_` or `goog_` key, as in the code below. On Cloud the SDK already points at RevenueDot, so your key is the only setting.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `Purchases.purchase(PurchaseParams.package(package))` and check `customerInfo.entitlements.active.containsKey('pro')`.",
          },
          {
            name: "Test with a Test Store key",
            text: "Use a `test_` key in a debug build and tap **Test valid purchase** in the dialog. See [the Test Store](/stores/test-store).",
          },
        ],
      },
      {
        h2: "Install the RevenueDot Flutter SDK and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `package:purchases_flutter` and calls `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account.",
          "Its iOS and Android builds pull RevenueDot's native packages from CocoaPods and Maven Central. Its web bundle is built from RevenueDot's purchases-js 1.67.0.",
          "Self-hosting? Await `Purchases.setProxyURL(...)` with your server's URL before `configure`, and leave entitlement verification at its default, `disabled`, because your server signs with its own key. See [Trusted Entitlements](/docs/guides/trusted-entitlements).",
        ],
        code: {
          title: "Install, then configure at app start",
          label: "YAML and Dart",
          code: `# pubspec.yaml
dependencies:
  purchases_flutter:
    git:
      url: https://github.com/revenuedot/purchases-flutter.git
      ref: 10.13.2-revenuedot
  purchases_ui_flutter:   # only for paywalls
    git:
      url: https://github.com/revenuedot/purchases-flutter.git
      path: purchases_ui_flutter
      ref: 10.13.2-revenuedot

// lib/main.dart
import 'dart:io' show Platform;
import 'package:purchases_flutter/purchases_flutter.dart';

Future<void> initPurchases() async {
  await Purchases.configure(PurchasesConfiguration(Platform.isIOS ? 'appl_...' : 'goog_...'));
}`,
        },
      },
      {
        h2: "Check the entitlement, then buy a package",
        label: "Dart",
        code: {
          title: "Check access and buy",
          label: "Dart",
          code: `final customerInfo = await Purchases.getCustomerInfo();
final isPro = customerInfo.entitlements.active.containsKey('pro');

final offerings = await Purchases.getOfferings();
final package = offerings.current?.availablePackages.first;
if (package != null) {
  try {
    final result = await Purchases.purchase(PurchaseParams.package(package));
    final nowPro = result.customerInfo.entitlements.active.containsKey('pro');
  } on PlatformException catch (e) {
    if (PurchasesErrorHelper.getErrorCode(e) != PurchasesErrorCode.purchaseCancelledError) rethrow;
  }
}`,
        },
        paras: ["`Purchases.purchasePackage` still works but is deprecated in 10.x."],
      },
      {
        h2: "Check these Flutter details before you ship",
        label: "Notes",
        bullets: [
          "**Test Store keys** work in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Flutter web** buys with Test Store keys today. For real web payments, use a RevenueDot purchase link with Stripe Checkout. See [web to app](/solutions/web-to-app).",
          "**Status:** the [Flutter example](https://github.com/revenuedot/examples/tree/main/mobile/flutter) bought a Test Store subscription on Flutter web, and its iOS simulator builds succeed. It has not run on a device yet.",
        ],
      },
      {
        h2: "Switching from RevenueCat? Keep purchases_flutter and change one line",
        label: "Switch",
        paras: [
          "If your app already ships RevenueCat's `purchases_flutter` from pub.dev, you can keep it on iOS and Android. Await `Purchases.setProxyURL` before `configure`. Verification is already `disabled` by default. Then call `Purchases.syncPurchases()` once on the first launch of the update, so current subscribers keep access. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        bullets: [
          "**Flutter web:** the stock package's web plugin ignores `setProxyURL`, so web calls would still go to RevenueCat. Move to the RevenueDot SDK for web.",
          "**Keys:** the importer keeps your RevenueCat `appl_` and `goog_` keys working, so builds you already shipped keep their keys.",
        ],
        code: {
          title: "Point the RevenueCat SDK at RevenueDot",
          label: "Dart",
          code: `import 'dart:io' show Platform;
import 'package:purchases_flutter/purchases_flutter.dart';

Future<void> initPurchases() async {
  await Purchases.setProxyURL("https://api.revenuedot.app");
  await Purchases.configure(
    PurchasesConfiguration(Platform.isIOS ? 'appl_...' : 'goog_...'),
    // entitlementVerificationMode stays at its default, disabled.
  );
  // Once, on the first launch of this update
  await Purchases.syncPurchases();
}`,
        },
      },
    ],
    howTo: "How to add subscriptions to a Flutter app with RevenueDot",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot Flutter SDK?",
        a: "No. The RevenueDot SDK is built from RevenueCat's open-source Flutter SDK under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, copy your app's keys and pass them to Purchases.configure.",
      },
      {
        q: "How do I add in-app purchases to a Flutter app?",
        a: "Add purchases_flutter from the RevenueDot git tag, configure it with your appl_ or goog_ key, fetch offerings and call Purchases.purchase. RevenueDot checks each purchase with the App Store or Google Play and keeps the customer's entitlements in sync.",
      },
      {
        q: "Why does the RevenueDot Flutter SDK install from git instead of pub.dev?",
        a: "The pub.dev names purchases_flutter and purchases_ui_flutter belong to RevenueCat. RevenueDot ships the same package names from git tags such as 10.13.2-revenuedot, so your Dart imports stay the same.",
      },
      {
        q: "Does RevenueDot work with Flutter web?",
        a: "Yes, with the RevenueDot SDK. Its web bundle is built from RevenueDot's purchases-js, and Test Store keys buy there today. For real web payments, use a RevenueDot purchase link with Stripe Checkout. RevenueCat's stock package ignores the proxy URL on web.",
      },
      {
        q: "How do I test Flutter purchases without store accounts?",
        a: "Create a Test Store app, use its test_ key in a debug build and tap Test valid purchase. Test purchases are always sandbox data.",
      },
      {
        q: "I already ship RevenueCat's purchases_flutter. What changes?",
        a: "On iOS and Android, await Purchases.setProxyURL(\"https://api.revenuedot.app\") before configure and call syncPurchases once after the update. Verification is already disabled by default. For Flutter web, move to the RevenueDot SDK.",
      },
    ],
    docs: [
      { href: "/docs/sdks/flutter", label: "Flutter guide" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
      { href: "/docs/guides/test-store", label: "Test Store" },
      { href: "/docs/sdks/hybrid-common", label: "Hybrid common" },
      { href: "/docs/migrate/sdk-changes", label: "SDK changes when you migrate" },
    ],
    related: ["/add-in-app-purchases", "/sdks/react-native", "/stores/test-store", "/stores/app-store", "/stores/google-play", "/migrate-from-revenuecat"],
  },

  {
    slug: "web",
    section: "sdks",
    name: "Web (purchases-js)",
    card: "The RevenueDot web SDK for Test Store purchases, plus real web payments on Stripe Checkout in your own account.",
    label: "SDK",
    title: "Web subscriptions with the RevenueDot web SDK and Stripe Checkout",
    metaTitle: "Web subscriptions SDK with Test Store and Stripe Checkout",
    metaDescription:
      "Add web subscriptions with the RevenueDot web SDK, @revenuedot/purchases-js. Test purchases work today. Real payments run on Stripe Checkout in your account.",
    answer:
      "To add web subscriptions, install `@revenuedot/purchases-js` and call `Purchases.configure` with your app's key and the signed-in user's ID. Today only Test Store (`test_`) keys buy through the web SDK. For real web payments, send buyers to a RevenueDot purchase link or funnel, which runs Stripe Checkout in your own Stripe account. Web buyers and app users share access through the same app user ID.",
    shot: {
      src: "web/web.png",
      alt: "The Web page in the RevenueDot dashboard showing the Stripe provider and the four-step setup checklist for web billing",
    },
    points: [
      { title: "One npm package", text: "`@revenuedot/purchases-js` 1.67.0, imported as `{ Purchases }`." },
      { title: "Tested end to end", text: "The web SDK ran configure, offerings, a Test Store purchase and the `pro` entitlement against a real server." },
      { title: "Real payments on Stripe", text: "Purchase links and funnels charge on your own Stripe account." },
      { title: "One customer", text: "A web buyer and an app user share entitlements through the same app user ID." },
    ],
    blocks: [
      {
        h2: "How to add web subscriptions with the RevenueDot web SDK",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project and a Test Store app",
            text: `[Start free on Cloud](${SIGNUP}), add a **Test Store** app and copy its \`test_\` key.`,
          },
          {
            name: "Create products and an offering",
            text: "Add a product with a duration and a Test Store price, an entitlement such as `pro` (the access your app checks) and a current offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot web SDK and configure it with your key",
            text: "Run `npm install @revenuedot/purchases-js@1.67.0`, then call `Purchases.configure` with your `test_` key and the user's ID, as in the code below. On Cloud the SDK already points at RevenueDot, so there is nothing else to set.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `purchases.purchase({ rcPackage })`. With a `test_` key it opens the Test Store modal. Read `customerInfo.entitlements.active`.",
          },
          {
            name: "Take real payments with a purchase link",
            text: "Connect Stripe, create web products and send buyers to a purchase link with `?app_user_id=` set to the same user ID. See [web to app](/solutions/web-to-app).",
          },
        ],
      },
      {
        h2: "Install the RevenueDot web SDK and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot web SDK is built from RevenueCat's open-source purchases-js (MIT license), so your code calls `Purchases` the same way. It sends every request, including analytics events, to RevenueDot and needs no RevenueCat account.",
          "The SDK needs an `appUserId`. Pass your signed-in user's ID, or one from `Purchases.generateRevenueCatAnonymousAppUserId()`.",
          "Self-hosting? Pass `httpConfig: { proxyURL }` with your server's URL to `configure`. The URL must not end with a slash. purchases-js does not check response signatures, so there is no verification setting to change.",
        ],
        code: {
          title: "Install, then configure",
          label: "Terminal and TypeScript",
          code: `npm install @revenuedot/purchases-js@1.67.0

// app.ts
import { Purchases } from "@revenuedot/purchases-js";

const purchases = Purchases.configure({ apiKey: "test_...", appUserId });`,
        },
      },
      {
        h2: "Check the entitlement, then make a test purchase",
        label: "TypeScript",
        code: {
          title: "Check access and buy",
          label: "TypeScript",
          code: `const customerInfo = await purchases.getCustomerInfo();
const isPro = "pro" in customerInfo.entitlements.active;

const offerings = await purchases.getOfferings();
const rcPackage = offerings.current?.availablePackages[0];
if (rcPackage) {
  const { customerInfo: after } = await purchases.purchase({ rcPackage });
  const nowPro = "pro" in after.entitlements.active;
}`,
        },
      },
      {
        h2: "Test Store and Stripe purchases work on the web today",
        label: "Honest limits",
        table: {
          head: ["Purchase type", "Works with RevenueDot", "How"],
          rows: [
            ["Test Store (`test_` key)", "Yes", "purchases-js opens a Test Store modal"],
            ["Stripe on your own account", "Yes", "RevenueDot purchase link or funnel, or your own checkout posted to the receipts endpoint"],
            ["RevenueCat Web Billing (`rcb_`)", "No", "RevenueDot answers error 7662. Keep those subscriptions on RevenueCat"],
            ["Paddle (`pdl_`)", "No", "purchases-js cannot open a Paddle checkout against RevenueDot. Post Paddle purchases from your backend instead"],
          ],
          caption: "Run a Stripe test-mode purchase before you go live.",
        },
      },
      {
        h2: "Switching from RevenueCat? Keep purchases-js and change one line",
        label: "Switch",
        paras: [
          "If your site already uses RevenueCat's `@revenuecat/purchases-js`, you can keep it. Pass `httpConfig.proxyURL` to `configure`, use your RevenueDot `test_` key and turn off analytics events. There is no store history to sync on the web, so there is no `syncPurchases` step. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        bullets: [
          "**Analytics:** the stock SDK sends analytics events to RevenueCat even with a proxy URL, so set `collectAnalyticsEvents: false`. The RevenueDot web SDK sends them to RevenueDot, so you can leave it on there.",
          "**Same imports:** install the RevenueDot web SDK under the old name with `\"@revenuecat/purchases-js\": \"npm:@revenuedot/purchases-js@1.67.0\"` in `package.json`.",
          "**Web Billing:** subscriptions sold through RevenueCat Web Billing stay on RevenueCat. New web sales can start on RevenueDot's Stripe checkout.",
        ],
        code: {
          title: "Point RevenueCat's purchases-js at RevenueDot",
          label: "TypeScript",
          code: `import { Purchases } from "@revenuecat/purchases-js";

const purchases = Purchases.configure({
  apiKey: "test_...",
  appUserId,
  httpConfig: { proxyURL: "https://api.revenuedot.app" },   // no trailing slash
  flags: { collectAnalyticsEvents: false },
});`,
        },
      },
    ],
    howTo: "How to add web subscriptions with the RevenueDot web SDK",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot web SDK?",
        a: "No. The RevenueDot web SDK is built from RevenueCat's open-source purchases-js under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, add a Test Store app and pass its test_ key to Purchases.configure.",
      },
      {
        q: "Can I take real payments through purchases-js with RevenueDot?",
        a: "Not yet. Only Test Store test_ keys buy through purchases-js against RevenueDot today. Real web payments run on RevenueDot's purchase links and funnels, which use Stripe Checkout in your own Stripe account.",
      },
      {
        q: "How do I take real subscription payments on the web with RevenueDot?",
        a: "Connect your Stripe account with a restricted key, create web products, put them in an offering and share a purchase link or publish a funnel. Buyers pay on Stripe Checkout, and the purchase lands on their app user ID or a redemption link.",
      },
      {
        q: "Can a web buyer use the mobile app too?",
        a: "Yes. Entitlements belong to the customer, not to one app. Send buyers to a purchase link with app_user_id set to the same ID your app uses, and getCustomerInfo shows the entitlement in the app.",
      },
      {
        q: "Does RevenueDot support RevenueCat Web Billing keys?",
        a: "No. Receipts for rcb_ and pdl_ keys answer error 7662. Subscriptions you sell through RevenueCat Web Billing stay on RevenueCat, and new web sales can start on RevenueDot's Stripe checkout.",
      },
    ],
    docs: [
      { href: "/docs/sdks/web", label: "Web SDK guide" },
      { href: "/docs/guides/web-billing", label: "Sell on the web with Stripe" },
      { href: "/docs/guides/purchase-links", label: "Purchase links" },
      { href: "/docs/guides/test-store", label: "Test Store" },
    ],
    related: ["/add-in-app-purchases", "/solutions/web-to-app", "/stores/stripe", "/features/purchase-links", "/stores/test-store", "/migrate-from-revenuecat"],
  },

  {
    slug: "capacitor",
    section: "sdks",
    name: "Capacitor and Ionic",
    card: "Add in-app purchases to Capacitor and Ionic apps on iOS and Android with the RevenueDot plugin.",
    label: "SDK",
    title: "Capacitor and Ionic in-app purchases with the RevenueDot plugin",
    metaTitle: "Capacitor and Ionic in-app purchases and subscriptions",
    metaDescription:
      "Add in-app purchases to a Capacitor or Ionic app. Install the RevenueDot plugin from npm, pass your app's key and buy on iOS and Android. Free until $10K.",
    answer:
      "To add in-app purchases to a Capacitor or Ionic app, install the RevenueDot plugin from npm under the name `@revenuecat/purchases-capacitor`, run `npx cap sync` and call `Purchases.configure` with your app's `appl_` or `goog_` key. RevenueDot checks each purchase with the App Store or Google Play and keeps each customer's access in sync. RevenueDot Cloud is free until your app makes $10,000 a month.",
    points: [
      { title: "One npm install", text: "An npm alias installs `@revenuedot/purchases-capacitor` 13.6.1, so Capacitor's native names stay the same." },
      { title: "iOS and Android", text: "One TypeScript API covers both native platforms. The plugin has no web implementation." },
      { title: "Build checked", text: "Installed from npm, it builds into a Capacitor 8 iOS app that carries `api.revenuedot.app` and no RevenueCat host." },
      { title: "Test Store first", text: "Buy with a `test_` key in a debug build before you have App Store or Google Play accounts." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to a Capacitor app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}) and add an App Store app and a Google Play app, or a **Test Store** app for a first run.`,
          },
          {
            name: "Connect the stores and create the catalog",
            text: "Add credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, an entitlement such as `pro` (the access your app checks) and a current offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot plugin and configure it with your key",
            text: "Install the plugin through the npm alias below, run `npx cap sync`, then call `Purchases.configure` with the `appl_` or `goog_` key. On Cloud the plugin already points at RevenueDot, so your key is the only setting.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `Purchases.purchasePackage({ aPackage })` and read `customerInfo.entitlements.active[\"pro\"]`.",
          },
          {
            name: "Test with a Test Store key",
            text: "Use a `test_` key in a debug build to buy with no store account. See [the Test Store](/stores/test-store).",
          },
        ],
      },
      {
        h2: "Install the RevenueDot Capacitor plugin and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot plugin is built from RevenueCat's open-source plugin (MIT license). The alias installs it under the name `@revenuecat/purchases-capacitor`, because Capacitor derives native pod and Swift package names from the npm name. Your code calls `Purchases`, every request goes to RevenueDot, and you need no RevenueCat account.",
          "For paywalls, add `@revenuecat/purchases-capacitor-ui@npm:@revenuedot/purchases-capacitor-ui@13.6.1` the same way.",
          "Self-hosting? Await `Purchases.setProxyURL({ url })` with your server's URL before `configure`, and pass `entitlementVerificationMode: ENTITLEMENT_VERIFICATION_MODE.DISABLED`, because your server signs with its own key. See [Trusted Entitlements](/docs/guides/trusted-entitlements).",
        ],
        code: {
          title: "Install, then configure at app start",
          label: "Terminal and TypeScript",
          code: `npm install @revenuecat/purchases-capacitor@npm:@revenuedot/purchases-capacitor@13.6.1
npx cap sync

// App start
import { Capacitor } from "@capacitor/core";
import { Purchases } from "@revenuecat/purchases-capacitor";

await Purchases.configure({ apiKey: Capacitor.getPlatform() === "ios" ? "appl_..." : "goog_..." });`,
        },
      },
      {
        h2: "Check the entitlement, then buy a package",
        label: "TypeScript",
        code: {
          title: "Check access and buy",
          label: "TypeScript",
          code: `const { customerInfo } = await Purchases.getCustomerInfo();
const isPro = customerInfo.entitlements.active["pro"] !== undefined;

const offerings = await Purchases.getOfferings();
const aPackage = offerings.current?.availablePackages[0];
if (aPackage) {
  const result = await Purchases.purchasePackage({ aPackage });
  const nowPro = result.customerInfo.entitlements.active["pro"] !== undefined;
}`,
        },
        paras: ["`getCustomerInfo` resolves to `{ customerInfo }`, and `purchasePackage` takes `{ aPackage }`."],
      },
      {
        h2: "Check these Capacitor details before you ship",
        label: "Notes",
        bullets: [
          "**Test Store keys** work in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Install through the alias only:** a direct install of `@revenuedot/purchases-capacitor` would change the generated native names and is not supported.",
          "**Status:** there is no Capacitor example app yet. The [React Native example](https://github.com/revenuedot/examples/tree/main/mobile/react-native-expo) shows the same calls in JavaScript.",
        ],
      },
      {
        h2: "Switching from RevenueCat? Keep the Capacitor plugin and change one line",
        label: "Switch",
        paras: [
          "If your app already ships RevenueCat's `@revenuecat/purchases-capacitor`, you can keep it. Await `Purchases.setProxyURL({ url })` before `configure`, and pass verification `DISABLED`. Then call `Purchases.syncPurchases()` once on the first launch of the update, so current subscribers keep access. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        bullets: [
          "**Object argument:** `setProxyURL` takes `{ url }`, not a plain string.",
          "**Verification:** the plugin passes no default, so the native informational mode would log every RevenueDot response as a failed check. Pass `DISABLED`. Never use `ENFORCED`: every request would fail.",
          "**Keys:** the importer keeps your RevenueCat `appl_` and `goog_` keys working, so builds you already shipped keep their keys.",
        ],
        code: {
          title: "Point the RevenueCat plugin at RevenueDot",
          label: "TypeScript",
          code: `import { Capacitor } from "@capacitor/core";
import { ENTITLEMENT_VERIFICATION_MODE, Purchases } from "@revenuecat/purchases-capacitor";

await Purchases.setProxyURL({ url: "https://api.revenuedot.app" });
await Purchases.configure({
  apiKey: Capacitor.getPlatform() === "ios" ? "appl_..." : "goog_...",
  entitlementVerificationMode: ENTITLEMENT_VERIFICATION_MODE.DISABLED,
});

// Once, on the first launch of this update
await Purchases.syncPurchases();`,
        },
      },
    ],
    howTo: "How to add subscriptions to a Capacitor app with RevenueDot",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot Capacitor plugin?",
        a: "No. The RevenueDot plugin is built from RevenueCat's open-source Capacitor plugin under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, copy your app's keys and pass them to Purchases.configure.",
      },
      {
        q: "How do I add in-app purchases to a Capacitor or Ionic app?",
        a: "Install the RevenueDot plugin through the npm alias, run npx cap sync, configure it with your appl_ or goog_ key, fetch offerings and call purchasePackage. RevenueDot checks each purchase with the store and keeps the customer's entitlements in sync.",
      },
      {
        q: "Why does the install use the name @revenuecat/purchases-capacitor?",
        a: "Capacitor derives native pod and Swift package names from the npm package name. The alias installs @revenuedot/purchases-capacitor under the original name, so those native names stay the same. A direct install is not supported.",
      },
      {
        q: "Does the Capacitor plugin work on the web?",
        a: "No. The plugin has no web implementation, like the open-source plugin it is built from. For web sales, use the RevenueDot web SDK or a purchase link with Stripe Checkout.",
      },
      {
        q: "I already ship RevenueCat's Capacitor plugin. What changes?",
        a: "Await Purchases.setProxyURL({ url: \"https://api.revenuedot.app\" }) before configure, pass entitlementVerificationMode DISABLED and call syncPurchases once after the update. The plugin passes no verification default, so without DISABLED every response is logged as a failed check.",
      },
    ],
    docs: [
      { href: "/docs/sdks/capacitor", label: "Capacitor and Ionic guide" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
      { href: "/docs/guides/test-store", label: "Test Store" },
      { href: "/docs/sdks/hybrid-common", label: "Hybrid common" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/add-in-app-purchases", "/sdks/cordova", "/sdks/react-native", "/stores/test-store", "/stores/app-store", "/migrate-from-revenuecat"],
  },

  {
    slug: "cordova",
    section: "sdks",
    name: "Cordova",
    card: "Add in-app purchases to Cordova apps on iOS and Android with the RevenueDot plugin.",
    label: "SDK",
    title: "Cordova in-app purchases and subscriptions with the RevenueDot plugin",
    metaTitle: "Cordova in-app purchases and subscriptions plugin",
    metaDescription:
      "Add in-app purchases to Cordova apps. Install the RevenueDot plugin, call Purchases.configureWith with your app's key and buy on iOS and Android. Free on Cloud.",
    answer:
      "To add in-app purchases to a Cordova app, run `cordova plugin add @revenuedot/cordova-plugin-purchases` and call `Purchases.configureWith` with your app's `appl_` or `goog_` key on `deviceready`. RevenueDot checks each purchase with the App Store or Google Play and keeps each customer's access in sync. The plugin id and the global `Purchases` match the open-source plugin it is built from. Cloud is free until $10,000 a month.",
    points: [
      { title: "One plugin", text: "`@revenuedot/cordova-plugin-purchases` 8.2.3 is on npm, with its native dependencies on CocoaPods and Maven Central." },
      { title: "Clean signature checks on Cloud", text: "The plugin trusts RevenueDot's signing key, so RevenueDot Cloud's responses verify." },
      { title: "Familiar names", text: "The plugin id is `cordova-plugin-purchases` and your code calls the global `Purchases`." },
      { title: "Test Store first", text: "Buy with a `test_` key in a debug build before you have App Store or Google Play accounts." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to a Cordova app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}) and add an App Store app and a Google Play app, or a **Test Store** app for a first run.`,
          },
          {
            name: "Connect the stores and create the catalog",
            text: "Add credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, an entitlement such as `pro` (the access your app checks) and a current offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot plugin and configure it with your key",
            text: "Run `cordova plugin add`, then call `Purchases.configureWith` inside the `deviceready` handler, as in the code below. On Cloud the plugin already points at RevenueDot, so your key is the only setting.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `Purchases.purchasePackage` with callbacks and read `customerInfo.entitlements.active[\"pro\"]`.",
          },
          {
            name: "Test with a Test Store key",
            text: "Use a `test_` key in a debug build to buy with no store account. See [the Test Store](/stores/test-store).",
          },
        ],
      },
      {
        h2: "Install the RevenueDot Cordova plugin and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot plugin is built from RevenueCat's open-source plugin (MIT license), so your code calls the global `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account.",
          "`device.platform` comes from `cordova-plugin-device`.",
          "Self-hosting? Call `Purchases.setProxyURL(...)` with your server's URL before `configureWith`. The plugin has no verification option, and your server signs with its own key, so the native SDKs log a failed check for every response unless you build the plugin with your own public key. Access is still granted. See [Trusted Entitlements](/docs/guides/trusted-entitlements).",
        ],
        code: {
          title: "Install, then configure on deviceready",
          label: "Terminal and JavaScript",
          code: `cordova plugin add @revenuedot/cordova-plugin-purchases

// www/js/index.js
document.addEventListener("deviceready", () => {
  Purchases.configureWith({ apiKey: device.platform === "iOS" ? "appl_..." : "goog_..." });
});`,
        },
      },
      {
        h2: "Check the entitlement, then buy a package",
        label: "JavaScript",
        code: {
          title: "Check access and buy with callbacks",
          label: "JavaScript",
          code: `Purchases.getOfferings(
  (offerings) => {
    const aPackage = offerings.current && offerings.current.availablePackages[0];
    if (!aPackage) return;
    Purchases.purchasePackage(
      aPackage,
      ({ customerInfo }) => {
        const nowPro = customerInfo.entitlements.active["pro"] !== undefined;
      },
      ({ error, userCancelled }) => { if (!userCancelled) console.error(error); }
    );
  },
  (error) => console.error(error)
);`,
        },
      },
      {
        h2: "Check these Cordova details before you ship",
        label: "Notes",
        bullets: [
          "**Test Store keys** work in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Xcode 27** rejects pods that target iOS 13. Set `<preference name=\"deployment-target\" value=\"15.0\" />` in `config.xml` and raise the pod targets in a `post_install` block. See the [Cordova guide](/docs/sdks/cordova).",
          "**Status:** there is no Cordova example app yet.",
        ],
      },
      {
        h2: "Switching from RevenueCat? Keep the Cordova plugin and change one line",
        label: "Switch",
        paras: [
          "If your app already ships RevenueCat's `cordova-plugin-purchases`, you can keep it. Call `Purchases.setProxyURL` before `configureWith`. Then call `Purchases.syncPurchases()` once on the first launch of the update, so current subscribers keep access. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        bullets: [
          "**Signature log:** the stock plugin has no option to turn off signature checks, so the native SDKs log a failed check for every RevenueDot response. Access is still granted, because the native default mode is informational. The RevenueDot plugin removes the noise against RevenueDot Cloud.",
          "**Keys:** the importer keeps your RevenueCat `appl_` and `goog_` keys working, so builds you already shipped keep their keys.",
        ],
        code: {
          title: "Point the RevenueCat plugin at RevenueDot",
          label: "JavaScript",
          code: `document.addEventListener("deviceready", () => {
  Purchases.setProxyURL("https://api.revenuedot.app");   // returns nothing
  Purchases.configureWith({
    apiKey: device.platform === "iOS" ? "appl_..." : "goog_...",
  });
  // Once, on the first launch of this update
  Purchases.syncPurchases();
});`,
        },
      },
    ],
    howTo: "How to add subscriptions to a Cordova app with RevenueDot",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot Cordova plugin?",
        a: "No. The RevenueDot plugin is built from RevenueCat's open-source Cordova plugin under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, copy your app's keys and pass them to Purchases.configureWith.",
      },
      {
        q: "How do I add in-app purchases to a Cordova app?",
        a: "Run cordova plugin add @revenuedot/cordova-plugin-purchases, configure it on deviceready with your appl_ or goog_ key, fetch offerings and call purchasePackage. RevenueDot checks each purchase with the store and keeps the customer's entitlements in sync.",
      },
      {
        q: "Does RevenueDot work with Cordova on iOS and Android?",
        a: "Yes. The RevenueDot plugin uses RevenueDot's native iOS and Android SDKs underneath, so App Store and Google Play purchases are handled the same way as in native apps.",
      },
      {
        q: "Why does Xcode reject the plugin's pods?",
        a: "Xcode 27 rejects pods that target iOS 13, and the stock plugin's pods do too. Set the deployment-target preference to 15.0 in config.xml and raise the pod targets with a post_install block or an after_prepare hook.",
      },
      {
        q: "Can I turn off signature verification in RevenueCat's Cordova plugin?",
        a: "No. configureWith has no verification option, so the native default, informational, applies. Every RevenueDot response is logged as a failed check and access is still granted. The RevenueDot plugin trusts RevenueDot's key, so the noise goes away on Cloud.",
      },
    ],
    docs: [
      { href: "/docs/sdks/cordova", label: "Cordova guide" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
      { href: "/docs/guides/test-store", label: "Test Store" },
      { href: "/docs/help/signature-verification-failed", label: "Signature verification failed" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/add-in-app-purchases", "/sdks/capacitor", "/sdks/react-native", "/stores/test-store", "/stores/app-store", "/migrate-from-revenuecat"],
  },

  {
    slug: "unity",
    section: "sdks",
    name: "Unity",
    card: "Add in-app purchases to Unity games on iOS and Android with the RevenueDot plugin from OpenUPM.",
    label: "SDK",
    title: "Unity in-app purchases and subscriptions with the RevenueDot plugin",
    metaTitle: "Unity in-app purchases (IAP) for iOS and Android games",
    metaDescription:
      "Add Unity in-app purchases with the RevenueDot plugin from OpenUPM. Paste your app's keys on the Purchases component and buy on iOS and Android. Free on Cloud.",
    answer:
      "To add in-app purchases to a Unity game, install the RevenueDot plugin with `openupm add com.revenuedot.purchases-unity` and paste your app's `appl_` and `goog_` keys on the Purchases component. RevenueDot checks each purchase with the App Store or Google Play and keeps each player's access in sync. Purchases run on iOS and Android devices and simulators. RevenueDot Cloud is free until your game makes $10,000 a month.",
    points: [
      { title: "OpenUPM or git", text: "`com.revenuedot.purchases-unity` 9.11.1 on OpenUPM, or the git tag `9.11.1-revenuedot`." },
      { title: "Inspector setup", text: "Paste your keys on the Purchases component. RevenueDot Cloud is the default server." },
      { title: "Runtime setup too", text: "Check **Use Runtime Setup** and call `Configure` from a script." },
      { title: "Test on a device", text: "The Editor uses a no-op wrapper, so buy on an iOS or Android device or simulator." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to a Unity game with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}) and add an App Store app and a Google Play app, or a **Test Store** app for a first run.`,
          },
          {
            name: "Connect the stores and create the catalog",
            text: "Add credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, an entitlement such as `pro` (the access your game checks) and a current offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot plugin and configure it with your key",
            text: "Run `openupm add com.revenuedot.purchases-unity`. On the Purchases component, paste your `appl_` and `goog_` keys into the Apple and Google API key fields. RevenueDot Cloud is the default server, so the keys are the only setting.",
          },
          {
            name: "Configure from a script if you use runtime setup",
            text: "Check **Use Runtime Setup** and call `Configure` from a script that runs after `Purchases.Start()`, as in the code below.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `PurchasePackage` and read `customerInfo.Entitlements.Active`. See [the Test Store](/stores/test-store) to buy without store accounts.",
          },
        ],
      },
      {
        h2: "Install the RevenueDot Unity plugin and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot plugin is built from RevenueCat's open-source Unity plugin (MIT license), so your scripts use the `Purchases` component and the `RevenueCat` namespace. It sends every request to RevenueDot and needs no RevenueCat account.",
          "The External Dependency Manager pulls RevenueDot's native iOS and Android packages. The paywall package (`RevenueCatUI` folder) installs from git.",
          "Self-hosting? Set the **Proxy URL** field under **Advanced** to your server and **Entitlement Verification Mode** to **Disabled**, because your server signs with its own key. Unity has no public `SetProxyURL` method, so the field is the only way. See [Trusted Entitlements](/docs/guides/trusted-entitlements).",
        ],
        code: {
          title: "Install, then paste your keys",
          label: "Terminal and Inspector",
          code: `# Install with OpenUPM
openupm add com.revenuedot.purchases-unity
# Or Package Manager > Add package from git URL:
# https://github.com/revenuedot/purchases-unity.git?path=RevenueCat#9.11.1-revenuedot

// Inspector: Purchases component → API keys
// Paste your app's key; RevenueDot Cloud is the default server.`,
        },
      },
      {
        h2: "Configure at runtime, then buy a package",
        label: "C#",
        code: {
          title: "Runs after Purchases.Start()",
          label: "C#",
          code: `using UnityEngine;

[DefaultExecutionOrder(100)]
[RequireComponent(typeof(Purchases))]
public class Store : MonoBehaviour
{
    void Start()
    {
        var purchases = GetComponent<Purchases>();
        purchases.Configure(Purchases.PurchasesConfiguration.Builder.Init("appl_...").Build());

        purchases.GetOfferings((offerings, error) =>
        {
            if (error != null || offerings.Current == null) return;
            purchases.PurchasePackage(offerings.Current.AvailablePackages[0], result =>
            {
                if (result.UserCancelled || result.Error != null) return;
                bool nowPro = result.CustomerInfo.Entitlements.Active.ContainsKey("pro");
            });
        });
    }
}`,
        },
        paras: ["The script must run after `Purchases.Start()`, which creates the native wrapper. Calling `Configure` before it throws a `NullReferenceException`. `[DefaultExecutionOrder(100)]` makes Unity call your `Start()` after it."],
      },
      {
        h2: "Check these Unity details before you ship",
        label: "Notes",
        bullets: [
          "**Editor:** the SDK uses a no-op wrapper in the Unity Editor and makes no requests. Test on a device or simulator.",
          "**Test Store keys** work in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Status:** there is no Unity example app yet, and the RevenueDot package has not been run in the Unity Editor yet.",
        ],
      },
      {
        h2: "Switching from RevenueCat? Keep your Unity plugin and set one field",
        label: "Switch",
        paras: [
          "If your game already ships RevenueCat's Unity plugin, you can keep it. On the Purchases component, set **Proxy URL** under **Advanced** to `https://api.revenuedot.app` and **Entitlement Verification Mode** to **Disabled**. The component applies the field before it configures the SDK, also with runtime setup. Then call `SyncPurchases()` once on the first launch of the update, so current players keep access. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        table: {
          head: ["Inspector field", "Before", "After"],
          rows: [
            ["Proxy URL (under Advanced)", "empty", "`https://api.revenuedot.app`"],
            ["Entitlement Verification Mode", "Informational", "Disabled"],
            ["Revenue Cat API Key Apple and Google", "your keys", "`appl_` and `goog_` keys from RevenueDot, or your RevenueCat keys if the importer kept them"],
          ],
        },
        code: {
          title: "Sync once after the update",
          label: "C#",
          code: `// Once, on the first launch of this update
GetComponent<Purchases>().SyncPurchases();`,
        },
      },
    ],
    howTo: "How to add subscriptions to a Unity game with RevenueDot",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot Unity plugin?",
        a: "No. The RevenueDot plugin is built from RevenueCat's open-source Unity plugin under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, copy your app's keys and paste them on the Purchases component.",
      },
      {
        q: "How do I add in-app purchases to a Unity game?",
        a: "Install the RevenueDot plugin from OpenUPM, paste your appl_ and goog_ keys on the Purchases component, then fetch offerings and call PurchasePackage. RevenueDot checks each purchase with the App Store or Google Play and keeps the player's entitlements in sync.",
      },
      {
        q: "Why does Configure throw a NullReferenceException?",
        a: "Your script ran before Purchases.Start(), which creates the native wrapper. Add [DefaultExecutionOrder(100)] to your script so Unity calls your Start() after the Purchases component's.",
      },
      {
        q: "Can I test Unity purchases in the Editor?",
        a: "No. In the Editor the SDK uses a no-op wrapper and makes no requests. Run on an iOS or Android device or simulator, with a Test Store key in a debug build if you have no store account.",
      },
      {
        q: "Where is the proxy URL in RevenueCat's Unity plugin?",
        a: "In the Inspector, on the Purchases component, under Advanced. Unity has no public SetProxyURL method. The component applies the field before it configures the SDK, also when you use runtime setup.",
      },
    ],
    docs: [
      { href: "/docs/sdks/unity", label: "Unity guide" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
      { href: "/docs/guides/test-store", label: "Test Store" },
      { href: "/docs/sdks/hybrid-common", label: "Hybrid common" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/add-in-app-purchases", "/sdks/android", "/sdks/ios", "/stores/test-store", "/stores/google-play", "/migrate-from-revenuecat"],
  },

  {
    slug: "kotlin-multiplatform",
    section: "sdks",
    name: "Kotlin Multiplatform",
    card: "Add in-app purchases to Kotlin Multiplatform apps on iOS and Android with the RevenueDot SDK from common code.",
    label: "SDK",
    title: "Kotlin Multiplatform in-app purchases with the RevenueDot SDK",
    metaTitle: "Kotlin Multiplatform in-app purchases and subscriptions",
    metaDescription:
      "Add in-app purchases to Kotlin Multiplatform apps. Add purchases-kmp-core from Maven Central and configure it in common code for iOS and Android. Free on Cloud.",
    answer:
      "To add in-app purchases to a Kotlin Multiplatform app, add `app.revenuedot.purchases:purchases-kmp-core:3.10.1` to `commonMain` and call `Purchases.configure` in common code, with the `appl_` key on iOS and the `goog_` key on Android. RevenueDot checks each purchase with the App Store or Google Play and keeps each customer's access in sync. RevenueDot Cloud is free until your app makes $10,000 a month.",
    points: [
      { title: "Common code", text: "One `Purchases.configure` call in `commonMain` covers the Android and iOS targets." },
      { title: "Maven Central", text: "`purchases-kmp-core` 3.10.1, plus `purchases-kmp-ui` for paywalls." },
      { title: "Built on the native SDKs", text: "Its Android side is RevenueDot's Android SDK 10.22.1, and its iOS side compiles RevenueDot's iOS SDK 5.90.2." },
      { title: "Test Store first", text: "Buy with a `test_` key in a debug build before you have App Store or Google Play accounts." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to a Kotlin Multiplatform app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}) and add an App Store app and a Google Play app, or a **Test Store** app for a first run.`,
          },
          {
            name: "Connect the stores and create the catalog",
            text: "Add credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, an entitlement such as `pro` (the access your app checks) and a current offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot SDK and configure it with your key",
            text: "Add the Gradle dependency to `commonMain`, then call `Purchases.configure` in common code, as in the code below. On Cloud the SDK already points at RevenueDot, so your key is the only setting.",
          },
          {
            name: "Pass the right key per platform",
            text: "Pass the `appl_` key on iOS and the `goog_` key on Android to `PurchasesConfiguration`.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `awaitPurchase(pkg)` and read `customerInfo.entitlements.active`. It throws `PurchasesTransactionException` on failure or cancel. See [the Test Store](/stores/test-store) to buy without store accounts.",
          },
        ],
      },
      {
        h2: "Install the RevenueDot Kotlin Multiplatform SDK and configure it with your key",
        label: "Install",
        paras: [
          "The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `com.revenuecat.purchases.kmp` and calls `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account.",
          "Self-hosting? Set `Purchases.proxyURL`, a `String`, to your server before `configure`, and keep the default verification mode, `DISABLED`, because your server signs with its own key. See [Trusted Entitlements](/docs/guides/trusted-entitlements).",
        ],
        code: {
          title: "Install, then configure in common code",
          label: "Gradle and Kotlin",
          code: `// build.gradle.kts, commonMain
implementation("app.revenuedot.purchases:purchases-kmp-core:3.10.1")
implementation("app.revenuedot.purchases:purchases-kmp-ui:3.10.1")   // only for paywalls

// Common code, once at app start
import com.revenuecat.purchases.kmp.Purchases
import com.revenuecat.purchases.kmp.PurchasesConfiguration

fun initPurchases(apiKey: String) {   // the appl_ key on iOS, the goog_ key on Android
    Purchases.configure(PurchasesConfiguration(apiKey))
}`,
        },
      },
      {
        h2: "Check the entitlement, then buy a package",
        label: "Kotlin",
        code: {
          title: "Check access and buy",
          label: "Kotlin",
          code: `val customerInfo = Purchases.sharedInstance.awaitCustomerInfo()
val isPro = customerInfo.entitlements.active.containsKey("pro")

val offerings = Purchases.sharedInstance.awaitOfferings()
val pkg = offerings.current?.availablePackages?.firstOrNull() ?: return
val result = Purchases.sharedInstance.awaitPurchase(pkg)
val nowPro = result.customerInfo.entitlements.active.containsKey("pro")`,
        },
        paras: ["The `await` helpers live in `com.revenuecat.purchases.kmp.ktx`."],
      },
      {
        h2: "Check these Kotlin Multiplatform details before you ship",
        label: "Notes",
        bullets: [
          "**Test Store keys** work in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Self-hosted servers** older than the 2026-09-30 fix could not serve Test Store products to the native iOS SDK, so update your server.",
          "**Status:** there is no Kotlin Multiplatform example app yet. The calls match the [Android SDK page](/sdks/android).",
        ],
      },
      {
        h2: "Switching from RevenueCat? Keep purchases-kmp and change one line",
        label: "Switch",
        paras: [
          "If your app already ships RevenueCat's `purchases-kmp`, you can keep it. Set `Purchases.proxyURL` in common code before `configure`. Verification is already `DISABLED` by default. Then call `awaitSyncPurchases()` once from a coroutine on the first launch of the update, so current subscribers keep access. The full plan is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
        bullets: [
          "**A String:** in `purchases-kmp` the proxy URL is a `String`, not a `URL` as in the native Android SDK.",
          "**Android diagnostics:** the stock Android SDK underneath still sends diagnostics, paywall events and ad events to RevenueCat. The RevenueDot SDK sends them to RevenueDot.",
          "**Verification:** never use `ENFORCED` with the stock SDK. RevenueDot cannot sign with RevenueCat's key, so every request would fail.",
        ],
        code: {
          title: "Point the RevenueCat SDK at RevenueDot",
          label: "Kotlin",
          code: `Purchases.proxyURL = "https://api.revenuedot.app"

fun initPurchases(apiKey: String) {
    Purchases.configure(PurchasesConfiguration(apiKey) {
        // DISABLED is the KMP default; keep it.
        verificationMode = EntitlementVerificationMode.DISABLED
    })
}

// Once, from a coroutine, on the first launch of this update
Purchases.sharedInstance.awaitSyncPurchases()`,
        },
      },
    ],
    howTo: "How to add subscriptions to a Kotlin Multiplatform app with RevenueDot",
    faq: [
      {
        q: "Do I need a RevenueCat account to use the RevenueDot Kotlin Multiplatform SDK?",
        a: "No. The RevenueDot SDK is built from RevenueCat's open-source purchases-kmp under the MIT license, but every request goes to RevenueDot. Create a free RevenueDot Cloud project, copy your app's keys and pass them to PurchasesConfiguration.",
      },
      {
        q: "How do I add in-app purchases to a Kotlin Multiplatform app?",
        a: "Add purchases-kmp-core from Maven Central to commonMain, configure it with a store key per platform, fetch offerings and call awaitPurchase. RevenueDot checks each purchase with the App Store or Google Play and keeps the customer's entitlements in sync.",
      },
      {
        q: "Does RevenueDot work on both iOS and Android targets in KMP?",
        a: "Yes. One configure call in common code covers both targets. Pass the appl_ key on iOS and the goog_ key on Android. The SDK builds on RevenueDot's native Android and iOS SDKs.",
      },
      {
        q: "Do I need to change entitlement verification in KMP?",
        a: "No. purchases-kmp already defaults to EntitlementVerificationMode.DISABLED, which works with RevenueDot Cloud and a self-hosted server.",
      },
      {
        q: "Is the proxy URL a String or a URL in purchases-kmp?",
        a: "A String. In the native Android SDK it is a java.net.URL, but purchases-kmp takes a plain String, so a switcher writes Purchases.proxyURL = \"https://api.revenuedot.app\".",
      },
    ],
    docs: [
      { href: "/docs/sdks/kotlin-multiplatform", label: "Kotlin Multiplatform guide" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
      { href: "/docs/sdks/android", label: "Android SDK guide" },
      { href: "/docs/sdks/ios", label: "iOS SDK guide" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/add-in-app-purchases", "/sdks/android", "/sdks/ios", "/stores/test-store", "/stores/google-play", "/migrate-from-revenuecat"],
  },
];
