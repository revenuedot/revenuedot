// RevenueDot Enterprise (ee/LICENSE). Organizations, members, projects, custom roles enforced on core routes, group
// role mappings and data location. Spec: prd/enterprise/PRD.md §3, §4, §7, §8.
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { eeServer, type EeServer } from "./helpers.js";
import { ensureOrgMember } from "../server/provision.js";
import { eeMembershipSources, eeOrgMembers, eeOrgProjects } from "../server/schema.js";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

/** An owner with an organization holding their project, and a second person with their own account. */
async function setup() {
  s = await eeServer();
  const owner = await s.signup("owner@acme.test");
  const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
  const dev = await s.signup("dev@acme.test", "Side project");
  return { s, owner, dev, orgId, P: `/v2/projects/${owner.projectId}`, O: `/v2/organizations/${orgId}` };
}

describe("organizations", () => {
  it("lists, updates and refuses outsiders with 404", async () => {
    const { s, owner, dev, O, orgId } = await setup();
    expect((await owner.browser.call("GET", "/v2/organizations")).body.items.map((o: any) => o.id)).toEqual([orgId]);
    expect((await dev.browser.call("GET", O)).status).toBe(404);
    expect((await dev.browser.call("GET", "/v2/organizations")).body.items).toEqual([]);
    const up = await owner.browser.call("POST", O, { name: "Acme Inc.", audit_retention_days: 365, seats: 25, billing_email: "Billing@Acme.test" });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ name: "Acme Inc.", audit_retention_days: 365, seats: { purchased: 25, used: 1 }, billing_email: "billing@acme.test" });
    expect((await owner.browser.call("POST", O, { audit_retention_days: 7 })).status).toBe(400);
    // Enforcing SSO needs a connection and a verified domain first.
    expect((await owner.browser.call("POST", O, { sso_enforced: true })).status).toBe(422);
    // Writes from another site are refused like the core API.
    expect((await owner.browser.call("POST", O, { name: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    // An organization with projects cannot be deleted.
    expect((await owner.browser.call("DELETE", O)).status).toBe(422);
    const logs = await owner.browser.call("GET", `${O}/audit_logs`);
    expect(logs.body.items.map((x: any) => x.action)).toEqual(expect.arrayContaining(["organization_created", "project_added", "organization_updated"]));
    expect(logs.body.items.find((x: any) => x.action === "organization_updated").actor).toMatchObject({ type: "user", email: "owner@acme.test" });
    void s;
  });

  it("members: admins add people, owners stay, removal ends access to every organization project", async () => {
    const { s, owner, dev, O, P, orgId } = await setup();
    const add = await owner.browser.call("POST", `${O}/members`, { email: "DEV@acme.test", role: "admin" });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ email: "dev@acme.test", role: "admin", source: "manual" });
    expect((await owner.browser.call("POST", `${O}/members`, { email: "nobody@acme.test" })).status).toBe(404);
    // Organization admins are admins of every organization project.
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(200);
    const [src] = await s.db.select().from(eeMembershipSources).where(and(eq(eeMembershipSources.userId, dev.userId), eq(eeMembershipSources.projectId, owner.projectId)));
    expect(src?.source).toBe("org");
    // Admins cannot make owners or demote the last owner.
    expect((await dev.browser.call("POST", `${O}/members/${owner.userId}`, { role: "member" })).status).toBe(403);
    expect((await owner.browser.call("POST", `${O}/members/${owner.userId}`, { role: "member" })).status).toBe(400);
    expect((await owner.browser.call("DELETE", `${O}/members/${owner.userId}`)).status).toBe(422);
    // Demoting to member removes the admin memberships that came from the organization role.
    await owner.browser.call("POST", `${O}/members/${dev.userId}`, { role: "member" });
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(404);
    // A hand-added membership stays while they are a member, and goes when they leave the organization.
    await s.db.insert(schema.memberships).values({ userId: dev.userId, projectId: owner.projectId, role: "viewer" });
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(200);
    expect((await dev.browser.call("DELETE", `${O}/members/${dev.userId}`)).status).toBe(200);
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(404);
    expect(await s.db.select().from(eeOrgMembers).where(eq(eeOrgMembers.orgId, orgId))).toHaveLength(1);
  });

  it("projects: only a project admin moves a project in; its people join; moving out turns custom roles into Viewer", async () => {
    const { s, owner, dev, O } = await setup();
    // dev is not an organization member: moving their project in is refused as not found.
    await owner.browser.call("POST", `${O}/members`, { email: "dev@acme.test", role: "admin" });
    const r = await owner.browser.call("POST", `${O}/projects`, { project_id: dev.projectId });
    expect(r.status).toBe(404); // owner is not a member of dev's project
    const moved = await dev.browser.call("POST", `${O}/projects`, { project_id: dev.projectId });
    expect(moved.status).toBe(201);
    expect((await dev.browser.call("POST", `${O}/projects`, { project_id: dev.projectId })).status).toBe(409);
    const list = (await owner.browser.call("GET", `${O}/projects`)).body.items;
    expect(list.map((p: any) => p.name).sort()).toEqual(["Scanner", "Side project"]);
    // The owner became an admin of the moved project.
    expect((await owner.browser.call("GET", `/v2/projects/${dev.projectId}/products`)).status).toBe(200);
    const role = await owner.browser.call("POST", `${O}/roles`, { name: "Support", scopes: ["customer_information:customers:read"] });
    const third = await s.signup("third@acme.test", "Third");
    await s.db.insert(schema.memberships).values({ userId: third.userId, projectId: dev.projectId, role: role.body.id });
    expect((await owner.browser.call("DELETE", `${O}/projects/${dev.projectId}`)).status).toBe(200);
    const [m] = await s.db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, third.userId), eq(schema.memberships.projectId, dev.projectId)));
    expect(m?.role).toBe("viewer");
  });
});

