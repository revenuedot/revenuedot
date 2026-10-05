import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { schema } from "@revenuedot/db";

/**
 * What a full export contains (prd/moves-export/PRD.md §1): every table that belongs to a project, in foreign-key order,
 * with how its rows are found from the project id, which columns are secrets, and which are left to the target.
 * A test (archive.test.ts) fails when a table is added to the schema without being listed here or in NOT_EXPORTED.
 */

/** The last migration of this build. Archives say which schema wrote them; a target refuses a newer one. */
export const ARCHIVE_SCHEMA = "0046_journey_feedback";
export const ARCHIVE_FORMAT = "revenuedot-export";
export const ARCHIVE_VERSION = 1;

/** How a table's rows are found: its own project column, or through a parent table's id. */
type Scope = { project: string } | { via: string; parent: string; parentKey?: string };

/** A secret column: what the table file holds instead, and whether the stored value is sealed with the server key. */
export interface SecretColumn { empty: unknown; sealed?: boolean }

export interface ArchiveTable {
  name: string;
  scope: Scope;
  /** Rows per database page (big rows: smaller pages). */
  page?: number;
  secrets?: Record<string, SecretColumn>;
  /** Columns that stay with the server they are on (move state, the owner). */
  local?: string[];
  /** Local columns a new row needs on the target: SQL over the archive row `r`. */
  fill?: Record<string, string>;
}

export const ARCHIVE_TABLES: ArchiveTable[] = [
  // Benchmark sharing is consent given on one server (RevenueDot Cloud): a moved project starts not sharing.
  { name: "projects", scope: { project: "id" }, local: ["owner_user_id", "move_state", "moved_to_url", "move_updated_at", "moved_in_at", "moved_in_from", "benchmarks_share", "benchmarks_category", "benchmarks_shared_at"] },
  { name: "apps", scope: { project: "project_id" }, secrets: { credentials: { empty: {} }, secrets: { empty: null, sealed: true }, secret_hints: { empty: {} } } },
  // Who granted an OAuth key, and to which client, stays on this server (accounts and OAuth clients are not moved).
  { name: "api_keys", scope: { project: "project_id" }, local: ["created_by_user_id", "oauth_client_id"] },
  { name: "products", scope: { project: "project_id" } },
  { name: "product_prices", scope: { project: "project_id" } },
  { name: "entitlements", scope: { project: "project_id" } },
  { name: "entitlement_products", scope: { via: "entitlement_id", parent: "entitlements" } },
  { name: "offerings", scope: { project: "project_id" } },
  { name: "packages", scope: { via: "offering_id", parent: "offerings" } },
  { name: "package_products", scope: { via: "package_id", parent: "packages" } },
  { name: "customers", scope: { project: "project_id" } },
  { name: "customer_aliases", scope: { project: "project_id" } },
  { name: "customer_attributes", scope: { via: "customer_id", parent: "customers" } },
  { name: "customer_attribution", scope: { project: "project_id" } },
  { name: "subscriptions", scope: { project: "project_id" } },
  { name: "non_subscriptions", scope: { project: "project_id" } },
  { name: "transactions", scope: { project: "project_id" } },
  { name: "events", scope: { project: "project_id" }, page: 500 },
  { name: "webhooks", scope: { project: "project_id" }, secrets: { signing_secret: { empty: "" }, authorization_header: { empty: null } } },
  { name: "webhook_deliveries", scope: { via: "webhook_id", parent: "webhooks" } },
  { name: "sdk_versions", scope: { project: "project_id" } },
  { name: "store_notifications", scope: { project: "project_id" }, page: 200 },
  { name: "alerts", scope: { project: "project_id" } },
  { name: "virtual_currencies", scope: { project: "project_id" } },
  { name: "virtual_currency_balances", scope: { via: "customer_id", parent: "customers" } },
  { name: "virtual_currency_transactions", scope: { project: "project_id" } },
  { name: "audit_logs", scope: { project: "project_id" } },
  { name: "paywalls", scope: { project: "project_id" }, page: 50 },
  { name: "paywall_versions", scope: { via: "paywall_id", parent: "paywalls" }, page: 50 },
  { name: "media_assets", scope: { project: "project_id" }, page: 10 },
  { name: "saved_charts", scope: { project: "project_id" } },
  // Chart annotations and share links (prd/charts/PRD.md, migration 0028). A share link keeps its token, so it opens on the target once its host serves the project; its snapshot and PNG make big rows.
  { name: "chart_annotations", scope: { project: "project_id" } },
  { name: "chart_shares", scope: { project: "project_id" }, page: 50 },
  { name: "audiences", scope: { project: "project_id" } },
  { name: "targeting_rules", scope: { project: "project_id" } },
  { name: "experiments", scope: { project: "project_id" } },
  { name: "experiment_enrollments", scope: { via: "experiment_id", parent: "experiments" } },
  { name: "sdk_events", scope: { project: "project_id" }, page: 500 },
  { name: "customer_activity", scope: { project: "project_id" } },
  { name: "integrations", scope: { project: "project_id" }, secrets: { secrets: { empty: null, sealed: true }, secret_hints: { empty: {} } } },
  { name: "integration_deliveries", scope: { via: "integration_id", parent: "integrations" }, page: 200 },
  { name: "export_jobs", scope: { project: "project_id" }, secrets: { secrets: { empty: null, sealed: true }, secret_hints: { empty: {} } } },
  { name: "export_runs", scope: { via: "job_id", parent: "export_jobs" } },
  { name: "refund_policies", scope: { project: "project_id" } },
  { name: "refund_requests", scope: { project: "project_id" } },
  { name: "retention_offers", scope: { project: "project_id" } },
  { name: "support_tickets", scope: { project: "project_id" } },
  { name: "winback_campaigns", scope: { project: "project_id" } },
  { name: "winback_sends", scope: { project: "project_id" } },
  { name: "email_suppressions", scope: { project: "project_id" } },
  { name: "web_configs", scope: { project: "project_id" } },
  { name: "web_products", scope: { project: "project_id" } },
  // A custom domain is proven per server (its TXT record names this server's token, its CNAME points here): the target
  // never takes "verified" from an archive. It gets its own token, and the domain waits for Verify there.
  { name: "web_domains", scope: { project: "project_id" }, local: ["verification_token", "status", "verified_at", "checked_at", "error"],
    fill: { verification_token: "replace(gen_random_uuid()::text, '-', '')", status: "CASE WHEN r.custom_domain IS NULL THEN 'none' ELSE 'pending' END" } },
  { name: "purchase_links", scope: { project: "project_id" } },
  { name: "funnels", scope: { project: "project_id" }, page: 100 },
  { name: "funnel_events", scope: { project: "project_id" } },
  { name: "web_checkouts", scope: { project: "project_id" }, secrets: { redemption_seed: { empty: null } } },
  { name: "discounts", scope: { project: "project_id" } },
  { name: "discount_codes", scope: { project: "project_id" } },
  { name: "ad_reward_rules", scope: { project: "project_id" } },
  { name: "ad_reward_verifications", scope: { project: "project_id" } },
  { name: "ad_units", scope: { project: "project_id" } },
  { name: "ai_share_cards", scope: { project: "project_id" } },
  { name: "auth_providers", scope: { project: "project_id" } },
  { name: "identity_links", scope: { project: "project_id" } },
  { name: "identity_sessions", scope: { project: "project_id" } },
  { name: "blocked_customers", scope: { project: "project_id" } },
  // A custom domain arrives unproven: the new server checks its DNS again, and never inherits a certificate's hostname.
  { name: "verified_pages", scope: { project: "project_id" }, local: ["domain_token", "domain_status", "domain_verified_at", "domain_checked_at", "domain_error", "domain_hostname_id", "domain_ssl_status"],
    fill: { domain_token: "CASE WHEN r.custom_domain IS NULL THEN NULL ELSE replace(gen_random_uuid()::text, '-', '') END", domain_status: "CASE WHEN r.custom_domain IS NULL THEN 'none' ELSE 'pending' END" } },
  // Connect with Stripe (prd/web-billing/PRD.md §8): the sealed account id travels in apps.secrets, so its routing row comes
  // too. On a server with another Connect platform the app then says to connect again. A sign-in in progress stays here.
  { name: "stripe_connections", scope: { project: "project_id" }, local: ["pending_state_hash", "pending_nonce_hash", "pending_until", "pending_mode", "redirect_uri", "connected_by"] },
  // Payment recovery (prd/payment-recovery/PRD.md): cases keep their link tokens, so emails already sent keep working.
  { name: "recovery_cases", scope: { project: "project_id" } },
  { name: "recovery_messages", scope: { project: "project_id" } },
];

