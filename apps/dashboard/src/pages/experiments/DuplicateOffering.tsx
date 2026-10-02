import { useMemo, useState, type DragEvent, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Check, Dialog, Field } from "../../components/ui";
import { Icon } from "../../components/icons";
import { durationLabel, errMsg, lookupKeyError, priceLabel, productName, useProducts, v2, type Offering, type PackageProduct } from "../catalog/lib";
import { TREATMENT_HELP, typeName } from "./lib";

/**
 * "Duplicate the control offering" (prd/experiments/PRD.md §1): a copy of an offering for an experiment's treatment, with
 * each package's product swappable (another price, period, trial or introductory offer), the packages reorderable (drag,
 * or the arrow keys on the handle) and, when the offering has one, a copy of its paywall.
 */
interface Row { uid: string; packageId: string; lookupKey: string; name: string; products: { productId: string; eligibility: PackageProduct["eligibility_criteria"]; appId: string }[] }

export function DuplicateOfferingDialog({ pid, source, type, taken, onClose, onCreated }: {
  pid: string; source: Offering; type: string; taken: string[]; onClose: () => void; onCreated: (o: Offering) => void;
}) {
  const qc = useQueryClient();
  const products = useProducts(pid);
  const slug = type === "other" ? "copy" : type.split("_")[0]!;
  const freeKey = useMemo(() => {
    const base = `${source.lookup_key}_${slug}`.slice(0, 190);
    let k = base, n = 2;
    while (taken.includes(k)) k = `${base}_${n++}`;
    return k;
  }, [source.lookup_key, slug, taken]);
  const [key, setKey] = useState(freeKey);
  const [name, setName] = useState(`${source.display_name} (${typeName(type).toLowerCase()})`.slice(0, 200));
  const [rows, setRows] = useState<Row[]>(() => (source.packages?.items ?? []).slice().sort((a, b) => a.position - b.position).map((p) => ({
    uid: p.id, packageId: p.id, lookupKey: p.lookup_key, name: p.display_name,
    products: (p.products?.items ?? []).map((x) => ({ productId: x.product.id, eligibility: x.eligibility_criteria, appId: x.product.app_id })),
  })));
  const [copyPaywall, setCopyPaywall] = useState(!!source.paywall_id && type === "paywall_design");
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyErr = lookupKeyError(key, "offering") ?? (taken.includes(key.trim()) ? "Another offering has this identifier." : null);

  const move = (uid: string, to: number) => setRows((rs) => {
    const from = rs.findIndex((r) => r.uid === uid);
    if (from < 0 || to < 0 || to >= rs.length || from === to) return rs;
    const next = rs.slice();
    const [r] = next.splice(from, 1);
    next.splice(to, 0, r!);
    return next;
  });
  const onDrop = (e: DragEvent, target: string) => { e.preventDefault(); if (drag) move(drag.from, rows.findIndex((r) => r.uid === target)); setDrag(null); };
  const label = (id: string) => {
    const p = products.data?.find((x) => x.id === id);
    if (!p) return id;
    return [productName(p), p.subscription?.duration ? durationLabel(p.subscription.duration) : p.type.replace(/_/g, " "), p.indicative_price ? priceLabel(p.indicative_price) : null].filter(Boolean).join(" · ");
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (keyErr) { setErr(keyErr); return; }
    if (!name.trim()) { setErr("Name the offering."); return; }
    setBusy(true); setErr(null);
    try {
      const o = await api<Offering>(`${v2(pid)}/offerings/${source.id}/actions/duplicate`, { method: "POST", json: {
        lookup_key: key.trim(), display_name: name.trim(), copy_paywall: copyPaywall,
        packages: rows.map((r) => ({ source_package_id: r.packageId, products: r.products.map((x) => ({ product_id: x.productId, eligibility_criteria: x.eligibility })) })),
      } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["offering-list-full", pid] }), qc.invalidateQueries({ queryKey: ["catalog", pid] }), qc.invalidateQueries({ queryKey: ["offering-list", pid] })]);
      onCreated(o);
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  }

  return (
    <Dialog title={`Duplicate ${source.lookup_key}`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="dup-form" className="btn btn-dark" disabled={busy}>{busy ? "Creating…" : "Create offering"}</button>
    </>}>
      <form id="dup-form" onSubmit={submit} noValidate className="xp-dup">
        <p className="section-sub">{TREATMENT_HELP[type] ?? TREATMENT_HELP.other}</p>
        <div className="xp-grid2">
          <Field label="Name" htmlFor="dup-name"><input id="dup-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Identifier" htmlFor="dup-key" error={key !== freeKey ? keyErr : null}><input id="dup-key" className="input mono" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
        </div>
        <div className="label">Packages, in the order the app shows them</div>
        {!rows.length && <p className="subtle">This offering has no packages. Add packages to it in Product catalog → Offerings first.</p>}
        <ol className="xp-pkgs">
          {rows.map((r, i) => (
            <li key={r.uid} className={`policy${drag?.from === r.uid ? " dragging" : ""}${drag?.over === r.uid && drag.from !== r.uid ? " over" : ""}`} aria-label={`Package ${r.lookupKey}`}
              onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== r.uid) setDrag({ ...drag, over: r.uid }); } }} onDrop={(e) => onDrop(e, r.uid)}>
              <div className="policy-h">
                <button type="button" className="ib grip" draggable aria-label={`Move ${r.lookupKey}. Use the up and down arrow keys.`} title="Drag to reorder" data-grip={r.uid}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.uid); setDrag({ from: r.uid, over: null }); }}
                  onDragEnd={() => setDrag(null)}
                  onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(r.uid, i + (e.key === "ArrowUp" ? -1 : 1)); requestAnimationFrame(() => (document.querySelector(`[data-grip="${r.uid}"]`) as HTMLElement | null)?.focus()); } }}>
                  <Icon name="grip" />
                </button>
                <span className="pos">{i + 1}</span>
                <span className="pname"><code>{r.lookupKey}</code> <span className="subtle">{r.name}</span></span>
              </div>
              <div className="xp-pkg-b">
                {!r.products.length && <span className="subtle">No products in this package.</span>}
                {r.products.map((x, j) => {
                  const options = (products.data ?? []).filter((p) => p.app_id === x.appId && p.state === "active");
                  return (
                    <select key={j} aria-label={`Product ${j + 1} of ${r.lookupKey}`} className="select" value={x.productId}
                      onChange={(e) => setRows(rows.map((q) => (q.uid === r.uid ? { ...q, products: q.products.map((y, k) => (k === j ? { ...y, productId: e.target.value } : y)) } : q)))}>
                      {!options.some((p) => p.id === x.productId) && <option value={x.productId}>{label(x.productId)}</option>}
                      {options.map((p) => <option key={p.id} value={p.id}>{label(p.id)}</option>)}
                    </select>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
        {source.paywall_id && <Check checked={copyPaywall} onChange={setCopyPaywall} label="Copy the paywall" hint="The copy is attached to the new offering, ready to edit in Paywalls." />}
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
