import { and, asc, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { defaultCustomerCenter, mergeConfig, sdkCustomerCenter, validateCustomerCenter } from "@revenuedot/core/customer-center";
import { retentionOffersOf, withRetentionOffers } from "./retention.js";

/**
 * Customer Center configuration (prd/customer-center/PRD.md), in the shape the SDKs decode (`GET /v1/customercenter/{id}`)
 * and API v2 returns (`GET /v2/projects/{id}/customers/{id}/customer_center`). A project starts with the default; what is
 * stored in `projects.customer_center` is merged over it, key by key (arrays replace), so a project can change only the
 * support email or store the whole configuration the dashboard editor saves. The pure parts live in
 * `packages/core/src/customer-center`.
 */

type Json = Record<string, unknown>;
export { mergeConfig };

/** The first project admin's email, or a neutral address when none is on file (self-hosted installs created through the CLI). */
async function supportEmailOf(db: DB, projectId: string): Promise<string> {
  const rows = await db.select({ email: schema.users.email }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.projectId, projectId), eq(schema.memberships.role, "admin"))).orderBy(asc(schema.users.createdAt)).limit(1);
  return rows[0]?.email ?? "support@example.com";
}

async function storedOf(db: DB, projectId: string): Promise<Json | null> {
  const [p] = await db.select({ cc: schema.projects.customerCenter }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return p?.cc ?? null;
}

/** The editable configuration: the default with the stored overrides merged in (what the dashboard editor starts from). */
export async function customerCenterConfigOf(db: DB, projectId: string): Promise<Json> {
  return mergeConfig(defaultCustomerCenter(await supportEmailOf(db, projectId)) as unknown as Json, (await storedOf(db, projectId)) ?? {});
}

/** Problems with stored overrides once merged over the default ("field: message" lines; empty when valid). */
export async function customerCenterProblems(db: DB, projectId: string, overrides: Json): Promise<string[]> {
  return validateCustomerCenter(mergeConfig(defaultCustomerCenter(await supportEmailOf(db, projectId)) as unknown as Json, overrides));
}

/**
 * The configuration the SDK loads: the default, the project's overrides, the Retention offers on the cancel and refund
 * paths that have no offer of their own, then the SDK shape in the customer's language (`X-Preferred-Locales`).
 */
export async function customerCenterFor(db: DB, projectId: string, opts: { preferredLocales?: string | null } = {}): Promise<Json> {
  const merged = await customerCenterConfigOf(db, projectId);
  return sdkCustomerCenter(withRetentionOffers(merged, await retentionOffersOf(db, projectId)), { preferredLocales: opts.preferredLocales });
}

/** Customer Center support settings (email and ticket intake) without the Retention offers, for Support and tickets. */
export async function supportSettingsFor(db: DB, projectId: string): Promise<{ email: string; tickets: { allow_creation: boolean; customer_type: string; customer_details: Record<string, boolean> } | null }> {
  const merged = await customerCenterConfigOf(db, projectId);
  const support = (merged.support ?? {}) as Json;
  const t = support.support_tickets as Json | undefined;
  return {
    email: String(support.email ?? ""),
    tickets: t ? { allow_creation: t.allow_creation === true, customer_type: String(t.customer_type ?? "all"), customer_details: (t.customer_details ?? {}) as Record<string, boolean> } : null,
  };
}
