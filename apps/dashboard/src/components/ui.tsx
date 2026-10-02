import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
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

export interface Column<T> {
  key: string; header: string; align?: "right"; render: (row: T) => ReactNode; className?: string;
  /** Makes the header a sort button: the current direction (null = not sorted by this column) and what a click does. */
  sort?: { direction: "asc" | "desc" | null; onSort: () => void };
  /** A control shown after the header text, such as a toggle. */
  headerExtra?: ReactNode;
}

function HeaderCell<T>({ c }: { c: Column<T> }) {
  const d = c.sort?.direction ?? null;
  const cls = `${c.align === "right" ? "amt" : ""} ${c.className ?? ""}`.trim() || undefined;
  if (!c.sort && !c.headerExtra) return <th className={cls}>{c.header}</th>;
  return (
    <th className={cls} aria-sort={d === "asc" ? "ascending" : d === "desc" ? "descending" : undefined}>
      <span className="th-in">
        {c.sort ? (
          <button type="button" className={`th-sort${d ? " on" : ""}`} onClick={c.sort.onSort} title={`Sort by ${c.header.toLowerCase()}`}>
            {c.header}<Icon name={d === "desc" ? "down" : "up"} className="i th-arrow" />
          </button>
        ) : c.header}
        {c.headerExtra}
      </span>
    </th>
  );
}

export function DataTable<T>({ columns, rows, onRowClick, rowKey, empty }: { columns: Column<T>[]; rows: T[]; onRowClick?: (r: T) => void; rowKey: (r: T) => string; empty?: ReactNode }) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="panel tbl">
      <table>
        <thead><tr>{columns.map((c) => <HeaderCell key={c.key} c={c} />)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={onRowClick ? "row" : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(r); } : undefined}>
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

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} className="sw" disabled={disabled} onClick={() => onChange(!checked)}><i />{label}</button>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return <div className="seg" role="group" aria-label={label}>{options.map((o) => <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  // One timer: an earlier toast's timer must not hide a newer toast early.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setMsg(null); timer.current = null; }, 2600);
  }, []);
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
export const STORE_LABEL: Record<string, string> = { app_store: "App Store", mac_app_store: "Mac App Store", play_store: "Google Play", amazon: "Amazon", stripe: "Stripe", rc_billing: "Web", promotional: "Promotional", test_store: "Test Store", paddle: "Paddle", roku: "Roku", galaxy: "Galaxy Store", external: "External" };
export const EVENT_TONE: Record<string, "up" | "down" | "info" | "gold" | "muted"> = {
  INITIAL_PURCHASE: "gold", RENEWAL: "up", NON_RENEWING_PURCHASE: "gold", UNCANCELLATION: "up", PRODUCT_CHANGE: "info", SUBSCRIPTION_EXTENDED: "up",
  CANCELLATION: "muted", EXPIRATION: "muted", BILLING_ISSUE: "down", REFUND_REVERSED: "up", TRANSFER: "info", SUBSCRIPTION_PAUSED: "muted", TEST: "muted",
};

/** Moves focus between the enabled buttons of a menu or tab list with the arrow keys, Home and End. */
function arrowFocus(e: ReactKeyboardEvent<HTMLElement>, selector: string, keys: [string, string]) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(selector)).filter((b) => !b.disabled);
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === keys[1] ? items[(i + 1) % items.length] : e.key === keys[0] ? items[(i - 1 + items.length) % items.length] : e.key === "Home" ? items[0] : e.key === "End" ? items[items.length - 1] : null;
  if (next) { e.preventDefault(); next.focus(); return next; }
  return null;
}

export interface MenuItem { label: string; onSelect: () => void; icon?: string; danger?: boolean; disabled?: boolean; hint?: string }

/**
 * The "…" row-actions menu. It floats (position: fixed) so tables that scroll sideways do not clip it, follows its
 * button when the page scrolls, closes on Escape or an outside click, and supports arrow-key navigation. Clicks and
 * keys never reach the row underneath.
 */
