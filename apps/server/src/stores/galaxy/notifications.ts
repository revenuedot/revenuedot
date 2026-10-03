import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { Codes, RCError } from "../../errors.js";
import { recordCredentialFailure } from "../../services/credential-health.js";
import { withStoreSecrets } from "../../services/store-secrets.js";
import { forwardStoreNotification } from "../forward.js";
import { GalaxyApiError } from "./api.js";
import { galaxyClientFor } from "./index.js";
import { GalaxyNotificationError, readGalaxyNotification } from "./isn.js";
import { handleGalaxyNotification } from "./sync.js";
import { demoteToRejected, logRejected, tooManyRejected } from "../rejected.js";

const { apps, storeNotifications } = schema;

/** The purchase id a notification is about, for its stored id and subtype. */
const purchaseOf = (d: Record<string, any>) =>
  [d.purchaseId, d.renewedPurchaseId, d.resubscribedPurchaseId, d.newPurchaseId, d.refundedPurchaseId, d.firstPurchaseId].find((x) => typeof x === "string" && x) as string | undefined;

/**
 * Samsung Instant Server Notifications: POST /v1/notifications/galaxy/{appId}, the URL set in Seller Portal. The body is a
 * JWT (stores/galaxy/isn.ts); with the app's IAP public key saved its signature must verify. The purchase it names is
 * always re-read from Samsung. Handled and ignored notifications answer 200, temporary failures 500.
 * A notification whose signature does not verify, or (without the key) one Samsung does not vouch for (a purchase it does
 * not know, unreadable claims), is a rejected request (stores/rejected.ts), never part of the app's notification status.
 */
export function galaxyNotificationRoutes(deps: Deps) {
  const r = new Hono();
  r.post("/:appId", async (c) => {
    const now = deps.now();
    const [row] = await deps.db.select().from(apps).where(eq(apps.id, c.req.param("appId"))).limit(1);
    if (!row || row.type !== "galaxy") return c.json({ code: Codes.NOT_FOUND, message: "No Galaxy Store app with this id." }, 404);
    let app: typeof row;
    try { app = await withStoreSecrets(deps, row); } catch (e) {
      console.error(`Galaxy notification for ${row.id}: ${e instanceof Error ? e.message : e}`);
      return c.json({ code: Codes.STORE_PROBLEM, message: "The app's Samsung credentials could not be opened; try again." }, 500);
    }
    const { client } = galaxyClientFor(deps.stores, deps.fetch);
    const raw = await c.req.text();
    const reject = async (error: string, message: string) => {
      if (!(await logRejected(deps, c, app, { store: "galaxy", raw, error }))) return tooManyRejected(c);
      return c.json({ code: Codes.BAD_REQUEST, message }, 400);
    };
    const publicKey = typeof app.credentials?.galaxy_iap_public_key === "string" && app.credentials.galaxy_iap_public_key.trim() ? app.credentials.galaxy_iap_public_key.trim() : null;
    let n;
    try { n = await readGalaxyNotification(raw, { packageName: app.bundleId, publicKey, now }); } catch (e) {
      const message = e instanceof GalaxyNotificationError ? e.message : String(e);
      if (e instanceof GalaxyNotificationError && e.authenticated) {
        // Signed by the app's key pair but not for this app: a real failure of this app's notification URL.
        await deps.db.insert(storeNotifications).values({
          id: `galaxy_${app.id}_invalid_${crypto.randomUUID()}`, projectId: app.projectId, appId: app.id, store: "galaxy", body: raw.slice(0, 64_000), receivedAt: now, error: message,
        });
        return c.json({ code: Codes.BAD_REQUEST, message }, 400);
      }
      return reject(`rejected: ${message}`, message);
    }
    const purchase = purchaseOf(n.data) ?? "";
    const environment = n.data.testPayYn === "Y" || n.data.betaTestYn === "Y" || n.event === "TEST" ? "sandbox" : "production";
    const id = `galaxy_${app.id}_${n.event}_${purchase}_${n.iat ?? ""}`.slice(0, 500);
    const inserted = await deps.db.insert(storeNotifications).values({
      id, projectId: app.projectId, appId: app.id, store: "galaxy", type: n.event, subtype: purchase.slice(0, 200) || null, body: raw, receivedAt: now, environment,
    }).onConflictDoNothing().returning({ id: storeNotifications.id });
    if (!inserted.length) {
      const [prev] = await deps.db.select({ processedAt: storeNotifications.processedAt }).from(storeNotifications).where(eq(storeNotifications.id, id));
      if (prev?.processedAt) return c.json({ status: "duplicate" });
    }
    if (inserted.length && app.notificationForwardUrl) {
      forwardStoreNotification(c, { db: deps.db, fetchFn: deps.fetch ?? client.fetchImpl, url: app.notificationForwardUrl, notificationId: id, raw, strict: deps.edition === "cloud", headers: { "content-type": c.req.header("content-type") ?? "text/plain" } });
    }
    const finish = (set: Partial<typeof storeNotifications.$inferInsert>) => deps.db.update(storeNotifications).set(set).where(eq(storeNotifications.id, id));
    try {
      const result = await handleGalaxyNotification({ db: deps.db, app, client, now }, n);
      await finish({ processedAt: now, error: null });
      if (result.status === "processed") await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
      deps.kick?.();
      return c.json({ status: result.status, verified: n.verified });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Without the IAP public key, a purchase Samsung does not know proves the notification is not Samsung's.
      const settle = (error: string) => n.verified ? finish({ processedAt: now, error }) : demoteToRejected(deps, c, app, "galaxy", id, `rejected: ${error}`);
      if (e instanceof GalaxyApiError && (e.kind === "invalid" || e.kind === "not_found")) {
        await settle(`Galaxy Store: ${message}`);
        return c.json({ status: "invalid" });
      }
      if (e instanceof RCError && e.status < 500) {
        await settle(message);
        return c.json({ status: "ignored" });
      }
      if (e instanceof GalaxyApiError && e.kind === "credentials") await recordCredentialFailure(deps.db, app.id, e.message, now).catch(() => {});
      console.error(`Galaxy notification ${id} failed: ${message}`);
      await finish({ error: message });
      return c.json({ code: Codes.STORE_PROBLEM, message: "Temporary failure; try again." }, 500);
    }
  });
  return r;
}
