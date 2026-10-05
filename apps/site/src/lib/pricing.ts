// Plans, the canonical price words and the price maths. Source: company/docs/business-model.md (private repo) and
// prd/cloud-billing/PRD.md, decided 2026-10-05: two plans, Pro and Enterprise. Every page takes its price words from here.
export type Plan = {
  id: "pro" | "enterprise";
  name: string;
  /** The card's big line, as on RevenueCat's pricing page ("Start for free", "Custom pricing"). */
  headline: string;
  price: string;
  priceNote: string;
  summary: string;
  features: string[];
  cta: { label: string; href: string };
};

export const CLOUD_FREE_UP_TO = 10_000; // USD tracked revenue a month that Pro charges nothing for
export const CLOUD_RATE = 0.005; // 0.5% of tracked revenue above $10,000
export const CLOUD_CAP = 999; // USD a month
export const PRO_LIMIT = 1_000_000; // Pro is for apps up to $1M a month; above that, Enterprise
export const RC_FREE_UP_TO = 2_500; // RevenueCat: free up to $2,500 monthly tracked revenue
export const RC_RATE = 0.01; // then 1% of all tracked revenue, not only the part above $2,500 (https://www.revenuecat.com/pricing)
export const GRACE_DAYS = 14; // days after an account's first live sale to start Pro

export const SIGNUP_CTA = "Start for free";

/** The canonical words (prd/cloud-billing/PRD.md, "Canonical copy"). */
export const PRICE_LINE = "$0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month.";
export const PRICE_SHORT = "Free until $10K a month, then 0.5%, capped at $999.";
export const CARD_RULE = "Building and testing are free, no card needed. Add a card when you go live; Pro costs $0 until your apps make $10,000 a month.";
export const STATUS_PRICE = "RevenueDot Cloud Pro is free until your apps make $10,000 a month, then 0.5% of revenue above that, never more than $999 a month; Enterprise is custom.";
export const ENTERPRISE_PRICE = "Custom pricing from $50,000 a year";

export const PRO_INCLUDED = [
  "Paywalls with a visual editor and templates",
  "Experiments and price tests",
  "43 revenue charts",
  "36 integrations and webhooks",
  "Web checkout with your own Stripe",
  "Unlimited apps, projects and teammates",
  "Organizations and custom roles",
  "Single sign-on with SAML 2.0 or OpenID Connect",
  "Email support, first reply within 2 business days",
];

export const PLANS: Plan[] = [
  {
    id: "pro",
    name: "Pro",
    headline: "Start for free",
    price: "$0",
    priceNote: "until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month",
    summary: "Pay nothing until your apps make $10,000 a month. Then pay 0.5% of the revenue above $10,000, and never more than $999 a month. The rate never rises. For apps up to $1M a month.",
    features: PRO_INCLUDED,
    cta: { label: SIGNUP_CTA, href: "https://app.revenuedot.app/signup" },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    headline: "Custom pricing",
    price: "$50K",
    priceNote: "a year to start, custom pricing and usage",
    summary: "For apps above $1M a month and companies with security and compliance rules: volume pricing, an uptime SLA, fast help and the paperwork your security team asks for.",
    features: [
      "Volume pricing for apps above $1M a month",
      "SCIM provisioning",
      "Audit log kept from 30 days to 10 years",
      "Signed compliance exports of the audit log and access review",
      "99.9% uptime SLA on purchases, with service credits",
      "Help within 1 hour when purchases fail, and a named engineer",
      "A DPA and answers to your security review",
      "A commercial license to run RevenueDot on your own servers",
    ],
    cta: { label: "Contact sales", href: "/contact-sales" },
  },
];

/** RevenueDot Pro bill for a month of tracked revenue (USD). */
export function cloudBill(mtr: number): number {
  return Math.min(CLOUD_CAP, Math.max(0, mtr - CLOUD_FREE_UP_TO) * CLOUD_RATE);
}

/** RevenueCat's published price for a month of tracked revenue (USD): once tracked revenue reaches $2,500, 1% of all of it
 * (pricing page FAQ: "For $2.5K, we'll charge you $25"; staff reply https://community.revenuecat.com/general-questions-7/questions-about-pro-plan-payments-3618). */
export function revenueCatBill(mtr: number): number {
  return mtr >= RC_FREE_UP_TO ? mtr * RC_RATE : 0;
}

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
