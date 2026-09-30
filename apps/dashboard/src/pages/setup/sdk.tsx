import { useState } from "react";
import { CodeBlock, Tabs } from "../../components/ui";
import type { AppType } from "./data";

type Platform = "ios" | "android" | "react-native" | "flutter";

/** The one change an app needs: the SDK's proxy URL, set before configure, plus this app's public key. */
export function snippet(platform: Platform, origin: string, key: string): string {
  switch (platform) {
    case "ios":
      return `import RevenueCat

// In your App init or application(_:didFinishLaunchingWithOptions:)
Purchases.proxyURL = URL(string: "${origin}")!   // before configure
Purchases.configure(withAPIKey: "${key}")`;
    case "android":
      return `import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.PurchasesConfiguration
import java.net.URL

// In Application.onCreate()
Purchases.proxyURL = URL("${origin}")   // before configure
Purchases.configure(PurchasesConfiguration.Builder(this, "${key}").build())`;
    case "react-native":
      return `import Purchases from "react-native-purchases";

// Once, when your app starts
await Purchases.setProxyURL("${origin}");   // before configure
Purchases.configure({ apiKey: "${key}" });`;
    case "flutter":
      return `import 'package:purchases_flutter/purchases_flutter.dart';

// Once, in main() before runApp
await Purchases.setProxyURL("${origin}");   // before configure
await Purchases.configure(PurchasesConfiguration("${key}"));`;
  }
}

const TABS: { value: Platform; label: string }[] = [
  { value: "ios", label: "iOS" }, { value: "android", label: "Android" }, { value: "react-native", label: "React Native" }, { value: "flutter", label: "Flutter" },
];

/** SDK setup tabs; the store decides which platform is shown first. */
export function SdkSetup({ type, origin, publicKey }: { type: AppType; origin: string; publicKey: string }) {
  const [p, setP] = useState<Platform>(type === "play_store" || type === "amazon" ? "android" : "ios");
  return (
    <div className="stack tight">
      <Tabs label="Platform" idBase="sdk" value={p} tabs={TABS} onChange={setP} />
      <div role="tabpanel" id={`sdk-${p}-panel`} aria-labelledby={`sdk-${p}`}>
        <CodeBlock label={TABS.find((t) => t.value === p)!.label} code={snippet(p, origin, publicKey)} />
      </div>
    </div>
  );
}
