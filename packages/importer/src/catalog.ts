// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: copies apps, public SDK keys, products, entitlements, offerings and packages from RevenueCat to RevenueDot.
// Docs: https://revenuedot.app/docs/migrate
import { HttpError } from "./http.js";
import type { RevenueCatClient, RcApp, RcProduct } from "./revenuecat.js";
import type { RevenueDotClient } from "./revenuedot.js";
import { addProblem, emptyCatalog, type CatalogMap, type Problem } from "./state.js";

export interface CatalogCounts { created: number; matched: number; updated: number }
export type CatalogReport = Record<"apps" | "publicKeys" | "products" | "entitlements" | "offerings" | "packages", CatalogCounts>;

const counts = (): CatalogCounts => ({ created: 0, matched: 0, updated: 0 });
export const emptyCatalogReport = (): CatalogReport => ({ apps: counts(), publicKeys: counts(), products: counts(), entitlements: counts(), offerings: counts(), packages: counts() });

const SUPPORTED_APPS = new Set(["app_store", "mac_app_store", "play_store", "amazon", "stripe", "rc_billing", "roku", "paddle", "test_store"]);
const ID_FIELD: Record<string, string> = { app_store: "bundle_id", mac_app_store: "bundle_id", play_store: "package_name", amazon: "package_name" };

export const appIdentifier = (a: RcApp): string | null => {
  const f = ID_FIELD[a.type];
  const block = a[a.type] as Record<string, unknown> | null | undefined;
  return f && typeof block?.[f] === "string" ? (block[f] as string) : null;
};

/** What to re-enter in RevenueDot for each store: store secrets cannot be read back from RevenueCat. */
export function credentialsNeeded(type: string): string | null {
  switch (type) {
    case "app_store": case "mac_app_store":
      return "the App Store In-App Purchase key (.p8 file, key ID, issuer ID); add the app-specific shared secret too if older app versions send StoreKit 1 receipts";
    case "play_store": return "the Google Play service account JSON (with View financial data, so purchase tokens can be looked up)";
    case "amazon": return "the Amazon Appstore shared key";
    case "stripe": return "the Stripe secret key";
    case "paddle": return "the Paddle API key";
    case "roku": return "the Roku Pay API key";
    default: return null;
  }
}

/** Whether the app's store credentials are set (the flags RevenueCat and RevenueDot both return on apps). */
export const credentialsConfigured = (a: RcApp) => {
  const b = (a[a.type] ?? {}) as Record<string, unknown>;
  if (a.type === "app_store") return b.subscription_key_configured === true;
  if (a.type === "play_store") return b.play_service_account_credentials_configured === true;
  return false;
};

interface Opts { dryRun: boolean; publicKeys: boolean; log: (m: string) => void }

