// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the stack every journey runs against, all on this machine except Postgres:
//   - a fresh database `rd_validate_j_<stamp>` on the Railway development Postgres (dropped at the end)
//   - an SMTP sink (the server's real SMTP driver delivers to it)
//   - a capture server: answers the server's outbound calls (see outbound-preload.mjs), hosts the fake Stripe account and
//     its Checkout page, records webhook and partner requests, and serves the web SDK test page
//   - the real Node entry (apps/server/src/entry.node.ts) with the built dashboard, started as its own process
// Ports: JOURNEY_PORT_BASE (default 5600) + 0 server, +1 SMTP, +2 capture, +3 example backend, +4/+5 MinIO, +6 self-host
// (JOURNEY_SELFHOST_PORT overrides).
// Docs: prd/validation/COVERAGE.md
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { FakeStripeAccount } from "../../../../packages/contract/src/fake-stripe.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "../../../..");
export const BUILD = join(HERE, "../build");
const req = createRequire(join(ROOT, "packages/db/package.json"));
export const postgres = req("postgres") as typeof import("postgres").default;
const serverReq = createRequire(join(ROOT, "apps/server/package.json"));

export const PORT_BASE = Number(process.env.JOURNEY_PORT_BASE ?? 5600);
export const PORTS = { server: PORT_BASE, smtp: PORT_BASE + 1, capture: PORT_BASE + 2, backend: PORT_BASE + 3, minio: PORT_BASE + 4, minioConsole: PORT_BASE + 5, selfhost: Number(process.env.JOURNEY_SELFHOST_PORT ?? PORT_BASE + 6) };

