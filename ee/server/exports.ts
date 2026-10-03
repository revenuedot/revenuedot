// RevenueDot Enterprise (ee/LICENSE). Compliance exports: the audit log and an access review, as CSV or JSON, signed
// with Ed25519 so an auditor can prove a file came from this server unchanged. Spec: prd/enterprise/PRD.md §10.
import type { Context, Hono } from "hono";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { fromBase64, toBase64 } from "../../apps/server/src/services/signing.js";
import { paramError } from "../../apps/server/src/routes/v2/common.js";
import { eeCustomRoles, eeMembershipSources, eeOrgAuditLogs, eeOrgMembers, eeScimUsers, eeSsoSessions } from "./schema.js";
import { needFeature, orgAudit, sha256Hex, type EeCtx } from "./util.js";
import type { Feature } from "./license.js";

/** Rows per export; narrow the dates for more. */
export const EXPORT_MAX_ROWS = 200_000;
export const SIGNATURE_HEADER = "X-RevenueDot-Signature";
export const KEY_ID_HEADER = "X-RevenueDot-Key-Id";
export const DIGEST_HEADER = "X-RevenueDot-Content-SHA256";

const ED25519 = { name: "Ed25519" } as const;
const PKCS8_ED25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

interface ExportKey { privateKey: CryptoKey; publicKey: string; keyId: string }
const keys = new Map<string, Promise<ExportKey | null>>();

/**
 * The export signing key: an Ed25519 key derived (HKDF-SHA256) from REVENUEDOT_SIGNING_KEY, else from
 * REVENUEDOT_ENCRYPTION_KEY. Never the response-signing key itself, so the two cannot sign for each other.
 * A server with neither cannot sign exports and says so.
 */
export function exportKey(o: { signingKey?: string; encryptionKey?: string }): Promise<ExportKey | null> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const material = (o.signingKey || env.REVENUEDOT_SIGNING_KEY || o.encryptionKey || env.REVENUEDOT_ENCRYPTION_KEY || "").trim();
  let p = keys.get(material);
  if (!p) {
    p = (async () => {
      if (!material) return null;
      const ikm = await crypto.subtle.importKey("raw", fromBase64(material), "HKDF", false, ["deriveBits"]);
      const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("revenuedot"), info: new TextEncoder().encode("compliance exports v1") }, ikm, 256));
      const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
      pkcs8.set(PKCS8_ED25519_PREFIX); pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
      const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, ED25519, true, ["sign"]);
      const jwk = await crypto.subtle.exportKey("jwk", privateKey);
      const publicKey = toBase64(fromBase64(jwk.x!));
      return { privateKey: await crypto.subtle.importKey("pkcs8", pkcs8, ED25519, false, ["sign"]), publicKey, keyId: (await sha256Hex(publicKey)).slice(0, 16) };
    })();
    keys.set(material, p);
  }
  return p;
}

