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
export const RC_RATE = 0.01; // then 1% of all tracked revenue, not only the part above $2,500 (https://www.revenuecat.com/pricing)

export const PLANS: Plan[] = [
  {
    id: "cloud-free",
    name: "Cloud Free",
    price: "$0",
    priceNote: "up to $10K monthly tracked revenue",
    summary: "RevenueDot Cloud, hosted by us, free while your app tracks up to $10,000 a month.",
    available: true,
    features: [
      "Hosted API and dashboard, nothing to run",
      "The whole open-source core: paywalls, experiments, charts and integrations",
      "Unlimited apps, projects and teammates",
      "Admin, Developer and Viewer roles",
      "Audit log kept for 90 days",
      "Community and email support",
    ],
    cta: { label: "Start free", href: "https://app.revenuedot.app/signup" },
  },
  {
    id: "cloud-standard",
    name: "Cloud Standard",
    price: "0.5%",
    priceNote: "of tracked revenue above $10K, capped at $999 a month",
    summary: "For growing apps up to $1M a month. Upgrade any time from Billing in the dashboard; below $10K a month it still costs $0.",
    available: true,
    features: [
      "Everything in Cloud Free",
      "Organizations that group projects and people",
      "Custom roles",
      "Single sign-on with SAML 2.0 or OpenID Connect",
      "Never more than $999 a month, and your rate never rises",
      "Email support, first reply within 2 business days",
    ],
    cta: { label: "Start free, upgrade any time", href: "https://app.revenuedot.app/signup" },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "$50K",
    priceNote: "a year to start, custom pricing",
    summary: "For large apps and companies: no revenue limit, an uptime SLA, fast support and the paperwork your security team asks for.",
    available: true,
    features: [
      "Everything in Cloud Standard",
      "SCIM provisioning and audit logs kept up to 10 years",
      "Signed compliance exports of the audit log and access review",
      "A commercial license if you must run your own server",
      "99.9% uptime SLA on purchases, with service credits",
      "Help within 1 hour when purchases fail, and a named engineer",
    ],
    cta: { label: "Contact sales", href: "/contact-sales" },
  },
];

/** RevenueDot Cloud bill for a month of tracked revenue (USD). */
export function cloudBill(mtr: number): number {
  return Math.min(CLOUD_CAP, Math.max(0, mtr - CLOUD_FREE_UP_TO) * CLOUD_RATE);
}

/** RevenueCat's published price for a month of tracked revenue (USD): once tracked revenue reaches $2,500, 1% of all of it
 * (pricing page FAQ: "For $2.5K, we'll charge you $25"; staff reply https://community.revenuecat.com/general-questions-7/questions-about-pro-plan-payments-3618). */
export function revenueCatBill(mtr: number): number {
  return mtr >= RC_FREE_UP_TO ? mtr * RC_RATE : 0;
}

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
