// RevenueDot Enterprise (ee/LICENSE). SCIM filter and PATCH path parser and in-memory evaluator (RFC 7644 §3.4.2.2,
// §3.5.2). Spec: prd/enterprise/PRD.md §6.
//
//   FILTER    = attrExp / logExp / valuePath / "not" "(" FILTER ")" / "(" FILTER ")"
//   valuePath = attrPath "[" valFilter "]" ["." subAttr [SP compareOp SP compValue | SP "pr"]]
//   attrExp   = attrPath SP "pr" / attrPath SP compareOp SP compValue
//   attrPath  = [URI ":"] ATTRNAME ["." subAttr]
// Precedence: not, then and, then or. Keywords, operators and attribute names are case-insensitive.

export type CompareOp = "eq" | "ne" | "co" | "sw" | "ew" | "gt" | "ge" | "lt" | "le";
export type Value = string | number | boolean | null;
/** An attribute path; `attr` and `sub` are lower case, `schema` is the URN prefix when one was given. */
export interface AttrPath { schema?: string; attr: string; sub?: string }
export type Filter =
  | { type: "and" | "or"; left: Filter; right: Filter }
  | { type: "not"; filter: Filter }
  | { type: "pr"; path: AttrPath }
  | { type: "compare"; path: AttrPath; op: CompareOp; value: Value }
  /** `attr[filter]`, optionally followed by `.sub` and a comparison on that sub-attribute of the matching elements. */
  | { type: "valuePath"; path: AttrPath; filter: Filter; sub?: string; then?: { op: CompareOp | "pr"; value?: Value } };

export class ScimFilterError extends Error {}

const OPS = new Set<string>(["eq", "ne", "co", "sw", "ew", "gt", "ge", "lt", "le"]);
const MAX_LENGTH = 4000;
const MAX_DEPTH = 32;

type Tok = { k: "(" | ")" | "[" | "]" | "." } | { k: "str"; v: string } | { k: "word"; v: string };

function tokenize(s: string): Tok[] {
  if (s.length > MAX_LENGTH) throw new ScimFilterError(`The filter is longer than ${MAX_LENGTH} characters.`);
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]") { out.push({ k: ch }); i++; continue; }
    // A sub-attribute after a value filter: emails[type eq "work"].value
    if (ch === "." && out[out.length - 1]?.k === "]") { out.push({ k: "." }); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let raw = '"';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\") { raw += s[j]! + (s[j + 1] ?? ""); j += 2; continue; }
        raw += s[j]!;
        j++;
      }
      if (j >= s.length) throw new ScimFilterError("A string in the filter is missing its closing quote.");
      try { out.push({ k: "str", v: JSON.parse(raw + '"') as string }); } catch { throw new ScimFilterError("A string in the filter has an invalid escape."); }
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z0-9_$:.+\-/]+/.exec(s.slice(i));
    if (!m) throw new ScimFilterError(`Unexpected character "${ch}" in the filter.`);
    out.push({ k: "word", v: m[0] });
    i += m[0].length;
  }
  return out;
}

/** Parses `name.givenName` or `urn:...:enterprise:2.0:User:manager.value` into its parts. */
export function parseAttrPath(raw: string): AttrPath {
  let rest = raw;
  let schema: string | undefined;
  if (/^urn:/i.test(raw)) {
    const at = raw.lastIndexOf(":");
    schema = raw.slice(0, at);
    rest = raw.slice(at + 1);
  }
  const m = /^([A-Za-z$][A-Za-z0-9_$\-]*)(?:\.([A-Za-z$][A-Za-z0-9_$\-]*))?$/.exec(rest);
  if (!m) throw new ScimFilterError(`"${raw}" is not a valid attribute path.`);
  return { ...(schema ? { schema } : {}), attr: m[1]!.toLowerCase(), ...(m[2] ? { sub: m[2].toLowerCase() } : {}) };
}

