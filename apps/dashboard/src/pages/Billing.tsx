import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../components/Shell";
import { Tag, useToast } from "../components/ui";
import { AccountLayout } from "./account/AccountLayout";
import { api, ApiError, fmt } from "../lib/api";
import { track } from "../lib/analytics";
import { StartPro } from "../components/PlanRequired";
import "./billing.css";

/**
 * Account settings → Billing (/account/billing; prd/account-settings §2): the projects this person owns and belongs to with
 * role and plan, then on RevenueDot Cloud with billing set up (prd/cloud-billing/PRD.md): the account's state in one card
 * (building, live with the date to start Pro by, paused, Pro with this month's bill, or Enterprise), the two plans with
 * Start Pro (Stripe Checkout), Manage billing (Customer Portal) or Contact sales, tracked revenue by project, and invoices.
 */

interface Plan { id: "pro" | "enterprise"; name: string; price_label: string; description: string; limit_usd: number | null; self_serve: boolean; includes?: string[]; rate?: number }
interface Billing {
  account: { plan: "none" | "pro" | "enterprise"; status: string; cancel_at: number | null; current_period_end: number | null; has_payment_method: boolean };
  gate: { stage: "off" | "building" | "grace" | "paused" | "active"; live_at: number | null; grace_ends_at: number | null; grace_days: number };
  plans: Plan[];
  usage: { month: string; tracked_revenue_usd: number; projects: { project_id: string; name: string | null; tracked_revenue_usd: number; transactions: number }[]; bill_usd: number; pro_bill_usd: number; free_up_to_usd: number; cap_usd: number; ceiling_usd: number; period_end: number; computed_at: number | null };
  flags: string[];
  invoices: { id: string; number: string | null; status: string; amount_due: number; amount_paid: number; period_end: number | null; hosted_invoice_url: string | null; invoice_pdf: string | null; created_at: number }[];
  stripe_ready: boolean; stripe_problem: string | null;
}
type Stage = "building" | "grace" | "paused" | "pro" | "enterprise";

const STATUS: Record<string, { label: string; tone: "up" | "down" | "info" | "gold" | "muted" }> = {
  active: { label: "Active", tone: "up" }, trialing: { label: "Active", tone: "up" }, past_due: { label: "Payment failed", tone: "down" }, unpaid: { label: "Unpaid", tone: "down" }, canceled: { label: "Cancelled", tone: "muted" }, incomplete: { label: "Checkout not finished", tone: "muted" }, paused: { label: "Paused", tone: "muted" }, none: { label: "No plan", tone: "muted" },
};
const CONTACT_SALES = "https://revenuedot.app/contact-sales";
const DAY = 86_400_000;
/** Billing dates in UTC: periods run on UTC calendar months, so "Ends Nov 1" matches Stripe's portal and emails everywhere. */
const utcDate = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Tracked revenue on Pro's scale: the first part is the $10,000 a month that costs nothing, the rest runs to the revenue
 * where the bill reaches the $999 cap ($209,800 at 0.5%). Two zones of fixed width, so $3,000 and $150,000 both read.
 */
