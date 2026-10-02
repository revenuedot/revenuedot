import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { SESSION_COOKIE } from "../../services/sessions.js";
import { ASSISTANT_CTX } from "../../services/assistant/client.js";
import { assistantScope } from "../../services/assistant/access.js";
import { V2Error, type Principal } from "./common.js";

/**
 * A signed-in user's principal in one project: their role, plus a custom role's permissions from an enterprise
 * extension. Throws 404 when they are not a member (or RevenueDot AI acts outside its conversation's project) and the
 * extension's error when it denies access (enforced single sign-on). Shared by the project routes and the account
 * overview, which checks every project the user belongs to.
 */
export async function userProjectPrincipal(deps: Deps, c: Context, p: Extract<Principal, { kind: "user" }>, projectId: string): Promise<Principal> {
  const [m] = await deps.db.select().from(schema.memberships)
    .where(and(eq(schema.memberships.userId, p.userId), eq(schema.memberships.projectId, projectId))).limit(1);
  if (!m) throw new V2Error(404, "resource_missing", "Project not found.");
  if (p.via === "assistant") {
    // The assistant works in its conversation's project only, and writes only where the project allows it.
    if (ASSISTANT_CTX.get(c.req.raw)?.projectId !== projectId) throw new V2Error(404, "resource_missing", "Project not found.");
    const [proj] = await deps.db.select({ aiAccess: schema.projects.aiAccess }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    const s = assistantScope(proj?.aiAccess ?? "disabled", m.role);
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (!s.canRead || (write && !s.canWrite)) throw new V2Error(403, "authorization_error", s.reason ?? "RevenueDot AI cannot do this here.");
  }
  // Enterprise extensions may deny access (enforced single sign-on) or give a custom role's permissions.
  let permissions: string[] | undefined;
  for (const x of deps.extensions ?? []) {
    // RevenueDot AI's in-process calls carry no cookie: they act with the session the turn came from.
    const sessionId = p.via === "assistant" ? ASSISTANT_CTX.get(c.req.raw)?.sessionId ?? null : getCookie(c, SESSION_COOKIE) ?? null;
    const a = await x.projectAccess?.({ deps, userId: p.userId, sessionId, projectId, role: m.role });
    if (a?.deny) throw new V2Error(a.deny.status, a.deny.status === 404 ? "resource_missing" : "authorization_error", a.deny.message);
    if (a?.permissions) permissions = a.permissions;
  }
  return { ...p, role: m.role, ...(permissions ? { permissions } : {}) };
}
