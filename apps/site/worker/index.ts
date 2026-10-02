// revenuedot.app Worker. Static assets answer every request except /api/* (cloudflare.config.ts, runWorkerFirst):
//   GET  /api/geo            the visitor's country (Cloudflare's guess), so the phone picker starts on the right country
//   POST /api/contact-sales  the contact-sales form: validate, store in D1 (LEADS), email sales (EMAIL to SALES_TO)
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { CURRENT, NEEDS, PLATFORMS, REVENUE, ROLES, SCORE_LABEL, TIMELINE, label, score, validate, type Lead, type Score } from "./lead";

interface D1 { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> }; run(): Promise<unknown> } }
interface SendEmail { send(m: { to: string; from: { email: string; name?: string }; subject: string; text: string; html: string; replyTo?: string }): Promise<unknown> }
interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  LEADS?: D1;
  EMAIL?: SendEmail;
  LEAD_LIMIT?: RateLimit;
  SALES_TO?: string;
}

const FROM = { email: "no-reply@mail.revenuedot.app", name: "RevenueDot website" };
const ALLOWED_ORIGIN = /^https:\/\/(www\.)?revenuedot\.app$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const SCHEMA = `CREATE TABLE IF NOT EXISTS sales_leads (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, score TEXT NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL, company TEXT NOT NULL, role TEXT NOT NULL,
  phone TEXT NOT NULL, phone_country TEXT NOT NULL, revenue TEXT NOT NULL, current_vendor TEXT NOT NULL,
  needs TEXT NOT NULL, timeline TEXT NOT NULL, platforms TEXT NOT NULL, website TEXT, message TEXT,
  country TEXT, referrer TEXT, user_agent TEXT, emailed INTEGER NOT NULL DEFAULT 0)`;
let schemaReady = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
// A plain page for form posts made without JavaScript. `body` is trusted HTML built here.
const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><body style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:#0A0A0A"><h1 style="font-size:24px;letter-spacing:-.02em">${title}</h1><p>${body}</p></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/geo" && request.method === "GET") {
      const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? null;
      return json({ country: country && /^[A-Z]{2}$/.test(country) ? country : null });
    }
    if (url.pathname === "/api/contact-sales") {
      if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
      return contactSales(request, env);
    }
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function readBody(request: Request): Promise<{ data: Record<string, unknown>; form: boolean } | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) return { data: (await request.json()) as Record<string, unknown>, form: false };
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      const fd = await request.formData();
      const data: Record<string, unknown> = {};
      for (const k of new Set(fd.keys())) {
        const all = fd.getAll(k).filter((v): v is string => typeof v === "string");
        data[k] = k === "needs" || k === "platforms" ? all : all[0];
      }
      return { data, form: true };
    }
  } catch { /* fall through */ }
  return null;
}

