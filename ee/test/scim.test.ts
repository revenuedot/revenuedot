// RevenueDot Enterprise (ee/LICENSE). SCIM 2.0 conformance and provisioning tests: discovery, bearer tokens, Users and
// Groups CRUD, filters, pagination, PATCH as Okta and Microsoft Entra ID send it, role mappings and deprovisioning.
// Spec: prd/enterprise/PRD.md §6.
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { eeServer, type EeServer, type Res } from "./helpers.js";
import { eeOrgAuditLogs, eeOrgMembers, eeScimTokens, eeSsoDomains } from "../server/schema.js";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ENT = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const BASE = "https://dash.example.com/scim/v2";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

async function scimCall(srv: EeServer, token: string | null, method: string, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await srv.app.fetch(new Request(`https://dash.example.com/scim/v2${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "content-type": "application/scim+json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  }));
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text, headers: res.headers, cookie: res.headers.get("set-cookie") };
}

/** An organization owned by owner@acme.test with its project, the verified domain acme.test and a SCIM token. */
async function setup() {
  s = await eeServer();
  const srv = s;
  const owner = await srv.signup("owner@acme.test", "Acme App");
  const orgId = await srv.createOrg(owner.browser, "Acme", [owner.projectId]);
  await srv.db.insert(eeSsoDomains).values({ domain: "acme.test", orgId, token: "t", verifiedAt: srv.now() });
  const t = await owner.browser.call("POST", `/v2/organizations/${orgId}/scim/tokens`, { name: "Okta" });
  expect(t.status).toBe(201);
  const token = t.body.token as string;
  const scim = (method: string, path: string, json?: unknown, headers?: Record<string, string>) => scimCall(srv, token, method, path, json, headers);
  const createUser = async (userName: string, extra: Record<string, unknown> = {}) => {
    const r = await scim("POST", "/Users", { schemas: [USER], userName, name: { givenName: userName.split("@")[0], familyName: "Test" }, emails: [{ value: userName, type: "work", primary: true }], active: true, ...extra });
    if (r.status !== 201) throw new Error(`create ${userName}: ${r.status} ${r.text}`);
    return r.body as { id: string; meta: { version: string } };
  };
  return { srv, owner, orgId, token, tokenId: t.body.id as string, scim, createUser };
}

const membership = async (srv: EeServer, userId: string, projectId: string) =>
  (await srv.db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.projectId, projectId))).limit(1))[0] ?? null;
const userIdFor = async (srv: EeServer, email: string) => (await srv.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1))[0]!.id;

describe("SCIM tokens (dashboard)", () => {
  it("creates a token once, stores only its hash, lists and revokes it", async () => {
    const { srv, owner, orgId, token, tokenId, scim } = await setup();
    expect(token).toMatch(/^rdscim_[0-9a-f]{64}$/);
    const [row] = await srv.db.select().from(eeScimTokens).where(eq(eeScimTokens.id, tokenId));
    expect(row!.tokenHash).not.toContain(token.slice(7));
    expect(row!.prefix).toBe(token.slice(0, 13));

    const list = await owner.browser.call("GET", `/v2/organizations/${orgId}/scim/tokens`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.text).not.toContain(token);
    expect(list.body.items[0]).toMatchObject({ object: "scim_token", id: tokenId, name: "Okta", revoked_at: null });

    const created = await owner.browser.call("POST", `/v2/organizations/${orgId}/scim/tokens`, { name: "Entra" });
    expect(created.body.base_url).toBe(BASE);

    expect((await scim("GET", "/Users")).status).toBe(200);
    const del = await owner.browser.call("DELETE", `/v2/organizations/${orgId}/scim/tokens/${tokenId}`);
    expect(del.status).toBe(200);
    expect(del.body.revoked_at).toBeTypeOf("number");
    const after = await scim("GET", "/Users");
    expect(after.status).toBe(401);
    expect(after.body).toMatchObject({ schemas: [ERROR], status: "401" });

    const audit = await srv.db.select().from(eeOrgAuditLogs).where(eq(eeOrgAuditLogs.orgId, orgId));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["scim_token_created", "scim_token_revoked"]));
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("lets only organization owners and admins manage tokens", async () => {
    const { srv, orgId } = await setup();
    const bob = await srv.signup("bob@other.test");
    expect((await bob.browser.call("GET", `/v2/organizations/${orgId}/scim/tokens`)).status).toBe(404);
    await srv.db.insert(eeOrgMembers).values({ orgId, userId: bob.userId, role: "member" });
    expect((await bob.browser.call("POST", `/v2/organizations/${orgId}/scim/tokens`, { name: "x" })).status).toBe(403);
  });
});

describe("SCIM discovery and authentication", () => {
  it("serves ServiceProviderConfig, ResourceTypes and Schemas", async () => {
    const { scim } = await setup();
    const spc = await scim("GET", "/ServiceProviderConfig");
    expect(spc.status).toBe(200);
    expect(spc.headers.get("content-type")).toContain("application/scim+json");
    expect(spc.body).toMatchObject({
      patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 }, changePassword: { supported: false },
      sort: { supported: false }, etag: { supported: true }, authenticationSchemes: [{ type: "oauthbearertoken" }],
    });
    const rt = await scim("GET", "/ResourceTypes");
    expect(rt.body.Resources.map((x: any) => x.id)).toEqual(["User", "Group"]);
    expect((await scim("GET", "/ResourceTypes/User")).body).toMatchObject({ endpoint: "/Users", schema: USER, schemaExtensions: [{ schema: ENT, required: false }] });
    const schemas = await scim("GET", "/Schemas");
    expect(schemas.body.totalResults).toBe(3);
    const user = await scim("GET", `/Schemas/${USER}`);
    expect(user.body.attributes.find((a: any) => a.name === "userName")).toMatchObject({ required: true, uniqueness: "server", caseExact: false });
    expect((await scim("GET", `/Schemas/${ENT}`)).status).toBe(200);
    expect((await scim("GET", "/Schemas/urn:nope")).status).toBe(404);
    expect((await scim("GET", "/Bulk")).body).toMatchObject({ schemas: [ERROR], status: "404" });
  });

  it("refuses missing, malformed and unknown tokens, and keeps organizations apart", async () => {
    const { srv, scim, createUser } = await setup();
    const alice = await createUser("alice@acme.test");
    expect((await scimCall(srv, null, "GET", "/Users")).status).toBe(401);
    expect((await scimCall(srv, "nope", "GET", "/Users")).status).toBe(401);
    const missing = await scimCall(srv, `rdscim_${"0".repeat(64)}`, "GET", "/Users");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const other = await srv.signup("owner@globex.test", "Globex");
    const otherOrg = await srv.createOrg(other.browser, "Globex", [other.projectId]);
    const t2 = await other.browser.call("POST", `/v2/organizations/${otherOrg}/scim/tokens`, { name: "Okta" });
    const theirs = (m: string, p: string, j?: unknown) => scimCall(srv, t2.body.token, m, p, j);
    expect((await theirs("GET", `/Users/${alice.id}`)).status).toBe(404);
    expect((await theirs("GET", "/Users")).body.totalResults).toBe(0);
    expect((await theirs("DELETE", `/Users/${alice.id}`)).status).toBe(404);
    // Their organization did not verify acme.test, so it cannot claim the account either.
    const claim = await theirs("POST", "/Users", { schemas: [USER], userName: "alice@acme.test" });
    expect(claim.status).toBe(400);
    expect(claim.body.scimType).toBe("invalidValue");
    expect((await scim("GET", `/Users/${alice.id}`)).status).toBe(200);
  });

  it("records the token's last use at most once a minute", async () => {
    const { srv, scim, tokenId } = await setup();
    await scim("GET", "/Users");
    const first = (await srv.db.select().from(eeScimTokens).where(eq(eeScimTokens.id, tokenId)))[0]!.lastUsedAt!;
    srv.advance(30_000);
    await scim("GET", "/Users");
    expect((await srv.db.select().from(eeScimTokens).where(eq(eeScimTokens.id, tokenId)))[0]!.lastUsedAt!.getTime()).toBe(first.getTime());
    srv.advance(31_000);
    await scim("GET", "/Users");
    expect((await srv.db.select().from(eeScimTokens).where(eq(eeScimTokens.id, tokenId)))[0]!.lastUsedAt!.getTime()).toBe(first.getTime() + 61_000);
  });
});

describe("SCIM Users", () => {
  it("creates a user with Location and meta, and makes the account an organization member", async () => {
    const { srv, scim, orgId } = await setup();
    const r = await scim("POST", "/Users", {
      schemas: [USER, ENT], userName: "Alice@Acme.test", externalId: "00uA", password: "Secret123!", title: "Engineer",
      name: { givenName: "Alice", familyName: "Liddell" }, displayName: "Alice Liddell",
      emails: [{ value: "alice@acme.test", type: "work", primary: true }], [ENT]: { department: "R&D" },
    });
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toContain("application/scim+json");
    expect(r.headers.get("location")).toBe(`${BASE}/Users/${r.body.id}`);
    expect(r.headers.get("etag")).toBe('W/"1"');
    expect(r.body).toMatchObject({
      schemas: [USER, ENT], userName: "Alice@Acme.test", externalId: "00uA", active: true, title: "Engineer", [ENT]: { department: "R&D" },
      meta: { resourceType: "User", location: `${BASE}/Users/${r.body.id}`, version: 'W/"1"' },
    });
    expect(r.body.meta.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.text).not.toContain("Secret123!");
    const userId = await userIdFor(srv, "alice@acme.test");
    const [m] = await srv.db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId)));
    expect(m).toMatchObject({ source: "scim", active: true, role: "member" });
    const [u] = await srv.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u!.passwordHash).toBeNull();
    expect(u!.name).toBe("Alice Liddell");

    const got = await scim("GET", `/Users/${r.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.userName).toBe("Alice@Acme.test");
    expect((await scim("GET", `/Users/${r.body.id}`, undefined, { "if-none-match": 'W/"1"' })).status).toBe(304);
    expect((await scim("GET", "/Users/scu_nope")).status).toBe(404);

    const [log] = await srv.db.select().from(eeOrgAuditLogs).where(and(eq(eeOrgAuditLogs.orgId, orgId), eq(eeOrgAuditLogs.action, "scim_user_created")));
    expect(log).toMatchObject({ actorType: "scim", targetId: r.body.id });
  });

  it("refuses a duplicate userName in any case, a missing userName and an unverified email domain", async () => {
    const { scim, createUser, token } = await setup();
    await createUser("alice@acme.test");
    const dup = await scim("POST", "/Users", { schemas: [USER], userName: "ALICE@acme.TEST" });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ schemas: [ERROR], status: "409", scimType: "uniqueness" });
    const none = await scim("POST", "/Users", { schemas: [USER], emails: [{ value: "x@acme.test" }] });
    expect(none.status).toBe(400);
    expect(none.body.scimType).toBe("invalidValue");
    const foreign = await scim("POST", "/Users", { schemas: [USER], userName: "eve", emails: [{ value: "eve@evil.test", primary: true }] });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ scimType: "invalidValue" });
    expect(foreign.body.detail).toContain("evil.test");
    const noEmail = await scim("POST", "/Users", { schemas: [USER], userName: "carol" });
    expect(noEmail.status).toBe(400);
    const bad = await s!.app.fetch(new Request(`${BASE}/Users`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, body: "{not json" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).scimType).toBe("invalidSyntax");
    // Plain application/json bodies work too.
    const json = await s!.app.fetch(new Request(`${BASE}/Users`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ schemas: [USER], userName: "dave@acme.test" }) }));
    expect(json.status).toBe(201);
  });

  it("lists with filters, attributes and pagination", async () => {
    const { scim, createUser } = await setup();
    await createUser("alice@acme.test", { externalId: "ext-A", title: "Engineer" });
    await createUser("bob@acme.test", { externalId: "ext-B", emails: [{ value: "bob@acme.test", type: "work" }, { value: "bobby@acme.test", type: "home" }] });
    await createUser("carol@acme.test", { active: false });
    for (let i = 0; i < 4; i++) await createUser(`user${i}@acme.test`);

    const f = async (filter: string) => (await scim("GET", `/Users?filter=${encodeURIComponent(filter)}`)).body;
    const names = (b: any) => b.Resources.map((x: any) => x.userName).sort();
    expect(names(await f('userName eq "ALICE@ACME.TEST"'))).toEqual(["alice@acme.test"]);
    expect(names(await f('externalId eq "ext-B"'))).toEqual(["bob@acme.test"]);
    expect((await f('externalId eq "EXT-B"')).totalResults).toBe(0);
    expect(names(await f('emails[type eq "work"].value eq "bob@acme.test"'))).toEqual(["bob@acme.test"]);
    expect(names(await f('emails[type eq "home"].value eq "bob@acme.test"'))).toEqual([]);
    expect(names(await f('userName eq "alice@acme.test" or userName eq "bob@acme.test"'))).toEqual(["alice@acme.test", "bob@acme.test"]);
    expect(names(await f('userName sw "user" and not (userName eq "user0@acme.test")'))).toEqual(["user1@acme.test", "user2@acme.test", "user3@acme.test"]);
    expect(names(await f("active eq false"))).toEqual(["carol@acme.test"]);
    expect(names(await f('title pr'))).toEqual(["alice@acme.test"]);
    const bad = await scim("GET", `/Users?filter=${encodeURIComponent('userName eq')}`);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ schemas: [ERROR], status: "400", scimType: "invalidFilter" });
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('userName regex "x"')}`)).body.scimType).toBe("invalidFilter");

    const all = await scim("GET", "/Users");
    expect(all.body).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: 7, startIndex: 1, itemsPerPage: 7 });
    const p1 = (await scim("GET", "/Users?startIndex=1&count=3")).body;
    const p3 = (await scim("GET", "/Users?startIndex=7&count=3")).body;
    expect(p1).toMatchObject({ totalResults: 7, startIndex: 1, itemsPerPage: 3 });
    expect(p3).toMatchObject({ totalResults: 7, startIndex: 7, itemsPerPage: 1 });
    expect((await scim("GET", "/Users?count=0")).body).toMatchObject({ totalResults: 7, itemsPerPage: 0, Resources: [] });
    expect((await scim("GET", "/Users?count=1000")).body.itemsPerPage).toBe(7);
    const ids = new Set<string>();
    for (let i = 1; i <= 7; i += 2) for (const x of (await scim("GET", `/Users?startIndex=${i}&count=2`)).body.Resources) ids.add(x.id);
    expect(ids.size).toBe(7);

    const proj = (await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "alice@acme.test"')}&attributes=userName,emails.value`)).body.Resources[0];
    expect(Object.keys(proj).sort()).toEqual(["emails", "id", "schemas", "userName"]);
    expect(proj.emails).toEqual([{ value: "alice@acme.test" }]);
    const ex = (await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "alice@acme.test"')}&excludedAttributes=emails,name`)).body.Resources[0];
    expect(ex).not.toHaveProperty("emails");
    expect(ex).not.toHaveProperty("name");
    expect(ex).toHaveProperty("userName");
  });

  it("replaces a user with PUT and honours If-Match", async () => {
    const { srv, scim, createUser } = await setup();
    const a = await createUser("alice@acme.test", { title: "Engineer" });
    const put = await scim("PUT", `/Users/${a.id}`, { schemas: [USER], userName: "alice@acme.test", displayName: "Alice L", emails: [{ value: "alice@acme.test", primary: true }] }, { "if-match": 'W/"1"' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ displayName: "Alice L", active: true, meta: { version: 'W/"2"' } });
    expect(put.body).not.toHaveProperty("title");
    expect(put.body).not.toHaveProperty("name");
    const stale = await scim("PUT", `/Users/${a.id}`, { schemas: [USER], userName: "alice@acme.test" }, { "if-match": 'W/"1"' });
    expect(stale.status).toBe(412);
    expect(stale.body.schemas).toEqual([ERROR]);
    expect((await scim("PATCH", `/Users/${a.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "title", value: "x" }] }, { "if-match": 'W/"9"' })).status).toBe(412);
    expect((await scim("DELETE", `/Users/${a.id}`, undefined, { "if-match": 'W/"1"' })).status).toBe(412);
    expect((await scim("PUT", `/Users/${a.id}`, { schemas: [USER], userName: "alice@acme.test", title: "x" }, { "if-match": "*" })).status).toBe(200);

    // A new userName and address on a verified domain move the account's email too.
    const moved = await scim("PUT", `/Users/${a.id}`, { schemas: [USER], userName: "alice.l@acme.test" });
    expect(moved.status).toBe(200);
    expect((await srv.db.select().from(schema.users).where(eq(schema.users.email, "alice.l@acme.test"))).length).toBe(1);
    await createUser("bob@acme.test");
    const clash = await scim("PUT", `/Users/${a.id}`, { schemas: [USER], userName: "BOB@acme.test" });
    expect(clash.status).toBe(409);
    expect(clash.body.scimType).toBe("uniqueness");
    expect((await scim("PUT", `/Users/${a.id}`, { schemas: [USER], userName: "alice@evil.test" })).status).toBe(400);
  });

  it("applies PATCH as Okta and Entra send it", async () => {
    const { srv, scim, createUser, orgId } = await setup();
    const a = await createUser("alice@acme.test");
    const userId = await userIdFor(srv, "alice@acme.test");
    const patch = (ops: unknown[]) => scim("PATCH", `/Users/${a.id}`, { schemas: [PATCH], Operations: ops });

    // Okta: no path, an object value.
    const okta = await patch([{ op: "replace", value: { active: false } }]);
    expect(okta.status).toBe(200);
    expect(okta.body.active).toBe(false);
    expect((await srv.db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId))))[0]!.active).toBe(false);
    const back = await patch([{ op: "replace", value: { active: true } }]);
    expect(back.body.active).toBe(true);
    expect((await srv.db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId))))[0]!.active).toBe(true);

    // Entra: capitalised op, a path, and a string boolean.
    const entra = await patch([{ op: "Replace", path: "active", value: "False" }]);
    expect(entra.status).toBe(200);
    expect(entra.body.active).toBe(false);
    expect((await patch([{ op: "Replace", path: "active", value: "True" }])).body.active).toBe(true);

    // Dotted and schema-qualified keys without a path.
    const dotted = await patch([{ op: "replace", value: { "name.givenName": "Alicia", [`${ENT}:department`]: "Sales", title: "Lead" } }]);
    expect(dotted.body).toMatchObject({ name: { givenName: "Alicia", familyName: "Test" }, [ENT]: { department: "Sales" }, title: "Lead" });
    expect(dotted.body.schemas).toEqual([USER, ENT]);

    const paths = await patch([
      { op: "Add", path: "name.familyName", value: "Liddell" },
      { op: "Replace", path: "displayName", value: "Alicia Liddell" },
      { op: "Replace", path: "externalId", value: "aad-1" },
      { op: "Add", path: 'emails[type eq "home"].value', value: "home@acme.test" },
      { op: "Remove", path: "title" },
    ]);
    expect(paths.status).toBe(200);
    expect(paths.body).toMatchObject({ displayName: "Alicia Liddell", externalId: "aad-1", name: { familyName: "Liddell" } });
    expect(paths.body).not.toHaveProperty("title");
    expect(paths.body.emails).toHaveLength(2);

    const rename = await patch([{ op: "replace", path: 'emails[type eq "work"].value', value: "alicia@acme.test" }, { op: "replace", path: "userName", value: "alicia@acme.test" }]);
    expect(rename.body.userName).toBe("alicia@acme.test");
    expect((await srv.db.select().from(schema.users).where(eq(schema.users.id, userId)))[0]!.email).toBe("alicia@acme.test");

    expect((await patch([{ op: "replace", path: "id", value: "x" }])).body.scimType).toBe("mutability");
    expect((await patch([{ op: "replace", path: "active", value: "maybe" }])).body.scimType).toBe("invalidValue");
    expect((await patch([{ op: "remove" }])).body.scimType).toBe("noTarget");
    expect((await patch([{ op: "replace", path: "emails[type", value: "x" }])).body.scimType).toBe("invalidPath");
    expect((await scim("PATCH", `/Users/${a.id}`, { Operations: "nope" })).body.scimType).toBe("invalidSyntax");

    const actions = (await srv.db.select().from(eeOrgAuditLogs).where(eq(eeOrgAuditLogs.orgId, orgId))).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["scim_user_deactivated", "scim_user_reactivated", "scim_user_updated"]));
  });
});

describe("SCIM Groups and role mappings", () => {
  it("creates groups with members, filters them and patches members as Okta and Entra do", async () => {
    const { srv, owner, orgId, scim, createUser } = await setup();
    const a = await createUser("alice@acme.test");
    const b = await createUser("bob@acme.test");
    const c = await createUser("carol@acme.test");

    const g = await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Engineering", externalId: "grp-1", members: [{ value: a.id }, { value: b.id }] });
    expect(g.status).toBe(201);
    expect(g.headers.get("location")).toBe(`${BASE}/Groups/${g.body.id}`);
    expect(g.body).toMatchObject({ schemas: [GROUP], displayName: "Engineering", meta: { resourceType: "Group", version: 'W/"1"' } });
    expect(g.body.members.map((m: any) => m.value).sort()).toEqual([a.id, b.id].sort());
    expect((await scim("POST", "/Groups", { schemas: [GROUP], displayName: "engineering" })).body).toMatchObject({ status: "409", scimType: "uniqueness" });
    expect((await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Bad", members: [{ value: "scu_nope" }] })).body.scimType).toBe("invalidValue");
    await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Sales" });

    const byName = await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "ENGINEERING"')}&excludedAttributes=members`);
    expect(byName.body.totalResults).toBe(1);
    expect(byName.body.Resources[0]).not.toHaveProperty("members");
    const byMember = await scim("GET", `/Groups?filter=${encodeURIComponent(`members[value eq "${a.id}"]`)}`);
    expect(byMember.body.Resources.map((x: any) => x.displayName)).toEqual(["Engineering"]);
    expect((await scim("GET", "/Groups")).body.totalResults).toBe(2);
    const alice = await scim("GET", `/Users/${a.id}`);
    expect(alice.body.groups).toEqual([{ value: g.body.id, display: "Engineering", $ref: `${BASE}/Groups/${g.body.id}` }]);

    const patch = (ops: unknown[]) => scim("PATCH", `/Groups/${g.body.id}`, { schemas: [PATCH], Operations: ops });
    const add = await patch([{ op: "add", path: "members", value: [{ value: c.id }] }]);
    expect(add.status).toBe(200);
    expect(add.body.members).toHaveLength(3);
    const okta = await patch([{ op: "remove", path: `members[value eq "${a.id}"]` }]);
    expect(okta.body.members.map((m: any) => m.value).sort()).toEqual([b.id, c.id].sort());
    const entra = await patch([{ op: "Remove", path: "members", value: [{ value: b.id }, { value: c.id }] }]);
    expect(entra.body.members ?? []).toEqual([]);
    const replace = await patch([{ op: "replace", path: "members", value: [{ value: a.id }] }, { op: "replace", value: { id: g.body.id, displayName: "Eng" } }]);
    expect(replace.body).toMatchObject({ displayName: "Eng", members: [{ value: a.id }] });
    expect((await patch([{ op: "add", path: "members", value: [{ value: "scu_nope" }] }])).body.scimType).toBe("invalidValue");

    const put = await scim("PUT", `/Groups/${g.body.id}`, { schemas: [GROUP], displayName: "Eng", members: [{ value: b.id }] });
    expect(put.body.members.map((m: any) => m.value)).toEqual([b.id]);

    const list = await owner.browser.call("GET", `/v2/organizations/${orgId}/scim/groups`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: any) => [x.display_name, x.member_count])).toEqual([["Eng", 1], ["Sales", 0]]);

    expect((await scim("DELETE", `/Groups/${g.body.id}`)).status).toBe(204);
    expect((await scim("GET", `/Groups/${g.body.id}`)).status).toBe(404);
    const actions = (await srv.db.select().from(eeOrgAuditLogs).where(eq(eeOrgAuditLogs.orgId, orgId))).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["scim_group_created", "scim_group_updated", "scim_group_deleted"]));
  });

  it("gives group members the mapped project role at once and removes it when they leave", async () => {
    const { srv, owner, orgId, scim, createUser } = await setup();
    const a = await createUser("alice@acme.test");
    const aliceId = await userIdFor(srv, "alice@acme.test");
    const map = await owner.browser.call("POST", `/v2/organizations/${orgId}/role_mappings`, { group: "engineering", project_id: owner.projectId, role: "developer" });
    expect(map.status).toBe(201);
    expect(await membership(srv, aliceId, owner.projectId)).toBeNull();

    const g = await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Engineering", members: [{ value: a.id }] });
    expect((await membership(srv, aliceId, owner.projectId))?.role).toBe("developer");
    const collabs = await owner.browser.call("GET", `/v2/projects/${owner.projectId}/collaborators`);
    expect(collabs.status).toBe(200);
    expect(collabs.body.items.map((x: any) => x.id)).toContain(aliceId);

    // Renaming the group away from the mapping removes it; renaming back restores it.
    await scim("PATCH", `/Groups/${g.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "displayName", value: "Marketing" }] });
    expect(await membership(srv, aliceId, owner.projectId)).toBeNull();
    await scim("PATCH", `/Groups/${g.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "displayName", value: "Engineering" }] });
    expect((await membership(srv, aliceId, owner.projectId))?.role).toBe("developer");

    await scim("PATCH", `/Groups/${g.body.id}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${a.id}"]` }] });
    expect(await membership(srv, aliceId, owner.projectId)).toBeNull();
    await scim("PATCH", `/Groups/${g.body.id}`, { schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: a.id }] }] });
    expect((await membership(srv, aliceId, owner.projectId))?.role).toBe("developer");
    await scim("DELETE", `/Groups/${g.body.id}`);
    expect(await membership(srv, aliceId, owner.projectId)).toBeNull();
  });
});

