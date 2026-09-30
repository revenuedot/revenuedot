/**
 * Entitlements: /projects/:projectId/product-catalog/entitlements and /entitlements/:entitlementId
 * List (identifier, display name, products, created), New entitlement, and the detail page with the associated products
 * table (App, Created, Detach), "New" (create a product and attach it) and "Attach".
 *
 * GAPS versus RevenueCat's dashboard: none known for Tier 1. RevenueCat shows store price labels in product cells; those
 * need store import (Tier 2).
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmt } from "../../lib/api";
import { Copy, Shell } from "../../components/Shell";
import { ConfirmDialog, DataTable, Dialog, EmptyState, Field, KeyValue, Menu, PageHead, Panel, Segmented, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { AppName, CatalogCrumbs, LoadError, LoadingRows, NewProductDialog, ProductCell } from "./parts";
import { count, errMsg, isConflict, lookupKeyError, useApps, useEntitlements, useProducts, useRefreshCatalog, v2, type App, type Entitlement, type Product } from "./lib";

type Filter = "all" | "active" | "inactive";
type Pending = { kind: "edit" | "archive" | "unarchive" | "delete"; e: Entitlement } | null;

function useEntitlementActions(pid: string, onDeleted?: () => void) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [pending, setPending] = useState<Pending>(null);
  const close = () => setPending(null);
  const url = (e: Entitlement) => `${v2(pid)}/entitlements/${e.id}`;
  const items = (e: Entitlement, withDelete = true): (MenuItem | "-")[] => [
    { label: "Edit", icon: "edit", onSelect: () => setPending({ kind: "edit", e }) },
    e.state === "active" ? { label: "Archive", icon: "archive", onSelect: () => setPending({ kind: "archive", e }) } : { label: "Unarchive", icon: "refresh", onSelect: () => setPending({ kind: "unarchive", e }) },
    ...(withDelete ? ["-" as const, { label: "Delete", icon: "trash", danger: true, onSelect: () => setPending({ kind: "delete", e }) }] : []),
  ];
  let dialog: ReactNode = null;
  if (pending) {
    const { e } = pending;
    const k = <code>{e.lookup_key}</code>;
    if (pending.kind === "edit") dialog = <EditEntitlementDialog pid={pid} e={e} onClose={close} />;
    if (pending.kind === "archive") dialog = (
      <ConfirmDialog title="Archive this entitlement?" confirmLabel="Archive" danger onClose={close} onConfirm={async () => {
        await api(`${url(e)}/actions/archive`, { method: "POST" }); await refresh(); toast(`${e.lookup_key} archived`);
      }}>
        <p>While archived, {k} is left out of every customer's entitlements, so <b>apps that check {k} treat every customer as not entitled</b>. Its products stay attached.</p>
        <p>Unarchive it to restore access right away.</p>
      </ConfirmDialog>
    );
    if (pending.kind === "unarchive") dialog = (
      <ConfirmDialog title="Unarchive this entitlement?" confirmLabel="Unarchive" onClose={close} onConfirm={async () => {
        await api(`${url(e)}/actions/unarchive`, { method: "POST" }); await refresh(); toast(`${e.lookup_key} restored`);
      }}>
        <p>Customers who bought one of its {count(e.products?.items.length ?? 0, "product")} get {k} again.</p>
      </ConfirmDialog>
    );
    if (pending.kind === "delete") dialog = (
      <ConfirmDialog title="Delete this entitlement?" confirmLabel="Delete entitlement" danger onClose={close} onConfirm={async () => {
        await api(url(e), { method: "DELETE" }); await refresh(); toast(`${e.lookup_key} deleted`); onDeleted?.();
      }}>
        <p>This deletes {k} and detaches its {count(e.products?.items.length ?? 0, "product")}. It cannot be undone. The products stay.</p>
        <p><b>Apps that check {k} treat every customer as not entitled</b>, including customers who already paid. Archive it instead if you might need it again.</p>
      </ConfirmDialog>
    );
  }
  return { items, dialog, ask: (kind: NonNullable<Pending>["kind"], e: Entitlement) => setPending({ kind, e }) };
}

export function EntitlementsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const ents = useEntitlements(pid);
  const actions = useEntitlementActions(pid);
  const [filter, setFilter] = useState<Filter>("active");
  const [creating, setCreating] = useState(false);
  const base = `/projects/${pid}/product-catalog`;
  const all = ents.data ?? [];
  const rows = all.filter((e) => filter === "all" || e.state === filter).sort((a, b) => a.created_at - b.created_at);
  return (
    <Shell title="Entitlements" crumbs={<CatalogCrumbs pid={pid} section="Entitlements" />}>
      <div className="page">
        <PageHead title="Entitlements" sub="The access levels your app checks, such as pro. Buying any attached product unlocks the entitlement."
          actions={<button type="button" className="btn btn-dark" onClick={() => setCreating(true)}><Icon name="plus" />New entitlement</button>} />
        {ents.isError ? <LoadError error={ents.error} retry={() => ents.refetch()} /> : ents.isLoading ? <LoadingRows label="Loading entitlements" /> : !all.length ? (
          <EmptyState title="No entitlements yet" text="Create an entitlement for each level of access, such as pro, then attach the products that unlock it. Your app checks customerInfo.entitlements[&quot;pro&quot;].isActive."
            action={<button type="button" className="btn btn-dark" onClick={() => setCreating(true)}><Icon name="plus" />New entitlement</button>} />
        ) : (
          <>
            <div className="cat-toolbar">
              <Segmented label="Filter entitlements" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "inactive", label: "Archived" }]} />
              <span className="cat-note">{count(rows.length, "entitlement")}</span>
            </div>
            <DataTable rows={rows} rowKey={(e) => e.id} onRowClick={(e) => nav(`${base}/entitlements/${e.id}`)}
              empty={<EmptyState title={filter === "inactive" ? "No archived entitlements" : "No active entitlements"} />}
              columns={[
                { key: "id", header: "Identifier", render: (e) => <span className="cat-idc"><Link className="cat-lnk" to={`${base}/entitlements/${e.id}`} onClick={(x) => x.stopPropagation()}>{e.lookup_key}</Link>{e.state === "inactive" && <Tag>Archived</Tag>}</span> },
                { key: "name", header: "Display name", render: (e) => e.display_name },
                { key: "prods", header: "Products", render: (e) => { const n = e.products?.items.length ?? 0; return <span className={`num${n ? "" : " subtle"}`} title={n ? undefined : "No product unlocks this entitlement yet"}>{count(n, "product")}</span>; } },
                { key: "created", header: "Created", render: (e) => <span className="num">{fmt.date(e.created_at)}</span> },
                { key: "act", header: "Actions", align: "right", render: (e) => <Menu label={`Actions for ${e.lookup_key}`} items={actions.items(e)} /> },
              ]} />
          </>
        )}
      </div>
      {creating && <NewEntitlementDialog pid={pid} onClose={() => setCreating(false)} onCreated={(e) => nav(`${base}/entitlements/${e.id}`)} />}
      {actions.dialog}
    </Shell>
  );
}

function NewEntitlementDialog({ pid, onClose, onCreated }: { pid: string; onClose: () => void; onCreated: (e: Entitlement) => void }) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const er: Record<string, string> = {};
    const ke = lookupKeyError(key.trim(), "entitlement");
    if (ke) er.key = ke;
    if (!name.trim()) er.name = "Enter a display name, such as Pro access.";
    setErr(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const e = await api<Entitlement>(`${v2(pid)}/entitlements`, { method: "POST", json: { lookup_key: key.trim(), display_name: name.trim() } });
      await refresh(); toast(`Entitlement ${e.lookup_key} created`); onClose(); onCreated(e);
    } catch (e) {
      setErr(isConflict(e) ? { key: "An entitlement with this identifier already exists. Identifiers are unique per project." } : { form: errMsg(e) });
      setBusy(false);
    }
  }
  return (
    <Dialog title="New entitlement" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="new-ent" className="btn btn-dark" disabled={busy}>{busy ? "Creating…" : "Create entitlement"}</button>
    </>}>
      <form id="new-ent" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Identifier" htmlFor="ne-key" error={err.key} hint={<>The key your app checks, e.g. <code>customerInfo.entitlements["pro"]</code>. It cannot be changed later.</>}>
          <input id="ne-key" className="input mono" autoFocus spellCheck={false} autoComplete="off" placeholder="pro" value={key} onChange={(e) => { setKey(e.target.value); setErr({}); }} />
        </Field>
        <Field label="Display name" htmlFor="ne-name" error={err.name} hint="A description for your team.">
          <input id="ne-name" className="input" placeholder="e.g. Pro access" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {err.form && <div className="banner err" role="alert">{err.form}</div>}
      </form>
    </Dialog>
  );
}

function EditEntitlementDialog({ pid, e, onClose }: { pid: string; e: Entitlement; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [name, setName] = useState(e.display_name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!name.trim()) { setErr("Enter a display name."); return; }
    setBusy(true);
    try { await api(`${v2(pid)}/entitlements/${e.id}`, { method: "POST", json: { display_name: name.trim() } }); await refresh(); toast("Entitlement saved"); onClose(); }
    catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <Dialog title="Edit entitlement" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="edit-ent" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </>}>
      <form id="edit-ent" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Identifier" htmlFor="ee-key" hint="Identifiers cannot be changed. Create a new entitlement to use another key.">
          <input id="ee-key" className="input mono" value={e.lookup_key} disabled />
        </Field>
        <Field label="Display name" htmlFor="ee-name" error={err}>
          <input id="ee-name" className="input" autoFocus value={name} onChange={(x) => setName(x.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

export function EntitlementDetail() {
  const pid = useProjectId();
  const { entitlementId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const base = `/projects/${pid}/product-catalog`;
  const ents = useEntitlements(pid);
  const apps = useApps(pid);
  const products = useProducts(pid);
  const actions = useEntitlementActions(pid, () => nav(`${base}/entitlements`));
  const [attach, setAttach] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detach, setDetach] = useState<Product | null>(null);
  const e = ents.data?.find((x) => x.id === entitlementId);
  const attached = e?.products?.items ?? [];

  let body: ReactNode;
  if (ents.isError) body = <LoadError error={ents.error} retry={() => ents.refetch()} />;
  else if (ents.isLoading) body = <LoadingRows label="Loading entitlement" rows={5} />;
  else if (!e) body = <EmptyState title="Entitlement not found" text="It may have been deleted." action={<Link className="btn btn-line" to={`${base}/entitlements`}>Back to entitlements</Link>} />;
  else body = (
    <>
      <div className="head">
        <div className="cat-titlerow"><h1>{e.lookup_key}</h1>{e.state === "inactive" && <Tag>Archived</Tag>}</div>
        <div className="actions">
          <Menu label="More actions" items={actions.items(e, false).filter((i) => i === "-" || i.label !== "Edit")} />
          <button type="button" className="btn btn-danger" onClick={() => actions.ask("delete", e)}><Icon name="trash" />Delete</button>
          <button type="button" className="btn btn-dark" onClick={() => actions.ask("edit", e)}><Icon name="edit" />Edit</button>
        </div>
      </div>
      {e.state === "inactive" && <div className="banner warn"><span><b>Archived.</b> No customer has <code>{e.lookup_key}</code> while it is archived. Unarchive it from the actions menu to restore access.</span></div>}
      <KeyValue rows={[
        ["Identifier", <Copy key="i" value={e.lookup_key} />],
        ["Display name", e.display_name],
        ["Status", e.state === "active" ? <Tag tone="up">Active</Tag> : <Tag>Archived</Tag>],
        ["Created", <span key="c" className="mono">{fmt.dateTime(e.created_at)}</span>],
      ]} />
      <Panel flush title="Associated products" link={<span className="actions">
        <button type="button" className="btn btn-ghost" onClick={() => setCreating(true)} disabled={!apps.data?.length} title={apps.data?.length ? undefined : "Add an app first"}><Icon name="plus" />New</button>
        <button type="button" className="btn btn-ghost" onClick={() => setAttach(true)}><Icon name="link" />Attach</button>
      </span>}>
        {!attached.length ? (
          <div className="pb cat-note" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            <span><b>No products unlock this entitlement yet.</b> Attach the products that grant {e.lookup_key}, on every store you sell on.</span>
          </div>
        ) : (
          <div className="tbl"><table>
            <thead><tr><th>Product</th><th>App</th><th>Created</th><th className="amt">Detach</th></tr></thead>
            <tbody>{attached.map((p) => (
              <tr key={p.id}>
                <td><ProductCell p={p} to={`${base}/products/${p.id}`} /></td>
                <td><AppName app={apps.data?.find((a) => a.id === p.app_id)} /></td>
                <td className="num">{fmt.date(p.created_at)}</td>
                <td className="amt"><button type="button" className="btn btn-ghost" aria-label={`Detach ${p.store_identifier}`} onClick={() => setDetach(p)}><Icon name="close" />Detach</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
      <div className="cat-apiid"><b>REST API identifier</b><Copy value={e.id} /></div>
    </>
  );

  return (
    <Shell title={e?.lookup_key ?? "Entitlement"} crumbs={<CatalogCrumbs pid={pid} section="Entitlements" sectionTo="entitlements" current={e?.lookup_key ?? "…"} />}>
      <div className="page cat-detail">{body}</div>
      {actions.dialog}
      {attach && e && <AttachProductsDialog pid={pid} e={e} apps={apps.data ?? []} products={products.data ?? []} onClose={() => setAttach(false)} />}
      {creating && e && apps.data && (
        <NewProductDialog pid={pid} apps={apps.data} onClose={() => setCreating(false)} onCreated={async (p) => {
          await api(`${v2(pid)}/entitlements/${e.id}/actions/attach_products`, { method: "POST", json: { product_ids: [p.id] } });
        }} />
      )}
      {detach && e && (
        <ConfirmDialog title="Detach this product?" confirmLabel="Detach" danger onClose={() => setDetach(null)} onConfirm={async () => {
          await api(`${v2(pid)}/entitlements/${e.id}/actions/detach_products`, { method: "POST", json: { product_ids: [detach.id] } }); await refresh(); toast(`${detach.store_identifier} detached`);
        }}>
          <p><code>{detach.store_identifier}</code> stops unlocking <code>{e.lookup_key}</code>. The change is retroactive: <b>customers who bought only this product lose {e.lookup_key}</b>, including past purchasers.</p>
        </ConfirmDialog>
      )}
    </Shell>
  );
}

/** Attach: every product not yet attached, grouped by app, with search. */
function AttachProductsDialog({ pid, e, apps, products, onClose }: { pid: string; e: Entitlement; apps: App[]; products: Product[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const have = new Set((e.products?.items ?? []).map((p) => p.id));
  const needle = q.trim().toLowerCase();
  const avail = products.filter((p) => !have.has(p.id) && (!needle || p.store_identifier.toLowerCase().includes(needle) || (p.display_name ?? "").toLowerCase().includes(needle)));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const ids = [...sel];
      for (let i = 0; i < ids.length; i += 50) await api(`${v2(pid)}/entitlements/${e.id}/actions/attach_products`, { method: "POST", json: { product_ids: ids.slice(i, i + 50) } });
      await refresh(); toast(`${count(ids.length, "product")} attached to ${e.lookup_key}`); onClose();
    } catch (x) { setError(errMsg(x)); setBusy(false); }
  };
  return (
    <Dialog title={`Attach products to ${e.lookup_key}`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" onClick={go} disabled={busy || !sel.size}>{busy ? "Attaching…" : sel.size ? `Attach ${count(sel.size, "product")}` : "Attach"}</button>
    </>}>
      <p className="cat-lead">Customers who buy any selected product get <code>{e.lookup_key}</code>, including past purchasers.</p>
      {products.length === have.size ? <p className="cat-note">Every product is already attached. Create a new product with “New”.</p> : (
        <>
          <label className="cat-toolbar" style={{ gap: 0 }}><span className="cat-find" style={{ maxWidth: "none" }}><Icon name="search" /><span className="sr">Search products</span><input autoFocus placeholder="Search products" value={q} onChange={(x) => setQ(x.target.value)} /></span></label>
          <div className="cat-checks" role="group" aria-label="Products">
            {apps.map((a) => {
              const list = avail.filter((p) => p.app_id === a.id);
              if (!list.length) return null;
              return (
                <div key={a.id}>
                  <div className="cat-grp"><AppName app={a} /></div>
                  {list.map((p) => (
                    <label key={p.id}><input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} /><ProductCell p={p} />{p.state === "inactive" && <Tag>Archived</Tag>}</label>
                  ))}
                </div>
              );
            })}
            {!avail.length && <p className="cat-note" style={{ padding: 12, margin: 0 }}>No products match your search.</p>}
          </div>
        </>
      )}
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}
