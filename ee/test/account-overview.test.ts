// RevenueDot Enterprise (ee/LICENSE). The Overview across projects (GET /v2/overview, GET /v2/overview/transactions)
// with the real enterprise extension: a project counts only where a project route would let the person read it. Left
// out: projects of an organization that requires single sign-on (password session), a custom role without the
// Overview scope, a deprovisioned organization member, a removed project member, and other organizations' projects.
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { eeOrgMembers } from "../server/schema.js";
import { eeServer, type Browser, type EeServer } from "./helpers.js";
import { IDP, addVerifiedDomain, dnsFetch, type FakeDns } from "./saml-idp.js";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });
const DAY = 86400_000;

/** A customer with one paid production purchase of `usd` a day ago. */
async function sale(projectId: string, user: string, usd: number) {
  const at = new Date(s!.now().getTime() - DAY);
  const id = `${projectId}_${user}`;
  await s!.db.insert(schema.customers).values({ id, projectId, originalAppUserId: user, firstSeen: at, lastSeen: at });
  await s!.db.insert(schema.transactions).values({
    id: `tx_${id}`, projectId, customerId: id, appId: null, store: "test_store", storeTransactionId: `st_${id}`, productIdentifier: "pro_monthly",
    kind: "purchase", isSandbox: false, purchasedAt: at, expiresAt: new Date(at.getTime() + 30 * DAY), revenueUsd: usd,
  });
  return `tx_${id}`;
}
const revenue = (body: any) => body.metrics.find((m: any) => m.id === "revenue").value as number;
const left = (body: any) => Object.fromEntries((body.projects as any[]).filter((p) => !p.included).map((p) => [p.name, p.reason]));
const shown = (body: any) => (body.projects as any[]).map((p) => p.name).sort();

async function project(owner: Browser, orgId: string, name: string) {
  const p = await owner.call("POST", "/v2/projects", { name });
  expect(p.status).toBeLessThan(300);
  expect((await owner.call("POST", `/v2/organizations/${orgId}/projects`, { project_id: p.body.id })).status).toBeLessThan(300);
  return p.body.id as string;
}

