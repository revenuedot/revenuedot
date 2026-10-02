import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { importIapPublicKey } from "./api.js";

/**
 * Samsung Instant Server Notifications (https://developer.samsung.com/iap/isn/jwt/payload.html): a POST whose body is a
 * compact JWT (RS256) signed with the seller's IAP key pair. Claims: `iss: "iap.samsungapps.com"`, `sub` = the event,
 * `aud` = [package name], `iat`, `nbf`, `version: "2.0"`, and `data` with the event's fields.
 * With the IAP public key saved, the signature must verify. Without it (RevenueCat asks for no such key) the notification
 * is only a trigger: nothing in it is trusted, the purchase it names is re-read from Samsung.
 */
export const SAMSUNG_ISSUER = "iap.samsungapps.com";

export class GalaxyNotificationError extends Error {}

export interface GalaxyNotification { event: string; data: Record<string, any>; iat: number | null; verified: boolean }

export async function readGalaxyNotification(body: string, o: { packageName: string | null; publicKey: string | null; now: Date }): Promise<GalaxyNotification> {
  const token = body.trim().replace(/^"|"$/g, "");
  if (!/^[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) throw new GalaxyNotificationError("The body is not a Samsung server notification (a JWT).");
  let claims: Record<string, unknown>;
  let verified = false;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256") throw new GalaxyNotificationError(`Samsung signs with RS256, not ${String(header.alg)}.`);
  } catch (e) {
    if (e instanceof GalaxyNotificationError) throw e;
    throw new GalaxyNotificationError("The notification's JWT header cannot be read.");
  }
  if (o.publicKey) {
    let key;
    try { key = await importIapPublicKey(o.publicKey); } catch (e) { throw new GalaxyNotificationError(e instanceof Error ? e.message : String(e)); }
    try {
      ({ payload: claims } = await jwtVerify(token, key, { algorithms: ["RS256"], currentDate: o.now, clockTolerance: 300 }));
      verified = true;
    } catch (e) {
      throw new GalaxyNotificationError(`The notification's signature does not match the IAP public key: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    try { claims = decodeJwt(token); } catch { throw new GalaxyNotificationError("The notification's JWT cannot be read."); }
  }
  if (claims.iss !== SAMSUNG_ISSUER) throw new GalaxyNotificationError(`The notification is not from Samsung (iss ${String(claims.iss)}).`);
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : typeof claims.aud === "string" ? [claims.aud] : [];
  if (o.packageName && !aud.includes(o.packageName)) throw new GalaxyNotificationError(`The notification is for ${aud.join(", ") || "no package"}, not ${o.packageName}.`);
  if (typeof claims.sub !== "string" || !claims.sub) throw new GalaxyNotificationError("The notification names no event (sub).");
  const data = claims.data && typeof claims.data === "object" ? claims.data as Record<string, any> : {};
  return { event: claims.sub, data, iat: typeof claims.iat === "number" ? claims.iat : null, verified };
}
