// Contact-sales leads: the options the form offers, validation and scoring. Shared by the form page (src/pages/contact-sales.astro)
// and the site Worker (worker/index.ts), so both accept exactly the same answers.
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

export const ROLES = [
  ["founder", "Founder or CEO"],
  ["engineering", "CTO or engineering lead"],
  ["product", "Product or growth"],
  ["finance", "Finance or procurement"],
  ["security", "Security or compliance"],
  ["other", "Other"],
] as const;

/** Monthly in-app revenue before Apple and Google fees: the number Cloud and Enterprise are priced on. */
export const REVENUE = [
  ["under_100k", "Under $100K a month"],
  ["100k_500k", "$100K to $500K a month"],
  ["500k_1m", "$500K to $1M a month"],
  ["1m_5m", "$1M to $5M a month"],
  ["5m_plus", "Over $5M a month"],
  ["undisclosed", "Prefer not to say"],
] as const;

export const CURRENT = [
  ["revenuecat", "RevenueCat"],
  ["adapty", "Adapty"],
  ["superwall", "Superwall"],
  ["qonversion", "Qonversion"],
  ["apphud", "Apphud"],
  ["in_house", "Our own StoreKit or Play Billing code"],
  ["none", "Nothing yet"],
  ["other", "Other"],
] as const;

export const NEEDS = [
  ["lower_cost", "Lower cost"],
  ["self_host", "Self-host in our own cloud"],
  ["data_residency", "EU or US data residency"],
  ["sso", "Single sign-on (SAML) and SCIM"],
  ["sla", "Uptime SLA and priority support"],
  ["security_review", "Security review and DPA"],
  ["migration", "Migration help"],
  ["invoicing", "Invoicing or a custom contract"],
] as const;

export const TIMELINE = [
  ["this_month", "This month"],
  ["this_quarter", "This quarter"],
  ["six_months", "In the next 6 months"],
  ["researching", "Just researching"],
] as const;

export const PLATFORMS = [
  ["ios", "iOS"],
  ["android", "Android"],
  ["web", "Web (Stripe)"],
  ["flutter", "Flutter"],
  ["react_native", "React Native or Expo"],
  ["unity", "Unity"],
  ["other", "Other"],
] as const;

type Opt = readonly (readonly [string, string])[];
const keys = (o: Opt) => new Set(o.map(([k]) => k));
export const label = (o: Opt, k: string) => o.find(([v]) => v === k)?.[1] ?? k;
/** "RevenueCat", or "Other (Glassfy)" when they named it. */
export const vendorLabel = (l: { current: string; currentOther?: string }) => (l.current === "other" && l.currentOther ? `Other (${l.currentOther})` : label(CURRENT, l.current));

/** Common consumer mail domains: allowed, but they lower the score. */
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.ru", "yandex.ru", "qq.com", "163.com"]);

export interface Lead {
  name: string;
  email: string;
  company: string;
  role: string;
  phone: string; // E.164, e.g. +14155550132
  phoneCountry: string; // ISO 3166-1 alpha-2
  revenue: string;
  current: string;
  /** What they use when they chose Other. */
  currentOther: string;
  needs: string[];
  timeline: string;
  platforms: string[];
  website: string;
  message: string;
}

export type Score = "hot" | "warm" | "self_serve" | "nurture";
export type Result = { ok: true; lead: Lead } | { ok: false; errors: Record<string, string> };

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const list = (v: unknown, allowed: Set<string>) => [...new Set((Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).filter((x): x is string => typeof x === "string" && allowed.has(x)))];

export function isEmail(s: string) {
  return s.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(s);
}

/** A phone number valid for its country, in E.164. `country` is the picker's value; a number typed with + wins. */
export function parsePhone(raw: string, country: string): { e164: string; country: string } | null {
  const value = raw.trim();
  if (!value || value.length > 40 || !/^[+\d\s().\-]+$/.test(value)) return null;
  const cc = /^[A-Z]{2}$/.test(country) ? (country as CountryCode) : undefined;
  const p = parsePhoneNumberFromString(value, cc);
  if (!p || !p.isValid() || !p.country) return null;
  return { e164: p.number, country: p.country };
}

export function validate(input: Record<string, unknown>): Result {
  const errors: Record<string, string> = {};
  const name = text(input.name, 120);
  const email = text(input.email, 254).toLowerCase();
  const company = text(input.company, 160);
  const role = text(input.role, 40);
  const revenue = text(input.revenue, 40);
  const current = text(input.current, 40);
  const currentOther = current === "other" ? text(input.currentOther, 80) : "";
  const timeline = text(input.timeline, 40);
  const website = text(input.website, 200);
  const message = text(input.message, 4000);
  const phone = parsePhone(text(input.phone, 40), text(input.phoneCountry, 2).toUpperCase());

  if (!name) errors.name = "Enter your name.";
  if (!isEmail(email)) errors.email = "Enter a valid work email, like you@company.com.";
  if (!company) errors.company = "Enter your company name.";
  if (role && !keys(ROLES).has(role)) errors.role = "Choose your role from the list.";
  if (!phone) errors.phone = "Enter a valid phone number for the country you chose.";
  if (!keys(REVENUE).has(revenue)) errors.revenue = "Choose a revenue range, or Prefer not to say.";
  if (!keys(CURRENT).has(current)) errors.current = "Choose what you use today.";
  else if (current === "other" && !currentOther) errors.currentOther = "Tell us which tool you use.";
  if (!keys(TIMELINE).has(timeline)) errors.timeline = "Choose when you want to start.";
  if (website && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(website)) errors.website = "Enter a website like company.com.";
  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    lead: {
      name, email, company, role, revenue, current, currentOther, timeline, website, message,
      phone: phone!.e164, phoneCountry: phone!.country,
      needs: list(input.needs, keys(NEEDS)),
      platforms: list(input.platforms, keys(PLATFORMS)),
    },
  };
}

/** Enterprise-only needs: anything here means a sales conversation even for a small app. */
const ENTERPRISE_NEEDS = new Set(["self_host", "data_residency", "sso", "sla", "security_review", "invoicing"]);

export function score(l: Lead): Score {
  const freeMail = FREE_MAIL.has(l.email.split("@")[1] ?? "");
  const soon = l.timeline === "this_month" || l.timeline === "this_quarter";
  const enterpriseNeed = l.needs.some((n) => ENTERPRISE_NEEDS.has(n));
  const big = l.revenue === "1m_5m" || l.revenue === "5m_plus";
  const mid = l.revenue === "100k_500k" || l.revenue === "500k_1m";
  if (big || (mid && soon)) return "hot";
  if (l.revenue === "under_100k" && !enterpriseNeed) return "self_serve";
  if (l.revenue === "undisclosed") {
    // Declined to share revenue: never sent to self-serve; judge by the other answers.
    if (soon && (enterpriseNeed || l.current === "revenuecat") && !freeMail) return "hot";
    return soon || enterpriseNeed ? "warm" : "nurture";
  }
  if (mid) return "warm";
  if (enterpriseNeed) return soon ? "warm" : "nurture";
  return "nurture";
}

export const SCORE_LABEL: Record<Score, string> = { hot: "Hot", warm: "Warm", self_serve: "Self-serve", nurture: "Nurture" };
