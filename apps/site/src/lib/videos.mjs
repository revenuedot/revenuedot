// Videos hosted on Cloudflare Stream (Circo account). Pages and docs link the stable revenuedot.app/videos/<name>.mp4
// address, which public/_redirects sends to Stream's MP4 download; on the site the same link renders Stream's player.
// Upload a new video and log it in revenuedot/company marketing/videos/README.md.
export const STREAM = "https://customer-fmxk2rh71xv35llp.cloudflarestream.com";

export const VIDEOS = {
  "revenuedot-platform-demo": { uid: "4122bc21c1ebbdd9019d9003326be207", title: "RevenueDot in 2 minutes 32: switch from RevenueCat in one line, run every subscription from one dashboard, self-host or Cloud with a bill that stops at $999 a month" },
  "revenuedot-chatgpt-demo": { uid: "268e07161316f8ff9857a94fe1c7d195", title: "87-second demo: RevenueDot running a subscription app from ChatGPT" },
  "revenuedot-first-purchase": { uid: "e38ce0c11f5a379b85897f5bde1bf711", title: "78-second tutorial: your first in-app purchase with RevenueDot in 5 minutes, no server and no App Store account" },
  "revenuedot-switch-from-revenuecat": { uid: "25e90e770134f68c17f037fe5650a0d9", title: "94-second tutorial: switch from RevenueCat to RevenueDot without losing a renewal: import, run both side by side, cut over" },
  "revenuedot-connect-your-app": { uid: "25d6e9a0dfc6d8d22ddedd1cf5ab5df2", title: "77-second tutorial: connect your iOS, Android, React Native or Flutter app to RevenueDot with the RevenueCat SDK" },
  "revenuedot-paywalls-and-experiments": { uid: "fc337fd585bac5568eccf00313394e5c", title: "64-second tutorial: build a paywall from a template in RevenueDot and test it with an experiment" },
  "revenuedot-dashboard-tour": { uid: "39db15d4d7f884f65f53577849b829fb", title: "14-second silent tour of the RevenueDot dashboard: Overview, MRR chart, paywall editor and experiment results" },
};

/**
 * Tutorials with a page at /watch/<name> (the onboarding emails link there until a video is on YouTube, then the page
 * links to YouTube too). `seconds` and `date` feed the VideoObject structured data.
 */
export const WATCH = {
  "revenuedot-platform-demo": {
    heading: "RevenueDot in two and a half minutes", seconds: 152, date: "2026-10-05", youtube: null,
    description: "The whole platform in 2:32: switch from RevenueCat in one line, import and verify, charts, customers, paywalls, experiments, refunds, enterprise, self-host and the $999 cap.",
    summary: "The 1% fee problem, then the fix: change one Purchases.proxyURL line, import your RevenueCat data and verify it, and run everything from one dashboard: Overview, 43 charts, the customer page, the paywall editor, experiment results, refund rules and payment recovery, enterprise SSO and roles, self-hosting with Docker, and a Cloud bill that never passes $999 a month.",
    next: { label: "Start free on Cloud", href: "https://app.revenuedot.app/signup" },
  },
  "revenuedot-connect-your-app": {
    heading: "Connect your app to RevenueDot", seconds: 77, date: "2026-10-05", youtube: null,
    description: "Connect an iOS, Android, React Native or Flutter app to RevenueDot: the SDK URL, the signature check and your key.",
    summary: "Add the RevenueCat SDK to your app and change two settings: point it at https://api.revenuedot.app and turn the signature check off. Start with your test key from API keys, watch the first customer arrive, then add your App Store or Google Play credentials.",
    next: { label: "Read the SDK guides", href: "/docs/sdks" },
  },
  "revenuedot-paywalls-and-experiments": {
    heading: "Build a paywall and test it", seconds: 64, date: "2026-10-05", youtube: null,
    description: "Build a paywall from a template in RevenueDot, publish it, then run an experiment to see which version earns more.",
    summary: "Start from a paywall template, edit the words and prices, preview light and dark, and publish. After one app release that shows the paywall view, changes need no app update. Then start an experiment and read the lift, the confidence interval and the chance each version wins.",
    next: { label: "How experiments work", href: "/docs/guides/experiments" },
  },
  "revenuedot-switch-from-revenuecat": {
    heading: "Switch from RevenueCat without losing a renewal", seconds: 94, date: "2026-10-05", youtube: null,
    description: "Move from RevenueCat to RevenueDot safely: keep the SDK, import your data, run both side by side, then cut over.",
    summary: "Keep the RevenueCat SDK your app ships. Import products, offerings, customers and purchase history with one command, forward store notifications so RevenueCat and RevenueDot both see every renewal, compare the numbers, then point the SDK at RevenueDot and turn RevenueCat off.",
    next: { label: "Start the migration guide", href: "/docs/migrate" },
  },
  "revenuedot-first-purchase": {
    heading: "Your first purchase in 5 minutes", seconds: 78, date: "2026-10-04", youtube: null,
    description: "Make your first in-app purchase with RevenueDot in 5 minutes: a Test Store app, a product, an entitlement and a test purchase.",
    summary: "Sign up, then follow the Overview checklist: add a Test Store app, a pro_monthly product, a pro entitlement and a default offering, and make a test purchase. The customer test_user_1 gets Pro for a month, with its events. No server and no App Store account needed.",
    next: { label: "Follow the quickstart", href: "/docs/getting-started/quickstart" },
  },
  "revenuedot-chatgpt-demo": {
    heading: "Run your subscriptions from ChatGPT", seconds: 87, date: "2026-10-01", youtube: null,
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

/** The video name for a revenuedot.app/videos/<name>.mp4 link, or null. */
export function videoFromHref(href) {
  const m = /^(?:https:\/\/revenuedot\.app)?\/videos\/([a-z0-9-]+)\.mp4$/.exec(href);
  return m && VIDEOS[m[1]] ? m[1] : null;
}
