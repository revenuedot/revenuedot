import { and, eq, notInArray, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { guardedFetch, OutboundRefused } from "../outbound.js";
import { mergeSecrets, unseal, type SecretKey } from "../secrets.js";
import { GOOGLE_TOKEN_URL } from "../google-sa.js";

/**
 * AdMob connection (prd/ads/PRD.md): OAuth 2.0 with a Google Cloud OAuth client, then the account's ad units are
 * loaded from the AdMob API (https://developers.google.com/admob/api/v1/reference/rest) for names and formats on the
 * Ads Overview. The connection is the project's `integrations` row of kind `admob`; the refresh token (and a project's
 * own client secret) are sealed like every integration secret. Every Google call goes through the outbound guard.
 *
 * The OAuth client: REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID / _SECRET on the server (RevenueDot Cloud), or the project's own
 * client id and secret saved on the AdMob page (any self-hosted server).
 */

export const ADMOB_SCOPE = "https://www.googleapis.com/auth/admob.readonly";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ADMOB_API = "https://admob.googleapis.com/v1";
const STATE_TTL_MS = 10 * 60_000;
const SYNC_EVERY_MS = 24 * 60 * 60_000;
const MAX_UNITS = 5000;

const I = schema.integrations;
type Row = typeof I.$inferSelect;

export interface AdMobDeps {
  db: DB;
  fetch: typeof fetch;
  now: () => Date;
  secretKey: SecretKey | null;
  googleOAuth?: { clientId?: string; clientSecret?: string };
}

export class AdMobError extends Error {
  constructor(message: string, public code: "not_configured" | "state" | "google" | "not_connected" = "google") { super(message); }
}

const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

export async function admobRow(db: DB, projectId: string): Promise<Row | null> {
  const [r] = await db.select().from(I).where(and(eq(I.projectId, projectId), eq(I.kind, "admob"))).limit(1);
  return r ?? null;
}

async function client(d: AdMobDeps, row: Row | null): Promise<{ id: string; secret: string }> {
  const own = row ? await unseal(row.secrets, d.secretKey).catch(() => ({} as Record<string, string>)) : {};
  const id = (row?.settings.client_id as string | undefined) || d.googleOAuth?.clientId;
  const secret = (row?.settings.client_id ? own.client_secret : undefined) || d.googleOAuth?.clientSecret;
  if (!id || !secret) throw new AdMobError("Connecting AdMob needs a Google OAuth client. Set REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID and REVENUEDOT_GOOGLE_OAUTH_CLIENT_SECRET on the server, or enter your own client ID and secret.", "not_configured");
  return { id, secret };
}

/** Whether a Google OAuth client is available (server-wide or the project's own). */
export async function admobConfigured(d: AdMobDeps, row: Row | null): Promise<"server" | "project" | null> {
  if (row?.settings.client_id) return "project";
  return d.googleOAuth?.clientId && d.googleOAuth.clientSecret ? "server" : null;
}

/**
 * Starts the OAuth flow: saves the project's own client (when given), stores the SHA-256 of a fresh state and of a
 * browser nonce with a 10-minute expiry, and returns Google's authorization URL and the nonce. The dashboard keeps the
 * nonce in the browser that started; Google's redirect hands the code back to that page, which finishes with the nonce
 * (`finishAdMobConnect`). So a sign-in link started in someone else's project cannot connect your AdMob account to it.
 */
export async function startAdMobConnect(d: AdMobDeps, o: { projectId: string; redirectUri: string; clientId?: string | null; clientSecret?: string | null }): Promise<{ url: string; nonce: string }> {
  let row: Row | null | undefined = await admobRow(d.db, o.projectId);
  const now = d.now();
  if (!row) {
    [row] = await d.db.insert(I).values({ id: newId("intg_", 14), projectId: o.projectId, kind: "admob", name: "Google AdMob", enabled: true, environment: "both", settings: {}, createdAt: now }).returning();
  }
  let settings = { ...row!.settings };
  let secrets = row!.secrets, hints = row!.secretHints;
  if (o.clientId !== undefined) {
    const update = await mergeSecrets(row!.secrets, { client_secret: o.clientId ? o.clientSecret ?? undefined : null }, d.secretKey);
    secrets = update.sealed; hints = update.hints;
    settings = { ...settings, client_id: o.clientId || null };
  }
  [row] = await d.db.update(I).set({ settings, secrets, secretHints: hints, updatedAt: now }).where(eq(I.id, row!.id)).returning();
  const c = await client(d, row!);
  const random = () => crypto.randomUUID().replace(/-/g, "");
  const state = `${o.projectId}.${random()}`;
  const nonce = `${random()}${random()}`;
  await d.db.update(I).set({ settings: { ...row!.settings, pending: { state: await sha256(state), nonce: await sha256(nonce), until: now.getTime() + STATE_TTL_MS, redirect_uri: o.redirectUri } } }).where(eq(I.id, row!.id));
  const u = new URL(GOOGLE_AUTH_URL);
  u.search = new URLSearchParams({ client_id: c.id, redirect_uri: o.redirectUri, response_type: "code", scope: ADMOB_SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
  return { url: u.toString(), nonce };
}

async function googleJson(d: AdMobDeps, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try { res = await guardedFetch(d.fetch, url, init); } catch (e) { throw new AdMobError(e instanceof OutboundRefused ? e.message : `Google could not be reached: ${e instanceof Error ? e.message : String(e)}`); }
  const text = await res.text().catch(() => "");
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  if (!res.ok) throw new AdMobError(`Google answered HTTP ${res.status}${j?.error_description ? `: ${j.error_description}` : j?.error?.message ? `: ${j.error.message}` : ""}.`);
  return j;
}

/**
 * Finishes the OAuth flow with the code Google sent back, from the browser that started it: the state must be this
 * project's pending one and the nonce the one `startAdMobConnect` gave that browser. Single use, whatever happens next.
 */
export async function finishAdMobConnect(d: AdMobDeps, o: { projectId: string; state: string; code: string; nonce: string }): Promise<void> {
  const projectId = o.projectId;
  const invalid = () => new AdMobError("This AdMob sign-in link is not valid. Start again from the AdMob page.", "state");
  if (o.state.split(".")[0] !== projectId) throw invalid();
  const row = await admobRow(d.db, projectId);
  const pending = row?.settings.pending as { state?: string; nonce?: string; until?: number; redirect_uri?: string } | undefined;
  const stateHash = await sha256(o.state);
  if (!row || !pending?.state || pending.state !== stateHash) throw invalid();
  // Consumed atomically: of two requests with the same state, one gets on.
  const consumed = await d.db.update(I).set({ settings: sql`${I.settings} - 'pending'` })
    .where(and(eq(I.id, row.id), sql`${I.settings}->'pending'->>'state' = ${stateHash}`)).returning({ id: I.id });
  if (!consumed.length) throw invalid();
  const { pending: _, ...rest } = row.settings as Record<string, unknown>;
  if (!pending.nonce || !o.nonce || pending.nonce !== await sha256(o.nonce)) throw new AdMobError("This AdMob sign-in was started in another browser. Start again from the AdMob page.", "state");
  if (!pending.until || pending.until < d.now().getTime()) throw new AdMobError("The AdMob sign-in took longer than 10 minutes. Start again from the AdMob page.", "state");
  const c = await client(d, row);
  const tok = await googleJson(d, GOOGLE_TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: o.code, client_id: c.id, client_secret: c.secret, redirect_uri: pending.redirect_uri ?? "", grant_type: "authorization_code" }).toString(),
  });
  if (typeof tok?.refresh_token !== "string") throw new AdMobError("Google returned no refresh token. Remove RevenueDot's access in your Google account and connect again.");
  const sealed = await mergeSecrets(row.secrets, { refresh_token: tok.refresh_token }, d.secretKey);
  await d.db.update(I).set({ secrets: sealed.sealed, secretHints: sealed.hints, settings: { ...rest, connected_at: d.now().getTime() }, enabled: true, updatedAt: d.now() }).where(eq(I.id, row.id));
  await syncAdMob(d, projectId).catch((e) => console.warn(`AdMob: loading ad units for ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`));
}

