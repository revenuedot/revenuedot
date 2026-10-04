import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Check, ConfirmDialog, Field, KeyValue, Menu, PageHead, Segmented, StatusLine, Switch, Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { base, errMsg, useExportColumns, useExports, type DataExport, type ExportRun } from "./data";

/**
 * Scheduled data exports (/projects/:projectId/integrations/exports): CSV or Parquet files of transactions, customers,
 * subscriptions, events and paywall events, written every few hours, daily or weekly to Amazon S3, Cloudflare R2, Google
 * Cloud Storage or Azure Blob Storage, or emailed as download links (prd/integrations/PRD.md). List, the new/edit form
 * (destination, credentials, format, schedule, tables and their columns, mode), "Run now", "Check bucket" and the run
 * history with each file written.
 * GAPS vs RevenueCat: no AWS IAM-role credentials.
 */

const DEST_LABEL: Record<DataExport["destination"], string> = { s3: "Amazon S3", r2: "Cloudflare R2", gcs: "Google Cloud Storage", azure: "Azure Blob Storage", email: "Email" };
const SCHEME: Record<DataExport["destination"], string> = { s3: "s3", r2: "r2", gcs: "gs", azure: "azure", email: "email" };
const TABLES: [string, string][] = [
  ["transactions", "One row per purchase, trial and renewal, with RevenueCat's export columns."],
  ["customers", "App user ids, aliases, first and last seen, attributes."],
  ["subscriptions", "The current state of every subscription."],
  ["events", "Every event webhooks receive, with its JSON body."],
  ["paywall_events", "Paywall impressions, closes, cancels and purchase attempts the SDK reports."],
  ["virtual_currency", "Every in-app currency balance change, with RevenueCat's In-App Currency columns."],
];
const INTERVALS = [4, 6, 8, 12];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const RUN_TONE: Record<ExportRun["status"], "up" | "info" | "down" | "muted"> = { succeeded: "up", queued: "info", running: "info", failed: "down" };
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const scheduleText = (e: DataExport) => e.schedule === "interval"
  ? `Every ${e.interval_hours ?? 6} hours from ${String(e.hour_utc).padStart(2, "0")}:00 UTC`
  : `${e.schedule === "weekly" ? `Every ${DAYS[e.weekday ?? 1]}` : "Every day"} at ${String(e.hour_utc).padStart(2, "0")}:00 UTC`;
const where = (e: DataExport) => (e.destination === "email" ? (e.config.recipients ?? []).join(", ") : `${SCHEME[e.destination]}://${e.config.bucket}/${e.config.prefix ?? ""}`);
const secretFor = (dest: DataExport["destination"], credType: string) =>
  dest === "email" ? null : dest === "azure" ? "connection_string" : dest === "gcs" && credType !== "hmac" ? "service_account_json" : "secret_access_key";

/** Every column of a table, or a chosen subset (kept in the catalog's order by the server). */
function ColumnPicker({ table, all, chosen, onChange }: { table: string; all: { name: string; type: string }[]; chosen: string[] | undefined; onChange: (v: string[] | undefined) => void }) {
  const custom = chosen !== undefined;
  const sel = new Set(chosen ?? []);
  return (
    <details className="cols-pick">
      <summary><span className="mono">{table}</span> columns: {custom ? `${sel.size} of ${all.length}` : `all ${all.length}`}</summary>
      <div className="stack tight" style={{ paddingTop: 8 }}>
        <Check checked={!custom} onChange={(v) => onChange(v ? undefined : all.map((c) => c.name))} label={`Every column of ${table}`} hint="Columns RevenueDot adds later are included too." />
        {custom && <div className="col-grid" role="group" aria-label={`${table} columns`} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 4 }}>
          {all.map((c) => (
            <Check key={c.name} checked={sel.has(c.name)} label={<span className="mono">{c.name}</span>} hint={c.type}
              onChange={(v) => onChange(all.map((x) => x.name).filter((n) => (n === c.name ? v : sel.has(n))))} />
          ))}
        </div>}
        {custom && !sel.size && <span className="form-err" role="alert">Pick at least one column.</span>}
      </div>
    </details>
  );
}

