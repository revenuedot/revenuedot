// Public changelog. Newest first. Each entry says what shipped in plain words; link to code where it helps.
export type Entry = { date: string; title: string; items: string[]; tag: "Server" | "Dashboard" | "Migration" | "SDKs" | "Project" };

export const CHANGELOG: Entry[] = [
  {
    date: "2026-10-04",
    title: "Customer history keeps purchases in view",
    tag: "Server",
    items: [
      "Event lists (a customer's events and the project event log) leave out paywall events by default. Pass include_paywall_events=true, or name the types in type, to get them.",
      "The customer history pages from the database, and the Customer page has a Show paywall events switch.",
    ],
  },
  {
    date: "2026-09-30",
    title: "SDK forks and signed responses",
    tag: "SDKs",
    items: [
      "Hard forks of all ten RevenueCat SDKs under github.com/revenuedot, with a pipeline that re-applies our patches after every upstream release.",
      "The server signs SDK responses the way the SDKs verify them, so apps on the forks get verified entitlements.",
    ],
  },
  {
    date: "2026-09-30",
    title: "Migration importer",
    tag: "Migration",
    items: [
      "npx revenuedot import copies a RevenueCat project: apps and SDK keys, products, entitlements, offerings, customers, aliases, attributes and purchases.",
      "import verify compares active entitlements customer by customer; import plan prints the cutover steps.",
      "A bulk import endpoint writes history without sending webhooks.",
    ],
  },
  {
    date: "2026-09-30",
    title: "Dashboard",
    tag: "Dashboard",
    items: [
      "Overview metrics (MRR, active subscriptions, trials, revenue, new and active customers) with recent transactions and setup health.",
      "Customers with purchase history and entitlement grants; offerings, products and entitlements; apps, API keys, webhooks with a delivery log, and project settings.",
      "Sign-up, sign-in and a first-run checklist with a Test Store purchase.",
    ],
  },
  {
    date: "2026-09-30",
    title: "App Store and Google Play",
    tag: "Server",
    items: [
      "StoreKit 2 signed transactions, StoreKit 1 receipts, the App Store Server API and Server Notifications v2.",
      "Google Play Developer API, real-time developer notifications, acknowledgement and a daily voided-purchases scan.",
      "Store actions: Google refunds, revokes, cancels and deferrals; Apple subscription extensions.",
      "Notification forwarding to RevenueCat for a side-by-side run.",
    ],
  },
  {
    date: "2026-09-30",
    title: "RevenueCat-compatible API",
    tag: "Server",
    items: [
      "All 37 SDK endpoints, checked against the RevenueCat SDKs' own test fixtures.",
      "REST API v1 and v2 core, validated against RevenueCat's published OpenAPI schemas.",
      "Webhooks with the same event names and payloads, an Authorization header, HMAC signatures and 5 retries.",
      "Entitlement engine: grace periods, billing retry, refunds, upgrades, lifetime purchases, promotional grants and transfers.",
    ],
  },
  {
    date: "2026-09-30",
    title: "Self-host and foundations",
    tag: "Project",
    items: [
      "docker compose up runs the API, dashboard and Postgres from one image.",
      "Brand kit, locked design system and the public repositories on GitHub.",
    ],
  },
];
