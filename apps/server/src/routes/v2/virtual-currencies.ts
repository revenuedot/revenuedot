import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { findCustomer } from "../../repo/customers.js";
import { adjust, balancesOf } from "../../services/virtual-currencies.js";
import { V2Error, body, conflict, listOf, notFound, pageParams, paginate, paramError, scope, type V2Context, type V2Router } from "./common.js";

/** In-app currencies (virtual currencies): definitions with product grants, and per-customer balances. */

const Code = z.string().min(1).max(10).regex(/^[a-zA-Z0-9_]+$/, "must be letters, digits or underscores");
const Grant = z.object({
  product_ids: z.array(z.string().min(1).max(255)).min(1),
  amount: z.number().int().min(1),
  trial_amount: z.number().int().min(0).nullable().optional(),
  expire_at_cycle_end: z.boolean().nullable().optional(),
}).strict();
const Create = z.object({
  code: Code, name: z.string().min(1).max(50), description: z.string().min(1).max(1500).nullable().optional(), product_grants: z.array(Grant).nullable().optional(),
}).strict();
const Update = z.object({
  name: z.string().min(1).max(50).optional(), description: z.string().min(1).max(1500).nullable().optional(), product_grants: z.array(Grant).nullable().optional(),
}).strict();
const Adjustments = z.object({ adjustments: z.record(Code, z.number().int()), reference: z.string().max(255).nullable().optional() }).strict();

type Row = typeof schema.virtualCurrencies.$inferSelect;
export const currencyShape = (r: Row) => ({
  object: "virtual_currency" as const, project_id: r.projectId, code: r.code, name: r.name, state: r.state as "active" | "inactive", created_at: r.createdAt.getTime(),
  description: r.description, product_grants: r.productGrants.map((g) => ({ object: "virtual_currency.product_grant" as const, ...g })),
});

