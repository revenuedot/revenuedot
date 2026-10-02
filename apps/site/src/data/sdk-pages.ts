// SDK landing pages: /sdks/<slug>. Code lines come from src/lib/sdks.ts and the docs in docs/sdks/*.md.
// Fork packages are not on any registry yet (docs/STATUS.md, October 2026): every page says so. Writing rules: apps/site/CONTENT.md.
import type { Landing } from "./types";

const SIGNUP = "https://app.revenuedot.app/signup";

export const SDK_PAGES: Landing[] = [
  {
    slug: "ios",
    section: "sdks",
    name: "iOS",
    card: "StoreKit 2 subscriptions for iOS, macOS, tvOS, watchOS and visionOS with the RevenueCat Swift SDK.",
    label: "SDK",
    title: "iOS in-app subscriptions backend (StoreKit 2) that works with the RevenueCat SDK",
    metaTitle: "iOS in-app subscriptions backend for StoreKit 2",
    metaDescription:
      "Add iOS subscriptions with StoreKit 2 and the RevenueCat Swift SDK. Set Purchases.proxyURL to RevenueDot and keep your code. Free on Cloud up to $10K a month.",
    answer:
      "To run iOS in-app subscriptions on RevenueDot, keep the RevenueCat Swift SDK and set Purchases.proxyURL to https://api.revenuedot.app before Purchases.configure. Turn entitlement verification off. RevenueDot verifies StoreKit 2 transactions with Apple, tracks entitlements and sends webhooks. It covers iOS, iPadOS, macOS, tvOS, watchOS and visionOS on SDK 5.x.",
    shot: {
      src: "paywalls-ios.png",
      alt: "A RevenueDot paywall rendered by the RevenueCat SDK on an iPhone simulator",
      caption: "A RevenueDot paywall rendered on an iPhone simulator.",
    },
    points: [
      { title: "One line", text: "`Purchases.proxyURL` points the SDK you already ship at RevenueDot." },
      { title: "StoreKit 2", text: "Signed transactions are verified against Apple's root certificate, and the App Store Server API supplies history." },
      { title: "Tested on a simulator", text: "The unmodified RevenueCat iOS SDK 5.92 passes configure, offerings, a Test Store purchase and logIn against RevenueDot." },
      { title: "Web purchases too", text: "Buyers from a RevenueDot purchase link get access in the app with `redeemWebPurchase`." },
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
            text: "Add your products, an entitlement such as `pro`, and a current offering named `default`.",
          },
          {
            name: "Set the proxy URL before configure",
            text: "In your app delegate or `App` initializer, set `Purchases.proxyURL` and configure with verification `.disabled`, as in the code below.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `purchase(package:)` and read `customerInfo.entitlements[\"pro\"]?.isActive`. The purchase goes to `POST /v1/receipts`, and RevenueDot verifies it with Apple.",
          },
          {
            name: "Test with a Test Store key or the sandbox",
            text: "Use a `test_` key in a debug build to buy with no App Store account, or use a sandbox tester. See [the Test Store](/stores/test-store).",
          },
        ],
      },
      {
        h2: "The iOS proxy URL change",
        label: "Swift",
        code: {
          title: "Point the SDK at RevenueDot",
          label: "Swift",
          code: `import RevenueCat

// Before Purchases.configure
Purchases.proxyURL = URL(string: "https://api.revenuedot.app")!
Purchases.configure(
    with: Configuration.Builder(withAPIKey: "appl_...")
        // Default is .informational, which logs every RevenueDot response as a failed check.
        .with(entitlementVerificationMode: .disabled)
        .build()
)`,
        },
        paras: [
          "Self-hosting? Use your own server's HTTPS URL instead of `https://api.revenuedot.app`. Never use `.enforced` with the stock SDK: RevenueDot cannot sign with RevenueCat's key, so every request would fail.",
        ],
      },
      {
        h2: "Check an entitlement and make a purchase",
        label: "Swift",
        code: {
          title: "RevenueCat's API, unchanged",
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
        h2: "The RevenueDot fork package for iOS",
        label: "Fork",
        paras: [
          "RevenueDot keeps a fork of the iOS SDK at [github.com/revenuedot/purchases-ios](https://github.com/revenuedot/purchases-ios). It keeps the modules `RevenueCat` and `RevenueCatUI`, trusts RevenueDot's signing key and defaults to `https://api.revenuedot.app`. **It is published (checked October 2026):** CocoaPods `RevenueDotPurchases` and `RevenueDotPurchasesUI` 5.91.0, and the Swift Package Manager tag `5.91.0-revenuedot`.",
        ],
        code: {
          title: "Fork install",
          label: "Swift and CocoaPods",
          code: `// Swift Package Manager
.package(url: "https://github.com/revenuedot/purchases-ios", exact: "5.91.0-revenuedot")
// CocoaPods
pod "RevenueDotPurchases", "5.91.0"   // still: import RevenueCat`,
        },
      },
      {
        h2: "iOS details worth knowing before you ship",
        label: "Notes",
        bullets: [
          "**Migrating from RevenueCat?** Call `syncPurchases()` once on the first launch of the update, so current subscribers keep access. See [Migrate from RevenueCat](/migrate-from-revenuecat).",
          "**Test Store keys** work in Debug builds only. A Release build shows a Wrong API Key alert and stops on purpose.",
          "**Web checkout:** a RevenueCatUI paywall's web checkout button opens Stripe Checkout on your own Stripe account for the current user. See [web to app](/solutions/web-to-app).",
          "**Before you ship:** run a purchase with a sandbox tester and check it on the customer page.",
        ],
      },
    ],
    howTo: "How to add subscriptions to an iOS app with RevenueDot",
    faq: [
      {
        q: "How do I add in-app subscriptions to an iOS app with StoreKit 2?",
        a: "Use the RevenueCat Swift SDK for the purchase UI and entitlements, and a backend that verifies StoreKit 2 transactions. With RevenueDot you set Purchases.proxyURL to the server, add your App Store In-App Purchase key and notification URL, and call purchase(package:).",
      },
      {
        q: "Does the RevenueCat iOS SDK work with a different backend?",
        a: "Yes, with a server that implements the API the SDK calls. RevenueDot does, so you set Purchases.proxyURL before configure and turn entitlement verification off. Offerings, purchases, restores and customer info work as before.",
      },
      {
        q: "Why do I turn off entitlement verification?",
        a: "The stock SDK checks response signatures against RevenueCat's key. RevenueDot cannot sign with that key, so the default informational mode logs every response as failed. Access is still granted, but .disabled stops the noise.",
      },
      {
        q: "Does RevenueDot support StoreKit 2?",
        a: "Yes. It verifies signed transactions against Apple's root certificate and, with an In-App Purchase key, reads history and renewal state from the App Store Server API. StoreKit 1 receipts also work once the key is added.",
      },
      {
        q: "How do I test iOS purchases without an App Store account?",
        a: "Create a Test Store app in RevenueDot, pass its test_ key to configure in a Debug build and buy through the SDK's alert. For real sandbox purchases, use a sandbox tester or an Xcode StoreKit file with its test certificate saved on the app.",
      },
    ],
    docs: [
      { href: "/docs/sdks/ios", label: "iOS SDK guide" },
      { href: "/docs/guides/app-store", label: "Connect the App Store" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/getting-started/connect-your-app", label: "Connect your app" },
    ],
    related: ["/stores/app-store", "/stores/test-store", "/migrate-from-revenuecat", "/features/paywalls", "/solutions/receipt-validation", "/pricing"],
  },

  {
    slug: "android",
    section: "sdks",
    name: "Android",
    card: "Google Play Billing subscriptions on Android with the RevenueCat Kotlin SDK and your own backend.",
    label: "SDK",
    title: "Android in-app subscriptions backend (Google Play Billing) that works with the RevenueCat SDK",
    metaTitle: "Android in-app subscriptions backend for Google Play",
    metaDescription:
      "Add Android subscriptions with Google Play Billing and the RevenueCat Kotlin SDK. Set Purchases.proxyURL to RevenueDot and keep your app code. Free on Cloud.",
    answer:
      "To run Android in-app subscriptions on RevenueDot, keep the RevenueCat Kotlin SDK and set Purchases.proxyURL to https://api.revenuedot.app before Purchases.configure, with EntitlementVerificationMode.DISABLED. RevenueDot reads each purchase from the Google Play Developer API and receives real-time developer notifications. The stock SDK still sends diagnostics to RevenueCat.",
    points: [
      { title: "One line", text: "`Purchases.proxyURL` points the SDK at RevenueDot. Kotlin packages stay `com.revenuecat.purchases.*`." },
      { title: "Google Play checked server-side", text: "Purchase tokens are read from the Play Developer API and acknowledged." },
      { title: "Tested on an emulator", text: "The unmodified Android SDK 10.24.0 passes a Test Store purchase on an Android 15 emulator." },
      { title: "Fork fixes the leaks", text: "The fork sends diagnostics, paywall events and ad events to your proxy URL too." },
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
            text: "Add products with `store_identifier` as `subscriptionId:basePlanId`, an entitlement such as `pro` and a current offering.",
          },
          {
            name: "Set the proxy URL before configure",
            text: "In `Application.onCreate`, set `Purchases.proxyURL` and configure with verification `DISABLED`, as in the code below.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `awaitPurchase` and read `customerInfo.entitlements[\"pro\"]?.isActive`. The purchase token goes to `POST /v1/receipts`.",
          },
          {
            name: "Test on a test track or with the Test Store",
            text: "Use a `test_` key in a debug build, or a Play license tester on an internal test track.",
          },
        ],
      },
      {
        h2: "The Android proxy URL change",
        label: "Kotlin",
        code: {
          title: "Point the SDK at RevenueDot",
          label: "Kotlin",
          code: `// Before Purchases.configure
Purchases.proxyURL = URL("https://api.revenuedot.app")
Purchases.configure(
    PurchasesConfiguration.Builder(this, "goog_...")
        // Default is INFORMATIONAL, which logs every response as a failed signature check.
        .entitlementVerificationMode(EntitlementVerificationMode.DISABLED)
        .build()
)`,
        },
        paras: [
          "The Android emulator reaches your computer at `http://10.0.2.2:8787` when you self-host locally. Plain `http` needs a network security config that allows cleartext traffic to that host.",
        ],
      },
      {
        h2: "Check an entitlement and make a purchase",
        label: "Kotlin",
        code: {
          title: "RevenueCat's coroutine API, unchanged",
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
        h2: "The RevenueDot fork package for Android",
        label: "Fork",
        paras: [
          "The fork lives at [github.com/revenuedot/purchases-android](https://github.com/revenuedot/purchases-android). Imports do not change. It also routes diagnostics, paywall events and ad events to your proxy URL, which the stock SDK still sends to RevenueCat. **It is published on Maven Central as `app.revenuedot.purchases:purchases` 10.23.3 (checked October 2026).**",
        ],
        code: {
          title: "Fork install",
          label: "Gradle",
          code: `// build.gradle.kts
implementation("app.revenuedot.purchases:purchases:10.23.3")
// still: import com.revenuecat.purchases.*`,
        },
      },
      {
        h2: "Android details worth knowing before you ship",
        label: "Notes",
        bullets: [
          "**Migrating from RevenueCat?** Call `syncPurchases()` once on the first launch of the update. It also gives RevenueDot any Google purchase token the importer could not find.",
          "**Test Store keys** work in debug builds only. A release build shows an error screen and stops on purpose.",
          "**Amazon:** the same SDK runs on Fire devices with `AmazonConfiguration`. See [Amazon Appstore setup](/stores/amazon-appstore).",
          "**Web purchases:** an intent filter for your redemption scheme plus `redeemWebPurchase` gives buyers from a RevenueDot purchase link access in the app.",
          "**Before you ship:** run a purchase with a license tester and check it on the customer page.",
        ],
      },
    ],
    howTo: "How to add subscriptions to an Android app with RevenueDot",
    faq: [
      {
        q: "How do I add in-app subscriptions to an Android app?",
        a: "Use the RevenueCat Kotlin SDK on the device and a server that checks Google Play purchases. With RevenueDot you set Purchases.proxyURL, add a Play service account and a Pub/Sub push subscription, create products as subscriptionId:basePlanId and call awaitPurchase.",
      },
      {
        q: "Does the stock Android SDK still talk to RevenueCat after I set a proxy URL?",
        a: "Purchases, customer info and offerings go to your proxy URL. Diagnostics, paywall events and ad events still go to RevenueCat's hosts in the stock SDK. The RevenueDot fork sends them to your server.",
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
    ],
    docs: [
      { href: "/docs/sdks/android", label: "Android SDK guide" },
      { href: "/docs/guides/google-play", label: "Connect Google Play" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/getting-started/connect-your-app", label: "Connect your app" },
    ],
    related: ["/stores/google-play", "/stores/amazon-appstore", "/stores/test-store", "/sdks/kotlin-multiplatform", "/migrate-from-revenuecat", "/pricing"],
  },

  {
    slug: "react-native",
    section: "sdks",
    name: "React Native and Expo",
    card: "Subscriptions for React Native and Expo apps with react-native-purchases and your own backend.",
    label: "SDK",
    title: "In-app purchases and subscriptions for React Native and Expo apps",
    metaTitle: "In-app purchases for React Native and Expo apps",
    metaDescription:
      "Add subscriptions to a React Native or Expo app with react-native-purchases. Await Purchases.setProxyURL and point it at RevenueDot. Free on Cloud up to $10K.",
    answer:
      "To add subscriptions to a React Native or Expo app on RevenueDot, keep react-native-purchases and await Purchases.setProxyURL(\"https://api.revenuedot.app\") before Purchases.configure. Entitlement verification is already off by default in this SDK. It works on iOS and Android builds, and in Expo Go and on the web with a Test Store key.",
    points: [
      { title: "One awaited call", text: "`Purchases.setProxyURL` is the whole change. Verification is already `DISABLED` in React Native." },
      { title: "Expo Go and web", text: "A `test_` key buys in Expo Go and on the web, with no store account." },
      { title: "Imports stay", text: "The fork installs through an npm alias, so no import changes." },
      { title: "Example app", text: "An Expo example loads offerings, buys through the Test Store and shows the entitlement." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to a React Native app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}). Add an App Store app and a Google Play app, or start with a **Test Store** app and its \`test_\` key.`,
          },
          {
            name: "Connect the stores",
            text: "Add the App Store In-App Purchase key and the Google Play service account. See [App Store](/stores/app-store) and [Google Play](/stores/google-play).",
          },
          {
            name: "Create your catalog",
            text: "Add products, an entitlement such as `pro` and a current offering.",
          },
          {
            name: "Await the proxy URL before configure",
            text: "Call `await Purchases.setProxyURL(...)`, then `Purchases.configure` with the `appl_` or `goog_` key for the platform.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `Purchases.purchasePackage(pkg)` and read `customerInfo.entitlements.active[\"pro\"]`.",
          },
          {
            name: "Test in Expo Go or on the web",
            text: "Use the `test_` key and tap **Test valid purchase** in the dialog.",
          },
        ],
      },
      {
        h2: "The React Native proxy URL change",
        label: "TypeScript",
        code: {
          title: "Point the SDK at RevenueDot",
          label: "TypeScript",
          code: `import { Platform } from "react-native";
import Purchases from "react-native-purchases";

await Purchases.setProxyURL("https://api.revenuedot.app");
Purchases.configure({
  apiKey: Platform.OS === "ios" ? "appl_..." : "goog_...",
  // Leave entitlementVerificationMode unset: DISABLED is the React Native default.
});`,
        },
        paras: [
          "`setProxyURL` returns a promise, so await it before `configure`. If your code sets `ENTITLEMENT_VERIFICATION_MODE.INFORMATIONAL` or `ENFORCED`, remove it. `ENFORCED` would fail every request.",
        ],
      },
      {
        h2: "Check an entitlement and make a purchase",
        label: "TypeScript",
        code: {
          title: "RevenueCat's API, unchanged",
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
        h2: "The RevenueDot fork package for React Native",
        label: "Fork",
        paras: [
          "The fork lives at [github.com/revenuedot/react-native-purchases](https://github.com/revenuedot/react-native-purchases). It depends on RevenueDot's hybrid-common native builds, which trust RevenueDot's signing key. **It is published on npm as `@revenuedot/react-native-purchases` 10.10.2, with its native builds on CocoaPods and Maven Central (checked October 2026).** Install it through an npm alias:",
        ],
        code: {
          title: "Fork install",
          label: "package.json",
          code: `// package.json: an npm alias keeps every import
"react-native-purchases": "npm:@revenuedot/react-native-purchases@10.10.2"`,
        },
      },
      {
        h2: "React Native and Expo details worth knowing",
        label: "Notes",
        bullets: [
          "**Expo Go and web:** the SDK runs in browser mode and accepts `test_` and `rcb_` keys. RevenueDot accepts `test_` only today.",
          "**Native builds** accept `test_` keys in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Migrating from RevenueCat?** Call `await Purchases.syncPurchasesForResult()` once on the first launch of the update.",
          "**Status:** the Expo example ran on the web against RevenueDot. Native builds of it are not verified yet.",
        ],
      },
    ],
    howTo: "How to add subscriptions to a React Native app with RevenueDot",
    faq: [
      {
        q: "How do I add in-app purchases to a React Native app?",
        a: "Install react-native-purchases, point it at a backend that checks store receipts, then call getOfferings and purchasePackage. With RevenueDot you await Purchases.setProxyURL before configure, connect your App Store and Google Play apps, and check customerInfo.entitlements.",
      },
      {
        q: "Does react-native-purchases work with Expo?",
        a: "Yes. Expo Go and the web run the SDK in browser mode with a test_ key. For real store purchases you build a development or production app, as with any native purchase library, and use your appl_ and goog_ keys.",
      },
      {
        q: "Do I need to turn off entitlement verification in React Native?",
        a: "No. The React Native SDK already defaults to DISABLED, which is what RevenueDot needs. Remove any INFORMATIONAL or ENFORCED setting you added.",
      },
      {
        q: "Can I test React Native purchases without Apple or Google accounts?",
        a: "Yes. Create a Test Store app and use its test_ key. In Expo Go or on the web, tap a package and choose Test valid purchase.",
      },
      {
        q: "Will my imports change when I switch to the RevenueDot fork?",
        a: "No. The fork installs through an npm alias, so import Purchases from react-native-purchases keeps working. It is published on npm as @revenuedot/react-native-purchases.",
      },
    ],
    docs: [
      { href: "/docs/sdks/react-native", label: "React Native and Expo guide" },
      { href: "/docs/sdks/hybrid-common", label: "Hybrid common" },
      { href: "/docs/guides/test-store", label: "Test Store" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/sdks/flutter", "/sdks/capacitor", "/stores/test-store", "/stores/app-store", "/stores/google-play", "/migrate-from-revenuecat"],
  },

  {
    slug: "flutter",
    section: "sdks",
    name: "Flutter",
    card: "Subscriptions for Flutter apps with purchases_flutter, a proxy URL and your own backend.",
    label: "SDK",
    title: "In-app purchases and subscriptions for Flutter apps",
    metaTitle: "In-app purchases and subscriptions for Flutter apps",
    metaDescription:
      "Add in-app purchases to a Flutter app with purchases_flutter. Await Purchases.setProxyURL to point it at RevenueDot. Free on Cloud up to $10K monthly revenue.",
    answer:
      "To add in-app subscriptions to a Flutter app with RevenueDot, keep purchases_flutter and await Purchases.setProxyURL('https://api.revenuedot.app') before Purchases.configure. Verification is already disabled by default, so iOS and Android need nothing else. The stock package ignores the proxy URL on Flutter web, which the RevenueDot fork fixes.",
    points: [
      { title: "One awaited call", text: "`Purchases.setProxyURL` before `configure` is the whole change on iOS and Android." },
      { title: "Verification already off", text: "`EntitlementVerificationMode.disabled` is the Flutter default." },
      { title: "Web needs the fork", text: "The stock web plugin ignores the proxy URL. The fork makes it work." },
      { title: "Package name stays", text: "The planned fork keeps `package:purchases_flutter`, shipped as a git dependency." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to a Flutter app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}) and add an App Store app and a Google Play app, or a **Test Store** app for a first test.`,
          },
          {
            name: "Connect the stores and create the catalog",
            text: "Add your store credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, a `pro` entitlement and a current offering.",
          },
          {
            name: "Add purchases_flutter",
            text: "Add `purchases_flutter` from pub.dev to `pubspec.yaml` as you would for any RevenueCat project.",
          },
          {
            name: "Await the proxy URL before configure",
            text: "Call `await Purchases.setProxyURL(...)`, then `Purchases.configure` with the `appl_` or `goog_` key.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `Purchases.purchase(PurchaseParams.package(package))` and check `customerInfo.entitlements.active.containsKey('pro')`.",
          },
          {
            name: "Test with a Test Store key",
            text: "Use a `test_` key in a debug build and tap **Test valid purchase** in the dialog.",
          },
        ],
      },
      {
        h2: "The Flutter proxy URL change",
        label: "Dart",
        code: {
          title: "Point the SDK at RevenueDot",
          label: "Dart",
          code: `import 'dart:io' show Platform;
import 'package:purchases_flutter/purchases_flutter.dart';

Future<void> initPurchases() async {
  await Purchases.setProxyURL("https://api.revenuedot.app");
  await Purchases.configure(
    PurchasesConfiguration(Platform.isIOS ? 'appl_...' : 'goog_...'),
    // entitlementVerificationMode stays at its default, disabled.
  );
}`,
        },
      },
      {
        h2: "Check an entitlement and make a purchase",
        label: "Dart",
        code: {
          title: "RevenueCat's API, unchanged",
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
      },
      {
        h2: "The RevenueDot fork package for Flutter",
        label: "Fork",
        paras: [
          "The fork lives at [github.com/revenuedot/purchases-flutter](https://github.com/revenuedot/purchases-flutter). pub.dev names belong to RevenueCat, so it will ship as a git dependency with `-revenuedot` tags. **It is not published yet (checked October 2026)**, and its iOS and Android builds need native packages that are not published either. Use proxy mode today. The planned install:",
        ],
        code: {
          title: "Planned fork install",
          label: "pubspec.yaml",
          code: `# pubspec.yaml
purchases_flutter:
  git:
    url: https://github.com/revenuedot/purchases-flutter
    ref: <version>-revenuedot`,
        },
      },
      {
        h2: "Flutter details worth knowing",
        label: "Notes",
        bullets: [
          "**Flutter web** does not work in proxy mode with the stock package, because its web plugin ignores `setProxyURL`. Web calls would still go to RevenueCat. The fork fixes it.",
          "**Migrating from RevenueCat?** Call `await Purchases.syncPurchases()` once on the first launch of the update.",
          "**Test Store keys** work in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Status:** the Flutter example is written but has not been analyzed or run on a device yet.",
        ],
      },
    ],
    howTo: "How to add subscriptions to a Flutter app with RevenueDot",
    faq: [
      {
        q: "How do I add in-app purchases to a Flutter app?",
        a: "Add purchases_flutter, configure it with your store key, fetch offerings and call Purchases.purchase. A backend verifies the store receipt. With RevenueDot you await Purchases.setProxyURL before configure and connect your App Store and Google Play apps.",
      },
      {
        q: "Does purchases_flutter work with a backend other than RevenueCat?",
        a: "Yes, on iOS and Android, when the server implements the API the SDK calls. RevenueDot does. You call Purchases.setProxyURL before configure. Verification is already disabled by default in Flutter.",
      },
      {
        q: "Does RevenueDot work with Flutter web?",
        a: "Not with the stock package: its web plugin ignores setProxyURL. The RevenueDot fork fixes that, but it is not published yet. For web sales today, use a RevenueDot purchase link and Stripe Checkout.",
      },
      {
        q: "How do I test Flutter purchases without store accounts?",
        a: "Create a Test Store app, use its test_ key in a debug build and tap Test valid purchase. Test purchases are always sandbox data.",
      },
      {
        q: "Will my Dart imports change with the fork?",
        a: "No. The package names stay purchases_flutter and purchases_ui_flutter. Only the dependency source in pubspec.yaml changes, and the fork is not published yet.",
      },
    ],
    docs: [
      { href: "/docs/sdks/flutter", label: "Flutter guide" },
      { href: "/docs/sdks/hybrid-common", label: "Hybrid common" },
      { href: "/docs/guides/test-store", label: "Test Store" },
      { href: "/docs/migrate/sdk-changes", label: "SDK changes when you migrate" },
    ],
    related: ["/sdks/react-native", "/sdks/android", "/sdks/ios", "/stores/test-store", "/migrate-from-revenuecat", "/pricing"],
  },

  {
    slug: "web",
    section: "sdks",
    name: "Web (purchases-js)",
    card: "purchases-js with test purchases, plus real web payments on Stripe Checkout and your own Stripe account.",
    label: "SDK",
    title: "Web subscriptions with purchases-js: test purchases and Stripe Checkout",
    metaTitle: "Web subscriptions with purchases-js and Stripe",
    metaDescription:
      "Use purchases-js with RevenueDot through httpConfig.proxyURL. Test purchases work today. Real web payments run on Stripe Checkout in your own Stripe account.",
    answer:
      "To use purchases-js with RevenueDot, pass httpConfig: { proxyURL: \"https://api.revenuedot.app\" } to Purchases.configure and turn off analytics events. Only Test Store (test_) keys buy through purchases-js today. For real web payments, send buyers to a RevenueDot purchase link or funnel, which runs Stripe Checkout in your own Stripe account.",
    shot: {
      src: "web/web.png",
      alt: "The Web page in the RevenueDot dashboard showing the Stripe provider and the four-step setup checklist for web billing",
    },
    points: [
      { title: "One config key", text: "`httpConfig.proxyURL` points purchases-js at RevenueDot." },
      { title: "Fork tested end to end", text: "The web fork ran configure, offerings, a Test Store purchase and the `pro` entitlement against a real server." },
      { title: "Real payments on Stripe", text: "Purchase links and funnels charge on your own Stripe account." },
      { title: "One customer", text: "A web buyer and an app user share entitlements through the same app user ID." },
    ],
    blocks: [
      {
        h2: "How to add web subscriptions with purchases-js and RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project and a Test Store app",
            text: `[Start free on Cloud](${SIGNUP}), add a **Test Store** app and copy its \`test_\` key.`,
          },
          {
            name: "Create products and an offering",
            text: "Add a product with a duration and a Test Store price, a `pro` entitlement and a current offering.",
          },
          {
            name: "Configure purchases-js with the proxy URL",
            text: "Pass `httpConfig.proxyURL` and `flags: { collectAnalyticsEvents: false }`, as in the code below. The URL must not end with a slash.",
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
        h2: "The purchases-js proxy URL change",
        label: "TypeScript",
        code: {
          title: "Point the SDK at RevenueDot",
          label: "TypeScript",
          code: `Purchases.configure({
  apiKey: "test_...",
  appUserId,
  httpConfig: { proxyURL: "https://api.revenuedot.app" },
});`,
        },
        paras: [
          "Use your RevenueDot `test_` key as `apiKey` today, and add `flags: { collectAnalyticsEvents: false }` so the stock SDK does not send analytics to RevenueCat. The SDK needs an `appUserId`. Pass your signed-in user's ID.",
        ],
      },
      {
        h2: "Check an entitlement and make a test purchase",
        label: "TypeScript",
        code: {
          title: "RevenueCat's API, unchanged",
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
        h2: "The RevenueDot fork package for the web",
        label: "Fork",
        paras: [
          "The fork lives at [github.com/revenuedot/purchases-js](https://github.com/revenuedot/purchases-js). It sends analytics events to the proxy URL too, and its checkout reads Secure checkout by RevenueDot. **It is published on npm as `@revenuedot/purchases-js` 1.67.0 (checked October 2026).** Install it through an alias so your imports stay the same.",
        ],
        code: {
          title: "Fork install",
          label: "package.json",
          code: `// package.json
"@revenuecat/purchases-js": "npm:@revenuedot/purchases-js@1.67.0"`,
        },
      },
      {
        h2: "Which web purchases work today",
        label: "Honest limits",
        table: {
          head: ["Purchase type", "Works with RevenueDot", "How"],
          rows: [
            ["Test Store (`test_` key)", "Yes", "purchases-js opens a Test Store modal"],
            ["Stripe on your own account", "Yes", "RevenueDot purchase link or funnel, or your own checkout posted to the receipts endpoint"],
            ["RevenueCat Web Billing (`rcb_`)", "No", "RevenueDot answers error 7662. Keep those subscriptions on RevenueCat"],
            ["Paddle (`pdl_`)", "No", "RevenueDot answers error 7662"],
          ],
          caption: "Run a Stripe test-mode purchase before you go live.",
        },
      },
    ],
    howTo: "How to add web subscriptions with purchases-js and RevenueDot",
    faq: [
      {
        q: "Can purchases-js use a custom backend?",
        a: "Yes. Pass httpConfig: { proxyURL } to Purchases.configure with a server that implements the SDK API. With RevenueDot, only Test Store test_ keys buy through purchases-js today. Real web payments use RevenueDot's Stripe-backed purchase links and funnels.",
      },
      {
        q: "How do I take real subscription payments on the web with RevenueDot?",
        a: "Connect your Stripe account with a restricted key, create web products, put them in an offering and share a purchase link or publish a funnel. Buyers pay on Stripe Checkout, and the purchase lands on their app user ID or a redemption link.",
      },
      {
        q: "Does RevenueDot support RevenueCat Web Billing keys?",
        a: "No. Receipts for rcb_ and pdl_ keys answer error 7662. Subscriptions you sell through RevenueCat Web Billing stay on RevenueCat, and new web sales can start on RevenueDot's Stripe checkout.",
      },
      {
        q: "Why turn off collectAnalyticsEvents?",
        a: "The stock purchases-js sends analytics events to RevenueCat even with a proxy URL. Turning the flag off keeps all traffic on your server. The RevenueDot fork sends them to the proxy URL, so you can leave it on there.",
      },
    ],
    docs: [
      { href: "/docs/sdks/web", label: "Web SDK guide" },
      { href: "/docs/guides/web-billing", label: "Sell on the web with Stripe" },
      { href: "/docs/guides/purchase-links", label: "Purchase links" },
      { href: "/docs/guides/test-store", label: "Test Store" },
    ],
    related: ["/solutions/web-to-app", "/stores/stripe", "/stores/test-store", "/stores/stripe", "/sdks/react-native", "/pricing"],
  },

  {
    slug: "capacitor",
    section: "sdks",
    name: "Capacitor and Ionic",
    card: "Subscriptions for Capacitor and Ionic apps with the RevenueCat plugin and a RevenueDot proxy URL.",
    label: "SDK",
    title: "In-app purchases and subscriptions for Capacitor and Ionic apps",
    metaTitle: "In-app purchases for Capacitor and Ionic apps",
    metaDescription:
      "Add subscriptions to a Capacitor or Ionic app. Await Purchases.setProxyURL({ url }) and pass verification DISABLED to point the RevenueCat plugin at RevenueDot.",
    answer:
      "To add subscriptions to a Capacitor or Ionic app on RevenueDot, keep @revenuecat/purchases-capacitor, await Purchases.setProxyURL({ url: \"https://api.revenuedot.app\" }) before Purchases.configure, and pass entitlementVerificationMode DISABLED. The plugin sets no default of its own, so the native informational mode would otherwise log every response as failed.",
    points: [
      { title: "Object argument", text: "`setProxyURL` takes `{ url }`, not a plain string." },
      { title: "Pass DISABLED", text: "Capacitor has no default, so the native informational mode applies unless you pass `DISABLED`." },
      { title: "Alias-only fork", text: "Install the fork through an npm alias so the native pod and package names stay the same." },
      { title: "iOS and Android", text: "One TypeScript call path covers both native platforms." },
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
            text: "Add credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, a `pro` entitlement and a current offering.",
          },
          {
            name: "Install the RevenueCat plugin",
            text: "Install `@revenuecat/purchases-capacitor` and run `npx cap sync`, as you would for any RevenueCat project.",
          },
          {
            name: "Await the proxy URL, then configure with verification disabled",
            text: "Call `await Purchases.setProxyURL({ url })`, then `Purchases.configure` with `entitlementVerificationMode: ENTITLEMENT_VERIFICATION_MODE.DISABLED`.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `Purchases.purchasePackage({ aPackage })` and read `customerInfo.entitlements.active[\"pro\"]`.",
          },
        ],
      },
      {
        h2: "The Capacitor proxy URL change",
        label: "TypeScript",
        code: {
          title: "Point the plugin at RevenueDot",
          label: "TypeScript",
          code: `import { Capacitor } from "@capacitor/core";
import { ENTITLEMENT_VERIFICATION_MODE, Purchases } from "@revenuecat/purchases-capacitor";

await Purchases.setProxyURL({ url: "https://api.revenuedot.app" });
await Purchases.configure({
  apiKey: Capacitor.getPlatform() === "ios" ? "appl_..." : "goog_...",
  entitlementVerificationMode: ENTITLEMENT_VERIFICATION_MODE.DISABLED,
});`,
        },
      },
      {
        h2: "Check an entitlement and make a purchase",
        label: "TypeScript",
        code: {
          title: "RevenueCat's API, unchanged",
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
        h2: "The RevenueDot fork package for Capacitor",
        label: "Fork",
        paras: [
          "The fork lives at [github.com/revenuedot/purchases-capacitor](https://github.com/revenuedot/purchases-capacitor). Install it only through the alias below: Capacitor derives native pod and Swift package names from the npm name, and the alias keeps them unchanged. **It is published on npm as `@revenuedot/purchases-capacitor` 13.6.1 (checked October 2026).**",
        ],
        code: {
          title: "Fork install",
          label: "package.json",
          code: `// package.json
"@revenuecat/purchases-capacitor": "npm:@revenuedot/purchases-capacitor@13.6.1"`,
        },
      },
      {
        h2: "Capacitor details worth knowing",
        label: "Notes",
        bullets: [
          "**Migrating from RevenueCat?** Call `await Purchases.syncPurchases()` once on the first launch of the update.",
          "**Test Store keys** work in debug builds only. Ship with `appl_` and `goog_` keys.",
          "**Never use `ENFORCED`:** every request would fail, because RevenueDot cannot sign with RevenueCat's key.",
          "**Status:** there is no Capacitor example app yet. The [React Native example](https://github.com/revenuedot/examples/tree/main/mobile/react-native-expo) shows the same calls in JavaScript.",
        ],
      },
    ],
    howTo: "How to add subscriptions to a Capacitor app with RevenueDot",
    faq: [
      {
        q: "How do I add in-app purchases to a Capacitor or Ionic app?",
        a: "Install @revenuecat/purchases-capacitor, configure it with your store key, fetch offerings and call purchasePackage. A backend checks the receipts. With RevenueDot you await Purchases.setProxyURL({ url }) before configure and pass verification DISABLED.",
      },
      {
        q: "Why does the Capacitor plugin log signature failures with RevenueDot?",
        a: "The plugin passes no verification default, so the native informational mode checks signatures against RevenueCat's key. Pass entitlementVerificationMode DISABLED to stop it. Access is granted either way in informational mode.",
      },
      {
        q: "Does setProxyURL take a string in Capacitor?",
        a: "No. It takes an object, so you write Purchases.setProxyURL({ url: \"https://api.revenuedot.app\" }), and you await it before configure.",
      },
      {
        q: "Can I install the RevenueDot fork of the Capacitor plugin directly?",
        a: "Only through the npm alias. A direct install of @revenuedot/purchases-capacitor would change the generated native names and is not supported. The fork is published on npm.",
      },
    ],
    docs: [
      { href: "/docs/sdks/capacitor", label: "Capacitor and Ionic guide" },
      { href: "/docs/sdks/hybrid-common", label: "Hybrid common" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
      { href: "/docs/guides/test-store", label: "Test Store" },
    ],
    related: ["/sdks/cordova", "/sdks/react-native", "/stores/app-store", "/stores/google-play", "/stores/test-store", "/migrate-from-revenuecat"],
  },

  {
    slug: "cordova",
    section: "sdks",
    name: "Cordova",
    card: "Subscriptions for Cordova apps with the RevenueCat plugin and a RevenueDot proxy URL.",
    label: "SDK",
    title: "In-app purchases and subscriptions for Cordova apps",
    metaTitle: "In-app purchases and subscriptions for Cordova apps",
    metaDescription:
      "Add in-app subscriptions to a Cordova app. Call Purchases.setProxyURL before configureWith to point the RevenueCat plugin at RevenueDot. Free on Cloud.",
    answer:
      "To add in-app subscriptions to a Cordova app on RevenueDot, keep cordova-plugin-purchases and call Purchases.setProxyURL(\"https://api.revenuedot.app\") before Purchases.configureWith. The plugin has no option to turn off signature checks, so the native SDKs log a failed verification for every response, but access is still granted.",
    points: [
      { title: "One call", text: "`Purchases.setProxyURL` before `configureWith` is the whole code change." },
      { title: "Honest limit", text: "You cannot turn off the signature log from JavaScript in the stock plugin." },
      { title: "Access still works", text: "The native default mode is informational, so entitlements are granted." },
      { title: "Plugin id stays", text: "The fork keeps `cordova-plugin-purchases` and the global `Purchases`." },
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
            text: "Add credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, a `pro` entitlement and a current offering.",
          },
          {
            name: "Call setProxyURL on deviceready",
            text: "Inside the `deviceready` handler, call `Purchases.setProxyURL(...)` before `Purchases.configureWith`.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `Purchases.purchasePackage` with callbacks and read `customerInfo.entitlements.active[\"pro\"]`.",
          },
          {
            name: "Test with a Test Store key",
            text: "Use a `test_` key in a debug build to buy with no store account.",
          },
        ],
      },
      {
        h2: "The Cordova proxy URL change",
        label: "JavaScript",
        code: {
          title: "Point the plugin at RevenueDot",
          label: "JavaScript",
          code: `document.addEventListener("deviceready", () => {
  Purchases.setProxyURL("https://api.revenuedot.app");
  Purchases.configureWith({
    apiKey: device.platform === "iOS" ? "appl_..." : "goog_...",
  });
});`,
        },
        paras: ["`device.platform` comes from `cordova-plugin-device`. `setProxyURL` returns nothing."],
      },
      {
        h2: "Check an entitlement and make a purchase",
        label: "JavaScript",
        code: {
          title: "Callback API, unchanged",
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
        h2: "The RevenueDot fork package for Cordova",
        label: "Fork",
        paras: [
          "The fork lives at [github.com/revenuedot/cordova-plugin-purchases](https://github.com/revenuedot/cordova-plugin-purchases). It trusts RevenueDot's signing key, so the verification log noise goes away when the server signs with that key. **It is published on npm as `@revenuedot/cordova-plugin-purchases` 8.2.3, and its native dependencies are on CocoaPods and Maven Central (checked October 2026).**",
        ],
        code: {
          title: "Fork install",
          label: "terminal",
          code: `cordova plugin add @revenuedot/cordova-plugin-purchases@8.2.3`,
        },
      },
      {
        h2: "Cordova details worth knowing",
        label: "Notes",
        bullets: [
          "**Signature log:** `configureWith` takes no verification mode, so every RevenueDot response is logged as a failed check with the stock plugin. A self-hosted server signs with its own key, so the noise stays unless you build the forks with your key.",
          "**Migrating from RevenueCat?** Call `Purchases.syncPurchases()` once on the first launch of the update.",
          "**Test Store keys** work in debug builds only.",
          "**Status:** there is no Cordova example app yet.",
        ],
      },
    ],
    howTo: "How to add subscriptions to a Cordova app with RevenueDot",
    faq: [
      {
        q: "How do I add in-app purchases to a Cordova app?",
        a: "Install cordova-plugin-purchases, configure it on deviceready, fetch offerings and call purchasePackage. A backend checks the receipts. With RevenueDot you call Purchases.setProxyURL before configureWith and connect your App Store and Google Play apps.",
      },
      {
        q: "Can I turn off signature verification in the Cordova plugin?",
        a: "No. configureWith has no verification option, so the native default, informational, applies. Every RevenueDot response is logged as a failed check and access is still granted. The RevenueDot fork removes the noise against a server that signs with its key.",
      },
      {
        q: "Does RevenueDot work with Cordova on iOS and Android?",
        a: "Yes, in proxy mode with the plugin you already ship. It uses the same native SDKs as the other RevenueCat wrappers, so the store handling is the same.",
      },
      {
        q: "Will my config.xml change with the fork?",
        a: "No. The plugin id stays cordova-plugin-purchases and the global stays Purchases. The fork is published on npm.",
      },
    ],
    docs: [
      { href: "/docs/sdks/cordova", label: "Cordova guide" },
      { href: "/docs/help/signature-verification-failed", label: "Signature verification failed" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
      { href: "/docs/guides/test-store", label: "Test Store" },
    ],
    related: ["/sdks/capacitor", "/sdks/react-native", "/stores/app-store", "/stores/google-play", "/stores/test-store", "/migrate-from-revenuecat"],
  },

  {
    slug: "unity",
    section: "sdks",
    name: "Unity",
    card: "In-app purchases for Unity games on iOS and Android with the RevenueCat plugin and a proxy URL.",
    label: "SDK",
    title: "In-app purchases and subscriptions for Unity games",
    metaTitle: "In-app purchases and subscriptions for Unity games",
    metaDescription:
      "Add in-app purchases to a Unity game. Fill the Proxy URL field on the Purchases component and set verification to Disabled to use RevenueDot. Free on Cloud.",
    answer:
      "To use RevenueDot in a Unity game, open the GameObject with the Purchases component, set the Proxy URL field to https://api.revenuedot.app and set Entitlement Verification Mode to Disabled. Unity has no public SetProxyURL method, so the Inspector field is the only way. The component applies it before it configures the SDK, also when you configure from code.",
    points: [
      { title: "Inspector setting", text: "Proxy URL sits under Advanced on the Purchases component." },
      { title: "Works with runtime setup", text: "The field still applies when you configure from a script." },
      { title: "iOS and Android", text: "Purchases run on a device or simulator. The Editor uses a no-op wrapper." },
      { title: "Namespaces stay", text: "`using RevenueCat;` keeps working with the planned fork." },
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
            text: "Add credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, a `pro` entitlement and a current offering.",
          },
          {
            name: "Set the Inspector fields",
            text: "On the Purchases component set **Proxy URL** to `https://api.revenuedot.app`, **Entitlement Verification Mode** to **Disabled**, and the Apple and Google API keys to your `appl_` and `goog_` keys.",
          },
          {
            name: "Configure from a script if you use runtime setup",
            text: "Check **Use Runtime Setup** and call `Configure` from a script that runs after `Purchases.Start()`, as in the code below.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `PurchasePackage` and read `customerInfo.Entitlements.Active`.",
          },
        ],
      },
      {
        h2: "The Unity proxy URL setting",
        label: "Inspector",
        table: {
          head: ["Inspector field", "Before", "After"],
          rows: [
            ["Proxy URL (under Advanced)", "empty", "`https://api.revenuedot.app`"],
            ["Entitlement Verification Mode", "Informational", "Disabled"],
            ["Revenue Cat API Key Apple and Google", "your keys", "`appl_` and `goog_` keys from RevenueDot, or your RevenueCat keys if the importer kept them"],
          ],
        },
        code: {
          title: "Proxy URL field and verification in the Inspector",
          label: "Inspector",
          code: `// Inspector: Purchases component → Proxy URL
// https://api.revenuedot.app`,
        },
      },
      {
        h2: "Configure at runtime and make a purchase",
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
        purchases.Configure(Purchases.PurchasesConfiguration.Builder.Init("appl_...")
            .SetEntitlementVerificationMode(Purchases.EntitlementVerificationMode.Disabled)
            .Build());

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
        h2: "The RevenueDot fork package for Unity",
        label: "Fork",
        paras: [
          "The fork lives at [github.com/revenuedot/purchases-unity](https://github.com/revenuedot/purchases-unity). C# namespaces and assembly names stay the same. **It is not published yet (checked October 2026)**, and it cannot build a working app until its native dependencies are published, so use the Inspector setting today.",
        ],
        code: {
          title: "Planned fork install",
          label: "terminal",
          code: `// OpenUPM
openupm add com.revenuedot.purchases-unity`,
        },
      },
      {
        h2: "Unity details worth knowing",
        label: "Notes",
        bullets: [
          "**Editor:** the SDK uses a no-op wrapper in the Unity Editor and makes no requests. Test on a device or simulator.",
          "**Migrating from RevenueCat?** Call `GetComponent<Purchases>().SyncPurchases()` once on the first launch of the update.",
          "**Test Store keys** work in debug builds only.",
          "**Status:** there is no Unity example app yet.",
        ],
      },
    ],
    howTo: "How to add subscriptions to a Unity game with RevenueDot",
    faq: [
      {
        q: "How do I add in-app purchases to a Unity game?",
        a: "Add the RevenueCat Unity plugin, set your store keys on the Purchases component, then fetch offerings and call PurchasePackage. A backend checks the receipts. With RevenueDot you fill the Proxy URL field and set verification to Disabled.",
      },
      {
        q: "Where is the proxy URL in the Unity SDK?",
        a: "In the Inspector, on the Purchases component, under Advanced. Unity has no public SetProxyURL method. The component applies the field before it configures the SDK, also when you use runtime setup.",
      },
      {
        q: "Why does Configure throw a NullReferenceException?",
        a: "Your script ran before Purchases.Start(), which creates the native wrapper. Add [DefaultExecutionOrder(100)] to your script so Unity calls your Start() after the Purchases component's.",
      },
      {
        q: "Can I test Unity purchases in the Editor?",
        a: "No. In the Editor the SDK uses a no-op wrapper and makes no requests. Run on an iOS or Android device or simulator, with a Test Store key in a debug build if you have no store account.",
      },
    ],
    docs: [
      { href: "/docs/sdks/unity", label: "Unity guide" },
      { href: "/docs/sdks/hybrid-common", label: "Hybrid common" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
      { href: "/docs/guides/test-store", label: "Test Store" },
    ],
    related: ["/sdks/android", "/sdks/ios", "/stores/app-store", "/stores/google-play", "/stores/test-store", "/migrate-from-revenuecat"],
  },

  {
    slug: "kotlin-multiplatform",
    section: "sdks",
    name: "Kotlin Multiplatform",
    card: "Subscriptions for Kotlin Multiplatform apps on iOS and Android with purchases-kmp and a proxy URL.",
    label: "SDK",
    title: "In-app purchases and subscriptions for Kotlin Multiplatform apps",
    metaTitle: "In-app purchases for Kotlin Multiplatform apps",
    metaDescription:
      "Add in-app subscriptions to a Kotlin Multiplatform app. Set Purchases.proxyURL, a String, in common code before configure to use RevenueDot on iOS and Android.",
    answer:
      "To add in-app subscriptions to a Kotlin Multiplatform app on RevenueDot, keep purchases-kmp and set Purchases.proxyURL = \"https://api.revenuedot.app\" in common code before Purchases.configure. In purchases-kmp the proxy URL is a String, not a URL. The default verification mode is already DISABLED, so nothing else changes on Android or iOS.",
    points: [
      { title: "Common code", text: "One `proxyURL` assignment covers the Android and iOS targets." },
      { title: "A String", text: "Unlike the native Android SDK, the KMP proxy URL is a `String`." },
      { title: "Verification off", text: "`EntitlementVerificationMode.DISABLED` is the default." },
      { title: "Android caveat", text: "The stock Android SDK underneath still sends diagnostics and events to RevenueCat." },
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
            text: "Add credentials ([App Store](/stores/app-store), [Google Play](/stores/google-play)), then products, a `pro` entitlement and a current offering.",
          },
          {
            name: "Set the proxy URL in common code",
            text: "Assign `Purchases.proxyURL` before `Purchases.configure`, in code shared by both targets.",
          },
          {
            name: "Pass the right key per platform",
            text: "Pass the `appl_` key on iOS and the `goog_` key on Android to `PurchasesConfiguration`.",
          },
          {
            name: "Buy and check the entitlement",
            text: "Call `awaitPurchase(pkg)` and read `customerInfo.entitlements.active`. It throws `PurchasesTransactionException` on failure or cancel.",
          },
        ],
      },
      {
        h2: "The Kotlin Multiplatform proxy URL change",
        label: "Kotlin",
        code: {
          title: "Point the SDK at RevenueDot",
          label: "Kotlin",
          code: `Purchases.proxyURL = "https://api.revenuedot.app"

fun initPurchases(apiKey: String) {
    Purchases.configure(PurchasesConfiguration(apiKey) {
        // DISABLED is the KMP default; keep it.
        verificationMode = EntitlementVerificationMode.DISABLED
    })
}`,
        },
      },
      {
        h2: "Check an entitlement and make a purchase",
        label: "Kotlin",
        code: {
          title: "RevenueCat's API, unchanged",
          label: "Kotlin",
          code: `val customerInfo = Purchases.sharedInstance.awaitCustomerInfo()
val isPro = customerInfo.entitlements.active.containsKey("pro")

val offerings = Purchases.sharedInstance.awaitOfferings()
val pkg = offerings.current?.availablePackages?.firstOrNull() ?: return
val result = Purchases.sharedInstance.awaitPurchase(pkg)
val nowPro = result.customerInfo.entitlements.active.containsKey("pro")`,
        },
      },
      {
        h2: "The RevenueDot fork package for Kotlin Multiplatform",
        label: "Fork",
        paras: [
          "The fork lives at [github.com/revenuedot/purchases-kmp](https://github.com/revenuedot/purchases-kmp). Packages stay `com.revenuecat.purchases.kmp.*`. It builds on RevenueDot's iOS and Android forks, so both trust RevenueDot's signing key and send events to your proxy URL. **It is not on Maven Central yet (checked October 2026)**, so proxy mode is the practical choice today.",
        ],
        code: {
          title: "Planned fork install",
          label: "Gradle",
          code: `implementation("app.revenuedot.purchases:purchases-kmp-core:<version>")`,
        },
      },
      {
        h2: "Kotlin Multiplatform details worth knowing",
        label: "Notes",
        bullets: [
          "**Migrating from RevenueCat?** Call `Purchases.sharedInstance.awaitSyncPurchases()` once from a coroutine on the first launch of the update.",
          "**Test Store keys** work in debug builds only. iOS servers older than the 2026-09-30 fix could not serve Test Store products to the native iOS SDK, so update a self-hosted server.",
          "**Android:** see the [Android SDK page](/sdks/android) for the diagnostics caveat of the stock SDK.",
          "**Status:** there is no Kotlin Multiplatform example app yet. The calls match the Android guide.",
        ],
      },
    ],
    howTo: "How to add subscriptions to a Kotlin Multiplatform app with RevenueDot",
    faq: [
      {
        q: "How do I add in-app purchases to a Kotlin Multiplatform app?",
        a: "Use purchases-kmp in common code, configure it with a store key per platform, fetch offerings and call awaitPurchase. A backend checks the receipts. With RevenueDot you set Purchases.proxyURL, a String, before configure.",
      },
      {
        q: "Is the proxy URL a String or a URL in purchases-kmp?",
        a: "A String. In the native Android SDK it is a java.net.URL, but purchases-kmp takes a plain String, so you write Purchases.proxyURL = \"https://api.revenuedot.app\".",
      },
      {
        q: "Do I need to disable entitlement verification in KMP?",
        a: "No. purchases-kmp already defaults to EntitlementVerificationMode.DISABLED. Never use ENFORCED, because RevenueDot cannot sign with RevenueCat's key and every request would fail.",
      },
      {
        q: "Does RevenueDot work on both iOS and Android targets in KMP?",
        a: "Yes. The proxy URL applies to both targets. Pass the appl_ key on iOS and the goog_ key on Android. On Android the stock SDK underneath still sends diagnostics to RevenueCat.",
      },
    ],
    docs: [
      { href: "/docs/sdks/kotlin-multiplatform", label: "Kotlin Multiplatform guide" },
      { href: "/docs/sdks/android", label: "Android SDK guide" },
      { href: "/docs/sdks/ios", label: "iOS SDK guide" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/sdks/android", "/sdks/ios", "/stores/app-store", "/stores/google-play", "/stores/test-store", "/migrate-from-revenuecat"],
  },
];
