/**
 * The signed-in person's display preferences (Account settings → Interface and Date and region,
 * prd/account-settings/PRD.md): theme, tint, the first day of the week and the display currency with its rate.
 * Module state, so the plain formatters (fmt.usd, money) follow it; PrefsProvider (main.tsx) keeps it in step with
 * GET /auth/me and remounts the pages when it changes. The last values are cached in localStorage only so the first
 * paint already has them.
 */

export type Theme = "system" | "light" | "dark";
export interface Display { currency: string; rate: number; rateDate: string | null; weekStart: number }

const DEFAULT: Display = { currency: "USD", rate: 1, rateDate: null, weekStart: 1 };
let display: Display = DEFAULT;

const read = <T,>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : null; } catch { return null; } };
const write = (k: string, v: unknown) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export function getDisplay(): Display { return display; }
export function setDisplay(d: Display) { display = d; write("rd-display", d); }
/** First paint: the cached display, theme and tint from the last visit. */
export function loadCachedPrefs() {
  const d = read<Display>("rd-display");
  if (d && typeof d.currency === "string" && d.rate > 0) display = { ...DEFAULT, ...d };
  try {
    const t = localStorage.getItem("rd-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch { /* ignore */ }
  applyTint(read<string>("rd-tint"));
}
export function clearCachedPrefs() { display = DEFAULT; write("rd-display", null); write("rd-tint", null); applyTint(null); }

/** "system" follows the operating system (no data-theme), the others pin it. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme; else root.dataset.theme = theme;
  try { if (theme === "system") localStorage.removeItem("rd-theme"); else localStorage.setItem("rd-theme", theme); } catch { /* ignore */ }
}
export const effectiveTheme = (): "light" | "dark" => {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
};

/* ---------- Colour and contrast (WCAG 2.x) ---------- */

type RGB = [number, number, number];
export const hexToRgb = (hex: string): RGB => { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB; };
export const rgbToHex = (c: RGB) => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = (hex: string) => { const [r, g, b] = hexToRgb(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The tint moved toward black (on a light page) or white (on a dark page) until it reaches `min` against `bg`. */
export function readableOn(tint: string, bg: string, min: number): string {
  const c = hexToRgb(tint), towards: RGB = luminance(bg) > 0.5 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const hex = rgbToHex(mix(c, towards, t));
    if (contrast(hex, bg) >= min) return hex;
  }
  return luminance(bg) > 0.5 ? "#000000" : "#FFFFFF";
}

/** The page colours of the two themes (design/tokens.css --bg); tints never change them. */
export const PAGE = { light: "#FFFFFF", dark: "#0A0A0A" } as const;

/** What a tint becomes in each theme: the accent itself, text in it (4.5:1) and the focus ring (3:1). */
export function tintTokens(tint: string) {
  return {
    accent: tint.toUpperCase(),
    light: { ink: readableOn(tint, PAGE.light, 4.5), focus: readableOn(tint, PAGE.light, 3) },
    dark: { ink: readableOn(tint, PAGE.dark, 4.5), focus: readableOn(tint, PAGE.dark, 3) },
  };
}

/** Replaces the gold accent tokens with the tint (null: back to the gold of design/tokens.css). */
export function applyTint(tint: string | null) {
  let el = document.getElementById("rd-tint") as HTMLStyleElement | null;
  if (!tint || !/^#[0-9a-fA-F]{6}$/.test(tint)) { el?.remove(); write("rd-tint", null); return; }
  const t = tintTokens(tint);
  const [r, g, b] = hexToRgb(t.accent);
  const dark = `--accent-ink:${t.dark.ink};--focus:${t.dark.focus}`;
  const css = `:root{--accent:${t.accent};--accent-ink:${t.light.ink};--focus:${t.light.focus};--accent-wash:rgb(${r} ${g} ${b} / .14)}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`;
  if (!el) { el = document.createElement("style"); el.id = "rd-tint"; document.head.appendChild(el); }
  el.textContent = css;
  write("rd-tint", t.accent);
}

/* ---------- Money and weeks ---------- */

/** The currency's minor units: 2 for USD and EUR, 0 for JPY and KRW. */
export const currencyDigits = (currency: string) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; } };
const digits = currencyDigits;

/** A USD amount in the display currency (at the latest rate). `cents` keeps the currency's minor units. */
export function formatUsd(n: number, cents: boolean, d: Display = display): string {
  const cur = d.currency || "USD";
  const v = cur === "USD" ? n : n * d.rate;
  const dp = cents ? digits(cur) : 0;
  try { return v.toLocaleString("en-US", { style: "currency", currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }); } catch { return `${cur} ${v.toFixed(dp)}`; }
}
/** An amount already in the display currency (a chart series converted with `display.rate`). */
export function formatDisplay(v: number, cents = true, d: Display = display): string {
  const cur = d.currency || "USD";
  const dp = cents ? digits(cur) : 0;
  try { return v.toLocaleString("en-US", { style: "currency", currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }); } catch { return `${cur} ${v.toFixed(dp)}`; }
}
/** USD → display currency multiplier (1 for USD). */
export const displayRate = (d: Display = display) => (d.currency === "USD" ? 1 : d.rate);

/** The display currency's symbol for axis ticks: "$", "€", "¥" … */
export function currencySymbol(d: Display = display) {
  try { return (0).toLocaleString("en-US", { style: "currency", currency: d.currency, maximumFractionDigits: 0 }).replace(/[\d\s.,]/g, "") || d.currency; } catch { return d.currency; }
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const CURRENCIES: { code: string; name: string }[] = [
  { code: "USD", name: "US dollar" }, { code: "EUR", name: "Euro" }, { code: "GBP", name: "British pound" }, { code: "AUD", name: "Australian dollar" },
  { code: "CAD", name: "Canadian dollar" }, { code: "JPY", name: "Japanese yen" }, { code: "BRL", name: "Brazilian real" }, { code: "KRW", name: "South Korean won" },
  { code: "CNY", name: "Chinese yuan" }, { code: "MXN", name: "Mexican peso" }, { code: "SEK", name: "Swedish krona" }, { code: "PLN", name: "Polish złoty" },
  { code: "NZD", name: "New Zealand dollar" }, { code: "CHF", name: "Swiss franc" },
];
