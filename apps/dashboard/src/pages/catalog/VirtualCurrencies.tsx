/**
 * In-app currencies: /projects/:projectId/product-catalog/virtual-currencies
 * List (code, name, grants, state) with New, Edit, Archive, Unarchive and Delete. A product grant credits a customer's
 * balance each time one of its products is bought, renewed or starts a trial. Balances are read on the customer page API
 * (`GET /v2/projects/{id}/customers/{id}/virtual_currencies`).
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { ConfirmDialog, DataTable, Dialog, EmptyState, Field, Menu, PageHead, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { CatalogCrumbs, LoadError, LoadingRows } from "./parts";
import { count, errMsg, listAll, productName, useProducts, v2, type Product } from "./lib";

interface Grant { product_ids: string[]; amount: number; trial_amount: number; expire_at_cycle_end: boolean }
interface Currency { object: "virtual_currency"; code: string; name: string; description: string | null; state: "active" | "inactive"; created_at: number; product_grants: Grant[] }

const useCurrencies = (pid: string) => useQuery({ queryKey: ["virtual-currencies", pid], queryFn: () => listAll<Currency>(`${v2(pid)}/virtual_currencies`), enabled: !!pid });

type Pending = { kind: "edit" | "archive" | "unarchive" | "delete"; c: Currency } | null;

function CurrencyDialog({ pid, existing, onClose, onSaved }: { pid: string; existing?: Currency; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const products = useProducts(pid);
  const [code, setCode] = useState(existing?.code ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [grants, setGrants] = useState<{ productId: string; amount: string; trial: string }[]>(
    (existing?.product_grants ?? []).flatMap((g) => g.product_ids.map((id) => ({ productId: id, amount: String(g.amount), trial: String(g.trial_amount) }))));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = (products.data ?? []).filter((p: Product) => p.state === "active");

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!existing && !/^[a-zA-Z0-9_]{1,10}$/.test(code)) { setErr("The code is 1 to 10 letters, digits or underscores, such as GLD."); return; }
    if (!name.trim()) { setErr("Enter a name."); return; }
    const parsed = grants.filter((g) => g.productId);
    if (parsed.some((g) => !/^\d+$/.test(g.amount) || Number(g.amount) < 1)) { setErr("Each grant needs a whole number of at least 1."); return; }
    if (parsed.some((g) => g.trial !== "" && !/^\d+$/.test(g.trial))) { setErr("Trial amounts must be whole numbers."); return; }
    setBusy(true); setErr(null);
    const product_grants = parsed.map((g) => ({ product_ids: [g.productId], amount: Number(g.amount), trial_amount: g.trial === "" ? 0 : Number(g.trial) }));
    try {
      if (existing) await api(`${v2(pid)}/virtual_currencies/${existing.code}`, { method: "POST", json: { name: name.trim(), description: description.trim() || null, product_grants } });
      else await api(`${v2(pid)}/virtual_currencies`, { method: "POST", json: { code, name: name.trim(), description: description.trim() || null, product_grants } });
      toast(existing ? "Currency saved" : "Currency created"); onSaved(); onClose();
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  }

  return (
    <Dialog title={existing ? "Edit in-app currency" : "New in-app currency"} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="currency-form" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </>}>
      <form id="currency-form" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Code" htmlFor="vc-code" hint="What your backend uses. It cannot be changed later.">
          <input id="vc-code" className="input mono" autoFocus={!existing} value={code} disabled={!!existing} placeholder="GLD" onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Name" htmlFor="vc-name"><input id="vc-name" className="input" autoFocus={!!existing} value={name} placeholder="Gold" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description" htmlFor="vc-desc" hint="Optional."><input id="vc-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div>
          <div className="label">Product grants</div>
          <p className="subtle" style={{ margin: "2px 0 8px" }}>Buying, renewing or starting a trial of a product credits this amount, once per store transaction.</p>
          {grants.map((g, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <select aria-label={`Product ${i + 1}`} className="select" value={g.productId} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                <option value="">Choose a product</option>
                {list.map((p) => <option key={p.id} value={p.id}>{productName(p)}</option>)}
              </select>
              <input aria-label={`Amount ${i + 1}`} className="input" style={{ width: 90 }} inputMode="numeric" placeholder="Amount" value={g.amount} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <input aria-label={`Trial amount ${i + 1}`} className="input" style={{ width: 90 }} inputMode="numeric" placeholder="Trial" value={g.trial} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, trial: e.target.value } : x)))} />
              <button type="button" className="btn btn-line" aria-label={`Remove grant ${i + 1}`} onClick={() => setGrants(grants.filter((_, j) => j !== i))}><Icon name="trash" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-line" onClick={() => setGrants([...grants, { productId: "", amount: "100", trial: "" }])}><Icon name="plus" />Add a grant</button>
        </div>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

export function VirtualCurrenciesPage() {
  const pid = useProjectId();
  const toast = useToast();
  const cur = useCurrencies(pid);
  const products = useProducts(pid);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const rows = (cur.data ?? []).slice().sort((a, b) => a.created_at - b.created_at);
  const name = (id: string) => { const p = products.data?.find((x) => x.id === id); return p ? productName(p) : id; };
  const refresh = () => cur.refetch();
  const url = (c: Currency) => `${v2(pid)}/virtual_currencies/${c.code}`;
  const items = (c: Currency): (MenuItem | "-")[] => [
    { label: "Edit", icon: "edit", onSelect: () => setPending({ kind: "edit", c }) },
    c.state === "active" ? { label: "Archive", icon: "archive", onSelect: () => setPending({ kind: "archive", c }) } : { label: "Unarchive", icon: "refresh", onSelect: () => setPending({ kind: "unarchive", c }) },
    "-", { label: "Delete", icon: "trash", danger: true, onSelect: () => setPending({ kind: "delete", c }) },
  ];
  let dialog: ReactNode = null;
  if (pending) {
    const { c } = pending;
    const close = () => setPending(null);
    if (pending.kind === "edit") dialog = <CurrencyDialog pid={pid} existing={c} onClose={close} onSaved={refresh} />;
    if (pending.kind === "archive") dialog = (
      <ConfirmDialog title="Archive this currency?" confirmLabel="Archive" danger onClose={close} onConfirm={async () => { await api(`${url(c)}/actions/archive`, { method: "POST" }); await refresh(); toast(`${c.code} archived`); }}>
        <p>An archived currency stops granting on purchases. Customers keep their balance.</p>
      </ConfirmDialog>
    );
    if (pending.kind === "unarchive") dialog = (
      <ConfirmDialog title="Unarchive this currency?" confirmLabel="Unarchive" onClose={close} onConfirm={async () => { await api(`${url(c)}/actions/unarchive`, { method: "POST" }); await refresh(); toast(`${c.code} restored`); }}>
        <p>Purchases of its products credit balances again.</p>
      </ConfirmDialog>
    );
    if (pending.kind === "delete") dialog = (
      <ConfirmDialog title="Delete this currency?" confirmLabel="Delete currency" danger onClose={close} onConfirm={async () => { await api(url(c), { method: "DELETE" }); await refresh(); toast(`${c.code} deleted`); }}>
        <p>This deletes <code>{c.code}</code>, every customer's balance of it and its ledger. It cannot be undone.</p>
      </ConfirmDialog>
    );
  }
  return (
    <Shell title="In-app currencies" crumbs={<CatalogCrumbs pid={pid} section="In-app currencies" />}>
      <div className="page">
        <PageHead title="In-app currencies" sub="Coins, gems or credits your app sells or rewards. Products can grant a currency; your backend spends it through the API."
          actions={<button type="button" className="btn btn-dark" onClick={() => setCreating(true)}><Icon name="plus" />New currency</button>} />
        {cur.isError ? <LoadError error={cur.error} retry={() => cur.refetch()} /> : cur.isLoading ? <LoadingRows label="Loading currencies" /> : !rows.length ? (
          <EmptyState title="No in-app currencies yet" text="Create a currency such as GLD, then choose which products grant it. Balances are per customer." action={<button type="button" className="btn btn-dark" onClick={() => setCreating(true)}>New currency</button>} />
        ) : (
          <DataTable rowKey={(c) => c.code} rows={rows} columns={[
            { key: "code", header: "Code", render: (c) => <code>{c.code}</code> },
            { key: "name", header: "Name", render: (c) => c.name },
            { key: "grants", header: "Granted by", render: (c) => c.product_grants.length ? c.product_grants.map((g, i) => <div key={i}>{g.product_ids.map(name).join(", ")}: {g.amount}{g.trial_amount ? ` (${g.trial_amount} in trial)` : ""}</div>) : <span className="subtle">No product grants</span> },
            { key: "state", header: "State", render: (c) => <Tag tone={c.state === "active" ? "up" : "muted"}>{c.state === "active" ? "Active" : "Archived"}</Tag> },
            { key: "menu", header: "", align: "right", render: (c) => <Menu label={`Actions for ${c.code}`} items={items(c)} /> },
          ]} />
        )}
        <p className="subtle" style={{ marginTop: 12 }}>{count(rows.length, "currency", "currencies")}. Credit or spend from your backend with <code>POST /v2/projects/{pid}/customers/{"{id}"}/virtual_currencies/transactions</code>.</p>
      </div>
      {creating && <CurrencyDialog pid={pid} onClose={() => setCreating(false)} onSaved={refresh} />}
      {dialog}
    </Shell>
  );
}
