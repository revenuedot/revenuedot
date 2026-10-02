/**
 * Experiments list (prd/experiments/PRD.md §5): /projects/:projectId/experiments. Empty state with the six starter
 * categories; "New experiment" menu (from scratch, with RevenueDot AI, by type); draft, running and paused experiments in
 * enrollment order with drag (or arrow keys on the handle, or Move up / Move down) to change priority; stopped ones below.
 */
import { useState, type DragEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { EXPERIMENT_TYPES } from "@revenuedot/core";
import { api, fmt } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { DataTable, Dialog, Menu, PageHead, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { errMsg, v2 } from "../catalog/lib";
import { useAiStatus } from "../ai/data";
import { askAssistant, STATUS_TONE, statusLabel, typeName, useExperiments, useOfferingsFull, type Experiment } from "./lib";

const STARTERS = EXPERIMENT_TYPES.filter((t) => t.id !== "other");
const ICONS: Record<string, string> = { introductory_offer: "dollar", free_trial_offer: "hourglass", paywall_design: "paywalls", price_point: "dollar", subscription_duration: "refresh", subscription_ordering: "updown" };

export function ExperimentsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useExperiments(pid);
  const offs = useOfferingsFull(pid);
  const ai = useAiStatus(pid);
  const [askOpen, setAskOpen] = useState(false);
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  const all = q.data ?? [];
  const open = all.filter((x) => x.status !== "stopped").sort((a, b) => a.priority - b.priority || a.created_at - b.created_at);
  const stopped = all.filter((x) => x.status === "stopped").sort((a, b) => (b.stopped_at ?? 0) - (a.stopped_at ?? 0));
  const offName = (id: string) => offs.data?.find((o) => o.id === id)?.lookup_key ?? "deleted offering";
  const aiOk = !!ai.data?.available && !!ai.data?.can_write;
  const aiHint = ai.data && !aiOk ? (ai.data.reason ?? (ai.data.available ? "RevenueDot AI can only read in this project." : "RevenueDot AI is not set up on this server.")) : undefined;

  const reorder = async (ids: string[]) => {
    qc.setQueryData<Experiment[]>(["experiments", pid], (xs) => xs?.map((x) => ({ ...x, priority: ids.indexOf(x.id) >= 0 ? ids.indexOf(x.id) + 1 : x.priority })));
    try { await api(`${v2(pid)}/experiments/actions/reorder`, { method: "POST", json: { experiment_ids: ids } }); toast("Enrollment order saved"); }
    catch (e) { toast(errMsg(e)); }
    await qc.invalidateQueries({ queryKey: ["experiments", pid] });
  };
  const move = (id: string, to: number) => {
    const ids = open.map((x) => x.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    void reorder(ids);
  };
  const onDrop = (e: DragEvent, target: string) => { e.preventDefault(); if (drag) move(drag.from, open.findIndex((x) => x.id === target)); setDrag(null); };
  const newItems: (MenuItem | "-")[] = [
    { label: "Create from scratch", icon: "plus", onSelect: () => nav(`/projects/${pid}/experiments/new`) },
    { label: "Create with RevenueDot AI", icon: "spark", disabled: !aiOk, hint: aiHint, onSelect: () => setAskOpen(true) },
    "-",
    ...STARTERS.map((t) => ({ label: t.name, icon: ICONS[t.id], onSelect: () => nav(`/projects/${pid}/experiments/new?type=${t.id}`) })),
  ];
  const variantsText = (x: Experiment) => x.variants.map((v) => offName(v.offering_id)).join(" vs ");

  return (
    <Shell title="Experiments">
      <div className="page">
        <PageHead title="Experiments" sub="Test offerings, prices, trials and paywalls against each other. Each customer always sees the same variant; results compare conversion, revenue and retention with 95% intervals."
          actions={<Menu label="New experiment" text="New experiment" primary items={newItems} />} />
        {q.isLoading ? <div className="panel pb subtle">Loading…</div> : q.isError ? <div className="banner err" role="alert">{errMsg(q.error)}</div> : !all.length ? (
          <section className="panel xp-empty">
            <div className="pb">
              <h2>Start with a proven test</h2>
              <p className="section-sub">Pick what to test. RevenueDot fills in the metrics and helps you make the treatment offering from the one you have.</p>
              <div className="xp-cats">
                {STARTERS.map((t) => (
                  <Link key={t.id} className="card xp-cat" to={`/projects/${pid}/experiments/new?type=${t.id}`}>
                    <span className="card-h"><Icon name={ICONS[t.id] ?? "experiments"} /><b>{t.name}</b><Icon name="arrow" /></span>
                    <p>{t.hint}</p>
                  </Link>
                ))}
              </div>
              <div className="xp-row">
                <Link className="btn btn-line" to={`/projects/${pid}/experiments/new`}><Icon name="plus" />Start from scratch</Link>
                <button type="button" className="btn btn-line" disabled={!aiOk} title={aiHint} onClick={() => setAskOpen(true)}><Icon name="spark" className="i gold" />Create with RevenueDot AI</button>
              </div>
            </div>
          </section>
        ) : (
          <>
            {open.length > 0 && (
              <section className="panel" aria-labelledby="xp-order">
                <div className="ph"><b id="xp-order">Enrollment order</b><span className="link subtle">A customer joins the first running experiment that accepts them</span></div>
                <ol className="xp-list">
                  {open.map((x, i) => (
                    <li key={x.id} className={`xp-item${drag?.from === x.id ? " dragging" : ""}${drag?.over === x.id && drag.from !== x.id ? " over" : ""}`}
                      onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== x.id) setDrag({ ...drag, over: x.id }); } }} onDrop={(e) => onDrop(e, x.id)}>
                      <button type="button" className="ib grip" draggable aria-label={`Priority of ${x.name}: ${i + 1}. Use the up and down arrow keys to move it.`} title="Drag to change the enrollment order" data-grip={x.id}
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", x.id); setDrag({ from: x.id, over: null }); }}
                        onDragEnd={() => setDrag(null)}
                        onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(x.id, i + (e.key === "ArrowUp" ? -1 : 1)); requestAnimationFrame(() => (document.querySelector(`[data-grip="${x.id}"]`) as HTMLElement | null)?.focus()); } }}>
                        <Icon name="grip" />
                      </button>
                      <span className="pos mono">{i + 1}</span>
                      <Link className="xp-item-main" to={`/projects/${pid}/experiments/${x.id}`}>
                        <b>{x.name}</b>
                        <small>{typeName(x.type)} · <code>{variantsText(x)}</code> · {x.enrollment === "new" ? "new customers" : "new and existing"} · {x.enrollment_percent}%</small>
                      </Link>
                      <span className="mono xp-count" title="Enrolled customers">{fmt.int(x.enrolled_customers ?? 0)}</span>
                      <Tag tone={STATUS_TONE[x.status]}>{statusLabel(x.status)}</Tag>
                      <Menu label={`Actions for ${x.name}`} items={[
                        { label: "Open", icon: "arrow", onSelect: () => nav(`/projects/${pid}/experiments/${x.id}`) },
                        { label: "Edit", icon: "edit", onSelect: () => nav(`/projects/${pid}/experiments/${x.id}/edit`) },
                        { label: "Move up", icon: "up", disabled: i === 0, onSelect: () => move(x.id, i - 1) },
                        { label: "Move down", icon: "down", disabled: i === open.length - 1, onSelect: () => move(x.id, i + 1) },
                      ]} />
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {stopped.length > 0 && (
              <section aria-label="Stopped experiments">
                <h2 className="xp-h2">Stopped</h2>
                <DataTable rowKey={(x) => x.id} rows={stopped} onRowClick={(x) => nav(`/projects/${pid}/experiments/${x.id}`)} columns={[
                  { key: "name", header: "Experiment", render: (x) => x.name },
                  { key: "type", header: "Type", render: (x) => typeName(x.type) },
                  { key: "v", header: "Offerings", render: (x) => <code>{variantsText(x)}</code> },
                  { key: "n", header: "Customers", align: "right", render: (x) => fmt.int(x.enrolled_customers ?? 0) },
                  { key: "d", header: "Ran", render: (x) => `${fmt.date(x.started_at)} – ${fmt.date(x.stopped_at)}` },
                ]} />
              </section>
            )}
          </>
        )}
      </div>
      {askOpen && <AskDialog pid={pid} kind="experiment" onClose={() => setAskOpen(false)} />}
    </Shell>
  );
}

