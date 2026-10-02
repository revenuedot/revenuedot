import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type KeyLike } from "jose";
import { guardedFetch } from "../../services/outbound.js";
import type { FetchFn } from "./api.js";

/**
 * Roku Pay push notifications (https://developer.roku.com/dev/docs/push-notifications-jwt): a POST whose body is a
 * compact JWS (RS256) signed by Roku. The keys are Roku's published key set; the test endpoint in Roku's dashboard signs
 * with the test key set (kids `ROKU-PARTNER-SERVICE-TEST-…`). The message is base64 UTF-8 JSON in `x-Roku-message`.
 */
export const ROKU_JWKS = "https://assets.cs.roku.com/keys/partner-jwks.json";
export const ROKU_TEST_JWKS = "https://assets.cs.roku.com/keys/partner-jwks-test.json";
export const ROKU_ISSUER = "Roku, Inc. urn:roku:apps:partner-service.roku.com";
export const ROKU_MESSAGE_TYPE = "roku.rpay.push";

export class RokuPushError extends Error {}

export interface RokuPushMessage {
  customerId?: string; transactionType: string; transactionId: string; originalTransactionId?: string | null; channelId?: string | number | null;
  channelName?: string | null; productCode?: string | null; productName?: string | null; price?: number | null; tax?: number | null; total?: number | null;
  currency?: string | null; isFreeTrial?: boolean | null; expirationDate?: string | null; originalPurchaseDate?: string | null; eventDate?: string | null;
  comments?: string | null; responseKey?: string | null; purchaseChannel?: string | null; purchaseContext?: string | null; partnerReferenceId?: string | null;
}
export interface VerifiedPush { message: RokuPushMessage; messageKey: string; test: boolean; kid: string }

const CACHE_MS = 3_600_000;
const keySets = new Map<string, { at: number; keys: JWK[] }>();
/** Forgets cached key sets (tests rotate keys). */
export function clearRokuKeyCache() { keySets.clear(); }

async function keysOf(fetchFn: FetchFn, url: string, refresh: boolean, now: number): Promise<JWK[]> {
  const hit = keySets.get(url);
  if (hit && !refresh && now - hit.at < CACHE_MS) return hit.keys;
  let res: Response;
  try { res = await guardedFetch(fetchFn, url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }); } catch {
    if (hit) return hit.keys;
    throw new RokuPushError("Roku's signing keys could not be fetched.");
  }
  if (!res.ok) { if (hit) return hit.keys; throw new RokuPushError(`Roku's signing keys could not be fetched (HTTP ${res.status}).`); }
  const j = await res.json().catch(() => null) as { keys?: JWK[] } | null;
  const keys = Array.isArray(j?.keys) ? j!.keys : [];
  keySets.set(url, { at: now, keys });
  return keys;
}

/** Base64 or base64url, padded or not. */
function decodeB64(s: string): string {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Verifies a push's JWS with Roku's keys and returns the decoded message. Throws RokuPushError for anything not from Roku. */
export async function verifyRokuPush(token: string, fetchFn: FetchFn, now: Date): Promise<VerifiedPush> {
  const jws = token.trim();
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jws)) throw new RokuPushError("The body is not a signed Roku notification (a JWT).");
  let header;
  try { header = decodeProtectedHeader(jws); } catch { throw new RokuPushError("The notification's JWT header cannot be read."); }
  if (header.alg !== "RS256") throw new RokuPushError(`Roku signs with RS256, not ${String(header.alg)}.`);
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid.startsWith("ROKU-PARTNER-SERVICE-")) throw new RokuPushError("The notification is not signed with a Roku key.");
  const test = kid.startsWith("ROKU-PARTNER-SERVICE-TEST-");
  const url = test ? ROKU_TEST_JWKS : ROKU_JWKS;
  let jwk = (await keysOf(fetchFn, url, false, now.getTime())).find((k) => k.kid === kid);
  // A key Roku added since the last fetch.
  if (!jwk) jwk = (await keysOf(fetchFn, url, true, now.getTime())).find((k) => k.kid === kid);
  if (!jwk) throw new RokuPushError(`Roku's key set has no key ${kid}.`);
  let key: KeyLike | Uint8Array;
  try { key = await importJWK({ ...jwk, alg: "RS256" }, "RS256"); } catch { throw new RokuPushError(`Roku's key ${kid} cannot be read.`); }
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(jws, key, { issuer: ROKU_ISSUER, algorithms: ["RS256"], currentDate: now, clockTolerance: 300 }));
  } catch (e) {
    throw new RokuPushError(`The notification's signature or dates do not check out: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (payload["x-Roku-message-type"] !== ROKU_MESSAGE_TYPE) throw new RokuPushError(`Not a Roku Pay push (x-Roku-message-type ${String(payload["x-Roku-message-type"])}).`);
  const raw = payload["x-Roku-message"];
  if (typeof raw !== "string") throw new RokuPushError("The notification carries no x-Roku-message.");
  let message: RokuPushMessage;
  try { message = JSON.parse(decodeB64(raw)); } catch { throw new RokuPushError("x-Roku-message is not base64 JSON."); }
  if (!message || typeof message.transactionType !== "string" || typeof message.transactionId !== "string" || !message.transactionId) throw new RokuPushError("The Roku message has no transactionType or transactionId.");
  const messageKey = typeof payload["x-Roku-message-key"] === "string" && payload["x-Roku-message-key"] ? payload["x-Roku-message-key"] : `${message.transactionType}:${message.transactionId}:${message.eventDate ?? ""}`;
  return { message, messageKey, test, kid };
}
