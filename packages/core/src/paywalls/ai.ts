/**
 * The AI paywall generator's pure half: the prompt, reading JSON out of the model's answer, and turning it into a valid
 * paywall with `repairPaywall`. The model call itself lives in the server (apps/server/src/services/paywall-ai.ts), so
 * tests run this with a fake model. Spec: prd/paywalls/PRD.md §3.
 */
import { PAYWALL_ICON_NAMES } from "./icons.js";
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

export const PAYWALL_AI_MAX_PROMPT = 2000;

export function paywallAiMessages(req: PaywallAiRequest): { system: string; user: string } {
  const system = `You design mobile app paywalls that convert. You answer with one JSON object and nothing else: no prose, no code fences.

The JSON is a paywall for the RevenueCat SDK's paywall components, written in this short form:
{
  "name": "short paywall name",
  "background": "#rrggbb",
  "components": [ ...components top to bottom... ],
  "footer": [ ...components pinned to the bottom: the purchase button, a short reassurance text, a restore button... ]
}

Components (use only these):
- {"type":"text","text":"...","font_size":28,"font_weight":"bold","color":"#111111","align":"center"}   font_weight: regular, medium, semibold, bold
- {"type":"stack","direction":"vertical"|"horizontal","spacing":12,"padding":16,"background":"#f5f5f5","corner_radius":16,"align":"center","components":[...]}
- {"type":"icon","icon_name":"check","color":"#111111","size_pt":22}   icon_name is one of: ${PAYWALL_ICON_NAMES.join(", ")}
- {"type":"features","items":[{"icon":"check_circle","text":"Unlimited access"}, ...]}   3 to 5 benefits
- {"type":"timeline","items":[{"icon":"unlock","title":"Today","description":"Full access"}, ...]}   for free trials: today, reminder, charge day
- {"type":"packages"}   the plan list, built from the offering; put it once, after the benefits
- {"type":"purchase_button","text":"Continue"}   exactly one, in the footer
- {"type":"button","action":"restore","text":"Restore purchases"}
- {"type":"carousel","pages":[{"components":[...]}, ...]}   for 2 or 3 swipeable value pages
- {"type":"countdown","date":"2026-12-31T23:59:59Z","text":"Ends in {{ count_hours_with_zero }}:{{ count_minutes_with_zero }}:{{ count_seconds_with_zero }}"}   only for limited offers

Prices are variables, never numbers: {{ product.price_per_period }}, {{ product.price }}, {{ product.price_per_month }}, {{ product.relative_discount }}, {{ product.offer_period_with_unit }} (trial length), {{ product.offer_price }}.

What converts in 2026: open on the value in one short headline; 3 to 5 concrete benefits with icons; explain the trial with a timeline when there is one; the yearly plan first; "No commitment, cancel anytime" under the button; one accent colour on a plain background; short words. Never invent ratings or user counts unless the user gave them.`;
  const lines = [
    `Paywall request: ${req.prompt.trim().slice(0, PAYWALL_AI_MAX_PROMPT)}`,
    req.appName ? `App name: ${req.appName.trim().slice(0, 80)}` : "",
    req.brandColors?.length ? `Brand colours: ${req.brandColors.slice(0, 3).join(", ")} (use the first as the accent)` : "",
    req.packages?.length ? `The offering's packages: ${req.packages.join(", ")}` : "",
    req.locale && !/^en/.test(req.locale) ? `Write every text in the language of the locale ${req.locale}.` : "",
  ].filter(Boolean);
  return { system, user: lines.join("\n") };
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