export function Menu({ label, items, text, icon = "plus", variant = "line" }: { label: string; items: (MenuItem | "-")[]; /** A text button ("+ Add path") instead of "…". */ text?: string; icon?: string; /** The text button's style: hairline (default) or the dark primary. */ variant?: "line" | "dark" }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback((focus = false) => { setPos(null); if (focus) btn.current?.focus(); }, []);
  const isOpen = !!pos;
  useEffect(() => {
    if (!isOpen) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const out = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(true); } };
    // Follow the button when something scrolls; close only once it leaves the screen.
    const away = () => { const next = place(); if (!next) close(); else setPos((p) => (p && p.top === next.top && p.left === next.left ? p : next)); };
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => { document.removeEventListener("mousedown", out); document.removeEventListener("keydown", esc, true); window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); };
  }, [isOpen, close]);
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r || r.bottom < 0 || r.top > window.innerHeight) return null;
    const h = items.length * 34 + 12;
    const left = text ? (primary ? r.right - 232 : r.left) : r.right - 232;
    return { top: r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4, left: Math.max(8, Math.min(left, window.innerWidth - 240)) };
  };
  const open = () => setPos(place());
  return (
    <span className="rmenu" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {text
        ? <button ref={btn} type="button" className={`btn btn-${variant}`} aria-haspopup="menu" aria-expanded={!!pos} onClick={() => (pos ? close() : open())}><Icon name={icon} />{text}</button>
        : <button ref={btn} type="button" className="ib" aria-label={label} aria-haspopup="menu" aria-expanded={!!pos} onClick={() => (pos ? close() : open())}><Icon name="more" /></button>}
      {pos && (
        <div ref={menu} className="menu float" role="menu" aria-label={label} style={{ top: pos.top, left: pos.left }} onKeyDown={(e) => arrowFocus(e, "button", ["ArrowUp", "ArrowDown"])}>
          {items.map((it, i) => it === "-" ? <hr key={`sep${i}`} /> : (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} title={it.hint} className={it.danger ? "danger" : undefined}
              onClick={() => { close(true); it.onSelect(); }}>
              {it.icon && <Icon name={it.icon} />}<span>{it.label}</span>{it.hint && it.disabled && <small>{it.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export interface TabItem<T extends string> { value: T; label: string; disabled?: boolean; badge?: string }

/** Underlined tabs (Packages / Metadata / Paywall). Arrow keys move between tabs. */
export function Tabs<T extends string>({ value, tabs, onChange, label, right, idBase = "tab" }: { value: T; tabs: TabItem<T>[]; onChange: (v: T) => void; label: string; right?: ReactNode; idBase?: string }) {
  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} onKeyDown={(e) => { const b = arrowFocus(e, "[role=tab]", ["ArrowLeft", "ArrowRight"]); if (b) b.click(); }}>
        {tabs.map((t) => (
          <button key={t.value} id={`${idBase}-${t.value}`} type="button" role="tab" aria-selected={value === t.value} aria-controls={`${idBase}-${t.value}-panel`}
            tabIndex={value === t.value ? 0 : -1} disabled={t.disabled} onClick={() => onChange(t.value)}>
            {t.label}{t.badge && <span className="soon">{t.badge}</span>}
          </button>
        ))}
      </div>
      {right && <div className="tabs-r">{right}</div>}
    </div>
  );
}

/**
 * Confirmation for destructive or high-impact actions. `onConfirm` may return a promise; the dialog shows progress,
 * keeps itself open and shows the API's message when it rejects, and closes when it resolves.
 */
export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => unknown; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong. Try again."); setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className={`btn ${danger ? "btn-danger" : "btn-dark"}`} onClick={go} disabled={busy} autoFocus>{busy ? "Working…" : confirmLabel}</button>
    </>}>
      <div className="confirm">{children}</div>
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}

/* Setup building blocks (apps, API keys, webhooks, project settings). */

/** Copies a value and confirms with a check mark. `children` replaces the default icon-only button content. */
export function CopyButton({ value, label = "Copy", text }: { value: string; label?: string; text?: boolean }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400); }
    catch { toast("Copy failed. Select the text and copy it by hand."); }
  };
  return (
    <button type="button" className={text ? "btn btn-line" : "ib"} aria-label={label} title={label} onClick={copy}>
      <Icon name={done ? "check" : "copy"} />{text && (done ? "Copied" : label)}
    </button>
  );
}

