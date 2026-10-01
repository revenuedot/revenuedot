import { DEFAULT_THEME, type FunnelDoc, type FunnelStep } from "./types.js";
import { normalizeFunnel, validateFunnel, type FunnelProblem } from "./validate.js";

/**
 * "Build with AI" for funnels (prd/web-billing/PRD.md §5): the same model and caps as the paywall generator. The model is
 * asked for the funnel JSON; whatever it answers is repaired into a funnel that validates for publishing (ids, a paywall
 * step, the success step last) or refused.
 */

export const FUNNEL_AI_MAX_PROMPT = 1000;

export interface FunnelAiRequest { prompt: string; appName?: string; offering?: string | null }

export function funnelAiMessages(r: FunnelAiRequest): { system: string; user: string } {
  const system = [
    "You design short web-to-app onboarding funnels that sell a mobile app subscription. Answer with one JSON object only, no prose.",
    'Shape: {"theme":{"background":"#RRGGBB","text":"#RRGGBB","accent":"#RRGGBB","button_text":"#RRGGBB","corner_radius":0-24},"steps":[...]}.',
    "Step types (each has id: lower-case a-z0-9_-, type, title, optional subtitle):",
    '- question: {"options":[{"id","label","next"?}],"multiple"?:bool,"attribute"?:"snake_case_name"} 2-5 options, labels under 60 characters;',
    '- info: {"body","button_label"?} a short proof point or explanation;',
    '- email: {"placeholder","required":true};',
    '- paywall: {"features":["…"],"allow_codes":true,"button_label"} exactly one, after the questions;',
    '- success: {"body","show_redemption":true} exactly one, last.',
    "Use 4 to 8 steps. Plain, specific, friendly copy. No emoji. High contrast colours.",
  ].join("\n");
  const user = `App: ${r.appName ?? "the app"}\nFunnel request: ${r.prompt.slice(0, FUNNEL_AI_MAX_PROMPT)}`;
  return { system, user };
}

const slug = (s: unknown, fallback: string) => {
  const v = String(s ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return v || fallback;
};
const text = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const hex = (s: unknown, fb: string) => (typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s) ? s : fb);

/** Pulls the first JSON object out of a model answer (code fences and prose around it are common). */
export function extractJson(answer: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer);
  const src = fenced ? fenced[1]! : answer;
  const start = src.indexOf("{"), end = src.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the answer");
  return JSON.parse(src.slice(start, end + 1));
}

/** Repairs a model's funnel into one that validates for publishing. Returns the funnel and what was fixed. */
export function repairFunnel(raw: unknown): { funnel: FunnelDoc; fixes: string[]; problems: FunnelProblem[] } {
  const fixes: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const t = (r.theme && typeof r.theme === "object" ? r.theme : {}) as Record<string, unknown>;
  const theme = {
    background: hex(t.background, DEFAULT_THEME.background), text: hex(t.text, DEFAULT_THEME.text), accent: hex(t.accent, DEFAULT_THEME.accent),
    button_text: hex(t.button_text, DEFAULT_THEME.button_text), corner_radius: typeof t.corner_radius === "number" ? Math.max(0, Math.min(24, Math.round(t.corner_radius))) : 0,
  };
  const used = new Set<string>();
  const uid = (v: unknown, fb: string) => { let id = slug(v, fb); let n = 2; while (used.has(id)) id = `${slug(v, fb).slice(0, 36)}_${n++}`; used.add(id); return id; };
  const steps: FunnelStep[] = [];
  for (const [i, s] of (Array.isArray(r.steps) ? r.steps : []).slice(0, 12).entries()) {
    if (!s || typeof s !== "object") continue;
    const type = ["question", "info", "email", "paywall", "success"].includes(s.type) ? s.type : null;
    if (!type) { fixes.push(`dropped step ${i + 1} (unknown type)`); continue; }
    const title = text(s.title, 120) || ({ question: "A quick question", info: "Good to know", email: "Your email", paywall: "Unlock everything", success: "You are in" } as Record<string, string>)[type]!;
    const base = { id: uid(s.id, `${type}_${i + 1}`), title, subtitle: text(s.subtitle, 600) || null };
    if (type === "question") {
      const opts = (Array.isArray(s.options) ? s.options : []).slice(0, 8).map((o: any, j: number) => ({ id: slug(o?.id ?? o?.label, `option_${j + 1}`), label: text(typeof o === "string" ? o : o?.label, 80), next: typeof o?.next === "string" ? slug(o.next, "") : null })).filter((o: { label: string }) => o.label);
      const seen = new Set<string>();
      for (const o of opts) { let id = o.id, n = 2; while (seen.has(id)) id = `${o.id}_${n++}`; o.id = id; seen.add(id); }
      if (!opts.length) { fixes.push(`dropped question "${title}" (no options)`); continue; }
      steps.push({ ...base, type, options: opts, multiple: !!s.multiple, attribute: typeof s.attribute === "string" ? slug(s.attribute, "") || null : null } as FunnelStep);
    } else if (type === "info") steps.push({ ...base, type, body: text(s.body, 600) || null, button_label: text(s.button_label, 40) || null } as FunnelStep);
    else if (type === "email") steps.push({ ...base, type, placeholder: text(s.placeholder, 80) || "you@example.com", required: s.required !== false } as FunnelStep);
    else if (type === "paywall") steps.push({ ...base, type, features: (Array.isArray(s.features) ? s.features : []).map((f: unknown) => text(f, 120)).filter(Boolean).slice(0, 8), allow_codes: s.allow_codes !== false, button_label: text(s.button_label, 40) || "Continue", offering: null } as FunnelStep);
    else steps.push({ ...base, type, body: text(s.body, 600) || null, show_redemption: true } as FunnelStep);
  }
  // Exactly one paywall and one success step, in that order, the success step last.
  const pays = steps.filter((s) => s.type === "paywall");
  const succ = steps.filter((s) => s.type === "success");
  let body = steps.filter((s) => s.type !== "paywall" && s.type !== "success");
  if (pays.length !== 1) fixes.push(pays.length ? "kept one paywall step" : "added a paywall step");
  if (succ.length !== 1) fixes.push(succ.length ? "kept one success step" : "added a success step");
  const pay = pays[0] ?? ({ id: uid("paywall", "paywall"), type: "paywall", title: "Unlock everything", subtitle: "Cancel anytime.", features: [], allow_codes: true, button_label: "Continue", offering: null } as FunnelStep);
  const done = succ[0] ?? ({ id: uid("success", "success"), type: "success", title: "You are in", body: "Open the app to start. Your purchase is waiting there.", show_redemption: true } as FunnelStep);
  body = body.slice(0, 28);
  const ids = new Set([...body, pay, done].map((s) => s.id));
  for (const s of body) if (s.type === "question") for (const o of s.options) if (o.next && !ids.has(o.next)) { o.next = null; fixes.push(`removed a path to a missing step in "${s.title}"`); }
  const funnel = normalizeFunnel({ theme, steps: [...body, pay, done] });
  return { funnel, fixes, problems: validateFunnel(funnel, { forPublish: true }) };
}

export function funnelFromModel(answer: string) {
  return repairFunnel(extractJson(answer));
}
