// RevenueDot Enterprise (ee/LICENSE). MCP OAuth keys (apps/server/src/routes/oauth.ts) never give more than the person's
// own access: a custom role's key holds only the role's scopes, and enforced single sign-on or deprovisioning refuses
// the consent and the token exchange. Spec: prd/enterprise/PRD.md §4 and §5.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { eeOrgMembers } from "../server/schema.js";
import { eeServer, type Browser, type EeServer } from "./helpers.js";
import { IDP, addVerifiedDomain, dnsFetch, type FakeDns } from "./saml-idp.js";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const REDIRECT = "https://claude.example.com/callback";
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Registers a client and runs the consent screen as the browser would. Returns the consent POST and the PKCE verifier. */
async function consent(b: Browser, projectId: string, access = "project:write") {
  const reg = await s!.browser().call("POST", "/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT] });
  expect(reg.status).toBe(201);
  const { verifier, challenge } = await pkce();
  const query = { response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1" };
  const page = await b.call("GET", `/oauth/authorize?${new URLSearchParams(query)}`);
  expect(page.status).toBe(200);
  const fields = Object.fromEntries([...page.text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"')]));
  const res = await b.form("/oauth/authorize", { ...fields, project_id: projectId, access, decision: "allow" });
  return { page: page.text, res, verifier, clientId: reg.body.client_id as string };
}

async function exchange(code: string, verifier: string, clientId: string) {
  return s!.browser().form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
}

const codeOf = (res: { headers: Headers }) => new URL(res.headers.get("location")!).searchParams.get("code")!;

describe("MCP OAuth keys and enterprise access", () => {
  it("a custom role's key holds only the role's scopes", async () => {
    s = await eeServer();
    const owner = await s.signup("owner@acme.test");
    const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
    const role = await owner.browser.call("POST", `/v2/organizations/${orgId}/roles`, { name: "Catalog reader", scopes: ["project_configuration:products:read"] });
    expect(role.status).toBe(201);
    const agent = await s.signup("agent@acme.test", "Agent's");
    await s.db.insert(schema.memberships).values({ userId: agent.userId, projectId: owner.projectId, role: role.body.id });

    const { page, res, verifier, clientId } = await consent(agent.browser, owner.projectId);
    expect(page).toContain(`value="${owner.projectId}"`);
    expect(res.status).toBe(302);
    const tok = await exchange(codeOf(res), verifier, clientId);
    expect(tok.status).toBe(200);
    const [key] = await s.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.projectId, owner.projectId));
    expect(key!.permissions).toEqual(["project_configuration:products:read"]);
    const bearer = { authorization: `Bearer ${tok.body.access_token}` };
    expect((await s.browser().call("GET", `/v2/projects/${owner.projectId}/products`, undefined, bearer)).status).toBe(200);
    expect((await s.browser().call("GET", `/v2/projects/${owner.projectId}/customers`, undefined, bearer)).status).toBe(403);
  });

  it("a role with nothing to share, enforced single sign-on and deprovisioning refuse the consent or the token", async () => {
    const dns: FakeDns = new Map();
    s = await eeServer({ fetch: dnsFetch(dns) });
    const owner = await s.signup("owner@acme.test");
    const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
    // A charts-only role: none of the scopes an MCP key carries, so the project is not offered.
    const role = await owner.browser.call("POST", `/v2/organizations/${orgId}/roles`, { name: "Charts", scopes: ["charts_metrics:charts:read"] });
    const charts = await s.signup("charts@contractor.test", "Charts's");
    await s.db.insert(schema.memberships).values({ userId: charts.userId, projectId: owner.projectId, role: role.body.id });
    const none = await consent(charts.browser, owner.projectId);
    expect(none.page).not.toContain(`value="${owner.projectId}"`);
    expect(none.res.status).toBe(403);

    // A developer on the verified domain with a password session, once the organization requires single sign-on.
    const mia = await s.signup("mia@acme.test", "Mia's");
    await s.db.insert(schema.memberships).values({ userId: mia.userId, projectId: owner.projectId, role: "developer" });
    // Consent before enforcement; the token exchange still works after it (the consent checked the session).
    const early = await consent(mia.browser, owner.projectId);
    expect(early.res.status).toBe(302);
    const conn = await owner.browser.call("POST", `/v2/organizations/${orgId}/sso/connections`, { kind: "saml", name: "Okta", enabled: true, saml: { idp_entity_id: IDP.entityId, idp_sso_url: IDP.ssoUrl, idp_certificates: [IDP.cert] } });
    expect(conn.status).toBe(201);
    await addVerifiedDomain(owner.browser, orgId, "acme.test", dns);
    expect((await owner.browser.call("POST", `/v2/organizations/${orgId}`, { sso_enforced: true })).status).toBe(200);
    const enforced = await consent(mia.browser, owner.projectId);
    expect(enforced.page).not.toContain(`value="${owner.projectId}"`);
    expect(enforced.res.status).toBe(403);
    expect(enforced.res.text).toContain("single sign-on");
    expect((await exchange(codeOf(early.res), early.verifier, early.clientId)).status).toBe(200);

    // Deprovisioned with a membership added back by hand: no consent, no token.
    const late = await consent(owner.browser, owner.projectId);
    expect(late.res.status).toBe(302);
    const ownerId = (await owner.browser.call("GET", "/auth/me")).body.user.id as string;
    await s.db.update(eeOrgMembers).set({ active: false }).where(eq(eeOrgMembers.userId, ownerId));
    const tok = await exchange(codeOf(late.res), late.verifier, late.clientId);
    expect(tok.status).toBe(400);
    expect(tok.body.error).toBe("invalid_grant");
  });
});
