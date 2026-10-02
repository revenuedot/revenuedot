import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { ConnectError, connectShape, disconnectConnect, finishConnect, startConnect } from "../../services/stripe-connect.js";
import { withStoreSecrets } from "../../services/store-secrets.js";
import { publicOrigin } from "../oauth.js";
import { V2Error, body, notFound, scope, type V2Context, type V2Router } from "./common.js";

/**
 * "Connect with Stripe" for a Stripe app (RevenueDot extension; prd/web-billing/PRD.md §8):
 *   GET  /v2/projects/{id}/apps/{app_id}/stripe_connect                    availability and the app's connection
 *   POST /v2/projects/{id}/apps/{app_id}/stripe_connect/actions/start      Stripe's OAuth URL or an onboarding link, and a nonce
 *   POST /v2/projects/{id}/apps/{app_id}/stripe_connect/actions/finish     from the callback page: state, nonce, code
 *   POST /v2/projects/{id}/apps/{app_id}/stripe_connect/actions/disconnect deauthorize and forget the account
 * Stripe sends the developer back to `<dashboard>/connect/stripe`; that URL must be one of the platform's OAuth redirect URIs.
 */

const Start = z.object({
  method: z.enum(["oauth", "account_link"]).default("oauth"),
  mode: z.enum(["live", "test"]).default("live"),
  email: z.string().trim().max(254).nullable().optional(),
}).strict();
const Finish = z.object({ state: z.string().min(10).max(300), nonce: z.string().min(16).max(200), code: z.string().max(500).nullable().optional() }).strict();

export function stripeConnectRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/apps/:app_id/stripe_connect";
  const findApp = async (c: V2Context) => {
    const [a] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, c.get("projectId")), eq(schema.apps.id, c.req.param("app_id")!))).limit(1);
    if (!a) throw notFound("App");
    if (a.type !== "stripe") throw new V2Error(422, "unprocessable_entity_error", "Only Stripe apps can connect with Stripe.", "app_id");
    return a;
  };
  const origin = (c: V2Context) => deps.apiUrl ?? publicOrigin(c);
  const userId = (c: V2Context) => { const p = c.get("principal"); return p.kind === "user" ? p.userId : null; };
  const fail = (e: unknown): never => {
    if (e instanceof ConnectError) {
      const type = e.code === "state" || e.code === "invalid" ? "parameter_error" : e.code === "stripe" ? "store_error" : "unprocessable_entity_error";
      throw new V2Error(e.status === 503 ? 422 : (e.status as 400 | 409 | 422), e.status === 409 ? "resource_already_exists" : type, e.message, undefined, e.status === 503);
    }
    throw e;
  };

  r.get(P, scope("project_configuration:apps:read"), async (c) => c.json(await connectShape(deps, await findApp(c), origin(c))));

  r.post(`${P}/actions/start`, scope("project_configuration:apps:read_write"), async (c) => {
    const app = await findApp(c);
    const b = await body(c, Start);
    // Stripe only redirects to the platform's registered URIs: the dashboard's callback page on this server's public origin.
    const redirectUri = `${deps.publicUrl ?? publicOrigin(c)}/connect/stripe`;
    try {
      const out = await startConnect(deps, app, { method: b.method, mode: b.mode, redirectUri, email: b.email, userId: userId(c) });
      // The state travels to Stripe anyway; the callback page matches it with the nonce kept in this browser.
      return c.json({ object: "stripe_connect_start", url: out.url, state: out.state, nonce: out.nonce, redirect_uri: redirectUri, expires_in: 600 });
    } catch (e) { return fail(e); }
  });

  r.post(`${P}/actions/finish`, scope("project_configuration:apps:read_write"), async (c) => {
    const app = await findApp(c);
    const b = await body(c, Finish);
    try { await finishConnect(deps, app, { state: b.state, nonce: b.nonce, code: b.code ?? null, userId: userId(c) }); } catch (e) { return fail(e); }
    const [fresh] = await db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    return c.json(await connectShape(deps, fresh!, origin(c)));
  });

  r.post(`${P}/actions/disconnect`, scope("project_configuration:apps:read_write"), async (c) => {
    const app = await findApp(c);
    let r0: { deauthorized: boolean; warning: string | null };
    try { r0 = await disconnectConnect(deps, app, await withStoreSecrets(deps, app)); } catch (e) { return fail(e); }
    const [fresh] = await db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    return c.json({ ...(await connectShape(deps, fresh!, origin(c))), deauthorized: r0.deauthorized, warning: r0.warning });
  });
}