/** A secret or key shown masked, with reveal and copy. The store prefix (appl_, goog_ ...) stays visible. */
export function SecretText({ value, label = "key" }: { value: string; label?: string }) {
  const [shown, setShown] = useState(false);
  const cut = value.indexOf("_");
  const masked = (cut > 0 && cut < 6 ? value.slice(0, cut + 1) : "") + "•".repeat(12);
  return (
    <span className="secret">
      <code aria-label={shown ? undefined : `${label} hidden`}>{shown ? value : masked}</code>
      <button type="button" className="ib" aria-label={shown ? `Hide ${label}` : `Show ${label}`} aria-pressed={shown} onClick={(e) => { e.stopPropagation(); setShown(!shown); }}><Icon name={shown ? "eyeoff" : "eye"} /></button>
      <span onClick={(e) => e.stopPropagation()}><CopyButton value={value} label={`Copy ${label}`} /></span>
    </span>
  );
}

/** A read-only value (URL, id) in an input-like hairline box with a copy button. */
export function CopyField({ value, label }: { value: string; label: string }) {
  return <div className="copyfield"><code title={value}>{value}</code><CopyButton value={value} label={`Copy ${label}`} /></div>;
}

/** Code with a copy button. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="codeblock">
      <div className="codeblock-h"><span>{label}</span><CopyButton value={code} label={label ? `Copy ${label} code` : "Copy code"} /></div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

/** A section that starts collapsed (the long store forms keep rarely used settings here). */
export function Disclosure({ title, sub, children, defaultOpen = false }: { title: ReactNode; sub?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className="disc">
      <button type="button" className="disc-h" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name="chev" className="i chev" /><span><b>{title}</b>{sub && <small>{sub}</small>}</span>
      </button>
      {open && <div id={id} className="disc-b">{children}</div>}
    </section>
  );
}

/** One status line: an 8px square in the state colour (DESIGN.md health rows), or the gold live dot. */
export function StatusLine({ tone, children }: { tone: "ok" | "bad" | "idle" | "live"; children: ReactNode }) {
  return <p className={`status s-${tone}`} role="status">{tone === "live" ? <span className="live" /> : <i className={`dot ${tone}`} />}<span>{children}</span></p>;
}

/** A square checkbox with an optional muted hint under the label. */
export function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`check${disabled ? " off" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
    </label>
  );
}

/** Drop a file or choose one; the text content is handed over (keys and JSON credentials are small text files). */
export function FileDrop({ id, accept, prompt, onFile, maxBytes = 64_000 }: { id: string; accept: string; prompt: ReactNode; onFile: (name: string, text: string) => void; maxBytes?: number }) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > maxBytes) { setError(`${f.name} is too large for a key file.`); return; }
    setError(null);
    onFile(f.name, await f.text());
  };
  return (
    <div className={`drop${over ? " over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files[0]); }}>
      <Icon name="docs" />
      <span>{prompt}</span>
      <label htmlFor={id} className="btn btn-line">Choose file</label>
      <input id={id} className="sr" type="file" accept={accept} onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
      {error && <span className="err" role="alert">{error}</span>}
    </div>
  );
}

/**
 * The Sandbox data switch, kept in the URL as `?environment=sandbox` (the Overview's convention), so a link or a reload
 * opens the page on the same data.
 */
export function useSandboxParam(): [boolean, (on: boolean) => void] {
  const [sp, setSp] = useSearchParams();
  const on = sp.get("environment") === "sandbox";
  return [on, (v) => { const n = new URLSearchParams(sp); if (v) n.set("environment", "sandbox"); else n.delete("environment"); setSp(n, { replace: true }); }];
}
