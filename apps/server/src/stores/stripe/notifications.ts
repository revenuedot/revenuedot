import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { AppRecord, Deps } from "../../context.js";
import { Codes, RCError } from "../../errors.js";
import { recordCredentialFailure } from "../../services/credential-health.js";
import { withStoreSecrets } from "../../services/store-secrets.js";
import { forwardStoreNotification } from "../forward.js";
import { StripeApiError, type StripeEvent } from "./api.js";
import { stripeClientFor } from "./index.js";
import { StripeSignatureError, verifyStripeSignature } from "./signature.js";
import { handleStripeEvent } from "./sync.js";
import { completeWebCheckout } from "../../services/web/checkout.js";
import { mailPayBase } from "../../services/web/domains.js";
import { publicOrigin } from "../../routes/oauth.js";
import { logRejected, tooManyRejected } from "../rejected.js";

const { apps, storeNotifications } = schema;

/**
 * Stripe webhooks: POST /v1/notifications/stripe/{appId}, an endpoint in the developer's own Stripe account.
 * Every event must carry a valid Stripe-Signature for the app's signing secret. Stripe retries anything but 2xx for
 * three days, so we answer 2xx once an event is handled or can never be handled, and 5xx for temporary failures.
 */
export function stripeNotificationRoutes(deps: Deps) {
  const r = new Hono();
  r.post("/:appId", async (c) => {
    const now = deps.now();
    const [row] = await deps.db.select().from(apps).where(eq(apps.id, c.req.param("appId"))).limit(1);
    if (!row || row.type !== "stripe") return c.json({ code: Codes.NOT_FOUND, message: "No Stripe app with this id." }, 404);
    let app: typeof row;
    try { app = await withStoreSecrets(deps, row); } catch (e) {
      console.error(`Stripe event for ${row.id}: ${e instanceof Error ? e.message : e}`);
      return c.json({ code: Codes.STORE_PROBLEM, message: "The app's Stripe credentials could not be opened; Stripe will retry." }, 500);
    }
    const creds = (app.credentials ?? {}) as Record<string, unknown>;
    const raw = await c.req.text();
    const event = parseEvent(raw);
    const objectId = typeof event?.data?.object?.id === "string" ? event.data.object.id : null;
    const signature = c.req.header("stripe-signature");
    // A body without a valid Stripe-Signature is a rejected request (stores/rejected.ts): logged under an id of its own, so
    // an unsigned body can never take a real event's id, never forwarded, and never part of the app's notification status.
    const reject = async (error: string, message: string) => {
      if (!(await logRejected(deps, c, app, { store: "stripe", raw, type: event?.type ?? null, subtype: objectId, error }))) return tooManyRejected(c);
      return c.json({ code: Codes.BAD_REQUEST, message }, 400);
    };
    // A connected app's events come through the platform's Connect endpoint, signed with the platform's secret. An endpoint
    // the developer set up before connecting still gets Stripe's copies: they are acknowledged and dropped (no failing status).
    if (creds.stripe_connected === true) return c.json({ status: "ignored", message: "This app is connected with Stripe Connect; its events arrive at RevenueDot's Connect endpoint. You can remove this endpoint from your Stripe account." });
    const secret = typeof creds.stripe_webhook_secret === "string" ? creds.stripe_webhook_secret.trim() : "";
    if (!secret) return reject("rejected: no webhook signing secret is saved for this app", "Add the webhook signing secret (whsec_…) in the app's settings.");
    try {
      // Over the raw body, before anything is parsed into state.
      await verifyStripeSignature(raw, signature, secret, now);
    } catch (e) {
      const message = e instanceof StripeSignatureError ? e.message : String(e);
      return reject(`rejected: ${message}`, message);
    }
    if (!event) {
      // Signed with the app's secret but not an event: a real failure of this app's endpoint.
      await deps.db.insert(storeNotifications).values({
        id: `stripe_${app.id}_invalid_${crypto.randomUUID()}`, projectId: app.projectId, appId: app.id, store: "stripe", body: raw.slice(0, 64_000), receivedAt: now, error: "The body is not a Stripe event.",
      });
      return c.json({ code: Codes.BAD_REQUEST, message: "The body is not a Stripe event." }, 400);
    }
    const out = await processStripeEvent(deps, c, app, { raw, event, signature });
    return c.json(out.body, out.status);
  });
  return r;
}

