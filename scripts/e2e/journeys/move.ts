// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (move), a developer moves a live project from their self-hosted RevenueDot to RevenueDot Cloud with
// `npx revenuedot move` (prd/moves-export/PRD.md), on two real Node servers with two fresh Railway development databases:
//   - Before: the unmodified purchases-js (@revenuecat/purchases-js, the examples/web/vanilla-js app) buys Monthly in
//     Chromium against the self-hosted server; INITIAL_PURCHASE reaches the developer's webhook, signed.
//   - The Cloud account (REVENUEDOT_EDITION=cloud) confirms its email from the real SMTP message and creates an import token.
//   - The CLI, as its own process: a dry run (rows per table, nothing written), the copy with verification, then --finish
//     (pause, last copy, verify, live on Cloud, the old server forwards).
//   - After: the OLD app build (proxy URL still the self-hosted server) still shows pro, answered by Cloud through the
//     forward; a NEW build pointed at Cloud shows pro, and a new visitor buys Annual there; the webhook from Cloud verifies with the ORIGINAL
//     signing secret; ids, the public key, the secret key and every table match (SQL on both databases); the old server
//     records nothing new. Both databases are dropped at the end.
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, eventsOf, signUp, standardCatalog } from "./lib/context.ts";
import { BUILD, DB_PREFIX, PORT_BASE, PORTS, RdServer, ROOT, createDatabase, dropDatabase, hideUrls, linksOf, postgres } from "./lib/stack.ts";

const EXAMPLE = join(ROOT, "..", "examples/web/vanilla-js");
const HOOK_HOST = "hooks.journeys.test";
const chromium = () => (createRequire(join(ROOT, "apps/dashboard/package.json"))("playwright") as typeof import("playwright")).chromium;

