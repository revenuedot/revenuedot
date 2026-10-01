import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type DB } from "@revenuedot/db";
import { overviewValues } from "../routes/v2/metrics.js";
import { HISTORY_METRICS, metricHistory, type HistoryMetric } from "./metric-history.js";

/**
 * Verified Metrics (prd/project-settings §4): a public page with a project's aggregate production numbers. Only the six
 * overview metrics, their 28-day sparklines, a display name, an optional icon and store links ever leave the server.
 */

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
  chart_type: z.enum(["number_sparkline"]).optional(),
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

export interface PublicMetric { id: HistoryMetric; name: string; unit: "$" | "#"; caption: string; value: number; sparkline: number[] }
export interface PublicPage {
  slug: string; display_name: string; chart_type: string; metrics: PublicMetric[]; computed_at: number;
  icon_url: string | null; store_links: { app_store: string | null; play_store: string | null };
}

/** The numbers a published page shows: production only, visible metrics in the chosen order. `iconUrl` serves the icon. */
export async function publicPage(db: DB, page: VerifiedRow, now: Date, iconUrl: string): Promise<PublicPage> {
  const visible = page.metrics.filter((m) => m.visible && m.id in METRIC_LABELS) as { id: HistoryMetric; visible: boolean }[];
  const [values, histories] = await Promise.all([
    overviewValues(db, page.projectId, now, "production"),
    Promise.all(visible.map((m) => metricHistory(db, page.projectId, now, m.id, 28, "production"))),
  ]);
  let icon: string | null = null;
  if (page.showIcon && page.iconAssetId) {
    const [a] = await db.select({ id: schema.mediaAssets.id }).from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.projectId, page.projectId), eq(schema.mediaAssets.id, page.iconAssetId), eq(schema.mediaAssets.kind, "image"))).limit(1);
    // The asset id versions the URL, so a new icon is not hidden behind a cached old one.
    if (a) icon = `${iconUrl}?v=${a.id}`;
  }
  return {
    slug: page.slug, display_name: page.displayName, chart_type: page.chartType, computed_at: now.getTime(), icon_url: icon,
    store_links: page.showStoreLinks ? { app_store: page.appStoreUrl, play_store: page.playStoreUrl } : { app_store: null, play_store: null },
    metrics: visible.map((m, i) => ({
      id: m.id, ...METRIC_LABELS[m.id], value: values[m.id],
      sparkline: (histories[i]!.values ?? []).map((p) => p.value),
    })),
  };
}
