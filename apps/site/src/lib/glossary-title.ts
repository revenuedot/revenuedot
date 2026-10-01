// The question form of a glossary term for its H1 and social card: "What is a billing grace period?".
const NONE = new Set(["churn", "proration", "billing-retry", "family-sharing", "sandbox-testing", "receipt-validation", "web-to-app", "price-increase-consent", "account-hold", "mrr", "ltv", "arpu", "trial-conversion-rate", "monthly-tracked-revenue", "storekit-2", "chargeback-and-voided-purchase"]);
const THE = new Set(["app-store-server-notifications-v2", "app-store-server-api", "google-play-billing-library", "small-business-program", "customer-center", "real-time-developer-notifications"]);
const ARE: Record<string, string> = {
  "consumable-and-non-consumable-in-app-purchase": "What are consumable and non-consumable in-app purchases?",
  "upgrade-downgrade-crossgrade": "What are upgrades, downgrades and crossgrades?",
  "base-plan-and-offer": "What are base plans and offers on Google Play?",
  "chargeback-and-voided-purchase": "What are chargebacks and voided purchases?",
  "app-store-server-notifications-v2": "What are App Store Server Notifications V2?",
  "real-time-developer-notifications": "What are Google Play real-time developer notifications (RTDN)?",
  "hard-paywall": "What is a hard paywall, and how is it different from a soft paywall?",
  "customer-center": "What is a Customer Center, and what is the manage subscription URL?",
  "family-sharing": "What is Family Sharing for in-app purchases?",
  "small-business-program": "What is the App Store Small Business Program?",
  "proration": "What is proration on Google Play?",
};
export function termQuestion(slug: string, term: string): string {
  if (ARE[slug]) return ARE[slug];
  const t = /^[A-Z]{2,}|^[A-Z][a-z]*[A-Z]|^App Store|^Google|^StoreKit|^JWS|\s[A-Z][a-z]/.test(term.replace(/\s*\(.*\)/, "")) ? term : term.charAt(0).toLowerCase() + term.slice(1);
  if (NONE.has(slug)) return `What is ${t}?`;
  if (THE.has(slug)) return `What is the ${t}?`;
  return `What is ${/^[aeiou]/i.test(t) ? "an" : "a"} ${t}?`;
}