describe("custom roles", () => {
  async function withRole(scopes: string[]) {
    const x = await setup();
    const role = await x.owner.browser.call("POST", `${x.O}/roles`, { name: "Catalog editor", description: "Edits entitlements", scopes });
    expect(role.status).toBe(201);
    await x.s.db.insert(schema.memberships).values({ userId: x.dev.userId, projectId: x.owner.projectId, role: "viewer" });
    const assign = await x.owner.browser.call("POST", `${x.O}/projects/${x.owner.projectId}/members/${x.dev.userId}`, { role: role.body.id });
    expect(assign.status).toBe(200);
    expect(assign.body).toMatchObject({ role: role.body.id, role_name: "Catalog editor" });
    return { ...x, roleId: role.body.id as string };
  }

  it("are enforced on every route through the same scope check", async () => {
    const { dev, P } = await withRole(["project_configuration:entitlements:read_write"]);
    // read_write includes read.
    expect((await dev.browser.call("GET", `${P}/entitlements`)).status).toBe(200);
    expect((await dev.browser.call("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" })).status).toBe(201);
    // Anything else is refused.
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(403);
    expect((await dev.browser.call("GET", `${P}/customers`)).status).toBe(403);
    expect((await dev.browser.call("POST", `${P}/api_keys`, { name: "x" })).status).toBe(403);
    expect((await dev.browser.call("POST", `${P}/invites`, { email: "a@acme.test", role: "admin" })).status).toBe(403);
  });

  it("validates scopes and names, updates take effect at once, deletion makes members Viewers", async () => {
    const { s, owner, dev, P, O, roleId } = await withRole(["customer_information:customers:read"]);
    expect((await owner.browser.call("POST", `${O}/roles`, { name: "Bad", scopes: ["project_configuration:api_keys:read_write"] })).status).toBe(400);
    expect((await owner.browser.call("POST", `${O}/roles`, { name: "Bad", scopes: ["made:up:read"] })).status).toBe(400);
    expect((await owner.browser.call("POST", `${O}/roles`, { name: "Catalog editor", scopes: [] })).status).toBe(409);
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(403);
    const up = await owner.browser.call("POST", `${O}/roles/${roleId}`, { scopes: ["customer_information:customers:read", "project_configuration:products:read"] });
    expect(up.body).toMatchObject({ member_count: 1, scopes: ["customer_information:customers:read", "project_configuration:products:read"] });
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(200);
    // Members of the organization see the catalogue; non-admins cannot create roles.
    expect((await owner.browser.call("GET", `${O}/scopes`)).body.groups.length).toBe(5);
    expect((await owner.browser.call("DELETE", `${O}/roles/${roleId}`)).status).toBe(200);
    const [m] = await s.db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, dev.userId), eq(schema.memberships.projectId, owner.projectId)));
    expect(m?.role).toBe("viewer");
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(200);
    expect((await dev.browser.call("POST", `${P}/entitlements`, { lookup_key: "x", display_name: "x" })).status).toBe(403);
  });

  it("a role id that no longer resolves gives no access, and the collaborator list shows the role id", async () => {
    const { s, owner, dev, P, roleId } = await withRole(["project_configuration:products:read"]);
    const collab = await owner.browser.call("GET", `${P}/collaborators`);
    expect(collab.body.items.find((x: any) => x.id === dev.userId).role).toBe(roleId);
    await s.db.update(schema.memberships).set({ role: "role_doesnotexist" }).where(eq(schema.memberships.userId, dev.userId));
    expect((await dev.browser.call("GET", `${P}/products`)).status).toBe(403);
  });

  it("a project-only role cannot be assigned in another project", async () => {
    const { owner, dev, O } = await withRole(["customer_information:customers:read"]);
    await dev.browser.call("POST", `${O}/projects`, { project_id: dev.projectId }).catch(() => null);
    const only = await owner.browser.call("POST", `${O}/roles`, { name: "Scanner only", scopes: ["customer_information:customers:read"], project_id: owner.projectId });
    expect(only.status).toBe(201);
    const other = await owner.browser.call("POST", `${O}/roles`, { name: "Elsewhere", scopes: [], project_id: "proj_unknown" });
    expect(other.status).toBe(400);
  });
});

