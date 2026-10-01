import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { issueSubscriberToken } from "../../services/auth.js";
import { body, notFound, scope, type V2Router } from "./common.js";

const Authenticate = z.object({ app_user_id: z.string().min(1).max(100) });

/**
 * `POST /v2/projects/{project_id}/apps/{app_id}/authenticate`: a short-lived access token for one app user id of one app.
 * The SDK endpoints accept it in place of the app's public key, pinned to that app user id (prd/sdk-api/PRD.md, IAM rows).
 */
export function subscriberAuthRoutes(r: V2Router, deps: Deps) {
  r.post("/v2/projects/:project_id/apps/:app_id/authenticate", scope("iam:authorization:issue_token"), async (c) => {
    const [app] = await deps.db.select().from(schema.apps).where(and(eq(schema.apps.projectId, c.get("projectId")), eq(schema.apps.id, c.req.param("app_id")!))).limit(1);
    if (!app) throw notFound("App");
    const b = await body(c, Authenticate);
    const { token, expiresAt } = await issueSubscriberToken(deps.db, app, b.app_user_id, deps.now());
    return c.json({ object: "authentication", access_token: token, expires_at: expiresAt.getTime() });
  });
}
