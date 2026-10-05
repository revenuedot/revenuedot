import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../lib/api";
import { Dialog, Field, STORE_LABEL, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import {
  COMMON_CURRENCIES, DURATIONS, ISO_PERIOD, PRODUCT_TYPES, STORE_CODE, appIdentifier, durationLabel, errMsg, errParam, isConflict, productName, storeIdHelp, testStorePrice, useApps, useRefreshCatalog, v2,
  type App, type Product, type ProductPrice,
} from "./lib";
import "./catalog.css";

/** Shared pieces of the product catalog pages. */

export function StoreMark({ type }: { type: string }) {
  return <span className="cat-store" title={STORE_LABEL[type] ?? type} aria-label={STORE_LABEL[type] ?? type}>{STORE_CODE[type] ?? "··"}</span>;
}

export function AppName({ app, sub }: { app: App | undefined; sub?: boolean }) {
  if (!app) return <span className="subtle">Deleted app</span>;
  return (
    <span className="cat-app"><StoreMark type={app.type} />
      {sub ? <span className="cat-cell"><b className="cat-t">{app.name}</b><span className="cat-s">{STORE_LABEL[app.type] ?? app.type}{appIdentifier(app) ? ` · ${appIdentifier(app)}` : ""}</span></span> : <b>{app.name}</b>}
    </span>
  );
}

/** Display name over the store identifier, like RevenueCat's product cells. */
export function ProductCell({ p, to }: { p: Product; to?: string }) {
  const name = p.display_name && p.display_name !== p.store_identifier ? p.display_name : null;
  const main = to ? <Link className="cat-lnk cat-t" to={to} onClick={(e) => e.stopPropagation()}>{name ?? p.store_identifier}</Link> : <span className="cat-t">{name ?? p.store_identifier}</span>;
  return <span className="cat-cell">{main}{name && <span className="cat-s">{p.store_identifier}</span>}</span>;
}

export function CatalogCrumbs({ pid, section, sectionTo, current }: { pid: string; section: string; sectionTo?: string; current?: string }) {
  const base = `/projects/${pid}/product-catalog`;
  return (
    <>
      <Link className="cat-crumb-up" to={`${base}/offerings`}>Product catalog</Link> <span className="cat-crumb-up">/</span>{" "}
      {current ? <><Link className="cat-crumb" to={`${base}/${sectionTo}`}>{section}</Link> <span>/</span> <b className="cat-crumb-cur" title={current}>{current}</b></> : <b className="cat-crumb">{section}</b>}
    </>
  );
}

/** Placeholder rows while a table loads. */
export function LoadingRows({ rows = 3, label }: { rows?: number; label: string }) {
  return <div className="panel" role="status" aria-label={label}>{Array.from({ length: rows }, (_, i) => <div key={i} className="cat-loadrow"><i /><i /><i /></div>)}</div>;
}

export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="banner err" role="alert">
      <div style={{ flex: 1 }}><b>Could not load this page.</b> {errMsg(error)}</div>
      <button type="button" className="btn btn-line" onClick={retry}>Retry</button>
    </div>
  );
}

/** Duration picker: RevenueCat's presets plus a custom ISO 8601 period. */
export function DurationField({ id, value, onChange, error }: { id: string; value: string; onChange: (v: string) => void; error?: string | null }) {
  const preset = DURATIONS.some((d) => d.iso === value);
  const [custom, setCustom] = useState(!preset && value !== "");
  return (
    <Field label="Duration" htmlFor={id} error={error} hint={custom ? <>An ISO 8601 period, e.g. <code>P3D</code> (3 days) or <code>P2W</code> (2 weeks). {value && ISO_PERIOD.test(value) ? `Reads as ${durationLabel(value)}.` : ""}</> : "How often the subscription renews."}>
      <div className="cat-row2">
        <select id={id} className="select" value={custom ? "custom" : value} onChange={(e) => {
          if (e.target.value === "custom") { setCustom(true); onChange(""); } else { setCustom(false); onChange(e.target.value); }
        }}>
          {DURATIONS.map((d) => <option key={d.iso} value={d.iso}>{d.label} ({d.iso})</option>)}
          <option value="custom">Custom…</option>
        </select>
        {custom && <input className="input mono" aria-label="Custom ISO 8601 duration" placeholder="P3D" value={value} onChange={(e) => onChange(e.target.value.toUpperCase().trim())} />}
      </div>
    </Field>
  );
}