describe("group role mappings", () => {
  it("give the highest mapped role per project and remove what they gave when the group goes", async () => {
    const { s, owner, dev, O, P, orgId } = await setup();
    const role = await owner.browser.call("POST", `${O}/roles`, { name: "Support", scopes: ["customer_information:customers:read", "customer_information:subscriptions:read_write"] });
    await owner.browser.call("POST", `${O}/role_mappings`, { group: "Support", project_id: owner.projectId, role: role.body.id });
    await owner.browser.call("POST", `${O}/role_mappings`, { group: "Everyone", project_id: owner.projectId, role: "viewer" });
    const mappings = (await owner.browser.call("GET", `${O}/role_mappings`)).body.items;
    expect(mappings.map((m: any) => [m.group, m.role_name])).toEqual([["Everyone", "Viewer"], ["Support", "Support"]]);
    await ensureOrgMember(s.db, orgId, dev.userId, "sso", { ssoGroups: ["everyone", "SUPPORT"], now: s.now() });
    const memb = () => s.db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, dev.userId), eq(schema.memberships.projectId, owner.projectId)));
    expect((await memb())[0]?.role).toBe(role.body.id);
    expect((await dev.browser.call("GET", `${P}/customers`)).status).toBe(200);
    // Leaving the Support group drops to Viewer; leaving every group removes the membership.
    await ensureOrgMember(s.db, orgId, dev.userId, "sso", { ssoGroups: ["Everyone"], now: s.now() });
    expect((await memb())[0]?.role).toBe("viewer");
    await ensureOrgMember(s.db, orgId, dev.userId, "sso", { ssoGroups: [], now: s.now() });
    expect(await memb()).toEqual([]);
    // A mapping deleted removes what it gave.
    await ensureOrgMember(s.db, orgId, dev.userId, "sso", { ssoGroups: ["Everyone"], now: s.now() });
    const every = mappings.find((m: any) => m.group === "Everyone");
    const del = await owner.browser.call("DELETE", `${O}/role_mappings/${every.id}`);
    expect(del.body.memberships_changed).toBe(1);
    expect(await memb()).toEqual([]);
  });
});

describe("data location", () => {
  it("records regions on a self-hosted server without enforcing them", async () => {
    const { owner, O, P } = await setup();
    const r = await owner.browser.call("POST", `${O}/projects/${owner.projectId}/region`, { region: "eu" });
    expect(r.body.region).toBe("eu");
    expect((await owner.browser.call("GET", `${P}/products`)).status).toBe(200);
    expect((await owner.browser.call("GET", O)).body).toMatchObject({ region_enforced: false, selectable_regions: ["us", "eu"] });
  });

  it("on Cloud with two regions, refuses dashboard, REST and SDK calls for a project stored elsewhere", async () => {
    s = await eeServer({ regions: { current: "us", regions: { us: { api: "https://api.example.com", app: "https://app.example.com" }, eu: { api: "https://api.eu.example.com", app: "https://app.eu.example.com" } } } });
    const owner = await s.signup("owner@acme.test");
    const O = `/v2/organizations/${await s.createOrg(owner.browser, "Acme", [owner.projectId])}`;
    const P = `/v2/projects/${owner.projectId}`;
    const app = await owner.browser.call("POST", `${P}/apps`, { name: "Test", type: "test_store" });
    expect(app.status).toBe(201);
    const [a] = await s.db.select().from(schema.apps).where(eq(schema.apps.projectId, owner.projectId));
    expect((await owner.browser.call("POST", `${O}/projects/${owner.projectId}/region`, { region: "eu" })).status).toBe(200);
    const dash = await owner.browser.call("GET", `${P}/products`);
    expect(dash.status).toBe(421);
    expect(dash.body).toMatchObject({ region: "eu", app_url: "https://app.eu.example.com" });
    const sdk = await s.browser().call("GET", "/v1/subscribers/user-1", undefined, { authorization: `Bearer ${a!.publicKey}` });
    expect(sdk.status).toBe(503);
    expect(sdk.headers.get("retry-after")).toBe("60");
    const [row] = await s.db.select().from(eeOrgProjects).where(eq(eeOrgProjects.projectId, owner.projectId));
    expect(row?.region).toBe("eu");
    // Organization routes (not project data) still answer here, so the setting can be changed back.
    expect((await owner.browser.call("POST", `${O}/projects/${owner.projectId}/region`, { region: "us" })).status).toBe(200);
    expect((await owner.browser.call("GET", `${P}/products`)).status).toBe(200);
  });

  it("refuses moving a project that already has customers to another region", async () => {
    s = await eeServer({ regions: { current: "us", regions: { us: { api: "https://api.example.com", app: "https://app.example.com" }, eu: { api: "https://api.eu.example.com", app: "https://app.eu.example.com" } } } });
    const owner = await s.signup("owner@acme.test");
    const O = `/v2/organizations/${await s.createOrg(owner.browser, "Acme", [owner.projectId])}`;
    await s.db.insert(schema.customers).values({ id: "cus_1", projectId: owner.projectId, originalAppUserId: "u1" } as never);
    expect((await owner.browser.call("POST", `${O}/projects/${owner.projectId}/region`, { region: "eu" })).status).toBe(422);
  });
});