function parseValue(t: Tok | undefined): Value {
  if (!t) throw new ScimFilterError("The filter ends where a value was expected.");
  if (t.k === "str") return t.v;
  if (t.k !== "word") throw new ScimFilterError("A comparison needs a value: a quoted string, a number, true, false or null.");
  const w = t.v.toLowerCase();
  if (w === "true") return true;
  if (w === "false") return false;
  if (w === "null") return null;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t.v)) return Number(t.v);
  throw new ScimFilterError(`"${t.v}" is not a valid value; quote strings with double quotes.`);
}

function checkOperand(op: CompareOp, value: Value) {
  if ((op === "co" || op === "sw" || op === "ew") && typeof value !== "string") throw new ScimFilterError(`"${op}" compares strings only.`);
  if ((op === "gt" || op === "ge" || op === "lt" || op === "le") && (typeof value === "boolean" || value === null)) throw new ScimFilterError(`"${op}" cannot compare booleans or null.`);
}

class Parser {
  i = 0;
  depth = 0;
  constructor(private t: Tok[]) {}
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  word(): string | null { const t = this.peek(); return t?.k === "word" ? t.v.toLowerCase() : null; }
  expect(k: "(" | ")" | "[" | "]") {
    const t = this.next();
    if (t?.k !== k) throw new ScimFilterError(`Expected "${k}" in the filter.`);
  }

  parseOr(): Filter {
    if (++this.depth > MAX_DEPTH) throw new ScimFilterError("The filter is nested too deeply.");
    let left = this.parseAnd();
    while (this.word() === "or") { this.next(); left = { type: "or", left, right: this.parseAnd() }; }
    this.depth--;
    return left;
  }
  parseAnd(): Filter {
    let left = this.parseUnary();
    while (this.word() === "and") { this.next(); left = { type: "and", left, right: this.parseUnary() }; }
    return left;
  }
  parseUnary(): Filter {
    const t = this.peek();
    if (!t) throw new ScimFilterError("The filter ends where an expression was expected.");
    if (t.k === "(") { this.next(); const f = this.parseOr(); this.expect(")"); return f; }
    if (t.k === "word" && t.v.toLowerCase() === "not" && this.t[this.i + 1]?.k === "(") {
      this.next(); this.next();
      const f = this.parseOr();
      this.expect(")");
      return { type: "not", filter: f };
    }
    if (t.k !== "word") throw new ScimFilterError("Expected an attribute name in the filter.");
    this.next();
    const path = parseAttrPath(t.v);
    if (this.peek()?.k === "[") {
      if (path.sub) throw new ScimFilterError(`"${t.v}" cannot take a value filter.`);
      this.next();
      const inner = this.parseOr();
      this.expect("]");
      const node: Filter = { type: "valuePath", path, filter: inner };
      if (this.peek()?.k === ".") {
        this.next();
        const s = this.next();
        if (s?.k !== "word" || !/^[A-Za-z$][A-Za-z0-9_$\-]*$/.test(s.v)) throw new ScimFilterError("Expected a sub-attribute after \"].\".");
        node.sub = s.v.toLowerCase();
        const op = this.word();
        if (op === "pr") { this.next(); node.then = { op: "pr" }; }
        else if (op && OPS.has(op)) { this.next(); const v = parseValue(this.next()); checkOperand(op as CompareOp, v); node.then = { op: op as CompareOp, value: v }; }
        else throw new ScimFilterError("Expected an operator after the sub-attribute.");
      }
      return node;
    }
    const op = this.word();
    if (op === "pr") { this.next(); return { type: "pr", path }; }
    if (!op || !OPS.has(op)) throw new ScimFilterError(op ? `Unsupported operator "${op}".` : `Expected an operator after "${t.v}".`);
    this.next();
    const value = parseValue(this.next());
    checkOperand(op as CompareOp, value);
    return { type: "compare", path, op: op as CompareOp, value };
  }
}

