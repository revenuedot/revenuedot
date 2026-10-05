// Resolves a feature visual (src/data/visuals.ts) to the image files its shot needs, so Visual.astro can render it.
import type { ImageMetadata } from "astro";
import { VISUALS, type FeatureKey, type Visual } from "../data/visuals";
import { VIDEOS } from "./videos.mjs";

const files = import.meta.glob<{ default: ImageMetadata }>("../assets/screens/*.png", { eager: true });
const image = (path: string): ImageMetadata => {
  const hit = files["../assets/screens/" + path.replace(/^src\/assets\/screens\//, "")];
  if (!hit) throw new Error(`Visual file missing: ${path}`);
  return hit.default;
};

export type ResolvedVisual = Visual & { key: FeatureKey; light?: ImageMetadata; dark?: ImageMetadata; videoTitle?: string };

export function visual(key: FeatureKey): ResolvedVisual {
  const v = VISUALS[key];
  if (!v) throw new Error(`Unknown visual "${key}". Known: ${Object.keys(VISUALS).join(", ")}`);
  return {
    ...v,
    key,
    light: v.shot ? image(v.shot.light) : undefined,
    dark: v.shot?.dark ? image(v.shot.dark) : undefined,
    videoTitle: v.video ? VIDEOS[v.video].title : undefined,
  };
}

/** A docs link that works on the site: VISUALS stores absolute revenuedot.app URLs. */
export const docsPath = (url: string) => url.replace(/^https:\/\/revenuedot\.app/, "");
