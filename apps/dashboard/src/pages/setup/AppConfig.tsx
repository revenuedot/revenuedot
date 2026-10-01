import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import {
  Check, ConfirmDialog, CopyButton, CopyField, Disclosure, Field, FileDrop, KeyValue, SecretText, StatusLine, Switch, useProjectId, useToast,
} from "../../components/ui";
import { api, fmt } from "../../lib/api";
import {
  STORES, apiOrigin, base, errMsg, storeId, useApp, useProducts, usePublicKey, useStoreSettings,
  type App, type CredentialsCheck, type Product, type StoreSettings,
} from "./data";
import { SdkSetup } from "./sdk";

/**
 * App configuration (/projects/:projectId/apps/:appId): RevenueCat's long app form (frames 23-25), one page per store.
 * App Store: name, bundle ID, URL scheme, in-app purchase key (.p8 + key ID + issuer ID) with a live check against Apple,
 * App Store Connect API key + vendor number, server notification URL with live "last received", forwarding URL,
 * "track new purchases", collapsed extras, public key, REST identifier, delete. Google Play: package name, service
 * account JSON with a live check, Pub/Sub push endpoint and steps. Amazon Appstore: package name, shared key with a live
 * RVS check, the Real-time Notifications URL (SNS) with its live status, the pinned SNS topic (set from the first verified message). Stripe: restricted
 * key with a live check, webhook URL with the events to select and the signing secret, how app user ids are found, when
 * a subscription counts, and server snippets for POST /v1/receipts. Test Store: nothing to configure, a test purchase.
 *
 * GAPS vs RevenueCat (later tiers; each shows as a note in its collapsed section):
 * - "Apply in App Store Connect" (setting the notification URL through Apple's API) and Apple's "request a test
 *   notification": the developer pastes the URL by hand.
 * - Refund request handling (answering Apple's consumption requests), Retention Messaging API, StoreKit
 *   subscription offer key (signing promotional offers) and the Small Business Program commission dates.
 * - A live check for the App Store Connect API key (it is stored; product import that uses it comes later).
 * - "Download sample app" banner.
 */

type Draft = {
  name: string; storeId: string;
  p8: { name: string; text: string } | null; keyId: string; issuerId: string;
  ascP8: { name: string; text: string } | null; ascKeyId: string; ascIssuerId: string; vendor: string;
  sharedSecret: string; xcodeCert: string;
  sa: { name: string; text: string } | null;
  forwardUrl: string; trackNew: boolean; allowUnsigned: boolean;
  amazonSecret: string; snsTopic: string;
  stripeKey: string; stripeWhsec: string; stripeAccount: string; userSource: "metadata" | "customer_id" | "anonymous"; metadataKey: string; registerOn: "invoice_paid" | "invoice_created";
};

const initial = (a: App, s: StoreSettings): Draft => ({
  name: a.name, storeId: storeId(a) ?? "",
  p8: null, keyId: s.credentials.subscription_key.key_id ?? "", issuerId: s.credentials.subscription_key.issuer_id ?? "",
  ascP8: null, ascKeyId: s.credentials.app_store_connect_api_key.key_id ?? "", ascIssuerId: s.credentials.app_store_connect_api_key.issuer_id ?? "",
  vendor: s.credentials.app_store_connect_api_key.vendor_number ?? "",
  sharedSecret: "", xcodeCert: "", sa: null,
  forwardUrl: s.notification_forward_url ?? "", trackNew: s.track_new_purchases, allowUnsigned: s.allow_unsigned_receipts,
  amazonSecret: "", snsTopic: s.sns_topic_arn ?? "",
  stripeKey: "", stripeWhsec: "", stripeAccount: s.stripe?.stripe_account_id ?? "", userSource: s.stripe?.app_user_id_source ?? "metadata",
  metadataKey: s.stripe?.app_user_id_metadata_key ?? "app_user_id", registerOn: s.stripe?.register_on ?? "invoice_paid",
});

type StoreName = "Apple" | "Google" | "Amazon" | "Stripe";
const storeName = (type: App["type"]): StoreName => (type === "play_store" ? "Google" : type === "amazon" ? "Amazon" : type === "stripe" ? "Stripe" : "Apple");

/** The Stripe events the webhook endpoint needs (RevenueCat's list plus the ones RevenueDot also reads). */
export const STRIPE_EVENTS = [
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed",
  "invoice.paid", "invoice.payment_failed", "invoice.updated", "charge.refunded", "checkout.session.completed",
];

const KEY_ID = /^[A-Z0-9]{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const P8 = /-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/;
/** App Store Connect names downloads SubscriptionKey_<KEYID>.p8 or AuthKey_<KEYID>.p8. */
const keyIdFromFile = (name: string) => /(?:SubscriptionKey|AuthKey|ApiKey)_([A-Z0-9]{10})\.p8$/i.exec(name)?.[1]?.toUpperCase() ?? null;

function parseServiceAccount(text: string): { email: string } | string {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return "This file is not JSON. Download a JSON key for the service account in Google Cloud (Keys → Add key → JSON)."; }
  const o = j as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.client_email !== "string" || typeof o.private_key !== "string") return "This JSON is not a service account key: it has no client_email and private_key.";
  if (o.type !== undefined && o.type !== "service_account") return `This is a "${String(o.type)}" credential, not a service account key.`;
  return { email: o.client_email };
}

