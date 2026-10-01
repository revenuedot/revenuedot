import { useState } from "react";
import { CodeBlock, Tabs } from "../../components/ui";
import type { AppType } from "./data";

type Platform = "ios" | "android" | "react-native" | "flutter" | "curl" | "node";

/** The one change an app needs: the SDK's proxy URL, set before configure, plus this app's public key. */
export function snippet(platform: Platform, origin: string, key: string, type: AppType = "app_store"): string {
  const amazon = type === "amazon";
  switch (platform) {
    case "ios":
      return `import RevenueCat

// In your App init or application(_:didFinishLaunchingWithOptions:)
Purchases.proxyURL = URL(string: "${origin}")!   // before configure
Purchases.configure(withAPIKey: "${key}")`;
    case "android":
      return amazon ? `import com.revenuecat.purchases.AmazonConfiguration
import com.revenuecat.purchases.Purchases
import java.net.URL

// In Application.onCreate() of your Amazon build
Purchases.proxyURL = URL("${origin}")   // before configure
Purchases.configure(AmazonConfiguration.Builder(this, "${key}").build())` : `import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.PurchasesConfiguration
import java.net.URL

// In Application.onCreate()
Purchases.proxyURL = URL("${origin}")   // before configure
Purchases.configure(PurchasesConfiguration.Builder(this, "${key}").build())`;
    case "react-native":
      return `import Purchases from "react-native-purchases";

// Once, when your app starts
await Purchases.setProxyURL("${origin}");   // before configure
Purchases.configure({ apiKey: "${key}"${amazon ? ", useAmazon: true" : ""} });`;
    case "flutter":
      return `import 'package:purchases_flutter/purchases_flutter.dart';

// Once, in main() before runApp
await Purchases.setProxyURL("${origin}");   // before configure
await Purchases.configure(${amazon ? "AmazonConfiguration" : "PurchasesConfiguration"}("${key}"));`;
    case "curl":
      return `# From your backend, after customer.subscription.created or checkout.session.completed
curl -X POST "${origin}/v1/receipts" \\
  -H "Authorization: Bearer ${key}" \\
  -H "X-Platform: stripe" \\
  -H "Content-Type: application/json" \\
  -d '{ "app_user_id": "user_123", "fetch_token": "sub_1Abc..." }'   # or a Checkout Session id (cs_...)`;
    case "node":
      return `// From your Stripe webhook handler or checkout success route
await fetch("${origin}/v1/receipts", {
  method: "POST",
  headers: { Authorization: "Bearer ${key}", "X-Platform": "stripe", "Content-Type": "application/json" },
  body: JSON.stringify({ app_user_id: userId, fetch_token: subscription.id }), // or session.id (cs_...)
});`;
  }
}

const TABS: { value: Platform; label: string }[] = [
  { value: "ios", label: "iOS" }, { value: "android", label: "Android" }, { value: "react-native", label: "React Native" }, { value: "flutter", label: "Flutter" },
];
const AMAZON_TABS = TABS.filter((t) => t.value !== "ios");
const SERVER_TABS: { value: Platform; label: string }[] = [{ value: "curl", label: "curl" }, { value: "node", label: "Node.js" }];

/** SDK setup tabs; the store decides which platforms are offered and which is shown first. Stripe purchases are posted by a server. */
export function SdkSetup({ type, origin, publicKey }: { type: AppType; origin: string; publicKey: string }) {
  const tabs = type === "stripe" ? SERVER_TABS : type === "amazon" ? AMAZON_TABS : TABS;
  const [p, setP] = useState<Platform>(type === "stripe" ? "curl" : type === "play_store" || type === "amazon" ? "android" : "ios");
  return (
    <div className="stack tight">
      <Tabs label="Platform" idBase="sdk" value={p} tabs={tabs} onChange={setP} />
      <div role="tabpanel" id={`sdk-${p}-panel`} aria-labelledby={`sdk-${p}`}>
        <CodeBlock label={tabs.find((t) => t.value === p)!.label} code={snippet(p, origin, publicKey, type)} />
      </div>
    </div>
  );
}