/** Tables that are not in an archive, and why (the manifest's `excluded`). */
export const NOT_EXPORTED: Record<string, string> = {
  chart_rollups: "Daily chart rollups are derived from the ledger; the target builds its own.",
  chart_rollup_state: "Where the rollups stand on this server; the target builds its own.",
  users: "Accounts stay on their server; members.json lists collaborators by email and role.",
  memberships: "Collaborators come over by email (members.json); people with an account on the target are added with their role.",
  sessions: "Dashboard sign-ins belong to one server.",
  subscriber_tokens: "Subscriber access tokens last one hour; apps ask for new ones.",
  oauth_clients: "MCP clients register again with the new server.",
  oauth_codes: "One-time codes that last minutes.",
  fx_rates: "Exchange rates are shared by every project; the target has or downloads them.",
  auth_tokens: "Password reset and verification links belong to one server.",
  invites: "Pending invites are sent again from the target.",
  rate_limits: "Counters of one server.",
  customer_counts: "A cache of counts, made again on the target from its own customers.",
  config_blobs: "Remote-config blobs are shared and rebuilt by the target on the first request.",
  ai_conversations: "RevenueDot AI conversations belong to one person (and on Cloud live in Durable Objects).",
  ai_messages: "Part of RevenueDot AI conversations.",
  ai_streams: "Part of RevenueDot AI conversations.",
  ai_stream_chunks: "Part of RevenueDot AI conversations.",
  ai_files: "Files attached to RevenueDot AI conversations.",
  ai_tool_runs: "Part of RevenueDot AI conversations.",
  ai_usage: "Daily model usage counters of one server.",
  project_exports: "Exports of this server.",
  archive_blobs: "Archive files of this server.",
  project_imports: "Imports into this server.",
  project_moves: "Moves this server runs.",
  billing_accounts: "RevenueDot Cloud billing is per account and server.",
  billing_usage: "RevenueDot Cloud billing is per account and server.",
  billing_meter_reports: "RevenueDot Cloud billing is per account and server.",
  billing_invoices: "RevenueDot Cloud billing is per account and server.",
  billing_notices: "RevenueDot Cloud billing is per account and server.",
  recovery_portal_links: "One-time payment links that last 30 minutes.",
  two_factor_recovery_codes: "Two-factor recovery codes belong to one account on one server.",
  notification_prefs: "Each person's email choices stay with their account; they choose again on the target.",
  notification_sends: "Which summary and alert emails this server already sent.",
  journey_sends: "Which onboarding and growth emails RevenueDot Cloud already sent to this account.",
  journey_feedback: "Answers to RevenueDot Cloud's own emails (ratings, reasons for leaving).",
  anomaly_checks: "Daily revenue anomaly results of this server; the target checks again.",
  store_listings: "A cache of App Store and Google Play prices; the target reads them from the stores again.",
  store_listing_syncs: "When this server last read each app's store prices.",
  product_edits: "Product editor files describe changes already made in the stores; the audit log, which is exported, records every store write.",
  product_edit_rows: "Part of product editor files.",
  benchmark_project_values: "Benchmarks are computed on RevenueDot Cloud from projects that share there; rebuilt nightly.",
  benchmark_aggregates: "Peer percentiles across projects, not one project's data.",
  benchmark_runs: "Runs of this server's nightly benchmark job.",
  ai_insights: "This week's growth insights are written again by the target (they are a cache of the project's numbers).",
};

