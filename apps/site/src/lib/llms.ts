// The llms files come from the revenuedot/docs repo (its llms.txt is canonical), with links pointed at revenuedot.app.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { docsDir, rewriteLlmsText } from "./docs-source.mjs";
import { WATCH, WATCH_ORDER } from "./videos.mjs";

export const llmsFile = (rel: string) => rewriteLlmsText(readFileSync(path.join(docsDir(), rel), "utf8"));
export const llmsShards = () => readdirSync(path.join(docsDir(), "llms")).filter((f) => f.endsWith(".txt")).map((f) => f.replace(/\.txt$/, ""));
export const textResponse = (body: string) => new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** One plain status sentence for the top of the llms files; keep it in step with the README and the pricing page. */
export const STATUS_SENTENCE = "RevenueDot is an open-source backend for in-app purchases and subscriptions on the App Store, Google Play, Amazon, Stripe and the web: a new app installs the RevenueDot SDK and needs no RevenueCat account, and an app on RevenueCat can switch by changing one line. The first release is v2026.10.03, it has run in production beside RevenueCat since 2026-10-02, RevenueDot Cloud is free up to $10,000 a month in tracked revenue and then 0.5% of the revenue above that (never more than $999 a month), and self-hosting is free (AGPL-3.0 server, MIT SDKs).";

/** The "Videos" section: one line per tutorial with its YouTube title, a sentence, the watch page and the YouTube URL. */
export function videosSection(heading = "## Videos"): string {
  const lines = WATCH_ORDER.filter((n) => WATCH[n]).map((n) => {
    const w = WATCH[n];
    return `- [${w.ytTitle}](https://revenuedot.app/watch/${n}): ${w.description} Watch page: https://revenuedot.app/watch/${n} . YouTube: ${w.youtube}`;
  });
  return [heading, "", ...lines, "", "All videos: https://revenuedot.app/watch and https://www.youtube.com/@revenuedot", ""].join("\n");
}

/** Puts the status sentence right after the file's opening blockquote (the first blank line after the first `>` line). */
export function withStatus(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.startsWith(">"));
  if (first < 0) return text;
  let end = first;
  while (lines[end + 1]?.startsWith(">")) end++;
  lines.splice(end + 1, 0, "", STATUS_SENTENCE);
  return lines.join("\n");
}
