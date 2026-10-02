import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { digestKey, verifyDigestToken } from "../services/insights/digest.js";
import { page } from "./lifecycle-public.js";

/**
 * The one-click opt-out in the weekly insights digest (prd/attribution-benchmarks-insights §3), no sign-in:
 * GET shows a button (mail scanners follow links, so a GET changes nothing); POST turns the digest off for that person,
 * also as RFC 8058 one-click from the List-Unsubscribe header. Turn it back on in Account settings.
 */
export function insightsPublicRoutes(deps: Deps) {
  const r = new Hono();
  const P = "/auth/insights/unsubscribe";
  const who = async (token: string | undefined) => {
    const userId = token ? await verifyDigestToken(token, digestKey(deps)) : null;
    if (!userId) return null;
    const [u] = await deps.db.select({ id: schema.users.id, email: schema.users.email, on: schema.users.insightsEmails }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    return u ?? null;
  };
  r.get(P, async (c) => {
    const u = await who(c.req.query("token"));
    if (!u) return c.html(page("Link not valid", "This link is not valid. Turn the weekly digest off in Account settings instead."), 404);
    if (!u.on) return c.html(page("The digest is off", `${u.email} gets no weekly insights digest. Turn it back on in Account settings.`));
    return c.html(page("Stop the weekly digest?", `${u.email} will stop getting the weekly growth insights email for every project.`, `<form method="post"><button type="submit">Stop the digest</button></form>`));
  });
  r.post(P, async (c) => {
    const u = await who(c.req.query("token"));
    if (!u) return c.html(page("Link not valid", "This link is not valid. Turn the weekly digest off in Account settings instead."), 404);
    await deps.db.update(schema.users).set({ insightsEmails: false }).where(eq(schema.users.id, u.id));
    return c.html(page("The digest is off", `${u.email} gets no more weekly insights emails. Turn it back on in Account settings.`));
  });
  return r;
}
