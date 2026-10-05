// Content types for the SEO and AEO landing pages. Writing rules: apps/site/CONTENT.md.
// Text fields accept a tiny inline markdown subset: **bold**, `code` and [text](url). Nothing else.
import type { Faq } from "../site";
import type { FeatureKey as VisualKey } from "./visuals";

/** A source for a claim about another company: label + URL. Every vendor fact needs one. */
export type Source = { label: string; url: string };

/** One step of a how-to; becomes a HowTo step in JSON-LD. */
export type Step = { name: string; text: string };

/** A code sample shown in the site's code frame. */
export type Sample = { title: string; label: string; code: string };

/** A screenshot from docs/assets (repo root) or apps/site/src/assets/screens, by file name without folder. */
export type ShotRef = { src: string; alt: string; caption?: string; /** The dark capture, shown with a dark colour scheme. */ dark?: string };

/** An evidence crop in src/data/evidence.ts, as "Vendor/page/claim", e.g. "RevenueCat/pricing/free-to-2500-then-1-percent". */
export type EvidenceKey = string;

/** A first-party visual in src/data/visuals.ts, by feature key. */
export type { FeatureKey as VisualKey } from "./visuals";

/** A body section. Use only the fields you need. */
export type Block = {
  h2: string;
  label?: string;
  paras?: string[];
  bullets?: string[];
  steps?: Step[];
  code?: Sample;
  shot?: ShotRef;
  table?: { head: string[]; rows: string[][]; caption?: string };
  /** Evidence crops shown under the table or text, visible, with their dated captions and source links. */
  evidence?: EvidenceKey[];
  /** A first-party feature visual (shot, and its clip when `clip` is set) shown after the text. */
  visual?: VisualKey;
  clip?: boolean;
};

/** Feature, store, SDK and solution pages: /features/x, /stores/x, /sdks/x, /solutions/x. */
export type Landing = {
  slug: string;
  section: "features" | "stores" | "sdks" | "solutions";
  /** Short name for nav, cards and breadcrumbs, e.g. "Paywalls". */
  name: string;
  /** One line for hub cards (max ~110 chars). */
  card: string;
  /** Uppercase label above the H1, e.g. "Feature". */
  label: string;
  /** The H1. Says what the page offers in the searcher's words. */
  title: string;
  /** <title>, max 60 characters, without "| RevenueDot". */
  metaTitle: string;
  /** Meta description, 140 to 160 characters. */
  metaDescription: string;
  /** Answer-first paragraph under the H1: 40 to 70 words that fully answer the search. */
  answer: string;
  /** Hero screenshot. */
  shot?: ShotRef;
  /** Three or four short proof points shown as a hairline grid under the hero. */
  points?: { title: string; text: string }[];
  blocks: Block[];
  /** If set, the page gets HowTo JSON-LD from this block's steps (its h2 is the HowTo name). */
  howTo?: string;
  faq: Faq[];
  /** Docs pages on revenuedot.app, e.g. "/docs/guides/paywalls". */
  docs: { href: string; label: string }[];
  /** Other landing pages, integrations, charts or comparisons, as site paths. */
  related: string[];
};

/** /integrations/x. Facts about the integration come from packages/core/src/integrations. */
export type IntegrationPage = {
  /** The `kind` in packages/core/src/integrations, or "webhooks" / "data-exports". */
  kind: string;
  slug: string;
  name: string;
  /** "analytics" | "attribution" | "marketing" | "support" | "ads" | "core" | "data". */
  category: string;
  /** Logo file in apps/site/src/assets/logos, e.g. "segment.svg". */
  logo: string;
  card: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  answer: string;
  /** What teams do with it, 3 to 5 bullets. */
  uses: string[];
  /** What RevenueDot sends: which events, under which names, with which fields. */
  sends: string[];
  setup: Step[];
  blocks?: Block[];
  faq: Faq[];
  /** The partner's own site and its docs for the API we call (sources). */
  partner: Source[];
  docs: { href: string; label: string }[];
  related: string[];
};

