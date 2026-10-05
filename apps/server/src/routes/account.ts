import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { trySend } from "../mail/index.js";
import { accountDeletedEmail, emailChangeConfirmEmail, emailChangeNoticeEmail, passwordChangedEmail, twoFactorEmail } from "../mail/templates.js";
import {
  LIMITS, DISPLAY_CURRENCIES, checkSecondFactor, countCodeAttempt, describeAgent, forgiveCodeAttempt, isUniqueViolation, replaceRecoveryCodes, sealTotp, twoFactorOn,
  unsealTotp, type User,
} from "../services/account.js";
import { consumeToken, defer, issueToken, linkBase, requestOrigin, retireTokens } from "../services/account-email.js";
import { ratesOn, type FxFetch } from "../services/fx.js";
import { normEmail } from "../services/members.js";
import { hit } from "../services/rate-limit.js";
import { SESSION_COOKIE, hashPassword, publicSessionId, sessionUser, verifyPassword } from "../services/sessions.js";
import { newTotpSecret, otpauthUrl } from "../services/totp.js";
import { accountPlanOf, planOf, plansFrom } from "../services/billing/plans.js";
import { OAUTH_SCOPES } from "./oauth.js";
import { page } from "./lifecycle-public.js";
import { UNSUBSCRIBE_COLUMN, type NotificationKind } from "../services/account-notifications.js";
import { sha256Hex } from "../services/auth.js";
import { journeyTokenUser } from "../services/journeys.js";
import { connectAvailability } from "../services/stripe-connect.js";
import { storeSecretHintOf, stripeConnected } from "../services/store-secrets.js";
import { releaseVerifiedHostnames } from "../services/verified.js";

/**
 * Account settings (prd/account-settings/PRD.md), all for the signed-in person (session cookie), none per project:
 *
 *   POST   /auth/email/change              { new_email, password, code? }  a link to the new address, a notice to the old
 *   DELETE /auth/email/change              cancel a waiting change
 *   POST   /auth/email/change/confirm      { token }  (no session needed) the account moves to the new address
 *   POST   /auth/password/change           { current_password, new_password }  other sessions signed out
 *   GET    /auth/sessions                  signed-in browsers;  DELETE /auth/sessions/{id};  POST /auth/sessions/revoke_others
 *   POST   /auth/2fa/setup                 { password }  a new TOTP secret (base32 and otpauth URI), not yet on
 *   POST   /auth/2fa/enable                { code }  on, with 10 recovery codes shown once
 *   POST   /auth/2fa/disable               { code | recovery_code }
 *   POST   /auth/2fa/recovery_codes        { code | recovery_code }  10 new codes
 *   GET    /auth/oauth_tokens              OAuth keys this person granted;  DELETE /auth/oauth_tokens/{id}
 *   GET    /auth/account/projects          projects with role, owner and plan (Billing)
 *   POST   /auth/account/delete            { email, password?, code? }
 *   GET    /auth/notifications             per project: weekly summary, experiment results, anomaly alerts
 *   PUT    /auth/notifications/{project_id}
 *   GET|POST /auth/notifications/unsubscribe/{token}  (no session needed) the one-click unsubscribe link of one email
 *   GET    /auth/fx?currency=EUR           the latest USD rate for the display currency
 *   GET    /auth/stripe_accounts           Stripe accounts connected with Connect with Stripe to apps in the person's projects
 * Writes must come from the dashboard's own origin (the session cookie also rides on same-site requests).
 */

const Password = z.string().min(8, "Use at least 8 characters for your password.").max(200, "Use at most 200 characters for your password.");
const Code = z.object({ code: z.string().max(40).optional(), recovery_code: z.string().max(40).optional() });
const EmailChange = z.object({ new_email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(320), password: z.string().max(200).optional(), code: z.string().max(40).optional() });
const PasswordChange = z.object({ current_password: z.string().max(200), new_password: Password });
const Delete = z.object({ email: z.string().max(320), password: z.string().max(200).optional(), code: z.string().max(40).optional(), recovery_code: z.string().max(40).optional() });
const Prefs = z.object({
  weekly_summary: z.boolean().optional(), experiment_results: z.boolean().optional(), anomaly_alerts: z.boolean().optional(),
  anomaly_sensitivity: z.enum(["low", "medium", "high"]).optional(),
});

type Err = 400 | 401 | 403 | 404 | 409 | 429 | 502;

