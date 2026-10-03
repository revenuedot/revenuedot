// RevenueDot Enterprise (ee/LICENSE). Which plan gets which feature (company decision 2026-10-02): on RevenueDot Cloud
// the account's plan decides per organization (Free: none; Standard: organizations, custom roles, single sign-on;
// Enterprise: everything); self-hosted servers keep the licence key. Spec: prd/enterprise/PRD.md §2a.
import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createEnterprise, enterpriseExtension } from "../server/index.js";
import { checkLicense } from "../server/license.js";
import { eeOrgAuditLogs } from "../server/schema.js";
import { loadExtensions } from "../../apps/server/src/extensions.js";
import { eeServer, type EeServer } from "./helpers.js";
import { IDP, addVerifiedDomain, dnsFetch, type FakeDns } from "./saml-idp.js";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const DAY = 86_400_000;
const STANDARD_LOCKED = [
  { feature: "scim", plan: "enterprise" }, { feature: "data_location", plan: "enterprise" },
  { feature: "audit_retention", plan: "enterprise" }, { feature: "compliance_exports", plan: "enterprise" },
];
const samlBody = { idp_entity_id: IDP.entityId, idp_sso_url: IDP.ssoUrl, idp_certificates: [IDP.cert], allow_idp_initiated: true };

/** A RevenueDot Cloud server: the extension as the Worker builds it (no licence key). */
async function cloud(dns: FakeDns = new Map()) {
  s = await eeServer({ extension: await createEnterprise({ env: {}, edition: "cloud" }), deps: { edition: "cloud" }, fetch: dnsFetch(dns) });
  return s;
}
const setPlan = (x: EeServer, userId: string, plan: "free" | "standard" | "enterprise") =>
  x.db.insert(schema.billingAccounts).values({ userId, plan, status: plan === "free" ? "none" : "active" })
    .onConflictDoUpdate({ target: schema.billingAccounts.userId, set: { plan, status: plan === "free" ? "canceled" : "active" } });

describe("RevenueDot Cloud: Free", () => {
  it("loads without a licence key, shows every feature as locked with the plan that has it, and refuses to create an organization", async () => {
    const x = await cloud();
    const free = await x.signup("free@acme.test");
    const me = await free.browser.call("GET", "/auth/me");
    expect(me.body.enterprise).toMatchObject({ mode: "cloud", plan: "free", features: [], organizations: [] });
    expect(me.body.enterprise.locked).toEqual([
      { feature: "organizations", plan: "standard" }, { feature: "custom_roles", plan: "standard" }, { feature: "sso", plan: "standard" }, ...STANDARD_LOCKED,
    ]);
    expect((await free.browser.call("GET", "/v2/enterprise")).body).toMatchObject({ object: "enterprise", mode: "cloud", plan: "free", features: [] });
    expect((await free.browser.call("GET", "/v2/organizations")).body.items).toEqual([]);
    const create = await free.browser.call("POST", "/v2/organizations", { name: "Acme" });
    expect(create.status).toBe(403);
    expect(create.body.message).toBe("Organizations are part of Cloud Standard. Upgrade in Billing.");
    // The sign-in page offers SSO on Cloud; a Free account's domain has none, so lookup says no.
    expect((await x.browser().call("GET", "/auth/config")).body.sso).toBe(true);
    expect((await x.browser().call("POST", "/sso/lookup", { email: "free@acme.test" })).body).toEqual({ sso: false });
  });

  it("leaves projects outside organizations exactly as before", async () => {
    const x = await cloud();
    const free = await x.signup("free@acme.test");
    expect((await free.browser.call("GET", `/v2/projects/${free.projectId}/apps`)).status).toBe(200);
    expect((await free.browser.call("GET", `/v2/projects/${free.projectId}/audit_logs`)).status).toBe(200);
  });
});

