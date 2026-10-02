// Delivery details (webhooks and partner integrations): what was sent, every attempt with its answer (first 4 KB,
// secrets scrubbed), cURL without secrets, Admins and Developers only, attempt details cleared after 30 days.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { curlFor, maskAuthorization, pruneAttemptLogs, readCapped, retryDelivery, scrubSecrets } from "../src/services/webhooks.js";
import { tick } from "../src/services/tick.js";
import { integrationCurl } from "../src/services/integrations/deliver.js";
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
    const leak = `error: got Bearer supersecret-token-123 and sk_live_abcdefghijkl ${hook.signing_secret}, bare supersecret-token-123 {"access_token":"tok-9f8e7d6c5b"} https://hooks.example.com/rc?token=qs-secret-1 ` + "x".repeat(6000);
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
    // The Authorization credential alone, JSON fields and query parameters that hold tokens are masked as well.
    expect(first.response_body).toContain("bare [redacted]");
    expect(first.response_body).toContain('{"access_token":"[redacted]"}');
    expect(first.response_body).toContain("?token=[redacted]");
    expect(first.response_body).not.toContain("tok-9f8e7d6c5b");
    expect(first.response_body).not.toContain("qs-secret-1");
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
    expect(await pruneAttemptLogs(s.db, s.now())).toBe(1);
    const [later] = await s.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, t.id));
    expect(later).toMatchObject({ status: "delivered", attempts: 2, attemptLog: [] });
    expect(await pruneAttemptLogs(s.db, s.now())).toBe(0);
    // A retry of that old delivery keeps its own details for 30 days (the age counts per attempt, not per delivery),
    // and the tick that prunes leaves it alone. (The session has expired by now, so the retry is queued directly.)
    await retryDelivery(s.db, t.id, s.now());
    await tick(s.db, s.now(), ep.f, { encryptionKey: KEY });
    await tick(s.db, s.now(), ep.f, { encryptionKey: KEY });
    const [again] = await s.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, t.id));
    expect(again).toMatchObject({ attempts: 3, status: "delivered" });
    expect(again!.attemptLog).toHaveLength(1);
    s.advance(29 * 86400_000);
    expect(await pruneAttemptLogs(s.db, s.now())).toBe(0);
    s.advance(2 * 86400_000);
    expect(await pruneAttemptLogs(s.db, s.now())).toBe(1);
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
    // Slack's URL is the secret, so there is nothing to repeat with cURL.
    expect(d.body.curl).toBeNull();
    expect((await viewer.call("GET", `${P}/integrations/partners/${slack.id}/deliveries/${t.id}`)).status).toBe(403);
    const list = await viewer.call("GET", `${P}/integrations/partners/${slack.id}/deliveries`);
    expect(list.body.items[0]).toMatchObject({ request_body: null, response_body: null, response_status: 400 });
    expect((await admin.call("GET", `${P}/integrations/partners/${slack.id}/deliveries`)).body.items[0].response_body).toBe("invalid_payload");
  });
});

