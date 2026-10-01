/**
 * Targeting: /projects/:projectId/targeting (rules in evaluation order, audiences) and Experiments: /experiments,
 * /experiments/:experimentId (variants, status, results).
 * A rule picks the current offering, and an offering per placement, for customers in its audience; the first live rule
 * that matches wins. Experiments split customers between two offerings and report conversion and revenue.
 * GAPS vs RevenueCat: no drag and drop (move up and down instead), no rule scheduling UI beyond start and end dates,
 * one control and one treatment per experiment, no LTV projections.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { ConfirmDialog, DataTable, Dialog, EmptyState, Field, Menu, PageHead, Panel, Tabs, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { errMsg, v2, type Offering } from "../catalog/lib";
import { ConditionBuilder, describeRules, fromRules, toRules, type Groups, type Rules } from "../../components/conditions";

interface Audience { id: string; name: string; rules: Rules; created_at: number; stats?: { total_customers: number; active_subscriptions: number; is_approximate: boolean } }
interface Rule { id: string; name: string; audience_id: string | null; offering_id: string; placements: Record<string, string | null>; position: number; state: "active" | "inactive"; starts_at: number | null; ends_at: number | null }
interface Experiment { id: string; name: string; status: "draft" | "running" | "paused" | "stopped"; audience_id: string | null; enrollment_percent: number; variants: { id: "a" | "b"; offering_id: string }[]; started_at: number | null; stopped_at: number | null; created_at: number }

export { describeRules };

const useAudiences = (pid: string) => useQuery({ queryKey: ["audiences", pid], enabled: !!pid, queryFn: async () => (await api<List<Audience>>(`${v2(pid)}/audiences`)).items });
const useRules = (pid: string) => useQuery({ queryKey: ["targeting-rules", pid], enabled: !!pid, queryFn: async () => (await api<List<Rule>>(`${v2(pid)}/targeting_rules`)).items });
const useOfferingList = (pid: string) => useQuery({ queryKey: ["offering-list", pid], enabled: !!pid, queryFn: async () => (await api<List<Offering>>(`${v2(pid)}/offerings?limit=100`)).items });

function AudienceDialog({ pid, existing, onClose, onSaved }: { pid: string; existing?: Audience; onClose: () => void; onSaved: (a: Audience) => void }) {
  const toast = useToast();
  const [name, setName] = useState(existing?.name ?? "");
  const [groups, setGroups] = useState<Groups>(existing ? fromRules(existing.rules) : [[{ field: "country", operator: "isAnyOf", value: "" }]]);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rules = toRules(groups);
  async function check() {
    setErr(null);
    try { const p = await api<{ stats: { total_customers: number; is_approximate: boolean } }>(`${v2(pid)}/audiences/actions/preview`, { method: "POST", json: { rules } }); setPreview(`${p.stats.is_approximate ? "About " : ""}${fmt.int(p.stats.total_customers)} customers match today.`); }
    catch (e) { setErr(errMsg(e)); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name the audience."); return; }
    setBusy(true); setErr(null);
    try {
      const a = existing ? await api<Audience>(`${v2(pid)}/audiences/${existing.id}`, { method: "POST", json: { name: name.trim(), rules } }) : await api<Audience>(`${v2(pid)}/audiences`, { method: "POST", json: { name: name.trim(), rules } });
      toast(existing ? "Audience saved" : "Audience created"); onSaved(a); onClose();
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <Dialog title={existing ? "Edit audience" : "New audience"} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={check}>Preview</button>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="aud-form" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </>}>
      <form id="aud-form" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Name" htmlFor="aud-name"><input id="aud-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Gold plan in the US" /></Field>
        <ConditionBuilder value={groups} onChange={setGroups} />
        {preview && <div className="banner" role="status">{preview}</div>}
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

function RuleDialog({ pid, existing, audiences, offerings, onClose }: { pid: string; existing?: Rule; audiences: Audience[]; offerings: Offering[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(existing?.name ?? "");
  const [audience, setAudience] = useState(existing?.audience_id ?? "");
  const [offering, setOffering] = useState(existing?.offering_id ?? offerings[0]?.id ?? "");
  const [placements, setPlacements] = useState<[string, string][]>(Object.entries(existing?.placements ?? {}).map(([k, v]) => [k, v ?? ""]));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name the rule."); return; }
    if (placements.some(([k]) => !/^[a-zA-Z0-9_.-]{1,100}$/.test(k))) { setErr("Placement identifiers are letters, digits, dots, dashes or underscores."); return; }
    setBusy(true); setErr(null);
    const json = { name: name.trim(), audience_id: audience || null, offering_id: offering, placements: Object.fromEntries(placements.map(([k, v]) => [k, v || null])) };
    try {
      await api(existing ? `${v2(pid)}/targeting_rules/${existing.id}` : `${v2(pid)}/targeting_rules`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: ["targeting-rules", pid] }); toast(existing ? "Rule saved" : "Rule created. It is inactive until you turn it on."); onClose();
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <Dialog title={existing ? "Edit targeting rule" : "New targeting rule"} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="rule-form" className="btn btn-dark" disabled={busy || !offering}>{busy ? "Saving…" : "Save"}</button>
    </>}>
      <form id="rule-form" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Name" htmlFor="rule-name"><input id="rule-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Summer sale for Germany" /></Field>
        <Field label="Audience" htmlFor="rule-aud" hint="Who this rule applies to.">
          <select id="rule-aud" className="select" value={audience} onChange={(e) => setAudience(e.target.value)}><option value="">Everyone</option>{audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
        <Field label="Current offering" htmlFor="rule-off" hint="What Offerings.current returns for them.">
          <select id="rule-off" className="select" value={offering} onChange={(e) => setOffering(e.target.value)}>{offerings.map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.lookup_key})</option>)}</select>
        </Field>
        <div>
          <div className="label">Placements</div>
          <p className="subtle" style={{ margin: "2px 0 6px" }}>Optional. A placement is a spot in your app, such as onboarding_end, asked for with getCurrentOffering(forPlacement:).</p>
          {placements.map(([k, v], i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <input aria-label={`Placement ${i + 1}`} className="input mono" value={k} placeholder="onboarding_end" onChange={(e) => setPlacements(placements.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} />
              <select aria-label={`Placement offering ${i + 1}`} className="select" value={v} onChange={(e) => setPlacements(placements.map((p, j) => (j === i ? [p[0], e.target.value] : p)))}>
                <option value="">No paywall</option>{offerings.map((o) => <option key={o.id} value={o.id}>{o.lookup_key}</option>)}
              </select>
              <button type="button" className="btn btn-ghost" aria-label={`Remove placement ${i + 1}`} onClick={() => setPlacements(placements.filter((_, j) => j !== i))}><Icon name="trash" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => setPlacements([...placements, ["", offering]])}><Icon name="plus" />Add a placement</button>
        </div>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

export function TargetingPage() {
  const pid = useProjectId();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"rules" | "audiences">("rules");
  const rules = useRules(pid);
  const auds = useAudiences(pid);
  const offs = useOfferingList(pid);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const close = () => setDialog(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["targeting-rules", pid] }), qc.invalidateQueries({ queryKey: ["audiences", pid] })]);
  const offName = (id: string | null) => offs.data?.find((o) => o.id === id)?.lookup_key ?? id ?? "—";
  const audName = (id: string | null) => (id ? auds.data?.find((a) => a.id === id)?.name ?? id : "Everyone");
  const list = rules.data ?? [];
  const move = async (i: number, d: -1 | 1) => {
    const ids = list.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    await api(`${v2(pid)}/targeting_rules/actions/reorder`, { method: "POST", json: { rule_ids: ids } }); await refresh();
  };
  const ruleMenu = (r: Rule, i: number): (MenuItem | "-")[] => [
    { label: r.state === "active" ? "Turn off" : "Turn on", icon: r.state === "active" ? "archive" : "refresh", onSelect: async () => { await api(`${v2(pid)}/targeting_rules/${r.id}`, { method: "POST", json: { state: r.state === "active" ? "inactive" : "active" } }); await refresh(); toast(r.state === "active" ? "Rule turned off" : "Rule is live"); } },
    { label: "Edit", icon: "edit", onSelect: () => setDialog(<RuleDialog pid={pid} existing={r} audiences={auds.data ?? []} offerings={offs.data ?? []} onClose={close} />) },
    { label: "Move up", icon: "up", disabled: i === 0, onSelect: () => move(i, -1) },
    { label: "Move down", icon: "down", disabled: i === list.length - 1, onSelect: () => move(i, 1) },
    "-", { label: "Delete", icon: "trash", danger: true, onSelect: () => setDialog(<ConfirmDialog title="Delete this rule?" confirmLabel="Delete rule" danger onClose={close} onConfirm={async () => { await api(`${v2(pid)}/targeting_rules/${r.id}`, { method: "DELETE" }); await refresh(); toast("Rule deleted"); }}><p>Customers it matched get the next matching rule, or the current offering.</p></ConfirmDialog>) },
  ];
  return (
    <Shell title="Targeting">
      <div className="page">
        <PageHead title="Targeting" sub="Show different offerings to different customers without an app release. Rules are checked from top to bottom; the first live rule that matches decides."
          actions={tab === "rules"
            ? <button type="button" className="btn btn-dark" disabled={!offs.data?.length} onClick={() => setDialog(<RuleDialog pid={pid} audiences={auds.data ?? []} offerings={offs.data ?? []} onClose={close} />)}><Icon name="plus" />New rule</button>
            : <button type="button" className="btn btn-dark" onClick={() => setDialog(<AudienceDialog pid={pid} onClose={close} onSaved={() => refresh()} />)}><Icon name="plus" />New audience</button>} />
        <Tabs label="Targeting" idBase="targeting" value={tab} tabs={[{ value: "rules", label: "Rules" }, { value: "audiences", label: "Audiences" }]} onChange={setTab} />
        {tab === "rules" ? (rules.isLoading ? <div className="panel pb subtle">Loading…</div> : !list.length ? (
          <EmptyState title="No targeting rules" text={offs.data?.length ? "Everyone sees the current offering. Add a rule to show another offering to an audience, or per placement." : "Create an offering first."} />
        ) : (
          <DataTable rowKey={(r) => r.id} rows={list} columns={[
            { key: "n", header: "#", render: (r) => r.position + 1 },
            { key: "name", header: "Rule", render: (r) => r.name },
            { key: "aud", header: "Audience", render: (r) => audName(r.audience_id) },
            { key: "off", header: "Offering", render: (r) => <><code>{offName(r.offering_id)}</code>{Object.keys(r.placements).length ? <span className="subtle"> · {Object.keys(r.placements).length} placement{Object.keys(r.placements).length === 1 ? "" : "s"}</span> : null}</> },
            { key: "state", header: "State", render: (r) => <Tag tone={r.state === "active" ? "up" : "muted"}>{r.state === "active" ? "Live" : "Off"}</Tag> },
            { key: "menu", header: "", align: "right", render: (r) => <Menu label={`Actions for ${r.name}`} items={ruleMenu(r, list.indexOf(r))} /> },
          ]} />
        )) : (auds.isLoading ? <div className="panel pb subtle">Loading…</div> : !auds.data?.length ? (
          <EmptyState title="No audiences" text="An audience is a set of conditions on customers, such as country, app version, subscription status or a custom attribute." />
        ) : (
          <DataTable rowKey={(a) => a.id} rows={auds.data} columns={[
            { key: "name", header: "Audience", render: (a) => a.name },
            { key: "rules", header: "Conditions", render: (a) => <span className="subtle">{describeRules(a.rules)}</span> },
            { key: "menu", header: "", align: "right", render: (a) => <Menu label={`Actions for ${a.name}`} items={[
              { label: "Edit", icon: "edit", onSelect: () => setDialog(<AudienceDialog pid={pid} existing={a} onClose={close} onSaved={() => refresh()} />) },
              "-", { label: "Delete", icon: "trash", danger: true, onSelect: () => setDialog(<ConfirmDialog title="Delete this audience?" confirmLabel="Delete audience" danger onClose={close} onConfirm={async () => { await api(`${v2(pid)}/audiences/${a.id}`, { method: "DELETE" }); await refresh(); toast("Audience deleted"); }}><p>Rules and experiments that use it must be changed first.</p></ConfirmDialog>) },
            ]} /> },
          ]} />
        ))}
      </div>
      {dialog}
    </Shell>
  );
}

// ---- Experiments ----

const STATUS_TONE: Record<Experiment["status"], "up" | "gold" | "muted" | "info"> = { draft: "muted", running: "up", paused: "gold", stopped: "info" };

function ExperimentDialog({ pid, audiences, offerings, onClose }: { pid: string; audiences: Audience[]; offerings: Offering[]; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [a, setA] = useState(offerings.find((o) => o.is_current)?.id ?? offerings[0]?.id ?? "");
  const [b, setB] = useState(offerings.find((o) => !o.is_current)?.id ?? "");
  const [audience, setAudience] = useState("");
  const [pct, setPct] = useState("100");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name the experiment."); return; }
    if (!a || !b || a === b) { setErr("Pick two different offerings."); return; }
    const n = Number(pct);
    if (!Number.isInteger(n) || n < 1 || n > 100) { setErr("Enrollment is a whole percentage from 1 to 100."); return; }
    setBusy(true); setErr(null);
    try { const x = await api<Experiment>(`${v2(pid)}/experiments`, { method: "POST", json: { name: name.trim(), offering_a: a, offering_b: b, audience_id: audience || null, enrollment_percent: n } }); nav(`/projects/${pid}/experiments/${x.id}`); }
    catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <Dialog title="New experiment" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="exp-form" className="btn btn-dark" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
    </>}>
      <form id="exp-form" onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Name" htmlFor="exp-name"><input id="exp-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Annual plan first" /></Field>
        <Field label="Control (a)" htmlFor="exp-a"><select id="exp-a" className="select" value={a} onChange={(e) => setA(e.target.value)}>{offerings.map((o) => <option key={o.id} value={o.id}>{o.lookup_key}</option>)}</select></Field>
        <Field label="Treatment (b)" htmlFor="exp-b"><select id="exp-b" className="select" value={b} onChange={(e) => setB(e.target.value)}><option value="">Choose an offering</option>{offerings.map((o) => <option key={o.id} value={o.id}>{o.lookup_key}</option>)}</select></Field>
        <Field label="Audience" htmlFor="exp-aud"><select id="exp-aud" className="select" value={audience} onChange={(e) => setAudience(e.target.value)}><option value="">Everyone</option>{audiences.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Enroll this share of customers (%)" htmlFor="exp-pct" hint="Customers who are not enrolled see the normal offering."><input id="exp-pct" className="input" inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

export function ExperimentsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["experiments", pid], enabled: !!pid, queryFn: async () => (await api<List<Experiment>>(`${v2(pid)}/experiments?limit=100`)).items });
  const auds = useAudiences(pid);
  const offs = useOfferingList(pid);
  const [creating, setCreating] = useState(false);
  const offName = (id: string) => offs.data?.find((o) => o.id === id)?.lookup_key ?? id;
  return (
    <Shell title="Experiments">
      <div className="page">
        <PageHead title="Experiments" sub="Test two offerings against each other. Each customer always sees the same one, and results compare conversion and revenue."
          actions={<button type="button" className="btn btn-dark" disabled={(offs.data?.length ?? 0) < 2} onClick={() => setCreating(true)}><Icon name="plus" />New experiment</button>} />
        {q.isLoading ? <div className="panel pb subtle">Loading…</div> : !q.data?.length ? (
          <EmptyState title="No experiments yet" text={(offs.data?.length ?? 0) < 2 ? "Create two offerings to compare, then start an experiment." : "Pick a control and a treatment offering and start the test."} />
        ) : (
          <DataTable rowKey={(x) => x.id} rows={q.data.slice().sort((a, b) => b.created_at - a.created_at)} onRowClick={(x) => nav(`/projects/${pid}/experiments/${x.id}`)} columns={[
            { key: "name", header: "Experiment", render: (x) => x.name },
            { key: "v", header: "Offerings", render: (x) => <><code>{offName(x.variants[0]!.offering_id)}</code> vs <code>{offName(x.variants[1]!.offering_id)}</code></> },
            { key: "s", header: "Status", render: (x) => <Tag tone={STATUS_TONE[x.status]}>{x.status[0]!.toUpperCase() + x.status.slice(1)}</Tag> },
            { key: "d", header: "Started", render: (x) => fmt.date(x.started_at) },
          ]} />
        )}
      </div>
      {creating && <ExperimentDialog pid={pid} audiences={auds.data ?? []} offerings={offs.data ?? []} onClose={() => setCreating(false)} />}
    </Shell>
  );
}

interface Results { variants: { items: { id: "a" | "b"; offering_id: string; customers: number; conversions: number; trials: number; conversion_rate: number; revenue: number; revenue_per_customer: number }[] }; chance_b_beats_a: number; enough_data: boolean }

export function ExperimentDetail() {
  const pid = useProjectId();
  const { experimentId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [env, setEnv] = useState<"production" | "sandbox">("production");
  const x = useQuery({ queryKey: ["experiment", pid, experimentId], queryFn: () => api<Experiment>(`${v2(pid)}/experiments/${experimentId}`) });
  const res = useQuery({ queryKey: ["experiment-results", pid, experimentId, env], queryFn: () => api<Results>(`${v2(pid)}/experiments/${experimentId}/results?environment=${env}`) });
  const offs = useOfferingList(pid);
  const [confirm, setConfirm] = useState<ReactNode>(null);
  const offName = (id: string) => offs.data?.find((o) => o.id === id)?.lookup_key ?? id;
  const act = async (action: "start" | "pause" | "stop") => {
    await api(`${v2(pid)}/experiments/${experimentId}/actions/${action}`, { method: "POST" });
    await qc.invalidateQueries({ queryKey: ["experiment", pid, experimentId] }); await qc.invalidateQueries({ queryKey: ["experiments", pid] });
    toast(action === "start" ? "Experiment running" : action === "pause" ? "Paused: nobody new is enrolled" : "Experiment stopped");
  };
  const e = x.data;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <Shell title={e?.name ?? "Experiment"} crumbs={<><Link className="cat-crumb-up" to={`/projects/${pid}/experiments`}>Experiments</Link> <span className="cat-crumb-up">/</span> <b className="cat-crumb">{e?.name ?? ""}</b></>}>
      <div className="page">
        <PageHead title={e?.name ?? "Experiment"} sub={e ? <Tag tone={STATUS_TONE[e.status]}>{e.status[0]!.toUpperCase() + e.status.slice(1)}</Tag> : undefined} actions={e ? (
          <div style={{ display: "flex", gap: 8 }}>
            {(e.status === "draft" || e.status === "paused") && <button type="button" className="btn btn-dark" onClick={() => act("start")}>{e.status === "draft" ? "Start" : "Resume"}</button>}
            {e.status === "running" && <button type="button" className="btn btn-line" onClick={() => act("pause")}>Pause</button>}
            {(e.status === "running" || e.status === "paused") && <button type="button" className="btn btn-line" onClick={() => setConfirm(<ConfirmDialog title="Stop this experiment?" confirmLabel="Stop" danger onClose={() => setConfirm(null)} onConfirm={() => act("stop")}><p>Customers go back to the normal offering. A stopped experiment cannot restart.</p></ConfirmDialog>)}>Stop</button>}
            {e.status !== "running" && <button type="button" className="btn btn-ghost" onClick={() => setConfirm(<ConfirmDialog title="Delete this experiment?" confirmLabel="Delete" danger onClose={() => setConfirm(null)} onConfirm={async () => { await api(`${v2(pid)}/experiments/${experimentId}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["experiments", pid] }); nav(`/projects/${pid}/experiments`); }}><p>Its enrollments and results are deleted.</p></ConfirmDialog>)}>Delete</button>}
          </div>) : undefined} />
        {e && (
          <Panel title="Results" link={<select aria-label="Environment" className="select" value={env} onChange={(ev) => setEnv(ev.target.value as typeof env)}><option value="production">Production</option><option value="sandbox">Sandbox</option></select>}>
            {res.isLoading || !res.data ? <div className="pb subtle">Loading…</div> : (
              <>
                <DataTable rowKey={(v) => v.id} rows={res.data.variants.items} columns={[
                  { key: "v", header: "Variant", render: (v) => <>{v.id === "a" ? "Control" : "Treatment"} <code>{offName(v.offering_id)}</code></> },
                  { key: "c", header: "Customers", align: "right", render: (v) => fmt.int(v.customers) },
                  { key: "cv", header: "Converted", align: "right", render: (v) => `${fmt.int(v.conversions)} (${pct(v.conversion_rate)})` },
                  { key: "t", header: "Trials", align: "right", render: (v) => fmt.int(v.trials) },
                  { key: "r", header: "Revenue", align: "right", render: (v) => fmt.usd(v.revenue, true) },
                  { key: "rpc", header: "Per customer", align: "right", render: (v) => fmt.usd(v.revenue_per_customer, true) },
                ]} />
                <p className="pb" style={{ margin: 0 }}>Chance the treatment converts better: <b>{pct(res.data.chance_b_beats_a)}</b>.{!res.data.enough_data && <span className="subtle"> Too early to call: wait for at least 100 customers in each variant.</span>}</p>
              </>
            )}
          </Panel>
        )}
      </div>
      {confirm}
    </Shell>
  );
}
