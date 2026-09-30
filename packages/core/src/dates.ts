/** RevenueCat's wire date format: ISO 8601 in UTC with second precision, e.g. 2019-07-26T23:30:41Z. */
export function rcDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v;
  const d = typeof v === "number" ? new Date(v) : new Date(/^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d;
}
