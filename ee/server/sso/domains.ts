// RevenueDot Enterprise (ee/LICENSE). Email domains an organization proves it owns with a DNS TXT record; single sign-on
// and its enforcement apply only to addresses on these domains. Spec: prd/enterprise/PRD.md §5.
//
//   GET    /v2/organizations/{org_id}/sso/domains                          the organization's domains
//   POST   /v2/organizations/{org_id}/sso/domains                          add one {domain}
//   POST   /v2/organizations/{org_id}/sso/domains/{domain}/actions/verify  check the TXT record over DNS over HTTPS
//   DELETE /v2/organizations/{org_id}/sso/domains/{domain}
import type { Context, Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { body, listOf } from "../../../apps/server/src/routes/v2/common.js";
import { DOMAIN } from "../../../apps/server/src/services/web/domains.js";
import { hit } from "../../../apps/server/src/services/rate-limit.js";
import { eeSsoDomains } from "../schema.js";
import { V2Error, ms, orgAudit, sha256Hex, type EeCtx } from "../util.js";

/** Mail providers anyone can sign up with: owning an address there proves nothing about an organization. */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "yahoo.com", "yahoo.co.uk",
  "yahoo.co.jp", "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.de", "gmx.net", "web.de", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "126.com", "sina.com",
  "foxmail.com", "naver.com", "hanmail.net", "zoho.com", "zohomail.com", "fastmail.com", "tutanota.com", "tuta.io", "hey.com",
  "mail.com", "inbox.com", "duck.com", "orange.fr", "free.fr", "libero.it", "rediffmail.com", "seznam.cz", "t-online.de",
]);

export const txtName = (domain: string) => `_revenuedot-sso.${domain}`;
export const txtValue = (token: string) => `revenuedot-sso-verification=${token}`;

/**
 * The token depends only on the organization and the domain. An unverified claim never blocks another organization,
 * so if someone else adds the same domain in the meantime, the real owner adds it again and its TXT record still works.
 * Knowing the token does not help anyone: only the domain's owner can publish it.
 */
const tokenFor = async (orgId: string, domain: string) => (await sha256Hex(`revenuedot-sso:${orgId}:${domain}`)).slice(0, 32);

export const normDomain = (d: string) => d.trim().toLowerCase().replace(/\.$/, "");

type DomainRow = typeof eeSsoDomains.$inferSelect;
export const domainShape = (d: DomainRow) => ({
  object: "sso_domain", domain: d.domain, verified: !!d.verifiedAt, verified_at: ms(d.verifiedAt),
  txt_record: { type: "TXT", name: txtName(d.domain), value: txtValue(d.token) },
  last_checked_at: ms(d.lastCheckedAt), last_error: d.lastError, created_at: d.createdAt.getTime(),
});

/** TXT records through DNS over HTTPS (the same resolver as custom web domains), so it runs on Workers and Node alike. */
export async function lookupTxt(fetchFn: typeof fetch, name: string): Promise<string[]> {
  const res = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`The DNS resolver answered ${res.status}.`);
  const j = (await res.json()) as { Answer?: { type?: number; data?: string }[] };
  return (j.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === "string").map((a) => a.data!.replace(/^"|"$/g, "").replace(/"\s*"/g, "").trim());
}

const DomainBody = z.object({ domain: z.string().trim().min(1).max(253) });

