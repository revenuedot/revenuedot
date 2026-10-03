/**
 * Web (/projects/:projectId/web, prd/web-billing/PRD.md §1): the project's Stripe apps as web providers, and "Start selling
 * on the web": connect Stripe, add a web config (checkout look, legal links, success behaviour, the redemption deep link),
 * create web products (RevenueDot creates them in the developer's Stripe account), and put one in an offering. Each step
 * is done or not from GET /v2/projects/:id/web. RevenueCat's equivalent: frame 26 of the contact sheet.
 * Step 1 connects Stripe on the Stripe app's page with a restricted key and the webhook signing secret, or with "Connect with
 * Stripe" (Stripe Connect OAuth, §8) where the server has a Connect platform. RevenueDot Cloud has none yet.
 * GAPS vs RevenueCat: Paddle and RevenueCat Billing providers.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DEFAULT_THEME, type FunnelTheme } from "@revenuedot/core/funnels";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { CopyButton, CopyField, Dialog, Field, Menu, PageHead, SecretText, Segmented, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { api } from "../../lib/api";
import { AddAppDialog } from "../setup/Apps";
import { useEntitlements, v2 } from "../catalog/lib";
import { StepMark, ThemeEditor, apiError } from "./parts";
import { WEB_DURATIONS, useRefreshWeb, useWeb, useWebConfig, useWebProducts, webPrice, type Provider, type WebConfig, type WebProduct } from "./lib";

const STRIPE_WRITE = "Products, Prices, Checkout Sessions, Coupons and Promotion Codes";

export function WebPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const web = useWeb(pid);
  const providers = web.data?.providers ?? [];
  const products = useWebProducts(pid, providers.map((p) => p.id));
  const [adding, setAdding] = useState(false);
  const [configFor, setConfigFor] = useState<string | null>(null);
  const [productFor, setProductFor] = useState<string | null>(null);
  const main = providers.find((p) => p.connection) ?? providers[0] ?? null;
  const c = web.data?.checklist;
  const addProvider = <button type="button" className="btn btn-dark" onClick={() => setAdding(true)}><Icon name="plus" />Add web provider</button>;

  const steps: { key: string; title: string; done: boolean; text: ReactNode; action: ReactNode }[] = c ? [
    {
      key: "stripe", title: "Connect Stripe", done: c.connect_stripe,
      text: <>Web payments run on your own Stripe account. Add a Stripe app, then on its page paste a restricted key with <b>write</b> access to {STRIPE_WRITE}, plus the read permissions listed there, and the signing secret of the Stripe webhook endpoint shown there. Connect with Stripe is not available on RevenueDot Cloud yet; a self-hosted server shows it on the same page once its operator sets it up.</>,
      action: main ? <Link className="btn btn-dark" to={`/projects/${pid}/apps/${main.id}#credentials`}>Connect Stripe</Link> : <button type="button" className="btn btn-dark" onClick={() => setAdding(true)}>Add Stripe app</button>,
    },
    {
      key: "config", title: "Add a web config", done: c.web_config,
      text: "Set how checkout looks, your legal links, what happens after payment, and the deep link that opens your app with the purchase.",
      action: <button type="button" className="btn btn-dark" disabled={!main} onClick={() => main && setConfigFor(main.id)}>{c.web_config ? "Edit web config" : "Add web config"}</button>,
    },
    {
      key: "products", title: "Create web products and prices", done: c.web_products,
      text: "Name a plan, set its price, period and free trial. RevenueDot creates the product and its price in your Stripe account and attaches it to your entitlements.",
      action: <button type="button" className="btn btn-dark" disabled={!main?.connection} onClick={() => main && setProductFor(main.id)}>Create web product</button>,
    },
    {
      key: "offering", title: "Create an offering", done: c.offering,
      text: "Add a web product to an offering's package. Purchase links and funnels sell an offering's packages.",
      action: <Link className="btn btn-dark" to={`/projects/${pid}/product-catalog/offerings/new`}>Create offering</Link>,
    },
  ] : [];
  const current = steps.findIndex((s) => !s.done);
  const done = steps.filter((s) => s.done).length;

  return (
    <Shell title="Web">
      <div className="page">
        <PageHead title="Web" sub="Configure web payment providers to sell subscriptions on the web." actions={addProvider} />
        {web.isError && <div className="banner err" role="alert">The web setup could not be loaded: {apiError(web.error).message} <button type="button" className="linkish" onClick={() => web.refetch()}>Try again</button></div>}
        {web.isLoading && <div className="panel pb subtle">Loading…</div>}
        {web.data && (
          <>
            {providers.length ? (
              <div className="panel tbl">
                <table aria-label="Web providers">
                  <thead><tr><th>Name</th><th>App ID</th><th>Public API key</th><th>Stripe</th><th>Web config</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {providers.map((p) => <ProviderRow key={p.id} p={p} pid={pid} onConfig={() => setConfigFor(p.id)} onProduct={() => setProductFor(p.id)} onOpen={() => nav(`/projects/${pid}/apps/${p.id}`)} />)}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                <h3>No web provider yet</h3>
                <p>Connect your Stripe account to sell your app's subscriptions on the web. Customers pay on a hosted checkout and get access in the app.</p>
                {addProvider}
              </div>
            )}

            <div className="wb-base">
              <span className="label">Pages live at</span>
              <code title={web.data.project_base}>{web.data.project_base}/…</code>
              <CopyButton value={web.data.project_base} label="Copy page address" />
              <Link className="linkbtn" to={`/projects/${pid}/settings/domains`}>Domains →</Link>
            </div>

            <section className="setup" aria-label="Start selling on the web">
              <div className="setup-h">
                <div><h2>Start selling on the web</h2><p>A few steps to your first web sale. Each one is checked against your project's real setup.</p></div>
                <span className="meter" aria-label={`${done} of ${steps.length} steps done`}><i>{steps.map((s) => <b key={s.key} className={s.done ? "on" : ""} />)}</i>{done}/{steps.length}</span>
              </div>
              {steps.map((s, i) => (
                <div key={s.key} className={`step${s.done ? " done" : ""}${i === current ? " next" : ""}`} data-step={s.key}>
                  <StepMark n={i + 1} done={s.done} />
                  <div>
                    <h3>{s.title}</h3>
                    {i === current && <p>{s.text}</p>}
                  </div>
                  {i === current ? <div className="go">{s.action}</div>
                    : s.done && s.key === "config" ? <button type="button" className="linkbtn go" onClick={() => main && setConfigFor(main.id)}>Edit</button> : <span />}
                </div>
              ))}
              {current < 0 && (
                <div className="wb-ready">
                  <Icon name="check" /><span>You can sell on the web. Share a purchase link or publish a funnel.</span>
                  <Link className="btn btn-line" to={`/projects/${pid}/funnels`}>Funnels and purchase links</Link>
                </div>
              )}
            </section>

            <section className="panel" aria-labelledby="wp-h">
              <div className="ph"><b id="wp-h">Web products</b>{main && c?.connect_stripe && <button type="button" className="linkbtn" onClick={() => setProductFor(main.id)}>+ Create web product</button>}</div>
              {products.data?.length ? (
                <div className="tbl">
                  <table>
                    <thead><tr><th>Name</th><th>Price</th><th>Free trial</th><th>Stripe price</th><th>Product ID</th></tr></thead>
                    <tbody>
                      {products.data.map((w) => (
                        <tr key={w.product.id}>
                          <td><b>{w.product.display_name ?? w.product.store_identifier}</b><span className="cellsub">{w.product.type === "subscription" ? "Subscription" : w.product.type === "consumable" ? "Consumable" : "One-time"}</span></td>
                          <td className="mono">{webPrice(w)}</td>
                          <td>{w.trial_days ? `${w.trial_days} days` : <span className="subtle">—</span>}</td>
                          <td className="id"><span className="hrow">{w.stripe_price_id}<CopyButton value={w.stripe_price_id} label="Copy Stripe price ID" /></span></td>
                          <td className="id"><Link className="ul" to={`/projects/${pid}/product-catalog/products/${w.product.id}`}>{w.product.id}</Link></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="pb"><p className="section-sub">{products.isLoading ? "Loading…" : "No web products yet. Each one is a product and a price in your Stripe account, and a product in your catalog."}</p></div>}
            </section>
          </>
        )}
      </div>
      {adding && <AddAppDialog pid={pid} initial="stripe" onClose={() => setAdding(false)} />}
      {configFor && <WebConfigDialog pid={pid} appId={configFor} providers={providers} onClose={() => setConfigFor(null)} />}
      {productFor && <WebProductDialog pid={pid} appId={productFor} providers={providers} onClose={() => setProductFor(null)} />}
    </Shell>
  );
}

function ProviderRow({ p, pid, onConfig, onProduct, onOpen }: { p: Provider; pid: string; onConfig: () => void; onProduct: () => void; onOpen: () => void }) {
  const items: MenuItem[] = [
    { label: p.web_config ? "Edit web config" : "Add web config", icon: "edit", onSelect: onConfig },
    { label: "Create web product", icon: "plus", onSelect: onProduct, disabled: !p.connection, hint: p.connection ? undefined : "Connect Stripe first" },
    { label: "Stripe app settings", icon: "settings", onSelect: onOpen },
  ];
  return (
    <tr className="row" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); }}>
      <td><span className="appcell"><span className="tile"><Icon name="dollar" /></span><span><b>{p.name}</b><small>Stripe</small></span></span></td>
      <td className="id"><span className="hrow" onClick={(e) => e.stopPropagation()}>{p.id}<CopyButton value={p.id} label="Copy app ID" /></span></td>
      <td><SecretText value={p.public_key} label="public API key" /></td>
      <td>{p.connection
        ? <span className="hrow"><Tag tone={p.mode === "test" ? "info" : "up"}>{p.mode === "test" ? "Test" : "Live"}</Tag><span className="subtle" style={{ fontSize: 12 }}>{p.connection === "stripe_connect" ? `Connect · ${p.connected_account ?? ""}` : "Restricted key"}</span></span>
        : <Link className="ul subtle" to={`/projects/${pid}/apps/${p.id}#credentials`} onClick={(e) => e.stopPropagation()}>Connect Stripe</Link>}</td>
      <td>{p.web_config ? <Tag tone="up">Saved</Tag> : <span className="subtle">Not set</span>}</td>
      <td className="amt"><Menu label={`Actions for ${p.name}`} items={items} /></td>
    </tr>
  );
}

/* ---------- web config ---------- */

