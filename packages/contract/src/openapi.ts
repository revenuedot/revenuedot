import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/**
 * Validates our API v2 responses against RevenueCat's published OpenAPI v2 response schemas.
 *
 * The spec files are private research material and are never copied into this repo. The path comes from
 * RC_OPENAPI_V2 (a combined spec, or a directory / overview file next to the per-tag `openapi-v2-*.yaml` files);
 * the default is the sibling private repo. When nothing is found, `loadSpec()` returns null and tests skip.
 */
const DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../company/docs/research/revenuecat-tech/raw/openapi/openapi-v2.yaml");
export const SPEC_PATH = process.env.RC_OPENAPI_V2 ?? DEFAULT;

type Doc = { paths?: Record<string, Record<string, any>>; components?: Record<string, any> };

/** OpenAPI 3.0 -> JSON Schema: `nullable` becomes a null branch; docs-only keywords go. */
function convert(node: any): any {
  if (Array.isArray(node)) return node.map(convert);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "discriminator" || k === "example" || k === "examples" || k === "xml" || k === "externalDocs" || k.startsWith("x-")) continue;
    out[k] = k === "properties" || k === "patternProperties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, convert(pv)])) : convert(v);
  }
  if (out.nullable === true) {
    delete out.nullable;
    if (typeof out.type === "string" && !out.$ref && !out.allOf && !out.oneOf && !out.anyOf) {
      out.type = [out.type, "null"];
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
      return out;
    }
    return { anyOf: [out, { type: "null" }] };
  }
  delete out.nullable;
  // OpenAPI 3.0 ignores siblings of $ref.
  if (out.$ref) return { $ref: out.$ref };
  return out;
}

function loadDocs(path: string): Doc[] | null {
  if (!existsSync(path)) return null;
  const dir = path.endsWith(".yaml") || path.endsWith(".yml") ? dirname(path) : path;
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    const doc = parse(readFileSync(path, "utf8")) as Doc;
    if (doc.paths && Object.keys(doc.paths).length) return [doc];
  }
  // openapi-v2.yaml is only the overview (`paths: {}`); the operations live in the per-tag files beside it.
  const files = readdirSync(dir).filter((f) => /^openapi-v2-.+\.ya?ml$/.test(f));
  return files.length ? files.map((f) => parse(readFileSync(join(dir, f), "utf8")) as Doc) : null;
}

export interface Spec {
  /** Validates a body against the response schema of `METHOD /path-template` for a status. Returns error text or null. */
  check(method: string, path: string, status: number, body: unknown): string | null;
  /** The operations we validated, for the coverage report. */
  checked: Set<string>;
}

export function loadSpec(path = SPEC_PATH): Spec | null {
  const docs = loadDocs(path);
  if (!docs) return null;
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  for (const f of ["int32", "int64", "float", "double", "byte", "binary", "password"]) ajv.addFormat(f, true);
  const where = new Map<string, { id: string; op: any; doc: Doc }>();
  docs.forEach((raw, i) => {
    const id = `rc-v2-${i}`;
    const doc = convert(raw) as Doc;
    doc.components ??= {};
    doc.components.schemas ??= {};
    for (const [p, ops] of Object.entries(doc.paths ?? {})) {
      for (const [m, op] of Object.entries(ops)) {
        const key = `${m.toUpperCase()} /v2${p}`;
        if (!where.has(key)) where.set(key, { id, op, doc });
        for (const [status, resp0] of Object.entries((op as any).responses ?? {})) {
          let resp: any = resp0;
          if (resp?.$ref) resp = doc.components!.responses?.[String(resp.$ref).split("/").pop()!];
          const s = resp?.content?.["application/json"]?.schema;
          if (s) doc.components!.schemas![`__resp__${m}__${p.replace(/[^a-zA-Z0-9]+/g, "_")}__${status}`] = s;
        }
      }
    }
    ajv.addSchema({ ...doc, $id: id } as object, id);
  });
  const cache = new Map<string, ValidateFunction | null>();
  const checked = new Set<string>();
  return {
    checked,
    check(method, path, status, body) {
      const key = `${method.toUpperCase()} ${path}`;
      const hit = where.get(key);
      if (!hit) return `operation ${key} is not in the RevenueCat spec`;
      const ref = `${hit.id}#/components/schemas/__resp__${method.toLowerCase()}__${path.replace(/^\/v2/, "").replace(/[^a-zA-Z0-9]+/g, "_")}__${status}`;
      if (!cache.has(ref)) {
        const exists = hit.doc.components?.schemas?.[ref.split("/").pop()!];
        cache.set(ref, exists ? ajv.compile({ $ref: ref }) : null);
      }
      const v = cache.get(ref);
      if (v === null) {
        const declared = Object.keys(hit.op.responses ?? {});
        if (!declared.includes(String(status))) return `status ${status} is not declared for ${key} (declared: ${declared.join(", ")})`;
        checked.add(`${key} ${status}`);
        return null; // declared without a JSON body
      }
      checked.add(`${key} ${status}`);
      return v!(body) ? null : ajv.errorsText(v!.errors, { separator: "\n" });
    },
  };
}
