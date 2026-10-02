// RevenueDot Enterprise (ee/LICENSE). Licence keys, audit retention and signed compliance exports.
// Spec: prd/enterprise/PRD.md §2, §9, §10.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { eeServer, type EeServer } from "./helpers.js";
import { checkLicense, issueLicense, GRACE_DAYS } from "../server/license.js";
import { createEnterprise, enterpriseExtension } from "../server/index.js";
import { generateSigningKeyPair } from "../../apps/server/src/services/signing.js";
import { eeOrgAuditLogs } from "../server/schema.js";
import { toCsv, verifyExport } from "../server/exports.js";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });
const DAY = 86_400_000;

describe("licence keys", () => {
  it("accepts a key signed by a pinned key, refuses tampering, other signers, wrong edition and expiry after the grace period", async () => {
    const issuer = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const now = Date.now();
    const payload = { v: 1 as const, id: "lic_1", licensee: "Acme Inc.", features: ["sso", "scim"], max_orgs: 2, edition: "self-hosted" as const, issued_at: now, expires_at: now + 30 * DAY };
    const key = await issueLicense(issuer.privateKey, payload);
    const ok = await checkLicense({ key, now, publicKeys: [issuer.publicKey], edition: "self-hosted" });
    // Every feature lives in an organization, so organizations comes with any of them.
    expect(ok).toMatchObject({ mode: "licensed", features: ["organizations", "sso", "scim"], licensee: "Acme Inc.", maxOrgs: 2, message: null });
    // Not pinned in this build, signed by someone else, edited, or for the other edition.
    expect((await checkLicense({ key, now })).mode).toBe("invalid");
    expect((await checkLicense({ key: await issueLicense(other.privateKey, payload), now, publicKeys: [issuer.publicKey] })).message).toContain("signature");
    const [body, sig] = key.slice(5).split(".");
    const forged = `rdl1_${Buffer.from(JSON.stringify({ ...payload, features: ["*"] })).toString("base64url")}.${sig}`;
    expect((await checkLicense({ key: forged, now, publicKeys: [issuer.publicKey] })).mode).toBe("invalid");
    expect(body).toBeTruthy();
    expect((await checkLicense({ key, now, publicKeys: [issuer.publicKey], edition: "cloud" })).message).toContain("self-hosted");
    // Expired: a warning during the grace period, then off.
    const late = await checkLicense({ key, now: now + 31 * DAY, publicKeys: [issuer.publicKey] });
    expect(late.mode).toBe("licensed");
    expect(late.message).toContain("Renew");
    expect((await checkLicense({ key, now: now + (31 + GRACE_DAYS) * DAY, publicKeys: [issuer.publicKey] })).features).toEqual([]);
    // "*" means every feature.
    const all = await checkLicense({ key: await issueLicense(issuer.privateKey, { ...payload, features: ["*"], edition: "any" }), now, publicKeys: [issuer.publicKey], edition: "cloud" });
    expect(all.features).toHaveLength(7);
  });

  it("development mode turns everything on except on Cloud", async () => {
    expect((await checkLicense({ dev: true, now: 0 })).mode).toBe("development");
    expect((await checkLicense({ dev: true, now: 0, edition: "cloud" })).mode).toBe("invalid");
    expect((await createEnterprise({ env: {} })).status().mode).toBe("invalid");
  });

  it("an invalid licence mounts no routes and reports itself to signed-in users", async () => {
    s = await eeServer({ extension: enterpriseExtension({ mode: "invalid", features: [], licensee: null, expiresAt: null, maxOrgs: null, message: "No licence key." }) });
    const o = await s.signup("owner@acme.test");
    expect((await o.browser.call("POST", "/v2/organizations", { name: "Acme" })).status).toBe(404);
    expect((await o.browser.call("GET", "/v2/enterprise")).body).toMatchObject({ mode: "invalid", features: [], message: "No licence key." });
    expect((await s.browser().call("GET", "/v2/enterprise")).status).toBe(401);
  });

  it("a licence limits the number of organizations and the features", async () => {
    s = await eeServer({ extension: enterpriseExtension({ mode: "licensed", features: ["organizations"], licensee: "Acme", expiresAt: null, maxOrgs: 1, message: null }) });
    const o = await s.signup("owner@acme.test");
    expect((await o.browser.call("POST", "/v2/organizations", { name: "One" })).status).toBe(201);
    expect((await o.browser.call("POST", "/v2/organizations", { name: "Two" })).status).toBe(403);
    const orgId = (await o.browser.call("GET", "/v2/organizations")).body.items[0].id;
    expect((await o.browser.call("GET", `/v2/organizations/${orgId}/roles`)).status).toBe(403);
    expect((await o.browser.call("GET", `/v2/organizations/${orgId}/exports/access_review`)).status).toBe(403);
    expect((await s.browser().call("GET", "/scim/v2/Users")).status).toBe(404);
  });
});

