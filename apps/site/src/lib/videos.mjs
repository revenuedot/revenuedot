// Videos hosted on Cloudflare Stream (Circo account). Pages and docs link the stable revenuedot.app/videos/<name>.mp4
// address, which public/_redirects sends to Stream's MP4 download; on the site the same link renders Stream's player.
// Upload a new video and log it in revenuedot/company marketing/videos/README.md.
export const STREAM = "https://customer-fmxk2rh71xv35llp.cloudflarestream.com";

export const VIDEOS = {
  "revenuedot-chatgpt-demo": { uid: "268e07161316f8ff9857a94fe1c7d195", title: "87-second demo: RevenueDot running a subscription app from ChatGPT" },
  "revenuedot-first-purchase": { uid: "e38ce0c11f5a379b85897f5bde1bf711", title: "78-second tutorial: your first in-app purchase with RevenueDot in 5 minutes, no server and no App Store account" },
  "revenuedot-switch-from-revenuecat": { uid: "25e90e770134f68c17f037fe5650a0d9", title: "94-second tutorial: switch from RevenueCat to RevenueDot without losing a renewal: import, run both side by side, cut over" },
  "revenuedot-connect-your-app": { uid: "25d6e9a0dfc6d8d22ddedd1cf5ab5df2", title: "77-second tutorial: connect your iOS, Android, React Native or Flutter app to RevenueDot with the RevenueCat SDK" },
  "revenuedot-paywalls-and-experiments": { uid: "fc337fd585bac5568eccf00313394e5c", title: "64-second tutorial: build a paywall from a template in RevenueDot and test it with an experiment" },
  "revenuedot-platform-demo": { uid: "2c1ee96b760bade2f41b145246e5a4d7", title: "2½-minute demo of the RevenueDot platform: switch from RevenueCat in one line, import and verify, then the dashboard, enterprise controls, self-hosting and pricing" },
  "revenuedot-platform-teaser": { uid: "40f7c65df9139dc6285edd5b7e0e1081", title: "43-second teaser of the RevenueDot platform: switch from RevenueCat in one line, one dashboard for everything, enterprise roles and audit log, and a bill capped at $999 a month" },
  "revenuedot-platform-teaser-vertical": { uid: "560f8087cfcee1f20b0dbbce1f5cea54", title: "43-second vertical teaser of the RevenueDot platform for phones and social posts: switch from RevenueCat in one line, one dashboard, enterprise controls and a bill capped at $999 a month" },
  "revenuedot-dashboard-tour": { uid: "39db15d4d7f884f65f53577849b829fb", title: "14-second silent tour of the RevenueDot dashboard: Overview, MRR chart, paywall editor and experiment results" },
};

/**
 * Chapters of a long video, for the chapter buttons under its player (components/TourPlayer.astro). `start` is in
 * seconds. The platform demo's come from company/marketing/videos/2026-10-03-platform-demo/chapters.json.
 */
export const CHAPTERS = {
  "revenuedot-platform-demo": [
    { title: "The fee problem", start: 0 },
    { title: "Meet RevenueDot", start: 12.8 },
    { title: "Switch in one line", start: 20.97 },
    { title: "Import and verify", start: 30.17 },
    { title: "Overview", start: 39.37 },
    { title: "Charts", start: 47.53 },
    { title: "Customers", start: 55.7 },
    { title: "Paywalls", start: 64.9 },
    { title: "Experiments", start: 73.07 },
    { title: "Win money back", start: 81.23 },
    { title: "Integrations", start: 91.47 },
    { title: "AI assistant", start: 101.67 },
    { title: "Enterprise", start: 111.9 },
    { title: "Self-host", start: 124.13 },
    { title: "Pricing", start: 132.33 },
    { title: "Start for free", start: 140.5 },
  ],
};

/**
 * Tutorials with a page at /watch/<name> (the onboarding emails link there; the page also links to the video on YouTube, whose title is `ytTitle`). `seconds` and `date` feed the VideoObject structured data.
 */
