// The ElevenLabs sales voice agent ("Alex"): its webhooks and tools, served under /api/agent/* (routes in worker/index.ts).
//   POST /api/agent/init       conversation-initiation webhook for inbound calls: who is calling, from sales_leads
//   POST /api/agent/lookup     a lead and their meeting requests, by email or phone
//   POST /api/agent/meeting    store a meeting request (sales_meetings), email sales and a confirmation to the lead
//   POST /api/agent/send_info  email the lead curated links (demo video, quickstart, pricing …), notify sales
//   GET  /api/agent/docs?q=    search the live docs (llms-full.txt) so the agent answers from what the site says today
//   POST /api/agent/postcall   post-call webhook: store the call (agent_calls) and email sales the summary and transcript
// Every route but postcall needs `x-agent-token: <AGENT_TOKEN>`; postcall is signed with ELEVENLABS_WEBHOOK_SECRET.
// Outbound calls to new hot and warm leads start from the contact-sales form (startOutboundCall, below).
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { PLANS } from "../src/lib/pricing";
import { isEmail, label, vendorLabel, NEEDS, PLATFORMS, REVENUE, SCORE_LABEL, TIMELINE, type Lead, type Score } from "./lead";

export interface D1Stmt { run(): Promise<unknown>; all<T = Record<string, unknown>>(): Promise<{ results: T[] }> }
export interface D1 { prepare(sql: string): D1Stmt & { bind(...v: unknown[]): D1Stmt } }
export interface SendEmail { send(m: { to: string; from: { email: string; name?: string }; subject: string; text: string; html: string; replyTo?: string }): Promise<unknown> }
export interface Ctx { waitUntil(p: Promise<unknown>): void }
export interface AgentEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
  LEADS?: D1;
  EMAIL?: SendEmail;
  SALES_TO?: string;
  // Secrets, set on the Worker with `cf` (not in cloudflare.config.ts, so a deploy never needs them).
  AGENT_TOKEN?: string;
  ELEVENLABS_WEBHOOK_SECRET?: string;
  ELEVENLABS_API_KEY?: string;
  // Text bindings in cloudflare.config.ts.
  ELEVENLABS_AGENT_ID?: string;
  ELEVENLABS_PHONE_ID?: string;
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Work that must not hold up the response. Without a context (tests) it is awaited instead. */
export const later = async (ctx: Ctx | undefined, p: Promise<unknown>) => { if (ctx) ctx.waitUntil(p); else await p; };

const KAI = { email: "no-reply@mail.revenuedot.app", name: "Kai at RevenueDot" };
const AGENT_FROM = { email: "no-reply@mail.revenuedot.app", name: "RevenueDot voice agent" };
const SALES_REPLY = "sales@revenuedot.app";
const MEETINGS = `CREATE TABLE IF NOT EXISTS sales_meetings (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, company TEXT, phone TEXT,
  preferred_times TEXT NOT NULL, timezone TEXT NOT NULL, topic TEXT, notes TEXT, conversation_id TEXT)`;
const CALLS = `CREATE TABLE IF NOT EXISTS agent_calls (
  conversation_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, direction TEXT, caller_phone TEXT, agent_number TEXT,
  duration_secs INTEGER, status TEXT, summary TEXT, data_collection TEXT, evaluation TEXT, transcript TEXT, lead_email TEXT)`;

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 200);

// ---------------------------------------------------------------------------------------------------------------------
// Time zones. libphonenumber gives the country; Intl gives its time zones. Countries spanning several zones use the
// zones most people live in, and calls must fall inside 8am to 8pm in every one of them.
const MAIN_ZONES: Record<string, string[]> = {
  US: ["America/New_York", "America/Los_Angeles"], CA: ["America/Toronto", "America/Vancouver"], AU: ["Australia/Sydney", "Australia/Perth"],
  BR: ["America/Sao_Paulo"], MX: ["America/Mexico_City"], RU: ["Europe/Moscow"], ID: ["Asia/Jakarta"], AR: ["America/Argentina/Buenos_Aires"],
  ES: ["Europe/Madrid"], PT: ["Europe/Lisbon"], CL: ["America/Santiago"], KZ: ["Asia/Almaty"], NZ: ["Pacific/Auckland"], UA: ["Europe/Kyiv"],
  EC: ["America/Guayaquil"], MY: ["Asia/Kuala_Lumpur"], CD: ["Africa/Kinshasa"], MN: ["Asia/Ulaanbaatar"], UZ: ["Asia/Tashkent"], CY: ["Asia/Nicosia"],
  PG: ["Pacific/Port_Moresby"], GL: ["America/Nuuk"], DE: ["Europe/Berlin"], CN: ["Asia/Shanghai"], IN: ["Asia/Kolkata"],
};

