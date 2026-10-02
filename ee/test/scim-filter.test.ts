// RevenueDot Enterprise (ee/LICENSE). Unit tests for the SCIM filter parser and evaluator and for PATCH application.
// Spec: prd/enterprise/PRD.md §6.
import { describe, expect, it } from "vitest";
import { matches, parseFilter, parsePatchPath, ScimFilterError } from "../server/scim/filter.js";
import { applyPatch, parsePatchBody, ScimPatchError } from "../server/scim/patch.js";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const ENT = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const alice = {
  schemas: [USER], id: "scu_A", externalId: "00uABC", userName: "Alice@Acme.test", active: true, title: "Engineer",
  name: { givenName: "Alice", familyName: "Liddell" }, displayName: "Alice Liddell",
  emails: [{ value: "alice@acme.test", type: "work", primary: true }, { value: "a@home.test", type: "home" }],
  [ENT]: { department: "R&D", manager: { value: "scu_B" } },
  meta: { created: "2026-01-02T03:04:05.000Z", lastModified: "2026-03-01T00:00:00.000Z", version: 'W/"3"' }, loginCount: 7,
};
const m = (f: string, r: unknown = alice) => matches(r, parseFilter(f), { coreSchema: USER });

describe("parseFilter", () => {
  it("parses comparisons, logic, grouping and not with the right precedence", () => {
    expect(parseFilter('userName eq "x"')).toEqual({ type: "compare", path: { attr: "username" }, op: "eq", value: "x" });
    expect(parseFilter("title pr")).toEqual({ type: "pr", path: { attr: "title" } });
    const f = parseFilter('a eq 1 or b eq 2 and c eq 3');
    expect(f.type).toBe("or");
    expect(f.type === "or" && f.right.type).toBe("and");
    expect(parseFilter('not (a eq "x")').type).toBe("not");
    expect(parseFilter('(a eq "x" or b eq "y") and c pr').type).toBe("and");
    expect(parseFilter('USERNAME EQ "x" AND active Eq TRUE').type).toBe("and");
  });

  it("parses value filters, sub-attributes and schema-qualified paths", () => {
    expect(parseFilter('emails[type eq "work"].value eq "a@b.c"')).toMatchObject({ type: "valuePath", path: { attr: "emails" }, sub: "value", then: { op: "eq", value: "a@b.c" } });
    expect(parseFilter('members[value eq "scu_1"]')).toMatchObject({ type: "valuePath", path: { attr: "members" } });
    expect(parseFilter(`${ENT}:manager.value eq "x"`)).toMatchObject({ path: { schema: ENT, attr: "manager", sub: "value" } });
    expect(parseFilter('name.givenName sw "Al"')).toMatchObject({ path: { attr: "name", sub: "givenname" }, op: "sw" });
  });

  it("parses literal values", () => {
    expect(parseFilter("a eq true")).toMatchObject({ value: true });
    expect(parseFilter("a eq null")).toMatchObject({ value: null });
    expect(parseFilter("a gt -1.5")).toMatchObject({ value: -1.5 });
    expect(parseFilter('a eq "quote \\" and \\\\ backslash"')).toMatchObject({ value: 'quote " and \\ backslash' });
  });

  it.each([
    "", "userName", 'userName eq', 'userName xx "a"', 'userName eq "a', 'userName eq abc', '(userName eq "a"', 'userName eq "a")',
    'userName eq "a" and', 'emails[type eq "work"', 'active co true', 'active gt false', 'a eq "x" b eq "y"', 'userName eq "a" & x', "not userName pr",
    `${"(".repeat(40)}a pr${")".repeat(40)}`,
  ])("rejects %j", (f) => {
    expect(() => parseFilter(f)).toThrow(ScimFilterError);
  });
});

