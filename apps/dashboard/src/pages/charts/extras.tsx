/*
 * The chart page's tabs and dialogs (prd/charts/PRD.md "The chart page"):
 * - Customers: a sample of the customers behind the chart (GET …/charts/{chart}/customers) and "Export all" (format=csv).
 * - Annotations: the project's annotations in the chart's range, with New, Edit and Delete (…/chart_annotations).
 * - Share preview: make a public link to a picture of the chart, list the chart's links, copy, open and revoke them
 *   (…/chart_shares).
 * Viewers read; the write controls are hidden for them and the API refuses their writes anyway.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../components/icons";
import { ConfirmDialog, CopyButton, Dialog, Field, Tag, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";

const STORE: Record<string, string> = { app_store: "App Store", mac_app_store: "Mac App Store", play_store: "Google Play", amazon: "Amazon", stripe: "Stripe", rc_billing: "Web", test_store: "Test Store", paddle: "Paddle", roku: "Roku", external: "External", promotional: "Promotional" };
const STATUS: Record<string, { label: string; tone: "up" | "down" | "info" | "gold" | "muted" }> = {
  active: { label: "Active", tone: "up" }, trialing: { label: "Trial", tone: "info" }, grace_period: { label: "Grace period", tone: "down" },
  billing_issue: { label: "Billing issue", tone: "down" }, expired: { label: "Expired", tone: "muted" }, none: { label: "No subscription", tone: "muted" },
};

// ---- Customers ------------------------------------------------------------------------------------------------------------
interface ChartCustomer { customer_id: string; app_user_id: string | null; status: string; store: string | null; product_id: string | null; contributed_at: number; first_seen_at: number | null; value: number; segment: string | null }
interface ChartCustomers { total_count: number; value: { id: string; display_name: string; unit: "$" | "#" | "%" } | null; sum: "total" | "last"; unattributed_value: number; date_label: string; currency: string; segment: string | null; items: ChartCustomer[] }

export const customersKey = (pid: string, chart: string, query: string) => ["chart-customers", pid, chart, query];

export function CustomersTab({ pid, chart, query, format }: { pid: string; chart: string; query: string; format: (unit: string) => (v: number | null) => string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: customersKey(pid, chart, query), queryFn: () => api<ChartCustomers>(`/v2/projects/${pid}/charts/${chart}/customers?${query}&limit=100`) });
  const exportAll = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/v2/projects/${pid}/charts/${chart}/customers?${query}&format=csv`, { credentials: "same-origin" });
      if (!res.ok) { const j = await res.json().catch(() => null) as { message?: string } | null; throw new Error(j?.message ?? `Export failed (${res.status})`); }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${chart}-customers.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (q.isError) return <div className="banner err" role="alert"><span style={{ flex: 1 }}>Could not load the customers: {q.error instanceof Error ? q.error.message : "unknown error"}.</span><button type="button" className="btn btn-line" onClick={() => q.refetch()}>Retry</button></div>;
  const d = q.data;
  const value = d?.value ? format(d.value.unit) : null;
  return (
    <div className="ctab" aria-busy={q.isFetching}>
      <div className="ctab-h">
        <p className="subtle">This is a sample of customers contributing to this chart{d ? <>: <b className="mono">{d.items.length.toLocaleString("en-US")}</b> of <b className="mono">{d.total_count.toLocaleString("en-US")}</b>, most recent first.</> : "."}
          {d?.value && <> {d.value.display_name} {d.sum === "last" ? "at the end of the last period" : "over the range"}.</>}
          {d && Math.abs(d.unattributed_value) >= 0.005 && value && <> {value(d.unattributed_value)} of it {d.value?.unit === "$" ? "is ad revenue" : "comes"} from app users with no customer record, so no one is listed for it.</>}</p>
        <button type="button" className="btn btn-line" disabled={busy || !d?.total_count} onClick={exportAll}><Icon name="download" />{busy ? "Exporting…" : "Export all"}</button>
      </div>
      {!d ? <div className="sk" style={{ height: 160, margin: 16 }} /> : !d.items.length ? (
        <p className="ctab-empty">No customers contribute to this chart in this range.</p>
      ) : (
        <div className="tbl">
          <table className="compact" aria-label="Customers contributing to this chart">
            <thead><tr><th scope="col">App User ID</th><th scope="col">Status</th><th scope="col">Store</th><th scope="col">Product</th><th scope="col">{d.date_label}</th>{d.value && <th scope="col" className="amt">{d.value.display_name}</th>}{d.segment && <th scope="col">Segment</th>}</tr></thead>
            <tbody>
              {d.items.map((c) => {
                const st = STATUS[c.status] ?? STATUS.none!;
                return (
                  <tr key={`${c.customer_id}|${c.segment ?? ""}`}>
                    <td className="mono">{c.app_user_id ? <Link className="ul" to={`/projects/${pid}/customers/${encodeURIComponent(c.app_user_id)}`}>{c.app_user_id}</Link> : c.customer_id}</td>
                    <td><Tag tone={st.tone}>{st.label}</Tag></td>
                    <td>{c.store ? STORE[c.store] ?? c.store : "—"}</td>
                    <td className="mono">{c.product_id ?? "—"}</td>
                    <td title={new Date(c.contributed_at).toISOString()}>{fmt.date(c.contributed_at)}</td>
                    {d.value && <td className="amt">{value!(c.value)}</td>}
                    {d.segment && <td>{c.segment}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Annotations ------------------------------------------------------------------------------------------------------------
export interface Annotation { id: string; title: string; description: string | null; start_date: string; end_date: string; created_by: { id: string; email: string | null; name: string | null } | null; created_at: number; updated_at: number }
export const annotationsKey = (pid: string) => ["chart-annotations", pid];
export const useAnnotations = (pid: string, from: string, to: string) => useQuery({
  queryKey: [...annotationsKey(pid), from, to],
  queryFn: () => api<List<Annotation>>(`/v2/projects/${pid}/chart_annotations?start_date=${from}&end_date=${to}`).then((r) => r.items),
  enabled: !!pid && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to,
});

export const dayText = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const whenText = (a: { start_date: string; end_date: string }) => (a.start_date === a.end_date ? dayText(a.start_date) : `${dayText(a.start_date)} – ${dayText(a.end_date)}`);

export function AnnotationsTab({ pid, items, loading, canWrite, highlight, onNew, onEdit }: { pid: string; items: Annotation[] | undefined; loading: boolean; canWrite: boolean; highlight: string | null; onNew: () => void; onEdit: (a: Annotation) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [deleting, setDeleting] = useState<Annotation | null>(null);
  return (
    <div className="ctab">
      <div className="ctab-h">
        <p className="subtle">Annotations mark events and milestones on every chart of this project.{canWrite ? " Select a day or a date range on the chart and press +, or add one here." : ""}</p>
        {canWrite && <button type="button" className="btn btn-line" onClick={onNew}><Icon name="plus" />New annotation</button>}
      </div>
      {loading && !items ? <div className="sk" style={{ height: 120, margin: 16 }} /> : !items?.length ? (
        <p className="ctab-empty">No annotations in this range yet.</p>
      ) : (
        <ul className="alist" aria-label="Annotations">
          {items.map((a) => (
            <li key={a.id} className={a.id === highlight ? "on" : undefined} id={`annotation-${a.id}`}>
              <i className="amark" aria-hidden />
              <div className="atext">
                <b>{a.title}</b>
                <span className="subtle mono">{whenText(a)}</span>
                {a.description && <p>{a.description}</p>}
                <span className="subtle">Added by {a.created_by?.name || a.created_by?.email || "an API key"} · {fmt.date(a.created_at)}</span>
              </div>
              {canWrite && (
                <span className="aact">
                  <button type="button" className="ib" aria-label={`Edit annotation ${a.title}`} onClick={() => onEdit(a)}><Icon name="edit" /></button>
                  <button type="button" className="ib" aria-label={`Delete annotation ${a.title}`} onClick={() => setDeleting(a)}><Icon name="trash" /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog title={`Delete "${deleting.title}"?`} confirmLabel="Delete annotation" danger onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/v2/projects/${pid}/chart_annotations/${deleting.id}`, { method: "DELETE" });
            await qc.invalidateQueries({ queryKey: annotationsKey(pid) });
            toast("Annotation deleted");
          }}>
          <p>It disappears from every chart of this project.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export function AnnotationDialog({ pid, initial, onClose }: { pid: string; initial: Partial<Annotation> & { start_date: string; end_date: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(initial.title ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [start, setStart] = useState(initial.start_date);
  const [end, setEnd] = useState(initial.end_date);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editing = !!initial.id;
  const save = async () => {
    // Enter in the title field can arrive again while the first save is still on its way.
    if (busy) return;
    if (!title.trim()) { setErr("Give the annotation a title."); return; }
    if (end && end < start) { setErr("The end date is before the start date."); return; }
    setBusy(true); setErr(null);
    try {
      const json = { title: title.trim(), description: description.trim() || null, start_date: start, end_date: end || start };
      if (editing) await api(`/v2/projects/${pid}/chart_annotations/${initial.id}`, { method: "PATCH", json });
      else await api(`/v2/projects/${pid}/chart_annotations`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: annotationsKey(pid) });
      toast(editing ? "Annotation updated" : "Annotation added to every chart");
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Dialog title={editing ? "Edit annotation" : "New annotation"} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy} onClick={save}>{busy ? "Saving…" : editing ? "Save" : "Add annotation"}</button>
    </>}>
      <Field label="Title" htmlFor="an-title" hint="Shown on every chart of this project, at these dates.">
        <input id="an-title" className="input" value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} placeholder="Launched version 2.0" />
      </Field>
      <Field label="Description (optional)" htmlFor="an-desc">
        <textarea id="an-desc" className="input" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="arow">
        <Field label="Start date" htmlFor="an-start"><input id="an-start" className="input" type="date" value={start} onChange={(e) => { setStart(e.target.value); if (end && e.target.value > end) setEnd(e.target.value); }} /></Field>
        <Field label="End date" htmlFor="an-end" hint="The same day for a one-day event."><input id="an-end" className="input" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      {err && <div className="banner err" role="alert">{err}</div>}
    </Dialog>
  );
}

// ---- Share preview ------------------------------------------------------------------------------------------------------------
interface Share { id: string; chart_name: string; title: string; url: string; image_url: string; view: Record<string, unknown>; start_date: string; end_date: string; created_by: { email: string | null; name: string | null } | null; created_at: number }
export const sharesKey = (pid: string, chart: string) => ["chart-shares", pid, chart];

export function ShareDialog({ pid, chart, title, view, describe, canWrite, onClose }: { pid: string; chart: string; title: string; view: Record<string, string | boolean>; describe: string; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: sharesKey(pid, chart), queryFn: () => api<List<Share>>(`/v2/projects/${pid}/chart_shares?chart_name=${encodeURIComponent(chart)}`).then((r) => r.items) });
  const [made, setMade] = useState<Share | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Share | null>(null);
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const s = await api<Share>(`/v2/projects/${pid}/chart_shares`, { method: "POST", json: { chart_name: chart, view } });
      setMade(s);
      await qc.invalidateQueries({ queryKey: sharesKey(pid, chart) });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Share preview" onClose={onClose} footer={<button type="button" className="btn btn-line" onClick={onClose}>Done</button>}>
      <p className="subtle share-intro">A public link to a picture of {title} as shown: {describe}. Anyone with the link sees the chart's numbers and labels, never customer data. The numbers are those of today; revoke the link to turn it off.</p>
      {made ? (
        <div className="share-made" data-testid="share-made">
          <img src={made.image_url} alt={`Preview of the shared ${title} chart`} width={1200} height={630} />
          <div className="share-url"><input className="input mono" readOnly aria-label="Share link" value={made.url} onFocus={(e) => e.currentTarget.select()} /><CopyButton value={made.url} label="Copy link" /><a className="btn btn-line" href={made.url} target="_blank" rel="noreferrer"><Icon name="link" />Open</a></div>
        </div>
      ) : canWrite ? (
        <button type="button" className="btn btn-dark" disabled={busy} onClick={create}><Icon name="link" />{busy ? "Creating…" : "Create link"}</button>
      ) : <p className="banner">Viewers can open the links below. Ask an admin or a developer to create one.</p>}
      {err && <div className="banner err" role="alert">{err}</div>}
      <div className="share-list">
        <div className="label">Active links for this chart</div>
        {list.isLoading ? <div className="sk" style={{ height: 40 }} /> : !list.data?.length ? <p className="subtle">No links yet.</p> : (
          <ul aria-label="Active share links">
            {list.data.map((s) => (
              <li key={s.id}>
                <div><b>{s.title}</b> <span className="subtle mono">{dayText(s.start_date)} – {dayText(s.end_date)}</span><br /><span className="subtle">By {s.created_by?.name || s.created_by?.email || "an API key"} · {fmt.dateTime(s.created_at)}</span></div>
                <span className="aact">
                  <CopyButton value={s.url} label={`Copy link from ${fmt.dateTime(s.created_at)}`} />
                  <a className="ib" href={s.url} target="_blank" rel="noreferrer" aria-label="Open link" title="Open"><Icon name="link" /></a>
                  {canWrite && <button type="button" className="ib" aria-label={`Revoke link from ${fmt.dateTime(s.created_at)}`} title="Revoke" onClick={() => setRevoking(s)}><Icon name="trash" /></button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {revoking && (
        <ConfirmDialog title="Revoke this link?" confirmLabel="Revoke link" danger onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api(`/v2/projects/${pid}/chart_shares/${revoking.id}`, { method: "DELETE" });
            if (made?.id === revoking.id) setMade(null);
            await qc.invalidateQueries({ queryKey: sharesKey(pid, chart) });
            toast("Link revoked");
          }}>
          <p>Anyone who opens it from now on sees that it was revoked. Copies of the picture already posted elsewhere stay where they are.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