/** The time zones to use for a phone number, from its country. Empty when the country or its zones are unknown. */
export function zonesFor(phone: string): string[] {
  const cc = parsePhoneNumberFromString(phone)?.country;
  if (!cc) return [];
  if (MAIN_ZONES[cc]) return MAIN_ZONES[cc]!;
  try {
    const loc = new Intl.Locale(`und-${cc}`) as Intl.Locale & { getTimeZones?(): string[]; timeZones?: string[] };
    const zones = loc.getTimeZones?.() ?? loc.timeZones ?? [];
    return zones.length ? [zones[0]!] : [];
  } catch { return []; }
}

/** "Friday 3:40 PM" in a time zone. */
export const localTime = (zone: string, now = new Date()) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", hour: "numeric", minute: "2-digit" }).format(now);
const localHour = (zone: string, now: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(now));

// ---------------------------------------------------------------------------------------------------------------------
// Dynamic variables: what the agent knows when the call starts. Every value is a plain string.
interface LeadRow {
  id: string; created_at: string; name: string; email: string; company: string; phone: string; revenue: string;
  current_vendor: string; current_other: string | null; needs: string; timeline: string; platforms: string; message: string | null;
}
const LEAD_COLUMNS = "id, created_at, name, email, company, phone, revenue, current_vendor, current_other, needs, timeline, platforms, message";

type Known = { name: string; company: string; email: string; revenue: string; current: string; currentOther?: string | null; timeline: string };

export function greeting(direction: "inbound" | "outbound", name: string | null) {
  if (direction === "outbound") return `Hi ${name ?? "there"}, it's Alex from RevenueDot. You'd asked us to give you a call about RevenueDot. Is now an okay time?`;
  return name ? `Hey ${name}, it's Alex at RevenueDot. Good to hear from you. What's up?` : "Hey, thanks for calling RevenueDot, this is Alex. Who am I chatting with?";
}

export function dynamicVariables(lead: Known | null, phone: string, direction: "inbound" | "outbound", now = new Date()): Record<string, string> {
  const zone = zonesFor(phone)[0] ?? "UTC";
  const first = lead ? firstName(lead.name) || null : null;
  return {
    name: first ?? "there",
    company: lead?.company || "unknown",
    revenue: lead ? (lead.revenue === "undisclosed" ? "not shared" : label(REVENUE, lead.revenue)) : "unknown",
    current_tool: lead ? vendorLabel({ current: lead.current, currentOther: lead.currentOther ?? "" }) : "unknown",
    timeline: lead ? label(TIMELINE, lead.timeline) : "unknown",
    email: lead?.email || "unknown",
    lead_known: lead ? "yes" : "no",
    caller_phone: phone,
    local_time: localTime(zone, now),
    greeting: greeting(direction, first),
  };
}

const rowToKnown = (r: LeadRow): Known => ({ name: r.name, company: r.company, email: r.email, revenue: r.revenue, current: r.current_vendor, currentOther: r.current_other, timeline: r.timeline });

const normalisePhone = (raw: string) => {
  const v = raw.trim();
  if (!v || v.length > 40) return null;
  const p = parsePhoneNumberFromString(v, v.startsWith("+") ? undefined : "US");
  return p?.isValid() ? p.number : null;
};

// ---------------------------------------------------------------------------------------------------------------------
/** Constant-time comparison of two secrets (their SHA-256 digests, so lengths do not leak either). */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i]! ^ v[i]!;
  return diff === 0;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** ElevenLabs webhook signature: `t=<unix seconds>,v0=<hex HMAC-SHA256 of "<t>.<raw body>">`, at most 30 minutes old. */
