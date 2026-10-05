import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { esc } from "../mail/templates.js";
import { JwsError, verifyAppleJws } from "../stores/apple/jws.js";
import { messagingOf, realtimeAnswer, type RealtimeRequest } from "../services/retention.js";
import { markClicked, markOpened, sendByToken, unsubscribe } from "../services/winback.js";
import { caseByCenterToken, caseByToken, destinationFor, emailFor, markClicked as markRecoveryClicked, portalLink, PORTAL_LINK_TTL_MS, sendPortalLink, unsubscribeCase } from "../services/payment-recovery.js";
import { clientIp } from "../services/rate-limit.js";
import { publicOrigin } from "./oauth.js";
import { withStoreSecrets } from "../services/store-secrets.js";

/**
 * Public lifecycle endpoints (no API key): Apple's real-time Retention Messaging call, and the links in win-back emails.
 * Mounted before the SDK routes, which would otherwise ask for an SDK key.
 */

const MAX_REQUEST_AGE_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

export const page = (title: string, body: string, form?: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>` +
  `<style>body{margin:0;background:#fff;color:#0A0A0A;font:15px/24px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}main{max-width:480px;margin:15vh auto;padding:0 16px}` +
  `h1{font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.02em;margin:0 0 12px}p{color:#525252;margin:0 0 20px}button{height:36px;padding:0 16px;border:0;background:#0A0A0A;color:#fff;font:600 12px/1 inherit;letter-spacing:.05em;text-transform:uppercase;cursor:pointer}` +
  `@media (prefers-color-scheme:dark){body{background:#0A0A0A;color:#FAFAFA}p{color:#A3A3A3}button{background:#FAFAFA;color:#0A0A0A}}</style></head>` +
  `<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p>${form ?? ""}</main></body></html>`;

export function lifecyclePublicRoutes(deps: Deps) {
  const r = new Hono();
  const { db } = deps;

  // Apple's "Get Retention Message" endpoint. Apple waits 700 ms in production, so this does one read and signs at most once.
  r.post("/v1/retention/apple/:appId", async (c) => {
    const [app] = await db.select().from(schema.apps).where(eq(schema.apps.id, c.req.param("appId"))).limit(1);
    if (!app || (app.type !== "app_store" && app.type !== "mac_app_store")) return c.json({ error: "Unknown App Store app." }, 404);
    const b = await c.req.json().catch(() => null) as { signedPayload?: unknown } | null;
    if (typeof b?.signedPayload !== "string") return c.json({ error: "signedPayload is missing." }, 400);
    let req: RealtimeRequest;
    try {
      // Only the App Store calls this endpoint: Xcode's local StoreKit certificates are not accepted.
      req = await verifyAppleJws<RealtimeRequest>(b.signedPayload, { xcodeRoots: [], now: deps.now() });
    } catch (e) {
      if (e instanceof JwsError) return c.json({ error: `The signed payload is not valid: ${e.message}.` }, 400);
      throw e;
    }
    if (req?.environment !== "Production" && req?.environment !== "Sandbox") return c.json({ error: "The signed payload is not a retention message request." }, 400);
    // A captured request cannot be replayed later: Apple signs each call just before it waits 700 ms for the answer.
    const age = deps.now().getTime() - Number(req.signedDate);
    if (!Number.isFinite(age) || age > MAX_REQUEST_AGE_MS || age < -MAX_CLOCK_SKEW_MS) return c.json({ error: "The signed payload is too old." }, 400);
    // Apple: always check appAppleId, and do not answer a request for another app. Production requires it to be set.
    const expected = app.credentials?.app_apple_id;
    if (expected && req.appAppleId != null && String(req.appAppleId) !== String(expected)) return c.json({ error: `The request is for Apple app id ${req.appAppleId}, not ${expected}.` }, 400);
    if (req.environment === "Production" && (!expected || req.appAppleId == null)) return c.json({ error: "Set the app's Apple ID in RevenueDot before answering production requests." }, 400);
    const cfg = messagingOf(app);
    let answer: Record<string, unknown> = {};
    // Signing a promotional offer can fail (an incomplete or invalid key): Apple then shows the default message.
    try { answer = await realtimeAnswer(cfg, req, await withStoreSecrets(deps, app), deps.now()); } catch (e) { console.warn(`Retention message for app ${app.id} failed: ${e instanceof Error ? e.message : String(e)}`); }
    const now = deps.now().getTime();
    // The counter is the only write, after the answer.
    const count = db.execute(sql`UPDATE apps SET retention_messaging = jsonb_set(coalesce(retention_messaging, '{}'::jsonb), '{stats}',
      jsonb_build_object('requests', coalesce((retention_messaging->'stats'->>'requests')::int, 0) + 1,
        'answered', coalesce((retention_messaging->'stats'->>'answered')::int, 0) + ${Object.keys(answer).length ? 1 : 0},
        'last_request_at', ${now}::bigint, 'last_environment', ${String(req.environment ?? "")}::text)) WHERE id = ${app.id}`).catch((e) => console.warn("Counting a retention request failed", e));
    if (deps.defer) deps.defer(() => count); else await count;
    return c.json(answer);
  });

  // Win-back email links.
  r.get("/v1/winback/c/:token", async (c) => {
    const url = await markClicked(db, c.req.param("token"), deps.now());
    if (!url) return c.html(page("This link has expired", "The offer this email linked to is no longer available."), 404);
    return c.redirect(url, 302);
  });
  r.get("/v1/winback/o/:token", async (c) => {
    await markOpened(db, c.req.param("token"), deps.now());
    return c.body(GIF, 200, { "content-type": "image/gif", "cache-control": "no-store, max-age=0" });
  });
  // The Customer Center link (customer info's management_url, readable with the app's public key). Store purchases go
  // straight to the store's own signed-in page; a web (Stripe) purchase gets a one-time portal link by email instead,
  // so nobody holding the public key and an app user id can open the customer's billing portal.
  const PAID = () => page("Your payment went through", "Your subscription is active again. There is nothing else to do.");
  const NO_EMAIL = () => page("Update your payment method", "We have no email address for your subscription, so we cannot send you a secure link. Update your payment method in the account where you subscribed on the web, or contact the app's support team.");
  const CLOSED = () => page("This link has expired", "Open the app to manage your subscription, or contact the app's support team.");
  const minutes = PORTAL_LINK_TTL_MS / 60_000;
  r.get("/v1/recovery/c/:token", async (c) => {
    const rc = await caseByCenterToken(db, c.req.param("token"));
    if (!rc) return c.html(page("Link not found", "This link is not valid."), 404);
    if (rc.status === "recovered") return c.html(PAID());
    if (rc.store !== "stripe") {
      await markRecoveryClicked(db, rc, deps.now());
      const to = await destinationFor(deps, rc, `${deps.apiUrl ?? publicOrigin(c)}/v1/recovery/done/${rc.token}`);
      if (to.kind === "redirect") return c.redirect(to.url, 303);
      return c.html(page(to.title, to.body));
    }
    if (rc.status !== "open") return c.html(CLOSED());
    if (!(await emailFor(deps, rc))) return c.html(NO_EMAIL());
    // A GET never sends email (link previews and prefetching open links); the button does.
    return c.html(page("We'll email you a secure link", `To keep your payment details safe, we send a link to the email address we have for your subscription. It opens the payment page once and works for ${minutes} minutes.`,
      `<form method="post"><button type="submit">Email me the link</button></form>`));
  });
  r.post("/v1/recovery/c/:token", async (c) => {
    const rc = await caseByCenterToken(db, c.req.param("token"));
    if (!rc) return c.html(page("Link not found", "This link is not valid."), 404);
    if (rc.status === "recovered") return c.html(PAID());
    if (rc.store !== "stripe" || rc.status !== "open") return c.html(CLOSED());
    const sent = await sendPortalLink(deps, rc, { base: deps.apiUrl ?? publicOrigin(c), ip: clientIp((h) => c.req.header(h)) });
    if (sent === "no_email") return c.html(NO_EMAIL());
    if (sent === "limited") return c.html(page("Too many requests", "We already sent you several links. Check your email, or try again in an hour."), 429);
    if (sent === "failed") return c.html(page("Try again in a minute", "We could not send the email right now. Try again in a minute."), 503);
    return c.html(page("Check your email", `We sent a secure link to the email address we have for your subscription. It works once, for ${minutes} minutes.`));
  });
  // The emailed one-time link. GET only shows a button (mail scanners open links, which must not spend it); POST spends it
  // and makes the Stripe portal session.
  const linkPage = (status: "invalid" | "used" | "expired" | "ok", open: boolean) =>
    status === "invalid" ? page("Link not found", "This link is not valid.")
    : status === "used" ? page("This link was already used", "Each link works once. Open the app and ask for a new one.")
    : status === "expired" || !open ? page("This link has expired", "Links work for 30 minutes. Open the app and ask for a new one.")
    : page("Update your payment method", "Continue to the secure payment page to update your card.", `<form method="post"><button type="submit">Update payment method</button></form>`);
  r.get("/v1/recovery/p/:token", async (c) => {
    const l = await portalLink(db, c.req.param("token"), deps.now(), false);
    if (l.case?.status === "recovered") return c.html(PAID());
    return c.html(linkPage(l.status, l.case?.status === "open"), l.status === "invalid" ? 404 : 200);
  });
  r.post("/v1/recovery/p/:token", async (c) => {
    const peek = await portalLink(db, c.req.param("token"), deps.now(), false);
    if (peek.case?.status === "recovered") return c.html(PAID());
    if (peek.status !== "ok" || peek.case?.status !== "open") return c.html(linkPage(peek.status, peek.case?.status === "open"), peek.status === "invalid" ? 404 : 200);
    const l = await portalLink(db, c.req.param("token"), deps.now(), true);
    if (l.status !== "ok" || !l.case) return c.html(linkPage(l.status, true));
    await markRecoveryClicked(db, l.case, deps.now());
    const to = await destinationFor(deps, l.case, `${deps.apiUrl ?? publicOrigin(c)}/v1/recovery/done/${l.case.token}`);
    if (to.kind === "redirect") return c.redirect(to.url, 303);
    return c.html(page(to.title, to.body));
  });
  // GET shows a button (mail scanners follow links, so a GET never unsubscribes); POST unsubscribes, also RFC 8058 one-click.
  r.get("/v1/winback/u/:token", async (c) => {
    const s = await sendByToken(db, c.req.param("token"));
    if (!s) return c.html(page("Link not found", "This unsubscribe link is not valid."), 404);
    if (s.unsubscribedAt) return c.html(page("You are unsubscribed", `${s.email} will get no more of these emails.`));
    return c.html(page("Unsubscribe?", `Stop offers like this one to ${s.email}.`, `<form method="post"><button type="submit">Unsubscribe</button></form>`));
  });
  r.post("/v1/winback/u/:token", async (c) => {
    const s = await sendByToken(db, c.req.param("token"));
    if (!s || !(await unsubscribe(db, c.req.param("token"), deps.now()))) return c.html(page("Link not found", "This unsubscribe link is not valid."), 404);
    return c.html(page("You are unsubscribed", `${s.email} will get no more of these emails.`));
  });

  // Payment recovery email links (prd/payment-recovery/PRD.md): "Update payment", the return page, unsubscribe.
  r.get("/v1/recovery/l/:token", async (c) => {
    const rc = await caseByToken(db, c.req.param("token"));
    if (!rc) return c.html(page("Link not found", "This link is not valid."), 404);
    if (rc.status === "recovered") return c.html(page("Your payment went through", "Your subscription is active again. There is nothing else to do."));
    // A Stripe portal session opens the customer's billing details: only while the case is open, never from an old email.
    if (rc.status !== "open" && rc.store === "stripe") return c.html(page("This link has expired", "Open the app to manage your subscription, or reply to the email you got and the app's support team will help you."));
    await markRecoveryClicked(db, rc, deps.now());
    const back = `${deps.apiUrl ?? publicOrigin(c)}/v1/recovery/done/${rc.token}`;
    const to = await destinationFor(deps, rc, back);
    if (to.kind === "redirect") return c.redirect(to.url, 303);
    return c.html(page(to.title, to.body));
  });
  r.get("/v1/recovery/done/:token", async (c) => {
    const rc = await caseByToken(db, c.req.param("token"));
    if (!rc) return c.html(page("Link not found", "This link is not valid."), 404);
    return c.html(page("Thank you", "Your payment details are saved. The store retries the payment shortly, and your subscription continues once it goes through. You can close this page."));
  });
  // GET shows a button (mail scanners follow links, so a GET never unsubscribes); POST unsubscribes, also RFC 8058 one-click.
  r.get("/v1/recovery/u/:token", async (c) => {
    const rc = await caseByToken(db, c.req.param("token"));
    if (!rc) return c.html(page("Link not found", "This unsubscribe link is not valid."), 404);
    if (rc.unsubscribedAt) return c.html(page("You are unsubscribed", "You will get no more of these emails."));
    return c.html(page("Unsubscribe?", `Stop emails about failed payments${rc.email ? ` to ${rc.email}` : ""}.`, `<form method="post"><button type="submit">Unsubscribe</button></form>`));
  });
  r.post("/v1/recovery/u/:token", async (c) => {
    const rc = await caseByToken(db, c.req.param("token"));
    if (!rc) return c.html(page("Link not found", "This unsubscribe link is not valid."), 404);
    await unsubscribeCase(db, rc, deps.now());
    return c.html(page("You are unsubscribed", `${rc.email ?? "This address"} will get no more of these emails.`));
  });
  return r;
}
