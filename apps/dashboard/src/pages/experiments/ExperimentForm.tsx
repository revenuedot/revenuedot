/**
 * Create and edit an experiment (prd/experiments/PRD.md §3): /projects/:projectId/experiments/new[?type=…] and
 * /experiments/:experimentId/edit. Details (name, type, metrics, notes with a preview), variants (control plus up to
 * three treatments, an offering and placement offerings each, Import from targeting, Add placement, Duplicate the
 * control offering), enrollment (new or new and existing customers, paywall view tracking), audience (everyone, saved,
 * custom conditions) and share, a live 7-day estimate, then Save as draft or Start experiment.
 * A running, paused or stopped experiment opens the same page with only name, type, metrics, notes and share editable.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EXPERIMENT_METRICS, EXPERIMENT_TYPES, MAX_VARIANTS, PLACEMENT_ID, PRIMARY_METRIC_IDS, TYPE_DEFAULTS, VARIANT_IDS, variantDefaultName, variantSignature, type ExperimentType } from "@revenuedot/core";
import { api } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { Check, Field, Menu, PageHead, Tabs, useProjectId, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { ConditionBuilder, describeRules, fromRules, incomplete, toRules, type Groups } from "../../components/conditions";
import { errMsg, v2, type Offering } from "../catalog/lib";
import { DuplicateOfferingDialog } from "./DuplicateOffering";
import { Markdown } from "./Markdown";
import { TREATMENT_HELP, metric, typeName, useAudiences, useOfferingsFull, useRules, type Experiment } from "./lib";

interface VariantDraft { name: string; offering: string; placements: Record<string, string> }
/** "" in a placement means "no paywall" (null in the API). */
const NONE = "";

export function ExperimentFormPage() {
  const pid = useProjectId();
  const { experimentId } = useParams();
  const [params] = useSearchParams();
  const existing = useQuery({ queryKey: ["experiment", pid, experimentId], enabled: !!experimentId, queryFn: () => api<Experiment>(`${v2(pid)}/experiments/${experimentId}`) });
  const offs = useOfferingsFull(pid);
  const auds = useAudiences(pid);
  const rules = useRules(pid);
  const ready = offs.data && auds.data && rules.data && (!experimentId || existing.data);
  const title = experimentId ? `Edit ${existing.data?.name ?? "experiment"}` : "New experiment";
  return (
    <Shell title={title} crumbs={<><Link className="cat-crumb-up" to={`/projects/${pid}/experiments`}>Experiments</Link> <span className="cat-crumb-up">/</span> <b className="cat-crumb">{experimentId ? existing.data?.name ?? "" : "New"}</b></>}>
      <div className="page xp-form">
        {!ready ? (existing.isError ? <div className="banner err" role="alert">{errMsg(existing.error)}</div> : <div className="panel pb subtle">Loading…</div>)
          : <Form key={experimentId ?? params.get("type") ?? "new"} pid={pid} existing={existing.data} offerings={offs.data!} startType={params.get("type")} />}
      </div>
    </Shell>
  );
}

