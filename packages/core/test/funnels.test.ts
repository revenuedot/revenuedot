import { describe, expect, it } from "vitest";
import {
  funnelFromModel, normalizeFunnel, priceLabels, purchaseLinkFunnel, renderFunnelPage, renderMessagePage, repairFunnel, starterFunnel, validateFunnel,
  type FunnelDoc,
} from "../src/funnels/index.js";

/** Funnels (prd/web-billing/PRD.md §5): validation, the AI repair, price labels and the one HTML renderer. */

const look = { app_name: "Scanner", terms_url: "https://scanner.example/terms", privacy_url: "https://scanner.example/privacy", support_email: "help@scanner.example" };
const pkgs = { "": [{ id: "$rc_monthly", name: "Monthly", price: "$9.99", period: "per month", detail: "7-day free trial, then $9.99 per month" }] };

describe("validateFunnel", () => {
  it("accepts the starter funnel and a purchase link's two steps, for publishing too", () => {
    expect(validateFunnel(starterFunnel(), { forPublish: true })).toEqual([]);
    expect(validateFunnel(purchaseLinkFunnel({ title: "Pro", offering: "web", allowCodes: true }), { forPublish: true })).toEqual([]);
  });

  it("reports bad colours, ids, duplicate ids, missing options, unknown paths and http images", () => {
    const f = starterFunnel() as any;
    f.theme.accent = "red";
    f.steps[0].options.push({ id: "focus", label: "dup" });
    f.steps[0].options[1].next = "nowhere";
    f.steps[1].image_url = "http://example.com/x.png";
    f.steps[2].id = "Bad Id";
    f.steps.push({ id: "paywall", type: "info", title: "again" });
    const paths = validateFunnel(f).map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(["theme.accent", "steps[0].options[3].id", "steps[0].options[1].next", "steps[1].image_url", "steps[2].id", "steps[5].id"]));
  });

  it("publishing needs one paywall before the success step, which is last", () => {
    const f = starterFunnel();
    const noPay = { ...f, steps: f.steps.filter((s) => s.type !== "paywall") };
    expect(validateFunnel(noPay, { forPublish: true }).map((p) => p.message)).toContain("needs a paywall step to sell anything");
    const succFirst = { ...f, steps: [f.steps[4]!, ...f.steps.slice(0, 4)] };
    expect(validateFunnel(succFirst, { forPublish: true }).map((p) => p.message)).toEqual(expect.arrayContaining(["the success step must be the last step"]));
    expect(validateFunnel(succFirst)).toEqual([]);
  });

  it("normalizeFunnel keeps known keys only and fills the theme", () => {
    const n = normalizeFunnel({ theme: { accent: "#123456" } as never, steps: [{ id: "a", type: "info", title: "Hi", evil: "<script>" } as never] });
    expect(n.theme).toMatchObject({ accent: "#123456", background: "#FFFFFF", corner_radius: 0 });
    expect(n.steps[0]).toEqual({ id: "a", type: "info", title: "Hi", subtitle: null });
  });
});

describe("Build with AI repair", () => {
  it("turns a sloppy model answer into a publishable funnel", () => {
    const answer = "Sure!\n```json\n" + JSON.stringify({
      theme: { background: "#0f172a", text: "#ffffff", accent: "#22c55e", button_text: "#000000", corner_radius: 40 },
      steps: [
        { type: "success", title: "Done" },
        { id: "Goal Q", type: "question", title: "Your goal?", options: ["Focus", { label: "Sleep", next: "missing" }, { label: "" }] },
        { type: "video", title: "x" },
        { id: "pay", type: "paywall", title: "Unlock", features: ["A", "B"] },
        { id: "pay2", type: "paywall", title: "Again" },
      ],
    }) + "\n```";
    const out = funnelFromModel(answer);
    expect(out.problems).toEqual([]);
    expect(out.funnel.theme.corner_radius).toBe(24);
    expect(out.funnel.steps.map((s) => s.type)).toEqual(["question", "paywall", "success"]);
    expect(out.funnel.steps[0]!.id).toBe("goal_q");
    expect((out.funnel.steps[0] as any).options.map((o: any) => o.label)).toEqual(["Focus", "Sleep"]);
    expect(out.fixes).toEqual(expect.arrayContaining(["dropped step 3 (unknown type)", "kept one paywall step"]));
    expect(() => funnelFromModel("no json here")).toThrow();
    expect(repairFunnel({}).funnel.steps.map((s) => s.type)).toEqual(["paywall", "success"]);
  });
});