export async function verifySignature(raw: string, header: string | null, secret: string, now = Date.now()): Promise<"ok" | "missing" | "stale" | "mismatch"> {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!parts.t || !Number.isFinite(t) || !parts.v0) return "missing";
  if (Math.abs(now / 1000 - t) > 30 * 60) return "stale";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${raw}`)));
  return (await sameSecret(expected, parts.v0.toLowerCase())) ? "ok" : "mismatch";
}

// ---------------------------------------------------------------------------------------------------------------------
export async function agent(request: Request, env: AgentEnv, ctx?: Ctx): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path === "/api/agent/postcall") {
    if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
    return postcall(request, env, ctx);
  }
  if (!env.AGENT_TOKEN) return json({ ok: false, error: "The voice agent is not set up on this server." }, 503);
  if (!(await sameSecret(request.headers.get("x-agent-token") ?? "", env.AGENT_TOKEN))) return json({ ok: false, error: "Send the agent token in x-agent-token." }, 401);

  const routes: Record<string, [string, (r: Request, e: AgentEnv, c?: Ctx) => Promise<Response>]> = {
    "/api/agent/init": ["POST", init], "/api/agent/lookup": ["POST", lookup], "/api/agent/meeting": ["POST", meeting],
    "/api/agent/send_info": ["POST", sendInfo], "/api/agent/docs": ["GET", docs],
  };
  const route = routes[path];
  if (!route) return json({ ok: false, error: "Not found." }, 404);
  if (request.method !== route[0]) return json({ ok: false, error: `Use ${route[0]}.` }, 405);
  return route[1](request, env, ctx);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try { const b = await request.json(); return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {}; } catch { return {}; }
}

/** Resolves to null after `ms`, so a slow database never delays the call. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

async function findLead(env: AgentEnv, email: string | null, phone: string | null): Promise<LeadRow | null> {
  if (!env.LEADS || (!email && !phone)) return null;
  const { results } = await env.LEADS.prepare(`SELECT ${LEAD_COLUMNS} FROM sales_leads WHERE email = ? OR phone = ? ORDER BY created_at DESC LIMIT 1`).bind(email, phone).all<LeadRow>();
  return results[0] ?? null;
}

/** Inbound call starting: ElevenLabs waits on this, so it always answers fast, with "unknown" values if it must. */
async function init(request: Request, env: AgentEnv): Promise<Response> {
  const b = await body(request);
  const caller = str(b.caller_id, 40);
  const phone = normalisePhone(caller);
  let lead: LeadRow | null = null;
  try { lead = await within(findLead(env, null, phone), 2500); } catch (e) { console.error("agent: init lookup failed", e); }
  console.log(JSON.stringify({ event: "agent_init", known: !!lead, call_sid: str(b.call_sid, 80) || null }));
  return json({ type: "conversation_initiation_client_data", dynamic_variables: dynamicVariables(lead ? rowToKnown(lead) : null, phone ?? caller, "inbound") });
}

const parseList = (s: string, opts: Parameters<typeof label>[0]) => { try { return (JSON.parse(s) as string[]).map((k) => label(opts, k)); } catch { return []; } };

async function lookup(request: Request, env: AgentEnv): Promise<Response> {
  const b = await body(request);
  const email = str(b.email, 254).toLowerCase() || null;
  const phone = normalisePhone(str(b.phone, 40));
  if (!email && !phone) return json({ ok: false, error: "Send an email or a phone number." }, 400);
  let lead: LeadRow | null = null;
  let meetings: Record<string, unknown>[] = [];
  try { lead = await findLead(env, email, phone); } catch (e) { console.error("agent: lookup failed", e); }
  if (env.LEADS) {
    try {
      meetings = (await env.LEADS.prepare(`SELECT created_at, name, email, company, phone, preferred_times, timezone, topic, notes FROM sales_meetings
        WHERE email = ? OR phone = ? OR email = ? ORDER BY created_at DESC LIMIT 5`).bind(email, phone, lead?.email ?? null).all()).results;
    } catch { /* no meetings table yet */ }
  }
  return json({
    found: !!lead,
    lead: lead ? {
      name: lead.name, company: lead.company, email: lead.email, phone: lead.phone,
      revenue: lead.revenue === "undisclosed" ? "not shared" : label(REVENUE, lead.revenue),
      current_tool: vendorLabel({ current: lead.current_vendor, currentOther: lead.current_other ?? "" }), timeline: label(TIMELINE, lead.timeline),
      needs: parseList(lead.needs, NEEDS), platforms: parseList(lead.platforms, PLATFORMS), message: lead.message ?? "", created_at: lead.created_at,
    } : null,
    meetings,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
let meetingsReady = false;

async function meeting(request: Request, env: AgentEnv): Promise<Response> {
  const b = await body(request);
  const m = {
    name: str(b.name, 120), email: str(b.email, 254).toLowerCase(), company: str(b.company, 160), phone: normalisePhone(str(b.phone, 40)) ?? str(b.phone, 40),
    preferred_times: str(b.preferred_times, 500), timezone: str(b.timezone, 80), topic: str(b.topic, 300), notes: str(b.notes, 2000), conversation_id: str(b.conversation_id, 100),
  };
  const errors: Record<string, string> = {};
  if (!m.name) errors.name = "Ask for their name.";
  if (!isEmail(m.email)) errors.email = "Ask for a valid email address and spell it back.";
  if (!m.preferred_times) errors.preferred_times = "Ask which days and times work for them.";
  if (!m.timezone) errors.timezone = "Ask which time zone they are in.";
  if (Object.keys(errors).length) return json({ ok: false, errors, message: Object.values(errors).join(" ") }, 400);

  const id = crypto.randomUUID();
  let stored = false;
  if (env.LEADS) {
    try {
      if (!meetingsReady) { await env.LEADS.prepare(MEETINGS).run(); meetingsReady = true; }
      await env.LEADS.prepare(`INSERT INTO sales_meetings (id, created_at, name, email, company, phone, preferred_times, timezone, topic, notes, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, new Date().toISOString(), m.name, m.email, m.company || null, m.phone || null, m.preferred_times, m.timezone, m.topic || null, m.notes || null, m.conversation_id || null).run();
      stored = true;
    } catch (e) { console.error("agent: storing a meeting failed", e); }
  }
  let emailed = false;
  if (env.EMAIL && env.SALES_TO) {
    try {
      await env.EMAIL.send({ to: env.SALES_TO, from: AGENT_FROM, replyTo: m.email, ...meetingSalesEmail(m) });
      emailed = true;
      await env.EMAIL.send({ to: m.email, from: KAI, replyTo: SALES_REPLY, ...meetingConfirmEmail(m) });
    } catch (e) { console.error("agent: meeting email failed", e); }
  }
  console.log(JSON.stringify({ event: "agent_meeting", id, stored, emailed }));
  if (!stored && !emailed) return json({ ok: false, message: "I couldn't save that just now. Please email sales@revenuedot.app and Kai will set it up." }, 503);
  return json({ ok: true, message: `All set. Kai will send a calendar invite to ${m.email} for ${m.preferred_times}, and a confirmation email is on its way now.` });
}

