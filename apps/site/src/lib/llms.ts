// The llms files come from the revenuedot/docs repo (its llms.txt is canonical), with links pointed at revenuedot.app.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { docsDir, rewriteLlmsText } from "./docs-source.mjs";
import { WATCH, WATCH_ORDER } from "./videos.mjs";

export const llmsFile = (rel: string) => rewriteLlmsText(readFileSync(path.join(docsDir(), rel), "utf8"));
export const llmsShards = () => readdirSync(path.join(docsDir(), "llms")).filter((f) => f.endsWith(".txt")).map((f) => f.replace(/\.txt$/, ""));
export const textResponse = (body: string) => new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** One plain status sentence for the top of the llms files; keep it in step with the README and the pricing page. */
export const STATUS_SENTENCE = "RevenueDot is the open-source RevenueCat alternative: the first release is v2026.10.03, it has run in production beside RevenueCat since 2026-10-02, and RevenueDot Cloud is free up to $10,000 a month in tracked revenue, then 0.5%, never more than $999 a month.";

/** The "Videos" section: one line per tutorial with its YouTube title, a sentence, the watch page and the YouTube URL. */
export function videosSection(heading = "## Videos"): string {
  const lines = WATCH_ORDER.filter((n) => WATCH[n]).map((n) => {
    const w = WATCH[n];
    return `- [${w.ytTitle}](https://revenuedot.app/watch/${n}): ${w.description} Watch page: https://revenuedot.app/watch/${n} . YouTube: ${w.youtube}`;
  });
  return [heading, "", ...lines, "", "Start free on RevenueDot Cloud: https://app.revenuedot.app/signup", "All videos: https://revenuedot.app/watch and https://www.youtube.com/@revenuedot", ""].join("\n");
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