describe("integration cURL", () => {
  it("repeats a single JSON request with the partner's key as a placeholder, and knows forms", async () => {
    const { admin, P } = await team();
    const ph = (await admin.call("POST", `${P}/integrations/partners`, { type: "posthog", settings: { api_key: "phc_secretkey123" } })).body;
    const t = (await admin.call("POST", `${P}/integrations/partners/${ph.id}/test`, {})).body;
    const ep = endpoint(() => new Response(JSON.stringify({ status: 1, echo: "phc_secretkey123" }), { status: 200 }));
    await tick(s.db, s.now(), ep.f, { encryptionKey: KEY });
    const d = await admin.call("GET", `${P}/integrations/partners/${ph.id}/deliveries/${t.id}`);
    expect(d.body.status).toBe("delivered");
    expect(d.body.curl).toMatch(/^curl -X POST 'https:\/\/[^']+' \\\n {2}-H 'Content-Type: application\/json' \\\n {2}-H 'Authorization: <partner credentials>'/);
    expect(d.body.curl).toContain("[redacted]");
    expect(JSON.stringify(d.body)).not.toContain("phc_secretkey123");
    expect(integrationCurl("POST https://s2s.adjust.com/event", "s2s=1&app_token=[redacted]")).toContain("Content-Type: application/x-www-form-urlencoded");
    expect(integrationCurl("GET https://api.example.com/e?k=1", "")).toBe("curl -X GET 'https://api.example.com/e?k=1' \\\n  -H 'Authorization: <partner credentials>'");
    // Several requests, a body the log cut, or nothing sent: no cURL.
    expect(integrationCurl("POST https://a.example.com\nPOST https://b.example.com", "{}\n{}")).toBeNull();
    expect(integrationCurl("POST https://a.example.com", "x".repeat(4000))).toBeNull();
    expect(integrationCurl(null, null)).toBeNull();
  });
});

describe("pruning", () => {
  it("runs from the tick unless turned off (the Worker prunes from its cron only)", async () => {
    const { admin, P } = await team();
    const hook = (await admin.call("POST", `${P}/integrations/webhooks`, { name: "Backend", url: "https://hooks.example.com/a" })).body;
    const t = (await admin.call("POST", `${P}/integrations/webhooks/${hook.id}/test`)).body;
    const ep = endpoint();
    await tick(s.db, s.now(), ep.f, { encryptionKey: KEY });
    s.advance(31 * 86400_000);
    expect((await tick(s.db, s.now(), ep.f, { encryptionKey: KEY, pruneDeliveryLogs: false })).attemptLogsPruned).toBe(0);
    const [kept] = await s.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, t.id));
    expect(kept!.attemptLog).toHaveLength(1);
    expect((await tick(s.db, s.now(), ep.f, { encryptionKey: KEY })).attemptLogsPruned).toBe(1);
  });
});

describe("helpers", () => {
  it("scrubs credentials wherever an answer or error may echo them", () => {
    const cases: [string, string][] = [
      ["invalid token abc123def456", "invalid token [redacted]"],
      ['{"password":"hunter2","user":"ann","client_secret":"cs_1"}', '{"password":"[redacted]","user":"ann","client_secret":"[redacted]"}'],
      ["GET /x?api_key=AK123&page=2&sig=ff00", "GET /x?api_key=[redacted]&page=2&sig=[redacted]"],
      ["see https://bob:pa55word@example.com/x", "see https://[redacted]@example.com/x"],
      ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: Basic [redacted]"],
      ["X-Api-Key: 9f8e7d6c5b4a3f2e", "X-Api-Key: [redacted]"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl here", "jwt [redacted] here"],
      ["key AIzaSyA1234567890abcdefghijklmnopqrstu", "key [redacted]"],
      // Ordinary words next to secret-sounding names stay.
      ["token: invalid, password reset required", "token: invalid, password reset required"],
    ];
    for (const [input, out] of cases) expect(scrubSecrets(input, ["Bearer abc123def456"])).toBe(out);
  });

  it("masks, scrubs, caps and quotes", async () => {
    expect(maskAuthorization("Bearer abc.def")).toBe("Bearer ••••••••");
    expect(maskAuthorization("rawsecret")).toBe("••••••••");
    expect(scrubSecrets("token=abcd1234 whsec_abcdefghij", ["abcd1234"])).toBe("token=[redacted] whsec_[redacted]");
    expect(await readCapped(new Response("y".repeat(10_000)), 4096)).toHaveLength(4096);
    expect(await readCapped(new Response(null))).toBe("");
    expect(curlFor("POST", "https://a.example.com/x", [{ name: "A", value: "it's" }], "{}")).toBe("curl -X POST 'https://a.example.com/x' \\\n  -H 'A: it'\\''s' \\\n  --data-binary @- <<'BODY'\n{}\nBODY");
  });
});