describe("matches", () => {
  it("compares strings case-insensitively except id and externalId", () => {
    expect(m('userName eq "alice@acme.test"')).toBe(true);
    expect(m('USERNAME eq "ALICE@ACME.TEST"')).toBe(true);
    expect(m('externalId eq "00uABC"')).toBe(true);
    expect(m('externalId eq "00uabc"')).toBe(false);
    expect(m('id eq "scu_a"')).toBe(false);
    expect(m('id eq "scu_A"')).toBe(true);
    expect(m('displayName co "LIDDELL"')).toBe(true);
    expect(m('userName sw "alice@"')).toBe(true);
    expect(m('userName ew ".TEST"')).toBe(true);
    expect(m('userName ne "bob@acme.test"')).toBe(true);
  });

  it("matches multi-valued attributes and value filters", () => {
    expect(m('emails.value eq "a@home.test"')).toBe(true);
    expect(m('emails eq "alice@acme.test"')).toBe(true);
    expect(m('emails[type eq "work"].value eq "ALICE@acme.test"')).toBe(true);
    expect(m('emails[type eq "home"].value eq "alice@acme.test"')).toBe(false);
    expect(m('emails[type eq "work" and primary eq true]')).toBe(true);
    expect(m('emails[type eq "other"]')).toBe(false);
    expect(m('emails[type eq "work"].value pr')).toBe(true);
    expect(m("phoneNumbers pr")).toBe(false);
    expect(m('members[value eq "scu_1"]', { members: [{ value: "scu_1" }, { value: "scu_2" }] })).toBe(true);
    expect(m('members[value eq "SCU_1"]', { members: [{ value: "scu_1" }] })).toBe(false);
  });

  it("evaluates and, or, not and parentheses", () => {
    expect(m('userName eq "alice@acme.test" and active eq true')).toBe(true);
    expect(m('userName eq "bob@acme.test" or title eq "engineer"')).toBe(true);
    expect(m('not (title eq "Engineer")')).toBe(false);
    expect(m('(userName eq "x" or title pr) and not (active eq false)')).toBe(true);
    expect(m('userName eq "x" or userName eq "y" and title pr')).toBe(false);
  });

  it("compares booleans, numbers, dates and schema-qualified attributes", () => {
    expect(m("active eq true")).toBe(true);
    expect(m("active eq false")).toBe(false);
    expect(m('active eq true', { active: "True" })).toBe(true);
    expect(m("loginCount gt 5")).toBe(true);
    expect(m("loginCount le 6")).toBe(false);
    expect(m('meta.created gt "2026-01-01T00:00:00Z"')).toBe(true);
    expect(m('meta.lastModified lt "2026-03-01T00:00:00Z"')).toBe(false);
    expect(m('meta.lastModified ge "2026-03-01T00:00:00Z"')).toBe(true);
    expect(m(`${ENT}:department eq "r&d"`)).toBe(true);
    expect(m(`${ENT}:manager.value eq "scu_B"`)).toBe(true);
    expect(m(`${USER}:userName eq "alice@acme.test"`)).toBe(true);
    expect(m("nickName eq null")).toBe(true);
    expect(m("title eq null")).toBe(false);
  });
});

