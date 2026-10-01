/**
 * The API client RevenueDot AI's tools run with (prd/ai-assistant/PRD.md §2). It has the MCP server's client interface
 * (`request(method, path, { query, body })`, `project()`), so tool executors are written the same way in both places, but
 * instead of HTTP with a secret key it hands each request to this server's own REST API v2 router in-process, acting as
 * the signed-in user. The router then applies the user's role, the project's AI setting, validation and the audit log.
 */

/** Who the assistant acts for. Attached to each in-process request (never to requests that come over the network). */
export interface AssistantActor {
  userId: string;
  email: string;
  projectId: string;
  conversationId: string;
}

/** Marks requests made by the assistant. A WeakMap keyed by the Request object, so no header can forge it. */
export const ASSISTANT_CTX = new WeakMap<Request, AssistantActor>();

/** An error answered by the API, in its own words (`type` is RevenueCat's error type, e.g. authorization_error). Same as the MCP client's. */
export class RevenueDotApiError extends Error {
  constructor(public status: number, public type: string, message: string, public param?: string) {
    super(message);
    this.name = "RevenueDotApiError";
  }
}

export type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export interface RevenueDotClient {
  baseUrl: string;
  request<T = unknown>(method: string, path: string, opts?: { query?: Query; body?: unknown }): Promise<T>;
  project(projectId?: string): Promise<string>;
}

/** `dispatch` is the app's fetch (deps.dispatch). Every request is scoped to `actor.projectId`. */
export function inProcessClient(dispatch: (req: Request) => Promise<Response>, actor: AssistantActor): RevenueDotClient {
  const baseUrl = "http://localhost";
  async function request<T>(method: string, path: string, o: { query?: Query; body?: unknown } = {}): Promise<T> {
    if (!path.startsWith(`/v2/projects/${encodeURIComponent(actor.projectId)}/`) && path !== `/v2/projects/${encodeURIComponent(actor.projectId)}`) {
      throw new RevenueDotApiError(403, "authorization_error", "RevenueDot AI can only use the project this conversation belongs to.");
    }
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x);
      else url.searchParams.set(k, String(v));
    }
    const req = new Request(url, {
      method, headers: { accept: "application/json", ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    ASSISTANT_CTX.set(req, actor);
    const res = await dispatch(req);
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const err = (json ?? {}) as { type?: string; message?: string; param?: string };
      throw new RevenueDotApiError(res.status, err.type ?? "http_error", err.message ?? `HTTP ${res.status} from ${method} ${path}`, err.param);
    }
    return json as T;
  }
  return { baseUrl, request, project: async () => actor.projectId };
}
