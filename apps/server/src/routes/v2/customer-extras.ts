import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { findCustomer, getOrCreateCustomer } from "../../repo/customers.js";
import { customerCenterConfigOf, customerCenterFor, customerCenterProblems } from "../../services/customer-center.js";
import { recordEvent } from "../../services/events.js";
import { V2Error, body, notFound, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { customerShape } from "./shapes.js";

/** Customer transfer, Customer Center configuration, StoreKit configuration files and subscription management URLs. */

const Transfer = z.object({
  target_customer_id: z.string().min(1).max(1500),
  app_ids: z.array(z.string().min(1).max(255)).nullable().optional(),
}).strict();

const ISO_TO_STOREKIT: Record<string, string> = { P1W: "P1W", P1M: "P1M", P2M: "P2M", P3M: "P3M", P6M: "P6M", P1Y: "P1Y" };

export function customerExtraRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";

  // Moves the customer's subscriptions, one-time purchases and transactions to another customer and records a TRANSFER event.
  r.post(`${P}/customers/:customer_id/actions/transfer`, scope("customer_information:customers:read_write", "customer_information:subscriptions:read_write", "customer_information:purchases:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, Transfer);
    const source = await findCustomer(db, projectId, c.req.param("customer_id")!);
    if (!source || source.projectId !== projectId) throw notFound("Customer");
    if (b.target_customer_id === c.req.param("customer_id") || (await findCustomer(db, projectId, b.target_customer_id))?.id === source.id) {
      throw paramError("target_customer_id must be a different customer.", "target_customer_id");
    }
    const now = deps.now();
    const { customer: target } = await getOrCreateCustomer(db, projectId, b.target_customer_id, now);
    const appIds = b.app_ids?.length ? b.app_ids : null;
    if (appIds) {
      const apps = await db.select({ id: schema.apps.id }).from(schema.apps).where(and(eq(schema.apps.projectId, projectId), inArray(schema.apps.id, appIds)));
      const missing = appIds.filter((id) => !apps.some((a) => a.id === id));
      if (missing.length) throw paramError(`app_ids: unknown app id(s): ${missing.join(", ")}.`, "app_ids");
    }
    const S = schema.subscriptions, N = schema.nonSubscriptions, T = schema.transactions;
    const subs = await db.select().from(S).where(and(eq(S.customerId, source.id), ...(appIds ? [inArray(S.appId, appIds)] : [])));
    const ones = await db.select().from(N).where(and(eq(N.customerId, source.id), ...(appIds ? [inArray(N.appId, appIds)] : [])));
    if (!subs.length && !ones.length) throw new V2Error(422, "unprocessable_entity_error", "The customer has no subscriptions or one-time purchases to transfer.");
    if (subs.length) await db.update(S).set({ customerId: target.id }).where(inArray(S.id, subs.map((x) => x.id)));
    if (ones.length) await db.update(N).set({ customerId: target.id }).where(inArray(N.id, ones.map((x) => x.id)));
    for (const s of subs) await db.update(T).set({ customerId: target.id }).where(and(eq(T.customerId, source.id), eq(T.store, s.store), eq(T.productIdentifier, s.productIdentifier)));
    for (const o of ones) await db.update(T).set({ customerId: target.id }).where(and(eq(T.customerId, source.id), eq(T.store, o.store), eq(T.storeTransactionId, o.storeTransactionId)));

    const first = subs[0] ?? null;
    const one = ones[0] ?? null;
    const subject = first
      ? { store: first.store as never, productId: first.productIdentifier, productPlanId: first.productPlanIdentifier, periodType: first.periodType, purchasedAt: first.purchaseDate, expiresAt: first.expiresDate,
          transactionId: first.storeTransactionId, originalTransactionId: first.originalTransactionId ?? first.storeKey, isSandbox: first.isSandbox, isFamilyShare: first.ownershipType === "FAMILY_SHARED" }
      : { store: one!.store as never, productId: one!.productIdentifier, periodType: "normal", purchasedAt: one!.purchaseDate, expiresAt: null,
          transactionId: one!.storeTransactionId, originalTransactionId: one!.storeTransactionId, isSandbox: one!.isSandbox, isFamilyShare: false };
    const alias = async (id: string) => (await db.select({ a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(eq(schema.customerAliases.customerId, id))).map((x) => x.a);
    await recordEvent(db, {
      projectId, appId: first?.appId ?? one?.appId ?? null, customer: target, appUserId: target.originalAppUserId, derived: { type: "TRANSFER" }, subject, now,
      extra: { transferred_from: await alias(source.id), transferred_to: await alias(target.id) },
    });
    deps.kick?.();
    const [s2] = await db.select().from(schema.customers).where(eq(schema.customers.id, source.id));
    const [t2] = await db.select().from(schema.customers).where(eq(schema.customers.id, target.id));
    return c.json({ source_customer: await customerShape(db, s2!, { now, detail: true }), target_customer: await customerShape(db, t2!, { now, detail: true }) });
  });

  // The Customer Center configuration the SDK would get for this customer. With no platform: the whole configuration.
  // `locale` (RevenueDot extension): the language the SDK would get for that locale, as with its X-Preferred-Locales header.
  r.get(`${P}/customers/:customer_id/customer_center`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const cust = await findCustomer(db, projectId, c.req.param("customer_id")!);
    if (!cust || cust.projectId !== projectId) throw notFound("Customer");
    const platform = c.req.query("platform");
    if (platform !== undefined && !["ios", "android", "macos", "web", "amazon"].includes(platform)) throw paramError("platform must be ios, android, macos, web or amazon.", "platform");
    return c.json({ object: "customer_center_config", customer_center: await customerCenterFor(db, projectId, { preferredLocales: c.req.query("locale") ?? null }) });
  });

  // RevenueDot extension: the stored overrides, the editable configuration they make with the default (`config`, what the
  // dashboard editor shows) and the configuration the SDK receives (`customer_center`, English unless `locale` is given).
  r.get(`${P}/customer_center_config`, scope("project_configuration:projects:read"), async (c) => {
    const [row] = await db.select({ cc: schema.projects.customerCenter }).from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))).limit(1);
    const projectId = c.get("projectId");
    return c.json({
      object: "customer_center_config",
      customer_center: await customerCenterFor(db, projectId, { preferredLocales: c.req.query("locale") ?? null }),
      config: await customerCenterConfigOf(db, projectId),
      overrides: row?.cc ?? null,
    });
  });

  // RevenueDot extension: replace the stored Customer Center configuration (merged over the default; null resets it).
  // The result is validated as a whole: paths, survey, promotional offers, colours, translations and custom strings.
  r.post(`${P}/customer_center_config`, scope("project_configuration:projects:read_write"), async (c) => {
    const b = await body(c, z.object({ customer_center: z.record(z.unknown()).nullable() }).strict());
    const projectId = c.get("projectId");
    if (b.customer_center) {
      const problems = await customerCenterProblems(db, projectId, b.customer_center);
      if (problems.length) throw paramError(`customer_center: ${problems.slice(0, 5).join(" ")}${problems.length > 5 ? ` (${problems.length - 5} more)` : ""}`, "customer_center");
    }
    await db.update(schema.projects).set({ customerCenter: b.customer_center }).where(eq(schema.projects.id, projectId));
    return c.json({ object: "customer_center_config", customer_center: await customerCenterFor(db, projectId), config: await customerCenterConfigOf(db, projectId), overrides: b.customer_center });
  });

  // A StoreKit configuration file (Xcode, local testing) for an App Store app's products.
  r.get(`${P}/apps/:app_id/store_kit_config`, scope("project_configuration:apps:read"), async (c) => {
    const projectId = c.get("projectId");
    const [app] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, c.req.param("app_id")!))).limit(1);
    if (!app) throw notFound("App");
    if (app.type !== "app_store" && app.type !== "mac_app_store") throw paramError("A StoreKit configuration file is only available for App Store apps.", "app_id");
    const prods = await db.select().from(schema.products).where(and(eq(schema.products.projectId, projectId), eq(schema.products.appId, app.id)));
    const price = (p: typeof prods[number]) => (p.testStorePriceMicros ? (p.testStorePriceMicros / 1_000_000).toFixed(2) : "0.99");
    const text = (p: typeof prods[number]) => [{ description: p.displayName ?? p.storeIdentifier, displayName: p.displayName ?? p.storeIdentifier, locale: "en_US" }];
    prods.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.storeIdentifier < b.storeIdentifier ? -1 : 1));
    const subs = prods.filter((p) => p.type === "subscription" && p.state === "active");
    const groupId = newId("", 8).toUpperCase();
    const contents = {
      identifier: newId("", 8).toUpperCase(), nonRenewingSubscriptions: [], settings: {},
      products: prods.filter((p) => p.type !== "subscription" && p.state === "active").map((p) => ({
        displayPrice: price(p), familyShareable: false, internalID: newId("", 8).toUpperCase(), localizations: text(p), productID: p.storeIdentifier,
        referenceName: p.displayName ?? p.storeIdentifier, type: p.type === "consumable" ? "Consumable" : "NonConsumable",
      })),
      subscriptionGroups: subs.length ? [{
        id: groupId, localizations: [], name: app.name,
        subscriptions: subs.map((p, i) => ({
          adHocOffers: [], codeOffers: [], displayPrice: price(p), familyShareable: false, groupNumber: i + 1, internalID: newId("", 8).toUpperCase(), introductoryOffer: null,
          localizations: text(p), productID: p.storeIdentifier, recurringSubscriptionPeriod: ISO_TO_STOREKIT[p.duration ?? "P1M"] ?? "P1M",
          referenceName: p.displayName ?? p.storeIdentifier, subscriptionGroupID: groupId, type: "RecurringSubscription",
        })),
      }] : [],
      version: { major: 4, minor: 0 },
    };
    return c.json({ object: "store_kit_config_file", contents });
  });

  // Where a customer manages one subscription. Apple and Google have fixed pages; stores that need a signed link are not supported here.
  r.get(`${P}/subscriptions/:subscription_id/authenticated_management_url`, scope("customer_information:subscriptions:read"), async (c: V2Context) => {
    const projectId = c.get("projectId");
    const id = c.req.param("subscription_id")!;
    const [sub] = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, projectId), eq(schema.subscriptions.id, id))).limit(1);
    if (!sub) throw notFound("Subscription");
    let url: string | null = null;
    if (sub.store === "app_store" || sub.store === "mac_app_store") url = "https://apps.apple.com/account/subscriptions";
    else if (sub.store === "play_store") {
      const [app] = sub.appId ? await db.select().from(schema.apps).where(eq(schema.apps.id, sub.appId)).limit(1) : [];
      url = `https://play.google.com/store/account/subscriptions?sku=${encodeURIComponent(sub.productIdentifier)}${app?.bundleId ? `&package=${encodeURIComponent(app.bundleId)}` : ""}`;
    }
    return c.json({ object: "authenticated_management_url", management_url: url });
  });
}
