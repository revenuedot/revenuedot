// Plans and the price maths. Source of the numbers: company/docs/business-model.md (private repo), decided 2026-09-30.
export type Plan = {
  id: string;
  name: string;
  price: string;
  priceNote: string;
  summary: string;
  available: boolean;
  features: string[];
  cta: { label: string; href: string };
};

export const CLOUD_FREE_UP_TO = 10_000; // USD monthly tracked revenue
export const CLOUD_RATE = 0.005; // 0.5% of tracked revenue above the free amount
export const CLOUD_CAP = 999; // USD a month
export const RC_FREE_UP_TO = 2_500; // RevenueCat: free up to $2,500 monthly tracked revenue
export const RC_RATE = 0.01; // then 1% of tracked revenue above that (https://www.revenuecat.com/pricing)

export const PLANS: Plan[] = [
  {
    id: "self-host",
    name: "Self-host",
    price: "$0",
    priceNote: "free forever, AGPL-3.0",
    summary: "Run the open-source server on your own infrastructure with Docker and Postgres. No revenue share and no limits.",
    available: true,
    features: [
      "The full open-source server and dashboard",
      "Unlimited apps, customers and tracked revenue",
      "Your own Postgres, in the region you choose",
      "Works with the RevenueCat SDK or our MIT forks",
      "Community support on GitHub",
    ],
    cta: { label: "Self-host free", href: "/self-host" },
  },
  {
    id: "cloud-free",
    name: "Cloud Free",
    price: "$0",
    priceNote: "up to $10K monthly tracked revenue",
    summary: "RevenueDot Cloud, hosted by us, free while your app tracks up to $10,000 a month.",
    available: true,
    features: [
      "Hosted API and dashboard, nothing to run",
      "Up to $10,000 monthly tracked revenue",
      "Same code and API as self-host, so you can move either way",
      "Webhooks, REST API and the importer",
      "Email and community support",
    ],
    cta: { label: "Request early access", href: "mailto:hello@revenuedot.app?subject=RevenueDot%20Cloud%20early%20access" },
  },
  {
    id: "cloud-standard",
    name: "Cloud Standard",
    price: "0.5%",
    priceNote: "of tracked revenue above $10K, capped at $999 a month",
    summary: "For growing apps: 0.5% of tracked revenue above $10,000 a month, never more than $999 a month. The rate is locked and never rises.",
    available: false,
    features: [
      "Everything in Cloud Free",
      "Your bill never passes $999 a month",
      "Price lock: your rate never rises",
      "For apps up to $1M monthly tracked revenue",
      "Email support",
    ],
    cta: { label: "Watch on GitHub", href: "https://github.com/revenuedot/revenuedot" },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "$50K",
    priceNote: "a year, on standard terms",
    summary: "Cloud with a support promise, or a commercial license to self-host in your own account, with single sign-on, audit logs and data-location controls.",
    available: false,
    features: [
      "SSO/SAML, SCIM and audit logs",
      "EU and US data regions, or your own cloud",
      "High-availability self-host and an SLA",
      "Commercial license for the ee/ folder",
      "Self-serve, standard terms",
    ],
    cta: { label: "Contact us", href: "mailto:hello@revenuedot.app?subject=RevenueDot%20Enterprise" },
  },
];

/** RevenueDot Cloud bill for a month of tracked revenue (USD). */
export function cloudBill(mtr: number): number {
  return Math.min(CLOUD_CAP, Math.max(0, mtr - CLOUD_FREE_UP_TO) * CLOUD_RATE);
}

/** RevenueCat's published price for a month of tracked revenue (USD): 1% of tracked revenue above $2,500. */
export function revenueCatBill(mtr: number): number {
  return Math.max(0, mtr - RC_FREE_UP_TO) * RC_RATE;
}

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
