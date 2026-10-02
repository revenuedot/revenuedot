// RevenueDot Enterprise (ee/LICENSE). RevenueDot AI in an organization that requires single sign-on: its in-process API
// calls act with the session the chat came from, so a member signed in with SSO can use it and a password session
// cannot. Spec: prd/enterprise/PRD.md §5; prd/ai-assistant/PRD.md §2.
import { afterEach, describe, expect, it } from "vitest";
type UIMessageChunk = { type: string; [k: string]: unknown };
import { schema } from "@revenuedot/db";
import { fakeAssistantModel } from "../../apps/server/src/services/assistant/fake-model.js";
import { eeServer, type Browser, type EeServer } from "./helpers.js";
import { IDP, addVerifiedDomain, dnsFetch, samlResponse, type FakeDns } from "./saml-idp.js";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const chunksOf = (text: string) => text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)) as UIMessageChunk);

async function ask(b: Browser, projectId: string, text: string) {
  const conv = await b.call("POST", `/v2/projects/${projectId}/ai/conversations`, {});
  if (conv.status !== 201 && conv.status !== 200) return { status: conv.status, chunks: [] as UIMessageChunk[] };
  const res = await b.call("POST", `/v2/projects/${projectId}/ai/conversations/${conv.body.id}/chat`, { trigger: "submit-message", message: { id: "u1", role: "user", parts: [{ type: "text", text }] } });
  return { status: res.status, chunks: res.status === 200 ? chunksOf(res.text) : [] };
}

describe("RevenueDot AI with required single sign-on", () => {
  it("tool calls work for a member signed in with SSO", async () => {
    const dns: FakeDns = new Map();
    s = await eeServer({ fetch: dnsFetch(dns), deps: { assistant: fakeAssistantModel(undefined, { delayMs: 0 }), assistantRuntime: "sse" } });
    const owner = await s.signup("owner@acme.test");
    const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
    const conn = await owner.browser.call("POST", `/v2/organizations/${orgId}/sso/connections`, { kind: "saml", name: "Okta", enabled: true, saml: { idp_entity_id: IDP.entityId, idp_sso_url: IDP.ssoUrl, idp_certificates: [IDP.cert], allow_idp_initiated: true } });
    await addVerifiedDomain(owner.browser, orgId, "acme.test", dns);
    expect((await owner.browser.call("POST", `/v2/organizations/${orgId}`, { sso_enforced: true })).status).toBe(200);

    // Mia signs in with SSO (IdP-initiated) and gets the Developer role on the project.
    const mia = s.browser();
    const signIn = await mia.form(`/sso/saml/${conn.body.id}/acs`, { SAMLResponse: samlResponse({ acsUrl: conn.body.sp.acs_url, audience: conn.body.sp.entity_id, email: "mia@acme.test" }) });
    expect(signIn.status).toBe(303);
    const miaId = (await mia.call("GET", "/auth/me")).body.user.id as string;
    await s.db.insert(schema.memberships).values({ userId: miaId, projectId: owner.projectId, role: "developer" });

    const r = await ask(mia, owner.projectId, "how is revenue doing?");
    await s.settle();
    expect(r.status).toBe(200);
    expect(r.chunks.some((c) => c.type === "tool-output-available")).toBe(true);
    expect(r.chunks.some((c) => c.type === "tool-output-error")).toBe(false);
    expect(JSON.stringify(r.chunks)).not.toContain("requires single sign-on");
  });
});
