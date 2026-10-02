import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../components/Shell";
import { Tag, useToast } from "../components/ui";
import { AccountLayout } from "./account/AccountLayout";
import { api, ApiError, fmt } from "../lib/api";
import "./billing.css";

/**
 * Account settings → Billing (/account/billing; prd/account-settings §2): the projects this person owns and belongs to with
 * role and plan, then on RevenueDot Cloud with billing set up (prd/cloud-billing/PRD.md): the plan and its state, this month's tracked
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
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cloud = me.data?.account?.edition === "cloud";
  // Like the Billing link: only on Cloud once RevenueDot's Stripe is set up (`billing_ready`).
  const q = useQuery({ queryKey: ["billing"], queryFn: () => api<Billing>("/v2/billing"), enabled: cloud && !!me.data?.account?.billing_ready, refetchInterval: params.get("checkout") === "success" ? 3000 : false });
  useEffect(() => {
    const c = params.get("checkout");
    if (c === "success") toast("Thanks. Your plan changes as soon as Stripe confirms the payment.");
    if (c === "cancelled") toast("Checkout cancelled. Nothing changed.");
    if (c) { const t = setTimeout(() => { setParams({}, { replace: true }); void qc.invalidateQueries({ queryKey: ["me"] }); }, 15_000); return () => clearTimeout(t); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
  const ready = cloud && !!me.data?.account?.billing_ready;
  return (
    <AccountLayout section="billing" sub={me.data ? (cloud ? `RevenueDot Cloud · ${me.data.user.email}` : `Self-hosted · ${me.data.user.email}`) : undefined}>
        <OwnedProjects />
        {me.data && !cloud && <div className="banner" role="status">Billing is only on RevenueDot Cloud. This server is self-hosted: free and unmetered, with no limits.</div>}
        {me.data && cloud && !ready && <div className="banner" role="status">Billing is not switched on yet: RevenueDot Cloud is free for every account until it is.</div>}
        {q.isError && <div className="banner err" role="alert">Billing could not be loaded: {q.error instanceof Error ? q.error.message : ""}</div>}
        {b && (
          <div className="stack">
            {b.flags.includes("past_due") && <div className="banner err" role="alert">Your last payment failed. Stripe tries again over the next days; your apps keep working. <button type="button" className="link-u" onClick={() => go("portal")}>Update your card</button>.</div>}
            {b.flags.includes("unpaid") && <div className="banner err" role="alert">We could not collect your payment, so your account is back on Cloud Free. Your apps keep working. Upgrade again below.</div>}
            {b.flags.includes("over_free_limit") && b.stripe_ready && <div className="banner warn" role="status">Your apps tracked {fmt.usdRaw(b.usage.tracked_revenue_usd)} this month, above Cloud Free's {fmt.usdRaw(b.usage.free_limit_usd)}. Nothing stops working; upgrade to Cloud Standard ({fmt.usdRaw(b.usage.standard_bill_usd, true)} this month so far).</div>}
            {b.flags.includes("over_standard_limit") && <div className="banner warn" role="status">Your apps tracked more than {fmt.usdRaw(b.usage.ceiling_usd)} this month. Write to <a href="mailto:hello@revenuedot.app">hello@revenuedot.app</a> to move to Enterprise.</div>}
            {!b.stripe_ready && <div className="banner" role="status">Billing is not switched on yet: RevenueDot Cloud is free for every account until it is.</div>}
            {error && <div className="banner err" role="alert">{error}</div>}

            <section className="bl-grid" aria-label="This month">
              <div><span className="l">Plan</span><span className="v name">{current?.name ?? "Cloud Free"}</span><span className="d"><Tag tone={STATUS[b.account.status]?.tone ?? "muted"}>{STATUS[b.account.status]?.label ?? b.account.status}</Tag>{b.account.cancel_at && <span className="subtle"> Ends {fmt.date(b.account.cancel_at)}</span>}</span></div>
              <div><span className="l">Tracked revenue, {monthName(b.usage.month)}</span><span className="v" data-tracked>{fmt.usdRaw(b.usage.tracked_revenue_usd, true)}</span>
                {limit ? <><Meter value={b.usage.tracked_revenue_usd} max={limit} label="Tracked revenue against the plan's limit" /><span className="d mono">{Math.round((b.usage.tracked_revenue_usd / limit) * 100)}% of {fmt.usdRaw(limit)}</span></> : <span className="d">No limit</span>}</div>
              <div><span className="l">Bill so far</span><span className="v" data-bill>{b.account.plan === "enterprise" ? "By contract" : fmt.usdRaw(b.usage.bill_usd, true)}</span><span className="d">{b.account.plan === "standard" ? `0.5% above ${fmt.usdRaw(b.usage.free_limit_usd)}, at most ${fmt.usdRaw(b.usage.cap_usd)}` : b.account.plan === "free" ? `${fmt.usdRaw(b.usage.standard_bill_usd, true)} on Cloud Standard` : ""}</span></div>
              <div><span className="l">Month ends</span><span className="v">{fmt.date(b.usage.period_end - 1)}</span><span className="d">{b.usage.computed_at ? `Updated ${fmt.ago(b.usage.computed_at)}` : "Measured hourly"}</span></div>
            </section>

            <section className="panel" aria-labelledby="bl-projects">
              <div className="ph"><b id="bl-projects">Tracked revenue by project</b></div>
              <div className="pb"><p className="section-sub">Production purchases and renewals in {monthName(b.usage.month)}, in USD at the purchase-date rate. Sandbox purchases, trials and refunds do not count; refunds are not subtracted.</p></div>
              <div className="tbl"><table>
                <thead><tr><th>Project</th><th className="num">Transactions</th><th className="num">Tracked revenue</th></tr></thead>
                <tbody>{b.usage.projects.map((p) => <tr key={p.project_id}><td><Link to={`/projects/${p.project_id}/overview`}>{p.name ?? p.project_id}</Link></td><td className="num mono">{fmt.int(p.transactions)}</td><td className="num mono">{fmt.usdRaw(p.tracked_revenue_usd, true)}</td></tr>)}</tbody>
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
                      <td className="num mono">{fmt.usdRaw(i.amount_due, true)}</td>
                      <td className="actions-cell">{i.hosted_invoice_url && <a className="btn btn-line" href={i.hosted_invoice_url} target="_blank" rel="noreferrer">View</a>}{i.invoice_pdf && <a className="btn btn-line" href={i.invoice_pdf} target="_blank" rel="noreferrer">PDF</a>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <div className="pb subtle">No invoices yet. Cloud Free has none; Cloud Standard invoices arrive at the start of each month.</div>}
            </section>
            <p className="subtle">Self-hosting stays free with no limits. Amounts are in USD, the currency RevenueDot Cloud bills in. Prices: <a href="https://revenuedot.app/pricing" target="_blank" rel="noreferrer">revenuedot.app/pricing</a>.</p>
          </div>
        )}
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
