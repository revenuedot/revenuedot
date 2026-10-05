// First-party visuals for every feature the comparison, alternatives, pricing and migration pages talk about, so a page
// can put a real picture or clip next to each claim. Every screenshot is the real dashboard (or the real hosted pay
// page, or the real CLI output) captured from the seeded demo project "Scanner" at 1440x900, device scale 2, in both
// colour schemes; the clips are 1280x800 silent recordings of the same app with a cursor (apps/site/public/clips).
// Shots are imported with `import light from "../assets/screens/<file>"` and shown with components/Shot.astro; clips are
// shown with components/Clip.astro by name; videos are the Cloudflare Stream videos in lib/videos.mjs.
export type FeatureKey =
  | "paywalls"
  | "experiments"
  | "targeting"
  | "charts"
  | "customer-center"
  | "refunds"
  | "win-back"
  | "payment-recovery"
  | "web-checkout"
  | "funnels"
  | "redemption-links"
  | "integrations"
  | "webhooks"
  | "customer"
  | "importer"
  | "dual-run"
  | "cloud-billing"
  | "product-editor"
  | "ai"
  | "self-host"
  | "export-move"
  | "enterprise";

export type VideoName = "revenuedot-dashboard-tour" | "revenuedot-chatgpt-demo";

export interface Visual {
  title: string;
  /** Paths relative to apps/site; the dark capture swaps in with the reader's colour scheme (Shot.astro). */
  shot?: { light: string; dark?: string; alt: string; caption: string };
  /** A clip in public/clips: <name>.mp4 and its poster <name>.webp (Clip.astro). */
  clip?: { name: string; alt: string; caption: string };
  video?: VideoName;
  /** The docs or feature page that explains the feature. */
  docs: string;
}

const screens = (name: string) => ({ light: `src/assets/screens/${name}-light.png`, dark: `src/assets/screens/${name}-dark.png` });
// The hosted pay pages follow the app's web config theme, not the reader's colour scheme, so they have one capture.
const payPage = (name: string) => ({ light: `src/assets/screens/${name}-light.png` });
const DEMO = "Captured from the real RevenueDot dashboard with example data.";
const DEMO_CLIP = "Recorded from the real RevenueDot dashboard with example data; silent.";