const EXAMPLES: Record<"experiment" | "targeting rule", string[]> = {
  experiment: ["Test a 14-day free trial against our 7-day trial", "Test showing the annual plan first", "Test a higher monthly price for new customers in the US"],
  "targeting rule": ["Show the promo offering to customers in Germany", "Show the onboarding offering at the onboarding_end placement for new customers", "Show a win-back offering to customers whose subscription expired"],
};

/** "Create with RevenueDot AI": what to test, in words; RevenueDot AI drafts it and asks before saving. */
export function AskDialog({ pid, kind, onClose }: { pid: string; kind: "experiment" | "targeting rule"; onClose: () => void }) {
  const nav = useNavigate();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) { setErr(`Say what the ${kind} should do.`); return; }
    setBusy(true);
    try {
      const ask = kind === "experiment"
        ? `Draft an experiment (save it as a draft, do not start it): ${text.trim()}`
        : `Draft a targeting rule (create it turned off): ${text.trim()}`;
      await askAssistant(pid, ask, nav);
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <Dialog title={`Create ${kind === "experiment" ? "an experiment" : "a targeting rule"} with RevenueDot AI`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="ask-form" className="btn btn-dark" disabled={busy}><Icon name="spark" />{busy ? "Opening…" : "Draft it"}</button>
    </>}>
      <form id="ask-form" onSubmit={submit} noValidate className="xp-stack">
        <label className="label" htmlFor="ask-text">{kind === "experiment" ? "What do you want to test?" : "Who should see which offering?"}</label>
        <textarea id="ask-text" className="textarea" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        <div className="chips">{EXAMPLES[kind].map((x) => <button key={x} type="button" className="chip xp-ex" onClick={() => setText(x)}>{x}</button>)}</div>
        <p className="subtle">RevenueDot AI reads your offerings and prepares the {kind}. You approve it before anything is saved, and it {kind === "experiment" ? "stays a draft until you start it" : "stays off until you turn it on"}.</p>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
