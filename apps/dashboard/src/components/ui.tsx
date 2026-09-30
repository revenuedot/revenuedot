import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Icon } from "./icons";

/** Shared dashboard building blocks. Pages compose these; they never restyle them (see DESIGN.md). */

export const useProjectId = () => useParams().projectId ?? "";

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Panel({ title, link, children, flush }: { title?: ReactNode; link?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="panel">
      {title && <div className="ph"><b>{title}</b>{link && <span className="link">{link}</span>}</div>}
      {flush ? children : <div className="pb">{children}</div>}
    </section>
  );
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{text && <p>{text}</p>}{action}</div>;
}

export function Tag({ tone = "muted", children }: { tone?: "up" | "down" | "info" | "gold" | "muted"; children: ReactNode }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

export interface Column<T> { key: string; header: string; align?: "right"; render: (row: T) => ReactNode; className?: string }

export function DataTable<T>({ columns, rows, onRowClick, rowKey, empty }: { columns: Column<T>[]; rows: T[]; onRowClick?: (r: T) => void; rowKey: (r: T) => string; empty?: ReactNode }) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="panel tbl">
      <table>
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.align === "right" ? "amt" : undefined}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={onRowClick ? "row" : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter") onRowClick(r); } : undefined}>
              {columns.map((c) => <td key={c.key} className={`${c.align === "right" ? "amt" : ""} ${c.className ?? ""}`}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return <div className="kv">{rows.flatMap(([k, v]) => [<div key={`${k}-k`}>{k}</div>, <div key={`${k}-v`}>{v}</div>])}</div>;
}

export function Dialog({ title, children, footer, onClose }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dh"><h2>{title}</h2><button className="ib" type="button" aria-label="Close" onClick={onClose}><Icon name="close" /></button></div>
        <div className="db">{children}</div>
        {footer && <div className="df">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, htmlFor, children }: { label: string; hint?: ReactNode; error?: string | null; htmlFor: string; children: ReactNode }) {
  return <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}{hint && <span className="hint">{hint}</span>}{error && <span className="err" role="alert">{error}</span>}</div>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} className="sw" onClick={() => onChange(!checked)}><i />{label}</button>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return <div className="seg" role="group" aria-label={label}>{options.map((o) => <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2600); }, []);
  return <ToastCtx.Provider value={show}>{children}{msg && <div className="toast" role="status">{msg}</div>}</ToastCtx.Provider>;
}

/** Sparkline with the gold square on the last point (DESIGN.md). Reads colours from tokens so it follows the theme. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="sp" viewBox="0 0 300 44" aria-hidden />;
  const W = 300, H = 44, mn = Math.min(...values), mx = Math.max(...values);
  const pts = values.map((v, i) => [i * W / (values.length - 1), H - 3 - ((v - mn) / ((mx - mn) || 1)) * (H - 8)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const e = pts[pts.length - 1]!;
  return (
    <svg className="sp" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={`${d} L${W} ${H} L0 ${H} Z`} fill="var(--spark-fill)" />
      <path d={d} fill="none" stroke="var(--spark)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
      <rect x={e[0] - 6} y={e[1] - 3} width="6" height="6" fill="var(--accent)" />
    </svg>
  );
}

/** Store and event labels shared by tables and the customer timeline. */
export const STORE_LABEL: Record<string, string> = { app_store: "App Store", mac_app_store: "Mac App Store", play_store: "Google Play", amazon: "Amazon", stripe: "Stripe", rc_billing: "Web", promotional: "Promotional", test_store: "Test Store", paddle: "Paddle", roku: "Roku", external: "External" };
export const EVENT_TONE: Record<string, "up" | "down" | "info" | "gold" | "muted"> = {
  INITIAL_PURCHASE: "gold", RENEWAL: "up", NON_RENEWING_PURCHASE: "gold", UNCANCELLATION: "up", PRODUCT_CHANGE: "info", SUBSCRIPTION_EXTENDED: "up",
  CANCELLATION: "muted", EXPIRATION: "muted", BILLING_ISSUE: "down", REFUND_REVERSED: "up", TRANSFER: "info", SUBSCRIPTION_PAUSED: "muted", TEST: "muted",
};