function ProMeter({ tracked, free, cap, rate, bill }: { tracked: number; free: number; cap: number; rate: number; bill: number }) {
  const capAt = free + cap / (rate || 0.005);
  const SPLIT = 40;
  const pct = tracked <= free ? (tracked / (free || 1)) * SPLIT : SPLIT + Math.min(1, (tracked - free) / (capAt - free)) * (100 - SPLIT);
  const caption = tracked < free ? <><b className="mono">{fmt.usdRaw(free - tracked, true)}</b> to go before Pro costs anything this month.</>
    : tracked >= capAt ? <>Capped: this month costs <b className="mono">{fmt.usdRaw(cap)}</b>, however much more your apps make.</>
    : <>0.5% of the <b className="mono">{fmt.usdRaw(tracked - free, true)}</b> above {fmt.usdRaw(free)}: <b className="mono">{fmt.usdRaw(bill, true)}</b> so far.</>;
  return (
    <div className="bl-scale">
      <p className="bl-scale-c">{caption}</p>
      <div className="bl-meter2" role="meter" aria-label={`Tracked revenue against the ${fmt.usdRaw(free)} that costs nothing and the ${fmt.usdRaw(cap)} cap`} aria-valuemin={0} aria-valuemax={Math.round(capAt)} aria-valuenow={Math.round(tracked)}>
        <span className="fill" style={{ width: `${pct}%` }} />
        <span className="tick" style={{ left: `${SPLIT}%` }} />
      </div>
      <div className="bl-scale-l mono" aria-hidden>
        <span style={{ width: `${SPLIT}%` }}>$0<em>Costs nothing</em></span>
        <span>{fmt.usdRaw(free)}<em>0.5% above it</em></span>
        <span className="r">{fmt.usdRaw(capAt)}<em>{fmt.usdRaw(cap)} cap</em></span>
      </div>
    </div>
  );
}

function StateCard({ b, stage, busy, portal }: { b: Billing; stage: Stage; busy: boolean; portal: () => void }) {
  const st = STATUS[b.account.status] ?? { label: b.account.status, tone: "muted" as const };
  const pro = b.plans.find((p) => p.id === "pro");
  const left = b.gate.grace_ends_at ? Math.max(0, Math.ceil((b.gate.grace_ends_at - Date.now()) / DAY)) : null;
  const date = fmt.date(b.gate.grace_ends_at);
  const start = <StartPro disabled={!b.stripe_ready} />;
  const msg: Record<Stage, { label: ReactNode; title: string; text: ReactNode; action: ReactNode }> = {
    building: b.usage.projects.length ? { label: "Building", title: "Building and testing are free",
      text: "Start Pro before you release your app: it costs $0 until your apps make $10,000 a month. Sandbox and Test Store purchases never count.", action: start }
      // A teammate who owns no project: each project's owner starts Pro for it, so there is nothing to start here.
      : { label: "No projects of your own", title: "Building and testing are free",
        text: "Pro is started by the owner of each project. The projects you work on follow their owner's plan; projects you create are billed here.", action: null },
    grace: { label: <>Live{left !== null && <> · {left} day{left === 1 ? "" : "s"} left</>}</>, title: "Your app is live",
      text: <>Start Pro by <b>{date}</b> to keep live charts, customer data and webhooks running. It costs $0 until your apps make $10,000 a month.</>, action: start },
    paused: { label: "Paused", title: "Live data and webhooks are paused",
      text: "Your app still works and every purchase still unlocks. Start Pro to see your live charts and customers again and to send the held webhooks. It costs $0 until your apps make $10,000 a month.", action: start },
    pro: { label: <>Pro <Tag tone={st.tone}>{st.label}</Tag>{b.account.cancel_at && <span className="subtle"> Ends {utcDate(b.account.cancel_at)}</span>}</>, title: "You are on Pro",
      text: "$0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month. The card on file pays each month's bill.",
      action: <button type="button" className="btn btn-line" disabled={!b.stripe_ready || busy} onClick={portal}>{busy ? "Opening Stripe…" : "Manage billing"}</button> },
    enterprise: { label: "Enterprise", title: "You are on Enterprise",
      text: "Your price and invoices follow your contract. To change them, talk to sales.", action: <a className="btn btn-line" href={CONTACT_SALES} target="_blank" rel="noreferrer">Contact sales</a> },
  };
  const m = msg[stage];
  const onPro = stage === "pro";
  return (
    <section className={`bl-state ${stage}`} aria-labelledby="bl-state-h" data-stage={stage}>
      <div className="bl-state-m">
        <span className="label"><i className="sq" aria-hidden />{m.label}</span>
        <h2 id="bl-state-h">{m.title}</h2>
        <p>{m.text}</p>
        <div className="bl-state-a">{m.action}</div>
      </div>
      <div className="bl-nums" aria-label="This month">
        <div><span className="l">Tracked revenue, {monthName(b.usage.month)}</span><span className="v" data-tracked>{fmt.usdRaw(b.usage.tracked_revenue_usd, true)}</span><span className="d">Production purchases and renewals</span></div>
        <div><span className="l">{onPro ? "Bill so far" : stage === "enterprise" ? "Bill" : "Pro would cost"}</span>
          <span className="v" data-bill>{stage === "enterprise" ? "By contract" : fmt.usdRaw(onPro ? b.usage.bill_usd : b.usage.pro_bill_usd, true)}</span>
          <span className="d">{stage === "enterprise" ? "Invoiced under your contract" : onPro ? `0.5% above ${fmt.usdRaw(b.usage.free_up_to_usd)}, at most ${fmt.usdRaw(b.usage.cap_usd)}` : "You pay nothing without a plan"}</span></div>
        <div><span className="l">Month ends</span><span className="v">{utcDate(b.usage.period_end - 1)}</span><span className="d">{b.usage.computed_at ? `Updated ${fmt.ago(b.usage.computed_at)}` : "Measured hourly"}</span></div>
      </div>
      {stage !== "enterprise" && <div className="bl-state-s"><ProMeter tracked={b.usage.tracked_revenue_usd} free={b.usage.free_up_to_usd} cap={b.usage.cap_usd} rate={pro?.rate ?? 0.005} bill={onPro ? b.usage.bill_usd : b.usage.pro_bill_usd} /></div>}
    </section>
  );
}

