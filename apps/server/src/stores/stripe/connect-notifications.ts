import { Hono } from "hono";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { Codes } from "../../errors.js";
import { accountUpdated, appsForAccount, deauthorizedInStripe } from "../../services/stripe-connect.js";
import { withStoreSecrets } from "../../services/store-secrets.js";
import type { StripeEvent } from "./api.js";
import { parseEvent, processStripeEvent } from "./notifications.js";
import { StripeSignatureError, verifyStripeSignature } from "./signature.js";

const { storeNotifications } = schema;

/**
 * The platform's Connect webhook endpoint (prd/web-billing/PRD.md §8): POST /v1/notifications/stripe-connect. Stripe sends
 * every connected account's events here with `account` set, signed with the platform endpoint's secret. Each event is
 * handled for every app connected to that account, exactly as on the app's own endpoint; deauthorization disconnects.
 */
export function stripeConnectNotificationRoutes(deps: Deps) {
  const r = new Hono();
  r.post("/v1/notifications/stripe-connect", async (c) => {
    const now = deps.now();
    const secrets = deps.stripeConnect?.webhookSecrets ?? [];
    if (!secrets.length) return c.json({ code: Codes.NOT_FOUND, message: "Stripe Connect is not set up on this server." }, 404);
    const raw = await c.req.text();
    const signature = c.req.header("stripe-signature");
    let verified = false;
    let lastError = "The Stripe-Signature header is missing.";
    for (const secret of secrets) {
      try { await verifyStripeSignature(raw, signature, secret, now); verified = true; break; } catch (e) { lastError = e instanceof StripeSignatureError ? e.message : String(e); }
    }
    if (!verified) return c.json({ code: Codes.BAD_REQUEST, message: lastError }, 400);
    const event = parseEvent(raw) as (StripeEvent & { account?: string }) | null;
    if (!event) return c.json({ code: Codes.BAD_REQUEST, message: "The body is not a Stripe event." }, 400);
    const account = typeof event.account === "string" && /^acct_[A-Za-z0-9]+$/.test(event.account) ? event.account : null;
    // Events on the platform's own account carry no `account`: nothing of a developer's.
    if (!account) return c.json({ status: "ignored" });
    const targets = await appsForAccount(deps.db, account);
    if (!targets.length) return c.json({ status: "unknown_account" });
    if (event.type === "account.application.deauthorized") {
      // The application object names the platform; another platform's deauthorization (impossible with our secret) is ignored.
      const appId = event.data?.object?.id;
      if (deps.stripeConnect?.clientId && typeof appId === "string" && appId.startsWith("ca_") && appId !== deps.stripeConnect.clientId) return c.json({ status: "ignored" });
      await deauthorizedInStripe(deps, targets);
      for (const t of targets) await recordConnectEvent(deps, t, event, raw, now);
      return c.json({ status: "disconnected" });
    }
    if (event.type === "account.updated") {
      await accountUpdated(deps.db, targets, event.data?.object ?? {}, now);
      for (const t of targets) await recordConnectEvent(deps, t, event, raw, now);
      return c.json({ status: "processed" });
    }
    const statuses: string[] = [];
    let failed = false;
    for (const row of targets) {
      // A test-mode connection acts with the platform's test key: live events are not its own (and the other way round).
      // With both a live and a test endpoint, Stripe sends each mode's events to its own endpoint, for every app of the account.
      const mode = row.credentials?.stripe_connect_mode === "test" ? "test" : "live";
      if (typeof event.livemode === "boolean" && event.livemode !== (mode === "live")) { statuses.push("other_mode"); continue; }
      let app: typeof row;
      try { app = await withStoreSecrets(deps, row); } catch (e) {
        console.error(`Stripe Connect event for ${row.id}: ${e instanceof Error ? e.message : e}`);
        failed = true; continue;
      }
      const out = await processStripeEvent(deps, c, app, { raw, event, signature });
      if (out.status >= 500) failed = true;
      statuses.push(String((out.body as { status?: string }).status ?? out.status));
    }
    if (failed) return c.json({ code: Codes.STORE_PROBLEM, message: "Temporary failure; Stripe will retry." }, 500);
    return c.json({ status: statuses.length === 1 ? statuses[0] : statuses.join(",") });
  });
  return r;
}

async function recordConnectEvent(deps: Deps, app: { id: string; projectId: string }, event: StripeEvent, raw: string, now: Date) {
  await deps.db.insert(storeNotifications).values({
    id: `stripe_${app.id}_${event.id}`, projectId: app.projectId, appId: app.id, store: "stripe", type: event.type, subtype: null, body: raw.slice(0, 64_000), receivedAt: now, processedAt: now,
    environment: event.livemode === false ? "sandbox" : "production",
  }).onConflictDoNothing();
}

