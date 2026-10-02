// RevenueDot AI's tools (prd/ai-assistant/PRD.md §2): which tools each role and AI setting gets, approval on every
// write, the in-process client acting as the user (role checks, project scoping, AI setting), the audit actor,
// secret redaction and compact results.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { assistantServer } from "./assistant-helpers.js";
import { allowedTools, assistantScope } from "../src/services/assistant/access.js";
import { buildToolSet, loadAssistantContext } from "../src/services/assistant/agent.js";
import { inProcessClient, RevenueDotApiError } from "../src/services/assistant/client.js";
import { compactChart, compactResult, isWriteTool, redactSecrets, tools, toolsByName } from "../src/services/assistant/tools.js";

const names = (t: { name: string }[]) => t.map((x) => x.name);
const WRITES = ["grant-customer-entitlement", "revoke-customer-entitlement", "create-product", "attach-products-to-entitlement", "attach-products-to-package", "set-current-offering", "import-storekit-products", "create-experiment", "create-targeting-rule", "start-experiment", "pause-experiment", "stop-experiment", "retry-webhook-delivery", "replay-failed-webhook-deliveries"];

describe("tool catalog", () => {
  it("has the MCP server's names for shared tools and the read and write tools the spec lists", () => {
    for (const n of ["get-metrics", "get-customer", "list-customers", "list-events", "list-transactions", "list-products", "list-entitlements", "list-offerings", "list-apps",
      "get-project-health", "list-webhook-integrations", "list-webhook-deliveries", "retry-webhook-delivery", "grant-customer-entitlement", "revoke-customer-entitlement",
      "create-product", "attach-products-to-entitlement", "attach-products-to-package", "get-import-status"]) expect(toolsByName.has(n), n).toBe(true);
    for (const n of ["list-charts", "get-chart", "list-paywalls", "list-targeting-rules", "list-audiences", "list-experiments", "get-experiment-results", "list-integrations", "set-current-offering",
      "create-experiment", "create-targeting-rule", "start-experiment", "pause-experiment", "stop-experiment", "replay-failed-webhook-deliveries", "import-storekit-products"]) expect(toolsByName.has(n), n).toBe(true);
    expect(names(tools.filter(isWriteTool)).sort()).toEqual([...WRITES].sort());
  });

  it("never offers a tool that creates keys, webhooks with secrets or store credentials, or deletes customers", () => {
    for (const n of ["create-webhook-integration", "delete-customer", "refund-subscription", "create-app", "update-app"]) expect(toolsByName.has(n), n).toBe(false);
  });
});

describe("scoping by AI setting and role", () => {
  it("read_write: admins and developers get every tool, viewers only reads", () => {
    expect(names(allowedTools(tools, assistantScope("read_write", "admin")))).toEqual(names(tools));
    expect(names(allowedTools(tools, assistantScope("read_write", "developer")))).toEqual(names(tools));
    const viewer = allowedTools(tools, assistantScope("read_write", "viewer"));
    expect(viewer.some(isWriteTool)).toBe(false);
    expect(names(viewer)).toContain("get-chart");
    expect(assistantScope("read_write", "viewer").reason).toBe("Your role (Viewer) can read only.");
  });
  it("read_only: reads for everyone; disabled: nothing", () => {
    expect(allowedTools(tools, assistantScope("read_only", "admin")).some(isWriteTool)).toBe(false);
    expect(allowedTools(tools, assistantScope("read_only", "admin")).length).toBe(tools.length - WRITES.length);
    expect(allowedTools(tools, assistantScope("disabled", "admin"))).toEqual([]);
  });
  it("every write tool needs approval in the AI SDK tool set; reads run without asking", async () => {
    const s = await assistantServer();
    const ctx = (await loadAssistantContext(s.deps, s.model, s.admin.userId, s.pid, "aic_test"))!;
    const set = buildToolSet(ctx);
    for (const [name, t] of Object.entries(set)) expect((t as { needsApproval?: boolean }).needsApproval, name).toBe(WRITES.includes(name));
  });
});

