// RevenueDot Enterprise (ee/LICENSE). SCIM resource shapes: errors, discovery documents (RFC 7643 §5-§7), input
// validation for Users and Groups, and attribute projection. Spec: prd/enterprise/PRD.md §6.
import { parseAttrPath, ScimFilterError, type AttrPath } from "./filter.js";
import { CANON, isObj } from "./patch.js";

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const ENTERPRISE_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SPC_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const RT_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";
export const DOCS = "https://revenuedot.app/docs/enterprise/scim";
export const MAX_RESULTS = 200;

export type ScimType = "uniqueness" | "invalidFilter" | "invalidValue" | "invalidSyntax" | "invalidPath" | "noTarget" | "mutability" | "tooMany";

export class ScimError extends Error {
  constructor(public status: number, message: string, public scimType?: ScimType) { super(message); }
}

export const errorBody = (status: number, detail: string, scimType?: string) => ({ schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail });

// ---- Discovery ----

interface AttrOpts { type?: string; multi?: boolean; required?: boolean; caseExact?: boolean; mutability?: string; returned?: string; uniqueness?: string; sub?: unknown[]; canonical?: string[]; desc?: string }
const a = (name: string, o: AttrOpts = {}) => ({
  name, type: o.type ?? (o.sub ? "complex" : "string"), multiValued: !!o.multi, description: o.desc ?? name, required: !!o.required,
  ...(o.sub ? { subAttributes: o.sub } : { caseExact: !!o.caseExact }), ...(o.canonical ? { canonicalValues: o.canonical } : {}),
  mutability: o.mutability ?? "readWrite", returned: o.returned ?? "default", uniqueness: o.uniqueness ?? "none",
});
const multiSub = (types: string[]) => [a("value"), a("display"), a("type", { canonical: types }), a("primary", { type: "boolean" })];

const USER_ATTRS = [
  a("userName", { required: true, uniqueness: "server", desc: "Unique identifier for the user; usually the work email address." }),
  a("name", { sub: [a("formatted"), a("familyName"), a("givenName"), a("middleName"), a("honorificPrefix"), a("honorificSuffix")] }),
  a("displayName"), a("nickName"), a("profileUrl", { type: "reference" }), a("title"), a("userType"), a("preferredLanguage"), a("locale"), a("timezone"),
  a("active", { type: "boolean", desc: "False removes the person's access to the organization's projects and ends their sessions." }),
  a("password", { mutability: "writeOnly", returned: "never", desc: "Ignored: RevenueDot accounts provisioned by SCIM sign in with single sign-on." }),
  a("emails", { multi: true, sub: multiSub(["work", "home", "other"]), desc: "The primary (or work, or first) address is the RevenueDot account's email." }),
  a("phoneNumbers", { multi: true, sub: multiSub(["work", "home", "mobile", "fax", "pager", "other"]) }),
  a("addresses", { multi: true, sub: [a("formatted"), a("streetAddress"), a("locality"), a("region"), a("postalCode"), a("country"), a("type", { canonical: ["work", "home", "other"] }), a("primary", { type: "boolean" })] }),
  a("groups", { multi: true, mutability: "readOnly", sub: [a("value", { mutability: "readOnly" }), a("$ref", { type: "reference", mutability: "readOnly" }), a("display", { mutability: "readOnly" })] }),
  a("roles", { multi: true, sub: multiSub([]) }),
  a("entitlements", { multi: true, sub: multiSub([]) }),
];
const GROUP_ATTRS = [
  a("displayName", { required: true, uniqueness: "server", desc: "Role mappings match groups by this name (case-insensitive)." }),
  a("members", { multi: true, sub: [a("value", { caseExact: true, mutability: "immutable" }), a("$ref", { type: "reference", mutability: "immutable" }), a("display", { mutability: "readOnly" }), a("type", { canonical: ["User"], mutability: "immutable" })] }),
];
const ENTERPRISE_ATTRS = [
  a("employeeNumber"), a("costCenter"), a("organization"), a("division"), a("department"),
  a("manager", { sub: [a("value"), a("$ref", { type: "reference" }), a("displayName", { mutability: "readOnly" })] }),
];

export function schemaDocs(base: string) {
  const doc = (id: string, name: string, description: string, attributes: unknown[]) => ({
    schemas: [SCHEMA_SCHEMA], id, name, description, attributes, meta: { resourceType: "Schema", location: `${base}/Schemas/${id}` },
  });
  return [
    doc(USER_SCHEMA, "User", "User Account", USER_ATTRS),
    doc(GROUP_SCHEMA, "Group", "Group", GROUP_ATTRS),
    doc(ENTERPRISE_SCHEMA, "EnterpriseUser", "Enterprise User", ENTERPRISE_ATTRS),
  ];
}

