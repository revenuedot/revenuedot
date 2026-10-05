import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { api, ApiError, fmt } from "../lib/api";
import { useToast } from "./ui";

/**
 * Cloud's go-live gate in the dashboard (prd/cloud-billing/PRD.md, "The go-live gate"). Live data of a paused project
 * answers 402 `plan_required`; the page keeps its head (period, Sandbox switch) and shows one panel instead of its data.
 * Editing paywalls, experiments and targeting answers 402 too; those saves open the same message in a dialog (Shell).
 */

export type GateStage = "off" | "building" | "grace" | "paused" | "active";
export interface Gate { stage: GateStage; live_at: number | null; grace_ends_at: number | null }
export interface ProjectGate extends Gate { owner_is_you: boolean; owner_name: string | null }

/** The one sentence about Pro's price, used everywhere the dashboard asks for Pro. */
export const PRO_PRICE = "Pro costs $0 until your apps make $10,000 a month.";
export const CARD_NOTE = "$0 today. Card required.";

export function isPlanRequired(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 402 && !!e.body && typeof e.body === "object" && (e.body as { type?: unknown }).type === "plan_required";
}

/** Starts Pro: Stripe Checkout through POST /v2/billing/checkout, then the browser leaves for Stripe. */
export function useStartPro() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/v2/billing/checkout", { method: "POST", json: { plan: "pro" } });
      window.location.assign(r.url);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Stripe could not be reached. Try again.");
      setBusy(false);
    }
  };
  return { start, busy };
}

/** The dashboard's "Start Pro" button with its price note under it. */
export function StartPro({ note = true, size, disabled }: { note?: boolean; size?: "lg"; disabled?: boolean }) {
  const { start, busy } = useStartPro();
  return (
    <span className="start-pro">
      <button type="button" className={`btn btn-dark${size === "lg" ? " btn-lg" : ""}`} disabled={busy || disabled} onClick={start} data-start-pro>{busy ? "Opening Stripe…" : "Start Pro"}</button>
      {note && <small>{CARD_NOTE}</small>}
    </span>
  );
}

/* ---------- Which queries count ---------- */

/**
 * A query the open page uses and has turned on (a query switched off by the Sandbox switch keeps its old error). A query
 * opts out with `meta: { gate: "ignore" }` (suggestions and other extras that fail quietly).
 */
const counts = (q: Query) => q.isActive() && q.state.status === "error" && isPlanRequired(q.state.error) && q.meta?.gate !== "ignore";

/** The server's message when a query the open page uses was refused with plan_required, else null. */
export function usePlanBlock(): string | null {
  const qc = useQueryClient();
  const cache = qc.getQueryCache();
  return useSyncExternalStore(
    (cb) => cache.subscribe(cb),
    () => { const q = cache.getAll().find(counts); return q ? (q.state.error as ApiError).message : null; },
  );
}

/* ---------- The panel ---------- */

interface Ctx { message: string | null; owner: boolean; ownerName: string | null; register: () => () => void }
const PlanCtx = createContext<Ctx>({ message: null, owner: true, ownerName: null, register: () => () => {} });

/** Shell provides it: whether the open page is blocked, and whether the viewer can start Pro for this project. */
export function PlanProvider({ gate, children, render }: { gate: ProjectGate | null; children: ReactNode; render: (fallback: ReactNode) => ReactNode }) {
  const message = usePlanBlock();
  const [slots, setSlots] = useState(0);
  const owner = gate ? gate.owner_is_you : true;
  const ctx: Ctx = { message, owner, ownerName: gate?.owner_name ?? null, register: () => { setSlots((n) => n + 1); return () => setSlots((n) => n - 1); } };
  // Pages that place no slot under their head still get the panel, at the top.
  const fallback = message && slots === 0 ? <PlanRequiredPanel message={message} owner={owner} ownerName={ctx.ownerName} /> : null;
  return <PlanCtx.Provider value={ctx}>{render(<>{fallback}{children}</>)}</PlanCtx.Provider>;
}

/**
 * Where a page shows the panel: right under its head. Everything after it on the page is hidden while it shows (CSS
 * `.plan-req ~ *`), so the head's period and Sandbox switches keep working. `onSandbox` adds "Show sandbox data".
 */
export function PlanSlot({ onSandbox }: { onSandbox?: () => void }) {
  const c = useContext(PlanCtx);
  const { register } = c;
  useEffect(() => register(), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c.message) return null;
  return <PlanRequiredPanel message={c.message} owner={c.owner} ownerName={c.ownerName} onSandbox={onSandbox} />;
}

export function PlanRequiredPanel({ message, owner, ownerName, onSandbox }: { message: string; owner: boolean; ownerName: string | null; onSandbox?: () => void }) {
  return (
    <section className="plan-req" role="region" aria-labelledby="plan-req-h" data-plan-required>
      <span className="label"><i className="sq" aria-hidden />Live data paused</span>
      <h2 id="plan-req-h">{owner ? "Start Pro to see your live data" : "Live data is paused"}</h2>
      <p>{owner ? `Your app keeps working and every purchase still unlocks. ${PRO_PRICE}` : message}</p>
      {!owner && ownerName && <p className="subtle">Ask {ownerName} to start Pro on their Billing page. Sandbox data stays open to everyone.</p>}
      <div className="plan-req-a">
        {owner && <StartPro />}
        {onSandbox && <button type="button" className="btn btn-line" onClick={onSandbox}>Show sandbox data</button>}
      </div>
    </section>
  );
}

/** The 402 of an edit (paywalls, experiments, targeting), in a dialog: what happened and the way out. */
export function PlanRequiredDialog({ message, owner, onClose }: { message: string; owner: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog plan-dialog" role="dialog" aria-modal="true" aria-label="Start Pro to keep editing">
        <div className="dh"><h2>{owner ? "Start Pro to keep editing" : "Editing is paused"}</h2></div>
        <div className="db stack">
          <p className="section-sub">{owner ? "Paywalls, experiments and targeting that are live keep serving. Changing them needs Pro." : message}</p>
          {owner && <p className="section-sub">{PRO_PRICE}</p>}
        </div>
        <div className="df">
          <button type="button" className="btn btn-line" onClick={onClose}>Not now</button>
          {owner && <StartPro note={false} />}
        </div>
        {owner && <p className="plan-dialog-note subtle">{CARD_NOTE}</p>}
      </div>
    </div>
  );
}

/** "Oct 19, 2026" for the grace date. */
export const gateDate = (ms: number | null | undefined) => fmt.date(ms ?? null);
