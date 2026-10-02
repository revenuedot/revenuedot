import { describe, expect, it } from "vitest";
import { parsePhone, score, validate, type Lead } from "../worker/lead";
import worker, { leadEmail } from "../worker/index";

const good = {
  name: "Maya Chen", email: "maya@habitly.app", company: "Habitly", role: "founder",
  phone: "(415) 555-0132", phoneCountry: "US", revenue: "100k_500k", current: "revenuecat",
  needs: ["lower_cost", "migration"], timeline: "this_quarter", platforms: ["ios", "android", "flutter"], website: "habitly.app", message: "Two apps.",
};
const lead = (o: Partial<Lead> = {}): Lead => ({ ...(validate(good) as { ok: true; lead: Lead }).lead, ...o });

describe("parsePhone", () => {
  it("returns E.164 for valid national numbers in each country", () => {
    expect(parsePhone("(415) 555-0132", "US")).toEqual({ e164: "+14155550132", country: "US" });
    expect(parsePhone("07400 123456", "GB")).toEqual({ e164: "+447400123456", country: "GB" });
    expect(parsePhone("030 1234567", "DE")).toEqual({ e164: "+49301234567", country: "DE" });
    expect(parsePhone("090-1234-5678", "JP")).toEqual({ e164: "+819012345678", country: "JP" });
    expect(parsePhone("138 0013 8000", "CN")).toEqual({ e164: "+8613800138000", country: "CN" });
    expect(parsePhone("98765 43210", "IN")).toEqual({ e164: "+919876543210", country: "IN" });
  });
  it("lets a number typed with + choose its own country", () => {
    expect(parsePhone("+44 7400 123456", "US")).toEqual({ e164: "+447400123456", country: "GB" });
  });
  it("rejects numbers that are too short, too long, wrong for the country, or not numbers", () => {
    expect(parsePhone("07400 12345", "GB")).toBeNull();
    expect(parsePhone("415 555 01322", "US")).toBeNull();
    expect(parsePhone("07400 123456", "US")).toBeNull();
    expect(parsePhone("call me", "US")).toBeNull();
    expect(parsePhone("", "US")).toBeNull();
    expect(parsePhone("123", "ZZ")).toBeNull();
  });
});

