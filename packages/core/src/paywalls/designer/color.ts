/**
 * Colour helpers for the AI paywall designer: WCAG 2 contrast, mixing, and moving a colour until it reads on its
 * background. Colours are "#rrggbb" (an "#rrggbbaa" alpha is composited over the background first).
 */

export function parseHex(c: string | null | undefined): [number, number, number, number] | null {
  const s = (c ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return [parseInt(s[0]! + s[0], 16), parseInt(s[1]! + s[1], 16), parseInt(s[2]! + s[2], 16), 1];
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1];
  return null;
}
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
export const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
/** A valid "#rrggbb", or the fallback. */
export function cleanHex(c: string | null | undefined, fallback: string): string {
  const p = parseHex(c);
  return p ? toHex(p[0], p[1], p[2]) : fallback;
}
/** `a` composited over the opaque `under`. */
export function over(a: string, under: string): string {
  const x = parseHex(a), u = parseHex(under);
  if (!x || !u) return cleanHex(a, "#000000");
  return toHex(x[0] * x[3] + u[0] * (1 - x[3]), x[1] * x[3] + u[1] * (1 - x[3]), x[2] * x[3] + u[2] * (1 - x[3]));
}
/** `a` moved towards `b` by t (0: a, 1: b). */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a) ?? [0, 0, 0, 1], y = parseHex(b) ?? [0, 0, 0, 1];
  return toHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}
export function withAlpha(c: string, alpha: number): string {
  return `${cleanHex(c, "#000000")}${hex2(alpha * 255)}`;
}

/** WCAG relative luminance (0 black … 1 white). */
export function luminance(c: string): number {
  const p = parseHex(c) ?? [0, 0, 0, 1];
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(p[0]) + 0.7152 * ch(p[1]) + 0.0722 * ch(p[2]);
}
/** WCAG contrast ratio of two opaque colours (1 … 21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** The lowest contrast of `fg` against any of `bgs` (a gradient's stops, a card and the background …). */
export function worstContrast(fg: string, bgs: string[]): number {
  return Math.min(...bgs.map((b) => contrast(over(fg, b), b)));
}
export const isDark = (c: string) => luminance(c) < 0.18;

/**
 * `fg` itself when it reaches `min` against every background; otherwise `fg` moved step by step towards white or black
 * (whichever reads better) until it does, keeping as much of its hue as possible. Falls back to pure black or white.
 */
export function readable(fg: string, bgs: string[], min = 4.5): string {
  const f = cleanHex(fg, "#000000");
  if (!bgs.length || worstContrast(f, bgs) >= min) return f;
  const avg = bgs.reduce((s, b) => s + luminance(b), 0) / bgs.length;
  const targets = avg < 0.4 ? ["#ffffff", "#000000"] : ["#000000", "#ffffff"];
  for (const t of targets) {
    for (let i = 1; i <= 20; i++) {
      const c = mix(f, t, i / 20);
      if (worstContrast(c, bgs) >= min) return c;
    }
  }
  return worstContrast("#ffffff", bgs) >= worstContrast("#000000", bgs) ? "#ffffff" : "#000000";
}