export function resourceTypes(base: string) {
  return [
    { schemas: [RT_SCHEMA], id: "User", name: "User", endpoint: "/Users", description: "User Account", schema: USER_SCHEMA,
      schemaExtensions: [{ schema: ENTERPRISE_SCHEMA, required: false }], meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` } },
    { schemas: [RT_SCHEMA], id: "Group", name: "Group", endpoint: "/Groups", description: "Group", schema: GROUP_SCHEMA,
      schemaExtensions: [], meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` } },
  ];
}

export function serviceProviderConfig(base: string) {
  return {
    schemas: [SPC_SCHEMA], documentationUri: DOCS,
    patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: true },
    authenticationSchemes: [{
      type: "oauthbearertoken", name: "OAuth Bearer Token", description: "A SCIM token created in the RevenueDot dashboard (Organization settings, SCIM).",
      specUri: "https://www.rfc-editor.org/info/rfc6750", documentationUri: DOCS, primary: true,
    }],
    meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
  };
}

// ---- Input ----

const MAX_DATA = 64 * 1024;
/** Attributes the server owns or never keeps. */
const DROP = new Set(["id", "meta", "schemas", "password", "groups"]);

export function toBool(v: unknown, attr: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === "true";
  throw new ScimError(400, `${attr} must be true or false.`, "invalidValue");
}

/** Copies a value with known attribute names in their canonical spelling; drops nulls (unassigned). */
function canon(v: unknown, depth = 0): unknown {
  if (depth > 6) throw new ScimError(400, "The resource is nested too deeply.", "invalidValue");
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map((x) => canon(x, depth + 1));
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined) continue;
    const key = k.toLowerCase() === ENTERPRISE_SCHEMA.toLowerCase() ? ENTERPRISE_SCHEMA : (CANON.get(k.toLowerCase()) ?? k);
    out[key] = canon(x, depth + 1);
  }
  return out;
}

const optString = (v: unknown, attr: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") throw new ScimError(400, `${attr} must be a string.`, "invalidValue");
  if (v.length > 512) throw new ScimError(400, `${attr} is longer than 512 characters.`, "invalidValue");
  return v;
};

export interface UserInput { userName: string; externalId: string | null; active: boolean; data: Record<string, unknown> }

/** Validates a User resource from POST, PUT or the result of a PATCH. */
export function userInput(body: unknown): UserInput {
  if (!isObj(body)) throw new ScimError(400, "The request body must be a User object.", "invalidSyntax");
  const r = canon(body) as Record<string, unknown>;
  const userName = optString(r.userName, "userName")?.trim();
  if (!userName) throw new ScimError(400, "userName is required.", "invalidValue");
  const externalId = optString(r.externalId, "externalId");
  const active = r.active === undefined ? true : toBool(r.active, "active");
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!DROP.has(k.toLowerCase()) && k !== "userName" && k !== "externalId" && k !== "active") data[k] = v;
  for (const k of ["emails", "phoneNumbers", "addresses", "roles", "entitlements"]) {
    if (data[k] === undefined) continue;
    const arr = Array.isArray(data[k]) ? (data[k] as unknown[]) : [data[k]];
    if (!arr.every(isObj)) throw new ScimError(400, `${k} must be an array of objects.`, "invalidValue");
    for (const e of arr as Record<string, unknown>[]) if (e.primary !== undefined) e.primary = toBool(e.primary, `${k}.primary`);
    data[k] = arr;
  }
  if (data.name !== undefined && !isObj(data.name)) throw new ScimError(400, "name must be an object.", "invalidValue");
  if (data[ENTERPRISE_SCHEMA] !== undefined && !isObj(data[ENTERPRISE_SCHEMA])) throw new ScimError(400, `${ENTERPRISE_SCHEMA} must be an object.`, "invalidValue");
  if (JSON.stringify(data).length > MAX_DATA) throw new ScimError(400, "The user's attributes are larger than 64 KB.", "invalidValue");
  return { userName, externalId, active, data };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The account's email: the primary address, else the work address, else the first one, else userName when it is an address. */
export function emailOf(u: UserInput): string | null {
  const emails = ((u.data.emails as Record<string, unknown>[] | undefined) ?? []).filter((e) => typeof e.value === "string" && EMAIL.test((e.value as string).trim()));
  const pick = emails.find((e) => e.primary === true) ?? emails.find((e) => typeof e.type === "string" && e.type.toLowerCase() === "work") ?? emails[0];
  if (pick) return (pick.value as string).trim();
  return EMAIL.test(u.userName) ? u.userName : null;
}

