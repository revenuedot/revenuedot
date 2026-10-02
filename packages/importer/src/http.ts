// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: JSON over HTTP with rate-limit backoff (429 Retry-After) and retries for server errors.
// Docs: https://revenuedot.app/docs/migrate

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchFn;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries for 5xx and network errors (429 has its own, larger budget). */
  maxRetries?: number;
  /** Called before each wait, for progress output. */
  onRetry?: (info: { url: string; status: number | null; waitMs: number; attempt: number }) => void;
  timeoutMs?: number;
  /** Retries after a request timed out (default 1): a request that took too long once usually does again. */
  timeoutRetries?: number;
}

export class HttpError extends Error {
  constructor(public status: number, public url: string, public body: any) {
    super(`${status} from ${redact(url)}: ${body?.message ?? (typeof body === "string" ? body.slice(0, 200) : "request failed")}`);
  }
}

/** No answer within `timeoutMs`, on every try. */
export class TimeoutError extends Error {
  constructor(public url: string, public timeoutMs: number) {
    super(`No answer from ${redact(url)} within ${Math.round(timeoutMs / 1000)} s.`);
  }
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_RATE_LIMIT_WAITS = 60;

/** Query strings can carry customer ids; keep error messages short and free of them. */
export const redact = (url: string) => url.replace(/\?.*$/, "");

/** Seconds (or an HTTP date) from Retry-After, else `backoff_ms` from RevenueCat's error body, else null. */
export function retryAfterMs(res: Response, body: any, now = Date.now()): number | null {
  const h = res.headers.get("retry-after");
  if (h) {
    const s = Number(h);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  if (body && typeof body.backoff_ms === "number") return body.backoff_ms;
  return null;
}

/**
 * Sends a request and returns the parsed JSON body. 429 waits for Retry-After (then retries, up to 60 times);
 * 5xx and network errors retry with exponential backoff (1s, 2s, 4s ... capped at 30s); other errors throw HttpError.
 * A request with no answer within `timeoutMs` is tried once more, then throws TimeoutError.
 */
export async function requestJson<T = any>(url: string, init: RequestInit, o: HttpOptions = {}): Promise<T> {
  const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sleep = o.sleep ?? realSleep;
  const maxRetries = o.maxRetries ?? 5;
  const timeoutMs = o.timeoutMs ?? 60_000;
  let failures = 0;
  let timeouts = 0;
  let waits = 0;
  for (;;) {
    let res: Response | null = null;
    let networkError: unknown = null;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      networkError = e;
      if (isTimeout(e) && ++timeouts > (o.timeoutRetries ?? 1)) throw new TimeoutError(url, timeoutMs);
    }
    if (res) {
      const text = await res.text();
      let body: any = null;
      if (text) { try { body = JSON.parse(text); } catch { body = text; } }
      if (res.ok) return body as T;
      if (res.status === 429 && waits < MAX_RATE_LIMIT_WAITS) {
        waits++;
        const waitMs = retryAfterMs(res, body) ?? Math.min(60_000, 1000 * 2 ** Math.min(waits, 6));
        o.onRetry?.({ url, status: 429, waitMs, attempt: waits });
        await sleep(waitMs);
        continue;
      }
      if (res.status < 500 || failures >= maxRetries) throw new HttpError(res.status, url, body);
    } else if (failures >= maxRetries) {
      throw new Error(`Could not reach ${redact(url)}: ${networkError instanceof Error ? networkError.message : networkError}`);
    }
    failures++;
    const waitMs = Math.min(30_000, 1000 * 2 ** (failures - 1));
    o.onRetry?.({ url, status: res?.status ?? null, waitMs, attempt: failures });
    await sleep(waitMs);
  }
}

/** Runs `fn` over items with at most `n` in flight, keeping the input order in the result. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