interface ConfigForm {
  app_name: string; logo_url: string; theme: FunnelTheme; terms_url: string; privacy_url: string; support_email: string;
  success_mode: "show_redemption" | "redirect"; success_redirect_url: string; success_title: string; success_body: string; cancel_url: string;
  app_scheme: string; app_store_url: string; play_store_url: string; redemption_link_hours: string;
}
const formOf = (c: WebConfig): ConfigForm => ({
  app_name: c.app_name, logo_url: c.logo_url ?? "", theme: { ...DEFAULT_THEME, ...c.theme }, terms_url: c.terms_url ?? "", privacy_url: c.privacy_url ?? "", support_email: c.support_email ?? "",
  success_mode: c.success_mode, success_redirect_url: c.success_redirect_url ?? "", success_title: c.success_title ?? "", success_body: c.success_body ?? "", cancel_url: c.cancel_url ?? "",
  app_scheme: c.app_scheme, app_store_url: c.app_store_url ?? "", play_store_url: c.play_store_url ?? "", redemption_link_hours: String(c.redemption_link_hours),
});

export function WebConfigDialog({ pid, appId, providers, onClose }: { pid: string; appId: string; providers: Provider[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const [app, setApp] = useState(appId);
  const cfg = useWebConfig(pid, app);
  const [f, setF] = useState<ConfigForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; param: string | null } | null>(null);
  useEffect(() => { if (cfg.data) setF(formOf(cfg.data)); }, [cfg.data]);
  const set = (p: Partial<ConfigForm>) => { setF((x) => (x ? { ...x, ...p } : x)); setErr(null); };
  const fe = (k: string) => (err?.param === k ? err.message : null);
  const scheme = f?.app_scheme.trim() || "yourapp";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!f) return;
    const opt = (v: string) => (v.trim() ? v.trim() : null);
    const hours = Number(f.redemption_link_hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) { setErr({ message: "The redemption link lifetime is a whole number of hours from 1 to 720.", param: "redemption_link_hours" }); return; }
    if (f.success_mode === "redirect" && !f.success_redirect_url.trim()) { setErr({ message: "Enter the https URL to send customers to after payment.", param: "success_redirect_url" }); return; }
    setBusy(true);
    try {
      await api(`${v2(pid)}/apps/${app}/web_config`, { method: "PUT", json: {
        app_name: f.app_name.trim() || undefined, logo_url: opt(f.logo_url), theme: f.theme, terms_url: opt(f.terms_url), privacy_url: opt(f.privacy_url),
        support_email: opt(f.support_email), success_mode: f.success_mode, success_redirect_url: opt(f.success_redirect_url), success_title: opt(f.success_title),
        success_body: opt(f.success_body), cancel_url: opt(f.cancel_url), app_scheme: f.app_scheme.trim() || undefined, app_store_url: opt(f.app_store_url),
        play_store_url: opt(f.play_store_url), redemption_link_hours: hours,
      } });
      await refresh();
      toast("Web config saved.");
      onClose();
    } catch (x) { setErr(apiError(x)); setBusy(false); }
  };
  const url = (k: "logo_url" | "terms_url" | "privacy_url" | "cancel_url" | "app_store_url" | "play_store_url" | "success_redirect_url", label: string, placeholder: string, hint?: string) => (
    <Field label={label} htmlFor={`wc-${k}`} hint={hint} error={fe(k)}>
      <input id={`wc-${k}`} className="input" inputMode="url" placeholder={placeholder} value={f![k]} aria-invalid={!!fe(k)} onChange={(e) => set({ [k]: e.target.value })} />
    </Field>
  );
  return (
    <Dialog title="Web config" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="web-config" className="btn btn-dark" disabled={busy || !f}>{busy ? "Saving…" : "Save web config"}</button>
    </>}>
      {cfg.isError && <div className="banner err" role="alert">{apiError(cfg.error).message}</div>}
      {!f ? <p className="subtle">Loading…</p> : (
        <form id="web-config" className="stack wc-form" onSubmit={save} noValidate>
          {providers.length > 1 && (
            <Field label="Stripe app" htmlFor="wc-app">
              <select id="wc-app" className="select" value={app} onChange={(e) => { setApp(e.target.value); setF(null); }}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </Field>
          )}
          <fieldset className="wc-sec"><legend className="label">Checkout look</legend>
            <div className="cols">
              <Field label="App name" htmlFor="wc-app_name" hint="Shown at the top of every page." error={fe("app_name")}>
                <input id="wc-app_name" className="input" maxLength={80} value={f.app_name} onChange={(e) => set({ app_name: e.target.value })} />
              </Field>
              {url("logo_url", "Logo URL", "https://yourapp.com/logo.png", "Optional. An https image, shown instead of the name.")}
            </div>
            <ThemeEditor idBase="wc-theme" theme={f.theme} presets={cfg.data?.presets ?? []} onChange={(theme) => set({ theme })} />
          </fieldset>
          <fieldset className="wc-sec"><legend className="label">Legal and support</legend>
            <div className="cols">
              {url("terms_url", "Terms URL", "https://yourapp.com/terms")}
              {url("privacy_url", "Privacy URL", "https://yourapp.com/privacy")}
              <Field label="Support email" htmlFor="wc-support_email" error={fe("support_email")}>
                <input id="wc-support_email" className="input" type="email" placeholder="help@yourapp.com" value={f.support_email} onChange={(e) => set({ support_email: e.target.value })} />
              </Field>
              {url("cancel_url", "Cancel URL", "https://yourapp.com", "Optional. Where Stripe's back link goes; without it, back to the page.")}
            </div>
          </fieldset>
          <fieldset className="wc-sec"><legend className="label">After payment</legend>
            <Segmented label="After payment" value={f.success_mode} onChange={(v) => set({ success_mode: v })} options={[{ value: "show_redemption", label: "Show the redemption page" }, { value: "redirect", label: "Redirect to my URL" }]} />
            {f.success_mode === "redirect" ? url("success_redirect_url", "Redirect URL", "https://yourapp.com/welcome", "RevenueDot adds ?redemption_url=… so your page can show the link that opens the app.") : (
              <div className="cols">
                <Field label="Success title" htmlFor="wc-success_title" hint="Optional. Default: Thank you for your purchase.">
                  <input id="wc-success_title" className="input" maxLength={120} value={f.success_title} onChange={(e) => set({ success_title: e.target.value })} />
                </Field>
                <Field label="Success text" htmlFor="wc-success_body" hint="Optional. A line under the title.">
                  <input id="wc-success_body" className="input" maxLength={600} value={f.success_body} onChange={(e) => set({ success_body: e.target.value })} />
                </Field>
              </div>
            )}
          </fieldset>
          <fieldset className="wc-sec"><legend className="label">Open the app</legend>
            <Field label="Deep link scheme" htmlFor="wc-app_scheme" error={fe("app_scheme")}
              hint="Your app must register this URL scheme and pass the link to the SDK's redeemWebPurchase. Customers who paid without signing in get the purchase when the app opens it.">
              <input id="wc-app_scheme" className="input mono" spellCheck={false} autoCapitalize="off" value={f.app_scheme} aria-invalid={!!fe("app_scheme")} onChange={(e) => set({ app_scheme: e.target.value.toLowerCase() })} />
            </Field>
            <div className="field">
              <span className="flabel">Redemption link</span>
              <CopyField value={`${scheme}://redeem_web_purchase?redemption_token=…`} label="redemption link format" />
            </div>
            <div className="cols">
              {url("app_store_url", "App Store URL", "https://apps.apple.com/app/id…", "Shown on the success page for people without the app.")}
              {url("play_store_url", "Google Play URL", "https://play.google.com/store/apps/details?id=…")}
              <Field label="Redemption link lifetime (hours)" htmlFor="wc-hours" error={fe("redemption_link_hours")} hint="After this the link expires and the SDK asks for a new one, which is emailed.">
                <input id="wc-hours" className="input mono" inputMode="numeric" value={f.redemption_link_hours} onChange={(e) => set({ redemption_link_hours: e.target.value })} />
              </Field>
            </div>
          </fieldset>
          {err && !["redemption_link_hours", "app_scheme", "support_email", "logo_url", "terms_url", "privacy_url", "cancel_url", "app_store_url", "play_store_url", "success_redirect_url", "app_name"].includes(err.param ?? "") && <div className="banner err" role="alert">{err.message}</div>}
        </form>
      )}
    </Dialog>
  );
}