describe("the in-process client acts as the signed-in user", () => {
  it("writes are audited with actor type assistant and 'assistant on behalf of <email>'", async () => {
    const s = await assistantServer();
    const c = inProcessClient(s.deps.dispatch, { userId: s.admin.userId, email: "ada@example.com", projectId: s.pid, conversationId: "aic_audit" });
    await toolsByName.get("create-product")!.run(c, { app_id: s.appId, store_identifier: "pro_yearly", type: "subscription", subscription_duration: "P1Y" } as never);
    const [log] = await s.db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.projectId, s.pid), eq(schema.auditLogs.actionType, "product_created"), eq(schema.auditLogs.actorType, "assistant")));
    expect(log).toMatchObject({ actorIdentifier: s.admin.userId, additionalData: { actor_display: "assistant on behalf of ada@example.com", on_behalf_of: s.admin.userId, conversation_id: "aic_audit" } });
    // Reads are not audited.
    await toolsByName.get("list-products")!.run(c, {} as never);
    expect((await s.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actorType, "assistant"))).length).toBe(1);
  });

  it("the API applies the user's role, the AI setting and the project boundary to the assistant's calls", async () => {
    const s = await assistantServer();
    const viewer = await s.member("vic@example.com", "viewer");
    const asViewer = inProcessClient(s.deps.dispatch, { userId: viewer.userId, email: "vic@example.com", projectId: s.pid, conversationId: "c" });
    await expect(toolsByName.get("grant-customer-entitlement")!.run(asViewer, { customer_id: "u1", entitlement_id: "pro", expires_at: "7d" } as never))
      .rejects.toMatchObject({ status: 403, message: "Your role (Viewer) can read only." });
    expect(await toolsByName.get("list-entitlements")!.run(asViewer, {} as never)).toMatchObject({ items: [{ lookup_key: "pro" }] });

    const asAdmin = inProcessClient(s.deps.dispatch, { userId: s.admin.userId, email: "ada@example.com", projectId: s.pid, conversationId: "c" });
    await s.admin.browser.call("POST", `${s.P}/ai/settings`, { access: "read_only" });
    await expect(toolsByName.get("create-product")!.run(asAdmin, { app_id: s.appId, store_identifier: "x", type: "consumable" } as never)).rejects.toMatchObject({ status: 403 });
    await s.admin.browser.call("POST", `${s.P}/ai/settings`, { access: "disabled" });
    await expect(toolsByName.get("list-products")!.run(asAdmin, {} as never)).rejects.toMatchObject({ status: 403 });

    // Another project of the same user is out of reach, even with a hand-written path.
    const other = await s.admin.browser.call("POST", "/v2/projects", { name: "Other" });
    const otherId = other.body.id ?? (await s.admin.browser.call("GET", "/auth/me")).body.projects.find((p: { name: string }) => p.name === "Other")?.id;
    if (otherId) await expect(asAdmin.request("GET", `/v2/projects/${otherId}/products`)).rejects.toBeInstanceOf(RevenueDotApiError);
    // A non-member never gets through.
    const stranger = await s.signup("eve@example.com");
    const asStranger = inProcessClient(s.deps.dispatch, { userId: stranger.userId, email: "eve@example.com", projectId: s.pid, conversationId: "c" });
    await expect(toolsByName.get("list-products")!.run(asStranger, {} as never)).rejects.toMatchObject({ status: 404 });
  });

  it("create-experiment drafts an experiment from offering lookup keys and create-targeting-rule a rule that is off", async () => {
    const s = await assistantServer();
    const c = inProcessClient(s.deps.dispatch, { userId: s.admin.userId, email: "ada@example.com", projectId: s.pid, conversationId: "c" });
    for (const key of ["default", "trial14"]) await s.admin.browser.call("POST", `${s.P}/offerings`, { lookup_key: key, display_name: key });
    const exp = await toolsByName.get("create-experiment")!.run(c, { name: "14-day trial", type: "free_trial_offer", control_offering: "default", treatment_offerings: ["trial14"], notes: "Longer trial, more payers." } as never) as Record<string, any>;
    expect(exp).toMatchObject({ object: "experiment", status: "draft", type: "free_trial_offer", primary_metric: "conversion_to_paying", notes: "Longer trial, more payers.", variants: [{ id: "a" }, { id: "b" }] });
    await expect(toolsByName.get("create-experiment")!.run(c, { name: "x", control_offering: "default", treatment_offerings: ["nope"] } as never)).rejects.toMatchObject({ status: 404 });
    const rule = await toolsByName.get("create-targeting-rule")!.run(c, { name: "Trial for all", offering: "trial14", placements: { onboarding: "default" }, starts_at: "7d" } as never) as Record<string, any>;
    expect(rule).toMatchObject({ object: "targeting_rule", state: "inactive", name: "Trial for all" });
    expect(rule.starts_at).toBeGreaterThan(Date.now());
    expect(Object.values(rule.placements)[0]).toMatch(/^ofrng/);
    const [log] = await s.db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.projectId, s.pid), eq(schema.auditLogs.actionType, "experiment_created")));
    expect(log).toMatchObject({ actorType: "assistant" });
    expect(await toolsByName.get("list-audiences")!.run(c, {} as never)).toMatchObject({ items: [] });
  });

  it("get-chart answers any chart compacted, and list-charts lists all 43", async () => {
    const s = await assistantServer();
    const c = inProcessClient(s.deps.dispatch, { userId: s.admin.userId, email: "ada@example.com", projectId: s.pid, conversationId: "c" });
    const list = await toolsByName.get("list-charts")!.run(c, {} as never) as { items: unknown[] };
    expect(list.items).toHaveLength(43);
    const mrr = await toolsByName.get("get-chart")!.run(c, { chart: "mrr", start_date: "2026-09-01", end_date: "2026-09-30" } as never) as { chart: string; rows: { date: string; MRR: number }[] };
    expect(mrr.chart).toBe("MRR");
    expect(mrr.rows).toHaveLength(30);
    expect(mrr.rows[0]).toEqual({ date: "2026-09-01", MRR: 0 });
    const cohort = await toolsByName.get("get-chart")!.run(c, { chart: "subscription_retention" } as never) as { rows: unknown[] };
    expect(Array.isArray(cohort.rows)).toBe(true);
  });
});

