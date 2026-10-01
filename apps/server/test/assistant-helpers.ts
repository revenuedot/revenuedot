// Test server for RevenueDot AI (prd/ai-assistant/PRD.md): the account test server plus a scripted fake model, a project
// with a Test Store app, a product and the "pro" entitlement, and members with each role. Never calls a real model.
import type { UIMessageChunk } from "ai";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { fakeAssistantModel, type FakeScript } from "../src/services/assistant/fake-model.js";
import type { AssistantCaps } from "../src/services/assistant/limits.js";

/** A base64 32-byte key, as REVENUEDOT_ENCRYPTION_KEY would be; it also signs RevenueDot AI's approval requests. */
export const TEST_ENCRYPTION_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));

export async function assistantServer(o: { script?: FakeScript; delayMs?: number; caps?: Partial<AssistantCaps>; noModel?: boolean; encryptionKey?: string | null } = {}) {
  const model = fakeAssistantModel(o.script, { delayMs: o.delayMs });
  const s = await accountServer({
    encryptionKey: o.encryptionKey === null ? undefined : o.encryptionKey ?? TEST_ENCRYPTION_KEY,
    assistant: o.noModel ? undefined : model,
    assistantRuntime: "sse",
    ...(o.caps ? { assistantCaps: { ...(await import("../src/services/assistant/limits.js")).DEFAULT_CAPS, ...o.caps } } : {}),
  });
  const admin = await s.signup("ada@example.com", { name: "Ada Lovelace" });
  const pid = admin.projectId!;
  const P = `/v2/projects/${pid}`;
  const app = await admin.browser.call("POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const product = await admin.browser.call("POST", `${P}/products`, { app_id: app.body.id, store_identifier: "pro_monthly", type: "subscription", display_name: "Pro monthly", subscription: { duration: "P1M" } });
  const ent = await admin.browser.call("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" });
  await admin.browser.call("POST", `${P}/entitlements/${ent.body.id}/actions/attach_products`, { product_ids: [product.body.id] });

  /** Another account, added to the project with `role`. */
  const member = async (email: string, role: "admin" | "developer" | "viewer") => {
    const m = await s.signup(email, { name: email.split("@")[0] });
    await s.db.insert(schema.memberships).values({ userId: m.userId, projectId: pid, role });
    return m;
  };

  /** POSTs to the chat route and reads the whole UI message stream. */
  const chat = async (browser: typeof admin.browser, conversationId: string, body: unknown) => {
    const res = await s.app.fetch(new Request(`http://localhost${P}/ai/conversations/${conversationId}/chat`, {
      method: "POST", headers: { "content-type": "application/json", cookie: browser.cookie! }, body: JSON.stringify(body),
    }));
    const text = await res.text();
    return { status: res.status, text, chunks: res.status === 200 ? parseSse(text) : [], json: res.status !== 200 && text ? JSON.parse(text) : null };
  };
  const newConversation = async (browser = admin.browser) => (await browser.call("POST", `${P}/ai/conversations`, {})).body.id as string;
  /** Waits for background work (the persist branch of a stream) to finish. */
  const settle = s.settle;
  /** The app's own fetch with the deps routes see (createApp sets `dispatch` on its copy of the deps). */
  const dispatch = (req: Request) => Promise.resolve(s.app.fetch(req));
  return { ...s, deps: { ...s.deps, dispatch }, model, admin, pid, P, appId: app.body.id as string, productId: product.body.id as string, entitlementId: ent.body.id as string, member, chat, newConversation, settle };
}

export function parseSse(text: string): UIMessageChunk[] {
  return text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)) as UIMessageChunk);
}

export const textOf = (chunks: UIMessageChunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => (c as { delta: string }).delta).join("");

let n = 0;
export const userMessage = (text: string, extra: Record<string, unknown> = {}) => ({ trigger: "submit-message", message: { id: `u${++n}`, role: "user", parts: [{ type: "text", text }], ...extra } });