export function virtualCurrencyRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/virtual_currencies";
  const C = "/v2/projects/:project_id/customers/:customer_id/virtual_currencies";

  const find = async (c: V2Context) => {
    const [row] = await db.select().from(schema.virtualCurrencies)
      .where(and(eq(schema.virtualCurrencies.projectId, c.get("projectId")), eq(schema.virtualCurrencies.code, c.req.param("virtual_currency_code")!))).limit(1);
    if (!row) throw notFound("In-app currency");
    return row;
  };

  /** Grants reference product ids; they must be products of this project. */
  const checkGrants = async (projectId: string, grants: z.infer<typeof Grant>[] | null | undefined) => {
    const ids = [...new Set((grants ?? []).flatMap((g) => g.product_ids))];
    if (!ids.length) return;
    const found = await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.projectId, projectId), inArray(schema.products.id, ids)));
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw paramError(`product_grants: unknown product id(s): ${missing.join(", ")}.`, "product_grants");
  };
  const normalise = (grants: z.infer<typeof Grant>[] | null | undefined) =>
    (grants ?? []).map((g) => ({ product_ids: g.product_ids, amount: g.amount, trial_amount: g.trial_amount ?? 0, expire_at_cycle_end: g.expire_at_cycle_end ?? false }));

  r.get(P, scope("project_configuration:virtual_currencies:read"), async (c) => {
    const rows = await db.select().from(schema.virtualCurrencies).where(eq(schema.virtualCurrencies.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (x) => x.code, (x) => x.createdAt.getTime(), currencyShape));
  });

  r.post(P, scope("project_configuration:virtual_currencies:read_write"), async (c) => {
    const b = await body(c, Create);
    const projectId = c.get("projectId");
    const [dup] = await db.select().from(schema.virtualCurrencies).where(and(eq(schema.virtualCurrencies.projectId, projectId), eq(schema.virtualCurrencies.code, b.code))).limit(1);
    if (dup) throw conflict(`An in-app currency with code ${b.code} already exists.`, "code");
    await checkGrants(projectId, b.product_grants);
    const [row] = await db.insert(schema.virtualCurrencies).values({
      projectId, code: b.code, name: b.name, description: b.description ?? null, productGrants: normalise(b.product_grants), createdAt: deps.now(),
    }).returning();
    return c.json(currencyShape(row!), 201);
  });

  r.get(`${P}/:virtual_currency_code`, scope("project_configuration:virtual_currencies:read"), async (c) => c.json(currencyShape(await find(c))));

  r.post(`${P}/:virtual_currency_code`, scope("project_configuration:virtual_currencies:read_write"), async (c) => {
    const row = await find(c);
    const b = await body(c, Update);
    await checkGrants(row.projectId, b.product_grants);
    const [out] = await db.update(schema.virtualCurrencies).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.product_grants !== undefined ? { productGrants: normalise(b.product_grants) } : {}),
    }).where(and(eq(schema.virtualCurrencies.projectId, row.projectId), eq(schema.virtualCurrencies.code, row.code))).returning();
    return c.json(currencyShape(out!));
  });

  r.delete(`${P}/:virtual_currency_code`, scope("project_configuration:virtual_currencies:read_write"), async (c) => {
    const row = await find(c);
    await db.delete(schema.virtualCurrencies).where(and(eq(schema.virtualCurrencies.projectId, row.projectId), eq(schema.virtualCurrencies.code, row.code)));
    await db.delete(schema.virtualCurrencyTransactions).where(and(eq(schema.virtualCurrencyTransactions.projectId, row.projectId), eq(schema.virtualCurrencyTransactions.code, row.code)));
    await db.execute(sql`delete from virtual_currency_balances where code = ${row.code} and customer_id in (select id from customers where project_id = ${row.projectId})`);
    return c.json({ object: "virtual_currency", id: row.code, deleted_at: deps.now().getTime() });
  });

  for (const [action, state] of [["archive", "inactive"], ["unarchive", "active"]] as const) {
    r.post(`${P}/:virtual_currency_code/actions/${action}`, scope("project_configuration:virtual_currencies:read_write"), async (c) => {
      const row = await find(c);
      const [out] = await db.update(schema.virtualCurrencies).set({ state }).where(and(eq(schema.virtualCurrencies.projectId, row.projectId), eq(schema.virtualCurrencies.code, row.code))).returning();
      return c.json(currencyShape(out!));
    });
  }

  // Customer balances.
  const customerOf = async (c: V2Context) => {
    const cust = await findCustomer(db, c.get("projectId"), c.req.param("customer_id")!);
    if (!cust || cust.projectId !== c.get("projectId")) throw notFound("Customer");
    return cust;
  };
  const includeEmpty = (c: V2Context) => c.req.query("include_empty_balances") === "true";
  const balanceShape = (b: { code: string; name: string; description: string | null; balance: number }) => ({
    object: "virtual_currency_balance" as const, currency_code: b.code, balance: b.balance, name: b.name, ...(b.description ? { description: b.description } : {}),
  });

  r.get(C, scope("customer_information:purchases:read"), async (c) => {
    const cust = await customerOf(c);
    const { limit, startingAfter } = pageParams(c);
    const all = await balancesOf(db, cust.projectId, cust.id, { includeEmpty: includeEmpty(c) });
    let start = 0;
    if (startingAfter) {
      const i = all.findIndex((b) => b.code === startingAfter);
      if (i < 0) throw paramError("starting_after does not match a currency in this list.", "starting_after");
      start = i + 1;
    }
    const page = all.slice(start, start + limit);
    return c.json(listOf(c, page.map(balanceShape), start + limit < all.length && page.length ? page[page.length - 1]!.code : null));
  });

  /** Applies all adjustments or none: every currency must exist and no balance may go below zero. */
  const apply = async (c: V2Context, ledger: boolean) => {
    const cust = await customerOf(c);
    const b = await body(c, Adjustments);
    const codes = Object.keys(b.adjustments);
    if (!codes.length) throw paramError("adjustments must name at least one currency.", "adjustments");
    const cur = await db.select().from(schema.virtualCurrencies).where(and(eq(schema.virtualCurrencies.projectId, cust.projectId), inArray(schema.virtualCurrencies.code, codes)));
    for (const code of codes) if (!cur.some((x) => x.code === code)) throw notFound(`In-app currency ${code}`);
    const have = new Map((await db.select().from(schema.virtualCurrencyBalances).where(eq(schema.virtualCurrencyBalances.customerId, cust.id))).map((x) => [x.code, x.balance]));
    for (const [code, amount] of Object.entries(b.adjustments)) {
      if ((have.get(code) ?? 0) + amount < 0) throw new V2Error(422, "unprocessable_entity_error", `Balance of ${code} is ${have.get(code) ?? 0}; it cannot go below zero.`, "adjustments");
    }
    const key = c.req.header("idempotency-key");
    for (const [code, amount] of Object.entries(b.adjustments)) {
      if (amount === 0) continue;
      if (ledger) await adjust(db, cust.projectId, cust.id, code, amount, { source: "api", sourceKey: key ? `${key}` : null, reference: b.reference ?? null, now: deps.now() });
      else await db.insert(schema.virtualCurrencyBalances).values({ customerId: cust.id, code, balance: amount })
        .onConflictDoUpdate({ target: [schema.virtualCurrencyBalances.customerId, schema.virtualCurrencyBalances.code], set: { balance: sql`${schema.virtualCurrencyBalances.balance} + ${amount}` } });
    }
    const all = await balancesOf(db, cust.projectId, cust.id, { includeEmpty: includeEmpty(c) });
    return c.json(listOf(c, all.map(balanceShape), null, `/v2/projects/${cust.projectId}/customers/${encodeURIComponent(c.req.param("customer_id")!)}/virtual_currencies`));
  };
  r.post(`${C}/transactions`, scope("customer_information:purchases:read_write"), (c) => apply(c, true));
  r.post(`${C}/update_balance`, scope("customer_information:purchases:read_write"), (c) => apply(c, false));
}