export const WATCH = {
  "revenuedot-platform-demo": {
    heading: "See the whole RevenueDot platform in 2½ minutes", seconds: 152, date: "2026-10-05", youtube: "https://www.youtube.com/watch?v=iZH8eTC5B1c", ytTitle: "RevenueCat Alternative (Open Source): Full Product Demo",
    description: "Switch from RevenueCat in one line, then tour RevenueDot: import, charts, paywalls, experiments, integrations, AI, enterprise roles, self-hosting and pricing.",
    summary: "Change one line to point the RevenueCat SDK at RevenueDot, import your customers and verify the numbers, then see the dashboard: 43 charts, customers, paywalls, experiments, refund rules and win-back, 38 integrations and the AI assistant. It ends with enterprise roles, single sign-on and audit logs, self-hosting with Docker, and a bill that is free until your apps make $10,000 a month and capped at $999 a month.",
    next: { label: "Start for free", href: "https://app.revenuedot.app/signup" },
  },
  "revenuedot-connect-your-app": {
    heading: "Connect your app to RevenueDot", seconds: 77, date: "2026-10-05", youtube: "https://www.youtube.com/watch?v=M_D0YodECkU", ytTitle: "Connect Your iOS or Android App to RevenueDot (RevenueCat SDK)",
    description: "Connect an iOS, Android, React Native or Flutter app to RevenueDot: the SDK URL, the signature check and your key.",
    summary: "Add the RevenueCat SDK to your app and change two settings: point it at https://api.revenuedot.app and turn the signature check off. Start with your test key from API keys, watch the first customer arrive, then add your App Store or Google Play credentials.",
    next: { label: "Read the SDK guides", href: "/docs/sdks" },
  },
  "revenuedot-paywalls-and-experiments": {
    heading: "Build a paywall and test it", seconds: 64, date: "2026-10-05", youtube: "https://www.youtube.com/watch?v=daXVK_4XD8I", ytTitle: "Paywall A/B Testing: Build a Paywall and Test It in Minutes",
    description: "Build a paywall from a template in RevenueDot, publish it, then run an experiment to see which version earns more.",
    summary: "Start from a paywall template, edit the words and prices, preview light and dark, and publish. After one app release that shows the paywall view, changes need no app update. Then start an experiment and read the lift, the confidence interval and the chance each version wins.",
    next: { label: "How experiments work", href: "/docs/guides/experiments" },
  },
  "revenuedot-switch-from-revenuecat": {
    heading: "Switch from RevenueCat without losing a renewal", seconds: 94, date: "2026-10-05", youtube: "https://www.youtube.com/watch?v=Smjskzwwo7o", ytTitle: "Migrate from RevenueCat Without Losing a Single Renewal",
    description: "Move from RevenueCat to RevenueDot safely: keep the SDK, import your data, run both side by side, then cut over.",
    summary: "Keep the RevenueCat SDK your app ships. Import products, offerings, customers and purchase history with one command, forward store notifications so RevenueCat and RevenueDot both see every renewal, compare the numbers, then point the SDK at RevenueDot and turn RevenueCat off.",
    next: { label: "Start the migration guide", href: "/docs/migrate" },
  },
  "revenuedot-first-purchase": {
    heading: "Your first purchase in 5 minutes", seconds: 78, date: "2026-10-04", youtube: "https://www.youtube.com/watch?v=1YLygdbWOKM", ytTitle: "In-App Purchases Setup: Your First Test Purchase in 5 Minutes",
    description: "Make your first in-app purchase with RevenueDot in 5 minutes: a Test Store app, a product, an entitlement and a test purchase.",
    summary: "Sign up, then follow the Overview checklist: add a Test Store app, a pro_monthly product, a pro entitlement and a default offering, and make a test purchase. The customer test_user_1 gets Pro for a month, with its events. No server and no App Store account needed.",
    next: { label: "Follow the quickstart", href: "/docs/getting-started/quickstart" },
  },
  "revenuedot-chatgpt-demo": {
    heading: "Run your subscriptions from ChatGPT", seconds: 87, date: "2026-10-01", youtube: "https://www.youtube.com/watch?v=bq8JAlei4x8", ytTitle: "Manage In-App Subscriptions with ChatGPT: RevenueDot MCP Demo",
    description: "Watch RevenueDot in ChatGPT: check setup health, find a customer, grant Pro for 7 days and fix a webhook, all in plain words.",
    summary: "Connect RevenueDot to ChatGPT and run your app's subscriptions in plain words: a health check finds a broken webhook, a customer lookup by email, a 7-day Pro grant with ChatGPT's approval prompt, a new weekly plan, a webhook retry, and a refund that waits for your permission.",
    next: { label: "Connect ChatGPT, Claude or Cursor", href: "/docs/guides/connect-ai-assistants" },
  },
};

/** Stream player URL for a video, with our own poster so the first frame matches the site. */
export function playerUrl(name) {
  const v = VIDEOS[name];
  const poster = encodeURIComponent(`https://revenuedot.app/videos/${name}.webp`);
  return `${STREAM}/${v.uid}/iframe?poster=${poster}&preload=metadata`;
}

/** `m:ss` for a number of seconds, rounded down. */
export function clock(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The video name for a revenuedot.app/videos/<name>.mp4 link, or null. */
export function videoFromHref(href) {
  const m = /^(?:https:\/\/revenuedot\.app)?\/videos\/([a-z0-9-]+)\.mp4$/.exec(href);
  return m && VIDEOS[m[1]] ? m[1] : null;
}

/** Public tutorials in the order the /watch index and the llms files list them. */
export const WATCH_ORDER = ["revenuedot-first-purchase", "revenuedot-connect-your-app", "revenuedot-switch-from-revenuecat", "revenuedot-paywalls-and-experiments", "revenuedot-platform-demo", "revenuedot-chatgpt-demo"];
