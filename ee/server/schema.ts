// RevenueDot Enterprise (ee/LICENSE). Tables for organizations, custom roles, single sign-on, SCIM, data location and
// audit retention. Spec: prd/enterprise/PRD.md. Created by migration 0025 (packages/db/migrations/0025_enterprise.sql);
// packages/db/drizzle.config.ts reads this file next to the core schema so later migrations keep these tables.
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
// The core tables, by path (not "@revenuedot/db"), so drizzle-kit can load this file on its own.
import { projects, sessions, users } from "../../packages/db/src/schema";

const ts = (n: string) => timestamp(n, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();

/** An organization owns projects, has members with an organization role, and holds the enterprise settings. */
export const eeOrganizations = pgTable("ee_organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Default data location for new projects: "us" or "eu" (region.ts). */
  region: text("region").notNull().default("us"),
  /** Days audit log rows of the organization and its projects are kept; null keeps them forever. */
  auditRetentionDays: integer("audit_retention_days"),
  /** Members whose email domain is verified must sign in with single sign-on (owners may still use a password). */
  ssoEnforced: boolean("sso_enforced").notNull().default(false),
  /** Seats bought (Cloud billing reads this; null when not set). Seats used are counted, never stored. */
  seats: integer("seats"),
  billingEmail: text("billing_email"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdAt: created(),
});

/** Organization members. `role`: owner, admin or member. `source`: how they joined (manual, sso, scim, project). */
export const eeOrgMembers = pgTable("ee_org_members", {
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  source: text("source").notNull().default("manual"),
  /** Groups the identity provider sent at the member's last single sign-on (role mappings use them with SCIM groups). */
  ssoGroups: text("sso_groups").array().notNull().default(sql`'{}'::text[]`),
  /** False after SCIM deactivated the person: no access to the organization's projects until reactivated. */
  active: boolean("active").notNull().default(true),
  lastSsoAt: ts("last_sso_at"),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("ee_org_members_user").on(t.userId)]);

/** Which organization owns a project (at most one), and where the project's data lives. */
export const eeOrgProjects = pgTable("ee_org_projects", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  region: text("region").notNull().default("us"),
  addedAt: ts("added_at").notNull().defaultNow(),
}, (t) => [index("ee_org_projects_org").on(t.orgId)]);

/**
 * Custom roles: a named set of API v2 scopes (routes/v2/common.ts `scope()`), assignable to project members. A role
 * with a project id is usable in that project only; without one, in every project of the organization.
 * The role id is what the core stores in `memberships.role`.
 */
export const eeCustomRoles = pgTable("ee_custom_roles", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdAt: created(),
}, (t) => [uniqueIndex("ee_custom_roles_name").on(t.orgId, t.name)]);

/** Identity provider group → role in a project. SCIM groups match by display name, SSO groups by value (both case-insensitive). */
export const eeRoleMappings = pgTable("ee_role_mappings", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  groupName: text("group_name").notNull(),
  groupKey: text("group_key").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: created(),
}, (t) => [uniqueIndex("ee_role_mappings_unique").on(t.orgId, t.groupKey, t.projectId)]);

/**
 * Project memberships the enterprise features manage: "idp" (from group mappings, SCIM or SSO) or "org" (organization
 * owners and admins are admins of every organization project). Memberships without a row here were added by hand and
 * are never changed by provisioning.
 */
export const eeMembershipSources = pgTable("ee_membership_sources", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.userId] })]);

export interface SamlConfig {
  idp_entity_id: string;
  idp_sso_url: string;
  /** PEM or base64 DER X.509 certificates; several during a rotation. */
  idp_certificates: string[];
  allow_idp_initiated: boolean;
  email_attribute?: string | null;
  first_name_attribute?: string | null;
  last_name_attribute?: string | null;
  groups_attribute?: string | null;
}
export interface OidcConfig {
  issuer: string;
  client_id: string;
  scopes?: string[];
  groups_claim?: string | null;
}

/** A single sign-on connection: SAML 2.0 or OpenID Connect. */
export const eeSsoConnections = pgTable("ee_sso_connections", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  config: jsonb("config").$type<SamlConfig | OidcConfig>().notNull(),
  /** OpenID Connect client secret, sealed like integration secrets (apps/server/src/services/secrets.ts). */
  secret: text("secret"),
  /** Create accounts and organization memberships at first sign-in (just-in-time provisioning). */
  jit: boolean("jit").notNull().default(true),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdAt: created(),
}, (t) => [index("ee_sso_connections_org").on(t.orgId)]);

