// The one-line proxy change and the fork package for every RevenueCat SDK. Sources: README.md and prd/sdk-forks/PRD.md.
export type Sdk = {
  id: string;
  name: string;
  platforms: string;
  language: string;
  repo: string;
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
    proxy: `Purchases.configure({
  apiKey: "rcb_...",
  appUserId,
  httpConfig: { proxyURL: "https://api.revenuedot.app" },
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
    proxy: `Purchases.setProxyURL("https://api.revenuedot.app");`,
    fork: `cordova plugin add @revenuedot/cordova-plugin-purchases`,
    forkNote: "npm @revenuedot/cordova-plugin-purchases. The plugin id and the global Purchases stay.",
  },
];
