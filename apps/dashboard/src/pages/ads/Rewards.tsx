import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { CodeBlock, ConfirmDialog, CopyField, Dialog, Field, Panel, Segmented, Switch, Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { errMsg, useApps } from "../setup/data";
import { rewardText, ruleGrantText, useAdMob, useRewardRules, v2, type RewardRule, type RewardVerification } from "./data";

/**
 * Ads Rewards (/projects/:projectId/ads/rewards; prd/ads/PRD.md): server-side verification of rewarded ads. The AdMob
 * callback URL to paste into each rewarded ad unit, the ordered reward rules (in-app currency or a temporary
 * entitlement), "Send a test reward", and the ledger of verifications with what each granted.
 */

const GUIDE = "https://revenuedot.app/docs/guides/ads#rewarded-ads";

const SWIFT = `// After the rewarded ad loads
let token = Purchases.shared.generateRewardVerificationToken(impressionId: impressionId)
let options = ServerSideVerificationOptions()
options.userIdentifier = token.appUserID
options.customRewardString = token.customData
rewardedAd.serverSideVerificationOptions = options

// When the ad's reward callback fires
let result = await Purchases.shared.pollRewardVerification(clientTransactionID: token.clientTransactionID)`;

const KOTLIN = `// After the rewarded ad loads
val token = Purchases.sharedInstance.generateRewardVerificationToken(impressionId)
rewardedAd.setServerSideVerificationOptions(
    ServerSideVerificationOptions.Builder()
        .setUserId(token.appUserID)
        .setCustomData(token.customData)
        .build()
)

// When the ad's reward callback fires
Purchases.sharedInstance.pollRewardVerificationWith(token.clientTransactionID, onResult = { result -> /* … */ })`;

interface Currency { code: string; name: string }
interface Entitlement { id: string; lookup_key: string; display_name: string }

type Draft = {
  id?: string; name: string; app_id: string; ad_unit_id: string; reward_item: string; kind: "virtual_currency" | "entitlement";
  currency_code: string; amount_mode: "fixed" | "network"; amount: string; multiplier: string; entitlement_id: string; duration: string; duration_unit: "minutes" | "hours" | "days";
};
const emptyDraft = (): Draft => ({ name: "", app_id: "", ad_unit_id: "", reward_item: "", kind: "virtual_currency", currency_code: "", amount_mode: "fixed", amount: "10", multiplier: "1", entitlement_id: "", duration: "1", duration_unit: "days" });
const UNIT_MIN = { minutes: 1, hours: 60, days: 1440 } as const;
function draftOf(r: RewardRule): Draft {
  const m = r.duration_minutes ?? 1440;
  const unit = m % 1440 === 0 ? "days" : m % 60 === 0 ? "hours" : "minutes";
  return {
    id: r.id, name: r.name, app_id: r.app_id ?? "", ad_unit_id: r.ad_unit_id ?? "", reward_item: r.reward_item ?? "", kind: r.kind, currency_code: r.currency_code ?? "",
    amount_mode: r.multiplier ? "network" : "fixed", amount: String(r.amount ?? 10), multiplier: String(r.multiplier ?? 1), entitlement_id: r.entitlement_id ?? "",
    duration: String(m / UNIT_MIN[unit]), duration_unit: unit,
  };
}

function RuleDialog({ pid, initial, onClose }: { pid: string; initial: Draft; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const apps = useApps(pid);
  const admob = useAdMob(pid);
  const currencies = useQuery({ queryKey: ["virtual_currencies", pid], queryFn: async () => (await api<List<Currency>>(`${v2(pid)}/virtual_currencies?limit=100`)).items });
  const ents = useQuery({ queryKey: ["entitlements-list", pid], queryFn: async () => (await api<List<Entitlement>>(`${v2(pid)}/entitlements?limit=100`)).items });
  const [d, setD] = useState<Draft>(() => ({ ...initial, currency_code: initial.currency_code, entitlement_id: initial.entitlement_id }));
  const [err, setErr] = useState<{ message: string; param?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const currency = d.currency_code || currencies.data?.[0]?.code || "";
  const entitlement = d.entitlement_id || ents.data?.[0]?.lookup_key || "";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!d.name.trim()) { setErr({ message: "Name the rule.", param: "name" }); return; }
    const json: Record<string, unknown> = {
      name: d.name.trim(), app_id: d.app_id || null, ad_unit_id: d.ad_unit_id.trim() || null, reward_item: d.reward_item.trim() || null, kind: d.kind,
    };
    if (d.kind === "virtual_currency") {
      json.currency_code = currency || null;
      if (d.amount_mode === "fixed") { json.amount = Number(d.amount) || null; json.multiplier = null; } else { json.multiplier = Number(d.multiplier) || null; json.amount = null; }
    } else {
      json.entitlement_id = entitlement || null;
      json.duration_minutes = Math.round((Number(d.duration) || 0) * UNIT_MIN[d.duration_unit]) || null;
    }
    setBusy(true); setErr(null);
    try {
      await api(`${v2(pid)}/ads/reward_rules${d.id ? `/${d.id}` : ""}`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: ["reward_rules", pid] });
      toast(d.id ? "Rule saved." : "Rule added. Verified rewards that match it are granted from now on.");
      onClose();
    } catch (x) {
      const b = (x as { body?: { message?: string; param?: string } }).body;
      setErr({ message: errMsg(x), param: b?.param });
    } finally { setBusy(false); }
  }
  const fe = (p: string) => (err?.param === p ? err.message : null);
  return (
    <Dialog title={d.id ? "Edit reward rule" : "New reward rule"} onClose={onClose}
      footer={<><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="submit" form="rule-form" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : d.id ? "Save rule" : "Add rule"}</button></>}>
      <form id="rule-form" className="stack" onSubmit={save} noValidate>
        <Field label="Name" htmlFor="r-name" error={fe("name")}><input id="r-name" className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Gems for level-end ads" /></Field>
        <div className="field">
          <span className="flabel">Grant</span>
          <Segmented label="Grant" value={d.kind} onChange={(v) => set({ kind: v })} options={[{ value: "virtual_currency", label: "In-app currency" }, { value: "entitlement", label: "Temporary access" }]} />
        </div>
        {d.kind === "virtual_currency" ? (
          <>
            {currencies.data && !currencies.data.length && <div className="banner" role="status">This project has no in-app currency yet. <Link className="link-u" to={`/projects/${pid}/product-catalog/virtual-currencies`}>Create one</Link> first.</div>}
            <Field label="Currency" htmlFor="r-cur" error={fe("currency_code")}>
              <select id="r-cur" className="select" value={currency} onChange={(e) => set({ currency_code: e.target.value })}>
                {currencies.data?.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
              </select>
            </Field>
            <div className="field">
              <span className="flabel">Amount</span>
              <Segmented label="Amount" value={d.amount_mode} onChange={(v) => set({ amount_mode: v })} options={[{ value: "fixed", label: "Fixed amount" }, { value: "network", label: "Network's amount" }]} />
            </div>
            {d.amount_mode === "fixed"
              ? <Field label="Amount per reward" htmlFor="r-amount" error={fe("amount")}><input id="r-amount" className="input mono" inputMode="numeric" value={d.amount} onChange={(e) => set({ amount: e.target.value })} style={{ maxWidth: 160 }} /></Field>
              : <Field label="Multiplier" htmlFor="r-mult" error={fe("multiplier") ?? fe("amount")} hint="The reward amount AdMob sends (set on the ad unit) times this number, rounded."><input id="r-mult" className="input mono" inputMode="decimal" value={d.multiplier} onChange={(e) => set({ multiplier: e.target.value })} style={{ maxWidth: 160 }} /></Field>}
          </>
        ) : (
          <>
            <Field label="Entitlement" htmlFor="r-ent" error={fe("entitlement_id")}>
              <select id="r-ent" className="select" value={entitlement} onChange={(e) => set({ entitlement_id: e.target.value })}>
                {ents.data?.map((x) => <option key={x.id} value={x.lookup_key}>{x.display_name} ({x.lookup_key})</option>)}
              </select>
            </Field>
            <Field label="For" htmlFor="r-dur" error={fe("duration_minutes")}>
              <span className="hrow" style={{ flexWrap: "nowrap" }}>
                <input id="r-dur" className="input mono" inputMode="numeric" value={d.duration} onChange={(e) => set({ duration: e.target.value })} style={{ maxWidth: 100 }} />
                <select className="select" aria-label="Duration unit" value={d.duration_unit} onChange={(e) => set({ duration_unit: e.target.value as Draft["duration_unit"] })} style={{ maxWidth: 140 }}>
                  <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
                </select>
              </span>
            </Field>
          </>
        )}
        <div className="group-h"><h2 style={{ fontSize: 13 }}>Only when</h2><p>Leave empty to match every rewarded ad.</p></div>
        <Field label="App" htmlFor="r-app" error={fe("app_id")}>
          <select id="r-app" className="select" value={d.app_id} onChange={(e) => set({ app_id: e.target.value })}>
            <option value="">Any app</option>
            {apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Ad unit" htmlFor="r-unit" hint="The AdMob ad unit ID, such as ca-app-pub-123/456. The number after the slash also matches.">
          <input id="r-unit" className="input mono" list="r-units" value={d.ad_unit_id} onChange={(e) => set({ ad_unit_id: e.target.value })} placeholder="Any ad unit" />
          <datalist id="r-units">{admob.data?.ad_units.filter((u) => !u.format || u.format.includes("reward")).map((u) => <option key={u.ad_unit_id} value={u.ad_unit_id}>{u.name}</option>)}</datalist>
        </Field>
        <Field label="Reward item" htmlFor="r-item" hint="The reward type set on the ad unit in AdMob, such as coins. Not case-sensitive.">
          <input id="r-item" className="input mono" value={d.reward_item} onChange={(e) => set({ reward_item: e.target.value })} placeholder="Any reward item" />
        </Field>
        {err && !fe(err.param ?? "") && <div className="banner err" role="alert">{err.message}</div>}
      </form>
    </Dialog>
  );
}

function TestDialog({ pid, onClose }: { pid: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [user, setUser] = useState("");
  const [unit, setUnit] = useState("");
  const [item, setItem] = useState("");
  const [amount, setAmount] = useState("10");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!user.trim()) { setErr("Enter the app user ID that should get the reward."); return; }
    setBusy(true); setErr(null);
    try {
      const v = await api<RewardVerification>(`${v2(pid)}/ads/reward_verifications/test`, { method: "POST", json: { app_user_id: user.trim(), ad_unit_id: unit.trim() || null, reward_item: item.trim() || null, reward_amount: Number(amount) || 0 } });
      await qc.invalidateQueries({ queryKey: ["reward_verifications", pid] });
      toast(v.status === "failed" ? `The test reward failed: ${v.failure_message ?? v.failure_reason}` : v.rewards.length ? `Granted ${v.rewards.map(rewardText).join(" and ")} to ${v.app_user_id}.` : "Verified, but no rule matched, so nothing was granted.");
      onClose();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <Dialog title="Send a test reward" onClose={onClose}
      footer={<><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="submit" form="test-form" className="btn btn-dark" disabled={busy}>{busy ? "Sending…" : "Send test reward"}</button></>}>
      <form id="test-form" className="stack" onSubmit={send} noValidate>
        <p className="section-sub">Runs the same rules as a verified AdMob callback, without an ad. The reward is marked as sandbox in the ledger. Currency and access are granted for real.</p>
        <Field label="App user ID" htmlFor="t-user" error={err && !user.trim() ? err : null}><input id="t-user" className="input mono" value={user} onChange={(e) => setUser(e.target.value)} placeholder="user_42" /></Field>
        <Field label="Ad unit (optional)" htmlFor="t-unit"><input id="t-unit" className="input mono" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="ca-app-pub-123/456" /></Field>
        <div className="cols">
          <Field label="Reward item (optional)" htmlFor="t-item"><input id="t-item" className="input mono" value={item} onChange={(e) => setItem(e.target.value)} placeholder="coins" /></Field>
          <Field label="Network's amount" htmlFor="t-amount"><input id="t-amount" className="input mono" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        </div>
        {err && user.trim() && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

function Rules({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useRewardRules(pid);
  const apps = useApps(pid);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<RewardRule | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["reward_rules", pid] });
  const move = async (i: number, j: number) => {
    const list = [...(rules.data ?? [])];
    const [x] = list.splice(i, 1);
    list.splice(j, 0, x!);
    try { await api(`${v2(pid)}/ads/reward_rules/actions/reorder`, { method: "POST", json: { rule_ids: list.map((r) => r.id) } }); await refresh(); } catch (e) { toast(errMsg(e)); }
  };
  const toggle = async (r: RewardRule, enabled: boolean) => {
    try { await api(`${v2(pid)}/ads/reward_rules/${r.id}`, { method: "POST", json: { enabled } }); await refresh(); } catch (e) { toast(errMsg(e)); }
  };
  const appName = (id: string | null) => (id ? apps.data?.find((a) => a.id === id)?.name ?? id : null);
  return (
    <section className="panel">
      <div className="ph wrap"><b>Reward rules</b><button type="button" className="btn btn-dark" onClick={() => setEditing(emptyDraft())}><Icon name="plus" />New rule</button></div>
      <div className="pb section-sub" style={{ paddingBottom: 0 }}>Checked from top to bottom; the first rule that matches a verified reward decides what the customer gets. No match: the reward is verified with nothing granted.</div>
      {rules.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(rules.error)}</div></div>}
      {rules.data && !rules.data.length && (
        <div className="empty" style={{ border: 0 }}>
          <h3>No reward rules yet</h3>
          <p>Add a rule to grant in-app currency or a day of access when an ad network verifies a reward.</p>
          <button type="button" className="btn btn-dark" onClick={() => setEditing(emptyDraft())}>Add your first rule</button>
        </div>
      )}
      {!!rules.data?.length && (
        <ol className="rule-list" aria-label="Reward rules in priority order">
          {rules.data.map((r, i) => (
            <li key={r.id} className={r.enabled ? undefined : "off"}>
              <span className="pos mono">{i + 1}</span>
              <div className="rule-main">
                <b>{r.name}</b>
                <span className="sub">Grants {ruleGrantText(r)}{[appName(r.app_id), r.ad_unit_id && `ad unit ${r.ad_unit_id}`, r.reward_item && `reward item "${r.reward_item}"`].filter(Boolean).length ? ` · when ${[appName(r.app_id), r.ad_unit_id && `ad unit ${r.ad_unit_id}`, r.reward_item && `reward item "${r.reward_item}"`].filter(Boolean).join(", ")}` : " · every rewarded ad"}</span>
              </div>
              <Switch label={r.enabled ? "On" : "Off"} checked={r.enabled} onChange={(v) => void toggle(r, v)} />
              <button type="button" className="ib" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="up" /></button>
              <button type="button" className="ib" aria-label={`Move ${r.name} down`} disabled={i === rules.data!.length - 1} onClick={() => move(i, i + 1)}><Icon name="down" /></button>
              <button type="button" className="ib" aria-label={`Edit ${r.name}`} onClick={() => setEditing(draftOf(r))}><Icon name="edit" /></button>
              <button type="button" className="ib" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}><Icon name="trash" /></button>
            </li>
          ))}
        </ol>
      )}
      {editing && <RuleDialog pid={pid} initial={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.name}?`} confirmLabel="Delete rule" danger onClose={() => setDeleting(null)}
          onConfirm={async () => { await api(`${v2(pid)}/ads/reward_rules/${deleting.id}`, { method: "DELETE" }); await refresh(); toast("Rule deleted."); }}>
          <p>Rewards already granted stay. New verified rewards that only this rule matched are verified with nothing granted.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

const STATUS_TONE = { verified: "up", failed: "down", pending: "info" } as const;

function Ledger({ pid }: { pid: string }) {
  const [status, setStatus] = useState<"all" | "verified" | "failed">("all");
  const q = useInfiniteQuery({
    queryKey: ["reward_verifications", pid, status],
    queryFn: ({ pageParam }) => api<List<RewardVerification>>(pageParam ?? `${v2(pid)}/ads/reward_verifications?limit=25${status === "all" ? "" : `&status=${status}`}`),
    initialPageParam: null as string | null, getNextPageParam: (l) => l.next_page, refetchInterval: 15_000,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="panel">
      <div className="ph wrap"><b>Ledger</b><Segmented label="Verification status" value={status} onChange={setStatus} options={[{ value: "all", label: "All" }, { value: "verified", label: "Verified" }, { value: "failed", label: "Failed" }]} /></div>
      {q.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(q.error)}</div></div>}
      {q.data && !rows.length && <div className="pb section-sub">No verified rewards yet. They appear here seconds after AdMob calls the callback URL, or after a test reward.</div>}
      {!!rows.length && (
        <div className="tbl">
          <table>
            <thead><tr><th>Customer</th><th>Network</th><th>Ad unit</th><th>Reward</th><th>Status</th><th>Granted</th><th>When</th></tr></thead>
            <tbody>{rows.map((v) => (
              <tr key={v.id}>
                <td><Link className="mono" to={`/projects/${pid}/customers/${encodeURIComponent(v.app_user_id)}`}>{v.app_user_id || "—"}</Link>{v.is_sandbox && <span className="soon" style={{ marginLeft: 6 }}>SANDBOX</span>}</td>
                <td>{v.network === "admob" ? "AdMob" : v.network === "test" ? "Test" : v.network}<span className="cellsub mono" title={v.network_transaction_id}>{v.network_transaction_id.slice(0, 18)}</span></td>
                <td className="mono">{v.ad_unit_id ?? "—"}</td>
                <td className="mono">{v.reward_item ? `${v.reward_amount ?? ""} ${v.reward_item}`.trim() : v.reward_amount ?? "—"}</td>
                <td><Tag tone={STATUS_TONE[v.status]}>{v.status}</Tag>{v.failure_message && <span className="cellsub">{v.failure_message}</span>}</td>
                <td>{v.rewards.length ? v.rewards.map(rewardText).join(", ") : <span className="subtle">Nothing</span>}</td>
                <td title={fmt.dateTime(v.created_at)}>{fmt.ago(v.created_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && <div className="pb"><button type="button" className="btn btn-line" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</button></div>}
    </section>
  );
}

export function RewardsPage() {
  const pid = useProjectId();
  const admob = useAdMob(pid);
  const [testing, setTesting] = useState(false);
  const [lang, setLang] = useState<"swift" | "kotlin">("swift");
  const url = admob.data?.ssv_callback_url;
  return (
    <Shell title="Rewards" crumbs={<><Link to={`/projects/${pid}/ads`}>Ads</Link> <span>/</span> <b>Rewards</b></>}>
      <div className="page">
        <div className="head">
          <div>
            <h1>Rewards</h1>
            <p>Rewarded ads verified on the server: the ad network tells RevenueDot, the reward rule grants currency or access, and your app only asks whether it went through.</p>
          </div>
          <div className="actions"><button type="button" className="btn btn-line" onClick={() => setTesting(true)}><Icon name="send" />Send a test reward</button></div>
        </div>
        <Panel title="Server-side verification" link={<a className="link" href={GUIDE} target="_blank" rel="noreferrer">Setup guide →</a>}>
          <div className="stack">
            <ol className="steps">
              <li>In AdMob, open each rewarded ad unit, turn on <b>Server-side verification</b> and paste this callback URL. AdMob signs every callback; RevenueDot checks the signature with Google's published keys.</li>
            </ol>
            {url ? <CopyField value={url} label="AdMob callback URL" /> : <span className="sk line" />}
            <ol className="steps" start={2}>
              <li>In your app, pass the SDK's reward verification token to the ad's server-side verification options, then poll when the reward callback fires.</li>
            </ol>
            <div className="hrow"><Segmented label="Language" value={lang} onChange={setLang} options={[{ value: "swift", label: "Swift" }, { value: "kotlin", label: "Kotlin" }]} /></div>
            <CodeBlock label={lang === "swift" ? "Swift" : "Kotlin"} code={lang === "swift" ? SWIFT : KOTLIN} />
          </div>
        </Panel>
        <Rules pid={pid} />
        <Ledger pid={pid} />
      </div>
      {testing && <TestDialog pid={pid} onClose={() => setTesting(false)} />}
    </Shell>
  );
}