describe("RevenueDot Cloud: Standard", () => {
  it("gets organizations, custom roles and single sign-on; SCIM, retention, data location and exports say Enterprise", async () => {
    const dns: FakeDns = new Map();
    const x = await cloud(dns);
    const owner = await x.signup("owner@acme.test");
    await setPlan(x, owner.userId, "standard");
    expect((await owner.browser.call("GET", "/v2/enterprise")).body).toMatchObject({ plan: "standard", features: ["organizations", "custom_roles", "sso"], locked: STANDARD_LOCKED });
    const orgId = await x.createOrg(owner.browser, "Acme", [owner.projectId]);
    const O = `/v2/organizations/${orgId}`;
    const org = await owner.browser.call("GET", O);
    expect(org.body).toMatchObject({ plan: "standard", features: ["organizations", "custom_roles", "sso"], locked: STANDARD_LOCKED });

    expect((await owner.browser.call("POST", `${O}/roles`, { name: "Support", scopes: ["customer_information:customers:read"] })).status).toBe(201);
    expect((await owner.browser.call("POST", `${O}/sso/connections`, { kind: "saml", name: "Okta", enabled: true, saml: samlBody })).status).toBe(201);
    await addVerifiedDomain(owner.browser, orgId, "acme.test", dns);
    expect((await owner.browser.call("POST", O, { sso_enforced: true })).status).toBe(200);
    expect((await x.browser().call("POST", "/sso/lookup", { email: "mia@acme.test" })).body.sso).toBe(true);

    const enterpriseOnly: [string, string, unknown, string][] = [
      ["POST", `${O}/scim/tokens`, { name: "Okta" }, "SCIM provisioning is part of Enterprise. Contact sales at https://revenuedot.app/contact-sales."],
      ["GET", `${O}/exports/audit_logs?format=json`, undefined, "Compliance exports are part of Enterprise. Contact sales at https://revenuedot.app/contact-sales."],
      ["POST", O, { audit_retention_days: 365 }, "Audit log retention is part of Enterprise. Contact sales at https://revenuedot.app/contact-sales."],
      ["POST", `${O}/projects/${owner.projectId}/region`, { region: "us" }, "Data location is part of Enterprise. Contact sales at https://revenuedot.app/contact-sales."],
    ];
    for (const [m, path, body, message] of enterpriseOnly) {
      const r = await owner.browser.call(m, path, body);
      expect(r.status, `${m} ${path}`).toBe(403);
      expect(r.body.message).toBe(message);
    }
  });

  it("an organization gets its best owner's plan: a Free member works under a Standard owner", async () => {
    const x = await cloud();
    const owner = await x.signup("owner@acme.test");
    await setPlan(x, owner.userId, "standard");
    const orgId = await x.createOrg(owner.browser, "Acme", [owner.projectId]);
    const dev = await x.signup("dev@acme.test", "Side");
    expect((await owner.browser.call("POST", `/v2/organizations/${orgId}/members`, { email: "dev@acme.test", role: "admin" })).status).toBe(201);
    // The Free admin manages the organization's roles because the organization is on Standard.
    expect((await dev.browser.call("POST", `/v2/organizations/${orgId}/roles`, { name: "Viewer plus", scopes: ["charts_metrics:overview:read"] })).status).toBe(201);
    // But cannot create an organization of their own.
    expect((await dev.browser.call("POST", "/v2/organizations", { name: "Mine" })).status).toBe(403);
  });
});

describe("RevenueDot Cloud: Enterprise", () => {
  it("an account marked Enterprise unlocks every feature for its organizations", async () => {
    const x = await cloud();
    const owner = await x.signup("owner@acme.test");
    await setPlan(x, owner.userId, "enterprise");
    const orgId = await x.createOrg(owner.browser, "Acme", [owner.projectId]);
    const O = `/v2/organizations/${orgId}`;
    expect((await owner.browser.call("GET", O)).body).toMatchObject({ plan: "enterprise", locked: [] });
    expect((await owner.browser.call("POST", `${O}/scim/tokens`, { name: "Okta" })).status).toBe(201);
    expect((await owner.browser.call("GET", `${O}/exports/audit_logs?format=json`)).status).toBe(200);
    expect((await owner.browser.call("POST", O, { audit_retention_days: 365 })).status).toBe(200);
  });
});

