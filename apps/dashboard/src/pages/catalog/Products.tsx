/**
 * Products: /projects/:projectId/product-catalog/products and /products/:productId
 * Grouped by app like RevenueCat: display name over the store identifier, type, duration, entitlements, status, created.
 *
 * "Import products" (page head, and "Import" on each App Store, Google Play and Stripe app group) opens ImportProductsDialog.
 *
 * GAPS versus RevenueCat's dashboard (later tiers):
 * - The "Product editor" (store-side price and metadata editing) is Tier 2.
 * - Price labels ("$9.99/week") come from the store APIs in RevenueCat; the import does not read Apple or Google prices yet,
 *   so we show the duration.
 *   Test Store products have a price set here (the detail page shows it; the SDK reads it).
 * - RevenueCat's "…" menu on each app group (app shortcuts) is left out; the Apps page owns app settings.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmt } from "../../lib/api";
import { Copy, Shell } from "../../components/Shell";
import { ConfirmDialog, Dialog, EmptyState, Field, KeyValue, Menu, PageHead, Panel, Segmented, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { IMPORT_STORES, ImportProductsDialog } from "./ImportProducts";
import { AppName, CatalogCrumbs, EditProductDialog, LoadError, LoadingRows, NewProductDialog, ProductCell } from "./parts";
import { count, durationLabel, errMsg, priceLabel, productName, typeLabel, useApps, useEntitlements, useOfferings, useProducts, useRefreshCatalog, v2, type Entitlement, type Offering, type Product } from "./lib";

type Filter = "all" | "active" | "inactive";

/** Which entitlements and packages reference each product. */
function useUsage(pid: string) {
  const ents = useEntitlements(pid);
  const offs = useOfferings(pid);
  return useMemo(() => {
    const entsBy = new Map<string, Entitlement[]>();
    for (const e of ents.data ?? []) for (const p of e.products?.items ?? []) entsBy.set(p.id, [...(entsBy.get(p.id) ?? []), e]);
    const pkgsBy = new Map<string, { offering: Offering; pkg: string }[]>();
    for (const o of offs.data ?? []) for (const k of o.packages?.items ?? []) for (const x of k.products?.items ?? []) pkgsBy.set(x.product.id, [...(pkgsBy.get(x.product.id) ?? []), { offering: o, pkg: k.lookup_key }]);
    return { entsBy, pkgsBy, loaded: !!ents.data && !!offs.data, ents: ents.data ?? [] };
  }, [ents.data, offs.data]);
}

type Pending = { kind: "edit" | "delete"; p: Product } | null;

function useProductActions(pid: string, usage: ReturnType<typeof useUsage>, onDeleted?: () => void) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [pending, setPending] = useState<Pending>(null);
  const setState = async (p: Product, action: "archive" | "unarchive") => {
    try { await api(`${v2(pid)}/products/${p.id}/actions/${action}`, { method: "POST" }); await refresh(); toast(`${p.store_identifier} ${action === "archive" ? "archived" : "restored"}`); }
    catch (e) { toast(errMsg(e)); }
  };
  const items = (p: Product, withDelete = true): (MenuItem | "-")[] => [
    { label: "Edit", icon: "edit", onSelect: () => setPending({ kind: "edit", p }) },
    p.state === "active" ? { label: "Archive", icon: "archive", onSelect: () => void setState(p, "archive") } : { label: "Unarchive", icon: "refresh", onSelect: () => void setState(p, "unarchive") },
    ...(withDelete ? ["-" as const, { label: "Delete", icon: "trash", danger: true, onSelect: () => setPending({ kind: "delete", p }) }] : []),
  ];
  let dialog: ReactNode = null;
  if (pending?.kind === "edit") dialog = <EditProductDialog pid={pid} product={pending.p} onClose={() => setPending(null)} />;
  if (pending?.kind === "delete") {
    const p = pending.p;
    const ents = usage.entsBy.get(p.id) ?? [];
    const pkgs = usage.pkgsBy.get(p.id) ?? [];
    dialog = (
      <ConfirmDialog title="Delete this product?" confirmLabel="Delete product" danger onClose={() => setPending(null)} onConfirm={async () => {
        await api(`${v2(pid)}/products/${p.id}`, { method: "DELETE" }); await refresh(); toast(`${p.store_identifier} deleted`); onDeleted?.();
      }}>
        <p>This deletes <code>{p.store_identifier}</code> from RevenueDot. It cannot be undone. The product stays in the store.</p>
        {ents.length > 0 && <p>It is detached from {count(ents.length, "entitlement")} ({ents.map((e) => e.lookup_key).join(", ")}). <b>Customers who bought only this product lose that access</b>, including past purchasers.</p>}
        {pkgs.length > 0 && <p>It is removed from {count(pkgs.length, "package")} ({pkgs.map((x) => `${x.offering.lookup_key} / ${x.pkg}`).join(", ")}); apps stop showing a package that has no other product for them.</p>}
        <p>Purchase history keeps the store identifier. To hide the product without these effects, archive it instead.</p>
      </ConfirmDialog>
    );
  }
  return { items, dialog, ask: (kind: "edit" | "delete", p: Product) => setPending({ kind, p }), setState };
}

