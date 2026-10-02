// Delivery details (webhooks and partner integrations): what was sent, every attempt with its answer (first 4 KB,
// secrets scrubbed), cURL without secrets, Admins and Developers only, attempt details cleared after 30 days.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { curlFor, maskAuthorization, pruneAttemptLogs, readCapped, scrubSecrets } from "../src/services/webhooks.js";
import { tick } from "../src/services/tick.js";
import { accountServer } from "./account-helpers.js";

type Server = Awaited<ReturnType<typeof accountServer>>;
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
let s: Server;
beforeEach(async () => { s = await accountServer({ encryptionKey: KEY }); });
afterEach(async () => { await s.close(); });

/** Answers from a script: one Response factory per call. */
function endpoint(...answers: (() => Response)[]) {
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const f = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body) });
    return (answers[seen.length - 1] ?? (() => new Response("ok")))();
  }) as typeof fetch;
  return { f, seen };
}

async function team() {
  const admin = await s.signup("admin@example.com");
  const viewer = await s.signup("viewer@example.com", { project_name: undefined });
  await s.db.insert(schema.memberships).values({ userId: viewer.userId, projectId: admin.projectId!, role: "viewer" });
  return { admin: admin.browser, viewer: viewer.browser, P: `/v2/projects/${admin.projectId}` };
}

