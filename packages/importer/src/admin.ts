// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: `revenuedot admin reset-password <email>`, for self-hosted servers without email: it talks to the
// server's Postgres directly (DATABASE_URL), sets a new password and signs the user out everywhere.
// Docs: https://revenuedot.app/docs/guides/self-hosting#reset-a-password-without-email

/** Runs one parameterised SQL statement and returns its rows. */
export type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

// Must match apps/server/src/services/sessions.ts: PBKDF2-SHA256, 100,000 iterations, 16-byte salt, 32-byte hash.
const ITER = 100_000;
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

/** 20 characters from an alphabet without look-alikes (no 0/O, 1/l/I). */
export function generatePassword(length = 20): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const out: string[] = [];
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 256 - (256 % alphabet.length) && out.length < length) out.push(alphabet[b % alphabet.length]!);
    }
  }
  return out.join("");
}

export type ResetResult = { ok: true; email: string; sessionsRevoked: number } | { ok: false; error: string };

/** Sets the password of the account with this email and deletes all of its sessions. */
export async function resetPassword(q: Query, emailRaw: string, password: string): Promise<ResetResult> {
  const email = emailRaw.trim().toLowerCase();
  if (password.length < 8) return { ok: false, error: "The password needs at least 8 characters." };
  const users = await q("select id, email from users where email = $1", [email]);
  const user = users[0];
  if (!user) return { ok: false, error: `No account uses ${email}.` };
  await q("update users set password_hash = $1 where id = $2", [await hashPassword(password), user.id]);
  const gone = await q("delete from sessions where user_id = $1 returning id", [user.id]);
  // Open reset links stop working too.
  await q("update auth_tokens set used_at = now() where user_id = $1 and kind = 'password_reset' and used_at is null", [user.id]);
  return { ok: true, email, sessionsRevoked: gone.length };
}
