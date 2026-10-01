import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { buildIntegration, sendsEvent, type IntegrationKind } from "@revenuedot/core/integrations";
import { webEnv, type WebEnv } from "../../../packages/contract/src/web-env.js";

/**
 * Funnel events to ad networks (Batch D item 5; prd/integrations/PRD.md "Funnel events to ad networks"): when an
 * integration's filter asks for FUNNEL_* events, the funnel records the visitor's browser (IP, user agent, page URL) and
 * the landing URL's ad click ids, the server-side purchase inherits them, and Meta, Google Tag Manager, Branch and
 * AppsFlyer get web events they can match. Without such an integration no visitor IP is stored.
 */
let env: WebEnv;
afterEach(async () => { await env?.h.close(); });
const P = () => `/v2/projects/${env.h.ids.project}`;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

async function publishedFunnel() {
  const f = (await env.api("POST", `${P()}/funnels`, { name: "Focus quiz" })).body;
  const draft = structuredClone(f.draft);
  draft.steps[3].offering = "web";
  await env.api("PATCH", `${P()}/funnels/${f.id}`, { draft });
  expect((await env.api("POST", `${P()}/funnels/${f.id}/actions/publish`)).status).toBe(200);
  return f;
}

async function visit(f: any, query: Record<string, string>) {
  const html = await (await env.raw(`${f.url}?${new URLSearchParams(query)}`)).text();
  const session = /"session_id":"([0-9a-f]{32})"/.exec(html)![1]!;
  const visitor = /"visitor_id":"(\$RCAnonymousID:[0-9a-f]{32})"/.exec(html)![1]!;
  const send = (json: Record<string, unknown>) => env.raw("http://localhost/pay/api/events", {
    method: "POST", headers: { "user-agent": UA, "cf-connecting-ip": "203.0.113.9" },
    json: { funnel_id: f.id, session_id: session, app_user_id: visitor, query, page_url: f.url, ...json },
  });
  return { session, visitor, send };
}