describe("webhook delivery details", () => {
  it("shows the request, every attempt with its scrubbed answer, and a cURL without secrets; Viewers get 403", async () => {
    const { admin, viewer, P } = await team();
    const hook = (await admin.call("POST", `${P}/integrations/webhooks`, { name: "Backend", url: "https://hooks.example.com/rc?x='1'", authorization_header: "Bearer supersecret-token-123" })).body;
    const t = (await admin.call("POST", `${P}/integrations/webhooks/${hook.id}/test`)).body;
    const leak = `error: got Bearer supersecret-token-123 and sk_live_abcdefghijkl ${hook.signing_secret} ` + "x".repeat(6000);
    const ep = endpoint(() => new Response(leak, { status: 500 }), () => new Response("{\"ok\":true}", { status: 200 }));
    await tick(s.db, s.now(), ep.f, { encryptionKey: KEY });
    expect((await admin.call("POST", `${P}/webhooks/${hook.id}/deliveries/${t.id}/retry`)).status).toBe(200);
    s.advance(1000);
    await tick(s.db, s.now(), ep.f, { encryptionKey: KEY });
    expect(ep.seen).toHaveLength(2);

    const d = await admin.call("GET", `${P}/webhooks/${hook.id}/deliveries/${t.id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ object: "webhook_delivery", id: t.id, status: "delivered", attempts: 2, event_type: "TEST", attempt_log_kept_days: 30 });
    expect(d.body.request.method).toBe("POST");
    expect(d.body.request.url).toBe(hook.url);
    expect(d.body.request.body).toBe(ep.seen[0]!.body);
    expect(JSON.parse(d.body.request.body)).toMatchObject({ api_version: "1.0", event: { type: "TEST", id: t.event_id } });
    expect(d.body.request.headers).toContainEqual({ name: "Authorization", value: "Bearer ••••••••" });
    expect(d.body.request.headers).toContainEqual({ name: "X-RevenueCat-Webhook-Signature", value: ep.seen[1]!.headers.get("X-RevenueCat-Webhook-Signature") });
    const [first, second] = d.body.attempt_log;
    expect(first).toMatchObject({ response_status: 500, error: "HTTP 500", signature: ep.seen[0]!.headers.get("X-RevenueCat-Webhook-Signature") });
    expect(first.response_ms).toBeGreaterThanOrEqual(0);
    expect(first.response_body.length).toBeLessThanOrEqual(4096);
    // The webhook's whole Authorization value is a secret; other bearer tokens and secret keys are masked too.
    expect(first.response_body).toContain("got [redacted] and");
    expect(scrubSecrets("x Bearer abcdefghijkl", [])).toBe("x Bearer [redacted]");
    expect(first.response_body).toContain("sk_[redacted]");
    expect(first.response_body).not.toContain("supersecret");
    expect(first.response_body).not.toContain(hook.signing_secret);
    expect(second).toMatchObject({ response_status: 200, error: null, response_body: "{\"ok\":true}" });
    expect(second.attempted_at).toBeGreaterThan(first.attempted_at);
    // cURL: the URL quoted for a shell, a placeholder for Authorization, the exact body.
    expect(d.body.curl).toContain(`curl -X POST 'https://hooks.example.com/rc?x='\\''1'\\'''`);
    expect(d.body.curl).toContain("Authorization: <your Authorization header value>");
    expect(d.body.curl).not.toContain("supersecret");
    expect(d.body.curl).toContain(ep.seen[0]!.body);
    expect(JSON.stringify(d.body)).not.toContain("supersecret");

    expect((await viewer.call("GET", `${P}/webhooks/${hook.id}/deliveries/${t.id}`)).status).toBe(403);
    expect((await viewer.call("GET", `${P}/webhooks/${hook.id}/deliveries`)).status).toBe(200);
    expect((await admin.call("GET", `${P}/webhooks/${hook.id}/deliveries/nope`)).status).toBe(404);

    // Older than 30 days: the attempt details go, the delivery stays.
    s.advance(31 * 86400_000);
    expect(await pruneAttemptLogs(s.db, s.now(), true)).toBe(1);
    const [later] = await s.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, t.id));
    expect(later).toMatchObject({ status: "delivered", attempts: 2, attemptLog: [] });
    expect(await pruneAttemptLogs(s.db, s.now(), true)).toBe(0);
  });
});

describe("integration delivery details", () => {
  it("keeps every attempt and builds a cURL with a placeholder for the partner's credentials; Viewers see no bodies", async () => {
    const { admin, viewer, P } = await team();
    const slack = (await admin.call("POST", `${P}/integrations/partners`, { type: "slack", settings: { webhook_url: "https://hooks.slack.com/services/T0/B0/secretpath" } })).body;
    const t = (await admin.call("POST", `${P}/integrations/partners/${slack.id}/test`, {})).body;
    const ep = endpoint(() => new Response("invalid_payload", { status: 400 }));
    await tick(s.db, s.now(), ep.f, { encryptionKey: KEY });
    const d = await admin.call("GET", `${P}/integrations/partners/${slack.id}/deliveries/${t.id}`);
    expect(d.status).toBe(200);
    expect(d.body.attempt_log).toHaveLength(1);
    expect(d.body.attempt_log[0]).toMatchObject({ response_status: 400, response_body: "invalid_payload" });
    expect(d.body.attempt_log[0].request).toMatch(/^POST /);
    expect(JSON.stringify(d.body)).not.toContain("secretpath");
    if (d.body.curl) expect(d.body.curl).toContain("<partner credentials>");
    expect((await viewer.call("GET", `${P}/integrations/partners/${slack.id}/deliveries/${t.id}`)).status).toBe(403);
    const list = await viewer.call("GET", `${P}/integrations/partners/${slack.id}/deliveries`);
    expect(list.body.items[0]).toMatchObject({ request_body: null, response_body: null, response_status: 400 });
    expect((await admin.call("GET", `${P}/integrations/partners/${slack.id}/deliveries`)).body.items[0].response_body).toBe("invalid_payload");
  });
});

describe("helpers", () => {
  it("masks, scrubs, caps and quotes", async () => {
    expect(maskAuthorization("Bearer abc.def")).toBe("Bearer ••••••••");
    expect(maskAuthorization("rawsecret")).toBe("••••••••");
    expect(scrubSecrets("token=abcd1234 whsec_abcdefghij", ["abcd1234"])).toBe("token=[redacted] whsec_[redacted]");
    expect(await readCapped(new Response("y".repeat(10_000)), 4096)).toHaveLength(4096);
    expect(await readCapped(new Response(null))).toBe("");
    expect(curlFor("POST", "https://a.example.com/x", [{ name: "A", value: "it's" }], "{}")).toBe("curl -X POST 'https://a.example.com/x' \\\n  -H 'A: it'\\''s' \\\n  --data-binary @- <<'JSON'\n{}\nJSON");
  });
});
