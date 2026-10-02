import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { clientIp } from "../src/services/rate-limit.js";
import { TICKET_LIMITS } from "../src/services/support.js";

/**
 * Per-IP limits (Customer Center tickets, web checkout, password resets) on a Node server with no proxy in front: the
 * caller's address comes from the connection. Before, every caller of such a server was "unknown" and shared one bucket.
 * Found by the lifecycle-tools journey (scripts/e2e/journeys/lifecycle-tools.ts).
 */

describe("clientIp", () => {
  const headers = (h: Record<string, string>) => (n: string) => h[n];
  it("takes the edge's header first, then the connection's address, then unknown", () => {
    expect(clientIp(headers({ "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.1" }), { incoming: { socket: { remoteAddress: "10.0.0.1" } } })).toBe("203.0.113.1");
    expect(clientIp(headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }))).toBe("198.51.100.1");
    expect(clientIp(headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(headers({}), { incoming: { socket: { remoteAddress: "::ffff:198.51.100.7" } } })).toBe("198.51.100.7");
    expect(clientIp(headers({}), { incoming: { socket: { remoteAddress: "2001:db8::1" } } })).toBe("2001:db8::1");
    // Workers: env holds the bindings (Cloudflare always sends cf-connecting-ip); tests: no env at all.
    expect(clientIp(headers({}), { DB: {} })).toBe("unknown");
    expect(clientIp(headers({}))).toBe("unknown");
  });
});

describe("Customer Center ticket limits on a server without a proxy", () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  it("counts each caller's own connection address, so one busy caller does not use up everyone's tickets", async () => {
    const app = createApp({ db: h.db, now: h.now, stores: defaultStores() });
    const ticket = async (remoteAddress: string, user: string) => {
      const req = new Request("http://localhost/v1/customercenter/support/create-ticket", {
        method: "POST", headers: { authorization: `Bearer ${h.ids.testKey}`, "content-type": "application/json" },
        body: JSON.stringify({ app_user_id: user, customer_email: `${user}@example.org`, issue_description: "Help" }),
      });
      return (await (await app.fetch(req, { incoming: { socket: { remoteAddress } } })).json()) as { sent: boolean };
    };
    for (let i = 0; i < TICKET_LIMITS.perIp; i++) expect(await ticket("::ffff:198.51.100.7", `busy${i}`)).toEqual({ sent: true });
    expect(await ticket("::ffff:198.51.100.7", "busy-next")).toEqual({ sent: false });
    expect(await ticket("203.0.113.9", "someone-else")).toEqual({ sent: true });
    const keys = (await h.db.select().from(schema.rateLimits).where(like(schema.rateLimits.key, "ticket:ip:%"))).map((r) => [r.key, r.count]).sort();
    expect(keys).toEqual([["ticket:ip:proj1:198.51.100.7", TICKET_LIMITS.perIp + 1], ["ticket:ip:proj1:203.0.113.9", 1]]);
  });
});
