import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { AppRecord, Deps } from "../context.js";
import { guardedFetch, OutboundRefused } from "./outbound.js";
import { depsSecretKey } from "./secrets.js";
import { sealStoreSecrets, storeSecretHintOf, storeSecretSet, stripeConnected, withStoreSecrets } from "./store-secrets.js";
import { connectMissing, connectModes, platformKeyFor, type StripeConnectConfig } from "./stripe-connect-config.js";
import { StripeApiError, StripeClient } from "../stores/stripe/api.js";
import { stripeClientFor } from "../stores/stripe/index.js";

/**
 * "Connect with Stripe" (prd/web-billing/PRD.md §8): a developer links their own Stripe account (a Standard connected account)
 * to RevenueDot's Connect platform through OAuth, or creates one through Account Links. The account id is sealed in
 * `apps.secrets`; every Stripe call for the app then uses the platform key with `Stripe-Account` (services/store-secrets.ts).
 * No application fee is taken.
 */

export const CONNECT_HOST = "https://connect.stripe.com";
const STATE_TTL_MS = 10 * 60_000;
export type ConnectMode = "live" | "test";
export type ConnectMethod = "oauth" | "account_link";
type Row = typeof schema.stripeConnections.$inferSelect;

export class ConnectError extends Error {
  constructor(message: string, public code: "unavailable" | "state" | "stripe" | "not_connected" | "invalid" = "stripe", public status = 422) { super(message); }
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const random = () => crypto.randomUUID().replace(/-/g, "");

/** Whether Connect can be used on this server, and if not, the sentence the dashboard shows. */
export function connectAvailability(deps: Pick<Deps, "stripeConnect" | "edition">) {
  const missing = connectMissing(deps.stripeConnect);
  const modes = connectModes(deps.stripeConnect);
  const available = !missing.length && modes.length > 0;
  const reason = available ? null : deps.edition === "cloud"
    ? "Connect with Stripe is not available on RevenueDot Cloud yet. Paste a restricted key from your Stripe account instead."
    : `Connect with Stripe is not set up on this server. Its operator needs a Stripe Connect platform and ${missing.join(", ")}. Paste a restricted key from your Stripe account instead.`;
  return { available, reason, modes, missing };
}

async function connectionOf(db: DB, appId: string): Promise<Row | null> {
  const [row] = await db.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.appId, appId)).limit(1);
  return row ?? null;
}

/** What the dashboard shows about an app's connection. */
export async function connectShape(deps: Deps, app: AppRecord, origin: string) {
  const row = await connectionOf(deps.db, app.id);
  const a = connectAvailability(deps);
  const connected = stripeConnected(app);
  const status = connected ? "connected" : row?.status === "disconnected" ? "disconnected" : "not_connected";
  return {
    object: "stripe_connect" as const, app_id: app.id, available: a.available, unavailable_reason: a.reason, modes: a.modes,
    status, method: connected ? row?.method ?? null : null, mode: connected ? (app.credentials?.stripe_connect_mode === "test" ? "test" : "live") : null,
    account: connected ? storeSecretHintOf(app, "stripe_connect_account_id") : null,
    charges_enabled: connected ? row?.chargesEnabled ?? null : null, details_submitted: connected ? row?.detailsSubmitted ?? null : null,
    connected_at: connected && row?.connectedAt ? row.connectedAt.getTime() : null,
    disconnected_at: !connected && row?.disconnectedAt ? row.disconnectedAt.getTime() : null,
    disconnect_reason: !connected ? row?.disconnectReason ?? null : null,
    restricted_key_configured: storeSecretSet(app, "stripe_secret_key"),
    webhook_url: `${origin}/v1/notifications/stripe-connect`,
    application_fee: null,
  };
}