/** Verifies an export (tests, and the snippet in the docs does the same with openssl or Node). */
export async function verifyExport(publicKeyB64: string, bytes: Uint8Array, signatureB64: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", fromBase64(publicKeyB64), ED25519, false, ["verify"]);
  return crypto.subtle.verify(ED25519, key, fromBase64(signatureB64), bytes as Uint8Array<ArrayBuffer>);
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula (=, +, -, @, tab, CR) get a leading apostrophe. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

const AUDIT_COLUMNS = ["occurred_at", "scope", "project_id", "project_name", "action", "actor_type", "actor_id", "actor_email", "target_type", "target_id", "details"];
const ACCESS_COLUMNS = ["user_id", "email", "name", "organization_role", "organization_member_source", "active", "project_id", "project_name", "project_role", "project_role_name", "permissions", "granted_by", "password_sign_in", "last_sso_sign_in", "scim_provisioned", "scim_active"];

const BUILTIN_PERMISSIONS: Record<string, string> = {
  admin: "everything, including members and secret API keys",
  developer: "everything except members and secret API keys",
  viewer: "read only",
};

type Helpers = {
  member: (c: Context) => Promise<{ user: { id: string; email: string }; org: { id: string; name: string }; features: Set<Feature> }>;
  orgProjects: (orgId: string) => Promise<{ projectId: string; name: string; region: string }[]>;
};

export function exportRoutes(r: Hono, ctx: EeCtx, h: Helpers) {
  const { deps } = ctx;
  const { db } = deps;
  const O = "/v2/organizations/:org_id";

  r.get(`${O}/exports/public_key`, async (c) => {
    const m = await h.member(c);
    needFeature(ctx, "compliance_exports", m.features);
    const k = await exportKey(deps);
    return c.json({ object: "export_signing_key", algorithm: "Ed25519", public_key: k?.publicKey ?? null, key_id: k?.keyId ?? null, signs: !!k });
  });

  r.get(`${O}/exports/:kind`, async (c) => {
    const m = await h.member(c);
    needFeature(ctx, "compliance_exports", m.features);
    const kind = c.req.param("kind");
    if (kind !== "audit_logs" && kind !== "access_review") throw paramError("kind must be audit_logs or access_review.", "kind");
    const format = c.req.query("format") ?? "csv";
    if (format !== "csv" && format !== "json") throw paramError("format must be csv or json.", "format");
    const now = deps.now();
    const projects = await h.orgProjects(m.org.id);
    const projectName = new Map(projects.map((p) => [p.projectId, p.name]));
    let columns: string[], rows: Record<string, unknown>[];
    const range = { start: null as Date | null, end: null as Date | null };
    if (kind === "audit_logs") {
      const s = c.req.query("start_time"), e = c.req.query("end_time");
      if (s) { const n = Number(s); if (!Number.isFinite(n)) throw paramError("start_time must be milliseconds since 1970.", "start_time"); range.start = new Date(n); }
      if (e) { const n = Number(e); if (!Number.isFinite(n)) throw paramError("end_time must be milliseconds since 1970.", "end_time"); range.end = new Date(n); }
      const orgConds = [eq(eeOrgAuditLogs.orgId, m.org.id)];
      if (range.start) orgConds.push(gte(eeOrgAuditLogs.occurredAt, range.start));
      if (range.end) orgConds.push(lt(eeOrgAuditLogs.occurredAt, range.end));
      const own = await db.select().from(eeOrgAuditLogs).where(and(...orgConds)).orderBy(asc(eeOrgAuditLogs.occurredAt)).limit(EXPORT_MAX_ROWS + 1);
      const ids = projects.map((p) => p.projectId);
      const projConds = [inArray(schema.auditLogs.projectId, ids.length ? ids : ["-"])];
      if (range.start) projConds.push(gte(schema.auditLogs.occurredAt, range.start));
      if (range.end) projConds.push(lt(schema.auditLogs.occurredAt, range.end));
      const proj = ids.length ? await db.select().from(schema.auditLogs).where(and(...projConds)).orderBy(asc(schema.auditLogs.occurredAt)).limit(EXPORT_MAX_ROWS + 1) : [];
      if (own.length + proj.length > EXPORT_MAX_ROWS) throw paramError(`More than ${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows; choose a shorter date range.`, "start_time");
      const actorIds = [...own.map((x) => x.actorId), ...proj.filter((x) => x.actorType === "user" || x.actorType === "assistant").map((x) => x.actorIdentifier)].filter((x): x is string => !!x);
      const emails = actorIds.length ? new Map((await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, [...new Set(actorIds)]))).map((u) => [u.id, u.email])) : new Map<string, string>();
      rows = [
        ...own.map((x) => ({ at: x.occurredAt.getTime(), occurred_at: x.occurredAt.toISOString(), scope: "organization", project_id: "", project_name: "", action: x.action, actor_type: x.actorType, actor_id: x.actorId ?? "", actor_email: x.actorId ? emails.get(x.actorId) ?? "" : "", target_type: x.targetType, target_id: x.targetId ?? "", details: x.data })),
        ...proj.map((x) => ({ at: x.occurredAt.getTime(), occurred_at: x.occurredAt.toISOString(), scope: "project", project_id: x.projectId, project_name: projectName.get(x.projectId) ?? "", action: x.actionType, actor_type: x.actorType, actor_id: x.actorIdentifier, actor_email: emails.get(x.actorIdentifier) ?? "", target_type: x.targetType, target_id: x.targetIdentifier, details: x.additionalData })),
      ].sort((a, b) => a.at - b.at).map(({ at: _at, ...rest }) => rest);
      columns = AUDIT_COLUMNS;
    } else {
      rows = await accessReview(m.org.id, projects);
      columns = ACCESS_COLUMNS;
    }
    const generatedAt = now.toISOString();
    const text = format === "csv"
      ? toCsv(columns, rows)
      : JSON.stringify({ object: "compliance_export", kind, organization: { id: m.org.id, name: m.org.name }, generated_at: generatedAt, generated_by: m.user.email, start_time: range.start?.toISOString() ?? null, end_time: range.end?.toISOString() ?? null, row_count: rows.length, columns, rows }, null, 2);
    const bytes = new TextEncoder().encode(text);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    const key = await exportKey(deps);
    const signature = key ? toBase64(new Uint8Array(await crypto.subtle.sign(ED25519, key.privateKey, bytes))) : null;
    await orgAudit(db, now, { orgId: m.org.id, action: "compliance_export_created", actor: { type: "user", id: m.user.id }, target: { type: "export", id: kind }, data: { format, rows: rows.length, sha256: digest, signed: !!signature, start_time: range.start?.toISOString() ?? null, end_time: range.end?.toISOString() ?? null } });
    const stamp = generatedAt.slice(0, 19).replace(/[:T]/g, "-");
    const headers: Record<string, string> = {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="revenuedot-${kind.replace(/_/g, "-")}-${m.org.id}-${stamp}.${format}"`,
      [DIGEST_HEADER]: digest,
      "cache-control": "no-store",
      "access-control-expose-headers": `${SIGNATURE_HEADER}, ${KEY_ID_HEADER}, ${DIGEST_HEADER}`,
    };
    if (signature && key) { headers[SIGNATURE_HEADER] = `ed25519=${signature}`; headers[KEY_ID_HEADER] = key.keyId; }
    return new Response(bytes, { status: 200, headers });
  });

  /** One row per person per organization project they can open, plus members with no project access. */
  async function accessReview(orgId: string, projects: { projectId: string; name: string }[]) {
    const ids = projects.map((p) => p.projectId);
    const members = await db.select({ m: eeOrgMembers, u: schema.users }).from(eeOrgMembers).innerJoin(schema.users, eq(schema.users.id, eeOrgMembers.userId)).where(eq(eeOrgMembers.orgId, orgId));
    const memberships = ids.length ? await db.select({ m: schema.memberships, u: schema.users }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(inArray(schema.memberships.projectId, ids)) : [];
    const sources = ids.length ? await db.select().from(eeMembershipSources).where(inArray(eeMembershipSources.projectId, ids)) : [];
    const src = new Map(sources.map((s) => [`${s.projectId}|${s.userId}`, s.source]));
    const roles = new Map((await db.select().from(eeCustomRoles).where(eq(eeCustomRoles.orgId, orgId))).map((r) => [r.id, r]));
    const scim = new Map((await db.select().from(eeScimUsers).where(eq(eeScimUsers.orgId, orgId))).map((s) => [s.userId, s]));
    const sso = await db.select({ userId: eeSsoSessions.userId, at: eeSsoSessions.createdAt }).from(eeSsoSessions).where(eq(eeSsoSessions.orgId, orgId));
    const lastSso = new Map<string, Date>();
    for (const s of sso) if (!lastSso.get(s.userId) || lastSso.get(s.userId)! < s.at) lastSso.set(s.userId, s.at);
    const memberOf = new Map(members.map((x) => [x.u.id, x.m]));
    const pname = new Map(projects.map((p) => [p.projectId, p.name]));
    const person = (u: typeof schema.users.$inferSelect) => {
      const om = memberOf.get(u.id), s = scim.get(u.id);
      const last = [om?.lastSsoAt, lastSso.get(u.id)].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        user_id: u.id, email: u.email, name: u.name ?? "", organization_role: om?.role ?? "", organization_member_source: om?.source ?? "", active: om ? om.active : true,
        password_sign_in: !!u.passwordHash, last_sso_sign_in: last ? last.toISOString() : "", scim_provisioned: !!s, scim_active: s ? s.active : "",
      };
    };
    const rows: Record<string, unknown>[] = memberships.map((x) => {
      const role = x.m.role;
      const custom = roles.get(role);
      return {
        ...person(x.u), project_id: x.m.projectId, project_name: pname.get(x.m.projectId) ?? "", project_role: role,
        project_role_name: custom?.name ?? (role in BUILTIN_PERMISSIONS ? role[0]!.toUpperCase() + role.slice(1) : "No access (role removed)"),
        permissions: custom ? custom.scopes.join(" ") : BUILTIN_PERMISSIONS[role] ?? "none",
        granted_by: src.get(`${x.m.projectId}|${x.u.id}`) ?? "manual",
      };
    });
    const withAccess = new Set(memberships.map((x) => x.u.id));
    for (const x of members) if (!withAccess.has(x.u.id)) rows.push({ ...person(x.u), project_id: "", project_name: "", project_role: "", project_role_name: "", permissions: "", granted_by: "" });
    return rows.sort((a, b) => String(a.email).localeCompare(String(b.email)) || String(a.project_name).localeCompare(String(b.project_name)));
  }
}
