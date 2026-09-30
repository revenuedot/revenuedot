import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { webhookStore, type Store } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { RCError } from "../../errors.js";
import { AppStoreServerApi, AppleApiClientError, appleCredentials } from "../../stores/apple/api.js";
import { GoogleApiError, serviceAccountOf } from "../../stores/google/api.js";
import { googleClientFor } from "../../stores/google/index.js";
import { V2Error, body, listOf, notFound, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { appleKeyConfigured, googleKeyConfigured, projectShape } from "./shapes.js";

/**
 * Project setup endpoints for the dashboard (apps, project settings, webhook tests).
 *   GET    /v2/projects/{project_id}                                             project with its settings (extension)
 *   POST   /v2/projects/{project_id}                                             update name and transfer behaviour (extension)
 *   DELETE /v2/projects/{project_id}                                             delete the project and everything in it (extension; admins, dashboard only)
 *   GET    /v2/projects/{project_id}/collaborators                               RevenueCat's collaborator list
 *   GET    /v2/projects/{project_id}/apps/{app_id}/store_settings                non-secret store setup state (extension)
 *   POST   /v2/projects/{project_id}/apps/{app_id}/actions/verify_credentials    ask Apple or Google whether the credentials work (extension)
 *   POST   /v2/projects/{project_id}/integrations/webhooks/{id}/test             queue a TEST event to one webhook (extension)
 */

export const TRANSFER_BEHAVIORS = ["transfer", "transfer_if_no_active", "keep", "share"] as const;
const Behavior = z.enum(TRANSFER_BEHAVIORS);
const ProjectUpdate = z.object({
  name: z.string().trim().min(1, "must not be empty").max(100).optional(),
  transfer_behavior: Behavior.optional(),
  sandbox_transfer_behavior: Behavior.nullable().optional(),
});

const str = z.string().max(20_000).nullable().optional();
const Verify = z.object({
  app_store: z.object({ bundle_id: str, subscription_private_key: str, subscription_key_id: str, subscription_key_issuer: str }).optional(),
  mac_app_store: z.object({ bundle_id: str, subscription_private_key: str, subscription_key_id: str, subscription_key_issuer: str }).optional(),
  play_store: z.object({ package_name: str, play_service_account_credentials_json: z.union([z.string().max(20_000), z.record(z.unknown())]).nullable().optional() }).optional(),
});

type ProjectRow = typeof schema.projects.$inferSelect;
type AppRow = typeof schema.apps.$inferSelect;

export function projectSettingsShape(p: ProjectRow) {
  return { ...projectShape(p), transfer_behavior: p.transferBehavior, sandbox_transfer_behavior: p.sandboxTransferBehavior ?? null };
}

/** The public origin the stores should call: the forwarded host behind a proxy, else the request's own origin. */
export function publicOrigin(c: V2Context) {
  const fwdHost = c.req.header("x-forwarded-host");
  return fwdHost ? `${c.req.header("x-forwarded-proto") ?? "https"}://${fwdHost}` : new URL(c.req.url).origin;
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const storeOf = (type: string) => (type === "app_store" || type === "mac_app_store" ? "apple" : type === "play_store" ? "google" : null);

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

  r.get(P, scope("project_configuration:projects:read"), async (c) => c.json(projectSettingsShape(await projectOf(c))));

  r.post(P, scope("project_configuration:projects:read_write"), async (c) => {
    const p = await projectOf(c);
    const b = await body(c, ProjectUpdate);
    const set: Partial<ProjectRow> = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.transfer_behavior !== undefined) set.transferBehavior = b.transfer_behavior;
    if (b.sandbox_transfer_behavior !== undefined) set.sandboxTransferBehavior = b.sandbox_transfer_behavior;
    if (!Object.keys(set).length) return c.json(projectSettingsShape(p));
    const [row] = await db.update(schema.projects).set(set).where(eq(schema.projects.id, p.id)).returning();
    return c.json(projectSettingsShape(row!));
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
      object: "collaborator", id: u.id, name: u.name ?? null, email: u.email, role: role === "viewer" ? "read_only" : "admin",
      accepted_at: u.createdAt.getTime(), has_mfa: false,
    })), null));
  });

  // What the app configuration page shows: never a secret, only whether it is set and the non-secret ids around it.
  r.get(`${P}/apps/:app_id/store_settings`, scope("project_configuration:apps:read"), async (c) => {
    const a = await findApp(c);
    const cr = a.credentials ?? {};
    const store = storeOf(a.type);
    const [last] = await db.select().from(schema.storeNotifications)
      .where(and(eq(schema.storeNotifications.appId, a.id), isNotNull(schema.storeNotifications.forwardStatus)))
      .orderBy(desc(schema.storeNotifications.receivedAt)).limit(1);
    const [lastIn] = await db.select({ at: schema.storeNotifications.receivedAt, error: schema.storeNotifications.error, type: schema.storeNotifications.type })
      .from(schema.storeNotifications).where(eq(schema.storeNotifications.appId, a.id)).orderBy(desc(schema.storeNotifications.receivedAt)).limit(1);
    let clientEmail: string | null = null;
    if (googleKeyConfigured(cr)) { try { clientEmail = serviceAccountOf(a).client_email; } catch { /* shown as configured but unreadable */ } }
    return c.json({
      object: "app_store_settings", app_id: a.id, type: a.type,
      // What the SDK's proxy URL should be: this server as the outside world reaches it.
      api_origin: publicOrigin(c),
      notification_url: store ? `${publicOrigin(c)}/v1/notifications/${store}/${a.id}` : null,
      notification_forward_url: a.notificationForwardUrl ?? null,
      last_notification_at: lastIn ? Math.max(lastIn.at.getTime(), a.lastNotificationAt?.getTime() ?? 0) : a.lastNotificationAt?.getTime() ?? null,
      last_notification_error: lastIn?.error ?? null,
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
      },
    });
  });

  r.post(`${P}/apps/:app_id/actions/verify_credentials`, scope("project_configuration:apps:read"), async (c) => {
    const a = await findApp(c);
    const b = await body(c, Verify);
    const checkedAt = deps.now().getTime();
    const out = (status: "valid" | "invalid" | "unreachable", message: string, extra: Record<string, unknown> = {}) =>
      c.json({ object: "credentials_check", app_id: a.id, store: a.type, status, valid: status === "valid", message, checked_at: checkedAt, ...extra });
    // Values in the body are checked before they are saved; anything missing falls back to what is stored.
    const merged = (over: Record<string, unknown> | undefined) => {
      const cr: Record<string, unknown> = { ...(a.credentials ?? {}) };
      for (const [k, v] of Object.entries(over ?? {})) if (v !== undefined && v !== null && v !== "") cr[k] = v;
      return cr;
    };

    if (a.type === "app_store" || a.type === "mac_app_store") {
      const over = b[a.type];
      const bundleId = s(over?.bundle_id) ?? a.bundleId;
      const app: AppRow = { ...a, bundleId, credentials: merged(over) };
      let creds;
      try { creds = appleCredentials(app); } catch (e) {
        return out("invalid", e instanceof RCError ? "The in-app purchase key is incomplete. Add the .p8 file, the key ID, the issuer ID and the bundle ID." : String(e));
      }
      if (!creds) return out("invalid", "No in-app purchase key yet. Add the .p8 file, the key ID and the issuer ID.");
      const api = new AppStoreServerApi(creds, deps.fetch ?? ((u, i) => fetch(u, i)), deps.now);
      try {
        // Any transaction id works: Apple answers 404 or 400 when the key is accepted and 401 when it is not.
        await api.get("production", "/inApps/v1/transactions/0");
        return out("valid", "Apple accepted the in-app purchase key.", { key_id: creds.keyId });
      } catch (e) {
        if (e instanceof AppleApiClientError) return out("valid", "Apple accepted the in-app purchase key.", { key_id: creds.keyId });
        if (e instanceof RCError && e.status >= 500 && e.status !== 503) {
          return out("invalid", /not a valid \.p8/.test(e.message)
            ? "The private key is not a valid .p8 file. Upload the file App Store Connect gave you, unchanged."
            : "Apple rejected the key. Check that the key ID and issuer ID belong to this .p8 file and that the key is an In-App Purchase key.");
        }
        return out("unreachable", "Apple could not be reached. Try again in a minute.");
      }
    }

    if (a.type === "play_store") {
      const over = b.play_store;
      const json = over?.play_service_account_credentials_json;
      const app: AppRow = {
        ...a, bundleId: s(over?.package_name) ?? a.bundleId,
        credentials: merged({ play_service_account_credentials_json: json && typeof json === "object" ? JSON.stringify(json) : json }),
      };
      if (!app.bundleId) return out("invalid", "Add the package name first (for example com.example.app).");
      const { client } = googleClientFor(deps.stores, deps.fetch);
      let email: string | null = null;
      try {
        const sa = serviceAccountOf(app);
        email = sa.client_email;
        await client.accessToken(sa);
        // A made-up token: Google answers "not found" when the account can see the app, 401/403 when it cannot.
        await client.call(app, "GET", `/purchases/subscriptionsv2/tokens/${encodeURIComponent("revenuedot-credentials-check")}`);
        return out("valid", "Google accepted the service account and it can read this app's purchases.", { client_email: email });
      } catch (e) {
        if (e instanceof GoogleApiError) {
          if (e.kind === "invalid_token") return out("valid", "Google accepted the service account and it can read this app's purchases.", { client_email: email });
          if (e.kind === "transient") return out("unreachable", "Google could not be reached. Try again in a minute.", { client_email: email });
          const msg = /applicationNotFound|No Play app/.test(e.message)
            ? `Google Play has no app with the package name ${app.bundleId}. Check the package name.`
            : e.status === 403
              ? "The service account works but cannot see this app yet. In Play Console, invite it under Users and permissions with the financial data and order management permissions. New permissions can take up to 36 hours to apply."
              : e.message.includes("JSON") || e.message.includes("client_email") || e.message.includes("PKCS")
                ? "This is not a service account key file. Download a JSON key for the service account in Google Cloud and upload it here."
                : `Google rejected the service account: ${e.message}`;
          return out("invalid", msg, { client_email: email });
        }
        return out("unreachable", "Google could not be reached. Try again in a minute.", { client_email: email });
      }
    }

    throw paramError(`${a.type} apps have no store credentials to check.`, "app_id");
  });

  // A purchase-shaped TEST event for one webhook, signed and retried like any other delivery; filters do not apply.
  r.post(`${P}/integrations/webhooks/:webhook_integration_id/test`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const [w] = await db.select().from(schema.webhooks)
      .where(and(eq(schema.webhooks.projectId, projectId), eq(schema.webhooks.id, c.req.param("webhook_integration_id")))).limit(1);
    if (!w) throw notFound("Webhook integration");
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
