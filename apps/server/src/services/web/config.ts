import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type DB } from "@revenuedot/db";
import { DEFAULT_THEME, type FunnelTheme, type PageLook } from "@revenuedot/core/funnels";

/**
 * Web config of a Stripe web provider (prd/web-billing/PRD.md §1): the checkout look, legal links, success and cancel
 * behaviour, and the app's deep link scheme for redemption links. Stored per Stripe app in `web_configs.config`.
 */

const https = z.string().trim().max(2048).regex(/^https:\/\/[^\s"'<>]+$/, "must be an https URL");
/** Schemes a browser handles itself: a redemption deep link must open the app. */
const BROWSER_SCHEMES = new Set(["http", "https", "javascript", "data", "vbscript", "file", "blob", "about", "ftp", "ws", "wss", "mailto", "tel", "sms", "intent"]);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a colour like #0A0A0A");

export const ThemeIn = z.object({ background: hex, text: hex, accent: hex, button_text: hex, corner_radius: z.number().int().min(0).max(24) });

export const WebConfigIn = z.object({
  app_name: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/, "must be one line of text").optional(),
  logo_url: https.nullable().optional(),
  theme: ThemeIn.optional(),
  terms_url: https.nullable().optional(),
  privacy_url: https.nullable().optional(),
  support_email: z.string().trim().email().max(254).nullable().optional(),
  success_mode: z.enum(["show_redemption", "redirect"]).optional(),
  success_redirect_url: https.nullable().optional(),
  success_title: z.string().trim().min(1).max(120).nullable().optional(),
  success_body: z.string().trim().max(600).nullable().optional(),
  cancel_url: https.nullable().optional(),
  app_scheme: z.string().trim().regex(/^[a-z][a-z0-9+.-]{1,39}$/, "must be a URL scheme such as myapp (lower case letters, digits, + . -)")
    .refine((v) => !BROWSER_SCHEMES.has(v), "must be your app's own scheme, not a browser scheme such as https or javascript").optional(),
  app_store_url: https.nullable().optional(),
  play_store_url: https.nullable().optional(),
  redemption_link_hours: z.number().int().min(1).max(720).optional(),
}).strict();
export type WebConfigInput = z.infer<typeof WebConfigIn>;

export interface WebConfig {
  app_name: string;
  logo_url: string | null;
  theme: FunnelTheme;
  terms_url: string | null;
  privacy_url: string | null;
  support_email: string | null;
  success_mode: "show_redemption" | "redirect";
  success_redirect_url: string | null;
  success_title: string | null;
  success_body: string | null;
  cancel_url: string | null;
  app_scheme: string;
  app_store_url: string | null;
  play_store_url: string | null;
  redemption_link_hours: number;
}

async function hex10(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d.slice(0, 5), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The default deep link scheme: `rd-` and 10 hex characters of the project id's hash (stable, shown in the dashboard). */
export const defaultScheme = async (projectId: string) => `rd-${await hex10(projectId)}`;

export async function webConfigOf(db: DB, app: { id: string; projectId: string; name: string }): Promise<{ config: WebConfig; saved: boolean; updatedAt: Date | null }> {
  const [row] = await db.select().from(schema.webConfigs).where(eq(schema.webConfigs.appId, app.id)).limit(1);
  const c = (row?.config ?? {}) as Partial<WebConfig>;
  return {
    saved: !!row, updatedAt: row?.updatedAt ?? null,
    config: {
      app_name: c.app_name ?? app.name, logo_url: c.logo_url ?? null, theme: { ...DEFAULT_THEME, ...(c.theme ?? {}) },
      terms_url: c.terms_url ?? null, privacy_url: c.privacy_url ?? null, support_email: c.support_email ?? null,
      success_mode: c.success_mode ?? "show_redemption", success_redirect_url: c.success_redirect_url ?? null,
      success_title: c.success_title ?? null, success_body: c.success_body ?? null, cancel_url: c.cancel_url ?? null,
      app_scheme: c.app_scheme ?? (await defaultScheme(app.projectId)), app_store_url: c.app_store_url ?? null, play_store_url: c.play_store_url ?? null,
      redemption_link_hours: c.redemption_link_hours ?? 24,
    },
  };
}

export async function saveWebConfig(db: DB, app: { id: string; projectId: string; name: string }, input: WebConfigInput, now: Date): Promise<WebConfig> {
  const { config } = await webConfigOf(db, app);
  const next = { ...config, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as WebConfig;
  if (next.success_mode === "redirect" && !next.success_redirect_url) throw Object.assign(new Error("success_redirect_url is required when success_mode is redirect."), { param: "success_redirect_url" });
  await db.insert(schema.webConfigs).values({ appId: app.id, projectId: app.projectId, config: next as unknown as Record<string, unknown>, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.webConfigs.appId, set: { config: next as unknown as Record<string, unknown>, updatedAt: now } });
  return next;
}

export const lookOf = (c: WebConfig): PageLook => ({ app_name: c.app_name, logo_url: c.logo_url, terms_url: c.terms_url, privacy_url: c.privacy_url, support_email: c.support_email });

/** The project's Stripe apps (web providers), oldest first. */
export async function stripeAppsOf(db: DB, projectId: string) {
  const rows = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.type, "stripe")));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
