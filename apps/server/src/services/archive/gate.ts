import type { MiddlewareHandler } from "hono";
import { eq, isNotNull } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { resolveKey } from "../auth.js";

/**
 * Requests for a moving project (prd/moves-export/PRD.md §3). Runs before every route:
 * - `forwarded`: SDK (/v1, /rcbilling), store notifications and secret-key v2 calls go to the new server unchanged, and its
 *   answer comes back (signature, status and body). Dashboard writes are refused; reads still show the old copy.
 * - `paused` and `incoming`: reads are served; SDK writes and notifications answer 503 with Retry-After (the SDKs keep the
 *   purchase and retry, Apple and Google retry notifications); v2 writes answer 423.
 * The list of moving projects is read at most every 5 seconds per process (or Worker isolate), so the usual request,
 * with nothing moving, costs one cached lookup.
 */

const TTL_MS = 5_000;
export const FORWARDED_HEADER = "x-revenuedot-forwarded";

interface Moving { state: string; url: string | null }

let epoch = 0;
/** Drops every cached list in this process (called when a move state changes here). */
export const moveStateChanged = () => { epoch++; };

export function moveGate(deps: Deps): MiddlewareHandler {
  let cache: { at: number; epoch: number; map: Map<string, Moving> } | null = null;
  const moving = async () => {
    const t = Date.now();
    if (cache && cache.epoch === epoch && t - cache.at < TTL_MS) return cache.map;
    const rows = await deps.db.select({ id: schema.projects.id, state: schema.projects.moveState, url: schema.projects.movedToUrl }).from(schema.projects).where(isNotNull(schema.projects.moveState));
    cache = { at: t, epoch, map: new Map(rows.map((r) => [r.id, { state: r.state!, url: r.url }])) };
    return cache.map;
  };
  const f = () => deps.fetch ?? fetch;

  return async (c, next) => {
    const path = c.req.path;
    const sdk = /^\/(v1|rcbilling)\//.test(path);
    const v2 = path.startsWith("/v2/projects/");
    if (!sdk && !v2) return next();
    const map = await moving();
    if (!map.size) return next();

    let projectId: string | null = null;
    let viaKey = false;
    const note = /^\/v1\/notifications\/(apple|google|amazon|stripe)\/([^/]+)/.exec(path);
    if (note) {
      const [a] = await deps.db.select({ p: schema.apps.projectId }).from(schema.apps).where(eq(schema.apps.id, note[2]!)).limit(1);
      projectId = a?.p ?? null;
    } else if (sdk) {
      const key = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (key) projectId = (await resolveKey(deps.db, key, deps.now()))?.projectId ?? null;
    } else {
      projectId = /^\/v2\/projects\/([^/]+)/.exec(path)?.[1] ?? null;
      viaKey = /^Bearer\s+sk_/i.test(c.req.header("authorization") ?? "");
    }
    const m = projectId ? map.get(projectId) : undefined;
    if (!m) return next();
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    // The move's own controls always answer (cancel, the state, exports for the last copy).
    if (v2 && /^\/v2\/projects\/[^/]+\/(move|exports?)(\/|$)/.test(path)) return next();

    if (m.state === "forwarded" && m.url && (sdk || viaKey)) {
      if (c.req.header(FORWARDED_HEADER)) return c.json({ code: 7110, message: "This project was forwarded in a loop between servers. Check where it moved." }, 508);
      const target = new URL(m.url.replace(/\/+$/, "") + path);
      target.search = new URL(c.req.url).search;
      const headers = new Headers();
      c.req.raw.headers.forEach((v, k) => {
        if (!/^(host|content-length|connection|cookie|accept-encoding|transfer-encoding|cf-|x-forwarded-|x-real-ip)/i.test(k)) headers.set(k, v);
      });
      headers.set(FORWARDED_HEADER, "1");
      const body = write ? await c.req.arrayBuffer() : undefined;
      let res: Response;
      try {
        res = await f()(target.href, { method: c.req.method, headers, body, redirect: "manual" });
      } catch {
        // The SDKs retry on 5xx and keep the purchase.
        return c.json({ code: 7110, message: "The server this project moved to did not answer. Try again." }, 502);
      }
      const out = new Headers(res.headers);
      for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(h);
      out.set("x-revenuedot-moved-to", new URL(m.url).origin);
      return new Response(res.body, { status: res.status, headers: out });
    }
    if (!write) return next();
    if (sdk) {
      c.header("retry-after", "60");
      return c.json({ code: 7110, message: m.state === "forwarded" ? "This project moved to another server." : "This project is moving to another server. Try again in a minute." }, 503);
    }
    const msg = m.state === "forwarded"
      ? `This project moved to ${m.url ? new URL(m.url).origin : "another server"}. Make changes there.`
      : m.state === "incoming" ? "This project is being copied in from another server. Changes are possible once the move finishes." : "This project is moving to another server. Changes are possible again once the move finishes or is cancelled.";
    return c.json({ object: "error", type: "resource_locked_error", message: msg, doc_url: "https://revenuedot.app/docs/guides/move-projects", retryable: m.state !== "forwarded" }, 423);
  };
}