function validate(type: App["type"], d: Draft, s: StoreSettings, origin: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = "Give the app a name.";
  if (type === "app_store" || type === "mac_app_store") {
    if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(d.storeId.trim())) e.storeId = "A bundle ID looks like com.company.app.";
    const touched = !!d.p8 || d.keyId !== (s.credentials.subscription_key.key_id ?? "") || d.issuerId !== (s.credentials.subscription_key.issuer_id ?? "");
    if (touched || s.credentials.subscription_key.configured) {
      if (!d.p8 && !s.credentials.subscription_key.configured) e.p8 = "Add the .p8 file for this key.";
      if (d.p8 && !P8.test(d.p8.text)) e.p8 = "This is not a .p8 private key. Upload the file App Store Connect gave you, unchanged.";
      if (!KEY_ID.test(d.keyId.trim())) e.keyId = "The key ID is 10 capital letters and digits, like 4F7XK7KYF8.";
      if (!UUID.test(d.issuerId.trim())) e.issuerId = "The issuer ID looks like 69a6de94-014f-47e3-e053-5b8c7c11a4d1.";
    }
    const ascTouched = !!d.ascP8 || d.ascKeyId || d.ascIssuerId;
    if (ascTouched) {
      if (!d.ascP8 && !s.credentials.app_store_connect_api_key.configured) e.ascP8 = "Add the .p8 file for this key.";
      if (d.ascP8 && !P8.test(d.ascP8.text)) e.ascP8 = "This is not a .p8 private key.";
      if (!KEY_ID.test(d.ascKeyId.trim())) e.ascKeyId = "The key ID is 10 capital letters and digits.";
      if (!UUID.test(d.ascIssuerId.trim())) e.ascIssuerId = "The issuer ID is a UUID shown above the keys list.";
    }
    if (d.vendor && !/^\d{6,12}$/.test(d.vendor.trim())) e.vendor = "The vendor number is digits only, like 88340210.";
    if (d.sharedSecret && !/^[0-9a-f]{32}$/i.test(d.sharedSecret.trim())) e.sharedSecret = "A shared secret is 32 letters and digits.";
    if (d.xcodeCert && !/BEGIN CERTIFICATE/.test(d.xcodeCert)) e.xcodeCert = "Paste the certificate as PEM text (-----BEGIN CERTIFICATE-----).";
  }
  if (type === "play_store" || type === "amazon") {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(d.storeId.trim())) e.storeId = "A package name looks like com.company.app.";
    if (d.sa) { const p = parseServiceAccount(d.sa.text); if (typeof p === "string") e.sa = p; }
  }
  if (type === "amazon") {
    if (d.amazonSecret && /\s/.test(d.amazonSecret.trim())) e.amazonSecret = "The shared key has no spaces. Copy it again from Settings → Identity.";
    if (d.snsTopic.trim() && !/^arn:aws(-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[\w.-]+$/.test(d.snsTopic.trim())) e.snsTopic = "An SNS topic ARN looks like arn:aws:sns:us-east-1:123456789012:topic-name.";
  }
  if (type === "stripe") {
    const k = d.stripeKey.trim();
    if (k && /^pk_/.test(k)) e.stripeKey = "This is a publishable key (pk_…). Paste a restricted key (rk_…) instead.";
    else if (k && !/^(rk|sk)_(live|test)_[A-Za-z0-9]+$/.test(k)) e.stripeKey = "A restricted key starts with rk_live_ or rk_test_.";
    if (d.stripeWhsec.trim() && !/^whsec_[A-Za-z0-9+/=]+$/.test(d.stripeWhsec.trim())) e.stripeWhsec = "The signing secret starts with whsec_.";
    if (d.stripeAccount.trim() && !/^acct_[A-Za-z0-9]+$/.test(d.stripeAccount.trim())) e.stripeAccount = "A Stripe account id starts with acct_.";
    if (d.userSource === "metadata" && !/^[\w.-]{1,40}$/.test(d.metadataKey.trim())) e.metadataKey = "Use the metadata key you set in Stripe, for example app_user_id.";
  }
  const f = d.forwardUrl.trim();
  if (f) {
    let u: URL | null = null;
    try { u = new URL(f); } catch { /* handled below */ }
    if (!u || !/^https?:$/.test(u.protocol)) e.forwardUrl = "Enter a full URL starting with https://.";
    else if (u.origin === origin) e.forwardUrl = "This is RevenueDot's own address; forwarding there would loop. Use RevenueCat's URL or your own server.";
  }
  return e;
}

function Section({ id, title, tag, children }: { id: string; title: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel" id={id} aria-labelledby={`${id}-h`}>
      <div className="ph"><b id={`${id}-h`}>{title}</b>{tag}</div>
      <div className="pb stack">{children}</div>
    </section>
  );
}

function Saved({ children, onReplace, replaceLabel = "Replace" }: { children: ReactNode; onReplace: () => void; replaceLabel?: string }) {
  return <div className="saved"><span><i className="dot ok" />{children}</span><button type="button" className="btn btn-line" onClick={onReplace}>{replaceLabel}</button></div>;
}

function CheckResult({ state }: { state: { busy: boolean; result: CredentialsCheck | null; error: string | null } }) {
  if (state.busy) return <StatusLine tone="live">Checking with the store…</StatusLine>;
  if (state.error) return <StatusLine tone="bad">{state.error}</StatusLine>;
  if (!state.result) return null;
  const r = state.result;
  return <StatusLine tone={r.status === "valid" ? "ok" : r.status === "invalid" ? "bad" : "idle"}>{r.status === "valid" ? `Valid credentials. ${r.message}` : r.message}</StatusLine>;
}

/** "Last received" for store notifications, refreshed every 10 seconds while the page is open. */
function NotificationStatus({ s, store }: { s: StoreSettings; store: StoreName }) {
  if (s.last_notification_error) return <StatusLine tone="bad">The last notification from {store} could not be processed: {s.last_notification_error}</StatusLine>;
  if (s.last_notification_at) return <StatusLine tone="ok">{store} notifications are configured correctly. Last received {fmt.ago(s.last_notification_at)} ({fmt.dateTime(s.last_notification_at)}).</StatusLine>;
  return <StatusLine tone="live">Waiting for the first notification from {store}. This updates by itself once {store} sends one.</StatusLine>;
}

const FORWARD_NAME: Record<StoreName, string> = {
  Apple: " Apple Server Notification URL", Google: " Google real-time notification URL", Amazon: " Amazon Real-time Notifications URL", Stripe: " Stripe webhook endpoint URL",
};

function ForwardField({ d, set, errors, s, store }: { d: Draft; set: (p: Partial<Draft>) => void; errors: Record<string, string>; s: StoreSettings; store: StoreName }) {
  return (
    <Field label="Forward notifications to RevenueCat or your own server" htmlFor="forward-url" error={errors.forwardUrl} hint={<>
      Optional. RevenueDot sends every {store} notification, unchanged, to this URL as well. Running side by side with RevenueCat? Paste the
      {FORWARD_NAME[store]} from your RevenueCat app settings here, so both stay up to date while you switch.
      {s.last_forward && <> Last forward: <span className="mono">{s.last_forward.status === 0 ? "no answer" : `HTTP ${s.last_forward.status}`}</span>, {fmt.ago(s.last_forward.at)}.</>}
    </>}>
      <input id="forward-url" className="input mono" inputMode="url" placeholder="https://api.revenuecat.com/v1/incoming-webhooks/…" value={d.forwardUrl}
        aria-invalid={!!errors.forwardUrl} onChange={(e) => set({ forwardUrl: e.target.value })} />
    </Field>
  );
}

const TRACK_HINT: Record<StoreName, string> = {
  Apple: "Record purchases RevenueDot first hears about from Apple, for example one made before your app sent its receipt. The customer is matched by the purchase's appAccountToken, or gets an anonymous ID.",
  Google: "Record purchases RevenueDot first hears about from Google. The customer is matched by the obfuscated account ID set at purchase, or gets an anonymous ID.",
  Amazon: "Record purchases RevenueDot first hears about from Amazon. Amazon's notifications carry no app user ID, so the customer gets an anonymous ID until the app posts the receipt.",
  Stripe: "Record subscriptions and Checkout purchases RevenueDot first hears about from Stripe, even if your backend never posts them. The customer is found as set below.",
};

