import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { FACTS, callEmail, dynamicVariables, outboundPlan, resetDocs, search, splitPages, verifySignature, zonesFor } from "../worker/agent";
import { validate, type Lead } from "../worker/lead";

const TOKEN = "test-agent-token";
const SECRET = "whsec_test";
const good = {
  name: "Maya Chen", email: "maya@habitly.app", company: "Habitly", role: "founder",
  phone: "(415) 555-0132", phoneCountry: "US", revenue: "100k_500k", current: "revenuecat",
  needs: ["lower_cost", "migration"], timeline: "this_quarter", platforms: ["ios"], website: "", message: "",
};
const lead = (o: Partial<Lead> = {}): Lead => ({ ...(validate(good) as { ok: true; lead: Lead }).lead, ...o });
const leadRow = {
  id: "l1", created_at: "2026-10-02T10:00:00.000Z", name: "Maya Chen", email: "maya@habitly.app", company: "Habitly", phone: "+14155550132",
  revenue: "100k_500k", current_vendor: "revenuecat", current_other: null, needs: '["lower_cost"]', timeline: "this_quarter", platforms: '["ios","android"]', message: "Two apps.",
};

/** A D1 stand-in: records every statement, answers SELECTs from `answer`. */
const makeEnv = (answer: (sql: string, v: unknown[]) => unknown[] = () => [], extra: Record<string, unknown> = {}) => {
  const sql: { q: string; v: unknown[] }[] = [];
  const sent: { to: string; from: { email: string; name?: string }; subject: string; text: string; html: string; replyTo?: string }[] = [];
  return {
    sql, sent,
    ASSETS: { fetch: async () => new Response("asset") },
    LEADS: { prepare: (q: string) => { const st = (v: unknown[]) => ({ run: async () => { sql.push({ q, v }); }, all: async () => { sql.push({ q, v }); return { results: answer(q, v) }; } }); return { ...st([]), bind: (...v: unknown[]) => st(v) }; } },
    EMAIL: { send: async (m: (typeof sent)[number]) => { sent.push(m); } },
    LEAD_LIMIT: { limit: async () => ({ success: true }) },
    SALES_TO: "sales@circo.so",
    AGENT_TOKEN: TOKEN,
    ELEVENLABS_WEBHOOK_SECRET: SECRET,
    ...extra,
  };
};
const call = (env: unknown, path: string, body?: unknown, headers: Record<string, string> = { "x-agent-token": TOKEN }) =>
  worker.fetch(new Request(`https://revenuedot.app${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env as never);

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("agent auth", () => {
  it("answers 503 when AGENT_TOKEN is not set, 401 for a missing or wrong token", async () => {
    expect((await call(makeEnv(() => [], { AGENT_TOKEN: undefined }), "/api/agent/docs?q=x")).status).toBe(503);
    expect((await call(makeEnv(), "/api/agent/docs?q=x", undefined, {})).status).toBe(401);
    expect((await call(makeEnv(), "/api/agent/lookup", { email: "a@b.co" }, { "x-agent-token": "wrong" })).status).toBe(401);
    expect((await call(makeEnv(), "/api/agent/lookup", { email: "maya@habitly.app" })).status).toBe(200);
  });
  it("checks the method and unknown paths only after the token", async () => {
    expect((await call(makeEnv(), "/api/agent/nope", undefined, {})).status).toBe(401);
    expect((await call(makeEnv(), "/api/agent/nope")).status).toBe(404);
    expect((await call(makeEnv(), "/api/agent/meeting")).status).toBe(405);
  });
});

describe("agent init", () => {
  const init = (env: unknown, caller = "+14155550132") => call(env, "/api/agent/init", { caller_id: caller, agent_id: "agent_x", called_number: "+18885550100", call_sid: "CA1" });
  it("greets a known caller by first name with their form answers", async () => {
    const env = makeEnv((q, v) => (q.includes("FROM sales_leads") && v[1] === "+14155550132" ? [leadRow] : []));
    const r = await init(env);
    const out = await r.json();
    expect(out.type).toBe("conversation_initiation_client_data");
    expect(out.dynamic_variables).toMatchObject({
      name: "Maya", company: "Habitly", revenue: "$100K to $500K a month", current_tool: "RevenueCat", timeline: "This quarter",
      email: "maya@habitly.app", lead_known: "yes", caller_phone: "+14155550132", greeting: "Hi Maya, this is Alex, customer success manager at RevenueDot. Good to hear from you. How can I help?",
    });
    expect(Object.values(out.dynamic_variables).every((v) => typeof v === "string")).toBe(true);
  });
  it("falls back to unknowns for a new caller or a database error", async () => {
    for (const env of [makeEnv(), makeEnv(() => { throw new Error("D1 down"); })]) {
      const out = await (await init(env, "+447400123456")).json();
      expect(out.dynamic_variables).toMatchObject({ name: "there", company: "unknown", revenue: "unknown", current_tool: "unknown", timeline: "unknown", email: "unknown", lead_known: "no", caller_phone: "+447400123456", greeting: "Hi, this is Alex, customer success manager at RevenueDot, the open-source RevenueCat alternative for mobile app monetization. How can I help you today?" });
    }
  });
  it("gives local time in the caller's country", () => {
    const at = new Date("2026-10-02T19:40:00Z"); // a Friday
    expect(dynamicVariables(null, "+14155550132", "inbound", at).local_time).toBe("Friday 3:40 PM");
    expect(dynamicVariables(null, "+447400123456", "inbound", at).local_time).toBe("Friday 8:40 PM");
    expect(dynamicVariables(null, "+819012345678", "inbound", at).local_time).toBe("Saturday 4:40 AM");
    expect(dynamicVariables(null, "not a phone", "inbound", at).local_time).toBe("Friday 7:40 PM");
    expect(dynamicVariables(lead(), "+14155550132", "outbound", at).greeting).toBe("Hi Maya, this is Alex, customer success manager at RevenueDot, the open-source RevenueCat alternative. You'd asked us to reach out about RevenueDot. Is now a good time?");
    expect(zonesFor("+14155550132")).toEqual(["America/New_York", "America/Los_Angeles"]);
    expect(zonesFor("+33612345678")).toEqual(["Europe/Paris"]);
  });
});

describe("agent lookup", () => {
  it("returns the lead with labels and their meeting requests", async () => {
    const meetingRow = { created_at: "2026-10-02T11:00:00Z", name: "Maya Chen", email: "maya@habitly.app", company: "Habitly", phone: null, preferred_times: "Tue 2pm", timezone: "PT", topic: null, notes: null };
    const env = makeEnv((q) => (q.includes("FROM sales_leads") ? [leadRow] : q.includes("FROM sales_meetings") ? [meetingRow] : []));
    const out = await (await call(env, "/api/agent/lookup", { phone: "415 555 0132" })).json();
    expect(out.found).toBe(true);
    expect(out.lead).toEqual({ name: "Maya Chen", company: "Habitly", email: "maya@habitly.app", phone: "+14155550132", revenue: "$100K to $500K a month", current_tool: "RevenueCat", timeline: "This quarter", needs: ["Lower cost"], platforms: ["iOS", "Android"], message: "Two apps.", created_at: "2026-10-02T10:00:00.000Z" });
    expect(out.meetings).toEqual([meetingRow]);
    expect(env.sql.find((s) => s.q.includes("FROM sales_leads"))!.v).toEqual([null, "+14155550132"]);
  });
  it("answers found:false for strangers and 400 with nothing to look up", async () => {
    expect(await (await call(makeEnv(), "/api/agent/lookup", { email: "x@y.co" })).json()).toEqual({ found: false, lead: null, meetings: [] });
    expect((await call(makeEnv(), "/api/agent/lookup", {})).status).toBe(400);
  });
});

describe("agent meeting", () => {
  const m = { name: "Maya Chen", email: "Maya@Habitly.app", company: "Habitly", phone: "+14155550132", preferred_times: "Tue 2pm or Wed morning", timezone: "America/Los_Angeles", topic: "Migration", notes: "Two apps", conversation_id: "conv_1" };
  it("stores the request, emails sales and confirms to the lead from Kai", async () => {
    const env = makeEnv();
    const r = await call(env, "/api/agent/meeting", m);
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out.ok).toBe(true);
    expect(out.message).toContain("maya@habitly.app");
    const insert = env.sql.find((s) => s.q.startsWith("INSERT INTO sales_meetings"))!;
    expect(insert.v.slice(2)).toEqual(["Maya Chen", "maya@habitly.app", "Habitly", "+14155550132", "Tue 2pm or Wed morning", "America/Los_Angeles", "Migration", "Two apps", "conv_1"]);
    const [sales, lead] = env.sent;
    expect(sales!.to).toBe("sales@circo.so");
    expect(sales!.subject).toBe("Meeting request: Maya Chen, Habitly");
    expect(sales!.replyTo).toBe("maya@habitly.app");
    expect(sales!.text).toContain("Add to calendar");
    expect(lead!.to).toBe("maya@habitly.app");
    expect(lead!.from).toEqual({ email: "no-reply@mail.revenuedot.app", name: "Kai at RevenueDot" });
    expect(lead!.replyTo).toBe("sales@revenuedot.app");
    expect(lead!.text).toContain("Tue 2pm or Wed morning (America/Los_Angeles)");
    expect(lead!.text).toContain("calendar invite");
  });
  it("says what is missing", async () => {
    const r = await call(makeEnv(), "/api/agent/meeting", { ...m, email: "maya at habitly", preferred_times: "" });
    expect(r.status).toBe(400);
    const out = await r.json();
    expect(Object.keys(out.errors).sort()).toEqual(["email", "preferred_times"]);
    expect(out.message).toMatch(/email/);
  });
});

describe("agent send_info", () => {
  it("emails the lead the chosen links and tells sales", async () => {
    const env = makeEnv();
    const out = await (await call(env, "/api/agent/send_info", { email: "maya@habitly.app", name: "Maya Chen", topics: ["quickstart", "migration", "bogus"], note: "Happy to help." })).json();
    expect(out).toMatchObject({ ok: true, sent: ["quickstart", "migration"], ignored: ["bogus"] });
    expect(env.sent[0]!.to).toBe("maya@habitly.app");
    expect(env.sent[0]!.text).toContain("https://revenuedot.app/docs/getting-started/quickstart");
    expect(env.sent[0]!.text).toContain("https://revenuedot.app/docs/migrate");
    expect(env.sent[0]!.text).toContain("Happy to help.");
    expect(env.sent[1]!.to).toBe("sales@circo.so");
  });
  it("refuses a bad email or no known topic", async () => {
    expect((await call(makeEnv(), "/api/agent/send_info", { email: "nope", topics: ["pricing"] })).status).toBe(400);
    const r = await call(makeEnv(), "/api/agent/send_info", { email: "maya@habitly.app", topics: ["everything"] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("demo_video");
  });
});

describe("agent docs search", () => {
  const fixture = `# RevenueDot documentation (full text)\n\nGenerated.\n\n\n=== Getting started ===\n\n# What is RevenueDot?\n\nSource: https://revenuedot.app/docs/getting-started.md\nDescription: Intro.\n\nRevenueDot is an open-source backend. Webhooks are mentioned once.\n\n---\n\n# How do webhooks work?\n\nSource: https://revenuedot.app/docs/guides/webhooks.md\nDescription: Webhooks.\n\nIntro paragraph.\n\n## Retries\n\nWebhooks retry with backoff for 3 days when your endpoint fails. Webhook retries keep the same id.\n\n---\n\n=== Blog ===\n\n# Webhooks retry tips\n\nSource: https://revenuedot.app/blog/webhook-tips.md\nDescription: Tips.\n\nWebhooks retry. Webhooks retry. Webhooks retry.\n`;
  it("splits pages on '# Title' + Source and drops separators", () => {
    const pages = splitPages(fixture);
    expect(pages.map((p) => [p.title, p.url, p.blog])).toEqual([
      ["What is RevenueDot?", "https://revenuedot.app/docs/getting-started", false],
      ["How do webhooks work?", "https://revenuedot.app/docs/guides/webhooks", false],
      ["Webhooks retry tips", "https://revenuedot.app/blog/webhook-tips", true],
    ]);
    expect(pages[1]!.body.endsWith("same id.")).toBe(true);
  });
  it("ranks title matches first and excerpts the best paragraph", () => {
    const r = search(splitPages(fixture), "How do webhook retries work?");
    expect(r[0]!.title).toBe("How do webhooks work?");
    expect(r[0]!.text.startsWith("## Retries\n\nWebhooks retry with backoff")).toBe(true);
    expect(r.at(-1)!.title).toBe("What is RevenueDot?");
    expect(search(splitPages(fixture), "the and of")).toEqual([]);
  });
  it("serves results from the site's llms-full.txt and adds pricing facts for price questions", async () => {
    resetDocs();
    const env = makeEnv(() => [], { ASSETS: { fetch: async (req: Request) => new Response(new URL(req.url).pathname === "/llms-full.txt" ? fixture : "", { status: 200 }) } });
    const out = await (await call(env, "/api/agent/docs?q=webhook%20retries")).json();
    expect(out.results[0].url).toBe("https://revenuedot.app/docs/guides/webhooks");
    expect(out.facts).toBeUndefined();
    const priced = await (await call(env, "/api/agent/docs?q=how%20much%20does%20enterprise%20cost")).json();
    expect(priced.facts).toBe(FACTS);
    expect(FACTS).toContain("Cloud Free: $0, up to $10K monthly tracked revenue.");
    expect(FACTS).toContain("of tracked revenue above $10K, capped at $999 a month");
    expect(FACTS).toContain("Enterprise: $50K, a year to start, custom pricing.");
    expect((await call(env, "/api/agent/docs")).status).toBe(400);
  });
});