export function ProductsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const apps = useApps(pid);
  const products = useProducts(pid);
  const usage = useUsage(pid);
  const actions = useProductActions(pid, usage);
  const [filter, setFilter] = useState<Filter>("active");
  const [q, setQ] = useState("");
  const [newFor, setNewFor] = useState<string | null | undefined>(undefined);
  const [importFor, setImportFor] = useState<string | null | undefined>(undefined);
  const canImport = (apps.data ?? []).some((a) => IMPORT_STORES.has(a.type) && a.type !== "amazon");
  const base = `/projects/${pid}/product-catalog`;
  const all = products.data ?? [];
  const needle = q.trim().toLowerCase();
  const shown = all.filter((p) => (filter === "all" || p.state === filter) && (!needle || p.store_identifier.toLowerCase().includes(needle) || (p.display_name ?? "").toLowerCase().includes(needle)));
  const failed = apps.isError ? apps : products.isError ? products : null;

  let body: ReactNode;
  if (failed) body = <LoadError error={failed.error} retry={() => failed.refetch()} />;
  else if (apps.isLoading || products.isLoading) body = <LoadingRows label="Loading products" rows={4} />;
  else if (!apps.data!.length) body = (
    <EmptyState title="Add an app first" text="Products belong to an app. Add your App Store, Google Play or Test Store app, then add its products here."
      action={<Link className="btn btn-dark" to={`/projects/${pid}/apps`}><Icon name="plus" />Add an app</Link>} />
  );
  else if (!all.length) body = (
    <EmptyState title="No products yet" text={canImport ? "Import the products you already set up in App Store Connect, Google Play or Stripe, or create one by its store identifier. Then attach them to an entitlement and group them into an offering." : "Create your first product with its store identifier, then attach it to an entitlement and group products into an offering."}
      action={<div className="hrow">{canImport && <button type="button" className="btn btn-dark" onClick={() => setImportFor(null)}><Icon name="download" />Import products</button>}<button type="button" className={canImport ? "btn btn-line" : "btn btn-dark"} onClick={() => setNewFor(null)}><Icon name="plus" />New product</button></div>} />
  );
  else body = (
    <>
      <div className="cat-toolbar">
        <Segmented label="Filter products" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} />
        <label className="cat-find"><Icon name="search" /><span className="sr">Search products</span><input placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </div>
      {apps.data!.map((a) => {
        const rows = shown.filter((p) => p.app_id === a.id).sort((x, y) => y.created_at - x.created_at);
        const total = all.filter((p) => p.app_id === a.id).length;
        return (
          <section className="panel" key={a.id} aria-label={`${a.name} products`}>
            <div className="ph"><AppName app={a} sub /><span className="hrow">{IMPORT_STORES.has(a.type) && a.type !== "amazon" && <button type="button" className="btn btn-ghost" aria-label={`Import products into ${a.name}`} onClick={() => setImportFor(a.id)}><Icon name="download" />Import</button>}<button type="button" className="btn btn-ghost" onClick={() => setNewFor(a.id)}><Icon name="plus" />New</button></span></div>
            {!rows.length ? (
              <div className="pb cat-note">{total ? (needle ? "No products match your search." : `No ${filter} products for this app.`) : <>No products for this app yet. <button type="button" className="cat-lnk" onClick={() => setNewFor(a.id)}>Add one</button>.</>}</div>
            ) : (
              <div className="tbl">
                <table className="cat-ptable">
                  <colgroup><col style={{ width: "31%" }} /><col style={{ width: "14%" }} /><col style={{ width: "11%" }} /><col style={{ width: "13%" }} /><col style={{ width: "10%" }} /><col style={{ width: "12%" }} /><col style={{ width: "9%" }} /></colgroup>
                  <thead><tr><th>Product</th><th>Type</th><th>Duration</th><th>Entitlements</th><th>Status</th><th>Created</th><th className="amt">Actions</th></tr></thead>
                  <tbody>
                    {rows.map((p) => {
                      const ents = usage.entsBy.get(p.id) ?? [];
                      return (
                        <tr key={p.id} className="row" tabIndex={0} onClick={() => nav(`${base}/products/${p.id}`)} onKeyDown={(e) => { if (e.key === "Enter") nav(`${base}/products/${p.id}`); }}>
                          <td><ProductCell p={p} to={`${base}/products/${p.id}`} /></td>
                          <td>{typeLabel(p.type)}</td>
                          <td className="num">{p.type === "subscription" ? durationLabel(p.subscription?.duration) : "—"}</td>
                          <td className={`num${ents.length ? "" : " subtle"}`} title={ents.length ? ents.map((e) => e.lookup_key).join(", ") : "Buying this product unlocks nothing yet"}>{usage.loaded ? count(ents.length, "entitlement") : "…"}</td>
                          <td>{p.state === "active" ? <Tag tone="up">Active</Tag> : <Tag>Archived</Tag>}</td>
                          <td className="num">{fmt.date(p.created_at)}</td>
                          <td className="amt"><Menu label={`Actions for ${p.store_identifier}`} items={actions.items(p)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </>
  );

  return (
    <Shell title="Products" crumbs={<CatalogCrumbs pid={pid} section="Products" />}>
      <div className="page">
        <PageHead title="Products" sub="The in-app purchases you set up in each store. Attach them to entitlements to unlock access, and add them to offerings to sell them."
          actions={apps.data?.length ? <>{canImport && <button type="button" className="btn btn-line" onClick={() => setImportFor(null)}><Icon name="download" />Import products</button>}<button type="button" className="btn btn-dark" onClick={() => setNewFor(null)}><Icon name="plus" />New product</button></> : undefined} />
        {body}
      </div>
      {importFor !== undefined && apps.data && <ImportProductsDialog pid={pid} apps={apps.data} appId={importFor ?? undefined} onClose={() => setImportFor(undefined)} />}
      {newFor !== undefined && apps.data && <NewProductDialog pid={pid} apps={apps.data} appId={newFor ?? undefined} onClose={() => setNewFor(undefined)} onCreated={() => setFilter((f) => (f === "inactive" ? "active" : f))} />}
      {actions.dialog}
    </Shell>
  );
}

export function ProductDetail() {
  const pid = useProjectId();
  const { productId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const base = `/projects/${pid}/product-catalog`;
  const apps = useApps(pid);
  const products = useProducts(pid);
  const usage = useUsage(pid);
  const actions = useProductActions(pid, usage, () => nav(`${base}/products`));
  const [attach, setAttach] = useState(false);
  const [detach, setDetach] = useState<Entitlement | null>(null);
  const p = products.data?.find((x) => x.id === productId);
  const app = apps.data?.find((a) => a.id === p?.app_id);
  const ents = p ? usage.entsBy.get(p.id) ?? [] : [];
  const pkgs = p ? usage.pkgsBy.get(p.id) ?? [] : [];

  let body: ReactNode;
  if (products.isError) body = <LoadError error={products.error} retry={() => products.refetch()} />;
  else if (products.isLoading) body = <LoadingRows label="Loading product" rows={5} />;
  else if (!p) body = <EmptyState title="Product not found" text="It may have been deleted." action={<Link className="btn btn-line" to={`${base}/products`}>Back to products</Link>} />;
  else body = (
    <>
      <div className="head">
        <div className="cat-titlerow"><h1>{productName(p)}</h1>{p.state === "inactive" && <Tag>Archived</Tag>}</div>
        <div className="actions">
          <Menu label="More actions" items={actions.items(p, false).filter((i) => i === "-" || i.label !== "Edit")} />
          <button type="button" className="btn btn-danger" onClick={() => actions.ask("delete", p)}><Icon name="trash" />Delete</button>
          <button type="button" className="btn btn-dark" onClick={() => actions.ask("edit", p)}><Icon name="edit" />Edit</button>
        </div>
      </div>
      <KeyValue rows={[
        ["Store identifier", <Copy key="s" value={p.store_identifier} />],
        ["App", <AppName key="a" app={app} sub />],
        ["Type", typeLabel(p.type)],
        ...(p.type === "subscription" ? [["Duration", p.subscription?.duration ? <span key="d">{durationLabel(p.subscription.duration)} <span className="mono subtle">{p.subscription.duration}</span></span> : <span key="d" className="subtle">Not set. Edit the product to set it; MRR uses it.</span>] as [string, ReactNode]] : []),
        ...(app?.type === "test_store" ? [["Test Store price", p.indicative_price ? <span key="tp" className="mono">{priceLabel(p.indicative_price)}</span> : <span key="tp" className="subtle">None. The SDK shows USD 0.00; edit the product to set a price.</span>] as [string, ReactNode]] : []),
        ["Display name", p.display_name || <span key="n" className="subtle">None</span>],
        ["Status", p.state === "active" ? <Tag tone="up">Active</Tag> : <Tag>Archived</Tag>],
        ["Created", <span key="c" className="mono">{fmt.dateTime(p.created_at)}</span>],
      ]} />
      <Panel flush title="Entitlements" link={<button type="button" className="btn btn-ghost" onClick={() => setAttach(true)}><Icon name="link" />Attach</button>}>
        {!ents.length ? <div className="pb cat-note">This product unlocks no entitlement yet, so buying it grants no access. Attach it to one, such as <code>pro</code>.</div> : (
          <div className="tbl"><table>
            <thead><tr><th>Identifier</th><th>Display name</th><th className="amt">Detach</th></tr></thead>
            <tbody>{ents.map((e) => (
              <tr key={e.id}>
                <td className="mono"><Link className="cat-lnk" to={`${base}/entitlements/${e.id}`}>{e.lookup_key}</Link></td>
                <td>{e.display_name}</td>
                <td className="amt"><button type="button" className="btn btn-ghost" onClick={() => setDetach(e)}><Icon name="close" />Detach</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
      <Panel flush title="Offerings">
        {!pkgs.length ? <div className="pb cat-note">Not in any offering. Add it to a package so your paywall can sell it.</div> : (
          <div className="tbl"><table>
            <thead><tr><th>Offering</th><th>Package</th></tr></thead>
            <tbody>{pkgs.map((x) => (
              <tr key={`${x.offering.id}${x.pkg}`}>
                <td><span className="cat-idc"><Link className="cat-lnk" to={`${base}/offerings/${x.offering.id}`}>{x.offering.lookup_key}</Link>{x.offering.is_current && <Tag tone="gold">Default</Tag>}</span></td>
                <td className="mono">{x.pkg}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
      <div className="cat-apiid"><b>REST API identifier</b><Copy value={p.id} /></div>
    </>
  );

  return (
    <Shell title={p ? productName(p) : "Product"} crumbs={<CatalogCrumbs pid={pid} section="Products" sectionTo="products" current={p?.store_identifier ?? "…"} />}>
      <div className="page cat-detail">{body}</div>
      {actions.dialog}
      {attach && p && <AttachToEntitlement pid={pid} product={p} ents={usage.ents.filter((e) => !ents.some((x) => x.id === e.id))} onClose={() => setAttach(false)} />}
      {detach && p && (
        <ConfirmDialog title="Detach from this entitlement?" confirmLabel="Detach" danger onClose={() => setDetach(null)} onConfirm={async () => {
          await api(`${v2(pid)}/entitlements/${detach.id}/actions/detach_products`, { method: "POST", json: { product_ids: [p.id] } }); await refresh(); toast(`Detached from ${detach.lookup_key}`);
        }}>
          <p><code>{p.store_identifier}</code> stops unlocking <code>{detach.lookup_key}</code>. The change is retroactive: <b>customers who bought only this product lose that access</b>, including past purchasers.</p>
        </ConfirmDialog>
      )}
    </Shell>
  );
}

function AttachToEntitlement({ pid, product, ents, onClose }: { pid: string; product: Product; ents: Entitlement[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [sel, setSel] = useState<string>(ents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    const e = ents.find((x) => x.id === sel);
    if (!e) return;
    setBusy(true); setError(null);
    try { await api(`${v2(pid)}/entitlements/${e.id}/actions/attach_products`, { method: "POST", json: { product_ids: [product.id] } }); await refresh(); toast(`Attached to ${e.lookup_key}`); onClose(); }
    catch (err) { setError(errMsg(err)); setBusy(false); }
  };
  return (
    <Dialog title="Attach to entitlement" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" onClick={go} disabled={busy || !sel}>{busy ? "Attaching…" : "Attach"}</button>
    </>}>
      {!ents.length ? <p className="cat-lead">No other entitlements. <Link className="cat-lnk" to={`/projects/${pid}/product-catalog/entitlements`}>Create an entitlement</Link> first.</p> : (
        <Field label="Entitlement" htmlFor="att-ent" hint={`Customers who buy ${product.store_identifier} get this entitlement, including past purchasers.`}>
          <select id="att-ent" className="select" autoFocus value={sel} onChange={(e) => setSel(e.target.value)}>
            {ents.map((e) => <option key={e.id} value={e.id}>{e.lookup_key} · {e.display_name}{e.state === "inactive" ? " (archived)" : ""}</option>)}
          </select>
        </Field>
      )}
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}