export interface TableInfo extends ArchiveTable {
  /** Every column, in table order. */
  allColumns: string[];
  /** The columns an archive holds (all but `local`). */
  columns: string[];
  pk: string[];
  /** Foreign keys to other archived tables (not `projects`): an import checks each row's parent is there. */
  fks: { columns: string[]; parent: string; parentColumns: string[] }[];
}

let infos: Map<string, TableInfo> | null = null;

/** Column names and primary keys from the Drizzle schema, so they can never drift from the database. */
export function tableInfos(): Map<string, TableInfo> {
  if (infos) return infos;
  const byName = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const v of Object.values(schema) as unknown[]) if (v instanceof PgTable) { const cfg = getTableConfig(v); byName.set(cfg.name, cfg); }
  const archived = new Set(ARCHIVE_TABLES.map((t) => t.name));
  infos = new Map();
  for (const t of ARCHIVE_TABLES) {
    const cfg = byName.get(t.name);
    if (!cfg) throw new Error(`archive: unknown table ${t.name}`);
    const allColumns = cfg.columns.map((c) => c.name);
    const pk = cfg.primaryKeys[0]?.columns.map((c) => c.name) ?? cfg.columns.filter((c) => c.primary).map((c) => c.name);
    if (!pk.length) throw new Error(`archive: ${t.name} has no primary key`);
    const fks = cfg.foreignKeys.map((fk) => fk.reference()).map((r) => ({ columns: r.columns.map((c) => c.name), parent: getTableConfig(r.foreignTable).name, parentColumns: r.foreignColumns.map((c) => c.name) }))
      .filter((fk) => fk.parent !== "projects" && archived.has(fk.parent) && !fk.columns.some((c) => t.local?.includes(c)));
    infos.set(t.name, { ...t, allColumns, columns: allColumns.filter((c) => !t.local?.includes(c)), pk, fks });
  }
  return infos;
}

export const allSchemaTables = () => (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable).map((t) => getTableConfig(t).name);

export const ident = (s: string) => sql.raw(`"${s.replace(/"/g, "")}"`);

/** SQL that selects the ids of a parent table's rows in the project (recursively through its own parent). */
function idsIn(table: string, projectId: string): SQL {
  const t = tableInfos().get(table)!;
  const key = t.pk.length === 1 ? t.pk[0]! : "id";
  if ("project" in t.scope) return sql`SELECT ${ident(key)} FROM ${ident(table)} WHERE ${ident(t.scope.project)} = ${projectId}`;
  return sql`SELECT ${ident(key)} FROM ${ident(table)} WHERE ${ident(t.scope.via)} IN (${idsIn(t.scope.parent, projectId)})`;
}

/** The WHERE condition for a table's rows in a project, on alias `t`. */
export function scopeWhere(table: string, projectId: string): SQL {
  const t = tableInfos().get(table)!;
  if ("project" in t.scope) return sql`t.${ident(t.scope.project)} = ${projectId}`;
  return sql`t.${ident(t.scope.via)} IN (${idsIn(t.scope.parent, projectId)})`;
}

/** Rows from db.execute on either driver (PGlite answers { rows }, postgres-js an array). */
export const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));
