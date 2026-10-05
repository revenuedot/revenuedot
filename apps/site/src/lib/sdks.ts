// Every platform's RevenueDot SDK: how a new app installs and configures it (`install`, `configure`), and the one-line
// change for an app switching from RevenueCat (`proxy`). Versions: company/docs/registries.md and docs/docs/sdks/*.md,
// checked 2026-10-05. Sources: README.md and prd/sdk-forks/PRD.md.
export type Sdk = {
  id: string;
  name: string;
  platforms: string;
  language: string;
  repo: string;
  /** How a new app installs the RevenueDot SDK. */
  install: string;
  /** The language of `install`, for the code frame's label. */
  installLabel: string;
  /** Configure on RevenueDot Cloud: only the app's key, because the SDK already points at api.revenuedot.app. */
  configure: string;
  /** Switching from RevenueCat: the one line that points the stock RevenueCat SDK at RevenueDot. */
  proxy: string;
  fork: string;
  forkNote: string;
};

const R = "https://github.com/revenuedot";

export const SDKS: Sdk[] = [
  {
    id: "ios",
    name: "iOS",
    platforms: "iOS, macOS, tvOS, watchOS, visionOS",
    language: "Swift",
    repo: `${R}/purchases-ios`,
    install: `// Swift Package Manager (Xcode: File > Add Package Dependencies)
.package(url: "https://github.com/revenuedot/purchases-ios", exact: "5.91.0-revenuedot")
// or CocoaPods
pod "RevenueDotPurchases", "5.91.0"`,
    installLabel: "Xcode or CocoaPods",
    configure: `import RevenueCat   // the RevenueDot SDK keeps this module name

Purchases.configure(withAPIKey: "appl_...")`,
    proxy: `// Before Purchases.configure
Purchases.proxyURL = URL(string: "https://api.revenuedot.app")!
Purchases.configure(withAPIKey: "appl_...")`,
    fork: `// Swift Package Manager
.package(url: "https://github.com/revenuedot/purchases-ios", exact: "<version>-revenuedot")
// CocoaPods
pod "RevenueDotPurchases"   // still: import RevenueCat`,
    forkNote: "Pod RevenueDotPurchases; SPM from github.com/revenuedot/purchases-ios with -revenuedot tags. import RevenueCat stays.",
  },
  {
    id: "android",
    name: "Android",
    platforms: "Android",
    language: "Kotlin",
    repo: `${R}/purchases-android`,
    install: `// build.gradle.kts
implementation("app.revenuedot.purchases:purchases:10.23.3")`,
    installLabel: "Gradle",
    configure: `// In Application.onCreate()
Purchases.configure(PurchasesConfiguration.Builder(this, "goog_...").build())`,
    proxy: `// Before Purchases.configure
Purchases.proxyURL = URL("https://api.revenuedot.app")`,
    fork: `// build.gradle.kts
implementation("app.revenuedot.purchases:purchases:<version>")
// still: import com.revenuecat.purchases.*`,
    forkNote: "Maven group app.revenuedot.purchases, same artifact ids. Kotlin packages com.revenuecat.purchases.* stay.",
  },
  {
    id: "react-native",
    name: "React Native and Expo",
    platforms: "iOS, Android",
    language: "TypeScript",
    repo: `${R}/react-native-purchases`,
    install: `npm install react-native-purchases@npm:@revenuedot/react-native-purchases@10.10.2`,
    installLabel: "terminal",
    configure: `import Purchases from "react-native-purchases";

Purchases.configure({ apiKey: Platform.OS === "ios" ? "appl_..." : "goog_..." });`,
    proxy: `await Purchases.setProxyURL("https://api.revenuedot.app");`,
    fork: `// package.json: an npm alias keeps every import
"react-native-purchases": "npm:@revenuedot/react-native-purchases@<version>"`,
    forkNote: "npm @revenuedot/react-native-purchases through an alias, so imports do not change.",
  },
  {
    id: "flutter",
    name: "Flutter",
    platforms: "iOS, Android, web",
    language: "Dart",
    repo: `${R}/purchases-flutter`,
    install: `# pubspec.yaml
purchases_flutter:
  git:
    url: "https://github.com/revenuedot/purchases-flutter.git"
    ref: 10.13.2-revenuedot`,
    installLabel: "YAML",
    configure: `import 'package:purchases_flutter/purchases_flutter.dart';

await Purchases.configure(PurchasesConfiguration(Platform.isIOS ? "appl_..." : "goog_..."));`,
    proxy: `await Purchases.setProxyURL("https://api.revenuedot.app");`,
    fork: `# pubspec.yaml
purchases_flutter:
  git:
    url: https://github.com/revenuedot/purchases-flutter
    ref: <version>-revenuedot`,
    forkNote: "Git dependency with -revenuedot tags; the package name purchases_flutter stays. The fork also fixes setProxyURL on Flutter web.",
  },
  {
    id: "web",
    name: "Web",
    platforms: "Browsers",
    language: "TypeScript",
    repo: `${R}/purchases-js`,
    install: `npm install @revenuedot/purchases-js@1.67.0`,
    installLabel: "terminal",
    configure: `import { Purchases } from "@revenuedot/purchases-js";

const purchases = Purchases.configure({ apiKey: "test_...", appUserId });`,
    proxy: `Purchases.configure({
  apiKey: "test_...",
  appUserId,
  httpConfig: { proxyURL: "https://api.revenuedot.app" },
  flags: { collectAnalyticsEvents: false },
});`,
    fork: `// package.json
"@revenuecat/purchases-js": "npm:@revenuedot/purchases-js@<version>"`,
    forkNote: "npm @revenuedot/purchases-js through an alias. The fork also sends analytics events to the proxy URL.",
  },
  {
    id: "capacitor",
    name: "Capacitor and Ionic",
    platforms: "iOS, Android",
    language: "TypeScript",
    repo: `${R}/purchases-capacitor`,
    install: `npm install @revenuecat/purchases-capacitor@npm:@revenuedot/purchases-capacitor@13.6.1`,
    installLabel: "terminal",
    configure: `import { Purchases } from "@revenuecat/purchases-capacitor";

await Purchases.configure({ apiKey: "appl_..." });`,
    proxy: `await Purchases.setProxyURL({ url: "https://api.revenuedot.app" });`,
    fork: `// package.json
"@revenuecat/purchases-capacitor": "npm:@revenuedot/purchases-capacitor@<version>"`,
    forkNote: "Install through the alias so Capacitor's generated native names stay the same.",
  },
  {
    id: "kmp",
    name: "Kotlin Multiplatform",
    platforms: "iOS, Android",
    language: "Kotlin",
    repo: `${R}/purchases-kmp`,
    install: `// build.gradle.kts, commonMain
implementation("app.revenuedot.purchases:purchases-kmp-core:3.10.1")`,
    installLabel: "Gradle",
    configure: `// In common code
Purchases.configure(PurchasesConfiguration(apiKey))`,
    proxy: `Purchases.proxyURL = "https://api.revenuedot.app"`,
    fork: `implementation("app.revenuedot.purchases:purchases-kmp-core:<version>")`,
    forkNote: "Maven app.revenuedot.purchases:purchases-kmp-*. Packages com.revenuecat.purchases.kmp.* stay.",
  },
  {
    id: "unity",
    name: "Unity",
    platforms: "iOS, Android",
    language: "C#",
    repo: `${R}/purchases-unity`,
    install: `openupm add com.revenuedot.purchases-unity`,
    installLabel: "terminal",
    configure: `// Inspector: Purchases component → API keys
// Paste your app's key; RevenueDot Cloud is the default server.`,
    proxy: `// Inspector: Purchases component → Proxy URL
// https://api.revenuedot.app`,
    fork: `// OpenUPM
openupm add com.revenuedot.purchases-unity`,
    forkNote: "OpenUPM com.revenuedot.purchases-unity. using RevenueCat; stays.",
  },
  {
    id: "cordova",
    name: "Cordova",
    platforms: "iOS, Android",
    language: "TypeScript",
    repo: `${R}/cordova-plugin-purchases`,
    install: `cordova plugin add @revenuedot/cordova-plugin-purchases`,
    installLabel: "terminal",
    configure: `Purchases.configureWith({ apiKey: device.platform === "iOS" ? "appl_..." : "goog_..." });`,
    proxy: `Purchases.setProxyURL("https://api.revenuedot.app");`,
    fork: `cordova plugin add @revenuedot/cordova-plugin-purchases`,
    forkNote: "npm @revenuedot/cordova-plugin-purchases. The plugin id and the global Purchases stay.",
  },
];
