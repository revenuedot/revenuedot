/**
 * Lenient paywall JSON from a model or a paste: reading JSON out of an answer and turning loose component JSON into a
 * valid paywall with `repairPaywall`. The AI generator itself designs through `designer/` (strict JSON schema, compiler,
 * checker); this stays for pasted JSON and the SDK decode tests. Spec: prd/paywalls/PRD.md §3.
 */
import { repairPaywall, type Repaired } from "./repair.js";
import { validatePaywall, type PaywallValidation } from "./validate.js";
import { hex8 } from "./build.js";

export interface PaywallAiRequest {
  prompt: string;
  appName?: string;
  /** Up to three hex colours: the first is the accent, then background, then text. */
  brandColors?: string[];
  /** Package identifiers of the offering. */
  packages?: string[];
  locale?: string;
}

/** The first JSON object in a model's answer: code fences, prose around it and trailing commas are tolerated. */
export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const src = fenced ? fenced[1]! : text;
  const start = src.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return parseLoose(src.slice(start, i + 1)); }
  }
  // Cut off mid-object (the model hit its token limit): close what is open.
  return parseLoose(closeOpen(src.slice(start)));
}
function parseLoose(s: string): unknown | null {
  try { return JSON.parse(s); } catch { /* try the cleanups */ }
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"')); } catch { return null; }
}
function closeOpen(s: string): string {
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === "{") stack.push("}"); else if (ch === "[") stack.push("]"); else if (ch === "}" || ch === "]") stack.pop();
  }
  return (inStr ? `${s}"` : s).replace(/,\s*$/, "") + stack.reverse().join("");
}

export interface PaywallAiResult extends Repaired { validation: PaywallValidation }

/** Model answer → valid paywall. Throws when the answer has no JSON at all. */
export function paywallFromModel(answer: string, req: PaywallAiRequest, iconBaseUrl: string): PaywallAiResult {
  const raw = extractJson(answer);
  if (!raw || typeof raw !== "object") throw new Error("The model did not answer with JSON.");
  const colors = (req.brandColors ?? []).map((c) => (hex8(c) ? c : null));
  const out = repairPaywall(raw, {
    iconBaseUrl, packages: req.packages, locale: req.locale ?? "en_US",
    colors: { accent: colors[0] ?? undefined, background: colors[1] ?? undefined, text: colors[2] ?? undefined },
  });
  return { ...out, validation: validatePaywall(out.doc, { packages: req.packages }) };
}
