// RevenueDot AI on RevenueDot Cloud's runtime (one Cloudflare Agents Durable Object per conversation), checked locally
// under `cf dev` with the scripted fake model (no model call): a read tool and its answer, the transcript restored from
// the Durable Object after a reload, an approval card, Approve, the grant and its audit entries, the ownership and
// sign-in checks on /agents/assistant-agent/<id>, and delete. Steps in docs/cloud.md ("RevenueDot AI locally").
//   node e2e/do-smoke.mjs http://localhost:5409
import { chromium } from "@playwright/test";
const base = process.argv[2] ?? "http://localhost:5409";
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; p.on("pageerror", (e) => errors.push(String(e))); p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const stamp = Date.now();
const r = await p.request.post(base + "/auth/signup", { data: { email: `do-${stamp}@revenuedot.test`, password: `do-${stamp}-pw-x`, name: "Ada Durable", project_name: "DO smoke" } });
console.log("signup", r.status());
const pid = (await (await p.request.get(base + "/auth/me")).json()).projects[0].id;
const P = `/v2/projects/${pid}`;
const app = await (await p.request.post(base + P + "/apps", { data: { name: "Test Store", type: "test_store" } })).json();
await p.request.post(base + P + "/entitlements", { data: { lookup_key: "pro", display_name: "Pro" } });
const st = await (await p.request.get(base + P + "/ai")).json();
console.log("status", st.runtime, st.provider, st.available);
await p.goto(`${base}/projects/${pid}/ai`);
const box = p.getByRole("textbox", { name: "Ask RevenueDot AI" });
await box.fill("How is revenue doing?"); await box.press("Enter");
await p.waitForURL(/\/ai\/aic\w+$/);
const conv = p.url().split("/").pop();
console.log("conversation", conv, (await (await p.request.get(base + P + "/ai/conversations/" + conv)).json()).runtime);
await p.locator('[data-tool="get-metrics"]').waitFor({ timeout: 30000 });
await p.getByText(/MRR is \$/).waitFor({ timeout: 30000 });
console.log("read tool + answer OK");
await p.reload();
await p.getByText(/MRR is \$/).waitFor({ timeout: 30000 });
console.log("after reload, transcript restored from the Durable Object");
await p.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
await box.fill("grant pro to do_user_1"); await box.press("Enter");
const card = p.getByTestId("approval-card").last();
await card.getByRole("button", { name: "Approve" }).waitFor({ timeout: 30000 });
console.log("approval card shown");
await card.getByRole("button", { name: "Approve" }).click();
await p.getByText(/^Done\./).waitFor({ timeout: 30000 });
const ent = await (await p.request.get(base + P + "/customers/do_user_1/active_entitlements")).json();
console.log("granted:", ent.items?.length);
const logs = await (await p.request.get(base + P + "/audit_logs")).json();
console.log("audit:", logs.items.filter((l) => l.actor_type === "assistant").map((l) => `${l.action_type} ${l.additional_data.actor_display}`));
// A read and a write in one step: the read's result arrives after the approval request and must still be stored, or
// the approved write never runs (agent.ts captureApprovalSignatures).
await p.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
await box.fill("look up do_user_2 and grant pro to do_user_2"); await box.press("Enter");
const card2 = p.getByTestId("approval-card").nth(1);
await card2.getByRole("button", { name: "Approve" }).waitFor({ timeout: 30000 });
const stored = await (await p.request.get(`${base}/agents/assistant-agent/${conv}/get-messages`)).json();
const lookup = stored.flatMap((m) => m.parts).filter((x) => x.type === "tool-get-customer").pop();
console.log("stored read tool before approval:", lookup?.state);
if (lookup?.state !== "output-available" && lookup?.state !== "output-error") throw new Error(`the read tool was stored as ${lookup?.state}`);
await card2.getByRole("button", { name: "Approve" }).click();
await p.getByText(/^Done\./).nth(1).waitFor({ timeout: 30000 });
console.log("read + write in one step: granted:", (await (await p.request.get(base + P + "/customers/do_user_2/active_entitlements")).json()).items?.length);
// Another user cannot open this conversation's socket.
const other = await b.newPage();
await other.request.post(base + "/auth/signup", { data: { email: `do2-${stamp}@revenuedot.test`, password: `do-${stamp}-pw-y`, project_name: "Other" } });
const res = await other.request.get(`${base}/agents/assistant-agent/${conv}/get-messages`);
console.log("other user get-messages:", res.status());
const anon = await (await chromium.launch()).newPage();
console.log("signed out get-messages:", (await anon.request.get(`${base}/agents/assistant-agent/${conv}/get-messages`)).status());
await p.screenshot({ path: "/tmp/rd-do-smoke.png" });
const del = await p.request.delete(`${base}${P}/ai/conversations/${conv}`);
console.log("delete:", del.status(), "then get-messages:", (await p.request.get(`${base}/agents/assistant-agent/${conv}/get-messages`)).status());
console.log("console errors:", errors);
process.exit(0);
