import { Codes, RCError } from "../../errors.js";
import type { AppRow } from "../types.js";
import { guardedFetch, OutboundRefused } from "../../services/outbound.js";

/**
 * Roku Pay web services (https://developer.roku.com/dev/docs/roku-web-service). The API key goes into the URL of every
 * call, so neither the URL nor a fetch error's text ever reaches a log or an answer.
 *   GET  {ROKU_API}/validate-transaction/{partnerAPIKey}/{transactionId}   (Accept: application/json)
 * Dates in JSON are WCF dates: "/Date(1588892919000+0000)/". A wrong key answers HTTP 200 with `status: 1` and
 * `errorMessage: "UNAUTHORIZED"`; a transaction id that is not a Roku id answers HTTP 400 `Invalid URI format.`
 */
export const ROKU_API = "https://apipub.roku.com/listen/transaction-service.svc";

export interface RokuTransaction {
  transactionId: string | null; OriginalTransactionId?: string | null; purchaseDate: string | null; originalPurchaseDate?: string | null;
  expirationDate?: string | null; channelId?: string | number | null; channelName?: string | null; productId: string | null; productName?: string | null;
  amount?: number | null; tax?: number | null; total?: number | null; currency?: string | null; quantity?: number | null;
  rokuCustomerId?: string | null; partnerReferenceId?: string | null; couponCode?: string | null;
  cancelled?: boolean | null; isEntitled?: boolean | null; isDunning?: boolean | null;
  purchaseStatus?: "Active" | "Inactive" | "PendingActive" | "PendingInactive" | string | null;
  purchaseType?: string | null; cancelledTransactionIds?: string[] | null; purchaseChannel?: string | null; purchaseContext?: string | null;
  status: number | string; errorCode?: string | null; errorDetails?: string | null; errorMessage?: string | null;
}

export class RokuApiError extends Error {
  constructor(public kind: "invalid" | "credentials" | "transient", message: string, public status = 0) { super(message); }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export interface RokuClientOptions { fetch?: FetchFn; timeoutMs?: number }

export function rokuKeyOf(app: Pick<AppRow, "credentials">): string | null {
  const k = (app.credentials ?? {}).roku_api_key;
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

/** WCF ("/Date(1588892919000+0000)/"), ISO 8601 or zone-less XML dates (UTC). */
export function rokuDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const wcf = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(v);
  if (wcf) return new Date(Number(wcf[1]));
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const ok = (status: unknown) => status === 0 || status === "0" || status === "Success";

export class RokuClient {
  readonly customFetch: boolean;
  readonly fetchImpl: FetchFn;
  readonly timeoutMs: number;
  constructor(opts: RokuClientOptions = {}) {
    this.customFetch = !!opts.fetch;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** One validate-transaction call with an explicit key (the credentials check uses a made-up transaction id). */
  async validateWith(key: string, transactionId: string): Promise<RokuTransaction> {
    const e = encodeURIComponent;
    let res: Response;
    try {
      res = await withTimeout(guardedFetch(this.fetchImpl, `${ROKU_API}/validate-transaction/${e(key)}/${e(transactionId)}`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) }), this.timeoutMs);
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      // Never the error's text: a fetch error can quote the URL, which holds the API key.
      throw new RokuApiError("transient", `Roku Pay ${timedOut ? "timed out" : err instanceof OutboundRefused ? `was refused: ${err.message}` : "could not be reached"}`);
    }
    const text = await res.text().catch(() => "");
    if (res.status === 400) throw new RokuApiError("invalid", "This is not a Roku transaction id (Roku: Invalid URI format).", 400);
    if (res.status === 404) throw new RokuApiError("invalid", "Roku does not know this transaction.", 404);
    if (!res.ok) throw new RokuApiError("transient", `Roku Pay answered ${res.status}`, res.status);
    let body: RokuTransaction;
    try { body = JSON.parse(text) as RokuTransaction; } catch { throw new RokuApiError("transient", "Roku Pay answered without JSON", res.status); }
    if (!body || typeof body !== "object") throw new RokuApiError("transient", "Roku Pay answered without a transaction", res.status);
    if (ok(body.status) && body.transactionId) return body;
    const msg = String(body.errorMessage ?? "").trim();
    if (/unauthori[sz]ed/i.test(msg)) throw new RokuApiError("credentials", "Roku rejected the API key (UNAUTHORIZED). Copy the key from the Roku developer dashboard → Roku Pay web services again.", 200);
    throw new RokuApiError("invalid", `Roku does not know this transaction${msg ? ` (${msg})` : ""}.`, 200);
  }

  async validate(app: Pick<AppRow, "credentials">, transactionId: string): Promise<RokuTransaction> {
    const key = rokuKeyOf(app);
    if (!key) throw new RCError(500, Codes.STORE_PROBLEM, "This Roku app has no Roku Pay API key yet. Add it in the app's settings (Roku developer dashboard → Roku Pay web services).");
    return this.validateWith(key, transactionId);
  }
}

/** Roku failures as the receipt endpoint must answer them: never 4xx for anything that can succeed later. */
export function toRCError(e: unknown): unknown {
  if (!(e instanceof RokuApiError)) return e;
  if (e.kind === "invalid") return new RCError(400, Codes.INVALID_RECEIPT, `Roku: ${e.message}`);
  if (e.kind === "credentials") return new RCError(500, Codes.STORE_PROBLEM, `Roku credentials problem: ${e.message}`);
  return new RCError(503, Codes.STORE_PROBLEM, `Roku Pay is temporarily unavailable: ${e.message}. Try again later.`);
}
