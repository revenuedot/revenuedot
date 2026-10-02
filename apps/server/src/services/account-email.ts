import { and, eq, gt, isNull } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { trySend } from "../mail/index.js";
import { passwordResetEmail, verifyEmail } from "../mail/templates.js";
import { sha256Hex } from "./auth.js";

/**
 * Password reset and email verification links (prd/account-email/PRD.md). A link carries 32 random bytes; the database
 * keeps only their SHA-256, the address it was sent to, an expiry and when it was used. Every link works once.
 */

export type TokenKind = "password_reset" | "email_verify";
export const TOKEN_TTL_MS: Record<TokenKind, number> = { password_reset: 3600_000, email_verify: 24 * 3600_000 };

export function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let lastOrigin: string | null = null;
/** Remembers the dashboard's origin from requests, for emails sent by the tick when REVENUEDOT_PUBLIC_URL is unset. */
export function rememberOrigin(origin: string) { lastOrigin = origin; }

/** Where links in emails point: REVENUEDOT_PUBLIC_URL, else the request's public origin, else the last one seen. */
export function linkBase(deps: Pick<Deps, "publicUrl">, requestOrigin?: string): string {
  return (deps.publicUrl ?? requestOrigin ?? lastOrigin ?? "http://localhost:8787").replace(/\/+$/, "");
}

/** Loopback hosts (`localhost:5615`, `127.0.0.1`, `[::1]`, `*.localhost`): local development, never behind TLS. */
const LOOPBACK = /^(localhost|[^:/]+\.localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;

/**
 * The origin the browser used, behind a proxy too (X-Forwarded-Host / -Proto, first value of each). A proxy that sends
 * X-Forwarded-Host without X-Forwarded-Proto is taken to terminate TLS (https), unless the host is a loopback one on a
 * plain-http request: local dev (`cf dev`) then keeps http instead of handing out https links that cannot load.
 */
export function requestOrigin(url: string, header: (n: string) => string | undefined): string {
  const host = header("x-forwarded-host")?.split(",")[0]!.trim();
  if (!host) return new URL(url).origin;
  const fwdProto = header("x-forwarded-proto")?.split(",")[0]!.trim().toLowerCase();
  const proto = fwdProto || (new URL(url).protocol === "http:" && LOOPBACK.test(host) ? "http" : "https");
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

export async function issueToken(db: DB, kind: TokenKind, user: { id: string; email: string }, now: Date): Promise<string> {
  const token = randomToken();
  await db.insert(schema.authTokens).values({ hash: await sha256Hex(token), kind, userId: user.id, email: user.email, expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[kind]), createdAt: now });
  return token;
}

export type TokenCheck = { ok: true; row: typeof schema.authTokens.$inferSelect; user: typeof schema.users.$inferSelect } | { ok: false; reason: "invalid" | "expired" | "used" };

/** Looks a link up without using it. The token must match the kind, be unused, unexpired, and still name the account's email. */
export async function checkToken(db: DB, kind: TokenKind, token: string, now: Date): Promise<TokenCheck> {
  if (!token || token.length > 200) return { ok: false, reason: "invalid" };
  const [row] = await db.select({ t: schema.authTokens, u: schema.users }).from(schema.authTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.authTokens.userId))
    .where(and(eq(schema.authTokens.hash, await sha256Hex(token)), eq(schema.authTokens.kind, kind))).limit(1);
  if (!row || row.t.email !== row.u.email) return { ok: false, reason: "invalid" };
  if (row.t.usedAt) return { ok: false, reason: "used" };
  if (row.t.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, row: row.t, user: row.u };
}

/** Uses a link: marks it used only if nobody used it first (two tabs racing get one success). */
export async function consumeToken(db: DB, kind: TokenKind, token: string, now: Date): Promise<TokenCheck> {
  const c = await checkToken(db, kind, token, now);
  if (!c.ok) return c;
  const used = await db.update(schema.authTokens).set({ usedAt: now })
    .where(and(eq(schema.authTokens.hash, c.row.hash), isNull(schema.authTokens.usedAt), gt(schema.authTokens.expiresAt, now))).returning({ hash: schema.authTokens.hash });
  if (!used.length) return { ok: false, reason: "used" };
  return c;
}

/** Every other open link of the same kind stops working (after a reset, or when a new verification link is sent). */
export async function retireTokens(db: DB, kind: TokenKind, userId: string, now: Date) {
  await db.update(schema.authTokens).set({ usedAt: now }).where(and(eq(schema.authTokens.userId, userId), eq(schema.authTokens.kind, kind), isNull(schema.authTokens.usedAt)));
}

export async function sendPasswordReset(deps: Deps, user: { id: string; email: string }, base: string) {
  const now = deps.now();
  const token = await issueToken(deps.db, "password_reset", user, now);
  const mail = passwordResetEmail({ base, url: `${base}/reset-password?token=${encodeURIComponent(token)}` });
  return trySend(deps.mailer, { to: user.email, ...mail });
}

export async function sendVerification(deps: Deps, user: { id: string; email: string }, base: string) {
  const now = deps.now();
  await retireTokens(deps.db, "email_verify", user.id, now);
  const token = await issueToken(deps.db, "email_verify", user, now);
  const mail = verifyEmail({ base, url: `${base}/verify-email?token=${encodeURIComponent(token)}` });
  return trySend(deps.mailer, { to: user.email, ...mail });
}

/** Cloud needs a verified email for secret API keys and invites; self-hosted servers trust every account. */
export const needsVerification = (deps: Pick<Deps, "edition">, user: { emailVerifiedAt: Date | null }) => deps.edition === "cloud" && !user.emailVerifiedAt;

/** Runs `task` after the response when the runtime allows it, else right away without waiting. Errors are logged. */
export function defer(deps: Pick<Deps, "defer">, task: () => Promise<unknown>) {
  const safe = () => task().catch((e) => console.error("[account-email] background task failed", e));
  if (deps.defer) deps.defer(safe);
  else void safe();
}
