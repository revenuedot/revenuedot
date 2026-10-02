/**
 * Lifecycle / Customer Center: /projects/:projectId/lifecycle/customer-center?tab=configuration|appearance|localization
 * The editor for the configuration the SDK's Customer Center loads (prd/customer-center/PRD.md). Configuration: the support
 * email and display switches, then both screens ("Customers with active subscriptions" = MANAGEMENT, "without" =
 * NO_ACTIVE) with their ordered paths; selecting a path opens its settings (button text and translations, URL and open
 * method, action identifier, feedback survey, promotional offers). Appearance: five colours per light and dark mode.
 * Localization: custom strings per language over the built-in ones. Preview renders the SDK shape the server would send;
 * Save changes stores the whole document, Reset configuration goes back to the default.
 * API: GET/POST /v2/projects/{id}/customer_center_config, GET /retention_offers (offers a path can reference).
 */
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CC_PATH_INFO, CC_PATH_TYPES, CC_REPEATABLE_PATHS, CC_DEFAULT_SURVEY, newCcId, newCcPath, validateCustomerCenter,
  type CcConfig, type CcPath, type CcPathType, type CcScreen,
} from "@revenuedot/core/customer-center";
import { api, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { Check, ConfirmDialog, Field, Menu, PageHead, Panel, Segmented, Tabs, Tag, useProjectId, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { errMsg, v2 } from "../catalog/lib";
import type { RetentionOffer } from "./lib";
import { AppearanceTab, LocalizationTab, OfferPicker, PreviewDialog, TranslateButton } from "./CustomerCenterParts";

type Tab = "configuration" | "appearance" | "localization";
type ScreenKey = "MANAGEMENT" | "NO_ACTIVE";
interface Resp { customer_center: Record<string, unknown>; config: CcConfig; overrides: Record<string, unknown> | null }
const SCREENS: { key: ScreenKey; title: string; sub: string }[] = [
  { key: "MANAGEMENT", title: "Customers with active subscriptions", sub: "Shown when the customer has an active subscription or purchase." },
  { key: "NO_ACTIVE", title: "Customers without active subscriptions", sub: "Shown when the customer has nothing active, for example after a reinstall." },
];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const print = (c: CcConfig | null) => JSON.stringify(c);
export const pathLabel = (t: string) => CC_PATH_INFO[t as CcPathType]?.label ?? t;

export function CustomerCenterPage() {
  const pid = useProjectId();
  const toast = useToast();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get("tab") === "appearance" || sp.get("tab") === "localization" ? (sp.get("tab") as Tab) : "configuration";
  const go = (t: Tab) => { const n = new URLSearchParams(sp); n.set("tab", t); setSp(n, { replace: true }); };
  const q = useQuery({ queryKey: ["customer-center", pid], queryFn: () => api<Resp>(`${v2(pid)}/customer_center_config`), enabled: !!pid });
  const offersQ = useQuery({ queryKey: ["retention-offers", pid], enabled: !!pid, queryFn: async () => (await api<List<RetentionOffer>>(`${v2(pid)}/retention_offers`)).items });
  const offers = offersQ.data ?? [];
  const [cfg, setCfg] = useState<CcConfig | null>(null);
  const [savedPrint, setSavedPrint] = useState<string | null>(null);
  const [sel, setSel] = useState<{ screen: ScreenKey; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [resetting, setResetting] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Load once; a refetch (the Support page saving) replaces the document only when there are no unsaved edits.
  useEffect(() => {
    if (!q.data?.config) return;
    if (cfg && print(cfg) !== savedPrint) return;
    setCfg(clone(q.data.config)); setSavedPrint(print(q.data.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  const dirty = !!cfg && print(cfg) !== savedPrint;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // Problems clear as soon as the document is valid again.
  useEffect(() => { if (cfg && problems.length) setProblems(validateCustomerCenter(cfg)); }, [cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (fn: (c: CcConfig) => void) => setCfg((c) => { if (!c) return c; const n = clone(c); fn(n); return n; });

  async function save() {
    if (!cfg) return;
    const found = validateCustomerCenter(cfg);
    setProblems(found);
    if (found.length) { setErr(`Fix ${found.length === 1 ? "this problem" : `these ${found.length} problems`} before saving.`); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api<Resp>(`${v2(pid)}/customer_center_config`, { method: "POST", json: { customer_center: cfg } });
      setCfg(clone(res.config)); setSavedPrint(print(res.config));
      qc.setQueryData(["customer-center", pid], res);
      toast("Customer Center saved");
    } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  }
  async function reset() {
    const res = await api<Resp>(`${v2(pid)}/customer_center_config`, { method: "POST", json: { customer_center: null } });
    setCfg(clone(res.config)); setSavedPrint(print(res.config)); setSel(null); setProblems([]); setErr(null);
    qc.setQueryData(["customer-center", pid], res);
    toast("Customer Center reset to the default");
  }

  return (
    <Shell title="Customer Center">
      <div className="page">
        <PageHead title="Customer Center" sub="The screen where customers manage their subscription inside your app. The SDK loads this configuration each time the screen opens."
          actions={<>
            {dirty && <Tag tone="gold">Unsaved changes</Tag>}
            <button type="button" className="btn btn-line" disabled={!cfg} onClick={() => setPreviewing(true)}><Icon name="phone" />Preview</button>
            <button type="button" className="btn btn-line" disabled={!cfg || busy} onClick={() => setResetting(true)}>Reset configuration</button>
            <button type="button" className="btn btn-dark" disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save changes"}</button>
          </>} />
        <Tabs label="Customer Center" idBase="cc" value={tab} onChange={go} tabs={[{ value: "configuration", label: "Configuration" }, { value: "appearance", label: "Appearance" }, { value: "localization", label: "Localization" }]} />
        {(err || problems.length > 0) && (
          <div className="banner err" role="alert">
            <div>
              {err && <b>{err}</b>}
              {problems.length > 0 && <ul className="cc-problems">{problems.slice(0, 8).map((p) => <li key={p}>{p}</li>)}{problems.length > 8 && <li>{problems.length - 8} more</li>}</ul>}
            </div>
          </div>
        )}
        <div role="tabpanel" id={`cc-${tab}-panel`} aria-labelledby={`cc-${tab}`} className="stack">
          {q.isError ? <div className="banner err" role="alert">The configuration could not be loaded: {errMsg(q.error)}</div>
            : !cfg ? <div className="panel pb" aria-busy="true"><span className="sk line" /></div>
            : tab === "configuration" ? <Configuration cfg={cfg} update={update} sel={sel} setSel={setSel} offers={offers} problems={problems} pid={pid} />
            : tab === "appearance" ? <AppearanceTab cfg={cfg} update={update} offers={offers} />
            : <LocalizationTab cfg={cfg} update={update} />}
        </div>
      </div>
      {previewing && cfg && <PreviewDialog cfg={cfg} offers={offers} onClose={() => setPreviewing(false)} />}
      {resetting && (
        <ConfirmDialog title="Reset the configuration?" confirmLabel="Reset configuration" danger onClose={() => setResetting(false)} onConfirm={reset}>
          <p>Every path, survey, colour, translation and custom string goes back to the default, and the app shows the default screens the next time the Customer Center opens. Retention offers are kept.</p>
        </ConfirmDialog>
      )}
    </Shell>
  );
}

interface ConfigProps {
  cfg: CcConfig; update: (fn: (c: CcConfig) => void) => void; offers: RetentionOffer[]; problems: string[]; pid: string;
  sel: { screen: ScreenKey; id: string } | null; setSel: (s: { screen: ScreenKey; id: string } | null) => void;
}

function Configuration({ cfg, update, sel, setSel, offers, problems, pid }: ConfigProps) {
  const s = cfg.support as Record<string, unknown>;
  const setSupport = (k: string, v: unknown) => update((c) => { (c.support as Record<string, unknown>)[k] = v; });
  const selScreen = sel ? cfg.screens[sel.screen] : null;
  const selIndex = selScreen && sel ? selScreen.paths.findIndex((p) => p.id === sel.id) : -1;
  const selPath = selIndex >= 0 ? selScreen!.paths[selIndex]! : null;
  return (
    <div className="two cc-two">
      <div className="stack">
        <Panel title="Support">
          <div className="stack tight">
            <Field label="Support email" htmlFor="cc-email" hint="Where the Contact support button sends mail. Ticket settings are under Lifecycle › Support.">
              <input id="cc-email" className="input" type="email" value={String(s.email ?? "")} onChange={(e) => setSupport("email", e.target.value)} />
            </Field>
            <Check checked={!!s.should_warn_customer_to_update} onChange={(v) => setSupport("should_warn_customer_to_update", v)} label="Warn customers on an old app version" hint="Asks them to update before they contact support." />
            <Check checked={!!s.display_purchase_history_link} onChange={(v) => setSupport("display_purchase_history_link", v)} label="Show purchase history" hint="A link to every past purchase of the customer." />
            <Check checked={!!s.display_user_details_section} onChange={(v) => setSupport("display_user_details_section", v)} label="Show the user details section" hint="The customer's user ID and first purchase date. iOS only." />
          </div>
        </Panel>
        {SCREENS.map((sc) => <ScreenPanel key={sc.key} meta={sc} screen={cfg.screens[sc.key]} update={update} sel={sel} setSel={setSel} problems={problems} />)}
      </div>
      <div className="cc-side">
        {selPath && sel ? (
          <PathPanel key={`${sel.screen}:${selPath.id}`} screenKey={sel.screen} index={selIndex} path={selPath} offers={offers} pid={pid}
            problems={problems.filter((p) => p.startsWith(`screens.${sel.screen}.paths[${selIndex}]`))}
            onChange={(fn) => update((c) => { const p = c.screens[sel.screen].paths.find((x) => x.id === sel.id); if (p) fn(p); })}
            onDelete={() => { update((c) => { c.screens[sel.screen].paths = c.screens[sel.screen].paths.filter((x) => x.id !== sel.id); }); setSel(null); }} />
        ) : (
          <Panel title="Path settings"><p className="subtle" style={{ margin: 0, fontSize: 13 }}>Select a path to edit its button text, translations and what it does.</p></Panel>
        )}
      </div>
    </div>
  );
}

function ScreenPanel({ meta, screen, update, sel, setSel, problems }: { meta: (typeof SCREENS)[number]; screen: CcScreen; update: ConfigProps["update"]; sel: ConfigProps["sel"]; setSel: ConfigProps["setSel"]; problems: string[] }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const key = meta.key;
  const setScreen = (fn: (s: CcScreen) => void) => update((c) => fn(c.screens[key]));
  const move = (from: number, to: number) => setScreen((s) => {
    if (from === to || to < 0 || to >= s.paths.length) return;
    const [x] = s.paths.splice(from, 1);
    s.paths.splice(to, 0, x!);
  });
  const present = new Set(screen.paths.map((p) => p.type));
  const add = (t: CcPathType) => {
    const p = newCcPath(t, screen.paths.flatMap((x) => [x.id, ...(x.feedback_survey?.options ?? []).map((o) => o.id)]));
    setScreen((s) => { s.paths.push(p); });
    setSel({ screen: key, id: p.id });
  };
  const onDrop = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = drag ?? Number(e.dataTransfer.getData("text/plain"));
    if (Number.isInteger(from)) move(from, i);
    setDrag(null); setOver(null);
  };
  const titleProblem = problems.find((p) => p.startsWith(`screens.${key}.title`));
  return (
    <section className="panel" aria-label={meta.title}>
      <div className="ph"><b>{meta.title}</b><span className="subtle cc-ph-tag">{key}</span></div>
      <div className="pb stack">
        <p className="section-sub">{meta.sub}</p>
        <div className="form-grid">
          <Field label="Screen title" htmlFor={`cc-${key}-title`} error={titleProblem ? titleProblem.split(": ").slice(1).join(": ") : null}
            hint={<TranslateButton label={`${meta.title}: screen title`} english={screen.title} value={screen.title_localizations} onSave={(v) => setScreen((s) => { s.title_localizations = v; })} />}>
            <input id={`cc-${key}-title`} className="input" value={screen.title} onChange={(e) => setScreen((s) => { s.title = e.target.value; })} />
          </Field>
          <Field label="Subtitle" htmlFor={`cc-${key}-sub`}
            hint={<TranslateButton label={`${meta.title}: subtitle`} english={screen.subtitle ?? ""} value={screen.subtitle_localizations} onSave={(v) => setScreen((s) => { s.subtitle_localizations = v; })} />}>
            <input id={`cc-${key}-sub`} className="input" value={screen.subtitle ?? ""} placeholder="Optional" onChange={(e) => setScreen((s) => { s.subtitle = e.target.value; })} />
          </Field>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Management options</div>
          {screen.paths.length === 0 ? (
            <p className="subtle" style={{ margin: "0 0 8px", fontSize: 13 }}>No paths: customers only see Contact support.</p>
          ) : (
            <ol className="policy-list cc-paths" aria-label={`${meta.title}: paths in order`}>
              {screen.paths.map((p, i) => {
                const selected = sel?.screen === key && sel.id === p.id;
                const bad = problems.some((x) => x.startsWith(`screens.${key}.paths[${i}]`));
                return (
                  <li key={p.id} className={`policy cc-path${selected ? " sel" : ""}${drag === i ? " dragging" : ""}${over === i && drag !== null && drag !== i ? " over" : ""}`}
                    onDragOver={(e) => { if (drag === null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== i) setOver(i); }}
                    onDragLeave={() => setOver((o) => (o === i ? null : o))} onDrop={onDrop(i)}>
                    <div className="policy-h">
                      <span className="ib grip" draggable onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
                        onDragEnd={() => { setDrag(null); setOver(null); }} title="Drag to reorder" aria-hidden><Icon name="grip" /></span>
                      <span className="pos">{i + 1}</span>
                      <button type="button" className="cc-path-b" aria-pressed={selected} onClick={() => setSel({ screen: key, id: p.id })}>
                        <b>{p.title || <span className="subtle">No button text</span>}</b>
                        <small>{pathLabel(p.type)}{p.type === "CUSTOM_URL" && p.url ? ` · ${p.url}` : ""}{p.type === "CUSTOM_ACTION" && p.action_identifier ? ` · ${p.action_identifier}` : ""}{p.feedback_survey ? " · survey" : ""}</small>
                      </button>
                      {bad && <Tag tone="down">Fix</Tag>}
                      <button type="button" className="ib" aria-label={`Move ${p.title || pathLabel(p.type)} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="up" /></button>
                      <button type="button" className="ib" aria-label={`Move ${p.title || pathLabel(p.type)} down`} disabled={i === screen.paths.length - 1} onClick={() => move(i, i + 1)}><Icon name="down" /></button>
                      <button type="button" className="ib" aria-label={`Delete ${p.title || pathLabel(p.type)}`} onClick={() => { setScreen((s) => { s.paths.splice(i, 1); }); if (selected) setSel(null); }}><Icon name="trash" /></button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div style={{ marginTop: 8 }}>
            <Menu label={`Add path to ${meta.title}`} text="Add path" items={CC_PATH_TYPES.map((t) => {
              const taken = !CC_REPEATABLE_PATHS.has(t) && present.has(t);
              return { label: CC_PATH_INFO[t].label, onSelect: () => add(t), disabled: taken || screen.paths.length >= 20, hint: taken ? "Already added" : undefined };
            })} />
          </div>
        </div>
      </div>
    </section>
  );
}

function PathPanel({ screenKey, index, path, onChange, onDelete, offers, problems, pid }: {
  screenKey: ScreenKey; index: number; path: CcPath; onChange: (fn: (p: CcPath) => void) => void; onDelete: () => void; offers: RetentionOffer[]; problems: string[]; pid: string;
}) {
  const info = CC_PATH_INFO[path.type as CcPathType];
  const prefix = `screens.${screenKey}.paths[${index}]`;
  const problemOf = (field: string) => {
    const p = problems.find((x) => x.startsWith(`${prefix}.${field}:`) || x.startsWith(`${prefix}.${field}.`));
    return p ? p.split(": ").slice(1).join(": ") : null;
  };
  const survey = path.feedback_survey;
  const ids = useMemo(() => [path.id, ...(survey?.options ?? []).map((o) => o.id)], [path.id, survey]);
  const trigger = path.type === "CANCEL" ? "cancel" : path.type === "REFUND_REQUEST" ? "refund" : null;
  return (
    <section className="panel cc-detail" aria-label="Path settings">
      <div className="ph"><b>{info?.label ?? path.type}</b><span className="subtle cc-ph-tag">{screenKey === "MANAGEMENT" ? "Active subscriptions" : "No active subscriptions"}</span></div>
      <div className="pb stack">
        <p className="section-sub">{info?.description}</p>
        <Field label="Button text" htmlFor="cc-path-title" error={problemOf("title")}
          hint={<TranslateButton label={`${info?.label ?? "Path"}: button text`} english={path.title} value={path.title_localizations} onSave={(v) => onChange((p) => { p.title_localizations = v; })} />}>
          <input id="cc-path-title" className="input" value={path.title} onChange={(e) => onChange((p) => { p.title = e.target.value; })} />
        </Field>

        {path.type === "CUSTOM_URL" && <>
          <Field label="URL" htmlFor="cc-path-url" error={problemOf("url")} hint="A web page or a deep link into your app, such as myapp://support.">
            <input id="cc-path-url" className="input" inputMode="url" placeholder="https://example.com/help" value={path.url ?? ""} onChange={(e) => onChange((p) => { p.url = e.target.value; })} />
          </Field>
          <div className="field">
            <span className="label">Open in</span>
            <Segmented label="Open in" value={path.open_method ?? "EXTERNAL"} onChange={(v) => onChange((p) => { p.open_method = v; })}
              options={[{ value: "IN_APP", label: "In the app" }, { value: "EXTERNAL", label: "Browser" }]} />
          </div>
        </>}

        {path.type === "CUSTOM_ACTION" && (
          <Field label="Action identifier" htmlFor="cc-path-action" error={problemOf("action_identifier")} hint="The SDK hands this identifier to your app's custom action handler, which runs your own flow.">
            <input id="cc-path-action" className="input mono" placeholder="open_chat" value={path.action_identifier ?? ""} onChange={(e) => onChange((p) => { p.action_identifier = e.target.value; })} />
          </Field>
        )}

        {trigger && (
          <div className="field">
            <span className="label">Promotional offer</span>
            <OfferPicker idBase="cc-path-offer" value={path.promotional_offer} offers={offers} trigger={trigger} allowAuto error={problemOf("promotional_offer")}
              onChange={(v) => onChange((p) => { if (v === undefined) delete p.promotional_offer; else p.promotional_offer = v; })} />
            <span className="hint">{path.type === "CANCEL" ? "Shown before the customer reaches the store's cancel screen." : "Shown before the refund request sheet."} Offers are set up under <Link to={`/projects/${pid}/lifecycle/retention`}>Lifecycle › Retention</Link>.</span>
          </div>
        )}

        {path.type === "CANCEL" && (
          <div className="stack tight cc-survey">
            <Check checked={!!survey} label="Ask why with a feedback survey" hint="The answer is reported to your app and webhooks; each answer can show its own offer."
              onChange={(on) => onChange((p) => { p.feedback_survey = on ? { title: CC_DEFAULT_SURVEY.title, options: CC_DEFAULT_SURVEY.options.map((title) => ({ id: newCcId("option", ids), title })) } : null; })} />
            {survey && <>
              <Field label="Survey question" htmlFor="cc-survey-title" error={problemOf("feedback_survey.title")}
                hint={<TranslateButton label="Survey question" english={survey.title} value={survey.title_localizations} onSave={(v) => onChange((p) => { p.feedback_survey!.title_localizations = v; })} />}>
                <input id="cc-survey-title" className="input" value={survey.title} onChange={(e) => onChange((p) => { p.feedback_survey!.title = e.target.value; })} />
              </Field>
              <div className="label">Answers</div>
              {problemOf("feedback_survey.options") && <span className="err" role="alert">{problemOf("feedback_survey.options")}</span>}
              <ol className="cc-options" aria-label="Survey answers">
                {survey.options.map((o, i) => (
                  <li key={o.id} className="cc-option">
                    <div className="inline-row">
                      <input className="input" aria-label={`Answer ${i + 1}`} value={o.title} onChange={(e) => onChange((p) => { p.feedback_survey!.options[i]!.title = e.target.value; })} />
                      <button type="button" className="ib" aria-label={`Move answer ${i + 1} up`} disabled={i === 0} onClick={() => onChange((p) => { const l = p.feedback_survey!.options; [l[i - 1], l[i]] = [l[i]!, l[i - 1]!]; })}><Icon name="up" /></button>
                      <button type="button" className="ib" aria-label={`Move answer ${i + 1} down`} disabled={i === survey.options.length - 1} onClick={() => onChange((p) => { const l = p.feedback_survey!.options; [l[i + 1], l[i]] = [l[i]!, l[i + 1]!]; })}><Icon name="down" /></button>
                      <button type="button" className="ib" aria-label={`Delete answer ${i + 1}`} disabled={survey.options.length <= 1} onClick={() => onChange((p) => { p.feedback_survey!.options.splice(i, 1); })}><Icon name="trash" /></button>
                    </div>
                    <div className="cc-option-b">
                      <TranslateButton label={`Answer ${i + 1}`} english={o.title} value={o.title_localizations} onSave={(v) => onChange((p) => { p.feedback_survey!.options[i]!.title_localizations = v; })} />
                      <OfferPicker idBase={`cc-option-${i}-offer`} label={`Offer for answer ${i + 1}`} value={o.promotional_offer} offers={offers} trigger="cancel"
                        error={problemOf(`feedback_survey.options[${i}]`)}
                        onChange={(v) => onChange((p) => { const opt = p.feedback_survey!.options[i]!; if (v === undefined || v === null) delete opt.promotional_offer; else opt.promotional_offer = v; })} />
                    </div>
                  </li>
                ))}
              </ol>
              <div><button type="button" className="btn btn-line" disabled={survey.options.length >= 10} onClick={() => onChange((p) => { p.feedback_survey!.options.push({ id: newCcId("option", ids), title: "" }); })}><Icon name="plus" />Add answer</button></div>
            </>}
          </div>
        )}

        <div><button type="button" className="btn btn-line cc-danger" onClick={onDelete}><Icon name="trash" />Delete path</button></div>
        <p className="subtle mono" style={{ margin: 0, fontSize: 11 }}>Path id {path.id}</p>
      </div>
    </section>
  );
}
