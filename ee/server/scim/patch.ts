// RevenueDot Enterprise (ee/LICENSE). SCIM PATCH (RFC 7644 §3.5.2) applied to a resource's plain JSON form, including
// what Okta and Microsoft Entra ID send: op names in any case, no-path values with dotted or schema-qualified keys,
// value filters (emails[type eq "work"].value, members[value eq "id"]) and "remove members" with a value array.
// Spec: prd/enterprise/PRD.md §6.
import { getCI, matches, parseAttrPath, parsePatchPath, ScimFilterError, type AttrPath, type Filter, type PatchPath } from "./filter.js";

export const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export interface PatchOperation { op: "add" | "replace" | "remove"; path?: string; value?: unknown }

export class ScimPatchError extends Error {
  constructor(public scimType: "invalidSyntax" | "invalidPath" | "noTarget" | "invalidValue" | "mutability", message: string) { super(message); }
}

/** Canonical spelling of the attribute names we know, so a resource keeps one key per attribute whatever case a client used. */
const KNOWN = [
  "id", "externalId", "meta", "schemas", "userName", "active", "displayName", "name", "formatted", "givenName", "familyName", "middleName",
  "honorificPrefix", "honorificSuffix", "nickName", "profileUrl", "title", "userType", "preferredLanguage", "locale", "timezone", "password",
  "emails", "phoneNumbers", "addresses", "ims", "photos", "entitlements", "roles", "x509Certificates", "groups", "members",
  "value", "type", "primary", "display", "$ref", "streetAddress", "locality", "region", "postalCode", "country",
  "employeeNumber", "costCenter", "organization", "division", "department", "manager",
];
export const CANON = new Map(KNOWN.map((k) => [k.toLowerCase(), k]));
/** Multi-valued attributes of the User and Group schemas. */
export const MULTI = new Set(["emails", "phonenumbers", "addresses", "ims", "photos", "entitlements", "roles", "x509certificates", "groups", "members"]);

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Sets a key case-insensitively: keeps the existing spelling, else the canonical one. */
export function setCI(o: Record<string, unknown>, key: string, value: unknown) {
  const lk = key.toLowerCase();
  const existing = Object.keys(o).find((k) => k.toLowerCase() === lk);
  o[existing ?? CANON.get(lk) ?? key] = value;
}

export function deleteCI(o: Record<string, unknown>, key: string) {
  const lk = key.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === lk) delete o[k];
}

