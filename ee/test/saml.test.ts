// RevenueDot Enterprise (ee/LICENSE). SAML 2.0 single sign-on end to end against a test identity provider: SP- and
// IdP-initiated sign-in, signature and wrapping attacks, every condition check, replay, domains, JIT and role
// mappings. Spec: prd/enterprise/PRD.md §5.
import { afterEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { eeServer, type Browser, type EeServer } from "./helpers.js";
import { IDP, addVerifiedDomain, assertionXml, b64, dnsFetch, newId, readAuthnRequest, responseXml, samlResponse, signAssertion, type FakeDns } from "./saml-idp.js";
import { eeOrgAuditLogs, eeOrgMembers, eeSsoSessions } from "../server/schema.js";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

interface Setup { owner: Browser; orgId: string; projectId: string; connId: string; acs: string; entity: string; dns: FakeDns }

async function setup(o: { allowIdp?: boolean; jit?: boolean; saml?: Record<string, unknown> } = {}): Promise<Setup> {
  const dns: FakeDns = new Map();
  s = await eeServer({ fetch: dnsFetch(dns) });
  const owner = await s.signup("owner@acme.test");
  const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
  const conn = await owner.browser.call("POST", `/v2/organizations/${orgId}/sso/connections`, {
    kind: "saml", name: "Okta", enabled: true, jit: o.jit ?? true,
    saml: { idp_entity_id: IDP.entityId, idp_sso_url: IDP.ssoUrl, idp_certificates: [IDP.cert], allow_idp_initiated: o.allowIdp ?? false, ...o.saml },
  });
  expect(conn.status).toBe(201);
  await addVerifiedDomain(owner.browser, orgId, "acme.test", dns);
  return { owner: owner.browser, orgId, projectId: owner.projectId, connId: conn.body.id, acs: conn.body.sp.acs_url, entity: conn.body.sp.entity_id, dns };
}

/** Starts an SP-initiated sign-in and returns the AuthnRequest id the IdP must answer. */
async function spStart(b: Browser, email: string, next = "/") {
  const r = await b.call("GET", `/sso/start?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
  expect(r.status).toBe(303);
  const loc = r.headers.get("location")!;
  expect(loc.startsWith(IDP.ssoUrl)).toBe(true);
  return readAuthnRequest(loc);
}

const post = (b: Browser, x: Setup, SAMLResponse: string, RelayState?: string) =>
  b.form(`/sso/saml/${x.connId}/acs`, { SAMLResponse, ...(RelayState ? { RelayState } : {}) });

async function lastFailure(orgId: string): Promise<string> {
  const [row] = await s!.db.select().from(eeOrgAuditLogs).where(and(eq(eeOrgAuditLogs.orgId, orgId), eq(eeOrgAuditLogs.action, "sso_sign_in_failed"))).orderBy(desc(eeOrgAuditLogs.occurredAt)).limit(1);
  return String(row?.data.reason ?? "");
}

function expectRefused(r: { status: number; headers: Headers; cookie: string | null }) {
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toMatch(/^\/login\?sso_error=/);
  expect(r.cookie ?? "").not.toMatch(/rd_session=[^;]/);
}

describe("SAML sign-in", () => {
  it("SP-initiated: start redirects to the IdP, the answer signs in a new account (JIT) and the session works", async () => {
    const x = await setup();
    const b = s!.browser();
    const req = await spStart(b, "alice@acme.test", "/projects/abc?tab=1");
    expect(req.relayState).toBe("/projects/abc?tab=1");
    expect(req.xml).toContain(`AssertionConsumerServiceURL="${x.acs}"`);
    const res = await post(b, x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "Alice@acme.test", inResponseTo: req.id, attributes: { givenName: ["Alice"], sn: ["Liddell"] } }), req.relayState!);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/projects/abc?tab=1");
    expect(res.cookie).toMatch(/rd_session=[^;]+;.*HttpOnly/i);
    expect(res.cookie).toMatch(/SameSite=Lax/i);
    expect(res.cookie).toMatch(/Secure/i);
    const me = await b.call("GET", "/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: "alice@acme.test", name: "Alice Liddell", email_verified: true });
    const [u] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "alice@acme.test"));
    expect(u!.passwordHash).toBeNull();
    const [m] = await s!.db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, x.orgId), eq(eeOrgMembers.userId, u!.id)));
    expect(m).toMatchObject({ role: "member", source: "sso", active: true });
    const sessions = await s!.db.select().from(eeSsoSessions).where(eq(eeSsoSessions.userId, u!.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ orgId: x.orgId, connectionId: x.connId });
    // The same answer cannot be used again: the request is consumed and the assertion id is spent.
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", inResponseTo: req.id })));
  });

  it("serves SP metadata at the entity id", async () => {
    const x = await setup();
    const r = await s!.browser().call("GET", `/sso/saml/${x.connId}/metadata`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("xml");
    expect(r.text).toContain(`entityID="${x.entity}"`);
    expect(r.text).toContain(`Location="${x.acs}"`);
  });

  it("IdP-initiated sign-in works when the connection allows it, with a safe RelayState", async () => {
    const x = await setup({ allowIdp: true });
    const b = s!.browser();
    const r = await post(b, x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "bob@acme.test" }), "/settings");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/settings");
    expect((await b.call("GET", "/auth/me")).body.user.email).toBe("bob@acme.test");
    // An absolute or protocol-relative RelayState never becomes the redirect.
    const r2 = await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "bob@acme.test" }), "//evil.example/x");
    expect(r2.headers.get("location")).toBe("/");
  });

  it("refuses IdP-initiated sign-in when the connection does not allow it", async () => {
    const x = await setup();
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "bob@acme.test" })));
    expect(await lastFailure(x.orgId)).toContain("IdP-initiated");
  });

  it("refuses an SP-initiated answer whose unsigned Response InResponseTo was stripped", async () => {
    const x = await setup();
    const b = s!.browser();
    const req = await spStart(b, "alice@acme.test");
    expectRefused(await post(b, x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", inResponseTo: req.id, response: { inResponseTo: null } })));
    expect(await lastFailure(x.orgId)).toContain("InResponseTo");
  });

  it("refuses an SP-initiated answer posted by a browser that did not start the sign-in (login CSRF)", async () => {
    const x = await setup();
    const attacker = s!.browser();
    const req = await spStart(attacker, "mallory@acme.test");
    const victim = s!.browser();
    expectRefused(await post(victim, x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "mallory@acme.test", inResponseTo: req.id })));
    expect(await lastFailure(x.orgId)).toContain("another browser");
    // The browser that started it can still finish it.
    const ok = await post(attacker, x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "mallory@acme.test", inResponseTo: req.id }));
    expect(ok.headers.get("location")).toBe("/");
  });

  it("refuses an unknown InResponseTo", async () => {
    const x = await setup();
    // From a browser with no sign-in in flight it is refused before any check; from one with another sign-in in flight
    // the signed InResponseTo must still match a stored request.
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", inResponseTo: "_unknown123" })));
    expect(await lastFailure(x.orgId)).toMatch(/another browser/);
    const b = s!.browser();
    const req = await spStart(b, "alice@acme.test");
    const xml = Buffer.from(samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", inResponseTo: "_unknown123", response: { inResponseTo: req.id } }), "base64").toString("utf8");
    expectRefused(await post(b, x, b64(xml)));
    expect(await lastFailure(x.orgId)).toMatch(/InResponseTo/);
  });

  it("refuses a replayed assertion", async () => {
    const x = await setup({ allowIdp: true });
    const resp = samlResponse({ acsUrl: x.acs, audience: x.entity, email: "carol@acme.test" });
    expect((await post(s!.browser(), x, resp)).headers.get("location")).toBe("/");
    expectRefused(await post(s!.browser(), x, resp));
    expect(await lastFailure(x.orgId)).toContain("replay");
  });
});

describe("SAML signatures", () => {
  it("refuses an unsigned assertion", async () => {
    const x = await setup({ allowIdp: true });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", sign: false })));
    expect(await lastFailure(x.orgId)).toMatch(/signature/i);
  });

  it("refuses an assertion signed with another key", async () => {
    const x = await setup({ allowIdp: true });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", sign: "attacker" })));
    expect(await lastFailure(x.orgId)).toMatch(/signature/i);
  });

  it("refuses an assertion whose email changed after signing", async () => {
    const x = await setup({ allowIdp: true });
    const signed = signAssertion(assertionXml({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test" }));
    const tampered = signed.replace(/>alice@acme\.test</g, ">owner@acme.test<");
    expect(tampered).not.toBe(signed);
    expectRefused(await post(s!.browser(), x, b64(responseXml(tampered, { destination: x.acs }))));
    expect(await lastFailure(x.orgId)).toMatch(/signature/i);
    expect((await s!.db.select().from(eeSsoSessions))).toHaveLength(0);
  });

  it("refuses signature wrapping: an evil unsigned assertion before the signed one", async () => {
    const x = await setup({ allowIdp: true });
    const good = signAssertion(assertionXml({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test" }));
    const evil = assertionXml({ acsUrl: x.acs, audience: x.entity, email: "owner@acme.test" });
    expectRefused(await post(s!.browser(), x, b64(responseXml(evil + good, { destination: x.acs }))));
    expect(await lastFailure(x.orgId)).toMatch(/signature/i);
  });

  it("refuses signature wrapping: the signed assertion moved into Extensions, an evil one in its place", async () => {
    const x = await setup({ allowIdp: true });
    const good = signAssertion(assertionXml({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test" }));
    const evil = assertionXml({ acsUrl: x.acs, audience: x.entity, email: "owner@acme.test" });
    expectRefused(await post(s!.browser(), x, b64(responseXml(evil, { destination: x.acs, extensions: good }))));
    expect(await lastFailure(x.orgId)).toMatch(/signature/i);
  });

  it("refuses signature wrapping: the signed assertion inside the evil assertion's ds:Object", async () => {
    const x = await setup({ allowIdp: true });
    const id = newId();
    const good = signAssertion(assertionXml({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", assertionId: id }));
    const sig = /<(ds:)?Signature[\s\S]*<\/(ds:)?Signature>/.exec(good)![0];
    const prefix = sig.startsWith("<ds:") ? "ds:" : "";
    // The original assertion without its signature still has the signed digest (the enveloped-signature transform).
    const sigWithObject = sig.replace(new RegExp(`</${prefix}Signature>$`), `<${prefix}Object>${good.replace(sig, "")}</${prefix}Object></${prefix}Signature>`);
    const evil = assertionXml({ acsUrl: x.acs, audience: x.entity, email: "owner@acme.test", assertionId: newId() })
      .replace(/(<saml:Issuer>[^<]*<\/saml:Issuer>)/, `$1${sigWithObject}`);
    expectRefused(await post(s!.browser(), x, b64(responseXml(evil, { destination: x.acs }))));
    expect(await lastFailure(x.orgId)).toMatch(/Referenced node does not refer/i);
  });

  it("refuses a response with two signed assertions", async () => {
    const x = await setup({ allowIdp: true });
    const a1 = signAssertion(assertionXml({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test" }));
    const a2 = signAssertion(assertionXml({ acsUrl: x.acs, audience: x.entity, email: "owner@acme.test" }));
    expectRefused(await post(s!.browser(), x, b64(responseXml(a1 + a2, { destination: x.acs }))));
    expect(await lastFailure(x.orgId)).toMatch(/multiple assertions/i);
  });
});

describe("SAML conditions", () => {
  it("refuses the wrong audience", async () => {
    const x = await setup({ allowIdp: true });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: "https://other-sp.example/metadata", email: "alice@acme.test" })));
    expect(await lastFailure(x.orgId)).toMatch(/audience/i);
  });

  it("refuses the wrong Recipient", async () => {
    const x = await setup({ allowIdp: true });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", recipient: "https://other-sp.example/acs" })));
    expect(await lastFailure(x.orgId)).toContain("Recipient");
  });

  it("refuses the wrong Destination", async () => {
    const x = await setup({ allowIdp: true });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", response: { destination: "https://other-sp.example/acs" } })));
    expect(await lastFailure(x.orgId)).toContain("Destination");
  });

  it("refuses an assertion from another issuer, even signed with the trusted key", async () => {
    const x = await setup({ allowIdp: true });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", issuer: "https://other-idp.example" })));
    expect(await lastFailure(x.orgId)).toContain("Issuer");
  });

  it("refuses an expired assertion (NotOnOrAfter in the past beyond the skew)", async () => {
    const x = await setup({ allowIdp: true });
    const past = new Date(Date.now() - 5 * 60_000);
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", notBefore: new Date(Date.now() - 10 * 60_000), notOnOrAfter: past })));
    expect(await lastFailure(x.orgId)).toMatch(/expired|subject confirmation/i);
  });

  it("refuses an assertion that is not valid yet (NotBefore in the future beyond the skew)", async () => {
    const x = await setup({ allowIdp: true });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", notBefore: new Date(Date.now() + 10 * 60_000), notOnOrAfter: new Date(Date.now() + 20 * 60_000) })));
    expect(await lastFailure(x.orgId)).toMatch(/not yet valid/i);
  });

  it("accepts a NotBefore within the 60 second skew", async () => {
    const x = await setup({ allowIdp: true });
    const r = await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "alice@acme.test", notBefore: new Date(Date.now() + 30_000) }));
    expect(r.headers.get("location")).toBe("/");
  });
});

describe("SAML accounts", () => {
  it("refuses an email whose domain the organization did not verify", async () => {
    const x = await setup({ allowIdp: true });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "mallory@other.test" })));
    expect(await lastFailure(x.orgId)).toContain("not verified");
    expect(await s!.db.select().from(schema.users).where(eq(schema.users.email, "mallory@other.test"))).toHaveLength(0);
  });

  it("refuses a deactivated (SCIM deprovisioned) member", async () => {
    const x = await setup({ allowIdp: true });
    expect((await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "dave@acme.test" }))).headers.get("location")).toBe("/");
    const [u] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "dave@acme.test"));
    await s!.db.update(eeOrgMembers).set({ active: false }).where(and(eq(eeOrgMembers.orgId, x.orgId), eq(eeOrgMembers.userId, u!.id)));
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "dave@acme.test" })));
    expect(await lastFailure(x.orgId)).toContain("deactivated");
  });

  it("with JIT off, refuses people who are not organization members and signs in members", async () => {
    const x = await setup({ allowIdp: true, jit: false });
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "erin@acme.test" })));
    expect(await lastFailure(x.orgId)).toContain("just-in-time");
    expect(await s!.db.select().from(schema.users).where(eq(schema.users.email, "erin@acme.test"))).toHaveLength(0);
    // An existing account that is not a member is refused too.
    await s!.signup("frank@acme.test");
    expectRefused(await post(s!.browser(), x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "frank@acme.test" })));
    // Once added to the organization, it signs in.
    expect((await x.owner.call("POST", `/v2/organizations/${x.orgId}/members`, { email: "frank@acme.test" })).status).toBeLessThan(300);
    const b = s!.browser();
    expect((await post(b, x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "frank@acme.test" }))).headers.get("location")).toBe("/");
    expect((await b.call("GET", "/auth/me")).body.user.email).toBe("frank@acme.test");
  });

  it("a groups attribute plus a role mapping gives the mapped project role", async () => {
    const x = await setup({ allowIdp: true });
    const map = await x.owner.call("POST", `/v2/organizations/${x.orgId}/role_mappings`, { group: "Engineering", project_id: x.projectId, role: "developer" });
    expect(map.status).toBe(201);
    const b = s!.browser();
    const r = await post(b, x, samlResponse({ acsUrl: x.acs, audience: x.entity, email: "gina@acme.test", attributes: { groups: ["engineering", "Sales"] } }));
    expect(r.headers.get("location")).toBe("/");
    const me = await b.call("GET", "/auth/me");
    expect(me.body.projects).toEqual([expect.objectContaining({ id: x.projectId, role: "developer" })]);
    const apps = await b.call("GET", `/v2/projects/${x.projectId}/apps`);
    expect(apps.status).toBe(200);
  });

  it("reads the email from a configured attribute, and from the NameID when it is an email", async () => {
    const x = await setup({ allowIdp: true, saml: { email_attribute: "urn:custom:mail" } });
    const b = s!.browser();
    await post(b, x, samlResponse({ acsUrl: x.acs, audience: x.entity, nameId: "ignored-id", attributes: { "urn:custom:mail": ["hank@acme.test"], email: ["not-this@acme.test"] } }));
    expect((await b.call("GET", "/auth/me")).body.user.email).toBe("hank@acme.test");
    await s!.close();
    const y = await setup({ allowIdp: true });
    const b2 = s!.browser();
    await post(b2, y, samlResponse({ acsUrl: y.acs, audience: y.entity, nameId: "ivy@acme.test" }));
    expect((await b2.call("GET", "/auth/me")).body.user.email).toBe("ivy@acme.test");
  });
});
