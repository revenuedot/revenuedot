// The docs navigation: sections in reading order (the same order as scripts/gen-llms.mjs in revenuedot/docs),
// short sidebar labels, prev/next, and each page's last commit date from the docs repo's git history.
import { getCollection, type CollectionEntry } from "astro:content";
import { execFileSync } from "node:child_process";
import { docsDir, pagePath, DOCS_REPO } from "./docs-source.mjs";

export type DocEntry = CollectionEntry<"docs">;
export type NavItem = { id: string; href: string; label: string; title: string; description: string };
export type NavSection = { id: string; title: string; blurb: string; dir: string; href: string; items: NavItem[] };

const SECTIONS = [
  { id: "getting-started", title: "Getting started", dir: "docs/getting-started", blurb: "What RevenueDot is, a 5-minute quickstart and the three ways to connect an app.", order: ["README", "quickstart", "connect-your-app"] },
  { id: "concepts", title: "Concepts", dir: "docs/concepts", blurb: "Projects, apps, products, entitlements, offerings, customers, events and sandbox.", order: ["README", "projects-and-apps", "products-and-entitlements", "offerings-and-packages", "customers-and-app-user-ids", "subscriptions-and-events", "sandbox"] },
  { id: "sdks", title: "SDK guides", dir: "docs/sdks", blurb: "Point each RevenueCat SDK at your server, or switch to the RevenueDot fork.", order: ["README", "ios", "android", "react-native", "flutter", "web", "capacitor", "kotlin-multiplatform", "unity", "cordova", "hybrid-common"] },
  { id: "guides", title: "Guides", dir: "docs/guides", blurb: "App Store, Google Play, Amazon Appstore and Stripe setup, webhooks, integrations and data exports, testing, self-hosting and production.", order: ["README", "app-store", "google-play", "amazon-appstore", "stripe", "webhooks", "integrations", "ads", "trusted-entitlements", "test-store", "sandbox-testing", "self-hosting", "upgrades", "backups", "going-to-production", "enterprise", "single-sign-on", "scim", "data-location", "audit-retention-and-exports"] },
  { id: "migrate", title: "Migrate from RevenueCat", dir: "docs/migrate", blurb: "The importer, a side-by-side run, SDK changes, the cutover checklist and what differs.", order: ["README", "importer", "dual-run", "sdk-changes", "cutover-checklist", "what-differs"] },
  { id: "api", title: "API reference", dir: "api", blurb: "SDK endpoints, REST API v1 and v2, extensions, errors and webhook events, from the OpenAPI document.", order: ["README", "authentication", "errors", "sdk-endpoints", "rest-v1", "rest-v2", "extensions", "enterprise", "webhook-events"] },
  { id: "help", title: "Help center", dir: "docs/help", blurb: "Answers to the questions people search: FAQ, troubleshooting and known issues.", order: ["README", "faq", "troubleshooting", "known-issues"] },
];

/** Sidebar labels, shorter than the question-style page titles. Pages not listed fall back to their file name. */
const LABELS: Record<string, string> = {
  "docs/getting-started/README": "What is RevenueDot?",
  "docs/getting-started/quickstart": "Quickstart",
  "docs/getting-started/connect-your-app": "Connect your app",
  "docs/concepts/README": "Overview",
  "docs/concepts/projects-and-apps": "Projects, apps and keys",
  "docs/concepts/products-and-entitlements": "Products and entitlements",
  "docs/concepts/offerings-and-packages": "Offerings and packages",
  "docs/concepts/customers-and-app-user-ids": "Customers and app user IDs",
  "docs/concepts/subscriptions-and-events": "Subscriptions and events",
  "docs/concepts/sandbox": "Sandbox and production",
  "docs/sdks/README": "Which SDKs work",
  "docs/sdks/ios": "iOS",
  "docs/sdks/android": "Android",
  "docs/sdks/react-native": "React Native",
  "docs/sdks/flutter": "Flutter",
  "docs/sdks/web": "Web (purchases-js)",
  "docs/sdks/capacitor": "Capacitor and Ionic",
  "docs/sdks/kotlin-multiplatform": "Kotlin Multiplatform",
  "docs/sdks/unity": "Unity",
  "docs/sdks/cordova": "Cordova",
  "docs/sdks/hybrid-common": "purchases-hybrid-common",
  "docs/guides/README": "Overview",
  "docs/guides/app-store": "App Store",
  "docs/guides/google-play": "Google Play",
  "docs/guides/amazon-appstore": "Amazon Appstore",
  "docs/guides/stripe": "Stripe",
  "docs/guides/webhooks": "Webhooks",
  "docs/guides/integrations": "Integrations",
  "docs/guides/ads": "Ads",
  "docs/guides/trusted-entitlements": "Trusted Entitlements",
  "docs/guides/test-store": "Test Store",
  "docs/guides/sandbox-testing": "Sandbox testing",
  "docs/guides/self-hosting": "Self-hosting",
  "docs/guides/upgrades": "Upgrades",
  "docs/guides/backups": "Backups",
  "docs/guides/going-to-production": "Going to production",
  "docs/guides/win-back-offers": "Win-back offers",
  "docs/guides/offline-entitlements": "Offline entitlements",
  "docs/guides/refund-control": "Refund Control",
  "docs/guides/retention": "Retention offers",
  "docs/guides/win-back-campaigns": "Win-back campaigns",
  "docs/guides/support-integrations": "Support",
  "docs/guides/customer-lists": "Customer lists",
  "docs/guides/enterprise": "Enterprise",
  "docs/guides/single-sign-on": "Single sign-on",
  "docs/guides/scim": "SCIM",
  "docs/guides/data-location": "Data location",
  "docs/guides/audit-retention-and-exports": "Audit retention and exports",
  "docs/migrate/README": "Overview",
  "docs/migrate/importer": "Importer",
  "docs/migrate/dual-run": "Side-by-side run",
  "docs/migrate/sdk-changes": "SDK changes",
  "docs/migrate/cutover-checklist": "Cutover checklist",
  "docs/migrate/what-differs": "What differs",
  "api/README": "Overview",
  "api/authentication": "Authentication",
  "api/errors": "Errors",
  "api/sdk-endpoints": "SDK endpoints",
  "api/rest-v1": "REST API v1",
  "api/rest-v2": "REST API v2",
  "api/extensions": "Extensions",
  "api/enterprise": "Enterprise",
  "api/webhook-events": "Webhook events",
  "docs/help/README": "Overview",
  "docs/help/faq": "FAQ",
  "docs/help/troubleshooting": "Troubleshooting",
  "docs/help/known-issues": "Known issues",
};

