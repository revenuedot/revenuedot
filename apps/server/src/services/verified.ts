import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema, type DB } from "@revenuedot/db";
import { overviewValues } from "../routes/v2/metrics.js";
import { HISTORY_METRICS, metricHistory, monthlyHistories, type HistoryMetric } from "./metric-history.js";

/**
 * Verified Metrics (prd/project-settings §4): a public page with a project's aggregate production numbers. Only the six
 * overview metrics, their 28-day sparklines or 12-month lines, a display name, an optional icon and store links ever leave
 * the server.
 */

/**
 * How each metric is drawn: "number_sparkline" (the value and a 28-day sparkline, the default), "numbers_only" (the value
 * alone) and "line" (RevenueDot's own: a larger line chart over the last 12 calendar months, one point per month).
 */
export const CHART_TYPES = ["number_sparkline", "numbers_only", "line"] as const;
export type ChartType = typeof CHART_TYPES[number];
export const LINE_MONTHS = 12;

export const METRIC_LABELS: Record<HistoryMetric, { name: string; unit: "$" | "#"; caption: string }> = {
  mrr: { name: "MRR", unit: "$", caption: "Monthly recurring revenue" },
  revenue: { name: "Revenue", unit: "$", caption: "Last 28 days" },
  active_subscriptions: { name: "Active subscriptions", unit: "#", caption: "Paid, right now" },
  active_trials: { name: "Active trials", unit: "#", caption: "Right now" },
  new_customers: { name: "New customers", unit: "#", caption: "Last 28 days" },
  active_users: { name: "Active customers", unit: "#", caption: "Last 28 days" },
};
export const DEFAULT_METRICS: { id: HistoryMetric; visible: boolean }[] = (["mrr", "revenue", "active_subscriptions", "active_trials", "new_customers", "active_users"] as const)
  .map((id) => ({ id, visible: true }));

/** Words a page could use to pass itself off as RevenueDot's own (or another product's official) page. */
const RESERVED = new Set([
  "about", "account", "admin", "api", "app", "assets", "auth", "billing", "blog", "dashboard", "docs", "help", "login", "new", "official", "pricing",
  "privacy", "revenuecat", "revenuedot", "security", "settings", "signup", "static", "status", "support", "terms", "verified", "www",
]);

/** Why a slug cannot be used (format only), or null. */
export function slugProblem(slug: string): string | null {
  if (slug.length < 3 || slug.length > 40) return "must be 3 to 40 characters";
  if (!/^[a-z0-9-]+$/.test(slug)) return "may use only a-z, 0-9 and -";
  if (slug.startsWith("-") || slug.endsWith("-") || slug.includes("--")) return "must not start or end with - or contain --";
  if (RESERVED.has(slug)) return "is reserved";
  return null;
}

const Https = (host: RegExp) => z.string().trim().max(300).url().refine((u) => { try { const x = new URL(u); return x.protocol === "https:" && host.test(x.hostname); } catch { return false; } }, "must be an https link to the store page");
export const VerifiedIn = z.object({
  slug: z.string().trim().toLowerCase().max(40).optional(),
  display_name: z.string().trim().min(1).max(60).optional(),
  chart_type: z.enum(CHART_TYPES).optional(),
  metrics: z.array(z.object({ id: z.enum(HISTORY_METRICS as [HistoryMetric, ...HistoryMetric[]]), visible: z.boolean() })).length(6).optional()
    .refine((m) => !m || new Set(m.map((x) => x.id)).size === 6, "must list each of the 6 metrics once"),
  show_icon: z.boolean().optional(),
  icon_asset_id: z.string().max(100).nullable().optional(),
  show_store_links: z.boolean().optional(),
  app_store_url: Https(/^apps\.apple\.com$/).nullable().optional().or(z.literal("").transform(() => null)),
  play_store_url: Https(/^play\.google\.com$/).nullable().optional().or(z.literal("").transform(() => null)),
});

export type VerifiedRow = typeof schema.verifiedPages.$inferSelect;

/** A slug for a project name: "Scanner Pro!" becomes "scanner-pro". */
export const slugify = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

/** `sparkline`: 28 daily values (number_sparkline only). `history`: 12 monthly points, "YYYY-MM" (line only). Empty otherwise. */
export interface PublicMetric { id: HistoryMetric; name: string; unit: "$" | "#"; caption: string; value: number; sparkline: number[]; history: { date: string; value: number }[] }
export interface PublicPage {
  slug: string; display_name: string; chart_type: ChartType; metrics: PublicMetric[]; computed_at: number;
  icon_url: string | null; store_links: { app_store: string | null; play_store: string | null };
}

