import type { Deps } from "../../context.js";
import { queryCustomerList, toCsv } from "../../services/customer-lists.js";
import type { Rules } from "../../services/targeting.js";
import { checkRules, RulesIn } from "./refund-control.js";
import { listOf, notFound, pageParams, paramError, scope, type V2Context, type V2Router } from "./common.js";

/** Customers lists (RevenueDot extension; prd/lifecycle/PRD.md): built-in lists, saved audiences, filters, cards and CSV. */
export function customerListRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/customer_lists";

  const parse = (c: V2Context) => {
    const list = c.req.query("list") || "all";
    let rules: Rules | null = null;
    const raw = c.req.query("rules");
    if (raw) {
      let json: unknown;
      try { json = JSON.parse(raw); } catch { throw paramError("rules must be JSON: {\"groups\":[{\"conditions\":[...]}]}.", "rules"); }
      const p = RulesIn.safeParse(json);
      if (!p.success) throw paramError(`rules: ${p.error.issues[0]!.message}`, "rules");
      checkRules(p.data);
      rules = p.data.groups.length ? p.data : null;
    }
    return { list, rules, search: c.req.query("search") ?? null };
  };

  r.get(P, scope("customer_information:customers:read"), async (c) => {
    const q = parse(c);
    const res = await queryCustomerList(db, c.get("projectId"), q, deps.now());
    if (!res) throw notFound("Audience");
    const { limit, startingAfter } = pageParams(c);
    let start = 0;
    if (startingAfter) {
      const i = res.rows.findIndex((x) => x.customer_uuid === startingAfter);
      if (i < 0) throw paramError("starting_after does not match an object in this list.", "starting_after");
      start = i + 1;
    }
    const page = res.rows.slice(start, start + limit);
    return c.json({ ...listOf(c, page, start + limit < res.rows.length && page.length ? page[page.length - 1]!.customer_uuid : null), summary: res.summary });
  });

  r.get(`${P}/export`, scope("customer_information:customers:read"), async (c) => {
    const q = parse(c);
    const res = await queryCustomerList(db, c.get("projectId"), q, deps.now());
    if (!res) throw notFound("Audience");
    const day = deps.now().toISOString().slice(0, 10);
    return c.body(toCsv(res.rows), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="customers-${q.list.replace(/[^a-z0-9_-]/gi, "")}-${day}.csv"`,
      ...(res.summary.is_approximate ? { "x-revenuedot-approximate": "true" } : {}),
    });
  });
}
