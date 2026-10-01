import { DEFAULT_THEME, type FunnelDoc, type FunnelStep, type FunnelTheme } from "./types.js";

export interface FunnelProblem { path: string; message: string }

const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9_-]{1,40}$/;
const STEP_TYPES = new Set(["question", "info", "email", "paywall", "success"]);
const ATTR = /^[A-Za-z0-9_$.-]{1,64}$/;
export const FUNNEL_LIMITS = { steps: 30, options: 8, title: 120, text: 600, features: 8 };

const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const optStr = (v: unknown, max: number) => v === undefined || v === null || str(v, max);
const httpsUrl = (v: unknown) => typeof v === "string" && /^https:\/\/[^\s"'<>]+$/.test(v) && v.length <= 2048;

/**
 * Checks a funnel before it is saved or published. Saving a draft only needs the shape to be right; publishing also needs
 * a paywall step and the success step last (`forPublish`). Returns every problem with a JSON-ish path.
 */
export function validateFunnel(doc: unknown, opts: { forPublish?: boolean } = {}): FunnelProblem[] {
  const out: FunnelProblem[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  if (!doc || typeof doc !== "object") return [{ path: "", message: "must be an object with theme and steps" }];
  const d = doc as Record<string, any>;
  const t = d.theme as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") add("theme", "is required");
  else {
    for (const k of ["background", "text", "accent", "button_text"] as const) if (typeof t[k] !== "string" || !HEX.test(t[k] as string)) add(`theme.${k}`, "must be a colour like #0A0A0A");
    if (typeof t.corner_radius !== "number" || t.corner_radius < 0 || t.corner_radius > 24) add("theme.corner_radius", "must be a number from 0 to 24");
  }
  const steps = d.steps;
  if (!Array.isArray(steps)) { add("steps", "must be a list"); return out; }
  if (steps.length < 1) add("steps", "needs at least one step");
  if (steps.length > FUNNEL_LIMITS.steps) add("steps", `can have at most ${FUNNEL_LIMITS.steps} steps`);
  const ids = new Set<string>();
  steps.forEach((s: any, i: number) => {
    const p = `steps[${i}]`;
    if (!s || typeof s !== "object") { add(p, "must be an object"); return; }
    if (typeof s.id !== "string" || !ID.test(s.id)) add(`${p}.id`, "must be 1-40 lower-case letters, digits, - or _");
    else if (ids.has(s.id)) add(`${p}.id`, `"${s.id}" is used twice`);
    else ids.add(s.id);
    if (!STEP_TYPES.has(s.type)) { add(`${p}.type`, "must be question, info, email, paywall or success"); return; }
    if (!str(s.title, FUNNEL_LIMITS.title) || !s.title.trim()) add(`${p}.title`, `is required (at most ${FUNNEL_LIMITS.title} characters)`);
    if (!optStr(s.subtitle, FUNNEL_LIMITS.text)) add(`${p}.subtitle`, `must be text of at most ${FUNNEL_LIMITS.text} characters`);
    if (!optStr(s.button_label, 40)) add(`${p}.button_label`, "must be text of at most 40 characters");
    if (s.type === "question") {
      if (!Array.isArray(s.options) || s.options.length < 1 || s.options.length > FUNNEL_LIMITS.options) add(`${p}.options`, `needs 1 to ${FUNNEL_LIMITS.options} options`);
      else {
        const oids = new Set<string>();
        s.options.forEach((o: any, j: number) => {
          if (!o || typeof o.id !== "string" || !ID.test(o.id) || oids.has(o.id)) add(`${p}.options[${j}].id`, "must be a unique id");
          else oids.add(o.id);
          if (!str(o?.label, 80) || !o.label.trim()) add(`${p}.options[${j}].label`, "is required (at most 80 characters)");
        });
      }
      if (s.attribute !== undefined && s.attribute !== null && (typeof s.attribute !== "string" || !ATTR.test(s.attribute))) add(`${p}.attribute`, "must be an attribute name (letters, digits, _ . - $)");
    }
    if (s.type === "info") {
      if (!optStr(s.body, FUNNEL_LIMITS.text)) add(`${p}.body`, `must be text of at most ${FUNNEL_LIMITS.text} characters`);
      if (s.image_url !== undefined && s.image_url !== null && s.image_url !== "" && !httpsUrl(s.image_url)) add(`${p}.image_url`, "must be an https URL");
    }
    if (s.type === "email" && !optStr(s.placeholder, 80)) add(`${p}.placeholder`, "must be text of at most 80 characters");
    if (s.type === "paywall") {
      if (s.features !== undefined && (!Array.isArray(s.features) || s.features.length > FUNNEL_LIMITS.features || s.features.some((f: unknown) => !str(f, 120)))) add(`${p}.features`, `must be at most ${FUNNEL_LIMITS.features} short lines`);
      if (!optStr(s.offering, 200)) add(`${p}.offering`, "must be an offering identifier");
    }
    if (s.type === "success" && !optStr(s.body, FUNNEL_LIMITS.text)) add(`${p}.body`, `must be text of at most ${FUNNEL_LIMITS.text} characters`);
  });
  steps.forEach((s: any, i: number) => {
    if (s?.type !== "question" || !Array.isArray(s.options)) return;
    s.options.forEach((o: any, j: number) => {
      if (o?.next !== undefined && o.next !== null && o.next !== "" && !ids.has(o.next)) add(`steps[${i}].options[${j}].next`, `goes to "${o.next}", which is not a step`);
    });
  });
  if (opts.forPublish && Array.isArray(steps) && steps.length) {
    const pay = steps.findIndex((s: any) => s?.type === "paywall");
    const succ = steps.findIndex((s: any) => s?.type === "success");
    if (pay < 0) add("steps", "needs a paywall step to sell anything");
    if (succ < 0) add("steps", "needs a success step");
    else if (succ !== steps.length - 1) add(`steps[${succ}]`, "the success step must be the last step");
    if (pay >= 0 && succ >= 0 && pay > succ) add(`steps[${pay}]`, "the paywall must come before the success step");
    if (steps.filter((s: any) => s?.type === "paywall").length > 1) add("steps", "can have only one paywall step");
    if (steps.filter((s: any) => s?.type === "success").length > 1) add("steps", "can have only one success step");
  }
  return out;
}

/** Fills missing theme fields and drops unknown keys, so a draft from the builder or the AI is stored in one shape. */
export function normalizeFunnel(doc: FunnelDoc): FunnelDoc {
  const theme: FunnelTheme = { ...DEFAULT_THEME, ...(doc.theme ?? {}) };
  const steps = (doc.steps ?? []).map((s) => {
    const base = { id: s.id, type: s.type, title: s.title, subtitle: s.subtitle ?? null } as Record<string, unknown>;
    const keep: Record<string, string[]> = {
      question: ["options", "multiple", "attribute", "button_label"], info: ["body", "image_url", "button_label"], email: ["placeholder", "required", "button_label"],
      paywall: ["offering", "features", "highlight_package", "discount_id", "allow_codes", "button_label"], success: ["body", "show_redemption"],
    };
    for (const k of keep[s.type] ?? []) if ((s as unknown as Record<string, unknown>)[k] !== undefined) base[k] = (s as unknown as Record<string, unknown>)[k];
    if (s.type === "question") base.options = (s.options ?? []).map((o) => ({ id: o.id, label: o.label, ...(o.next ? { next: o.next } : {}) }));
    return base as unknown as FunnelStep;
  });
  return { theme: { background: theme.background, text: theme.text, accent: theme.accent, button_text: theme.button_text, corner_radius: theme.corner_radius }, steps };
}