/* ---------- web products ---------- */

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "SEK", "BRL", "INR"];

export function WebProductDialog({ pid, appId, providers, onClose }: { pid: string; appId: string; providers: Provider[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const ents = useEntitlements(pid);
  const [app, setApp] = useState(appId);
  const [mode, setMode] = useState<"create" | "link">("create");
  const [name, setName] = useState("");
  const [type, setType] = useState<"subscription" | "non_consumable" | "consumable">("subscription");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [duration, setDuration] = useState("P1M");
  const [trial, setTrial] = useState("");
  const [priceId, setPriceId] = useState("");
  const [entIds, setEntIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; param: string | null } | null>(null);
  useEffect(() => { if (ents.data?.length === 1 && !entIds.length) setEntIds([ents.data[0]!.id]); }, [ents.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const fe = (k: string) => (err?.param === k ? err.message : null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) { setErr({ message: "Give the product a name, for example Pro monthly.", param: "display_name" }); return; }
    const body: Record<string, unknown> = { display_name: name.trim(), type, ...(entIds.length ? { entitlement_ids: entIds } : {}) };
    if (mode === "link") {
      if (!/^price_[A-Za-z0-9_]+$/.test(priceId.trim())) { setErr({ message: "A Stripe price ID starts with price_.", param: "stripe_price_id" }); return; }
      body.stripe_price_id = priceId.trim();
    } else {
      const n = Number(amount);
      if (!amount.trim() || !Number.isFinite(n) || n <= 0) { setErr({ message: "Enter a price above zero, like 9.99.", param: "price" }); return; }
      body.price = { amount: n, currency };
      if (type === "subscription") body.duration = duration;
    }
    if (type === "subscription" && trial.trim()) {
      const t = Number(trial);
      if (!Number.isInteger(t) || t < 1 || t > 730) { setErr({ message: "A free trial is a whole number of days from 1 to 730.", param: "trial_days" }); return; }
      body.trial_days = t;
    }
    setBusy(true);
    try {
      const w = await api<WebProduct>(`${v2(pid)}/apps/${app}/web_products`, { method: "POST", json: body });
      await refresh();
      toast(`${w.product.display_name ?? "Web product"} created in Stripe.`);
      onClose();
    } catch (x) { setErr(apiError(x)); setBusy(false); }
  };
  return (
    <Dialog title="Create web product" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="web-product" className="btn btn-dark" disabled={busy}>{busy ? "Creating in Stripe…" : "Create product"}</button>
    </>}>
      <form id="web-product" className="stack" onSubmit={save} noValidate>
        {providers.length > 1 && (
          <Field label="Stripe app" htmlFor="wp-app">
            <select id="wp-app" className="select" value={app} onChange={(e) => setApp(e.target.value)}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </Field>
        )}
        <Segmented label="Price source" value={mode} onChange={(v) => { setMode(v); setErr(null); }} options={[{ value: "create", label: "Create in Stripe" }, { value: "link", label: "Link an existing Stripe price" }]} />
        <Field label="Name" htmlFor="wp-name" error={fe("display_name")} hint="Customers see it on the checkout and in Stripe receipts.">
          <input id="wp-name" className="input" maxLength={120} placeholder="Pro monthly" value={name} aria-invalid={!!fe("display_name")} onChange={(e) => { setName(e.target.value); setErr(null); }} />
        </Field>
        <Field label="Type" htmlFor="wp-type">
          <select id="wp-type" className="select" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="subscription">Subscription (renews every period)</option>
            <option value="non_consumable">One-time (owned forever)</option>
            <option value="consumable">Consumable (bought again and again)</option>
          </select>
        </Field>
        {mode === "create" ? (
          <>
            <div className="cols">
              <Field label="Price" htmlFor="wp-amount" error={fe("price")}>
                <input id="wp-amount" className="input mono" inputMode="decimal" placeholder="9.99" value={amount} aria-invalid={!!fe("price")} onChange={(e) => { setAmount(e.target.value); setErr(null); }} />
              </Field>
              <Field label="Currency" htmlFor="wp-currency">
                <select id="wp-currency" className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
              </Field>
            </div>
            {type === "subscription" && (
              <Field label="Billing period" htmlFor="wp-period" error={fe("duration")}>
                <select id="wp-period" className="select" value={duration} onChange={(e) => setDuration(e.target.value)}>{WEB_DURATIONS.map((d) => <option key={d.iso} value={d.iso}>{d.label}</option>)}</select>
              </Field>
            )}
          </>
        ) : (
          <Field label="Stripe price ID" htmlFor="wp-price-id" error={fe("stripe_price_id")} hint="From the Stripe Dashboard → Product catalog → the price. RevenueDot reads its amount and period.">
            <input id="wp-price-id" className="input mono" spellCheck={false} placeholder="price_…" value={priceId} aria-invalid={!!fe("stripe_price_id")} onChange={(e) => { setPriceId(e.target.value); setErr(null); }} />
          </Field>
        )}
        {type === "subscription" && (
          <Field label="Free trial (days)" htmlFor="wp-trial" error={fe("trial_days")} hint="Optional. Leave empty for no trial.">
            <input id="wp-trial" className="input mono" inputMode="numeric" placeholder="7" value={trial} onChange={(e) => { setTrial(e.target.value); setErr(null); }} />
          </Field>
        )}
        <fieldset className="wc-sec">
          <legend className="flabel">Entitlements</legend>
          {ents.data?.length ? (
            <div className="wb-checks">
              {ents.data.map((x) => (
                <label key={x.id} className="check">
                  <input type="checkbox" checked={entIds.includes(x.id)} onChange={(e) => setEntIds((ids) => (e.target.checked ? [...ids, x.id] : ids.filter((i) => i !== x.id)))} />
                  <span><b>{x.display_name}</b><small className="mono">{x.lookup_key}</small></span>
                </label>
              ))}
            </div>
          ) : <p className="section-sub">{ents.isLoading ? "Loading…" : <>No entitlements yet. <Link className="ul" to={`/projects/${pid}/product-catalog/entitlements`}>Create one</Link> to unlock access with this product.</>}</p>}
        </fieldset>
        {err && !["display_name", "price", "stripe_price_id", "trial_days", "duration"].includes(err.param ?? "") && <div className="banner err" role="alert">{err.message}</div>}
      </form>
    </Dialog>
  );
}