/** Brings the catalog over. Existing RevenueDot objects are matched by their natural keys, so a re-run creates nothing twice. */
export async function importCatalog(rc: RevenueCatClient, rd: RevenueDotClient, o: Opts): Promise<{ map: CatalogMap; report: CatalogReport; problems: Problem[] }> {
  const map = emptyCatalog();
  const report = emptyCatalogReport();
  const problems: Problem[] = [];
  const write = async <T>(fn: () => Promise<T>): Promise<T | null> => (o.dryRun ? null : fn());

  // Apps: matched by store and bundle id / package name; apps without one by store type (and name when several).
  const rcApps = await rc.apps();
  const ours = await rd.apps();
  for (const a of rcApps) {
    const identifier = appIdentifier(a);
    map.apps[a.id] = { id: null, type: a.type, name: a.name, identifier };
    if (!SUPPORTED_APPS.has(a.type)) {
      addProblem(problems, { kind: "skipped", message: `App "${a.name}" (${a.type}) is a store RevenueDot does not support yet; its products and purchases are skipped.` });
      continue;
    }
    const sameType = ours.filter((x) => x.type === a.type);
    let hit = identifier ? sameType.find((x) => appIdentifier(x) === identifier) : sameType.find((x) => x.name === a.name) ?? (sameType.length === 1 ? sameType[0] : undefined);
    if (hit) report.apps.matched++;
    else {
      const body: Record<string, unknown> = { name: a.name, type: a.type };
      if (identifier) body[a.type] = { [ID_FIELD[a.type]!]: identifier };
      // Roku's channel id and name and Paddle's sandbox flag are not secret, so they come over too.
      const block = (a[a.type] ?? {}) as Record<string, unknown>;
      if (a.type === "roku") body.roku = Object.fromEntries(["roku_channel_id", "roku_channel_name"].filter((k) => typeof block[k] === "string" && block[k]).map((k) => [k, block[k]]));
      if (a.type === "paddle" && block.paddle_is_sandbox === true) body.paddle = { paddle_is_sandbox: true };
      hit = (await write(() => rd.post<RcApp>("/apps", body))) ?? undefined;
      if (hit) ours.push(hit);
      report.apps.created++;
      o.log(`  app ${a.name} (${a.type}${identifier ? ` ${identifier}` : ""}) ${o.dryRun ? "would be created" : "created"}`);
    }
    map.apps[a.id]!.id = hit?.id ?? null;
    const need = credentialsNeeded(a.type);
    if (need && !(hit && credentialsConfigured(hit))) addProblem(problems, { kind: "credentials", message: `${a.name} (${a.type}${identifier ? `, ${identifier}` : ""}): enter ${need}.${credentialsConfigured(a) ? " RevenueCat has them, but store secrets cannot be exported." : ""}` });
    if (a.type === "rc_billing") addProblem(problems, { kind: "note", message: `${a.name} uses RevenueCat Billing: current access is imported, but those subscriptions keep renewing through RevenueCat.` });

    // The SDK key shipped in existing app binaries keeps working when RevenueDot uses the same string.
    if (o.publicKeys && hit?.id !== undefined) {
      const keys = await rc.publicKeys(a.id).catch((e) => { addProblem(problems, { kind: "note", message: `Could not read the public SDK keys of ${a.name}: ${e.message}` }); return []; });
      const key = keys.find((k) => k.environment === "production") ?? keys[0];
      if (key) {
        try {
          await write(() => rd.setPublicKey(hit!.id, key.key));
          report.publicKeys.updated++;
        } catch (e) {
          addProblem(problems, { kind: "note", message: `${a.name}: kept RevenueDot's own SDK key (${e instanceof HttpError && e.status === 409 ? "RevenueCat's key is already used by another RevenueDot app" : e instanceof Error ? e.message : e}).` });
        }
        if (keys.filter((k) => k.environment !== key.environment).length) addProblem(problems, { kind: "note", message: `${a.name}: only the ${key.environment} SDK key is kept; RevenueDot has one key per app.` });
      }
    } else if (o.publicKeys && o.dryRun) report.publicKeys.updated++;
  }

  // Products: matched by app and store identifier.
  const ourProducts = await rd.products();
  for (const p of await rc.products()) {
    const app = map.apps[p.app_id];
    map.products[p.id] = { id: null, storeIdentifier: p.store_identifier, appId: app?.id ?? null, rcAppId: p.app_id, type: p.type };
    if (!app || !SUPPORTED_APPS.has(app.type)) continue;
    let hit = app.id ? ourProducts.find((x) => x.app_id === app.id && x.store_identifier === p.store_identifier) : undefined;
    if (hit) report.products.matched++;
    else {
      const body: Record<string, unknown> = { store_identifier: p.store_identifier, app_id: app.id, type: p.type, display_name: p.display_name ?? null };
      if (p.type === "subscription" && p.subscription?.duration) body.subscription = { duration: p.subscription.duration };
      hit = (app.id ? await write(() => rd.post<RcProduct>("/products", body)) : null) ?? undefined;
      if (hit) ourProducts.push(hit);
      report.products.created++;
    }
    map.products[p.id]!.id = hit?.id ?? null;
    if (hit && p.state === "inactive" && hit.state !== "inactive") { await write(() => rd.post(`/products/${hit!.id}/actions/archive`, {})); report.products.updated++; }
  }

  // Entitlements: matched by lookup key; product attachments added (never removed).
  const ourEnts = await rd.entitlements();
  for (const e of await rc.entitlements()) {
    let hit = ourEnts.find((x) => x.lookup_key === e.lookup_key);
    if (hit) report.entitlements.matched++;
    else {
      hit = (await write(() => rd.post<typeof ourEnts[number]>("/entitlements", { lookup_key: e.lookup_key, display_name: e.display_name }))) ?? undefined;
      report.entitlements.created++;
    }
    map.entitlements[e.id] = { id: hit?.id ?? null, lookupKey: e.lookup_key };
    const want = (await rc.entitlementProducts(e.id)).map((p) => map.products[p.id]?.id).filter((x): x is string => !!x);
    const have = new Set((hit?.products?.items ?? []).map((p) => p.id));
    const missing = [...new Set(want)].filter((id) => !have.has(id));
    for (let i = 0; i < missing.length && hit; i += 50) {
      await write(() => rd.post(`/entitlements/${hit!.id}/actions/attach_products`, { product_ids: missing.slice(i, i + 50) }));
    }
    if (missing.length) report.entitlements.updated++;
    if (hit && e.state === "inactive" && hit.state !== "inactive") await write(() => rd.post(`/entitlements/${hit!.id}/actions/archive`, {}));
  }

  // Offerings and packages: matched by lookup key; metadata, positions and product attachments follow RevenueCat.
  const ourOfferings = await rd.offerings();
  const rcOfferings = await rc.offerings();
  for (const off of rcOfferings) {
    let hit = ourOfferings.find((x) => x.lookup_key === off.lookup_key);
    if (hit) {
      report.offerings.matched++;
      const changed = hit.display_name !== off.display_name || JSON.stringify(hit.metadata ?? null) !== JSON.stringify(off.metadata ?? null);
      if (changed) { await write(() => rd.post(`/offerings/${hit!.id}`, { display_name: off.display_name, metadata: off.metadata ?? null })); report.offerings.updated++; }
    } else {
      hit = (await write(() => rd.post<typeof ourOfferings[number]>("/offerings", { lookup_key: off.lookup_key, display_name: off.display_name, metadata: off.metadata ?? null }))) ?? undefined;
      report.offerings.created++;
    }
    map.offerings[off.id] = { id: hit?.id ?? null, lookupKey: off.lookup_key };
    const ourPkgs = hit?.packages?.items ?? [];
    for (const [i, pk] of (await rc.packages(off.id)).entries()) {
      let ph = ourPkgs.find((x) => x.lookup_key === pk.lookup_key);
      const position = pk.position ?? i;
      if (ph) {
        report.packages.matched++;
        if (ph.display_name !== pk.display_name || ph.position !== position) { await write(() => rd.post(`/packages/${ph!.id}`, { display_name: pk.display_name, position })); report.packages.updated++; }
      } else {
        ph = hit ? (await write(() => rd.post<typeof ourPkgs[number]>(`/offerings/${hit!.id}/packages`, { lookup_key: pk.lookup_key, display_name: pk.display_name, position }))) ?? undefined : undefined;
        report.packages.created++;
      }
      map.packages[pk.id] = { id: ph?.id ?? null, lookupKey: pk.lookup_key };
      const rcProducts = pk.products?.next_page ? await rc.packageProducts(pk.id) : pk.products?.items ?? await rc.packageProducts(pk.id);
      const have = new Map((ph?.products?.items ?? []).map((x) => [x.product.id, x.eligibility_criteria]));
      const attach = rcProducts.flatMap((x) => {
        const id = map.products[x.product.id]?.id;
        return id && have.get(id) !== x.eligibility_criteria ? [{ product_id: id, eligibility_criteria: x.eligibility_criteria }] : [];
      });
      if (attach.length && ph) {
        try {
          await write(() => rd.post(`/packages/${ph!.id}/actions/attach_products`, { products: attach }));
        } catch (e) {
          addProblem(problems, { kind: "note", message: `Package ${pk.lookup_key} in offering ${off.lookup_key}: could not attach products (${e instanceof Error ? e.message : e}).` });
        }
      }
    }
    if (hit && off.state === "inactive" && hit.state !== "inactive" && !off.is_current) await write(() => rd.post(`/offerings/${hit!.id}/actions/archive`, {}));
  }
  const current = rcOfferings.find((x) => x.is_current);
  const ourCurrent = current ? map.offerings[current.id]?.id : null;
  if (current && ourCurrent && !ourOfferings.find((x) => x.id === ourCurrent)?.is_current) {
    await write(() => rd.post(`/offerings/${ourCurrent}`, { is_current: true }));
    report.offerings.updated++;
  }
  return { map, report, problems };
}