/** Runs the CLI as a real process (the published bin is `revenuedot`; `npx revenuedot` runs the same file). */
function cli(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", join(ROOT, "node_modules/tsx/dist/loader.mjs"), join(ROOT, "packages/importer/src/bin.ts"), ...args], { cwd, env: { ...process.env, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

function build(outDir: string, url: string, key: string, base: string) {
  return spawnSync(join(EXAMPLE, "node_modules/.bin/vite"), ["build", "--base", base, "--outDir", outDir, "--emptyOutDir"], {
    cwd: EXAMPLE, env: { ...process.env, VITE_REVENUEDOT_URL: url, VITE_REVENUEDOT_API_KEY: key }, encoding: "utf8",
  });
}

const verifyHook = (secret: string, body: string, header: string) => {
  const m = /t=(\d+),v1=([0-9a-f]+)/.exec(header);
  return !!m && createHmac("sha256", secret).update(`${m[1]}.${body}`).digest("hex") === m[2];
};

const journey: Journey = {
  name: "move",
  title: "Self-hosted to Cloud with npx revenuedot move: purchases-js before and after, webhooks keep their secret",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    if (!existsSync(join(EXAMPLE, "node_modules/@revenuecat/purchases-js/package.json"))) throw new Error(`Install the example first: (cd ${EXAMPLE} && npm ci)`);
    const A = ctx.server;
    const dbB = `${DB_PREFIX}${ctx.stamp}_cloud`;
    const urlB = await createDatabase(dbB);
    const portB = PORT_BASE + 7;
    const B = new RdServer({ databaseUrl: urlB, port: portB, smtpPort: PORTS.smtp, capturePort: PORTS.capture, logDir: join(ctx.out, "cloud"), env: { REVENUEDOT_EDITION: "cloud" } });
    const sqlB = postgres(urlB, { max: 2, onnotice: () => {} });
    const browser = await chromium().launch();
    const consoleErrors: string[] = [];
    try {
      await B.start();
      c.begin("self-hosted: a project with a catalog, a webhook and a real purchase from purchases-js");
      const dev = await signUp(ctx, "mover", "Focus");
      const cat = await standardCatalog(dev);
      const hook = await dev.v2("POST", "/integrations/webhooks", { name: "Backend", url: `https://${HOOK_HOST}/revenuedot` });
      const secret = hook.signing_secret as string;
      c.check("the webhook's signing secret is shown once", /^whsec_/.test(secret));
      const sk = await dev.v2("POST", "/api_keys", { name: "Move" });
      const oldDir = join(BUILD, `move-old-${ctx.stamp}`), newDir = join(BUILD, `move-new-${ctx.stamp}`);
      mkdirSync(oldDir, { recursive: true });
      const b1 = build(oldDir, A.base, cat.testKey, "/site-old/");
      c.must("vite build of the example web app pointed at the self-hosted server", b1.status === 0, (b1.stderr || b1.stdout).slice(-800));
      ctx.capture.dirs.set("/site-old/", oldDir);
      const page = await browser.newPage();
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push(String(e)));
      await page.goto(`${ctx.capture.base}/site-old/`);
      await page.getByTestId("plan-$rc_monthly").click();
      await page.getByTestId("buy").click();
      await page.getByRole("button", { name: "Test valid purchase" }).click();
      await page.getByRole("heading", { name: "You're in." }).waitFor({ timeout: 20_000 });
      const anon = (await page.evaluate(() => localStorage.getItem("revenuedot_app_user_id")))!;
      c.check("purchases-js made an anonymous app user id and bought Monthly", /^\$RCAnonymousID:/.test(anon));
      const before = await ctx.sql`SELECT kind, product_identifier FROM transactions WHERE project_id = ${dev.projectId}`;
      c.eq("self-hosted SQL: one Monthly purchase", before.map((r) => ({ ...r })), [{ kind: "purchase", product_identifier: "pro_monthly" }]);
      const first = await until(async () => ctx.capture.of(HOOK_HOST, "/revenuedot").find((r) => JSON.parse(r.body).event?.type === "INITIAL_PURCHASE"), { timeoutMs: 45_000 });
      c.check("INITIAL_PURCHASE reached the webhook, signed with its secret", !!first && verifyHook(secret, first.body, first.headers["x-revenuecat-webhook-signature"] ?? ""), first?.headers);

      c.begin("Cloud: sign up, confirm the email from the real message, create an import token");
      const email = `cloud-mover-${ctx.stamp}@journeys.test`;
      const password = `journey-${ctx.stamp}-cloud`;
      const su = await fetch(`${B.base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "Mover", project_name: "First Cloud project" }) });
      c.must("Cloud sign-up", su.status === 201, await su.text());
      const cookie = `rd_session=${/rd_session=([^;]+)/.exec(su.headers.get("set-cookie") ?? "")?.[1]}`;
      const early = await fetch(`${B.base}/v2/imports/tokens`, { method: "POST", headers: { cookie } });
      c.eq("an unconfirmed Cloud account cannot create an import token (403)", early.status, 403);
      const mail = await until(async () => ctx.mails.find((m) => m.to.includes(email.toLowerCase()) && /verify-email/.test(m.text)), { timeoutMs: 15_000 });
      const link = mail ? linksOf(mail).find((l) => l.includes("/verify-email?token=")) : undefined;
      c.must("the verification email arrived through SMTP", !!link);
      const v = await fetch(`${B.base}/auth/email/verify`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ token: new URL(link!).searchParams.get("token") }) });
      c.eq("the link confirms the email", v.status, 200);
      const tk = await (await fetch(`${B.base}/v2/imports/tokens`, { method: "POST", headers: { cookie } })).json() as { token: string };
      c.check("import token rdi_…", /^rdi_[0-9a-f]{64}$/.test(tk.token));
      const env = { REVENUEDOT_FROM_KEY: sk.key as string, REVENUEDOT_TO_TOKEN: tk.token };
      const work = join(ctx.out, "cli");
      mkdirSync(work, { recursive: true });

      c.begin("npx revenuedot move --dry-run");
      const dry = await cli(["move", "--from", A.base, "--to", B.base, "--dry-run"], env, work);
      c.check("exit 0", dry.code === 0, hideUrls(dry.err).slice(-1500));
      c.check("the diff lists customers 1 → 0 and transactions 1 → 0, and says nothing was written", /customers\s+1\s+0\s+\+1/.test(dry.out) && /transactions\s+1\s+0\s+\+1/.test(dry.out) && /Nothing was written/.test(dry.out), dry.out.slice(0, 2500));
      const none = await sqlB`SELECT count(*)::int AS n FROM projects WHERE id = ${dev.projectId}`;
      c.eq("Cloud has no copy after the dry run", none[0]!.n, 0);

      c.begin("npx revenuedot move (copy and verify)");
      const copy = await cli(["move", "--from", A.base, "--to", B.base], env, work);
      c.check("exit 0, all 65 tables match", copy.code === 0 && /All 65 tables match/.test(copy.out), hideUrls(copy.out + copy.err).slice(-2000));
      const incoming = await sqlB`SELECT move_state, moved_in_from FROM projects WHERE id = ${dev.projectId}`;
      c.has("Cloud holds the copy as incoming", incoming[0], { move_state: "incoming", moved_in_from: A.base });
      const stillHere = await fetch(`${A.base}/v1/subscribers/${encodeURIComponent(anon)}`, { headers: { authorization: `Bearer ${cat.testKey}` } });
      c.check("the self-hosted server still answers the app itself", stillHere.status === 200 && !stillHere.headers.get("x-revenuedot-moved-to"));

      c.begin("npx revenuedot move --finish");
      const t0 = Date.now();
      const fin = await cli(["move", "--from", A.base, "--to", B.base, "--finish"], env, work);
      c.check("exit 0 and the next steps", fin.code === 0 && /Moved\. Project .* now lives on/.test(fin.out) && /Purchases\.proxyURL/.test(fin.out), hideUrls(fin.out + fin.err).slice(-2500));
      c.check("it paused writes first and waited for the pause to reach every process", /Paused writes on/.test(fin.err) && Date.now() - t0 >= 10_000, fin.err.slice(0, 800));
      const stateA = await ctx.sql`SELECT move_state, moved_to_url FROM projects WHERE id = ${dev.projectId}`;
      c.has("self-hosted: forwarded to Cloud", stateA[0], { move_state: "forwarded", moved_to_url: B.base });
      const stateB = await sqlB`SELECT move_state, owner_user_id IS NOT NULL AS owned FROM projects WHERE id = ${dev.projectId}`;
      c.has("Cloud: live, owned by the Cloud account", stateB[0], { move_state: null, owned: true });
      for (const t of ["customers", "customer_aliases", "subscriptions", "transactions", "events", "apps", "products", "offerings", "packages", "webhooks", "webhook_deliveries"]) {
        const q = (sql: typeof ctx.sql) => sql.unsafe(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === "packages" ? "offering_id IN (SELECT id FROM offerings WHERE project_id = $1)" : t === "webhook_deliveries" ? "webhook_id IN (SELECT id FROM webhooks WHERE project_id = $1)" : "project_id = $1"}`, [dev.projectId]);
        const [a, b] = [(await q(ctx.sql))[0]!.n, (await q(sqlB))[0]!.n];
        c.eq(`${t}: the same rows on both (${a})`, b, a);
      }
      const keysA = await ctx.sql`SELECT public_key FROM apps WHERE project_id = ${dev.projectId} ORDER BY id`;
      const keysB = await sqlB`SELECT public_key FROM apps WHERE project_id = ${dev.projectId} ORDER BY id`;
      c.eq("the SDK's public keys are the same", keysB.map((r) => r.public_key), keysA.map((r) => r.public_key));
      const [hookB] = await sqlB`SELECT signing_secret FROM webhooks WHERE project_id = ${dev.projectId}`;
      c.check("the webhook kept its signing secret", hookB?.signing_secret === secret);
      const restB = await fetch(`${B.base}/v2/projects/${dev.projectId}/customers/${encodeURIComponent(anon)}`, { headers: { authorization: `Bearer ${sk.key}` } });
      c.eq("the backend's secret key works on Cloud, same project id and customer id", restB.status, 200);

      c.begin("after: the old app build keeps working through the forward");
      const aReqBefore = A.requests().length;
      await page.reload();
      // The field sits in the collapsed Developer panel, so read its text instead of waiting for it to be visible.
      const shows = () => until(async () => /Active until/.test((await page.getByTestId("entitlement").textContent()) ?? ""), { timeoutMs: 20_000 });
      c.check("the old build (proxy URL = the self-hosted server) still shows pro", await shows());
      const viaA = await fetch(`${A.base}/v1/subscribers/${encodeURIComponent(anon)}`, { headers: { authorization: `Bearer ${cat.testKey}` } });
      c.check("the self-hosted server forwards to Cloud (x-revenuedot-moved-to)", viaA.headers.get("x-revenuedot-moved-to") === B.base);
      c.check("Cloud answered the old build's calls", B.requests().some((r) => r.path.startsWith("/v1/subscribers/")) && A.requests().length > aReqBefore);

      c.begin("after: a new build pointed at Cloud buys Annual; the webhook verifies with the original secret");
      mkdirSync(newDir, { recursive: true });
      const b2 = build(newDir, B.base, cat.testKey, "/site-new/");
      c.must("vite build pointed at Cloud with the same public key", b2.status === 0, (b2.stderr || b2.stdout).slice(-800));
      ctx.capture.dirs.set("/site-new/", newDir);
      const hooksBefore = ctx.capture.of(HOOK_HOST, "/revenuedot").length;
      const txA = (await ctx.sql`SELECT count(*)::int AS n FROM transactions WHERE project_id = ${dev.projectId}`)[0]!.n;
      await page.goto(`${ctx.capture.base}/site-new/`);
      c.check("the new build shows pro from Cloud", await shows());
      c.check("the same browser (same app user id) has pro on Cloud", (await page.evaluate(() => localStorage.getItem("revenuedot_app_user_id"))) === anon);
      // A new visitor (fresh anonymous id) on the new build buys Annual.
      await page.evaluate(() => localStorage.removeItem("revenuedot_app_user_id"));
      await page.reload();
      await page.getByTestId("plan-$rc_annual").click();
      await page.getByTestId("buy").click();
      await page.getByRole("button", { name: "Test valid purchase" }).click();
      await page.getByRole("heading", { name: "You're in." }).waitFor({ timeout: 20_000 });
      c.check("the app says Purchased $rc_annual", await until(async () => /Purchased \$rc_annual/.test((await page.getByTestId("last-action").textContent()) ?? ""), { timeoutMs: 10_000 }));
      const txB = await sqlB`SELECT product_identifier FROM transactions WHERE project_id = ${dev.projectId} ORDER BY purchased_at`;
      c.eq("Cloud SQL: Monthly (moved) then Annual (new)", txB.map((r) => r.product_identifier), ["pro_monthly", "pro_annual"]);
      c.eq("the self-hosted database got nothing new", (await ctx.sql`SELECT count(*)::int AS n FROM transactions WHERE project_id = ${dev.projectId}`)[0]!.n, txA);
      const second = await until(async () => ctx.capture.of(HOOK_HOST, "/revenuedot").slice(hooksBefore).find((r) => /pro_annual/.test(r.body)), { timeoutMs: 60_000 });
      c.check("Cloud delivered the Annual purchase to the webhook, signed with the ORIGINAL secret", !!second && verifyHook(secret, second.body, second.headers["x-revenuecat-webhook-signature"] ?? ""), second?.body.slice(0, 400));
      c.check("that delivery came from the Cloud server (its outbound log)", await until(async () => B.outbound().some((o) => o.host === HOOK_HOST), { timeoutMs: 10_000 }), B.outbound().slice(-5));
      const evB = (await sqlB`SELECT payload FROM events WHERE project_id = ${dev.projectId} ORDER BY event_timestamp_ms`).map((r) => r.payload.event.type);
      c.check("Cloud's events: the moved INITIAL_PURCHASE and the new purchase", evB[0] === "INITIAL_PURCHASE" && evB.length >= 2, evB);
      c.eq("the self-hosted events stayed as they were", (await eventsOf(ctx, dev.projectId)).length, 1);
      await page.screenshot({ path: join(ctx.out, "after-move.png") });
      c.check("no console errors in the app", consoleErrors.length === 0, consoleErrors.slice(0, 5));
    } finally {
      await browser.close().catch(() => {});
      B.stop();
      await sqlB.end().catch(() => {});
      if (process.env.KEEP_DB !== "1") await dropDatabase(dbB).catch((e) => console.error("drop failed", hideUrls(String(e))));
    }
  },
};

export default journey;