/** Email domains an organization proved it owns (DNS TXT); single sign-on and enforcement apply to these addresses only. */
export const eeSsoDomains = pgTable("ee_sso_domains", {
  domain: text("domain").primaryKey(),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  verifiedAt: ts("verified_at"),
  lastCheckedAt: ts("last_checked_at"),
  lastError: text("last_error"),
  createdAt: created(),
}, (t) => [index("ee_sso_domains_org").on(t.orgId)]);

/** Sign-ins in flight: SAML AuthnRequest ids (InResponseTo) and OpenID Connect state (nonce and PKCE verifier). */
export const eeSsoRequests = pgTable("ee_sso_requests", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull().references(() => eeSsoConnections.id, { onDelete: "cascade" }),
  value: text("value").notNull(),
  returnTo: text("return_to"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: created(),
}, (t) => [index("ee_sso_requests_expiry").on(t.expiresAt)]);

/** SAML assertion ids already used, kept until they expire: a replayed assertion is refused. */
export const eeSamlAssertions = pgTable("ee_saml_assertions", {
  connectionId: text("connection_id").notNull().references(() => eeSsoConnections.id, { onDelete: "cascade" }),
  assertionId: text("assertion_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
}, (t) => [primaryKey({ columns: [t.connectionId, t.assertionId] }), index("ee_saml_assertions_expiry").on(t.expiresAt)]);

/** Dashboard sessions that started with single sign-on, and for which organization. */
export const eeSsoSessions = pgTable("ee_sso_sessions", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  connectionId: text("connection_id").references(() => eeSsoConnections.id, { onDelete: "set null" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: created(),
}, (t) => [index("ee_sso_sessions_user").on(t.userId)]);

/** SCIM bearer tokens, one or more per organization; only a SHA-256 hash is stored. */
export const eeScimTokens = pgTable("ee_scim_tokens", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  prefix: text("prefix").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("ee_scim_tokens_hash").on(t.tokenHash), index("ee_scim_tokens_org").on(t.orgId)]);

/** SCIM User resources. Each maps to one RevenueDot account (users.id). */
export const eeScimUsers = pgTable("ee_scim_users", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  userName: text("user_name").notNull(),
  userNameKey: text("user_name_key").notNull(),
  externalId: text("external_id"),
  active: boolean("active").notNull().default(true),
  /** The resource's other attributes as the client last sent them (name, displayName, emails, title ...). */
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  version: integer("version").notNull().default(1),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdAt: created(),
}, (t) => [uniqueIndex("ee_scim_users_name").on(t.orgId, t.userNameKey), uniqueIndex("ee_scim_users_user").on(t.orgId, t.userId)]);

/** SCIM Group resources; role mappings match them by display name. */
export const eeScimGroups = pgTable("ee_scim_groups", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  displayKey: text("display_key").notNull(),
  externalId: text("external_id"),
  version: integer("version").notNull().default(1),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdAt: created(),
}, (t) => [uniqueIndex("ee_scim_groups_name").on(t.orgId, t.displayKey)]);

export const eeScimGroupMembers = pgTable("ee_scim_group_members", {
  groupId: text("group_id").notNull().references(() => eeScimGroups.id, { onDelete: "cascade" }),
  scimUserId: text("scim_user_id").notNull().references(() => eeScimUsers.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.groupId, t.scimUserId] }), index("ee_scim_group_members_user").on(t.scimUserId)]);

/** Organization-level audit log: members, roles, SSO and SCIM changes, sign-ins, provisioning, exports. */
export const eeOrgAuditLogs = pgTable("ee_org_audit_logs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => eeOrganizations.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
}, (t) => [index("ee_org_audit_logs_org_time").on(t.orgId, t.occurredAt)]);

/** When each periodic enterprise job last ran (the tick runs every minute; some jobs run hourly). */
export const eeJobRuns = pgTable("ee_job_runs", {
  name: text("name").primaryKey(),
  lastRunAt: ts("last_run_at").notNull(),
});
