// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: RevenueDot AI (prd/ai-assistant/PRD.md) used as a project admin and a viewer would, in Chromium, on the
// self-host runtime (Postgres + SSE). The model is a scripted Anthropic Messages API at the network layer
// (lib/fake-anthropic.ts), so the real provider, streaming, tool loop, approvals and audit run. Checks: a read question
// calls get-metrics and the answer quotes the real MRR; a write asks first, Approve grants in the database once and is
// audited as "assistant on behalf of <email>", Deny changes nothing; a Viewer is offered no write tools and the API
// refuses their writes; read only hides writes; disabled turns the assistant off.
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, signUp, standardCatalog } from "./lib/context.ts";
import { fakeModelCalls } from "./lib/fake-anthropic.ts";
import { chromium } from "./onboarding.ts";
import { join } from "node:path";

const journey: Journey = {
  name: "assistant",
  title: "RevenueDot AI: read with a tool, approve and deny a write, audit, viewer, read only, disabled",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dev = await signUp(ctx, "aiadmin", "AI Coach");
    const cat = await standardCatalog(dev);
    // Some revenue so the MRR answer has a real number: two Test Store purchases a month apart in the past (production
    // numbers ignore the Test Store, so the overview the assistant reads is the production one — it must match exactly).
    await dev.v2("POST", "/test_purchases", { app_user_id: "paying_1", product_id: "pro_monthly", scenario: "renewal", offset_days: 40 });
    const browser = await chromium().launch();
    const errors: string[] = [];
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: "rd_session", value: dev.cookie.split("=")[1]!, url: ctx.base }]);
      const page = await context.newPage();
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e)));
      const composer = () => page.getByRole("textbox", { name: "Ask RevenueDot AI" });
      const ask = async (text: string) => {
        await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
        await composer().fill(text);
        await composer().press("Enter");
      };

      c.begin("status");
      const status = await dev.v2("GET", "/ai");
      c.has("GET /ai: available on the SSE runtime with Anthropic's model, read and write", status, { available: true, provider: "Anthropic", runtime: "sse", access: "read_write", can_read: true, can_write: true });

      c.begin("a read question calls a tool");
      await page.goto(`${ctx.base}/projects/${dev.projectId}/ai`);
      await composer().waitFor({ timeout: 20_000 });
      const calls0 = fakeModelCalls.length;
      await ask("How is revenue doing this month?");
      await page.waitForURL(/\/ai\/aic\w+$/, { timeout: 20_000 }).catch(() => {});
      const card = page.locator('[data-tool="get-metrics"]');
      c.check("a get-metrics tool card appears", await card.waitFor({ timeout: 30_000 }).then(() => true, () => false));
      const overview = await dev.v2("GET", "/metrics/overview");
      const mrr = Math.round(overview.metrics.find((m: any) => m.id === "mrr").value);
      const answer = page.getByText(new RegExp(`MRR is \\$${mrr.toLocaleString("en-US")}`));
      c.check(`the answer quotes the overview's MRR ($${mrr}) returned by the tool`, await answer.waitFor({ timeout: 30_000 }).then(() => true, () => false), await page.locator("main").innerText().catch(() => ""));
      const modelCalls = fakeModelCalls.slice(calls0);
      c.check("the model was offered read and write tools, and called twice (tool call, then the answer)", modelCalls.length === 2 && modelCalls[0]!.tools.includes("get-metrics") && modelCalls[0]!.tools.includes("grant-customer-entitlement"), modelCalls.map((m) => ({ tools: m.tools.length, user: m.lastUser.slice(0, 40) })));
      const convId = page.url().split("/").pop()!;
      const conv = await dev.v2("GET", `/ai/conversations/${convId}`);
      c.check("the conversation is stored with the question and the answer", conv.messages?.length >= 2 && JSON.stringify(conv.messages).includes("How is revenue doing"), conv.messages?.length);
      await page.reload();
      c.check("a reload shows the whole conversation", await page.locator('[data-tool="get-metrics"]').waitFor({ timeout: 15_000 }).then(() => true, () => false));

      c.begin("a write asks first: Approve");
      const target = `ai_granted_${ctx.stamp}`;
      await ask(`Please grant pro to ${target}`);
      const approval = page.getByTestId("approval-card").last();
      await approval.waitFor({ timeout: 30_000 });
      c.check("the approval card says what will change", /Grant pro to .* for 7 days/.test(await approval.innerText()), await approval.innerText());
      c.eq("nothing is written before the approval", (await dev.v2r("GET", `/customers/${target}`)).status, 404);
      await approval.getByRole("button", { name: "Approve" }).click();
      c.check("the answer confirms the grant", await page.getByText(/^Done\. The customer has the entitlement/).waitFor({ timeout: 30_000 }).then(() => true, () => false));
      const active = await dev.v2("GET", `/customers/${target}/active_entitlements`);
      c.check("the customer now has pro for about 7 days", active.items.length === 1 && active.items[0].entitlement_id === cat.pro.id && Math.abs(active.items[0].expires_at - (Date.now() + 7 * 86400_000)) < 3600_000, active.items);
      const runs = await ctx.sql`SELECT tool_name, count(*)::int AS n FROM ai_tool_runs WHERE conversation_id = ${convId} GROUP BY tool_name`;
      c.eq("ai_tool_runs claimed the approved call once", runs.map((r) => ({ ...r })), [{ tool_name: "grant-customer-entitlement", n: 1 }]);
      const audit = await dev.v2("GET", "/audit_logs?limit=50");
      const entry = audit.items.find((a: any) => a.actor_type === "assistant");
      c.check(`the audit log records the grant as "assistant on behalf of ${dev.email}"`, entry?.additional_data?.actor_display === `assistant on behalf of ${dev.email}` && entry.additional_data.conversation_id === convId && /grant/i.test(`${entry.action_type} ${entry.target_type}`), entry);

      const assistantEntries = async () => (await dev.v2("GET", "/audit_logs?limit=100")).items.filter((a: any) => a.actor_type === "assistant");
      const beforeDeny = await assistantEntries();
      c.check("every assistant audit entry is from the approved grant's conversation", beforeDeny.length >= 1 && beforeDeny.every((a: any) => a.additional_data?.conversation_id === convId), beforeDeny.map((a: any) => [a.action_type, a.target_type]));

      c.begin("a write asks first: Deny");
      const denied = `ai_denied_${ctx.stamp}`;
      await ask(`grant pro to ${denied}`);
      const second = page.getByTestId("approval-card").last();
      await second.getByRole("button", { name: "Deny" }).waitFor({ timeout: 30_000 });
      await second.getByRole("button", { name: "Deny" }).click();
      c.check("the assistant says nothing changed", await page.getByText("OK, I did not change anything.").waitFor({ timeout: 30_000 }).then(() => true, () => false));
      c.eq("the denied customer was not created", (await dev.v2r("GET", `/customers/${denied}`)).status, 404);
      c.eq("no new audit entry for the denied write", (await assistantEntries()).length, beforeDeny.length);
      await page.goto(`${ctx.base}/projects/${dev.projectId}/settings/audit-logs`);
      c.check("the Audit logs tab shows RevenueDot AI and the person", await page.getByText("RevenueDot AI").first().waitFor({ timeout: 15_000 }).then(() => true, () => false) && (await page.locator("body").innerText()).includes(dev.email));

      c.begin("a read and a write in one step: Approve finishes the answer");
      const both = `ai_both_${ctx.stamp}`;
      await page.goto(`${ctx.base}/projects/${dev.projectId}/ai`);
      await composer().waitFor({ timeout: 15_000 });
      await ask(`look up ${both} and grant pro to ${both}`);
      const third = page.getByTestId("approval-card").last();
      await third.getByRole("button", { name: "Approve" }).waitFor({ timeout: 30_000 });
      c.check("the read tool ran before the approval", await page.locator('[data-tool="get-customer"]').last().waitFor({ timeout: 15_000 }).then(() => true, () => false));
      await third.getByRole("button", { name: "Approve" }).click();
      c.check("after Approve the answer finishes (no endless Thinking…)", await page.getByText(/^Done\. The customer has the entitlement/).last().waitFor({ timeout: 30_000 }).then(() => true, () => false));
      const bothActive = await dev.v2("GET", `/customers/${both}/active_entitlements`);
      c.check("the customer has pro from the grant", bothActive.items.some((e: any) => e.entitlement_id === cat.pro.id), bothActive.items);

      c.begin("a viewer");
      const viewerEmail = `aiviewer-${ctx.stamp}@journeys.test`;
      await dev.v2("POST", "/invites", { email: viewerEmail, role: "viewer" });
      const inviteMail = await until(async () => ctx.mails.find((m) => m.to.includes(viewerEmail)));
      const token = /invite\?token=([^\s"&<]+)/.exec(inviteMail?.text ?? "")?.[1];
      const su = await fetch(`${ctx.base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: viewerEmail, password: "viewer-pass-123", invite_token: decodeURIComponent(token ?? "") }) });
      c.must("the viewer joins through the invite", su.status === 201, await su.text());
      const vcookie = /rd_session=([^;]+)/.exec(su.headers.get("set-cookie") ?? "")![1]!;
      const vfetch = (method: string, path: string, json?: unknown) => fetch(`${ctx.base}/v2/projects/${dev.projectId}${path}`, { method, headers: { cookie: `rd_session=${vcookie}`, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: json === undefined ? undefined : JSON.stringify(json) });
      const vstatus = await (await vfetch("GET", "/ai")).json() as any;
      c.has("GET /ai for a viewer: can read, cannot write", vstatus, { role: "viewer", can_read: true, can_write: false });
      const vctx = await browser.newContext();
      await vctx.addCookies([{ name: "rd_session", value: vcookie, url: ctx.base }]);
      const vpage = await vctx.newPage();
      await vpage.goto(`${ctx.base}/projects/${dev.projectId}/ai`);
      const vcomp = vpage.getByRole("textbox", { name: "Ask RevenueDot AI" });
      await vcomp.waitFor({ timeout: 20_000 });
      const before = fakeModelCalls.length;
      await vcomp.fill(`grant pro to viewer_target_${ctx.stamp}`);
      await vcomp.press("Enter");
      c.check("the assistant tells the viewer it cannot change anything", await vpage.getByText("I can't change anything in this project").waitFor({ timeout: 30_000 }).then(() => true, () => false));
      const vcall = fakeModelCalls[before];
      c.check("the viewer's model call offered no write tools", vcall && !vcall.tools.includes("grant-customer-entitlement") && vcall.tools.includes("get-metrics"), vcall?.tools);
      c.eq("no approval card for the viewer", await vpage.getByTestId("approval-card").count(), 0);
      const vwrite = await vfetch("POST", `/customers/viewer_direct_${ctx.stamp}/actions/grant_entitlement`, { entitlement_id: cat.pro.id, expires_at: Date.now() + 86400_000 });
      c.eq("the API refuses a viewer's write (403)", vwrite.status, 403);
      const vset = await vfetch("POST", "/ai/settings", { access: "disabled" });
      c.eq("a viewer cannot change AI features (403)", vset.status, 403);
      await vctx.close();

      c.begin("read only and disabled");
      await page.goto(`${ctx.base}/projects/${dev.projectId}/settings/ai`);
      const tab = page.getByTestId("ai-features");
      await tab.getByRole("radio", { name: /^Read only/ }).check();
      await page.getByText("AI features saved.").waitFor({ timeout: 10_000 }).catch(() => {});
      c.eq("projects.ai_access = read_only", (await ctx.sql`SELECT ai_access FROM projects WHERE id = ${dev.projectId}`)[0]!.ai_access, "read_only");
      const ro0 = fakeModelCalls.length;
      await page.goto(`${ctx.base}/projects/${dev.projectId}/ai`);
      await ask(`grant pro to readonly_target_${ctx.stamp}`);
      c.check("read only: the assistant offers no write", await page.getByText("I can't change anything in this project").waitFor({ timeout: 30_000 }).then(() => true, () => false) && !fakeModelCalls[ro0]?.tools.includes("grant-customer-entitlement"), fakeModelCalls[ro0]?.tools);
      await page.goto(`${ctx.base}/projects/${dev.projectId}/settings/ai`);
      await page.getByTestId("ai-features").getByRole("radio", { name: /^Disabled/ }).check();
      await page.getByText("AI features saved.").waitFor({ timeout: 10_000 }).catch(() => {});
      await page.goto(`${ctx.base}/projects/${dev.projectId}/ai`);
      c.check("disabled: the /ai page says an admin turned it off", await page.getByTestId("ai-unavailable").filter({ hasText: "turned RevenueDot AI off" }).waitFor({ timeout: 15_000 }).then(() => true, () => false));
      const off = await dev.v2("GET", "/ai");
      c.has("GET /ai: access disabled, cannot read or write", off, { access: "disabled", can_read: false, can_write: false });
      const offCalls = fakeModelCalls.length;
      const chat = await dev.call("POST", `/v2/projects/${dev.projectId}/ai/conversations/${convId}/chat`, { message: { id: "m1", role: "user", parts: [{ type: "text", text: "How is revenue doing?" }] }, trigger: "submit-message" }, { "sec-fetch-site": "same-origin" });
      // The chat transport answers with an error event in the stream (what the chat UI shows), not an HTTP error.
      c.check("disabled: a chat request is refused with the admin message and no model call is made", /turned RevenueDot AI off/.test(String(chat.body)) && !/text-delta/.test(String(chat.body)) && fakeModelCalls.length === offCalls, { status: chat.status, body: chat.body });
      const settingsAudit = (await dev.v2("GET", "/audit_logs?limit=50")).items.filter((a: any) => a.action_type === "ai_settings_updated");
      c.eq("each AI setting change is audited (read only, disabled)", settingsAudit.length, 2);
      await page.screenshot({ path: join(ctx.out, "ai-disabled.png") });
      c.check("no console errors", errors.length === 0, errors.slice(0, 5));
    } finally {
      await browser.close();
    }
  },
};
export default journey;
