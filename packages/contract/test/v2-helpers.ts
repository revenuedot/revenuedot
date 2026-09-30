import { expect } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "@revenuedot/server/services/auth.js";
import { getOrCreateCustomer } from "@revenuedot/server/repo/customers.js";
import type { Harness } from "../src/harness.js";
import { SPEC_PATH, loadSpec } from "../src/openapi.js";

export const spec = loadSpec();
if (!spec) console.warn(`[v2 tests] RevenueCat OpenAPI spec not found at ${SPEC_PATH}; response schema validation is SKIPPED. Set RC_OPENAPI_V2 to enable it.`);

export interface CallOpts { json?: unknown; body?: string; key?: string; cookie?: string; query?: string; ext?: boolean; headers?: Record<string, string> }

/**
 * Calls a v2 operation by its path template and, unless it is a RevenueDot extension, validates the body
 * against RevenueCat's response schema for that operation and status (errors included).
 */
export function v2(h: Harness) {
  return async function call(method: string, tmpl: string, params: Record<string, string> = {}, o: CallOpts = {}) {
    const path = tmpl.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? (k === "project_id" ? h.ids.project : `missing_${k}`)));
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.cookie) headers.Cookie = o.cookie;
    const key = o.cookie ? "" : o.key ?? h.ids.secretKey;
    const res = await h.fetch(path + (o.query ? `?${o.query}` : ""), { method, json: o.json, body: o.body, key, headers: o.body ? { ...headers, "content-type": "application/json" } : headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    expect(res.headers.get("content-type") ?? "", `${method} ${path}`).toMatch(/application\/json/);
    if (spec && !o.ext) {
      const err = spec.check(method, tmpl, res.status, body);
      expect(err, `${method} ${tmpl} ${res.status} does not match RevenueCat's schema:\n${err}\n${JSON.stringify(body, null, 1).slice(0, 3000)}`).toBeNull();
    }
    if (o.ext && res.status >= 400) expect(body.object).toBe("error");
    return { status: res.status, body, headers: res.headers };
  };
}

/** A second, unrelated project with its own key and one of everything, for isolation tests. */
export async function otherProject(h: Harness) {
  const db = h.db;
  await db.insert(schema.projects).values({ id: "projB", name: "Other" });
  await db.insert(schema.apps).values({ id: "appB", projectId: "projB", name: "Other iOS", type: "app_store", bundleId: "com.other", publicKey: "appl_other" });
  await db.insert(schema.products).values({ id: "prodB", projectId: "projB", appId: "appB", storeIdentifier: "other_monthly", duration: "P1M" });
  await db.insert(schema.entitlements).values({ id: "entlB", projectId: "projB", lookupKey: "other", displayName: "Other" });
  await db.insert(schema.offerings).values({ id: "ofrngB", projectId: "projB", lookupKey: "other", displayName: "Other", isCurrent: true });
  await db.insert(schema.packages).values({ id: "pkgeB", offeringId: "ofrngB", lookupKey: "$rc_monthly", displayName: "Monthly" });
  await db.insert(schema.webhooks).values({ id: "whB", projectId: "projB", name: "Other", url: "https://other.example.com/hook", signingSecret: "whsec_other" });
  const { customer } = await getOrCreateCustomer(db, "projB", "other_user", h.now());
  await db.insert(schema.subscriptions).values({ id: "subB", projectId: "projB", customerId: customer.id, appId: "appB", store: "app_store", storeKey: "otB", productIdentifier: "other_monthly", purchaseDate: h.now(), originalPurchaseDate: h.now(), expiresDate: new Date(h.now().getTime() + 86400_000 * 20) });
  await db.insert(schema.nonSubscriptions).values({ id: "purB", projectId: "projB", customerId: customer.id, appId: "appB", store: "app_store", productIdentifier: "other_lifetime", storeTransactionId: "txB", purchaseDate: h.now() });
  await db.insert(schema.transactions).values({ id: "txnB", projectId: "projB", customerId: customer.id, store: "app_store", storeTransactionId: "txB", productIdentifier: "other_monthly", kind: "purchase", purchasedAt: h.now(), revenueUsd: 9.99 });
  const key = (await createSecretKey(db, "projB", "other")).key;
  const [k] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.projectId, "projB"));
  return { key, keyId: k!.id, customerId: customer.id };
}

/** Signs up a dashboard user and returns the session cookie. */
export async function signup(h: Harness, email = "owner@example.com", project = "Dashboard project") {
  const res = await h.fetch("/auth/signup", { method: "POST", key: "", json: { email, password: "correct horse battery", project_name: project } });
  expect(res.status).toBe(201);
  const set = res.headers.get("set-cookie") ?? "";
  const m = /rd_session=([^;]+)/.exec(set);
  expect(m).not.toBeNull();
  return `rd_session=${m![1]}`;
}

/** Test Store purchase through the SDK endpoint, like a device would. */
export const buy = (h: Harness, user: string, product: string, at: Date, price = 9.99) =>
  h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: user, fetch_token: `test_${at.getTime()}_${crypto.randomUUID()}`, product_id: product, price, currency: "USD" } });