async function accessToken(d: AdMobDeps, row: Row): Promise<string> {
  const secrets = await unseal(row.secrets, d.secretKey);
  if (!secrets.refresh_token) throw new AdMobError("AdMob is not connected.", "not_connected");
  const c = await client(d, row);
  const tok = await googleJson(d, GOOGLE_TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: secrets.refresh_token, client_id: c.id, client_secret: c.secret, grant_type: "refresh_token" }).toString(),
  });
  if (typeof tok?.access_token !== "string") throw new AdMobError("Google returned no access token.");
  return tok.access_token;
}

/** Loads every ad unit of the connected AdMob account(s) into `ad_units`, replacing the previous list. Returns the count. */
export async function syncAdMob(d: AdMobDeps, projectId: string): Promise<number> {
  const row = await admobRow(d.db, projectId);
  if (!row) throw new AdMobError("AdMob is not connected.", "not_connected");
  const now = d.now();
  try {
    const token = await accessToken(d, row);
    const auth = { headers: { authorization: `Bearer ${token}`, accept: "application/json" } };
    const accounts = await googleJson(d, `${ADMOB_API}/accounts`, auth);
    const list = (accounts?.account ?? []) as { name: string; publisherId?: string; currencyCode?: string }[];
    const seen: string[] = [];
    for (const a of list) {
      if (!/^accounts\/pub-\d+$/.test(a.name)) continue;
      let pageToken = "";
      do {
        const page = await googleJson(d, `${ADMOB_API}/${a.name}/adUnits?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, auth);
        for (const u of (page?.adUnits ?? []) as { adUnitId?: string; appId?: string; displayName?: string; adFormat?: string }[]) {
          if (!u.adUnitId || seen.length >= MAX_UNITS) continue;
          seen.push(u.adUnitId);
          const values = { projectId, network: "admob", adUnitId: u.adUnitId, accountId: a.publisherId ?? a.name.slice(9), networkAppId: u.appId ?? null, displayName: u.displayName ?? u.adUnitId, format: u.adFormat?.toLowerCase() ?? null, updatedAt: now };
          await d.db.insert(schema.adUnits).values(values).onConflictDoUpdate({ target: [schema.adUnits.projectId, schema.adUnits.network, schema.adUnits.adUnitId], set: { displayName: values.displayName, format: values.format, networkAppId: values.networkAppId, accountId: values.accountId, updatedAt: now } });
        }
        pageToken = typeof page?.nextPageToken === "string" ? page.nextPageToken : "";
      } while (pageToken && seen.length < MAX_UNITS);
    }
    const A = schema.adUnits;
    await d.db.delete(A).where(and(eq(A.projectId, projectId), eq(A.network, "admob"), ...(seen.length ? [notInArray(A.adUnitId, seen)] : [])));
    await d.db.update(I).set({
      settings: { ...row.settings, accounts: list.map((a) => ({ id: a.publisherId ?? a.name.slice(9), currency: a.currencyCode ?? null })), last_sync_at: now.getTime(), last_sync_error: null, ad_unit_count: seen.length },
      consecutiveFailures: 0, lastError: null, lastDeliveredAt: now,
    }).where(eq(I.id, row.id));
    return seen.length;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await d.db.update(I).set({ settings: { ...row.settings, last_sync_at: now.getTime(), last_sync_error: message.slice(0, 500) }, lastError: message.slice(0, 500) }).where(eq(I.id, row.id));
    throw e;
  }
}

/** Removes the tokens and the loaded ad units. */
export async function disconnectAdMob(db: DB, projectId: string) {
  await db.delete(schema.adUnits).where(and(eq(schema.adUnits.projectId, projectId), eq(schema.adUnits.network, "admob")));
  await db.delete(I).where(and(eq(I.projectId, projectId), eq(I.kind, "admob")));
}

/** Daily refresh from the tick: connections whose last load is over a day old. */
export async function refreshDueAdMob(d: AdMobDeps, limit = 5): Promise<number> {
  const rows = await d.db.select().from(I).where(and(eq(I.kind, "admob"), eq(I.enabled, true)));
  const due = rows.filter((r) => r.secretHints.refresh_token && (Number(r.settings.last_sync_at ?? 0) < d.now().getTime() - SYNC_EVERY_MS)).slice(0, limit);
  let n = 0;
  for (const r of due) {
    try { await syncAdMob(d, r.projectId); n++; } catch (e) { console.warn(`AdMob refresh for ${r.projectId} failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return n;
}

export function admobShape(row: Row | null, configured: "server" | "project" | null, units: (typeof schema.adUnits.$inferSelect)[]) {
  const s = (row?.settings ?? {}) as Record<string, any>;
  return {
    object: "admob_connection" as const,
    connected: !!row?.secretHints.refresh_token,
    oauth_client: configured,
    client_id: s.client_id ?? null,
    client_secret: row?.secretHints.client_secret ? { configured: true, hint: row.secretHints.client_secret } : { configured: false, hint: null },
    connected_at: s.connected_at ?? null,
    accounts: s.accounts ?? [],
    last_sync_at: s.last_sync_at ?? null,
    last_sync_error: s.last_sync_error ?? null,
    ad_units: units.map((u) => ({ ad_unit_id: u.adUnitId, name: u.displayName, format: u.format, account_id: u.accountId, app_id: u.networkAppId, updated_at: u.updatedAt.getTime() })),
  };
}