/** Registers the domain routes on the SSO router. `admin` checks the session and the organization role. */
export function domainRoutes(ctx: EeCtx, r: Hono, admin: (c: Context) => Promise<{ user: { id: string }; org: { id: string } }>) {
  const { deps } = ctx;
  const { db } = deps;
  const O = "/v2/organizations/:org_id/sso/domains";
  const audit = (orgId: string, userId: string, action: string, domain: string, data?: Record<string, unknown>) =>
    orgAudit(db, deps.now(), { orgId, action, actor: { type: "user", id: userId }, target: { type: "sso_domain", id: domain }, data });
  const own = async (orgId: string, domain: string) => {
    const [row] = await db.select().from(eeSsoDomains).where(and(eq(eeSsoDomains.domain, normDomain(domain)), eq(eeSsoDomains.orgId, orgId))).limit(1);
    if (!row) throw new V2Error(404, "resource_missing", "Domain not found.");
    return row;
  };

  r.get(O, async (c) => {
    const m = await admin(c);
    const rows = await db.select().from(eeSsoDomains).where(eq(eeSsoDomains.orgId, m.org.id)).orderBy(eeSsoDomains.createdAt);
    return c.json(listOf(c, rows.map(domainShape), null));
  });

  r.post(O, async (c) => {
    const m = await admin(c);
    const domain = normDomain((await body(c, DomainBody)).domain);
    if (!DOMAIN.test(domain)) throw new V2Error(400, "parameter_error", "Enter a domain such as example.com.", "domain");
    if (PUBLIC_EMAIL_DOMAINS.has(domain)) throw new V2Error(400, "parameter_error", `${domain} is a public email provider. Add a domain your organization owns.`, "domain");
    const now = deps.now();
    const token = await tokenFor(m.org.id, domain);
    const [existing] = await db.select().from(eeSsoDomains).where(eq(eeSsoDomains.domain, domain)).limit(1);
    if (existing?.orgId === m.org.id) return c.json(domainShape(existing), 200);
    if (existing?.verifiedAt) throw new V2Error(409, "resource_already_exists", "Another organization verified this domain.", "domain");
    // Only a verified claim blocks: anyone can type a domain, only its owner can publish the TXT record.
    if (existing) await db.delete(eeSsoDomains).where(and(eq(eeSsoDomains.domain, domain), eq(eeSsoDomains.orgId, existing.orgId)));
    const [row] = await db.insert(eeSsoDomains).values({ domain, orgId: m.org.id, token, createdAt: now }).onConflictDoNothing().returning();
    if (!row) throw new V2Error(409, "resource_already_exists", "Another organization added this domain at the same moment. Try again.", "domain");
    await audit(m.org.id, m.user.id, "sso_domain_added", domain);
    return c.json(domainShape(row), 201);
  });

  r.post(`${O}/:domain/actions/verify`, async (c) => {
    const m = await admin(c);
    const d = await own(m.org.id, c.req.param("domain")!);
    const now = deps.now();
    if (!(await hit(db, `sso-domain-verify:${m.org.id}`, 10, 60_000, now))) throw new V2Error(429, "rate_limit_error", "Wait a minute before checking again.", undefined, true);
    let found: string[] = [];
    let error: string | null = null;
    try {
      found = await lookupTxt(deps.fetch ?? fetch, txtName(d.domain));
      const want = txtValue(d.token);
      if (!found.includes(want)) error = `The TXT record ${txtName(d.domain)} must be "${want}"${found.length ? `; it is ${found.map((t) => `"${t}"`).join(", ")}` : " and was not found"}. DNS changes can take a few minutes.`;
    } catch (e) {
      error = `DNS could not be checked: ${e instanceof Error ? e.message : String(e)} Try again in a minute.`;
    }
    const verifiedAt = error ? d.verifiedAt : d.verifiedAt ?? now;
    const [row] = await db.update(eeSsoDomains).set({ verifiedAt, lastCheckedAt: now, lastError: error })
      .where(and(eq(eeSsoDomains.domain, d.domain), eq(eeSsoDomains.orgId, m.org.id))).returning();
    if (!row) throw new V2Error(404, "resource_missing", "Domain not found.");
    if (!error && !d.verifiedAt) await audit(m.org.id, m.user.id, "sso_domain_verified", d.domain);
    return c.json({ ...domainShape(row), found: { txt: found } });
  });

  r.delete(`${O}/:domain`, async (c) => {
    const m = await admin(c);
    const d = await own(m.org.id, c.req.param("domain")!);
    await db.delete(eeSsoDomains).where(and(eq(eeSsoDomains.domain, d.domain), eq(eeSsoDomains.orgId, m.org.id)));
    await audit(m.org.id, m.user.id, "sso_domain_removed", d.domain, { was_verified: !!d.verifiedAt });
    return c.json({ object: "sso_domain", domain: d.domain, deleted: true });
  });
}