export const VISUALS: Record<FeatureKey, Visual> = {
  paywalls: {
    title: "Paywalls and the editor",
    shot: {
      ...screens("paywalls"),
      alt: "The RevenueDot paywall editor with the Trial timeline template open: layers on the left, a phone preview of the paywall in the middle with the headline selected, and the selected layer's text, colour and spacing controls on the right.",
      caption: DEMO,
    },
    clip: { name: "paywalls", alt: "Picking the Trial timeline template, creating the paywall, selecting its headline and yearly plan layers and switching the preview between dark and light.", caption: DEMO_CLIP },
    video: "revenuedot-dashboard-tour",
    docs: "https://revenuedot.app/docs/guides/paywalls",
  },
  experiments: {
    title: "Experiments with results",
    shot: {
      ...screens("experiments"),
      alt: "An experiment page in RevenueDot, 'Annual plan first on the paywall': the results panel compares the control and treatment offerings on customers, paywall views, purchases, conversion and revenue, with the treatment's lift and chance to win.",
      caption: DEMO,
    },
    clip: { name: "experiments", alt: "Opening the 'Annual plan first on the paywall' experiment from the list and moving across its results table of control and treatment.", caption: DEMO_CLIP },
    video: "revenuedot-dashboard-tour",
    docs: "https://revenuedot.app/docs/guides/experiments",
  },
  targeting: {
    title: "Targeting rules and audiences",
    shot: {
      ...screens("targeting"),
      alt: "The RevenueDot Targeting page with one live rule, 'US customers see the annual plan first': if the customer matches the United States audience, show the winback offering for the onboarding_end placement and annual_first everywhere else; below it the default offering picker.",
      caption: DEMO,
    },
    clip: { name: "targeting", alt: "Opening the Audiences tab, then New rule: typing a rule name, picking the United States audience and the winback offering in the rule dialog.", caption: DEMO_CLIP },
    docs: "https://revenuedot.app/docs/guides/targeting-and-experiments",
  },
  charts: {
    title: "43 charts",
    shot: {
      ...screens("charts"),
      alt: "The RevenueDot MRR chart segmented by product, with weekly, monthly and yearly plans stacked over the last months, the chart's filters and segment picker above it and the Customers tab below.",
      caption: DEMO,
    },
    clip: { name: "charts", alt: "Moving through the Revenue, Active subscriptions, Trial conversion funnel, Subscription status and MRR movement charts.", caption: DEMO_CLIP },
    video: "revenuedot-dashboard-tour",
    docs: "https://revenuedot.app/charts",
  },
  "customer-center": {
    title: "Customer Center",
    shot: {
      ...screens("customer-center"),
      alt: "The RevenueDot Customer Center editor: the support email, the cancel and refund paths and the offers to show, with the phone preview of the Customer Center open on the right.",
      caption: DEMO,
    },
    clip: { name: "customer-center", alt: "Scrolling the Customer Center editor and opening its phone preview, then switching the preview between dark and light.", caption: DEMO_CLIP },
    docs: "https://revenuedot.app/docs/guides/customer-center",
  },
  refunds: {
    title: "Refund Control",
    shot: {
      ...screens("refunds"),
      alt: "The RevenueDot Refund Control page: a 64% refund rate over 28 days, declined amount and requests, the four policy templates, and the ordered policies 'Renewed in the last day' (prefer full refund) and 'Spent over $40' (prefer no refund) with their conditions.",
      caption: DEMO,
    },
    docs: "https://revenuedot.app/docs/guides/refund-control",
  },
  "win-back": {
    title: "Win-back campaigns",
    shot: {
      ...screens("win-back"),
      alt: "A RevenueDot win-back campaign, 'Lapsed Pro subscribers', active with 3 emails sent: the audience (subscribers whose last subscription ended 3 to 60 days ago), the product and store filters, and the email preview 'Come back to Pro' with its See my offer button.",
      caption: DEMO,
    },
    docs: "https://revenuedot.app/docs/guides/win-back-campaigns",
  },
  "payment-recovery": {
    title: "Payment recovery",
    shot: {
      ...screens("payment-recovery"),
      alt: "The RevenueDot Payment recovery page: 3 subscribers at risk for $29.97 in failed renewals, 3 emails sent, 1 recovered (a 50% recovery rate, $9.99 recovered), and the list of App Store subscribers in billing retry with their grace period end and next email date.",
      caption: DEMO,
    },
    docs: "https://revenuedot.app/docs/guides/payment-recovery",
  },
  "web-checkout": {
    title: "Web checkout and purchase links",
    shot: {
      ...payPage("web-checkout"),
      alt: "A hosted RevenueDot purchase page for the app Scanner, 'Go Pro on the web': Monthly at $9.99 after a 7-day free trial and Annual at $59.99 with a Save 50% badge, a discount code field and a Continue to payment button that leads to Stripe.",
      caption: "The hosted purchase page RevenueDot serves for a purchase link, captured from the running app with example products.",
    },
    clip: { name: "web-checkout", alt: "On the hosted purchase page: switching between the Annual and Monthly plans, opening the discount code field, typing SPRING20 and applying it.", caption: "Recorded from the real hosted purchase page with example products; silent." },
    docs: "https://revenuedot.app/docs/guides/web-billing",
  },
  funnels: {
    title: "Web funnels",
    shot: {
      ...screens("funnels"),
      alt: "The RevenueDot funnel builder with the starter onboarding funnel: the ordered steps on the left, the selected step's phone preview in the middle and its question, answers and design settings on the right, with the hosted page address above.",
      caption: DEMO,
    },
    clip: { name: "funnels", alt: "Opening the onboarding funnel and stepping through its screens: the plan question, the location question, the unlock screen, the welcome screen and the goal question.", caption: DEMO_CLIP },
    docs: "https://revenuedot.app/docs/guides/funnels",
  },
  "redemption-links": {
    title: "Redemption links",
    shot: {
      ...payPage("redemption-links"),
      alt: "The RevenueDot redemption page after a web purchase of Scanner: 'Open Scanner', the instruction to tap on the phone where the app is installed, an Open the app button and the scanner:// redemption link with its token for the phone.",
      caption: "The redemption page RevenueDot serves after a web purchase, captured from the running app with example products.",
    },
    docs: "https://revenuedot.app/docs/guides/redemption-links",
  },
  integrations: {
    title: "36 integrations",
    shot: {
      ...screens("integrations"),
      alt: "The RevenueDot Integrations page scrolled to the Analytics section: cards for Amplitude, Mixpanel, PostHog, Segment, Firebase and the other analytics, engagement and attribution tools, each with its connection status.",
      caption: DEMO,
    },
    clip: { name: "integrations", alt: "Scrolling the Integrations page and opening the Amplitude integration's settings.", caption: DEMO_CLIP },
    docs: "https://revenuedot.app/integrations",
  },
  webhooks: {
    title: "Webhooks with a delivery log",
    shot: {
      ...screens("webhooks"),
      alt: "A RevenueDot webhook, 'Scanner backend', posting to api.scanner.example: deliveries on, production and sandbox, all apps and events, the signature header, and the delivery log of INITIAL_PURCHASE events each delivered with a 200 in a few milliseconds.",
      caption: DEMO,
    },
    docs: "https://revenuedot.app/docs/guides/webhooks",
  },
  customer: {
    title: "The customer page",
    shot: {
      light: "src/assets/screens/customer-detail-light.png",
      dark: "src/assets/screens/customer-detail-dark.png",
      alt: "A customer page in RevenueDot: the app user ID and aliases, the active entitlement and its App Store subscription, attributes such as email and country, the purchase history with renewals, and the events and webhook deliveries for that customer.",
      caption: DEMO,
    },
    docs: "https://revenuedot.app/docs/concepts/customers-and-app-user-ids",
  },
  importer: {
    title: "The importer from RevenueCat",
    shot: {
      ...screens("importer"),
      alt: "Terminal output of 'npx revenuedot import --from-revenuecat --dry-run': the catalog it would create (apps, products, entitlements, offerings, packages, SDK keys kept), 14 customers read with their subscriptions and purchases, and the store credentials to re-enter because RevenueCat cannot export them.",
      caption: "The real output of the importer's dry run against a RevenueCat project copy, rendered as a terminal window.",
    },
    docs: "https://revenuedot.app/docs/migrate/importer",
  },
  "dual-run": {
    title: "The dual run with RevenueCat",
    shot: {
      ...screens("dual-run"),
      alt: "An App Store app's page in RevenueDot, Apple server-to-server notifications: the Apple Server Notification URL to paste into App Store Connect, the green line 'Apple notifications are configured correctly, last received 23 minutes ago', and the field that forwards every notification to RevenueCat or your own server, filled in.",
      caption: DEMO,
    },
    docs: "https://revenuedot.app/docs/migrate/dual-run",
  },
  "cloud-billing": {
    title: "Cloud billing with the $999 cap",
    shot: {
      ...screens("cloud-billing"),
      alt: "The RevenueDot Cloud Billing page for an account on Cloud Standard: $42,000 tracked revenue in October, a bill so far of $160 (0.5% above $10,000, at most $999), the tracked revenue by project, and the Cloud Free, Cloud Standard (current) and Enterprise plan cards.",
      caption: "Captured from the real RevenueDot Cloud billing page with example revenue.",
    },
    docs: "https://revenuedot.app/docs/guides/cloud-billing",
  },
  "product-editor": {
    title: "The product editor",
    shot: {
      ...screens("product-editor"),
      alt: "The RevenueDot product editor at its Review changes step: an uploaded price file with 4 price changes across 3 App Store products, a note about Apple's automatic prices, and the per-territory diff of current and new prices with the percentage change, ready to commit to App Store Connect.",
      caption: DEMO,
    },
    clip: { name: "product-editor", alt: "In the product editor: selecting all products, downloading the price file, uploading the edited file and scrolling the review of price changes by territory.", caption: DEMO_CLIP },
    docs: "https://revenuedot.app/docs/guides/product-editor",
  },
  ai: {
    title: "RevenueDot AI",
    shot: {
      ...screens("ai"),
      alt: "The RevenueDot AI page: the question 'How is revenue doing this month?' answered with the month's revenue, MRR, new and churned subscribers and a comparison with last month, with the suggested questions below.",
      caption: DEMO,
    },
    video: "revenuedot-chatgpt-demo",
    docs: "https://revenuedot.app/docs/guides/revenuedot-ai",
  },
  "self-host": {
    title: "Self-host",
    shot: {
      ...screens("self-host"),
      alt: "The Billing page of a self-hosted RevenueDot server: the owned project Scanner on the Self-hosted plan and the line 'Billing is only on RevenueDot Cloud. This server is self-hosted: free and unmetered, with no limits.'",
      caption: "Captured from a self-hosted RevenueDot server running the same dashboard.",
    },
    docs: "https://revenuedot.app/docs/guides/self-hosting",
  },
  "export-move": {
    title: "Export and move",
    shot: {
      ...screens("export-move"),
      alt: "Project settings, Export and move, in RevenueDot: Export project (every table as JSON Lines plus a manifest, optionally with secrets encrypted with a passphrase) and Move this project to RevenueDot Cloud or another RevenueDot server with an import token.",
      caption: DEMO,
    },
    docs: "https://revenuedot.app/docs/guides/move-projects",
  },
  enterprise: {
    title: "Enterprise: single sign-on and roles",
    shot: {
      ...screens("enterprise-sso"),
      alt: "Organization settings, Single sign-on, in RevenueDot Enterprise: an OpenID Connect connection named Okta turned on, the verified domain acme-visuals.test, and the Require single sign-on switch.",
      caption: "Captured from the real RevenueDot dashboard with the enterprise extension in development mode.",
    },
    clip: { name: "enterprise-roles", alt: "On the organization's Roles page: opening New role, typing a name and description and ticking the View customers, View subscriptions and View purchases scopes.", caption: "Recorded from the real RevenueDot dashboard with the enterprise extension in development mode; silent." },
    docs: "https://revenuedot.app/docs/guides/enterprise",
  },
};

/** Every shot, clip and video a page could use, for a quick check that the files exist. */
export const VISUAL_ASSETS = Object.values(VISUALS).flatMap((v) => [
  ...(v.shot ? [v.shot.light, ...(v.shot.dark ? [v.shot.dark] : [])] : []),
  ...(v.clip ? [`public/clips/${v.clip.name}.mp4`, `public/clips/${v.clip.name}.webp`] : []),
]);