describe("validate", () => {
  it("accepts a complete form and normalises it", () => {
    const v = validate({ ...good, email: " Maya@Habitly.app ", needs: ["sso", "bogus", "sso"] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.lead.email).toBe("maya@habitly.app");
    expect(v.lead.phone).toBe("+14155550132");
    expect(v.lead.needs).toEqual(["sso"]);
  });
  it("names every missing or wrong required answer", () => {
    const v = validate({ name: "", email: "nope", phone: "12", phoneCountry: "US", revenue: "lots", website: "not a site" });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(Object.keys(v.errors).sort()).toEqual(["company", "current", "email", "name", "phone", "revenue", "role", "timeline", "website"]);
  });
  it("accepts Prefer not to say for revenue", () => {
    expect(validate({ ...good, revenue: "undisclosed" }).ok).toBe(true);
  });
});

describe("score", () => {
  it("ranks big apps and near-term mid-size apps as hot", () => {
    expect(score(lead({ revenue: "1m_5m", timeline: "researching" }))).toBe("hot");
    expect(score(lead({ revenue: "500k_1m", timeline: "this_month" }))).toBe("hot");
  });
  it("keeps mid-size apps warm even when researching", () => {
    expect(score(lead({ revenue: "100k_500k", timeline: "researching" }))).toBe("warm");
  });
  it("sends small apps without enterprise needs to self-serve", () => {
    expect(score(lead({ revenue: "under_100k", needs: ["lower_cost"] }))).toBe("self_serve");
    expect(score(lead({ revenue: "under_100k", needs: ["sso"], timeline: "this_month" }))).toBe("warm");
  });
  it("never sends a lead that declined to share revenue to self-serve", () => {
    expect(score(lead({ revenue: "undisclosed", needs: [], timeline: "researching" }))).toBe("nurture");
    expect(score(lead({ revenue: "undisclosed", needs: ["sla"], timeline: "this_month" }))).toBe("hot");
    expect(score(lead({ revenue: "undisclosed", needs: ["sla"], timeline: "this_month", email: "maya@gmail.com" }))).toBe("warm");
  });
});

describe("worker", () => {
  const env = () => {
    const rows: unknown[][] = [];
    const sent: { to: string; subject: string; text: string; replyTo?: string }[] = [];
    return {
      rows, sent,
      ASSETS: { fetch: async () => new Response("asset") },
      LEADS: { prepare: (sql: string) => ({ bind: (...v: unknown[]) => ({ run: async () => { if (sql.startsWith("INSERT")) rows.push(v); } }), run: async () => {} }) },
      EMAIL: { send: async (m: { to: string; subject: string; text: string; replyTo?: string }) => { sent.push(m); } },
      LEAD_LIMIT: { limit: async () => ({ success: true }) },
      SALES_TO: "sales@circo.so",
    };
  };
  const post = (body: unknown, headers: Record<string, string> = {}) => new Request("https://revenuedot.app/api/contact-sales", { method: "POST", headers: { "content-type": "application/json", origin: "https://revenuedot.app", ...headers }, body: JSON.stringify(body) });

  it("stores the lead and emails sales with the score and E.164 phone", async () => {
    const e = env();
    const r = await worker.fetch(post(good), e as never);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, next: "sales" });
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0]).toContain("+14155550132");
    expect(e.sent[0]!.to).toBe("sales@circo.so");
    expect(e.sent[0]!.replyTo).toBe("maya@habitly.app");
    expect(e.sent[0]!.subject).toBe("[Hot] Sales lead: Habitly (Maya Chen), $100K to $500K/mo, uses RevenueCat");
  });
  it("answers 400 with field errors", async () => {
    const r = await worker.fetch(post({ ...good, phone: "555" }), env() as never);
    expect(r.status).toBe(400);
    expect((await r.json()).errors.phone).toMatch(/valid phone/);
  });
  it("refuses other origins and rate-limited callers", async () => {
    expect((await worker.fetch(post(good, { origin: "https://evil.example" }), env() as never)).status).toBe(403);
    const limited = { ...env(), LEAD_LIMIT: { limit: async () => ({ success: false }) } };
    expect((await worker.fetch(post(good), limited as never)).status).toBe(429);
  });
  it("drops bot posts quietly", async () => {
    const e = env();
    const r = await worker.fetch(post({ ...good, fax: "x" }), e as never);
    expect(r.status).toBe(200);
    expect(e.rows).toHaveLength(0);
    expect(e.sent).toHaveLength(0);
  });
  it("accepts form posts made without JavaScript", async () => {
    const e = env();
    const fd = new URLSearchParams({ ...good, needs: "sso", platforms: "ios" } as Record<string, string>);
    fd.append("needs", "sla");
    const r = await worker.fetch(new Request("https://revenuedot.app/api/contact-sales", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://revenuedot.app" }, body: fd }), e as never);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Thanks");
    expect(e.rows[0]).toContain(JSON.stringify(["sso", "sla"]));
  });
  it("saves drafts once the email is valid, and marks them completed on submit", async () => {
    const drafts: unknown[][] = [];
    const updates: unknown[][] = [];
    const e = { ...env(), DRAFT_LIMIT: { limit: async () => ({ success: true }) }, LEADS: { prepare: (sql: string) => ({ bind: (...v: unknown[]) => ({ run: async () => { if (sql.includes("sales_lead_drafts (id")) drafts.push(v); if (sql.startsWith("UPDATE sales_lead_drafts")) updates.push(v); } }), run: async () => {} }) } };
    const draftId = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
    const draft = (b: unknown) => worker.fetch(new Request("https://revenuedot.app/api/contact-sales/draft", { method: "POST", headers: { "content-type": "application/json", origin: "https://revenuedot.app" }, body: JSON.stringify(b) }), e as never);
    expect((await draft({ draftId, email: "not-an-email", step: 1 })).status).toBe(400);
    expect((await draft({ draftId: "nope", email: "maya@habitly.app", step: 1 })).status).toBe(400);
    expect((await draft({ draftId, email: "Maya@Habitly.app", revenue: "1m_5m", step: 2 })).status).toBe(200);
    expect(drafts[0]![1]).toBe("maya@habitly.app");
    expect(JSON.parse(drafts[0]![2] as string)).toEqual({ revenue: "1m_5m" });
    await worker.fetch(post({ ...good, draftId }), e as never);
    expect(updates).toEqual([[draftId]]);
  });
  it("serves assets for every other path", async () => {
    expect(await (await worker.fetch(new Request("https://revenuedot.app/pricing"), env() as never)).text()).toBe("asset");
  });
  it("escapes lead text in the email HTML", () => {
    const m = leadEmail(lead({ name: "<script>x</script>", message: "a & b" }), "warm", { country: "US", referrer: "", userAgent: "" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});
