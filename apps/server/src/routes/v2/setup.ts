import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { webhookStore, type Store } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { RCError } from "../../errors.js";
import { AppleApiClientError } from "../../stores/apple/api.js";
import { appleApiFor } from "../../stores/apple/index.js";
import { serviceAccountOf } from "../../stores/google/api.js";
import { V2Error, body, listOf, notFound, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { amazonKeyConfigured, appleKeyConfigured, galaxyKeyConfigured, googleKeyConfigured, notificationStoreOf, paddleIsSandbox, paddleKeyConfigured, projectShape, rokuKeyConfigured, stripeKeyConfigured } from "./shapes.js";
import { notificationHealth } from "./notification-health.js";
import { apiRole } from "../../services/members.js";
import { checkStoreCredentials, recordCredentialCheck } from "../../services/credential-health.js";
import { checkConnectKey } from "../../services/connect-key-check.js";
import { paddleKeyHintOf, sealStoreSecrets, storeSecretHintOf, storeSecretSet, stripeConnected, stripeKeyHintOf, stripeModeOf, withStoreSecrets } from "../../services/store-secrets.js";
import { depsSecretKey } from "../../services/secrets.js";
import { PaddleApiError } from "../../stores/paddle/api.js";
import { paddleClientFor } from "../../stores/paddle/index.js";
import { PADDLE_EVENTS } from "../../stores/paddle/sync.js";
import { SANDBOX_ACCESS } from "../../repo/access.js";
import { ownershipEmail } from "../../mail/templates.js";
import { trySend } from "../../mail/index.js";
import { linkBase, requestOrigin } from "../../services/account-email.js";
import { buildSampleApp, SAMPLE_APPS, samplePlatformsFor, type SamplePlatform } from "../../services/sample-apps/index.js";

/**
 * Project setup endpoints for the dashboard (apps, project settings, webhook tests).
 *   GET    /v2/projects/{project_id}                                             project with its settings (extension)
 *   POST   /v2/projects/{project_id}                                             update name, transfer behaviour and sandbox testing access (extension)
 *   POST   /v2/projects/{project_id}/actions/transfer_ownership                  hand the project to an admin collaborator (extension; owner, dashboard only)
 *   DELETE /v2/projects/{project_id}                                             delete the project and everything in it (extension; admins, dashboard only)
 *   GET    /v2/projects/{project_id}/collaborators                               RevenueCat's collaborator list
 *   GET    /v2/projects/{project_id}/apps/{app_id}/store_settings                non-secret store setup state (extension)
 *   POST   /v2/projects/{project_id}/apps/{app_id}/actions/verify_credentials    ask the store whether the credentials work (extension)
 *   POST   /v2/projects/{project_id}/apps/{app_id}/actions/verify_app_store_connect_key    ask App Store Connect whether the API key works (extension)
 *   POST   /v2/projects/{project_id}/apps/{app_id}/actions/apply_notification_settings  Paddle: create or update the notification destination (extension)
 *   POST   /v2/projects/{project_id}/integrations/webhooks/{id}/test             queue a TEST event to one webhook (extension)
 *   POST   /v2/projects/{project_id}/apps/{app_id}/actions/mass_extend           App Store: extend every active subscriber of a product (extension)
 *   GET    /v2/projects/{project_id}/apps/{app_id}/mass_extensions/{request_id}  status of a mass extension (?product_id=&environment=) (extension)
 */

export const TRANSFER_BEHAVIORS = ["transfer", "transfer_if_no_active", "keep", "share"] as const;
const Behavior = z.enum(TRANSFER_BEHAVIORS);
const ProjectUpdate = z.object({
  name: z.string().trim().min(1, "must not be empty").max(100).optional(),
  transfer_behavior: Behavior.optional(),
  sandbox_transfer_behavior: Behavior.nullable().optional(),
  sandbox_testing_access: z.enum(SANDBOX_ACCESS).optional(),
  sandbox_testers: z.array(z.string().trim().max(100)).max(500).optional(),
});
const TransferOwnership = z.object({ user_id: z.string().min(1).max(100) });

const str = z.string().max(20_000).nullable().optional();
const Verify = z.object({
  app_store: z.object({ bundle_id: str, subscription_private_key: str, subscription_key_id: str, subscription_key_issuer: str }).optional(),
  mac_app_store: z.object({ bundle_id: str, subscription_private_key: str, subscription_key_id: str, subscription_key_issuer: str }).optional(),
  play_store: z.object({ package_name: str, play_service_account_credentials_json: z.union([z.string().max(20_000), z.record(z.unknown())]).nullable().optional() }).optional(),
  amazon: z.object({ package_name: str, shared_secret: str }).optional(),
  stripe: z.object({ stripe_secret_key: str, stripe_account_id: str }).optional(),
  paddle: z.object({ paddle_api_key: str, paddle_is_sandbox: z.boolean().nullable().optional() }).optional(),
  roku: z.object({ roku_api_key: str }).optional(),
  galaxy: z.object({ package_name: str, galaxy_service_account_id: str, galaxy_service_account_private_key: str }).optional(),
});
const VerifyConnectKey = z.object({ bundle_id: str, app_store_connect_api_key: str, app_store_connect_api_key_id: str, app_store_connect_api_key_issuer: str });

const Reason = z.enum(["undeclared", "customer_satisfaction", "other", "service_issue_or_outage"]);
const REASON_CODES = { undeclared: 0, customer_satisfaction: 1, other: 2, service_issue_or_outage: 3 } as const;
const MassExtend = z.object({
  product_id: z.string().min(1).max(200),
  extend_by_days: z.number().int().min(1).max(90),
  extend_reason_code: Reason,
  storefront_country_codes: z.array(z.string().regex(/^[A-Z]{3}$/, "must be ISO 3166-1 alpha-3 codes such as USA")).max(200).optional(),
  environment: z.enum(["production", "sandbox"]).optional(),
});

type ProjectRow = typeof schema.projects.$inferSelect;
type AppRow = typeof schema.apps.$inferSelect;

export function projectSettingsShape(p: ProjectRow, owner: { id: string; email: string; name: string | null } | null = null) {
  return {
    ...projectShape(p), transfer_behavior: p.transferBehavior, sandbox_transfer_behavior: p.sandboxTransferBehavior ?? null,
    sandbox_testing_access: p.sandboxTestingAccess, sandbox_testers: p.sandboxTesters ?? [],
    owner: owner ? { id: owner.id, email: owner.email, name: owner.name ?? null } : null,
  };
}

/** The public origin the stores should call: the forwarded host behind a proxy, else the request's own origin. */
export function publicOrigin(c: V2Context) {
  return requestOrigin(c.req.url, (n) => c.req.header(n));
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function setupRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";

  // The scoping middleware in index.ts runs for `/v2/projects/:project_id/*`; the bare project path checks here too.
  const projectOf = async (c: V2Context) => {
    const id = c.get("projectId");
    if (!id || id !== c.req.param("project_id")) throw notFound("Project");
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    if (!p) throw notFound("Project");
    return p;
  };
  const findApp = async (c: V2Context) => {
    const [a] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, c.get("projectId")), eq(schema.apps.id, c.req.param("app_id")!))).limit(1);
    if (!a) throw notFound("App");
    return a;
  };

  const ownerOf = async (p: ProjectRow) => {
    if (!p.ownerUserId) return null;
    const [u] = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, p.ownerUserId)).limit(1);
    return u ?? null;
  };
  const settingsOut = async (p: ProjectRow) => projectSettingsShape(p, await ownerOf(p));

  r.get(P, scope("project_configuration:projects:read"), async (c) => c.json(await settingsOut(await projectOf(c))));

  r.post(P, scope("project_configuration:projects:read_write"), async (c) => {
    const p = await projectOf(c);
    const b = await body(c, ProjectUpdate);
    const set: Partial<ProjectRow> = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.transfer_behavior !== undefined) set.transferBehavior = b.transfer_behavior;
    if (b.sandbox_transfer_behavior !== undefined) set.sandboxTransferBehavior = b.sandbox_transfer_behavior;
    if (b.sandbox_testing_access !== undefined) set.sandboxTestingAccess = b.sandbox_testing_access;
    // Duplicates and blank lines from a pasted list are dropped; order is kept.
    if (b.sandbox_testers !== undefined) set.sandboxTesters = [...new Set(b.sandbox_testers.map((x) => x.trim()).filter(Boolean))];
    if (!Object.keys(set).length) return c.json(await settingsOut(p));
    const [row] = await db.update(schema.projects).set(set).where(eq(schema.projects.id, p.id)).returning();
    return c.json(await settingsOut(row!));
  });

  // The owner hands the project to another admin. The old owner stays an admin; both get an email.
  r.post(`${P}/actions/transfer_ownership`, scope("project_configuration:projects:read_write"), async (c) => {
    const p = await projectOf(c);
    const who = c.get("principal");
    // Not through an API key, and not through RevenueDot AI: only the person in the dashboard can hand the project over.
    if (who.kind !== "user" || who.via === "assistant") throw new V2Error(403, "authorization_error", "Project ownership can only be transferred from the dashboard.");
    // An owner who left the project no longer counts: any admin may then hand it on.
    const [ownerMember] = p.ownerUserId ? await db.select({ id: schema.memberships.userId }).from(schema.memberships)
      .where(and(eq(schema.memberships.projectId, p.id), eq(schema.memberships.userId, p.ownerUserId))).limit(1) : [];
    if (who.role !== "admin" || (ownerMember && ownerMember.id !== who.userId)) throw new V2Error(403, "authorization_error", "Only the project owner can transfer ownership.");
    const b = await body(c, TransferOwnership);
    if (b.user_id === who.userId && p.ownerUserId === who.userId) throw paramError("You already own this project.", "user_id");
    const [target] = await db.select({ u: schema.users, role: schema.memberships.role }).from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(and(eq(schema.memberships.projectId, p.id), eq(schema.memberships.userId, b.user_id))).limit(1);
    if (!target) throw new V2Error(422, "unprocessable_entity_error", "The new owner must be a collaborator on this project.", "user_id");
    if (target.role !== "admin") throw new V2Error(422, "unprocessable_entity_error", "The new owner must have the Admin role. Change their role first.", "user_id");
    const [row] = await db.update(schema.projects).set({ ownerUserId: target.u.id }).where(eq(schema.projects.id, p.id)).returning();
    const [from] = await db.select().from(schema.users).where(eq(schema.users.id, who.userId)).limit(1);
    const base = linkBase(deps, requestOrigin(c.req.url, (n) => c.req.header(n)));
    const fromName = from?.name?.trim() || from?.email || "The previous owner";
    const toName = target.u.name?.trim() || target.u.email;
    const url = `${base}/projects/${p.id}/settings/general`;
    // Email failures never undo the transfer; the dashboard shows the new owner either way.
    const sent = await Promise.all([
      trySend(deps.mailer, { to: target.u.email, ...ownershipEmail({ base, url, projectName: p.name, from: fromName, to: toName, you: "new" }) }),
      ...(from ? [trySend(deps.mailer, { to: from.email, ...ownershipEmail({ base, url, projectName: p.name, from: fromName, to: toName, you: "old" }) })] : []),
    ]);
    return c.json({ ...(await settingsOut(row!)), email_sent: sent.every(Boolean) });
  });

  // Everything in the project goes with it (foreign keys cascade). Only admins signed in to the dashboard may do this.
  r.delete(P, scope("project_configuration:projects:read_write"), async (c) => {
    const p = await projectOf(c);
    const who = c.get("principal");
    if (who.kind !== "user") throw new V2Error(403, "authorization_error", "Projects can only be deleted from the dashboard by an admin.");
    if (who.role !== "admin") throw new V2Error(403, "authorization_error", "Only project admins can delete a project.");
    await db.delete(schema.projects).where(eq(schema.projects.id, p.id));
    return c.json({ object: "project", id: p.id, deleted_at: deps.now().getTime() });
  });

  r.get(`${P}/collaborators`, scope("project_configuration:collaborators:read"), async (c) => {
    const rows = await db.select({ u: schema.users, role: schema.memberships.role }).from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.projectId, c.get("projectId")));
    rows.sort((a, b) => a.u.createdAt.getTime() - b.u.createdAt.getTime() || a.u.id.localeCompare(b.u.id));
    return c.json(listOf(c, rows.map(({ u, role }) => ({
      object: "collaborator", id: u.id, name: u.name ?? null, email: u.email, role: apiRole(role),
      accepted_at: u.createdAt.getTime(), has_mfa: !!u.totpEnabledAt && !!u.totpSecret,
    })), null));
  });

  const programOf = async (a: AppRow) => {
    const field = a.type === "amazon" ? "small_business_accelerator" : "small_business_program";
    const read = (x: AppRow) => {
      const v = (x.credentials ?? {})[field] as { enrolled?: boolean; periods?: Array<{ entry_date: string; exit_date: string | null }> } | undefined;
      return { enrolled: !!v && v.enrolled !== false && !!v.periods?.length, periods: v?.periods ?? [] };
    };
    const siblings = (await db.select().from(schema.apps).where(eq(schema.apps.projectId, a.projectId)))
      .filter((x) => x.id !== a.id && (a.type === "amazon" ? x.type === "amazon" : x.type === "app_store" || x.type === "mac_app_store"));
    return {
      program: a.type === "amazon" ? "amazon_small_business_accelerator" : "app_store_small_business_program", rate: a.type === "amazon" ? 0.2 : 0.15, standard_rate: 0.3,
      ...read(a), other_apps: siblings.map((x) => ({ app_id: x.id, name: x.name, ...read(x) })).filter((x) => x.periods.length),
    };
  };

  // A zip of the matching example from revenuedot/examples with this app's public key, this server's URL and the
  // project's first entitlement filled in (services/sample-apps). Only public values: the same ones the app ships with.
  r.get(`${P}/apps/:app_id/sample_app`, scope("project_configuration:apps:read"), async (c) => {
    const a = await findApp(c);
    const offered = samplePlatformsFor(a.type);
    const platform = (c.req.query("platform") ?? offered[0]) as SamplePlatform | undefined;
    if (!platform || !offered.includes(platform)) {
      throw paramError(offered.length ? `platform must be one of ${offered.join(", ")} for ${a.type} apps.` : `There is no sample app for ${a.type} apps.`, "platform");
    }
    const [ent] = await db.select({ key: schema.entitlements.lookupKey }).from(schema.entitlements)
      .where(eq(schema.entitlements.projectId, a.projectId)).orderBy(schema.entitlements.createdAt, schema.entitlements.id).limit(1);
    const out = await buildSampleApp({ platform, appType: a.type, appName: a.name, publicKey: a.publicKey, serverUrl: publicOrigin(c), entitlement: ent?.key ?? null, now: deps.now() });
    return new Response(out.data, { headers: {
      "content-type": "application/zip", "content-disposition": `attachment; filename="${out.filename}"`,
      "cache-control": "no-store", "x-revenuedot-examples-commit": out.commit,
    } });
  });

  // What the app configuration page shows: never a secret, only whether it is set and the non-secret ids around it.
  r.get(`${P}/apps/:app_id/store_settings`, scope("project_configuration:apps:read"), async (c) => {
    const a = await findApp(c);
    const cr = a.credentials ?? {};
    const store = notificationStoreOf(a.type);
    const [last] = await db.select().from(schema.storeNotifications)
      .where(and(eq(schema.storeNotifications.appId, a.id), isNotNull(schema.storeNotifications.forwardStatus)))
      .orderBy(desc(schema.storeNotifications.receivedAt)).limit(1);
    const health = await notificationHealth(db, a);
    let clientEmail: string | null = null;
    if (googleKeyConfigured(cr)) { try { clientEmail = serviceAccountOf(a).client_email; } catch { /* shown as configured but unreadable */ } }
    return c.json({
      object: "app_store_settings", app_id: a.id, type: a.type,
      // What the SDK's proxy URL should be: this server as the outside world reaches it.
      api_origin: publicOrigin(c),
      notification_url: store ? `${publicOrigin(c)}/v1/notifications/${store}/${a.id}` : null,
      notification_forward_url: a.notificationForwardUrl ?? null,
      // "Test your setup with the sample app": the examples that can buy with this app (GET …/sample_app?platform=).
      sample_apps: samplePlatformsFor(a.type).map((platform) => ({ platform, ...SAMPLE_APPS[platform] })),
      // Only a notification processed for a known purchase counts; the newest failure stays visible until one succeeds.
      last_notification_at: health.last_notification_at,
      last_notification_error: health.notification_status === "failing" ? health.last_notification_error!.message : null,
      last_notification_received_at: health.last_notification_received_at,
      notification_status: health.notification_status,
      last_forward: last ? { status: last.forwardStatus, at: last.receivedAt.getTime() } : null,
      track_new_purchases: cr.track_new_purchases === true,
      allow_unsigned_receipts: cr.allow_unsigned_receipts === true,
      credentials: {
        subscription_key: { configured: appleKeyConfigured(cr), key_id: s(cr.subscription_key_id), issuer_id: s(cr.subscription_key_issuer) },
        app_store_connect_api_key: {
          configured: typeof cr.app_store_connect_api_key === "string" && !!cr.app_store_connect_api_key,
          key_id: s(cr.app_store_connect_api_key_id), issuer_id: s(cr.app_store_connect_api_key_issuer), vendor_number: s(cr.app_store_connect_vendor_number),
        },
        shared_secret: { configured: !!s(cr.shared_secret) },
        play_service_account: { configured: googleKeyConfigured(cr), client_email: clientEmail },
        xcode_certificate: { configured: !!s(cr.xcode_certificate) },
        // Amazon and Stripe secrets are sealed; only whether they are set (and a Stripe key's mode and last four) comes back.
        amazon_shared_secret: { configured: amazonKeyConfigured(a) },
        stripe_secret_key: stripeKeyHintOf(storeSecretHintOf(a, "stripe_secret_key")),
        stripe_webhook_secret: { configured: storeSecretSet(a, "stripe_webhook_secret") },
        // Paddle, Roku and Galaxy secrets are sealed too: the Paddle key's environment and last four, the rest whether set.
        paddle_api_key: paddleKeyHintOf(storeSecretHintOf(a, "paddle_api_key")),
        paddle_webhook_secret: { configured: storeSecretSet(a, "paddle_webhook_secret") },
        roku_api_key: { configured: rokuKeyConfigured(a) },
        galaxy_service_account: { configured: galaxyKeyConfigured(a), service_account_id: s(cr.galaxy_service_account_id) },
        galaxy_iap_public_key: { configured: !!s(cr.galaxy_iap_public_key) },
      },
      // Amazon: the SNS topic notifications must come from (optional).
      sns_topic_arn: a.type === "amazon" ? s(cr.sns_topic_arn) : null,
      // Stripe: how purchases first seen in a webhook find their customer, and when a subscription counts.
      stripe: a.type === "stripe" ? {
        stripe_account_id: s(cr.stripe_account_id), app_user_id_source: s(cr.app_user_id_source) ?? "metadata",
        app_user_id_metadata_key: s(cr.app_user_id_metadata_key) ?? "app_user_id", register_on: cr.register_on === "invoice_created" ? "invoice_created" : "invoice_paid",
        configured: stripeKeyConfigured(a),
        // "Connect with Stripe" (prd/web-billing/PRD.md §8): its events arrive at the platform's endpoint, not this app's.
        connection: stripeConnected(a) ? "stripe_connect" : storeSecretSet(a, "stripe_secret_key") ? "restricted_key" : null,
        connected_account: stripeConnected(a) ? storeSecretHintOf(a, "stripe_connect_account_id") : null, mode: stripeModeOf(a),
      } : null,
      // Store commission programs (services/commission.ts): App Store Small Business Program, Amazon Small Business
      // Accelerator. `other_apps` are the dates saved on the project's other apps of the store ("Use existing dates").
      small_business_program: a.type === "app_store" || a.type === "mac_app_store" || a.type === "amazon" ? await programOf(a) : null,
      // Paddle: the environment, how purchases first seen in a notification find their customer, and the destination Apply in Paddle made.
      paddle: a.type === "paddle" ? {
        environment: paddleIsSandbox(a) ? "sandbox" : "live", paddle_is_sandbox: cr.paddle_is_sandbox === true,
        app_user_id_source: cr.app_user_id_source === "anonymous" ? "anonymous" : "custom_data", app_user_id_custom_data_key: s(cr.app_user_id_custom_data_key) ?? "app_user_id",
        notification_setting_id: s(cr.paddle_notification_setting_id), events: PADDLE_EVENTS, configured: paddleKeyConfigured(a),
      } : null,
      roku: a.type === "roku" ? { roku_channel_id: s(cr.roku_channel_id), roku_channel_name: s(cr.roku_channel_name), configured: rokuKeyConfigured(a) } : null,
      galaxy: a.type === "galaxy" ? {
        package_name: a.bundleId ?? null, service_account_id: s(cr.galaxy_service_account_id), configured: galaxyKeyConfigured(a),
        iap_public_key_configured: !!s(cr.galaxy_iap_public_key),
      } : null,
    });
  });

  r.post(`${P}/apps/:app_id/actions/verify_credentials`, scope("project_configuration:apps:read"), async (c) => {
    const row = await findApp(c);
    const b = await body(c, Verify);
    const checkedAt = deps.now().getTime();
    const out = (status: "valid" | "invalid" | "unreachable", message: string, extra: Record<string, unknown> = {}) =>
      c.json({ object: "credentials_check", app_id: row.id, store: row.type, status, valid: status === "valid", message, checked_at: checkedAt, ...extra });
    // Sealed Amazon and Stripe secrets are opened in memory for the check only. Secrets this server cannot open still let
    // a new key in the body be checked (the way to replace them); without one the stored key is reported unusable.
    let a: typeof row = row;
    let unopened: string | null = null;
    try { a = await withStoreSecrets(deps, row); } catch (e) { unopened = e instanceof Error ? e.message : String(e); }
    // Values in the body are checked before they are saved; anything missing falls back to what is stored.
    const merged = (over: Record<string, unknown> | undefined) => {
      const cr: Record<string, unknown> = { ...(a.credentials ?? {}) };
      for (const [k, v] of Object.entries(over ?? {})) if (v !== undefined && v !== null && v !== "") cr[k] = v;
      return cr;
    };

    let app: AppRow;
    let overrides = false;
    if (a.type === "app_store" || a.type === "mac_app_store") {
      const over = b[a.type];
      overrides = Object.values(over ?? {}).some((v) => v !== undefined && v !== null && v !== "");
      app = { ...a, bundleId: s(over?.bundle_id) ?? a.bundleId, credentials: merged(over) };
    } else if (a.type === "play_store") {
      const over = b.play_store;
      const json = over?.play_service_account_credentials_json;
      overrides = Object.values(over ?? {}).some((v) => v !== undefined && v !== null && v !== "");
      app = {
        ...a, bundleId: s(over?.package_name) ?? a.bundleId,
        credentials: merged({ play_service_account_credentials_json: json && typeof json === "object" ? JSON.stringify(json) : json }),
      };
    } else if (a.type === "amazon") {
      const over = b.amazon;
      overrides = Object.values(over ?? {}).some((v) => v !== undefined && v !== null && v !== "");
      app = { ...a, bundleId: s(over?.package_name) ?? a.bundleId, credentials: merged({ shared_secret: over?.shared_secret }) };
    } else if (a.type === "stripe" || a.type === "paddle" || a.type === "roku") {
      const over = b[a.type];
      overrides = Object.values(over ?? {}).some((v) => v !== undefined && v !== null && v !== "");
      // A connected app's opened credentials hold the Connect platform's secret key: a body value must never be checked
      // with it (a stripe_account_id from the body would send that key with another developer's account).
      if (overrides && stripeConnected(row)) {
        throw new V2Error(409, "resource_already_exists", "This app is connected with Stripe Connect. Disconnect it before checking a restricted key or another account.", "stripe");
      }
      app = { ...a, credentials: merged(over) };
    } else if (a.type === "galaxy") {
      const over = b.galaxy;
      overrides = Object.values(over ?? {}).some((v) => v !== undefined && v !== null && v !== "");
      app = { ...a, bundleId: s(over?.package_name) ?? a.bundleId, credentials: merged({ galaxy_service_account_id: over?.galaxy_service_account_id, galaxy_service_account_private_key: over?.galaxy_service_account_private_key }) };
    } else {
      throw paramError(`${a.type} apps have no store credentials to check.`, "app_id");
    }
    const newSecret = a.type === "amazon" ? s(b.amazon?.shared_secret) : a.type === "stripe" ? s(b.stripe?.stripe_secret_key) : a.type === "paddle" ? s(b.paddle?.paddle_api_key)
      : a.type === "roku" ? s(b.roku?.roku_api_key) : a.type === "galaxy" ? s(b.galaxy?.galaxy_service_account_private_key) : null;
    if (unopened && !newSecret) return out("invalid", unopened);
    const r = await checkStoreCredentials(deps, app);
    // A check of what is stored also updates the app's credential health (and the alert it drives).
    if (!overrides) await recordCredentialCheck(db, a.id, r, deps.now());
    return out(r.status, r.message, r.extra);
  });

  // The App Store Connect API key (Import products, the product editor): values in the body are checked before they are
  // saved, anything missing falls back to what is stored. Read-only at Apple; the result is not stored. It needs write
  // access: the stored .p8 with another bundle ID in the body would describe any app of the developer's Apple team.
  r.post(`${P}/apps/:app_id/actions/verify_app_store_connect_key`, scope("project_configuration:apps:read_write"), async (c) => {
    const row = await findApp(c);
    if (row.type !== "app_store" && row.type !== "mac_app_store") throw paramError("Only App Store and Mac App Store apps have an App Store Connect API key.", "app_id");
    const b = await body(c, VerifyConnectKey);
    const cr: Record<string, unknown> = { ...(row.credentials ?? {}) };
    for (const k of ["app_store_connect_api_key", "app_store_connect_api_key_id", "app_store_connect_api_key_issuer"] as const) if (s(b[k])) cr[k] = b[k];
    const r = await checkConnectKey(deps, { bundleId: s(b.bundle_id) ?? row.bundleId, credentials: cr });
    return c.json({ object: "credentials_check", app_id: row.id, store: row.type, key: "app_store_connect_api_key", status: r.status, valid: r.status === "valid", message: r.message, checked_at: deps.now().getTime(), ...r.extra });
  });

  // Paddle's "Apply in Paddle": a notification destination in the developer's Paddle account pointing at this app's
  // notification URL, subscribed to the events RevenueDot reads; its secret key is sealed with the app. A second call updates
  // the same destination (its id is kept in the credentials).
  r.post(`${P}/apps/:app_id/actions/apply_notification_settings`, scope("project_configuration:apps:read_write"), async (c) => {
    const row = await findApp(c);
    if (row.type !== "paddle") throw new V2Error(422, "unprocessable_entity_error", "Only Paddle apps can apply notification settings through the store's API.", "app_id");
    let a: typeof row;
    try { a = await withStoreSecrets(deps, row); } catch (e) { throw new V2Error(422, "store_error", e instanceof Error ? e.message : String(e)); }
    if (!paddleKeyConfigured(row)) throw new V2Error(422, "store_error", "Save the Paddle API key first.", "paddle_api_key");
    const { client } = paddleClientFor(deps.stores, deps.fetch);
    const url = `${publicOrigin(c)}/v1/notifications/paddle/${a.id}`;
    const body = { description: `RevenueDot ${a.name}`.slice(0, 100), type: "url", destination: url, subscribed_events: PADDLE_EVENTS, api_version: 1, include_sensitive_fields: false, traffic_source: "all" };
    const cr = a.credentials ?? {};
    const existing = s(cr.paddle_notification_setting_id);
    let setting;
    try {
      try { setting = await client.notificationSetting(a, existing ? { ...body, type: undefined, active: true } : body, existing); } catch (e) {
        // The saved destination was deleted in Paddle: make a new one.
        if (!(existing && e instanceof PaddleApiError && e.kind === "not_found")) throw e;
        setting = await client.notificationSetting(a, body, null);
      }
    } catch (e) {
      if (e instanceof PaddleApiError) {
        const msg = e.kind === "credentials"
          ? `Paddle refused (${e.code ?? e.status}): ${e.message}. The API key needs write access to Notification settings.`
          : e.kind === "transient" ? `Paddle could not be reached: ${e.message}` : `Paddle refused the destination: ${e.message}`;
        throw new V2Error(422, "store_error", msg, undefined, e.kind === "transient");
      }
      throw e;
    }
    const credentials: Record<string, unknown> = { ...(row.credentials ?? {}), paddle_notification_setting_id: setting.id };
    const update: Record<string, string | null> = typeof setting.endpoint_secret_key === "string" && setting.endpoint_secret_key ? { paddle_webhook_secret: setting.endpoint_secret_key } : {};
    const sealed = await sealStoreSecrets({ type: row.type, credentials, secrets: row.secrets }, update, await depsSecretKey(deps));
    await db.update(schema.apps).set({ credentials: sealed.credentials, secrets: sealed.secrets, secretHints: sealed.secretHints }).where(eq(schema.apps.id, row.id));
    return c.json({ object: "notification_settings", app_id: row.id, store: "paddle", notification_setting_id: setting.id, destination: url, subscribed_events: PADDLE_EVENTS, secret_saved: !!update.paddle_webhook_secret });
  });

  // App Store mass extension (Extend Subscription Renewal Dates for All Active Subscribers). Apple then sends a
  // RENEWAL_EXTENDED notification per subscription, which records SUBSCRIPTION_EXTENDED like any single extension.
  const appleApp = async (c: V2Context) => {
    const a = await findApp(c);
    if (a.type !== "app_store" && a.type !== "mac_app_store") throw new V2Error(422, "unprocessable_entity_error", "Mass extensions are only supported for App Store apps.", "app_id");
    let api;
    try { api = appleApiFor(deps.stores, a, deps.fetch, deps.now); } catch (e) { throw new V2Error(422, "store_error", e instanceof Error ? e.message : String(e)); }
    if (!api) throw new V2Error(422, "store_error", "Mass extensions need the app's in-app purchase key. Add it in the app's settings.");
    return { a, api };
  };
  const appleFailure = (e: unknown) => {
    if (e instanceof AppleApiClientError) return new V2Error(422, "store_error", `The App Store rejected the request: ${e.message}`);
    // Apple down is still 422 store_error, retryable: RevenueCat's 503 is server_error alone.
    if (e instanceof RCError) return new V2Error(422, "store_error", e.message, undefined, e.status >= 500);
    return e;
  };
  r.post(`${P}/apps/:app_id/actions/mass_extend`, scope("customer_information:subscriptions:read_write"), async (c) => {
    const { a, api } = await appleApp(c);
    const b = await body(c, MassExtend);
    const env = b.environment ?? "production";
    const requestIdentifier = crypto.randomUUID();
    try {
      await api.massExtendRenewalDate(env, {
        extendByDays: b.extend_by_days, extendReasonCode: REASON_CODES[b.extend_reason_code], requestIdentifier, productId: b.product_id,
        ...(b.storefront_country_codes?.length ? { storefrontCountryCodes: b.storefront_country_codes } : {}),
      });
    } catch (e) { throw appleFailure(e); }
    return c.json({
      object: "subscription_mass_extension", id: requestIdentifier, app_id: a.id, product_id: b.product_id, environment: env,
      extend_by_days: b.extend_by_days, extend_reason_code: b.extend_reason_code, storefront_country_codes: b.storefront_country_codes ?? null,
      complete: false, completed_at: null, succeeded_count: null, failed_count: null, requested_at: deps.now().getTime(),
    }, 202);
  });
  r.get(`${P}/apps/:app_id/mass_extensions/:request_id`, scope("customer_information:subscriptions:read"), async (c) => {
    const { a, api } = await appleApp(c);
    const productId = c.req.query("product_id");
    if (!productId) throw paramError("product_id is required.", "product_id");
    const env = c.req.query("environment") === "sandbox" ? "sandbox" : "production";
    let st;
    try { st = await api.massExtendStatus(env, productId, c.req.param("request_id")!); } catch (e) { throw appleFailure(e); }
    if (!st) throw notFound("Mass extension");
    return c.json({
      object: "subscription_mass_extension", id: c.req.param("request_id"), app_id: a.id, product_id: productId, environment: env,
      complete: st.complete === true, completed_at: st.completeDate ?? null, succeeded_count: st.succeededCount ?? null, failed_count: st.failedCount ?? null,
    });
  });

  // A purchase-shaped TEST event for one webhook, signed and retried like any other delivery; filters do not apply.
  r.post(`${P}/integrations/webhooks/:webhook_integration_id/test`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const [w] = await db.select().from(schema.webhooks)
      .where(and(eq(schema.webhooks.projectId, projectId), eq(schema.webhooks.id, c.req.param("webhook_integration_id")))).limit(1);
    if (!w) throw notFound("Webhook integration");
    if (!w.enabled) throw new V2Error(422, "unprocessable_entity_error", "Deliveries to this webhook are paused. Turn them on to send a test event.", "enabled");
    const now = deps.now();
    const apps = await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId));
    const app = (w.appId ? apps.find((x) => x.id === w.appId) : apps.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0]) ?? null;
    const environment = w.environment === "production" ? "PRODUCTION" : "SANDBOX";
    const id = crypto.randomUUID().toUpperCase();
    const user = `$RCAnonymousID:${crypto.randomUUID().replace(/-/g, "")}`;
    const event = {
      id, type: "TEST", event_timestamp_ms: now.getTime(), app_id: app?.id ?? null, app_user_id: user, original_app_user_id: user, aliases: [user],
      product_id: "test_product", period_type: "NORMAL", purchased_at_ms: now.getTime(), expiration_at_ms: now.getTime() + 30 * 86400_000, environment,
      entitlement_id: null, entitlement_ids: null, presented_offering_id: null, transaction_id: "test_transaction_id", original_transaction_id: "test_original_transaction_id",
      is_family_share: false, country_code: "US", currency: "USD", price: 0, price_in_purchased_currency: 0, subscriber_attributes: {},
      store: webhookStore((app?.type ?? "app_store") as Store), takehome_percentage: 1, tax_percentage: 0, commission_percentage: 0, offer_code: null,
    };
    await db.insert(schema.events).values({ id, projectId, customerId: null, type: "TEST", environment: environment.toLowerCase(), appId: app?.id ?? null, payload: { api_version: "1.0", event }, eventTimestampMs: now.getTime() });
    const deliveryId = crypto.randomUUID();
    const [d] = await db.insert(schema.webhookDeliveries).values({ id: deliveryId, webhookId: w.id, eventId: id, nextAttemptAt: now, createdAt: now }).returning();
    deps.kick?.();
    return c.json({
      object: "webhook_delivery", id: d!.id, webhook_integration_id: w.id, event_id: id, event_type: "TEST", status: d!.status, attempts: d!.attempts,
      next_attempt_at: d!.nextAttemptAt.getTime(), response_status: null, response_ms: null, last_error: null, created_at: d!.createdAt.getTime(),
    }, 201);
  });
}
