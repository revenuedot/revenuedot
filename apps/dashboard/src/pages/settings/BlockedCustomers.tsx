import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../components/icons";
import { ConfirmDialog, Dialog, EmptyState, Field, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { base, errMsg } from "../setup/data";
import "./settings.css";

/**
 * Blocked customers tab (prd/project-settings §3): block an app user ID so it loses paid features on every platform
 * (no entitlements in customer info, no in-app currency from purchases), see who blocked whom and when, and unblock.
 */

export interface Blocked {
  object: "blocked_customer"; app_user_id: string; note: string | null; blocked_at: number; customer_exists: boolean;
  blocked_by: { type: "user" | "api_key"; id: string; email: string | null } | null;
}

function BlockDialog({ pid, onClose }: { pid: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [id, setId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    const v = id.trim();
    if (!v) { setError("Enter the app user ID to block."); document.getElementById("block-id")?.focus(); return; }
    if (v.length > 100) { setError("App user IDs are at most 100 characters."); return; }
    setBusy(true);
    try {
      await api<Blocked>(`${base(pid)}/blocked_customers`, { method: "POST", json: { app_user_id: v, note: note.trim() || null } });
      await qc.invalidateQueries({ queryKey: ["blocked", pid] });
      toast(`${v} is blocked.`);
      onClose();
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title="Block a customer" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-danger" disabled={busy} onClick={go}>{busy ? "Blocking…" : "Block customer"}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <p className="section-sub">The customer loses access to paid features across all platforms at once: customer info shows no entitlements and purchases credit no in-app currency. Their purchases are still recorded, and webhooks keep arriving.</p>
        <Field label="App user ID" htmlFor="block-id" hint="Any of the customer's app user IDs blocks the whole customer. It does not need to exist yet." error={error}>
          <input id="block-id" className="input mono" autoFocus autoComplete="off" maxLength={100} value={id} onChange={(e) => { setId(e.target.value); setError(null); }} />
        </Field>
        <Field label="Note (optional)" htmlFor="block-note" hint="Why, for your team. Only collaborators see it.">
          <input id="block-note" className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function BlockedCustomersTab({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [unblock, setUnblock] = useState<Blocked | null>(null);
  const q = useInfiniteQuery({
    queryKey: ["blocked", pid, search.trim()],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "50" });
      if (search.trim()) p.set("search", search.trim());
      if (pageParam) p.set("starting_after", pageParam);
      return api<List<Blocked>>(`${base(pid)}/blocked_customers?${p}`);
    },
    getNextPageParam: (last) => (last.next_page ? new URL(last.next_page, "http://x").searchParams.get("starting_after") ?? undefined : undefined),
    enabled: !!pid,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Blocked customers</b><button type="button" className="btn btn-dark" onClick={() => setBlocking(true)}><Icon name="plus" />Block customer</button></div>
        <div className="pb stack">
          <p className="section-sub">A blocked app user ID loses access to paid features across all platforms. Use it for fraud, chargeback abuse or shared accounts. Unblocking restores access at once.</p>
          <div className="hrow">
            <input className="input" type="search" aria-label="Search blocked app user IDs" placeholder="Search app user IDs" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
          </div>
        </div>
        {q.isError ? <div className="pb"><div className="banner err" role="alert">The block list could not be loaded: {errMsg(q.error)}</div></div>
          : q.isLoading ? <div className="pb subtle">Loading…</div>
          : !rows.length ? <div className="pb"><EmptyState title={search ? "No blocked app user ID matches" : "No blocked customers"} text={search ? undefined : "Blocked app user IDs appear here with when and by whom they were blocked."} /></div>
          : (
            <div className="tbl">
              <table>
                <thead><tr><th>App user ID</th><th>Blocked at</th><th className="hide-sm">Blocked by</th><th className="hide-sm">Note</th><th aria-label="Actions" /></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.app_user_id}>
                    <td className="mono">{r.customer_exists ? <Link to={`/projects/${pid}/customers/${encodeURIComponent(r.app_user_id)}`}>{r.app_user_id}</Link> : <span title="No customer with this ID yet">{r.app_user_id}</span>}</td>
                    <td><span title={fmt.dateTime(r.blocked_at)}>{fmt.dateTime(r.blocked_at)}</span></td>
                    <td className="hide-sm">{r.blocked_by ? (r.blocked_by.type === "user" ? r.blocked_by.email ?? "A collaborator" : <>API key <code>{r.blocked_by.id}</code></>) : "—"}</td>
                    <td className="hide-sm subtle">{r.note ?? ""}</td>
                    <td className="actions-cell"><button type="button" className="btn btn-line" onClick={() => setUnblock(r)}>Unblock</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        {q.hasNextPage && <div className="pb"><button type="button" className="btn btn-line" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</button></div>}
      </section>
      {blocking && <BlockDialog pid={pid} onClose={() => setBlocking(false)} />}
      {unblock && <ConfirmDialog title={`Unblock ${unblock.app_user_id}?`} confirmLabel="Unblock" onClose={() => setUnblock(null)} onConfirm={async () => {
        await api(`${base(pid)}/blocked_customers/${encodeURIComponent(unblock.app_user_id)}`, { method: "DELETE" });
        await qc.invalidateQueries({ queryKey: ["blocked", pid] });
        toast(`${unblock.app_user_id} is unblocked.`);
      }}>The customer gets their entitlements back right away, on every platform.</ConfirmDialog>}
    </div>
  );
}