/** A form POST to connect.stripe.com with the platform's secret key (OAuth token exchange and deauthorization). */
async function connectPost(deps: Deps, path: string, form: Record<string, string>, key: string): Promise<any> {
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  let res: Response;
  try {
    res = await guardedFetch(deps.fetch ?? client.fetchImpl, `${CONNECT_HOST}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(client.timeoutMs),
    });
  } catch (e) {
    throw new StripeApiError("transient", e instanceof OutboundRefused ? `The Stripe request was refused: ${e.message}` : "Stripe could not be reached");
  }
  const text = await res.text().catch(() => "");
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.ok && body) return body;
  const message = typeof body?.error_description === "string" ? body.error_description : typeof body?.error?.message === "string" ? body.error.message : `Stripe answered ${res.status}`;
  const code = typeof body?.error === "string" ? body.error : body?.error?.code;
  throw new StripeApiError(res.status >= 500 ? "transient" : res.status === 401 ? "credentials" : "invalid", message, res.status, code);
}

/** The platform acting for itself (no Stripe-Account): creating accounts and account links, reading an account. */
const platformApp = (key: string) => ({ credentials: { stripe_secret_key: key } as Record<string, unknown> });
const platformClient = (deps: Deps): StripeClient => stripeClientFor(deps.stores, deps.fetch).client;

function requireAvailable(deps: Deps, mode: ConnectMode) {
  const a = connectAvailability(deps);
  if (!a.available) throw new ConnectError(a.reason!, "unavailable");
  const key = platformKeyFor(deps.stripeConnect, mode);
  if (!key) throw new ConnectError(`This server cannot connect in ${mode} mode. Choose ${a.modes.join(" or ")} mode.`, "invalid", 400);
  return { cfg: deps.stripeConnect as StripeConnectConfig, key };
}

/** The key the OAuth client id belongs to (the token exchange and deauthorization use it). */
const oauthKey = (cfg: StripeConnectConfig) => (cfg.secretKey ?? cfg.testSecretKey)!;

async function upsertConnection(db: DB, app: AppRecord, set: Partial<typeof schema.stripeConnections.$inferInsert>, now: Date) {
  await db.insert(schema.stripeConnections).values({ appId: app.id, projectId: app.projectId, ...set, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.stripeConnections.appId, set: { ...set, updatedAt: now } });
}

/** Reads the account's status (charges enabled, details submitted) with the platform key of the connection's mode. */
async function accountStatus(deps: Deps, key: string, account: string) {
  try {
    const a = await platformClient(deps).get<{ id: string; charges_enabled?: boolean; details_submitted?: boolean; email?: string | null }>(platformApp(key), `/v1/accounts/${encodeURIComponent(account)}`);
    return { chargesEnabled: a.charges_enabled ?? null, detailsSubmitted: a.details_submitted ?? null };
  } catch (e) {
    console.warn(`Stripe Connect: reading account status failed: ${e instanceof Error ? e.message : String(e)}`);
    return { chargesEnabled: null, detailsSubmitted: null };
  }
}

/** Seals the connected account id into the app (dropping a restricted key and webhook secret) and records the connection. */
async function saveConnection(deps: Deps, app: AppRecord, o: { account: string; mode: ConnectMode; method: ConnectMethod; userId?: string | null; status: { chargesEnabled: boolean | null; detailsSubmitted: boolean | null } }) {
  const now = deps.now();
  const sealed = await sealStoreSecrets(app, { stripe_connect_account_id: o.account, stripe_secret_key: null, stripe_webhook_secret: null }, await depsSecretKey(deps));
  const credentials = { ...sealed.credentials, stripe_connect_mode: o.mode };
  await deps.db.update(schema.apps).set({
    secrets: sealed.secrets, secretHints: sealed.secretHints, credentials, credentialsStatus: "ok", credentialsError: null, credentialsCheckedAt: now,
  }).where(eq(schema.apps.id, app.id));
  await upsertConnection(deps.db, app, {
    status: "connected", method: o.method, mode: o.mode, accountHash: await sha256(o.account), chargesEnabled: o.status.chargesEnabled, detailsSubmitted: o.status.detailsSubmitted,
    connectedAt: now, connectedBy: o.userId ?? null, disconnectedAt: null, disconnectReason: null,
  }, now);
}

/**
 * Starts a connection. OAuth: Stripe's authorize URL. Account Links: creates a Standard account (or reuses the app's own
 * unfinished one) and answers its onboarding link. Either way a fresh state and browser nonce are stored hashed for 10 minutes;
 * the dashboard keeps the nonce and posts it to `finishConnect` from the callback page.
 */
export async function startConnect(deps: Deps, app: AppRecord, o: { method: ConnectMethod; mode: ConnectMode; redirectUri: string; email?: string | null; userId?: string | null }) {
  if (app.type !== "stripe") throw new ConnectError("Only Stripe apps can connect with Stripe.", "invalid", 400);
  const { cfg, key } = requireAvailable(deps, o.mode);
  const now = deps.now();
  const state = `${app.projectId}.${app.id}.${random()}`;
  const nonce = `${random()}${random()}`;
  const pending = { pendingStateHash: await sha256(state), pendingNonceHash: await sha256(nonce), pendingUntil: new Date(now.getTime() + STATE_TTL_MS), pendingMode: o.mode, redirectUri: o.redirectUri };
  if (o.method === "oauth") {
    if (stripeConnected(app)) throw new ConnectError("This app is already connected. Disconnect it first to connect another Stripe account.", "invalid", 409);
    await upsertConnection(deps.db, app, { ...pending, method: "oauth" }, now);
    const u = new URL(`${CONNECT_HOST}/oauth/authorize`);
    u.search = new URLSearchParams({ response_type: "code", client_id: cfg.clientId!, scope: "read_write", state, redirect_uri: o.redirectUri, stripe_landing: "login" }).toString();
    return { url: u.toString(), nonce, state };
  }
  // Account Links: an account created through the platform, onboarded on Stripe's pages.
  const row = await connectionOf(deps.db, app.id);
  const client = platformClient(deps);
  let account: string | null = null;
  if (stripeConnected(app)) {
    if (row?.method !== "account_link") throw new ConnectError("This app is already connected. Disconnect it first to create a new Stripe account.", "invalid", 409);
    const opened = await withStoreSecrets(deps, app);
    account = typeof opened.credentials?.stripe_account_id === "string" ? opened.credentials.stripe_account_id : null;
  }
  try {
    if (!account) {
      const email = o.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email) ? o.email : undefined;
      const created = await client.post<{ id: string }>(platformApp(key), "/v1/accounts", { type: "standard", email, metadata: { revenuedot_project: app.projectId, revenuedot_app: app.id } }, `rd-connect-account-${pending.pendingStateHash}`);
      account = created.id;
      await saveConnection(deps, app, { account, mode: o.mode, method: "account_link", userId: o.userId, status: { chargesEnabled: false, detailsSubmitted: false } });
    }
    const back = new URL(o.redirectUri);
    back.searchParams.set("state", state);
    const refresh = new URL(back);
    refresh.searchParams.set("refresh", "1");
    const link = await client.post<{ url: string }>(platformApp(key), "/v1/account_links", { account, type: "account_onboarding", return_url: back.toString(), refresh_url: refresh.toString() });
    await upsertConnection(deps.db, app, { ...pending }, now);
    return { url: link.url, nonce, state };
  } catch (e) {
    if (e instanceof StripeApiError) throw new ConnectError(`Stripe refused to create the account: ${e.message}`, "stripe", e.kind === "transient" ? 503 : 422);
    throw e;
  }
}

/**
 * Finishes a connection from the callback page in the browser that started it: the state must be this app's pending one and
 * not expired, and the nonce the one `startConnect` gave that browser. Single use. OAuth exchanges the code for the account
 * id; an Account Links return reads the account's status again.
 */
export async function finishConnect(deps: Deps, app: AppRecord, o: { state: string; nonce: string; code?: string | null; userId?: string | null }) {
  const invalid = () => new ConnectError("This Stripe sign-in link is not valid. Start again from the app's page.", "state", 400);
  const [projectId, appId] = o.state.split(".");
  if (projectId !== app.projectId || appId !== app.id) throw invalid();
  const row = await connectionOf(deps.db, app.id);
  const stateHash = await sha256(o.state);
  if (!row?.pendingStateHash || row.pendingStateHash !== stateHash) throw invalid();
  // Consumed atomically: of two requests with the same state, one gets on.
  const consumed = await deps.db.update(schema.stripeConnections).set({ pendingStateHash: null, pendingNonceHash: null, pendingUntil: null, updatedAt: deps.now() })
    .where(and(eq(schema.stripeConnections.appId, app.id), eq(schema.stripeConnections.pendingStateHash, stateHash))).returning({ appId: schema.stripeConnections.appId });
  if (!consumed.length) throw invalid();
  if (!row.pendingNonceHash || !o.nonce || row.pendingNonceHash !== await sha256(o.nonce)) throw new ConnectError("This Stripe sign-in was started in another browser. Start again from the app's page.", "state", 400);
  if (!row.pendingUntil || row.pendingUntil < deps.now()) throw new ConnectError("Connecting took longer than 10 minutes. Start again from the app's page.", "state", 400);
  const mode: ConnectMode = row.pendingMode === "test" ? "test" : "live";
  const { cfg, key } = requireAvailable(deps, mode);

  if (row.method === "account_link") {
    const opened = await withStoreSecrets(deps, app);
    const account = typeof opened.credentials?.stripe_account_id === "string" && opened.credentials.stripe_connected ? opened.credentials.stripe_account_id : null;
    if (!account) throw new ConnectError("The Stripe account was disconnected. Start again from the app's page.", "not_connected");
    const st = await accountStatus(deps, key, account);
    await upsertConnection(deps.db, app, { chargesEnabled: st.chargesEnabled, detailsSubmitted: st.detailsSubmitted }, deps.now());
    return;
  }
  if (!o.code) throw invalid();
  if (stripeConnected(app)) throw new ConnectError("This app is already connected.", "invalid", 409);
  let tok: { stripe_user_id?: string; livemode?: boolean; scope?: string };
  try {
    tok = await connectPost(deps, "/oauth/token", { grant_type: "authorization_code", code: o.code }, oauthKey(cfg));
  } catch (e) {
    if (e instanceof StripeApiError) throw new ConnectError(e.kind === "transient" ? "Stripe could not be reached. Try connecting again in a minute." : `Stripe did not accept the sign-in: ${e.message}`, "stripe", e.kind === "transient" ? 503 : 422);
    throw e;
  }
  const account = tok.stripe_user_id;
  if (typeof account !== "string" || !/^acct_[A-Za-z0-9]+$/.test(account)) throw new ConnectError("Stripe returned no account id.", "stripe");
  const status = await accountStatus(deps, key, account);
  await saveConnection(deps, app, { account, mode, method: "oauth", userId: o.userId, status });
}

/** Removes the connection: the sealed account id goes and the row says why. Clears the per-app status for "Check credentials". */
async function dropConnection(db: DB, app: AppRecord, reason: string, now: Date, deps: { encryptionKey?: string; signingKey?: string }) {
  const sealed = await sealStoreSecrets(app, { stripe_connect_account_id: null }, await depsSecretKey(deps));
  const { stripe_connect_mode: _m, ...credentials } = sealed.credentials as Record<string, unknown>;
  void _m;
  await db.update(schema.apps).set({ secrets: sealed.secrets, secretHints: sealed.secretHints, credentials, credentialsStatus: null, credentialsError: null, credentialsCheckedAt: null }).where(eq(schema.apps.id, app.id));
  await db.update(schema.stripeConnections).set({ status: "disconnected", accountHash: null, disconnectedAt: now, disconnectReason: reason, chargesEnabled: null, detailsSubmitted: null, updatedAt: now })
    .where(eq(schema.stripeConnections.appId, app.id));
}

/**
 * Disconnects from RevenueDot: deauthorizes the platform's access at Stripe, then forgets the account. Stripe answering that
 * the account is not connected is fine; Stripe being down still disconnects here and says so (`deauthorized: false`).
 */
export async function disconnectConnect(deps: Deps, app: AppRecord, opened: AppRecord) {
  if (!stripeConnected(app)) throw new ConnectError("This app is not connected with Stripe Connect.", "not_connected", 409);
  const account = typeof opened.credentials?.stripe_account_id === "string" ? opened.credentials.stripe_account_id : null;
  let deauthorized = false;
  let warning: string | null = null;
  const cfg = deps.stripeConnect;
  if (account && cfg?.clientId && (cfg.secretKey || cfg.testSecretKey)) {
    try {
      await connectPost(deps, "/oauth/deauthorize", { client_id: cfg.clientId, stripe_user_id: account }, oauthKey(cfg));
      deauthorized = true;
    } catch (e) {
      if (e instanceof StripeApiError && e.kind === "invalid") deauthorized = true; // already disconnected on Stripe's side
      else warning = "Stripe could not be reached, so RevenueDot may still appear under Connected apps in your Stripe account. Remove it there.";
    }
  } else {
    warning = "This server has no Stripe Connect platform keys, so RevenueDot may still appear under Connected apps in your Stripe account. Remove it there.";
  }
  await dropConnection(deps.db, app, "Disconnected in RevenueDot", deps.now(), deps);
  return { deauthorized, warning };
}

/** Connected apps for an account id from a Connect webhook. */
export async function appsForAccount(db: DB, account: string): Promise<AppRecord[]> {
  const hash = await sha256(account);
  const rows = await db.select({ app: schema.apps }).from(schema.stripeConnections).innerJoin(schema.apps, eq(schema.apps.id, schema.stripeConnections.appId))
    .where(and(eq(schema.stripeConnections.accountHash, hash), eq(schema.stripeConnections.status, "connected")));
  return rows.map((r) => r.app).filter((a) => stripeConnected(a));
}

/** `account.application.deauthorized`: the developer removed RevenueDot in Stripe. */
export async function deauthorizedInStripe(deps: Deps, apps: AppRecord[]) {
  for (const app of apps) await dropConnection(deps.db, app, "Disconnected in Stripe", deps.now(), deps);
}

/** `account.updated`: onboarding progress of a connected account. */
export async function accountUpdated(db: DB, apps: AppRecord[], o: { charges_enabled?: boolean; details_submitted?: boolean }, now: Date) {
  for (const app of apps) {
    await db.update(schema.stripeConnections).set({
      ...(typeof o.charges_enabled === "boolean" ? { chargesEnabled: o.charges_enabled } : {}),
      ...(typeof o.details_submitted === "boolean" ? { detailsSubmitted: o.details_submitted } : {}), updatedAt: now,
    }).where(eq(schema.stripeConnections.appId, app.id));
  }
}