const fallbackLabel = (id: string) => {
  const s = id.split("/").pop()!.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

let cache: NavSection[] | undefined;
export async function docsNav(): Promise<NavSection[]> {
  if (cache) return cache;
  const entries = await getCollection("docs");
  const byDir = new Map<string, DocEntry[]>();
  for (const e of entries) {
    const dir = e.id.split("/").slice(0, -1).join("/");
    byDir.set(dir, [...(byDir.get(dir) ?? []), e]);
  }
  const known = new Set(SECTIONS.map((s) => s.dir));
  const stray = [...byDir.keys()].filter((d) => !known.has(d));
  if (stray.length) throw new Error(`Docs folders without a sidebar section: ${stray.join(", ")}. Add them to SECTIONS in src/lib/docs.ts.`);
  cache = SECTIONS.map((s) => {
    const list = byDir.get(s.dir) ?? [];
    const name = (e: DocEntry) => e.id.slice(s.dir.length + 1);
    const ordered = [
      ...s.order.map((o) => list.find((e) => name(e) === o)).filter((e): e is DocEntry => !!e),
      ...list.filter((e) => !s.order.includes(name(e))).sort((a, b) => a.id.localeCompare(b.id)),
    ];
    return {
      id: s.id,
      title: s.title,
      blurb: s.blurb,
      dir: s.dir,
      href: pagePath(`${s.dir}/README.md`)!,
      items: ordered.map((e) => ({ id: e.id, href: pagePath(`${e.id}.md`)!, label: LABELS[e.id] ?? fallbackLabel(e.id), title: e.data.title, description: e.data.description })),
    };
  });
  return cache;
}

/** URL slug under /docs for an entry id: docs/concepts/sandbox → concepts/sandbox, api/README → api. */
export const docSlug = (id: string) => pagePath(`${id}.md`)!.replace(/^\/docs\/?/, "");

/** The page's GitHub edit link. API pages are generated, so they link to the OpenAPI source instead. */
export function editUrl(id: string) {
  return id.startsWith("api/") ? `${DOCS_REPO}/tree/main/scripts/openapi` : `${DOCS_REPO}/edit/main/${id}.md`;
}

let dates: Map<string, string> | undefined;
/** Last commit date (YYYY-MM-DD) of a docs-repo file, from one `git log` over the whole repo. */
export function lastModified(rel: string): string | undefined {
  if (!dates) {
    dates = new Map();
    try {
      const out = execFileSync("git", ["-C", docsDir(), "log", "--format=@%cs", "--name-only"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      let current = "";
      for (const line of out.split("\n")) {
        if (line.startsWith("@")) current = line.slice(1);
        else if (line && !dates.has(line)) dates.set(line, current);
      }
    } catch {
      // Not a git checkout (for example a tarball): pages simply show no date.
    }
  }
  return dates.get(rel);
}

export type BlogEntry = CollectionEntry<"blog">;
export type BlogPost = { entry: BlogEntry; slug: string; href: string; title: string; description: string; date: string; author?: string; image?: string };

/** Published blog posts, newest first. blog/README.md is the index text, not a post. */
export async function blogPosts(): Promise<BlogPost[]> {
  const entries = await getCollection("blog", (e) => e.id !== "blog/README" && !e.data.draft);
  return entries
    .map((entry) => {
      const slug = entry.id.slice("blog/".length);
      const date = entry.data.date ? entry.data.date.toISOString().slice(0, 10) : lastModified(`${entry.id}.md`) ?? "";
      return { entry, slug, href: `/blog/${slug}`, title: entry.data.title, description: entry.data.description, date, author: entry.data.author, image: entry.data.image };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}
