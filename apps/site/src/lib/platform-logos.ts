// Logo file for a store, SDK or platform page slug, when one exists.
import { hasLogo, logo } from "./logos";
const MAP: Record<string, string> = {
  "app-store": "app-store.svg", "google-play": "google-play.svg", "amazon-appstore": "amazon.svg", stripe: "stripe.svg",
  ios: "apple.svg", android: "android-icon.svg", "react-native": "react.svg", expo: "expo-icon.svg", flutter: "flutter.svg",
  web: "javascript.svg", "purchases-js": "javascript.svg", capacitor: "ionic-icon.svg", cordova: "cordova.svg", unity: "unity.svg",
  "kotlin-multiplatform": "kotlin-icon.svg", kmp: "kotlin-icon.svg",
};
export const platformLogo = (slug: string) => (MAP[slug] && hasLogo(MAP[slug]) ? logo(MAP[slug]) : undefined);
