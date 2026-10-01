import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { findCustomer } from "../repo/customers.js";
import { customersByEmail, supportSummary } from "../services/support.js";
import { depsSecretKey, unseal } from "../services/secrets.js";
import { publicOrigin } from "./oauth.js";

/**
 * Help desk apps (prd/integrations/PRD.md, "Support apps"). No API key: each request is authenticated by the help desk.
 *
 *   POST /v1/support/intercom/{project_id}/canvas
 *     Intercom Canvas Kit "initialize" (and "submit") request for an inbox app. Intercom signs the raw body with the app's
 *     client secret: `X-Body-Signature` is the hex HMAC-SHA256 (https://developers.intercom.com/docs/canvas-kit). The
 *     secret is saved on the project's `intercom_inbox` connection. The contact is looked up by `external_id` (the app
 *     user id) and then by email; the answer is the support summary as Canvas Kit components.
 *
 * Zendesk's sidebar app needs no route of its own: it calls `GET /v2/projects/{id}/support_summaries?email=` with a
 * secret key kept in Zendesk's secure settings (integrations/zendesk-app/).
 */

const MAX_BODY = 64_000;

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const date = (ms: number | null) => (ms === null ? "—" : new Date(ms).toISOString().slice(0, 10));
const STATUS: Record<string, string> = { active: "Active", trial: "In trial", expired: "Expired", cancelled: "Cancelled", grace_period: "Billing issue", none: "No purchases" };

type Summary = Awaited<ReturnType<typeof supportSummary>>;

/** Canvas Kit components for one customer (text, data-table, divider, button). */
export function intercomCanvas(s: Summary | null, lookedUp: string) {
  if (!s) {
    return { canvas: { content: { components: [
      { type: "text", text: "RevenueDot", style: "header" },
      { type: "text", text: `No customer with ${lookedUp || "this contact's email"} in RevenueDot.`, style: "muted" },
    ] } } };
  }
  const active = s.subscriptions.find((x) => x.active) ?? s.subscriptions[0];
  const rows: [string, string][] = [
    ["Status", STATUS[s.status] ?? s.status],
    ["Entitlements", s.active_entitlements.length ? s.active_entitlements.join(", ") : "None"],
  ];
  if (active) {
    rows.push(["Plan", active.product_id], ["Store", active.store], [active.auto_renew ? "Renews" : "Expires", date(active.expires_at)]);
    if (active.billing_issue) rows.push(["Billing issue", "Yes"]);
  }
  rows.push(["Total spent", money(s.total_spent_in_usd)], ["Customer since", date(s.first_seen_at)], ["App user ID", s.app_user_id]);
  if (s.country) rows.push(["Country", s.country]);
  if (s.refund_requests.length) rows.push(["Refund requests", String(s.refund_requests.length)]);
  if (s.open_tickets.length) rows.push(["Open tickets", String(s.open_tickets.length)]);
  return { canvas: { content: { components: [
    { type: "text", text: "RevenueDot", style: "header" },
    { type: "data-table", items: rows.map(([field, value]) => ({ type: "field-value", field, value })) },
    { type: "divider" },
    { type: "button", id: "open-revenuedot", label: "Open in RevenueDot", style: "secondary", action: { type: "url", url: s.dashboard_url } },
  ] } } };
}

export function supportAppRoutes(deps: Deps) {
  const r = new Hono();
  const { db } = deps;

  r.post("/v1/support/intercom/:projectId/canvas", async (c) => {
    const projectId = c.req.param("projectId");
    const raw = await c.req.text().catch(() => "");
    if (raw.length > MAX_BODY) return c.json({ error: "The request is too large." }, 413);
    const [conn] = await db.select().from(schema.integrations).where(and(eq(schema.integrations.projectId, projectId), eq(schema.integrations.kind, "intercom_inbox"), eq(schema.integrations.enabled, true))).limit(1);
    if (!conn) return c.json({ error: "Intercom is not connected to this project." }, 404);
    const secrets = await unseal(conn.secrets, await depsSecretKey(deps)).catch(() => ({} as Record<string, string>));
    const secret = secrets.client_secret;
    const sig = (c.req.header("x-body-signature") ?? "").trim().toLowerCase();
    if (!secret || !sig) return c.json({ error: "Missing signature." }, 401);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
    if (!sameText(sig, expected)) return c.json({ error: "The signature is not valid." }, 401);
    let b: Record<string, any> = {};
    try { b = JSON.parse(raw) ?? {}; } catch { return c.json({ error: "The body is not JSON." }, 400); }
    const contact = (b.contact ?? b.customer ?? {}) as { external_id?: unknown; user_id?: unknown; email?: unknown };
    const base = deps.publicUrl ?? publicOrigin(c);
    const now = deps.now();
    const externalId = typeof contact.external_id === "string" ? contact.external_id : typeof contact.user_id === "string" ? contact.user_id : "";
    const email = typeof contact.email === "string" ? contact.email.trim() : "";
    let summary: Summary | null = null;
    const byId = externalId ? await findCustomer(db, projectId, externalId) : null;
    if (byId) summary = await supportSummary(db, projectId, byId, externalId, now, base);
    else if (email) {
      const [cu] = await customersByEmail(db, projectId, email);
      if (cu) {
        const aliases = await db.select({ a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(eq(schema.customerAliases.customerId, cu.id));
        summary = await supportSummary(db, projectId, cu, aliases.map((x) => x.a).find((a) => !a.startsWith("$RCAnonymousID:")) ?? cu.originalAppUserId, now, base);
      }
    }
    await db.update(schema.integrations).set({ lastDeliveredAt: now, lastError: null, consecutiveFailures: 0 }).where(eq(schema.integrations.id, conn.id));
    return c.json(intercomCanvas(summary, externalId || email));
  });

  return r;
}