/** The numbers a published page shows: production only, visible metrics in the chosen order. `iconUrl` serves the icon. */
export async function publicPage(db: DB, page: VerifiedRow, now: Date, iconUrl: string): Promise<PublicPage> {
  const visible = page.metrics.filter((m) => m.visible && m.id in METRIC_LABELS) as { id: HistoryMetric; visible: boolean }[];
  const chart = chartTypeOf(page.chartType);
  const [values, histories, months] = await Promise.all([
    overviewValues(db, page.projectId, now, "production"),
    chart === "number_sparkline" ? Promise.all(visible.map((m) => metricHistory(db, page.projectId, now, m.id, 28, "production"))) : Promise.resolve([]),
    chart === "line" && visible.length ? monthlyHistories(db, page.projectId, now, visible.map((m) => m.id), LINE_MONTHS, "production") : Promise.resolve({} as Awaited<ReturnType<typeof monthlyHistories>>),
  ]);
  let icon: string | null = null;
  if (page.showIcon && page.iconAssetId) {
    const [a] = await db.select({ id: schema.mediaAssets.id }).from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.projectId, page.projectId), eq(schema.mediaAssets.id, page.iconAssetId), eq(schema.mediaAssets.kind, "image"))).limit(1);
    // The asset id versions the URL, so a new icon is not hidden behind a cached old one.
    if (a) icon = `${iconUrl}?v=${a.id}`;
  }
  return {
    slug: page.slug, display_name: page.displayName, chart_type: chart, computed_at: now.getTime(), icon_url: icon,
    store_links: page.showStoreLinks ? { app_store: page.appStoreUrl, play_store: page.playStoreUrl } : { app_store: null, play_store: null },
    metrics: visible.map((m, i) => ({
      id: m.id, ...METRIC_LABELS[m.id], value: values[m.id],
      sparkline: (histories[i]?.values ?? []).map((p) => p.value),
      history: months[m.id] ?? [],
    })),
  };
}

/** A stored chart type this build knows, else the default (a row written by a newer server). */
export const chartTypeOf = (v: string): ChartType => ((CHART_TYPES as readonly string[]).includes(v) ? v as ChartType : "number_sparkline");

/**
 * Pages on verified custom domains, by host (an unpublished page answers 404 there, as at its slug), cached for a minute (the host check runs on requests to hosts
 * that are not RevenueDot's own). A domain serves only its page: `/`, `/metrics.json`, `/og.png` and `/icon`.
 */
const hostCache = new Map<string, { at: number; slug: string | null }>();
export async function verifiedSlugForHost(db: DB, host: string, nowMs: number): Promise<string | null> {
  const hit = hostCache.get(host);
  if (hit && nowMs - hit.at < 60_000) return hit.slug;
  const V = schema.verifiedPages;
  const [row] = await db.select({ slug: V.slug }).from(V).where(and(eq(V.customDomain, host), eq(V.domainStatus, "verified"))).limit(1);
  if (hostCache.size > 1000) hostCache.clear();
  hostCache.set(host, { at: nowMs, slug: row?.slug ?? null });
  return row?.slug ?? null;
}
export const forgetVerifiedHost = (host: string | null | undefined) => { if (host) hostCache.delete(host); };

/** The path a custom domain's request maps to on the API host, or null (not found on that domain). */
export function verifiedPathFor(slug: string, path: string): string | null {
  if (path === "/" || path === "") return `/verified/${slug}`;
  if (path === "/metrics.json" || path === "/og.png" || path === "/icon") return `/verified/${slug}${path}`;
  return null;
}

/** Where a request for a page came from, set by app.ts for custom domains, so its links name that domain. */
export const VERIFIED_ORIGIN = new WeakMap<Request, string>();

/**
 * Removes the Cloudflare for SaaS hostnames of these projects' verified pages before the projects are deleted, so a
 * customer's domain stops reaching the server. Failures are logged: deleting a project never waits on Cloudflare.
 */
export async function releaseVerifiedHostnames(deps: { db: DB; fetch?: typeof fetch; cloudflareSaas?: { zoneId: string; apiToken: string } }, projectIds: string[]) {
  if (!deps.cloudflareSaas || !projectIds.length) return;
  const { deleteCustomHostname } = await import("./cloudflare-saas.js");
  const V = schema.verifiedPages;
  const rows = await deps.db.select({ id: V.domainHostnameId, domain: V.customDomain }).from(V).where(inArray(V.projectId, projectIds));
  for (const r of rows) {
    forgetVerifiedHost(r.domain);
    if (!r.id) continue;
    try { await deleteCustomHostname(deps.fetch ?? fetch, deps.cloudflareSaas, r.id); } catch (e) { console.warn(`Removing the custom hostname ${r.domain} failed`, e); }
  }
}
