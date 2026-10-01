import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { findCustomer, mergeCustomers } from "../src/repo/customers.js";

/** logIn after earning coins anonymously: the coins and their history follow the customer (prd/lifecycle/PRD.md, item 6). */
let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const ANON = "$RCAnonymousID:0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";
const credit = (user: string, json: unknown, key?: string) => h.fetch(`/v2/projects/proj1/customers/${encodeURIComponent(user)}/virtual_currencies/transactions`, {
  method: "POST", key: h.ids.secretKey, json, headers: key ? { "Idempotency-Key": key } : {},
});
const balances = async (user: string) => {
  const body = await (await h.fetch(`/v1/subscribers/${encodeURIComponent(user)}/virtual_currencies`, { key: h.ids.testKey })).json() as any;
  return Object.fromEntries(Object.entries(body.virtual_currencies).filter(([, v]: [string, any]) => v.balance !== 0).map(([k, v]: [string, any]) => [k, v.balance]));
};

describe("mergeCustomers and in-app currency", () => {
  beforeEach(async () => {
    for (const code of ["GLD", "GEM"]) await h.fetch("/v2/projects/proj1/virtual_currencies", { method: "POST", key: h.ids.secretKey, json: { code, name: code } });
  });

  it("logIn into an existing customer sums the balances and moves every ledger row", async () => {
    await h.fetch(`/v1/subscribers/${encodeURIComponent(ANON)}`, { key: h.ids.testKey });
    expect((await credit(ANON, { adjustments: { GLD: 120, GEM: 3 } })).status).toBe(200);
    await h.fetch("/v2/projects/proj1/customers", { method: "POST", key: h.ids.secretKey, json: { id: "player_1" } });
    expect((await credit("player_1", { adjustments: { GLD: 30 } })).status).toBe(200);
    const anonId = (await findCustomer(h.db, "proj1", ANON))!.id;

    const res = await h.fetch("/v1/subscribers/identify", { method: "POST", key: h.ids.testKey, json: { app_user_id: ANON, new_app_user_id: "player_1" } });
    expect(res.status).toBe(200);
    expect(await balances("player_1")).toEqual({ GLD: 150, GEM: 3 });
    const into = (await findCustomer(h.db, "proj1", "player_1"))!;
    const ledger = await h.db.select().from(schema.virtualCurrencyTransactions).where(eq(schema.virtualCurrencyTransactions.customerId, into.id));
    expect(ledger.map((r) => [r.code, r.amount]).sort()).toEqual([["GEM", 3], ["GLD", 120], ["GLD", 30]]);
    expect(await h.db.select().from(schema.virtualCurrencyBalances).where(eq(schema.virtualCurrencyBalances.customerId, anonId))).toEqual([]);
    expect(await h.db.select().from(schema.virtualCurrencyTransactions).where(eq(schema.virtualCurrencyTransactions.customerId, anonId))).toEqual([]);
  });

  it("logIn with a new app user id keeps the anonymous customer, so the balance simply stays", async () => {
    await h.fetch(`/v1/subscribers/${encodeURIComponent(ANON)}`, { key: h.ids.testKey });
    await credit(ANON, { adjustments: { GLD: 40 } });
    const res = await h.fetch("/v1/subscribers/identify", { method: "POST", key: h.ids.testKey, json: { app_user_id: ANON, new_app_user_id: "fresh_login" } });
    expect(res.status).toBe(201);
    expect(await balances("fresh_login")).toEqual({ GLD: 40 });
  });

  it("a grant both customers got with the same source key counts once", async () => {
    await h.fetch("/v2/projects/proj1/customers", { method: "POST", key: h.ids.secretKey, json: { id: "a_user" } });
    await h.fetch("/v2/projects/proj1/customers", { method: "POST", key: h.ids.secretKey, json: { id: "b_user" } });
    await credit("a_user", { adjustments: { GLD: 100 } }, "grant-tx-1");
    await credit("b_user", { adjustments: { GLD: 100 } }, "grant-tx-1");
    await credit("a_user", { adjustments: { GLD: 5 } });
    const a = (await findCustomer(h.db, "proj1", "a_user"))!, b = (await findCustomer(h.db, "proj1", "b_user"))!;
    await mergeCustomers(h.db, a.id, b.id);
    expect(await balances("b_user")).toEqual({ GLD: 105 });
    expect(await balances("a_user")).toEqual({ GLD: 105 });
    const ledger = await h.db.select().from(schema.virtualCurrencyTransactions).where(eq(schema.virtualCurrencyTransactions.customerId, b.id));
    expect(ledger.map((r) => r.amount).sort((x, y) => x - y)).toEqual([5, 100]);
  });

  it("a merge that fails halfway changes nothing, so a retry never adds the balance twice", async () => {
    await h.fetch("/v2/projects/proj1/customers", { method: "POST", key: h.ids.secretKey, json: { id: "c_user" } });
    await h.fetch("/v2/projects/proj1/customers", { method: "POST", key: h.ids.secretKey, json: { id: "d_user" } });
    await credit("c_user", { adjustments: { GLD: 70 } });
    await credit("d_user", { adjustments: { GLD: 10 } });
    const c = (await findCustomer(h.db, "proj1", "c_user"))!, d = (await findCustomer(h.db, "proj1", "d_user"))!;
    // A statement after the currency move fails.
    await h.db.execute(sql`ALTER TABLE customer_activity RENAME TO customer_activity_off`);
    await expect(mergeCustomers(h.db, c.id, d.id)).rejects.toThrow();
    await h.db.execute(sql`ALTER TABLE customer_activity_off RENAME TO customer_activity`);
    expect(await balances("c_user")).toEqual({ GLD: 70 });
    expect(await balances("d_user")).toEqual({ GLD: 10 });
    await mergeCustomers(h.db, c.id, d.id);
    expect(await balances("d_user")).toEqual({ GLD: 80 });
  });
});