describe("price labels", () => {
  it("formats amounts, periods and trials, zero-decimal currencies included", () => {
    expect(priceLabels({ amount_minor: 999, currency: "usd", interval: "month", interval_count: 1, trial_days: 7 })).toEqual({ price: "$9.99", period: "per month", detail: "7-day free trial, then $9.99 per month" });
    expect(priceLabels({ amount_minor: 1200, currency: "jpy", interval: null })).toMatchObject({ price: "¥1,200", period: "once", detail: "¥1,200 one-time payment" });
    expect(priceLabels({ amount_minor: 2999, currency: "eur", interval: "month", interval_count: 3 }).period).toBe("every 3 months");
  });
});

describe("renderFunnelPage", () => {
  const base = (doc: FunnelDoc, extra: Partial<Parameters<typeof renderFunnelPage>[0]> = {}) => renderFunnelPage({ funnel: doc, look, packages: pkgs, mode: "live", nonce: "abc123", urls: { checkout: "/pay/api/checkout", events: "/pay/api/events", discount: "/pay/api/discount" }, context: { project: "scanner", slug: "quiz", funnel_id: "fnl_1", session_id: "s1234567890" }, ...extra });

  it("renders every step type with the theme, nonce, legal links and the packages", () => {
    const html = base(starterFunnel());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<style nonce="abc123">');
    expect(html).toContain('<script nonce="abc123">');
    for (const t of ["question", "info", "email", "paywall", "success"]) expect(html).toContain(`data-type="${t}"`);
    expect(html).toContain("7-day free trial, then $9.99 per month");
    expect(html).toContain('href="https://scanner.example/terms"');
    expect(html).toContain("mailto:help@scanner.example");
    expect(html).toContain("Have a discount code?");
    expect(html).toContain('"funnel_id":"fnl_1"');
    // The pages' CSP allows no inline style attributes (only the nonce'd <style>).
    expect(html).not.toMatch(/ style="/);
    expect(renderMessagePage({ title: "x", body: "y", action: { label: "Go", href: "https://x.example" } })).not.toMatch(/ style="/);
  });

  it("escapes every text, refuses unsafe URLs and colours, and keeps the data script closed", () => {
    const doc = starterFunnel();
    doc.steps[0]!.title = '<img src=x onerror=alert(1)>"';
    (doc.steps[1] as any).image_url = "javascript:alert(1)";
    doc.theme.background = "red;}</style><script>alert(1)</script>" as never;
    const html = base(doc, { look: { ...look, app_name: "</script><b>x", logo_url: "http://evil.example/x.png", terms_url: "javascript:alert(1)" }, context: { email: '"><svg onload=1>', session_id: "s", project: "p", slug: "s" } });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<svg onload");
    expect(html.match(/<\/script>/g)!.length).toBe(2);
    expect(html).toContain("--bg:#FFFFFF");
  });

  it("preview mode makes no network calls and shows the selected step; the success page shows the redemption buttons", () => {
    const prev = renderFunnelPage({ funnel: starterFunnel(), look, packages: pkgs, mode: "preview", startStepId: "paywall" });
    expect(prev).toContain('"mode":"preview"');
    expect(prev).toContain('"start":"paywall"');
    const succ = renderFunnelPage({ funnel: starterFunnel(), look, packages: {}, mode: "live", startStepId: "success", success: { status: "paid", redeem_url: "https://pay.example/r/rdrt_x", deep_link: "scanner://redeem_web_purchase?redemption_token=rdrt_x", app_store_url: "https://apps.apple.com/app/id1", play_store_url: null } });
    expect(succ).toContain('href="https://pay.example/r/rdrt_x" data-redeem');
    expect(succ).toContain(">App Store</a>");
    expect(succ).not.toContain("Google Play");
    const processing = renderFunnelPage({ funnel: starterFunnel(), look, packages: {}, mode: "live", startStepId: "success", success: { status: "processing" } });
    expect(processing).toContain("Your payment is processing");
    expect(renderMessagePage({ title: "Gone <b>", body: "x" })).toContain("Gone &lt;b&gt;");
  });
});
