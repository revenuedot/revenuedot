import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { schema } from "@revenuedot/db";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Deps } from "../context.js";
import { SESSION_COOKIE, createSession, hashPassword, login, logout, projectsForUser, sessionUser, signup } from "../services/sessions.js";
import {
  checkToken, consumeToken, defer, linkBase, needsVerification, rememberOrigin, requestOrigin, retireTokens, sendPasswordReset, sendVerification,
} from "../services/account-email.js";
import { acceptInvite, inviteByToken, normEmail } from "../services/members.js";
import { clientIp, hit } from "../services/rate-limit.js";
import { stripeProblem } from "../services/billing/stripe.js";

const Password = z.string().min(8, "Use at least 8 characters for your password.").max(200, "Use at most 200 characters for your password.");
const Email = z.string().trim().toLowerCase().email("Enter a valid email address.");
const Signup = z.object({ email: Email, password: Password, name: z.string().max(100).optional(), project_name: z.string().max(100).optional(), invite_token: z.string().max(200).optional() });
const Login = z.object({ email: Email, password: z.string().min(1) });
const Forgot = z.object({ email: z.string().max(320) });
const Token = z.object({ token: z.string().min(1).max(200) });
const Reset = z.object({ token: z.string().min(1).max(200), password: Password });
const MeUpdate = z.object({ name: z.string().trim().max(100).nullable().optional(), alert_emails: z.boolean().optional(), insights_emails: z.boolean().optional() });

const MIN = 60_000;
/** Password reset: requests per IP per 15 minutes (429 beyond), and emails per address per hour (silently skipped beyond). */
export const RESET_LIMITS = { perIp: 5, ipWindowMs: 15 * MIN, perEmail: 3, emailWindowMs: 60 * MIN };
/** Verification resends per user per hour. */
export const RESEND_LIMIT = { perUser: 5, windowMs: 60 * MIN };
const FORGOT_ANSWER = { ok: true, message: "If an account uses this email, we sent it a link to reset the password. The link expires in 1 hour." };
const TOKEN_ERRORS = {
  invalid: "This link is not valid. Ask for a new one.",
  expired: "This link has expired. Ask for a new one.",
  used: "This link was already used. Ask for a new one if you still need it.",
} as const;

