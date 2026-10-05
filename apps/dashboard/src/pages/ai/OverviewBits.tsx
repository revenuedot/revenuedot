import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../components/icons";
import { Switch, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { aiBase, useAiStatus, type Conversation, type PendingMessage } from "./data";
import "../analytics/analytics.css";

/**
 * The Overview's AI bar (DESIGN.md §5, prd/ai-assistant/PRD.md §3): a 44px hairline box with the gold sparkle. Enter
 * starts a conversation with the question and opens it on /ai. `/` focuses it from anywhere on the page.
 */
export function AskBar({ pid }: { pid: string }) {
  const status = useAiStatus(pid);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const s = status.data;
  if (s && !s.available) {
    return (
      <button type="button" className="ask" onClick={() => nav(`/projects/${pid}/ai`)} aria-label="RevenueDot AI">
        <Icon name="spark" /><span className="q">{s.configured ? s.reason : "RevenueDot AI is off on this server. Set a model key to turn it on."}</span>
      </button>
    );
  }
  const ask = async () => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const conv = await api<Conversation>(`${aiBase(pid)}/conversations`, { method: "POST", json: {} });
      await qc.invalidateQueries({ queryKey: ["ai-conversations", pid] });
      const pending: PendingMessage = { text, files: [] };
      nav(`/projects/${pid}/ai/${conv.id}`, { state: { pending } });
    } catch (e) {
      toast(e instanceof Error ? e.message : "RevenueDot AI could not start.");
      setBusy(false);
    }
  };
  return (
    <form className="ask ask-live" role="search" aria-label="Ask RevenueDot AI" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <Icon name="spark" />
      <input ref={ref} className="q" value={q} onChange={(e) => setQ(e.target.value)} disabled={busy} aria-label="Ask about insights or growth opportunities"
        placeholder={'Ask about insights or growth opportunities. "Why did trial conversion drop this week?"'} />
      <kbd>/</kbd>
    </form>
  );
}

interface FirstSale { id: string; project_name: string; product: string; store: string; amount: number | null; currency: string | null; revenue_usd: number; purchased_at: number; share_url: string; image_url: string; dismissed: boolean }

/** The price paid in the store's currency; a currency code Intl does not know falls back to the USD revenue. */
function priceOf(card: FirstSale) {
  if (card.amount !== null && card.currency) {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: card.currency }).format(card.amount); } catch { /* unknown code */ }
  }
  return fmt.usd(card.revenue_usd, true);
}

