import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

/**
 * Chart annotations (prd/charts/PRD.md "Annotations"): project-level notes on a UTC day or date range. Days are stored
 * as YYYY-MM-DD text, so overlap is a string comparison.
 */
type Row = typeof schema.chartAnnotations.$inferSelect;
export const MAX_ANNOTATIONS = 1000;

/** Annotations overlapping [from, to] (inclusive days), oldest first. */
export async function annotationsBetween(db: DB, projectId: string, from: string | null, to: string | null): Promise<Row[]> {
  const A = schema.chartAnnotations;
  return db.select().from(A)
    .where(and(eq(A.projectId, projectId), to ? lte(A.startDate, to) : undefined, from ? gte(A.endDate, from) : undefined))
    .orderBy(asc(A.startDate), asc(A.id)).limit(MAX_ANNOTATIONS);
}

/** RevenueCat's `ChartAnnotation` (chart data with include_annotations=true): one text, and no end date for a single day. */
export const rcAnnotation = (x: Row) => ({ object: "chart_annotation" as const, id: x.id, description: x.title, start_date: x.startDate, end_date: x.endDate === x.startDate ? null : x.endDate });

/** Names and emails of the people who made annotations or share links, for the dashboard's "Added by". */
export async function authors(db: DB, ids: (string | null)[]): Promise<Map<string, { id: string; email: string; name: string | null }>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, want));
  return new Map(rows.map((r) => [r.id, r]));
}