/** Parses a filter expression. Throws ScimFilterError (answer 400 invalidFilter) when it is malformed or unsupported. */
export function parseFilter(s: string): Filter {
  const toks = tokenize(s);
  if (!toks.length) throw new ScimFilterError("The filter is empty.");
  const p = new Parser(toks);
  const f = p.parseOr();
  if (p.i < toks.length) throw new ScimFilterError("Unexpected text after the end of the filter.");
  return f;
}

/** A PATCH path: an attribute path, or `attr[filter]` with an optional `.sub` (RFC 7644 §3.5.2). */
export interface PatchPath { path: AttrPath; filter?: Filter; sub?: string }

export function parsePatchPath(s: string): PatchPath {
  const toks = tokenize(s);
  const first = toks[0];
  if (first?.k !== "word") throw new ScimFilterError(`"${s}" is not a valid path.`);
  const path = parseAttrPath(first.v);
  if (toks.length === 1) return { path };
  if (toks[1]?.k !== "[" || path.sub) throw new ScimFilterError(`"${s}" is not a valid path.`);
  const p = new Parser(toks);
  p.i = 2;
  const filter = p.parseOr();
  p.expect("]");
  let sub: string | undefined;
  if (p.peek()?.k === ".") {
    p.next();
    const t = p.next();
    if (t?.k !== "word" || !/^[A-Za-z$][A-Za-z0-9_$\-]*$/.test(t.v)) throw new ScimFilterError(`"${s}" is not a valid path.`);
    sub = t.v.toLowerCase();
  }
  if (p.i < toks.length) throw new ScimFilterError(`"${s}" is not a valid path.`);
  return { path, filter, ...(sub ? { sub } : {}) };
}

// ---- Evaluation ----

export interface EvalOptions {
  /** Whether an attribute ("id", "externalid", "members.value" ...) compares case-sensitively. Default: DEFAULT_CASE_EXACT. */
  caseExact?: (key: string) => boolean;
  /** The resource's core schema URN; paths qualified with it address top-level attributes. */
  coreSchema?: string;
}

export const DEFAULT_CASE_EXACT = new Set(["id", "externalid", "members.value", "groups.value", "meta.version"]);

/** Reads a key from an object case-insensitively. */
export function getCI(o: unknown, key: string): unknown {
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const k = key.toLowerCase();
  for (const [name, v] of Object.entries(o)) if (name.toLowerCase() === k) return v;
  return undefined;
}

/** The object holding a path's attribute: the resource itself, or the extension object for an extension URN. */
function container(resource: unknown, path: AttrPath, o: EvalOptions): unknown {
  if (!path.schema) return resource;
  if (o.coreSchema && path.schema.toLowerCase() === o.coreSchema.toLowerCase()) return resource;
  return getCI(resource, path.schema);
}

