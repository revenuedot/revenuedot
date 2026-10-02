// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (n), self-hosting with Docker. The repo's own image (Dockerfile) is built and started through the
// repo's docker-compose.yml, as a self-hoster does, against a fresh database `rd_validate_selfhost_<stamp>` on the
// Railway development Postgres (never a local Postgres): only the `revenuedot` service starts (`--no-deps`), and a small
// override file points DATABASE_URL at that database and binds the port to 127.0.0.1:JOURNEY_SELFHOST_PORT.
// The database URL reaches Docker only through an env file (mode 600) in the build folder, deleted right after `up`.
// Checks: migrations applied on start (drizzle's table complete, the same tables as the journey server's database), the
// image's health check, /v1/health, the dashboard pages, owner sign-up and the second sign-up refused (403 signup_closed),
// sign-in, a Test Store app + product + SDK purchase on the container, and `docker compose restart` keeping everything.
// Tear-down: compose down, the built image removed, the database dropped.
// Docs: https://revenuedot.app/docs/self-hosting
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, sdkClient } from "./lib/context.ts";
import { BUILD, PORTS, ROOT, createDatabase, devAdminUrl, dropDatabase, hideUrls, postgres } from "./lib/stack.ts";

/**
 * Docker sees only what it needs: compose interpolates `${ANTHROPIC_API_KEY:-}` and the like from its environment, so this
 * machine's own keys and settings must never reach the container.
 */
const DOCKER_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => ["PATH", "HOME", "USER", "TMPDIR", "LANG"].includes(k) || k.startsWith("DOCKER_")));

interface Out { code: number | null; out: string; /** The raw output contained a database URL (it is scrubbed from `out`). */ leaked: boolean }
/** Runs a command; output is captured (never printed) and scrubbed of database URLs before anyone sees it. */
function run(cmd: string, args: string[], opts: { log?: string; timeoutMs?: number } = {}): Promise<Out> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: DOCKER_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    const t = opts.timeoutMs ? setTimeout(() => p.kill("SIGTERM"), opts.timeoutMs) : null;
    p.on("close", (code) => {
      if (t) clearTimeout(t);
      const leaked = /postgres(ql)?:\/\//.test(out);
      out = hideUrls(out);
      if (opts.log) writeFileSync(opts.log, out);
      resolve({ code, out, leaked });
    });
  });
}

const freeGb = async () => {
  const df = await run("df", ["-k", "/"]);
  const kb = Number(df.out.trim().split("\n").pop()!.trim().split(/\s+/)[3]);
  return Math.round(kb / 1024 / 1024 * 10) / 10;
};