/** The first-sale card (prd/ai-assistant/PRD.md §4): shown on the Overview until dismissed, with a public share link. */
export function FirstSaleCard({ pid }: { pid: string }) {
  const q = useQuery({ queryKey: ["first-sale", pid], queryFn: () => api<{ card: FirstSale | null }>(`${aiBase(pid)}/first_sale`).then((r) => r.card), enabled: !!pid, meta: { gate: "ignore" } });
  const qc = useQueryClient();
  const status = useAiStatus(pid);
  const [copied, setCopied] = useState(false);
  const card = q.data;
  if (!card || card.dismissed) return null;
  const price = priceOf(card);
  // Hiding the card hides it for the whole project, so viewers (who cannot change the project) do not get the button.
  const canDismiss = status.data ? status.data.role !== "viewer" : false;
  const share = async () => {
    const data = { title: `${card.project_name} made its first sale`, url: card.share_url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(card.share_url); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    } catch { /* cancelled */ }
  };
  return (
    <div className="first-sale" role="status" data-testid="first-sale">
      <span className="dot" aria-hidden />
      <div className="t">
        <b>First sale: {price}</b>
        <span className="subtle">{card.product} · {new Date(card.purchased_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}. Share the moment.</span>
      </div>
      <a className="btn btn-line" href={card.share_url} target="_blank" rel="noreferrer">View card</a>
      <button type="button" className="btn" onClick={share}>{copied ? "Link copied" : "Share"}</button>
      {canDismiss && <button type="button" className="ib" aria-label="Dismiss" onClick={async () => { await api(`${aiBase(pid)}/first_sale/dismiss`, { method: "POST" }).catch(() => {}); await qc.invalidateQueries({ queryKey: ["first-sale", pid] }); }}><Icon name="close" /></button>}
    </div>
  );
}

interface InsightNumber { id: string; label: string; unit: "$" | "%" | "#"; value: number | null; previous: number | null; change_pct: number | null; window: string; lower_is_better?: boolean }
interface Insight { id: string; title: string; finding: string; recommendation: string; numbers: InsightNumber[]; link: string; ask: string }
interface InsightsResp {
  available: boolean; reason: string | null; week: string; status: "none" | "running" | "ready" | "error"; error: string | null; insights_week: string | null; stale: boolean;
  generated_at: number | null; provider: string | null; model: string | null; insights: Insight[]; can_refresh: boolean; digest: { available: boolean; subscribed: boolean | null };
}

const numText = (n: InsightNumber) => {
  if (n.value === null) return "n/a";
  if (n.unit === "$") return n.value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(n.value) < 100 ? 2 : 0 });
  if (n.unit === "%") return `${n.value.toFixed(1)}%`;
  return n.value.toLocaleString("en-US");
};
const weekLabel = (w: string) => new Date(`${w}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Growth insights (prd/attribution-benchmarks-insights §3): this week's 3 to 5 recommendations from RevenueDot AI, under
 * the Ask bar. The numbers come from the server's data pack, not the model's text. Read from the weekly cache; Refresh
 * (admins and developers, once an hour) writes them again. Ask about this opens a conversation with the question.
 */
export function GrowthInsights({ pid }: { pid: string }) {
  const q = useQuery({ queryKey: ["ai-insights", pid], enabled: !!pid, meta: { gate: "ignore" }, queryFn: () => api<InsightsResp>(`${aiBase(pid)}/insights`) });
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const d = q.data;
  if (!d || !d.available) return null;
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api<InsightsResp>(`${aiBase(pid)}/insights/refresh`, { method: "POST" });
      qc.setQueryData(["ai-insights", pid], r);
    } catch (e) {
      toast(e instanceof Error ? e.message : "The insights could not be written.");
      await qc.invalidateQueries({ queryKey: ["ai-insights", pid] });
    } finally { setBusy(false); }
  };
  const ask = async (text: string) => {
    try {
      const conv = await api<Conversation>(`${aiBase(pid)}/conversations`, { method: "POST", json: {} });
      await qc.invalidateQueries({ queryKey: ["ai-conversations", pid] });
      nav(`/projects/${pid}/ai/${conv.id}`, { state: { pending: { text, files: [] } satisfies PendingMessage } });
    } catch (e) { toast(e instanceof Error ? e.message : "RevenueDot AI could not start."); }
  };
  const setDigest = async (on: boolean) => {
    try {
      await api("/auth/me", { method: "POST", json: { insights_emails: on } });
      qc.setQueryData(["ai-insights", pid], { ...d, digest: { ...d.digest, subscribed: on } });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast(on ? "You will get the weekly digest by email." : "The weekly digest is off.");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not save."); }
  };
  const running = busy || d.status === "running";
  // The server writes a week's insights at most once an hour; the button says when it can again instead of failing.
  const nextAt = d.status === "ready" && !d.stale && d.generated_at ? d.generated_at + 3_600_000 : 0;
  const wait = nextAt > Date.now();
  return (
    <section className="ins" aria-label="Growth insights" data-testid="growth-insights" aria-busy={running}>
      <div className="ins-h">
        <b><Icon name="spark" />Growth insights{d.insights_week && <span className="sub">week of {weekLabel(d.insights_week)}{d.stale ? " (last week)" : ""}</span>}</b>
        <div className="r">
          {d.digest.available && d.digest.subscribed !== null && <Switch label="Email me weekly" checked={!!d.digest.subscribed} onChange={setDigest} />}
          {d.can_refresh && <button type="button" className="btn btn-line" disabled={running || wait} onClick={refresh}
            title={wait ? `Written ${new Date(d.generated_at!).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. Refresh again after ${new Date(nextAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.` : undefined}>
            <Icon name="refresh" />{running ? "Writing…" : d.insights.length ? "Refresh" : "Write insights"}</button>}
        </div>
      </div>
      {d.status === "error" && d.error && <div className="banner err" role="alert" style={{ border: 0, borderBottom: "1px solid var(--border)" }}>This week's insights could not be written: {d.error}</div>}
      {running && !d.insights.length && <div className="ins-empty" aria-live="polite"><span className="sk line" /></div>}
      {!running && !d.insights.length && (
        <div className="ins-empty">
          <span>RevenueDot AI reads your charts each Monday and suggests 3 to 5 things to act on, with the numbers behind them.{d.can_refresh ? " Write this week's now." : ""}</span>
        </div>
      )}
      {d.insights.length > 0 && (
        <ol className="ins-list">
          {d.insights.map((i) => (
            <li className="ins-i" key={i.id} data-insight={i.id}>
              <div style={{ minWidth: 0 }}>
                <h3>{i.title}</h3>
                <div className="ins-nums">
                  {i.numbers.map((n) => {
                    const good = n.change_pct === null ? null : n.lower_is_better ? n.change_pct < 0 : n.change_pct > 0;
                    return (
                      <span className="ins-num" key={n.id} title={`${n.label}: ${n.window}`}>
                        <span className="l">{n.label.replace(/\s*\(.*\)$/, "").replace(/:.*$/, "")}</span><b>{numText(n)}</b>
                        {n.change_pct !== null && <span className={`d ${good ? "up" : good === false ? "down" : ""}`}>{n.change_pct > 0 ? "+" : n.change_pct < 0 ? "−" : ""}{Math.abs(n.change_pct).toFixed(1)}%</span>}
                      </span>
                    );
                  })}
                </div>
                <p>{i.finding}</p>
                <p className="do"><b>Do</b>{i.recommendation}</p>
              </div>
              <div className="ins-go">
                <Link className="btn btn-line" to={i.link}>Open</Link>
                <button type="button" className="btn btn-ghost" onClick={() => ask(i.ask)}>Ask about this</button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
