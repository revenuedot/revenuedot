import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../../components/Shell";
import { Check, CodeBlock, ConfirmDialog, Disclosure, Field, Tag, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { base, errMsg } from "../setup/data";
import "./settings.css";

/**
 * Project settings → Export and move (prd/moves-export/PRD.md §6): a full export of the project (JSON Lines in a .tar,
 * secrets only with a passphrase), and moving the project to RevenueDot Cloud or to another server, run by this server:
 * check (dry run with rows per table), copy and verify, then finish (pause, last copy, go live, forward).
 */

export const CLOUD_API = "https://api.revenuedot.app";

interface Export {
  object: "project_export"; id: string; status: "queued" | "running" | "succeeded" | "failed" | "expired"; include_secrets: boolean;
  rows: number; bytes: number; tables_done: number; tables_total: number; error: string | null; created_at: number; finished_at: number | null; expires_at: number | null;
  download_url?: string;
}
interface PlanTable { name: string; archive_rows: number; target_rows: number }
interface VerifyTable { name: string; source_rows: number; target_rows: number; match: boolean }
interface NoteUrl { app_id: string; app_name: string; store: string; url: string; where: string }
interface Move {
  object: "project_move"; id: string; status: "running" | "ready" | "copied" | "finished" | "failed" | "cancelled"; target_url: string; mode: "copy" | "finish"; dry_run: boolean;
  phase: string; files_copied: number; plan: { conflicts: string[]; tables: PlanTable[]; project: { exists: boolean } } | null; verify: VerifyTable[] | null;
  report: { notification_urls: NoteUrl[]; apps_needing_credentials: { name: string }[]; webhooks_with_new_secrets: { name: string }[]; members_to_invite: { email: string; role: string }[] } | null; error: string | null;
}
export interface MoveState { state: "incoming" | "paused" | "forwarded" | null; moved_to_url: string | null; moved_in_from: string | null; move: Move | null }

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1_048_576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1_048_576).toFixed(1)} MB`);
const PHASE: Record<string, string> = { export: "Exporting", plan: "Checking the destination", copy: "Copying files", members: "Copying collaborators", verify: "Verifying counts and checksums", paused: "Pausing writes here", finish: "Going live", done: "Done" };

function ExportPanel({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [secrets, setSecrets] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["exports", pid], queryFn: () => api<List<Export>>(`${base(pid)}/exports`) });
  const working = list.data?.items.find((e) => e.status === "queued" || e.status === "running");
  // While an export runs, this page moves it forward (the server's background job does too, once a minute).
  useEffect(() => {
    if (!working) return;
    let stop = false;
    const step = async () => {
      if (stop) return;
      try { await api(`${base(pid)}/exports/${working.id}/actions/advance`, { method: "POST" }); } catch { /* shown by the list */ }
      await qc.invalidateQueries({ queryKey: ["exports", pid] });
    };
    const t = setTimeout(step, 400);
    return () => { stop = true; clearTimeout(t); };
  }, [working, pid, qc]);
  const start = async () => {
    setError(null);
    if (secrets && pass.length < 12) { setError("Use a passphrase of at least 12 characters."); return; }
    if (secrets && pass !== pass2) { setError("The two passphrases differ."); return; }
    setBusy(true);
    try {
      await api(`${base(pid)}/exports`, { method: "POST", json: secrets ? { include_secrets: true, passphrase: pass } : {} });
      setPass(""); setPass2("");
      toast("Export started.");
      await qc.invalidateQueries({ queryKey: ["exports", pid] });
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const items = list.data?.items ?? [];
  return (
    <section className="panel" aria-labelledby="export-h">
      <div className="ph"><b id="export-h">Export project</b></div>
      <div className="pb stack">
        <p className="section-sub">Everything this project owns, in one archive you can read: apps, catalog, customers, aliases and attributes, subscriptions, transactions, events, webhooks and integrations, paywalls and their images, targeting and experiments, lifecycle settings, in-app currencies and the audit log. One JSON Lines file per table plus a manifest with row counts and checksums. Kept for 7 days.</p>
        <Check checked={secrets} onChange={setSecrets} label="Include secrets, encrypted with a passphrase" hint="Store keys, webhook signing secrets and integration keys. Without them the archive holds everything else." />
        {secrets && (
          <div className="hrow" style={{ flexWrap: "wrap" }}>
            <Field label="Passphrase" htmlFor="export-pass" hint="At least 12 characters. Nobody can read the secrets without it, not even RevenueDot."><input id="export-pass" className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
            <Field label="Passphrase again" htmlFor="export-pass2"><input id="export-pass2" className="input" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} /></Field>
          </div>
        )}
        {error && <div className="banner err" role="alert">{error}</div>}
        <div className="hrow"><button type="button" className="btn btn-dark" disabled={busy || !!working} onClick={start}>{working ? "Exporting…" : "Export project"}</button></div>
      </div>
      {items.length > 0 && (
        <div className="tbl">
          <table>
            <thead><tr><th>Started</th><th>Status</th><th className="num">Rows</th><th className="num hide-sm">Size</th><th className="hide-sm">Secrets</th><th aria-label="Download" /></tr></thead>
            <tbody>{items.map((e) => (
              <tr key={e.id} data-export={e.id}>
                <td>{fmt.dateTime(e.created_at)}</td>
                <td>{e.status === "succeeded" ? <Tag tone="up">Ready</Tag> : e.status === "failed" ? <Tag tone="down">Failed</Tag> : e.status === "expired" ? <Tag>Expired</Tag> : <span className="mono" role="status">Table {Math.min(e.tables_done + 1, e.tables_total)} of {e.tables_total}</span>}
                  {e.error && <div className="subtle">{e.error}</div>}</td>
                <td className="num mono">{e.status === "succeeded" ? fmt.int(e.rows) : "—"}</td>
                <td className="num mono hide-sm">{e.status === "succeeded" ? size(e.bytes) : "—"}</td>
                <td className="hide-sm">{e.include_secrets ? "Encrypted" : "Left out"}</td>
                <td className="actions-cell">{e.download_url && <a className="btn btn-line" href={e.download_url} download>Download</a>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PlanTableView({ tables }: { tables: PlanTable[] }) {
  const shown = tables.filter((t) => t.archive_rows || t.target_rows);
  return (
    <div className="tbl" aria-label="What the move copies">
      <table>
        <thead><tr><th>Table</th><th className="num">Here</th><th className="num">There now</th></tr></thead>
        <tbody>{shown.map((t) => <tr key={t.name}><td className="mono">{t.name}</td><td className="num mono">{fmt.int(t.archive_rows)}</td><td className="num mono">{fmt.int(t.target_rows)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function VerifyView({ tables }: { tables: VerifyTable[] }) {
  const bad = tables.filter((t) => !t.match);
  const rows = tables.reduce((n, t) => n + t.target_rows, 0);
  return (
    <div className="stack">
      <div className={`banner ${bad.length ? "err" : "ok"}`} role="status">{bad.length ? `${bad.length} table(s) differ: ${bad.map((t) => t.name).join(", ")}.` : `Verified: all ${tables.length} tables and ${fmt.int(rows)} rows match, by count and checksum.`}</div>
      {bad.length > 0 && (
        <div className="tbl"><table><thead><tr><th>Table</th><th className="num">Here</th><th className="num">There</th></tr></thead>
          <tbody>{bad.map((t) => <tr key={t.name}><td className="mono">{t.name}</td><td className="num mono">{t.source_rows}</td><td className="num mono">{t.target_rows}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

function MovePanel({ pid, state }: { pid: string; state: MoveState }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const cloud = me.data?.account?.edition === "cloud";
  const [dest, setDest] = useState<"cloud" | "other">(cloud ? "other" : "cloud");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const m = state.move;
  const target = dest === "cloud" ? CLOUD_API : url.trim();
  const refresh = () => qc.invalidateQueries({ queryKey: ["move", pid] });
  useEffect(() => {
    if (m?.status !== "running") return;
    const t = setTimeout(async () => { try { await api(`${base(pid)}/move/actions/advance`, { method: "POST" }); } catch { /* shown below */ } await refresh(); }, 600);
    return () => clearTimeout(t);
  });
  const run = async (dry: boolean) => {
    setError(null);
    if (!target) { setError("Enter the destination server's URL."); return; }
    if (!/^rdi_[0-9a-f]{64}$/.test(token.trim())) { setError("Paste the import token from the destination (Receive a project). It starts with rdi_."); return; }
    setBusy(true);
    try { await api(`${base(pid)}/move`, { method: "POST", json: { to_url: target, to_token: token.trim(), dry_run: dry } }); await refresh(); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const act = async (path: string, done: string) => {
    setBusy(true); setError(null);
    try { await api(`${base(pid)}/move/${path}`, { method: "POST" }); toast(done); await refresh(); await qc.invalidateQueries({ queryKey: ["me"] }); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const self = cloud ? CLOUD_API : window.location.origin;
  const running = m?.status === "running";
  return (
    <section className="panel" aria-labelledby="move-h">
      <div className="ph"><b id="move-h">Move this project</b>{m && !["finished", "cancelled"].includes(m.status) && <button type="button" className="btn btn-line" disabled={busy} onClick={() => act("cancel", "Move cancelled. This server serves the project.")}>Cancel move</button>}</div>
      <div className="pb stack">
        <p className="section-sub">Copy this project to another RevenueDot server with its ids, SDK keys, secret API keys and webhook signing secrets, so your apps and webhooks keep working. Nothing changes here until you finish; then this server forwards every SDK call, REST call and store notification to the new one.</p>
        {state.state === "forwarded" ? (
          <div className="banner ok" role="status">This project moved to <b>{state.moved_to_url}</b>. Requests that still arrive here are forwarded there.</div>
        ) : (
          <>
            <div role="radiogroup" aria-label="Destination" className="stack">
              {!cloud && <label className="check"><input type="radio" name="dest" checked={dest === "cloud"} onChange={() => setDest("cloud")} /><span><b>RevenueDot Cloud</b><small>{CLOUD_API}: hosted for you, free up to $10,000 tracked revenue a month.</small></span></label>}
              <label className="check"><input type="radio" name="dest" checked={dest === "other"} onChange={() => setDest("other")} /><span><b>{cloud ? "Your own server" : "Another RevenueDot server"}</b><small>{cloud ? "A self-hosted RevenueDot (docker compose up) reachable from the internet. Behind a firewall, use the command line below." : "Another self-hosted RevenueDot."}</small></span></label>
            </div>
            {dest === "other" && <Field label="Server URL" htmlFor="move-url" hint="The address your apps would use as the SDK proxy URL, e.g. https://revenuedot.example.com."><input id="move-url" className="input mono" placeholder="https://revenuedot.example.com" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>}
            <Field label="Import token" htmlFor="move-token" hint={<>On the destination, sign in and open <b>Receive a project</b> to create one. It starts with rdi_ and lasts 24 hours.{dest === "cloud" && <> <a href="https://app.revenuedot.app/signup" target="_blank" rel="noreferrer">Create a free Cloud account</a>.</>}</>}>
              <input id="move-token" className="input mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
            {error && <div className="banner err" role="alert">{error}</div>}
            <div className="hrow">
              <button type="button" className="btn btn-line" disabled={busy || running} onClick={() => run(true)}>Check</button>
              <button type="button" className="btn btn-dark" disabled={busy || running} onClick={() => run(false)}>Copy data</button>
            </div>
          </>
        )}
        {m && (
          <div className="stack" aria-live="polite">
            <div className="hrow"><span className="flabel">To</span><span className="mono">{m.target_url}</span>
              {m.status === "running" ? <Tag tone="info">{PHASE[m.phase] ?? m.phase}{m.phase === "copy" ? ` (${m.files_copied})` : ""}</Tag>
                : m.status === "ready" ? <Tag>Checked</Tag> : m.status === "copied" ? <Tag tone="up">Copied</Tag> : m.status === "finished" ? <Tag tone="up">Moved</Tag> : m.status === "failed" ? <Tag tone="down">Failed</Tag> : <Tag>Cancelled</Tag>}</div>
            {m.error && <div className="banner err" role="alert">{m.error}</div>}
            {m.plan?.conflicts.length ? <div className="banner err" role="alert">{m.plan.conflicts.join(" ")}</div> : null}
            {m.status === "ready" && m.plan && <><p className="section-sub">Nothing was written. This is what the copy would bring over.</p><PlanTableView tables={m.plan.tables} /></>}
            {m.verify && <VerifyView tables={m.verify} />}
            {m.status === "copied" && (
              <div className="stack">
                <p className="section-sub">The copy is on the destination but not live yet; this server still serves your apps. Finishing pauses writes here for the last copy (purchases and store notifications are retried, nothing is lost), puts the project live there and forwards this server's traffic.</p>
                <div className="hrow"><button type="button" className="btn btn-dark" disabled={busy} onClick={() => setConfirm(true)}>Finish move</button></div>
              </div>
            )}
            {m.report && (
              <div className="stack">
                <b>Next steps</b>
                <p className="section-sub">Point your app at <span className="mono">{m.target_url}</span> in your next release (Purchases.proxyURL). Until then this server forwards. Change these store notification URLs; this server forwards notifications in the meantime:</p>
                <div className="tbl"><table><thead><tr><th>App</th><th>New URL</th><th className="hide-sm">Where</th></tr></thead>
                  <tbody>{m.report.notification_urls.map((n) => <tr key={n.app_id}><td>{n.app_name}</td><td className="mono">{n.url}</td><td className="hide-sm subtle">{n.where}</td></tr>)}</tbody></table></div>
                {m.report.members_to_invite.length > 0 && <p className="section-sub">Invite on the new server: {m.report.members_to_invite.map((x) => `${x.email} (${x.role})`).join(", ")}.</p>}
              </div>
            )}
          </div>
        )}
        <Disclosure title="Prefer the command line?" sub="It runs on your machine, so it also works when a server is behind a firewall.">
          <CodeBlock label="Move with the CLI" code={`npx revenuedot move --from ${self} --to ${target || "<destination URL>"} --dry-run\nnpx revenuedot move --from ${self} --to ${target || "<destination URL>"}\nnpx revenuedot move --from ${self} --to ${target || "<destination URL>"} --finish`} />
        </Disclosure>
        <p className="section-sub">Moving a project to this server instead? <Link to="/projects/receive">Receive a project</Link>.</p>
      </div>
      {confirm && <ConfirmDialog title="Finish the move?" confirmLabel="Finish move" onClose={() => setConfirm(false)} onConfirm={() => act("finish", "Finishing the move…")}>
        Writes on this server pause while the project is copied one last time and verified (purchases and store notifications are retried). Then the project goes live on <b>{m?.target_url}</b> and this server forwards its traffic there. You can undo with Cancel move.
      </ConfirmDialog>}
    </section>
  );
}

export function ExportMoveTab({ pid }: { pid: string }) {
  const state = useQuery({ queryKey: ["move", pid], queryFn: () => api<MoveState>(`${base(pid)}/move`) });
  return (
    <div className="stack">
      <ExportPanel pid={pid} />
      {state.isError ? <div className="banner err" role="alert">{errMsg(state.error)}</div> : state.data ? <MovePanel pid={pid} state={state.data} /> : <div className="panel pb subtle">Loading…</div>}
    </div>
  );
}