const journey: Journey = {
  name: "self-host",
  title: "Self-hosting: docker compose with the repo's image on a Railway database, owner sign-up, a purchase, a restart",
  heavy: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const project = `rdjourney${ctx.stamp}`;
    const image = `${project}-revenuedot`;
    const dbName = `rd_validate_selfhost_${ctx.stamp}`;
    const override = join(BUILD, `${project}.compose.yml`);
    const envFile = join(BUILD, `.${project}.env`);
    const base = `http://127.0.0.1:${PORTS.selfhost}`;
    const compose = (...args: string[]) => ["compose", "-p", project, "-f", "docker-compose.yml", "-f", override, ...args];
    let started = false;
    let built = false;
    let dbCreated = false;
    let selfSql: ReturnType<typeof postgres> | null = null;
    try {
      c.begin("build the image from the repo's Dockerfile");
      const gbBefore = await freeGb();
      c.must(`enough free disk for an image build (${gbBefore} GB free)`, gbBefore >= 8, gbBefore);
      // Only the app service, the port on loopback, the database from the env file; everything else is the repo's compose file.
      writeFileSync(override, [
        "# Journey override (scripts/e2e/journeys/self-host.ts): app service only, database on the Railway development Postgres.",
        "services:",
        "  revenuedot:",
        `    ports: !override ["127.0.0.1:${PORTS.selfhost}:8787"]`,
        "    environment:",
        "      DATABASE_URL: ${RD_JOURNEY_DATABASE_URL:-}",
        "    depends_on: !reset {}",
        "    restart: \"no\"",
        "",
      ].join("\n"));
      const t0 = Date.now();
      // Built before the env file exists, so the database URL is never near the build context.
      const build = await run("docker", compose("build", "revenuedot"), { log: join(ctx.out, "docker-build.log"), timeoutMs: 30 * 60_000 });
      built = build.code === 0;
      c.must(`docker compose build succeeds (${Math.round((Date.now() - t0) / 1000)}s)`, built, build.out.slice(-3000));
      const size = await run("docker", ["image", "inspect", image, "--format", "{{.Size}}"]);
      c.check("the image is built under the compose project's name", size.code === 0 && Number(size.out.trim()) > 0, size.out);
      const node = await run("docker", ["run", "--rm", "--entrypoint", "node", image, "--version"]);
      const nvmrc = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim().replace(/^v/, "");
      c.check(`the image runs Node ${nvmrc} (.nvmrc)`, node.out.trim().startsWith(`v${nvmrc}`), { node: node.out.trim(), nvmrc });

      c.begin("start on a Railway development database");
      const databaseUrl = await createDatabase(dbName);
      dbCreated = true;
      writeFileSync(envFile, `RD_JOURNEY_DATABASE_URL='${databaseUrl}'\n`, { mode: 0o600 });
      chmodSync(envFile, 0o600);
      const up = await run("docker", ["compose", "--env-file", envFile, ...compose("up", "-d", "--no-build", "--no-deps", "revenuedot").slice(1)], { log: join(ctx.out, "docker-up.log") });
      rmSync(envFile, { force: true });
      started = up.code === 0;
      c.must("docker compose up -d starts only the revenuedot service", started, up.out.slice(-2000));
      c.check("the env file with the database URL is deleted right after start", !existsSync(envFile));
      const ps = await run("docker", compose("ps", "--format", "{{.Service}}"));
      c.eq("no Postgres container: only the app service runs", ps.out.trim().split("\n").filter(Boolean), ["revenuedot"]);
      const healthy = await until(async () => { try { return (await fetch(`${base}/v1/health`)).ok; } catch { return false; } }, { timeoutMs: 180_000, everyMs: 1000 });
      const logRun = () => run("docker", compose("logs", "--no-color", "revenuedot"));
      const logs = async () => (await logRun()).out;
      c.must("GET /v1/health answers 200 on the container", healthy, (await logs()).slice(-3000));

      const blank = await run("docker", compose("exec", "-T", "revenuedot", "node", "-e", "process.stdout.write(JSON.stringify([process.env.OPENAI_BASE_URL, process.env.ANTHROPIC_API_KEY]))"));
      c.eq("compose passes unset AI settings as empty strings (OPENAI_BASE_URL \"\" once stopped the server) and the server runs", blank.out.trim(), JSON.stringify(["", ""]));
      c.check("the container started without downloading pnpm (corepack install at build time)", !(await logs()).includes("Corepack is about to download"), (await logs()).slice(0, 500));

      c.begin("migrations ran on start");
      selfSql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
      const journal = JSON.parse(readFileSync(join(ROOT, "packages/db/migrations/meta/_journal.json"), "utf8")).entries as unknown[];
      const [applied] = await selfSql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      c.eq(`drizzle's migrations table has all ${journal.length} migrations`, applied!.n, journal.length);
      const tablesOf = async (q: typeof selfSql) => (await q!`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).map((r) => r.table_name as string);
      const selfTables = await tablesOf(selfSql);
      const refTables = await tablesOf(ctx.sql as never);
      c.check(`the same ${refTables.length} tables as the journey server's database (projects, apps, subscriptions, users ...)`, JSON.stringify(selfTables) === JSON.stringify(refTables) && ["projects", "apps", "subscriptions", "users", "webhook_deliveries"].every((t) => selfTables.includes(t)),
        { missing: refTables.filter((t) => !selfTables.includes(t)), extra: selfTables.filter((t) => !refTables.includes(t)) });

      c.begin("health check, API and dashboard on one port");
      const root = await fetch(`${base}/`);
      const rootBody = await root.json().catch(() => null) as any;
      c.check("GET / answers the name and docs link (the image's health check target)", root.ok && rootBody?.name === "RevenueDot", rootBody);
      const dockerHealth = await until(async () => (await run("docker", ["inspect", "--format", "{{.State.Health.Status}}", `${project}-revenuedot-1`])).out.trim() === "healthy", { timeoutMs: 75_000, everyMs: 3000 });
      c.check("Docker reports the container healthy (the Dockerfile's HEALTHCHECK passes)", dockerHealth, (await run("docker", ["inspect", "--format", "{{json .State.Health}}", `${project}-revenuedot-1`])).out.slice(0, 600));
      const login = await fetch(`${base}/login`);
      const html = await login.text();
      const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
      c.check("the dashboard's sign-in page /login is served as HTML", login.ok && /text\/html/.test(login.headers.get("content-type") ?? "") && /<div id="root"/.test(html), html.slice(0, 300));
      const js = script ? await fetch(new URL(script, base)) : null;
      c.check("the dashboard's JavaScript bundle loads", js?.ok && /javascript/.test(js.headers.get("content-type") ?? ""), { script, status: js?.status });
      const deep = await fetch(`${base}/projects/x/overview`);
      c.check("dashboard routes fall back to the single-page app", deep.ok && (await deep.text()).includes('<div id="root"'), deep.status);
      const v2Unknown = await fetch(`${base}/v2/nope`);
      const v2Type = v2Unknown.headers.get("content-type") ?? "";
      c.check("API paths never fall back to the dashboard (unknown /v2 path: JSON 401 without a key)", v2Unknown.status === 401 && v2Type.includes("json"), { status: v2Unknown.status, type: v2Type });
      const cfg = await (await fetch(`${base}/auth/config`)).json() as any;
      c.has("sign-up is open for the first account (self-hosted edition)", cfg, { edition: "self-hosted", signup: "open" });

      c.begin("owner sign-up, the second sign-up refused, sign-in");
      const email = `owner-${ctx.stamp}@journeys.test`;
      const password = `owner-${ctx.stamp}-pw`;
      const post = (path: string, json: unknown, cookie?: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(json) });
      const su = await post("/auth/signup", { email, password, name: "Owner", project_name: "Self-hosted app" });
      const cookie = `rd_session=${/rd_session=([^;]+)/.exec(su.headers.get("set-cookie") ?? "")?.[1]}`;
      c.must("the first account signs up (201) and gets a session", su.status === 201 && !cookie.endsWith("undefined"), { status: su.status, body: await su.clone().text() });
      const second = await post("/auth/signup", { email: `stranger-${ctx.stamp}@journeys.test`, password: "stranger-pass-1", name: "Stranger", project_name: "Nope" });
      const secondBody = await second.json() as any;
      c.check("a second sign-up is refused: 403 signup_closed, no session cookie", second.status === 403 && secondBody.type === "signup_closed" && !(second.headers.get("set-cookie") ?? "").includes("rd_session="), { status: second.status, body: secondBody });
      const [users] = await selfSql`SELECT count(*)::int AS n FROM users`;
      c.eq("only the owner is in the users table", users!.n, 1);
      c.has("GET /auth/config now says sign-up is closed", await (await fetch(`${base}/auth/config`)).json() as any, { signup: "closed" });
      const bad = await post("/auth/login", { email, password: "wrong-password" });
      const good = await post("/auth/login", { email, password });
      const session = `rd_session=${/rd_session=([^;]+)/.exec(good.headers.get("set-cookie") ?? "")?.[1]}`;
      c.check("sign-in: a wrong password is 401, the right one 200 with a session", bad.status === 401 && good.status === 200 && !session.endsWith("undefined"), { bad: bad.status, good: good.status });
      const call = async (method: string, path: string, json?: unknown) => {
        const r = await fetch(`${base}${path}`, { method, headers: { cookie: session, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
        const t = await r.text();
        let body: any = t; try { body = t ? JSON.parse(t) : null; } catch { /* text */ }
        return { status: r.status, body };
      };
      const me = await call("GET", "/auth/me");
      c.check("GET /auth/me names the owner and the project", me.status === 200 && me.body.user?.email === email && me.body.projects?.length === 1, me.body);
      const P = `/v2/projects/${me.body.projects[0].id}`;
      const v2 = async (method: string, path: string, json?: unknown) => {
        const r = await call(method, P + path, json);
        if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
        return r.body;
      };

      c.begin("Test Store app, product and an SDK purchase on the container");
      const app = await v2("POST", "/apps", { name: "Self-hosted (Test Store)", type: "test_store" });
      const testKey = (await v2("GET", `/apps/${app.id}/public_api_keys`)).items[0]?.key as string;
      c.check("Test Store app with a test_ key", /^test_/.test(testKey ?? ""), testKey?.slice(0, 5));
      const product = await v2("POST", "/products", { store_identifier: "selfhost_monthly", app_id: app.id, type: "subscription", display_name: "Monthly", subscription: { duration: "P1M" }, test_store_price: { amount_micros: 4_990_000, currency: "USD" } });
      const ent = await v2("POST", "/entitlements", { lookup_key: "pro", display_name: "Pro" });
      await v2("POST", `/entitlements/${ent.id}/actions/attach_products`, { product_ids: [product.id] });
      const off = await v2("POST", "/offerings", { lookup_key: "default", display_name: "Default" });
      await v2("POST", `/offerings/${off.id}`, { is_current: true });
      const pkg = await v2("POST", `/offerings/${off.id}/packages`, { lookup_key: "$rc_monthly", display_name: "Monthly", position: 0 });
      await v2("POST", `/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: product.id, eligibility_criteria: "all" }] });
      const sdk = sdkClient({ ...ctx, base }, testKey);
      const buyer = `selfhost_buyer_${ctx.stamp}`;
      const offerings = await sdk.offerings(buyer);
      c.check("SDK offerings: current 'default' with the monthly package", offerings.status === 200 && offerings.body.current_offering_id === "default" && offerings.body.offerings?.[0]?.packages?.[0]?.platform_product_identifier === "selfhost_monthly", offerings.body);
      const buy = await sdk.purchase(buyer, "selfhost_monthly", { price: 4.99, presented_offering_identifier: "default" });
      c.check("SDK receipt post (Test Store): 200 with 'pro' active", buy.status === 200 && buy.body.subscriber?.entitlements?.pro?.product_identifier === "selfhost_monthly", buy.body);
      const [subRow] = await selfSql`SELECT s.store, s.product_identifier, s.expires_date FROM subscriptions s JOIN customer_aliases a ON a.customer_id = s.customer_id WHERE a.app_user_id = ${buyer}`;
      c.check("the subscription is stored in the self-hosted database", subRow?.store === "test_store" && subRow.product_identifier === "selfhost_monthly" && subRow.expires_date > new Date(), subRow);
      const [ev] = await selfSql`SELECT type FROM events WHERE payload->'event'->>'app_user_id' = ${buyer}`;
      c.eq("INITIAL_PURCHASE recorded", ev?.type, "INITIAL_PURCHASE");
      const logRun1 = await logRun();
      c.check("the server log names the port and never prints the database URL", logRun1.out.includes("RevenueDot API on http://localhost:8787") && !logRun1.leaked, logRun1.out.slice(-800));

      c.begin("docker compose restart keeps everything");
      const counts = async () => (await selfSql!`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM products)::int AS products, (SELECT count(*) FROM subscriptions)::int AS subscriptions, (SELECT count(*) FROM events)::int AS events, (SELECT count(*) FROM drizzle.__drizzle_migrations)::int AS migrations`)[0];
      const before = await counts();
      const restart = await run("docker", compose("restart", "revenuedot"), { log: join(ctx.out, "docker-restart.log") });
      c.check("docker compose restart succeeds", restart.code === 0, restart.out.slice(-1000));
      const back = await until(async () => { try { return (await fetch(`${base}/v1/health`)).ok; } catch { return false; } }, { timeoutMs: 120_000, everyMs: 1000 });
      c.must("the container answers /v1/health again", back, (await logs()).slice(-2000));
      c.eq("users, products, subscriptions, events and migrations unchanged after the restart", await counts(), before);
      const meAgain = await call("GET", "/auth/me");
      c.check("the owner's session from before the restart still works", meAgain.status === 200 && meAgain.body.user?.email === email, meAgain.status);
      const info = await sdk.customerInfo(buyer);
      c.check("the buyer still has 'pro' after the restart", info.status === 200 && info.body.subscriber?.entitlements?.pro?.product_identifier === "selfhost_monthly", info.body);
      const again = await post("/auth/signup", { email: `late-${ctx.stamp}@journeys.test`, password: "late-pass-123", name: "Late", project_name: "Nope" });
      c.eq("sign-up is still closed after the restart (403)", again.status, 403);
    } finally {
      rmSync(envFile, { force: true });
      await selfSql?.end().catch(() => {});
      c.begin("tear-down");
      if (started || built) {
        const down = await run("docker", compose("down", "--remove-orphans", "--volumes"), { log: join(ctx.out, "docker-down.log") });
        c.check("docker compose down removes the container and network", down.code === 0, down.out.slice(-1000));
      }
      if (built) {
        const rm = await run("docker", ["image", "rm", image]);
        c.check("the built image is removed", rm.code === 0, rm.out.slice(-500));
      }
      rmSync(override, { force: true });
      if (dbCreated) {
        await dropDatabase(dbName).catch((e) => c.check("drop the self-host database", false, hideUrls(String(e))));
        const admin = postgres(devAdminUrl(), { max: 1, onnotice: () => {} });
        const left = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`.finally(() => admin.end());
        c.eq(`database ${dbName} dropped`, left.length, 0);
      }
      const left = await run("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]);
      c.eq("no container of this run is left", left.out.trim(), "");
      c.check(`free disk after tear-down: ${await freeGb()} GB`, true);
    }
  },
};
export default journey;
