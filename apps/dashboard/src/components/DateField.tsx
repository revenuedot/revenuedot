import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getDisplay, WEEKDAYS } from "../lib/prefs";
import { Icon } from "./icons";

/**
 * A date field whose calendar starts its weeks on the person's first day (Account settings → Date and region), which a
 * native <input type="date"> cannot do. Type YYYY-MM-DD or pick a day: arrow keys move by a day or a week, Page Up and
 * Page Down by a month, Home and End to the week's ends, Enter picks, Escape closes. Dates are UTC days ("2026-09-30").
 */
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? Date.parse(`${s}T00:00:00Z`) : null);
const monthStart = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const addMonths = (t: number, n: number) => { const d = new Date(t); const y = d.getUTCFullYear(), m = d.getUTCMonth() + n; const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Date.UTC(y, m, Math.min(d.getUTCDate(), last)); };
const long = (t: number) => new Date(t).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function DateField({ value, onChange, label, min, max, id, className, weekStart }: {
  value: string; onChange: (v: string) => void; label: string; min?: string; max?: string; id?: string; className?: string;
  /** Overrides the person's preference (tests and previews). */ weekStart?: number;
}) {
  const ws = weekStart ?? getDisplay().weekStart;
  const auto = useId();
  const fid = id ?? `df${auto}`;
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<number>(() => parse(value) ?? Date.parse(`${iso(Date.now())}T00:00:00Z`));
  const wrap = useRef<HTMLSpanElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => { setText(value); const t = parse(value); if (t !== null) setFocus(t); }, [value]);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", out);
    return () => document.removeEventListener("mousedown", out);
  }, [open]);
  useEffect(() => { if (open) grid.current?.querySelector<HTMLButtonElement>("button[data-focus='true']")?.focus(); }, [open, focus]);
  const lo = min ? parse(min) : null, hi = max ? parse(max) : null;
  const allowed = (t: number) => (lo === null || t >= lo) && (hi === null || t <= hi);
  const commit = (t: number) => { if (!allowed(t)) return; onChange(iso(t)); setOpen(false); };
  const view = monthStart(focus);
  const cells = useMemo(() => {
    const first = new Date(view).getUTCDay();
    const lead = (first - ws + 7) % 7;
    const start = view - lead * DAY;
    return Array.from({ length: 42 }, (_, i) => start + i * DAY);
  }, [view, ws]);
  const heads = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(ws + i) % 7]!);
  const onKey = (e: KeyboardEvent) => {
    const move: Record<string, () => number> = {
      ArrowLeft: () => focus - DAY, ArrowRight: () => focus + DAY, ArrowUp: () => focus - 7 * DAY, ArrowDown: () => focus + 7 * DAY,
      PageUp: () => addMonths(focus, -1), PageDown: () => addMonths(focus, 1),
      Home: () => focus - ((new Date(focus).getUTCDay() - ws + 7) % 7) * DAY, End: () => focus + (6 - (new Date(focus).getUTCDay() - ws + 7) % 7) * DAY,
    };
    if (move[e.key]) { e.preventDefault(); setFocus(move[e.key]!()); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); wrap.current?.querySelector<HTMLButtonElement>("button.df-open")?.focus(); }
  };
  const selected = parse(value);
  return (
    <span className={`datefield${className ? ` ${className}` : ""}`} ref={wrap}>
      <input id={fid} className="input mono" aria-label={label} placeholder="YYYY-MM-DD" inputMode="numeric" value={text} maxLength={10}
        onChange={(e) => { const v = e.target.value.trim(); setText(e.target.value); if (v === "") onChange(""); else { const t = parse(v); if (t !== null && allowed(t)) onChange(v); } }}
        onBlur={() => { if (text.trim() !== "" && parse(text.trim()) === null) setText(value); }} />
      <button type="button" className="ib df-open" aria-label={`Choose ${label.toLowerCase()}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setFocus(selected ?? focus); setOpen(!open); }}><Icon name="calendar" /></button>
      {open && (
        <div className="df-pop" role="dialog" aria-label={`${label}: choose a date`} onKeyDown={onKey}>
          <div className="df-head">
            <button type="button" className="ib" aria-label="Previous month" onClick={() => setFocus(addMonths(focus, -1))}><Icon name="chev" className="i flip" /></button>
            <b aria-live="polite">{new Date(view).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</b>
            <button type="button" className="ib" aria-label="Next month" onClick={() => setFocus(addMonths(focus, 1))}><Icon name="chev" /></button>
          </div>
          <div className="df-grid" role="grid" ref={grid} data-week-start={ws} aria-label={new Date(view).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}>
            <div role="row" className="df-row">{heads.map((h) => <span key={h} role="columnheader" aria-label={h} className="df-wd">{h.slice(0, 2)}</span>)}</div>
            {[0, 1, 2, 3, 4, 5].map((r) => (
              <div role="row" className="df-row" key={r}>
                {cells.slice(r * 7, r * 7 + 7).map((t) => {
                  const out = new Date(t).getUTCMonth() !== new Date(view).getUTCMonth();
                  return (
                    <span role="gridcell" key={t} aria-selected={t === selected}>
                      <button type="button" tabIndex={t === focus ? 0 : -1} data-focus={t === focus} disabled={!allowed(t)} aria-label={long(t)}
                        className={`df-day${out ? " out" : ""}${t === selected ? " sel" : ""}${iso(t) === iso(Date.now()) ? " today" : ""}`} onClick={() => commit(t)}>
                        {new Date(t).getUTCDate()}
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="df-foot subtle">Weeks start on {WEEKDAYS[ws]}. Change it in Account settings → Date and region.</p>
        </div>
      )}
    </span>
  );
}
