import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Text colours in design/tokens.css must be readable (WCAG AA, 4.5:1) on every surface they sit on, in both themes.
// The dashboard-ui journey found --up (#5F822B, 4.45:1 on white) under AA on "Active" tags and growth deltas, and --fg-3
// (#737373, 4.05:1 on --active) on selected rows.
const css = readFileSync(new URL("../../../design/tokens.css", import.meta.url), "utf8");
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
const light = tokens(css.slice(0, css.indexOf("@media")));
const dark = { ...light, ...tokens(css.slice(css.indexOf(':root[data-theme="dark"]'))) };
const lum = (hex: string) => {
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => f(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("design tokens: text contrast", () => {
  for (const [theme, t] of [["light", light], ["dark", dark]] as const) {
    it(`${theme}: ink, state and gold text colours reach 4.5:1 on the page, panels, the sidebar and selected rows`, () => {
      const low: string[] = [];
      // Ink also sits on hovered and selected rows (a selected nav item's SOON tag, a selected funnel step's caption).
      for (const fg of ["fg", "fg-2", "fg-3", "up", "down", "info", "accent-ink"]) {
        for (const bg of ["bg", "panel", "sidebar", ...(fg.startsWith("fg") ? ["hover", "active"] : [])]) {
          const r = ratio(t[fg]!, t[bg]!);
          if (r < 4.5) low.push(`--${fg} ${t[fg]} on --${bg} ${t[bg]}: ${r.toFixed(2)}`);
        }
      }
      expect(low).toEqual([]);
    });
  }
});