describe("agent postcall", () => {
  const payload = {
    type: "post_call_transcription", event_timestamp: 1790000000,
    data: {
      agent_id: "agent_x", conversation_id: "conv_42", status: "done",
      transcript: [{ role: "agent", message: "Hi Maya, it's Alex.", time_in_call_secs: 0 }, { role: "user", message: "Hi! Tuesday works.", time_in_call_secs: 4 }, { role: "agent", message: null, time_in_call_secs: 6 }],
      metadata: { start_time_unix_secs: 1790000000, call_duration_secs: 192, phone_call: { direction: "outbound", agent_number: "+18885550100", external_number: "+14155550132" } },
      analysis: { transcript_summary: "Maya wants a migration call.", call_successful: "success", data_collection_results: { email: { value: "maya@habitly.app" }, company: { value: "Habitly" } }, evaluation_criteria_results: { booked: { result: "success" } } },
      conversation_initiation_client_data: { dynamic_variables: { name: "Maya", lead_known: "yes" } },
    },
  };
  const sign = async (raw: string, t: number, secret = SECRET) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `t=${t},v0=${sig}`;
  };
  const post = (env: unknown, raw: string, sig?: string) => worker.fetch(new Request("https://revenuedot.app/api/agent/postcall", { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "elevenlabs-signature": sig } : {}) }, body: raw }), env as never);
  const now = () => Math.floor(Date.now() / 1000);

  it("stores a signed call and emails sales the summary and transcript", async () => {
    const env = makeEnv();
    const raw = JSON.stringify(payload);
    const r = await post(env, raw, await sign(raw, now()));
    expect(r.status).toBe(200);
    const insert = env.sql.find((s) => s.q.startsWith("INSERT OR REPLACE INTO agent_calls"))!;
    expect(insert.v.slice(0, 8)).toEqual(["conv_42", new Date(1790000000 * 1000).toISOString(), "outbound", "+14155550132", "+18885550100", 192, "done", "Maya wants a migration call."]);
    expect(insert.v[11]).toBe("maya@habitly.app");
    expect(JSON.parse(insert.v[10] as string)).toHaveLength(2);
    const mail = env.sent[0]!;
    expect(mail.subject).toBe("[Voice call] Maya, Habitly (+14155550132), outbound, 3:12");
    expect(mail.replyTo).toBe("maya@habitly.app");
    expect(mail.text).toContain("[0:04] Caller: Hi! Tuesday works.");
    expect(mail.text).toContain("https://elevenlabs.io/app/agents/history/conv_42");
  });
  it("rejects a wrong or stale signature, and 503s without the secret", async () => {
    const raw = JSON.stringify(payload);
    expect((await post(makeEnv(), raw, await sign(raw, now(), "other"))).status).toBe(401);
    expect((await post(makeEnv(), raw, await sign(raw, now() - 31 * 60))).status).toBe(401);
    expect((await post(makeEnv(), raw)).status).toBe(401);
    expect((await post(makeEnv(), `${raw} `, await sign(raw, now()))).status).toBe(401);
    expect((await post(makeEnv(() => [], { ELEVENLABS_WEBHOOK_SECRET: undefined }), raw, await sign(raw, now()))).status).toBe(503);
    expect(await verifySignature(raw, await sign(raw, 1000), SECRET, 1000 * 1000)).toBe("ok");
    expect(await verifySignature(raw, await sign(raw, 1000), SECRET, (1000 + 1801) * 1000)).toBe("stale");
  });
  it("acknowledges other event types without storing them", async () => {
    const env = makeEnv();
    const raw = JSON.stringify({ type: "post_call_audio", data: { conversation_id: "c" } });
    expect(await (await post(env, raw, await sign(raw, now()))).json()).toEqual({ ok: true, ignored: "post_call_audio" });
    expect(env.sql).toHaveLength(0);
    expect(callEmail(payload as never).html).not.toContain("<script>");
  });
});

