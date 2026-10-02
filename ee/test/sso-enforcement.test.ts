// RevenueDot Enterprise (ee/LICENSE). Required single sign-on (password refusal, owner break-glass, project access by
// session kind), SSO lookup, and the admin routes for connections and verified domains. Spec: prd/enterprise/PRD.md §5.
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { eeOrgMembers } from "../server/schema.js";
import { eeServer, type Browser, type EeServer } from "./helpers.js";
import { IDP, addVerifiedDomain, dnsFetch, samlResponse, type FakeDns } from "./saml-idp.js";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const samlBody = (allowIdp = true) => ({ idp_entity_id: IDP.entityId, idp_sso_url: IDP.ssoUrl, idp_certificates: [IDP.cert], allow_idp_initiated: allowIdp });

async function base() {
  const dns: FakeDns = new Map();
  s = await eeServer({ fetch: dnsFetch(dns) });
  const owner = await s.signup("owner@acme.test");
  const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
  return { dns, owner: owner.browser, ownerId: owner.userId, orgId, projectId: owner.projectId };
}

async function connect(owner: Browser, orgId: string) {
  const conn = await owner.call("POST", `/v2/organizations/${orgId}/sso/connections`, { kind: "saml", name: "Okta", enabled: true, saml: samlBody() });
  expect(conn.status).toBe(201);
  return conn.body as { id: string; sp: { acs_url: string; entity_id: string } };
}

