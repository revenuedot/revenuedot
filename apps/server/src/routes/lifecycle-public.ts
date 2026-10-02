import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { esc } from "../mail/templates.js";
import { JwsError, verifyAppleJws } from "../stores/apple/jws.js";
import { messagingOf, realtimeAnswer, type RealtimeRequest } from "../services/retention.js";
import { markClicked, markOpened, sendByToken, unsubscribe } from "../services/winback.js";
import { caseByToken, destinationFor, markClicked as markRecoveryClicked, unsubscribeCase } from "../services/payment-recovery.js";
import { publicOrigin } from "./oauth.js";

/**
 * Public lifecycle endpoints (no API key): Apple's real-time Retention Messaging call, and the links in win-back emails.
 * Mounted before the SDK routes, which would otherwise ask for an SDK key.
 */

const MAX_REQUEST_AGE_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

const page = (title: string, body: string, form?: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>` +
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
    try { answer = await realtimeAnswer(cfg, req, app, deps.now()); } catch (e) { console.warn(`Retention message for app ${app.id} failed: ${e instanceof Error ? e.message : String(e)}`); }
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
