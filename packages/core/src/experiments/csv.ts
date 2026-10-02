import { EXPERIMENT_METRICS } from "./catalog.js";
import type { ExperimentResults } from "./results.js";

/**
 * Experiment results as CSV (RFC 4180, CRLF): `summary` has one row per variant and metric, `daily` one row per day and
 * variant with every metric as a column. Text that a spreadsheet would run as a formula gets a leading apostrophe.
 */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return s;
  const safe = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function summaryCsv(r: ExperimentResults): string {
  const rows: unknown[][] = [["variant_id", "variant_name", "offering_id", "customers", "metric", "metric_name", "value", "numerator", "denominator", "lower_95", "upper_95", "lift", "lift_lower_95", "lift_upper_95", "chance_to_beat_control"]];
  for (const v of r.variants) for (const d of EXPERIMENT_METRICS) {
    const m = v.metrics[d.id]!;
    rows.push([v.id, v.name, v.offering_id, v.customers, d.id, d.name, m.value, m.numerator, m.denominator, m.lower, m.upper, m.lift, m.lift_lower, m.lift_upper, m.chance_to_beat_control]);
  }
  return csv(rows);
}

export function dailyCsv(r: ExperimentResults): string {
  const rows: unknown[][] = [["date", "variant_id", "variant_name", ...EXPERIMENT_METRICS.map((d) => d.id)]];
  r.series.days.forEach((day, i) => {
    for (const v of r.variants) rows.push([new Date(day).toISOString().slice(0, 10), v.id, v.name, ...EXPERIMENT_METRICS.map((d) => r.series.values[d.id]?.[v.id]?.[i] ?? null)]);
  });
  return csv(rows);
}