describe("results the model sees", () => {
  it("hides secret values and keeps whether they are set", () => {
    expect(redactSecrets({ name: "Slack", webhook_secret: "whsec_123", credentials: { private_key: "-----BEGIN", configured: true }, api_key_configured: true, token: "", nested: [{ password: "x" }] }))
      .toEqual({ name: "Slack", webhook_secret: "[hidden]", credentials: { private_key: "[hidden]", configured: true }, api_key_configured: true, token: "", nested: [{ password: "[hidden]" }] });
  });
  it("hides everything under a secret key, and secret-looking values under any key", () => {
    expect(redactSecrets({ credentials: { key_id: "ABC", value: "pem", n: 4, list: ["a"], hint: "…abcd" }, secrets: { webhook_url: { configured: true, hint: "…x9" } } }))
      .toEqual({ credentials: { key_id: "[hidden]", value: "[hidden]", n: "[hidden]", list: ["[hidden]"], hint: "…abcd" }, secrets: { webhook_url: { configured: true, hint: "…x9" } } });
    const out = redactSecrets({
      url: "https://user:pa55@example.com/hook", note: "key sk_live_abcdefghijklmnop", pem: "-----BEGIN PRIVATE KEY-----\nMII", slack: "https://hooks.slack.com/services/T0/B0/xyz",
      attributes: { $email: "a@b.co", plain: "https://example.com/ok" },
    });
    expect(out).toEqual({ url: "[hidden]", note: "[hidden]", pem: "[hidden]", slack: "[hidden]", attributes: { $email: "a@b.co", plain: "https://example.com/ok" } });
  });
  it("cuts long lists to fit and says how many were left out", () => {
    const big = { object: "list", items: Array.from({ length: 500 }, (_, i) => ({ id: `cust_${i}`, note: "x".repeat(50) })) };
    const c = compactResult(big, 12_000) as { items: unknown[] };
    expect(JSON.stringify(c).length).toBeLessThanOrEqual(12_000);
    expect(c.items[c.items.length - 1]).toMatchObject({ omitted: expect.any(Number) });
  });
  it("gives the model timestamps as ISO dates, leaving other numbers alone", () => {
    expect(compactResult({ subscriptions: [{ ends_at: 1793576152443, expires_date: 1793576152443, starts_at: null, total: 1793576152443, gross: 9.99 }] }))
      .toEqual({ subscriptions: [{ ends_at: "2026-11-01T23:35:52.443Z", expires_date: "2026-11-01T23:35:52.443Z", starts_at: null, total: 1793576152443, gross: 9.99 }] });
  });
  it("compactChart turns segments into one row per date", () => {
    const body = { display_name: "Revenue", measures: [{ display_name: "Revenue", unit: "$" }], segments: [{ display_name: "US" }, { display_name: "Total" }],
      values: [{ cohort: 1759276800, segment: 0, measure: 0, value: 5 }, { cohort: 1759276800, segment: 1, measure: 0, value: 9 }] };
    expect(compactChart(body)).toMatchObject({ segmented_by: ["US", "Total"], rows: [{ date: "2025-10-01", US: 5, Total: 9 }] });
  });
});
