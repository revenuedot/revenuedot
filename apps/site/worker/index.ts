// revenuedot.app Worker. Static assets answer every request except /api/* (cloudflare.config.ts, runWorkerFirst):
//   GET  /api/geo            the visitor's country (Cloudflare's guess), so the phone picker starts on the right country
//   POST /api/contact-sales  the contact-sales form: validate, store in D1 (LEADS), email sales (EMAIL to SALES_TO)
//   POST /api/contact-sales/draft  partial answers from the stepped form, saved once the email is valid (no email sent)
// Scheduled (daily, cloudflare.config.ts): one email to sales listing people who started the form and did not finish.
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { isEmail, vendorLabel, CURRENT, NEEDS, PLATFORMS, REVENUE, ROLES, SCORE_LABEL, TIMELINE, label, score, validate, type Lead, type Score } from "./lead";

interface D1Stmt { run(): Promise<unknown>; all<T = Record<string, unknown>>(): Promise<{ results: T[] }> }
interface D1 { prepare(sql: string): D1Stmt & { bind(...v: unknown[]): D1Stmt } }
interface SendEmail { send(m: { to: string; from: { email: string; name?: string }; subject: string; text: string; html: string; replyTo?: string }): Promise<unknown> }
interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  LEADS?: D1;
  EMAIL?: SendEmail;
  LEAD_LIMIT?: RateLimit;
  DRAFT_LIMIT?: RateLimit;
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
const DRAFTS = `CREATE TABLE IF NOT EXISTS sales_lead_drafts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, answers TEXT NOT NULL, step INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, country TEXT)`;
let schemaReady = false;
const ADD_OTHER = "ALTER TABLE sales_leads ADD COLUMN current_other TEXT";
let draftsReady = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
// A plain page for form posts made without JavaScript. `body` is trusted HTML built here.
const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><body style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:#0A0A0A"><h1 style="font-size:24px;letter-spacing:-.02em">${title}</h1><p>${body}</p></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export default {
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(sendDigest(env).catch((e) => console.error("contact-sales: digest failed", e)));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/geo" && request.method === "GET") {
      const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? null;
      return json({ country: country && /^[A-Z]{2}$/.test(country) ? country : null });
    }
    if (url.pathname === "/api/contact-sales/draft") {
      if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
      return saveDraft(request, env);
    }
    if (url.pathname === "/api/contact-sales") {
      if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
      return contactSales(request, env);
    }
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },
};

