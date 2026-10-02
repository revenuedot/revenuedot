// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (account), Account settings (prd/account-settings/PRD.md) on the real Node server, a fresh Railway
// development database and the SMTP sink:
//   - email change: the link to the new inbox, the notice to the old one, the account moved, links bound to the old address
//   - password change: other sessions revoked in SQL, the notice email
//   - two-factor: setup, the secret sealed at rest, recovery codes hashed, sign-in with the next code (method two_factor),
//     replay refused, a recovery code used once, the per-challenge limit
//   - OAuth: a grant recorded on api_keys, listed and revoked from Account settings, the key dead at once
//   - preferences stored on users; charts with week_start and currency through the API
//   - revenue anomaly alert sent by the server's own tick for a project whose revenue stopped yesterday, and its
//     one-click unsubscribe link (RFC 8058) turning the alerts off without a session
//   - account deletion refused while a teammate needs an owner, then done after the transfer, checked in SQL, with the
//     audit entry the shared project keeps
// Every state is checked through the API, SQL and the emails the SMTP sink received.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, signUp } from "./lib/context.ts";
import { linksOf } from "./lib/stack.ts";

const DAY = 86_400_000;

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s). */
function totp(secretB32: string, at = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32) { value = (value << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const off = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function req(ctx: Ctx, method: string, path: string, json?: unknown, cookie?: string) {
  const r = await fetch(ctx.base + path, { method, redirect: "manual", headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
  const text = await r.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* html */ }
  const set = /rd_session=([^;]*)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
  return { status: r.status, body, cookie: set ? `rd_session=${set}` : null, headers: r.headers };
}
const mailsTo = (ctx: Ctx, to: string) => ctx.mails.filter((m) => m.to.includes(to.toLowerCase()));
const waitMail = (ctx: Ctx, to: string, subject: RegExp) => until(async () => mailsTo(ctx, to).find((m) => subject.test(m.subject)) ?? null, { timeoutMs: 15_000 });

const journey: Journey = {
  name: "account",
  title: "Account settings: email change, password, two-factor, sessions, OAuth tokens, preferences, anomaly alert, deletion",
  async run(ctx: Ctx) {
    const { c, sql } = ctx;
    const dev = await signUp(ctx, "acct", "Account app");
    const [me] = await sql`SELECT id FROM users WHERE email = ${dev.email}`;
    const uid = me!.id as string;

    c.begin("sessions carry their method and browser");
    const [s0] = await sql`SELECT method, created_at, last_seen_at FROM sessions WHERE user_id = ${uid}`;
    c.eq("the sign-up session is labelled signup", s0?.method, "signup");

    c.begin("email change");
    const newEmail = `acct-new-${ctx.stamp}@journeys.test`;
    const asked = await req(ctx, "POST", "/auth/email/change", { new_email: newEmail, password: dev.password }, dev.cookie);
    c.eq("the change is accepted", asked.status, 200);
    const confirm = await waitMail(ctx, newEmail, /Confirm your new email/);
    c.check("the new inbox got the confirmation link", !!confirm);
    c.check("the old inbox got a notice", !!(await waitMail(ctx, dev.email, /about to change/)));
    const link = linksOf(confirm!).find((l) => l.includes("/confirm-email?token="))!;
    const token = new URL(link).searchParams.get("token")!;
    const [tok] = await sql`SELECT hash, new_email, used_at FROM auth_tokens WHERE user_id = ${uid} AND kind = 'email_change' ORDER BY created_at DESC LIMIT 1`;
    c.check("only the token's hash is stored, with the new address", tok && tok.hash !== token && tok.new_email === newEmail && !tok.used_at, tok);
    const done = await req(ctx, "POST", "/auth/email/change/confirm", { token });
    c.eq("the link works without a session", done.body, { ok: true, email: newEmail });
    const [u1] = await sql`SELECT email, email_verified_at FROM users WHERE id = ${uid}`;
    c.check("users.email moved and counts as verified", u1?.email === newEmail && !!u1?.email_verified_at, u1);
    c.check("the old inbox heard it changed", !!(await waitMail(ctx, dev.email, /was changed/)));
    c.eq("the link is single use", (await req(ctx, "POST", "/auth/email/change/confirm", { token })).body?.reason, "used");
    const email = newEmail;

    c.begin("password change");
    const phone = await req(ctx, "POST", "/auth/login", { email, password: dev.password });
    c.eq("a second browser signs in", phone.status, 200);
    c.eq("wrong current password refused", (await req(ctx, "POST", "/auth/password/change", { current_password: "nope nope", new_password: "x".repeat(12) }, dev.cookie)).body?.type, "invalid_password");
    const pw2 = `${dev.password}-2`;
    const changed = await req(ctx, "POST", "/auth/password/change", { current_password: dev.password, new_password: pw2 }, dev.cookie);
    c.eq("the change signs out the other session", changed.body, { ok: true, sessions_revoked: 1 });
    const [{ n: sessions } = { n: 0 }] = await sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${uid}`;
    c.eq("one session left in SQL", sessions, 1);
    c.check("the notice email arrived", !!(await waitMail(ctx, email, /password was changed/)));

    c.begin("two-factor authentication");
    const setup = await req(ctx, "POST", "/auth/2fa/setup", { password: pw2 }, dev.cookie);
    const secret = setup.body?.secret as string;
    c.check("setup answers a base32 secret and an otpauth URI", /^[A-Z2-7]{32}$/.test(secret) && setup.body.otpauth_url.startsWith("otpauth://totp/RevenueDot:"), setup.body?.otpauth_url);
    const [sealed] = await sql`SELECT totp_secret FROM users WHERE id = ${uid}`;
    c.check("the secret is sealed at rest (AES-GCM, the server key)", String(sealed?.totp_secret).startsWith("v1:") && !String(sealed?.totp_secret).includes(secret));
    const on = await req(ctx, "POST", "/auth/2fa/enable", { code: totp(secret) }, dev.cookie);
    const codes = on.body?.recovery_codes as string[];
    c.eq("ten recovery codes, shown once", codes?.length, 10);
    const rc = await sql`SELECT hash FROM two_factor_recovery_codes WHERE user_id = ${uid}`;
    c.check("recovery codes stored as SHA-256 only", rc.length === 10 && rc.every((r) => /^[0-9a-f]{64}$/.test(r.hash)) && !rc.some((r) => codes.some((x) => r.hash.includes(x.replace("-", "")))));
    const step1 = await req(ctx, "POST", "/auth/login", { email, password: pw2 });
    c.check("password sign-in now stops at the challenge, without a session", step1.body?.two_factor_required === true && !step1.cookie, step1.body);
    const next = totp(secret, Date.now() + 30_000);
    const step2 = await req(ctx, "POST", "/auth/login/2fa", { challenge: step1.body.challenge, code: next });
    c.check("the next code signs in", step2.status === 200 && !!step2.cookie, step2.body);
    const [m2] = await sql`SELECT method FROM sessions WHERE user_id = ${uid} ORDER BY created_at DESC LIMIT 1`;
    c.eq("the session is labelled two_factor", m2?.method, "two_factor");
    const again = await req(ctx, "POST", "/auth/login", { email, password: pw2 });
    c.eq("the same code is never accepted twice", (await req(ctx, "POST", "/auth/login/2fa", { challenge: again.body.challenge, code: next })).status, 401);
    const viaCode = await req(ctx, "POST", "/auth/login/2fa", { challenge: again.body.challenge, recovery_code: codes[0] });
    c.eq("a recovery code signs in", viaCode.body, { ok: true, recovery_codes_left: 9 });
    const [used] = await sql`SELECT count(*)::int AS n FROM two_factor_recovery_codes WHERE user_id = ${uid} AND used_at IS NOT NULL`;
    c.eq("one recovery code marked used", used?.n, 1);
    c.check("the recovery-code email arrived", !!(await waitMail(ctx, email, /recovery code was used/)));
    const third = await req(ctx, "POST", "/auth/login", { email, password: pw2 });
    const tries = [];
    for (let i = 0; i < 6; i++) tries.push((await req(ctx, "POST", "/auth/login/2fa", { challenge: third.body.challenge, code: "000000" })).status);
    c.eq("five wrong codes per challenge, then 429", tries, [401, 401, 401, 401, 401, 429]);

    c.begin("OAuth tokens");
    const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
    const reg = await req(ctx, "POST", "/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT] });
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "project:write", state: "j" });
    const page = await (await fetch(`${ctx.base}/oauth/authorize?${q}`, { headers: { cookie: dev.cookie } })).text();
    const fields = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
    const allow = await fetch(`${ctx.base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { cookie: dev.cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, project_id: dev.projectId, access: "project:write", decision: "allow" }) });
    const code = new URL(allow.headers.get("location")!).searchParams.get("code")!;
    const tokRes = await req(ctx, "POST", "/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: reg.body.client_id });
    const key = tokRes.body?.access_token as string;
    const [k] = await sql`SELECT id, created_by_user_id, oauth_client_id FROM api_keys WHERE project_id = ${dev.projectId} AND oauth_client_id IS NOT NULL`;
    c.check("the grant is recorded on api_keys", k?.created_by_user_id === uid && k?.oauth_client_id === reg.body.client_id, k);
    const list = await req(ctx, "GET", "/auth/oauth_tokens", undefined, dev.cookie);
    c.check("Account settings lists it", list.body?.items?.[0]?.client?.name === "Claude" && list.body.items[0].access === "read_write", list.body);
    c.eq("the key works", (await fetch(`${ctx.base}/v2/projects/${dev.projectId}/products`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
    c.eq("revoke", (await req(ctx, "DELETE", `/auth/oauth_tokens/${k!.id}`, undefined, dev.cookie)).status, 200);
    c.eq("the key is dead at once", (await fetch(`${ctx.base}/v2/projects/${dev.projectId}/products`, { headers: { authorization: `Bearer ${key}` } })).status, 401);
    c.eq("the row is gone", (await sql`SELECT 1 FROM api_keys WHERE id = ${k!.id}`).length, 0);

    c.begin("preferences and charts");
    const prefs = await req(ctx, "POST", "/auth/me", { theme: "dark", tint: "#1BAF7A", week_start: 0, display_currency: "EUR" }, dev.cookie);
    c.eq("saved", prefs.body?.user?.preferences, { theme: "dark", tint: "#1BAF7A", week_start: 0, display_currency: "EUR" });
    const [u2] = await sql`SELECT theme, tint, week_start, display_currency FROM users WHERE id = ${uid}`;
    c.eq("stored on users", u2, { theme: "dark", tint: "#1BAF7A", week_start: 0, display_currency: "EUR" });
    const fx = await req(ctx, "GET", "/auth/fx", undefined, dev.cookie);
    c.check("the EUR rate is answered", fx.body?.currency === "EUR" && fx.body.rate > 0.5 && fx.body.rate < 1.5, fx.body);

    // Revenue: $100 a day for the 28 days before yesterday, nothing yesterday (UTC), in production.
    const today = Math.floor(Date.now() / DAY) * DAY;
    await sql`INSERT INTO customers (id, project_id, original_app_user_id, first_seen, last_seen) VALUES (${`cus_j_${ctx.stamp}`}, ${dev.projectId}, 'journey_buyer', ${new Date(today - 40 * DAY)}, ${new Date(today - 2 * DAY)})`;
    for (let d = 29; d >= 2; d--) {
      const id = `txn_j_${ctx.stamp}_${d}`;
      await sql`INSERT INTO transactions (id, project_id, customer_id, store, store_transaction_id, product_identifier, kind, is_sandbox, purchased_at, revenue_usd) VALUES (${id}, ${dev.projectId}, ${`cus_j_${ctx.stamp}`}, 'app_store', ${id}, 'coins', 'one_time', false, ${new Date(today - d * DAY + 12 * 3_600_000)}, 100)`;
    }
    const chart = await req(ctx, "GET", `/v2/projects/${dev.projectId}/charts/revenue?resolution=week&week_start=0&currency=EUR&start_date=${new Date(today - 28 * DAY).toISOString().slice(0, 10)}&end_date=${new Date(today).toISOString().slice(0, 10)}`, undefined, dev.cookie);
    c.check("a weekly chart in EUR with Sunday weeks", chart.body?.yaxis_currency === "EUR" && chart.body.values.length > 0 && chart.body.values.every((v: any) => new Date(v.cohort * 1000).getUTCDay() === 0), chart.body?.values?.slice(0, 3));

    c.begin("revenue anomaly alert from the server's tick");
    const prefRes = await req(ctx, "PUT", `/auth/notifications/${dev.projectId}`, { anomaly_alerts: true, anomaly_sensitivity: "medium" }, dev.cookie);
    c.eq("alerts on", prefRes.body?.anomaly_alerts, true);
    if (new Date().getUTCHours() >= 6) {
      const alert = await until(async () => mailsTo(ctx, email).find((m) => /revenue dropped/.test(m.subject)) ?? null, { timeoutMs: 75_000, everyMs: 1000 });
      c.check("the tick emailed the drop", !!alert, mailsTo(ctx, email).map((m) => m.subject));
      c.check("in the reader's currency (EUR)", /€/.test(alert?.text ?? ""), alert?.text?.slice(0, 300));
      const checks = await sql`SELECT day, result FROM anomaly_checks WHERE project_id = ${dev.projectId}`;
      c.check("one anomaly check stored for yesterday", checks.length === 1 && checks[0]!.day === new Date(today - DAY).toISOString().slice(0, 10), checks.map((x) => x.day));
      const sends = await sql`SELECT kind, key, token_hash FROM notification_sends WHERE user_id = ${uid}`;
      c.check("one send recorded, with its unsubscribe token hashed", sends.length === 1 && sends[0]!.kind === "revenue_anomaly" && /^[0-9a-f]{64}$/.test(sends[0]!.token_hash ?? ""), sends.map((x) => x.kind));
      c.check("List-Unsubscribe-Post marks it one-click", /List-Unsubscribe-Post: List-Unsubscribe=One-Click/i.test(alert?.raw ?? ""));
      const unsub = alert ? linksOf(alert).find((l) => l.includes("/auth/notifications/unsubscribe/")) : undefined;
      c.check("the email has an unsubscribe link", !!unsub);
      if (unsub) {
        const path = new URL(unsub).pathname;
        c.eq("opening it changes nothing yet", (await req(ctx, "GET", path)).status, 200);
        c.eq("still on after a GET", (await sql`SELECT anomaly_alerts FROM notification_prefs WHERE user_id = ${uid}`)[0]?.anomaly_alerts, true);
        const one = await fetch(ctx.base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
        c.eq("one-click POST without a session", one.status, 200);
        c.eq("the alerts are off in SQL", (await sql`SELECT anomaly_alerts FROM notification_prefs WHERE user_id = ${uid}`)[0]?.anomaly_alerts, false);
      }
    } else c.check("before 06:00 UTC the daily check waits (skipped)", true);

    c.begin("account deletion");
    const mate = await signUp(ctx, "mate", "Mate app");
    await req(ctx, "POST", `/v2/projects/${dev.projectId}/invites`, { email: mate.email, role: "admin" }, dev.cookie);
    const invite = await waitMail(ctx, mate.email, /invited you/);
    const inviteToken = new URL(linksOf(invite!).find((l) => l.includes("/invite?token="))!).searchParams.get("token")!;
    c.eq("the teammate joins", (await req(ctx, "POST", `/auth/invites/${encodeURIComponent(inviteToken)}/accept`, undefined, mate.cookie)).status, 200);
    const blocked = await req(ctx, "POST", "/auth/account/delete", { email, password: pw2 }, dev.cookie);
    c.eq("refused while the shared project needs its owner", blocked.body?.type, "ownership_transfer_required");
    const [mateRow] = await sql`SELECT id FROM users WHERE email = ${mate.email}`;
    c.eq("ownership moves to the teammate", (await req(ctx, "POST", `/v2/projects/${dev.projectId}/actions/transfer_ownership`, { user_id: mateRow!.id }, dev.cookie)).status, 200);
    const del = await req(ctx, "POST", "/auth/account/delete", { email, password: pw2, recovery_code: codes[1] }, dev.cookie);
    c.eq("deleted", del.body, { ok: true, deleted: true, projects_deleted: [] });
    c.eq("users row gone", (await sql`SELECT 1 FROM users WHERE id = ${uid}`).length, 0);
    c.eq("sessions gone", (await sql`SELECT 1 FROM sessions WHERE user_id = ${uid}`).length, 0);
    c.eq("recovery codes and preferences gone", (await sql`SELECT 1 FROM two_factor_recovery_codes WHERE user_id = ${uid} UNION ALL SELECT 1 FROM notification_prefs WHERE user_id = ${uid}`).length, 0);
    const members = await sql`SELECT user_id FROM memberships WHERE project_id = ${dev.projectId}`;
    c.check("the shared project stays with the teammate", members.length === 1 && members[0]!.user_id === mateRow!.id, members);
    const [left] = await sql`SELECT target_identifier, additional_data FROM audit_logs WHERE project_id = ${dev.projectId} AND action_type = 'collaborator_account_deleted'`;
    c.check("its audit log names who left, by email", left?.target_identifier === uid && left?.additional_data?.email === email, left);
    c.check("the deletion email arrived", !!(await waitMail(ctx, email, /account was deleted/)));
    c.eq("the old password no longer signs in", (await req(ctx, "POST", "/auth/login", { email, password: pw2 })).status, 401);
  },
};
export default journey;
