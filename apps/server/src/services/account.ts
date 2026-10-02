import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { CURRENCIES } from "../routes/v2/charts.js";
import { issueToken } from "./account-email.js";
import { sha256Hex } from "./auth.js";
import { hit } from "./rate-limit.js";
import { depsSecretKey, seal, unseal } from "./secrets.js";
import { looksLikeRecoveryCode, newRecoveryCodes, normalizeRecoveryCode, verifyTotp } from "./totp.js";

/**
 * Account settings (prd/account-settings/PRD.md): preferences, two-factor checks and the sign-in challenge, shared by
 * routes/auth.ts and routes/account.ts.
 */

export type User = typeof schema.users.$inferSelect;
export const THEMES = ["system", "light", "dark"] as const;
export const DISPLAY_CURRENCIES = CURRENCIES;
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const preferencesOf = (u: User) => ({ theme: u.theme, tint: u.tint, week_start: u.weekStart, display_currency: u.displayCurrency });
export const twoFactorOn = (u: Pick<User, "totpEnabledAt" | "totpSecret">) => !!u.totpEnabledAt && !!u.totpSecret;

/** Rate limits (services/rate-limit.ts keys). */
export const LIMITS = {
  /** Code attempts per user (sign-in and settings together). */
  codesPerUser: { n: 10, ms: 15 * 60_000 },
  /** Attempts per sign-in challenge. */
  perChallenge: { n: 5, ms: 10 * 60_000 },
  /** Current-password checks per user (password change, two-factor setup, email change, deletion). */
  passwordChecks: { n: 10, ms: 15 * 60_000 },
  /** Email change requests per user. */
  emailChanges: { n: 5, ms: 60 * 60_000 },
};

async function sealedKey(deps: Pick<Deps, "encryptionKey" | "signingKey">) { return depsSecretKey(deps); }

/** Seals a TOTP secret for `users.totp_secret` (AES-256-GCM when the server has a key, services/secrets.ts). */
export async function sealTotp(deps: Pick<Deps, "encryptionKey" | "signingKey">, secretB32: string) {
  return (await seal({ totp: secretB32 }, await sealedKey(deps)))!;
}
export async function unsealTotp(deps: Pick<Deps, "encryptionKey" | "signingKey">, stored: string | null): Promise<string | null> {
  if (!stored) return null;
  try { return (await unseal(stored, await sealedKey(deps))).totp ?? null; } catch { return null; }
}

export type SecondFactor = { code?: string | null; recovery_code?: string | null };
export type FactorResult = { ok: true; method: "totp" | "recovery_code"; remaining?: number } | { ok: false; reason: "missing" | "invalid" };

/**
 * Checks a TOTP code or a recovery code for a user with two-factor on. A TOTP step is recorded so the same code never
 * works twice (an UPDATE that only succeeds for a later step, so two racing requests get one success); a recovery code
 * is marked used the same way.
 */
export async function checkSecondFactor(deps: Pick<Deps, "db" | "encryptionKey" | "signingKey">, u: User, f: SecondFactor, now: Date, secretOverride?: string): Promise<FactorResult> {
  const { db } = deps;
  const code = (f.code ?? "").trim();
  const rc = (f.recovery_code ?? "").trim();
  if (!code && !rc) return { ok: false, reason: "missing" };
  // A recovery code typed into the code field still works.
  if (rc || (!/^\d{6}$/.test(code.replace(/\s/g, "")) && looksLikeRecoveryCode(code))) {
    const hash = await sha256Hex(normalizeRecoveryCode(rc || code));
    const R = schema.twoFactorRecoveryCodes;
    const used = await db.update(R).set({ usedAt: now }).where(and(eq(R.userId, u.id), eq(R.hash, hash), isNull(R.usedAt))).returning({ h: R.hash });
    if (!used.length) return { ok: false, reason: "invalid" };
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(R).where(and(eq(R.userId, u.id), isNull(R.usedAt)));
    return { ok: true, method: "recovery_code", remaining: Number(n) };
  }
  const secret = secretOverride ?? (await unsealTotp(deps, u.totpSecret));
  if (!secret) return { ok: false, reason: "invalid" };
  const step = await verifyTotp(secret, code, now.getTime(), u.totpLastStep ?? null);
  if (step === null) return { ok: false, reason: "invalid" };
  const U = schema.users;
  const won = await db.update(U).set({ totpLastStep: step }).where(and(eq(U.id, u.id), or(isNull(U.totpLastStep), lt(U.totpLastStep, step)))).returning({ id: U.id });
  if (!won.length) return { ok: false, reason: "invalid" };
  return { ok: true, method: "totp" };
}

