// Videos hosted on Cloudflare Stream (Circo account). Pages and docs link the stable revenuedot.app/videos/<name>.mp4
// address, which public/_redirects sends to Stream's MP4 download; on the site the same link renders Stream's player.
// Upload a new video and log it in revenuedot/company marketing/videos/README.md.
export const STREAM = "https://customer-fmxk2rh71xv35llp.cloudflarestream.com";

export const VIDEOS = {
  "revenuedot-chatgpt-demo": { uid: "268e07161316f8ff9857a94fe1c7d195", title: "87-second demo: RevenueDot running a subscription app from ChatGPT" },
  "revenuedot-dashboard-tour": { uid: "39db15d4d7f884f65f53577849b829fb", title: "14-second silent tour of the RevenueDot dashboard: Overview, MRR chart, paywall editor and experiment results" },
};

/**
 * Tutorials with a page at /watch/<name> (the onboarding emails link there until a video is on YouTube, then the page
 * links to YouTube too). `seconds` and `date` feed the VideoObject structured data.
 */
export const WATCH = {
  "revenuedot-chatgpt-demo": {
    heading: "Run your subscriptions from ChatGPT", seconds: 87, date: "2026-10-01", youtube: null,
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
