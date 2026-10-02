/**
 * Product editor (beta): /projects/:projectId/product-catalog/product-editor (prd/catalog/PRD.md "Product editor").
 * "Update prices or create new products for the App Store and Play Store", in RevenueCat's three steps:
 *   1. Update product file: pick the store and the app, select products, download a CSV (one row per product and
 *      territory), edit prices or add rows, upload it. Tabs: Products and Files (every uploaded file and its outcome).
 *   2. Review changes: the server's validation (every problem with its line) or the diff of every price per territory
 *      and every new product, with the warnings; App Store subscriptions keep existing subscribers' prices by default.
 *   3. Commit to store: App Store Connect or Google Play, each row's outcome and the store's message; Retry failed rows.
 * The URL holds the app and the file (`?app=…&edit=…`), so a reload or a Files link opens the same step. Viewers read
 * and download; admins and developers upload and commit.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { Check, ConfirmDialog, DataTable, EmptyState, PageHead, Segmented, Tabs, Tag, useProjectId, useToast, type Column } from "../../components/ui";
import { Icon } from "../../components/icons";
import { AppName, CatalogCrumbs, LoadError, LoadingRows } from "./parts";
import { PRICE_STORES, catalogKey, durationLabel, errMsg, priceLabel, storeStatus, typeLabel, useApps, useStorePrices, v2, type App, type PriceSync, type StoreListing } from "./lib";
import { PriceSource, useCanEdit } from "./store-parts";
import "./store.css";

interface EditRowT {
  idx: number; kind: "price_change" | "new_product"; line: number | null; store_identifier: string; territory: string; currency: string;
  old_amount_micros: number | null; new_amount_micros: number; change_percent: number | null;
  product: { type: string; duration: string | null; display_name: string; group: string | null } | null;
  status: "pending" | "succeeded" | "failed"; error: string | null; attempts: number;
}
interface Edit {
  id: string; app_id: string; store: string; status: "invalid" | "ready" | "committing" | "committed" | "partially_committed" | "failed"; file_name: string;
  created_at: number; committed_at: number | null; created_by_email?: string | null;
  errors: { line: number | null; message: string }[]; warnings: { line: number | null; message: string }[];
  summary: { price_changes?: number; new_products?: number; new_product_prices?: number; unchanged?: number; products?: number; rows?: number };
  options: { preserve_current_price?: boolean }; results?: { pending: number; succeeded: number; failed: number }; rows?: EditRowT[];
}

type StoreKey = "app_store" | "play_store";
const STORE_NAME: Record<StoreKey, string> = { app_store: "App Store Connect", play_store: "Google Play" };
const STATUS_TAG: Record<Edit["status"], [string, "up" | "down" | "info" | "gold" | "muted"]> = {
  invalid: ["Has errors", "down"], ready: ["Ready to commit", "info"], committing: ["Committing", "gold"], committed: ["Committed", "up"],
  partially_committed: ["Partly committed", "down"], failed: ["Failed", "down"],
};
const MAX_BYTES = 1_000_000;
type Dir = "asc" | "desc";
/** One sort state for a table: the column and direction, and the header props DataTable's sortable headers take. */
function useSort<K extends string>(initial: { key: K; dir: Dir }) {
  const [sort, setSort] = useState(initial);
  const of = (key: K) => ({ direction: sort.key === key ? sort.dir : null, onSort: () => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" })) });
  const cmp = <T,>(get: (x: T) => string | number | null) => (a: T, b: T) => {
    const x = get(a), y = get(b);
    const r = x === null ? (y === null ? 0 : 1) : y === null ? -1 : typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort.dir === "asc" ? r : -r;
  };
  return { sort, of, cmp };
}
const money = (micros: number | null, currency: string) => (micros === null ? "—" : priceLabel({ amount_micros: micros, currency }));
const storeOf = (a: App): StoreKey => (a.type === "play_store" ? "play_store" : "app_store");

export function ProductEditorPage() {
  const pid = useProjectId();
  const [params, setParams] = useSearchParams();
  const apps = useApps(pid);
  const prices = useStorePrices(pid);
  const canEdit = useCanEdit(pid);
  const editable = useMemo(() => (apps.data ?? []).filter((a) => PRICE_STORES.has(a.type)), [apps.data]);
  const appId = params.get("app") ?? editable[0]?.id ?? "";
  const app = editable.find((a) => a.id === appId);
  const editId = params.get("edit");
  const setQuery = useCallback((next: Record<string, string | null>) => {
    setParams((p) => {
      const q = new URLSearchParams(p);
      for (const [k, v] of Object.entries(next)) if (v === null) q.delete(k); else q.set(k, v);
      return q;
    }, { replace: false });
  }, [setParams]);

  let body: ReactNode;
  if (apps.isError) body = <LoadError error={apps.error} retry={() => apps.refetch()} />;
  else if (apps.isLoading) body = <LoadingRows label="Loading apps" rows={4} />;
  else if (!editable.length) body = (
    <EmptyState title="Add an App Store or Google Play app" text="The product editor changes prices in App Store Connect and Google Play. Add one of those apps with its store key first."
      action={<Link className="btn btn-dark" to={`/projects/${pid}/apps`}><Icon name="plus" />Add an app</Link>} />
  );
  else if (!app) body = <EmptyState title="App not found" text="It may have been deleted." action={<button type="button" className="btn btn-line" onClick={() => setQuery({ app: null, edit: null })}>Choose another app</button>} />;
  else body = editId
    ? <EditView key={editId} pid={pid} app={app} editId={editId} canEdit={canEdit} onBack={() => setQuery({ edit: null })} onOpen={(id) => setQuery({ edit: id })} />
    : <ChooseStep pid={pid} app={app} apps={editable} sync={prices.data?.apps.find((x) => x.app_id === app.id)} listings={prices.data?.items.filter((l) => l.app_id === app.id)} loading={prices.isLoading}
      canEdit={canEdit} preselect={params.get("products")} onApp={(id) => setQuery({ app: id, edit: null, products: null })} onOpen={(id) => setQuery({ edit: id, products: null })} />;

  return (
    <Shell title="Product editor" crumbs={<CatalogCrumbs pid={pid} section="Products" sectionTo="products" current="Product editor" />}>
      <div className="page pe">
        <PageHead title="Product editor" sub="Update prices or create new products for the App Store and Play Store." actions={<Tag tone="gold">Beta</Tag>} />
        {!canEdit && <div className="banner" role="note"><Icon name="eye" /><span>You can download product files and read past ones. Only admins and developers can upload and commit changes to the stores.</span></div>}
        {body}
      </div>
    </Shell>
  );
}

function Steps({ at }: { at: 1 | 2 | 3 }) {
  const names = ["Update product file", "Review changes", "Commit to store"];
  return (
    <ol className="pe-steps" aria-label="Steps">
      {names.map((n, i) => (
        <li key={n} className={i + 1 === at ? "on" : i + 1 < at ? "done" : ""} aria-current={i + 1 === at ? "step" : undefined}>
          <span className="n">{i + 1 < at ? <Icon name="check" /> : i + 1}</span><span>{n}</span>
        </li>
      ))}
    </ol>
  );
}

// ---- Step 1 -----------------------------------------------------------------------------------------------------------

function ChooseStep({ pid, app, apps, sync, listings, loading, canEdit, preselect, onApp, onOpen }: {
  pid: string; app: App; apps: App[]; sync: PriceSync | undefined;
  listings: StoreListing[] | undefined; loading: boolean; canEdit: boolean; preselect: string | null; onApp: (id: string) => void; onOpen: (id: string) => void;
}) {
  const [tab, setTab] = useState<"products" | "files">("products");
  const store = storeOf(app);
  const stores = (["app_store", "play_store"] as StoreKey[]).filter((s) => apps.some((a) => storeOf(a) === s));
  const sameStore = apps.filter((a) => storeOf(a) === store);
  const files = useQuery({ queryKey: [...catalogKey(pid), "edits", app.id], queryFn: () => api<List<Edit>>(`${v2(pid)}/product_edits?app_id=${encodeURIComponent(app.id)}`).then((r) => r.items) });
  return (
    <>
      <Steps at={1} />
      <div className="pe-pick">
        <Segmented label="Store" value={store} onChange={(s) => onApp(apps.find((a) => storeOf(a) === s)!.id)} options={stores.map((s) => ({ value: s, label: s === "app_store" ? "App Store" : "Play Store" }))} />
        {sameStore.length > 1 ? (
          <label className="pe-app"><span className="sr">App</span>
            <select className="select" aria-label="App" value={app.id} onChange={(e) => onApp(e.target.value)}>{sameStore.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          </label>
        ) : <AppName app={app} sub />}
      </div>
      <Tabs label="Product editor" value={tab} onChange={setTab} idBase="pe" tabs={[{ value: "products", label: "Products" }, { value: "files", label: "Files", badge: files.data?.length ? String(files.data.length) : undefined }]} />
      {tab === "products"
        ? <ProductsTab key={app.id} pid={pid} app={app} sync={sync} listings={listings} loading={loading} canEdit={canEdit} preselect={preselect} onUploaded={onOpen} />
        : <FilesTab files={files} onOpen={onOpen} />}
    </>
  );
}

function ProductsTab({ pid, app, sync, listings, loading, canEdit, preselect, onUploaded }: {
  pid: string; app: App; sync: PriceSync | undefined; listings: StoreListing[] | undefined; loading: boolean;
  canEdit: boolean; preselect: string | null; onUploaded: (id: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [sel, setSel] = useState<Set<string>>(() => new Set(preselect ? preselect.split(",") : []));
  const [busy, setBusy] = useState<"download" | "upload" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sorter = useSort<"product" | "price" | "status">({ key: "product", dir: "asc" });
  const items = useMemo(() => [...(listings ?? [])].sort((a, b) => Number(b.editable) - Number(a.editable) || a.store_identifier.localeCompare(b.store_identifier)), [listings]);
  const choosable = items.filter((i) => i.editable);
  const play = app.type === "play_store";
  const store = STORE_NAME[storeOf(app)];
  if (sync && !sync.can_read_prices) {
    return (
      <div className="banner warn pe-cant" role="alert" data-testid="pe-no-key">
        <Icon name="warn" />
        <div><b>RevenueDot cannot read or change this app's prices yet.</b><p>{sync.reason}</p>
          <Link className="btn btn-line" to={`/projects/${pid}/apps/${app.id}`}>Open app settings</Link></div>
      </div>
    );
  }
  const download = async () => {
    setBusy("download");
    try {
      // Only products that can be chosen: a link's ?products= may name one that is gone or cannot be edited.
      const ids = choosable.filter((c) => sel.has(c.store_identifier)).map((c) => c.store_identifier);
      const res = await fetch(`${v2(pid)}/apps/${encodeURIComponent(app.id)}/store_products/export.csv?store_identifiers=${encodeURIComponent(ids.join(","))}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? `Download failed (${res.status})`);
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "products.csv";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Downloaded ${name}`);
      // The download read the store again: show the fresh prices (without holding the button).
      void qc.invalidateQueries({ queryKey: [...catalogKey(pid), "store-prices"] });
    } catch (e) { toast(errMsg(e)); }
    setBusy(null);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { setUploadError(`${f.name} is ${(f.size / 1_000_000).toFixed(1)} MB; upload at most 1 MB at a time.`); return; }
    if (!/\.(csv|txt)$/i.test(f.name) && f.type && !/csv|text/.test(f.type)) { setUploadError(`${f.name} is not a CSV file. Upload the .csv you downloaded and edited.`); return; }
    setBusy("upload"); setUploadError(null);
    try {
      const edit = await api<Edit>(`${v2(pid)}/product_edits`, { method: "POST", json: { app_id: app.id, file_name: f.name, csv: await f.text() } });
      await qc.invalidateQueries({ queryKey: catalogKey(pid) });
      onUploaded(edit.id);
    } catch (e) { setUploadError(errMsg(e)); setBusy(null); }
  };
  const allOn = choosable.length > 0 && choosable.every((i) => sel.has(i.store_identifier));
  const picked = choosable.filter((c) => sel.has(c.store_identifier)).length;
  const toggle = (i: StoreListing) => {
    if (!i.editable) return;
    const n = new Set(sel);
    if (n.has(i.store_identifier)) n.delete(i.store_identifier); else n.add(i.store_identifier);
    setSel(n);
  };
  const off = (i: StoreListing) => (i.editable ? "" : "pe-off");
  const columns: Column<StoreListing>[] = [
    {
      key: "pick", header: "Select",
      headerExtra: <input type="checkbox" aria-label="Select all products" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(choosable.map((c) => c.store_identifier)))} disabled={!choosable.length} />,
      render: (i) => <input type="checkbox" aria-label={`Select ${i.store_identifier}`} checked={sel.has(i.store_identifier)} disabled={!i.editable} onChange={() => toggle(i)} onClick={(e) => e.stopPropagation()} />,
    },
    {
      key: "product", header: "Product", sort: sorter.of("product"),
      render: (i) => <span className={`cat-cell ${off(i)}`} title={i.editable ? undefined : play && i.type === "one_time" ? "Play Store one-time purchases aren't supported yet." : i.note ?? "This product cannot be edited here."}><span className="cat-t">{i.display_name ?? i.store_identifier}</span><span className="cat-s">{i.store_identifier}</span></span>,
    },
    { key: "type", header: "Type", className: "cat-hide-sm", render: (i) => <span className={off(i)}>{typeLabel(i.type)}{i.duration ? <span className="subtle"> · {durationLabel(i.duration)}</span> : null}</span> },
    { key: "price", header: "Price", sort: sorter.of("price"), render: (i) => <span className={`mono ${off(i)}`}>{i.price ? priceLabel(i.price) : <span className="subtle">No price</span>}{i.price?.territory && <span className="subtle"> {i.price.territory}</span>}</span> },
    { key: "terr", header: "Territories", align: "right", className: "cat-hide-sm", render: (i) => <span className="num">{i.prices.length}</span> },
    { key: "status", header: "Status", sort: sorter.of("status"), className: "cat-hide-sm", render: (i) => { const st = storeStatus(i.status); return st ? <Tag tone={st.tone}>{st.label}</Tag> : "—"; } },
  ];
  const ordered = [...items].sort(sorter.sort.key === "product" ? sorter.cmp((i: StoreListing) => i.display_name ?? i.store_identifier)
    // Prices group by currency first, then by amount: micros of different currencies are not comparable.
    : sorter.sort.key === "price" ? sorter.cmp((i: StoreListing) => (i.price ? `${i.price.currency} ${String(i.price.amount_micros).padStart(16, "0")}` : null))
      : sorter.cmp((i: StoreListing) => storeStatus(i.status)?.label ?? null));
  return (
    <div className="pe-products">
      <div className="pe-bar">
        <b data-testid="pe-count">{choosable.length ? `${picked} selected of ${choosable.length} products` : "No products to select"}</b>
        <span className="grow" />
        <button type="button" className="btn btn-dark" disabled={!picked || busy !== null} onClick={download}><Icon name="download" />{busy === "download" ? "Preparing…" : "Download .csv"}</button>
      </div>
      <div className="panel pe-src"><PriceSource pid={pid} app={app} sync={sync} canEdit={canEdit} />
        {play && <div className="pb cat-note" data-testid="pe-play-note"><Icon name="warn" />Play Store one-time purchases aren't supported yet. Their prices are shown but cannot be selected.</div>}
      </div>
      {loading ? <LoadingRows label="Loading products" rows={4} /> : !items.length ? (
        <div className="panel"><div className="pb cat-note">{sync?.status === "never" ? `Reading products from ${store}…` : `${store} has no products for this app yet. Add a row with action create to the CSV to make one.`}</div></div>
      ) : <div className="pe-table"><DataTable columns={columns} rows={ordered} rowKey={(i) => i.store_identifier} onRowClick={toggle} /></div>}
      <section className="pe-upload" aria-label="Upload a product file">
        <h2>Upload the edited file</h2>
        <p className="cat-lead">Change the <code>price</code> column, or add rows with <code>action</code> set to <code>create</code> for new products. Territories use {play ? "Google Play's two-letter region codes (US, GB)" : "App Store Connect's three-letter codes (USA, GBR)"}. <a className="cat-lnk" href="https://revenuedot.app/docs/guides/product-editor" target="_blank" rel="noreferrer">CSV format</a></p>
        {canEdit ? (
          <div className={`drop${over ? " over" : ""}`} data-testid="pe-drop" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files[0]); }}>
            <Icon name="docs" />
            <span>{busy === "upload" ? `Reading ${store} and checking the file…` : "Drop the .csv here, or choose it. Nothing changes in the store until you review and commit."}</span>
            <label htmlFor="pe-file" className="btn btn-line">Choose file</label>
            <input ref={fileInput} id="pe-file" className="sr" type="file" accept=".csv,text/csv" disabled={busy !== null} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
            {uploadError && <span className="err" role="alert">{uploadError}</span>}
          </div>
        ) : <p className="cat-note">Only admins and developers can upload product files.</p>}
      </section>
    </div>
  );
}

function FilesTab({ files, onOpen }: { files: ReturnType<typeof useQuery<Edit[]>>; onOpen: (id: string) => void }) {
  const sorter = useSort<"uploaded" | "status" | "file">({ key: "uploaded", dir: "desc" });
  if (files.isError) return <LoadError error={files.error} retry={() => files.refetch()} />;
  if (files.isLoading) return <LoadingRows label="Loading files" rows={3} />;
  const list = files.data ?? [];
  if (!list.length) return <div className="panel"><div className="pb cat-note">No files uploaded for this app yet. Download a CSV on the Products tab, change it, and upload it.</div></div>;
  const ordered = [...list].sort(sorter.sort.key === "uploaded" ? sorter.cmp((f: Edit) => f.created_at) : sorter.sort.key === "status" ? sorter.cmp((f: Edit) => STATUS_TAG[f.status]?.[0] ?? f.status) : sorter.cmp((f: Edit) => f.file_name));
  const columns: Column<Edit>[] = [
    { key: "file", header: "File", sort: sorter.of("file"), render: (f) => <span className="cat-cell"><span className="cat-lnk cat-t">{f.file_name}</span><span className="cat-s">{f.id}</span></span> },
    { key: "uploaded", header: "Uploaded", sort: sorter.of("uploaded"), className: "cat-hide-sm", render: (f) => <span className="cat-cell"><span>{fmt.dateTime(f.created_at)}</span><span className="cat-s">{f.created_by_email ?? "API key"}</span></span> },
    { key: "status", header: "Status", sort: sorter.of("status"), render: (f) => { const [label, tone] = STATUS_TAG[f.status] ?? [f.status, "muted"]; return <Tag tone={tone}>{label}</Tag>; } },
    { key: "changes", header: "Changes", align: "right", className: "cat-hide-sm", render: (f) => <span className="num">{f.status === "invalid" ? `${f.errors.length} ${f.errors.length === 1 ? "error" : "errors"}` : (f.summary.price_changes ?? 0) + (f.summary.new_product_prices ?? 0)}</span> },
    { key: "results", header: "Results", align: "right", className: "cat-hide-sm", render: (f) => <span className="num">{f.results && (f.results.succeeded || f.results.failed) ? <>{f.results.succeeded} ok{f.results.failed ? <span className="down"> · {f.results.failed} failed</span> : null}</> : "—"}</span> },
  ];
  return <div className="pe-files"><DataTable columns={columns} rows={ordered} rowKey={(f) => f.id} onRowClick={(f) => onOpen(f.id)} /></div>;
}

// ---- Steps 2 and 3 ------------------------------------------------------------------------------------------------------

function EditView({ pid, app, editId, canEdit, onBack, onOpen }: { pid: string; app: App; editId: string; canEdit: boolean; onBack: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = [...catalogKey(pid), "edit", editId];
  const [running, setRunning] = useState(false);
  // Another tab (or person) committing this file: follow its progress.
  const edit = useQuery({
    queryKey: key, queryFn: () => api<Edit>(`${v2(pid)}/product_edits/${encodeURIComponent(editId)}`),
    refetchInterval: (q) => (q.state.data?.status === "committing" && !running ? 3000 : false),
  });
  const listings = useStorePrices(pid);
  const [confirm, setConfirm] = useState(false);
  const [discard, setDiscard] = useState(false);
  // The checkbox follows the click at once; the server's copy is the truth after the save.
  const [preserveShown, setPreserveShown] = useState<boolean | null>(null);
  const e = edit.data;
  const store = STORE_NAME[storeOf(app)];
  const run = useCallback(async (action: "commit" | "retry") => {
    setRunning(true);
    try {
      let r = await api<Edit>(`${v2(pid)}/product_edits/${encodeURIComponent(editId)}/actions/${action}`, { method: "POST" });
      qc.setQueryData(key, r);
      // A commit writes for at most 20 seconds a call; keep calling until every row has an outcome.
      for (let i = 0; r.status === "committing" && i < 50; i++) {
        r = await api<Edit>(`${v2(pid)}/product_edits/${encodeURIComponent(editId)}/actions/commit`, { method: "POST" });
        qc.setQueryData(key, r);
      }
      toast(r.status === "committed" ? `Committed to ${store}` : r.status === "failed" ? `Nothing was committed to ${store}` : `Some rows failed in ${store}`);
    } catch (err) { toast(errMsg(err)); await edit.refetch(); }
    await qc.invalidateQueries({ queryKey: catalogKey(pid) });
    setRunning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, editId, store]);
  // An edit left mid-commit (the tab was closed) continues when it is opened again.
  const resumed = useRef(false);
  useEffect(() => {
    if (e?.status === "committing" && canEdit && !running && !resumed.current) { resumed.current = true; void run("commit"); }
  }, [e?.status, canEdit, running, run]);

  if (edit.isError) return <><Steps at={2} /><LoadError error={edit.error} retry={() => edit.refetch()} /><p><button type="button" className="btn btn-line" onClick={onBack}>Back to products</button></p></>;
  if (!e) return <><Steps at={2} /><LoadingRows label="Loading the file" rows={5} /></>;
  const rows = e.rows ?? [];
  const reviewing = e.status === "ready" || e.status === "invalid";
  const committable = rows.length;
  // Apple's preserveCurrentPrice concerns price changes of existing subscriptions (in-app purchases have no subscribers).
  const typeOf = (id: string) => listings.data?.items.find((l) => l.app_id === app.id && l.store_identifier === id)?.type;
  const hasSubChanges = storeOf(app) === "app_store" && rows.some((r) => r.kind === "price_change" && (typeOf(r.store_identifier) ?? "subscription") === "subscription");
  const setPreserve = async (v: boolean) => {
    setPreserveShown(v);
    try { qc.setQueryData(key, await api<Edit>(`${v2(pid)}/product_edits/${encodeURIComponent(editId)}`, { method: "POST", json: { preserve_current_price: v } })); }
    catch (err) { toast(errMsg(err)); }
    setPreserveShown(null);
  };
  const [label, tone] = STATUS_TAG[e.status];
  return (
    <>
      <Steps at={reviewing ? 2 : 3} />
      <div className="pe-filehead">
        <span className="cat-cell"><b className="cat-t">{e.file_name}</b><span className="cat-s">Uploaded {fmt.dateTime(e.created_at)}{e.created_by_email ? ` by ${e.created_by_email}` : ""} · {app.name}</span></span>
        <span data-testid="pe-status"><Tag tone={tone}>{label}</Tag></span>
      </div>
      {e.status === "ready" && <Summary e={e} />}
      {e.status === "invalid" && (
        <div className="banner err pe-errors" role="alert" data-testid="pe-errors">
          <Icon name="warn" />
          <div>
            <b>{e.errors.length === 1 ? "The file has 1 problem" : `The file has ${e.errors.length} problems`}. Nothing was changed. Fix {e.errors.length === 1 ? "it" : "them"} and upload the file again.</b>
            <ul>{e.errors.map((x, i) => <li key={i}>{x.line ? <span className="mono">Line {x.line}: </span> : null}{x.message}</li>)}</ul>
          </div>
        </div>
      )}
      {e.warnings.length > 0 && reviewing && (
        <details className="pe-warn" open={e.warnings.length <= 5}>
          <summary>{e.warnings.length === 1 ? "1 note" : `${e.warnings.length} notes`} to check</summary>
          <ul>{e.warnings.map((x, i) => <li key={i}>{x.line ? <span className="mono">Line {x.line}: </span> : null}{x.message}</li>)}</ul>
        </details>
      )}
      {e.status !== "invalid" && <Diff rows={rows} results={!reviewing} />}
      {e.status === "ready" && hasSubChanges && (
        <div className="pe-opt">
          <Check checked={preserveShown ?? e.options.preserve_current_price !== false} disabled={!canEdit} onChange={setPreserve} label="Keep existing subscribers on their current price"
            hint="Apple's preserveCurrentPrice. Turn it off to move existing subscribers to the new price; Apple asks them to agree to an increase." />
        </div>
      )}
      {storeOf(app) === "play_store" && e.status === "ready" && rows.some((r) => r.kind === "price_change") && (
        <p className="cat-note">Google Play applies new base plan prices to new subscribers. Existing subscribers keep their price until you migrate them in Play Console.</p>
      )}
      <div className="pe-actions">
        <button type="button" className="btn btn-line" onClick={onBack}><Icon name="undo" />{e.status === "invalid" ? "Upload a corrected file" : reviewing ? "Back" : "Back to products"}</button>
        {reviewing && canEdit && <button type="button" className="btn btn-ghost" onClick={() => setDiscard(true)}><Icon name="trash" />Discard file</button>}
        <span className="grow" />
        {e.status === "ready" && canEdit && (
          <button type="button" className="btn btn-dark" disabled={running} onClick={() => setConfirm(true)}><Icon name="send" />Commit {committable} {committable === 1 ? "change" : "changes"} to {store}</button>
        )}
        {(e.status === "partially_committed" || e.status === "failed") && canEdit && (
          <button type="button" className="btn btn-dark" disabled={running} onClick={() => void run("retry")}><Icon name="refresh" />{running ? "Retrying…" : `Retry ${e.results?.failed ?? rows.filter((r) => r.status === "failed").length} failed`}</button>
        )}
        {e.status === "committing" && <span className="cat-note"><Icon name="hourglass" />Committing to {store}…</span>}
      </div>
      {confirm && (
        <ConfirmDialog title={`Commit to ${store}?`} confirmLabel={`Commit ${committable} ${committable === 1 ? "change" : "changes"}`} onClose={() => setConfirm(false)} onConfirm={async () => { setConfirm(false); await run("commit"); }}>
          <p>This changes {e.summary.price_changes ?? 0} {e.summary.price_changes === 1 ? "price" : "prices"}{e.summary.new_products ? ` and creates ${e.summary.new_products} ${e.summary.new_products === 1 ? "product" : "products"}` : ""} in {store} for {app.name}. Customers see new prices once {store} applies them.</p>
          <p>Each change is recorded in the audit log. Rows that fail can be retried.</p>
        </ConfirmDialog>
      )}
      {discard && (
        <ConfirmDialog title="Discard this file?" confirmLabel="Discard" danger onClose={() => setDiscard(false)} onConfirm={async () => {
          await api(`${v2(pid)}/product_edits/${encodeURIComponent(editId)}`, { method: "DELETE" });
          await qc.invalidateQueries({ queryKey: catalogKey(pid) });
          onBack();
        }}>
          <p>{e.file_name} is removed from the Files tab. Nothing was sent to {store}.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function Summary({ e }: { e: Edit }) {
  const tiles: [string, number][] = [["Price changes", e.summary.price_changes ?? 0], ["New products", e.summary.new_products ?? 0], ["Unchanged rows", e.summary.unchanged ?? 0], ["Products", e.summary.products ?? 0]];
  return (
    <div className="pe-summary" data-testid="pe-summary">
      {tiles.map(([k, v]) => <div key={k}><span className="k">{k}</span><span className="v">{v.toLocaleString("en-US")}</span></div>)}
    </div>
  );
}

/** Every change, grouped by product; with results once committed. */
function Diff({ rows, results }: { rows: EditRowT[]; results: boolean }) {
  const groups = useMemo(() => {
    const m = new Map<string, EditRowT[]>();
    for (const r of rows) m.set(r.store_identifier, [...(m.get(r.store_identifier) ?? []), r]);
    return [...m];
  }, [rows]);
  if (!rows.length) return null;
  return (
    <div className="pe-diff" data-testid="pe-diff">
      {groups.map(([id, rs]) => {
        const np = rs[0]!.product;
        const ok = rs.filter((r) => r.status === "succeeded").length, bad = rs.filter((r) => r.status === "failed").length;
        return (
          <section key={id} className="panel" aria-label={`Changes to ${id}`}>
            <div className="ph">
              <span className="cat-cell"><b className="cat-t mono">{id}</b>{np && <span className="cat-s">New {typeLabel(np.type).toLowerCase()}{np.duration ? ` · ${durationLabel(np.duration)}` : ""}{np.group ? ` · group ${np.group}` : ""} · “{np.display_name}”</span>}</span>
              <span className="hrow">{np && <Tag tone="info">New product</Tag>}{results && <span className="cat-note">{ok} committed{bad ? <span className="down"> · {bad} failed</span> : null}</span>}</span>
            </div>
            <div className="tbl"><table className="pe-difft">
              <thead><tr><th className="pe-w-terr">Territory</th><th className="amt cat-hide-sm">Current</th><th className="amt">New</th><th className="amt cat-hide-sm">Change</th>{results && <th className="pe-w-res">Result</th>}</tr></thead>
              <tbody>{rs.map((r) => (
                <tr key={r.idx} className={r.status === "failed" ? "pe-failed" : undefined}>
                  <td className="mono">{r.territory} <span className="subtle">{r.currency}</span>{r.line ? <span className="subtle cat-hide-sm"> · line {r.line}</span> : null}</td>
                  <td className="amt mono subtle cat-hide-sm">{r.old_amount_micros === null ? (r.kind === "new_product" ? "—" : "No price") : money(r.old_amount_micros, r.currency)}</td>
                  <td className="amt mono"><b>{money(r.new_amount_micros, r.currency)}</b>{r.old_amount_micros !== null && <span className="cat-show-sm subtle pe-was">was {money(r.old_amount_micros, r.currency)}</span>}</td>
                  <td className={`amt mono cat-hide-sm ${r.change_percent === null ? "subtle" : r.change_percent > 0 ? "up" : "down"}`}>{r.change_percent === null ? "new" : `${r.change_percent > 0 ? "+" : ""}${r.change_percent}%`}</td>
                  {results && <td>{r.status === "succeeded" ? <Tag tone="up">Committed</Tag> : r.status === "failed" ? <span className="pe-res"><Tag tone="down">Failed</Tag><span className="pe-msg">{r.error}</span></span> : <Tag>Pending</Tag>}{r.status === "succeeded" && r.error ? <span className="pe-msg subtle">{r.error}</span> : null}</td>}
                </tr>
              ))}</tbody>
            </table></div>
          </section>
        );
      })}
    </div>
  );
}