/** 10 new recovery codes; every earlier one stops working. The plaintext is returned once. */
export async function replaceRecoveryCodes(db: DB, userId: string, now: Date): Promise<string[]> {
  const codes = newRecoveryCodes();
  const R = schema.twoFactorRecoveryCodes;
  await db.delete(R).where(eq(R.userId, userId));
  await db.insert(R).values(await Promise.all(codes.map(async (c) => ({ userId, hash: await sha256Hex(normalizeRecoveryCode(c)), createdAt: now }))));
  return codes;
}

export async function recoveryCodesLeft(db: DB, userId: string) {
  const R = schema.twoFactorRecoveryCodes;
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(R).where(and(eq(R.userId, userId), isNull(R.usedAt)));
  return Number(n);
}

/**
 * One code attempt against the per-user limit (sign-in and settings together). It is counted before the code is checked,
 * so parallel guesses cannot slip past the limit; `forgiveCodeAttempt` takes a right code back off, so only wrong codes
 * add up to the pause.
 */
export const countCodeAttempt = (db: DB, userId: string, now: Date) => hit(db, `2fa:user:${userId}`, LIMITS.codesPerUser.n, LIMITS.codesPerUser.ms, now);
export async function forgiveCodeAttempt(db: DB, userId: string) {
  const t = schema.rateLimits;
  await db.update(t).set({ count: sql`greatest(${t.count} - 1, 0)` }).where(eq(t.key, `2fa:user:${userId}`));
}

/** A Postgres unique violation (23505), from postgres-js or PGlite. */
export function isUniqueViolation(e: unknown): boolean {
  const x = e as { code?: unknown; cause?: { code?: unknown } } | null;
  return x?.code === "23505" || x?.cause?.code === "23505";
}

/** The step between a correct password and a session: a single-use token (10 minutes) the browser sends with the code. */
export const issueChallenge = (db: DB, u: { id: string; email: string }, now: Date) => issueToken(db, "two_factor", u, now);

/** The open email change, if any: the newest unused, unexpired link for the account's current address. */
export async function pendingEmailChange(db: DB, u: { id: string; email: string }, now: Date) {
  const T = schema.authTokens;
  const [row] = await db.select({ to: T.newEmail, expiresAt: T.expiresAt }).from(T)
    .where(and(eq(T.userId, u.id), eq(T.kind, "email_change"), eq(T.email, u.email), isNull(T.usedAt), gt(T.expiresAt, now)))
    .orderBy(sql`${T.createdAt} desc`).limit(1);
  return row?.to ? { email: row.to, expires_at: row.expiresAt.getTime() } : null;
}

/** "Chrome on macOS" from a user agent: enough to recognise a session, never used for decisions. */
export function describeAgent(ua: string | null | undefined): { browser: string; os: string } {
  const s = ua ?? "";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox" : /Chrome\/|CriOS\//.test(s) ? "Chrome"
    : /Safari\//.test(s) && /Version\//.test(s) ? "Safari" : /^curl\//.test(s) ? "curl" : /node|undici/i.test(s) ? "Script" : s ? "Browser" : "Unknown";
  const os = /iPad/.test(s) ? "iPadOS" : /iPhone|iPod/.test(s) ? "iOS" : /Android/.test(s) ? "Android" : /CrOS/.test(s) ? "ChromeOS" : /Mac OS X|Macintosh/.test(s) ? "macOS"
    : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : "";
  return { browser, os };
}

/** Validates a preferences patch from POST /auth/me; returns the columns to set or an error message. */
export function preferencesPatch(b: Record<string, unknown>): { set: Partial<typeof schema.users.$inferInsert> } | { error: string } {
  const set: Partial<typeof schema.users.$inferInsert> = {};
  if (b.theme !== undefined) {
    if (!THEMES.includes(b.theme as never)) return { error: "theme must be system, light or dark." };
    set.theme = b.theme as string;
  }
  if (b.tint !== undefined) {
    if (b.tint !== null && (typeof b.tint !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.tint))) return { error: "tint must be a colour such as #2A78D6, or null for the default." };
    set.tint = b.tint === null ? null : (b.tint as string).toUpperCase();
  }
  if (b.week_start !== undefined) {
    if (!Number.isInteger(b.week_start) || (b.week_start as number) < 0 || (b.week_start as number) > 6) return { error: "week_start must be 0 (Sunday) to 6 (Saturday)." };
    set.weekStart = b.week_start as number;
  }
  if (b.display_currency !== undefined) {
    const cur = typeof b.display_currency === "string" ? b.display_currency.toUpperCase() : "";
    if (!DISPLAY_CURRENCIES.includes(cur)) return { error: `display_currency must be one of ${DISPLAY_CURRENCIES.join(", ")}.` };
    set.displayCurrency = cur;
  }
  return { set };
}