type Meeting = { name: string; email: string; company: string; phone: string; preferred_times: string; timezone: string; topic: string; notes: string; conversation_id: string };

export function meetingSalesEmail(m: Meeting) {
  const rows: [string, string][] = [["Name", m.name], ["Email", m.email], ["Company", m.company || "Not given"], ["Phone", m.phone || "Not given"],
    ["Preferred times", m.preferred_times], ["Time zone", m.timezone], ["Topic", m.topic || "Not given"], ["Notes", m.notes || "None"]];
  const subject = oneLine(`Meeting request: ${m.name}${m.company ? `, ${m.company}` : ""}`);
  const hint = `Add to calendar: pick one of their times (${m.timezone}), create the invite and send it to ${m.email}. They were told Kai will send it shortly.`;
  const link = m.conversation_id ? `\n\nCall recording and transcript: https://elevenlabs.io/app/agents/history/${m.conversation_id}` : "";
  const text = `The voice agent booked a meeting request.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${hint}${link}\n\nReply to this email to answer ${m.name} directly.`;
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A"><p style="font-weight:700">The voice agent booked a meeting request.</p><table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#525252;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join("")}</table><p style="margin-top:16px"><b>${esc(hint)}</b></p>${m.conversation_id ? `<p><a href="https://elevenlabs.io/app/agents/history/${esc(m.conversation_id)}">Call recording and transcript</a></p>` : ""}<p style="color:#737373">Reply to this email to answer ${esc(m.name)} directly.</p></div>`;
  return { subject, text, html };
}

export function meetingConfirmEmail(m: Meeting) {
  const first = firstName(m.name) || "there";
  const subject = "Your call with RevenueDot";
  const text = `Hi ${first},\n\nThanks for talking with us. You asked to meet ${m.preferred_times} (${m.timezone}).\n\nI'll send a calendar invite for one of those times shortly. If anything changes, just reply to this email.\n\nKai\nRevenueDot`;
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A"><p>Hi ${esc(first)},</p><p>Thanks for talking with us. You asked to meet ${esc(m.preferred_times)} (${esc(m.timezone)}).</p><p>I'll send a calendar invite for one of those times shortly. If anything changes, just reply to this email.</p><p>Kai<br>RevenueDot</p></div>`;
  return { subject, text, html };
}

// ---------------------------------------------------------------------------------------------------------------------
/** Links the agent may send. Each URL was checked to answer 200 on 2026-10-02. */
export const INFO_LINKS: Record<string, [string, string]> = {
  demo_video: ["A 2-minute demo video", "https://revenuedot.app/videos/revenuedot-chatgpt-demo.mp4"],
  quickstart: ["Quickstart: a first purchase in 5 minutes", "https://revenuedot.app/docs/getting-started/quickstart"],
  connect_app: ["Connect your app", "https://revenuedot.app/docs/getting-started/connect-your-app"],
  migration: ["Migrate from RevenueCat", "https://revenuedot.app/docs/migrate"],
  pricing: ["Pricing", "https://revenuedot.app/pricing"],
  self_host: ["Self-hosting guide", "https://revenuedot.app/docs/guides/self-hosting"],
  sdks: ["SDKs", "https://revenuedot.app/docs/sdks"],
  enterprise: ["Enterprise: talk to sales", "https://revenuedot.app/contact-sales"],
  signup: ["Start free on RevenueDot Cloud", "https://app.revenuedot.app/signup"],
};

