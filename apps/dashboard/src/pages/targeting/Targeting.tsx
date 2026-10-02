/**
 * Targeting: /projects/:projectId/targeting (prd/experiments/PRD.md §6), in RevenueCat's layout. Tabs Live, Scheduled
 * (turned on, start date ahead), Inactive (turned off or ended) and Audiences. Each rule is a card that reads as
 * sentences ("If customer matches Gold plan then show promo for onboarding_end; default for all other cases") with a
 * drag handle (arrow keys too) and a menu: Edit, Turn on / off, Move up / down, Duplicate, Delete. Below the live rules
 * the default offering: the project's current offering, for customers no rule matches. New rule: from scratch, or
 * drafted by RevenueDot AI (created turned off, after approval).
 * Rules are checked from top to bottom; the first live rule that matches decides (services/targeting.ts).
 */
import { useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { ConfirmDialog, DataTable, Dialog, EmptyState, Field, Menu, PageHead, Tabs, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { errMsg, listAll, v2, type Offering } from "../catalog/lib";
import { ConditionBuilder, describeRules, fromRules, incomplete, toRules, useFieldSuggestions, type Groups } from "../../components/conditions";
import { useAiStatus } from "../ai/data";
import { AskDialog } from "../experiments/Experiments";
import { useCanEdit, useOrderSaver, type Audience, type TargetingRule as Rule } from "../experiments/lib";

export { describeRules };

const useAudiences = (pid: string) => useQuery({ queryKey: ["audiences", pid], enabled: !!pid, queryFn: async () => (await api<List<Audience>>(`${v2(pid)}/audiences`)).items });
const useRules = (pid: string) => useQuery({ queryKey: ["targeting-rules", pid], enabled: !!pid, queryFn: async () => (await api<List<Rule>>(`${v2(pid)}/targeting_rules`)).items });
const useOfferingList = (pid: string) => useQuery({ queryKey: ["offering-list", pid], enabled: !!pid, queryFn: () => listAll<Offering>(`${v2(pid)}/offerings`) });

type Phase = "live" | "scheduled" | "inactive";
/** Where a rule is now: live (on, started, not ended), scheduled (on, starts later) or inactive (off, or ended). */
export function phaseOf(r: Rule, now = Date.now()): Phase {
  if (r.state !== "active" || (r.ends_at !== null && r.ends_at <= now)) return "inactive";
  return r.starts_at !== null && r.starts_at > now ? "scheduled" : "live";
}
/** datetime-local value (local time) for an epoch, and back. */
const toLocal = (ms: number | null) => (ms === null ? "" : new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
const fromLocal = (s: string) => (s ? new Date(s).getTime() : null);

function AudienceDialog({ pid, existing, onClose, onSaved }: { pid: string; existing?: Audience; onClose: () => void; onSaved: (a: Audience) => void }) {
  const toast = useToast();
  const [name, setName] = useState(existing?.name ?? "");
  const [groups, setGroups] = useState<Groups>(existing ? fromRules(existing.rules) : [[{ field: "country", operator: "isAnyOf", value: "" }]]);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suggestions = useFieldSuggestions(pid);
  const rules = toRules(groups);
  async function check() {
    setErr(null);
    try { const p = await api<{ stats: { total_customers: number; is_approximate: boolean } }>(`${v2(pid)}/audiences/actions/preview`, { method: "POST", json: { rules } }); setPreview(`${p.stats.is_approximate ? "About " : ""}${fmt.int(p.stats.total_customers)} customers match today.`); }
    catch (e) { setErr(errMsg(e)); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name the audience."); return; }
    if (incomplete(groups)) { setErr("Fill in every condition's value, or remove the condition."); return; }
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
        <ConditionBuilder value={groups} onChange={setGroups} suggestions={suggestions.data} />
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
  // Archived offerings are not served to the SDK: never a new rule's default, and listed only when a rule already names one.
  const servable = offerings.filter((o) => o.state !== "inactive");
  const [offering, setOffering] = useState(existing?.offering_id ?? servable.find((o) => !o.is_current)?.id ?? servable[0]?.id ?? "");
  const choices = (keep: string | null) => offerings.filter((o) => o.state !== "inactive" || o.id === keep);
  const [placements, setPlacements] = useState<[string, string][]>(Object.entries(existing?.placements ?? {}).map(([k, v]) => [k, v ?? ""]));
  const [starts, setStarts] = useState(toLocal(existing?.starts_at ?? null));
  const [ends, setEnds] = useState(toLocal(existing?.ends_at ?? null));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name the rule."); return; }
    if (placements.some(([k]) => !/^[a-zA-Z0-9_.-]{1,100}$/.test(k))) { setErr("Placement identifiers are letters, digits, dots, dashes or underscores."); return; }
    if (new Set(placements.map(([k]) => k)).size !== placements.length) { setErr("Each placement can be listed once."); return; }
    const s = fromLocal(starts), en = fromLocal(ends);
    if (s !== null && en !== null && en <= s) { setErr("The end must be after the start."); return; }
    setBusy(true); setErr(null);
    const json = { name: name.trim(), audience_id: audience || null, offering_id: offering, placements: Object.fromEntries(placements.map(([k, v]) => [k, v || null])), starts_at: s, ends_at: en };
    try {
      await api(existing ? `${v2(pid)}/targeting_rules/${existing.id}` : `${v2(pid)}/targeting_rules`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: ["targeting-rules", pid] }); toast(existing ? "Rule saved" : "Rule created. It is off until you turn it on."); onClose();
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
          <select id="rule-aud" className="select" value={audience} onChange={(e) => setAudience(e.target.value)}><option value="">Any audience</option>{audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
        <Field label="Current offering" htmlFor="rule-off" hint="What Offerings.current returns for them, and what every placement not listed below shows.">
          <select id="rule-off" className="select" value={offering} onChange={(e) => setOffering(e.target.value)}>{choices(existing?.offering_id ?? null).map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.lookup_key}){o.state === "inactive" ? " · archived" : ""}</option>)}</select>
        </Field>
        <div>
          <div className="label">Placements</div>
          <p className="subtle" style={{ margin: "2px 0 6px" }}>Optional. A placement is a spot in your app, such as onboarding_end, asked for with getCurrentOffering(forPlacement:).</p>
          {placements.map(([k, v], i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <input aria-label={`Placement ${i + 1}`} className="input mono" value={k} placeholder="onboarding_end" onChange={(e) => setPlacements(placements.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} />
              <select aria-label={`Placement offering ${i + 1}`} className="select" value={v} onChange={(e) => setPlacements(placements.map((p, j) => (j === i ? [p[0], e.target.value] : p)))}>
                <option value="">No paywall</option>{choices(existing?.placements[k] ?? null).map((o) => <option key={o.id} value={o.id}>{o.lookup_key}{o.state === "inactive" ? " · archived" : ""}</option>)}
              </select>
              <button type="button" className="btn btn-ghost" aria-label={`Remove placement ${i + 1}`} onClick={() => setPlacements(placements.filter((_, j) => j !== i))}><Icon name="trash" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => setPlacements([...placements, ["", offering]])}><Icon name="plus" />Add a placement</button>
        </div>
        <div className="xp-grid2">
          <Field label="Starts" htmlFor="rule-start" hint="Optional. Empty: as soon as it is on."><input id="rule-start" type="datetime-local" className="input" value={starts} onChange={(e) => setStarts(e.target.value)} /></Field>
          <Field label="Ends" htmlFor="rule-end" hint="Optional. Empty: until you turn it off."><input id="rule-end" type="datetime-local" className="input" value={ends} onChange={(e) => setEnds(e.target.value)} /></Field>
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
  const [tab, setTab] = useState<Phase | "audiences">("live");
  const rules = useRules(pid);
  const auds = useAudiences(pid);
  const offs = useOfferingList(pid);
  const ai = useAiStatus(pid);
  const canEdit = useCanEdit(pid);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  const close = () => setDialog(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["targeting-rules", pid] }), qc.invalidateQueries({ queryKey: ["audiences", pid] })]);
  const offKey = (id: string | null) => offs.data?.find((o) => o.id === id)?.lookup_key ?? id ?? "—";
  const audName = (id: string | null) => (id ? auds.data?.find((a) => a.id === id)?.name ?? id : "Any audience");
  const all = (rules.data ?? []).slice().sort((a, b) => a.position - b.position);
  const now = Date.now();
  const byPhase = { live: all.filter((r) => phaseOf(r, now) === "live"), scheduled: all.filter((r) => phaseOf(r, now) === "scheduled"), inactive: all.filter((r) => phaseOf(r, now) === "inactive") };
  const shown = tab === "audiences" ? [] : byPhase[tab];
  const current = offs.data?.find((o) => o.is_current);
  const aiOk = !!ai.data?.available && !!ai.data?.can_write;

  const saveOrder = useOrderSaver<Rule>(["targeting-rules", pid], (rs, ids) => rs.map((r) => ({ ...r, position: ids.indexOf(r.id) })),
    (ids) => api(`${v2(pid)}/targeting_rules/actions/reorder`, { method: "POST", json: { rule_ids: ids } }), (error) => toast(error ?? "Order saved"));
  /** Reorders the rules of one tab; the other tabs' rules keep their slots in the global order. */
  const reorder = (subset: string[]) => {
    const set = new Set(subset);
    const queue = [...subset];
    return saveOrder(all.map((r) => (set.has(r.id) ? queue.shift()! : r.id)));
  };
  const move = (id: string, to: number) => {
    const ids = shown.map((r) => r.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    void reorder(ids);
  };
  const onDrop = (e: DragEvent, target: string) => { e.preventDefault(); if (drag) move(drag.from, shown.findIndex((r) => r.id === target)); setDrag(null); };
  const setState = async (r: Rule, on: boolean) => {
    try {
      await api(`${v2(pid)}/targeting_rules/${r.id}`, { method: "POST", json: { state: on ? "active" : "inactive" } }); await refresh();
      const phase = phaseOf({ ...r, state: "active" });
      toast(!on ? "Rule turned off" : phase === "scheduled" ? "Rule scheduled" : phase === "inactive" ? "Rule turned on, but its end date has passed: edit the dates to use it" : "Rule is live");
    }
    catch (e) { toast(errMsg(e)); }
  };
  const duplicate = async (r: Rule) => {
    try {
      await api(`${v2(pid)}/targeting_rules`, { method: "POST", json: { name: `${r.name} (copy)`.slice(0, 256), audience_id: r.audience_id, offering_id: r.offering_id, placements: r.placements, state: "inactive", starts_at: r.starts_at, ends_at: r.ends_at } });
      await refresh(); toast("Copied. The copy is off, in Inactive.");
    } catch (e) { toast(errMsg(e)); }
  };
  const ruleMenu = (r: Rule, i: number): (MenuItem | "-")[] => [
    { label: "Edit", icon: "edit", onSelect: () => setDialog(<RuleDialog pid={pid} existing={r} audiences={auds.data ?? []} offerings={offs.data ?? []} onClose={close} />) },
    { label: r.state === "active" ? "Turn off" : "Turn on", icon: r.state === "active" ? "archive" : "refresh", onSelect: () => void setState(r, r.state !== "active") },
    { label: "Move up", icon: "up", disabled: i === 0, onSelect: () => move(r.id, i - 1) },
    { label: "Move down", icon: "down", disabled: i === shown.length - 1, onSelect: () => move(r.id, i + 1) },
    { label: "Duplicate", icon: "duplicate", onSelect: () => void duplicate(r) },
    "-", { label: "Delete", icon: "trash", danger: true, onSelect: () => setDialog(<ConfirmDialog title="Delete this rule?" confirmLabel="Delete rule" danger onClose={close} onConfirm={async () => { await api(`${v2(pid)}/targeting_rules/${r.id}`, { method: "DELETE" }); await refresh(); toast("Rule deleted"); }}><p>Customers it matched get the next matching rule, or the default offering.</p></ConfirmDialog>) },
  ];
  const setDefault = (id: string) => {
    const o = offs.data?.find((x) => x.id === id);
    if (!o || o.is_current) return;
    setDialog(<ConfirmDialog title={`Make ${o.lookup_key} the default offering?`} confirmLabel="Make default" onClose={close} onConfirm={async () => {
      await api(`${v2(pid)}/offerings/${o.id}`, { method: "POST", json: { is_current: true } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["offering-list", pid] }), qc.invalidateQueries({ queryKey: ["catalog", pid] }), qc.invalidateQueries({ queryKey: ["offering-list-full", pid] })]);
      toast(`${o.lookup_key} is the default offering`);
    }}><p>Customers who match no live rule (and are in no experiment) see it from their next offerings request. It is also the project's current offering in Product catalog.</p></ConfirmDialog>);
  };
  const schedule = (r: Rule) => [r.starts_at ? `${r.starts_at > now ? "Starts" : "Started"} ${fmt.dateTime(r.starts_at)}` : null, r.ends_at ? `${r.ends_at > now ? "ends" : "ended"} ${fmt.dateTime(r.ends_at)}` : null].filter(Boolean).join(", ");
  const empty: Record<Phase, string> = {
    live: "No live rules: everyone sees the default offering below. Add a rule to show another offering to an audience, or per placement.",
    scheduled: "No scheduled rules. A rule that is on with a start date ahead waits here until it starts.",
    inactive: "No inactive rules. Rules you turn off, and rules past their end date, wait here.",
  };
  const newRule = () => setDialog(<RuleDialog pid={pid} audiences={auds.data ?? []} offerings={offs.data ?? []} onClose={close} />);

  return (
    <Shell title="Targeting">
      <div className="page">
        <PageHead title="Targeting" sub="Show different offerings to different customers without an app release. Rules are checked from top to bottom; the first live rule that matches decides."
          actions={!canEdit ? undefined : tab !== "audiences"
            ? <Menu label="New rule" text="New rule" variant="dark" items={[
                { label: "Create from scratch", icon: "plus", disabled: !offs.data?.length, hint: offs.data?.length ? undefined : "Create an offering first", onSelect: newRule },
                { label: "Create with RevenueDot AI", icon: "spark", disabled: !aiOk || !offs.data?.length, hint: ai.data && !aiOk ? ai.data.reason ?? "RevenueDot AI is not available here." : undefined, onSelect: () => setDialog(<AskDialog pid={pid} kind="targeting rule" onClose={close} />) },
              ]} />
            : <button type="button" className="btn btn-dark" onClick={() => setDialog(<AudienceDialog pid={pid} onClose={close} onSaved={() => refresh()} />)}><Icon name="plus" />New audience</button>} />
        <Tabs label="Targeting" idBase="targeting" value={tab} onChange={setTab} tabs={[
          { value: "live", label: rules.data ? `Live · ${byPhase.live.length}` : "Live" }, { value: "scheduled", label: rules.data ? `Scheduled · ${byPhase.scheduled.length}` : "Scheduled" },
          { value: "inactive", label: rules.data ? `Inactive · ${byPhase.inactive.length}` : "Inactive" }, { value: "audiences", label: "Audiences" },
        ]} />
        {tab !== "audiences" ? (rules.isError || offs.isError ? <div className="banner err" role="alert">{errMsg(rules.error ?? offs.error)}</div> : rules.isLoading || offs.isLoading ? <div className="panel pb subtle">Loading…</div> : (
          <div role="tabpanel" id={`targeting-${tab}-panel`} aria-labelledby={`targeting-${tab}`} className="tg-stack">
            {!shown.length ? <EmptyState title={`No ${tab} rules`} text={offs.data?.length ? empty[tab] : "Create an offering first."} /> : (
              <ol className="tg-list">
                {shown.map((r, i) => {
                  const pls = Object.entries(r.placements);
                  return (
                    <li key={r.id} className={`tg-card${drag?.from === r.id ? " dragging" : ""}${drag?.over === r.id && drag.from !== r.id ? " over" : ""}`} aria-label={`Rule ${r.name}`}
                      onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== r.id) setDrag({ ...drag, over: r.id }); } }} onDrop={(e) => onDrop(e, r.id)}>
                      <div className="tg-card-h">
                        {canEdit && <button type="button" className="ib grip" draggable aria-label={`Move ${r.name}. Use the up and down arrow keys.`} title="Drag to reorder" data-grip={r.id}
                          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); setDrag({ from: r.id, over: null }); }}
                          onDragEnd={() => setDrag(null)}
                          onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(r.id, i + (e.key === "ArrowUp" ? -1 : 1)); requestAnimationFrame(() => (document.querySelector(`[data-grip="${r.id}"]`) as HTMLElement | null)?.focus()); } }}>
                          <Icon name="grip" />
                        </button>}
                        <span className="pos mono">{i + 1}</span>
                        <b className="tg-name">{r.name}</b>
                        {schedule(r) && <span className="subtle tg-when">{schedule(r)}</span>}
                        <Tag tone={tab === "live" ? "up" : tab === "scheduled" ? "info" : "muted"}>{tab === "live" ? "Live" : tab === "scheduled" ? "Scheduled" : r.state === "active" ? "Ended" : "Off"}</Tag>
                        {canEdit && <Menu label={`Actions for ${r.name}`} items={ruleMenu(r, i)} />}
                      </div>
                      <div className="tg-card-b">
                        <p>If customer matches <b>{audName(r.audience_id)}</b> then show</p>
                        <ul>
                          {pls.map(([p, o]) => <li key={p}>{o ? <code>{offKey(o)}</code> : <b>no paywall</b>} for <code>{p}</code></li>)}
                          <li><code>{offKey(r.offering_id)}</code> for {pls.length ? "all other cases" : "every placement"}</li>
                        </ul>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            {tab === "live" && offs.data?.length ? (
              <section className="panel tg-default" aria-labelledby="tg-default">
                <div className="ph"><b id="tg-default">Default offering</b></div>
                <div className="pb">
                  <Field label="Select default offering" htmlFor="tg-default-off" hint="Show the selected offering to customers who don't match any of the rules above.">
                    <select id="tg-default-off" className="select" value={current?.id ?? ""} disabled={!canEdit} onChange={(e) => setDefault(e.target.value)}>
                      {!current && <option value="" disabled>Choose an offering</option>}
                      {offs.data.filter((o) => o.state !== "inactive" || o.is_current).map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.lookup_key})</option>)}
                    </select>
                  </Field>
                </div>
              </section>
            ) : null}
          </div>
        )) : (auds.isError ? <div className="banner err" role="alert">{errMsg(auds.error)}</div> : auds.isLoading ? <div className="panel pb subtle">Loading…</div> : !auds.data?.length ? (
          <EmptyState title="No audiences" text="An audience is a set of conditions on customers, such as country, app version, subscription status or a custom attribute." />
        ) : (
          <DataTable rowKey={(a) => a.id} rows={auds.data} columns={[
            { key: "name", header: "Audience", render: (a) => a.name },
            { key: "rules", header: "Conditions", render: (a) => <span className="subtle">{describeRules(a.rules)}</span> },
            { key: "menu", header: "", align: "right", render: (a) => canEdit && <Menu label={`Actions for ${a.name}`} items={[
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
