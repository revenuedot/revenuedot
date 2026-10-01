// Videos hosted on Cloudflare Stream (Circo account). Pages and docs link the stable revenuedot.app/videos/<name>.mp4
// address, which public/_redirects sends to Stream's MP4 download; on the site the same link renders Stream's player.
// Upload a new video and log it in revenuedot/company marketing/videos/README.md.
export const STREAM = "https://customer-fmxk2rh71xv35llp.cloudflarestream.com";

export const VIDEOS = {
  "revenuedot-chatgpt-demo": { uid: "268e07161316f8ff9857a94fe1c7d195", title: "87-second demo: RevenueDot running a subscription app from ChatGPT" },
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