describe("Overview across projects with the enterprise extension", () => {
  it("never counts a project the person could not open, and never shows its transactions", async () => {
    const dns: FakeDns = new Map();
    s = await eeServer({ fetch: dnsFetch(dns) });
    const owner = await s.signup("owner@acme.test", "Acme App");
    const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
    const ops = await project(owner.browser, orgId, "Acme Ops");
    const old = await project(owner.browser, orgId, "Acme Old");
    // A custom role that may read purchases but not the Overview.
    const role = await owner.browser.call("POST", `/v2/organizations/${orgId}/roles`, { name: "Support", scopes: ["customer_information:purchases:read", "customer_information:customers:read"] });
    expect(role.status).toBe(201);

    // Mia: her own project; Developer on Acme App and Acme Old; the custom role on Acme Ops.
    const mia = await s.signup("mia@acme.test", "Mia's");
    expect((await owner.browser.call("POST", `/v2/organizations/${orgId}/members`, { email: "mia@acme.test" })).status).toBeLessThan(300);
    for (const [projectId, r] of [[owner.projectId, "developer"], [old, "developer"], [ops, role.body.id]] as const) {
      await s.db.insert(schema.memberships).values({ userId: mia.userId, projectId, role: r });
    }
    // Another organization's project, which Mia does not belong to.
    const zed = await s.signup("zed@other.test", "Other Co");
    await s.createOrg(zed.browser, "Other", [zed.projectId]);

    await sale(mia.projectId, "m1", 10);
    await sale(owner.projectId, "a1", 20);
    const opsTx = await sale(ops, "o1", 40);
    const oldTx = await sale(old, "d1", 80);
    const zedTx = await sale(zed.projectId, "z1", 160);

    // The custom role keeps Acme Ops off the cards, but its purchases scope puts it in the transactions.
    let o = await mia.browser.call("GET", "/v2/overview");
    expect(o.status).toBe(200);
    expect(shown(o.body)).toEqual(["Acme App", "Acme Old", "Acme Ops", "Mia's"]);
    expect(left(o.body)).toEqual({ "Acme Ops": "Your role in this project does not include this data." });
    expect(revenue(o.body)).toBe(110);
    let t = await mia.browser.call("GET", "/v2/overview/transactions");
    expect(t.body.items.map((x: any) => x.customer_id).sort()).toEqual(["a1", "d1", "m1", "o1"]);
    // Another organization's ids are ignored, whether asked for by id or as a cursor.
    expect((await mia.browser.call("GET", `/v2/overview?project_ids=${zed.projectId}`)).body).toMatchObject({ projects: [] });
    expect(revenue((await mia.browser.call("GET", `/v2/overview?project_ids=${zed.projectId}`)).body)).toBe(0);
    expect((await mia.browser.call("GET", `/v2/overview/transactions?starting_after=${zedTx}`)).body.param).toBe("starting_after");

    // Removed from Acme Old: it disappears, with its revenue and its transactions; its ids cannot be used either.
    await s.db.delete(schema.memberships).where(and(eq(schema.memberships.userId, mia.userId), eq(schema.memberships.projectId, old)));
    o = await mia.browser.call("GET", "/v2/overview");
    expect(shown(o.body)).toEqual(["Acme App", "Acme Ops", "Mia's"]);
    expect(revenue(o.body)).toBe(30);
    t = await mia.browser.call("GET", "/v2/overview/transactions");
    expect(t.body.items.map((x: any) => x.customer_id).sort()).toEqual(["a1", "m1", "o1"]);
    expect((await mia.browser.call("GET", `/v2/overview/transactions?starting_after=${oldTx}`)).body.param).toBe("starting_after");
    expect((await mia.browser.call("GET", `/v2/overview/transactions?project_ids=${old}`)).body.items).toEqual([]);

    // Dan, deprovisioned from the organization (SCIM), keeps a project membership row but no access.
    const dan = await s.signup("dan@acme.test", "Dan's");
    expect((await owner.browser.call("POST", `/v2/organizations/${orgId}/members`, { email: "dan@acme.test" })).status).toBeLessThan(300);
    await s.db.insert(schema.memberships).values({ userId: dan.userId, projectId: owner.projectId, role: "admin" });
    await sale(dan.projectId, "n1", 5);
    expect(revenue((await dan.browser.call("GET", "/v2/overview")).body)).toBe(25);
    await s.db.update(eeOrgMembers).set({ active: false }).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, dan.userId)));
    const d = await dan.browser.call("GET", "/v2/overview");
    expect(left(d.body)).toEqual({ "Acme App": "You no longer have access to this project." });
    expect(revenue(d.body)).toBe(5);
    expect((await dan.browser.call("GET", "/v2/overview/transactions")).body.items.map((x: any) => x.customer_id)).toEqual(["n1"]);
    expect((await dan.browser.call("GET", `/v2/projects/${owner.projectId}/metrics/overview`)).status).toBe(404);

    // Acme now requires single sign-on: Mia's password session opens none of its projects; the owner keeps access
    // (break-glass), and Mia's own project still counts.
    const conn = await owner.browser.call("POST", `/v2/organizations/${orgId}/sso/connections`, {
      kind: "saml", name: "Okta", enabled: true, saml: { idp_entity_id: IDP.entityId, idp_sso_url: IDP.ssoUrl, idp_certificates: [IDP.cert], allow_idp_initiated: true },
    });
    expect(conn.status).toBe(201);
    await addVerifiedDomain(owner.browser, orgId, "acme.test", dns);
    expect((await owner.browser.call("POST", `/v2/organizations/${orgId}`, { sso_enforced: true })).status).toBe(200);
    o = await mia.browser.call("GET", "/v2/overview");
    expect(Object.keys(left(o.body)).sort()).toEqual(["Acme App", "Acme Ops"]);
    expect(left(o.body)["Acme App"]).toContain("single sign-on");
    expect(revenue(o.body)).toBe(10);
    expect((await mia.browser.call("GET", "/v2/overview/transactions")).body.items.map((x: any) => x.customer_id)).toEqual(["m1"]);
    expect((await mia.browser.call("GET", `/v2/overview/transactions?starting_after=${opsTx}`)).body.param).toBe("starting_after");
    expect((await mia.browser.call("GET", `/v2/projects/${owner.projectId}/metrics/overview`)).status).toBe(403);
    const own = await owner.browser.call("GET", "/v2/overview");
    expect(left(own.body)).toEqual({});
    expect(revenue(own.body)).toBe(20 + 40 + 80);
  });
});