describe("RevenueDot Cloud: downgrades", () => {
  it("keeps projects working, turns custom roles into no access, stops SSO enforcement and SCIM, and keeps the organization readable", async () => {
    const dns: FakeDns = new Map();
    const x = await cloud(dns);
    const owner = await x.signup("owner@acme.test");
    await setPlan(x, owner.userId, "enterprise");
    const orgId = await x.createOrg(owner.browser, "Acme", [owner.projectId]);
    const O = `/v2/organizations/${orgId}`;
    const role = await owner.browser.call("POST", `${O}/roles`, { name: "Catalog", scopes: ["project_configuration:entitlements:read"] });
    const dev = await x.signup("dev@other.test", "Side");
    await x.db.insert(schema.memberships).values({ userId: dev.userId, projectId: owner.projectId, role: "viewer" });
    expect((await owner.browser.call("POST", `${O}/projects/${owner.projectId}/members/${dev.userId}`, { role: role.body.id })).status).toBe(200);
    expect((await dev.browser.call("GET", `/v2/projects/${owner.projectId}/entitlements`)).status).toBe(200);
    const mia = await x.signup("mia@acme.test", "Mia's");
    expect((await owner.browser.call("POST", `${O}/members`, { email: "mia@acme.test" })).status).toBe(201);
    expect((await owner.browser.call("POST", `${O}/sso/connections`, { kind: "saml", name: "Okta", enabled: true, saml: samlBody })).status).toBe(201);
    await addVerifiedDomain(owner.browser, orgId, "acme.test", dns);
    expect((await owner.browser.call("POST", O, { sso_enforced: true })).status).toBe(200);
    expect((await x.browser().call("POST", "/auth/login", { email: "mia@acme.test", password: "correct horse battery" })).status).toBe(403);
    const token = await owner.browser.call("POST", `${O}/scim/tokens`, { name: "Okta" });
    const scim = (path: string) => x.app.fetch(new Request(`https://dash.example.com${path}`, { headers: { authorization: `Bearer ${token.body.token}` } }));
    expect((await scim("/scim/v2/Users")).status).toBe(200);
    void mia;

    // The contract ends: the account goes back to Free.
    await setPlan(x, owner.userId, "free");
    // The project keeps working for its owner with the built-in roles.
    expect((await owner.browser.call("GET", `/v2/projects/${owner.projectId}/apps`)).status).toBe(200);
    // A custom role gives no access until an admin picks a built-in role.
    expect((await dev.browser.call("GET", `/v2/projects/${owner.projectId}/entitlements`)).status).toBe(403);
    // Required SSO is no longer enforced, and SSO itself is off.
    expect((await x.browser().call("POST", "/auth/login", { email: "mia@acme.test", password: "correct horse battery" })).status).toBe(200);
    expect((await x.browser().call("POST", "/sso/lookup", { email: "mia@acme.test" })).body).toEqual({ sso: false });
    // SCIM tokens stop working.
    expect((await scim("/scim/v2/Users")).status).toBe(403);
    // The organization stays readable, shows what is locked, and its projects can be moved out.
    const org = await owner.browser.call("GET", O);
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ plan: "free", features: [] });
    expect(org.body.locked).toContainEqual({ feature: "organizations", plan: "standard" });
    const rename = await owner.browser.call("POST", O, { name: "Acme 2" });
    expect(rename.status).toBe(403);
    expect(rename.body.message).toBe("Organizations are part of Cloud Standard. Upgrade in Billing.");
    expect((await owner.browser.call("DELETE", `${O}/projects/${owner.projectId}`)).status).toBe(200);
    // Upgrading again brings everything back.
    await setPlan(x, owner.userId, "standard");
    expect((await owner.browser.call("POST", O, { name: "Acme 2" })).status).toBe(200);
  });
});

