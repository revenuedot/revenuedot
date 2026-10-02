import { SignJWT, importPKCS8 } from "jose";
import { Codes, RCError } from "../../errors.js";
import type { AppRow } from "../types.js";

export type AppleEnv = "production" | "sandbox";
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const HOSTS: Record<AppleEnv, string> = {
  production: "https://api.storekit.itunes.apple.com",
  sandbox: "https://api.storekit-sandbox.itunes.apple.com",
};
/** The Retention Messaging API's documented hosts. */
const MESSAGING_HOSTS: Record<AppleEnv, string> = {
  production: "https://api.storekit.apple.com",
  sandbox: "https://api.storekit-sandbox.apple.com",
};
const TIMEOUT_MS = 15_000;
const MAX_HISTORY_PAGES = 50;

/** The app's In-App Purchase key for the App Store Server API, stored in `apps.credentials`. */
export interface AppleCredentials { keyId: string; issuerId: string; privateKey: string; bundleId: string }

/** Returns the credentials, null when none are configured, and throws 7234 when they are only partly filled in. */
export function appleCredentials(app: AppRow): AppleCredentials | null {
  const c = app.credentials ?? {};
  // RevenueCat's field names (what the REST API stores) win over the short names.
  const str = (...keys: string[]) => { for (const k of keys) { const v = c[k]; if (typeof v === "string" && v.trim()) return v; } return ""; };
  const keyId = str("subscription_key_id", "key_id").trim();
  const issuerId = str("subscription_key_issuer", "issuer_id").trim();
  const privateKey = str("subscription_private_key", "private_key").replace(/\\n/g, "\n").trim();
  if (!keyId && !issuerId && !privateKey) return null;
  const bundleId = (typeof c.bundle_id === "string" && c.bundle_id) || app.bundleId || "";
  if (!keyId || !issuerId || !privateKey || !bundleId) {
    throw new RCError(500, Codes.INVALID_APPLE_SUBSCRIPTION_KEY, "The App Store in-app purchase key is incomplete: key_id, issuer_id, private_key and a bundle id are required.");
  }
  return { keyId, issuerId, privateKey, bundleId };
}

export interface HistoryResponse { signedTransactions?: string[]; hasMore?: boolean; revision?: string }
export interface StatusesResponse {
  data?: { subscriptionGroupIdentifier?: string; lastTransactions?: { originalTransactionId: string; status: number; signedTransactionInfo: string; signedRenewalInfo?: string }[] }[];
}

/** Waiting on Apple's rate limit (HTTP 429). Off by default: SDK requests answer 503 at once and the device retries. */
export interface RateLimitRetry {
  /** How many times one call waits and tries again after a 429. */
  retries: number;
  /** The longest single wait. A Retry-After further out gives up at once with AppleRateLimitError. */
  maxWaitMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A client for one app; 5xx and network failures surface as retryable 503s, key problems as 7234. */
export class AppStoreServerApi {
  private token: Promise<string> | null = null;

  constructor(private creds: AppleCredentials, private fetchFn: FetchFn, private now: () => Date, private rateLimit?: RateLimitRetry) {}

  private jwt(): Promise<string> {
    this.token ??= (async () => {
      let key: Awaited<ReturnType<typeof importPKCS8>>;
      try {
        key = await importPKCS8(this.creds.privateKey, "ES256");
      } catch {
        throw new RCError(500, Codes.INVALID_APPLE_SUBSCRIPTION_KEY, "The App Store in-app purchase key is not a valid .p8 private key.");
      }
      const iat = Math.floor(this.now().getTime() / 1000);
      return new SignJWT({ bid: this.creds.bundleId })
        .setProtectedHeader({ alg: "ES256", kid: this.creds.keyId, typ: "JWT" })
        .setIssuer(this.creds.issuerId).setIssuedAt(iat).setExpirationTime(iat + 20 * 60).setAudience("appstoreconnect-v1")
        .sign(key);
    })();
    return this.token;
  }

  /** GET that returns the parsed body, or null on 404 (unknown transaction in this environment). */
  get<T>(env: AppleEnv, path: string): Promise<T | null> {
    return this.send<T>(env, "GET", path);
  }