describe("outbound speed to lead", () => {
  const keys = { ELEVENLABS_API_KEY: "xi", ELEVENLABS_AGENT_ID: "agent_x", ELEVENLABS_PHONE_ID: "phnum_x" };
  const noon = new Date("2026-10-02T19:00:00Z"); // noon in California, 3pm in New York
  it("calls only hot or warm leads, when set up, inside 8am to 8pm their time", () => {
    const yes = lead();
    expect(outboundPlan(yes, "hot", keys as never, noon).call).toBe(true);
    expect(outboundPlan(yes, "warm", keys as never, noon).call).toBe(true);
    expect(outboundPlan(yes, "hot", { ...keys, ELEVENLABS_API_KEY: undefined } as never, noon)).toEqual({ call: false, note: "Not called: the voice agent is not set up." });
    expect(outboundPlan(yes, "nurture", keys as never, noon).note).toMatch(/Nurture leads/);
    expect(outboundPlan(yes, "self_serve", keys as never, noon).call).toBe(false);
    // 7am in California is outside the window even though it is 10am in New York.
    const early = outboundPlan(yes, "hot", keys as never, new Date("2026-10-02T14:00:00Z"));
    expect(early.call).toBe(false);
    expect(early.note).toContain("America/Los_Angeles");
    // 9pm in London.
    expect(outboundPlan(lead({ phone: "+447400123456" }), "hot", keys as never, noon).call).toBe(false);
  });
  it("starts the call from the contact-sales form and records the conversation id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(noon);
    const fetches: { url: string; body: Record<string, unknown>; key: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fetches.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("xi-api-key") });
      return new Response(JSON.stringify({ success: true, message: "ok", conversation_id: "conv_out", callSid: "CA9" }));
    });
    const env = makeEnv(() => [], keys);
    const form = (b: unknown) => worker.fetch(new Request("https://revenuedot.app/api/contact-sales", { method: "POST", headers: { "content-type": "application/json", origin: "https://revenuedot.app" }, body: JSON.stringify(b) }), env as never);
    expect((await form(good)).status).toBe(200);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
    expect(fetches[0]!.key).toBe("xi");
    expect(fetches[0]!.body).toMatchObject({ agent_id: "agent_x", agent_phone_number_id: "phnum_x", to_number: "+14155550132" });
    expect((fetches[0]!.body.conversation_initiation_client_data as { dynamic_variables: Record<string, string> }).dynamic_variables).toMatchObject({ name: "Maya", lead_known: "yes", email: "maya@habitly.app", local_time: "Friday 3:00 PM" });
    expect(env.sql.find((s) => s.q.startsWith("UPDATE sales_leads SET outbound_conversation_id"))!.v[0]).toBe("conv_out");
    expect(env.sent[0]!.text).toContain("Voice agent: The voice agent is calling them now");
    // A self-serve lead is not called, and the sales email says why.
    expect((await form({ ...good, revenue: "under_100k", needs: [] })).status).toBe(200);
    expect(fetches).toHaveLength(1);
    expect(env.sent[1]!.text).toContain("Voice agent: Not called: Self-serve leads are not called automatically.");
  });
});