describe("RevenueDot Cloud: audit log retention", () => {
  it("deletes entries older than 90 days on Free and Standard, and keeps Enterprise accounts' and organizations' history", async () => {
    const x = await cloud();
    const free = await x.signup("free@acme.test", "Free app");
    const ent = await x.signup("ent@big.test", "Big app");
    const entOrgMember = await x.signup("member@big.test", "Org app");
    await setPlan(x, ent.userId, "enterprise");
    const orgId = await x.createOrg(ent.browser, "Big", []);
    await x.db.insert(schema.memberships).values({ userId: ent.userId, projectId: entOrgMember.projectId, role: "admin" });
    expect((await ent.browser.call("POST", `/v2/organizations/${orgId}/projects`, { project_id: entOrgMember.projectId })).status).toBeLessThan(300);
    const std = await x.signup("std@acme.test", "Standard app");
    await setPlan(x, std.userId, "standard");
    const stdOrg = await x.createOrg(std.browser, "Std", [std.projectId]);

    const now = x.now();
    const old = new Date(now.getTime() - 91 * DAY), recent = new Date(now.getTime() - 89 * DAY);
    let n = 0;
    const row = (projectId: string, at: Date) => ({ id: `al_test_${++n}`, projectId, actionType: "test", targetType: "project", targetIdentifier: projectId, actorType: "user", actorIdentifier: "u", occurredAt: at });
    for (const p of [free.projectId, ent.projectId, entOrgMember.projectId, std.projectId]) await x.db.insert(schema.auditLogs).values([row(p, old), row(p, recent)]);
    for (const o of [orgId, stdOrg]) await x.db.insert(eeOrgAuditLogs).values([
      { id: `oal_old_${o}`, orgId: o, action: "test", actorType: "system", targetType: "organization", targetId: o, occurredAt: old },
      { id: `oal_new_${o}`, orgId: o, action: "test", actorType: "system", targetType: "organization", targetId: o, occurredAt: recent },
    ]);

    await x.tick();
    const left = async (projectId: string) => (await x.db.select({ id: schema.auditLogs.id }).from(schema.auditLogs)
      .where(sql`${schema.auditLogs.projectId} = ${projectId} and ${schema.auditLogs.actionType} = 'test'`)).length;
    expect(await left(free.projectId)).toBe(1);
    expect(await left(std.projectId)).toBe(1);
    expect(await left(ent.projectId)).toBe(2);
    expect(await left(entOrgMember.projectId)).toBe(2);
    const orgRows = async (o: string) => (await x.db.select({ id: eeOrgAuditLogs.id }).from(eeOrgAuditLogs).where(eq(eeOrgAuditLogs.orgId, o))).map((r) => r.id);
    expect(await orgRows(stdOrg)).not.toContain(`oal_old_${stdOrg}`);
    expect(await orgRows(stdOrg)).toContain(`oal_new_${stdOrg}`);
    expect(await orgRows(orgId)).toContain(`oal_old_${orgId}`);
  });
});

describe("self-hosted servers keep the licence key", () => {
  it("without a key nothing loads; Cloud always loads", async () => {
    expect(await loadExtensions({}, { edition: "self-hosted" })).toEqual([]);
    expect(await loadExtensions({})).toEqual([]);
    const c = await loadExtensions({}, { edition: "cloud" });
    expect(c).toHaveLength(1);
    expect(c[0]!.status().mode).toBe("cloud");
  });

  it("a licence without a feature shows it locked as Enterprise and refuses it with the licence message; billing plans change nothing", async () => {
    const lic = await checkLicense({ dev: true, now: Date.now() });
    s = await eeServer({ extension: enterpriseExtension({ ...lic, features: ["organizations", "sso"] }) });
    const owner = await s.signup("owner@acme.test");
    // A billing row (never on a self-hosted server, but harmless) does not unlock anything: the licence decides.
    await setPlan(s, owner.userId, "enterprise");
    const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
    const org = await owner.browser.call("GET", `/v2/organizations/${orgId}`);
    expect(org.body.plan).toBeUndefined();
    expect(org.body.features).toEqual(["organizations", "sso"]);
    expect(org.body.locked).toContainEqual({ feature: "custom_roles", plan: "enterprise" });
    const r = await owner.browser.call("POST", `/v2/organizations/${orgId}/roles`, { name: "x", scopes: [] });
    expect(r.status).toBe(403);
    expect(r.body.message).toBe("Your RevenueDot Enterprise licence does not include custom roles.");
    expect((await owner.browser.call("GET", "/v2/enterprise")).body).toMatchObject({ mode: "development", features: ["organizations", "sso"] });
  });

  it("a full licence: every feature, nothing locked", async () => {
    s = await eeServer();
    const owner = await s.signup("owner@acme.test");
    const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
    expect((await owner.browser.call("GET", `/v2/organizations/${orgId}`)).body.locked).toEqual([]);
    expect((await owner.browser.call("POST", `/v2/organizations/${orgId}/scim/tokens`, { name: "Okta" })).status).toBe(201);
  });
});
