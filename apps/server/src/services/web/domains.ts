import { and, eq, ne } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

/**
 * Where hosted pages live (prd/web-billing/PRD.md §7).
 * - RevenueDot's domain: `<pay base>/<project slug>/<page slug>`. The pay base is `REVENUEDOT_PAY_URL` (Deps.payUrl), else
 *   `<request origin>/pay`. A pay URL without a path (https://pay.example.com) is served on that host at the root.
 * - A custom domain, once DNS proves it: `https://<domain>/<page slug>`.
 */

export const RESERVED_SLUGS = new Set(["api", "r", "pay", "www", "admin", "assets", "static", "app", "success", "cancel", "v1", "v2", "auth", "oauth", "rcbilling"]);
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export type DomainRow = typeof schema.webDomains.$inferSelect;

/** The project's web domain row, created with a slug from the project name the first time it is needed. */
export async function domainOf(db: DB, projectId: string, now: Date): Promise<DomainRow> {
  const [row] = await db.select().from(schema.webDomains).where(eq(schema.webDomains.projectId, projectId)).limit(1);
  if (row) return row;
  const [p] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  let base = slugify(p?.name ?? "") || "app";
  if (base.length < 3 || RESERVED_SLUGS.has(base)) base = `${base}-app`.replace(/^-/, "");
  for (let i = 0; i < 8; i++) {
    const slug = i === 0 ? base : `${base.slice(0, 33)}-${newId("", 6)}`;
    const [ins] = await db.insert(schema.webDomains).values({ projectId, slug, verificationToken: newId("", 24), createdAt: now }).onConflictDoNothing().returning();
    if (ins) return ins;
    const [again] = await db.select().from(schema.webDomains).where(eq(schema.webDomains.projectId, projectId)).limit(1);
    if (again) return again;
  }
  throw new Error("Could not pick a web slug for the project.");
}

export async function slugTaken(db: DB, slug: string, projectId: string) {
  const [r] = await db.select({ p: schema.webDomains.projectId }).from(schema.webDomains).where(and(eq(schema.webDomains.slug, slug), ne(schema.webDomains.projectId, projectId))).limit(1);
  return !!r;
}

/** The pay base without a trailing slash: Deps.payUrl, else `<origin>/pay`. */
export function payBaseOf(payUrl: string | undefined, origin: string): string {
  return (payUrl?.trim() || `${origin}/pay`).replace(/\/+$/, "");
}

/**
 * The pay base for links in emails (redemption links): configured URLs only (REVENUEDOT_PAY_URL, else REVENUEDOT_PUBLIC_URL),
 * never the request's Host or X-Forwarded-Host, which a caller chooses. The request origin is the last resort, for a server
 * with neither set (as password reset emails do).
 */
export function mailPayBase(deps: { payUrl?: string; publicUrl?: string }, requestOrigin: string): string {
  if (deps.payUrl?.trim()) return payBaseOf(deps.payUrl, requestOrigin);
  if (deps.publicUrl?.trim()) return `${deps.publicUrl.trim().replace(/\/+$/, "")}/pay`;
  return payBaseOf(undefined, requestOrigin);
}

/** The base under which one project's pages live (custom domain first, when verified). */
export function projectBase(payBase: string, d: Pick<DomainRow, "slug" | "customDomain" | "status">): string {
  if (d.customDomain && d.status === "verified") return `https://${d.customDomain}`;
  return `${payBase}/${d.slug}`;
}

/** The CNAME target custom domains point at: REVENUEDOT_CUSTOM_DOMAIN_TARGET, else the pay host. */
export function cnameTarget(customDomainTarget: string | undefined, payBase: string): string {
  if (customDomainTarget?.trim()) return customDomainTarget.trim().toLowerCase().replace(/\.$/, "");
  try { return new URL(payBase).hostname.toLowerCase(); } catch { return "localhost"; }
}

export const txtName = (domain: string) => `_revenuedot.${domain}`;
export const txtValue = (token: string) => `revenuedot-verify=${token}`;

interface DohAnswer { name?: string; type?: number; data?: string }
async function doh(fetchFn: typeof fetch, name: string, type: "CNAME" | "TXT"): Promise<string[]> {
  const res = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`The DNS resolver answered ${res.status}.`);
  const j = (await res.json()) as { Status?: number; Answer?: DohAnswer[] };
  const code = type === "CNAME" ? 5 : 16;
  return (j.Answer ?? []).filter((a) => a.type === code && typeof a.data === "string").map((a) => a.data!.replace(/^"|"$/g, "").replace(/"\s*"/g, "").trim());
}

/**
 * Checks the two DNS records: TXT `_revenuedot.<domain>` = `revenuedot-verify=<token>` (ownership) and a CNAME from the
 * domain to the target (traffic). Reads them through DNS over HTTPS, so it works on Workers and Node alike.
 */
export async function verifyDomain(fetchFn: typeof fetch, d: DomainRow, target: string): Promise<{ ok: boolean; error: string | null; cname: string[]; txt: string[] }> {
  if (!d.customDomain) return { ok: false, error: "No custom domain is set.", cname: [], txt: [] };
  let cname: string[] = [], txt: string[] = [];
  try {
    [cname, txt] = await Promise.all([doh(fetchFn, d.customDomain, "CNAME"), doh(fetchFn, txtName(d.customDomain), "TXT")]);
  } catch (e) {
    return { ok: false, error: `DNS could not be checked: ${e instanceof Error ? e.message : String(e)} Try again in a minute.`, cname, txt };
  }
  const want = txtValue(d.verificationToken);
  if (!txt.includes(want)) return { ok: false, error: `The TXT record ${txtName(d.customDomain)} must be "${want}"${txt.length ? `; it is ${txt.map((t) => `"${t}"`).join(", ")}` : " and was not found"}. DNS changes can take a few minutes.`, cname, txt };
  const hosts = cname.map((c) => c.toLowerCase().replace(/\.$/, ""));
  if (!hosts.includes(target)) return { ok: false, error: `${d.customDomain} must be a CNAME to ${target}${hosts.length ? `; it points to ${hosts.join(", ")}` : " and no CNAME was found"}. Use a subdomain such as pay.yourapp.com.`, cname, txt };
  return { ok: true, error: null, cname, txt };
}

/** Verified custom domains by host, cached for a minute (the host check runs on requests that are not API paths). */
const cache = new Map<string, { at: number; projectSlug: string | null }>();
export async function projectForHost(db: DB, host: string, nowMs: number): Promise<string | null> {
  const hit = cache.get(host);
  if (hit && nowMs - hit.at < 60_000) return hit.projectSlug;
  const [row] = await db.select({ slug: schema.webDomains.slug }).from(schema.webDomains).where(and(eq(schema.webDomains.customDomain, host), eq(schema.webDomains.status, "verified"))).limit(1);
  const projectSlug = row?.slug ?? null;
  if (cache.size > 1000) cache.clear();
  cache.set(host, { at: nowMs, projectSlug });
  return projectSlug;
}
export const forgetHost = (host: string | null | undefined) => { if (host) cache.delete(host); };
