// RevenueDot AI's self-host runtime (prd/ai-assistant/PRD.md §1, §6): conversations and ownership, streaming over SSE,
// resuming mid-answer from the stored chunks, interrupted streams, Stop, attachments, status, settings and the
// first-sale card with its public share page.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { assistantServer, parseSse, textOf, userMessage } from "./assistant-helpers.js";
import { ensureFirstSaleCards } from "../src/services/assistant/first-sale.js";

const STOREKIT = readFileSync(new URL("../../../packages/core/test/fixtures/storekit/Scanner.storekit", import.meta.url), "utf8");
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("conversations", () => {
  it("create, list, search, rename and delete; another member's conversation is not found", async () => {
    const s = await assistantServer();
    const a = await s.admin.browser.call("POST", `${s.P}/ai/conversations`, { title: "Churn in September" });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ object: "ai_conversation", title: "Churn in September", runtime: "postgres" });
    await s.admin.browser.call("POST", `${s.P}/ai/conversations`, {});
    expect((await s.admin.browser.call("GET", `${s.P}/ai/conversations`)).body.items).toHaveLength(2);
    expect((await s.admin.browser.call("GET", `${s.P}/ai/conversations?q=churn`)).body.items.map((x: { id: string }) => x.id)).toEqual([a.body.id]);
    expect((await s.admin.browser.call("POST", `${s.P}/ai/conversations/${a.body.id}`, { title: "Churn, Sep 2026" })).body.title).toBe("Churn, Sep 2026");

    const dev = await s.member("dev@example.com", "developer");
    expect((await dev.browser.call("GET", `${s.P}/ai/conversations`)).body.items).toEqual([]);
    expect((await dev.browser.call("GET", `${s.P}/ai/conversations/${a.body.id}`)).status).toBe(404);
    expect((await dev.browser.call("DELETE", `${s.P}/ai/conversations/${a.body.id}`)).status).toBe(404);

    expect((await s.admin.browser.call("DELETE", `${s.P}/ai/conversations/${a.body.id}`)).body.deleted).toBe(true);
    expect((await s.admin.browser.call("GET", `${s.P}/ai/conversations/${a.body.id}`)).status).toBe(404);
  });

  it("secret API keys cannot use conversations", async () => {
    const s = await assistantServer();
    const key = await s.admin.browser.call("POST", `${s.P}/api_keys`, { name: "ci", permissions: ["*"] });
    const r = await s.app.fetch(new Request(`http://localhost${s.P}/ai/conversations`, { headers: { authorization: `Bearer ${key.body.key ?? key.body.secret}` } }));
    expect([401, 403]).toContain(r.status);
  });
});

describe("streaming and resume", () => {
  it("a second reader resumes the answer mid-stream from the stored chunks and gets the same text", async () => {
    const s = await assistantServer({ delayMs: 15 });
    const cid = await s.newConversation();
    const long = "word ".repeat(60);
    s.model.fake.calls.length = 0;
    const sending = s.chat(s.admin.browser, cid, userMessage(`Say this back: ${long}`));
    // Wait until the stream is running and some chunks are stored, then reconnect like a reloaded tab.
    for (let i = 0; i < 100; i++) {
      const rows = await s.db.select().from(schema.aiStreamChunks);
      if (rows.length > 3) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const conv = await s.admin.browser.call("GET", `${s.P}/ai/conversations/${cid}`);
    expect(conv.body.streaming).toBe(true);
    const resumed = await s.app.fetch(new Request(`http://localhost${s.P}/ai/conversations/${cid}/stream`, { headers: { cookie: s.admin.browser.cookie! } }));
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get("content-type")).toMatch(/text\/event-stream/);
    const resumedChunks = parseSse(await resumed.text());
    const original = await sending;
    expect(textOf(resumedChunks)).toBe(textOf(original.chunks));
    expect(resumedChunks[0]).toMatchObject({ type: "start" });
    expect(resumedChunks.at(-1)).toMatchObject({ type: "finish" });
    await s.settle();
    // Nothing is running any more.
    expect((await s.app.fetch(new Request(`http://localhost${s.P}/ai/conversations/${cid}/stream`, { headers: { cookie: s.admin.browser.cookie! } }))).status).toBe(204);
  });

  it("only one answer at a time per conversation; Stop ends it", async () => {
    const s = await assistantServer({ delayMs: 30 });
    const cid = await s.newConversation();
    const sending = s.chat(s.admin.browser, cid, userMessage(`Say ${"slowly ".repeat(80)}`));
    for (let i = 0; i < 100 && !(await s.db.select().from(schema.aiStreams)).length; i++) await new Promise((r) => setTimeout(r, 10));
    const busy = await s.chat(s.admin.browser, cid, userMessage("another"));
    expect(busy.status).toBe(423);
    const stop = await s.admin.browser.call("POST", `${s.P}/ai/conversations/${cid}/stop`);
    expect(stop.body.stopped).toBe(true);
    await sending;
    await s.settle();
    const [st] = await s.db.select().from(schema.aiStreams);
    expect(st!.status).toBe("stopped");
  });

  it("a stream that stopped moving (server restart) is marked interrupted and the conversation says so", async () => {
    const s = await assistantServer();
    const cid = await s.newConversation();
    const id = newId("ais", 16);
    await s.db.insert(schema.aiStreams).values({ id, conversationId: cid, status: "streaming", createdAt: new Date(s.now().getTime() - 120_000), updatedAt: new Date(s.now().getTime() - 120_000) });
    const res = await s.app.fetch(new Request(`http://localhost${s.P}/ai/conversations/${cid}/stream`, { headers: { cookie: s.admin.browser.cookie! } }));
    expect(res.status).toBe(204);
    const conv = await s.admin.browser.call("GET", `${s.P}/ai/conversations/${cid}`);
    expect(conv.body.last_stream).toMatchObject({ status: "interrupted" });
    // The conversation is usable again.
    expect((await s.chat(s.admin.browser, cid, userMessage("hello"))).status).toBe(200);
  });
});

