import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";
import { memoryMailer } from "../../../apps/server/src/mail/index.js";
import { getOrCreateCustomer, setAttributes } from "../../../apps/server/src/repo/customers.js";
import { applyPurchases } from "../../../apps/server/src/services/purchases.js";
import type { VerifiedPurchase } from "../../../apps/server/src/stores/types.js";

/**
 * RFC 8058 one-click unsubscribe on win-back email (prd/lifecycle/PRD.md), as a mail provider performs it: it reads the
 * two headers from the message, then sends a POST to the List-Unsubscribe https URI with the body
 * `List-Unsubscribe=One-Click`, form-encoded, with no cookies or credentials, and does not follow redirects.
 * https://www.rfc-editor.org/rfc/rfc8058 (sections 3.1 and 3.2), https://www.rfc-editor.org/rfc/rfc2369
 */
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T12:00:00Z");
let h: Harness;
let mail: ReturnType<typeof memoryMailer>;
beforeEach(async () => { mail = memoryMailer(); h = await harness({ mailer: mail, publicUrl: "https://api.example.test" }); h.setNow(new Date(NOW)); });
afterEach(async () => { await h.close(); });

async function churned(user: string, email: string) {
  const { customer } = await getOrCreateCustomer(h.db, "proj1", user, new Date(NOW - 200 * DAY));
  const end = new Date(NOW - 10 * DAY);
  const p = {
    kind: "subscription", store: "app_store", storeKey: `key_${user}`, productIdentifier: "pro_monthly", isSandbox: false,
    purchaseDate: new Date(end.getTime() - 30 * DAY), originalPurchaseDate: new Date(end.getTime() - 90 * DAY), expiresDate: end, periodType: "normal",
    ownershipType: "PURCHASED", storeTransactionId: `tx_${user}_1`, originalTransactionId: `key_${user}`, price: { amount: 9.99, currency: "USD" },
  } as unknown as VerifiedPurchase;
  await applyPurchases(h.db, customer, [p], { projectId: "proj1", appId: "app_ios", appUserId: user, now: new Date(end.getTime() - 30 * DAY), fromDevice: false });
  await setAttributes(h.db, customer.id, { $email: { value: email } }, new Date(NOW));
}

describe("RFC 8058 one-click unsubscribe (win-back)", () => {
  it("the message carries both headers; a credential-less form POST to the URI suppresses the address without a redirect", async () => {
    await churned("lapsed", "lapsed@example.com");
    const res = await h.fetch("/v2/projects/proj1/winback_campaigns", {
      key: h.ids.secretKey, method: "POST",
      json: {
        name: "Come back", status: "active", audience: { churned_min_days: 3, churned_max_days: 60, product_ids: [], stores: [], audience_id: null },
        email: { subject: "We miss you", heading: "Hi", body: "Come back.", button_label: "Resubscribe" }, offer: { type: "store" }, send_hour_utc: 9,
      },
    });
    const id = ((await res.json()) as { id: string }).id;
    expect((await h.fetch(`/v2/projects/proj1/winback_campaigns/${id}/actions/run`, { key: h.ids.secretKey, method: "POST" })).status).toBe(200);
    const m = mail.sent.find((x) => x.to === "lapsed@example.com")!;

    // RFC 8058 section 3.1: an https URI in angle brackets, and the exact List-Unsubscribe-Post value.
    const lu = m.headers?.["List-Unsubscribe"] ?? "";
    expect(lu).toMatch(/^<https:\/\/api\.example\.test\/v1\/winback\/u\/[A-Za-z0-9_-]{32}>$/);
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(new TextEncoder().encode(lu).length).toBeLessThanOrEqual(2048); // Cloudflare Email Service's per-header limit
    const uri = new URL(lu.slice(1, -1));

    // The provider's POST: no Authorization (key ""), no cookie, the one-click body. The token alone authorises it.
    const post = () => h.fetch(uri.pathname, { key: "", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", redirect: "manual" });
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    expect((await h.db.select().from(schema.emailSuppressions)).map((s) => s.email)).toEqual(["lapsed@example.com"]);
    // Providers may retry: the same answer, still one suppression.
    expect((await post()).status).toBe(200);
    expect(await h.db.select().from(schema.emailSuppressions)).toHaveLength(1);

    // A GET (a link scanner, or the reader clicking the body link) only asks; it never unsubscribes on its own.
    const before = await h.db.select().from(schema.emailSuppressions);
    const g = await h.fetch(uri.pathname, { key: "" });
    expect(g.status).toBe(200);
    expect(await h.db.select().from(schema.emailSuppressions)).toEqual(before);
  });

  it("a forged or unknown token is rejected and suppresses nobody", async () => {
    const r = await h.fetch("/v1/winback/u/not-a-real-token-at-all-000000000", { key: "", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(r.status).toBe(404);
    expect(await h.db.select().from(schema.emailSuppressions)).toHaveLength(0);
  });
});