describe("audit retention", () => {
  it("deletes organization and project audit rows older than the retention, hourly, and logs the purge", async () => {
    s = await eeServer();
    const o = await s.signup("owner@acme.test");
    const orgId = await s.createOrg(o.browser, "Acme", [o.projectId]);
    const other = await s.signup("solo@other.test");
    const old = new Date(s.now().getTime() - 400 * DAY), recent = new Date(s.now().getTime() - 10 * DAY);
    await s.db.insert(schema.auditLogs).values([
      { id: "a1", projectId: o.projectId, actionType: "product_created", targetType: "product", targetIdentifier: "p1", actorType: "user", actorIdentifier: o.userId, occurredAt: old },
      { id: "a2", projectId: o.projectId, actionType: "product_created", targetType: "product", targetIdentifier: "p2", actorType: "user", actorIdentifier: o.userId, occurredAt: recent },
      { id: "a3", projectId: other.projectId, actionType: "product_created", targetType: "product", targetIdentifier: "p3", actorType: "user", actorIdentifier: other.userId, occurredAt: old },
    ]);
    await s.db.insert(eeOrgAuditLogs).values({ id: "o1", orgId, action: "member_added", actorType: "user", actorId: o.userId, targetType: "user", targetId: o.userId, occurredAt: old });
    // Forever by default: nothing goes.
    await s.tick();
    expect((await s.db.select().from(schema.auditLogs)).map((r) => r.id).sort()).toEqual(["a1", "a2", "a3"]);
    // Only owners shorten retention.
    expect((await o.browser.call("POST", `/v2/organizations/${orgId}`, { audit_retention_days: 365 })).status).toBe(200);
    s.advance(2 * 3_600_000);
    const r = await s.tick();
    expect(r.extensions).toEqual({ audit_rows_purged: 2 });
    expect((await s.db.select().from(schema.auditLogs)).map((r) => r.id).sort()).toEqual(["a2", "a3"]);
    const left = await s.db.select().from(eeOrgAuditLogs).where(eq(eeOrgAuditLogs.orgId, orgId));
    expect(left.find((x) => x.id === "o1")).toBeUndefined();
    expect(left.find((x) => x.action === "audit_logs_purged")?.data).toMatchObject({ rows: 2, retention_days: 365 });
    // At most once an hour.
    expect((await s.tick()).extensions).toEqual({});
  });
});

describe("compliance exports", () => {
  it("exports the audit log and an access review as signed CSV and JSON", async () => {
    s = await eeServer({ deps: { signingKey: (await generateSigningKeyPair()).privateKey } });
    const o = await s.signup("owner@acme.test");
    const orgId = await s.createOrg(o.browser, "Acme", [o.projectId]);
    const O = `/v2/organizations/${orgId}`;
    const role = await o.browser.call("POST", `${O}/roles`, { name: "Support", scopes: ["customer_information:customers:read"] });
    const dev = await s.signup("dev@acme.test", "Own");
    await s.db.insert(schema.memberships).values({ userId: dev.userId, projectId: o.projectId, role: role.body.id });
    await o.browser.call("POST", `/v2/projects/${o.projectId}/entitlements`, { lookup_key: "=cmd|calc", display_name: "Pro" });
    const key = (await o.browser.call("GET", `${O}/exports/public_key`)).body;
    expect(key).toMatchObject({ algorithm: "Ed25519", signs: true });

    const csv = await o.browser.call("GET", `${O}/exports/audit_logs?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename="revenuedot-audit-logs-org_/);
    const sig = csv.headers.get("x-revenuedot-signature")!.replace(/^ed25519=/, "");
    const bytes = new TextEncoder().encode(csv.text);
    expect(await verifyExport(key.public_key, bytes, sig)).toBe(true);
    expect(await verifyExport(key.public_key, new TextEncoder().encode(csv.text.replace("owner@", "other@")), sig)).toBe(false);
    expect(csv.headers.get("x-revenuedot-content-sha256")).toMatch(/^[0-9a-f]{64}$/);
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]).toBe("occurred_at,scope,project_id,project_name,action,actor_type,actor_id,actor_email,target_type,target_id,details");
    expect(csv.text).toContain("organization_created");
    expect(csv.text).toContain("entitlement_created");
    expect(csv.text).toContain("owner@acme.test");

    const review = await o.browser.call("GET", `${O}/exports/access_review?format=json`);
    expect(await verifyExport(key.public_key, new TextEncoder().encode(review.text), review.headers.get("x-revenuedot-signature")!.slice(8))).toBe(true);
    expect(review.body).toMatchObject({ object: "compliance_export", kind: "access_review", organization: { id: orgId, name: "Acme" }, row_count: 2 });
    const devRow = review.body.rows.find((r: any) => r.email === "dev@acme.test");
    expect(devRow).toMatchObject({ project_role: role.body.id, project_role_name: "Support", permissions: "customer_information:customers:read", granted_by: "manual", password_sign_in: true, organization_role: "" });
    expect(review.body.rows.find((r: any) => r.email === "owner@acme.test")).toMatchObject({ organization_role: "owner", project_role: "admin", granted_by: "manual" });
    // Exports are logged with their digest; members who are not admins cannot export.
    const logs = await o.browser.call("GET", `${O}/audit_logs`);
    expect(logs.body.items.filter((x: any) => x.action === "compliance_export_created")).toHaveLength(2);
    expect((await dev.browser.call("GET", `${O}/exports/audit_logs`)).status).toBe(404);
    expect((await o.browser.call("GET", `${O}/exports/audit_logs?format=xml`)).status).toBe(400);
  });

  it("CSV quotes and neutralises spreadsheet formulas", () => {
    expect(toCsv(["a", "b"], [{ a: "=SUM(A1)", b: 'say "hi", ok' }, { a: null, b: { x: 1 } }])).toBe('a,b\r\n\'=SUM(A1),"say ""hi"", ok"\r\na,"{""x"":1}"\r\n'.replace("\r\na,", "\r\n,"));
  });
});
