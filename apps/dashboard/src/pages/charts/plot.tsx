/*
 * Chart drawing for the Charts page: a time-series plot (line, bar or stacked bar) and a cohort heat table.
 * Follows DESIGN.md §7 and the dataviz method: hairline grid, mono axis labels, one y axis, 2px lines, bars at most
 * 24px wide with a 2px surface gap between stacked segments, square marks (DESIGN.md: radius 0). A single series is
 * ink with the current (incomplete) period in gold; several series take the validated categorical slots --series-1…5
 * in fixed order, never cycled, with "Other" in grey. Crosshair and tooltip on hover and on arrow keys.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";

export interface Series { key: string; label: string; values: (number | null)[]; other?: boolean }
export interface PlotProps {
  periods: { start: number; label: string; long: string; incomplete: boolean }[];
  series: Series[];
  kind: "line" | "bar" | "stacked_bar";
  format: (v: number | null) => string;
  /** Axis ticks: compact money and counts. */
  formatTick: (v: number) => string;
  ariaLabel: string;
  /** Counts: whole-number ticks only. */
  integer?: boolean;
}

export const seriesColor = (i: number, s: Series) => (s.other ? "var(--fg-3)" : `var(--series-${(i % 5) + 1})`);

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

export function Plot({ periods, series, kind, format, formatTick, ariaLabel, integer }: PlotProps) {
  const [ref, W] = useWidth();
  const H = 300, L = 64, R = 16, T = 14, B = 30;
  const pw = W - L - R, ph = H - T - B;
  const n = periods.length;
  const [hover, setHover] = useState<number | null>(null);
  const stacked = kind === "stacked_bar";
  const single = series.length === 1;

  const { ticks, y } = useMemo(() => {
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      if (stacked) {
        let pos = 0, neg = 0;
        for (const s of series) { const v = s.values[i] ?? 0; if (v >= 0) pos += v; else neg += v; }
        hi = Math.max(hi, pos); lo = Math.min(lo, neg);
      } else for (const s of series) { const v = s.values[i]; if (v !== null && v !== undefined) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }
    }
    const t = niceTicks(lo, hi, 4, integer);
    const a = t[0]!, b = t[t.length - 1]!;
    return { ticks: t, y: (v: number) => T + ph - ((v - a) / ((b - a) || 1)) * ph };
  }, [series, n, stacked, ph, integer]);

  const band = pw / Math.max(1, n);
  const cx = (i: number) => L + band * i + band / 2;
  const barW = Math.max(2, Math.min(24, band * 0.62 / (kind === "bar" && !single ? series.length : 1)));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 92))));
  const pick = (clientX: number, rect: DOMRect) => Math.max(0, Math.min(n - 1, Math.floor((clientX - rect.left - L) / band)));
  const onMove = (e: PointerEvent<SVGRectElement>) => setHover(pick(e.clientX, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") { e.preventDefault(); setHover((h) => (h === null ? 0 : Math.min(n - 1, h + 1))); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => (h === null ? n - 1 : Math.max(0, h - 1))); }
    if (e.key === "Escape") setHover(null);
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
  } else {
    periods.forEach((p, i) => {
      if (stacked || single) {
        let pos = 0, neg = 0;
        series.forEach((s, si) => {
          const v = s.values[i];
          if (!v) return;
          const from = v >= 0 ? pos : neg;
          const to = from + v;
          if (v >= 0) pos = to; else neg = to;
          const top = Math.min(y(from), y(to)), h = Math.abs(y(from) - y(to));
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

  const tip = hover !== null ? periods[hover] : null;
  const tipLeft = hover !== null ? cx(hover) : 0;
  return (
    <div className="plot" ref={ref} tabIndex={0} role="img" aria-label={ariaLabel} onKeyDown={onKey} onBlur={() => setHover(null)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--border)" : "var(--border-2)"} strokeWidth={1} />
            <text x={L - 10} y={y(t)} dy="0.32em" textAnchor="end" className="ax">{formatTick(t)}</text>
          </g>
        ))}
        {periods.map((p, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2) ? <text key={p.start} x={cx(i)} y={H - 10} textAnchor="middle" className="ax">{p.label}</text> : null)}
        {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={T} y2={T + ph} stroke="var(--fg-3)" strokeWidth={1} />}
        {marks}
        <rect x={L} y={T} width={pw} height={ph} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {tip && (
        <div className="tip" role="status" style={{ left: Math.min(Math.max(8, tipLeft + 12), W - 220), top: 10 }}>
          <div className="tip-h">{tip.long}{tip.incomplete && <span> · incomplete</span>}</div>
          {series.map((s, si) => (
            <div className="tip-r" key={s.key}>
              <i style={{ background: single ? "var(--fg)" : seriesColor(si, s) }} />
              <b>{format(s.values[hover!] ?? null)}</b><span>{s.label}</span>
            </div>
          ))}
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