function Form({ pid, existing, offerings, startType }: { pid: string; existing?: Experiment; offerings: Offering[]; startType: string | null }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const auds = useAudiences(pid).data ?? [];
  const rules = useRules(pid).data ?? [];
  const locked = !!existing && existing.status !== "draft";
  const initialType = (existing?.type ?? (EXPERIMENT_TYPES.some((t) => t.id === startType) ? startType : "other")) as ExperimentType;
  const current = offerings.find((o) => o.is_current) ?? offerings[0];

  const [name, setName] = useState(existing?.name ?? (startType && initialType !== "other" ? `${typeName(initialType)} test` : ""));
  const [type, setType] = useState<ExperimentType>(initialType);
  const [primary, setPrimary] = useState(existing?.primary_metric ?? TYPE_DEFAULTS[initialType].primary);
  const [secondary, setSecondary] = useState<string[]>(existing?.secondary_metrics ?? TYPE_DEFAULTS[initialType].secondary);
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [notesTab, setNotesTab] = useState<"write" | "preview">("write");
  const [placementKeys, setPlacementKeys] = useState<string[]>(() => [...new Set((existing?.variants ?? []).flatMap((v) => Object.keys(v.placements)))]);
  const [variants, setVariants] = useState<VariantDraft[]>(() => existing
    ? existing.variants.map((v) => ({ name: v.name, offering: v.offering_id, placements: Object.fromEntries(Object.entries(v.placements).map(([k, o]) => [k, o ?? NONE])) }))
    : [{ name: variantDefaultName("a"), offering: current?.id ?? "", placements: {} }, { name: variantDefaultName("b"), offering: "", placements: {} }]);
  const [enrollment, setEnrollment] = useState<"new" | "new_and_existing">(existing?.enrollment ?? "new");
  const [track, setTrack] = useState(existing?.track_paywall_views ?? false);
  const [audMode, setAudMode] = useState<"everyone" | "saved" | "custom">(existing?.audience_rules ? "custom" : existing?.audience_id ? "saved" : "everyone");
  const [audienceId, setAudienceId] = useState(existing?.audience_id ?? auds[0]?.id ?? "");
  const [groups, setGroups] = useState<Groups>(existing?.audience_rules ? fromRules(existing.audience_rules) : [[{ field: "country", operator: "isAnyOf", value: "" }]]);
  const [pct, setPct] = useState(String(existing?.enrollment_percent ?? 100));
  const [dup, setDup] = useState<number | null>(null);
  const [newPlacement, setNewPlacement] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<"draft" | "start" | null>(null);

  const offName = (id: string) => offerings.find((o) => o.id === id)?.lookup_key ?? id;
  const changeType = (t: ExperimentType) => {
    setType(t);
    // Metrics follow the type until the user picks their own.
    const was = TYPE_DEFAULTS[type];
    if (primary === was.primary) setPrimary(TYPE_DEFAULTS[t].primary);
    if (JSON.stringify(secondary) === JSON.stringify(was.secondary)) setSecondary(TYPE_DEFAULTS[t].secondary);
  };
  const setVariant = (i: number, patch: Partial<VariantDraft>) => {
    setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
    // A changed variant may now be valid: drop its errors until the next save.
    setErrors((e) => (e[`v${i}`] || e[`vn${i}`] ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== `v${i}` && k !== `vn${i}`)) : e));
  };
  const addVariant = () => {
    const id = VARIANT_IDS[variants.length]!;
    setVariants([...variants, { name: variantDefaultName(id), offering: "", placements: Object.fromEntries(placementKeys.map((k) => [k, variants[0]!.placements[k] ?? NONE])) }]);
  };
  const removeVariant = (i: number) => setVariants(variants.filter((_, j) => j !== i).map((v, j) => ({ ...v, name: v.name === variantDefaultName(VARIANT_IDS[j >= i ? j + 1 : j]!) ? variantDefaultName(VARIANT_IDS[j]!) : v.name })));
  const addPlacement = (key: string) => {
    setPlacementKeys([...placementKeys, key]);
    setVariants(variants.map((v) => ({ ...v, placements: { ...v.placements, [key]: v.offering } })));
  };
  const removePlacement = (key: string) => {
    setPlacementKeys(placementKeys.filter((k) => k !== key));
    setVariants(variants.map((v) => { const p = { ...v.placements }; delete p[key]; return { ...v, placements: p }; }));
  };
  const importRule = (ruleId: string) => {
    const r = rules.find((x) => x.id === ruleId);
    if (!r) return;
    const keys = Object.keys(r.placements);
    setPlacementKeys(keys);
    setVariants(variants.map((v, i) => ({ ...v, offering: i === 0 ? r.offering_id : v.offering || r.offering_id, placements: Object.fromEntries(keys.map((k) => [k, r.placements[k] ?? NONE])) })));
    toast(`Imported "${r.name}": its offering and ${keys.length} placement${keys.length === 1 ? "" : "s"}. Change the treatments' offerings.`);
  };

  const audienceRules = audMode === "custom" ? toRules(groups) : null;
  const estimateBody = useMemo(() => ({
    audience_id: audMode === "saved" && audienceId ? audienceId : null, audience_rules: audMode === "custom" && !incomplete(groups) && audienceRules?.groups.length ? audienceRules : null,
    enrollment, enrollment_percent: Math.min(100, Math.max(1, Number(pct) || 100)), variant_count: variants.length,
  }), [audMode, audienceId, groups, enrollment, pct, variants.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [debounced, setDebounced] = useState(estimateBody);
  useEffect(() => { const t = setTimeout(() => setDebounced(estimateBody), 350); return () => clearTimeout(t); }, [estimateBody]);
  const estimate = useQuery({
    queryKey: ["experiment-estimate", pid, debounced], enabled: !locked,
    queryFn: () => api<{ matching_customers: number; enrolled_customers: number; customers_per_variant: number; is_approximate: boolean }>(`${v2(pid)}/experiments/actions/estimate`, { method: "POST", json: debounced }),
  });

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Name the experiment.";
    if (!locked) {
      variants.forEach((v, i) => {
        if (!v.offering) e[`v${i}`] = i === 0 ? "Pick the offering customers see today." : "Pick an offering, or create one from the control.";
        if (!v.name.trim()) e[`vn${i}`] = "Name the variant.";
      });
      const seen = new Map<string, number>();
      variants.forEach((v, i) => {
        if (!v.offering) return;
        const sig = variantSignature({ offering_id: v.offering, placements: Object.fromEntries(Object.entries(v.placements).map(([k, o]) => [k, o || null])) });
        if (seen.has(sig) && !e[`v${i}`]) e[`v${i}`] = `Same offering and placements as ${variants[seen.get(sig)!]!.name}. Change the offering or a placement.`;
        seen.set(sig, i);
      });
      if (audMode === "saved" && !audienceId) e.audience = "Pick a saved audience, or choose Everyone.";
      if (audMode === "custom" && (!groups.length || incomplete(groups))) e.audience = "Fill in every condition's value, or remove the condition.";
    }
    const n = Number(pct);
    if (!Number.isInteger(n) || n < 1 || n > 100) e.pct = "A whole percentage from 1 to 100.";
    return e;
  }

  async function save(mode: "draft" | "start") {
    const e = validate();
    setErrors(e); setBanner(null);
    // Focus the first highlighted field once React has drawn the errors.
    if (Object.keys(e).length) { setBanner("Fix the highlighted fields."); requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus()); return; }
    setBusy(mode);
    const live = { name: name.trim(), type, primary_metric: primary, secondary_metrics: secondary.filter((m) => m !== primary), notes, enrollment_percent: Number(pct) };
    const json = locked ? live : {
      ...live, enrollment, track_paywall_views: enrollment === "new_and_existing" ? true : track,
      audience_id: audMode === "saved" ? audienceId : null, audience_rules: audMode === "custom" ? audienceRules : null,
      variants: variants.map((v) => ({ name: v.name.trim(), offering_id: v.offering, placements: Object.fromEntries(Object.entries(v.placements).map(([k, o]) => [k, o || null])) })),
    };
    let saved: Experiment | null = null;
    try {
      saved = existing ? await api<Experiment>(`${v2(pid)}/experiments/${existing.id}`, { method: "POST", json }) : await api<Experiment>(`${v2(pid)}/experiments`, { method: "POST", json });
      if (mode === "start") await api(`${v2(pid)}/experiments/${saved.id}/actions/start`, { method: "POST" });
      await Promise.all([qc.invalidateQueries({ queryKey: ["experiments", pid] }), qc.invalidateQueries({ queryKey: ["experiment", pid, saved.id] })]);
      toast(mode === "start" ? "Experiment running: customers join from their next offerings request" : existing ? "Experiment saved" : "Draft saved");
      nav(`/projects/${pid}/experiments/${saved.id}`);
    } catch (err) {
      // Saved but not started: open the draft (a retry here would make a second one) and say why it did not start.
      if (saved && !existing) {
        await qc.invalidateQueries({ queryKey: ["experiments", pid] });
        toast(`Saved as a draft, but it did not start: ${errMsg(err)}`);
        nav(`/projects/${pid}/experiments/${saved.id}`, { replace: true });
        return;
      }
      setBanner(errMsg(err)); setBusy(null);
    }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void save("draft"); };

  const metricOptions = EXPERIMENT_METRICS.filter((m) => PRIMARY_METRIC_IDS.includes(m.id));
  return (
    <>
    <form onSubmit={submit} noValidate>
      <PageHead title={existing ? `Edit ${existing.name}` : "New experiment"} sub={locked
        ? "This experiment has started: its variants, enrollment and audience are fixed. Name, type, metrics, notes and the share of customers can still change."
        : "Test offerings against each other. Each customer always sees the same variant, and results compare conversion, revenue and retention."} />

      <section className="panel xp-sec" aria-labelledby="xp-details">
        <div className="ph"><b id="xp-details">Details</b></div>
        <div className="pb xp-stack">
          <div className="xp-grid2">
            <Field label="Name" htmlFor="xp-name" error={errors.name}><input id="xp-name" className="input" value={name} aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} placeholder="Annual plan first" /></Field>
            <Field label="Experiment type" htmlFor="xp-type" hint={EXPERIMENT_TYPES.find((t) => t.id === type)?.hint}>
              <select id="xp-type" className="select" value={type} onChange={(e) => changeType(e.target.value as ExperimentType)}>{EXPERIMENT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </Field>
          </div>
          <Field label="Primary metric" htmlFor="xp-primary" hint={metric(primary).description + " It decides the winner."}>
            <select id="xp-primary" className="select" value={primary} onChange={(e) => setPrimary(e.target.value)}>{metricOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          </Field>
          <fieldset className="xp-fs">
            <legend className="label">Secondary metrics</legend>
            <div className="xp-checks">
              {EXPERIMENT_METRICS.filter((m) => m.id !== primary).map((m) => (
                <Check key={m.id} checked={secondary.includes(m.id)} label={m.name} onChange={(on) => setSecondary(on ? [...secondary, m.id] : secondary.filter((x) => x !== m.id))} />
              ))}
            </div>
          </fieldset>
          <div>
            <Tabs label="Notes" idBase="xp-notes" value={notesTab} onChange={setNotesTab} tabs={[{ value: "write", label: "Notes" }, { value: "preview", label: "Preview" }]} />
            {notesTab === "write"
              ? <div role="tabpanel" id="xp-notes-write-panel" aria-labelledby="xp-notes-write"><textarea id="xp-notes-text" aria-label="Notes" className="textarea xp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={20_000}
                placeholder={"## Hypothesis\nShowing the annual plan first raises realized LTV per customer by 10%, because…\n\n- What we change\n- What we expect"} /></div>
              : <div className="xp-notes-prev" role="tabpanel" id="xp-notes-preview-panel" aria-label="Notes preview">{notes.trim() ? <Markdown text={notes} /> : <p className="subtle">Nothing to preview yet.</p>}</div>}
            <span className="subtle xp-hint">Markdown: headings, lists, **bold**, *italic*, `code` and links.</span>
          </div>
        </div>
      </section>

      <section className="panel xp-sec" aria-labelledby="xp-variants">
        <div className="ph"><b id="xp-variants">Variants</b>
          {!locked && <span className="link xp-tools">
            {rules.length > 0 && <Menu label="Import from targeting" text="Import from targeting" icon="targeting" items={rules.map((r) => ({ label: r.name, onSelect: () => importRule(r.id) }))} />}
            <button type="button" className="btn btn-line" onClick={() => setNewPlacement("")}><Icon name="plus" />Add placement</button>
            <button type="button" className="btn btn-line" disabled={variants.length >= MAX_VARIANTS} onClick={addVariant}><Icon name="plus" />Add variant</button>
          </span>}
        </div>
        <div className="pb xp-stack">
          <p className="section-sub">Customers are split evenly between the variants. Each variant gives the app a current offering and, for each placement, the offering to show there.</p>
          {newPlacement !== null && (
            <div className="xp-newpl">
              <Field label="Placement identifier" htmlFor="xp-newpl" hint="The id your app passes to getCurrentOffering(forPlacement:), such as onboarding_end." error={newPlacement && (!PLACEMENT_ID.test(newPlacement) || placementKeys.includes(newPlacement)) ? (placementKeys.includes(newPlacement) ? "This placement is already listed." : "Letters, digits, dots, dashes or underscores.") : null}>
                <input id="xp-newpl" className="input mono" autoFocus value={newPlacement} onChange={(e) => setNewPlacement(e.target.value.trim())}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (PLACEMENT_ID.test(newPlacement) && !placementKeys.includes(newPlacement)) { addPlacement(newPlacement); setNewPlacement(null); } } if (e.key === "Escape") setNewPlacement(null); }} />
              </Field>
              <div className="xp-row">
                <button type="button" className="btn btn-dark" disabled={!PLACEMENT_ID.test(newPlacement) || placementKeys.includes(newPlacement)} onClick={() => { addPlacement(newPlacement); setNewPlacement(null); }}>Add</button>
                <button type="button" className="btn btn-line" onClick={() => setNewPlacement(null)}>Cancel</button>
              </div>
            </div>
          )}
          <div className={`xp-variants n${variants.length}`}>
            {variants.map((v, i) => (
              <div key={i} className="xp-variant" aria-label={`Variant ${VARIANT_IDS[i]!.toUpperCase()}`} role="group">
                <div className="xp-variant-h">
                  <span className="xp-vid">{VARIANT_IDS[i]!.toUpperCase()}</span>
                  <input aria-label={`Variant ${VARIANT_IDS[i]!.toUpperCase()} name`} className="input" value={v.name} disabled={locked} aria-invalid={!!errors[`vn${i}`]} onChange={(e) => setVariant(i, { name: e.target.value })} />
                  {i >= 2 && !locked && <button type="button" className="ib" aria-label={`Remove variant ${VARIANT_IDS[i]!.toUpperCase()}`} onClick={() => removeVariant(i)}><Icon name="trash" /></button>}
                </div>
                <Field label={i === 0 ? "Offering (control: what customers see today)" : "Offering"} htmlFor={`xp-off-${i}`} error={errors[`v${i}`]}>
                  <select id={`xp-off-${i}`} className="select" value={v.offering} disabled={locked} aria-invalid={!!errors[`v${i}`]}
                    onChange={(e) => { if (e.target.value === "__dup") { setDup(i); return; } setVariant(i, { offering: e.target.value }); }}>
                    <option value="" disabled>Choose an offering</option>
                    {offerings.filter((o) => o.state !== "inactive" || o.id === v.offering).map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.lookup_key}){o.is_current ? " · current" : ""}{o.state === "inactive" ? " · archived" : ""}</option>)}
                    {i > 0 && variants[0]!.offering && <option value="__dup">Duplicate {offName(variants[0]!.offering)}…</option>}
                  </select>
                </Field>
                {i > 0 && !v.offering && !locked && (
                  <div className="xp-create">
                    <p>{TREATMENT_HELP[type]}</p>
                    <button type="button" className="btn btn-dark" disabled={!variants[0]!.offering} onClick={() => setDup(i)}><Icon name="duplicate" />Create offering</button>
                  </div>
                )}
                {placementKeys.map((k) => (
                  <div key={k} className="xp-pl">
                    <label htmlFor={`xp-pl-${i}-${k}`} className="xp-pl-k"><code>{k}</code></label>
                    <select id={`xp-pl-${i}-${k}`} aria-label={`Variant ${VARIANT_IDS[i]!.toUpperCase()} placement ${k}`} className="select" value={v.placements[k] ?? NONE} disabled={locked}
                      onChange={(e) => setVariant(i, { placements: { ...v.placements, [k]: e.target.value } })}>
                      <option value={NONE}>No paywall</option>
                      {offerings.filter((o) => o.state !== "inactive" || o.id === v.placements[k]).map((o) => <option key={o.id} value={o.id}>{o.lookup_key}</option>)}
                    </select>
                    {i === 0 && !locked && <button type="button" className="ib" aria-label={`Remove placement ${k}`} onClick={() => removePlacement(k)}><Icon name="trash" /></button>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel xp-sec" aria-labelledby="xp-enroll">
        <div className="ph"><b id="xp-enroll">Enrollment</b></div>
        <div className="pb xp-stack">
          <div className="choice" role="group" aria-label="Who can join">
            <button type="button" aria-pressed={enrollment === "new"} disabled={locked} onClick={() => setEnrollment("new")}>
              <Icon name="userplus" /><span><b>New customers</b><small>Customers first seen after the experiment starts. Best for paywalls people meet in onboarding.</small></span>
            </button>
            <button type="button" aria-pressed={enrollment === "new_and_existing"} disabled={locked} onClick={() => { setEnrollment("new_and_existing"); setTrack(true); }}>
              <Icon name="customers" /><span><b>New and existing customers</b><small>Anyone who asks for offerings while it runs. Results count customers from their first paywall view.</small></span>
            </button>
          </div>
          <Check checked={enrollment === "new_and_existing" || track} disabled={locked || enrollment === "new_and_existing"} onChange={setTrack} label="Track paywall views for better analysis"
            hint={enrollment === "new_and_existing" ? "Required for new and existing customers." : "RevenueDot paywalls report views on their own; custom paywalls call trackCustomPaywallImpression. Results can then show only customers who saw a paywall."} />
        </div>
      </section>

      <section className="panel xp-sec" aria-labelledby="xp-aud">
        <div className="ph"><b id="xp-aud">Audience</b></div>
        <div className="pb xp-stack">
          <div className="radio-row" role="radiogroup" aria-label="Audience">
            {([["everyone", "Everyone"], ["saved", "Saved audience"], ["custom", "Custom filters"]] as const).map(([v, l]) => (
              <label key={v}><input type="radio" name="xp-aud" value={v} checked={audMode === v} disabled={locked} onChange={() => setAudMode(v)} />{l}</label>
            ))}
          </div>
          {audMode === "saved" && (auds.length
            ? <Field label="Saved audience" htmlFor="xp-aud-id" error={errors.audience} hint={describeRules(auds.find((a) => a.id === audienceId)?.rules)}>
                <select id="xp-aud-id" className="select" value={audienceId} disabled={locked} onChange={(e) => setAudienceId(e.target.value)}>{auds.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              </Field>
            : <p className="subtle">No saved audiences yet. Make one in <Link className="ul" to={`/projects/${pid}/targeting`}>Targeting → Audiences</Link>, or use custom filters.</p>)}
          {audMode === "custom" && (locked ? <p className="subtle">{describeRules(audienceRules)}</p> : <ConditionBuilder value={groups} onChange={setGroups} />)}
          {audMode === "custom" && errors.audience && <span className="err" role="alert">{errors.audience}</span>}
          <div className="xp-grid2">
            <Field label="Audience percentage" htmlFor="xp-pct" error={errors.pct} hint="The share of matching customers who join. The rest see the usual offering.">
              <input id="xp-pct" className="input" inputMode="numeric" value={pct} aria-invalid={!!errors.pct} onChange={(e) => setPct(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} />
            </Field>
            {!locked && (
              <div className="xp-est" aria-live="polite">
                <div><span className="label">Matching customers (last 7 days)</span><b className="mono" data-testid="xp-est-matching">{estimate.data ? `${estimate.data.is_approximate ? "≈ " : ""}${estimate.data.matching_customers.toLocaleString("en-US")}` : "…"}</b></div>
                <div><span className="label">Customers per variant (last 7 days)</span><b className="mono" data-testid="xp-est-per">{estimate.data ? estimate.data.customers_per_variant.toLocaleString("en-US") : "…"}</b></div>
              </div>
            )}
          </div>
          {!locked && <p className="subtle xp-note"><Icon name="up" /> New experiments start at the lowest enrollment priority. When several experiments could take the same customer, the one highest on the Experiments list enrolls them; drag the list to reorder.</p>}
        </div>
      </section>

      {banner && <div className="banner err" role="alert">{banner}</div>}
      <div className="xp-foot">
        <Link className="btn btn-ghost" to={existing ? `/projects/${pid}/experiments/${existing.id}` : `/projects/${pid}/experiments`}>Cancel</Link>
        <span />
        <button type="submit" className="btn btn-line" disabled={!!busy}>{busy === "draft" ? "Saving…" : locked ? "Save changes" : "Save as draft"}</button>
        {(!existing || existing.status === "draft") && <button type="button" className="btn btn-dark" disabled={!!busy} onClick={() => void save("start")}>{busy === "start" ? "Starting…" : "Start experiment"}</button>}
      </div>
    </form>

      {dup !== null && variants[0]!.offering && offerings.find((o) => o.id === variants[0]!.offering) && (
        <DuplicateOfferingDialog pid={pid} type={type} source={offerings.find((o) => o.id === variants[0]!.offering)!} taken={offerings.map((o) => o.lookup_key)}
          onClose={() => setDup(null)} onCreated={(o) => { setVariant(dup, { offering: o.id, placements: Object.fromEntries(placementKeys.map((k) => [k, variants[dup]!.placements[k] || o.id])) }); setDup(null); toast(`Created ${o.lookup_key}`); }} />
      )}
    </>
  );
}
