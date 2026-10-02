/**
 * Import products from the store: the dialog behind "Import products" on the Products page and on each app's page.
 * Lists what App Store Connect, Google Play or Stripe has for the app (GET /v2/projects/{id}/apps/{app_id}/store_products),
 * with search, select all, rows already in the catalog disabled and an optional entitlement picker, then creates the
 * chosen products (POST …/store_products/actions/import) and shows what was created, skipped and failed.
 * Amazon has no product API, so the dialog shows the server's explanation instead of a list.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type List } from "../../lib/api";
import { Check, Dialog, Field, STORE_LABEL, StatusLine, Tag, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { catalogKey, count, durationLabel, errMsg, priceLabel, typeLabel, useEntitlements, v2, type App, type Product } from "./lib";
import "./catalog.css";

export interface StoreListing {
  object: "store_product_listing"; store_identifier: string; type: string; display_name: string | null; duration: string | null;
  store_state: string | null; group: { id: string; name: string | null } | null; price: { amount_micros: number; currency: string } | null;
  importable: boolean; note: string | null; in_catalog: boolean; product_id: string | null;
}
interface Listing extends List<StoreListing> { app_id: string; store: string; warnings: string[] }
interface ImportResult {
  created: Product[]; existing: Product[]; entitlement_ids: string[];
  failed: { store_identifier: string; reason: string; message: string }[];
}

/** Stores the dialog can read from (Amazon is listed so the dialog can explain why it cannot). */
export const IMPORT_STORES = new Set(["app_store", "mac_app_store", "play_store", "stripe", "amazon"]);
const SOURCE: Record<string, string> = { app_store: "App Store Connect", mac_app_store: "App Store Connect", play_store: "Google Play", stripe: "Stripe", amazon: "Amazon" };

const CREDENTIAL: Record<string, string> = { app_store: "App Store Connect API key", mac_app_store: "App Store Connect API key", play_store: "service account", stripe: "restricted key" };

const storeProductsKey = (pid: string, appId: string) => ["store-products", pid, appId] as const;

