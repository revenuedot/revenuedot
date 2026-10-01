/**
 * Stripe webhook signatures (https://docs.stripe.com/webhooks#verify-manually):
 *   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=…][,v0=…]
 * Any v1 may match (several appear while a secret is being rolled). The timestamp must be within the tolerance.
 */
export const STRIPE_TOLERANCE_SECONDS = 300;

export class StripeSignatureError extends Error {}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function stripeSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
}

/** Builds a header the way Stripe does (tests and the dashboard's "send a test event" use it). */
export async function signStripePayload(secret: string, payload: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${await stripeSignature(secret, timestamp, payload)}`;
}

/** Throws StripeSignatureError unless `header` signs `payload` with `secret` within the tolerance of `now`. */
export async function verifyStripeSignature(payload: string, header: string | undefined | null, secret: string, now: Date, tolerance = STRIPE_TOLERANCE_SECONDS): Promise<void> {
  if (!header) throw new StripeSignatureError("The Stripe-Signature header is missing.");
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1") v1.push(v.toLowerCase());
  }
  if (t === null || !v1.length) throw new StripeSignatureError("The Stripe-Signature header has no timestamp or no v1 signature.");
  const expected = await stripeSignature(secret, t, payload);
  if (!v1.some((s) => timingSafeEqual(s, expected))) throw new StripeSignatureError("No signature in Stripe-Signature matches the payload. Check the webhook signing secret.");
  if (Math.abs(now.getTime() / 1000 - t) > tolerance) throw new StripeSignatureError("The Stripe-Signature timestamp is outside the 5-minute tolerance.");
}
