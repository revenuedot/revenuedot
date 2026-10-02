/*
 * Chart drawing for the Charts page: a time-series plot (line, stacked area, column, stacked column, 100% stacked column)
 * and a cohort heat table. Follows DESIGN.md §7 and the dataviz method: hairline grid, mono axis labels, one y axis, 2px
 * lines, bars at most 24px wide with a 2px surface gap between stacked segments, square marks (DESIGN.md: radius 0). A
 * single series is ink with the current (incomplete) period in gold; several series take the validated categorical
 * slots --series-1…5 in fixed order, never cycled, with "Other" in grey. Stacks split by sign (positives up, negatives
 * down); the 100% column shows shares of the period's absolute total. Crosshair and tooltip on hover and on arrow keys.
 *
 * Annotations (prd/charts/PRD.md "Annotations") draw as a square marker at the top of the plot, a dashed hairline for
 * one day and a light band for a range. When `onAddAnnotation` is given, a click selects a period, a drag or Shift+click
 * a range (Enter and Shift+Enter from the keyboard), and a "+" button over the selection adds an annotation there.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { stackPeriod, type ChartType } from "@revenuedot/core";

export interface Series { key: string; label: string; values: (number | null)[]; other?: boolean }
export interface PlotAnnotation { id: string; title: string; when: string; from: number; to: number }
export interface PlotProps {
  periods: { start: number; label: string; long: string; incomplete: boolean }[];
  series: Series[];
  kind: ChartType;
  format: (v: number | null) => string;
  /** Axis ticks: compact money and counts. */
  formatTick: (v: number) => string;
  ariaLabel: string;
  /** Counts: whole-number ticks only. */
  integer?: boolean;
  /** The same measure for the period before, by position: drawn as a dashed grey line under the current values. */
  compare?: { label: string; values: (number | null)[] } | null;
  /** Annotations by period index (inclusive), already clipped to the plotted periods. */
  annotations?: PlotAnnotation[];
  onAnnotation?: (id: string) => void;
  /** Turns on period selection and the "+" button; receives the selected period indexes. */
  onAddAnnotation?: (from: number, to: number) => void;
}

export const seriesColor = (i: number, s: Series) => (s.other ? "var(--fg-3)" : `var(--series-${(i % 5) + 1})`);
const STACKED = new Set<ChartType>(["stacked_area", "stacked_column", "percent_column"]);