/**
 * Test Store price: what the SDK shows for this product and what a test purchase records as revenue. Amount plus an
 * ISO 4217 currency code (USD by default). Required when creating a Test Store product, optional when editing one.
 */
export function TestStorePriceField({ id = "tsp", amount, currency, onAmount, onCurrency, error, invalid = "amount", required }: { id?: string; amount: string; currency: string; onAmount: (v: string) => void; onCurrency: (v: string) => void; error?: string | null; invalid?: "amount" | "currency"; required?: boolean }) {
  return (
    <Field label="Price" htmlFor={`${id}-amount`} error={error} hint={required ? "What the SDK shows for this Test Store product. Test purchases record it as revenue." : "What the SDK shows for this Test Store product and what test purchases record. Leave the amount empty for no price."}>
      <div className="cat-price">
        <input id={`${id}-amount`} className="input mono" aria-label="Price amount" aria-required={required} aria-invalid={!!error && invalid === "amount"} inputMode="decimal" autoComplete="off" placeholder="9.99" value={amount} onChange={(e) => onAmount(e.target.value)} />
        <input className="input mono" aria-label="Currency" aria-invalid={!!error && invalid === "currency"} list={`${id}-currencies`} maxLength={3} autoComplete="off" spellCheck={false} placeholder="USD" value={currency} onChange={(e) => onCurrency(e.target.value.toUpperCase().trim())} />
        <datalist id={`${id}-currencies`}>{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
      </div>
    </Field>
  );
}

const microsToAmount = (m: number | undefined) => (m === undefined ? "" : String(m / 1_000_000));

function TypeRadios({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <span className="cat-flabel" id="ptype-l">Type</span>
      <div className="cat-radios" role="radiogroup" aria-labelledby="ptype-l">
        {PRODUCT_TYPES.map((t) => (
          <label key={t.value}><input type="radio" name="ptype" value={t.value} checked={value === t.value} onChange={() => onChange(t.value)} />{t.label}<span>{t.help}</span></label>
        ))}
      </div>
    </div>
  );
}

/**
 * New product. Opened from the Products page, the offering editor ("New product" next to an app) and an
 * entitlement ("New"). `onCreated` receives the created product so callers can select or attach it.
 */
export function NewProductDialog({ pid, apps, appId, onClose, onCreated }: { pid: string; apps: App[]; appId?: string; onClose: () => void; onCreated?: (p: Product) => void | Promise<void> }) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [f, setF] = useState({ app_id: appId ?? apps[0]?.id ?? "", store_identifier: "", type: "subscription", duration: "P1M", display_name: "", price: "", currency: "USD" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const app = apps.find((a) => a.id === f.app_id);
  const help = storeIdHelp(app?.type);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!f.app_id) er.app_id = "Choose the app this product is sold in.";
    if (!f.store_identifier.trim()) er.store_identifier = "Enter the product's identifier in the store.";
    else if (/\s/.test(f.store_identifier.trim())) er.store_identifier = "Store identifiers cannot contain spaces.";
    if (f.type === "subscription" && !ISO_PERIOD.test(f.duration)) er.duration = "Enter an ISO 8601 period such as P1M, P1Y or P3D.";
    const price = app?.type === "test_store" ? testStorePrice(f.price, f.currency, true) : { value: null };
    if ("error" in price) er[price.field === "currency" ? "test_store_currency" : "test_store_price"] = price.error;
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const p = await api<Product>(`${v2(pid)}/products`, { method: "POST", json: {
        app_id: f.app_id, store_identifier: f.store_identifier.trim(), type: f.type, display_name: f.display_name.trim() || null,
        ...(f.type === "subscription" ? { subscription: { duration: f.duration } } : {}),
        ...("value" in price && price.value ? { test_store_price: price.value } : {}),
      } });
      await onCreated?.(p);
      await refresh();
      toast(`Product ${p.store_identifier} created`);
      onClose();
    } catch (err) {
      const param = errParam(err);
      if (isConflict(err)) setErrors({ store_identifier: `${app?.name ?? "This app"} already has a product with this identifier.` });
      else if (param === "subscription.duration" || param === "subscription") setErrors({ duration: errMsg(err) });
      else if (param?.startsWith("test_store_price")) setErrors({ [param === "test_store_price.currency" ? "test_store_currency" : "test_store_price"]: errMsg(err) });
      else if (param && ["app_id", "store_identifier", "display_name", "type"].includes(param)) setErrors({ [param]: errMsg(err) });
      else setErrors({ form: errMsg(err) });
      setBusy(false);
    }
  }
  return (
    <Dialog title="New product" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="new-product" className="btn btn-dark" disabled={busy}>{busy ? "Creating…" : "Create product"}</button>
    </>}>
      <form id="new-product" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="App" htmlFor="np-app" error={errors.app_id}>
          <select id="np-app" className="select" value={f.app_id} disabled={!!appId} onChange={(e) => setF({ ...f, app_id: e.target.value })}>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.name} ({STORE_LABEL[a.type] ?? a.type})</option>)}
          </select>
        </Field>
        <Field label="Store identifier" htmlFor="np-sid" error={errors.store_identifier} hint={`${help.hint} It cannot be changed later.`}>
          <input id="np-sid" className="input mono" autoFocus autoComplete="off" spellCheck={false} placeholder={help.placeholder} value={f.store_identifier} onChange={(e) => setF({ ...f, store_identifier: e.target.value })} />
        </Field>
        <TypeRadios value={f.type} onChange={(type) => setF({ ...f, type })} />
        {f.type === "subscription" && <DurationField id="np-dur" value={f.duration} onChange={(duration) => setF({ ...f, duration })} error={errors.duration} />}
        {app?.type === "test_store" && <TestStorePriceField id="np-price" required amount={f.price} currency={f.currency} onAmount={(price) => setF({ ...f, price })} onCurrency={(currency) => setF({ ...f, currency })} error={errors.test_store_price ?? errors.test_store_currency} invalid={errors.test_store_currency ? "currency" : "amount"} />}
        <Field label="Display name" htmlFor="np-name" error={errors.display_name} hint="Optional. Shown in the dashboard instead of the store identifier.">
          <input id="np-name" className="input" placeholder="e.g. Pro monthly" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        </Field>
        {errors.form && <div className="banner err" role="alert">{errors.form}</div>}
        {app && ["app_store", "mac_app_store", "play_store", "stripe", "paddle", "galaxy"].includes(app.type) && <p className="cat-note" style={{ margin: 0 }}><Icon name="docs" />Already set up in {({ play_store: "Google Play", stripe: "Stripe", paddle: "Paddle", galaxy: "Samsung Seller Portal" } as Record<string, string>)[app.type] ?? "App Store Connect"}? Use Import products on the Products page to bring products over with their type and duration.</p>}
      </form>
    </Dialog>
  );
}

