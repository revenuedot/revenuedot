// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: runs a device harness (scripts/e2e/ios/run.ts or scripts/e2e/android/run.ts: the UNMODIFIED RevenueCat
// iOS or Android SDK in the simulator or emulator, tapping the SDK's own Test Store dialog) against the journey server,
// then checks what only the journey can see: the purchase webhook delivered to the node-express example backend and
// signature-checked there, the Overview moving, the SQL rows, and the customer page timeline in the dashboard.
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Ctx } from "./context.ts";
import { until } from "./check.ts";
import { ROOT, hideUrls } from "./stack.ts";
import { backendUrl, startExampleBackend } from "./backend.ts";
import { chromium } from "../onboarding.ts";

export async function deviceJourney(ctx: Ctx, kind: "ios" | "android") {
  const { c } = ctx;
  const label = kind === "ios" ? "iOS" : "Android";
  // The harness signs in with these (or signs up); making the account first lets the webhook exist before the device buys.
  const email = `${kind}-harness@revenuedot.test`, password = `${kind}-harness-password`;
  const su = await fetch(`${ctx.base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, project_name: `${label} harness` }) });
  c.must("harness account signed up through /auth/signup", su.status === 201, await su.text());
  const cookie = `rd_session=${/rd_session=([^;]+)/.exec(su.headers.get("set-cookie") ?? "")![1]}`;
  const api = async (method: string, path: string, json?: unknown) => {
    const r = await fetch(ctx.base + path, { method, headers: { cookie, ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
    return r.json() as Promise<any>;
  };
  const projectId = (await api("GET", "/auth/me")).projects[0].id as string;
  const P = `/v2/projects/${projectId}`;
  const hook = await api("POST", `${P}/integrations/webhooks`, { name: "Example backend", url: backendUrl() });
  const backend = await startExampleBackend(hook.signing_secret);
  try {
    c.begin(`the unmodified ${label} SDK on a ${kind === "ios" ? "simulator" : "emulator"}`);
    const lines: string[] = [];
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["--import", join(ROOT, "node_modules/tsx/dist/loader.mjs"), join(ROOT, `scripts/e2e/${kind}/run.ts`)], {
        cwd: ROOT, env: { ...process.env, RD_SERVER_URL: ctx.base, RD_REQUEST_LOG: ctx.server.requestLog },
      });
      let buf = "";
      const take = (d: Buffer) => { buf += d; const parts = buf.split("\n"); buf = parts.pop()!; for (const l of parts) { lines.push(hideUrls(l)); if (/^(ok  |FAIL|Server |xcodebuild|instrumented|iOS simulator run|Android emulator run)/.test(l)) console.log(`      ${hideUrls(l).slice(0, 200)}`); } };
      child.stdout.on("data", take); child.stderr.on("data", take);
      child.on("close", (n) => resolve(n ?? 1));
    });
    const loginId = /login id (\S+)/.exec(lines.find((l) => l.includes("login id")) ?? "")?.[1];
    const harnessChecks = lines.filter((l) => /^(ok  |FAIL) /.test(l));
    for (const l of harnessChecks) c.check(`harness: ${l.slice(5, l.indexOf(":", 5) > 0 ? l.indexOf(":", 5) : undefined)}`, l.startsWith("ok"), l.slice(0, 600));
    c.check(`${label} harness passed (exit 0) with its checks`, code === 0 && harnessChecks.length > 5, lines.filter((l) => /FAIL|error|PASS/.test(l)).slice(-15));
    if (!loginId) { c.check("harness printed its login id", false, lines.slice(-30)); return; }

    c.begin("what the journey checks after the device run");
    const [cust] = await ctx.sql`SELECT c.id FROM customers c JOIN customer_aliases a ON a.customer_id = c.id WHERE c.project_id = ${projectId} AND a.app_user_id = ${loginId}`;
    c.must("the logged-in customer exists", cust);
    const tx = await ctx.sql`SELECT store, is_sandbox, revenue_usd, product_identifier FROM transactions WHERE customer_id = ${cust!.id}`;
    c.check("one sandbox Test Store transaction with revenue for the device's customer", tx.length === 1 && tx[0]!.store === "test_store" && tx[0]!.is_sandbox && Number(tx[0]!.revenue_usd) > 0, tx);
    const ev = await ctx.sql`SELECT payload FROM events WHERE customer_id = ${cust!.id} AND type = 'INITIAL_PURCHASE'`;
    const purchaser = ev[0]?.payload?.event?.app_user_id as string | undefined;
    c.check("INITIAL_PURCHASE stored for the device purchase (made while anonymous)", ev.length === 1 && /^\$RCAnonymousID:/.test(purchaser ?? ""), ev.map((e) => e.payload.event.app_user_id));
    const delivered = await until(async () => (await api("GET", `${P}/webhooks/${hook.id}/deliveries?limit=50`)).items?.find((d: any) => d.event_id === ev[0]?.payload?.event?.id && d.status === "delivered"), { timeoutMs: 60_000, everyMs: 1000 });
    c.check("the device purchase's INITIAL_PURCHASE was delivered to the example backend (HTTP 200)", delivered?.response_status === 200, delivered);
    c.check("the backend checked the HMAC signature and granted pro to the purchaser", await until(async () => backend.log.includes(`grant pro to ${purchaser}`), { timeoutMs: 5000 }), backend.log.slice(-600));
    const overview = await api("GET", `${P}/metrics/overview?environment=sandbox`);
    const m = (id: string) => overview.metrics.find((x: any) => x.id === id)?.value;
    c.check("Overview (sandbox) counts the device's subscription and revenue", m("active_subscriptions") >= 1 && m("revenue") > 0, overview.metrics.map((x: any) => [x.id, x.value]));

    const browser = await chromium().launch();
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: "rd_session", value: cookie.split("=")[1]!, url: ctx.base }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
      await page.goto(`${ctx.base}/projects/${projectId}/customers/${encodeURIComponent(loginId)}`);
      await page.waitForLoadState("networkidle");
      const text = await page.locator("body").innerText();
      c.check("the customer page shows the login id, pro and the purchase in the timeline", text.includes(loginId) && text.includes("pro") && /Initial purchase|INITIAL_PURCHASE|Purchased/i.test(text), text.slice(0, 1200));
      await page.screenshot({ path: join(ctx.out, `${kind}-customer.png`), fullPage: true });
      c.check("no console errors on the customer page", errors.length === 0, errors);
    } finally { await browser.close(); }
  } finally { backend.stop(); }
}
