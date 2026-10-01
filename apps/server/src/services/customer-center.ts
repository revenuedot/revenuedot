import { and, asc, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { retentionOffersOf, withRetentionOffers } from "./retention.js";

/**
 * Customer Center configuration, in the shape the SDKs decode (`GET /v1/customercenter/{id}`) and API v2 returns
 * (`GET /v2/projects/{id}/customers/{id}/customer_center`). A project starts with the default below; what is stored in
 * `projects.customer_center` is merged over it, key by key, so a project can change only the support email or one screen.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars replace. */
export function mergeConfig(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? mergeConfig(base[k] as Json, v) : v;
  return out;
}

const STRINGS: Record<string, string> = {
  no_thanks: "No, thanks", restore_purchases: "Restore purchases", cancel: "Cancel", contact_support: "Contact support",
  manage_subscription: "Manage your subscription", check_past_purchases: "Check past purchases", dismiss: "Dismiss", done: "Done",
  no_subscriptions_found: "No subscriptions found", default_subject: "Support request", default_body: "Please describe your issue or question.",
};

export function defaultCustomerCenter(supportEmail: string): Json {
  const path = (id: string, title: string, type: string, extra: Json = {}) => ({ id, title, type, ...extra });
  return {
    appearance: { light: {}, dark: {} },
    screens: {
      MANAGEMENT: {
        type: "MANAGEMENT", title: "Manage subscription", subtitle: "Choose what you want to do.",
        paths: [
          path("path_cancel", "Cancel subscription", "CANCEL"),
          path("path_refund", "Request a refund", "REFUND_REQUEST"),
          path("path_missing", "Missing purchase", "MISSING_PURCHASE"),
        ],
      },
      NO_ACTIVE: {
        type: "NO_ACTIVE", title: "No active subscriptions", subtitle: "We could not find an active subscription for this account.",
        paths: [path("path_missing_none", "Restore purchases", "MISSING_PURCHASE")],
      },
    },
    localization: { locale: "en_US", localized_strings: STRINGS },
    support: { email: supportEmail, should_warn_customer_to_update: false, display_purchase_history_link: true, display_user_details_section: true, display_virtual_currencies: false },
    change_plans: [],
  };
}

/** The first project admin's email, or a neutral address when none is on file (self-hosted installs created through the CLI). */
async function supportEmailOf(db: DB, projectId: string): Promise<string> {
  const rows = await db.select({ email: schema.users.email }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.projectId, projectId), eq(schema.memberships.role, "admin"))).orderBy(asc(schema.users.createdAt)).limit(1);
  return rows[0]?.email ?? "support@example.com";
}

/** The configuration the SDK loads: the default, the project's overrides, then the Retention offers on the cancel and refund paths. */
export async function customerCenterFor(db: DB, projectId: string): Promise<Json> {
  const [p] = await db.select({ cc: schema.projects.customerCenter }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  const merged = mergeConfig(defaultCustomerCenter(await supportEmailOf(db, projectId)), p?.cc ?? {});
  return withRetentionOffers(merged, await retentionOffersOf(db, projectId));
}

/** Customer Center support settings (email and ticket intake) without the Retention offers, for Support and tickets. */
export async function supportSettingsFor(db: DB, projectId: string): Promise<{ email: string; tickets: { allow_creation: boolean; customer_type: string; customer_details: Record<string, boolean> } | null }> {
  const [p] = await db.select({ cc: schema.projects.customerCenter }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  const merged = mergeConfig(defaultCustomerCenter(await supportEmailOf(db, projectId)), p?.cc ?? {});
  const support = (merged.support ?? {}) as Json;
  const t = support.support_tickets as Json | undefined;
  return {
    email: String(support.email ?? ""),
    tickets: t ? { allow_creation: t.allow_creation === true, customer_type: String(t.customer_type ?? "all"), customer_details: (t.customer_details ?? {}) as Record<string, boolean> } : null,
  };
}