/** One currency row of the Test Store price editor. `key` keeps React's row identity while the currency is edited. */
interface PriceRow { key: number; currency: string; amount: string; saved: { currency: string; amount_micros: number } | null }
let rowKey = 0;
const toRow = (p: ProductPrice): PriceRow => ({ key: ++rowKey, currency: p.currency, amount: microsToAmount(p.amount_micros), saved: p });

/** Test Store prices of a product, default first (`GET …/products/{id}/prices`). */
export function useProductPrices(pid: string, product: Product, enabled: boolean) {
  return useQuery({ queryKey: ["products", pid, "prices", product.id], enabled, queryFn: () => api<ProductPrice[]>(`${v2(pid)}/products/${product.id}/prices`) });
}

/**
 * The Test Store price editor: one row per currency, one of them the default (shown when no price matches the customer's
 * currency, and the product's `indicative_price`). The SDK shows each customer the price in their storefront's currency.
 */
function PriceRows({ rows, def, onRows, onDefault, error }: { rows: PriceRow[]; def: number | null; onRows: (r: PriceRow[]) => void; onDefault: (k: number) => void; error: Record<string, string> }) {
  const set = (k: number, patch: Partial<PriceRow>) => onRows(rows.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  return (
    <div className="field" role="group" aria-labelledby="ep-prices-l">
      <span className="cat-flabel" id="ep-prices-l">Prices</span>
      <p className="hint cat-phint">Customers see the price in their store's currency; the default is shown everywhere else. Test purchases record the price shown.</p>
      {rows.length > 0 && (
        <div className="cat-prices">
          {rows.map((r, i) => (
            <div key={r.key} className="cat-cur" data-testid="price-row">
              <label className="cat-pdef"><input type="radio" name="ep-default" checked={def === r.key} onChange={() => onDefault(r.key)} aria-label={`Default price ${r.currency || `row ${i + 1}`}`} />Default</label>
              <input className="input mono" aria-label={`Currency ${i + 1}`} aria-invalid={!!error[`c${r.key}`]} list="ep-currencies" maxLength={3} autoComplete="off" spellCheck={false} placeholder="EUR" value={r.currency} onChange={(e) => set(r.key, { currency: e.target.value.toUpperCase().trim() })} />
              <input className="input mono" aria-label={`Amount ${i + 1}`} aria-invalid={!!error[`a${r.key}`]} inputMode="decimal" autoComplete="off" placeholder="9.99" value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} />
              <button type="button" className="btn btn-ghost" aria-label={`Remove ${r.currency || `row ${i + 1}`} price`} onClick={() => onRows(rows.filter((x) => x.key !== r.key))}><Icon name="close" /></button>
              {(error[`c${r.key}`] || error[`a${r.key}`]) && <div className="err cat-perr" role="alert">{error[`c${r.key}`] ?? error[`a${r.key}`]}</div>}
            </div>
          ))}
        </div>
      )}
      {!rows.length && <p className="hint cat-phint">No price. The SDK shows USD 0.00.</p>}
      <datalist id="ep-currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
      <div><button type="button" className="btn btn-line" onClick={() => {
        const used = new Set(rows.map((r) => r.currency));
        const row = { key: ++rowKey, currency: COMMON_CURRENCIES.find((c) => !used.has(c)) ?? "", amount: "", saved: null };
        onRows([...rows, row]);
        if (def === null) onDefault(row.key);
      }}><Icon name="plus" />Add currency</button></div>
    </div>
  );
}