export function parseEvent(raw: string): StripeEvent | null {
  try { const j = JSON.parse(raw); if (j && typeof j === "object" && typeof j.id === "string" && typeof j.type === "string") return j; } catch { /* below */ }
  return null;
}

/**
 * One verified Stripe event for one app (its own endpoint or the Connect endpoint): stored once per app and event id,
 * forwarded when the app forwards, then applied. Stripe retries anything but 2xx for three days, so the answer is 2xx once
 * an event is handled or can never be handled, and 5xx for temporary failures.
 */
export async function processStripeEvent(deps: Deps, c: Context, app: AppRecord, o: { raw: string; event: StripeEvent; signature: string | undefined }): Promise<{ status: ContentfulStatusCode; body: Record<string, unknown> }> {
  const now = deps.now();
  const { raw, event, signature } = o;
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  const objectId = typeof event?.data?.object?.id === "string" ? event.data.object.id : null;
  const id = `stripe_${app.id}_${event.id}`;
  const inserted = await deps.db.insert(storeNotifications).values({
    id, projectId: app.projectId, appId: app.id, store: "stripe", type: event.type, subtype: objectId, body: raw, receivedAt: now,
  }).onConflictDoNothing().returning({ id: storeNotifications.id });
  if (!inserted.length) {
    const [prev] = await deps.db.select({ processedAt: storeNotifications.processedAt }).from(storeNotifications).where(eq(storeNotifications.id, id));
    if (prev?.processedAt) return { status: 200, body: { status: "duplicate" } };
  }
  if (inserted.length && app.notificationForwardUrl) {
    forwardStoreNotification(c, { db: deps.db, fetchFn: deps.fetch ?? client.fetchImpl, url: app.notificationForwardUrl, notificationId: id, raw, strict: deps.edition === "cloud", headers: signature ? { "stripe-signature": signature } : {} });
  }
  const finish = (set: Partial<typeof storeNotifications.$inferInsert>) => deps.db.update(storeNotifications).set(set).where(eq(storeNotifications.id, id));

  const eventTime = new Date((event.created ?? now.getTime() / 1000) * 1000);
  try {
    // A session from RevenueDot's hosted checkout completes its web checkout (purchase, discount, redemption link).
    const meta = event.data?.object?.metadata as Record<string, unknown> | undefined;
    if ((event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") && objectId && typeof meta?.rd_checkout === "string") {
      // Only a checkout of this Stripe app: the signature proves the event came from this app's account, no other.
      const done = await completeWebCheckout(deps, { sessionId: objectId, appId: app.id }, mailPayBase(deps, publicOrigin(c)));
      if (done) {
        await finish({ processedAt: now, error: null, environment: event.livemode === false ? "sandbox" : "production" });
        if (done.status === "completed") await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
        deps.kick?.();
        return { status: 200, body: { status: done.status === "completed" ? "processed" : "ignored" } };
      }
    }
    const result = await handleStripeEvent({ db: deps.db, app, client, now, eventTime: Number.isNaN(eventTime.getTime()) ? now : eventTime }, event);
    await finish({ processedAt: now, error: null, environment: event.livemode === false || result.sandbox ? "sandbox" : "production" });
    if (result.status === "processed") await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
    deps.kick?.();
    return { status: 200, body: { status: result.status } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof StripeApiError && (e.kind === "not_found" || e.kind === "invalid")) {
      await finish({ processedAt: now, error: `Stripe: ${message}` });
      return { status: 200, body: { status: "invalid" } };
    }
    if (e instanceof RCError && e.status < 500) {
      await finish({ processedAt: now, error: message });
      return { status: 200, body: { status: "ignored" } };
    }
    if (e instanceof StripeApiError && e.kind === "credentials") await recordCredentialFailure(deps.db, app.id, e.message, now).catch(() => {});
    console.error(`Stripe event ${id} failed:`, e);
    await finish({ error: message });
    return { status: 500, body: { code: Codes.STORE_PROBLEM, message: "Temporary failure; Stripe will retry." } };
  }
}
