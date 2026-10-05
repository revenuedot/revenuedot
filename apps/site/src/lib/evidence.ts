// Resolves an evidence key ("Vendor/page/claim", see src/data/evidence.ts) to its crop, its page and the image files, so a
// page can show the dated screenshot next to the claim it proves. Keys are checked at build time: an unknown key fails
// the build instead of shipping a claim without its evidence.
import type { ImageMetadata } from "astro";
import { EVIDENCE, type Evidence, type EvidenceCrop } from "../data/evidence";

const files = import.meta.glob<{ default: ImageMetadata }>("../assets/evidence/**/*.png", { eager: true });
const image = (rel: string): ImageMetadata => {
  const hit = files[rel.replace(/^\.\.\/assets\//, "../assets/")];
  if (!hit) throw new Error(`Evidence file missing: ${rel}`);
  return hit.default;
};

export type ResolvedEvidence = {
  key: string;
  evidence: Evidence;
  crop: EvidenceCrop;
  image: ImageMetadata;
  /** The first full-page segment, for the "Full page" link. */
  full: ImageMetadata;
  /** "RevenueCat pricing page" */
  pageName: string;
  /** "4 Oct 2026" */
  captured: string;
};

const index = new Map<string, ResolvedEvidence>();
for (const e of EVIDENCE) {
  for (const crop of e.crops) {
    const key = `${e.vendor}/${e.page}/${crop.claim}`;
    index.set(key, {
      key,
      evidence: e,
      crop,
      image: image(crop.file),
      full: image(e.full),
      pageName: crop.caption.split(", captured ")[0] ?? e.vendor,
      captured: new Date(e.captured + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
    });
  }
}

/** The crop for a key, or a build error naming it. */
export function evidence(key: string): ResolvedEvidence {
  const hit = index.get(key);
  if (!hit) throw new Error(`Unknown evidence key "${key}". Known: ${[...index.keys()].join(", ")}`);
  return hit;
}

export const evidenceList = (keys: string[] | undefined) => (keys ?? []).map(evidence);

/** The claim part of a caption: "Free to $2,500 monthly tracked revenue, then 1% of what you track." */
export const claimOf = (r: ResolvedEvidence) => r.crop.caption.split(": ").slice(1).join(": ") || r.crop.caption;

export const EVIDENCE_KEYS = [...index.keys()];