export function accountRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono();
  const err = (c: Context, status: Err, type: string, message: string, extra: Record<string, unknown> = {}) => c.json({ type, message, ...extra }, status);
  const json = async (c: Context) => c.req.json().catch(() => ({}));
  const base = (c: Context) => linkBase(deps, requestOrigin(c.req.url, (n) => c.req.header(n)));
  const sid = (c: Context) => getCookie(c, SESSION_COOKIE);
  const parse = <T>(c: Context, schemaZ: z.ZodType<T>, body: unknown): T | Response => {
    const p = schemaZ.safeParse(body);
    return p.success ? p.data : err(c, 400, "invalid_request", p.error.issues[0]?.message ?? "Invalid request.");
  };
  const passwordRefusal = async (email: string) => {
    for (const x of deps.extensions ?? []) { const r = await x.passwordPolicy?.({ deps, email: normEmail(email) }); if (r) return r; }
    return null;
  };

  // Every route here but the links in emails needs a session; writes must come from the dashboard itself.
  const isPublic = (path: string) => path === "/auth/email/change/confirm" || path.startsWith("/auth/notifications/unsubscribe/");
  const ROUTES = /^\/auth\/(email\/change|password\/change|sessions|2fa\/|oauth_tokens|account\/|notifications|fx|stripe_accounts)/;
  r.use("/auth/*", async (c, next) => {
    if (!ROUTES.test(c.req.path) || isPublic(c.req.path)) return next();
    const site = c.req.header("sec-fetch-site");
    if (c.req.method !== "GET" && (site === "cross-site" || site === "same-site")) return err(c, 403, "authorization_error", "Dashboard requests must come from the dashboard.");
    const u = await sessionUser(db, sid(c), deps.now());
    if (!u) return err(c, 401, "authentication_error", "Not signed in.");
    c.set("user" as never, u as never);
    await next();
  });
  const user = (c: Context) => c.get("user" as never) as User;

  /** Checks the current password (rate-limited per user). Accounts without one (single sign-on) pass with `null`. */
  const checkPassword = async (c: Context, u: User, password: string | undefined): Promise<Response | null> => {
    if (!u.passwordHash) return null;
    if (!(await hit(db, `pwcheck:user:${u.id}`, LIMITS.passwordChecks.n, LIMITS.passwordChecks.ms, deps.now()))) return err(c, 429, "rate_limit_error", "Too many attempts. Try again in 15 minutes.");
    if (!password || !(await verifyPassword(password, u.passwordHash))) return err(c, 400, "invalid_password", "Your current password is not right.");
    return null;
  };
  /** With two-factor on, a code (or recovery code) too; rate-limited with sign-in's code attempts. */
  const checkCode = async (c: Context, u: User, f: { code?: string; recovery_code?: string }): Promise<Response | { method?: string } | null> => {
    if (!twoFactorOn(u)) return null;
    if (!(await countCodeAttempt(db, u.id, deps.now()))) return err(c, 429, "rate_limit_error", "Too many code attempts. Try again in 15 minutes.");
    const r = await checkSecondFactor(deps, u, f, deps.now());
    if (!r.ok) return err(c, 400, "invalid_code", r.reason === "missing" ? "Enter the code from your authenticator app." : "That code is not right. Check your authenticator app, or use a recovery code.");
    await forgiveCodeAttempt(db, u.id);
    return { method: r.method };
  };
  const isResponse = (x: unknown): x is Response => x instanceof Response;

  // ---------- General: email change ----------
  r.post("/auth/email/change", async (c) => {
    const u = user(c);
    const b = parse(c, EmailChange, await json(c));
    if (isResponse(b)) return b;
    const now = deps.now();
    if (!(await hit(db, `emailchange:user:${u.id}`, LIMITS.emailChanges.n, LIMITS.emailChanges.ms, now))) return err(c, 429, "rate_limit_error", "Too many email changes. Try again in an hour.");
    const to = normEmail(b.new_email);
    if (to === u.email) return err(c, 400, "invalid_request", "That is already your email address.");
    for (const e of [u.email, to]) {
      const refusal = await passwordRefusal(e);
      if (refusal) return err(c, 403, "sso_required", e === u.email ? "Your organization manages this account's email through single sign-on." : `Addresses at ${to.split("@")[1]} sign in with single sign-on. Ask your organization's admin to add you.`);
    }
    const bad = await checkPassword(c, u, b.password);
    if (bad) return bad;
    const second = await checkCode(c, u, { code: b.code });
    if (isResponse(second)) return second;
    const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, to)).limit(1);
    if (taken) return err(c, 409, "email_taken", "Another RevenueDot account uses that address.");
    // One open change at a time: a new request replaces the old link.
    await retireTokens(db, "email_change", u.id, now);
    const token = await issueToken(db, "email_change", u, now, { newEmail: to });
    const bs = base(c);
    const url = `${bs}/confirm-email?token=${encodeURIComponent(token)}`;
    const [sentNew, sentOld] = await Promise.all([
      trySend(deps.mailer, { to, ...emailChangeConfirmEmail({ base: bs, url, oldEmail: u.email, newEmail: to }) }),
      trySend(deps.mailer, { to: u.email, ...emailChangeNoticeEmail({ base: bs, oldEmail: u.email, newEmail: to, state: "requested" }) }),
    ]);
    if (!sentNew) return err(c, 502, "server_error", "The email could not be sent. Try again in a few minutes.");
    return c.json({ ok: true, pending_email: { email: to, expires_at: now.getTime() + 24 * 3600_000 }, notice_sent: sentOld });
  });

  r.delete("/auth/email/change", async (c) => {
    await retireTokens(db, "email_change", user(c).id, deps.now());
    return c.json({ ok: true, pending_email: null });
  });

  const LINK_ERRORS = {
    invalid: "This link is not valid. Ask for a new one from Account settings.",
    expired: "This link has expired. Change your email again from Account settings.",
    used: "This link was already used.",
  } as const;
  r.post("/auth/email/change/confirm", async (c) => {
    const b = await json(c) as { token?: unknown };
    const token = typeof b.token === "string" ? b.token : "";
    const now = deps.now();
    const t = await consumeToken(db, "email_change", token, now);
    if (!t.ok) return err(c, 400, "token_invalid", LINK_ERRORS[t.reason], { reason: t.reason });
    const to = t.row.newEmail!;
    const old = t.user.email;
    // The unique index on users.email decides, so an address another account took a moment ago is refused, not a 500.
    try {
      await db.update(schema.users).set({ email: to, emailVerifiedAt: now }).where(eq(schema.users.id, t.user.id));
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, 409, "email_taken", "Another RevenueDot account started using that address. Pick another one.");
      throw e;
    }
    // Links sent to the old address stop working (they are bound to it); say so for the record.
    for (const k of ["password_reset", "email_verify", "email_change", "two_factor"] as const) await retireTokens(db, k, t.user.id, now);
    const bs = base(c);
    defer(deps, () => trySend(deps.mailer, { to: old, ...emailChangeNoticeEmail({ base: bs, oldEmail: old, newEmail: to, state: "changed" }) }));
    return c.json({ ok: true, email: to });
  });

  // ---------- Security: password ----------
  r.post("/auth/password/change", async (c) => {
    const u = user(c);
    const b = parse(c, PasswordChange, await json(c));
    if (isResponse(b)) return b;
    const refusal = await passwordRefusal(u.email);
    if (refusal) return err(c, 403, "sso_required", refusal.message);
    if (!u.passwordHash) return err(c, 400, "no_password", "This account signs in with single sign-on and has no password. Use \"Forgot password?\" on the sign-in page to set one.");
    const bad = await checkPassword(c, u, b.current_password);
    if (bad) return bad;
    if (b.new_password === b.current_password) return err(c, 400, "invalid_request", "The new password is the same as the current one.");
    const now = deps.now();
    await db.update(schema.users).set({ passwordHash: await hashPassword(b.new_password), passwordChangedAt: now }).where(eq(schema.users.id, u.id));
    const others = await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, u.id), ne(schema.sessions.id, sid(c)!))).returning({ id: schema.sessions.id });
    await retireTokens(db, "password_reset", u.id, now);
    // Sign-ins half done with the old password (a correct password, no code yet) end too.
    await retireTokens(db, "two_factor", u.id, now);
    const bs = base(c);
    defer(deps, () => trySend(deps.mailer, { to: u.email, ...passwordChangedEmail({ base: bs, email: u.email }) }));
    return c.json({ ok: true, sessions_revoked: others.length });
  });

  // ---------- Security: sessions ----------
  r.get("/auth/sessions", async (c) => {
    const u = user(c);
    const mine = sid(c);
    const rows = await db.select().from(schema.sessions).where(and(eq(schema.sessions.userId, u.id), sql`${schema.sessions.expiresAt} > ${deps.now().toISOString()}::timestamptz`))
      .orderBy(desc(schema.sessions.lastSeenAt));
    const items = await Promise.all(rows.map(async (s) => ({
      object: "session", id: await publicSessionId(s.id), current: s.id === mine, method: s.method, ...describeAgent(s.userAgent), user_agent: s.userAgent, ip: s.ip,
      created_at: s.createdAt.getTime(), last_seen_at: (s.lastSeenAt ?? s.createdAt).getTime(), expires_at: s.expiresAt.getTime(),
    })));
    items.sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at - a.last_seen_at);
    return c.json({ object: "list", items });
  });

  r.delete("/auth/sessions/:id", async (c) => {
    const u = user(c);
    const want = c.req.param("id");
    const rows = await db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, u.id));
    for (const s of rows) {
      if ((await publicSessionId(s.id)) !== want) continue;
      await db.delete(schema.sessions).where(eq(schema.sessions.id, s.id));
      if (s.id === sid(c)) deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true, id: want, current: s.id === sid(c) });
    }
    return err(c, 404, "resource_missing", "That session has already ended.");
  });

  r.post("/auth/sessions/revoke_others", async (c) => {
    const u = user(c);
    const gone = await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, u.id), ne(schema.sessions.id, sid(c)!))).returning({ id: schema.sessions.id });
    return c.json({ ok: true, sessions_revoked: gone.length });
  });

  // ---------- Security: two-factor authentication ----------
  r.post("/auth/2fa/setup", async (c) => {
    const u = user(c);
    if (twoFactorOn(u)) return err(c, 409, "already_enabled", "Two-factor authentication is already on. Turn it off first to set up another device.");
    const b = await json(c) as { password?: string };
    const bad = await checkPassword(c, u, typeof b.password === "string" ? b.password : undefined);
    if (bad) return bad;
    const secret = newTotpSecret();
    await db.update(schema.users).set({ totpSecret: await sealTotp(deps, secret), totpEnabledAt: null, totpLastStep: null }).where(eq(schema.users.id, u.id));
    return c.json({ object: "two_factor_setup", secret, otpauth_url: otpauthUrl(secret, u.email), issuer: "RevenueDot", account: u.email, digits: 6, period: 30, algorithm: "SHA1" });
  });

  r.post("/auth/2fa/enable", async (c) => {
    const u = user(c);
    if (twoFactorOn(u)) return err(c, 409, "already_enabled", "Two-factor authentication is already on.");
    const b = parse(c, Code, await json(c));
    if (isResponse(b)) return b;
    const now = deps.now();
    if (!(await countCodeAttempt(db, u.id, now))) return err(c, 429, "rate_limit_error", "Too many code attempts. Try again in 15 minutes.");
    const secret = await unsealTotp(deps, u.totpSecret);
    if (!secret) return err(c, 409, "setup_required", "Start the setup again: there is no pending authenticator.");
    // Only an authenticator code proves the app was set up; recovery codes do not exist yet.
    const r2 = await checkSecondFactor(deps, u, { code: b.code }, now, secret);
    if (!r2.ok || r2.method !== "totp") return err(c, 400, "invalid_code", "That code is not right. Check that the time on your phone is set automatically, and try the newest code.");
    await forgiveCodeAttempt(db, u.id);
    await db.update(schema.users).set({ totpEnabledAt: now }).where(eq(schema.users.id, u.id));
    const codes = await replaceRecoveryCodes(db, u.id, now);
    const bs = base(c);
    defer(deps, () => trySend(deps.mailer, { to: u.email, ...twoFactorEmail({ base: bs, email: u.email, kind: "enabled" }) }));
    return c.json({ ok: true, enabled: true, recovery_codes: codes });
  });

  r.post("/auth/2fa/disable", async (c) => {
    const u = user(c);
    if (!twoFactorOn(u)) return err(c, 409, "not_enabled", "Two-factor authentication is off.");
    const b = parse(c, Code, await json(c));
    if (isResponse(b)) return b;
    const ok = await checkCode(c, u, b);
    if (isResponse(ok)) return ok;
    await db.update(schema.users).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null }).where(eq(schema.users.id, u.id));
    await db.delete(schema.twoFactorRecoveryCodes).where(eq(schema.twoFactorRecoveryCodes.userId, u.id));
    const bs = base(c);
    defer(deps, () => trySend(deps.mailer, { to: u.email, ...twoFactorEmail({ base: bs, email: u.email, kind: "disabled" }) }));
    return c.json({ ok: true, enabled: false });
  });

  r.post("/auth/2fa/recovery_codes", async (c) => {
    const u = user(c);
    if (!twoFactorOn(u)) return err(c, 409, "not_enabled", "Two-factor authentication is off.");
    const b = parse(c, Code, await json(c));
    if (isResponse(b)) return b;
    const ok = await checkCode(c, u, b);
    if (isResponse(ok)) return ok;
    const codes = await replaceRecoveryCodes(db, u.id, deps.now());
    const bs = base(c);
    defer(deps, () => trySend(deps.mailer, { to: u.email, ...twoFactorEmail({ base: bs, email: u.email, kind: "codes_regenerated" }) }));
    return c.json({ ok: true, recovery_codes: codes });
  });

  // ---------- Security: OAuth tokens ----------
  const accessOf = (permissions: string[]) => {
    const write = permissions.some((p) => p.endsWith(":read_write"));
    const money = permissions.some((p) => (OAUTH_SCOPES as Record<string, readonly string[]>)["project:support"]?.includes(p));
    return money ? "read_write_support" : write ? "read_write" : "read";
  };
  const clientUrl = (id: string | null, uris: string[] | null) => {
    if (id?.startsWith("https://")) return id;
    const first = uris?.[0];
    if (!first) return null;
    try { const u = new URL(first); return u.host ? `${u.protocol}//${u.host}` : `${u.protocol}//`; } catch { return null; }
  };
  r.get("/auth/oauth_tokens", async (c) => {
    const u = user(c);
    const K = schema.apiKeys;
    const rows = await db.select({ k: K, client: schema.oauthClients, project: { id: schema.projects.id, name: schema.projects.name } }).from(K)
      .leftJoin(schema.oauthClients, eq(schema.oauthClients.id, K.oauthClientId))
      .innerJoin(schema.projects, eq(schema.projects.id, K.projectId))
      .where(and(eq(K.createdByUserId, u.id), isNotNull(K.oauthClientId))).orderBy(desc(K.createdAt));
    return c.json({
      object: "list",
      items: rows.map(({ k, client, project }) => ({
        object: "oauth_token", id: k.id, client: { id: k.oauthClientId, name: client?.name ?? k.name.replace(/^OAuth: /, ""), url: clientUrl(k.oauthClientId, client?.redirectUris ?? null) },
        project, access: accessOf(k.permissions), key_prefix: k.prefix, created_at: k.createdAt.getTime(), last_used_at: k.lastUsedAt?.getTime() ?? null,
      })),
    });
  });

  r.delete("/auth/oauth_tokens/:id", async (c) => {
    const u = user(c);
    const K = schema.apiKeys;
    const [gone] = await db.delete(K).where(and(eq(K.id, c.req.param("id")), eq(K.createdByUserId, u.id), isNotNull(K.oauthClientId))).returning({ id: K.id, projectId: K.projectId, name: K.name });
    if (!gone) return err(c, 404, "resource_missing", "That token was already revoked.");
    // The project's audit log shows who revoked it, like a key revoked on the API keys page.
    await db.insert(schema.auditLogs).values({
      id: newId("log", 12), projectId: gone.projectId, actionType: "api_key_deleted", targetType: "api_key", targetIdentifier: gone.id,
      actorType: "user", actorIdentifier: u.id, additionalData: { method: "DELETE", status: 200, name: gone.name, via: "account_settings" }, occurredAt: deps.now(),
    });
    return c.json({ ok: true, id: gone.id });
  });

  // ---------- Billing: projects ----------
  r.get("/auth/account/projects", async (c) => {
    const u = user(c);
    const M = schema.memberships, P = schema.projects;
    const mine = await db.select({ id: P.id, name: P.name, owner: P.ownerUserId, role: M.role, createdAt: P.createdAt }).from(M).innerJoin(P, eq(P.id, M.projectId)).where(eq(M.userId, u.id));
    const ids = mine.map((p) => p.id);
    const counts = ids.length ? await db.select({ p: M.projectId, n: sql<number>`count(*)::int` }).from(M).where(inArray(M.projectId, ids)).groupBy(M.projectId) : [];
    const ownerIds = [...new Set(mine.map((p) => p.owner).filter((x): x is string => !!x))];
    const owners = ownerIds.length ? await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, ownerIds)) : [];
    const cloud = deps.edition === "cloud";
    const plans = plansFrom(deps.billing?.plansJson);
    const accts = cloud && ownerIds.length ? await db.select({ u: schema.billingAccounts.userId, plan: schema.billingAccounts.plan, status: schema.billingAccounts.status }).from(schema.billingAccounts).where(inArray(schema.billingAccounts.userId, ownerIds)) : [];
    const planName = (owner: string | null) => {
      if (!cloud) return { id: "self_hosted", name: "Self-hosted" };
      const a = accts.find((x) => x.u === owner);
      const id = accountPlanOf(a?.plan);
      if (id === "none") return { id: "none", name: "No plan" };
      const p = planOf(plans, id);
      return { id: p.id, name: p.name };
    };
    const items = mine.map((p) => {
      const o = owners.find((x) => x.id === p.owner);
      return {
        object: "account_project", id: p.id, name: p.name, role: p.role, is_owner: p.owner === u.id, members: Number(counts.find((x) => x.p === p.id)?.n ?? 1),
        owner: o ? { id: o.id, name: o.name, email: o.email } : null, plan: planName(p.owner), created_at: p.createdAt.getTime(),
      };
    }).sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || a.name.localeCompare(b.name));
    return c.json({ object: "list", edition: cloud ? "cloud" : "self-hosted", items });
  });

  // ---------- General: delete account ----------
  r.post("/auth/account/delete", async (c) => {
    const u = user(c);
    const b = parse(c, Delete, await json(c));
    if (isResponse(b)) return b;
    if (normEmail(b.email) !== u.email) return err(c, 400, "confirmation_mismatch", `Type your email address, ${u.email}, to confirm.`);
    const blocked = await deletionBlockers(u);
    if (blocked) return blocked(c);
    const bad = await checkPassword(c, u, b.password);
    if (bad) return bad;
    const second = await checkCode(c, u, { code: b.code, recovery_code: b.recovery_code });
    if (isResponse(second)) return second;
    const M = schema.memberships, P = schema.projects;
    const mine = await db.select({ id: P.id, name: P.name }).from(M).innerJoin(P, eq(P.id, M.projectId)).where(eq(M.userId, u.id));
    const solo: { id: string; name: string }[] = [];
    for (const p of mine) {
      const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(M).where(eq(M.projectId, p.id));
      if (Number(n) <= 1) solo.push(p);
    }
    const now = deps.now();
    await releaseVerifiedHostnames(deps, solo.map((p) => p.id));
    await db.transaction(async (tx) => {
      // OAuth keys this person handed to assistants stop working everywhere, then their own projects go.
      const keys = await tx.delete(schema.apiKeys).where(and(eq(schema.apiKeys.createdByUserId, u.id), isNotNull(schema.apiKeys.oauthClientId))).returning({ projectId: schema.apiKeys.projectId });
      if (solo.length) await tx.delete(P).where(inArray(P.id, solo.map((p) => p.id)));
      // The projects other people keep record who left and why, with the email: the user id in older entries no longer
      // names anyone once the account is gone.
      const left = mine.filter((p) => !solo.some((x) => x.id === p.id));
      if (left.length) {
        await tx.insert(schema.auditLogs).values(left.map((p) => ({
          id: newId("log", 12), projectId: p.id, actionType: "collaborator_account_deleted", targetType: "collaborator", targetIdentifier: u.id,
          actorType: "user", actorIdentifier: u.id, occurredAt: now,
          additionalData: { email: u.email, name: u.name, via: "account_settings", oauth_keys_revoked: keys.filter((k) => k.projectId === p.id).length },
        })));
      }
      // Memberships, sessions, links, codes, preferences, AI conversations and the billing account cascade.
      await tx.delete(schema.users).where(eq(schema.users.id, u.id));
    });
    const bs = base(c);
    defer(deps, () => trySend(deps.mailer, { to: u.email, ...accountDeletedEmail({ base: bs, email: u.email, projects: solo.map((p) => p.name) }) }));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true, deleted: true, projects_deleted: solo.map((p) => p.id) });
  });

  /** Why the account cannot be deleted yet, as a response maker, or null. */
  async function deletionBlockers(u: User): Promise<((c: Context) => Response) | null> {
    const M = schema.memberships, P = schema.projects;
    const mine = await db.select({ id: P.id, name: P.name, owner: P.ownerUserId, role: M.role }).from(M).innerJoin(P, eq(P.id, M.projectId)).where(eq(M.userId, u.id));
    const blocking: { id: string; name: string; reason: "owner" | "last_admin"; members: number }[] = [];
    for (const p of mine) {
      const people = await db.select({ u: M.userId, role: M.role }).from(M).where(eq(M.projectId, p.id));
      const others = people.filter((x) => x.u !== u.id);
      if (!others.length) continue;
      if (p.owner === u.id) blocking.push({ id: p.id, name: p.name, reason: "owner", members: people.length });
      else if (p.role === "admin" && !others.some((x) => x.role === "admin")) blocking.push({ id: p.id, name: p.name, reason: "last_admin", members: people.length });
    }
    if (blocking.length) {
      // What to do depends on why: an owned project needs a new owner, a project with no other admin needs one.
      const some = (n: number) => (n === 1 ? "a project" : `${n} projects`);
      const names = (r: string) => blocking.filter((p) => p.reason === r).map((p) => p.name).join(", ");
      const owned = blocking.filter((p) => p.reason === "owner").length, admin = blocking.length - owned;
      const parts = [
        ...(owned ? [`Transfer ownership first: you own ${some(owned)} that other people use (${names("owner")}). Transfer it in Project settings → General, or remove the other members.`] : []),
        ...(admin ? [`Make someone else an admin first: you are the only admin of ${some(admin)} that other people use (${names("last_admin")}). Change their role in Project settings → Collaborators.`] : []),
      ];
      return (c) => err(c, 409, "ownership_transfer_required", parts.join(" "), { projects: blocking });
    }
    if (deps.edition === "cloud") {
      const [acct] = await db.select().from(schema.billingAccounts).where(eq(schema.billingAccounts.userId, u.id)).limit(1);
      if (acct && accountPlanOf(acct.plan) === "pro" && ["active", "past_due"].includes(acct.status) && !acct.cancelAt) {
        return (c) => err(c, 409, "billing_active", "Cancel your Pro plan on the Billing page first, so you are not charged for a deleted account.");
      }
    }
    for (const x of deps.extensions ?? []) {
      const refusal = await x.beforeAccountDelete?.({ deps, userId: u.id });
      if (refusal) return (c) => err(c, 409, "extension_refused", refusal.message);
    }
    return null;
  }

  r.get("/auth/account/delete", async (c) => {
    // What the dialog needs before asking for confirmation: what blocks it and what would be deleted.
    const u = user(c);
    const blocked = await deletionBlockers(u);
    if (blocked) {
      const res = blocked(c);
      const body = await res.clone().json() as Record<string, unknown>;
      return c.json({ object: "account_deletion", allowed: false, ...body });
    }
    const M = schema.memberships, P = schema.projects;
    const mine = await db.select({ id: P.id, name: P.name }).from(M).innerJoin(P, eq(P.id, M.projectId)).where(eq(M.userId, u.id));
    const solo: { id: string; name: string }[] = [];
    for (const p of mine) {
      const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(M).where(eq(M.projectId, p.id));
      if (Number(n) <= 1) solo.push(p);
    }
    return c.json({ object: "account_deletion", allowed: true, projects_deleted: solo, projects_left: mine.filter((p) => !solo.some((s) => s.id === p.id)) });
  });

  // ---------- Notifications ----------
  r.get("/auth/notifications", async (c) => {
    const u = user(c);
    const M = schema.memberships, P = schema.projects, N = schema.notificationPrefs;
    const rows = await db.select({ id: P.id, name: P.name, role: M.role, pref: N }).from(M).innerJoin(P, eq(P.id, M.projectId))
      .leftJoin(N, and(eq(N.projectId, P.id), eq(N.userId, u.id))).where(eq(M.userId, u.id));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({
      object: "notification_settings", alert_emails: u.alertEmails, integration_alert_emails: u.integrationAlertEmails,
      projects: rows.map((r) => ({
        project: { id: r.id, name: r.name, role: r.role },
        weekly_summary: r.pref?.weeklySummary ?? false, experiment_results: r.pref?.experimentResults ?? false,
        anomaly_alerts: r.pref?.anomalyAlerts ?? false, anomaly_sensitivity: r.pref?.anomalySensitivity ?? "medium",
      })),
    });
  });

  r.put("/auth/notifications/:project_id", async (c) => {
    const u = user(c);
    const pid = c.req.param("project_id");
    const b = parse(c, Prefs, await json(c));
    if (isResponse(b)) return b;
    const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, u.id), eq(schema.memberships.projectId, pid))).limit(1);
    if (!m) return err(c, 404, "resource_missing", "Project not found.");
    const N = schema.notificationPrefs;
    const set = {
      ...(b.weekly_summary !== undefined ? { weeklySummary: b.weekly_summary } : {}), ...(b.experiment_results !== undefined ? { experimentResults: b.experiment_results } : {}),
      ...(b.anomaly_alerts !== undefined ? { anomalyAlerts: b.anomaly_alerts } : {}), ...(b.anomaly_sensitivity ? { anomalySensitivity: b.anomaly_sensitivity } : {}), updatedAt: deps.now(),
    };
    const [row] = await db.insert(N).values({ userId: u.id, projectId: pid, ...set }).onConflictDoUpdate({ target: [N.userId, N.projectId], set }).returning();
    return c.json({
      object: "project_notifications", project_id: pid, weekly_summary: row!.weeklySummary, experiment_results: row!.experimentResults,
      anomaly_alerts: row!.anomalyAlerts, anomaly_sensitivity: row!.anomalySensitivity,
    });
  });

  // ---------- Notifications: the one-click unsubscribe link of an email (RFC 8058), no session ----------
  const KIND_LABEL: Record<NotificationKind, string> = {
    weekly_summary: "weekly summaries", experiment_enough_data: "experiment results", experiment_ended: "experiment results", revenue_anomaly: "revenue anomaly alerts",
  };
  const unsubscribeOf = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
    const S = schema.notificationSends;
    const [row] = await db.select({ send: S, email: schema.users.email, project: schema.projects.name }).from(S)
      .innerJoin(schema.users, eq(schema.users.id, S.userId)).innerJoin(schema.projects, eq(schema.projects.id, S.projectId))
      .where(eq(S.tokenHash, await sha256Hex(token))).limit(1);
    return row && row.send.kind in UNSUBSCRIBE_COLUMN ? { ...row, kind: row.send.kind as NotificationKind } : null;
  };
  const NOT_FOUND = () => page("Link not found", "This unsubscribe link is not valid. Choose your emails in Account settings → Notifications.");
  // GET shows a button (mail scanners follow links, so a GET never unsubscribes); POST unsubscribes, also as one-click.
  r.get("/auth/notifications/unsubscribe/:token", async (c) => {
    const u = await unsubscribeOf(c.req.param("token"));
    if (!u) return c.html(NOT_FOUND(), 404);
    return c.html(page("Unsubscribe?", `Stop ${KIND_LABEL[u.kind]} for ${u.project} to ${u.email}.`, `<form method="post"><button type="submit">Unsubscribe</button></form>`));
  });
  r.post("/auth/notifications/unsubscribe/:token", async (c) => {
    const u = await unsubscribeOf(c.req.param("token"));
    if (!u) return c.html(NOT_FOUND(), 404);
    const N = schema.notificationPrefs;
    await db.update(N).set({ [UNSUBSCRIBE_COLUMN[u.kind]]: false, updatedAt: deps.now() }).where(and(eq(N.userId, u.send.userId), eq(N.projectId, u.send.projectId)));
    return c.html(page("You are unsubscribed", `${u.email} gets no more ${KIND_LABEL[u.kind]} for ${u.project}. Turn them back on in Account settings → Notifications.`));
  });

  // ---------- Onboarding and growth emails (prd/onboarding-emails/PRD.md): one-click unsubscribe and the welcome's path links ----------
  const JOURNEY_NOT_FOUND = () => page("Link not found", "This link is not valid. Choose your emails in Account settings → Notifications.");
  r.get("/auth/journeys/unsubscribe/:token", async (c) => {
    const u = await journeyTokenUser(db, c.req.param("token"));
    if (!u) return c.html(JOURNEY_NOT_FOUND(), 404);
    return c.html(page("Unsubscribe?", `Stop setup help, tips and product news to ${u.email}. Security, billing and alert emails still arrive.`, `<form method="post"><button type="submit">Unsubscribe</button></form>`));
  });
  r.post("/auth/journeys/unsubscribe/:token", async (c) => {
    const u = await journeyTokenUser(db, c.req.param("token"));
    if (!u) return c.html(JOURNEY_NOT_FOUND(), 404);
    await db.update(schema.users).set({ productEmails: false }).where(eq(schema.users.id, u.userId));
    return c.html(page("You are unsubscribed", `${u.email} gets no more setup help, tips or product news. Turn them back on in Account settings → Notifications.`));
  });
  // The welcome email's "Switching from RevenueCat?" link. GET shows a confirm button, so a mail scanner that opens the link
  // changes nothing; POST records the switching path (switchers get the switching emails instead of the new-app ones) and opens
  // the guide. Any other path, from older emails, just opens the quickstart.
  const utm = (path: string) => `utm_source=revenuedot&utm_medium=email&utm_campaign=journeys&utm_content=welcome_${path}`;
  r.get("/auth/journeys/path/:token", async (c) => {
    if (c.req.query("path") !== "revenuecat") return c.redirect(`https://revenuedot.app/docs/getting-started/quickstart?${utm("new")}`, 302);
    const u = await journeyTokenUser(db, c.req.param("token"));
    if (!u) return c.html(JOURNEY_NOT_FOUND(), 404);
    return c.html(page("Switching from RevenueCat?", `We'll send ${u.email} the switching steps instead of the new-app ones: import, a side-by-side run, then turning RevenueCat off.`,
      `<form method="post"><input type="hidden" name="path" value="revenuecat"><button type="submit">Yes, show me how to switch</button></form>`));
  });
  r.post("/auth/journeys/path/:token", async (c) => {
    const u = await journeyTokenUser(db, c.req.param("token"));
    if (!u) return c.html(JOURNEY_NOT_FOUND(), 404);
    await db.update(schema.users).set({ journeyPath: "revenuecat" }).where(eq(schema.users.id, u.userId));
    return c.redirect(`https://revenuedot.app/docs/migrate?${utm("revenuecat")}`, 302);
  });

  // One-click answers (a 0 to 10 rating, a reason for leaving Pro). GET shows the answer with a confirm button and a
  // comment box, so a mail scanner that opens the link records nothing; POST records it (the latest answer per kind wins).
  const FEEDBACK: Record<string, { title: string; ok: (v: string) => boolean; show: (v: string) => string }> = {
    nps: { title: "How likely are you to recommend RevenueDot?", ok: (v) => /^(10|[0-9])$/.test(v), show: (v) => `Your answer: ${v} out of 10.` },
    cancel: { title: "Why did you leave Pro?", ok: (v) => v.length > 0 && v.length <= 80, show: (v) => `Your answer: ${v}.` },
  };
  r.get("/auth/journeys/feedback/:token", async (c) => {
    const kind = c.req.query("kind") ?? "", value = (c.req.query("value") ?? "").trim();
    const f = FEEDBACK[kind];
    const u = await journeyTokenUser(db, c.req.param("token"));
    if (!u || !f || !f.ok(value)) return c.html(JOURNEY_NOT_FOUND(), 404);
    // The comment box asks what fits the answer: a quote from a fan, the first fix from a detractor.
    const n = kind === "nps" ? Number(value) : NaN;
    const ask = n >= 9 ? "Thank you. Could we quote you on our site? Write a sentence or two, and we'll ask before we use it."
      : n <= 6 ? "Thank you for being honest. What should we fix first?" : "Anything you'd like to add? (optional)";
    return c.html(page(f.title, f.show(value), `<form method="post"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="value" value="${value.replace(/[&<>"']/g, "")}">` +
      `<p><textarea name="comment" rows="4" maxlength="2000" placeholder="${ask.replace(/"/g, "&quot;")}" style="width:100%;font:inherit;padding:10px;border:1px solid #E5E5E5;box-sizing:border-box"></textarea></p><button type="submit">Send</button></form>`));
  });
  r.post("/auth/journeys/feedback/:token", async (c) => {
    const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const kind = String(body.kind ?? ""), value = String(body.value ?? "").trim(), comment = String(body.comment ?? "").trim().slice(0, 2000) || null;
    const f = FEEDBACK[kind];
    const u = await journeyTokenUser(db, c.req.param("token"));
    if (!u || !f || !f.ok(value)) return c.html(JOURNEY_NOT_FOUND(), 404);
    const F = schema.journeyFeedback;
    await db.insert(F).values({ userId: u.userId, kind, value, comment, createdAt: deps.now() }).onConflictDoUpdate({ target: [F.userId, F.kind], set: { value, comment, createdAt: deps.now() } });
    return c.html(page("Thank you", "Your answer reached the people who build RevenueDot. If you'd like to say more, reply to our email."));
  });

  // ---------- General: Stripe accounts (RevenueCat's account-level list; RevenueDot connects per app, prd/web-billing §8) ----------
  r.get("/auth/stripe_accounts", async (c) => {
    const u = user(c);
    const M = schema.memberships, P = schema.projects, A = schema.apps, S = schema.stripeConnections;
    const rows = await db.select({ app: A, project: { id: P.id, name: P.name }, role: M.role, conn: S }).from(M)
      .innerJoin(P, eq(P.id, M.projectId)).innerJoin(A, eq(A.projectId, P.id)).leftJoin(S, eq(S.appId, A.id))
      .where(and(eq(M.userId, u.id), eq(A.type, "stripe")));
    const a = connectAvailability(deps);
    const items = rows.filter((r) => stripeConnected(r.app)).map((r) => ({
      object: "stripe_account", app: { id: r.app.id, name: r.app.name }, project: r.project, role: r.role,
      account: storeSecretHintOf(r.app, "stripe_connect_account_id"), mode: r.app.credentials?.stripe_connect_mode === "test" ? "test" : "live",
      method: r.conn?.method ?? null, charges_enabled: r.conn?.chargesEnabled ?? null, details_submitted: r.conn?.detailsSubmitted ?? null,
      connected_at: r.conn?.connectedAt?.getTime() ?? null,
    })).sort((x, y) => x.project.name.localeCompare(y.project.name) || x.app.name.localeCompare(y.app.name));
    const stripeApps = rows.filter((r) => !stripeConnected(r.app) && (r.role === "admin" || r.role === "developer")).map((r) => ({ app: { id: r.app.id, name: r.app.name }, project: r.project }));
    return c.json({ object: "list", available: a.available, unavailable_reason: a.reason, items, connectable_apps: stripeApps });
  });

  // ---------- Date and region: exchange rate ----------
  r.get("/auth/fx", async (c) => {
    const u = user(c);
    const cur = (c.req.query("currency") ?? u.displayCurrency).toUpperCase();
    if (!DISPLAY_CURRENCIES.includes(cur)) return err(c, 400, "parameter_error", `currency must be one of ${DISPLAY_CURRENCIES.join(", ")}.`);
    if (cur === "USD") return c.json({ object: "fx_rate", base: "USD", currency: "USD", rate: 1, date: deps.now().toISOString().slice(0, 10), source: "identity" });
    // The cache first, then the source (the global fetch unless the server was given one), then the bundled rates.
    const f: FxFetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const ecb = await ratesOn(db, deps.now(), f, "ecb");
    let rate = ecb.rates[cur] && ecb.rates.USD ? ecb.rates[cur]! / ecb.rates.USD : null;
    let date = ecb.date, source = "ecb";
    if (!rate) { const usd = await ratesOn(db, deps.now(), f, "usd"); rate = usd.rates[cur] ?? null; date = usd.date; source = "currency-api"; }
    if (!rate) return err(c, 502, "server_error", "No exchange rate is available for that currency right now.");
    return c.json({ object: "fx_rate", base: "USD", currency: cur, rate: Math.round(rate * 1e6) / 1e6, date, source });
  });

  return r;
}