/** Dashboard sign-in, password reset, email verification and invites. The session cookie also authorizes /v2 for the user's projects. */
export function authRoutes(deps: Deps) {
  const r = new Hono();
  const cookieOpts = (secure: boolean) => ({ httpOnly: true, sameSite: "Lax" as const, secure, path: "/", maxAge: 30 * 86400 });
  const isHttps = (url: string) => url.startsWith("https:");
  const origin = (c: Context) => requestOrigin(c.req.url, (n) => c.req.header(n));
  const base = (c: Context) => linkBase(deps, origin(c));
  const startSession = async (c: Context, userId: string) => setCookie(c, SESSION_COOKIE, await createSession(deps.db, userId, deps.now()), cookieOpts(isHttps(c.req.url)));
  const json = async (c: Context) => c.req.json().catch(() => ({}));
  const bad = (c: Context, message: string) => c.json({ type: "invalid_request", message }, 400);
  const me = (c: Context) => sessionUser(deps.db, getCookie(c, SESSION_COOKIE), deps.now());
  const meExtras = async (c: Context, userId: string) => {
    const extra: Record<string, unknown> = {};
    for (const x of deps.extensions ?? []) Object.assign(extra, await x.me?.({ deps, userId, sessionId: getCookie(c, SESSION_COOKIE) ?? null }));
    return extra;
  };
  r.use("/auth/*", async (c, next) => { rememberOrigin(origin(c)); await next(); });

  // Self-hosted servers default to one owner account; the cloud edition takes sign-ups from anyone.
  const signupOpen = async () => {
    if (deps.edition === "cloud" || deps.signup !== "owner_only") return true;
    const [row] = await deps.db.select({ n: sql<number>`count(*)` }).from(schema.users);
    return Number(row?.n ?? 0) === 0;
  };

  // What the sign-in pages need before showing a form. No session required.
  // signed_in lets the sign-in pages skip their form without probing /auth/me, which answers 401 when signed out.
  r.get("/auth/config", async (c) => {
    const extra: Record<string, unknown> = {};
    for (const x of deps.extensions ?? []) Object.assign(extra, await x.config?.(deps));
    return c.json({ edition: deps.edition ?? "self-hosted", signup: (await signupOpen()) ? "open" : "closed", signed_in: !!(await me(c)), ...extra });
  });
  // Enterprise extensions may refuse password sign-in, sign-up and reset for an address (enforced single sign-on).
  const passwordRefusal = async (email: string) => {
    for (const x of deps.extensions ?? []) { const r = await x.passwordPolicy?.({ deps, email: normEmail(email) }); if (r) return r; }
    return null;
  };
  const ssoRequired = (c: Context, r: { message: string; sso_url?: string }) => c.json({ type: "sso_required", message: r.message, ...(r.sso_url ? { sso_url: r.sso_url } : {}) }, 403);

  r.post("/auth/signup", async (c) => {
    const p = Signup.safeParse(await json(c));
    // An invite lets its address create an account even where sign-up is closed.
    let invite = null;
    if (p.success && p.data.invite_token) {
      const found = await inviteByToken(deps.db, p.data.invite_token, deps.now());
      if (!found.ok) return c.json({ type: "invite_invalid", message: found.reason === "expired" ? "This invite has expired. Ask for a new one." : "This invite is no longer valid. Ask for a new one." }, 400);
      if (normEmail(p.data.email) !== found.invite.email) return c.json({ type: "invite_email_mismatch", message: `This invite is for ${found.invite.email}. Sign up with that address.` }, 400);
      invite = found.invite;
    }
    if (!invite && !(await signupOpen())) {
      return c.json({ type: "signup_closed", message: "Sign-up is closed on this server: it has an owner account already. The owner can open it by setting REVENUEDOT_ALLOW_SIGNUP=true, or invite you to a project." }, 403);
    }
    if (!p.success) return bad(c, p.error.issues[0]?.message ?? "Invalid request.");
    const refusal = await passwordRefusal(p.data.email);
    if (refusal) return ssoRequired(c, refusal);
    const now = deps.now();
    const res = await signup(deps.db, {
      email: p.data.email, password: p.data.password, name: p.data.name,
      // Invited people join the inviting project instead of getting an empty one.
      projectName: invite ? undefined : p.data.project_name?.trim() || "My project",
      // The invite link proved the inbox.
      emailVerifiedAt: invite ? now : null,
    });
    if ("error" in res) return c.json({ type: "conflict", message: invite ? "An account with this email already exists. Sign in to accept the invite." : res.error }, 409);
    if (invite) await acceptInvite(deps.db, invite, res.userId!, now);
    else if (deps.edition === "cloud") {
      const b = base(c);
      const user = { id: res.userId!, email: normEmail(p.data.email) };
      defer(deps, () => sendVerification(deps, user, b));
    }
    await startSession(c, res.userId!);
    return c.json({ ok: true, ...(invite ? { project_id: invite.projectId } : {}) }, 201);
  });

  r.post("/auth/login", async (c) => {
    const p = Login.safeParse(await json(c));
    if (!p.success) return c.json({ type: "invalid_request", message: "Enter your email and password." }, 400);
    const refusal = await passwordRefusal(p.data.email);
    if (refusal) return ssoRequired(c, refusal);
    const u = await login(deps.db, p.data.email, p.data.password);
    if (!u) return c.json({ type: "authentication_error", message: "Email or password is incorrect." }, 401);
    await startSession(c, u.id);
    return c.json({ ok: true });
  });

  r.post("/auth/logout", async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) await logout(deps.db, sid);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  r.get("/auth/me", async (c) => {
    const u = await me(c);
    if (!u) return c.json({ type: "authentication_error", message: "Not signed in." }, 401);
    return c.json({
      user: { id: u.id, email: u.email, name: u.name, email_verified: !!u.emailVerifiedAt, alert_emails: u.alertEmails, insights_emails: u.insightsEmails },
      // Cloud: the plan and billing status (prd/cloud-billing/PRD.md); self-hosted servers have no plan. `billing_ready`:
      // RevenueDot's Stripe is set up; until then the dashboard links no Billing page, as before billing existed.
      account: {
        edition: deps.edition ?? "self-hosted", plan: u.plan, billing_ready: deps.edition === "cloud" && !stripeProblem(deps.billing),
        billing_status: deps.edition === "cloud" ? (await deps.db.select({ s: schema.billingAccounts.status }).from(schema.billingAccounts).where(eq(schema.billingAccounts.userId, u.id)))[0]?.s ?? "none" : null, email_verification_required: needsVerification(deps, u),
        // Cloud-only features the dashboard shows (prd/attribution-benchmarks-insights): benchmarks and the weekly digest.
        features: { benchmarks: !!deps.benchmarks, insights_digest: !!deps.insightsDigest && !!deps.assistant },
      },
      projects: await projectsForUser(deps.db, u.id),
      ...(await meExtras(c, u.id)),
    });
  });

  // Account settings: display name and alert emails.
  r.post("/auth/me", async (c) => {
    const u = await me(c);
    if (!u) return c.json({ type: "authentication_error", message: "Not signed in." }, 401);
    const p = MeUpdate.safeParse(await json(c));
    if (!p.success) return bad(c, p.error.issues[0]?.message ?? "Invalid request.");
    const set: Partial<typeof schema.users.$inferInsert> = {};
    if (p.data.name !== undefined) set.name = p.data.name || null;
    if (p.data.alert_emails !== undefined) set.alertEmails = p.data.alert_emails;
    if (p.data.insights_emails !== undefined) set.insightsEmails = p.data.insights_emails;
    const [row] = Object.keys(set).length ? await deps.db.update(schema.users).set(set).where(eq(schema.users.id, u.id)).returning() : [u];
    return c.json({ user: { id: row!.id, email: row!.email, name: row!.name, email_verified: !!row!.emailVerifiedAt, alert_emails: row!.alertEmails, insights_emails: row!.insightsEmails } });
  });

  // Password reset, step 1. The same answer, after the same work, whether or not the account exists: the lookup and
  // the email happen after the response.
  r.post("/auth/password/forgot", async (c) => {
    const p = Forgot.safeParse(await json(c));
    const email = p.success ? normEmail(p.data.email) : "";
    if (!email || !z.string().email().safeParse(email).success) return bad(c, "Enter a valid email address.");
    const now = deps.now();
    if (!(await hit(deps.db, `pwreset:ip:${clientIp((n) => c.req.header(n), c.env)}`, RESET_LIMITS.perIp, RESET_LIMITS.ipWindowMs, now))) {
      return c.json({ type: "rate_limit_error", message: "Too many password reset requests. Try again in 15 minutes." }, 429);
    }
    const b = base(c);
    defer(deps, async () => {
      if (!(await hit(deps.db, `pwreset:email:${email}`, RESET_LIMITS.perEmail, RESET_LIMITS.emailWindowMs, now))) return;
      if (await passwordRefusal(email)) return;
      const [u] = await deps.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
      if (u) await sendPasswordReset(deps, u, b);
    });
    return c.json(FORGOT_ANSWER);
  });

  // Whether a reset link still works, so the page can say so before the user types a new password.
  r.post("/auth/password/check", async (c) => {
    const p = Token.safeParse(await json(c));
    if (!p.success) return bad(c, TOKEN_ERRORS.invalid);
    const t = await checkToken(deps.db, "password_reset", p.data.token, deps.now());
    return t.ok ? c.json({ valid: true, email: t.user.email }) : c.json({ valid: false, reason: t.reason, message: TOKEN_ERRORS[t.reason] });
  });

  // Password reset, step 2: new password, every session revoked, this browser signed in.
  r.post("/auth/password/reset", async (c) => {
    const p = Reset.safeParse(await json(c));
    if (!p.success) return bad(c, p.error.issues.find((i) => i.path[0] === "password")?.message ?? TOKEN_ERRORS.invalid);
    const now = deps.now();
    const t = await consumeToken(deps.db, "password_reset", p.data.token, now);
    if (!t.ok) return c.json({ type: "token_invalid", reason: t.reason, message: TOKEN_ERRORS[t.reason] }, 400);
    const refusal = await passwordRefusal(t.user.email);
    if (refusal) return ssoRequired(c, refusal);
    await deps.db.update(schema.users).set({ passwordHash: await hashPassword(p.data.password), emailVerifiedAt: t.user.emailVerifiedAt ?? now }).where(eq(schema.users.id, t.user.id));
    await deps.db.delete(schema.sessions).where(eq(schema.sessions.userId, t.user.id));
    await retireTokens(deps.db, "password_reset", t.user.id, now);
    await startSession(c, t.user.id);
    return c.json({ ok: true });
  });

  r.post("/auth/email/verify", async (c) => {
    const p = Token.safeParse(await json(c));
    if (!p.success) return bad(c, TOKEN_ERRORS.invalid);
    const now = deps.now();
    const t = await consumeToken(deps.db, "email_verify", p.data.token, now);
    if (!t.ok) return c.json({ type: "token_invalid", reason: t.reason, message: TOKEN_ERRORS[t.reason] }, 400);
    await deps.db.update(schema.users).set({ emailVerifiedAt: t.user.emailVerifiedAt ?? now }).where(eq(schema.users.id, t.user.id));
    return c.json({ ok: true, email: t.user.email });
  });

  r.post("/auth/email/verify/resend", async (c) => {
    const u = await me(c);
    if (!u) return c.json({ type: "authentication_error", message: "Not signed in." }, 401);
    if (u.emailVerifiedAt) return c.json({ ok: true, already_verified: true });
    if (!(await hit(deps.db, `verify:user:${u.id}`, RESEND_LIMIT.perUser, RESEND_LIMIT.windowMs, deps.now()))) {
      return c.json({ type: "rate_limit_error", message: "Too many emails sent. Try again in an hour." }, 429);
    }
    const sent = await sendVerification(deps, u, base(c));
    if (!sent) return c.json({ type: "server_error", message: "The email could not be sent. Try again in a few minutes." }, 502);
    return c.json({ ok: true, email: u.email });
  });

  // Invite page: who invited whom to what. Works without a session.
  r.get("/auth/invites/:token", async (c) => {
    const found = await inviteByToken(deps.db, c.req.param("token"), deps.now());
    if (!found.ok) return c.json({ type: "invite_invalid", reason: found.reason, message: found.reason === "expired" ? "This invite has expired. Ask the person who invited you for a new one." : found.reason === "accepted" ? "This invite was already accepted." : "This invite is no longer valid." }, 404);
    const [existing] = await deps.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, found.invite.email)).limit(1);
    return c.json({
      object: "invite", email: found.invite.email, role: found.invite.role, project: { id: found.project.id, name: found.project.name },
      invited_by: found.inviter ? { name: found.inviter.name, email: found.inviter.email } : null,
      expires_at: found.invite.expiresAt.getTime(), account_exists: !!existing,
    });
  });

  // An existing user accepts while signed in with the invited address.
  r.post("/auth/invites/:token/accept", async (c) => {
    const u = await me(c);
    if (!u) return c.json({ type: "authentication_error", message: "Sign in to accept the invite." }, 401);
    const now = deps.now();
    const found = await inviteByToken(deps.db, c.req.param("token"), now);
    if (!found.ok) return c.json({ type: "invite_invalid", reason: found.reason, message: "This invite is no longer valid." }, 404);
    if (found.invite.email !== u.email) return c.json({ type: "invite_email_mismatch", message: `This invite is for ${found.invite.email}, and you are signed in as ${u.email}. Sign in with the invited address.` }, 403);
    if (!(await acceptInvite(deps.db, found.invite, u.id, now))) return c.json({ type: "invite_invalid", message: "This invite is no longer valid." }, 404);
    // Following the invite link proved the inbox.
    if (!u.emailVerifiedAt) await deps.db.update(schema.users).set({ emailVerifiedAt: now }).where(eq(schema.users.id, u.id));
    return c.json({ ok: true, project_id: found.invite.projectId });
  });
  return r;
}