describe("required single sign-on", () => {
  it("refuses passwords on verified domains, keeps owners in (break-glass), and gates projects by session kind", async () => {
    const x = await base();
    // A member with a password and a project role, and a contractor on another domain, before SSO is required.
    const mia = await s!.signup("mia@acme.test", "Mia's");
    const contractor = await s!.signup("cara@contractor.test", "Cara's");
    for (const [u, email] of [[mia, "mia@acme.test"], [contractor, "cara@contractor.test"]] as const) {
      expect((await x.owner.call("POST", `/v2/organizations/${x.orgId}/members`, { email })).status).toBeLessThan(300);
      await s!.db.insert(schema.memberships).values({ userId: u.userId, projectId: x.projectId, role: "developer" });
    }
    expect((await mia.browser.call("GET", `/v2/projects/${x.projectId}/apps`)).status).toBe(200);

    // Enforcement needs an enabled connection and a verified domain.
    const early = await x.owner.call("POST", `/v2/organizations/${x.orgId}`, { sso_enforced: true });
    expect(early.status).toBe(422);
    const conn = await connect(x.owner, x.orgId);
    await addVerifiedDomain(x.owner, x.orgId, "acme.test", x.dns);
    expect((await x.owner.call("POST", `/v2/organizations/${x.orgId}`, { sso_enforced: true })).status).toBe(200);

    // Password sign-in, sign-up and the existing password session are refused for the verified domain.
    const login = await s!.browser().call("POST", "/auth/login", { email: "mia@acme.test", password: "correct horse battery" });
    expect(login.status).toBe(403);
    expect(login.body).toEqual({ type: "sso_required", message: "Acme requires single sign-on for @acme.test addresses.", sso_url: "/sso/start?email=mia%40acme.test" });
    const signup = await s!.browser().call("POST", "/auth/signup", { email: "newbie@acme.test", password: "correct horse battery" });
    expect(signup.status).toBe(403);
    expect(signup.body.type).toBe("sso_required");
    const denied = await mia.browser.call("GET", `/v2/projects/${x.projectId}/apps`);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("single sign-on");

    // The owner keeps password sign-in and project access.
    const ownerB = s!.browser();
    expect((await ownerB.call("POST", "/auth/login", { email: "owner@acme.test", password: "correct horse battery" })).status).toBe(200);
    expect((await ownerB.call("GET", `/v2/projects/${x.projectId}/apps`)).status).toBe(200);

    // People on other domains keep their passwords.
    const caraB = s!.browser();
    expect((await caraB.call("POST", "/auth/login", { email: "cara@contractor.test", password: "correct horse battery" })).status).toBe(200);
    expect((await caraB.call("GET", `/v2/projects/${x.projectId}/apps`)).status).toBe(200);

    // An SSO session for the same person gets in.
    const ssoB = s!.browser();
    const r = await ssoB.form(`/sso/saml/${conn.id}/acs`, { SAMLResponse: samlResponse({ acsUrl: conn.sp.acs_url, audience: conn.sp.entity_id, email: "mia@acme.test" }) });
    expect(r.headers.get("location")).toBe("/");
    expect((await ssoB.call("GET", `/v2/projects/${x.projectId}/apps`)).status).toBe(200);

    // The sign-in page learns that SSO exists and where to send each address.
    expect((await s!.browser().call("GET", "/auth/config")).body.sso).toBe(true);
    expect((await s!.browser().call("POST", "/sso/lookup", { email: "Mia@acme.test", next: "/projects" })).body).toEqual({ sso: true, url: "/sso/start?email=mia%40acme.test&next=%2Fprojects" });
    expect((await s!.browser().call("POST", "/sso/lookup", { email: "cara@contractor.test" })).body).toEqual({ sso: false });

    // The only enabled connection cannot be turned off or deleted while SSO is required.
    expect((await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/connections/${conn.id}`, { enabled: false })).status).toBe(422);
    expect((await x.owner.call("DELETE", `/v2/organizations/${x.orgId}/sso/connections/${conn.id}`)).status).toBe(422);
  });

  it("a deactivated owner loses break-glass", async () => {
    const x = await base();
    await connect(x.owner, x.orgId);
    await addVerifiedDomain(x.owner, x.orgId, "acme.test", x.dns);
    const co = await s!.signup("co@acme.test");
    await x.owner.call("POST", `/v2/organizations/${x.orgId}/members`, { email: "co@acme.test", role: "owner" });
    expect((await x.owner.call("POST", `/v2/organizations/${x.orgId}`, { sso_enforced: true })).status).toBe(200);
    expect((await s!.browser().call("POST", "/auth/login", { email: "co@acme.test", password: "correct horse battery" })).status).toBe(200);
    await s!.db.update(eeOrgMembers).set({ active: false }).where(and(eq(eeOrgMembers.orgId, x.orgId), eq(eeOrgMembers.userId, co.userId)));
    expect((await s!.browser().call("POST", "/auth/login", { email: "co@acme.test", password: "correct horse battery" })).status).toBe(403);
  });
});

describe("SSO domains", () => {
  it("adds, verifies over DNS and removes a domain; refuses public and invalid domains", async () => {
    const x = await base();
    for (const d of ["gmail.com", "Outlook.com", "qq.com", "proton.me"]) {
      const r = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/domains`, { domain: d });
      expect(r.status, d).toBe(400);
      expect(r.body.message).toContain("public email provider");
    }
    expect((await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/domains`, { domain: "not a domain" })).status).toBe(400);

    const add = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/domains`, { domain: "Acme.test." });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ domain: "acme.test", verified: false, txt_record: { type: "TXT", name: "_revenuedot-sso.acme.test" } });
    expect(add.body.txt_record.value).toMatch(/^revenuedot-sso-verification=[0-9a-f]{32}$/);

    const missing = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/domains/acme.test/actions/verify`);
    expect(missing.status).toBe(200);
    expect(missing.body.verified).toBe(false);
    expect(missing.body.last_error).toContain("was not found");

    x.dns.set("_revenuedot-sso.acme.test", ["v=spf1 -all", add.body.txt_record.value]);
    const ok = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/domains/acme.test/actions/verify`);
    expect(ok.body).toMatchObject({ verified: true, last_error: null });
    const list = await x.owner.call("GET", `/v2/organizations/${x.orgId}/sso/domains`);
    expect(list.body.items).toEqual([expect.objectContaining({ domain: "acme.test", verified: true })]);

    expect((await x.owner.call("DELETE", `/v2/organizations/${x.orgId}/sso/domains/acme.test`)).status).toBe(200);
    expect((await x.owner.call("GET", `/v2/organizations/${x.orgId}/sso/domains`)).body.items).toEqual([]);
  });

  it("a domain another organization verified answers 409; an unverified claim does not block", async () => {
    const x = await base();
    await addVerifiedDomain(x.owner, x.orgId, "acme.test", x.dns);
    const other = await s!.signup("boss@beta.test", "Beta app");
    const betaOrg = await s!.createOrg(other.browser, "Beta");
    const taken = await other.browser.call("POST", `/v2/organizations/${betaOrg}/sso/domains`, { domain: "acme.test" });
    expect(taken.status).toBe(409);

    // Beta claims beta.test but never verifies; Acme can still add it, and Beta's own TXT value stays the same.
    const pending = await other.browser.call("POST", `/v2/organizations/${betaOrg}/sso/domains`, { domain: "beta.test" });
    expect(pending.status).toBe(201);
    const claim = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/domains`, { domain: "beta.test" });
    expect(claim.status).toBe(201);
    expect(claim.body.txt_record.value).not.toBe(pending.body.txt_record.value);
    expect((await other.browser.call("POST", `/v2/organizations/${betaOrg}/sso/domains/beta.test/actions/verify`)).status).toBe(404);
    const again = await other.browser.call("POST", `/v2/organizations/${betaOrg}/sso/domains`, { domain: "beta.test" });
    expect(again.body.txt_record.value).toBe(pending.body.txt_record.value);
  });
});

describe("SSO connections admin", () => {
  it("only owners and admins manage connections, every change is audited, and the shape has the SP details", async () => {
    const x = await base();
    const conn = await connect(x.owner, x.orgId);
    expect(conn.sp).toEqual({
      entity_id: `https://dash.example.com/sso/saml/${conn.id}/metadata`, acs_url: `https://dash.example.com/sso/saml/${conn.id}/acs`,
      metadata_url: `https://dash.example.com/sso/saml/${conn.id}/metadata`, start_url: `https://dash.example.com/sso/connections/${conn.id}/start`,
    });
    const upd = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/connections/${conn.id}`, { name: "Okta prod", jit: false, saml: { groups_attribute: "memberOf" } });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: "Okta prod", jit: false, saml: { groups_attribute: "memberOf", idp_entity_id: IDP.entityId } });

    const m = await s!.signup("member@acme.test");
    await x.owner.call("POST", `/v2/organizations/${x.orgId}/members`, { email: "member@acme.test" });
    expect((await m.browser.call("GET", `/v2/organizations/${x.orgId}/sso/connections`)).status).toBe(403);
    expect((await m.browser.call("POST", `/v2/organizations/${x.orgId}/sso/domains`, { domain: "acme.test" })).status).toBe(403);

    expect((await x.owner.call("DELETE", `/v2/organizations/${x.orgId}/sso/connections/${conn.id}`)).status).toBe(200);
    expect((await x.owner.call("GET", `/v2/organizations/${x.orgId}/sso/connections/${conn.id}`)).status).toBe(404);
    const log = await x.owner.call("GET", `/v2/organizations/${x.orgId}/audit_logs`);
    const actions = JSON.stringify(log.body);
    for (const a of ["sso_connection_created", "sso_connection_updated", "sso_connection_deleted"]) expect(actions).toContain(a);
  });

  it("reads IdP metadata XML and refuses certificates that are not X.509", async () => {
    const x = await base();
    const certBody = IDP.cert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, "");
    const metadata = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP.entityId}">`
      + `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`
      + `<md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>bm90IGEgY2VydA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`
      + `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/post"/>`
      + `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP.ssoUrl}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
    const r = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/connections`, { kind: "saml", name: "From metadata", saml: { metadata_xml: metadata } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ enabled: false, jit: true, saml: { idp_entity_id: IDP.entityId, idp_sso_url: IDP.ssoUrl, allow_idp_initiated: false } });
    expect(r.body.saml.idp_certificates).toHaveLength(1);
    expect(r.body.saml.idp_certificates[0].replace(/\s+/g, "")).toBe(IDP.cert.replace(/\s+/g, ""));

    for (const bad of ["not a certificate", "bm90IGEgY2VydA==", "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END CERTIFICATE-----"]) {
      const b = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/connections`, { kind: "saml", name: "Bad", saml: { ...samlBody(), idp_certificates: [bad] } });
      expect(b.status, bad).toBe(400);
      expect(b.body.param).toBe("saml.idp_certificates");
    }
    const noMeta = await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/connections`, { kind: "saml", name: "Bad", saml: { metadata_xml: "<nope" } });
    expect(noMeta.status).toBe(400);
  });

  it("a disabled connection does not start sign-in", async () => {
    const x = await base();
    const conn = await connect(x.owner, x.orgId);
    await x.owner.call("POST", `/v2/organizations/${x.orgId}/sso/connections/${conn.id}`, { enabled: false });
    const r = await s!.browser().call("GET", `/sso/connections/${conn.id}/start`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/^\/login\?sso_error=/);
  });
});
