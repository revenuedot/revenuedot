// The AI paywall designer (prd/paywalls/PRD.md §3) with a scripted JSON model: no network, no provider.
import { describe, expect, it } from "vitest";
import {
  DesignerError, briefMessages, coerceBrief, designSchema, mergeTranslations, forEachComponent, runDesigner, validatePaywall, type DesignerInput, type JsonModel, type StepEvent,
} from "../src/index.js";

const ICONS = "https://api.example.com/assets/icons";
const OFFERING: DesignerInput["offering"] = {
  offering: { id: "ofrng1", lookup_key: "default", display_name: "Default" },
  packages: [
    { id: "$rc_annual", label: "Yearly", product: { store_identifier: "drift.yearly", name: "Drift Yearly", type: "subscription", duration: "P1Y", price: { amount: 59.99, currency: "USD" } } },
    { id: "$rc_monthly", label: "Monthly", product: { store_identifier: "drift.monthly", name: "Drift Monthly", type: "subscription", duration: "P1M", price: { amount: 9.99, currency: "USD" } } },
  ],
};
const INPUT: DesignerInput = { prompt: "A calm sleep app called Drift. Yearly plan first, three benefits.", appName: "Drift", brandColors: ["#4f46e5"], offering: OFFERING };

const brief = (over: Record<string, unknown> = {}) => ({
  app_name: "Drift", locale: "en_US", extra_locales: [], tone: "calm",
  plans: { order: ["$rc_annual", "$rc_monthly"], selected: "$rc_annual", trial_packages: [], trial_days: 0, missing: [] },
  discount: { percent: 0, package_id: "", limited_time: false }, benefits: { count: 3, named: [] },
  look: { appearance: "light", gradient: false, colors: [], description: "" }, sections: [], facts: [], ...over,
});
const design = (subtitle = "{{ product.price_per_period }}") => ({
  name: "Drift", locale: "en_US",
  theme: { appearance: "light", background: { style: "solid", colors: ["#ffffff"], angle: 180 }, accent: "#4f46e5", on_accent: "#ffffff", text: "#111111", secondary_text: "#52525b", card: "#f4f4f5", card_border: "#e4e4e7", corners: "soft", dark_mode: "adapt" },
  close_button: "leading", order: ["hero", "benefits", "plans"],
  hero: { art: "icon_glow", icon: "moon", decoration: "none", eyebrow: "", title: "Sleep better with Drift", subtitle: "Calm nights, every night.", align: "center" },
  benefits: { style: "list", title: "", items: [{ icon: "moon", title: "Sleep stories", description: "" }, { icon: "wind", title: "Guided breathing", description: "" }, { icon: "download", title: "Offline downloads", description: "" }] },
  trial_timeline: null, social_proof: null, countdown: null, comparison: null, pages: null, note: null,
  plans: { layout: "list", title: "", selected: "$rc_annual", items: [
    { package_id: "$rc_annual", title: "Yearly", subtitle, trial_subtitle: "", badge: "BEST VALUE", trial: false },
    { package_id: "$rc_monthly", title: "Monthly", subtitle: "{{ product.price_per_period }}", trial_subtitle: "", badge: "", trial: false },
  ] },
  footer: { cta: "Continue", cta_trial: "", reassurance: "No commitment, cancel anytime.", disclosure: "{{ product.price_per_period }}, renews automatically. Cancel anytime.", disclosure_trial: "", restore: "Restore purchases" },
  notes: [],
});

/** A model that answers each call from `answers[name]` in turn and records what it was asked. */
function scripted(answers: Record<string, unknown[]>) {
  const calls: { name: string; user: string; schema: Record<string, unknown> }[] = [];
  const model: JsonModel = {
    async json({ name, user, schema }) {
      calls.push({ name, user, schema });
      const next = answers[name]?.shift();
      if (next instanceof Error) throw next;
      return { value: next, usage: { input: 10, output: 5 } };
    },
  };
  return { model, calls };
}

