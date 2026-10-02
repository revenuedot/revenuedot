import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell, useMe } from "../components/Shell";
import { PageHead, Tag, useToast } from "../components/ui";
import { api, ApiError, fmt } from "../lib/api";
import "./billing.css";

/**
 * Billing (/account/billing, RevenueDot Cloud only; prd/cloud-billing/PRD.md): the plan and its state, this month's tracked
 * revenue against the plan's limit, the bill so far, the plans with Upgrade (Stripe Checkout), Manage billing (Customer
 * Portal) or Contact us, and invoices. Self-hosted servers have no billing.
 */

interface Plan { id: "free" | "standard" | "enterprise"; name: string; price_label: string; description: string; limit_usd: number | null; self_serve: boolean }
interface Billing {
  account: { plan: Plan["id"]; status: string; cancel_at: number | null; current_period_end: number | null; has_payment_method: boolean };
  plans: Plan[];
  usage: { month: string; tracked_revenue_usd: number; projects: { project_id: string; name: string | null; tracked_revenue_usd: number; transactions: number }[]; bill_usd: number; standard_bill_usd: number; free_limit_usd: number; cap_usd: number; ceiling_usd: number; period_end: number; computed_at: number | null };
  flags: string[];
  invoices: { id: string; number: string | null; status: string; amount_due: number; amount_paid: number; period_end: number | null; hosted_invoice_url: string | null; invoice_pdf: string | null; created_at: number }[];
  stripe_ready: boolean; stripe_problem: string | null;
}

const STATUS: Record<string, { label: string; tone: "up" | "down" | "info" | "gold" | "muted" }> = {
  active: { label: "Active", tone: "up" }, past_due: { label: "Payment failed", tone: "down" }, unpaid: { label: "Unpaid", tone: "down" }, canceled: { label: "Cancelled", tone: "muted" }, none: { label: "Free", tone: "muted" },
};
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.min(100, max ? (value / max) * 100 : 0);
  return (
    <div className="bl-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)}>
      <span style={{ width: `${pct}%` }} className={value > max ? "over" : ""} />
    </div>
  );
}