export function BillingPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cloud = me.data?.account?.edition === "cloud";
  // Like the Billing link: only on Cloud once RevenueDot's Stripe is set up (`billing_ready`).
  // Back from Checkout: ?sync=1 makes the server read Stripe, so the plan shows even if the webhook is late.
  const returning = params.get("checkout") === "success";
  const q = useQuery({ queryKey: ["billing", returning], queryFn: () => api<Billing>(returning ? "/v2/billing?sync=1" : "/v2/billing"), enabled: cloud && !!me.data?.account?.billing_ready, refetchInterval: returning ? 3000 : false });
  useEffect(() => {
    const c = params.get("checkout");
    if (c === "success" || c === "cancelled") {
      // Once per return: a refresh or back-navigation within the 15 seconds the parameter stays must not count again.
      let seen = 0;
      try { seen = Number(sessionStorage.getItem("rd-checkout-returned") ?? 0); sessionStorage.setItem("rd-checkout-returned", String(Date.now())); } catch { /* ignore */ }
      if (Date.now() - seen > 60_000) track("checkout_returned", { result: c });
    }
    if (c === "success") toast("Thanks. Pro starts as soon as Stripe confirms your card.");
    if (c === "cancelled") toast("Checkout cancelled. Nothing changed.");
    if (c) { const t = setTimeout(() => { setParams({}, { replace: true }); void qc.invalidateQueries({ queryKey: ["me"] }); }, 15_000); return () => clearTimeout(t); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The plan changed (back from Checkout): the banners and panels that read /auth/me follow at once.
  const plan = q.data?.account.plan;
  useEffect(() => { if (plan && me.data?.account && me.data.account.plan !== plan) void qc.invalidateQueries({ queryKey: ["me"] }); }, [plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const portal = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ url: string }>("/v2/billing/portal", { method: "POST", json: {} });
      window.location.assign(r.url);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Stripe could not be reached. Try again."); setBusy(false); }
  };
  const b = q.data;
  const stage: Stage = !b ? "building" : b.account.plan === "enterprise" ? "enterprise" : b.account.plan === "pro" ? "pro" : b.gate.stage === "grace" || b.gate.stage === "paused" ? b.gate.stage : "building";
  const ready = cloud && !!me.data?.account?.billing_ready;
  return (
    <AccountLayout section="billing" sub={me.data ? (cloud ? `RevenueDot Cloud · ${me.data.user.email}` : `Self-hosted · ${me.data.user.email}`) : undefined}>
        {me.data && !cloud && <div className="banner" role="status">Billing is only on RevenueDot Cloud. This server is self-hosted, so it has no billing.</div>}
        {me.data && cloud && !ready && <div className="banner" role="status">Billing is not switched on yet, so nothing is billed.</div>}
        {q.isError && <div className="banner err" role="alert">Billing could not be loaded: {q.error instanceof Error ? q.error.message : ""}</div>}
        {q.isLoading && ready && <div className="panel pb subtle">Loading billing…</div>}
        {b && (
          <div className="stack">
            {b.flags.includes("past_due") && <div className="banner err" role="alert">Your last payment failed. Stripe tries again over the next days; your apps keep working. <button type="button" className="link-u" onClick={portal}>Update your card</button>.</div>}
            {b.flags.includes("unpaid") && <div className="banner err" role="alert">We could not collect your payment, so Pro has ended. Your apps keep working. Start Pro again below.</div>}
            {b.flags.includes("over_pro_limit") && <div className="banner warn" role="status">Your apps tracked more than {fmt.usdRaw(b.usage.ceiling_usd)} this month, above what Pro is for. <a className="link-u" href={CONTACT_SALES} target="_blank" rel="noreferrer">Talk to sales about Enterprise</a>.</div>}
            {!b.stripe_ready && <div className="banner" role="status">Billing is not switched on yet, so nothing is billed.</div>}
            {error && <div className="banner err" role="alert">{error}</div>}

            <StateCard b={b} stage={stage} busy={busy} portal={portal} />

            <section className="bl-plans" aria-label="Plans">
              {b.plans.map((p) => {
                const isCurrent = p.id === b.account.plan;
                const pro = p.id === "pro";
                return (
                  <div key={p.id} className={`bl-plan${isCurrent ? " current" : ""}`} data-plan={p.id}>
                    <span className="l">{p.name}{isCurrent && <Tag tone="gold">Current</Tag>}</span>
                    <span className="v">{pro ? "Start for free" : "Custom pricing"}</span>
                    <p>{pro ? p.description : "From $50,000 a year, for apps above $1M a month or with security, legal or support requirements."}</p>
                    {!!p.includes?.length && <ul className="bl-includes">{p.includes.map((x) => <li key={x}>{x}</li>)}</ul>}
                    <div className="bl-plan-a">
                      {pro && !isCurrent && b.account.plan !== "enterprise" && <StartPro disabled={!b.stripe_ready} />}
                      {pro && isCurrent && <button type="button" className="btn btn-line" disabled={!b.stripe_ready || busy} onClick={portal}>{busy ? "Opening Stripe…" : "Manage billing"}</button>}
                      {!pro && !isCurrent && <a className="btn btn-line" href={CONTACT_SALES} target="_blank" rel="noreferrer">Contact sales</a>}
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="panel" aria-labelledby="bl-projects">
              <div className="ph"><b id="bl-projects">Tracked revenue by project</b></div>
              <div className="pb"><p className="section-sub">Production purchases and renewals in {monthName(b.usage.month)}, in USD at the purchase-date rate. Sandbox purchases, trials and refunds do not count; refunds are not subtracted.</p></div>
              <div className="tbl"><table>
                <thead><tr><th>Project</th><th className="num">Transactions</th><th className="num">Tracked revenue</th></tr></thead>
                <tbody>{b.usage.projects.map((p) => <tr key={p.project_id}><td><Link to={`/projects/${p.project_id}/overview`}>{p.name ?? p.project_id}</Link></td><td className="num mono">{fmt.int(p.transactions)}</td><td className="num mono">{fmt.usdRaw(p.tracked_revenue_usd, true)}</td></tr>)}</tbody>
              </table></div>
            </section>

            <section className="panel" aria-labelledby="bl-invoices">
              <div className="ph"><b id="bl-invoices">Invoices</b>{b.account.has_payment_method && <button type="button" className="btn btn-line" disabled={!b.stripe_ready || busy} onClick={portal}>Payment methods</button>}</div>
              {b.invoices.length ? (
                <div className="tbl"><table>
                  <thead><tr><th>Date</th><th>Number</th><th>Status</th><th className="num">Amount</th><th aria-label="Links" /></tr></thead>
                  <tbody>{b.invoices.map((i) => (
                    <tr key={i.id}><td>{fmt.date(i.created_at)}</td><td className="mono">{i.number ?? "—"}</td>
                      <td>{i.status === "paid" ? <Tag tone="up">Paid</Tag> : i.status === "open" ? <Tag tone="down">Open</Tag> : <Tag>{i.status}</Tag>}</td>
                      <td className="num mono">{fmt.usdRaw(i.amount_due, true)}</td>
                      <td className="actions-cell">{i.hosted_invoice_url && <a className="btn btn-line" href={i.hosted_invoice_url} target="_blank" rel="noreferrer">View</a>}{i.invoice_pdf && <a className="btn btn-line" href={i.invoice_pdf} target="_blank" rel="noreferrer">PDF</a>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <div className="pb subtle">No invoices yet. Pro invoices arrive at the start of each month, and they are $0 until your apps make $10,000 in a month.</div>}
            </section>
            <p className="subtle">Amounts are in USD, the currency RevenueDot Cloud bills in. Prices: <a className="link-u" href="https://revenuedot.app/pricing" target="_blank" rel="noreferrer">revenuedot.app/pricing</a>.</p>
          </div>
        )}
        <OwnedProjects />
    </AccountLayout>
  );
}

interface AccountProject { id: string; name: string; role: string; is_owner: boolean; members: number; owner: { id: string; name: string | null; email: string } | null; plan: { id: string; name: string } }
const ROLE: Record<string, string> = { admin: "Admin", developer: "Developer", viewer: "Viewer" };

/** RevenueCat's "Owned projects" (project, role, plan), then the projects this person is a member of. */
function OwnedProjects() {
  const q = useQuery({ queryKey: ["account-projects"], queryFn: () => api<{ edition: string; items: AccountProject[] }>("/auth/account/projects") });
  const owned = q.data?.items.filter((p) => p.is_owner) ?? [];
  const member = q.data?.items.filter((p) => !p.is_owner) ?? [];
  const table = (rows: AccountProject[], ownerCol: boolean) => (
    <div className="tbl"><table>
      <thead><tr><th>Project</th><th>Your role</th>{ownerCol && <th>Owner</th>}<th>Members</th><th>Plan</th></tr></thead>
      <tbody>{rows.map((p) => (
        <tr key={p.id} data-account-project={p.id}>
          <td><Link to={`/projects/${p.id}/overview`}>{p.name}</Link></td>
          <td>{ROLE[p.role] ?? p.role}</td>
          {ownerCol && <td>{p.owner ? (p.owner.name || p.owner.email) : "—"}</td>}
          <td className="num mono">{p.members}</td>
          <td>{p.plan.name}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
  return (
    <>
      <section className="panel" aria-labelledby="owned-h">
        <div className="ph"><b id="owned-h">Owned projects</b><Link className="btn btn-line" to="/projects/new">New project</Link></div>
        {q.isError ? <div className="pb"><div className="banner err" role="alert">{q.error instanceof Error ? q.error.message : "Could not load projects."}</div></div>
          : !q.data ? <div className="pb subtle">Loading…</div>
          : owned.length ? table(owned, false) : <div className="pb subtle">You do not own a project. Projects you create, or that are transferred to you, appear here.</div>}
      </section>
      {member.length > 0 && <section className="panel" aria-labelledby="member-h"><div className="ph"><b id="member-h">Projects you are a member of</b></div>{table(member, true)}</section>}
    </>
  );
}