/** /charts/x. Facts about the chart come from packages/core/src/charts/catalog.ts and prd/charts/PRD.md. */
export type ChartPage = {
  /** The chart's API name in the catalog, e.g. "mrr". */
  name: string;
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  /** 40 to 60 words: what the number is and how it is calculated. */
  answer: string;
  /** The formula in plain words, e.g. "MRR = sum of each active subscription's price normalised to 30 days". */
  formula?: string;
  /** How RevenueDot computes it: the exact rules (sandbox excluded, USD rate, refunds, trials...). */
  how: string[];
  /** Why it matters: the decisions it drives. */
  why: string[];
  /** How to read it, common mistakes, what moves it. */
  tips: string[];
  /** Optional worked example with small, clearly illustrative numbers. */
  example?: { intro: string; rows: string[][]; head: string[]; result: string };
  faq: Faq[];
  /** Other chart API names. */
  related: string[];
};

/** A product in a comparison. */
export type Vendor = { name: string; url: string };

/** /compare/x: RevenueDot vs a vendor, or vendor vs vendor with RevenueDot as the third column. */
export type ComparePage = {
  slug: string;
  kind: "vs" | "versus";
  /** Column names, RevenueDot first when it is in the table. */
  columns: string[];
  /** Short name for breadcrumbs, cards and the social card. Defaults to the first two columns joined with "vs". */
  short?: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  card: string;
  /** The TL;DR, answer-first, 50 to 80 words, with the honest verdict. */
  answer: string;
  /** "Choose X if" lists, one per column. */
  choose: { name: string; reasons: string[] }[];
  /** Rows: topic, one cell per column, the sources for the cells about other vendors, the evidence crops that show the
   * cited facts (one per claim), and the RevenueDot visual for the RevenueDot cell. */
  rows: { topic: string; cells: string[]; sources: Source[]; evidence?: EvidenceKey[]; visual?: VisualKey }[];
  /** Price table at monthly tracked revenue levels; cells are strings like "$0" or "$1,000". */
  price?: { intro: string; head: string[]; rows: string[][]; sources: Source[]; evidence?: EvidenceKey[] };
  /** The "See it" block: the dashboard tour video plus these feature visuals (clips where they exist). */
  seeIt?: VisualKey[];
  /** A third-party YouTube video from src/data/third-party-videos.ts, by URL; at most one per page. */
  video?: string;
  blocks: Block[];
  faq: Faq[];
  /** Month the vendor facts were checked, e.g. "October 2026". */
  checked: string;
  related: string[];
};

/** One entry on /revenuecat-alternatives. */
export type Alternative = {
  name: string;
  url: string;
  bestFor: string;
  summary: string;
  pricing: string;
  openSource: string;
  selfHost: string;
  pros: string[];
  cons: string[];
  sources: Source[];
  /** Our own comparison page, if any. */
  compare?: string;
  /** Evidence crops: the vendor's homepage hero and its pricing page. */
  evidence?: EvidenceKey[];
  /** For RevenueDot's own entry: a feature shot and a clip. */
  visual?: VisualKey;
  clip?: VisualKey;
};

/** /errors/x: one RevenueCat SDK error code (PurchasesErrorCode), explained for apps on RevenueDot or RevenueCat. */
export type ErrorPage = {
  /** The numeric code, e.g. 7. */
  code: number;
  slug: string;
  /** Swift case name, e.g. "receiptAlreadyInUseError". */
  swift: string;
  /** Kotlin enum name, e.g. "RECEIPT_ALREADY_IN_USE_ERROR" or as the Android SDK spells it. */
  android: string;
  /** Short human name, e.g. "Receipt already in use". */
  name: string;
  metaTitle: string;
  metaDescription: string;
  /** 40 to 70 words: what the error means and the most common fix. */
  answer: string;
  /** When the SDK raises it, from the SDK source: which StoreKit/Play errors or backend codes map to it. */
  causes: string[];
  /** Ordered fixes. */
  fixes: Step[];
  /** Is it safe to retry, should the user see a message, should the app grant access? */
  handling: string[];
  /** Backend error codes (7xxx) that map to this error, with what they mean, when relevant. */
  backend?: { code: number; meaning: string }[];
  /** How RevenueDot's server behaves for this case (only what the code does). */
  revenuedot?: string;
  faq: Faq[];
  related: string[];
};

/** A top-level guide page (/in-app-purchases, /add-in-app-purchases, /do-i-need-revenuecat): a Landing without a section. */
export type Guide = Omit<Landing, "section" | "slug"> & {
  /** The page's URL path, e.g. "/in-app-purchases". */
  path: string;
  /** Breadcrumbs between Home and this page, if any. The page itself is added last. */
  parents?: { name: string; path: string }[];
  /** Second button under the answer. Defaults to the first docs link. */
  secondary?: { href: string; label: string };
  /** Small line under the buttons. */
  note?: string;
};
