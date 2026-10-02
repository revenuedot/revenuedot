import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { resolveKey } from "../../services/auth.js";
import { SESSION_COOKIE, sessionUser } from "../../services/sessions.js";
import { V2Error, v2ErrorResponse, type V2Vars } from "./common.js";
import { userProjectPrincipal } from "./project-access.js";
import { accountOverviewRoutes } from "./account-overview.js";
import { projectRoutes } from "./projects.js";
import { appRoutes } from "./apps.js";
import { productRoutes } from "./products.js";
import { entitlementRoutes } from "./entitlements.js";
import { offeringRoutes } from "./offerings.js";
import { customerRoutes } from "./customers.js";
import { metricsRoutes } from "./metrics.js";
import { integrationRoutes } from "./integrations.js";
import { extensionRoutes } from "./extensions.js";
import { setupRoutes } from "./setup.js";
import { importRoutes } from "./import.js";
import { memberRoutes } from "./members.js";
import { virtualCurrencyRoutes } from "./virtual-currencies.js";
import { customerExtraRoutes } from "./customer-extras.js";
import { auditMiddleware, auditRoutes } from "./audit.js";
import { paywallRoutes } from "./paywalls.js";
import { targetingRoutes } from "./targeting.js";
import { chartRoutes } from "./charts.js";
import { savedChartRoutes } from "./saved-charts.js";
import { partnerIntegrationRoutes } from "./partner-integrations.js";
import { dataExportRoutes } from "./data-exports.js";
import { storeOpRoutes } from "./store-ops.js";
import { storeImportRoutes } from "./store-import.js";
import { subscriberAuthRoutes } from "./subscriber-auth.js";
import { billingExcludedRoutes } from "./billing-excluded.js";
import { discountRoutes } from "./discounts.js";
import { webRoutes } from "./web.js";
import { refundControlRoutes } from "./refund-control.js";
import { retentionRoutes } from "./retention.js";
import { supportRoutes } from "./support.js";
import { winbackRoutes } from "./winback.js";
import { stripeConnectRoutes } from "./stripe-connect.js";
import { paymentRecoveryRoutes } from "./payment-recovery.js";
import { customerListRoutes } from "./customer-lists.js";
import { projectSettingsRoutes } from "./project-settings.js";
import { authRoutes as authConfigRoutes } from "./auth.js";
import { assistantRoutes } from "./assistant.js";
import { ASSISTANT_CTX } from "../../services/assistant/client.js";
import { adsRoutes } from "./ads.js";
import { moveRoutes } from "./moves.js";

/**
 * REST API v2, wire-compatible with RevenueCat's `https://api.revenuecat.com/v2`.
 *
 * Auth: `Authorization: Bearer sk_...` (a secret key bound to one project, with scopes) or the dashboard session
 * cookie (`rd_session`, any project the user is a member of). Every `/v2/projects/{project_id}/...` route runs
 * after the project check below, and every query in the handlers filters by that project id.
 */
export function v2Routes(deps: Deps) {
  const r = new Hono<{ Variables: V2Vars }>();
  r.onError((e, c) => v2ErrorResponse(c, e));

  r.use("/v2/*", async (c, next) => {
    c.set("deps", deps);
    // RevenueDot AI acting for a signed-in user (services/assistant/client.ts). Only in-process requests carry this.
    const assistant = ASSISTANT_CTX.get(c.req.raw);
    const header = c.req.header("authorization");
    if (assistant) {
      c.set("principal", { kind: "user", userId: assistant.userId, via: "assistant", email: assistant.email, conversationId: assistant.conversationId });
    } else if (header !== undefined && header.trim() !== "") {
      const key = header.replace(/^Bearer\s+/i, "").trim();
      const auth = await resolveKey(deps.db, key, deps.now());
      if (!auth) throw new V2Error(401, "authentication_error", "Invalid API key.");
      if (auth.kind !== "secret") throw new V2Error(403, "authorization_error", "API v2 requires a secret API key (sk_...). Public app keys only work with the SDK endpoints.");
      c.set("principal", { kind: "key", projectId: auth.projectId, keyId: auth.keyId!, permissions: auth.permissions ?? [] });
      // Record usage at most once a minute per key.
      const now = deps.now();
      await deps.db.update(schema.apiKeys).set({ lastUsedAt: now })
        .where(and(eq(schema.apiKeys.id, auth.keyId!), or(isNull(schema.apiKeys.lastUsedAt), lt(schema.apiKeys.lastUsedAt, new Date(now.getTime() - 60_000)))));
    } else {
      // The session cookie is SameSite=Lax, which still rides along on requests from sibling hosts (api. and pay. pages are
      // same-site with app.). A write with the cookie must come from the dashboard's own origin.
      const site = c.req.header("sec-fetch-site");
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && (site === "cross-site" || site === "same-site")) {
        throw new V2Error(403, "authorization_error", "Dashboard requests must come from the dashboard.");
      }
      const user = await sessionUser(deps.db, getCookie(c, SESSION_COOKIE), deps.now());
      if (!user) throw new V2Error(401, "authentication_error", "Missing API key. Send Authorization: Bearer <secret key>.");
      c.set("principal", { kind: "user", userId: user.id });
    }
    await next();
  });

  // Project scoping. Another project's id answers 404 whether it exists or not, so ids cannot be probed.
  r.use("/v2/projects/:project_id/*", async (c, next) => {
    const projectId = c.req.param("project_id");
    const p = c.get("principal");
    if (p.kind === "key") {
      if (p.projectId !== projectId) throw new V2Error(404, "resource_missing", "Project not found.");
    } else {
      c.set("principal", await userProjectPrincipal(deps, c, p, projectId));
    }
    c.set("projectId", projectId);
    await next();
  });

  r.use("/v2/projects/:project_id/*", auditMiddleware(deps));

  // Across every project the signed-in user can open (Overview → All projects).
  accountOverviewRoutes(r, deps);

  projectRoutes(r, deps);
  appRoutes(r, deps);
  // Lifecycle and customer lists (prd/lifecycle/PRD.md), before the customer routes they share a prefix with.
  refundControlRoutes(r, deps);
  retentionRoutes(r, deps);
  supportRoutes(r, deps);
  winbackRoutes(r, deps);
  paymentRecoveryRoutes(r, deps);
  stripeConnectRoutes(r, deps);
  customerListRoutes(r, deps);
  adsRoutes(r, deps);
  productRoutes(r, deps);
  entitlementRoutes(r, deps);
  offeringRoutes(r, deps);
  customerRoutes(r, deps);
  metricsRoutes(r, deps);
  integrationRoutes(r, deps);
  extensionRoutes(r, deps);
  setupRoutes(r, deps);
  importRoutes(r, deps);
  memberRoutes(r, deps);
  virtualCurrencyRoutes(r, deps);
  customerExtraRoutes(r, deps);
  auditRoutes(r, deps);
  paywallRoutes(r, deps);
  targetingRoutes(r, deps);
  chartRoutes(r, deps);
  savedChartRoutes(r, deps);
  partnerIntegrationRoutes(r, deps);
  dataExportRoutes(r, deps);
  storeOpRoutes(r, deps);
  storeImportRoutes(r, deps);
  subscriberAuthRoutes(r, deps);
  discountRoutes(r, deps);
  webRoutes(r, deps);
  billingExcludedRoutes(r, deps);
  projectSettingsRoutes(r, deps);
  authConfigRoutes(r, deps);
  assistantRoutes(r, deps);
  moveRoutes(r, deps);

  r.all("/v2/*", () => { throw new V2Error(404, "resource_missing", "Resource not found."); });
  return r;
}

