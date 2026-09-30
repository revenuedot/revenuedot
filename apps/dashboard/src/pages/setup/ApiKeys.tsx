import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { CodeBlock, ConfirmDialog, Dialog, Field, Menu, PageHead, Segmented, Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { KeyCell, StoreCell } from "./Apps";
import { apiOrigin, base, errMsg, useApps, type SecretKey } from "./data";

/**
 * API keys (/projects/:projectId/api-keys): public app keys (reveal, copy) and secret keys for API v2 (create with a
 * name and permissions, shown once, revoke).
 * GAPS vs RevenueCat: legacy v1 secret keys (every key here is a v2 key with scopes) and editing a key's name or
 * permissions after creation (revoke and create a new one).
 */

type Level = "none" | "read" | "read_write";
const GROUPS: { domain: string; label: string; resources: { id: string; label: string; readOnly?: boolean }[] }[] = [
  { domain: "project_configuration", label: "Project configuration", resources: [
    { id: "projects", label: "Projects" }, { id: "apps", label: "Apps" }, { id: "products", label: "Products" }, { id: "entitlements", label: "Entitlements" },
    { id: "offerings", label: "Offerings" }, { id: "packages", label: "Packages" }, { id: "integrations", label: "Integrations (webhooks)" },
    { id: "collaborators", label: "Collaborators", readOnly: true }, { id: "api_keys", label: "API keys" },
  ] },
  { domain: "customer_information", label: "Customer information", resources: [
    { id: "customers", label: "Customers" }, { id: "subscriptions", label: "Subscriptions" }, { id: "purchases", label: "Purchases" }, { id: "invoices", label: "Invoices" },
  ] },
  { domain: "charts_metrics", label: "Charts and metrics", resources: [{ id: "charts", label: "Charts", readOnly: true }, { id: "overview", label: "Overview metrics", readOnly: true }] },
];

function summary(perms: string[]) {
  if (perms.includes("*")) return "Full access";
  const rw = perms.filter((p) => p.endsWith(":read_write")).length;
  return `${perms.length} permission${perms.length === 1 ? "" : "s"}${rw ? `, ${rw} with write` : ", read only"}`;
}

function CreateKeyDialog({ pid, onClose, onCreated }: { pid: string; onClose: () => void; onCreated: (k: SecretKey) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"full" | "custom">("full");
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [errors, setErrors] = useState<{ name?: string; perms?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const perms = Object.entries(levels).filter(([, l]) => l !== "none").map(([k, l]) => `${k}:${l}`);
  const setGroup = (domain: string, l: Level) => {
    const g = GROUPS.find((x) => x.domain === domain)!;
    setLevels((v) => ({ ...v, ...Object.fromEntries(g.resources.map((r) => [`${domain}:${r.id}`, r.readOnly && l === "read_write" ? "read" : l])) }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!name.trim()) errs.name = "Name the key after where it is used, for example Backend production.";
    if (mode === "custom" && !perms.length) errs.perms = "Give the key at least one permission.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const k = await api<SecretKey>(`${base(pid)}/api_keys`, { method: "POST", json: { name: name.trim(), permissions: mode === "full" ? ["*"] : perms } });
      await qc.invalidateQueries({ queryKey: ["api_keys", pid] });
      onCreated(k);
    } catch (err) { setErrors({ form: errMsg(err) }); setBusy(false); }
  }

  return (
    <Dialog title="New secret API key" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="new-key" className="btn btn-dark" disabled={busy}>{busy ? "Creating…" : "Create key"}</button>
    </>}>
      <form id="new-key" className="stack" onSubmit={submit} noValidate>
        <Field label="Name" htmlFor="key-name" error={errors.name} hint="Only you see this name.">
          <input id="key-name" className="input" autoFocus maxLength={100} value={name} placeholder="Backend production" aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="field">
          <span className="flabel">Permissions</span>
          <Segmented label="Permissions" value={mode} onChange={setMode} options={[{ value: "full", label: "Full access" }, { value: "custom", label: "Choose permissions" }]} />
          <span className="hint">{mode === "full" ? "Reads and changes everything in this project, like a project admin." : "Give the key only what your server needs."}</span>
        </div>
        {mode === "custom" && GROUPS.map((g) => (
          <div key={g.domain} className="stack tight">
            <div className="hrow between"><b>{g.label}</b>
              <span className="hrow">
                <button type="button" className="btn btn-ghost" onClick={() => setGroup(g.domain, "none")}>None</button>
                <button type="button" className="btn btn-ghost" onClick={() => setGroup(g.domain, "read")}>All read</button>
                {g.resources.some((r) => !r.readOnly) && <button type="button" className="btn btn-ghost" onClick={() => setGroup(g.domain, "read_write")}>All write</button>}
              </span>
            </div>
            <div>
              {g.resources.map((r) => {
                const k = `${g.domain}:${r.id}`;
                const opts: { value: Level; label: string }[] = [{ value: "none", label: "None" }, { value: "read", label: "Read" }, ...(r.readOnly ? [] : [{ value: "read_write" as Level, label: "Read & write" }])];
                return (
                  <div key={k} className="perm">
                    <span>{r.label} <code>{k}</code></span>
                    <select className="select" aria-label={`${r.label} access`} value={levels[k] ?? "none"} onChange={(e) => setLevels((x) => ({ ...x, [k]: e.target.value as Level }))}>
                      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {errors.perms && <span className="form-err" role="alert">{errors.perms}</span>}
        {errors.form && <div className="banner err" role="alert">{errors.form}</div>}
      </form>
    </Dialog>
  );
}

function ShowOnceDialog({ pid, k, onClose }: { pid: string; k: SecretKey; onClose: () => void }) {
  const curl = `curl ${apiOrigin()}/v2/projects/${pid}/apps \\\n  -H "Authorization: Bearer ${k.key}"`;
  return (
    <Dialog title="Copy your secret key now" onClose={onClose} footer={<button type="button" className="btn btn-dark" onClick={onClose}>I have copied it</button>}>
      <div className="banner warn">This is the only time the key is shown. Store it in your server's secrets. If you lose it, revoke it and create a new one.</div>
      <CodeBlock label="Secret key" code={k.key ?? ""} />
      <p className="section-sub">Try it:</p>
      <CodeBlock label="Terminal" code={curl} />
    </Dialog>
  );
}

export function ApiKeys() {
  const pid = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const apps = useApps(pid);
  const keys = useQuery({ queryKey: ["api_keys", pid], queryFn: async () => (await api<List<SecretKey>>(`${base(pid)}/api_keys?limit=100`)).items, enabled: !!pid });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<SecretKey | null>(null);
  const [revoking, setRevoking] = useState<SecretKey | null>(null);

  const revoke = async (k: SecretKey) => {
    await api(`${base(pid)}/api_keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: ["api_keys", pid] });
    toast(`${k.name} revoked. Requests with it now fail.`);
  };

  return (
    <Shell title="API keys">
      <div className="page">
        <PageHead title="API keys" sub="Public keys go in your app. Secret keys are for your server and the REST API: keep them out of apps and source control." />

        <section className="panel">
          <div className="ph"><b>Public app-specific keys</b><Link className="link" to={`/projects/${pid}/apps`}>Manage apps →</Link></div>
          {apps.isLoading && <div className="pb subtle">Loading…</div>}
          {apps.isError && <div className="pb"><div className="banner err" role="alert">The apps could not be loaded: {errMsg(apps.error)}</div></div>}
          {apps.data && !apps.data.length && <div className="pb section-sub">No apps yet. <Link className="linkish" to={`/projects/${pid}/apps`}>Add an app</Link> to get its public key.</div>}
          {!!apps.data?.length && (
            <div className="tbl">
              <table>
                <thead><tr><th>App</th><th>Public key</th><th>Environment</th></tr></thead>
                <tbody>{apps.data.map((a) => (
                  <tr key={a.id}><td><StoreCell app={a} /></td><td><KeyCell pid={pid} appId={a.id} /></td><td><Tag tone={a.type === "test_store" ? "info" : "muted"}>{a.type === "test_store" ? "Sandbox" : "Production"}</Tag></td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="ph"><b>Secret keys</b>{!!keys.data?.length && <button type="button" className="btn btn-dark" onClick={() => setCreating(true)}><Icon name="plus" />New secret key</button>}</div>
          {keys.isLoading && <div className="pb subtle">Loading…</div>}
          {keys.isError && <div className="pb"><div className="banner err" role="alert">The keys could not be loaded: {errMsg(keys.error)}</div></div>}
          {keys.data && !keys.data.length && (
            <div className="pb stack" style={{ alignItems: "flex-start" }}>
              <p className="section-sub">No secret keys yet. Create one to call the REST API (v2) from your server, for example to grant entitlements or read customers.</p>
              <button type="button" className="btn btn-dark" onClick={() => setCreating(true)}><Icon name="plus" />New secret key</button>
            </div>
          )}
          {!!keys.data?.length && (
            <div className="tbl">
              <table>
                <thead><tr><th>Name</th><th>Key</th><th>Permissions</th><th>Created</th><th>Last used</th><th aria-label="Actions" /></tr></thead>
                <tbody>{keys.data.map((k) => (
                  <tr key={k.id}>
                    <td><b>{k.name}</b></td>
                    <td className="id">{k.prefix}…</td>
                    <td title={k.permissions.join("\n")}>{summary(k.permissions)}</td>
                    <td>{fmt.date(k.created_at)}</td>
                    <td className="muted">{k.last_used_at ? fmt.ago(k.last_used_at) : "Never"}</td>
                    <td className="amt"><Menu label={`Actions for ${k.name}`} items={[{ label: "Revoke key", icon: "trash", danger: true, onSelect: () => setRevoking(k) }]} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {creating && <CreateKeyDialog pid={pid} onClose={() => setCreating(false)} onCreated={(k) => { setCreating(false); setCreated(k); }} />}
      {created && <ShowOnceDialog pid={pid} k={created} onClose={() => setCreated(null)} />}
      {revoking && (
        <ConfirmDialog title={`Revoke ${revoking.name}?`} confirmLabel="Revoke key" danger onConfirm={() => revoke(revoking)} onClose={() => setRevoking(null)}>
          <p>Servers using <span className="mono">{revoking.prefix}…</span> get "Invalid API key" from the next request. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </Shell>
  );
}