export function displayNameOf(u: UserInput): string | null {
  if (typeof u.data.displayName === "string" && u.data.displayName.trim()) return u.data.displayName.trim().slice(0, 100);
  const n = isObj(u.data.name) ? u.data.name : {};
  if (typeof n.formatted === "string" && n.formatted.trim()) return n.formatted.trim().slice(0, 100);
  const parts = [n.givenName, n.familyName].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
  return parts ? parts.slice(0, 100) : null;
}

export interface GroupInput { displayName: string; externalId: string | null; members: string[] }

export function groupInput(body: unknown): GroupInput {
  if (!isObj(body)) throw new ScimError(400, "The request body must be a Group object.", "invalidSyntax");
  const r = canon(body) as Record<string, unknown>;
  const displayName = optString(r.displayName, "displayName")?.trim();
  if (!displayName) throw new ScimError(400, "displayName is required.", "invalidValue");
  if (displayName.length > 256) throw new ScimError(400, "displayName is longer than 256 characters.", "invalidValue");
  const raw = r.members === undefined ? [] : Array.isArray(r.members) ? r.members : [r.members];
  if (raw.length > 50000) throw new ScimError(400, "A group can have at most 50000 members.", "invalidValue");
  const members = new Set<string>();
  for (const m of raw) {
    const v = isObj(m) ? m.value : m;
    if (typeof v !== "string" || !v) throw new ScimError(400, "Each member needs a value: the id of a SCIM User.", "invalidValue");
    if (isObj(m) && typeof m.type === "string" && m.type.toLowerCase() === "group") throw new ScimError(400, "Nested groups are not supported; add the group's users instead.", "invalidValue");
    members.add(v);
  }
  return { displayName, externalId: optString(r.externalId, "externalId"), members: [...members] };
}

// ---- Output ----

const ALWAYS = new Set(["id", "schemas"]);

function attrList(raw: string | undefined): AttrPath[] | null {
  if (!raw) return null;
  try { return raw.split(",").map((s) => s.trim()).filter(Boolean).map(parseAttrPath); } catch (e) {
    throw new ScimError(400, e instanceof ScimFilterError ? e.message : "attributes is not a list of attribute names.", "invalidValue");
  }
}

const keyCI = (o: Record<string, unknown>, k: string) => Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());

/** Applies the `attributes` and `excludedAttributes` query parameters (RFC 7644 §3.4.2.5). */
export function project(resource: Record<string, unknown>, coreSchema: string, attributes?: string, excluded?: string): Record<string, unknown> {
  const only = attrList(attributes);
  const skip = attrList(excluded);
  const holderKey = (p: AttrPath) => (p.schema && p.schema.toLowerCase() !== coreSchema.toLowerCase() ? keyCI(resource, p.schema) ?? null : "");
  if (only) {
    const out: Record<string, unknown> = { schemas: resource.schemas, id: resource.id };
    for (const p of only) {
      const hk = holderKey(p);
      if (hk === null) continue;
      const src = (hk ? resource[hk] : resource) as Record<string, unknown>;
      if (!isObj(src)) continue;
      const k = keyCI(src, p.attr);
      if (!k || ALWAYS.has(k)) continue;
      const dst = hk ? ((out[hk] as Record<string, unknown>) ?? (out[hk] = {})) as Record<string, unknown> : out;
      const v = src[k];
      if (!p.sub) { dst[k] = v; continue; }
      const pickSub = (e: unknown) => { if (!isObj(e)) return undefined; const sk = keyCI(e, p.sub!); return sk ? { [sk]: e[sk] } : undefined; };
      if (Array.isArray(v)) {
        const prev = Array.isArray(dst[k]) ? (dst[k] as Record<string, unknown>[]) : v.map(() => ({}));
        dst[k] = v.map((e, i) => ({ ...prev[i], ...pickSub(e) }));
      } else if (isObj(v)) dst[k] = { ...(isObj(dst[k]) ? dst[k] : {}), ...pickSub(v) };
    }
    return out;
  }
  if (skip) {
    const out = structuredClone(resource);
    for (const p of skip) {
      const hk = holderKey(p);
      if (hk === null) continue;
      const src = (hk ? out[hk] : out) as Record<string, unknown>;
      if (!isObj(src)) continue;
      const k = keyCI(src, p.attr);
      if (!k || (!hk && ALWAYS.has(k))) continue;
      if (!p.sub) { delete src[k]; continue; }
      for (const e of Array.isArray(src[k]) ? (src[k] as unknown[]) : [src[k]]) if (isObj(e)) { const sk = keyCI(e, p.sub); if (sk) delete e[sk]; }
    }
    return out;
  }
  return resource;
}

