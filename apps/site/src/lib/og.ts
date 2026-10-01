// The social card for a page: /og/<path>.png, made by scripts/og.mjs from the same data. "/" is /og/home.png.
// Returns undefined when the card has not been made yet (for example a blog post merged in revenuedot/docs before its
// card lands here), so the page falls back to the site card instead of pointing at a missing file.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const ogPath = (path: string) => `/og/${path === "/" ? "home" : path.replace(/^\//, "")}.png`;
export const ogFor = (path: string): string | undefined => {
  const p = ogPath(path);
  return existsSync(join(process.cwd(), "public", p)) ? p : undefined;
};