  /** One authorised call; null on 404. An empty 2xx body (202 Accepted) is `{}`. */
  send<T>(env: AppleEnv, method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T | null> {
    return this.call<T>(`${HOSTS[env]}${path}`, method, body);
  }

  private async call<T>(url: string, method: string, body?: unknown): Promise<T | null> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.jwt()}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    // Called as a plain function: Workers' global fetch throws "Illegal invocation" when called as a method of this object.
    const fetchFn = this.fetchFn;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        throw new RCError(503, Codes.STORE_PROBLEM, `The App Store could not be reached (${networkReason(e)}). Try again later.`);
      }
      if (res.status === 429) {
        await discard(res);
        const waitMs = retryAfterMs(res.headers.get("retry-after"), this.now().getTime());
        const rl = this.rateLimit;
        if (rl && attempt < rl.retries) {
          const wait = waitMs ?? 1000 * 2 ** attempt;
          if (wait <= rl.maxWaitMs) {
            await (rl.sleep ?? sleep)(wait);
            continue;
          }
        }
        throw new AppleRateLimitError(waitMs);
      }
      if (res.status === 404) { await discard(res); return null; }
      if (res.status === 401) { await discard(res); throw new RCError(500, Codes.INVALID_APPLE_SUBSCRIPTION_KEY, "The App Store rejected the in-app purchase key (key_id, issuer_id or private_key is wrong)."); }
      if (res.status >= 500) { await discard(res); throw new RCError(503, Codes.STORE_PROBLEM, `The App Store answered HTTP ${res.status}. Try again later.`); }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { errorCode?: number; errorMessage?: string };
        throw new AppleApiClientError(res.status, body.errorCode ?? null, body.errorMessage ?? `App Store Server API answered ${res.status}`);
      }
      const text = await res.text().catch(() => "");
      if (!text.trim()) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new RCError(503, Codes.STORE_PROBLEM, "The App Store returned an unreadable response. Try again later.");
      }
    }
  }

  /** Send Consumption Information V1 (answer to CONSUMPTION_REQUEST): 202 Accepted, no body. */
  sendConsumptionInformation(env: AppleEnv, transactionId: string, body: Record<string, unknown>) {
    return this.send<Record<string, never>>(env, "PUT", `/inApps/v1/transactions/consumption/${encodeURIComponent(transactionId)}`, body);
  }

  /** Retention Messaging API (pre-release, needs Apple's approval): Upload Message, Configure Default Message, Configure Realtime URL. */
  uploadRetentionMessage(env: AppleEnv, messageId: string, body: { header: string; body: string }) {
    return this.call<Record<string, never>>(`${MESSAGING_HOSTS[env]}/inApps/v1/messaging/message/${encodeURIComponent(messageId)}`, "PUT", body);
  }
  configureDefaultRetentionMessage(env: AppleEnv, productId: string, locale: string, messageId: string) {
    return this.call<Record<string, never>>(`${MESSAGING_HOSTS[env]}/inApps/v1/messaging/default/${encodeURIComponent(productId)}/${encodeURIComponent(locale)}`, "PUT", { messageIdentifier: messageId });
  }
  configureRealtimeUrl(env: AppleEnv, realtimeURL: string) {
    return this.call<Record<string, never>>(`${MESSAGING_HOSTS[env]}/inApps/v1/messaging/realtime/url`, "PUT", { realtimeURL });
  }

  /** Every signed transaction of the customer, following pagination. null when the transaction is unknown. */
  async history(env: AppleEnv, transactionId: string): Promise<string[] | null> {
    const out: string[] = [];
    let revision: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const q = new URLSearchParams({ sort: "ASCENDING" });
      if (revision) q.set("revision", revision);
      const body = await this.get<HistoryResponse>(env, `/inApps/v2/history/${encodeURIComponent(transactionId)}?${q}`);
      if (!body) return page === 0 ? null : out;
      out.push(...(body.signedTransactions ?? []));
      if (!body.hasMore || !body.revision) break;
      revision = body.revision;
    }
    return out;
  }

  subscriptionStatuses(env: AppleEnv, transactionId: string): Promise<StatusesResponse | null> {
    return this.get<StatusesResponse>(env, `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`);
  }

  /** Look Up Order ID: the signed transactions on an App Store order (the id on the customer's receipt email). Status 0 valid, 1 invalid. */
  lookupOrder(env: AppleEnv, orderId: string) {
    return this.get<{ status?: number; signedTransactions?: string[] }>(env, `/inApps/v1/lookup/${encodeURIComponent(orderId)}`);
  }

  /** Extend a Subscription Renewal Date: up to 90 days, twice a year per customer. */
  extendRenewalDate(env: AppleEnv, originalTransactionId: string, body: { extendByDays: number; extendReasonCode: number; requestIdentifier: string }) {
    return this.send<{ effectiveDate?: number; originalTransactionId?: string; success?: boolean; webOrderLineItemId?: string }>(env, "PUT", `/inApps/v1/subscriptions/extend/${encodeURIComponent(originalTransactionId)}`, body);
  }

  /** Extend Subscription Renewal Dates for All Active Subscribers of one product (optionally some storefronts only). */
  massExtendRenewalDate(env: AppleEnv, body: { extendByDays: number; extendReasonCode: number; requestIdentifier: string; productId: string; storefrontCountryCodes?: string[] }) {
    return this.send<{ requestIdentifier?: string }>(env, "POST", "/inApps/v1/subscriptions/extend/mass", body);
  }

  /** Status of a mass extension request. */
  massExtendStatus(env: AppleEnv, productId: string, requestIdentifier: string) {
    return this.get<{ requestIdentifier?: string; complete?: boolean; completeDate?: number; succeededCount?: number; failedCount?: number }>(
      env, `/inApps/v1/subscriptions/extend/mass/${encodeURIComponent(productId)}/${encodeURIComponent(requestIdentifier)}`);
  }
}

/** A 4xx other than 401/404 from Apple: the request was about a transaction Apple does not accept. */
export class AppleApiClientError extends Error {
  constructor(public status: number, public errorCode: number | null, message: string) { super(message); }
}

/** Apple's rate limit (HTTP 429) after any allowed waits. A 503 like other temporary store failures. */
export class AppleRateLimitError extends RCError {
  constructor(public retryAfterMs: number | null) {
    super(503, Codes.STORE_PROBLEM, `Apple's rate limit was reached (HTTP 429)${retryAfterMs !== null ? `; Apple asks to wait ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s` : ""}. Try again later.`);
  }
}

/**
 * Milliseconds until Retry-After allows another call, or null without a usable header. Apple sends the UNIX time in
 * milliseconds; the HTTP forms (seconds, or a date) are accepted too.
 */
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  const v = header?.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Math.max(0, n > 1e11 ? n - nowMs : n * 1000);
  }
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Frees the connection: Workers count an unread response body against the request's few simultaneous connections. */
const discard = (res: Response) => res.body?.cancel().catch(() => {});

/** Why fetch threw, short and safe to show (the URL holds no secret; the key is in a header). */
function networkReason(e: unknown): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return `no answer within ${TIMEOUT_MS / 1000} s`;
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
