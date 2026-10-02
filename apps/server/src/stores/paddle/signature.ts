/**
 * Paddle Billing webhook signatures (https://developer.paddle.com/webhooks/signature-verification):
 *   Paddle-Signature: ts=<unix seconds>;h1=<hex HMAC-SHA256(secret key, "<ts>:<raw body>")>[;h1=…]
 * Any h1 may match (several appear while a secret key is being rotated). Paddle's SDKs refuse a timestamp more than five
 * seconds old; deliveries can queue for longer, so the tolerance here is five minutes, like Stripe's.
 */
export const PADDLE_TOLERANCE_SECONDS = 300;

export class PaddleSignatureError extends Error {}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function paddleSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}:${payload}`)));
}

/** Builds a header the way Paddle does (tests, fakes and the e2e server use it). */
export async function signPaddlePayload(secret: string, payload: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `ts=${timestamp};h1=${await paddleSignature(secret, timestamp, payload)}`;
}

/** Throws PaddleSignatureError unless `header` signs `payload` with `secret` within the tolerance of `now`. */
export async function verifyPaddleSignature(payload: string, header: string | undefined | null, secret: string, now: Date, tolerance = PADDLE_TOLERANCE_SECONDS): Promise<void> {
  if (!header) throw new PaddleSignatureError("The Paddle-Signature header is missing.");
  let ts: number | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "ts" && /^\d+$/.test(v)) ts = Number(v);
    else if (k === "h1") h1.push(v.toLowerCase());
  }
  if (ts === null || !h1.length) throw new PaddleSignatureError("The Paddle-Signature header has no ts or no h1 signature.");
  const expected = await paddleSignature(secret, ts, payload);
  if (!h1.some((s) => timingSafeEqual(s, expected))) throw new PaddleSignatureError("No signature in Paddle-Signature matches the payload. Check the notification destination's secret key.");
  if (Math.abs(now.getTime() / 1000 - ts) > tolerance) throw new PaddleSignatureError("The Paddle-Signature timestamp is outside the 5-minute tolerance.");
}