describe("funnel events to ad networks", () => {
  it("Meta, Tag Manager, Branch and AppsFlyer get matchable web events; the purchase inherits the landing context", async () => {
    env = await webEnv();
    await env.setupWeb();
    const types = ["funnel_viewed", "funnel_step_completed", "funnel_purchase"];
    const meta = await env.api("POST", `${P()}/integrations/partners`, { type: "meta", environment: null, event_types: types, settings: { dataset_id: "111", access_token: "EAAB_live", sandbox_dataset_id: "222", sandbox_access_token: "EAAB_sbx" } });
    expect(meta.status).toBe(201);
    const af = await env.api("POST", `${P()}/integrations/partners`, { type: "appsflyer", environment: null, event_types: types, settings: { dev_key: "af_dev", web_app_id: "web-brand-1", web_s2s_token: "af_web_token" } });
    expect(af.status).toBe(201);
    const f = await publishedFunnel();
    const v = await visit(f, { utm_source: "facebook", utm_campaign: "fall", fbclid: "IwAR3abc", gclid: "Cj0KCQ" });
    expect((await v.send({ type: "funnel_viewed" })).status).toBe(204);
    expect((await v.send({ type: "step_completed", step_id: "email", answer: "provided" })).status).toBe(204);

    const start = await env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug: "focus-quiz", package: "$rc_annual", session: v.session, visitor_id: v.visitor } });
    const { url } = await start.json() as { url: string };
    const s = env.stripe.complete(new URL(url).pathname.split("/").pop()!);
    await env.raw(s.success_url);

    const viewed = (await env.events("FUNNEL_VIEWED"))[0]!;
    expect(viewed).toMatchObject({ client_ip: "203.0.113.9", client_user_agent: UA, page_url: f.url, click_ids: { fbclid: "IwAR3abc", gclid: "Cj0KCQ" }, utm_source: "facebook" });
    // Recorded from Stripe's checkout completion, with the landing page's browser and click ids.
    const purchase = (await env.events("FUNNEL_PURCHASE"))[0]!;
    expect(purchase).toMatchObject({ client_ip: "203.0.113.9", client_user_agent: UA, click_ids: { fbclid: "IwAR3abc" }, currency: "USD", app_user_id: v.visitor, environment: "SANDBOX" });
    expect(purchase.revenue_usd).toBeCloseTo(59.99, 2);
    const lead = (await env.events("FUNNEL_STEP_COMPLETED")).find((e) => e.step_type === "email")!;

    // Queued to both integrations, by their filters.
    const queued = await env.h.db.select({ i: schema.integrationDeliveries.integrationId, t: schema.events.type }).from(schema.integrationDeliveries).innerJoin(schema.events, eq(schema.events.id, schema.integrationDeliveries.eventId));
    expect(queued.filter((q) => q.i === meta.body.id).map((q) => q.t).sort()).toEqual(expect.arrayContaining(["FUNNEL_PURCHASE", "FUNNEL_STEP_COMPLETED", "FUNNEL_VIEWED"]));

    const now = env.h.now();
    const metaPlan = await buildIntegration("meta", { event: purchase, settings: { dataset_id: "111", sandbox_dataset_id: "222" }, secrets: { access_token: "EAAB_live", sandbox_access_token: "EAAB_sbx" }, now });
    expect("requests" in metaPlan).toBe(true);
    if (!("requests" in metaPlan)) return;
    expect(metaPlan.requests[0]!.url).toBe("https://graph.facebook.com/v21.0/222/events");
    const metaBody = JSON.parse(metaPlan.requests[0]!.body);
    expect(metaBody.data[0]).toMatchObject({
      event_name: "Purchase", event_id: purchase.id, action_source: "website", event_source_url: f.url,
      user_data: { client_user_agent: UA, client_ip_address: "203.0.113.9", fbc: `fb.1.${purchase.event_timestamp_ms}.IwAR3abc` },
      custom_data: { currency: "USD", content_category: "funnel", funnel_id: f.id },
    });
    expect(metaBody.data[0].custom_data.value).toBeCloseTo(59.99, 2);
    expect(metaBody.data[0].user_data.external_id[0]).toMatch(/^[0-9a-f]{64}$/);
    const leadPlan = await buildIntegration("meta", { event: lead, settings: { sandbox_dataset_id: "222" }, secrets: { sandbox_access_token: "t" }, now });
    expect("name" in leadPlan && leadPlan.name).toBe("Lead");

    const gtm = await buildIntegration("google_tag_manager", { event: { ...viewed, environment: "PRODUCTION" }, settings: { server_container_url: "https://sgtm.example.com", measurement_id: "G-ABC123" }, secrets: {}, now });
    expect("requests" in gtm && JSON.parse(gtm.requests[0]!.body).events[0]).toMatchObject({ name: "page_view", params: { page_location: `${f.url}?utm_source=facebook&utm_campaign=fall&gclid=Cj0KCQ`, funnel_id: f.id } });

    const branch = await buildIntegration("branch", { event: purchase, settings: {}, secrets: { branch_key: "key_live_x", sandbox_branch_key: "key_test_x" }, now });
    expect("requests" in branch && branch.requests[0]!.url).toBe("https://api2.branch.io/v2/event/standard");
    expect("requests" in branch && JSON.parse(branch.requests[0]!.body)).toMatchObject({ name: "PURCHASE", branch_key: "key_test_x", user_data: { developer_identity: v.visitor, user_agent: UA, ip: "203.0.113.9", http_origin: f.url }, custom_data: { fbclid: "IwAR3abc", utm_source: "facebook" }, event_data: { currency: "USD" } });

    // AppsFlyer has no web sandbox: sandbox funnel events skip; a production one goes to the Web S2S API.
    expect(await buildIntegration("appsflyer", { event: purchase, settings: { web_app_id: "web-brand-1" }, secrets: { web_s2s_token: "tok" }, now })).toEqual({ skip: "Sandbox funnel events are not sent to AppsFlyer, which has no web sandbox." });
    const afPlan = await buildIntegration("appsflyer", { event: { ...purchase, environment: "PRODUCTION" }, settings: { web_app_id: "web-brand-1" }, secrets: { web_s2s_token: "tok" }, now });
    expect("requests" in afPlan && afPlan.requests[0]).toMatchObject({ method: "POST", url: "https://events.appsflyer.com/v2.0/s2s/inapps/app/web/web-brand-1", headers: { authorization: "Bearer tok" } });
    const afBody = "requests" in afPlan ? JSON.parse(afPlan.requests[0]!.body) : null;
    expect(afBody).toMatchObject({ event_name: "rd_funnel_purchase", event_revenue_currency: "USD", user_id: { customer_user_id: v.visitor }, event_value: { funnel_id: f.id, fbclid: "IwAR3abc" } });

    // Partners that match only by mobile device ids never queue funnel events.
    for (const k of ["adjust", "kochava", "singular", "tenjin", "airbridge"] as IntegrationKind[]) expect(sendsEvent(k, purchase), k).toBe(false);
    for (const k of ["meta", "google_tag_manager", "branch", "appsflyer"] as IntegrationKind[]) expect(sendsEvent(k, purchase), k).toBe(true);
  });

  it("stores no visitor IP when no integration asks for funnel events", async () => {
    env = await webEnv();
    await env.setupWeb();
    await env.api("POST", `${P()}/integrations/webhooks`, { name: "Funnels", url: "https://hooks.example.com/f", event_types: ["funnel_viewed"] });
    const f = await publishedFunnel();
    const v = await visit(f, { fbclid: "IwAR3abc" });
    await v.send({ type: "funnel_viewed" });
    const [row] = await env.h.db.select().from(schema.funnelEvents);
    expect(row!.properties).toMatchObject({ click_ids: { fbclid: "IwAR3abc" } });
    expect(row!.properties).not.toHaveProperty("client_ip");
    expect((await env.events("FUNNEL_VIEWED"))[0]).not.toHaveProperty("client_user_agent");
  });
});
