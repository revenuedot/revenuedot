import { Codes, RCError } from "../../errors.js";
import type { AppRow } from "../types.js";

/**
 * Amazon Appstore Receipt Verification Service (RVS) v1.0.
 * https://developer.amazon.com/docs/in-app-purchasing/iap-rvs-for-android-apps.html
 *   production: https://appstore-sdk.amazon.com/version/1.0/verifyReceiptId/developer/{secret}/user/{userId}/receiptId/{receiptId}
 *   sandbox:    https://appstore-sdk.amazon.com/sandbox/version/1.0/verifyReceiptId/...   (RVS cloud sandbox, App Tester)
 */
export const RVS_ORIGIN = "https://appstore-sdk.amazon.com";

/** RVS receipt (only the fields RevenueDot reads; Amazon may add more). Dates are epoch milliseconds. */
export interface AmazonReceipt {
  receiptId: string;
  productId: string;
  productType: "SUBSCRIPTION" | "CONSUMABLE" | "ENTITLED" | string;
  purchaseDate: number | null;
  renewalDate?: number | null;
  cancelDate?: number | null;
  /** null not cancelled, 0 unavailable, 1 customer, 2 Amazon (system). */
  cancelReason?: number | null;
  autoRenewing?: boolean | null;
  freeTrialEndDate?: number | null;
  gracePeriodEndDate?: number | null;
  deferredDate?: number | null;
  deferredSku?: string | null;
  term?: string | null;
  termSku?: string | null;
  testTransaction?: boolean | null;
  betaProduct?: boolean | null;
  countryCode?: string | null;
  quantity?: number | null;
  parentProductId?: string | null;
  promotions?: { promotionType?: string; promotionStatus?: string }[] | null;
  fulfillmentDate?: number | null;
  fulfillmentResult?: string | null;
}

/** What went wrong talking to RVS: the receipt is bad (never retry), the shared secret is wrong, or Amazon is unavailable. */
export class AmazonApiError extends Error {
  constructor(public kind: "invalid_receipt" | "cancelled" | "credentials" | "transient", message: string, public status = 0) { super(message); }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface AmazonClientOptions { fetch?: FetchFn; timeoutMs?: number }

export function sharedSecretOf(app: Pick<AppRow, "credentials">): string | null {
  const s = (app.credentials ?? {}).shared_secret;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

export class AmazonRvsClient {
  readonly customFetch: boolean;
  readonly fetchImpl: FetchFn;
  readonly timeoutMs: number;
  constructor(opts: AmazonClientOptions = {}) {
    this.customFetch = !!opts.fetch;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  url(env: "production" | "sandbox", secret: string, userId: string, receiptId: string) {
    const e = encodeURIComponent;
    return `${RVS_ORIGIN}${env === "sandbox" ? "/sandbox" : ""}/version/1.0/verifyReceiptId/developer/${e(secret)}/user/${e(userId)}/receiptId/${e(receiptId)}`;
  }

  /** One RVS call. Amazon's status codes: 200 ok, 400 invalid receipt, 410 no longer valid, 496 bad secret, 497 bad user, 429/5xx try later. */
  async verifyIn(env: "production" | "sandbox", secret: string, userId: string, receiptId: string): Promise<AmazonReceipt> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(env, secret, userId, receiptId), { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new AmazonApiError("transient", timedOut ? "Amazon's Receipt Verification Service timed out" : `Amazon's Receipt Verification Service could not be reached: ${e instanceof Error ? e.message : e}`);
    }
    const text = await res.text().catch(() => "");
    if (res.status === 200) {
      try {
        const j = JSON.parse(text) as AmazonReceipt;
        if (j && typeof j === "object" && typeof j.productId === "string") return j;
      } catch { /* below */ }
      throw new AmazonApiError("transient", "Amazon's Receipt Verification Service answered without a receipt", 200);
    }
    if (res.status === 400) throw new AmazonApiError("invalid_receipt", "Amazon does not know this receipt id.", 400);
    if (res.status === 410) throw new AmazonApiError("cancelled", "Amazon says this receipt is no longer valid (cancelled).", 410);
    if (res.status === 496) throw new AmazonApiError("credentials", "Amazon rejected the shared key (RVS 496). Copy the Shared Key from Developer Console → Settings → Identity again.", 496);
    if (res.status === 497) throw new AmazonApiError("invalid_receipt", "Amazon does not know this Amazon user id (RVS 497).", 497);
    throw new AmazonApiError("transient", `Amazon's Receipt Verification Service answered ${res.status}`, res.status);
  }

  /** Production first; a receipt production does not know is looked up in the RVS cloud sandbox (App Tester). */
  async verify(app: Pick<AppRow, "credentials">, userId: string, receiptId: string): Promise<{ receipt: AmazonReceipt; sandbox: boolean }> {
    const secret = sharedSecretOf(app);
    if (!secret) throw new RCError(500, Codes.STORE_PROBLEM, "This Amazon app has no shared key yet. Add it in the app's settings (Developer Console → Settings → Identity → Shared Key).");
    try {
      return { receipt: await this.verifyIn("production", secret, userId, receiptId), sandbox: false };
    } catch (e) {
      if (!(e instanceof AmazonApiError && e.kind === "invalid_receipt" && e.status === 400)) throw e;
    }
    return { receipt: await this.verifyIn("sandbox", secret, userId, receiptId), sandbox: true };
  }
}

/** RVS failures as the SDK must see them: bad receipts 400 (finish), everything temporary 5xx (keep and retry). */
export function toRCError(e: unknown): unknown {
  if (!(e instanceof AmazonApiError)) return e;
  if (e.kind === "invalid_receipt" || e.kind === "cancelled") return new RCError(400, Codes.INVALID_RECEIPT, e.message);
  if (e.kind === "credentials") return new RCError(500, Codes.STORE_PROBLEM, `Amazon credentials problem: ${e.message}`);
  return new RCError(503, Codes.STORE_PROBLEM, `Amazon is temporarily unavailable: ${e.message}. Try again later.`);
}
