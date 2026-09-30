import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { Dialog, Field, STORE_LABEL, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import {
  DURATIONS, ISO_PERIOD, PRODUCT_TYPES, STORE_CODE, appIdentifier, durationLabel, errMsg, errParam, isConflict, productName, storeIdHelp, useRefreshCatalog, v2,
  type App, type Product,
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
  const [f, setF] = useState({ app_id: appId ?? apps[0]?.id ?? "", store_identifier: "", type: "subscription", duration: "P1M", display_name: "" });
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
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const p = await api<Product>(`${v2(pid)}/products`, { method: "POST", json: {
        app_id: f.app_id, store_identifier: f.store_identifier.trim(), type: f.type, display_name: f.display_name.trim() || null,
        ...(f.type === "subscription" ? { subscription: { duration: f.duration } } : {}),
      } });
      await onCreated?.(p);
      await refresh();
      toast(`Product ${p.store_identifier} created`);
      onClose();
    } catch (err) {
      const param = errParam(err);
      if (isConflict(err)) setErrors({ store_identifier: `${app?.name ?? "This app"} already has a product with this identifier.` });
      else if (param === "subscription.duration" || param === "subscription") setErrors({ duration: errMsg(err) });
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
        <Field label="Display name" htmlFor="np-name" error={errors.display_name} hint="Optional. Shown in the dashboard instead of the store identifier.">
          <input id="np-name" className="input" placeholder="e.g. Pro monthly" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        </Field>
        {errors.form && <div className="banner err" role="alert">{errors.form}</div>}
        <p className="cat-note" style={{ margin: 0 }}><Icon name="docs" />Importing products from App Store Connect and Google Play comes in a later release.</p>
      </form>
    </Dialog>
  );
}

export function EditProductDialog({ pid, product, onClose }: { pid: string; product: Product; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [name, setName] = useState(product.display_name ?? "");
  const [type, setType] = useState(product.type);
  const [duration, setDuration] = useState(product.subscription?.duration ?? "P1M");
  const [error, setError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (type === "subscription" && !ISO_PERIOD.test(duration)) { setError({ duration: "Enter an ISO 8601 period such as P1M, P1Y or P3D." }); return; }
    setBusy(true); setError({});
    try {
      await api(`${v2(pid)}/products/${product.id}`, { method: "POST", json: { display_name: name.trim(), type, ...(type === "subscription" ? { subscription: { duration } } : {}) } });
      await refresh();
      toast("Product saved");
      onClose();
    } catch (err) { setError(errParam(err)?.startsWith("subscription") ? { duration: errMsg(err) } : { form: errMsg(err) }); setBusy(false); }
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
        {error.form && <div className="banner err" role="alert">{error.form}</div>}
      </form>
    </Dialog>
  );
}

/** A labelled value row for detail headers when KeyValue needs a custom cell. */
export const Mono = ({ children }: { children: ReactNode }) => <span className="mono" style={{ fontSize: 12.5 }}>{children}</span>;

export { productName };
