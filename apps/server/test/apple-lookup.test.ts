// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: tests for Apple original-transaction lookups during the bulk customer import (rate limits, the other
// environment, network failures, a fetch that must be called as a plain function, and re-runs that re-key a guessed chain).
// Docs: https://revenuedot.app/docs/migrate
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { schema, type DB } from "@revenuedot/db";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { createAppleStore, setAppleRootsForTesting } from "../src/stores/apple/index.js";
import { AppStoreServerApi, AppleRateLimitError, retryAfterMs } from "../src/stores/apple/api.js";
import { createSecretKey } from "../src/services/auth.js";
import { DAY, T0, appleHarness, makeP8, makePki, signJws, transaction, type AppleHarness, type Pki } from "./apple-fixtures.js";
import { TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";

let pki: Pki;
let p8: string;
let h: AppleHarness | undefined;
beforeAll(async () => { pki = await makePki(); p8 = await makeP8(); setAppleRootsForTesting([pki.rootPem]); });
afterAll(() => setAppleRootsForTesting(null));
afterEach(async () => { await h?.close(); h = undefined; });

const PROD = "https://api.storekit.itunes.apple.com";
const SANDBOX = "https://api.storekit-sandbox.itunes.apple.com";
const creds = () => ({ subscription_key_id: "KEY123", subscription_key_issuer: "issuer-1", subscription_private_key: p8 });

/** A fake Apple: answers per "host path" from a script; every call is recorded. */
function fakeApple(script: (url: URL, n: number) => Promise<Response> | Response) {
  const calls: string[] = [];
  // Like Workers' global fetch: throws "Illegal invocation" unless called as a plain function.
  const f = function (this: unknown, url: string) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    const u = new URL(url);
    calls.push(`${u.host === new URL(PROD).host ? "production" : "sandbox"} ${u.pathname}`);
    return Promise.resolve(script(u, calls.length));
  } as unknown as typeof fetch;
  return { fetch: f, calls };
}

const signed = async (transactionId: string, originalTransactionId: string, environment = "Production") =>
  Response.json({ signedTransactionInfo: await signJws(transaction({ transactionId, originalTransactionId, purchaseDate: T0, expiresDate: T0 + 30 * DAY, environment }), pki) });
const notFound = () => Response.json({ errorCode: 4040010, errorMessage: "Transaction id not found." }, { status: 404 });

async function restFor(db: DB, now: () => Date, fetchFn: typeof fetch) {
  const app = createApp({ db, now, stores: { ...defaultStores(), app_store: createAppleStore({ now, fetch: fetchFn }) }, fetch: fetchFn, encryptionKey: TEST_ENCRYPTION_KEY });
  const { key } = await createSecretKey(db, "proj1", "import");
  return async (customers: unknown[]) => {
    const res = await app.fetch(new Request("http://localhost/v2/projects/proj1/import/customers", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ customers }),
    }));
    const body = await res.json() as { customers: { id: string; notes: string[] }[] };
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.customers;
  };
}

/** One customer with one Apple chain; RevenueCat's first known transaction (`guess`) is not Apple's original id. */
const customer = (id: string, latest: string, guess: string, environment = "production") => ({
  id, first_seen_at: T0 - 90 * DAY,
  subscriptions: [{
    source_id: `sub_${id}`, app_id: "app_ios", store: "app_store", product_identifier: "pro_monthly", environment,
    starts_at: T0 - 60 * DAY, current_period_starts_at: T0, current_period_ends_at: T0 + 30 * DAY, status: "active", auto_renewal_status: "will_renew",
    store_subscription_identifier: latest, original_transaction_id: null,
    transactions: [{ id: guess, purchased_at: T0 - 30 * DAY, revenue_usd: 9.99 }, { id: latest, purchased_at: T0, revenue_usd: 9.99 }],
  }],
});

const appleSubs = async (db: DB) => (await db.select().from(schema.subscriptions)).map((s) => ({ customerId: s.customerId, storeKey: s.storeKey, original: s.originalTransactionId }));