export function EditProductDialog({ pid, product, onClose }: { pid: string; product: Product; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [name, setName] = useState(product.display_name ?? "");
  const [type, setType] = useState(product.type);
  const [duration, setDuration] = useState(product.subscription?.duration ?? "P1M");
  const isTestStore = useApps(pid).data?.find((a) => a.id === product.app_id)?.type === "test_store";
  const prices = useProductPrices(pid, product, isTestStore);
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [def, setDef] = useState<number | null>(null);
  // The currencies the rows were built from: a save removes only a currency the editor showed.
  const [shown, setShown] = useState<string[]>([]);
  // The rows start from the saved prices once they load (default first).
  if (isTestStore && rows === null && prices.data) {
    const r = prices.data.map(toRow);
    setRows(r); setDef(r[0]?.key ?? null); setShown(prices.data.map((p) => p.currency));
  }
  const [error, setError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const editRows = (next: PriceRow[]) => {
    setRows(next);
    if (def !== null && !next.some((r) => r.key === def)) setDef(next[0]?.key ?? null);
  };
  /** Each row as a price, or the errors keyed by row (`c<key>` currency, `a<key>` amount). */
  function checkRows(list: PriceRow[]) {
    const errs: Record<string, string> = {};
    const out: { key: number; currency: string; amount_micros: number }[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      // A row left as saved is kept as is, even when it has more decimals than the editor would accept for a new price.
      if (r.saved && r.currency === r.saved.currency && r.amount === microsToAmount(r.saved.amount_micros)) {
        if (seen.has(r.currency)) { errs[`c${r.key}`] = `${r.currency} is listed twice.`; continue; }
        seen.add(r.currency);
        out.push({ key: r.key, currency: r.saved.currency, amount_micros: r.saved.amount_micros });
        continue;
      }
      const v = testStorePrice(r.amount, r.currency);
      if ("error" in v) { errs[`${v.field === "currency" ? "c" : "a"}${r.key}`] = v.error; continue; }
      if (!v.value) { errs[`a${r.key}`] = "Enter the price, such as 9.99, or remove the row."; continue; }
      if (seen.has(v.value.currency)) { errs[`c${r.key}`] = `${v.value.currency} is listed twice.`; continue; }
      seen.add(v.value.currency);
      out.push({ key: r.key, ...v.value });
    }
    return { errs, out };
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (type === "subscription" && !ISO_PERIOD.test(duration)) { setError({ duration: "Enter an ISO 8601 period such as P1M, P1Y or P3D." }); return; }
    // Prices that could not be loaded are left as they are; the name, type and duration still save.
    const withPrices = isTestStore && rows !== null;
    if (isTestStore && rows === null && !prices.isError) { setError({ form: "Prices are still loading." }); return; }
    const { errs, out } = withPrices ? checkRows(rows!) : { errs: {}, out: [] };
    if (Object.keys(errs).length) { setError(errs); return; }
    const defPrice = out.find((p) => p.key === def) ?? out[0] ?? null;
    setBusy(true); setError({});
    try {
      await api(`${v2(pid)}/products/${product.id}`, { method: "POST", json: {
        display_name: name.trim(), type, ...(type === "subscription" ? { subscription: { duration } } : {}),
        ...(withPrices ? { test_store_price: defPrice ? { amount_micros: defPrice.amount_micros, currency: defPrice.currency } : null } : {}),
      } });
      if (withPrices && defPrice) {
        // The default is saved with the product; the other currencies through the prices endpoints. Adds and changes are
        // compared with the server's latest prices; removals cover only currencies this editor showed.
        const saved = new Map((prices.data ?? []).map((p) => [p.currency, p.amount_micros]));
        const others = out.filter((p) => p.currency !== defPrice.currency);
        const added = others.filter((p) => !saved.has(p.currency));
        const changed = others.filter((p) => saved.has(p.currency) && saved.get(p.currency) !== p.amount_micros);
        const kept = new Set(out.map((p) => p.currency));
        const base = `${v2(pid)}/products/${product.id}`;
        if (added.length) await api(`${base}/test_store_prices`, { method: "POST", json: { prices: added.map(({ currency, amount_micros }) => ({ currency, amount_micros })) } });
        for (const p of changed) await api(`${base}/prices/${p.currency}`, { method: "PATCH", json: { amount_micros: p.amount_micros } });
        // A currency already removed by an earlier, half-finished save answers 404: it is gone either way.
        for (const c of shown) if (!kept.has(c)) await api(`${base}/prices/${c}`, { method: "DELETE" }).catch((e) => { if (!(e instanceof ApiError && e.status === 404)) throw e; });
      }
      await refresh();
      toast("Product saved");
      onClose();
    } catch (err) {
      const param = errParam(err);
      setError(param?.startsWith("subscription") ? { duration: errMsg(err) } : { form: errMsg(err) });
      // Part of the save may have landed: compare the next try with what the server has now.
      if (isTestStore) await prices.refetch();
      setBusy(false);
    }
  }
  return (
    <Dialog title="Edit product" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="edit-product" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </>}>
      <form id="edit-product" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Store identifier" htmlFor="ep-sid" hint="Store identifiers cannot be changed. Create a new product instead.">
          <input id="ep-sid" className="input mono" value={product.store_identifier} disabled />
        </Field>
        <Field label="Display name" htmlFor="ep-name" hint="Leave empty to show the store identifier.">
          <input id="ep-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <TypeRadios value={type} onChange={setType} />
        {type === "subscription" && <DurationField id="ep-dur" value={duration} onChange={setDuration} error={error.duration} />}
        {isTestStore && (rows === null && prices.isError ? (
          <div className="banner err" role="alert">
            The prices could not be loaded, so saving keeps them as they are. {errMsg(prices.error)}{" "}
            <button type="button" className="btn btn-line" onClick={() => void prices.refetch()} disabled={prices.isFetching}>Retry</button>
          </div>
        )
          : rows === null ? <p className="hint">Loading prices…</p>
          : <PriceRows rows={rows} def={def} onRows={editRows} onDefault={setDef} error={error} />)}
        {error.form && <div className="banner err" role="alert">{error.form}</div>}
      </form>
    </Dialog>
  );
}

/** A labelled value row for detail headers when KeyValue needs a custom cell. */
export const Mono = ({ children }: { children: ReactNode }) => <span className="mono" style={{ fontSize: 12.5 }}>{children}</span>;

export { productName };