describe("AI paywall designer", () => {
  it("reads the brief with the description, the form and the offering's real prices", () => {
    const m = briefMessages({ ...INPUT, locale: "es_ES" });
    expect(m.user).toMatch(/Drift\. Yearly plan first[\s\S]*Drift[\s\S]*#4f46e5[\s\S]*es_ES/);
    expect(m.user).toContain('$rc_annual "Yearly": product drift.yearly');
    expect(m.user).toContain("price $59.99");
  });

  it("designs a valid paywall in two calls when the first draft passes the check", async () => {
    const { model, calls } = scripted({ paywall_brief: [brief()], paywall_design: [design()] });
    const steps: StepEvent[] = [];
    const r = await runDesigner(INPUT, model, { iconBaseUrl: ICONS, onStep: (e) => { steps.push(e); } });
    expect(calls.map((c) => c.name)).toEqual(["paywall_brief", "paywall_design"]);
    expect(r).toMatchObject({ rounds: 0, calls: 2, usage: { input: 20, output: 10 }, firstDraftErrors: [] });
    expect(validatePaywall(r.doc, { packages: ["$rc_annual", "$rc_monthly"] }).valid).toBe(true);
    const pkgs: [unknown, unknown][] = [];
    forEachComponent(r.doc.components_config, (c) => { if (c.type === "package") pkgs.push([c.package_id, c.is_selected_by_default]); });
    expect(pkgs).toEqual([["$rc_annual", true], ["$rc_monthly", false]]);
    expect(Object.values(r.doc.components_localizations.en_US!)).toContain("Sleep better with Drift");
    expect(steps.filter((s) => s.status !== "running").map((s) => `${s.id}:${s.status}`)).toEqual(["brief:done", "packages:done", "draft:done", "check:done", "fix:skipped", "translate:skipped"]);
    // The design schema only offers the offering's packages.
    expect(JSON.stringify(calls[1]!.schema)).toContain('"enum":["$rc_annual","$rc_monthly"]');
  });

  it("sends the checker's problems back and keeps the better draft", async () => {
    const { model, calls } = scripted({ paywall_brief: [brief()], paywall_design: [design("$59.99 a year"), design()] });
    const r = await runDesigner(INPUT, model, { iconBaseUrl: ICONS });
    expect(r.firstDraftErrors.map((e) => e.code)).toContain("price_literal");
    expect(r.rounds).toBe(1);
    expect(calls[2]!.user).toMatch(/The checker found these problems[\s\S]*typed price/);
    expect(r.fixes).toContain("Replaced typed prices with price variables.");
    expect(r.warnings.filter((w) => w.severity === "error")).toEqual([]);
  });

  it("translates into the extra languages the brief asks for, keeping only translations with the same variables", async () => {
    const { model } = scripted({
      paywall_brief: [brief({ extra_locales: ["de_DE"] })], paywall_design: [design()],
      paywall_translations: [{ locales: [{ locale: "de_DE", strings: [] }] }],
    });
    const r = await runDesigner(INPUT, model, { iconBaseUrl: ICONS });
    expect(Object.keys(r.doc.components_localizations)).toEqual(["en_US", "de_DE"]);
  });

  it("credits fixes only from an accepted repair round", async () => {
    // The repair answer fixes the plan's typed price but types two others, so it scores worse: the first draft stays,
    // and nothing may claim the plan's price was fixed.
    const worse = design();
    worse.footer.disclosure = "$9.99 a month, renews automatically.";
    worse.footer.reassurance = "Only $59.99 a year.";
    const { model } = scripted({ paywall_brief: [brief()], paywall_design: [design("$59.99 a year"), worse, worse] });
    const r = await runDesigner(INPUT, model, { iconBaseUrl: ICONS });
    expect(r.rounds).toBe(2);
    expect(r.warnings.map((w) => w.code)).toContain("price_literal");
    expect(r.fixes).not.toContain("Replaced typed prices with price variables.");
  });

  it("adds a plan the brief asks for when the model leaves it out", async () => {
    const onlyMonthly = design();
    onlyMonthly.plans.items = onlyMonthly.plans.items.filter((p) => p.package_id === "$rc_monthly");
    onlyMonthly.plans.selected = "$rc_monthly";
    const { model } = scripted({ paywall_brief: [brief()], paywall_design: [onlyMonthly] });
    const r = await runDesigner(INPUT, model, { iconBaseUrl: ICONS });
    expect(r.design.plans.items.map((p) => p.package_id)).toEqual(["$rc_annual", "$rc_monthly"]);
    expect(r.design.plans.selected).toBe("$rc_annual");
    expect(r.fixes).toContain("Added the plans the brief asks for.");
  });

  it("knows lifetime plans from their products, not from 'life' in the id", () => {
    const offering: DesignerInput["offering"] = { offering: OFFERING.offering, packages: [
      { id: "lifestyle_monthly", label: "Monthly", product: { store_identifier: "m", name: null, type: "subscription", duration: "P1M", price: null } },
      { id: "lifestyle_annual", label: "Yearly", product: { store_identifier: "y", name: null, type: "subscription", duration: "P1Y", price: null } },
      { id: "forever", label: "Forever", product: { store_identifier: "f", name: null, type: "non_consumable", duration: null, price: null } },
    ] };
    const ids = offering.packages.map((p) => p.id);
    const b = coerceBrief({ plans: { trial_packages: ["lifestyle_annual", "forever"] } }, { ...INPUT, offering }, ids);
    expect(b.plans.order).toEqual(["lifestyle_annual", "lifestyle_monthly"]);
    expect(b.plans.selected).toBe("lifestyle_annual");
    expect(b.plans.trial_packages).toEqual(["lifestyle_annual"]);
    // Only lifetime packages: the order falls back to them instead of being empty.
    const only = { offering: OFFERING.offering, packages: [offering.packages[2]!, { id: "$rc_lifetime", label: "Lifetime", product: null }] };
    expect(coerceBrief({}, { ...INPUT, offering: only }, ["forever", "$rc_lifetime"]).plans.order).toHaveLength(2);
  });

  it("an offering without packages designs with standard packages and says that offering is empty", async () => {
    const { model, calls } = scripted({ paywall_brief: [{}], paywall_design: [{}] });
    const r = await runDesigner({ ...INPUT, offering: { offering: OFFERING.offering, packages: [] } }, model, { iconBaseUrl: ICONS });
    expect(r.notes[0]).toMatch(/"Default" has no packages yet/);
    expect(JSON.stringify(calls[1]!.schema)).toContain("$rc_lifetime");
  });

  it("keeps the finished paywall when translating fails, and says so", async () => {
    const { model } = scripted({ paywall_brief: [brief({ extra_locales: ["de_DE"] })], paywall_design: [design()], paywall_translations: [new Error("timeout")] });
    const steps: StepEvent[] = [];
    const r = await runDesigner(INPUT, model, { iconBaseUrl: ICONS, onStep: (e) => { steps.push(e); } });
    expect(Object.keys(r.doc.components_localizations)).toEqual(["en_US"]);
    expect(steps.at(-1)).toMatchObject({ id: "translate", status: "error" });
    expect(r.notes.join(" ")).toMatch(/Translating into de_DE failed/);
  });

  it("merges translations of the same script only, and copies variable-only strings", () => {
    const doc = { components_config: { base: {} }, default_locale: "en_US", components_localizations: { en_US: { a: "Go Pro", b: "{{ product.price_per_period }}" } } } as unknown as Parameters<typeof mergeTranslations>[0];
    const done = mergeTranslations(doc, { locales: [{ locale: "zh_Hans", strings: [{ key: "a", text: "升级" }] }] }, ["zh_Hant"]);
    expect(done).toEqual([{ locale: "zh_Hant", translated: 0, total: 1 }]);
    expect(doc.components_localizations.zh_Hant).toEqual({ b: "{{ product.price_per_period }}" });
  });

  it("fails with the step that broke when the model errors", async () => {
    const { model } = scripted({ paywall_brief: [new Error("gateway down")] });
    const e = await runDesigner(INPUT, model, { iconBaseUrl: ICONS }).catch((x) => x);
    expect(e).toBeInstanceOf(DesignerError);
    expect(e).toMatchObject({ step: "brief", message: "gateway down", retryable: true });
  });

  it("keeps the brief to the offering's packages and sane numbers", () => {
    const b = coerceBrief({ plans: { order: ["$rc_lifetime", "$rc_monthly"], selected: "$rc_weekly", trial_days: 9999 }, discount: { percent: 300 } }, INPUT, ["$rc_annual", "$rc_monthly"]);
    expect(b.plans).toMatchObject({ order: ["$rc_monthly"], selected: "$rc_monthly", trial_days: 365 });
    expect(b.discount.percent).toBe(95);
    expect(b.app_name).toBe("Drift");
  });

  it("writes a strict schema: every object lists all its properties and allows no others", () => {
    const walk = (s: unknown): void => {
      if (!s || typeof s !== "object") return;
      const o = s as Record<string, unknown>;
      if (o.type === "object") {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      }
      Object.values(o).forEach(walk);
    };
    walk(designSchema({ packages: ["$rc_annual"] }));
  });
});