const flat = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Every leaf value the path addresses; multi-valued attributes contribute each element. Complex values without a sub-attribute use their `value`. */
function valuesAt(resource: unknown, path: AttrPath, o: EvalOptions): unknown[] {
  const base = flat(getCI(container(resource, path, o), path.attr));
  if (path.sub) return base.flatMap((e) => flat(getCI(e, path.sub!)));
  return base.map((e) => (e && typeof e === "object" && !Array.isArray(e) ? getCI(e, "value") : e));
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const present = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

function compare(actual: unknown, op: CompareOp, expected: Value, exact: boolean): boolean {
  if (expected === null) {
    const has = present(actual);
    return op === "eq" ? !has : op === "ne" ? has : false;
  }
  if (typeof expected === "boolean") {
    const a = typeof actual === "string" && /^(true|false)$/i.test(actual) ? actual.toLowerCase() === "true" : actual;
    if (typeof a !== "boolean") return op === "ne";
    return op === "eq" ? a === expected : op === "ne" ? a !== expected : false;
  }
  if (typeof expected === "number") {
    const a = typeof actual === "number" ? actual : typeof actual === "string" && actual.trim() !== "" ? Number(actual) : NaN;
    if (Number.isNaN(a)) return op === "ne";
    switch (op) {
      case "eq": return a === expected;
      case "ne": return a !== expected;
      case "gt": return a > expected;
      case "ge": return a >= expected;
      case "lt": return a < expected;
      case "le": return a <= expected;
      default: return false;
    }
  }
  if (typeof actual !== "string") {
    if (typeof actual === "number" || typeof actual === "boolean") actual = String(actual);
    else return op === "ne";
  }
  let a = actual as string;
  let e = expected;
  if (ISO.test(a) && ISO.test(e) && op !== "co" && op !== "sw" && op !== "ew") {
    const ta = Date.parse(a), te = Date.parse(e);
    if (!Number.isNaN(ta) && !Number.isNaN(te)) return cmp(ta, te, op);
  }
  if (!exact) { a = a.toLowerCase(); e = e.toLowerCase(); }
  switch (op) {
    case "co": return a.includes(e);
    case "sw": return a.startsWith(e);
    case "ew": return a.endsWith(e);
    default: return cmp(a, e, op);
  }
}

function cmp<T extends string | number>(a: T, e: T, op: CompareOp): boolean {
  switch (op) {
    case "eq": return a === e;
    case "ne": return a !== e;
    case "gt": return a > e;
    case "ge": return a >= e;
    case "lt": return a < e;
    case "le": return a <= e;
    default: return false;
  }
}

const keyOf = (path: AttrPath, prefix?: string) => [prefix, path.attr, path.sub].filter(Boolean).join(".");

/** Whether a resource (a plain SCIM JSON object) matches the filter. */
export function matches(resource: unknown, f: Filter, o: EvalOptions = {}, prefix?: string): boolean {
  const exact = (k: string) => (o.caseExact ? o.caseExact(k) : DEFAULT_CASE_EXACT.has(k));
  switch (f.type) {
    case "and": return matches(resource, f.left, o, prefix) && matches(resource, f.right, o, prefix);
    case "or": return matches(resource, f.left, o, prefix) || matches(resource, f.right, o, prefix);
    case "not": return !matches(resource, f.filter, o, prefix);
    case "pr": return valuesAt(resource, f.path, o).some(present);
    case "compare": {
      const vals = valuesAt(resource, f.path, o);
      const ex = exact(keyOf(f.path, prefix));
      // "ne" on a multi-valued attribute: true when no value equals (RFC 7644 compares each value; "any" for ne would be surprising).
      if (f.op === "ne") return !vals.some((v) => compare(v, "eq", f.value, ex));
      if (!vals.length) return compare(undefined, f.op, f.value, ex);
      return vals.some((v) => compare(v, f.op, f.value, ex));
    }
    case "valuePath": {
      const elems = flat(getCI(container(resource, f.path, o), f.path.attr));
      const inner = { ...o, coreSchema: undefined };
      const hits = elems.filter((e) => matches(e, f.filter, inner, f.path.attr));
      if (!f.sub) return hits.length > 0;
      const vals = hits.flatMap((e) => flat(getCI(e, f.sub!)));
      if (!f.then) return vals.some(present);
      if (f.then.op === "pr") return vals.some(present);
      const ex = exact(`${f.path.attr}.${f.sub}`);
      const op = f.then.op, value = f.then.value as Value;
      if (op === "ne") return !vals.some((v) => compare(v, "eq", value, ex));
      return vals.some((v) => compare(v, op, value, ex));
    }
  }
}

/** The single `attr eq "value"` a filter is, if it is only that (lets the routes answer the common lookups from an index). */
export function simpleEq(f: Filter): { attr: string; sub?: string; value: Value } | null {
  return f.type === "compare" && f.op === "eq" && !f.path.sub ? { attr: f.path.attr, value: f.value } : null;
}

/** Whether a filter mentions an attribute (to skip loading, for example, group members when it does not). */
export function mentions(f: Filter, attr: string): boolean {
  switch (f.type) {
    case "and": case "or": return mentions(f.left, attr) || mentions(f.right, attr);
    case "not": return mentions(f.filter, attr);
    default: return f.path.attr === attr;
  }
}