/** Saves the answers so far, so a buyer who leaves after giving an email is not lost. Upsert by the form's draft id. */
async function saveDraft(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGIN.test(origin)) return json({ ok: false }, 403);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (env.DRAFT_LIMIT && !(await env.DRAFT_LIMIT.limit({ key: ip })).success) return json({ ok: false }, 429);
  const body = await readBody(request);
  const d = body?.data ?? {};
  const id = typeof d.draftId === "string" && /^[a-f0-9-]{36}$/.test(d.draftId) ? d.draftId : null;
  const email = typeof d.email === "string" ? d.email.trim().toLowerCase() : "";
  if (!id || !isEmail(email) || typeof d.fax === "string" && d.fax.trim()) return json({ ok: false }, 400);
  const step = Math.max(0, Math.min(20, Number(d.step) || 0));
  const keep = ["revenue", "current", "currentOther", "needs", "timeline", "name", "company", "role", "phone", "phoneCountry", "platforms", "website", "message"];
  const answers = JSON.stringify(Object.fromEntries(keep.filter((k) => d[k] !== undefined).map((k) => [k, typeof d[k] === "string" ? (d[k] as string).slice(0, 2000) : d[k]])));
  if (!env.LEADS) return json({ ok: true });
  try {
    if (!draftsReady) { await env.LEADS.prepare(DRAFTS).run(); draftsReady = true; }
    const now = new Date().toISOString();
    const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? null;
    await env.LEADS.prepare(`INSERT INTO sales_lead_drafts (id, email, answers, step, created_at, updated_at, country) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, answers = excluded.answers, step = max(sales_lead_drafts.step, excluded.step), updated_at = excluded.updated_at`)
      .bind(id, email, answers, step, now, now, country).run();
  } catch (e) { console.error("contact-sales: saving a draft failed", e); return json({ ok: false }, 503); }
  return json({ ok: true });
}

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
      if (!schemaReady) {
        await env.LEADS.prepare(SCHEMA).run();
        // Tables created before current_other existed get the column; "duplicate column" means it is already there.
        await env.LEADS.prepare(ADD_OTHER).run().catch(() => {});
        schemaReady = true;
      }
      await env.LEADS.prepare(`INSERT INTO sales_leads (id, created_at, score, name, email, company, role, phone, phone_country, revenue, current_vendor, current_other, needs, timeline, platforms, website, message, country, referrer, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id, new Date().toISOString(), s, lead.name, lead.email, lead.company, lead.role, lead.phone, lead.phoneCountry, lead.revenue, lead.current, lead.currentOther || null,
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
  const draftId = typeof data.draftId === "string" && /^[a-f0-9-]{36}$/.test(data.draftId) ? data.draftId : null;
  if (draftId && env.LEADS) await env.LEADS.prepare("UPDATE sales_lead_drafts SET completed = 1 WHERE id = ?").bind(draftId).run().catch(() => {});
  console.log(JSON.stringify({ event: "contact_sales", id, score: s, stored, emailed }));
  if (!stored && !emailed) return json({ ok: false, error: "We could not save your request. Email hello@revenuedot.app instead." }, 503);
  return done(s === "self_serve" ? "self_serve" : "sales");
}

export function leadEmail(l: Lead, s: Score, meta: { country: string | null; referrer: string; userAgent: string }) {
  const rows: [string, string][] = [
    ["Name", l.name], ["Email", l.email], ["Phone", `${parsePhoneNumberFromString(l.phone)?.formatInternational() ?? l.phone} (dial ${l.phone})`], ["Company", l.company], ["Role", l.role ? label(ROLES, l.role) : "Not given"],
    ["Monthly in-app revenue", label(REVENUE, l.revenue)], ["Uses today", vendorLabel(l)],
    ["Needs", l.needs.map((n) => label(NEEDS, n)).join(", ") || "None chosen"], ["Timeline", label(TIMELINE, l.timeline)],
    ["Platforms", l.platforms.map((p) => label(PLATFORMS, p)).join(", ") || "Not given"], ["Website", l.website || "Not given"],
    ["Visitor country", meta.country ?? "Unknown"], ["Came from", meta.referrer || "Direct"],
  ];
  const revenue = l.revenue === "undisclosed" ? "revenue not shared" : label(REVENUE, l.revenue).replace(" a month", "/mo");
  const subject = `[${SCORE_LABEL[s]}] Sales lead: ${l.company} (${l.name}), ${revenue}, uses ${vendorLabel(l)}`.replace(/[\r\n]+/g, " ").slice(0, 200);
  const text = `${SCORE_LABEL[s]} lead from revenuedot.app/contact-sales\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nMessage:\n${l.message || "(none)"}\n\nReply to this email to answer ${l.name} directly.`;
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A"><p style="font-weight:700">${esc(SCORE_LABEL[s])} lead from revenuedot.app/contact-sales</p><table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#525252;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${k === "Phone" ? `<a href="tel:${esc(l.phone)}">${esc(v)}</a>` : k === "Email" ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v)}</td></tr>`).join("")}</table><p style="color:#525252;margin-top:16px">Message</p><p style="white-space:pre-wrap">${esc(l.message || "(none)")}</p><p style="color:#737373">Reply to this email to answer ${esc(l.name)} directly.</p></div>`;
  return { subject, text, html };
}

export interface DraftRow { id: string; email: string; answers: string; step: number; updated_at: string; country: string | null }

/** Partial leads: people who gave an email but did not send the form, idle for at least 30 minutes, not reported before. */
export async function sendDigest(env: Env, now = new Date()): Promise<number> {
  if (!env.LEADS || !env.EMAIL || !env.SALES_TO) return 0;
  await env.LEADS.prepare(SCHEMA).run();
  await env.LEADS.prepare(DRAFTS).run();
  await env.LEADS.prepare("ALTER TABLE sales_lead_drafts ADD COLUMN digested INTEGER NOT NULL DEFAULT 0").run().catch(() => {});
  const cutoff = new Date(now.getTime() - 30 * 60_000).toISOString();
  const { results } = await env.LEADS.prepare(`SELECT d.id, d.email, d.answers, d.step, d.updated_at, d.country FROM sales_lead_drafts d
    WHERE d.completed = 0 AND d.digested = 0 AND d.updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM sales_leads l WHERE l.email = d.email)
    ORDER BY d.step DESC, d.updated_at DESC LIMIT 200`).bind(cutoff).all<DraftRow>();
  if (results.length) {
    await env.EMAIL.send({ to: env.SALES_TO, from: FROM, ...digestEmail(results) });
  }
  // Drafts that finished as leads, or were just reported, are not reported again.
  await env.LEADS.prepare(`UPDATE sales_lead_drafts SET digested = 1 WHERE digested = 0 AND updated_at < ?
    AND (completed = 1 OR EXISTS (SELECT 1 FROM sales_leads l WHERE l.email = sales_lead_drafts.email) OR id IN (SELECT value FROM json_each(?)))`)
    .bind(cutoff, JSON.stringify(results.map((r) => r.id))).run();
  console.log(JSON.stringify({ event: "contact_sales_digest", partial: results.length }));
  return results.length;
}

const STEP_NAMES = ["", "work email", "revenue", "current tool", "timeline", "contact details"];

export function digestEmail(rows: DraftRow[]) {
  const line = (r: DraftRow) => {
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(r.answers) as Record<string, unknown>; } catch { /* keep empty */ }
    const parts = [
      typeof a.revenue === "string" && a.revenue ? (a.revenue === "undisclosed" ? "revenue not shared" : label(REVENUE, a.revenue)) : "",
      typeof a.current === "string" && a.current ? `uses ${vendorLabel({ current: a.current, currentOther: typeof a.currentOther === "string" ? a.currentOther : "" })}` : "",
      typeof a.timeline === "string" && a.timeline ? label(TIMELINE, a.timeline) : "",
      typeof a.name === "string" && a.name ? String(a.name) : "",
      typeof a.company === "string" && a.company ? String(a.company) : "",
      typeof a.phone === "string" && a.phone ? String(a.phone) : "",
    ].filter(Boolean);
    return { email: r.email, reached: `stopped at ${STEP_NAMES[Math.min(r.step + 1, 5)] ?? `step ${r.step + 1}`}`, parts, when: r.updated_at.slice(0, 16).replace("T", " ") + " UTC", country: r.country ?? "" };
  };
  const items = rows.map(line);
  const n = rows.length;
  const subject = `[Partial] ${n} ${n === 1 ? "person" : "people"} started the contact-sales form but did not send it`;
  const text = `${subject}\n\n${items.map((i) => `${i.email} (${i.reached}${i.country ? `, ${i.country}` : ""}, ${i.when})${i.parts.length ? `\n  ${i.parts.join(" · ")}` : ""}`).join("\n\n")}\n\nThey gave a work email, so you can follow up. Each person is listed once.`;
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A"><p style="font-weight:700">${esc(subject)}</p><table style="border-collapse:collapse">${items.map((i) => `<tr><td style="padding:8px 16px 8px 0;vertical-align:top"><a href="mailto:${esc(i.email)}">${esc(i.email)}</a><br><span style="color:#737373">${esc(i.reached)}${i.country ? ` · ${esc(i.country)}` : ""} · ${esc(i.when)}</span></td><td style="padding:8px 0;vertical-align:top;color:#525252">${esc(i.parts.join(" · ") || "No answers yet")}</td></tr>`).join("")}</table><p style="color:#737373">They gave a work email, so you can follow up. Each person is listed once.</p></div>`;
  return { subject, text, html };
}