/** The development Postgres server (Railway), from the environment or ~/.config/revenuedot/dev.env. Never printed. */
export function devAdminUrl(): string {
  if (process.env.REVENUEDOT_DEV_DATABASE_URL) return process.env.REVENUEDOT_DEV_DATABASE_URL;
  const file = join(process.env.HOME ?? "", ".config/revenuedot/dev.env");
  const m = existsSync(file) ? /REVENUEDOT_DEV_DATABASE_URL=["']?([^"'\n]+)/.exec(readFileSync(file, "utf8")) : null;
  if (!m) throw new Error("No development Postgres: set REVENUEDOT_DEV_DATABASE_URL or create ~/.config/revenuedot/dev.env (see AGENTS.md)");
  return m[1]!;
}
export const dbUrl = (admin: string, name: string) => { const u = new URL(admin); u.pathname = `/${name}`; return u.href; };
export const hideUrls = (s: string) => s.replace(/postgres(ql)?:\/\/\S+/g, "postgres://…");

export async function createDatabase(name: string): Promise<string> {
  const admin = devAdminUrl();
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE "${name}"`);
  } finally { await sql.end(); }
  return dbUrl(admin, name);
}

export async function dropDatabase(name: string): Promise<void> {
  const sql = postgres(devAdminUrl(), { max: 1, onnotice: () => {} });
  try { await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await sql.end(); }
}

// ---------- SMTP sink ----------
export interface Mail { to: string[]; from: string; subject: string; text: string; html: string; raw: string; at: number }

function decodeQP(s: string) {
  const bytes: number[] = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(...Buffer.from(t[i]!, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Splits a MIME message into its decoded text and HTML parts (enough for the server's own emails). */
export function parseMime(raw: string): { subject: string; text: string; html: string } {
  const [head = "", ...rest] = raw.split(/\r?\n\r?\n/);
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const subjectRaw = /^subject:\s*(.*)$/im.exec(unfolded)?.[1] ?? "";
  const subject = subjectRaw.replace(/=\?utf-8\?([QB])\?([^?]*)\?=/gi, (_m, enc, data) => enc.toUpperCase() === "B" ? Buffer.from(data, "base64").toString("utf8") : decodeQP(data.replace(/_/g, " "))).replace(/\s+/g, " ").trim();
  let text = "", html = "";
  const body = rest.join("\n\n");
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(unfolded)?.[1] ?? /boundary="?([^";\r\n]+)"?/i.exec(body)?.[1];
  const parts = boundary ? raw.split(`--${boundary}`) : [raw];
  const walk = (part: string) => {
    const [h = "", ...b] = part.split(/\r?\n\r?\n/);
    const inner = /boundary="?([^";\r\n]+)"?/i.exec(h)?.[1];
    if (inner) { part.split(`--${inner}`).slice(1).forEach(walk); return; }
    const ctype = /content-type:\s*([^;\r\n]+)/i.exec(h)?.[1]?.toLowerCase() ?? "";
    const enc = /content-transfer-encoding:\s*([^\s;]+)/i.exec(h)?.[1]?.toLowerCase() ?? "";
    let content = b.join("\n\n");
    if (enc === "quoted-printable") content = decodeQP(content);
    else if (enc === "base64") content = Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8");
    if (ctype === "text/plain" && !text) text = content;
    if (ctype === "text/html" && !html) html = content;
  };
  (boundary ? parts.slice(1) : parts).forEach(walk);
  return { subject, text, html };
}

export async function startSmtpSink(port: number): Promise<{ mails: Mail[]; close: () => Promise<void> }> {
  const { SMTPServer } = serverReq("smtp-server") as typeof import("smtp-server");
  const mails: Mail[] = [];
  const server = new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS"], logger: false,
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const p = parseMime(raw);
        mails.push({ to: session.envelope.rcptTo.map((r) => r.address.toLowerCase()), from: (session.envelope.mailFrom || { address: "" }).address, ...p, raw, at: Date.now() });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  return { mails, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Links in an email (text and HTML), unescaped. */
export const linksOf = (m: Mail) => [...new Set([...(m.text + "\n" + m.html).matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((x) => x[0].replace(/&amp;/g, "&").replace(/[.,]$/, "")))];

// ---------- Capture server ----------
export interface Captured { at: number; method: string; host: string; path: string; query: string; headers: Record<string, string>; body: string }

export class Capture {
  requests: Captured[] = [];
  stripe = new FakeStripeAccount();
  /** Extra handlers by original host (or "/local/<name>" paths), tried before the defaults. */
  handlers: Array<(c: Captured, res: ServerResponse) => boolean | Promise<boolean>> = [];
  /** Static pages served at /pages/<name>. */
  pages = new Map<string, { type: string; body: string | Buffer }>();
  /** Static folders: URL prefix (e.g. "/site/") → directory, for built web apps. */
  dirs = new Map<string, string>();
  server!: Server;
  constructor(readonly port: number) {
    this.stripe.checkoutUrl = `http://localhost:${port}/__stripe/checkout/{id}`;
  }
  get base() { return `http://localhost:${this.port}`; }

  of(host: string, path?: string | RegExp) {
    return this.requests.filter((r) => r.host === host && (!path || (typeof path === "string" ? r.path === path : path.test(r.path))));
  }

  async start() {
    this.server = createServer((rq, rs) => { this.handle(rq, rs).catch((e) => { rs.statusCode = 500; rs.end(String(e)); }); });
    await new Promise<void>((r) => this.server.listen(this.port, "127.0.0.1", () => r()));
  }
  close() { return new Promise<void>((r) => this.server.close(() => r())); }

  private async handle(rq: IncomingMessage, rs: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of rq) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(rq.url ?? "/", "http://capture");
    const host = String(rq.headers["x-rd-original-host"] ?? "local");
    const headers = Object.fromEntries(Object.entries(rq.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
    const c: Captured = { at: Date.now(), method: rq.method ?? "GET", host, path: url.pathname, query: url.search, headers, body: raw.toString("utf8") };

    // Fake Stripe Checkout page: "Pay" completes the session the way the customer paying on Stripe would.
    const co = /^\/__stripe\/checkout\/([^/]+)$/.exec(url.pathname);
    if (co && host === "local") {
      const s = this.stripe.sessions.get(co[1]!);
      if (!s) { rs.statusCode = 404; rs.end("No such checkout session"); return; }
      if (rq.method === "POST") {
        const email = new URLSearchParams(c.body).get("email")?.trim() || undefined;
        this.stripe.complete(s.id, { email });
        rs.statusCode = 303; rs.setHeader("location", s.success_url); rs.end(); return;
      }
      const item = s.line_items.data[0];
      const amount = `${(item.price.unit_amount / 100).toFixed(2)} ${String(item.price.currency).toUpperCase()}`;
      const discount = s.discounts?.[0] ? `<p data-discount>Discount applied (${s.discounts[0].promotion_code ?? s.discounts[0].coupon})</p>` : "";
      rs.setHeader("content-type", "text/html");
      rs.end(`<!doctype html><html><head><meta charset="utf-8"><title>Fake Stripe Checkout</title></head><body><h1>Fake Stripe Checkout</h1>
<p>${s.mode}: <b data-amount>${amount}</b></p>${discount}<form method="post"><input name="email" type="email" value="${s.customer_email ?? ""}"><button type="submit">Pay</button></form></body></html>`);
      return;
    }
    for (const [prefix, dir] of this.dirs) {
      if (host !== "local" || !url.pathname.startsWith(prefix)) continue;
      const rel = url.pathname.slice(prefix.length) || "index.html";
      const file = join(dir, rel);
      const target = file.startsWith(dir) && existsSync(file) && !file.endsWith("/") ? file : join(dir, "index.html");
      const ext = target.split(".").pop() ?? "";
      const types: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", json: "application/json", woff2: "font/woff2" };
      rs.setHeader("content-type", types[ext] ?? "application/octet-stream");
      rs.end(readFileSync(target));
      return;
    }
    const page = /^\/pages\/(.+)$/.exec(url.pathname);
    if (page && host === "local") {
      const p = this.pages.get(page[1]!);
      rs.statusCode = p ? 200 : 404; if (p) rs.setHeader("content-type", p.type); rs.end(p?.body ?? "not found"); return;
    }

    this.requests.push(c);
    for (const h of this.handlers) if (await h(c, rs)) return;

    if (host === "api.stripe.com") {
      const res = await this.stripe.fetch(`https://api.stripe.com${url.pathname}${url.search}`, { method: c.method, headers: rq.headers as Record<string, string>, body: ["GET", "HEAD"].includes(c.method) ? undefined : c.body });
      rs.statusCode = res.status; rs.setHeader("content-type", "application/json"); rs.end(await res.text()); return;
    }
    if (host === "oauth2.googleapis.com" && url.pathname === "/token") {
      rs.setHeader("content-type", "application/json"); rs.end(JSON.stringify({ access_token: "ya29.journey-fake", expires_in: 3600, token_type: "Bearer" })); return;
    }
    // Every other partner: a plain success, as most partner APIs answer.
    rs.statusCode = 200; rs.setHeader("content-type", "application/json"); rs.end(JSON.stringify({ ok: true, success: true, status: 1, code: 200 }));
  }
}

// ---------- The RevenueDot server ----------
export interface ServerOpts { databaseUrl: string; port: number; smtpPort: number; capturePort: number; logDir: string; env?: Record<string, string> }

export const OUTBOUND_BLOCK = ["apple.com", "itunes.apple.com", "storekit.itunes.apple.com", "api.storekit.itunes.apple.com", "androidpublisher.googleapis.com", "playdeveloperreporting.googleapis.com", "pubsub.googleapis.com", "appstoreconnect.apple.com"];
/** Public endpoints the server may call for real: exchange rates, Google's Measurement Protocol validation server. */
export const OUTBOUND_ALLOW = ["cdn.jsdelivr.net", "latest.currency-api.pages.dev", "data-api.ecb.europa.eu", "www.google-analytics.com", "region1.google-analytics.com"];

export class RdServer {
  child!: ChildProcess;
  readonly base: string;
  readonly signingKey = randomBytes(32).toString("base64");
  readonly encryptionKey = randomBytes(32).toString("base64");
  constructor(readonly o: ServerOpts) { this.base = `http://localhost:${o.port}`; }
  get requestLog() { return join(this.o.logDir, "requests.jsonl"); }
  get outboundLog() { return join(this.o.logDir, "outbound.jsonl"); }
  get serverLog() { return join(this.o.logDir, "server.log"); }

  async start() {
    mkdirSync(this.o.logDir, { recursive: true });
    for (const f of [this.requestLog, this.outboundLog]) rmSync(f, { force: true });
    const fd = openSync(this.serverLog, "a");
    const tsxLoader = join(ROOT, "node_modules/tsx/dist/loader.mjs");
    const env = {
      ...process.env,
      PORT: String(this.o.port), DATABASE_URL: this.o.databaseUrl, REVENUEDOT_ALLOW_SIGNUP: "true",
      REVENUEDOT_SMTP_URL: `smtp://127.0.0.1:${this.o.smtpPort}`, REVENUEDOT_MAIL_FROM: "RevenueDot <no-reply@journeys.test>",
      REVENUEDOT_PUBLIC_URL: this.base, REVENUEDOT_API_URL: this.base, REVENUEDOT_REQUEST_LOG: this.requestLog,
      REVENUEDOT_SIGNING_KEY: this.signingKey, REVENUEDOT_ENCRYPTION_KEY: this.encryptionKey,
      RD_JOURNEY_ROUTES: JSON.stringify({ "*": `http://127.0.0.1:${this.o.capturePort}` }),
      RD_JOURNEY_ALLOW: OUTBOUND_ALLOW.join(","), RD_JOURNEY_BLOCK: OUTBOUND_BLOCK.join(","), RD_JOURNEY_OUTBOUND_LOG: this.outboundLog,
      DASHBOARD_DIST: join(ROOT, "apps/dashboard/dist"),
      ...this.o.env,
    };
    this.child = spawn(process.execPath, ["--import", tsxLoader, "--import", join(HERE, "outbound-preload.mjs"), join(ROOT, "apps/server/src/entry.node.ts")], {
      cwd: join(ROOT, "apps/server"), env, stdio: ["ignore", fd, fd], detached: true,
    });
    for (let i = 0; i < 180; i++) {
      try { if ((await fetch(`${this.base}/v1/health`)).ok) return; } catch { /* starting */ }
      if (this.child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`server did not start:\n${hideUrls(readFileSync(this.serverLog, "utf8")).slice(-3000)}`);
  }

  stop() {
    if (!this.child?.pid) return;
    try { process.kill(-this.child.pid, "SIGTERM"); } catch { try { this.child.kill("SIGTERM"); } catch { /* gone */ } }
  }

  /** Request log lines (method, path, status) since `since`. */
  requests(since = 0): Array<{ at: number; method: string; path: string; query: string; status: number; routed: boolean }> {
    if (!existsSync(this.requestLog)) return [];
    return readFileSync(this.requestLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.at >= since);
  }
  outbound(since = 0): Array<{ at: number; method: string; host: string; path: string; routed: string; status: number }> {
    if (!existsSync(this.outboundLog)) return [];
    return readFileSync(this.outboundLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.at >= since);
  }
}

export function writeJson(path: string, data: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2)); }
export function appendLine(path: string, line: string) { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, line + "\n"); }