describe("AppStoreServerApi", () => {
  const api = (f: typeof fetch, rateLimit?: ConstructorParameters<typeof AppStoreServerApi>[3]) =>
    new AppStoreServerApi({ keyId: "KEY123", issuerId: "issuer-1", privateKey: p8, bundleId: "com.example.scanner" }, f, () => new Date(T0), rateLimit);

  it("calls the fetch it was given as a plain function (Workers' global fetch throws when called as a method)", async () => {
    const apple = fakeApple(() => Response.json({ ok: true }));
    expect(await api(apple.fetch).get("production", "/inApps/v1/transactions/1")).toEqual({ ok: true });
  });

  it("waits as Retry-After asks after HTTP 429, then succeeds", async () => {
    const waits: number[] = [];
    const apple = fakeApple((_u, n) => n === 1 ? new Response("", { status: 429, headers: { "retry-after": String(T0 + 1500) } }) : Response.json({ ok: n }));
    const out = await api(apple.fetch, { retries: 2, maxWaitMs: 5000, sleep: async (ms) => { waits.push(ms); } }).get("production", "/x");
    expect(out).toEqual({ ok: 2 });
    expect(waits).toEqual([1500]);
  });

  it("gives up with a rate-limit error when Retry-After is further out than the longest wait, or retries run out", async () => {
    const far = fakeApple(() => new Response("", { status: 429, headers: { "retry-after": String(T0 + 60_000) } }));
    const sleeps: number[] = [];
    const e = (await api(far.fetch, { retries: 2, maxWaitMs: 5000, sleep: async (ms) => { sleeps.push(ms); } }).get("production", "/x").catch((x: unknown) => x)) as AppleRateLimitError;
    expect(e).toBeInstanceOf(AppleRateLimitError);
    expect(e.message).toBe("Apple's rate limit was reached (HTTP 429); Apple asks to wait 60 s. Try again later.");
    expect(sleeps).toEqual([]);
    expect(far.calls).toHaveLength(1);

    const always = fakeApple(() => new Response("", { status: 429 }));
    const waits: number[] = [];
    const e2 = (await api(always.fetch, { retries: 2, maxWaitMs: 5000, sleep: async (ms) => { waits.push(ms); } }).get("production", "/x").catch((x: unknown) => x)) as AppleRateLimitError;
    expect(e2).toBeInstanceOf(AppleRateLimitError);
    expect(e2.message).toBe("Apple's rate limit was reached (HTTP 429). Try again later.");
    // No Retry-After: back off 1 s, then 2 s.
    expect(waits).toEqual([1000, 2000]);
    expect(always.calls).toHaveLength(3);
  });

  it("without retries (SDK requests), a 429 fails at once", async () => {
    const apple = fakeApple(() => new Response("", { status: 429, headers: { "retry-after": "2" } }));
    const e = (await api(apple.fetch).get("production", "/x").catch((x: unknown) => x)) as AppleRateLimitError;
    expect(e).toBeInstanceOf(AppleRateLimitError);
    expect(e.status).toBe(503);
    expect(apple.calls).toHaveLength(1);
  });

  it("names the reason for a network failure, a timeout and a 5xx", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(api(down).get("production", "/x")).rejects.toThrow("The App Store could not be reached (TypeError: fetch failed). Try again later.");
    const slow = (async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as unknown as typeof fetch;
    await expect(api(slow).get("production", "/x")).rejects.toThrow("The App Store could not be reached (no answer within 15 s). Try again later.");
    const broken = fakeApple(() => new Response("", { status: 502 }));
    await expect(api(broken.fetch).get("production", "/x")).rejects.toThrow("The App Store answered HTTP 502. Try again later.");
  });

  it("reads Retry-After as Apple's UNIX milliseconds, as seconds, or as an HTTP date", () => {
    expect(retryAfterMs(String(T0 + 2500), T0)).toBe(2500);
    expect(retryAfterMs("3", T0)).toBe(3000);
    expect(retryAfterMs(new Date(T0 + 4000).toUTCString(), T0)).toBe(4000);
    expect(retryAfterMs(String(T0 - 10), T0)).toBe(0);
    expect(retryAfterMs(null, T0)).toBeNull();
    expect(retryAfterMs("soon", T0)).toBeNull();
  });
});