function TrackNew({ d, set, store }: { d: Draft; set: (p: Partial<Draft>) => void; store: StoreName }) {
  return <Check checked={d.trackNew} onChange={(v) => set({ trackNew: v })} label="Track new purchases from server-to-server notifications" hint={TRACK_HINT[store]} />;
}

function TestPurchase({ pid, app }: { pid: string; app: App }) {
  const qc = useQueryClient();
  const toast = useToast();
  const products = useProducts(pid, app.id);
  const [user, setUser] = useState(() => `test_user_${Math.random().toString(36).slice(2, 8)}`);
  const [product, setProduct] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ user: string; product: string; entitlements: number } | null>(null);
  const [newId, setNewId] = useState("pro_monthly");
  const [newType, setNewType] = useState("subscription");
  const list = products.data ?? [];
  const chosen = product || list[0]?.id || "";

  const createProduct = async () => {
    setBusy(true); setError(null);
    try {
      const p = await api<Product>(`${base(pid)}/products`, { method: "POST", json: { store_identifier: newId.trim(), app_id: app.id, type: newType, display_name: newId.trim(), ...(newType === "subscription" ? { subscription: { duration: "P1M" } } : {}) } });
      await qc.invalidateQueries({ queryKey: ["products", pid] });
      setProduct(p.id);
      toast(`Product ${p.store_identifier} created.`);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  const buy = async () => {
    if (!user.trim()) { setError("Enter an app user ID, as your app would send it."); return; }
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api<{ customer: { id: string; active_entitlements?: { items: unknown[] } } }>(`${base(pid)}/test_purchases`, { method: "POST", json: { app_user_id: user.trim(), product_id: chosen, app_id: app.id } });
      const p = list.find((x) => x.id === chosen);
      setDone({ user: r.customer.id, product: p?.store_identifier ?? chosen, entitlements: r.customer.active_entitlements?.items.length ?? 0 });
      toast("Test purchase recorded.");
      await qc.invalidateQueries();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  if (products.isLoading) return <p className="subtle">Loading products…</p>;
  if (!list.length) {
    return (
      <div className="stack">
        <p className="section-sub">This app has no products yet. Create one here (you can edit it later in Product catalog), then send a test purchase.</p>
        <div className="cols">
          <Field label="Product identifier" htmlFor="tp-new-id" hint="The id your app asks the store for.">
            <input id="tp-new-id" className="input mono" value={newId} onChange={(e) => setNewId(e.target.value)} />
          </Field>
          <Field label="Type" htmlFor="tp-new-type">
            <select id="tp-new-type" className="select" value={newType} onChange={(e) => setNewType(e.target.value)}>
              <option value="subscription">Monthly subscription</option><option value="non_consumable">One-time purchase (lifetime)</option><option value="consumable">Consumable</option>
            </select>
          </Field>
        </div>
        {error && <div className="banner err" role="alert">{error}</div>}
        <div><button type="button" className="btn btn-line" disabled={busy || !newId.trim()} onClick={createProduct}>{busy ? "Creating…" : "Create product"}</button></div>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="cols">
        <Field label="App user ID" htmlFor="tp-user" hint="Who buys. A new ID creates a new customer.">
          <input id="tp-user" className="input mono" value={user} onChange={(e) => setUser(e.target.value)} />
        </Field>
        <Field label="Product" htmlFor="tp-product">
          <select id="tp-product" className="select" value={chosen} onChange={(e) => setProduct(e.target.value)}>
            {list.map((p) => <option key={p.id} value={p.id}>{p.display_name && p.display_name !== p.store_identifier ? `${p.display_name} (${p.store_identifier})` : p.store_identifier}</option>)}
          </select>
        </Field>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}
      {done && <StatusLine tone="ok">{done.user} bought {done.product}. They now have {done.entitlements} active entitlement{done.entitlements === 1 ? "" : "s"}. <Link className="linkish" to={`/projects/${pid}/customers/${encodeURIComponent(done.user)}`}>View customer</Link></StatusLine>}
      <div><button type="button" className="btn btn-dark" disabled={busy || !chosen} onClick={buy}><Icon name="send" />{busy ? "Sending…" : "Send a test purchase"}</button></div>
    </div>
  );
}

function AppForm({ app, s }: { app: App; s: StoreSettings }) {
  const pid = useProjectId();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const pub = usePublicKey(pid, app.id);
  // The notification URLs and the SDK proxy URL both use the server's public address.
  const origin = s.api_origin || apiOrigin();
  const start = useMemo(() => initial(app, s), [app, s]);
  const [d, setD] = useState<Draft>(start);
  // Until the developer edits something, the form follows the server (it refreshes every 10 seconds and after saving).
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!touched) setD(start); }, [start, touched]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<{ busy: boolean; result: CredentialsCheck | null; error: string | null }>({ busy: false, result: null, error: null });
  const [replacing, setReplacing] = useState<{ p8?: boolean; asc?: boolean; sa?: boolean; secret?: boolean; amazon?: boolean; stripeKey?: boolean; whsec?: boolean }>({});
  const [deleting, setDeleting] = useState(false);
  const set = (p: Partial<Draft>) => { setTouched(true); setD((x) => ({ ...x, ...p })); setErrors((e) => { const n = { ...e }; for (const k of Object.keys(p)) delete n[k]; return n; }); };
  const apple = app.type === "app_store" || app.type === "mac_app_store";
  const google = app.type === "play_store";
  const amazon = app.type === "amazon";
  const stripe = app.type === "stripe";
  const test = app.type === "test_store";
  const name = storeName(app.type);
  const dirty = JSON.stringify(d) !== JSON.stringify(start);
  const sa = d.sa ? parseServiceAccount(d.sa.text) : null;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const runCheck = async (useDraft: boolean) => {
    setCheck({ busy: true, result: null, error: null });
    const json = !useDraft ? {} : apple
      ? { [app.type]: { bundle_id: d.storeId.trim() || null, subscription_private_key: d.p8?.text ?? null, subscription_key_id: d.keyId.trim() || null, subscription_key_issuer: d.issuerId.trim() || null } }
      : amazon ? { amazon: { package_name: d.storeId.trim() || null, shared_secret: d.amazonSecret.trim() || null } }
      : stripe ? { stripe: { stripe_secret_key: d.stripeKey.trim() || null, stripe_account_id: d.stripeAccount.trim() || null } }
      : { play_store: { package_name: d.storeId.trim() || null, play_service_account_credentials_json: d.sa?.text ?? null } };
    try {
      const r = await api<CredentialsCheck>(`${base(pid)}/apps/${app.id}/actions/verify_credentials`, { method: "POST", json });
      setCheck({ busy: false, result: r, error: null });
    } catch (e) { setCheck({ busy: false, result: null, error: errMsg(e) }); }
  };

  const save = async () => {
    const errs = validate(app.type, d, s, origin);
    setErrors(errs);
    if (Object.keys(errs).length) {
      toast("Fix the highlighted fields first.");
      document.getElementById(Object.keys(errs)[0] === "name" ? "app-name" : `f-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    const details: Record<string, unknown> = {};
    const put = (k: string, v: unknown, was: unknown) => { if (v !== was) details[k] = v; };
    let credsChanged = false;
    if (apple) {
      put("bundle_id", d.storeId.trim(), start.storeId);
      if (d.p8) { details.subscription_private_key = d.p8.text.trim(); credsChanged = true; }
      if (d.keyId.trim() !== start.keyId) { details.subscription_key_id = d.keyId.trim(); credsChanged = true; }
      if (d.issuerId.trim() !== start.issuerId) { details.subscription_key_issuer = d.issuerId.trim(); credsChanged = true; }
      if (d.ascP8) details.app_store_connect_api_key = d.ascP8.text.trim();
      put("app_store_connect_api_key_id", d.ascKeyId.trim() || null, start.ascKeyId || null);
      put("app_store_connect_api_key_issuer", d.ascIssuerId.trim() || null, start.ascIssuerId || null);
      put("app_store_connect_vendor_number", d.vendor.trim() || null, start.vendor || null);
      if (d.sharedSecret.trim()) details.shared_secret = d.sharedSecret.trim();
      if (d.xcodeCert.trim()) details.xcode_certificate = d.xcodeCert.trim();
      put("allow_unsigned_receipts", d.allowUnsigned, start.allowUnsigned);
    }
    if (google) {
      put("package_name", d.storeId.trim(), start.storeId);
      if (d.sa) { details.play_service_account_credentials_json = d.sa.text.trim(); credsChanged = true; }
    }
    if (amazon) {
      put("package_name", d.storeId.trim(), start.storeId);
      if (d.amazonSecret.trim()) { details.shared_secret = d.amazonSecret.trim(); credsChanged = true; }
      put("sns_topic_arn", d.snsTopic.trim() || null, start.snsTopic || null);
    }
    if (stripe) {
      if (d.stripeKey.trim()) { details.stripe_secret_key = d.stripeKey.trim(); credsChanged = true; }
      if (d.stripeWhsec.trim()) details.stripe_webhook_secret = d.stripeWhsec.trim();
      put("stripe_account_id", d.stripeAccount.trim() || null, start.stripeAccount || null);
      put("app_user_id_source", d.userSource, start.userSource);
      put("app_user_id_metadata_key", d.metadataKey.trim(), start.metadataKey);
      put("register_on", d.registerOn, start.registerOn);
    }
    if (!test) {
      put("notification_forward_url", d.forwardUrl.trim() || null, start.forwardUrl || null);
      put("track_new_purchases", d.trackNew, start.trackNew);
    }
    const json: Record<string, unknown> = {};
    if (d.name.trim() !== start.name) json.name = d.name.trim();
    if (Object.keys(details).length) json[app.type] = details;
    setSaving(true);
    try {
      if (Object.keys(json).length) await api(`${base(pid)}/apps/${app.id}`, { method: "POST", json });
      setReplacing({});
      setTouched(false);
      await Promise.all([qc.invalidateQueries({ queryKey: ["app", pid, app.id] }), qc.invalidateQueries({ queryKey: ["store_settings", pid, app.id] }), qc.invalidateQueries({ queryKey: ["apps", pid] }), qc.invalidateQueries({ queryKey: ["setup_health", pid] })]);
      toast("Changes saved.");
      if (credsChanged) void runCheck(false);
    } catch (e) { toast(errMsg(e)); setErrors({ form: errMsg(e) }); } finally { setSaving(false); }
  };

  const del = async () => {
    await api(`${base(pid)}/apps/${app.id}`, { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: ["apps", pid] });
    await qc.invalidateQueries({ queryKey: ["setup_health", pid] });
    toast(`${app.name} deleted.`);
    nav(`/projects/${pid}/apps`);
  };

  const store = STORES[app.type]!;
  const key = pub.data?.key ?? "";
  const cr = s.credentials;
  const keyOk = cr.subscription_key.configured;
  const saOk = cr.play_service_account.configured;
  const amazonOk = !!cr.amazon_shared_secret?.configured;
  const stripeKey = cr.stripe_secret_key;
  const stripeOk = !!stripeKey?.configured;
  const whsecOk = !!cr.stripe_webhook_secret?.configured;
  const credsOk = apple ? keyOk : google ? saOk : amazon ? amazonOk : stripeOk;
  const credsName = apple ? "In-app purchase key" : google ? "Service account" : amazon ? "Shared key" : "Stripe API key";
  const notifName = apple ? "Server notifications" : google ? "Real-time developer notifications" : amazon ? "Real-time Notifications" : "Stripe webhooks";

  return (
    <div className="page narrow">
      <div className="head">
        <div>
          <h1>{app.name}</h1>
          <p className="hrow">{store.label} · <span className="copy"><span>{app.id}</span><CopyButton value={app.id} label="Copy app ID" /></span></p>
        </div>
      </div>

      {!test && (
        <section className="panel" aria-label="Setup checklist">
          <div className="ph"><b>Setup checklist</b><span className="link">{[credsOk, !!s.last_notification_at].filter(Boolean).length} of 2 verified</span></div>
          <div className="pb stack tight">
            <StatusLine tone={credsOk ? "ok" : "bad"}><a className="linkish" href="#credentials">{credsName}</a> {credsOk ? "is saved." : `is missing. RevenueDot needs it to check purchases with ${name}.`}</StatusLine>
            <StatusLine tone={s.last_notification_at ? "ok" : "idle"}><a className="linkish" href="#notifications">{notifName}</a> {s.last_notification_at ? `arrive (last ${fmt.ago(s.last_notification_at)}).` : "have not arrived yet."}</StatusLine>
            {stripe
              ? <StatusLine tone="idle"><a className="linkish" href="#sdk">Your backend</a>: post each new subscription or Checkout Session to <span className="mono">/v1/receipts</span> with this app's key.</StatusLine>
              : <StatusLine tone="idle"><a className="linkish" href="#sdk">SDK</a>: set the proxy URL and this app's key in your app, then make a sandbox purchase.</StatusLine>}
          </div>
        </section>
      )}

      <Section id="details" title="App details">
        <div className="cols">
          <Field label="App name" htmlFor="app-name" error={errors.name}>
            <input id="app-name" className="input" maxLength={255} value={d.name} aria-invalid={!!errors.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          {(apple || google || amazon) && (
            <Field label={store.idLabel!} htmlFor="f-storeId" error={errors.storeId} hint={apple ? "In Xcode: your target → General → Bundle Identifier." : amazon ? "Your app's package name in the Amazon Appstore Console." : "Shown under your app's name in Play Console."}>
              <input id="f-storeId" className="input mono" value={d.storeId} spellCheck={false} aria-invalid={!!errors.storeId} onChange={(e) => set({ storeId: e.target.value })} />
            </Field>
          )}
        </div>
        {apple && app.custom_url_scheme && (
          <Field label="Custom URL scheme" htmlFor="url-scheme" hint="Register this URL scheme in your app so paywall previews and purchase links can open it.">
            <CopyField value={app.custom_url_scheme} label="URL scheme" />
          </Field>
        )}
      </Section>

      {test && (
        <>
          <Section id="test-store" title="Nothing to configure">
            <p className="section-sub">Test Store purchases never reach Apple or Google and never charge anyone. They count as sandbox data, so they stay out of your production numbers. Put this app's key in a debug build, or send a purchase from here.</p>
          </Section>
          <Section id="test-purchase" title="Send a test purchase">
            <TestPurchase pid={pid} app={app} />
          </Section>
        </>
      )}

      {apple && (
        <Section id="credentials" title="In-app purchase key" tag={<span className="tag gold">Required</span>}>
          <p className="section-sub">RevenueDot uses this key to ask Apple for each customer's purchases, renewals and refunds. StoreKit 2 purchases cannot be checked without it.</p>
          <ol className="steps">
            <li>Open <a href="https://appstoreconnect.apple.com/access/integrations/api/subs" target="_blank" rel="noreferrer">App Store Connect → Users and Access → Integrations → In-App Purchase</a>.</li>
            <li>Click <b>+</b>, name the key (for example RevenueDot), and click <b>Generate</b>.</li>
            <li>Click <b>Download</b> next to the key. Apple lets you download the .p8 file only once, so keep a copy.</li>
            <li>Drop the file below. The key ID fills in from the file name. Copy the <b>Issuer ID</b> shown above the keys list.</li>
          </ol>
          {keyOk && !replacing.p8 && !d.p8
            ? <Saved onReplace={() => setReplacing({ ...replacing, p8: true })} replaceLabel="Replace key">Key <span className="mono">{cr.subscription_key.key_id}</span> is saved. The private key is never shown again.</Saved>
            : (
              <Field label="P8 key file" htmlFor="f-p8" error={errors.p8}>
                <FileDrop id="f-p8" accept=".p8,.pem,.txt" prompt={d.p8 ? <><b>{d.p8.name}</b> is ready to save.</> : "Drop the .p8 file from App Store Connect here."}
                  onFile={(name, text) => { const k = keyIdFromFile(name); set({ p8: { name, text }, ...(k ? { keyId: k } : {}) }); }} />
              </Field>
            )}
          <div className="cols">
            <Field label="Key ID" htmlFor="f-keyId" error={errors.keyId} hint="10 characters, next to the key's name.">
              <input id="f-keyId" className="input mono" maxLength={10} value={d.keyId} placeholder="4F7XK7KYF8" spellCheck={false} aria-invalid={!!errors.keyId} onChange={(e) => set({ keyId: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Issuer ID" htmlFor="f-issuerId" error={errors.issuerId} hint="Above the keys list in App Store Connect.">
              <input id="f-issuerId" className="input mono" value={d.issuerId} placeholder="69a6de94-014f-47e3-e053-5b8c7c11a4d1" spellCheck={false} aria-invalid={!!errors.issuerId} onChange={(e) => set({ issuerId: e.target.value.trim() })} />
            </Field>
          </div>
          <div className="hrow">
            <button type="button" className="btn btn-line" disabled={check.busy || (!keyOk && !d.p8)} onClick={() => runCheck(true)}><Icon name="refresh" />Check credentials</button>
            <CheckResult state={check} />
          </div>
        </Section>
      )}

      {apple && (
        <Section id="asc" title="App Store Connect API key" tag={<span className="tag muted">Optional</span>}>
          <p className="section-sub">A separate key with the App Manager role. Store it now so importing your products and prices from Apple works when that arrives. Create it in <a className="linkish" href="https://appstoreconnect.apple.com/access/integrations/api" target="_blank" rel="noreferrer">Users and Access → Integrations → App Store Connect API</a>.</p>
          {cr.app_store_connect_api_key.configured && !replacing.asc && !d.ascP8
            ? <Saved onReplace={() => setReplacing({ ...replacing, asc: true })} replaceLabel="Replace key">Key <span className="mono">{cr.app_store_connect_api_key.key_id ?? ""}</span> is saved.</Saved>
            : (
              <Field label="P8 key file" htmlFor="f-ascP8" error={errors.ascP8}>
                <FileDrop id="f-ascP8" accept=".p8,.pem,.txt" prompt={d.ascP8 ? <><b>{d.ascP8.name}</b> is ready to save.</> : "Drop the App Store Connect API .p8 file here."}
                  onFile={(name, text) => { const k = keyIdFromFile(name); set({ ascP8: { name, text }, ...(k ? { ascKeyId: k } : {}) }); }} />
              </Field>
            )}
          <div className="cols">
            <Field label="Key ID" htmlFor="f-ascKeyId" error={errors.ascKeyId}><input id="f-ascKeyId" className="input mono" maxLength={10} value={d.ascKeyId} aria-invalid={!!errors.ascKeyId} onChange={(e) => set({ ascKeyId: e.target.value.toUpperCase() })} /></Field>
            <Field label="Issuer ID" htmlFor="f-ascIssuerId" error={errors.ascIssuerId}><input id="f-ascIssuerId" className="input mono" value={d.ascIssuerId} aria-invalid={!!errors.ascIssuerId} onChange={(e) => set({ ascIssuerId: e.target.value.trim() })} /></Field>
          </div>
          <Field label="Vendor number" htmlFor="f-vendor" error={errors.vendor} hint="Top left of Payments and Financial Reports in App Store Connect.">
            <input id="f-vendor" className="input mono" inputMode="numeric" value={d.vendor} aria-invalid={!!errors.vendor} onChange={(e) => set({ vendor: e.target.value.trim() })} />
          </Field>
        </Section>
      )}

      {google && (
        <Section id="credentials" title="Service account credentials" tag={<span className="tag gold">Required</span>}>
          <p className="section-sub">RevenueDot uses a Google Cloud service account to check purchases, acknowledge them (Google refunds purchases left unacknowledged for 3 days) and read refunds.</p>
          <ol className="steps">
            <li>In <a href="https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com" target="_blank" rel="noreferrer">Google Cloud</a>, enable the <b>Google Play Android Developer API</b> for your project.</li>
            <li>Under IAM → <b>Service accounts</b>, create a service account. Open it, go to <b>Keys → Add key → JSON</b>, and download the file.</li>
            <li>In <a href="https://play.google.com/console/developers/users-and-permissions" target="_blank" rel="noreferrer">Play Console → Users and permissions</a>, invite the service account's email with <b>View app information</b>, <b>View financial data</b> and <b>Manage orders and subscriptions</b>.</li>
            <li>Drop the JSON file below and check it. New Play Console permissions can take up to 36 hours to apply.</li>
          </ol>
          {saOk && !replacing.sa && !d.sa
            ? <Saved onReplace={() => setReplacing({ ...replacing, sa: true })} replaceLabel="Replace file">Service account <span className="mono">{cr.play_service_account.client_email ?? ""}</span> is saved.</Saved>
            : (
              <Field label="Service account JSON" htmlFor="f-sa" error={errors.sa} hint={sa && typeof sa !== "string" ? <>Service account: <span className="mono">{sa.email}</span></> : undefined}>
                <FileDrop id="f-sa" accept=".json,application/json" prompt={d.sa ? <><b>{d.sa.name}</b> is ready to save.</> : "Drop the service account .json key file here."}
                  onFile={(name, text) => { set({ sa: { name, text } }); const p = parseServiceAccount(text); if (typeof p === "string") setErrors((e) => ({ ...e, sa: p })); }} />
              </Field>
            )}
          <div className="hrow">
            <button type="button" className="btn btn-line" disabled={check.busy || (!saOk && !d.sa)} onClick={() => runCheck(true)}><Icon name="refresh" />Check credentials</button>
            <CheckResult state={check} />
          </div>
        </Section>
      )}

      {apple && s.notification_url && (
        <Section id="notifications" title="Apple server-to-server notifications">
          <p className="section-sub">Apple tells RevenueDot about renewals, cancellations, billing problems and refunds as they happen. Without this, changes show up only when the app next opens.</p>
          <Field label="Apple Server Notification URL" htmlFor="notif-url">
            <CopyField value={s.notification_url} label="notification URL" />
          </Field>
          <NotificationStatus s={s} store="Apple" />
          <ol className="steps">
            <li>In App Store Connect, open your app → <b>App Information</b> → <b>App Store Server Notifications</b>.</li>
            <li>Paste the URL above as both the <b>Production Server URL</b> and the <b>Sandbox Server URL</b>, and choose <b>Version 2</b>.</li>
            <li>Make a sandbox purchase. The status above turns green when the first notification arrives.</li>
          </ol>
          <ForwardField d={d} set={set} errors={errors} s={s} store="Apple" />
          <TrackNew d={d} set={set} store="Apple" />
        </Section>
      )}

      {google && s.notification_url && (
        <Section id="notifications" title="Real-time developer notifications">
          <p className="section-sub">Google Play tells RevenueDot about renewals, cancellations, refunds and one-time purchases through a Pub/Sub push subscription.</p>
          <Field label="Pub/Sub push endpoint URL" htmlFor="notif-url">
            <CopyField value={s.notification_url} label="push endpoint URL" />
          </Field>
          <NotificationStatus s={s} store="Google" />
          <ol className="steps">
            <li>In <a href="https://console.cloud.google.com/cloudpubsub/topic/list" target="_blank" rel="noreferrer">Google Cloud → Pub/Sub</a>, create a topic. Give <span className="mono">google-play-developer-notifications@system.gserviceaccount.com</span> the <b>Pub/Sub Publisher</b> role on it.</li>
            <li>Add a subscription to the topic with delivery type <b>Push</b> and the endpoint URL above.</li>
            <li>In Play Console → <b>Monetize with Play → Monetization setup</b>, paste the full topic name, and turn on subscriptions, voided purchases and all one-time products.</li>
            <li>Click <b>Send test notification</b> there. The status above turns green when it arrives.</li>
          </ol>
          <ForwardField d={d} set={set} errors={errors} s={s} store="Google" />
          <TrackNew d={d} set={set} store="Google" />
        </Section>
      )}

      {amazon && (
        <Section id="credentials" title="Amazon shared key" tag={<span className="tag gold">Required</span>}>
          <p className="section-sub">RevenueDot sends every Amazon receipt to Amazon's Receipt Verification Service with this key, to check the purchase and read renewals and cancellations.</p>
          <ol className="steps">
            <li>Sign in to the <a href="https://developer.amazon.com/settings/console/sdk/shared-key" target="_blank" rel="noreferrer">Amazon Developer Console → Settings → Identity</a>.</li>
            <li>Copy the <b>Shared Key</b> and paste it below.</li>
            <li>Check it. Amazon answers right away; a wrong key is reported here, never on a customer's purchase.</li>
          </ol>
          {amazonOk && !replacing.amazon && !d.amazonSecret
            ? <Saved onReplace={() => setReplacing({ ...replacing, amazon: true })} replaceLabel="Replace key">A shared key is saved. It is never shown again.</Saved>
            : (
              <Field label="Shared key" htmlFor="f-amazonSecret" error={errors.amazonSecret}>
                <input id="f-amazonSecret" className="input mono" type="password" autoComplete="off" spellCheck={false} value={d.amazonSecret} aria-invalid={!!errors.amazonSecret} onChange={(e) => set({ amazonSecret: e.target.value })} />
              </Field>
            )}
          <div className="hrow">
            <button type="button" className="btn btn-line" disabled={check.busy || (!amazonOk && !d.amazonSecret.trim())} onClick={() => runCheck(true)}><Icon name="refresh" />Check credentials</button>
            <CheckResult state={check} />
          </div>
        </Section>
      )}

      {amazon && s.notification_url && (
        <Section id="notifications" title="Amazon Real-time Notifications">
          <p className="section-sub">Amazon tells RevenueDot about renewals, cancellations and refunds of one-time purchases as they happen, through Amazon SNS. Every message's SNS signature is checked.</p>
          <Field label="Real-time Notifications URL" htmlFor="notif-url">
            <CopyField value={s.notification_url} label="notification URL" />
          </Field>
          <NotificationStatus s={s} store="Amazon" />
          <ol className="steps">
            <li>In the <a href="https://developer.amazon.com/apps-and-games/console/apps/list.html" target="_blank" rel="noreferrer">Amazon Appstore Console</a>, open your app → <b>App Services</b> → <b>Real-time Notifications</b>.</li>
            <li>Expand <b>Add an Endpoint</b>, paste the URL above and click <b>Submit</b>.</li>
            <li>RevenueDot confirms the subscription by itself. Amazon shows <b>Verified</b> within seconds, and the status above turns green.</li>
          </ol>
          <Field label="SNS topic ARN" htmlFor="f-snsTopic" error={errors.snsTopic} hint="Messages from any other SNS topic are refused. Left empty, it is set to the topic of the first verified message (Amazon's subscription confirmation).">
            <input id="f-snsTopic" className="input mono" spellCheck={false} placeholder="arn:aws:sns:us-east-1:123456789012:…" value={d.snsTopic} aria-invalid={!!errors.snsTopic} onChange={(e) => set({ snsTopic: e.target.value })} />
          </Field>
          <ForwardField d={d} set={set} errors={errors} s={s} store="Amazon" />
          <TrackNew d={d} set={set} store="Amazon" />
        </Section>
      )}

      {stripe && (
        <Section id="credentials" title="Stripe API key" tag={<span className="tag gold">Required</span>}>
          <p className="section-sub">RevenueDot reads subscriptions, invoices and Checkout Sessions from your own Stripe account with a restricted key. It never charges, refunds or changes anything in Stripe.</p>
          <ol className="steps">
            <li>In the <a href="https://dashboard.stripe.com/apikeys/create" target="_blank" rel="noreferrer">Stripe Dashboard → Developers → API keys</a>, click <b>Create restricted key</b>.</li>
            <li>Give it <b>Read</b> access to Subscriptions, Invoices, Checkout Sessions, Charges, Customers, Products and Prices. Leave everything else at None.</li>
            <li>Paste the key below and check it. A test-mode key (rk_test_…) records sandbox purchases; use a separate Stripe app for each mode or sandbox.</li>
          </ol>
          {stripeOk && !replacing.stripeKey && !d.stripeKey
            ? <Saved onReplace={() => setReplacing({ ...replacing, stripeKey: true })} replaceLabel="Replace key">A {stripeKey?.mode === "test" ? "test mode" : "live mode"} {stripeKey?.kind === "restricted" ? "restricted" : "secret"} key ending in <span className="mono">{stripeKey?.last4}</span> is saved.</Saved>
            : (
              <Field label="Restricted key" htmlFor="f-stripeKey" error={errors.stripeKey}>
                <input id="f-stripeKey" className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="rk_live_…" value={d.stripeKey} aria-invalid={!!errors.stripeKey} onChange={(e) => set({ stripeKey: e.target.value })} />
              </Field>
            )}
          <div className="hrow">
            <button type="button" className="btn btn-line" disabled={check.busy || (!stripeOk && !d.stripeKey.trim())} onClick={() => runCheck(true)}><Icon name="refresh" />Check credentials</button>
            <CheckResult state={check} />
          </div>
          <Field label="Connected account ID" htmlFor="f-stripeAccount" error={errors.stripeAccount} hint="Optional. Only for a Stripe Connect platform key that acts for one connected account (sent as Stripe-Account).">
            <input id="f-stripeAccount" className="input mono" spellCheck={false} placeholder="acct_…" value={d.stripeAccount} aria-invalid={!!errors.stripeAccount} onChange={(e) => set({ stripeAccount: e.target.value })} />
          </Field>
        </Section>
      )}

      {stripe && s.notification_url && (
        <Section id="notifications" title="Stripe webhooks">
          <p className="section-sub">Stripe tells RevenueDot about renewals, failed payments, cancellations and refunds. Every event's Stripe-Signature is checked with the signing secret.</p>
          <Field label="Webhook endpoint URL" htmlFor="notif-url">
            <CopyField value={s.notification_url} label="webhook endpoint URL" />
          </Field>
          <NotificationStatus s={s} store="Stripe" />
          <ol className="steps">
            <li>In the <a href="https://dashboard.stripe.com/webhooks/create" target="_blank" rel="noreferrer">Stripe Dashboard → Developers → Webhooks</a>, add an endpoint with the URL above.</li>
            <li>Select these events: <span className="mono">{STRIPE_EVENTS.join(", ")}</span>. Other events are accepted and ignored.</li>
            <li>Reveal the endpoint's <b>Signing secret</b> and paste it below.</li>
          </ol>
          {whsecOk && !replacing.whsec && !d.stripeWhsec
            ? <Saved onReplace={() => setReplacing({ ...replacing, whsec: true })} replaceLabel="Replace secret">A signing secret is saved.</Saved>
            : (
              <Field label="Signing secret" htmlFor="f-stripeWhsec" error={errors.stripeWhsec} hint={!whsecOk ? "Without it every webhook is refused with 400." : undefined}>
                <input id="f-stripeWhsec" className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="whsec_…" value={d.stripeWhsec} aria-invalid={!!errors.stripeWhsec} onChange={(e) => set({ stripeWhsec: e.target.value })} />
              </Field>
            )}
          <ForwardField d={d} set={set} errors={errors} s={s} store="Stripe" />
        </Section>
      )}

      {stripe && (
        <Section id="stripe-purchases" title="Which purchases count">
          <Field label="When does a subscription count?" htmlFor="f-registerOn" hint="Paid is safer: access starts once Stripe reports the first invoice paid. Created grants access while the first invoice is still open.">
            <select id="f-registerOn" className="select" value={d.registerOn} onChange={(e) => set({ registerOn: e.target.value as Draft["registerOn"] })}>
              <option value="invoice_paid">When the invoice is paid</option>
              <option value="invoice_created">When the invoice is created</option>
            </select>
          </Field>
          <TrackNew d={d} set={set} store="Stripe" />
          <div className="cols">
            <Field label="Find the app user ID from" htmlFor="f-userSource" hint="For purchases first seen in a webhook. Posts from your backend always carry the app user ID.">
              <select id="f-userSource" className="select" value={d.userSource} onChange={(e) => set({ userSource: e.target.value as Draft["userSource"] })}>
                <option value="metadata">A Stripe metadata key</option>
                <option value="customer_id">The Stripe customer ID</option>
                <option value="anonymous">An anonymous ID</option>
              </select>
            </Field>
            {d.userSource === "metadata" && (
              <Field label="Metadata key" htmlFor="f-metadataKey" error={errors.metadataKey} hint="Read on the Checkout Session and the subscription.">
                <input id="f-metadataKey" className="input mono" spellCheck={false} value={d.metadataKey} aria-invalid={!!errors.metadataKey} onChange={(e) => set({ metadataKey: e.target.value })} />
              </Field>
            )}
          </div>
        </Section>
      )}

      <section className="panel" aria-label="More settings">
        <div className="ph"><b>More settings</b></div>
        {apple && (
          <>
            <Disclosure title="Refund request handling" sub="Lifecycle › Refund control">
              <p>When a customer asks Apple for a refund, Apple asks the developer for usage data. RevenueDot answers these consumption requests with your policies. <Link to={`/projects/${pid}/lifecycle/refund-control`}>Set up Refund control</Link>.</p>
            </Disclosure>
            <Disclosure title="Apple Retention Messaging API" sub="Lifecycle › Retention">
              <p>Show a retention message or offer inside Apple's cancellation sheet. <Link to={`/projects/${pid}/lifecycle/retention`}>Set up retention messages</Link>.</p>
            </Disclosure>
            <Disclosure title="StoreKit subscription offer key" sub="Uses the In-App Purchase key">
              <p>Promotional offers are signed on the server with the In-App Purchase key above, so the SDK's promotional offers work without your own backend.</p>
            </Disclosure>
            <Disclosure title="StoreKit testing in Xcode" sub={cr.xcode_certificate.configured ? "Certificate saved" : "For purchases made in the simulator"}>
              <p>Purchases made with a StoreKit Configuration file in Xcode are signed by Xcode, not Apple. To accept them, export the certificate in Xcode (Debug → StoreKit → Manage Transactions → Editor → Save Public Certificate) and paste it here as PEM text.</p>
              <Field label="StoreKit test certificate" htmlFor="f-xcodeCert" error={errors.xcodeCert} hint={cr.xcode_certificate.configured ? "A certificate is saved. Paste a new one to replace it." : undefined}>
                <textarea id="f-xcodeCert" className="textarea" rows={4} placeholder="-----BEGIN CERTIFICATE-----" value={d.xcodeCert} onChange={(e) => set({ xcodeCert: e.target.value })} />
              </Field>
              <div className="stack tight">
                <Switch checked={d.allowUnsigned} onChange={(v) => set({ allowUnsigned: v })} label="Allow unsigned receipts (development only)" />
                {d.allowUnsigned && <div className="banner warn" role="alert">Anyone can then send a made-up receipt and unlock paid features. Only turn this on for a development server, never in production.</div>}
              </div>
            </Disclosure>
            <Disclosure title="Apple Small Business Program" sub="Later release">
              <p>Revenue estimates use Apple's standard 30% commission. Entering your Small Business Program dates, so proceeds use 15%, comes in a later release.</p>
            </Disclosure>
            <Disclosure title="App-specific shared secret (legacy)" sub={cr.shared_secret.configured ? "Saved" : "Only for old StoreKit 1 receipts"}>
              <p>Only needed for StoreKit 1 receipts from old app versions. Find it in App Store Connect → your app → App Information → App-Specific Shared Secret → Manage.</p>
              {cr.shared_secret.configured && !replacing.secret
                ? <Saved onReplace={() => setReplacing({ ...replacing, secret: true })}>A shared secret is saved.</Saved>
                : (
                  <Field label="Shared secret" htmlFor="f-sharedSecret" error={errors.sharedSecret}>
                    <input id="f-sharedSecret" className="input mono" type="password" autoComplete="off" value={d.sharedSecret} aria-invalid={!!errors.sharedSecret} onChange={(e) => set({ sharedSecret: e.target.value })} />
                  </Field>
                )}
            </Disclosure>
          </>
        )}
        <Disclosure title="Public API key" sub="The key your app passes to the SDK" defaultOpen={test}>
          {key ? <SecretText value={key} label="public SDK key" /> : <span className="subtle">Loading…</span>}
          <p>{stripe ? "Use this key in your backend's posts to /v1/receipts. It can only read and post purchases for this app's customers." : "Public keys are safe to ship in your app. They can only read and post purchases for this app's customers."}</p>
        </Disclosure>
      </section>

      <Section id="sdk" title={stripe ? "Send purchases from your backend" : "SDK setup"}>
        <p className="section-sub">{stripe
          ? <>After Stripe confirms a purchase (<span className="mono">customer.subscription.created</span> or <span className="mono">checkout.session.completed</span>), post its subscription or Checkout Session id with the customer's app user ID. Your apps then see the same entitlements.</>
          : <>Your app keeps using the RevenueCat SDK. Add one line that points it at this server, before <span className="mono">configure</span>, and use this app's key.</>}</p>
        {key && <SdkSetup type={app.type} origin={origin} publicKey={key} />}
      </Section>

      <KeyValue rows={[["REST API identifier", <span className="copy"><span>{app.id}</span><CopyButton value={app.id} label="Copy REST API identifier" /></span>]]} />

      <section className="panel danger">
        <div className="ph"><b>Delete app</b></div>
        <div className="pb hrow between">
          <p className="section-sub">Deletes this app, its products and its SDK key. Apps using the key stop working. Purchases already recorded stay in customer history.</p>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}><Icon name="trash" />Delete app</button>
        </div>
      </section>

      {dirty && (
        <div className="unsaved" role="region" aria-label="Unsaved changes">
          <span>You have unsaved changes.</span>
          <div className="actions">
            <button type="button" className="btn btn-line" disabled={saving} onClick={() => { setTouched(false); setD(start); setErrors({}); setReplacing({}); }}>Discard</button>
            <button type="button" className="btn btn-dark" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </div>
      )}
      {errors.form && <div className="banner err" role="alert">{errors.form}</div>}

      {deleting && (
        <ConfirmDialog title={`Delete ${app.name}?`} confirmLabel="Delete app" danger onConfirm={del} onClose={() => setDeleting(false)}>
          <p>This deletes the app, its products and its public SDK key <span className="mono">{key.slice(0, 5)}…</span>. Any build that uses the key stops loading offerings and purchases.</p>
          <p>Customers and their purchase history stay. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export function AppConfig() {
  const pid = useProjectId();
  const { appId = "" } = useParams();
  const app = useApp(pid, appId);
  const s = useStoreSettings(pid, appId);
  const crumbs = <><Link to={`/projects/${pid}/apps`}>Apps</Link> <span>/</span> <b>{app.data?.name ?? "App"}</b></>;
  return (
    <Shell title={app.data?.name ?? "App"} crumbs={crumbs}>
      {(app.isLoading || (s.isLoading && !s.data)) && <div className="page narrow"><div className="panel pb subtle">Loading app…</div></div>}
      {app.isError && (
        <div className="page narrow">
          <div className="empty"><h3>This app does not exist</h3><p>It may have been deleted, or it belongs to another project.</p><Link className="btn btn-line" to={`/projects/${pid}/apps`}>Back to apps</Link></div>
        </div>
      )}
      {s.isError && !app.isError && <div className="page narrow"><div className="banner err" role="alert">The store settings could not be loaded: {errMsg(s.error)}</div></div>}
      {app.data && s.data && <AppForm key={app.data.id} app={app.data} s={s.data} />}
    </Shell>
  );
}
