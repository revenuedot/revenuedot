import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { tick } from "../src/services/tick.js";
import { matches } from "../src/services/integrations/queue.js";
import { getOrCreateCustomer, setAttributes } from "../src/repo/customers.js";

/**
 * Paywall events to integrations and webhooks (prd/integrations/PRD.md "Paywall events"): the SDK posts them to
 * /v1/events; an `events` row is written and delivered only where an enabled filter names the type, a resent batch is
 * not delivered twice, and malformed events are still skipped.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
let h: Harness;
beforeEach(async () => { h = await harness({ encryptionKey: KEY }); });
afterEach(async () => { await h.close(); });

const v2 = async (method: string, path: string, json?: unknown) => {
  const res = await h.fetch(`/v2/projects/proj1${path}`, { method, key: h.ids.secretKey, json });
  return { status: res.status, body: await res.json() as any };
};
const ts = () => h.now().getTime() - 1000;
const impression = (id: string) => ({
  id, version: 1, type: "paywall_impression", app_user_id: "user_42", paywall_id: "pw_spring", session_id: "S-1", offering_id: "default", paywall_revision: 2,
  timestamp: ts(), display_mode: "full_screen", dark_mode: true, locale: "en_US", presented_offering_context: { placement_identifier: "onboarding" },
});
const post = (events: unknown[], headers: Record<string, string> = {}) => h.fetch("/v1/events", { method: "POST", json: { events }, headers });

describe("paywall events from /v1/events", () => {
  it("are delivered only to the integrations and webhooks that opted in, once, with the paywall fields", async () => {
    const { customer } = await getOrCreateCustomer(h.db, "proj1", "user_42", h.now());
    await setAttributes(h.db, customer.id, { $email: { value: "wren@example.com", updated_at_ms: 1 } }, h.now());
    await h.db.insert(schema.paywalls).values({ id: "pw_spring", projectId: "proj1", name: "Spring sale" });
    const amp = await v2("POST", "/integrations/partners", { type: "amplitude", event_types: ["paywall_impression", "paywall_component_interacted"], settings: { api_key: "amp_key" } });
    expect(amp.status).toBe(201);
    const mp = await v2("POST", "/integrations/partners", { type: "mixpanel", settings: { project_token: "mp_token" } });
    expect(mp.status).toBe(201);
    const hook = await v2("POST", "/integrations/webhooks", { name: "Paywalls", url: "https://hooks.example.com/rd", event_types: ["paywall_close"] });
    expect(hook.status).toBe(201);

    const batch = [
      impression("E1"),
      { ...impression("E2"), type: "paywall_close" },
      { ...impression("E3"), type: "paywall_purchase_initiated", package_id: "$rc_annual", product_id: "pro_annual" },
      { ...impression("E4"), type: "customer_center_impression" },
      null, "junk", { id: "E5" }, { id: "E6", type: "" },
    ];
    expect((await post(batch)).status).toBe(200);
    // The SDK resends the same batch until it gets a 2xx: nothing is written or queued twice.
    expect((await post(batch)).status).toBe(200);

    const evs = await h.db.select().from(schema.events).where(eq(schema.events.projectId, "proj1"));
    expect(evs.map((e) => e.type).sort()).toEqual(["PAYWALL_CLOSE", "PAYWALL_IMPRESSION"]);
    const imp = evs.find((e) => e.type === "PAYWALL_IMPRESSION")!;
    expect(imp).toMatchObject({ customerId: customer.id, environment: "production", appId: "app_ios" });
    const event = (imp.payload as any).event;
    expect(event).toMatchObject({
      id: imp.id, type: "PAYWALL_IMPRESSION", app_id: "app_ios", app_user_id: "user_42", original_app_user_id: "user_42", aliases: ["user_42"],
      environment: "PRODUCTION", store: "APP_STORE", paywall_id: "pw_spring", paywall_name: "Spring sale", paywall_revision: 2, offering_id: "default",
      session_id: "S-1", display_mode: "full_screen", dark_mode: true, locale: "en_US", placement_identifier: "onboarding",
      subscriber_attributes: { $email: { value: "wren@example.com" } },
    });
    expect(event).not.toHaveProperty("price");
    expect(imp.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);

    const intDel = await h.db.select({ i: schema.integrationDeliveries.integrationId, t: schema.events.type }).from(schema.integrationDeliveries).innerJoin(schema.events, eq(schema.events.id, schema.integrationDeliveries.eventId));
    expect(intDel).toEqual([{ i: amp.body.id, t: "PAYWALL_IMPRESSION" }]);
    const hookDel = await h.db.select({ w: schema.webhookDeliveries.webhookId, t: schema.events.type }).from(schema.webhookDeliveries).innerJoin(schema.events, eq(schema.events.id, schema.webhookDeliveries.eventId));
    expect(hookDel).toEqual([{ w: hook.body.id, t: "PAYWALL_CLOSE" }]);
    // Every SDK event is still kept for the charts (malformed ones are skipped).
    expect(await h.db.select().from(schema.sdkEvents)).toHaveLength(4);

    // Delivery: Amplitude gets paywall_impression with the paywall fields and no revenue (fake partner).
    const seen: { url: string; body: string }[] = [];
    const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), body: String(init.body ?? "") });
      return new Response(JSON.stringify({ code: 200, events_ingested: 1 }), { status: 200 });
    }) as typeof fetch;
    await tick(h.db, h.now(), f, { encryptionKey: KEY, publicUrl: "https://app.example.com" });
    const sent = seen.find((s) => s.url.includes("amplitude"))!;
    const ev = JSON.parse(sent.body).events[0];
    expect(ev).toMatchObject({ event_type: "paywall_impression", user_id: "user_42", insert_id: imp.id, event_properties: { paywall_id: "pw_spring", paywall_name: "Spring sale", session_id: "S-1" } });
    expect(ev).not.toHaveProperty("revenue");
    const log = await v2("GET", `/integrations/partners/${amp.body.id}/deliveries`);
    expect(log.body.items[0]).toMatchObject({ event_type: "PAYWALL_IMPRESSION", status: "delivered", sent_as: "paywall_impression" });
    const toHook = seen.find((s) => s.url === "https://hooks.example.com/rd")!;
    expect(JSON.parse(toHook.body)).toMatchObject({ api_version: "1.0", event: { type: "PAYWALL_CLOSE", paywall_id: "pw_spring" } });
  });

  it("writes nothing when no filter names a paywall type, and sandbox comes from the header", async () => {
    await v2("POST", "/integrations/partners", { type: "posthog", settings: { api_key: "phc_key" } });
    await post([impression("A1")]);
    expect(await h.db.select().from(schema.events)).toHaveLength(0);
    await v2("POST", "/integrations/partners", { type: "segment", event_types: ["paywall_impression"], settings: { write_key: "wk" } });
    await post([impression("A2")], { "x-is-sandbox": "true" });
    const [e] = await h.db.select().from(schema.events);
    expect(e).toMatchObject({ type: "PAYWALL_IMPRESSION", environment: "sandbox", customerId: null });
    expect((e!.payload as any).event).toMatchObject({ environment: "SANDBOX", aliases: ["user_42"], original_app_user_id: "user_42", subscriber_attributes: {} });
  });

  it("paywall types add to an integration's filter instead of narrowing it; funnel types still narrow it", () => {
    const row = (eventTypes: string[] | null) => ({ kind: "amplitude", environment: "both", appId: null, eventTypes }) as never;
    const o = (type: string) => ({ type, environment: "production", appId: null, event: { type, period_type: "NORMAL" } });
    expect(matches(row(["PAYWALL_IMPRESSION"]), o("INITIAL_PURCHASE"))).toBe(true);
    expect(matches(row(["PAYWALL_IMPRESSION"]), o("PAYWALL_IMPRESSION"))).toBe(true);
    expect(matches(row(["PAYWALL_IMPRESSION"]), o("PAYWALL_CLOSE"))).toBe(false);
    expect(matches(row(null), o("PAYWALL_IMPRESSION"))).toBe(false);
    expect(matches(row(["RENEWAL", "PAYWALL_IMPRESSION"]), o("INITIAL_PURCHASE"))).toBe(false);
    expect(matches(row(["RENEWAL", "PAYWALL_IMPRESSION"]), o("RENEWAL"))).toBe(true);
    expect(matches(row(["FUNNEL_VIEWED"]), o("INITIAL_PURCHASE"))).toBe(false);
    expect(matches(row(["FUNNEL_VIEWED", "PAYWALL_IMPRESSION"]), o("INITIAL_PURCHASE"))).toBe(false);
  });
});