async function sendInfo(request: Request, env: AgentEnv): Promise<Response> {
  const b = await body(request);
  const email = str(b.email, 254).toLowerCase();
  const name = str(b.name, 120);
  const note = str(b.note, 1000);
  const asked = (Array.isArray(b.topics) ? b.topics : typeof b.topics === "string" ? b.topics.split(",") : []).map((t) => str(t, 40).toLowerCase());
  const topics = [...new Set(asked.filter((t) => t in INFO_LINKS))];
  const unknown = asked.filter((t) => t && !(t in INFO_LINKS));
  if (!isEmail(email)) return json({ ok: false, error: "Enter a valid email.", message: "Ask for their email address and spell it back." }, 400);
  if (!topics.length) return json({ ok: false, error: `Choose topics from: ${Object.keys(INFO_LINKS).join(", ")}.`, message: "Ask what they would like to receive." }, 400);
  if (!env.EMAIL || !env.SALES_TO) return json({ ok: false, message: "I couldn't send that just now. You'll find everything at revenuedot.app/docs." }, 503);
  try {
    await env.EMAIL.send({ to: email, from: KAI, replyTo: SALES_REPLY, ...infoEmail(name, topics, note) });
  } catch (e) {
    console.error("agent: send_info failed", e);
    return json({ ok: false, message: "I couldn't send that just now. You'll find everything at revenuedot.app/docs." }, 503);
  }
  const list = topics.map((t) => INFO_LINKS[t]![0]).join(", ");
  await env.EMAIL.send({ to: env.SALES_TO, from: AGENT_FROM, replyTo: email, subject: oneLine(`Voice agent sent links to ${name || email}`), text: `Sent to ${name ? `${name} <${email}>` : email}: ${list}.${note ? `\n\nNote: ${note}` : ""}`, html: `<p style="font:14px/1.5 -apple-system,sans-serif">Sent to ${esc(name ? `${name} <${email}>` : email)}: ${esc(list)}.</p>${note ? `<p>Note: ${esc(note)}</p>` : ""}` }).catch((e) => console.error("agent: send_info sales copy failed", e));
  return json({ ok: true, sent: topics, ignored: unknown, message: `Done. I've emailed ${email} the links: ${list.toLowerCase()}.` });
}

export function infoEmail(name: string, topics: string[], note: string) {
  const first = firstName(name) || "there";
  const links = topics.map((t) => INFO_LINKS[t]!);
  const subject = "The RevenueDot links you asked for";
  const text = `Hi ${first},\n\nHere are the links from our call:\n\n${links.map(([l, u]) => `${l}: ${u}`).join("\n")}${note ? `\n\n${note}` : ""}\n\nAny questions, just reply to this email.\n\nKai\nRevenueDot`;
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A"><p>Hi ${esc(first)},</p><p>Here are the links from our call:</p><ul>${links.map(([l, u]) => `<li><a href="${esc(u)}">${esc(l)}</a></li>`).join("")}</ul>${note ? `<p style="white-space:pre-wrap">${esc(note)}</p>` : ""}<p>Any questions, just reply to this email.</p><p>Kai<br>RevenueDot</p></div>`;
  return { subject, text, html };
}

// ---------------------------------------------------------------------------------------------------------------------
// Docs search over llms-full.txt (every docs and blog page in one file). Pages start with "# Title", a blank line and
// "Source: <url>.md". The text is kept in the Cache API for an hour and parsed once per isolate.
const DOCS_URL = "https://revenuedot.app/llms-full.txt";
const DOCS_TTL = 3600;
export interface DocPage { title: string; url: string; body: string; lower: string; titleLower: string; blog: boolean }
let docsMemo: { at: number; pages: DocPage[] } | null = null;
export const resetDocs = () => { docsMemo = null; };

export function splitPages(text: string): DocPage[] {
  const re = /^# (.+)\n\nSource: (https?:\/\/\S+)\n/gm;
  const heads = [...text.matchAll(re)];
  const blogAt = text.indexOf("\n=== Blog ===");
  return heads.map((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : text.length;
    // Drop the separators before the next page: "---" and section headings like "=== Blog ===".
    let body = text.slice(start, end).trim();
    for (let prev = ""; prev !== body;) { prev = body; body = body.replace(/\n*(---|=== .+ ===)$/, "").trim(); }
    const title = m[1]!.trim();
    return { title, url: m[2]!.replace(/\.md$/, ""), body, lower: body.toLowerCase(), titleLower: title.toLowerCase(), blog: blogAt >= 0 && m.index! > blogAt };
  });
}