function ExportForm({ pid, current }: { pid: string; current?: DataExport }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(current?.name ?? "");
  const [dest, setDest] = useState<DataExport["destination"]>(current?.destination ?? "s3");
  const [cfg, setCfg] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(current?.config ?? {}).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)])));
  const [secret, setSecret] = useState("");
  const [format, setFormat] = useState<DataExport["format"]>(current?.format ?? "csv");
  const [gzip, setGzip] = useState((current?.compression ?? "gzip") === "gzip");
  const [split, setSplit] = useState(current?.split_files ?? false);
  const [schedule, setSchedule] = useState<DataExport["schedule"]>(current?.schedule ?? "daily");
  const [hour, setHour] = useState(current?.hour_utc ?? 3);
  const [weekday, setWeekday] = useState(current?.weekday ?? 1);
  const [mode, setMode] = useState<DataExport["mode"]>(current?.mode ?? "incremental");
  const [tables, setTables] = useState<string[]>(current?.tables ?? ["transactions"]);
  const [columns, setColumns] = useState<Record<string, string[]>>(current?.columns ?? {});
  const [interval, setInterval_] = useState(current?.interval_hours ?? 6);
  const [credType, setCredType] = useState<string>(current?.config.credential_type ?? "service_account");
  const [recipients, setRecipients] = useState((current?.config.recipients ?? []).join(", "));
  const catalog = useExportColumns(pid);
  const [env, setEnv] = useState<"both" | "production" | "sandbox">(current?.environment ?? "both");
  const [error, setError] = useState<{ message: string; param?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const secretKey = secretFor(dest, credType);
  const savedSecret = current && secretKey && secretFor(current.destination, current.config.credential_type ?? "service_account") === secretKey ? current.credentials[secretKey] : undefined;
  const set = (k: string) => (e: { target: { value: string } }) => setCfg((x) => ({ ...x, [k]: e.target.value }));
  const err = (p: string) => (error?.param === p ? error.message : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!tables.length) { setError({ message: "Pick at least one table.", param: "tables" }); return; }
    const empty = tables.find((t) => columns[t] !== undefined && !columns[t]!.length);
    if (empty) { setError({ message: `Pick at least one column of ${empty}.`, param: `columns.${empty}` }); return; }
    const keys = dest === "email" ? ["prefix", "subject_prefix"] : dest === "azure" ? ["bucket", "prefix"] : dest === "gcs" ? (credType === "hmac" ? ["bucket", "prefix", "access_key_id"] : ["bucket", "prefix"])
      : dest === "r2" ? ["bucket", "prefix", "account_id", "access_key_id"] : ["bucket", "prefix", "region", "endpoint", "access_key_id"];
    const config: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, cfg[k]?.trim() ? cfg[k]!.trim() : null]));
    if (dest === "gcs") config.credential_type = credType;
    if (dest === "email") config.recipients = recipients.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const json: Record<string, unknown> = {
      name: name.trim() || `${DEST_LABEL[dest]} export`, destination: dest, config, format, compression: gzip ? "gzip" : "none", split_files: format === "csv" && split, schedule, hour_utc: hour,
      weekday: schedule === "weekly" ? weekday : null, interval_hours: schedule === "interval" ? interval : null, mode, tables,
      columns: Object.fromEntries(tables.map((t) => [t, columns[t] ?? []])), environment: env === "both" ? null : env,
    };
    if (secret.trim() && secretKey) json.credentials = { [secretKey]: secret.trim() };
    setBusy(true); setError(null);
    try {
      const saved = await api<DataExport>(`${base(pid)}/integrations/exports${current ? `/${current.id}` : ""}`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: ["exports", pid] });
      await qc.invalidateQueries({ queryKey: ["export", pid, saved.id] });
      toast(current ? "Export saved." : "Export created. Check the bucket, then run it now or wait for the schedule.");
      nav(`/projects/${pid}/integrations/exports/${saved.id}`);
    } catch (x) {
      const b = (x as { body?: { param?: string } }).body;
      setError({ message: errMsg(x), param: b?.param });
    } finally { setBusy(false); }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label="Data export settings">
      <section className="panel">
        <div className="ph"><b>Destination</b><a className="link" href="https://revenuedot.app/docs/guides/integrations#scheduled-data-exports" target="_blank" rel="noreferrer">Setup guide →</a></div>
        <div className="pb stack">
          <Field label="Name" htmlFor="x-name"><input id="x-name" className="input" value={name} placeholder={`${DEST_LABEL[dest]} export`} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="field">
            <span className="flabel">Storage</span>
            <select id="x-dest" aria-label="Storage" className="select" value={dest} onChange={(e) => setDest(e.target.value as DataExport["destination"])}>
              {(Object.keys(DEST_LABEL) as DataExport["destination"][]).map((d) => <option key={d} value={d}>{DEST_LABEL[d]}</option>)}
            </select>
          </div>
          {dest === "email" ? <>
            <Field label="Recipients" htmlFor="x-recipients" error={err("config.recipients")} hint="Up to 25 members of this project, separated by commas. Each gets a download link per file; links and files last 7 days.">
              <input id="x-recipients" className="input mono" value={recipients} placeholder="you@example.com" onChange={(e) => setRecipients(e.target.value)} />
            </Field>
            <Field label="Subject prefix" htmlFor="x-subject" hint="Optional text at the start of the email subject, up to 200 characters."><input id="x-subject" className="input" maxLength={200} value={cfg.subject_prefix ?? ""} placeholder="[Finance]" onChange={set("subject_prefix")} /></Field>
          </> : <>
            <Field label={dest === "azure" ? "Container" : "Bucket"} htmlFor="x-bucket" error={err("config.bucket")}><input id="x-bucket" className="input mono" value={cfg.bucket ?? ""} placeholder="acme-revenue-exports" onChange={set("bucket")} /></Field>
            <Field label="Path prefix" htmlFor="x-prefix" hint={`Optional folder inside the ${dest === "azure" ? "container" : "bucket"}. Files go to <prefix>/<date>/<table>_<time>.csv.gz.`}><input id="x-prefix" className="input mono" value={cfg.prefix ?? ""} placeholder="revenuedot" onChange={set("prefix")} /></Field>
          </>}
          {dest === "gcs" && <div className="field"><span className="flabel">Credential type</span>
            <Segmented label="Credential type" value={credType} onChange={setCredType} options={[{ value: "service_account", label: "Service account JSON" }, { value: "hmac", label: "HMAC key" }]} />
          </div>}
          {dest === "s3" && <>
            <Field label="Region" htmlFor="x-region"><input id="x-region" className="input mono" value={cfg.region ?? ""} placeholder="us-east-1" onChange={set("region")} /></Field>
            <Field label="Endpoint" htmlFor="x-endpoint" hint="Only for S3-compatible storage such as MinIO. Leave empty for Amazon S3." error={err("config.endpoint")}><input id="x-endpoint" className="input mono" value={cfg.endpoint ?? ""} placeholder="https://s3.example.com" onChange={set("endpoint")} /></Field>
          </>}
          {dest === "r2" && <Field label="Cloudflare account ID" htmlFor="x-account" error={err("config.account_id")}><input id="x-account" className="input mono" value={cfg.account_id ?? ""} placeholder="32-character account ID" onChange={set("account_id")} /></Field>}
          {secretKey === "secret_access_key" && <Field label="Access key ID" htmlFor="x-akid" error={err("config.access_key_id")}><input id="x-akid" className="input mono" value={cfg.access_key_id ?? ""} onChange={set("access_key_id")} /></Field>}
          {secretKey && <Field label={secretKey === "service_account_json" ? "Service account key (JSON)" : secretKey === "connection_string" ? "Connection string" : dest === "gcs" ? "HMAC secret" : "Secret access key"} htmlFor="x-secret" error={err(`credentials.${secretKey}`)}
            hint={savedSecret?.configured ? <>Saved: <span className="mono">{savedSecret.hint}</span>. Leave empty to keep it.</>
              : dest === "azure" ? "The storage account's connection string, with an account key or a shared access signature that can write to the container."
              : dest === "gcs" ? "Needs Storage Object Creator and Storage Legacy Bucket Reader on the bucket." : "Needs s3:PutObject on the bucket's objects and s3:ListBucket on the bucket."}>
            {secretKey === "service_account_json" || secretKey === "connection_string"
              ? <textarea id="x-secret" className="input mono" rows={secretKey === "connection_string" ? 3 : 4} value={secret} placeholder={savedSecret?.configured ? "Unchanged" : secretKey === "connection_string" ? "DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…;EndpointSuffix=core.windows.net" : '{ "type": "service_account", … }'} onChange={(e) => setSecret(e.target.value)} />
              : <input id="x-secret" className="input mono" type="password" autoComplete="off" value={secret} placeholder={savedSecret?.configured ? "Unchanged" : ""} onChange={(e) => setSecret(e.target.value)} />}
          </Field>}
        </div>
      </section>
      <section className="panel">
        <div className="ph"><b>What and when</b></div>
        <div className="pb stack">
          <fieldset className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="flabel">Tables</legend>
            {TABLES.map(([t, text]) => <Check key={t} checked={tables.includes(t)} label={<span className="mono">{t}</span>} hint={text} onChange={(v) => setTables((x) => (v ? [...x, t] : x.filter((y) => y !== t)))} />)}
            {err("tables") && <span className="form-err" role="alert">{error!.message}</span>}
          </fieldset>
          {!!tables.length && <div className="field"><span className="flabel">Columns</span>
            {(catalog.data ?? []).filter((t) => tables.includes(t.table)).map((t) => (
              <ColumnPicker key={t.table} table={t.table} all={t.columns} chosen={columns[t.table]} onChange={(v) => setColumns((x) => { const n = { ...x }; if (v) n[t.table] = v; else delete n[t.table]; return n; })} />
            ))}
            {error?.param?.startsWith("columns.") && <span className="form-err" role="alert">{error.message}</span>}
          </div>}
          <div className="field"><span className="flabel">Format</span>
            <Segmented label="Format" value={format} onChange={setFormat} options={[{ value: "csv", label: "CSV" }, { value: "parquet", label: "Parquet" }]} />
          </div>
          {format === "csv" && <Check checked={gzip} onChange={setGzip} label="Compress with gzip (.csv.gz)" />}
          {format === "csv" && <Check checked={split} onChange={setSplit} label="Split into files of 10,000 rows" hint="Off: one file per table, however big. Parquet is always split." />}
          <div className="field"><span className="flabel">Schedule</span>
            <Segmented label="Schedule" value={schedule} onChange={setSchedule} options={[{ value: "interval", label: "Every few hours" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]} />
          </div>
          <div className="cols">
            {schedule === "interval" && <Field label="Every" htmlFor="x-interval"><select id="x-interval" className="select" value={interval} onChange={(e) => setInterval_(Number(e.target.value))}>{INTERVALS.map((n) => <option key={n} value={n}>{`${n} hours`}</option>)}</select></Field>}
            {schedule === "weekly" && <Field label="Day" htmlFor="x-day"><select id="x-day" className="select" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>}
            <Field label={schedule === "interval" ? "Starting at (UTC)" : "Time (UTC)"} htmlFor="x-hour"><select id="x-hour" className="select" value={hour} onChange={(e) => setHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{`${String(i).padStart(2, "0")}:00`}</option>)}</select></Field>
          </div>
          <div className="field"><span className="flabel">Rows</span>
            <Segmented label="Rows" value={mode} onChange={setMode} options={[{ value: "incremental", label: "New and changed only" }, { value: "full", label: "Everything, every time" }]} />
            <span className="hint">The first export of each table is always complete.</span>
          </div>
          <div className="field"><span className="flabel">Environment</span>
            <Segmented label="Environment" value={env} onChange={setEnv} options={[{ value: "both", label: "Both" }, { value: "production", label: "Production" }, { value: "sandbox", label: "Sandbox" }]} />
          </div>
        </div>
      </section>
      {error && !error.param?.startsWith("config.") && !error.param?.startsWith("credentials.") && !error.param?.startsWith("columns.") && error.param !== "tables" && <div className="banner err" role="alert">{error.message}</div>}
      <div className="hrow">
        <button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : current ? "Save changes" : "Create export"}</button>
        <Link className="btn btn-line" to={current ? `/projects/${pid}/integrations/exports/${current.id}` : `/projects/${pid}/integrations/exports`}>Cancel</Link>
      </div>
    </form>
  );
}

