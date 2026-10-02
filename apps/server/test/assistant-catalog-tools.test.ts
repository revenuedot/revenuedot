// "Create with AI" (prd/catalog/PRD.md): RevenueDot AI drafts products and offerings with its read tools and writes them
// with create-products and create-offering only after the user approves the card; Deny writes nothing; viewers get no
// write tool. Runs the default scripted model (services/assistant/fake-model.ts), never a real one.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { assistantServer, textOf } from "./assistant-helpers.js";
import { draftOffering, draftProducts } from "../src/services/assistant/fake-model.js";

type S = Awaited<ReturnType<typeof assistantServer>>;

/** Sends `text`, then answers the approval card the turn stopped on. */
async function draftAndDecide(s: S, browser: S["admin"]["browser"], text: string, approved: boolean | null) {
  const cid = await s.newConversation(browser);
  const first = await s.chat(browser, cid, { trigger: "submit-message", message: { id: `m${Math.random()}`, role: "user", parts: [{ type: "text", text }] } });
  await s.settle();
  const msgs = (await browser.call("GET", `${s.P}/ai/conversations/${cid}`)).body.messages;
  const answer = msgs[msgs.length - 1];
  if (approved === null) return { first, answer, second: null };
  const decided = { ...answer, parts: answer.parts.map((p: Record<string, unknown>) => p.state === "approval-requested" ? { ...p, state: "approval-responded", approval: { ...(p.approval as object), approved } } : p) };
  const second = await s.chat(browser, cid, { trigger: "submit-message", message: decided });
  await s.settle();
  return { first, answer, second };
}

describe("Create with AI", () => {
  it("drafts products from the request, creates them on approval with Test Store prices, and attaches them to pro", async () => {
    const s = await assistantServer();
    const r = await draftAndDecide(s, s.admin.browser, "Draft products for this project and create them after I approve: Pro $9.99 monthly, $59.99 yearly and a $99.99 lifetime unlock on the Test Store", null);
    expect(r.first.chunks.some((c) => c.type === "tool-approval-request")).toBe(true);
    const card = r.answer.parts.find((p: any) => p.type === "tool-create-products");
    expect(card.state).toBe("approval-requested");
    expect(card.input.products.map((p: any) => [p.store_identifier, p.type, p.subscription_duration ?? null, p.test_store_price?.amount ?? null])).toEqual([
      ["pro_monthly", "subscription", "P1M", 9.99], ["pro_annual", "subscription", "P1Y", 59.99], ["pro_lifetime", "non_consumable", null, 99.99],
    ]);
    // It read the apps first; nothing was written yet.
    expect(r.answer.parts.some((p: any) => p.type === "tool-list-apps" && p.state === "output-available")).toBe(true);
    expect((await s.admin.browser.call("GET", `${s.P}/products?limit=100`)).body.items).toHaveLength(1);

    const decided = { ...r.answer, parts: r.answer.parts.map((p: any) => p.state === "approval-requested" ? { ...p, state: "approval-responded", approval: { ...p.approval, approved: true } } : p) };
    const cid = (await s.admin.browser.call("GET", `${s.P}/ai/conversations`)).body.items[0].id;
    const second = await s.chat(s.admin.browser, cid, { trigger: "submit-message", message: decided });
    await s.settle();
    expect(textOf(second.chunks)).toMatch(/Created 2 products, skipped 1 that already existed and attached them to pro/);
    const products = (await s.admin.browser.call("GET", `${s.P}/products?expand=items.indicative_price&limit=100`)).body.items;
    const annual = products.find((p: any) => p.store_identifier === "pro_annual");
    expect(annual).toMatchObject({ type: "subscription", subscription: { duration: "P1Y" }, display_name: "Pro Annual", indicative_price: { amount_micros: 59_990_000, currency: "USD" } });
    expect(products.find((p: any) => p.store_identifier === "pro_lifetime")).toMatchObject({ type: "non_consumable", indicative_price: { amount_micros: 99_990_000 } });
    const attached = await s.db.select().from(schema.entitlementProducts).where(eq(schema.entitlementProducts.entitlementId, s.entitlementId));
    expect(attached).toHaveLength(3);
    const audit = await s.db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.projectId, s.pid), eq(schema.auditLogs.actionType, "product_created"), eq(schema.auditLogs.actorType, "assistant")));
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actorIdentifier: s.admin.userId, additionalData: { actor_display: "assistant on behalf of ada@example.com" } });
  });

  it("drafts an offering from the products; Deny writes nothing, Approve creates it with its packages and makes it current", async () => {
    const s = await assistantServer();
    const P = s.P;
    await s.admin.browser.call("POST", `${P}/products`, { app_id: s.appId, store_identifier: "pro_annual", type: "subscription", subscription: { duration: "P1Y" } });
    const denied = await draftAndDecide(s, s.admin.browser, "Draft an offering called sale with every plan and make it the default", false);
    expect(denied.answer.parts.find((p: any) => p.type === "tool-create-offering").input).toMatchObject({ lookup_key: "sale", make_current: true, packages: [{ lookup_key: "$rc_monthly" }, { lookup_key: "$rc_annual" }] });
    expect(textOf(denied.second!.chunks)).toMatch(/did not change anything/);
    expect((await s.admin.browser.call("GET", `${P}/offerings`)).body.items).toHaveLength(0);

    const ok = await draftAndDecide(s, s.admin.browser, "Draft an offering called sale with every plan and make it the default", true);
    expect(textOf(ok.second!.chunks)).toMatch(/Created the offering sale with 2 packages; it is now the current offering/);
    const offerings = (await s.admin.browser.call("GET", `${P}/offerings?expand=items.package.product`)).body.items;
    expect(offerings).toHaveLength(1);
    expect(offerings[0]).toMatchObject({ lookup_key: "sale", is_current: true });
    expect(offerings[0].packages.items.map((k: any) => [k.lookup_key, k.products.items.map((x: any) => x.product.store_identifier)])).toEqual([["$rc_monthly", ["pro_monthly"]], ["$rc_annual", ["pro_annual"]]]);
  });

  it("a viewer gets no write tool, so nothing is drafted for approval", async () => {
    const s = await assistantServer();
    const viewer = await s.member("vic@example.com", "viewer");
    const r = await draftAndDecide(s, viewer.browser, "Draft products for this project and create them after I approve: Pro $4.99 monthly", null);
    expect(r.first.chunks.some((c) => c.type === "tool-approval-request")).toBe(false);
    expect(textOf(r.first.chunks)).toMatch(/can't change anything/);
  });

  it("the drafts follow the request: stores named in it, prices next to each period, package ids by period", () => {
    const apps = [{ id: "a_ios", type: "app_store" }, { id: "a_play", type: "play_store" }, { id: "a_ts", type: "test_store" }];
    const d = draftProducts("Premium $3.99 weekly and $29.99 yearly on iOS and Android", apps);
    expect(d.products.map((p) => [p.app_id, p.store_identifier])).toEqual([
      ["a_ios", "com.example.premium.weekly"], ["a_play", "premium:weekly"], ["a_ios", "com.example.premium.annual"], ["a_play", "premium:annual"],
    ]);
    expect(d.entitlement.lookup_key).toBe("premium");
    const o = draftOffering("draft an offering", [{ id: "p1", type: "subscription", store_identifier: "w", subscription: { duration: "P1W" } }, { id: "p2", type: "consumable", store_identifier: "c" }]);
    expect(o).toEqual({ lookup_key: "ai_offering", display_name: "Ai offering", packages: [{ lookup_key: "$rc_weekly", display_name: "Weekly", products: ["p1"] }], make_current: false });
  });
});
