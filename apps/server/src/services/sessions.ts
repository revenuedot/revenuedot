import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

const { users, sessions, memberships, projects } = schema;
// Cloudflare Workers caps WebCrypto PBKDF2 at 100,000 iterations, so the cloud and self-host builds both use that.
const ITER = 100_000;
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** PBKDF2-SHA256 (WebCrypto, so it runs on Node and Workers). Format: pbkdf2$<iter>$<salt>$<hash>. */
export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16)), iter = ITER): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2" || !iter || !salt || !hash) return false;
  let again: string;
  // Hashes made with more iterations than the runtime allows (older self-host builds used 210,000) fail on Workers.
  try { again = await hashPassword(password, unb64(salt), Number(iter)); } catch { return false; }
  const a = again.split("$")[3]!, b = hash;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const SESSION_COOKIE = "rd_session";
const SESSION_DAYS = 30;
/** `sessions.last_seen_at` is written at most this often per session. */
const SEEN_EVERY_MS = 5 * 60_000;

/**
 * How a session began (Account settings → Security lists it): password, two_factor, signup, reset, invite,
 * email_change, or sso (enterprise single sign-on, ee/server/sso). Unknown callers get "password".
 */
export type SessionMethod = "password" | "two_factor" | "signup" | "reset" | "invite" | "email_change" | "sso";
export interface SessionMeta { userAgent?: string | null; ip?: string | null; method?: SessionMethod }

export async function createSession(db: DB, userId: string, now: Date, meta: SessionMeta = {}) {
  const id = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[^a-zA-Z0-9]/g, "");
  await db.insert(sessions).values({
    id, userId, expiresAt: new Date(now.getTime() + SESSION_DAYS * 86400_000), createdAt: now, lastSeenAt: now,
    userAgent: meta.userAgent?.slice(0, 400) ?? null, ip: meta.ip && meta.ip !== "unknown" ? meta.ip.slice(0, 64) : null, method: meta.method ?? "password",
  });
  return id;
}

export async function sessionUser(db: DB, sessionId: string | undefined, now: Date) {
  if (!sessionId) return null;
  const [row] = await db.select({ u: users, seen: sessions.lastSeenAt }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now))).limit(1);
  if (!row) return null;
  // "Last active" in the sessions list, without a write on every request.
  if (!row.seen || now.getTime() - row.seen.getTime() >= SEEN_EVERY_MS) {
    await db.update(sessions).set({ lastSeenAt: now })
      .where(and(eq(sessions.id, sessionId), or(isNull(sessions.lastSeenAt), lt(sessions.lastSeenAt, new Date(now.getTime() - SEEN_EVERY_MS + 1000)))));
  }
  return row.u;
}

/** A session's id as the dashboard sees it: a hash, never the cookie value itself. */
export async function publicSessionId(sessionId: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`session:${sessionId}`));
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function projectsForUser(db: DB, userId: string) {
  return db.select({ id: projects.id, name: projects.name, role: memberships.role, createdAt: projects.createdAt })
    .from(memberships).innerJoin(projects, eq(projects.id, memberships.projectId)).where(eq(memberships.userId, userId));
}

export async function canAccess(db: DB, userId: string, projectId: string) {
  const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.projectId, projectId))).limit(1);
  return !!m;
}

/** Signup creates the user and, when given, their first project. */
export async function signup(db: DB, input: { email: string; password: string; name?: string; projectName?: string; emailVerifiedAt?: Date | null; timeZone?: string | null; referredBy?: string | null }) {
  const email = input.email.trim().toLowerCase();
  const [exists] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (exists) return { error: "An account with this email already exists." as const };
  const id = newId("usr_", 16);
  await db.insert(users).values({ id, email, name: input.name ?? null, passwordHash: await hashPassword(input.password), emailVerifiedAt: input.emailVerifiedAt ?? null, timeZone: input.timeZone ?? null, referredBy: input.referredBy ?? null });
  if (input.projectName) {
    const pid = newId("proj", 8);
    await db.insert(projects).values({ id: pid, name: input.projectName, ownerUserId: id });
    await db.insert(memberships).values({ userId: id, projectId: pid, role: "admin" });
  }
  return { userId: id };
}

export async function login(db: DB, emailRaw: string, password: string) {
  const [u] = await db.select().from(users).where(eq(users.email, emailRaw.trim().toLowerCase())).limit(1);
  if (!u?.passwordHash || !(await verifyPassword(password, u.passwordHash))) return null;
  return u;
}

export async function logout(db: DB, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