async function loadDocs(env: AgentEnv): Promise<DocPage[]> {
  if (docsMemo && Date.now() - docsMemo.at < DOCS_TTL * 1000) return docsMemo.pages;
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
  let res = cache ? await cache.match(DOCS_URL).catch(() => undefined) : undefined;
  if (!res) {
    // The site's own static file: the Worker serves it, so this is always the docs the site shows now.
    res = await env.ASSETS.fetch(new Request(DOCS_URL));
    if (!res.ok) res = await fetch(DOCS_URL);
    if (!res.ok) throw new Error(`llms-full.txt answered ${res.status}`);
    const text = await res.text();
    res = new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": `public, max-age=${DOCS_TTL}` } });
    if (cache) await cache.put(DOCS_URL, res.clone()).catch(() => {});
  }
  const pages = splitPages(await res.text());
  docsMemo = { at: Date.now(), pages };
  return pages;
}

const STOP = new Set("a an and are as at be but by can do does for from how i if in into is it its me my of on or our so that the their them then there these this to us was we what when where which who why will with you your about any have has just like get need want tell know does did should could would revenuedot".split(" "));
export const terms = (q: string) => [...new Set(q.toLowerCase().split(/[^a-z0-9$%.]+/).map((t) => t.replace(/^\.+|\.+$/g, "")).filter((t) => t.length > 1 && !STOP.has(t)))];

const count = (hay: string, needle: string, cap = 20) => { let n = 0, i = hay.indexOf(needle); while (i >= 0 && n < cap) { n++; i = hay.indexOf(needle, i + needle.length); } return n; };

