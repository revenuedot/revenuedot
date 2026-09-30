import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { commission, type Store } from "@revenuedot/core";
import type { Deps } from "../../context.js";

/**
 * REST API v2 plumbing: RevenueCat-shaped errors, auth principal, scopes, pagination and list envelopes.
 * Wire format follows RevenueCat's API v2 (object/list/error shapes, `starting_after` + `limit` pagination).
 */

export type ErrorType =
  | "parameter_error" | "resource_already_exists" | "resource_missing" | "idempotency_error" | "rate_limit_error"
  | "authentication_error" | "authorization_error" | "store_error" | "server_error" | "resource_locked_error"
  | "unprocessable_entity_error" | "invalid_request" | "entity_references_archived_entities";

export class V2Error extends Error {
  constructor(public status: ContentfulStatusCode, public type: ErrorType, message: string, public param?: string, public retryable = false) {
    super(message);
  }
}

// Our own docs, never RevenueCat's domain.
const docUrl = (type: ErrorType) => `https://revenuedot.app/docs/api/errors#${type.replace(/_/g, "-")}`;

export function v2ErrorBody(e: V2Error) {
  return { object: "error" as const, type: e.type, message: e.message, ...(e.param ? { param: e.param } : {}), doc_url: docUrl(e.type), retryable: e.retryable };
}

export function v2ErrorResponse(c: Context, e: unknown) {
  if (e instanceof V2Error) return c.json(v2ErrorBody(e), e.status);
  console.error(e);
  return c.json(v2ErrorBody(new V2Error(500, "server_error", "There was an internal server error.", undefined, true)), 500);
}

export const notFound = (what: string) => new V2Error(404, "resource_missing", `${what} not found.`);
export const conflict = (message: string, param?: string) => new V2Error(409, "resource_already_exists", message, param);
export const paramError = (message: string, param?: string) => new V2Error(400, "parameter_error", message, param);

/** Who is calling: a secret API key (bound to one project) or a dashboard user (session cookie). */
export type Principal =
  | { kind: "key"; projectId: string; keyId: string; permissions: string[] }
  | { kind: "user"; userId: string; role?: string };

export type V2Vars = { principal: Principal; projectId: string; deps: Deps };
export type V2Context = Context<{ Variables: V2Vars }>;
export type V2Router = Hono<{ Variables: V2Vars }>;

/**
 * Scope check. Scopes use RevenueCat's names (`project_configuration:apps:read` ...). A key's permissions may hold
 * `*`, an exact scope, a `read_write` scope (implies `read`), or a prefix wildcard such as `customer_information:*`.
 * Dashboard users: `viewer` gets read scopes only; `developer` gets everything except creating or revoking secret API
 * keys (RevenueCat's Developer role cannot generate them); `admin` gets everything.
 */
export function allows(p: Principal, scope: string): boolean {
  if (p.kind === "user") {
    if (p.role === "viewer") return scope.endsWith(":read");
    if (p.role === "developer") return scope !== "project_configuration:api_keys:read_write";
    return true;
  }
  const perms = p.permissions;
  if (perms.includes("*") || perms.includes(scope)) return true;
  if (scope.endsWith(":read") && perms.includes(`${scope.slice(0, -5)}:read_write`)) return true;
  return perms.some((x) => x.endsWith(":*") && scope.startsWith(x.slice(0, -1)));
}

export const scope = (...scopes: string[]): MiddlewareHandler<{ Variables: V2Vars }> => async (c, next) => {
  const p = c.get("principal");
  const missing = scopes.filter((s) => !allows(p, s));
  if (missing.length) {
    if (p.kind === "user") throw new V2Error(403, "authorization_error", `Your role in this project (${p.role ?? "member"}) does not allow this. Ask a project admin.`);
    throw new V2Error(403, "authorization_error", `This API key is missing the permission(s): ${missing.join(", ")}.`);
  }
  await next();
};

/** Parses a JSON body. A missing body is `{}`; malformed JSON is a 400 invalid_request. */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new V2Error(400, "invalid_request", "The request body is not valid JSON."); }
}

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await readJson(c));
  if (!r.success) {
    const i = r.error.issues[0]!;
    const param = i.path.join(".") || undefined;
    throw paramError(param ? `${param}: ${i.message}` : i.message, param);
  }
  return r.data;
}

/** `limit` is clamped to 1..100 (never rejected); default 20. */
export function pageParams(c: Context) {
  const raw = Number(c.req.query("limit"));
  const limit = Number.isFinite(raw) && c.req.query("limit") !== undefined ? Math.min(100, Math.max(1, Math.trunc(raw))) : 20;
  return { limit, startingAfter: c.req.query("starting_after") || null };
}

/** `expand` may be repeated (`expand=a&expand=b`) or comma separated. */
export function expands(c: Context): Set<string> {
  const out = new Set<string>();
  for (const v of c.req.queries("expand") ?? []) for (const x of v.split(",")) if (x.trim()) out.add(x.trim());
  return out;
}

export interface ListEnvelope<T> { object: "list"; items: T[]; next_page: string | null; url: string }

/** The list envelope. `url` is the request path; `next_page` keeps the other query params and sets `starting_after`. */
export function listOf<T>(c: Context, items: T[], nextCursor: string | null, path = new URL(c.req.url).pathname): ListEnvelope<T> {
  let next: string | null = null;
  if (nextCursor !== null) {
    const q = new URL(c.req.url).searchParams;
    q.delete("starting_after");
    q.set("starting_after", nextCursor);
    next = `${path}?${q.toString()}`;
  }
  return { object: "list", items, next_page: next, url: path };
}

/** A whole sub-list embedded in an object (entitlement.products, offering.packages ...): one page, no next page. */
export const embeddedList = <T>(url: string, items: T[]): ListEnvelope<T> => ({ object: "list", items, next_page: null, url });

/**
 * In-memory pagination for small per-project collections (apps, products, offerings ...), ordered by (created, id).
 * An unknown cursor is a 400 so clients never silently restart from the first page.
 */
export function paginate<T>(c: Context, rows: T[], key: (r: T) => string, created: (r: T) => number, mapper: (r: T) => unknown) {
  const { limit, startingAfter } = pageParams(c);
  const sorted = [...rows].sort((a, b) => created(a) - created(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  let start = 0;
  if (startingAfter) {
    const i = sorted.findIndex((r) => key(r) === startingAfter);
    if (i < 0) throw paramError("starting_after does not match an object in this list.", "starting_after");
    start = i + 1;
  }
  const page = sorted.slice(start, start + limit);
  const more = start + limit < sorted.length;
  return listOf(c, page.map(mapper), more && page.length ? key(page[page.length - 1]!) : null);
}

export const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

/** A MonetaryAmount in any currency: gross, the estimated store commission, no tax, proceeds. */
export function monetaryFor(gross: number, currency: string, store: string) {
  const comm = round2(gross * commission(store as Store));
  return { currency, gross: round2(gross), commission: comm, tax: 0, proceeds: round2(gross - comm) };
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
