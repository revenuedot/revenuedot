import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { connectCredentials } from "../../stores/apple/connect.js";
import { hasServiceAccount } from "../../stores/google/api.js";
import { StoreOpError } from "../../services/store-ops.js";
import { PRICE_STORES, cachedListings, refreshStorePrices, type ListingRow, type SyncRow } from "../../services/store-prices.js";
import { MAX_CSV_BYTES, commitEdit, createEdit, editRows, editShape, exportCsv, findEdit, listEdits, storeKind } from "../../services/product-editor.js";
import { auditActor } from "./audit.js";
import { V2Error, body, listOf, notFound, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { v2StoreError } from "./store-ops.js";

/**
 * Store prices and the product editor (extensions; prd/catalog/PRD.md "Store prices and status", "Product editor"):
 *   GET    /v2/projects/{id}/store_prices?app_id=                                   cached store products with every territory's price
 *   POST   /v2/projects/{id}/apps/{app_id}/store_prices/actions/refresh              read them from the store again
 *   GET    /v2/projects/{id}/apps/{app_id}/store_products/export.csv?store_identifiers=a,b | all=true
 *   GET    /v2/projects/{id}/product_edits?app_id=  ·  POST /v2/projects/{id}/product_edits   upload a CSV
 *   GET    /v2/projects/{id}/product_edits/{edit_id}  ·  POST (options)  ·  DELETE (discard before commit)
 *   POST   /v2/projects/{id}/product_edits/{edit_id}/actions/commit  ·  …/actions/retry
 * Reads need `project_configuration:products:read`; uploads, commits, retries and refreshes need `…:read_write`
 * (admins and developers).
 */

const Upload = z.object({
  app_id: z.string().min(1),
  file_name: z.string().trim().max(200).optional(),
  csv: z.string().min(1, "the file is empty.").refine((t) => new TextEncoder().encode(t).length <= MAX_CSV_BYTES, `the file is larger than ${MAX_CSV_BYTES / 1_000_000} MB.`),
  preserve_current_price: z.boolean().optional(),
});
const Options = z.object({ preserve_current_price: z.boolean() });

/** Product editor failures: a commit already running is locked (409), other state conflicts are 409 invalid_request. */
function editError(e: unknown): unknown {
  if (e instanceof StoreOpError && e.kind === "conflict") {
    return e.param === "locked" ? new V2Error(409, "resource_locked_error", e.message) : new V2Error(409, "invalid_request", e.message, e.param === "status" ? undefined : e.param);
  }
  return v2StoreError(e);
}

/** Whether RevenueDot can read this app's prices, and why not. */
export function priceAccess(app: typeof schema.apps.$inferSelect): { can_read_prices: boolean; reason: string | null } {
  if (!PRICE_STORES.has(app.type)) return { can_read_prices: false, reason: app.type === "test_store" ? "Test Store prices are set on each product in RevenueDot." : app.type === "stripe" ? "Stripe prices come with the imported web products." : "This store has no price API RevenueDot reads." };
  if (app.type === "play_store") return hasServiceAccount(app) ? { can_read_prices: true, reason: null } : { can_read_prices: false, reason: "Add the app's Play service account JSON to read and change prices." };
  if (connectCredentials(app)) return { can_read_prices: true, reason: null };
  const c = app.credentials ?? {};
  const hasIap = typeof c.subscription_key_id === "string" || typeof c.key_id === "string";
  return {
    can_read_prices: false,
    reason: `Reading and changing App Store prices needs an App Store Connect API team key with the App Manager role (Users and Access → Integrations → App Store Connect API).${hasIap ? " The app's In-App Purchase key only works with the App Store Server API and cannot list or change prices." : ""}`,
  };
}

export function listingShape(l: ListingRow, productId: string | null = null) {
  return {
    object: "store_listing" as const, app_id: l.appId, store_identifier: l.storeIdentifier, product_id: productId, type: l.type, display_name: l.displayName,
    duration: l.duration, store_state: l.storeState, status: l.storeState ? l.storeState.toLowerCase() : null,
    group: l.groupId ? { id: l.groupId, name: l.groupName } : null, store_id: l.storeRef,
    price: l.basePriceMicros !== null && l.baseCurrency ? { amount_micros: l.basePriceMicros, currency: l.baseCurrency, territory: l.baseTerritory } : null,
    prices: l.prices, editable: l.editable, note: l.note, refreshed_at: l.refreshedAt.getTime(),
  };
}

const syncShape = (app: typeof schema.apps.$inferSelect, s: SyncRow | undefined) => ({
  object: "store_price_sync" as const, app_id: app.id, store: app.type, ...priceAccess(app),
  status: s?.status ?? "never", error: s?.error ?? null, item_count: s?.itemCount ?? 0, refreshed_at: s?.refreshedAt.getTime() ?? null,
});

export function productEditorRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";
  const findApp = async (c: V2Context, id = c.req.param("app_id")!) => {
    const [app] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, c.get("projectId")), eq(schema.apps.id, id))).limit(1);
    if (!app) throw notFound("App");
    return app;
  };
  const findEditOr404 = async (c: V2Context) => {
    const e = await findEdit(deps, c.get("projectId"), c.req.param("edit_id")!);
    if (!e) throw notFound("Product edit");
    return e;
  };
  /** Emails of the people who uploaded, for the Files tab. */
  const emails = async (ids: (string | null)[]) => {
    const users = [...new Set(ids.filter((x): x is string => !!x && x.startsWith("usr_")))];
    if (!users.length) return new Map<string, string>();
    const rows = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, users));
    return new Map(rows.map((u) => [u.id, u.email]));
  };
  const catalogIds = async (projectId: string, listings: ListingRow[]) => {
    const appIds = [...new Set(listings.map((l) => l.appId))];
    if (!appIds.length) return new Map<string, string>();
    const rows = await db.select({ id: schema.products.id, appId: schema.products.appId, sid: schema.products.storeIdentifier }).from(schema.products)
      .where(and(eq(schema.products.projectId, projectId), inArray(schema.products.appId, appIds)));
    return new Map(rows.map((p) => [`${p.appId}|${p.sid}`, p.id]));
  };

  r.get(`${P}/store_prices`, scope("project_configuration:products:read"), async (c) => {
    const projectId = c.get("projectId");
    const appId = c.req.query("app_id") || undefined;
    if (appId) await findApp(c, appId);
    const { rows, syncs } = await cachedListings(deps, projectId, appId);
    const apps = (await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), ...(appId ? [eq(schema.apps.id, appId)] : []))))
      .filter((a) => PRICE_STORES.has(a.type));
    const ids = await catalogIds(projectId, rows);
    const bySync = new Map(syncs.map((s) => [s.appId, s]));
    return c.json({ ...listOf(c, rows.map((l) => listingShape(l, ids.get(`${l.appId}|${l.storeIdentifier}`) ?? null)), null), apps: apps.map((a) => syncShape(a, bySync.get(a.id))) });
  });

  r.post(`${P}/apps/:app_id/store_prices/actions/refresh`, scope("project_configuration:products:read_write"), async (c) => {
    const app = await findApp(c);
    let read;
    try { read = await refreshStorePrices(deps, app); } catch (e) { throw v2StoreError(e); }
    const { rows, syncs } = await cachedListings(deps, app.projectId, app.id);
    const ids = await catalogIds(app.projectId, rows);
    return c.json({
      object: "store_price_refresh", app_id: app.id, warnings: read.warnings, sync: syncShape(app, syncs[0]),
      items: rows.map((l) => listingShape(l, ids.get(`${l.appId}|${l.storeIdentifier}`) ?? null)),
    });
  });

  r.get(`${P}/apps/:app_id/store_products/export.csv`, scope("project_configuration:products:read"), async (c) => {
    const app = await findApp(c);
    const all = c.req.query("all") === "true";
    const ids = (c.req.queries("store_identifiers") ?? []).flatMap((v) => v.split(",")).map((x) => x.trim()).filter(Boolean);
    if (!all && !ids.length) throw paramError("Choose products: store_identifiers=a,b or all=true.", "store_identifiers");
    if (ids.length > 2000) throw paramError("At most 2,000 store_identifiers at a time.", "store_identifiers");
    let out;
    try { out = await exportCsv(deps, app, all ? null : [...new Set(ids)]); } catch (e) { throw v2StoreError(e); }
    const slug = app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
    const name = `${slug}-${storeKind(app.type) === "apple" ? "app-store" : "play-store"}-products-${deps.now().toISOString().slice(0, 10)}.csv`;
    return new Response(out.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "x-product-count": String(out.products), "cache-control": "no-store" } });
  });

  r.get(`${P}/product_edits`, scope("project_configuration:products:read"), async (c) => {
    const appId = c.req.query("app_id") || undefined;
    if (appId) await findApp(c, appId);
    const edits = await listEdits(deps, c.get("projectId"), appId);
    const who = await emails(edits.map((e) => e.createdBy));
    const counts = new Map<string, { pending: number; succeeded: number; failed: number }>();
    if (edits.length) {
      const rows = await db.select({ editId: schema.productEditRows.editId, status: schema.productEditRows.status }).from(schema.productEditRows).where(inArray(schema.productEditRows.editId, edits.map((e) => e.id)));
      for (const r of rows) {
        const x = counts.get(r.editId) ?? { pending: 0, succeeded: 0, failed: 0 };
        if (r.status === "pending" || r.status === "succeeded" || r.status === "failed") x[r.status]++;
        counts.set(r.editId, x);
      }
    }
    return c.json(listOf(c, edits.map((e) => ({ ...editShape(e), results: counts.get(e.id) ?? { pending: 0, succeeded: 0, failed: 0 }, created_by_email: who.get(e.createdBy ?? "") ?? null })), null));
  });

  r.post(`${P}/product_edits`, scope("project_configuration:products:read_write"), async (c) => {
    // The body is read only when it can hold a file of at most 1 MB (JSON escapes at most double it).
    if (Number(c.req.header("content-length") ?? 0) > 2 * MAX_CSV_BYTES + 10_000) throw paramError(`csv: the file is larger than ${MAX_CSV_BYTES / 1_000_000} MB.`, "csv");
    const b = await body(c, Upload);
    const app = await findApp(c, b.app_id).catch(() => { throw paramError("app_id does not match an app in this project.", "app_id"); });
    const p = c.get("principal");
    let edit;
    try {
      edit = await createEdit(deps, app, { fileName: b.file_name ?? "products.csv", csv: b.csv, preserveCurrentPrice: b.preserve_current_price, createdBy: p.kind === "user" ? p.userId : p.keyId });
    } catch (e) { throw editError(e); }
    return c.json(editShape(edit, await editRows(deps, edit.id)), 201);
  });

  r.get(`${P}/product_edits/:edit_id`, scope("project_configuration:products:read"), async (c) => {
    const e = await findEditOr404(c);
    const who = await emails([e.createdBy]);
    return c.json({ ...editShape(e, await editRows(deps, e.id)), created_by_email: who.get(e.createdBy ?? "") ?? null });
  });

  r.post(`${P}/product_edits/:edit_id`, scope("project_configuration:products:read_write"), async (c) => {
    const e = await findEditOr404(c);
    const b = await body(c, Options);
    if (e.status !== "ready") throw new V2Error(409, "invalid_request", "Options can only change before the edit is committed.");
    if (storeKind(e.store) !== "apple") throw paramError("preserve_current_price applies to App Store subscriptions only.", "preserve_current_price");
    // Only while the edit is still ready: a commit that starts at the same moment keeps the options it read.
    const E = schema.productEdits;
    const [row] = await db.update(E).set({ options: { ...e.options, preserve_current_price: b.preserve_current_price }, updatedAt: deps.now() })
      .where(and(eq(E.id, e.id), eq(E.status, "ready"), or(isNull(E.lockedUntil), lt(E.lockedUntil, deps.now())))).returning();
    if (!row) throw new V2Error(409, "invalid_request", "Options can only change before the edit is committed.");
    return c.json(editShape(row, await editRows(deps, e.id)));
  });

  r.delete(`${P}/product_edits/:edit_id`, scope("project_configuration:products:read_write"), async (c) => {
    const e = await findEditOr404(c);
    const notCommitted = () => new V2Error(409, "invalid_request", "Only an edit that was not committed can be discarded; committed rows stay in the history.");
    if (e.status !== "ready" && e.status !== "invalid") throw notCommitted();
    // In one statement with the check, so a commit that starts at the same moment is never deleted under it.
    const E = schema.productEdits;
    const gone = await db.delete(E).where(and(eq(E.id, e.id), inArray(E.status, ["ready", "invalid"]), or(isNull(E.lockedUntil), lt(E.lockedUntil, deps.now())))).returning({ id: E.id });
    if (!gone.length) throw notCommitted();
    return c.json({ object: "product_edit", id: e.id, deleted_at: deps.now().getTime() });
  });

  for (const action of ["commit", "retry"] as const) {
    r.post(`${P}/product_edits/:edit_id/actions/${action}`, scope("project_configuration:products:read_write"), async (c) => {
      const e = await findEditOr404(c);
      if (action === "retry" && !(await editRows(deps, e.id)).some((x) => x.status === "failed")) throw new V2Error(409, "invalid_request", "No row failed, so there is nothing to retry.");
      let done;
      try { done = await commitEdit(deps, e, await auditActor(deps, c.get("principal")), { retry: action === "retry" }); } catch (err) { throw editError(err); }
      return c.json(editShape(done, await editRows(deps, done.id)));
    });
  }
}
