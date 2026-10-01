// Resolves a ShotRef.src ("charts-light.png", "web/funnels.png", "screens/overview-light.png", "charts/mrr.png")
// to a real capture. Captures live in the monorepo's docs/assets and in apps/site/src/assets/screens.
import type { ImageMetadata } from "astro";

const docs = import.meta.glob<{ default: ImageMetadata }>("../../../../docs/assets/**/*.png", { eager: true });
const site = import.meta.glob<{ default: ImageMetadata }>("../assets/screens/**/*.png", { eager: true });

const index = new Map<string, ImageMetadata>();
for (const [k, v] of Object.entries(docs)) index.set(k.replace(/^.*\/docs\/assets\//, ""), v.default);
for (const [k, v] of Object.entries(site)) index.set(k.replace(/^.*\/assets\/screens\//, "screens/"), v.default);

export function shot(src: string): ImageMetadata {
  const img = index.get(src) ?? index.get(src.replace(/^docs\/assets\//, ""));
  if (!img) throw new Error(`Unknown screenshot "${src}". Known: ${[...index.keys()].join(", ")}`);
  return img;
}
export const hasShot = (src: string) => index.has(src);