const crumbsFor = (pid: string, last?: string) => (
  <><Link to={`/projects/${pid}/integrations`}>Integrations</Link> <span>/</span> {last ? <><Link to={`/projects/${pid}/integrations/exports`}>Data exports</Link> <span>/</span> <b>{last}</b></> : <b>Data exports</b>}</>
);

export function ExportsList() {
  const pid = useProjectId();
  const nav = useNavigate();
  const list = useExports(pid);
  const add = <Link className="btn btn-dark" to={`/projects/${pid}/integrations/exports/new`}><Icon name="plus" />New export</Link>;
  return (
    <Shell title="Data exports" crumbs={crumbsFor(pid)}>
      <div className="page">
        <PageHead title="Scheduled data exports" sub="CSV or Parquet files of your transactions, customers, subscriptions, events and paywall events, in your own bucket or inbox every few hours, day or week." actions={list.data?.length ? add : undefined} />
        {list.isLoading && <div className="panel pb subtle">Loading exports…</div>}
        {list.isError && <div className="banner err" role="alert">{errMsg(list.error)}</div>}
        {list.data && !list.data.length && <div className="empty"><h3>No data exports yet</h3><p>Send files to Amazon S3, Cloudflare R2, Google Cloud Storage or Azure Blob Storage, or get download links by email. The transaction columns match RevenueCat's export, so warehouse queries keep working.</p>{add}</div>}
        {!!list.data?.length && (
          <div className="panel tbl"><table>
            <thead><tr><th>Name</th><th>Destination</th><th>Tables</th><th>Schedule</th><th>Last run</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((x) => {
              const go = () => nav(`/projects/${pid}/integrations/exports/${x.id}`);
              return (
                <tr key={x.id} className="row" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }}>
                  <td><b>{x.name}</b></td>
                  <td>{DEST_LABEL[x.destination]}<span className="cellsub mono">{x.destination === "email" ? (x.config.recipients ?? []).join(", ") : `${x.config.bucket}${x.config.prefix ? `/${x.config.prefix}` : ""}`}</span></td>
                  <td className="mono">{x.tables.join(", ")}</td>
                  <td>{scheduleText(x)}<span className="cellsub">{x.format.toUpperCase()} · {x.mode === "incremental" ? "new and changed" : "full"}</span></td>
                  <td>{fmt.ago(x.last_run_at)}</td>
                  <td>{!x.enabled ? <StatusLine tone="idle">Paused</StatusLine> : x.consecutive_failures ? <StatusLine tone="bad">Failing</StatusLine> : <StatusLine tone="ok">Next {fmt.dateTime(x.next_run_at)}</StatusLine>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    </Shell>
  );
}

export function ExportNew() {
  const pid = useProjectId();
  return (
    <Shell title="New data export" crumbs={crumbsFor(pid, "New")}>
      <div className="page narrow">
        <PageHead title="New data export" sub="RevenueDot writes the files with the credentials you give it, which never leave the server." />
        <ExportForm pid={pid} />
      </div>
    </Shell>
  );
}

export function ExportDetail() {
  const pid = useProjectId();
  const { exportId = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const job = useQuery({ queryKey: ["export", pid, exportId], queryFn: () => api<DataExport>(`${base(pid)}/integrations/exports/${encodeURIComponent(exportId)}`), enabled: !!exportId, retry: false });
  const runs = useQuery({
    queryKey: ["export_runs", pid, exportId], queryFn: () => api<List<ExportRun>>(`${base(pid)}/integrations/exports/${encodeURIComponent(exportId)}/runs?limit=50`),
    enabled: !!job.data, refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === "queued" || r.status === "running") ? 2000 : 20_000),
  });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const x = job.data;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["export", pid, exportId] }), qc.invalidateQueries({ queryKey: ["export_runs", pid, exportId] }), qc.invalidateQueries({ queryKey: ["exports", pid] })]);
  const runNow = async (mode?: "full") => {
    setBusy("run");
    try { await api(`${base(pid)}/integrations/exports/${exportId}/actions/run`, { method: "POST", json: mode ? { mode } : {} }); toast("Export queued. It starts within a minute."); await refresh(); } catch (e) { toast(errMsg(e)); } finally { setBusy(null); }
  };
  const checkBucket = async () => {
    setBusy("check");
    try { setCheck(await api<{ ok: boolean; message: string }>(`${base(pid)}/integrations/exports/${exportId}/actions/check`, { method: "POST" })); } catch (e) { setCheck({ ok: false, message: errMsg(e) }); } finally { setBusy(null); }
  };
  const setEnabled = async (enabled: boolean) => {
    try { await api(`${base(pid)}/integrations/exports/${exportId}`, { method: "POST", json: { enabled } }); await refresh(); toast(enabled ? "Export resumed." : "Export paused."); } catch (e) { toast(errMsg(e)); }
  };
  const del = async () => {
    await api(`${base(pid)}/integrations/exports/${exportId}`, { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: ["exports", pid] });
    toast("Export deleted. Files already written stay in the bucket.");
    nav(`/projects/${pid}/integrations/exports`);
  };
  return (
    <Shell title={x?.name ?? "Data export"} crumbs={crumbsFor(pid, x?.name ?? "Export")}>
      <div className="page narrow">
        {job.isLoading && <div className="panel pb subtle">Loading…</div>}
        {job.isError && <div className="empty"><h3>This export does not exist</h3><Link className="btn btn-line" to={`/projects/${pid}/integrations/exports`}>Back to exports</Link></div>}
        {x && editing && <><PageHead title={`Edit ${x.name}`} /><ExportForm pid={pid} current={x} /></>}
        {x && !editing && (
          <>
            <PageHead title={x.name} sub={<span className="mono">{where(x)}</span>} actions={<>
              <button type="button" className="btn btn-dark" disabled={busy === "run"} onClick={() => runNow()}><Icon name="send" />{busy === "run" ? "Queuing…" : "Run now"}</button>
              {x.destination !== "email" && <button type="button" className="btn btn-line" disabled={busy === "check"} onClick={checkBucket}>{busy === "check" ? "Checking…" : x.destination === "azure" ? "Check container" : "Check bucket"}</button>}
              <button type="button" className="btn btn-line" onClick={() => setEditing(true)}><Icon name="edit" />Edit</button>
              <Menu label="More actions" items={[{ label: "Run a full export now", icon: "refresh", onSelect: () => runNow("full") }, "-", { label: "Delete export", icon: "trash", danger: true, onSelect: () => setDeleting(true) }]} />
            </>} />
            {check && <div className={`banner ${check.ok ? "ok" : "err"}`} role="status">{check.message}</div>}
            {x.last_error && <div className="banner err" role="alert">The last run failed: {x.last_error}</div>}
            <KeyValue rows={[
              ["Exports", <span key="en" className="hrow"><Switch checked={x.enabled} onChange={(v) => void setEnabled(v)} label={x.enabled ? "On" : "Paused"} /></span>],
              ["Destination", DEST_LABEL[x.destination]],
              ["Tables", <span className="mono">{x.tables.join(", ")}</span>],
              ["Columns", <span>{x.tables.map((t) => `${t}: ${x.columns[t]?.length ? `${x.columns[t]!.length} chosen` : "all"}`).join(" · ")}</span>],
              ["Format", `${x.format === "csv" ? `CSV${x.compression === "gzip" ? ", gzip" : ""}${x.split_files ? ", split every 10,000 rows" : ", one file per table"}` : "Parquet, split every 10,000 rows"} · ${x.mode === "incremental" ? "new and changed rows" : "every row, every time"}`],
              ["Schedule", `${scheduleText(x)} · next ${fmt.dateTime(x.next_run_at)}`],
              ["Environment", x.environment === "production" ? "Production" : x.environment === "sandbox" ? "Sandbox" : "Production and sandbox"],
            ]} />
            <section className="panel">
              <div className="ph"><b>Runs</b><button type="button" className="ib" aria-label="Refresh runs" onClick={() => runs.refetch()}><Icon name="refresh" /></button></div>
              {runs.data && !runs.data.items.length && <div className="pb section-sub">No runs yet. Click Run now, or wait for the schedule.</div>}
              {!!runs.data?.items.length && (
                <div className="tbl"><table>
                  <thead><tr><th>Started</th><th>Status</th><th>Mode</th><th>Rows</th><th>Size</th><th>Files</th></tr></thead>
                  <tbody>{runs.data.items.map((r) => (
                    <tr key={r.id}>
                      <td title={fmt.dateTime(r.created_at)}>{fmt.dateTime(r.started_at ?? r.created_at)}<span className="cellsub">{r.trigger === "manual" ? "Run now" : "Scheduled"}</span></td>
                      <td><Tag tone={RUN_TONE[r.status]}>{r.status}</Tag>{r.error && <span className="cellsub">{r.error}{r.next_attempt_at ? ` Retry ${fmt.dateTime(r.next_attempt_at)}.` : ""}</span>}</td>
                      <td>{r.mode === "full" || r.window_start === null ? "Full" : "Incremental"}</td>
                      <td className="num">{fmt.int(r.rows)}</td>
                      <td className="num">{bytes(r.bytes)}</td>
                      <td>{r.files.map((f) => <span key={f.key} className="cellsub mono">{f.key} · {fmt.int(f.rows)} rows</span>)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </section>
          </>
        )}
      </div>
      {deleting && x && (
        <ConfirmDialog title={`Delete ${x.name}?`} confirmLabel="Delete export" danger onConfirm={del} onClose={() => setDeleting(false)}>
          <p>RevenueDot stops writing files and deletes the saved credentials and the run history. Files already in the bucket stay there.</p>
        </ConfirmDialog>
      )}
    </Shell>
  );
}
