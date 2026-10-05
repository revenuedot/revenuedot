import type { Hono } from "hono";
import { gateOn, pausedMessage, projectGate } from "../../services/billing/gate.js";
import { V2Error, type V2Vars } from "./common.js";

/**
 * The go-live gate on API v2 (prd/cloud-billing/PRD.md, "The go-live gate"): while a project's owner is paused (live, no
 * plan, past the 14 days), reads of live data answer 402 plan_required, and so do edits of paywalls, experiments and
 * targeting. Sandbox reads (`environment=sandbox`) keep working. A secret key can still read one customer, subscription or
 * purchase: app backends check access with those, and an app's paying customers must never lose what they bought.
 * Everything else (setup, catalog, apps, keys, members, imports, moves and their full exports, webhook settings) is never
 * gated: a paused account can always take its data elsewhere.
 */

/** Live data, read or written: gated for every caller. */
const DATA = new Set(["metrics", "charts", "attribution", "benchmarks", "customer_lists", "transactions", "events", "overview", "stats", "customer_summaries", "ads", "payment_recovery", "winback_campaigns"]);
/** RevenueDot AI: its conversations, insights and the first-sale card read live data; its status and settings do not. */
const AI_DATA = new Set(["conversations", "insights", "first_sale", "files", "actions", "mentions"]);
/** Records: their lists are gated for every caller, one record only in the dashboard. */
const RECORDS = new Set(["customers", "subscriptions", "purchases"]);
/** Editing is gated, reading is not (RevenueCat locks the same; live ones keep serving). */
const EDIT = new Set(["paywalls", "experiments", "targeting_rules"]);

export function needsPlan(method: string, rest: string[], query: (k: string) => string | undefined, byKey: boolean): boolean {
  const [head, second] = rest;
  if (!head) return false;
  const read = method === "GET" || method === "HEAD";
  const sandbox = query("environment") === "sandbox" || query("env") === "sandbox";
  if (head === "integrations" && second === "exports") return !(read && sandbox);
  if (DATA.has(head)) return !(read && sandbox);
  if (head === "ai") return !!second && AI_DATA.has(second);
  // Audience definitions are read by targeting and experiments; creating, changing and previewing them count customers.
  if (head === "audiences") return !read;
  if (RECORDS.has(head)) {
    if (!read) return false;
    if (rest.length === 1) return !sandbox;
    return !byKey && !sandbox;
  }
  if (EDIT.has(head)) return !read;
  return false;
}

export function liveGateMiddleware(r: Hono<{ Variables: V2Vars }>) {
  r.use("/v2/projects/:project_id/*", async (c, next) => {
    const deps = c.get("deps");
    if (!gateOn(deps)) return next();
    const projectId = c.get("projectId");
    const path = new URL(c.req.url).pathname;
    const rest = path.split("/").slice(4).filter(Boolean);
    const p = c.get("principal");
    if (!needsPlan(c.req.method, rest, (k) => c.req.query(k), p.kind === "key")) return next();
    const g = await projectGate(deps.db, projectId, deps.now(), true);
    if (g.stage !== "paused") return next();
    throw new V2Error(402, "plan_required", pausedMessage(g.owner, p.kind === "user" ? p.userId : null));
  });
}