export function BillingPage() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cloud = me.data?.account?.edition === "cloud";
  const q = useQuery({ queryKey: ["billing"], queryFn: () => api<Billing>("/v2/billing"), enabled: cloud, refetchInterval: params.get("checkout") === "success" ? 3000 : false });
  useEffect(() => {
    const c = params.get("checkout");
    if (c === "success") toast("Thanks. Your plan changes as soon as Stripe confirms the payment.");
    if (c === "cancelled") toast("Checkout cancelled. Nothing changed.");
    if (c) { const t = setTimeout(() => { setParams({}, { replace: true }); void qc.invalidateQueries({ queryKey: ["me"] }); }, 15_000); return () => clearTimeout(t); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  let last = "";
  try { last = localStorage.getItem("rd-last-project") ?? ""; } catch { /* ignore */ }
  const pid = me.data?.projects.find((p) => p.id === last)?.id ?? me.data?.projects[0]?.id ?? "";
  useEffect(() => { if (me.data && !pid) nav("/account"); }, [me.data, pid, nav]);
  const go = async (what: "checkout" | "portal") => {
    setBusy(what); setError(null);
    try {
      const r = await api<{ url: string }>(`/v2/billing/${what}`, { method: "POST", json: what === "checkout" ? { plan: "standard" } : {} });
      window.location.assign(r.url);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Stripe could not be reached. Try again."); setBusy(null); }
  };
  const b = q.data;
  const current = b?.plans.find((p) => p.id === b.account.plan);
  const limit = b ? (b.account.plan === "free" ? b.usage.free_limit_usd : b.usage.ceiling_usd) : 0;
  return (
    <Shell title="Billing" projectId={pid} crumbs={<><span>Account</span> <span className="crumb-sep">/</span> <b>Billing</b></>}>
      <div className="page narrow">
        <PageHead title="Billing" sub={me.data ? `RevenueDot Cloud · ${me.data.user.email}` : undefined} />
        {me.data && !cloud && <div className="banner" role="status">Billing is only on RevenueDot Cloud. This server is self-hosted: free and unmetered, with no limits.</div>}
        {q.isError && <div className="banner err" role="alert">Billing could not be loaded: {q.error instanceof Error ? q.error.message : ""}</div>}
        {b && (
          <div className="stack">
            {b.flags.includes("past_due") && <div className="banner err" role="alert">Your last payment failed. Stripe tries again over the next days; your apps keep working. <button type="button" className="link-u" onClick={() => go("portal")}>Update your card</button>.</div>}
            {b.flags.includes("unpaid") && <div className="banner err" role="alert">We could not collect your payment, so your account is back on Cloud Free. Your apps keep working. Upgrade again below.</div>}
            {b.flags.includes("over_free_limit") && <div className="banner warn" role="status">Your apps tracked {fmt.usd(b.usage.tracked_revenue_usd)} this month, above Cloud Free's {fmt.usd(b.usage.free_limit_usd)}. Nothing stops working; upgrade to Cloud Standard ({fmt.usd(b.usage.standard_bill_usd, true)} this month so far).</div>}
            {b.flags.includes("over_standard_limit") && <div className="banner warn" role="status">Your apps tracked more than {fmt.usd(b.usage.ceiling_usd)} this month. Write to <a href="mailto:hello@revenuedot.app">hello@revenuedot.app</a> to move to Enterprise.</div>}
            {!b.stripe_ready && <div className="banner" role="status">{b.stripe_problem}</div>}
            {error && <div className="banner err" role="alert">{error}</div>}

            <section className="bl-grid" aria-label="This month">
              <div><span className="l">Plan</span><span className="v">{current?.name ?? "Cloud Free"}</span><span className="d"><Tag tone={STATUS[b.account.status]?.tone ?? "muted"}>{STATUS[b.account.status]?.label ?? b.account.status}</Tag>{b.account.cancel_at && <span className="subtle"> Ends {fmt.date(b.account.cancel_at)}</span>}</span></div>
              <div><span className="l">Tracked revenue, {monthName(b.usage.month)}</span><span className="v" data-tracked>{fmt.usd(b.usage.tracked_revenue_usd, true)}</span>
                {limit ? <><Meter value={b.usage.tracked_revenue_usd} max={limit} label="Tracked revenue against the plan's limit" /><span className="d mono">{Math.round((b.usage.tracked_revenue_usd / limit) * 100)}% of {fmt.usd(limit)}</span></> : <span className="d">No limit</span>}</div>
              <div><span className="l">Bill so far</span><span className="v" data-bill>{b.account.plan === "enterprise" ? "By contract" : fmt.usd(b.usage.bill_usd, true)}</span><span className="d">{b.account.plan === "standard" ? `0.5% above ${fmt.usd(b.usage.free_limit_usd)}, at most ${fmt.usd(b.usage.cap_usd)}` : b.account.plan === "free" ? `${fmt.usd(b.usage.standard_bill_usd, true)} on Cloud Standard` : ""}</span></div>
              <div><span className="l">Month ends</span><span className="v">{fmt.date(b.usage.period_end - 1)}</span><span className="d">{b.usage.computed_at ? `Updated ${fmt.ago(b.usage.computed_at)}` : "Measured hourly"}</span></div>
            </section>

            <section className="panel" aria-labelledby="bl-projects">
              <div className="ph"><b id="bl-projects">Tracked revenue by project</b></div>
              <div className="pb"><p className="section-sub">Production purchases and renewals in {monthName(b.usage.month)}, in USD at the purchase-date rate. Sandbox purchases, trials and refunds do not count; refunds are not subtracted.</p></div>
              <div className="tbl"><table>
                <thead><tr><th>Project</th><th className="num">Transactions</th><th className="num">Tracked revenue</th></tr></thead>
                <tbody>{b.usage.projects.map((p) => <tr key={p.project_id}><td><Link to={`/projects/${p.project_id}/overview`}>{p.name ?? p.project_id}</Link></td><td className="num mono">{fmt.int(p.transactions)}</td><td className="num mono">{fmt.usd(p.tracked_revenue_usd, true)}</td></tr>)}</tbody>
              </table></div>
            </section>

            <section className="bl-plans" aria-label="Plans">
              {b.plans.map((p) => {
                const isCurrent = p.id === b.account.plan;
                return (
                  <div key={p.id} className={`bl-plan${isCurrent ? " current" : ""}`} data-plan={p.id}>
                    <span className="l">{p.name}{isCurrent && <Tag tone="gold">Current</Tag>}</span>
                    <span className="v">{p.price_label}</span>
                    <p>{p.description}</p>
                    {p.id === "standard" && !isCurrent && <button type="button" className="btn btn-dark" disabled={!b.stripe_ready || busy !== null} onClick={() => go("checkout")}>{busy === "checkout" ? "Opening Stripe…" : "Upgrade to Standard"}</button>}
                    {p.id === "standard" && isCurrent && <button type="button" className="btn btn-line" disabled={!b.stripe_ready || busy !== null} onClick={() => go("portal")}>{busy === "portal" ? "Opening Stripe…" : "Manage billing"}</button>}
                    {p.id === "enterprise" && !isCurrent && <a className="btn btn-line" href="mailto:hello@revenuedot.app?subject=RevenueDot%20Enterprise">Contact us</a>}
                    {p.id === "free" && !isCurrent && b.account.has_payment_method && <button type="button" className="btn btn-line" disabled={!b.stripe_ready || busy !== null} onClick={() => go("portal")}>Cancel in the billing portal</button>}
                  </div>
                );
              })}
            </section>

            <section className="panel" aria-labelledby="bl-invoices">
              <div className="ph"><b id="bl-invoices">Invoices</b>{b.account.has_payment_method && <button type="button" className="btn btn-line" disabled={!b.stripe_ready || busy !== null} onClick={() => go("portal")}>Payment methods</button>}</div>
              {b.invoices.length ? (
                <div className="tbl"><table>
                  <thead><tr><th>Date</th><th>Number</th><th>Status</th><th className="num">Amount</th><th aria-label="Links" /></tr></thead>
                  <tbody>{b.invoices.map((i) => (
                    <tr key={i.id}><td>{fmt.date(i.created_at)}</td><td className="mono">{i.number ?? "—"}</td>
                      <td>{i.status === "paid" ? <Tag tone="up">Paid</Tag> : i.status === "open" ? <Tag tone="down">Open</Tag> : <Tag>{i.status}</Tag>}</td>
                      <td className="num mono">{fmt.usd(i.amount_due, true)}</td>
                      <td className="actions-cell">{i.hosted_invoice_url && <a className="btn btn-line" href={i.hosted_invoice_url} target="_blank" rel="noreferrer">View</a>}{i.invoice_pdf && <a className="btn btn-line" href={i.invoice_pdf} target="_blank" rel="noreferrer">PDF</a>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <div className="pb subtle">No invoices yet. Cloud Free has none; Cloud Standard invoices arrive at the start of each month.</div>}
            </section>
            <p className="subtle">Self-hosting stays free with no limits. Prices: <a href="https://revenuedot.app/pricing" target="_blank" rel="noreferrer">revenuedot.app/pricing</a>.</p>
          </div>
        )}
      </div>
    </Shell>
  );
}
