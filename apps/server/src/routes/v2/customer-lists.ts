import type { Deps } from "../../context.js";
import { CSV_HEAD, csvLines, exportPages, listPage, SORT_KEYS, type SortKey } from "../../services/customer-lists.js";
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
    const sort = c.req.query("sort") || null;
    if (sort && !(SORT_KEYS as readonly string[]).includes(sort)) throw paramError(`sort must be one of ${SORT_KEYS.join(", ")}.`, "sort");
    const direction = c.req.query("direction") || "asc";
    if (direction !== "asc" && direction !== "desc") throw paramError("direction must be asc or desc.", "direction");
    return { list, rules, search: c.req.query("search") ?? null, sort: sort as SortKey | null, direction: direction as "asc" | "desc" };
  };

  r.get(P, scope("customer_information:customers:read"), async (c) => {
    const q = parse(c);
    const { limit, startingAfter } = pageParams(c);
    const res = await listPage(db, c.get("projectId"), q, deps.now(), { limit, startingAfter, inlineLimit: deps.countInlineLimit });
    if (!res) throw notFound("Audience");
    if (res.badCursor) throw paramError("starting_after does not match an object in this list.", "starting_after");
    return c.json({ ...listOf(c, res.rows, res.next), summary: res.summary });
  });

  // The whole list, streamed a page at a time, so a large project's export never holds every row in memory.
  r.get(`${P}/export`, scope("customer_information:customers:read"), async (c) => {
    const q = parse(c);
    const now = deps.now();
    const pages = await exportPages(db, c.get("projectId"), q, now);
    if (!pages) throw notFound("Audience");
    // The rows are written by a task the server keeps alive after the response starts (Workers: waitUntil, which also keeps
    // the request's database connection open until the last row), so the stream never reads from a closed connection.
    const enc = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const write = async () => {
      try {
        await writer.write(enc.encode(CSV_HEAD));
        for await (const rows of pages) await writer.write(enc.encode(csvLines(rows)));
        await writer.close();
      } catch (e) {
        console.error("customer list export failed", e);
        await writer.abort(e).catch(() => {});
      }
    };
    if (deps.defer) deps.defer(write); else void write();
    const body = readable;
    const day = now.toISOString().slice(0, 10);
    return c.body(body, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="customers-${q.list.replace(/[^a-z0-9_-]/gi, "")}-${day}.csv"`,
    });
  });
}