describe("attachments, mentions and the .storekit viewer", () => {
  it("images go to the model as data URLs; other projects cannot read them; unsupported types are refused", async () => {
    const s = await assistantServer();
    const up = await s.app.fetch(new Request(`http://localhost${s.P}/ai/files?name=shot.png`, { method: "POST", headers: { cookie: s.admin.browser.cookie!, "content-type": "image/png" }, body: PNG }));
    expect(up.status).toBe(201);
    const f = await up.json() as { id: string; url: string; media_type: string };
    expect(f.media_type).toBe("image/png");
    const back = await s.app.fetch(new Request(`http://localhost${f.url}`, { headers: { cookie: s.admin.browser.cookie! } }));
    expect(back.headers.get("content-type")).toBe("image/png");
    expect(back.headers.get("x-content-type-options")).toBe("nosniff");
    const svg = await s.app.fetch(new Request(`http://localhost${s.P}/ai/files?name=x.svg`, { method: "POST", headers: { cookie: s.admin.browser.cookie!, "content-type": "image/svg+xml" }, body: "<svg/>" }));
    expect(svg.status).toBe(400);

    const cid = await s.newConversation();
    await s.chat(s.admin.browser, cid, { trigger: "submit-message", message: { id: "img1", role: "user", parts: [{ type: "text", text: "What is in this screenshot?" }, { type: "file", url: f.url, mediaType: "image/png", filename: "shot.png" }] } });
    const user = s.model.fake.calls.at(-1)!.prompt.find((m) => m.role === "user")!;
    const file = (user.content as { type: string; data?: unknown; mediaType?: string }[]).find((p) => p.type === "file");
    expect(file).toMatchObject({ mediaType: "image/png" });

    const stranger = await s.signup("eve@example.com");
    const theirs = await stranger.browser.call("GET", f.url);
    expect(theirs.status).toBe(404);
    // A file part pointing outside this project's files is refused.
    const bad = await s.chat(s.admin.browser, cid, { trigger: "submit-message", message: { id: "img2", role: "user", parts: [{ type: "text", text: "x" }, { type: "file", url: "https://evil.example/x.png", mediaType: "image/png" }] } });
    expect(bad.status).toBe(400);
  });

  it("a .storekit upload is parsed, summarized for the model and importable with approval", async () => {
    const s = await assistantServer({
      script: ({ lastUserText, lastToolResults, tools }) => {
        if (lastToolResults.length) return { text: `Imported: ${JSON.stringify(lastToolResults[0]!.output)}` };
        const id = /file_id (aif\w+)/.exec(lastUserText)?.[1];
        const app = /app (app\w+)/.exec(lastUserText)?.[1];
        return id && app && tools.includes("import-storekit-products") ? { toolCalls: [{ toolName: "import-storekit-products", input: { app_id: app, file_id: id } }] } : { text: "no" };
      },
    });
    const up = await s.app.fetch(new Request(`http://localhost${s.P}/ai/files?name=Scanner.storekit`, { method: "POST", headers: { cookie: s.admin.browser.cookie!, "content-type": "application/octet-stream" }, body: STOREKIT }));
    const f = await up.json() as { id: string; url: string; storekit: { products: unknown[] } };
    expect(f.storekit.products).toHaveLength(5);
    expect((await s.admin.browser.call("GET", `${f.url}?format=storekit`)).body.storekit.products).toHaveLength(5);
    const parsed = await s.app.fetch(new Request(`http://localhost${s.P}/ai/storekit`, { method: "POST", headers: { cookie: s.admin.browser.cookie! }, body: "{}" }));
    expect(parsed.status).toBe(400);

    const cid = await s.newConversation();
    const first = await s.chat(s.admin.browser, cid, { trigger: "submit-message", message: { id: "sk1", role: "user", parts: [{ type: "text", text: `Import these into app ${s.appId}` }, { type: "file", url: f.url, mediaType: "application/x-storekit+json", filename: "Scanner.storekit" }] } });
    expect(first.chunks.some((c) => c.type === "tool-approval-request")).toBe(true);
    const prompt = JSON.stringify(s.model.fake.calls[0]!.prompt);
    expect(prompt).toContain("com.example.scanner.pro.monthly");
    expect(prompt).toContain(`file_id ${f.id}`);
    await s.settle();
    const answer = (await s.admin.browser.call("GET", `${s.P}/ai/conversations/${cid}`)).body.messages[1];
    const ok = { ...answer, parts: answer.parts.map((p: Record<string, unknown>) => p.state === "approval-requested" ? { ...p, state: "approval-responded", approval: { ...(p.approval as object), approved: true } } : p) };
    const second = await s.chat(s.admin.browser, cid, { trigger: "submit-message", message: ok });
    expect(textOf(second.chunks)).toMatch(/"created":\["com.example.scanner.credits100"/);
    const products = await s.admin.browser.call("GET", `${s.P}/products?app_id=${s.appId}&limit=100`);
    expect(products.body.items.map((p: { store_identifier: string }) => p.store_identifier)).toEqual(expect.arrayContaining(["com.example.scanner.pro.yearly", "com.example.scanner.lifetime"]));
    expect(products.body.items.find((p: { store_identifier: string }) => p.store_identifier === "com.example.scanner.pro.yearly")).toMatchObject({ type: "subscription", subscription: { duration: "P1Y" } });
  });

  it("@ mentions: suggestions for customers, offerings and charts, and their context reaches the model", async () => {
    const s = await assistantServer();
    await s.admin.browser.call("POST", `${s.P}/customers`, { id: "wren_ios" });
    await s.admin.browser.call("POST", `${s.P}/offerings`, { lookup_key: "default", display_name: "Default" });
    const m = await s.admin.browser.call("GET", `${s.P}/ai/mentions?q=wr`);
    expect(m.body.items.map((x: { type: string; id: string }) => `${x.type}:${x.id}`)).toEqual(["customer:wren_ios"]);
    const all = await s.admin.browser.call("GET", `${s.P}/ai/mentions?q=mrr`);
    expect(all.body.items).toContainEqual({ type: "chart", id: "mrr", label: "MRR", detail: "Chart" });
    const cid = await s.newConversation();
    await s.chat(s.admin.browser, cid, userMessage("Tell me about @wren_ios", { metadata: { mentions: [{ type: "customer", id: "wren_ios", label: "wren_ios" }] } }));
    expect(JSON.stringify(s.model.fake.calls.at(-1)!.prompt)).toMatch(/Context the user attached with @ mentions.*wren_ios/);
    // The saved transcript keeps the mention, not the loaded context.
    const saved = (await s.admin.browser.call("GET", `${s.P}/ai/conversations/${cid}`)).body.messages[0];
    expect(saved.metadata.mentions).toEqual([{ type: "customer", id: "wren_ios", label: "wren_ios" }]);
    expect(JSON.stringify(saved)).not.toMatch(/Context the user attached/);
  });
});

describe("status and settings", () => {
  it("says who is asking, what they may do, the model and today's usage; hidden without a model", async () => {
    const s = await assistantServer();
    const st = await s.admin.browser.call("GET", `${s.P}/ai`);
    expect(st.body).toMatchObject({ configured: true, available: true, provider: "Fake", runtime: "sse", access: "read_write", role: "admin", can_write: true, greeting_name: "Ada", usage: { user: { turns: 0 } } });
    const viewer = await s.member("vic@example.com", "viewer");
    expect((await viewer.browser.call("GET", `${s.P}/ai`)).body).toMatchObject({ can_read: true, can_write: false, reason: "Your role (Viewer) can read only." });
    expect((await viewer.browser.call("POST", `${s.P}/ai/settings`, { access: "disabled" })).status).toBe(403);
    expect((await s.admin.browser.call("POST", `${s.P}/ai/settings`, { access: "nope" })).status).toBe(400);

    const none = await assistantServer({ noModel: true });
    expect((await none.admin.browser.call("GET", `${none.P}/ai`)).body).toMatchObject({ configured: false, available: false, reason: "No model is configured on this server." });
    expect((await none.admin.browser.call("POST", `${none.P}/ai/conversations`, {})).status).toBe(503);
  });
});

describe("first-sale card", () => {
  const sale = (projectId: string, customerId: string, at: Date, extra: Partial<typeof schema.transactions.$inferInsert> = {}) => ({
    id: newId("tx", 12), projectId, customerId, store: "app_store", storeTransactionId: newId("st", 8), productIdentifier: "scanner.pro.monthly", kind: "purchase",
    isSandbox: false, purchasedAt: at, revenueUsd: 9.99, priceAmount: 9.99, priceCurrency: "USD", countryCode: "US", createdAt: at, ...extra,
  });

  it("is made once when the first paid production purchase arrives, served publicly without personal data", async () => {
    const s = await assistantServer();
    const cust = await s.admin.browser.call("POST", `${s.P}/customers`, { id: "secret_user_id_123" });
    const [customer] = await s.db.select().from(schema.customers).where(eq(schema.customers.projectId, s.pid));
    await s.db.insert(schema.transactions).values(sale(s.pid, customer!.id, new Date(s.now().getTime() - 3600_000), { isSandbox: true }));
    expect(await ensureFirstSaleCards(s.db, s.now())).toBe(0);
    await s.db.insert(schema.transactions).values(sale(s.pid, customer!.id, new Date(s.now().getTime() - 600_000)));
    expect(await ensureFirstSaleCards(s.db, s.now())).toBe(1);
    expect(await ensureFirstSaleCards(s.db, s.now())).toBe(0);
    expect(cust.status).toBe(201);

    const card = (await s.admin.browser.call("GET", `${s.P}/ai/first_sale`)).body.card;
    expect(card).toMatchObject({ project_name: "Scanner", product: "scanner.pro.monthly", store: "app_store", amount: 9.99, dismissed: false });
    const page = await s.app.fetch(new Request(new URL(card.share_url).pathname.replace(/^/, "http://localhost")));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('<meta property="og:image"');
    expect(html).toContain("Scanner made its first sale");
    expect(html).not.toContain("secret_user_id_123");
    const img = await s.app.fetch(new Request(`http://localhost${new URL(card.image_url).pathname}`));
    expect(img.headers.get("content-type")).toMatch(/image\/svg\+xml/);
    expect(await img.text()).toContain("$9.99");
    expect((await s.app.fetch(new Request("http://localhost/share/first-sale/fs_nope_nope_nope_nope_nope"))).status).toBe(404);

    await s.admin.browser.call("POST", `${s.P}/ai/first_sale/dismiss`);
    expect((await s.admin.browser.call("GET", `${s.P}/ai/first_sale`)).body.card.dismissed).toBe(true);
  });

  it("an established app (first sale long ago) gets no card and is not scanned again", async () => {
    const s = await assistantServer();
    await s.admin.browser.call("POST", `${s.P}/customers`, { id: "old" });
    const [customer] = await s.db.select().from(schema.customers).where(eq(schema.customers.projectId, s.pid));
    await s.db.insert(schema.transactions).values([sale(s.pid, customer!.id, new Date(s.now().getTime() - 200 * 86400_000)), sale(s.pid, customer!.id, new Date(s.now().getTime() - 3600_000), { kind: "renewal" })]);
    expect(await ensureFirstSaleCards(s.db, s.now())).toBe(0);
    expect((await s.admin.browser.call("GET", `${s.P}/ai/first_sale`)).body.card).toBeNull();
    expect((await s.db.select().from(schema.aiShareCards)).map((c) => c.data)).toEqual([{ skipped: true }]);
  });
});
