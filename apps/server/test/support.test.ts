import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { memoryMailer } from "../src/mail/index.js";

/** Support (prd/lifecycle/PRD.md): Customer Center tickets and the help desk summary. */
let h: Harness;
let mail: ReturnType<typeof memoryMailer>;
beforeEach(async () => { mail = memoryMailer(); h = await harness({ mailer: mail, publicUrl: "https://app.example.test" }); });
afterEach(async () => { await h.close(); });

const ticket = (json: unknown) => h.fetch("/v1/customercenter/support/create-ticket", { method: "POST", key: h.ids.testKey, json });
const v2 = (path: string, init: { method?: string; json?: unknown } = {}) => h.fetch(`/v2/projects/proj1${path}`, { key: h.ids.secretKey, ...init });
const settings = (support: Record<string, unknown>) => v2("/customer_center_config", { method: "POST", json: { customer_center: { support } } });

async function payingCustomer() {
  await h.fetch("/v1/subscribers/wren", { key: h.ids.testKey, headers: { "X-Platform": "iOS", "X-Client-Version": "3.4.1" } });
  await v2("/customers/wren/attributes", { method: "POST", json: { attributes: [{ name: "$email", value: "Wren@Example.com" }, { name: "$displayName", value: "Wren" }] } });
  const res = await v2("/test_purchases", { method: "POST", json: { app_user_id: "wren", product_id: "p4", scenario: "purchase" } });
  expect(res.status).toBeLessThan(300);
}

describe("POST /v1/customercenter/support/create-ticket", () => {
  it("stores the ticket and emails the support address with the customer's details, Reply-To the customer", async () => {
    await settings({ email: "help@scanner.app" });
    await payingCustomer();
    const res = await ticket({ app_user_id: "wren", customer_email: "wren@example.com", issue_description: "My scans are not syncing to iCloud since yesterday." });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    const [t] = await h.db.select().from(schema.supportTickets);
    expect(t).toMatchObject({ appUserId: "wren", customerEmail: "wren@example.com", status: "open", emailedTo: "help@scanner.app", emailed: true, appId: "app_test" });
    expect(t!.customerId).toMatch(/^cus_/);
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0]!;
    expect(m).toMatchObject({ to: "help@scanner.app", replyTo: "wren@example.com", subject: "Support request from wren@example.com (Test Store)" });
    expect(m.text).toContain("My scans are not syncing to iCloud since yesterday.");
    expect(m.text).toContain("App user ID: wren");
    expect(m.text).toContain("Active entitlements: pro");
    expect(m.text).toContain("App version: 3.4.1");
    expect(m.text).toContain(`https://app.example.test/projects/proj1/lifecycle/support?ticket=${t!.id}`);
  });

  it("answers sent: false when ticket creation is off, the request is incomplete, or the customer sends too many", async () => {
    await settings({ email: "help@scanner.app", support_tickets: { allow_creation: false, customer_type: "all" } });
    expect(await (await ticket({ app_user_id: "u1", customer_email: "u1@example.org", issue_description: "Help" })).json()).toEqual({ sent: false });
    await settings({ email: "help@scanner.app", support_tickets: { allow_creation: true, customer_type: "all", customer_details: { appUserId: true } } });
    expect(await (await ticket({ app_user_id: "u1", customer_email: "not an email", issue_description: "Help" })).json()).toEqual({ sent: false });
    expect(await (await ticket({ app_user_id: "u1", customer_email: "u1@example.org", issue_description: "   " })).json()).toEqual({ sent: false });
    for (let i = 0; i < 5; i++) expect(await (await ticket({ app_user_id: "u1", customer_email: "u1@example.org", issue_description: `Try ${i}` })).json()).toEqual({ sent: true });
    expect(await (await ticket({ app_user_id: "u1", customer_email: "u1@example.org", issue_description: "Sixth" })).json()).toEqual({ sent: false });
    expect(await h.db.select().from(schema.supportTickets)).toHaveLength(5);
    // Only the details the project allows: the app user id, nothing else.
    expect(mail.sent[0]!.text).toContain("App user ID: u1");
    expect(mail.sent[0]!.text).not.toContain("Total spent");
  });

  it("the SDK reads the ticket settings from the Customer Center config", async () => {
    await settings({ email: "help@scanner.app", support_tickets: { allow_creation: true, customer_type: "active", customer_details: { appUserId: true, totalSpent: true } } });
    const cc = (await (await h.fetch("/v1/customercenter/anyone", { key: h.ids.testKey })).json() as any).customer_center;
    expect(cc.support).toMatchObject({ email: "help@scanner.app", support_tickets: { allow_creation: true, customer_type: "active", customer_details: { appUserId: true, totalSpent: true } } });
  });

  it("stores the ticket without email when the project has no support address of its own", async () => {
    expect(await (await ticket({ app_user_id: "u2", customer_email: "u2@example.org", issue_description: "Refund please" })).json()).toEqual({ sent: true });
    const [t] = await h.db.select().from(schema.supportTickets);
    expect(t).toMatchObject({ emailedTo: null, emailed: false });
    expect(mail.sent).toHaveLength(0);
  });
});

describe("tickets and the help desk summary in API v2", () => {
  it("lists tickets newest first, closes and reopens them", async () => {
    await ticket({ app_user_id: "a", customer_email: "a@example.org", issue_description: "First" });
    h.setNow(new Date(h.now().getTime() + 60_000));
    await ticket({ app_user_id: "b", customer_email: "b@example.org", issue_description: "Second" });
    const list = await (await v2("/support_tickets")).json() as any;
    expect(list.items.map((t: any) => t.description)).toEqual(["Second", "First"]);
    const id = list.items[1].id;
    const closed = await (await v2(`/support_tickets/${id}`, { method: "POST", json: { status: "closed" } })).json() as any;
    expect(closed).toMatchObject({ object: "support_ticket", status: "closed", closed_at: h.now().getTime() });
    expect((await (await v2("/support_tickets?status=open")).json() as any).items.map((t: any) => t.description)).toEqual(["Second"]);
    expect((await v2("/support_tickets/tkt_nope", { method: "POST", json: { status: "closed" } })).status).toBe(404);
  });

  it("returns what Intercom or Zendesk shows, by app user id or by email", async () => {
    await payingCustomer();
    await ticket({ app_user_id: "wren", customer_email: "wren@example.com", issue_description: "Where is my receipt?" });
    const res = await v2("/customers/wren/support_summary");
    expect(res.status).toBe(200);
    const s = await res.json() as any;
    expect(s).toMatchObject({
      object: "support_summary", app_user_id: "wren", email: "Wren@Example.com", display_name: "Wren", status: "active", active_entitlements: ["pro"],
      platform: "iOS", app_version: "3.4.1", dashboard_url: "https://app.example.test/projects/proj1/customers/wren",
    });
    expect(s.subscriptions[0]).toMatchObject({ product_id: "pro_monthly", store: "test_store", active: true, auto_renew: true });
    expect(s.open_tickets.map((t: any) => t.description)).toEqual(["Where is my receipt?"]);
    const byEmail = await (await v2("/support_summaries?email=wren%40example.com")).json() as any;
    expect(byEmail.items.map((x: any) => x.app_user_id)).toEqual(["wren"]);
    expect((await (await v2("/support_summaries?email=nobody%40example.com")).json() as any).items).toEqual([]);
    expect((await v2("/customers/nobody/support_summary")).status).toBe(404);
    expect((await v2("/support_summaries")).status).toBe(400);
  });
});