async function contactSales(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGIN.test(origin)) return json({ ok: false, error: "This form only accepts posts from revenuedot.app." }, 403);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (env.LEAD_LIMIT && !(await env.LEAD_LIMIT.limit({ key: ip })).success) return json({ ok: false, error: "Too many requests. Wait a minute and try again." }, 429);

  const body = await readBody(request);
  if (!body || typeof body.data !== "object" || body.data === null) return json({ ok: false, error: "Send the form as JSON or form data." }, 400);
  const { data, form } = body;
  const done = (next: "sales" | "self_serve") => (form ? page("Thanks. We will reply within one business day.", next === "self_serve"
    ? `Your apps fit RevenueDot Cloud, which is free up to $10,000 a month. <a href="https://app.revenuedot.app/signup">Start free on Cloud</a> while you wait.`
    : `We will email you to set up a 30-minute call. <a href="/pricing">Back to pricing</a>.`) : json({ ok: true, next }));

  // Bots: a filled hidden field, or a form sent faster than a person can type. They get a normal-looking answer.
  const started = Number(data.started);
  if (typeof data.fax === "string" && data.fax.trim()) return done("sales");
  if (Number.isFinite(started) && started > 0 && Date.now() - started < 2500) return done("sales");

  const v = validate(data);
  if (!v.ok) {
    if (!form) return json({ ok: false, errors: v.errors }, 400);
    const items = Object.values(v.errors).map((e) => `<li>${esc(e)}</li>`).join("");
    return page("Check the form", `<ul>${items}</ul>Go back and correct these answers.`, 400);
  }
  const lead = v.lead;
  const s = score(lead);
  const id = crypto.randomUUID();
  const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? null;
  const meta = { country, referrer: (request.headers.get("referer") ?? "").slice(0, 300), userAgent: (request.headers.get("user-agent") ?? "").slice(0, 300) };

  let stored = false;
  if (env.LEADS) {
    try {
      if (!schemaReady) { await env.LEADS.prepare(SCHEMA).run(); schemaReady = true; }
      await env.LEADS.prepare(`INSERT INTO sales_leads (id, created_at, score, name, email, company, role, phone, phone_country, revenue, current_vendor, needs, timeline, platforms, website, message, country, referrer, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id, new Date().toISOString(), s, lead.name, lead.email, lead.company, lead.role, lead.phone, lead.phoneCountry, lead.revenue, lead.current,
        JSON.stringify(lead.needs), lead.timeline, JSON.stringify(lead.platforms), lead.website || null, lead.message || null, meta.country, meta.referrer || null, meta.userAgent || null,
      ).run();
      stored = true;
    } catch (e) { console.error("contact-sales: storing the lead failed", e); }
  }

  let emailed = false;
  if (env.EMAIL && env.SALES_TO) {
    try {
      await env.EMAIL.send({ to: env.SALES_TO, from: FROM, replyTo: lead.email, ...leadEmail(lead, s, meta) });
      emailed = true;
      if (stored) await env.LEADS!.prepare("UPDATE sales_leads SET emailed = 1 WHERE id = ?").bind(id).run().catch(() => {});
    } catch (e) { console.error("contact-sales: emailing the lead failed", e); }
  }
  console.log(JSON.stringify({ event: "contact_sales", id, score: s, stored, emailed }));
  if (!stored && !emailed) return json({ ok: false, error: "We could not save your request. Email hello@revenuedot.app instead." }, 503);
  return done(s === "self_serve" ? "self_serve" : "sales");
}

export function leadEmail(l: Lead, s: Score, meta: { country: string | null; referrer: string; userAgent: string }) {
  const rows: [string, string][] = [
    ["Name", l.name], ["Email", l.email], ["Phone", `${parsePhoneNumberFromString(l.phone)?.formatInternational() ?? l.phone} (dial ${l.phone})`], ["Company", l.company], ["Role", label(ROLES, l.role)],
    ["Monthly in-app revenue", label(REVENUE, l.revenue)], ["Uses today", label(CURRENT, l.current)],
    ["Needs", l.needs.map((n) => label(NEEDS, n)).join(", ") || "None chosen"], ["Timeline", label(TIMELINE, l.timeline)],
    ["Platforms", l.platforms.map((p) => label(PLATFORMS, p)).join(", ") || "Not given"], ["Website", l.website || "Not given"],
    ["Visitor country", meta.country ?? "Unknown"], ["Came from", meta.referrer || "Direct"],
  ];
  const revenue = l.revenue === "undisclosed" ? "revenue not shared" : label(REVENUE, l.revenue).replace(" a month", "/mo");
  const subject = `[${SCORE_LABEL[s]}] Sales lead: ${l.company} (${l.name}), ${revenue}, uses ${label(CURRENT, l.current)}`.replace(/[\r\n]+/g, " ").slice(0, 200);
  const text = `${SCORE_LABEL[s]} lead from revenuedot.app/contact-sales\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nMessage:\n${l.message || "(none)"}\n\nReply to this email to answer ${l.name} directly.`;
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A"><p style="font-weight:700">${esc(SCORE_LABEL[s])} lead from revenuedot.app/contact-sales</p><table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#525252;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${k === "Phone" ? `<a href="tel:${esc(l.phone)}">${esc(v)}</a>` : k === "Email" ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v)}</td></tr>`).join("")}</table><p style="color:#525252;margin-top:16px">Message</p><p style="white-space:pre-wrap">${esc(l.message || "(none)")}</p><p style="color:#737373">Reply to this email to answer ${esc(l.name)} directly.</p></div>`;
  return { subject, text, html };
}
