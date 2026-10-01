// Published pricing rules of subscription platforms, as monthly cost for a month of tracked revenue (USD, before the
// store's cut). Checked October 2026 against each vendor's pricing page; the same rules drive /compare and /tools.
import type { Source } from "../data/types";
import { CLOUD_CAP, CLOUD_FREE_UP_TO, CLOUD_RATE } from "./pricing";

export type VendorRule = {
  id: string;
  name: string;
  /** How the rule reads in words. */
  rule: string;
  sources: Source[];
  /** The rule as data, so the calculator in the browser uses the same numbers: free below `from`; at or above it,
   *  `rate` of all revenue ("all") or of the revenue above `from` ("above"), capped at `cap`. */
  calc: { from: number; rate: number; basis: "all" | "above"; cap?: number };
  note?: string;
};

export const VENDORS: VendorRule[] = [
  {
    id: "revenuecat",
    name: "RevenueCat",
    rule: "Free under $2,500 a month; from $2,500, 1% of all tracked revenue",
    sources: [
      { label: "RevenueCat pricing", url: "https://www.revenuecat.com/pricing" },
      { label: "RevenueCat staff answer", url: "https://community.revenuecat.com/general-questions-7/questions-about-pro-plan-payments-3618" },
    ],
    calc: { from: 2500, rate: 0.01, basis: "all" },
  },
  {
    id: "adapty",
    name: "Adapty",
    rule: "Free under $5,000 a month; above that, 1% of the month's revenue",
    sources: [{ label: "Adapty pricing", url: "https://adapty.io/pricing/" }],
    calc: { from: 5000, rate: 0.01, basis: "all" },
    note: "Add-ons such as Refund Saver and attribution cost extra.",
  },
  {
    id: "qonversion",
    name: "Qonversion",
    rule: "Free up to $7,000 a month; above that, 0.8% of all tracked revenue",
    sources: [{ label: "Qonversion pricing", url: "https://qonversion.io/pricing" }],
    calc: { from: 7000.01, rate: 0.008, basis: "all" },
  },
  {
    id: "superwall",
    name: "Superwall",
    rule: "Infrastructure free; paywalls free to $10,000 of paywall revenue, then 1% (upper bound shown)",
    sources: [{ label: "Superwall pricing", url: "https://superwall.com/pricing" }],
    calc: { from: 10000.01, rate: 0.01, basis: "all" },
    note: "Superwall bills only revenue that converts through its paywalls, so the real bill is between $0 and this figure.",
  },
  {
    id: "rdcloud",
    name: "RevenueDot Cloud",
    rule: `Free up to $10,000 a month; planned: ${CLOUD_RATE * 100}% of revenue above $10,000, capped at $${CLOUD_CAP}`,
    sources: [{ label: "RevenueDot pricing", url: "/pricing" }],
    calc: { from: CLOUD_FREE_UP_TO, rate: CLOUD_RATE, basis: "above", cap: CLOUD_CAP },
    note: "The paid Cloud plan is planned and not charged yet.",
  },
  {
    id: "rdself",
    name: "RevenueDot self-hosted",
    rule: "Free and open source (AGPL-3.0); you pay for your own server",
    sources: [{ label: "Self-host RevenueDot", url: "/self-host" }],
    calc: { from: Infinity, rate: 0, basis: "all" },
  },
];

export function cost(v: VendorRule, mtr: number): number {
  const { from, rate, basis, cap } = v.calc;
  if (mtr < from) return 0;
  const fee = (basis === "all" ? mtr : mtr - from) * rate;
  return cap === undefined ? fee : Math.min(cap, fee);
}

/** Apple and Google commission rules for the store fee calculator. */
export const STORE_SOURCES: Source[] = [
  { label: "Apple: App Store Small Business Program", url: "https://developer.apple.com/app-store/small-business-program/" },
  { label: "Apple: auto-renewable subscriptions (85% after one year)", url: "https://developer.apple.com/app-store/subscriptions/" },
  { label: "Google Play: service fees", url: "https://support.google.com/googleplay/android-developer/answer/112622?hl=en" },
];
