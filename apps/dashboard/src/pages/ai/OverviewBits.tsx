import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../components/icons";
import { useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { aiBase, useAiStatus, type Conversation, type PendingMessage } from "./data";

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

/** The first-sale card (prd/ai-assistant/PRD.md §4): shown on the Overview until dismissed, with a public share link. */
export function FirstSaleCard({ pid }: { pid: string }) {
  const q = useQuery({ queryKey: ["first-sale", pid], queryFn: () => api<{ card: FirstSale | null }>(`${aiBase(pid)}/first_sale`).then((r) => r.card), enabled: !!pid });
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const card = q.data;
  if (!card || card.dismissed) return null;
  const price = card.amount !== null && card.currency ? new Intl.NumberFormat("en-US", { style: "currency", currency: card.currency }).format(card.amount) : `$${card.revenue_usd.toFixed(2)}`;
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
      <button type="button" className="ib" aria-label="Dismiss" onClick={async () => { await api(`${aiBase(pid)}/first_sale/dismiss`, { method: "POST" }); await qc.invalidateQueries({ queryKey: ["first-sale", pid] }); }}><Icon name="close" /></button>
    </div>
  );
}
