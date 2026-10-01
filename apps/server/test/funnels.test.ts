import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { buildIntegration } from "@revenuedot/core/integrations";
import { fakeModel } from "../src/services/paywall-ai.js";
import { webEnv, type WebEnv } from "../../../packages/contract/src/web-env.js";

/**
 * Funnels (prd/web-billing/PRD.md §5): create from the starter, validation, publish, the public page, events from the page,
 * opt-in delivery to webhooks and analytics tools, a purchase with answers saved as attributes, analytics, and Build with AI.
 */
let env: WebEnv;
afterEach(async () => { await env?.h.close(); });
const P = () => `/v2/projects/${env.h.ids.project}`;
const event = (json: Record<string, unknown>) => env.raw("http://localhost/pay/api/events", { method: "POST", json });

describe("funnels", () => {
  it("builds, publishes, records the visit step by step, converts, and reports the drop-off", async () => {
    env = await webEnv();
    await env.setupWeb();
    // A webhook that asks for funnel events and one that does not.
    const wanted = await env.api("POST", `${P()}/integrations/webhooks`, { name: "Funnels", url: "https://hooks.example.com/f", event_types: ["funnel_viewed", "funnel_step_completed", "funnel_purchase", "initial_purchase"] });
    expect(wanted.status).toBe(201);
    await env.api("POST", `${P()}/integrations/webhooks`, { name: "All", url: "https://hooks.example.com/all" });

    const created = await env.api("POST", `${P()}/funnels`, { name: "Focus quiz" });
    expect(created.status).toBe(201);
    const f = created.body;
    expect(f).toMatchObject({ object: "funnel", slug: "focus-quiz", status: "draft", url: "http://localhost/pay/scanner/focus-quiz", problems: [], app_id: "app_web" });
    expect(f.draft.steps.map((s: any) => s.type)).toEqual(["question", "info", "email", "paywall", "success"]);

    // Drafts are validated; the paywall step points at the web offering.
    const bad = await env.api("PATCH", `${P()}/funnels/${f.id}`, { draft: { ...f.draft, theme: { ...f.draft.theme, accent: "blue" } } });
    expect(bad.status).toBe(400);
    expect(bad.body.param).toBe("draft.theme.accent");
    const draft = structuredClone(f.draft);
    draft.steps[3].offering = "web";
    draft.steps[3].highlight_package = "$rc_annual";
    expect((await env.api("PATCH", `${P()}/funnels/${f.id}`, { draft })).status).toBe(200);
    expect((await env.raw(f.url)).status).toBe(404);

    const noPay = await env.api("PATCH", `${P()}/funnels/${f.id}`, { draft: { ...draft, steps: draft.steps.filter((s: any) => s.type !== "paywall") } });
    expect(noPay.body.problems.map((p: any) => p.message)).toContain("needs a paywall step to sell anything");
    expect((await env.api("POST", `${P()}/funnels/${f.id}/actions/publish`)).status).toBe(422);
    await env.api("PATCH", `${P()}/funnels/${f.id}`, { draft });
    const pub = await env.api("POST", `${P()}/funnels/${f.id}/actions/publish`);
    expect(pub.body).toMatchObject({ status: "published", has_unpublished_changes: false, published_at: env.h.now().getTime() });

    const page = await env.raw(`${f.url}?utm_source=tiktok&utm_campaign=fall`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("What do you want to get done?");
    expect(html).toContain('"utm_source":"tiktok"');
    expect(html).toMatch(/data-pkg="\$rc_annual" aria-checked="true"/);
    const session = /"session_id":"([0-9a-f]{32})"/.exec(html)![1]!;

    // The page's events; junk is ignored with 204.
    const base = { funnel_id: f.id, session_id: session, query: { utm_source: "tiktok" } };
    for (const [type, step, answer] of [["funnel_viewed"], ["step_viewed", "goal"], ["step_completed", "goal", "Sleep better"], ["step_viewed", "plan"], ["step_completed", "plan"], ["step_viewed", "email"], ["step_completed", "email", "provided"], ["step_viewed", "paywall"]] as [string, string?, string?][]) {
      expect((await event({ ...base, type, step_id: step, answer })).status).toBe(204);
    }
    expect((await event({ ...base, type: "purchase" })).status).toBe(204);
    expect((await event({ ...base, type: "step_viewed", step_id: "nope" })).status).toBe(204);
    expect((await event({ funnel_id: "fnl_nope", session_id: session, type: "funnel_viewed" })).status).toBe(204);
    const rows = await env.h.db.select().from(schema.funnelEvents);
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.type === "step_completed" && r.stepId === "email")!.properties).toMatchObject({ answer: "provided" });

    // A second visitor leaves after the first question.
    await event({ funnel_id: f.id, session_id: "second0000000000", type: "funnel_viewed" });
    await event({ funnel_id: f.id, session_id: "second0000000000", type: "step_viewed", step_id: "goal" });

    // Checkout from the paywall with the answers: they become attributes once the purchase completes.
    const start = await env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug: "focus-quiz", package: "$rc_annual", email: "quiz@example.com", session, answers: { goal: "Sleep better", email: "provided" } } });
    expect(start.status).toBe(200);
    const { url } = await start.json() as { url: string };
    const s = env.stripe.complete(new URL(url).pathname.split("/").pop()!);
    expect(env.stripe.writes("/v1/checkout/sessions")[0]!.params).toMatchObject({ customer_email: "quiz@example.com", metadata: { rd_source: `funnel:${f.id}` } });
    const success = await (await env.raw(s.success_url)).text();
    expect(success).toContain("You are in");
    expect(success).toMatch(/\/pay\/r\/rdrt_/);
    const anon = s.metadata.app_user_id as string;
    const [cust] = await env.h.db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, anon));
    const attrs = await env.h.db.select().from(schema.customerAttributes).where(eq(schema.customerAttributes.customerId, cust!.customerId));
    expect(Object.fromEntries(attrs.map((a) => [a.key, a.value]))).toMatchObject({ goal: "Sleep better", $email: "quiz@example.com" });

    // Analytics: 2 views, the second visitor dropped at the first step, 1 purchase.
    const a = (await env.api("GET", `${P()}/funnels/${f.id}/analytics?days=7`)).body;
    expect(a).toMatchObject({ object: "funnel_analytics", views: 2, checkouts: 1, purchases: 1, conversion: 0.5 });
    expect(a.revenue_usd).toBeCloseTo(59.99, 2);
    expect(a.steps[0]).toEqual({ id: "goal", type: "question", title: "What do you want to get done?", viewed: 2, completed: 1, drop_off: 0.5 });
    expect(a.steps[4]).toMatchObject({ type: "success", viewed: 1, completed: 1, drop_off: 0 });
    expect(a.daily).toHaveLength(7);
    const list = (await env.api("GET", `${P()}/funnels`)).body.items;
    expect(list[0]).toMatchObject({ views_30d: 2, purchases_30d: 1, status: "published" });

    // Funnel events reached only the webhook that asked for them.
    const evs = await env.events();
    expect(evs.filter((e) => e.type === "FUNNEL_VIEWED")).toHaveLength(2);
    const purchase = evs.find((e) => e.type === "FUNNEL_PURCHASE")!;
    expect(purchase).toMatchObject({ funnel_id: f.id, funnel_name: "Focus quiz", session_id: session, app_user_id: anon, store: "STRIPE", environment: "SANDBOX" });
    const step = evs.find((e) => e.type === "FUNNEL_STEP_COMPLETED" && e.step_id === "goal")!;
    expect(step).toMatchObject({ step_type: "question", step_index: 0, answer: "Sleep better", utm_source: "tiktok" });
    const deliveries = await env.h.db.select({ w: schema.webhookDeliveries.webhookId, e: schema.events.type }).from(schema.webhookDeliveries).innerJoin(schema.events, eq(schema.events.id, schema.webhookDeliveries.eventId));
    const toAll = deliveries.filter((d) => d.w !== wanted.body.id).map((d) => d.e);
    expect(toAll.some((t) => t.startsWith("FUNNEL_"))).toBe(false);
    expect(deliveries.filter((d) => d.w === wanted.body.id).map((d) => d.e)).toEqual(expect.arrayContaining(["FUNNEL_VIEWED", "FUNNEL_STEP_COMPLETED", "FUNNEL_PURCHASE", "INITIAL_PURCHASE"]));

    // Analytics tools name them rd_funnel_* and carry the funnel fields.
    const plan = await buildIntegration("segment", { event: step, settings: {}, secrets: { write_key: "wk_test" }, now: env.h.now() });
    expect("requests" in plan && JSON.parse(plan.requests[0]!.body)).toMatchObject({ event: "rd_funnel_step_completed", properties: { funnel_id: f.id, step_id: "goal", answer: "Sleep better", utm_source: "tiktok" } });

    // Unpublish takes the page down; preview data has the web packages.
    const pd = (await env.api("GET", `${P()}/funnels/${f.id}/preview_data`)).body;
    expect(pd.packages.web.map((p: any) => p.id)).toEqual(["$rc_monthly", "$rc_annual", "$rc_lifetime"]);
    expect(pd.look).toMatchObject({ app_name: "Scanner" });
    expect((await env.api("POST", `${P()}/funnels/${f.id}/actions/unpublish`)).body.status).toBe("draft");
    expect((await env.raw(f.url)).status).toBe(404);
  });

  it("Build with AI returns a publishable draft with the paywall model's caps", async () => {
    const answer = "```json\n" + JSON.stringify({ steps: [{ id: "q", type: "question", title: "How do you sleep?", options: ["Badly", "OK"] }, { type: "paywall", title: "Sleep better" }] }) + "\n```";
    env = await webEnv({ ai: fakeModel(answer) });
    expect((await env.api("GET", `${P()}/funnels/ai`)).body).toMatchObject({ available: true, provider: "Fake" });
    const g = await env.api("POST", `${P()}/funnels/generate`, { prompt: "A sleep app quiz for people who wake up at night" });
    expect(g.status).toBe(200);
    expect(g.body.draft.steps.map((s: any) => s.type)).toEqual(["question", "paywall", "success"]);
    expect(g.body.fixes).toContain("added a success step");
    expect((await env.api("POST", `${P()}/funnels/generate`, { prompt: "again right away" })).status).toBe(429);
    const c = await env.api("POST", `${P()}/funnels`, { name: "AI quiz", draft: g.body.draft });
    expect(c.status).toBe(201);
    expect(c.body.problems).toEqual([]);
    const off = await webEnv();
    expect((await off.api("POST", `/v2/projects/${off.h.ids.project}/funnels/generate`, { prompt: "a quiz" })).status).toBe(503);
    await off.h.close();
  });
});