describe("SCIM and existing accounts", () => {
  it("an account whose address nobody confirmed loses its password and sessions when SCIM creates the person", async () => {
    const { srv, scim } = await setup();
    // Someone signed up with Bob's work address before the organization provisioned him; nobody confirmed it.
    const squatter = await srv.signup("bob@acme.test", "Squat");
    const u = await scim("POST", "/Users", { schemas: [USER], userName: "bob@acme.test", emails: [{ value: "bob@acme.test", primary: true }] });
    expect(u.status).toBe(201);
    expect((await squatter.browser.call("GET", "/auth/me")).status).toBe(401);
    expect((await srv.browser().call("POST", "/auth/login", { email: "bob@acme.test", password: "correct horse battery" })).status).toBe(401);
    const [row] = await srv.db.select().from(schema.users).where(eq(schema.users.email, "bob@acme.test"));
    expect(row!.passwordHash).toBeNull();
    expect(row!.emailVerifiedAt).not.toBeNull();
  });
});

describe("SCIM deprovisioning", () => {
  it("ends a signed-in person's project access and sessions on active false, restores access on reactivation, and DELETE removes it", async () => {
    const { srv, owner, orgId, scim } = await setup();
    // Alice signed up with a password, and confirmed her address, before the organization provisioned her.
    const alice = await srv.signup("alice@acme.test", "Alice's own");
    await srv.db.update(schema.users).set({ emailVerifiedAt: srv.now() }).where(eq(schema.users.id, alice.userId));
    const u = await scim("POST", "/Users", { schemas: [USER], userName: "alice@acme.test", emails: [{ value: "alice@acme.test", primary: true }] });
    expect(u.status).toBe(201);
    await owner.browser.call("POST", `/v2/organizations/${orgId}/role_mappings`, { group: "Eng", project_id: owner.projectId, role: "viewer" });
    await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Eng", members: [{ value: u.body.id }] });
    expect((await membership(srv, alice.userId, owner.projectId))?.role).toBe("viewer");
    expect((await alice.browser.call("GET", `/v2/projects/${owner.projectId}/collaborators`)).status).toBe(200);
    expect((await alice.browser.call("GET", "/auth/me")).status).toBe(200);

    const off = await scim("PATCH", `/Users/${u.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
    expect(off.status).toBe(200);
    expect(await membership(srv, alice.userId, owner.projectId)).toBeNull();
    expect((await alice.browser.call("GET", "/auth/me")).status).toBe(401);
    // Her password still works, but the organization's project is gone; her own project is not the organization's.
    const again = srv.browser();
    expect((await again.call("POST", "/auth/login", { email: "alice@acme.test", password: "correct horse battery" })).status).toBe(200);
    expect((await again.call("GET", `/v2/projects/${owner.projectId}/collaborators`)).status).not.toBe(200);
    expect(await membership(srv, alice.userId, alice.projectId)).not.toBeNull();

    const on = await scim("PATCH", `/Users/${u.body.id}`, { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "True" }] });
    expect(on.body.active).toBe(true);
    expect((await membership(srv, alice.userId, owner.projectId))?.role).toBe("viewer");

    const del = await scim("DELETE", `/Users/${u.body.id}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe("");
    expect(await membership(srv, alice.userId, owner.projectId)).toBeNull();
    expect((await again.call("GET", "/auth/me")).status).toBe(401);
    expect((await scim("GET", `/Users/${u.body.id}`)).status).toBe(404);
    const groups = await scim("GET", "/Groups");
    expect(groups.body.Resources[0].members ?? []).toEqual([]);
    const actions = (await srv.db.select().from(eeOrgAuditLogs).where(eq(eeOrgAuditLogs.orgId, orgId))).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["scim_user_deactivated", "scim_user_reactivated", "scim_user_deleted"]));
  });

  it("creates an inactive user deprovisioned and never deactivates the last owner", async () => {
    const { srv, owner, orgId, scim } = await setup();
    const r = await scim("POST", "/Users", { schemas: [USER], userName: "zoe@acme.test", active: "False" });
    expect(r.status).toBe(201);
    expect(r.body.active).toBe(false);
    const zoeId = await userIdFor(srv, "zoe@acme.test");
    expect((await srv.db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, zoeId)))).filter((m) => m.active)).toEqual([]);

    const o = await scim("POST", "/Users", { schemas: [USER], userName: "owner@acme.test" });
    expect(o.status).toBe(201);
    const off = await scim("PATCH", `/Users/${o.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
    expect(off.status).toBe(400);
    expect((await owner.browser.call("GET", "/auth/me")).status).toBe(200);
    expect((await scim("DELETE", `/Users/${o.body.id}`)).status).toBe(400);

    // After the organization drops the domain, deactivation still works; reactivation needs the domain again.
    const yan = await scim("POST", "/Users", { schemas: [USER], userName: "yan@acme.test" });
    await srv.db.update(eeSsoDomains).set({ verifiedAt: null }).where(eq(eeSsoDomains.domain, "acme.test"));
    const offYan = await scim("PATCH", `/Users/${yan.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
    expect(offYan.status).toBe(200);
    const onYan = await scim("PATCH", `/Users/${yan.body.id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: true } }] });
    expect(onYan.status).toBe(400);
    expect(onYan.body.scimType).toBe("invalidValue");
  });
});