/** Pages ranked by query terms: rarer terms weigh more, a term in the title counts much more than in the body. */
export function search(pages: DocPage[], q: string, limit = 3) {
  const ts = terms(q);
  if (!ts.length) return [];
  const df = new Map(ts.map((t) => [t, pages.filter((p) => p.lower.includes(t) || p.titleLower.includes(t)).length]));
  const scored = pages.map((p) => {
    // Long reference pages mention everything; their body matches count for less.
    const long = 1 / Math.max(1, 1 + Math.log10(p.body.length / 8000));
    let s = 0, matched = 0;
    for (const t of ts) {
      const idf = Math.log(1 + pages.length / (1 + df.get(t)!));
      const inTitle = p.titleLower.includes(t);
      const n = count(p.lower, t);
      if (inTitle || n) matched++;
      s += idf * ((inTitle ? 6 : 0) + Math.log2(1 + n) * long);
    }
    // Pages that match more of the question beat pages that repeat one word; docs beat blog posts.
    s *= (matched / ts.length) ** 2 * (p.blog ? 0.75 : 1);
    return { p, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
  return scored.map(({ p }) => ({ title: p.title, url: p.url, text: excerpt(p.body, ts) }));
}

/** About 1,500 characters starting at the paragraph that matches the most terms. */
export function excerpt(body: string, ts: string[], max = 1500) {
  const paras = body.split(/\n{2,}/);
  let best = 0, bestScore = -1;
  paras.forEach((para, i) => {
    const l = para.toLowerCase();
    // Prose beats link lists ("## Related"), code and the Description line.
    const links = (para.match(/\]\(http/g) ?? []).length;
    const s = ts.reduce((n, t) => n + (l.includes(t) ? 2 : 0) + Math.min(count(l, t), 3) * 0.1, 0) - (/^(Description:|```|## Related)/.test(para) ? 1 : 0) - (links > 2 ? 1.5 : 0);
    if (s > bestScore) { bestScore = s; best = i; }
  });
  // Keep the heading above the best paragraph for context.
  const start = best > 0 && /^#{2,4} /.test(paras[best - 1]!) ? best - 1 : best;
  let out = "";
  for (let i = start; i < paras.length && out.length < max; i++) out += (out ? "\n\n" : "") + paras[i];
  return out.length > max ? `${out.slice(0, max).replace(/\s+\S*$/, "")} …` : out;
}

const PRICING_WORDS = /\b(price|prices|pricing|cost|costs|pay|paid|plan|plans|free|fee|fees|charge|bill|billing|enterprise|standard|cheap|expensive|\$)/i;
/** Plans and prices exactly as the pricing page states them (src/lib/pricing.ts). */
export const FACTS = PLANS.map((p) => `${p.name}: ${p.price}, ${p.priceNote}. ${p.summary}${p.available ? "" : " Coming soon: not available to buy yet, this is the price it launches at."}`).join("\n");

async function docs(request: Request, env: AgentEnv): Promise<Response> {
  const q = str(new URL(request.url).searchParams.get("q"), 300);
  if (!q) return json({ ok: false, error: "Add a question as ?q=" }, 400);
  let results: ReturnType<typeof search> = [];
  try { results = search(await loadDocs(env), q); } catch (e) { console.error("agent: docs search failed", e); }
  return json({ query: q, results, ...(PRICING_WORDS.test(q) ? { facts: FACTS } : {}) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Post-call webhook.
interface Turn { role?: string; message?: string | null; time_in_call_secs?: number }
interface PostCall {
  type?: string;
  data?: {
    conversation_id?: string; agent_id?: string; status?: string; transcript?: Turn[];
    metadata?: { start_time_unix_secs?: number; call_duration_secs?: number; phone_call?: { direction?: string; agent_number?: string; external_number?: string } };
    analysis?: { transcript_summary?: string; call_successful?: string; data_collection_results?: Record<string, { value?: unknown }>; evaluation_criteria_results?: Record<string, { result?: string; rationale?: string }> };
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
  };
}

async function postcall(request: Request, env: AgentEnv, ctx?: Ctx): Promise<Response> {
  if (!env.ELEVENLABS_WEBHOOK_SECRET) return json({ ok: false, error: "The webhook secret is not set up on this server." }, 503);
  const raw = await request.text();
  const check = await verifySignature(raw, request.headers.get("elevenlabs-signature"), env.ELEVENLABS_WEBHOOK_SECRET);
  if (check !== "ok") { console.warn(JSON.stringify({ event: "agent_postcall_rejected", reason: check })); return json({ ok: false, error: `Bad signature (${check}).` }, 401); }
  let p: PostCall;
  try { p = JSON.parse(raw) as PostCall; } catch { return json({ ok: false, error: "Send JSON." }, 400); }
  if (p.type !== "post_call_transcription" || !p.data?.conversation_id) return json({ ok: true, ignored: p.type ?? "unknown" });
  await later(ctx, recordCall(env, p).catch((e) => console.error("agent: recording a call failed", e)));
  return json({ ok: true });
}

export function callFacts(p: PostCall) {
  const d = p.data!;
  const vars = d.conversation_initiation_client_data?.dynamic_variables ?? {};
  const collected = Object.fromEntries(Object.entries(d.analysis?.data_collection_results ?? {}).map(([k, v]) => [k, v?.value]).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  const evaluation = Object.fromEntries(Object.entries(d.analysis?.evaluation_criteria_results ?? {}).map(([k, v]) => [k, v?.result ?? "unknown"]));
  const known = (k: string) => { const v = vars[k]; return typeof v === "string" && v && v !== "unknown" && v !== "there" ? v : ""; };
  const pick = (k: string) => (typeof collected[k] === "string" ? (collected[k] as string) : "") || known(k);
  const email = (pick("email") || "").toLowerCase();
  return {
    id: d.conversation_id!, direction: d.metadata?.phone_call?.direction ?? "web", phone: d.metadata?.phone_call?.external_number ?? (known("caller_phone") || ""),
    agentNumber: d.metadata?.phone_call?.agent_number ?? "", duration: Math.round(d.metadata?.call_duration_secs ?? 0), status: d.status ?? "",
    summary: d.analysis?.transcript_summary ?? "", successful: d.analysis?.call_successful ?? "", collected, evaluation,
    name: pick("name"), company: pick("company"), email: isEmail(email) ? email : "",
    started: d.metadata?.start_time_unix_secs ? new Date(d.metadata.start_time_unix_secs * 1000).toISOString() : new Date().toISOString(),
    transcript: (d.transcript ?? []).filter((t) => t.message).map((t) => ({ role: t.role ?? "", message: String(t.message), time_in_call_secs: t.time_in_call_secs ?? 0 })),
  };
}

let callsReady = false;
async function recordCall(env: AgentEnv, p: PostCall) {
  const c = callFacts(p);
  if (env.LEADS) {
    try {
      if (!callsReady) { await env.LEADS.prepare(CALLS).run(); callsReady = true; }
      // Very long calls: drop the last turns until the transcript fits (the email and ElevenLabs keep the full one).
      const turns = [...c.transcript];
      let transcript = JSON.stringify(turns);
      while (transcript.length > 200_000 && turns.length) { turns.splice(Math.floor(turns.length * 0.9)); transcript = JSON.stringify([...turns, { role: "note", message: "(truncated)" }]); }
      await env.LEADS.prepare(`INSERT OR REPLACE INTO agent_calls (conversation_id, created_at, direction, caller_phone, agent_number, duration_secs, status, summary, data_collection, evaluation, transcript, lead_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.id, c.started, c.direction, c.phone || null, c.agentNumber || null, c.duration, c.status, c.summary || null,
        JSON.stringify(c.collected), JSON.stringify(c.evaluation), transcript, c.email || null).run();
    } catch (e) { console.error("agent: storing a call failed", e); }
  }
  if (env.EMAIL && env.SALES_TO) await env.EMAIL.send({ to: env.SALES_TO, from: AGENT_FROM, ...(c.email ? { replyTo: c.email } : {}), ...callEmail(p) });
  console.log(JSON.stringify({ event: "agent_postcall", id: c.id, direction: c.direction, duration: c.duration }));
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function callEmail(p: PostCall) {
  const c = callFacts(p);
  const who = [c.name, c.company].filter(Boolean).join(", ") || "Unknown caller";
  const link = `https://elevenlabs.io/app/agents/history/${c.id}`;
  const rows: [string, string][] = [
    ["Who", who], ["Phone", c.phone || "Not known"], ["Email", c.email || "Not given"], ["Direction", c.direction],
    ["Duration", c.duration ? `${Math.floor(c.duration / 60)}m ${c.duration % 60}s` : "0s"], ["Call successful", c.successful || "unknown"],
    ...Object.entries(c.collected).map(([k, v]): [string, string] => [k, show(v)]),
    ...Object.entries(c.evaluation).map(([k, v]): [string, string] => [`Check: ${k}`, v]),
  ];
  const lines = c.transcript.map((t) => `[${mmss(t.time_in_call_secs)}] ${t.role === "agent" ? "Alex" : t.role === "user" ? "Caller" : t.role}: ${t.message}`);
  const subject = oneLine(`[Voice call] ${who}${c.phone ? ` (${c.phone})` : ""}, ${c.direction}, ${mmss(c.duration)}`);
  const text = `${c.summary || "No summary."}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nRecording and full details: ${link}\n\nTranscript\n\n${lines.join("\n") || "(empty)"}`;
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0A0A"><p style="font-weight:700">${esc(who)}</p><p>${esc(c.summary || "No summary.")}</p><table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#525252;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${k === "Phone" && c.phone ? `<a href="tel:${esc(c.phone)}">${esc(v)}</a>` : esc(v)}</td></tr>`).join("")}</table><p><a href="${esc(link)}">Recording and full details</a></p><p style="color:#525252;margin-top:16px">Transcript</p><pre style="white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,monospace">${esc(lines.join("\n") || "(empty)")}</pre></div>`;
  return { subject, text, html };
}

// ---------------------------------------------------------------------------------------------------------------------
// Outbound "speed to lead": the agent calls a new hot or warm lead right after the form, if they agreed to a call.
export function outboundPlan(l: Lead, s: Score, env: AgentEnv, now = new Date()): { call: boolean; note: string } {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID || !env.ELEVENLABS_PHONE_ID) return { call: false, note: "Not called: the voice agent is not set up." };
  if (!l.consentCall) return { call: false, note: "Not called: they did not tick the box agreeing to a call." };
  if (s !== "hot" && s !== "warm") return { call: false, note: `Not called: ${SCORE_LABEL[s]} leads are not called automatically.` };
  const zones = zonesFor(l.phone);
  if (!zones.length) return { call: false, note: "Not called: we could not tell their time zone from the phone number. Call them during their day." };
  const off = zones.find((z) => { const h = localHour(z, now); return h < 8 || h >= 20; });
  if (off) return { call: false, note: `Not called: it was ${localTime(off, now)} in ${off}, outside 8am to 8pm their time. Call them during their day.` };
  return { call: true, note: `The voice agent is calling them now (${localTime(zones[0]!, now)} their time). The call summary arrives by email when it ends.` };
}

export async function startOutboundCall(env: AgentEnv, l: Lead, leadId: string, now = new Date()): Promise<string | null> {
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY! },
      body: JSON.stringify({
        agent_id: env.ELEVENLABS_AGENT_ID, agent_phone_number_id: env.ELEVENLABS_PHONE_ID, to_number: l.phone,
        conversation_initiation_client_data: { dynamic_variables: dynamicVariables(l, l.phone, "outbound", now) },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const out = (await r.json().catch(() => ({}))) as { success?: boolean; conversation_id?: string | null; message?: string };
    if (!r.ok || out.success === false) { console.error(JSON.stringify({ event: "agent_outbound_failed", status: r.status, message: out.message ?? null })); return null; }
    const id = out.conversation_id ?? null;
    if (id && env.LEADS) await env.LEADS.prepare("UPDATE sales_leads SET outbound_conversation_id = ? WHERE id = ?").bind(id, leadId).run().catch((e) => console.error("agent: saving the call id failed", e));
    console.log(JSON.stringify({ event: "agent_outbound", lead: leadId, conversation_id: id }));
    return id;
  } catch (e) { console.error("agent: outbound call failed", e); return null; }
}