describe("PATCH", () => {
  const opts = { coreSchema: USER, readOnly: new Set(["id", "meta", "groups"]) };
  const base = () => ({ schemas: [USER], userName: "alice@acme.test", active: true, name: { givenName: "Alice", familyName: "L" }, emails: [{ value: "alice@acme.test", type: "work", primary: true }] });
  const patch = (ops: unknown[], r: Record<string, unknown> = base()) => applyPatch(r, parsePatchBody({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: ops }), opts);

  it("parses paths", () => {
    expect(parsePatchPath('emails[type eq "work"].value')).toMatchObject({ path: { attr: "emails" }, sub: "value" });
    expect(parsePatchPath(`${ENT}:department`)).toMatchObject({ path: { schema: ENT, attr: "department" } });
    expect(() => parsePatchPath("emails[")).toThrow(ScimFilterError);
  });

  it("applies Okta deactivation and Entra replace in any case", () => {
    expect(patch([{ op: "replace", value: { active: false } }]).active).toBe(false);
    expect(patch([{ op: "Replace", path: "active", value: "False" }]).active).toBe("False");
    expect(patch([{ op: "replace", value: { id: "scu_x", userName: "new@acme.test" } }])).not.toHaveProperty("id");
  });

  it("applies dotted and schema-qualified keys without a path", () => {
    const r = patch([{ op: "replace", value: { "name.givenName": "Alicia", [`${ENT}:department`]: "Sales", title: "Lead" } }]);
    expect(r.name).toEqual({ givenName: "Alicia", familyName: "L" });
    expect(r[ENT]).toEqual({ department: "Sales" });
    expect(r.title).toBe("Lead");
    const r2 = patch([{ op: "add", value: { [ENT]: { employeeNumber: "42" } } }]);
    expect(r2[ENT]).toEqual({ employeeNumber: "42" });
  });

  it("applies paths with sub-attributes and value filters", () => {
    expect(patch([{ op: "replace", path: "name.familyName", value: "Liddell" }]).name).toEqual({ givenName: "Alice", familyName: "Liddell" });
    expect(patch([{ op: "replace", path: 'emails[type eq "work"].value', value: "new@acme.test" }]).emails).toEqual([{ value: "new@acme.test", type: "work", primary: true }]);
    expect(patch([{ op: "replace", path: 'emails[type eq "home"].value', value: "h@x.test" }]).emails).toHaveLength(2);
    expect(patch([{ op: "remove", path: 'emails[type eq "work"]' }])).not.toHaveProperty("emails");
    expect(patch([{ op: "remove", path: "title" }], { ...base(), title: "x" })).not.toHaveProperty("title");
    expect(patch([{ op: "add", path: "emails", value: [{ value: "b@acme.test", type: "other", primary: true }] }]).emails).toEqual([
      { value: "alice@acme.test", type: "work", primary: false }, { value: "b@acme.test", type: "other", primary: true },
    ]);
  });

  it("adds and removes group members, including Entra's remove with a value array", () => {
    const g = { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Eng", members: [{ value: "a" }, { value: "b" }] };
    const go = { coreSchema: "urn:ietf:params:scim:schemas:core:2.0:Group", readOnly: new Set(["id", "meta"]) };
    const p = (ops: unknown[]) => applyPatch(g, parsePatchBody({ Operations: ops }), go);
    expect(p([{ op: "add", path: "members", value: [{ value: "c" }, { value: "a" }] }]).members).toEqual([{ value: "a" }, { value: "b" }, { value: "c" }]);
    expect(p([{ op: "remove", path: 'members[value eq "a"]' }]).members).toEqual([{ value: "b" }]);
    expect(p([{ op: "Remove", path: "members", value: [{ value: "a" }, { value: "b" }] }])).not.toHaveProperty("members");
    expect(p([{ op: "replace", path: "members", value: [{ value: "z" }] }]).members).toEqual([{ value: "z" }]);
    expect(p([{ op: "replace", value: { id: "g1", displayName: "Engineering" } }]).displayName).toBe("Engineering");
  });

  it("rejects malformed operations", () => {
    expect(() => parsePatchBody({ Operations: [] })).toThrow(ScimPatchError);
    expect(() => parsePatchBody({ Operations: [{ op: "move", path: "a" }] })).toThrow(ScimPatchError);
    expect(() => parsePatchBody({ schemas: ["x"], Operations: [{ op: "add", value: {} }] })).toThrow(ScimPatchError);
    expect(() => patch([{ op: "remove" }])).toThrow(/needs a path/);
    expect(() => patch([{ op: "replace", path: "id", value: "x" }])).toThrow(/cannot be changed/);
    expect(() => patch([{ op: "replace", path: "emails[type eq", value: "x" }])).toThrow(ScimPatchError);
    expect(() => patch([{ op: "replace", path: 'emails[type eq "work" or type eq "home"].value', value: "x" }], { ...base(), emails: [] })).toThrow(/matches/);
  });
});
