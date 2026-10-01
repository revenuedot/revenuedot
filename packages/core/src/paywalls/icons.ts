/**
 * The built-in icon set for paywall `icon` and `timeline` components: our own drawings on a 24 × 24 grid, stroked 2px with
 * round caps. The server serves each as a 96 × 96 white PNG at `/assets/icons/{name}.png` (the SDKs tint icons with the
 * component's colour) and as SVG; the dashboard preview draws the same paths. PNGs are generated from these paths by
 * `scripts/paywall-icons.ts`.
 */

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const PAYWALL_ICONS: Record<string, { label: string; d: string }> = {
  check: { label: "Check", d: "M5 12.5l4.5 4.5L19 7.5" },
  check_circle: { label: "Check in circle", d: `${circle(12, 12, 9)}M8 12.5l3 3 5-6` },
  x: { label: "Close", d: "M6 6l12 12M18 6L6 18" },
  star: { label: "Star", d: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" },
  sparkles: { label: "Sparkles", d: "M11 3l1.8 4.7 4.7 1.8-4.7 1.8L11 16l-1.8-4.7L4.5 9.5l4.7-1.8zM18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" },
  lock: { label: "Lock", d: "M5.5 11h13v9.5h-13zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" },
  unlock: { label: "Unlock", d: "M5.5 11h13v9.5h-13zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2" },
  bell: { label: "Bell", d: "M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4" },
  crown: { label: "Crown", d: "M4 18h16M4 18L3 7.5l5 4 4-6.5 4 6.5 5-4L20 18" },
  shield: { label: "Shield", d: "M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" },
  shield_check: { label: "Shield with check", d: "M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6zM9 12l2 2 4-4.5" },
  zap: { label: "Lightning", d: "M13 2.5L4.5 14H11l-1 7.5L18.5 10H12z" },
  heart: { label: "Heart", d: "M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" },
  gift: { label: "Gift", d: "M3.5 9.5h17v4h-17zM5 13.5h14v7H5zM12 9.5v11M12 9.5C10 5.5 6.5 5.5 6.5 7.8S9.5 9.5 12 9.5zM12 9.5c2-4 5.5-4 5.5-1.7S14.5 9.5 12 9.5z" },
  clock: { label: "Clock", d: `${circle(12, 12, 9)}M12 7v5l3.5 2` },
  calendar: { label: "Calendar", d: "M4 5.5h16v15H4zM4 10h16M8 3v4M16 3v4" },
  calendar_check: { label: "Calendar with check", d: "M4 5.5h16v15H4zM4 10h16M8 3v4M16 3v4M9 15l2 2 4-4" },
  cloud: { label: "Cloud", d: "M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 17.8 9a4.8 4.8 0 0 1-.3 9.5z" },
  infinity: { label: "Infinity", d: "M12 12c-2-2.7-3.6-4-5.5-4a4 4 0 0 0 0 8c1.9 0 3.5-1.3 5.5-4zm0 0c2 2.7 3.6 4 5.5 4a4 4 0 0 0 0-8c-1.9 0-3.5 1.3-5.5 4z" },
  chart: { label: "Bar chart", d: "M4 20h16M7 16v-4M12 16V7.5M17 16v-6.5" },
  trending_up: { label: "Trending up", d: "M3 17l6-6 4 4 8-8M15 7h6v6" },
  users: { label: "People", d: `${circle(9, 8, 3.5)}M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.8 3 2.6 3.5 5.2` },
  user: { label: "Person", d: `${circle(12, 8, 4)}M4 21c1-4 4.2-6.5 8-6.5s7 2.5 8 6.5` },
  download: { label: "Download", d: "M12 4v11M7 10l5 5 5-5M5 20h14" },
  camera: { label: "Camera", d: `M3.5 8h4l2-3h5l2 3h4v12h-17z${circle(12, 13.5, 3.5)}` },
  music: { label: "Music", d: `M9 18V5.5l11-2V16${circle(6.5, 18, 2.5)}${circle(17.5, 16, 2.5)}` },
  book: { label: "Book", d: "M4 19.5V5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h14" },
  globe: { label: "Globe", d: `${circle(12, 12, 9)}M3 12h18M12 3c2.6 2.5 2.6 15.5 0 18M12 3c-2.6 2.5-2.6 15.5 0 18` },
  moon: { label: "Moon", d: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" },
  sun: { label: "Sun", d: `${circle(12, 12, 4)}M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4` },
  flame: { label: "Flame", d: "M12 21c-3.9 0-7-2.7-7-6.5 0-4 3.5-6 4-10 2.5 1.5 4 4 4 6.5 1-1 1.5-2 1.5-3.5 2 1.5 3.5 4 3.5 7 0 3.8-2.6 6.5-6 6.5z" },
  target: { label: "Target", d: `${circle(12, 12, 9)}${circle(12, 12, 5)}${circle(12, 12, 1)}` },
  leaf: { label: "Leaf", d: "M5 19C5 10 10 5 20 4c-1 10-6 15-15 15zM5 19l7.5-7.5" },
  dumbbell: { label: "Dumbbell", d: "M2.5 12h19M5.5 8.5v7M8.5 6.5v11M15.5 6.5v11M18.5 8.5v7" },
  mic: { label: "Microphone", d: "M9 5.5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" },
  image: { label: "Image", d: `M3.5 5h17v14h-17zM3.5 16l5-5 4 4 3-3 5 5${circle(15.5, 9, 1.5)}` },
  wand: { label: "Magic wand", d: "M4 20L15 9M13 7l4 4M18 2.5v3.5M16.25 4.25h3.5M21 8.5v2M20 9.5h2" },
  percent: { label: "Percent", d: `M19 5L5 19${circle(7, 7, 2.5)}${circle(17, 17, 2.5)}` },
  tag: { label: "Tag", d: `M3 12V3.5h8.5L21 13l-8 8z${circle(7.5, 8, 1.5)}` },
  no_ads: { label: "No ads", d: `${circle(12, 12, 9)}M5.6 5.6l12.8 12.8` },
  sync: { label: "Sync", d: "M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4" },
  devices: { label: "Devices", d: "M7 3h10v18H7zM11 18h2" },
  headphones: { label: "Headphones", d: "M4 18v-5a8 8 0 0 1 16 0v5M4 15h3v6H4zM17 15h3v6h-3z" },
  trophy: { label: "Trophy", d: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3.5 3.5 0 0 0 4 4M16 6h3.5a3.5 3.5 0 0 1-4 4M12 13v4M9 21h6M9.5 17h5v4h-5z" },
};

export const PAYWALL_ICON_NAMES = Object.keys(PAYWALL_ICONS);

/** The SVG for an icon, `color` stroke on a transparent ground. */
export function paywallIconSvg(name: string, color = "#ffffff", px = 96): string | null {
  const icon = PAYWALL_ICONS[name];
  if (!icon) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${icon.d}"/></svg>`;
}