function niceTicks(min: number, max: number, count = 4, integer = false): number[] {
  if (min === max) { max = min === 0 ? 1 : min > 0 ? min * 1.2 : 0; if (min > 0) min = 0; }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  if (integer) step = Math.max(1, Math.ceil(step));
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const pctTick = (v: number) => `${+v.toFixed(1)}%`;

export function Plot({ periods, series, kind, format, formatTick, ariaLabel, integer, compare, annotations = [], onAnnotation, onAddAnnotation }: PlotProps) {
  const [ref, W] = useWidth();
  const H = 300, L = 64, R = 16, T = 14, B = 30;
  const pw = W - L - R, ph = H - T - B;
  const n = periods.length;
  const [hover, setHover] = useState<number | null>(null);
  const [note, setNote] = useState<PlotAnnotation | null>(null);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const anchor = useRef<number | null>(null);
  const dragging = useRef(false);
  const stacked = STACKED.has(kind);
  const percent = kind === "percent_column";
  const single = series.length === 1;
  // A selection that no longer fits (fewer periods after a range change) is dropped.
  // The anchor goes with it: a Shift+click must not extend from a period the plot no longer has.
  useEffect(() => {
    setSel((s) => (s && s[1] < n ? s : null));
    if (anchor.current !== null && anchor.current >= n) anchor.current = null;
  }, [n]);

  const stacks = useMemo(() => (stacked ? periods.map((_, i) => stackPeriod(series.map((s) => s.values[i]), percent)) : null), [stacked, percent, periods, series]);
  const { ticks, y } = useMemo(() => {
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      if (stacks) for (const r of stacks[i]!) { if (r) { lo = Math.min(lo, r[0], r[1]); hi = Math.max(hi, r[0], r[1]); } }
      else for (const s of series) { const v = s.values[i]; if (v !== null && v !== undefined) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }
      const cv = percent ? null : compare?.values[i];
      if (cv !== null && cv !== undefined) { hi = Math.max(hi, cv); lo = Math.min(lo, cv); }
    }
    const t = niceTicks(lo, hi, 4, integer && !percent);
    const a = t[0]!, b = t[t.length - 1]!;
    return { ticks: t, y: (v: number) => T + ph - ((v - a) / ((b - a) || 1)) * ph };
  }, [series, n, stacks, percent, ph, integer, compare]);

  const band = pw / Math.max(1, n);
  const cx = (i: number) => L + band * i + band / 2;
  const barW = Math.max(2, Math.min(24, band * 0.62 / (kind === "column" && !single ? series.length : 1)));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 92))));
  const pick = (clientX: number, rect: DOMRect) => Math.max(0, Math.min(n - 1, Math.floor((clientX - rect.left - L) / band)));
  const at = (e: PointerEvent<SVGRectElement>) => pick(e.clientX, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect());
  const selectTo = (i: number, extend: boolean) => {
    if (extend && anchor.current !== null) setSel([Math.min(anchor.current, i), Math.max(anchor.current, i)]);
    else { anchor.current = i; setSel([i, i]); }
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const i = at(e);
    setHover(i);
    if (dragging.current && anchor.current !== null) setSel([Math.min(anchor.current, i), Math.max(anchor.current, i)]);
  };
  const onDown = (e: PointerEvent<SVGRectElement>) => {
    if (!onAddAnnotation || e.button !== 0) return;
    selectTo(at(e), e.shiftKey);
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onUp = () => { dragging.current = false; };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowRight") { e.preventDefault(); setHover((h) => (h === null ? 0 : Math.min(n - 1, h + 1))); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => (h === null ? n - 1 : Math.max(0, h - 1))); }
    if (e.key === "Escape") { setHover(null); setSel(null); anchor.current = null; }
    if ((e.key === "Enter" || e.key === " ") && onAddAnnotation && hover !== null) { e.preventDefault(); selectTo(hover, e.shiftKey); }
  };
  const zero = y(0);

  const marks: ReactElement[] = [];
  if (kind === "line") {
    series.forEach((s, si) => {
      const color = single ? "var(--fg)" : seriesColor(si, s);
      // Complete periods solid; steps into incomplete periods dashed; a single series' step into the current period gold.
      let solid = "", dashed = "", current = "";
      let prev: [number, number] | null = null;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) { prev = null; return; }
        const pt: [number, number] = [cx(i), y(v)];
        if (prev) {
          const seg = `M${prev[0].toFixed(1)} ${prev[1].toFixed(1)}L${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`;
          if (!periods[i]!.incomplete) solid += seg; else if (single && i === n - 1) current += seg; else dashed += seg;
        }
        prev = pt;
      });
      marks.push(<path key={`l${s.key}`} d={solid} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />);
      if (dashed) marks.push(<path key={`d${s.key}`} d={dashed} fill="none" stroke={color} strokeWidth={2} strokeDasharray="4 4" />);
      if (current) marks.push(<path key={`c${s.key}`} d={current} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="4 4" />);
      if (n === 1 || s.values.filter((v) => v !== null).length === 1) {
        s.values.forEach((v, i) => { if (v !== null) marks.push(<rect key={`p${s.key}${i}`} x={cx(i) - 4} y={y(v) - 4} width={8} height={8} fill={color} stroke="var(--panel)" strokeWidth={2} />); });
      }
      if (single) {
        const last = s.values.length - 1;
        const v = s.values[last];
        if (v !== null && v !== undefined) marks.push(<rect key="cur" x={cx(last) - 4} y={y(v) - 4} width={8} height={8} fill="var(--accent)" stroke="var(--panel)" strokeWidth={2} />);
      }
    });
  } else if (kind === "stacked_area") {
    // One band per series between its stacked edges; a missing value keeps the edge below it.
    series.forEach((s, si) => {
      const edge = (i: number) => stacks![i]![si] ?? (() => { const below = stacks![i]!.slice(0, si).reverse().find((r) => r)?.[1] ?? 0; return [below, below] as [number, number]; })();
      const top = periods.map((_, i) => `${cx(i).toFixed(1)} ${y(edge(i)[1]).toFixed(1)}`);
      const bottom = periods.map((_, i) => `${cx(i).toFixed(1)} ${y(edge(i)[0]).toFixed(1)}`).reverse();
      if (n) marks.push(<path key={`a${s.key}`} d={`M${top.join("L")}L${bottom.join("L")}Z`} fill={seriesColor(si, s)} fillOpacity={0.85} stroke="var(--panel)" strokeWidth={1} data-testid="area" />);
    });
  } else {
    periods.forEach((p, i) => {
      if (stacks || single) {
        const ranges = stacks ? stacks[i]! : stackPeriod(series.map((s) => s.values[i]), false);
        series.forEach((s, si) => {
          const r = ranges[si];
          if (!r || r[0] === r[1]) return;
          const top = Math.min(y(r[0]), y(r[1])), h = Math.abs(y(r[0]) - y(r[1]));
          // The 2px surface gap between touching segments.
          const gap = series.length > 1 && h > 3 ? 1 : 0;
          // A single series is ink with the current period in gold; other incomplete periods are faded.
          const current = i === n - 1 && p.incomplete;
          const color = single ? (current ? "var(--accent)" : "var(--fg)") : seriesColor(si, s);
          marks.push(<rect key={`b${i}-${s.key}`} x={cx(i) - barW / 2} y={top + gap} width={barW} height={Math.max(0, h - 2 * gap)} fill={color} opacity={p.incomplete && !(single && current) ? 0.55 : 1} />);
        });
      } else {
        series.forEach((s, si) => {
          const v = s.values[i];
          if (v === null || v === undefined) return;
          const x = cx(i) - (barW * series.length + 2 * (series.length - 1)) / 2 + si * (barW + 2);
          marks.push(<rect key={`g${i}-${s.key}`} x={x} y={Math.min(zero, y(v))} width={barW} height={Math.abs(zero - y(v))} fill={seriesColor(si, s)} opacity={p.incomplete ? 0.55 : 1} />);
        });
      }
    });
  }

  // The previous period, under everything else (not on the 100% column, whose axis is shares).
  if (compare && !percent) {
    let d = "", prev = false;
    compare.values.slice(0, n).forEach((v, i) => {
      if (v === null || v === undefined) { prev = false; return; }
      d += `${prev ? "L" : "M"}${cx(i).toFixed(1)} ${y(v).toFixed(1)}`; prev = true;
    });
    if (d) marks.unshift(<path key="cmp" d={d} fill="none" stroke="var(--fg-3)" strokeWidth={1.5} strokeDasharray="5 4" data-testid="compare-line" />);
  }

  // Annotation bands under the marks, markers on top (so they take the pointer and the focus).
  const lanes = new Map<number, number>();
  const notes = annotations.filter((a) => a.to >= 0 && a.from < n).map((a) => {
    const from = Math.max(0, a.from), to = Math.min(n - 1, a.to);
    const lane = lanes.get(from) ?? 0;
    lanes.set(from, lane + 1);
    return { a, from, to, lane: Math.min(lane, 3) };
  });
  const bands = notes.map(({ a, from, to }) => from === to
    ? <line key={`an${a.id}`} x1={cx(from)} x2={cx(from)} y1={T} y2={T + ph} stroke="var(--fg-3)" strokeWidth={1} strokeDasharray="2 3" />
    : <rect key={`an${a.id}`} x={cx(from) - band / 2} y={T} width={band * (to - from + 1)} height={ph} fill="var(--fg)" opacity={0.05} />);
  const tip = note ? null : hover !== null ? periods[hover] : null;
  const tipLeft = hover !== null ? cx(hover) : 0;
  const shares = percent && hover !== null ? stacks![hover]!.map((r) => (r ? r[1] - r[0] : null)) : null;
  const selLabel = sel ? (sel[0] === sel[1] ? periods[sel[0]]?.long : `${periods[sel[0]]?.long} – ${periods[sel[1]]?.long}`) : "";
  return (
    // A group, not an img: an img's children are presentational, which would hide the annotation markers and "+" (buttons)
    // from screen readers.
    <div className={`plot${onAddAnnotation ? " can-select" : ""}`} ref={ref} tabIndex={0} role="group" aria-roledescription="chart" aria-label={ariaLabel} onKeyDown={onKey} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHover(null); }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {sel && <rect x={cx(sel[0]) - band / 2} y={T} width={band * (sel[1] - sel[0] + 1)} height={ph} fill="var(--active)" data-testid="selection" />}
        {bands}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--border)" : "var(--border-2)"} strokeWidth={1} />
            <text x={L - 10} y={y(t)} dy="0.32em" textAnchor="end" className="ax">{percent ? pctTick(t) : formatTick(t)}</text>
          </g>
        ))}
        {periods.map((p, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2) ? <text key={p.start} x={cx(i)} y={H - 10} textAnchor="middle" className="ax">{p.label}</text> : null)}
        {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={T} y2={T + ph} stroke="var(--fg-3)" strokeWidth={1} />}
        {marks}
        <rect x={L} y={T} width={pw} height={ph} fill="transparent" onPointerMove={onMove} onPointerLeave={() => { if (!dragging.current) setHover(null); }} onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onUp} data-testid="plot-area" />
        {notes.map(({ a, from, to, lane }) => (
          <g key={`m${a.id}`} className="anote" tabIndex={0} role="button" aria-label={`Annotation: ${a.title}, ${a.when}`} data-testid="annotation-marker"
            onMouseEnter={() => setNote(a)} onMouseLeave={() => setNote(null)} onFocus={() => setNote(a)} onBlur={() => setNote(null)}
            onClick={() => onAnnotation?.(a.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAnnotation?.(a.id); } }}>
            <rect x={cx(from) - (from === to ? 0 : band / 2) - 7} y={T - 7 + lane * 11} width={14} height={14} fill="transparent" />
            <rect x={cx(from) - (from === to ? 0 : band / 2) - 4} y={T - 4 + lane * 11} width={8} height={8} fill="var(--fg-2)" stroke="var(--panel)" strokeWidth={1.5} />
          </g>
        ))}
      </svg>
      {note && (
        <div className="tip" role="status" style={{ left: Math.min(Math.max(8, cx(Math.max(0, Math.min(n - 1, note.from))) + 12), W - 248), top: 10 }}>
          <div className="tip-h">{note.when}</div>
          <div className="tip-note">{note.title}</div>
        </div>
      )}
      {tip && (
        <div className="tip" role="status" style={{ left: Math.min(Math.max(8, tipLeft + 12), W - 220), top: 10 }}>
          <div className="tip-h">{tip.long}{tip.incomplete && <span> · incomplete</span>}</div>
          {series.map((s, si) => (
            <div className="tip-r" key={s.key}>
              <i style={{ background: single ? "var(--fg)" : seriesColor(si, s) }} />
              <b>{format(s.values[hover!] ?? null)}</b><span>{s.label}{shares && shares[si] !== null ? ` · ${(shares[si] as number).toFixed(1)}%` : ""}</span>
            </div>
          ))}
          {compare && !percent && <div className="tip-r"><i style={{ background: "transparent", border: "1px dashed var(--fg-3)" }} /><b>{format(compare.values[hover!] ?? null)}</b><span>{compare.label}</span></div>}
          {onAddAnnotation && !sel && <div className="tip-hint">Click or drag to select, then + to annotate</div>}
        </div>
      )}
      {sel && onAddAnnotation && (
        <div className="plot-add" style={{ left: Math.min(Math.max(4, cx((sel[0] + sel[1]) / 2) - 14), W - 32) }}>
          <button type="button" className="ib" aria-label={`Add annotation for ${selLabel}`} title={`Add annotation for ${selLabel}`} onClick={() => { onAddAnnotation(sel[0], sel[1]); setSel(null); anchor.current = null; }}>+</button>
        </div>
      )}
    </div>
  );
}

export function Legend({ series, single }: { series: Series[]; single?: boolean }) {
  if (single || series.length < 2) return null;
  return (
    <ul className="legend" aria-label="Legend">
      {series.map((s, i) => <li key={s.key}><i style={{ background: seriesColor(i, s) }} />{s.label}</li>)}
    </ul>
  );
}
