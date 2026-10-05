import type { Hono } from "hono";
import { gateOn, pausedMessage, projectGate } from "../../services/billing/gate.js";
import { V2Error, type V2Vars } from "./common.js";

/**
 * The go-live gate on API v2 (prd/cloud-billing/PRD.md, "The go-live gate"): while a project's owner is paused (live, no
 * plan, past the 14 days), reads of live data answer 402 plan_required, and so do edits of paywalls, experiments and
 * targeting. Sandbox reads (`environment=sandbox`) keep working. A secret key can still read one customer, subscription or
 * purchase (also looked up by its store identifier): app backends check access with those, and an app's paying customers
 * must never lose what they bought.
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

/**
 * Reads that `environment=sandbox` really limits to sandbox data, so they stay open: only handlers that filter on it. A
 * handler that ignores the parameter (the customer list, metrics/revenue, win-back, benchmarks) would answer with live data.
 */
function sandboxOnly(rest: string[], query: (k: string) => string | undefined): boolean {
  const [head, second] = rest;
  switch (head) {
    case "metrics": return second === "overview" || second === "history";
    case "charts": case "attribution": case "transactions": case "events": return true;
    // The built-in Sandbox list; every other list holds live customers.
    case "customer_lists": return query("list") === "sandbox";
    case "ads": return second === "overview";
    case "payment_recovery": return second === "stats" || second === "cases";
    // One customer's records, read by the dashboard's sandbox customer page; the lists hold live customers.
    case "customer_summaries": return true;
    case "customers": case "subscriptions": case "purchases": return rest.length > 1;
    default: return false;
  }
}

export function needsPlan(method: string, rest: string[], query: (k: string) => string | undefined, byKey: boolean): boolean {
  const [head, second] = rest;
  if (!head) return false;
  const read = method === "GET" || method === "HEAD";
  const sandbox = read && query("environment") === "sandbox" && sandboxOnly(rest, query);
  if (head === "integrations" && second === "exports") return !(read && query("environment") === "sandbox");
  // Settings, not data: benchmark sharing, payment recovery's switch and steps, and the ads setup (AdMob, reward rules,
  // reward verifications). Ad revenue (the overview, Apple Search Ads) is live data.
  if (head === "benchmarks" && second === "settings") return false;
  if (head === "payment_recovery" && !second) return false;
  if (head === "ads" && second !== "overview" && second !== "apple_search_ads") return false;
  if (head === "ads" && second === "apple_search_ads" && !read) return false;
  // Win-back: pausing or deleting a campaign (it emails the app's customers) is never blocked; its lists, stats, previews
  // and runs are live data.
  if (head === "winback_campaigns" && rest.length === 2 && (method === "POST" || method === "DELETE")) return false;
  if (DATA.has(head)) return !sandbox;
  if (head === "ai") return !!second && AI_DATA.has(second);
  // Audience definitions are read by targeting and experiments; creating, changing and previewing them count customers.
  if (head === "audiences") return !read;
  if (RECORDS.has(head)) {
    if (!read) return false;
    // Subscription and purchase lookups need a store identifier and return its one record: backends use them like a
    // customer read. The customer list is a list.
    if (rest.length === 1) return head === "customers" || !byKey;
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