/** Parses a PatchOp request body. */
export function parsePatchBody(body: unknown): PatchOperation[] {
  if (!isObj(body)) throw new ScimPatchError("invalidSyntax", "The request body must be a PatchOp object.");
  const schemas = getCI(body, "schemas");
  if (schemas !== undefined && !(Array.isArray(schemas) && schemas.some((s) => typeof s === "string" && s.toLowerCase() === PATCH_OP.toLowerCase()))) {
    throw new ScimPatchError("invalidSyntax", `schemas must contain "${PATCH_OP}".`);
  }
  const ops = getCI(body, "Operations");
  if (!Array.isArray(ops) || !ops.length) throw new ScimPatchError("invalidSyntax", "Operations must be a non-empty array.");
  if (ops.length > 1000) throw new ScimPatchError("invalidSyntax", "At most 1000 operations per request.");
  return ops.map((o, i) => {
    if (!isObj(o)) throw new ScimPatchError("invalidSyntax", `Operations[${i}] must be an object.`);
    const op = String(getCI(o, "op") ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") throw new ScimPatchError("invalidSyntax", `Operations[${i}].op must be add, replace or remove.`);
    const path = getCI(o, "path");
    if (path !== undefined && path !== null && typeof path !== "string") throw new ScimPatchError("invalidPath", `Operations[${i}].path must be a string.`);
    const trimmed = typeof path === "string" && path.trim() ? path.trim() : undefined;
    return { op, ...(trimmed ? { path: trimmed } : {}), value: getCI(o, "value") };
  });
}

export interface PatchOptions {
  /** The resource's core schema URN ("urn:ietf:params:scim:schemas:core:2.0:User"). */
  coreSchema: string;
  /** Top-level attributes a client may not change (lower case): a path naming one fails with "mutability"; no-path values skip them. */
  readOnly: Set<string>;
}

/** Whether a key or path names a whole schema extension ("urn:...:enterprise:2.0:User") rather than an attribute in one. */
const isSchemaUrn = (s: string) => /^urn:/i.test(s) && /:\d+(\.\d+)*:[A-Za-z]+$/.test(s);

/** Applies the operations to a copy of the resource and returns it. The caller validates and saves the result like a PUT. */
export function applyPatch(resource: Record<string, unknown>, ops: PatchOperation[], o: PatchOptions): Record<string, unknown> {
  const out = structuredClone(resource);
  for (const op of ops) applyOne(out, op, o);
  return out;
}

function applyOne(res: Record<string, unknown>, op: PatchOperation, o: PatchOptions) {
  if (!op.path) {
    if (op.op === "remove") throw new ScimPatchError("noTarget", "A remove operation needs a path.");
    if (!isObj(op.value)) throw new ScimPatchError("invalidValue", "An operation without a path needs an object value.");
    for (const [k, v] of Object.entries(op.value)) {
      const lk = k.toLowerCase();
      if (lk === "schemas" || o.readOnly.has(lk)) continue; // Okta sends the id along with the new values.
      if (isSchemaUrn(k) && lk !== o.coreSchema.toLowerCase()) {
        if (!isObj(v)) throw new ScimPatchError("invalidValue", `${k} must be an object.`);
        for (const [sk, sv] of Object.entries(v)) applyAt(res, op.op, { path: { schema: k, ...attrOf(sk) } }, sv, o);
        continue;
      }
      if (lk === o.coreSchema.toLowerCase() && isObj(v)) {
        for (const [sk, sv] of Object.entries(v)) applyAt(res, op.op, { path: attrOf(sk) }, sv, o);
        continue;
      }
      applyAt(res, op.op, { path: attrOf(k) }, v, o);
    }
    return;
  }
  if (isSchemaUrn(op.path) && op.path.toLowerCase() !== o.coreSchema.toLowerCase()) {
    if (op.op === "remove") { deleteCI(res, op.path); return; }
    if (!isObj(op.value)) throw new ScimPatchError("invalidValue", `${op.path} must be an object.`);
    for (const [sk, sv] of Object.entries(op.value)) applyAt(res, op.op, { path: { schema: op.path, ...attrOf(sk) } }, sv, o);
    return;
  }
  let pp: PatchPath;
  try { pp = parsePatchPath(op.path); } catch (e) { throw new ScimPatchError("invalidPath", e instanceof ScimFilterError ? e.message : `"${op.path}" is not a valid path.`); }
  if (isCore(pp.path, o) && o.readOnly.has(pp.path.attr)) throw new ScimPatchError("mutability", `${op.path} cannot be changed.`);
  applyAt(res, op.op, pp, op.value, o);
}

function attrOf(k: string): AttrPath {
  try { return parseAttrPath(k); } catch { throw new ScimPatchError("invalidPath", `"${k}" is not a valid attribute name.`); }
}

const isCore = (p: AttrPath, o: PatchOptions) => !p.schema || p.schema.toLowerCase() === o.coreSchema.toLowerCase();

/** The object that holds the path's attribute: the resource, or its extension object (created when asked). */
function holder(res: Record<string, unknown>, p: AttrPath, o: PatchOptions, create: boolean): Record<string, unknown> | null {
  if (isCore(p, o)) return res;
  const cur = getCI(res, p.schema!);
  if (isObj(cur)) return cur;
  if (!create) return null;
  const made: Record<string, unknown> = {};
  setCI(res, p.schema!, made);
  return made;
}

const valueOf = (e: unknown) => (isObj(e) ? getCI(e, "value") : e);
const flat = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The attributes an `a eq x and b eq y` filter pins down, to create the element a replace on a missing value targets. */
function seedOf(f: Filter): Record<string, unknown> | null {
  if (f.type === "compare" && f.op === "eq" && !f.path.sub && !f.path.schema) return { [CANON.get(f.path.attr) ?? f.path.attr]: f.value };
  if (f.type === "and") {
    const l = seedOf(f.left), r = seedOf(f.right);
    return l && r ? { ...l, ...r } : null;
  }
  return null;
}

function mergeInto(target: Record<string, unknown>, value: Record<string, unknown>) {
  for (const [k, v] of Object.entries(value)) setCI(target, k, v);
}

/** Only one element of a multi-valued attribute may be primary: the last one marked wins. */
function onePrimary(arr: unknown[]) {
  const marked = arr.filter((e) => isObj(e) && isTrue(getCI(e, "primary")));
  for (const e of marked.slice(0, -1)) setCI(e as Record<string, unknown>, "primary", false);
}
const isTrue = (v: unknown) => v === true || (typeof v === "string" && v.toLowerCase() === "true");

function setOrDrop(h: Record<string, unknown>, attr: string, arr: unknown[]) {
  if (arr.length) setCI(h, attr, arr);
  else deleteCI(h, attr);
}

function applyAt(res: Record<string, unknown>, op: PatchOperation["op"], pp: PatchPath, value: unknown, o: PatchOptions) {
  const { path } = pp;
  const h = holder(res, path, o, op !== "remove");
  if (!h) return;
  const cur = getCI(h, path.attr);

  if (pp.filter) {
    const arr = flat(cur);
    const hit = (e: unknown) => matches(e, pp.filter!, {}, path.attr);
    if (op === "remove") {
      if (!pp.sub) setOrDrop(h, path.attr, arr.filter((e) => !hit(e)));
      else for (const e of arr) if (hit(e) && isObj(e)) deleteCI(e, pp.sub);
      return;
    }
    const hits = arr.filter(hit);
    if (!hits.length) {
      // Entra replaces emails[type eq "work"].value on users that have no work address yet: add one.
      const seed = seedOf(pp.filter);
      if (!seed) throw new ScimPatchError("noTarget", `No value of ${path.attr} matches the filter.`);
      hits.push(seed);
      arr.push(seed);
    }
    for (const e of hits) {
      if (!isObj(e)) throw new ScimPatchError("invalidPath", `${path.attr} has no sub-attributes.`);
      if (pp.sub) setCI(e, pp.sub, value);
      else if (isObj(value)) mergeInto(e, value);
      else throw new ScimPatchError("invalidValue", `The value for ${path.attr}[...] must be an object.`);
    }
    onePrimary(arr);
    setCI(h, path.attr, arr);
    return;
  }

  if (path.sub) {
    if (op === "remove") {
      if (isObj(cur)) deleteCI(cur, path.sub);
      else if (Array.isArray(cur)) for (const e of cur) if (isObj(e)) deleteCI(e, path.sub);
      return;
    }
    if (Array.isArray(cur)) {
      for (const e of cur) if (isObj(e)) setCI(e, path.sub, value);
      return;
    }
    const obj = isObj(cur) ? cur : {};
    setCI(obj, path.sub, value);
    setCI(h, path.attr, obj);
    return;
  }

  if (op === "remove") {
    // Entra removes group members with path "members" and the members to remove as the value.
    if (value !== undefined && value !== null && Array.isArray(cur)) {
      const drop = new Set(flat(value).map(valueOf).map(String));
      setOrDrop(h, path.attr, cur.filter((e) => !drop.has(String(valueOf(e)))));
    } else deleteCI(h, path.attr);
    return;
  }

  const multi = Array.isArray(cur) || Array.isArray(value) || MULTI.has(path.attr);
  if (multi) {
    const incoming = flat(value);
    if (op === "replace") {
      onePrimary(incoming);
      setOrDrop(h, path.attr, incoming);
      return;
    }
    const arr = flat(cur);
    for (const v of incoming) {
      const key = JSON.stringify(valueOf(v));
      const same = arr.findIndex((e) => JSON.stringify(valueOf(e)) === key && (!isObj(v) || !isObj(e) || String(getCI(e, "type") ?? "") === String(getCI(v, "type") ?? "")));
      if (same === -1) arr.push(v);
      else if (isObj(v) && isObj(arr[same])) mergeInto(arr[same] as Record<string, unknown>, v);
    }
    onePrimary(arr);
    setOrDrop(h, path.attr, arr);
    return;
  }
  // A complex attribute takes the given sub-attributes and keeps the others (RFC 7644 §3.5.2.1 and §3.5.2.3).
  if (isObj(value) && isObj(cur)) mergeInto(cur, value);
  else setCI(h, path.attr, value);
}
