/**
 * Offerings list: /projects/:projectId/product-catalog/offerings
 *
 * GAPS versus RevenueCat's dashboard (later tiers):
 * - "New offering → Create with AI" is not offered; only "Create from scratch".
 * - The experiment hint ("Offerings can also be used to test pricing … as variants in an experiment") waits for Experiments (Tier 2).
 * - Paywall, web purchase link and targeting columns/rows wait for Paywalls, Web and Targeting (Tier 2/3).
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmt } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { ConfirmDialog, DataTable, Dialog, EmptyState, Field, Menu, PageHead, Segmented, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { CatalogCrumbs, LoadError, LoadingRows } from "./parts";
import { copyKey, count, errMsg, isConflict, lookupKeyError, useOfferings, useProducts, useRefreshCatalog, v2, type Offering, type Package } from "./lib";

type Filter = "all" | "active" | "inactive";

/** The offering the SDK returns as `offerings.current`, marked in gold everywhere. */
export function DefaultTag() {
  return <Tag tone="gold"><span className="live" style={{ marginRight: 6 }} />Default</Tag>;
}

export function OfferingsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const offerings = useOfferings(pid);
  const products = useProducts(pid);
  const [filter, setFilter] = useState<Filter>("active");
  const actions = useOfferingActions(pid, offerings.data ?? []);
  const all = offerings.data ?? [];
  const rows = all.filter((o) => filter === "all" || o.state === filter)
    .sort((a, b) => Number(b.is_current) - Number(a.is_current) || a.created_at - b.created_at);
  const current = all.find((o) => o.is_current && o.state === "active");
  const base = `/projects/${pid}/product-catalog`;
  const noProducts = products.data && products.data.length === 0;

  return (
    <Shell title="Offerings" crumbs={<CatalogCrumbs pid={pid} section="Offerings" />}>
      <div className="page">
        <PageHead title="Offerings" sub="The set of products your paywall offers. Your app asks the SDK for offerings; it gets the default offering unless a customer has an override."
          actions={<Link className="btn btn-dark" to={`${base}/offerings/new`}><Icon name="plus" />New offering</Link>} />

        {offerings.isError ? <LoadError error={offerings.error} retry={() => offerings.refetch()} /> : offerings.isLoading ? <LoadingRows label="Loading offerings" /> : all.length === 0 ? (
          <EmptyState title="No offerings yet"
            text={noProducts ? "Create your first product, then group products into an offering. The SDK shows the default offering on your paywall." : "Group your products into an offering with one package per plan, such as Monthly and Annual. Your first offering becomes the default the SDK returns."}
            action={<div className="actions" style={{ justifyContent: "center" }}>
              {noProducts && <Link className="btn btn-line" to={`${base}/products`}>Create a product</Link>}
              <Link className="btn btn-dark" to={`${base}/offerings/new`}><Icon name="plus" />New offering</Link>
            </div>} />
        ) : (
          <>
            <div className={`cat-defaultbar${current ? "" : " cat-none"}`}>
              <span className="cat-k">Default offering</span>
              {current ? <>
                <Link className="cat-v cat-lnk" to={`${base}/offerings/${current.id}`}><span className="live" />{current.lookup_key}</Link>
                <span className="cat-d">The SDK returns it as <code>offerings.current</code> to every customer without an override.</span>
              </> : <span className="cat-d" style={{ color: "var(--fg)" }}>None. <code>offerings.current</code> is null in your app until you make an offering the default (row menu → Make default).</span>}
            </div>
            <div className="cat-toolbar">
              <Segmented label="Filter offerings" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} />
              <span className="cat-note">{count(rows.length, "offering")}</span>
            </div>
            <DataTable rows={rows} rowKey={(o) => o.id} onRowClick={(o) => nav(`${base}/offerings/${o.id}`)}
              empty={<EmptyState title={filter === "inactive" ? "No inactive offerings" : "No active offerings"} text={filter === "inactive" ? "Offerings you make inactive show up here. The SDK does not return them." : "Every offering is inactive. Make one active from the Inactive tab."} />}
              columns={[
                { key: "id", header: "Identifier", render: (o) => <span className="cat-idc"><Link className="cat-lnk" to={`${base}/offerings/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.lookup_key}</Link>{o.is_current && <DefaultTag />}{o.state === "inactive" && <Tag>Inactive</Tag>}</span> },
                { key: "name", header: "Display name", render: (o) => o.display_name },
                { key: "pk", header: "Packages", render: (o) => <span className="num">{count(o.packages?.items.length ?? 0, "package")}</span> },
                { key: "created", header: "Created", render: (o) => <span className="num">{fmt.date(o.created_at)}</span> },
                { key: "act", header: "Actions", align: "right", render: (o) => <Menu label={`Actions for ${o.lookup_key}`} items={actions.items(o)} /> },
              ]} />
          </>
        )}
      </div>
      {actions.dialog}
    </Shell>
  );
}

type Pending = { kind: "duplicate" | "default" | "archive" | "unarchive" | "delete"; o: Offering } | null;

/** Row-menu actions shared by the list and the detail page: Duplicate, Make default, Make inactive/active, Delete. */
export function useOfferingActions(pid: string, all: Offering[], opts: { onDeleted?: () => void } = {}) {
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [pending, setPending] = useState<Pending>(null);
  const url = (o: Offering) => `${v2(pid)}/offerings/${o.id}`;
  const close = () => setPending(null);

  const ask = (kind: NonNullable<Pending>["kind"], o: Offering) => setPending({ kind, o });
  const items = (o: Offering, withDelete = true): (MenuItem | "-")[] => [
    { label: "Duplicate", icon: "duplicate", onSelect: () => setPending({ kind: "duplicate", o }) },
    { label: "Make default", icon: "check", disabled: o.is_current || o.state !== "active", hint: o.is_current ? "Already the default" : o.state !== "active" ? "Make it active first" : undefined, onSelect: () => setPending({ kind: "default", o }) },
    o.state === "active"
      ? { label: "Make inactive", icon: "archive", disabled: o.is_current, hint: o.is_current ? "Make another offering the default first" : undefined, onSelect: () => setPending({ kind: "archive", o }) }
      : { label: "Make active", icon: "refresh", onSelect: () => setPending({ kind: "unarchive", o }) },
    ...(withDelete ? ["-" as const, { label: "Delete", icon: "trash", danger: true, onSelect: () => setPending({ kind: "delete", o }) }] : []),
  ];

  let dialog: ReactNode = null;
  if (pending) {
    const { o } = pending;
    const id = <code>{o.lookup_key}</code>;
    if (pending.kind === "duplicate") dialog = <DuplicateDialog pid={pid} source={o} taken={new Set(all.map((x) => x.lookup_key))} onClose={close} />;
    if (pending.kind === "default") dialog = (
      <ConfirmDialog title="Make this the default offering?" confirmLabel="Make default" onClose={close} onConfirm={async () => {
        await api(url(o), { method: "POST", json: { is_current: true } }); await refresh(); toast(`${o.lookup_key} is now the default offering`);
      }}>
        <p>Every customer without an override gets {id} as <code>offerings.current</code> the next time their app fetches offerings.</p>
        {all.find((x) => x.is_current) && <p>It replaces <code>{all.find((x) => x.is_current)!.lookup_key}</code>, which stays active and can still be fetched by identifier.</p>}
      </ConfirmDialog>
    );
    if (pending.kind === "archive") dialog = (
      <ConfirmDialog title="Make this offering inactive?" confirmLabel="Make inactive" onClose={close} onConfirm={async () => {
        await api(`${url(o)}/actions/archive`, { method: "POST" }); await refresh(); toast(`${o.lookup_key} is inactive`);
      }}>
        <p>The SDK stops returning {id}. Code that reads <code>offerings["{o.lookup_key}"]</code> gets nothing, and customers with this offering as an override fall back to the default.</p>
        <p>You can make it active again at any time.</p>
      </ConfirmDialog>
    );
    if (pending.kind === "unarchive") dialog = (
      <ConfirmDialog title="Make this offering active?" confirmLabel="Make active" onClose={close} onConfirm={async () => {
        await api(`${url(o)}/actions/unarchive`, { method: "POST", json: { unarchive_referenced_entities: true } }); await refresh(); toast(`${o.lookup_key} is active`);
      }}>
        <p>The SDK returns {id} again. Inactive products in its packages become active too.</p>
      </ConfirmDialog>
    );
    if (pending.kind === "delete") dialog = (
      <ConfirmDialog title="Delete this offering?" confirmLabel="Delete offering" danger onClose={close} onConfirm={async () => {
        await api(url(o), { method: "DELETE" }); await refresh(); toast(`${o.lookup_key} deleted`); opts.onDeleted?.();
      }}>
        <p>This deletes {id} and its {count(o.packages?.items.length ?? 0, "package")}. It cannot be undone. Products and entitlements stay.</p>
        <p>Apps already released keep asking the SDK for this offering: <code>offerings["{o.lookup_key}"]</code> returns nothing, and customers with it as an override fall back to the default.</p>
        {o.is_current && <div className="banner warn"><span><b>This is your default offering.</b> After deleting it, <code>offerings.current</code> is null in your app until you make another offering the default. Most paywalls show nothing in that case.</span></div>}
      </ConfirmDialog>
    );
  }
  return { items, dialog, ask };
}

/** Duplicate: a new offering with the same display name (plus "copy"), metadata, packages and products. */
function DuplicateDialog({ pid, source, taken, onClose }: { pid: string; source: Offering; taken: Set<string>; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [key, setKey] = useState(() => copyKey(source.lookup_key, taken));
  const [name, setName] = useState(`${source.display_name} (copy)`);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pkgs = useMemo(() => [...(source.packages?.items ?? [])].sort((a, b) => a.position - b.position), [source]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ke = lookupKeyError(key.trim(), "offering");
    const er: Record<string, string> = {};
    if (ke) er.key = ke;
    if (!name.trim()) er.name = "Enter a display name.";
    setErr(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    let o: Offering | null = null;
    try {
      o = await api<Offering>(`${v2(pid)}/offerings`, { method: "POST", json: { lookup_key: key.trim(), display_name: name.trim(), metadata: source.metadata } });
      for (const [i, p] of pkgs.entries()) {
        const np = await api<Package>(`${v2(pid)}/offerings/${o.id}/packages`, { method: "POST", json: { lookup_key: p.lookup_key, display_name: p.display_name, position: i } });
        const prods = p.products?.items ?? [];
        if (prods.length) await api(`${v2(pid)}/packages/${np.id}/actions/attach_products`, { method: "POST", json: { products: prods.map((x) => ({ product_id: x.product.id, eligibility_criteria: x.eligibility_criteria })) } });
      }
      await refresh();
      toast(`Duplicated as ${o.lookup_key}`);
      onClose();
      nav(`/projects/${pid}/product-catalog/offerings/${o.id}`);
    } catch (e2) {
      if (o) {
        // The copy exists but is incomplete: open it so the rest can be fixed in the editor.
        await refresh();
        toast(`Copied ${o.lookup_key}, but not every package: ${errMsg(e2)}`);
        onClose();
        nav(`/projects/${pid}/product-catalog/offerings/${o.id}/edit`);
        return;
      }
      if (isConflict(e2)) setErr({ key: "An offering with this identifier already exists. Pick another one." });
      else setErr({ form: errMsg(e2) });
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Duplicate ${source.lookup_key}`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="dup-offering" className="btn btn-dark" disabled={busy}>{busy ? "Duplicating…" : "Duplicate"}</button>
    </>}>
      <form id="dup-offering" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p className="cat-lead">Copies {count(pkgs.length, "package")}, their products and the metadata. The copy is not the default.</p>
        <Field label="Identifier" htmlFor="dup-key" error={err.key} hint="Used to access the offering via the SDK. It cannot be changed later.">
          <input id="dup-key" className="input mono" autoFocus spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="Display name" htmlFor="dup-name" error={err.name}>
          <input id="dup-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {err.form && <div className="banner err" role="alert">{err.form}</div>}
      </form>
    </Dialog>
  );
}