function SelectBox({ checked, indeterminate, disabled, onChange, label }: { checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <label className={`check imp-box${disabled ? " off" : ""}`} onClick={(e) => e.stopPropagation()}>
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function ImportProductsDialog({ pid, apps, appId, onClose }: { pid: string; apps: App[]; appId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const choices = apps.filter((a) => IMPORT_STORES.has(a.type));
  const [app, setApp] = useState(appId ?? choices.find((a) => a.type !== "amazon")?.id ?? choices[0]?.id ?? "");
  const current = apps.find((a) => a.id === app);
  const listing = useQuery({
    queryKey: storeProductsKey(pid, app), enabled: !!app, retry: false, staleTime: 0, gcTime: 0,
    queryFn: () => api<Listing>(`${v2(pid)}/apps/${encodeURIComponent(app)}/store_products`),
  });
  const ents = useEntitlements(pid);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [entIds, setEntIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // Another app starts clean: a selection, or entitlements picked for the last import, must not carry over unseen.
  useEffect(() => { setPicked(new Set()); setEntIds(new Set()); setQ(""); setError(null); }, [app]);

  const items = listing.data?.items ?? [];
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => items.filter((i) => !needle || i.store_identifier.toLowerCase().includes(needle) || (i.display_name ?? "").toLowerCase().includes(needle) || (i.group?.name ?? "").toLowerCase().includes(needle)), [items, needle]);
  const selectable = shown.filter((i) => i.importable && !i.in_catalog);
  const allOn = selectable.length > 0 && selectable.every((i) => picked.has(i.store_identifier));
  const someOn = selectable.some((i) => picked.has(i.store_identifier));
  const inCatalog = items.filter((i) => i.in_catalog).length;
  const source = SOURCE[current?.type ?? ""] ?? "the store";

  const toggle = (id: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleAll = (on: boolean) => setPicked((s) => { const n = new Set(s); for (const i of selectable) { if (on) n.add(i.store_identifier); else n.delete(i.store_identifier); } return n; });

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<ImportResult>(`${v2(pid)}/apps/${encodeURIComponent(app)}/store_products/actions/import`, { method: "POST", json: { store_identifiers: [...picked], ...(entIds.size ? { entitlement_ids: [...entIds] } : {}) } });
      setResult(r);
      setPicked(new Set());
      await Promise.all([qc.invalidateQueries({ queryKey: catalogKey(pid) }), qc.invalidateQueries({ queryKey: ["products", pid] }), qc.invalidateQueries({ queryKey: storeProductsKey(pid, app) })]);
      toast(r.created.length ? `Imported ${count(r.created.length, "product")}` : "Nothing new to import");
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  const failure = listing.error;
  const failureBody = failure instanceof ApiError ? failure.body as { type?: string; retryable?: boolean } | null : null;
  const amazon = current?.type === "amazon";

  let content;
  if (!choices.length) {
    content = <p className="cat-lead">Products can be imported from App Store, Mac App Store, Google Play and Stripe apps. <Link className="cat-lnk" to={`/projects/${pid}/apps?add=app_store`}>Add one of those apps</Link> first.</p>;
  } else if (result) {
    const names = (ents.data ?? []).filter((e) => result.entitlement_ids.includes(e.id)).map((e) => e.lookup_key);
    content = (
      <div className="imp-result" aria-label="Import result">
        <StatusLine tone={result.created.length ? "ok" : "idle"}>{result.created.length ? `Imported ${count(result.created.length, "product")} from ${source}.` : "No new products were imported."}</StatusLine>
        {result.created.length > 0 && <ul className="imp-ids">{result.created.map((p) => <li key={p.id}><span className="mono">{p.store_identifier}</span> · {typeLabel(p.type)}{p.subscription?.duration ? ` · ${durationLabel(p.subscription.duration)}` : ""}</li>)}</ul>}
        {result.existing.length > 0 && <StatusLine tone="idle">{count(result.existing.length, "product was", "products were")} already in the catalog and left as they are.</StatusLine>}
        {names.length > 0 && <StatusLine tone="ok">Attached to {names.map((n, i) => <span key={n}>{i ? ", " : ""}<code>{n}</code></span>)}.</StatusLine>}
        {result.failed.length > 0 && (
          <div className="banner err" role="alert">
            <div><b>{count(result.failed.length, "product")} could not be imported.</b>
              <ul className="imp-ids">{result.failed.map((f) => <li key={f.store_identifier}><span className="mono">{f.store_identifier}</span>: {f.message}</li>)}</ul>
            </div>
          </div>
        )}
      </div>
    );
  } else {
    let body;
    if (!app) body = null;
    else if (listing.isLoading) body = <div className="panel" role="status" aria-label="Loading store products">{[0, 1, 2].map((i) => <div key={i} className="cat-loadrow"><i /><i /><i /></div>)}<p className="pb cat-note" style={{ margin: 0 }}>Reading products from {source}…</p></div>;
    else if (failure && amazon) body = <div className="banner" role="note"><Icon name="docs" /><div>{errMsg(failure)} <Link className="cat-lnk" to={`/projects/${pid}/product-catalog/products`} onClick={onClose}>Add products by SKU</Link>.</div></div>;
    else if (failure) {
      body = (
        <div className="banner err" role="alert">
          <div style={{ flex: 1 }}><b>{source} could not be read.</b> {errMsg(failure)}{failureBody?.type === "unprocessable_entity_error" && <> <Link className="cat-lnk" to={`/projects/${pid}/apps/${app}`} onClick={onClose}>Open app settings</Link></>}</div>
          <button type="button" className="btn btn-line" onClick={() => void listing.refetch()}>Retry</button>
        </div>
      );
    } else if (!items.length) body = <p className="cat-lead">{source} has no products for this app yet. Create them there first, then import them here.</p>;
    else body = (
      <>
        {listing.data!.warnings.map((w) => <div key={w} className="banner warn" role="note">{w}</div>)}
        <div className="cat-toolbar">
          <label className="cat-find"><Icon name="search" /><span className="sr">Search store products</span><input placeholder="Search store products" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <span className="cat-note">{count(items.length, "product")} in {source}{inCatalog ? `, ${inCatalog} already in the catalog` : ""}</span>
        </div>
        <div className="imp-list tbl">
          <table className="imp-table">
            <colgroup><col style={{ width: 40 }} /><col className="imp-prod" style={{ width: "34%" }} /><col className="imp-hide" style={{ width: "15%" }} /><col className="imp-hide" style={{ width: "13%" }} /><col className="imp-hide" style={{ width: "16%" }} /><col className="imp-stat" /></colgroup>
            <thead><tr>
              <th className="imp-c"><SelectBox checked={allOn} indeterminate={someOn} disabled={!selectable.length} onChange={toggleAll} label="Select all" /></th>
              <th>Product</th><th>Type</th><th>Duration</th><th>{current?.type === "stripe" ? "Price" : "Group"}</th><th>Status</th>
            </tr></thead>
            <tbody>
              {shown.map((i) => {
                const off = !i.importable || i.in_catalog;
                const on = picked.has(i.store_identifier);
                return (
                  <tr key={i.store_identifier} className={`row${off ? " imp-off" : ""}`} aria-disabled={off || undefined} onClick={() => { if (!off) toggle(i.store_identifier, !on); }}>
                    <td className="imp-c"><SelectBox checked={on || i.in_catalog} disabled={off} onChange={(v) => toggle(i.store_identifier, v)} label={`Select ${i.store_identifier}`} /></td>
                    <td>
                      <span className="cat-cell">
                        <span className="cat-t">{i.display_name || i.store_identifier}</span>
                        {i.display_name && <span className="cat-s">{i.store_identifier}</span>}
                        <span className="imp-meta">{typeLabel(i.type)}{i.type === "subscription" && i.duration ? ` · ${durationLabel(i.duration)}` : ""}{current?.type === "stripe" && i.price ? ` · ${priceLabel(i.price)}` : ""}</span>
                        {i.note && <span className="imp-note">{i.note}</span>}
                      </span>
                    </td>
                    <td>{typeLabel(i.type)}</td>
                    <td className="num">{i.type === "subscription" ? durationLabel(i.duration) : "—"}</td>
                    <td>{current?.type === "stripe" ? <span className="mono">{priceLabel(i.price)}</span> : i.group?.name ?? <span className="subtle">—</span>}</td>
                    <td>{i.in_catalog ? <Tag tone="up">In catalog</Tag> : !i.importable ? <Tag>Not importable</Tag> : <span className="imp-state">{i.store_state ? i.store_state.replace(/_/g, " ").toLowerCase() : "—"}</span>}</td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={6} className="cat-note" style={{ padding: 16 }}>No store products match your search.</td></tr>}
            </tbody>
          </table>
        </div>
        <fieldset className="imp-ents">
          <legend>Attach to entitlements <span className="subtle">(optional)</span></legend>
          {ents.isLoading ? <span className="cat-note">Loading entitlements…</span> : !(ents.data ?? []).length
            ? <span className="cat-note">No entitlements yet. <Link className="cat-lnk" to={`/projects/${pid}/product-catalog/entitlements`} onClick={onClose}>Create one</Link> to unlock access with these products.</span>
            : <div className="imp-entlist">{(ents.data ?? []).map((e) => (
              <Check key={e.id} checked={entIds.has(e.id)} label={e.lookup_key} hint={`${e.display_name}${e.state === "inactive" ? " · archived" : ""}`}
                onChange={(v) => setEntIds((s) => { const n = new Set(s); if (v) n.add(e.id); else n.delete(e.id); return n; })} />
            ))}</div>}
        </fieldset>
      </>
    );
    content = (
      <>
        {!appId && choices.length > 1 && (
          <Field label="App" htmlFor="imp-app" hint={CREDENTIAL[current?.type ?? ""] ? `Products are read with the app's stored ${CREDENTIAL[current!.type]}. Nothing is changed in the store.` : undefined}>
            <select id="imp-app" className="select" value={app} onChange={(e) => setApp(e.target.value)}>
              {choices.map((a) => <option key={a.id} value={a.id}>{a.name} ({STORE_LABEL[a.type] ?? a.type})</option>)}
            </select>
          </Field>
        )}
        {body}
        {error && <div className="banner err" role="alert">{error}</div>}
      </>
    );
  }

  const footer = result
    ? <><button type="button" className="btn btn-line" onClick={() => { setResult(null); setEntIds(new Set()); }}>Import more</button><button type="button" className="btn btn-dark" onClick={onClose}>Done</button></>
    : <><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy || !picked.size} onClick={() => void run()}>{busy ? "Importing…" : picked.size ? `Import ${count(picked.size, "product")}` : "Import"}</button></>;

  return (
    <Dialog title={current && appId ? `Import products into ${current.name}` : "Import products"} onClose={onClose} footer={footer}>
      <div className="imp">{content}</div>
    </Dialog>
  );
}