describe("POST /v2/projects/{id}/import/customers: Apple original-transaction lookups", () => {
  it("confirms the original id through a fetch that must be called as a plain function (as on Workers)", async () => {
    const apple = fakeApple(async (u) => u.pathname.endsWith("/7000000009") ? signed("7000000009", "7000000001") : notFound());
    h = await appleHarness({ credentials: creds() });
    const out = await (await restFor(h.db, h.now, apple.fetch))([customer("u1", "7000000009", "7000000005")]);
    expect(out[0]!.notes).toEqual([]);
    expect(apple.calls).toEqual(["production /inApps/v1/transactions/7000000009"]);
    expect(await appleSubs(h.db)).toMatchObject([{ storeKey: "7000000001", original: "7000000001" }]);
  });

  it("tries the sandbox when production answers 4040010 (transaction not found), and the other way round", async () => {
    const apple = fakeApple(async (u) => {
      if (u.host === new URL(SANDBOX).host && u.pathname.endsWith("/7100000009")) return signed("7100000009", "7100000001", "Sandbox");
      if (u.host === new URL(PROD).host && u.pathname.endsWith("/7200000009")) return signed("7200000009", "7200000001");
      return notFound();
    });
    h = await appleHarness({ credentials: creds() });
    const out = await (await restFor(h.db, h.now, apple.fetch))([customer("u1", "7100000009", "7100000005"), customer("u2", "7200000009", "7200000005", "sandbox")]);
    expect(out.flatMap((c) => c.notes)).toEqual([]);
    expect(apple.calls.sort()).toEqual([
      "production /inApps/v1/transactions/7100000009", "production /inApps/v1/transactions/7200000009",
      "sandbox /inApps/v1/transactions/7100000009", "sandbox /inApps/v1/transactions/7200000009",
    ]);
    expect((await appleSubs(h.db)).map((s) => s.original).sort()).toEqual(["7100000001", "7200000001"]);
  });

  it("keeps the guessed key and notes why when neither environment knows the transaction", async () => {
    const apple = fakeApple(() => notFound());
    h = await appleHarness({ credentials: creds() });
    const out = await (await restFor(h.db, h.now, apple.fetch))([customer("u1", "7300000009", "7300000005")]);
    expect(out[0]!.notes).toEqual([]);
    expect(apple.calls).toHaveLength(2);
    expect(await appleSubs(h.db)).toMatchObject([{ storeKey: "7300000005", original: null }]);
  });

  it("waits out a 429 with Retry-After and confirms the chain", async () => {
    let limited = false;
    const apple = fakeApple(async (u) => {
      if (!limited) { limited = true; return new Response("", { status: 429, headers: { "retry-after": String(T0 + 200) } }); }
      return u.pathname.endsWith("/7400000009") ? signed("7400000009", "7400000001") : notFound();
    });
    h = await appleHarness({ credentials: creds() });
    const out = await (await restFor(h.db, h.now, apple.fetch))([customer("u1", "7400000009", "7400000005")]);
    expect(out[0]!.notes).toEqual([]);
    expect(apple.calls).toHaveLength(2);
    expect(await appleSubs(h.db)).toMatchObject([{ storeKey: "7400000001", original: "7400000001" }]);
  });

  it("after Apple's rate limit stops one lookup, the rest of the page skips Apple and keeps the guessed keys", async () => {
    const apple = fakeApple(() => new Response("", { status: 429, headers: { "retry-after": String(T0 + 120_000) } }));
    h = await appleHarness({ credentials: creds() });
    const page = Array.from({ length: 10 }, (_, i) => customer(`u${i}`, `75000000${i}9`, `75000000${i}5`));
    const out = await (await restFor(h.db, h.now, apple.fetch))(page);
    const notes = out.flatMap((c) => c.notes);
    expect(notes).toHaveLength(10);
    // The lookups already in flight when the limit hit report it; the rest are skipped without calling Apple.
    expect(apple.calls.length).toBeLessThanOrEqual(4);
    expect(notes.filter((n) => n.startsWith("Apple lookup failed for")).length).toBe(apple.calls.length);
    expect(notes.every((n) => n.includes("Apple's rate limit was reached (HTTP 429); Apple asks to wait 120 s."))).toBe(true);
    expect(notes.filter((n) => n.startsWith("Apple lookup skipped for") && n.endsWith("Run the import again to confirm this chain."))).toHaveLength(10 - apple.calls.length);
    expect((await appleSubs(h.db)).every((s) => s.original === null)).toBe(true);
  });

  it("a network failure is noted with its reason, and the next run re-keys the guessed chain in place (no duplicate)", async () => {
    let down = true;
    const apple = fakeApple(async (u) => {
      if (down) throw new TypeError("Network connection lost.");
      return u.pathname.endsWith("/7600000009") ? signed("7600000009", "7600000001") : notFound();
    });
    h = await appleHarness({ credentials: creds() });
    const run = await restFor(h.db, h.now, apple.fetch);
    const first = await run([customer("u1", "7600000009", "7600000005")]);
    expect(first[0]!.notes).toEqual(["Apple lookup failed for 7600000009: The App Store could not be reached (TypeError: Network connection lost.). Try again later."]);
    expect(await appleSubs(h.db)).toMatchObject([{ storeKey: "7600000005", original: null }]);
    const [before] = await h.db.select().from(schema.subscriptions);

    down = false;
    const second = await run([customer("u1", "7600000009", "7600000005")]);
    expect(second[0]!.notes).toEqual([]);
    const after = await h.db.select().from(schema.subscriptions);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before!.id, storeKey: "7600000001", originalTransactionId: "7600000001" });
    // The guessed first purchase turns out to be a renewal of Apple's chain: its revenue row is re-kinded, not doubled.
    const txns = async () => (await h!.db.select().from(schema.transactions)).map((t) => [t.storeTransactionId, t.kind]).sort();
    expect(await txns()).toEqual([["7600000005", "renewal"], ["7600000009", "renewal"]]);

    // A third run changes nothing.
    await run([customer("u1", "7600000009", "7600000005")]);
    expect(await h.db.select().from(schema.subscriptions)).toEqual(after);
    expect(await txns()).toEqual([["7600000005", "renewal"], ["7600000009", "renewal"]]);
  });

  it("a 4xx other than 404 is reported as Apple's rejection with its error code", async () => {
    const apple = fakeApple(() => Response.json({ errorCode: 4000006, errorMessage: "Invalid transaction id." }, { status: 400 }));
    h = await appleHarness({ credentials: creds() });
    const out = await (await restFor(h.db, h.now, apple.fetch))([customer("u1", "bad-id", "bad-id")]);
    expect(out[0]!.notes).toEqual(["Apple rejected the lookup for bad-id: Invalid transaction id. (HTTP 400, error 4000006)."]);
  });
});
