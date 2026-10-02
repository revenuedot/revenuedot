import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type StorePrice } from "@revenuedot/db";
import type { Deps } from "../context.js";
import type { AppRow } from "../stores/types.js";
import { appleHttpFor } from "../stores/apple/index.js";
import { AppStoreConnectApi, ConnectError, connectCredentials } from "../stores/apple/connect.js";
import { GoogleApiError, hasServiceAccount, microsMoney, moneyMicros, type PlayBasePlan, type PlaySubscription } from "../stores/google/api.js";
import { googleClientFor } from "../stores/google/index.js";
import type { AuditActor } from "../routes/v2/audit.js";
import { writeAudit } from "../routes/v2/audit.js";
import { StoreOpError } from "./store-ops.js";
import { decimalMicros, fromConnect, refreshStorePrices, type PricedListing } from "./store-prices.js";

/**
 * The product editor (prd/catalog/PRD.md "Product editor"): a CSV of store products and their prices per territory,
 * downloaded, edited and uploaded; validated against what the store has now; shown as a diff; then committed to App
 * Store Connect or Google Play row by row with each row's outcome, retried when rows failed, and audited.
 * The pure parts (CSV, validation) are exported for unit tests.
 */

type App = typeof schema.apps.$inferSelect;
export type EditRow = typeof schema.productEdits.$inferSelect;
export type EditLineRow = typeof schema.productEditRows.$inferSelect;
export interface Problem { line: number | null; message: string }

export const CSV_COLUMNS = ["store_identifier", "display_name", "type", "duration", "group", "territory", "currency", "price", "action"] as const;
const REQUIRED = ["store_identifier", "territory", "currency", "price"];
export const MAX_CSV_BYTES = 1_000_000;
export const MAX_CSV_ROWS = 20_000;
/** A price above this in any currency is a typo (the largest store prices are in Indonesian rupiah, below 100 million). */
const MAX_PRICE_MICROS = 100_000_000 * 1_000_000;
/** A commit request writes for at most this long; the rest stays pending for the next call. */
export const COMMIT_BUDGET_MS = 20_000;
const LOCK_MS = 120_000;

const APPLE = new Set(["app_store", "mac_app_store"]);
export const storeKind = (appType: string): "apple" | "play" | null => (APPLE.has(appType) ? "apple" : appType === "play_store" ? "play" : null);
const STORE_NAME = { apple: "App Store Connect", play: "Google Play" } as const;

// ---- CSV ------------------------------------------------------------------------------------------------------------

/**
 * RFC 4180 reader that keeps each record's first line number: quoted fields, doubled quotes, CRLF or LF, a UTF-8 BOM.
 * The delimiter is a comma, or a semicolon or tab when the header has one and no comma (spreadsheets in some locales).
 * Throws on an unterminated quote.
 */
export function readCsv(text: string): { line: number; cells: string[] }[] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = firstLine.includes(",") ? "," : firstLine.includes(";") ? ";" : firstLine.includes("\t") ? "\t" : ",";
  const out: { line: number; cells: string[] }[] = [];
  let row: string[] = [], cell = "", q = false, line = 1, start = 1, quotedFrom = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else { if (ch === "\n") line++; cell += ch; }
    } else if (ch === '"' && cell === "") { q = true; quotedFrom = line; }
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); out.push({ line: start, cells: row }); row = []; cell = ""; line++; start = line;
    } else cell += ch;
  }
  if (q) throw new Error(`The quote opened on line ${quotedFrom} is never closed.`);
  if (cell !== "" || row.length) { row.push(cell); out.push({ line: start, cells: row }); }
  return out;
}

/** A spreadsheet would run a cell starting with = + - @ as a formula: text cells get a leading apostrophe. */
const guard = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const unguard = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);
function cell(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function writeCsv(rows: (string | null | undefined)[][]): string {
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** How many decimals a currency's prices have (JPY 0, USD 2, KWD 3). */
export function currencyDigits(currency: string): number {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}

/** 9_990_000 micros of USD → "9.99"; 1_740_000_000 of JPY → "1740". */
export function microsText(micros: number, currency: string): string {
  const digits = currencyDigits(currency);
  if (micros % 10 ** (6 - digits) === 0) return (micros / 1_000_000).toFixed(digits);
  return (micros / 1_000_000).toFixed(6).replace(/0+$/, "");
}

// ---- Export ---------------------------------------------------------------------------------------------------------

/** The CSV of the chosen products (or all editable ones): one row per product and territory, base territory first. */
export function buildCsv(items: PricedListing[], identifiers: Set<string> | null): { csv: string; products: number; rows: number } {
  const rows: string[][] = [[...CSV_COLUMNS]];
  let products = 0;
  for (const it of items) {
    if (!it.editable || (identifiers && !identifiers.has(it.store_identifier))) continue;
    products++;
    const ordered = [...it.prices].sort((a, b) => (a.territory === it.base?.territory ? -1 : b.territory === it.base?.territory ? 1 : a.territory.localeCompare(b.territory)));
    const product = [it.store_identifier, guard(it.display_name ?? ""), it.type, it.duration ?? "", guard(it.group?.name ?? "")];
    if (!ordered.length) rows.push([...product, "", "", "", ""]);
    for (const p of ordered) rows.push([...product, p.territory, p.currency, microsText(p.amount_micros, p.currency), ""]);
  }
  return { csv: writeCsv(rows), products, rows: rows.length - 1 };
}

// ---- Validation -----------------------------------------------------------------------------------------------------

export interface ChangeInput {
  kind: "price_change" | "new_product";
  line: number;
  store_identifier: string;
  territory: string;
  currency: string;
  old_micros: number | null;
  new_micros: number;
  product: { type: string; duration: string | null; display_name: string; group: string | null } | null;
}

export interface Validation { errors: Problem[]; warnings: Problem[]; changes: ChangeInput[]; summary: Record<string, number> }

const APPLE_TYPES = new Set(["subscription", "consumable", "non_consumable", "non_renewing_subscription"]);
const APPLE_DURATIONS = new Set(["P1W", "P1M", "P2M", "P3M", "P6M", "P1Y"]);
const PLAY_DURATIONS = new Set(["P1W", "P1M", "P2M", "P3M", "P4M", "P6M", "P1Y"]);
const BIG_CHANGE = 0.5;

/** A price cell as micros of its currency, or why it is not one. */
export function parsePrice(raw: string, currency: string): { micros: number } | { error: string } {
  const t = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return { error: `price "${raw.trim()}" is not a number such as 9.99.` };
  const digits = currencyDigits(currency);
  const decimals = t.includes(".") ? t.split(".")[1]!.replace(/0+$/, "").length : 0;
  if (decimals > digits) return { error: digits === 0 ? `${currency} prices have no decimals; "${t}" has ${decimals}.` : `${currency} prices have at most ${digits} decimals; "${t}" has ${decimals}.` };
  const micros = decimalMicros(t);
  if (micros === null) return { error: `price "${t}" is not a number such as 9.99.` };
  if (micros <= 0) return { error: "price must be above 0." };
  if (micros > MAX_PRICE_MICROS) return { error: `price ${t} is above the largest price RevenueDot accepts (100,000,000).` };
  return { micros };
}

/**
 * Checks a product file against what the store has (`live`) and the store's territories and currencies, and returns
 * every problem with its line, the warnings, and the changes to commit. Pure.
 */
export function validateFile(kind: "apple" | "play", text: string, live: PricedListing[], territories: Map<string, string>): Validation {
  const errors: Problem[] = [], warnings: Problem[] = [];
  const store = STORE_NAME[kind];
  const fail = (line: number | null, message: string) => { if (errors.length < 500) errors.push({ line, message }); };
  const empty: Validation = { errors, warnings, changes: [], summary: {} };
  let records: { line: number; cells: string[] }[];
  try { records = readCsv(text); } catch (e) { fail(null, `This is not a valid CSV file: ${(e as Error).message}`); return empty; }
  records = records.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (!records.length) { fail(null, "The file is empty. Download a CSV first, change its prices, and upload it."); return empty; }
  const header = records[0]!.cells.map((c) => c.trim().toLowerCase().replace(/^﻿/, ""));
  const col = new Map<string, number>();
  header.forEach((h, i) => {
    if (!h) return;
    if (col.has(h)) fail(records[0]!.line, `The column ${h} appears twice.`);
    else col.set(h, i);
  });
  const missing = REQUIRED.filter((c) => !col.has(c));
  if (missing.length) {
    fail(records[0]!.line, `The first line must name the columns; ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing. Expected: ${CSV_COLUMNS.join(", ")}.`);
    return empty;
  }
  for (const h of col.keys()) if (!(CSV_COLUMNS as readonly string[]).includes(h)) warnings.push({ line: records[0]!.line, message: `The column ${h} is not used.` });
  const data = records.slice(1);
  if (data.length > MAX_CSV_ROWS) { fail(null, `The file has ${data.length.toLocaleString("en-US")} rows; upload at most ${MAX_CSV_ROWS.toLocaleString("en-US")} at a time.`); return empty; }
  if (!data.length) { fail(null, "The file has a header but no rows."); return empty; }

  const get = (r: { cells: string[] }, name: string) => { const i = col.get(name); return i === undefined ? "" : (r.cells[i] ?? "").trim(); };
  const byId = new Map(live.map((l) => [l.store_identifier, l]));
  const seen = new Map<string, number>();
  const changes: ChangeInput[] = [];
  const newProducts = new Map<string, { line: number; product: NonNullable<ChangeInput["product"]> }>();
  const ignoredWarned = new Set<string>();
  let unchanged = 0, blank = 0;
  const bigChanges: { line: number; text: string }[] = [];
  const territoryCode = kind === "apple" ? /^[A-Z]{3}$/ : /^[A-Z]{2}$/;

  for (const r of data) {
    const line = r.line;
    const id = get(r, "store_identifier");
    const action = get(r, "action").toLowerCase();
    if (!id) { fail(line, "store_identifier is empty."); continue; }
    if (/\s/.test(id)) { fail(line, `store_identifier "${id}" has a space in it.`); continue; }
    if (action && action !== "update" && action !== "create") { fail(line, `action "${action}" is not one of: create, update, or empty.`); continue; }
    const territory = get(r, "territory").toUpperCase();
    const currency = get(r, "currency").toUpperCase();
    const rawPrice = get(r, "price");
    const existing = byId.get(id);

    // Rows of new products.
    if (action === "create") {
      if (existing) { fail(line, `${id} already exists in ${store}. Leave action empty to change its prices.`); continue; }
      const product = {
        type: get(r, "type").toLowerCase(), duration: get(r, "duration").toUpperCase() || null,
        display_name: unguard(get(r, "display_name")), group: unguard(get(r, "group")) || null,
      };
      const known = newProducts.get(id);
      if (known) {
        // Later rows may leave the product columns empty; a different value is a conflict.
        for (const k of ["type", "duration", "display_name", "group"] as const) {
          if (product[k] && product[k] !== known.product[k]) fail(line, `${k} "${product[k]}" of ${id} conflicts with "${known.product[k] ?? ""}" on line ${known.line}.`);
        }
      } else {
        const problem = newProductProblem(kind, id, product);
        if (problem) { fail(line, problem); newProducts.set(id, { line, product }); continue; }
        newProducts.set(id, { line, product });
      }
    } else if (!existing) {
      const sub = kind === "play" ? id.split(":")[0]! : null;
      const hint = kind === "play" && !id.includes(":") && live.some((l) => l.store_identifier.startsWith(`${id}:`)) ? ` Google Play subscriptions are named subscription:base_plan, such as ${live.find((l) => l.store_identifier.startsWith(`${id}:`))!.store_identifier}.` : "";
      fail(line, `${id} is not in ${store} for this app.${hint || ` Check the identifier, or set action to create to add it as a new product${sub && live.some((l) => l.store_identifier.startsWith(`${sub}:`)) ? " (a new base plan of an existing subscription)" : ""}.`}`);
      continue;
    } else if (!existing.editable) {
      fail(line, kind === "play" && existing.type === "one_time"
        ? `${id} is a Google Play one-time product. Play Store one-time purchases aren't supported yet; change their prices in Play Console.`
        : `${id} cannot be changed with the product editor.${existing.note ? ` ${existing.note}` : ""}`);
      continue;
    }

    // Territory, currency and price.
    if (!territory && !currency && !rawPrice) { if (action === "create") fail(line, `${id} needs a territory, currency and price.`); else blank++; continue; }
    if (!territoryCode.test(territory)) { fail(line, `territory "${get(r, "territory")}" is not ${kind === "apple" ? "a three-letter App Store territory code such as USA" : "a two-letter Google Play region code such as US"}.`); continue; }
    const territoryCurrency = territories.get(territory);
    if (!territoryCurrency) { fail(line, `territory ${territory} is not ${kind === "apple" ? "an App Store territory" : "a region Google Play sells in"}.`); continue; }
    if (currency !== territoryCurrency) { fail(line, currency ? `The currency of ${territory} is ${territoryCurrency}, not ${currency}.` : `currency is empty; ${territory} uses ${territoryCurrency}.`); continue; }
    if (!rawPrice) {
      if (action === "create") fail(line, `price is empty; a new product needs a price in ${territory}.`);
      else { blank++; warnings.push({ line, message: `${id} in ${territory} has no price; nothing changes for it.` }); }
      continue;
    }
    const price = parsePrice(rawPrice, currency);
    if ("error" in price) { fail(line, price.error); continue; }
    const key = `${id}|${territory}`;
    const dup = seen.get(key);
    if (dup !== undefined) { fail(line, `${id} in ${territory} is on lines ${dup} and ${line}. Keep one of them.`); continue; }
    seen.set(key, line);

    if (action === "create") {
      changes.push({ kind: "new_product", line, store_identifier: id, territory, currency, old_micros: null, new_micros: price.micros, product: newProducts.get(id)!.product });
      continue;
    }
    // An existing product: only prices change.
    const ex = existing!;
    if (!ignoredWarned.has(id)) {
      const differs = [
        ["display_name", unguard(get(r, "display_name")), ex.display_name ?? ""], ["type", get(r, "type").toLowerCase(), ex.type],
        ["duration", get(r, "duration").toUpperCase(), ex.duration ?? ""], ["group", unguard(get(r, "group")), ex.group?.name ?? ""],
      ].filter(([name, v, was]) => v && v !== was && !(name === "group" && kind === "play"));
      if (differs.length) {
        ignoredWarned.add(id);
        warnings.push({ line, message: `The product editor changes prices only: the new ${differs.map(([n]) => n).join(", ")} of ${id} ${differs.length > 1 ? "are" : "is"} ignored. Change ${differs.length > 1 ? "them" : "it"} in ${store}.` });
      }
    }
    const current = ex.prices.find((p) => p.territory === territory);
    if (current && current.amount_micros === price.micros) { unchanged++; continue; }
    if (current && current.currency !== currency) { fail(line, `${id} is priced in ${current.currency} in ${territory}, not ${currency}.`); continue; }
    changes.push({ kind: "price_change", line, store_identifier: id, territory, currency, old_micros: current?.amount_micros ?? null, new_micros: price.micros, product: null });
    if (current && Math.abs(price.micros / current.amount_micros - 1) > BIG_CHANGE) {
      const pct = Math.round((price.micros / current.amount_micros - 1) * 100);
      bigChanges.push({ line, text: `${id} in ${territory} changes by ${pct > 0 ? "+" : ""}${pct}% (${microsText(current.amount_micros, currency)} → ${microsText(price.micros, currency)}). Check it is not a typo.` });
    }
  }

  // Changes of more than half: each one when there are a few, else one line that names them.
  if (bigChanges.length <= 10) for (const b of bigChanges) warnings.push({ line: b.line, message: b.text });
  else warnings.push({ line: bigChanges[0]!.line, message: `${bigChanges.length} prices change by more than 50% (lines ${bigChanges.slice(0, 12).map((b) => b.line).join(", ")}${bigChanges.length > 12 ? " …" : ""}). Check they are not typos.` });

  // New products: the base price, and where they will be sold.
  for (const [id, np] of newProducts) {
    const rows = changes.filter((c) => c.store_identifier === id);
    if (!rows.length && !errors.some((e) => e.line === np.line)) fail(np.line, `${id} has no price. A new product needs at least one territory with a price.`);
    if (rows.length && np.product.type === "subscription" && territories.size > rows.length) {
      warnings.push({ line: np.line, message: `${id} gets a price in ${rows.length} of ${territories.size} territories; ${kind === "apple" ? "the App Store" : "Google Play"} sells it only where it has one.` });
    }
  }
  if (!errors.length && !changes.length) fail(null, `The file changes nothing: every price matches ${store}${blank ? ` (${blank} rows have no price)` : ""}.`);
  const products = new Set(changes.map((c) => c.store_identifier));
  return {
    errors, warnings, changes: errors.length ? [] : changes,
    summary: {
      price_changes: changes.filter((c) => c.kind === "price_change").length, new_products: newProducts.size,
      new_product_prices: changes.filter((c) => c.kind === "new_product").length, unchanged, products: products.size, rows: data.length,
    },
  };
}

function newProductProblem(kind: "apple" | "play", id: string, p: { type: string; duration: string | null; display_name: string; group: string | null }): string | null {
  if (kind === "apple") {
    if (!/^[A-Za-z0-9._]+$/.test(id) || id.length > 100) return `${id} is not a valid App Store product ID: use letters, digits, periods and underscores.`;
    if (!APPLE_TYPES.has(p.type)) return `type "${p.type}" of new product ${id} is not one of: subscription, consumable, non_consumable, non_renewing_subscription.`;
    if (p.type === "subscription") {
      if (!p.duration || !APPLE_DURATIONS.has(p.duration)) return `New subscription ${id} needs a duration of P1W, P1M, P2M, P3M, P6M or P1Y${p.duration ? `, not ${p.duration}` : ""}.`;
      if (!p.group) return `New subscription ${id} needs a group: the subscription group's reference name, created when it does not exist.`;
    }
    if (!p.display_name) return `New product ${id} needs a display_name (its reference name in App Store Connect).`;
    if (p.display_name.length > 64) return `display_name of ${id} has ${p.display_name.length} characters; App Store Connect allows 64.`;
    return null;
  }
  if (p.type === "one_time" || p.type === "consumable" || p.type === "non_consumable") return `${id} is a one-time product. Play Store one-time purchases aren't supported yet; create it in Play Console.`;
  const [sub, plan, extra] = id.split(":");
  if (!plan || extra !== undefined) return `${id} must be subscription_id:base_plan_id, such as pro:monthly.`;
  if (!/^[a-z0-9][a-z0-9._]{0,39}$/.test(sub!)) return `Subscription ID "${sub}" must start with a lowercase letter or digit and use lowercase letters, digits, periods and underscores (40 at most).`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(plan)) return `Base plan ID "${plan}" must start with a lowercase letter or digit and use lowercase letters, digits and hyphens (63 at most).`;
  if (p.type !== "subscription") return `type "${p.type}" of new product ${id} must be subscription.`;
  if (!p.duration || !PLAY_DURATIONS.has(p.duration)) return `New base plan ${id} needs a duration of P1W, P1M, P2M, P3M, P4M, P6M or P1Y${p.duration ? `, not ${p.duration}` : ""}.`;
  if (!p.display_name) return `New subscription ${id} needs a display_name (its title in Play Console).`;
  if (p.display_name.length > 55) return `display_name of ${id} has ${p.display_name.length} characters; Google Play allows 55.`;
  return null;
}

// ---- Store context --------------------------------------------------------------------------------------------------

function requireCredentials(app: App, kind: "apple" | "play", writing: boolean) {
  if (kind === "apple" && !connectCredentials(app)) {
    throw new StoreOpError("credentials", `${writing ? "Changing" : "Reading"} prices in App Store Connect needs the app's App Store Connect API key: a team key with the App Manager role (.p8 file, key ID and issuer ID). The In-App Purchase key cannot list or change prices.`);
  }
  if (kind === "play" && !hasServiceAccount(app)) {
    throw new StoreOpError("credentials", `${writing ? "Changing" : "Reading"} prices in Google Play needs the app's service account JSON${writing ? ", with the \"Manage store presence\" permission in Play Console" : ""}.`);
  }
}

const ascApi = (deps: Deps, app: App) => {
  const { fetchFn, now } = appleHttpFor(deps.stores, deps.fetch, deps.now);
  return new AppStoreConnectApi(connectCredentials(app)!, fetchFn, now);
};

/** Every territory the store sells in, with its currency: App Store Connect's list; Google Play's regions seen on the app's base plans, else pricing.convertRegionPrices. */
async function territoriesFor(deps: Deps, app: App, kind: "apple" | "play", live: PricedListing[], need: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const l of live) for (const p of l.prices) map.set(p.territory, p.currency);
  if (need.every((t) => map.has(t))) return map;
  try {
    if (kind === "apple") {
      for (const [t, c] of await ascApi(deps, app).territories()) if (c) map.set(t, c);
    } else {
      const { client } = googleClientFor(deps.stores, deps.fetch);
      const r = await client.convertRegionPrices(app as AppRow, { currencyCode: "USD", units: "1" });
      for (const [region, v] of Object.entries(r.convertedRegionPrices ?? {})) if (v.price?.currencyCode) map.set(v.regionCode ?? region, v.price.currencyCode);
    }
  } catch (e) {
    throw kind === "apple" ? fromConnect(e) : fromGoogle(e);
  }
  return map;
}

function fromGoogle(e: unknown): unknown {
  if (!(e instanceof GoogleApiError)) return e;
  if (e.kind === "credentials") return new StoreOpError("credentials", `Google Play refused the service account: ${e.message} Changing prices needs the "Manage store presence" permission.`);
  if (e.kind === "transient") return new StoreOpError("unavailable", `Google Play could not be reached: ${e.message}`);
  return new StoreOpError("invalid", `Google Play refused the request: ${e.message}`);
}

// ---- Edits ----------------------------------------------------------------------------------------------------------

export async function exportCsv(deps: Deps, app: App, identifiers: string[] | null) {
  const kind = storeKind(app.type);
  if (!kind) throw new StoreOpError("unsupported", `The product editor works with App Store and Google Play apps; this is a ${app.type} app.`);
  requireCredentials(app, kind, false);
  const read = await refreshStorePrices(deps, app);
  const set = identifiers ? new Set(identifiers) : null;
  if (set) {
    const unknown = [...set].filter((id) => !read.items.some((i) => i.store_identifier === id));
    if (unknown.length) throw new StoreOpError("invalid", `Not in ${STORE_NAME[kind]} for this app: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ""}.`, "store_identifiers");
    const blocked = read.items.filter((i) => set.has(i.store_identifier) && !i.editable);
    if (blocked.length) throw new StoreOpError("invalid", `${blocked.map((b) => b.store_identifier).join(", ")} cannot be edited here${kind === "play" ? ": Play Store one-time purchases aren't supported yet" : ""}.`, "store_identifiers");
  }
  return buildCsv(read.items, set);
}

/** Uploads a file: reads the store, validates, and keeps the edit (status `ready`, or `invalid` with its errors). */
export async function createEdit(deps: Deps, app: App, input: { fileName: string; csv: string; preserveCurrentPrice?: boolean; createdBy: string | null }) {
  const kind = storeKind(app.type);
  if (!kind) throw new StoreOpError("unsupported", `The product editor works with App Store and Google Play apps; this is a ${app.type} app.`);
  requireCredentials(app, kind, true);
  const read = await refreshStorePrices(deps, app);
  let records: { line: number; cells: string[] }[] = [];
  try { records = readCsv(input.csv); } catch { /* validateFile reports it */ }
  const tCol = (records[0]?.cells ?? []).findIndex((c) => c.trim().toLowerCase() === "territory");
  const need = tCol < 0 ? [] : [...new Set(records.slice(1).map((r) => (r.cells[tCol] ?? "").trim().toUpperCase()).filter(Boolean))];
  const territories = await territoriesFor(deps, app, kind, read.items, need);
  const v = validateFile(kind, input.csv, read.items, territories);
  const now = deps.now();
  const id = newId("pedit", 14);
  const [edit] = await deps.db.insert(schema.productEdits).values({
    id, projectId: app.projectId, appId: app.id, store: app.type, status: v.errors.length ? "invalid" : "ready", fileName: input.fileName.slice(0, 200) || "products.csv",
    csv: input.csv, errors: v.errors, warnings: v.warnings.slice(0, 500), summary: v.summary,
    options: kind === "apple" ? { preserve_current_price: input.preserveCurrentPrice ?? true } : {}, createdBy: input.createdBy, createdAt: now, updatedAt: now,
  }).returning();
  for (let i = 0; i < v.changes.length; i += 500) {
    await deps.db.insert(schema.productEditRows).values(v.changes.slice(i, i + 500).map((c, j) => ({
      editId: id, idx: i + j, kind: c.kind, line: c.line, storeIdentifier: c.store_identifier, territory: c.territory, currency: c.currency,
      oldMicros: c.old_micros, newMicros: c.new_micros, product: c.product,
    })));
  }
  return edit!;
}

export async function editRows(deps: Deps, editId: string) {
  return deps.db.select().from(schema.productEditRows).where(eq(schema.productEditRows.editId, editId)).orderBy(asc(schema.productEditRows.idx));
}

export async function findEdit(deps: Deps, projectId: string, id: string) {
  const [e] = await deps.db.select().from(schema.productEdits).where(and(eq(schema.productEdits.projectId, projectId), eq(schema.productEdits.id, id))).limit(1);
  return e ?? null;
}

export async function listEdits(deps: Deps, projectId: string, appId?: string) {
  const E = schema.productEdits;
  return deps.db.select().from(E).where(and(eq(E.projectId, projectId), ...(appId ? [eq(E.appId, appId)] : []))).orderBy(desc(E.createdAt), desc(E.id)).limit(200);
}

// ---- Commit ---------------------------------------------------------------------------------------------------------

const COMMITTABLE = ["ready", "committing", "partially_committed", "failed"];

/** A row's result; null when the row was not attempted (the time budget ran out) and stays pending. */
interface Outcome { ok: boolean; error?: string; note?: string }
type MaybeOutcome = Outcome | null;
class FatalStoreError extends Error {}

/**
 * Commits an edit's pending rows to the store, one product at a time, for at most `budgetMs`. Rows sharing a store call
 * share its outcome. Returns the edit after the run; `committing` means rows are left for the next call.
 */
export async function commitEdit(deps: Deps, edit: EditRow, actor: AuditActor, opts: { budgetMs?: number; retry?: boolean } = {}): Promise<EditRow> {
  const app = (await deps.db.select().from(schema.apps).where(eq(schema.apps.id, edit.appId)).limit(1))[0];
  if (!app) throw new StoreOpError("not_found", "The edit's app was deleted.");
  const kind = storeKind(app.type)!;
  if (!COMMITTABLE.includes(edit.status)) {
    throw new StoreOpError("conflict", edit.status === "invalid" ? "This file has errors. Fix them and upload it again." : edit.status === "committed" ? "This edit is already committed." : `This edit is ${edit.status} and cannot be committed.`, "status");
  }
  requireCredentials(app, kind, true);
  const now = deps.now();
  const E = schema.productEdits, R = schema.productEditRows;
  // Only one commit of an edit at a time.
  const [locked] = await deps.db.update(E).set({ lockedUntil: new Date(now.getTime() + LOCK_MS), status: "committing", updatedAt: now })
    .where(and(eq(E.id, edit.id), inArray(E.status, COMMITTABLE), or(isNull(E.lockedUntil), lt(E.lockedUntil, now)))).returning();
  if (!locked) throw new StoreOpError("conflict", "This edit is being committed right now. Wait for it to finish.", "locked");
  if (opts.retry) await deps.db.update(R).set({ status: "pending", error: null, updatedAt: now }).where(and(eq(R.editId, edit.id), eq(R.status, "failed")));

  const started = Date.now();
  const budget = opts.budgetMs ?? COMMIT_BUDGET_MS;
  const pending = (await editRows(deps, edit.id)).filter((r) => r.status === "pending");
  const groups = new Map<string, EditLineRow[]>();
  for (const r of pending) {
    const key = kind === "play" ? r.storeIdentifier.split(":")[0]! : r.storeIdentifier;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const ctx: CommitContext = { deps, app, edit: locked, actor, created: { ...locked.created }, pricePoints: new Map(), deadline: started + budget };
  let fatal: string | null = null;
  try {
    for (const [key, rows] of groups) {
      if (Date.now() - started > budget) break;
      if (fatal) { await finish(ctx, rows, rows.map(() => ({ ok: false, error: fatal! }))); continue; }
      let outcomes: MaybeOutcome[];
      try {
        outcomes = kind === "apple" ? await commitApple(ctx, rows) : await commitPlay(ctx, key, rows);
      } catch (e) {
        const msg = storeMessage(kind, e);
        if (e instanceof FatalStoreError || isCredentialError(e)) fatal = msg;
        outcomes = rows.map(() => ({ ok: false, error: msg }));
      }
      await finish(ctx, rows, outcomes);
    }
  } finally {
    const all = await editRows(deps, edit.id);
    const left = all.filter((r) => r.status === "pending").length;
    const ok = all.filter((r) => r.status === "succeeded").length;
    const failed = all.filter((r) => r.status === "failed").length;
    const status = left ? "committing" : failed && ok ? "partially_committed" : failed ? "failed" : "committed";
    const end = deps.now();
    await deps.db.update(E).set({ status, lockedUntil: null, created: ctx.created, updatedAt: end, ...(left ? {} : { committedAt: end }) }).where(eq(E.id, edit.id));
  }
  // The cache shows what the store has now (best effort: the commit already happened).
  if (!(await editRows(deps, edit.id)).some((r) => r.status === "pending")) {
    await refreshStorePrices(deps, app).catch(() => undefined);
  }
  return (await findEdit(deps, edit.projectId, edit.id))!;
}

interface CommitContext {
  deps: Deps;
  app: App;
  edit: EditRow;
  actor: AuditActor;
  /** Store ids of products this edit created (kept on the edit, so a retry does not create them twice). */
  created: Record<string, string>;
  pricePoints: Map<string, { id: string; customerPrice: string }[]>;
  /** Date.now() after which no new store write starts. */
  deadline: number;
}

const isCredentialError = (e: unknown) => (e instanceof ConnectError && e.kind === "credentials") || (e instanceof GoogleApiError && e.kind === "credentials");

function storeMessage(kind: "apple" | "play", e: unknown): string {
  if (e instanceof FatalStoreError) return e.message;
  if (e instanceof ConnectError) {
    if (e.kind === "credentials") return `App Store Connect refused the API key (${e.status || "no answer"}). Changing prices needs a team key with the App Manager role.`;
    return /^App Store Connect/.test(e.message) ? e.message : `App Store Connect: ${e.message}`;
  }
  if (e instanceof GoogleApiError) {
    if (e.kind === "credentials") return `Google Play refused the service account: ${e.message} Changing prices needs the "Manage store presence" permission.`;
    if (e.kind === "transient") return `Google Play could not be reached (${e.message}). Retry later.`;
    return `Google Play: ${e.message.replace(/^\d{3} /, "")}`;
  }
  if (e instanceof StoreOpError) return e.message;
  console.error("product editor: commit failed", e);
  return `${kind === "apple" ? "App Store Connect" : "Google Play"} could not be updated: ${e instanceof Error ? e.message : String(e)}`;
}

async function finish(ctx: CommitContext, rows: EditLineRow[], outcomes: MaybeOutcome[]) {
  const { deps } = ctx;
  const now = deps.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!, o = outcomes[i];
    if (!o) continue;
    await deps.db.update(schema.productEditRows).set({ status: o.ok ? "succeeded" : "failed", error: o.ok ? o.note ?? null : (o.error ?? "Failed.").slice(0, 2000), attempts: r.attempts + 1, updatedAt: now })
      .where(and(eq(schema.productEditRows.editId, r.editId), eq(schema.productEditRows.idx, r.idx)));
    await writeAudit(deps, ctx.app.projectId, ctx.actor, {
      actionType: "store_price_changed", targetType: "product", targetIdentifier: r.storeIdentifier,
      data: {
        app_id: ctx.app.id, store: ctx.app.type, edit_id: r.editId, line: r.line, territory: r.territory, currency: r.currency,
        old_amount_micros: r.oldMicros, new_amount_micros: r.newMicros, result: o.ok ? "succeeded" : "failed", ...(o.ok ? {} : { error: o.error }),
      },
    });
  }
}

async function productCreated(ctx: CommitContext, storeIdentifier: string, storeId: string, product: Record<string, string | null>) {
  const { deps, app } = ctx;
  ctx.created[storeIdentifier] = storeId;
  await deps.db.update(schema.productEdits).set({ created: ctx.created }).where(eq(schema.productEdits.id, ctx.edit.id));
  // Like an import: the new store product is in the catalog too.
  await deps.db.insert(schema.products).values({
    id: newId("prod", 14), projectId: app.projectId, appId: app.id, storeIdentifier, type: product.type ?? "subscription",
    displayName: product.display_name ?? null, duration: product.type === "subscription" ? product.duration ?? null : null, createdAt: deps.now(),
  }).onConflictDoNothing();
  await writeAudit(deps, app.projectId, ctx.actor, {
    actionType: "store_product_created", targetType: "product", targetIdentifier: storeIdentifier,
    data: { app_id: app.id, store: app.type, edit_id: ctx.edit.id, store_id: storeId, type: product.type, duration: product.duration, display_name: product.display_name },
  });
}

// ---- App Store Connect writes ---------------------------------------------------------------------------------------

const ASC_PERIOD: Record<string, string> = { P1W: "ONE_WEEK", P1M: "ONE_MONTH", P2M: "TWO_MONTHS", P3M: "THREE_MONTHS", P6M: "SIX_MONTHS", P1Y: "ONE_YEAR" };
const ASC_IAP: Record<string, "CONSUMABLE" | "NON_CONSUMABLE" | "NON_RENEWING_SUBSCRIPTION"> = { consumable: "CONSUMABLE", non_consumable: "NON_CONSUMABLE", non_renewing_subscription: "NON_RENEWING_SUBSCRIPTION" };

async function pointsFor(ctx: CommitContext, api: AppStoreConnectApi, sub: boolean, ref: string, territory: string) {
  const key = `${sub ? "s" : "i"}|${ref}|${territory}`;
  let points = ctx.pricePoints.get(key);
  if (!points) {
    points = sub ? await api.subscriptionPricePoints(ref, territory) : await api.inAppPurchasePricePoints(ref, territory);
    ctx.pricePoints.set(key, points);
  }
  return points;
}

/** The price point with exactly this price, or a message naming the nearest ones. */
function matchPoint(points: { id: string; customerPrice: string }[], micros: number, territory: string, currency: string): { id: string } | { error: string } {
  const exact = points.find((p) => decimalMicros(p.customerPrice) === micros);
  if (exact) return exact;
  if (!points.length) return { error: `App Store Connect has no price points in ${territory} for this product.` };
  const near = [...points].sort((a, b) => Math.abs((decimalMicros(a.customerPrice) ?? 0) - micros) - Math.abs((decimalMicros(b.customerPrice) ?? 0) - micros)).slice(0, 2)
    .map((p) => p.customerPrice).sort((a, b) => Number(a) - Number(b));
  return { error: `The App Store has no price of ${microsText(micros, currency)} ${currency} in ${territory}. The nearest App Store prices are ${near.join(" and ")}.` };
}

async function commitApple(ctx: CommitContext, rows: EditLineRow[]): Promise<MaybeOutcome[]> {
  const { deps, app } = ctx;
  const api = ascApi(deps, app);
  const first = rows[0]!;
  const id = first.storeIdentifier;
  const today = deps.now().toISOString().slice(0, 10);
  let ref: string | null = ctx.created[id] ?? null;
  let isSub: boolean;
  if (first.kind === "new_product") {
    const p = first.product ?? {};
    isSub = p.type === "subscription";
    if (!ref) {
      if (!app.bundleId) throw new FatalStoreError("The app has no bundle ID. Add it in the app's settings.");
      const ascApp = await api.appByBundleId(app.bundleId);
      if (!ascApp) throw new FatalStoreError(`App Store Connect has no app with bundle ID ${app.bundleId} that this API key can see.`);
      const name = (p.display_name ?? id).slice(0, 64);
      const created = isSub
        ? await api.createSubscription(await api.subscriptionGroup(ascApp.id, p.group ?? "Subscriptions"), { name, productId: id, subscriptionPeriod: ASC_PERIOD[p.duration ?? ""] ?? "ONE_MONTH" })
        : await api.createInAppPurchase(ascApp.id, { name, productId: id, inAppPurchaseType: ASC_IAP[p.type ?? ""] ?? "NON_CONSUMABLE" });
      ref = created.data.id;
      await productCreated(ctx, id, ref, p);
    }
  } else {
    const [listing] = await deps.db.select().from(schema.storeListings).where(and(eq(schema.storeListings.appId, app.id), eq(schema.storeListings.storeIdentifier, id))).limit(1);
    ref = listing?.storeRef ?? null;
    if (!ref) return rows.map(() => ({ ok: false, error: `${id} is no longer in App Store Connect.` }));
    isSub = listing!.type === "subscription";
  }

  if (isSub) {
    const preserve = ctx.edit.options.preserve_current_price !== false;
    // A retried row may have gone through before: read the current prices once and skip rows already at their price.
    const current = rows.some((r) => r.attempts > 0) ? await api.subscriptionPrices(ref, today) : [];
    const out: MaybeOutcome[] = [];
    for (const r of rows) {
      if (Date.now() > ctx.deadline) { out.push(null); continue; }
      const now = current.find((p) => p.territory === r.territory);
      if (now && decimalMicros(now.customerPrice) === r.newMicros) { out.push({ ok: true, note: "Already at this price." }); continue; }
      try {
        const m = matchPoint(await pointsFor(ctx, api, true, ref, r.territory), r.newMicros, r.territory, r.currency);
        if ("error" in m) { out.push({ ok: false, error: m.error }); continue; }
        await api.createSubscriptionPrice(ref, r.territory, m.id, preserve);
        out.push({ ok: true });
      } catch (e) {
        if (isCredentialError(e)) throw e;
        out.push({ ok: false, error: storeMessage("apple", e) });
      }
    }
    return out;
  }

  // In-app purchases: one schedule for the product, keeping the manual prices nobody changed.
  const schedule = await api.inAppPurchaseSchedule(ref, today);
  const manual = new Map<string, string>();
  for (const p of schedule?.manual ?? []) if (p.pricePointId) manual.set(p.territory, p.pricePointId);
  const out: Outcome[] = [];
  const applied: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const m = matchPoint(await pointsFor(ctx, api, false, ref, r.territory), r.newMicros, r.territory, r.currency);
    if ("error" in m) { out[i] = { ok: false, error: m.error }; continue; }
    manual.set(r.territory, m.id);
    applied.push(i);
  }
  if (!applied.length) return out;
  const baseTerritory = schedule?.baseTerritory ?? (rows.some((r) => r.territory === "USA") ? "USA" : rows[applied[0]!]!.territory);
  if (!manual.has(baseTerritory)) {
    for (const i of applied) out[i] = { ok: false, error: `${id} needs a price in its base territory ${baseTerritory} first.` };
    return out;
  }
  try {
    await api.setInAppPurchaseSchedule(ref, baseTerritory, [...manual.values()].map((pricePointId) => ({ pricePointId })));
    for (const i of applied) out[i] = { ok: true };
  } catch (e) {
    if (isCredentialError(e)) throw e;
    const msg = storeMessage("apple", e);
    for (const i of applied) out[i] = { ok: false, error: msg };
  }
  return out;
}

// ---- Google Play writes ---------------------------------------------------------------------------------------------

async function commitPlay(ctx: CommitContext, subscriptionId: string, rows: EditLineRow[]): Promise<MaybeOutcome[]> {
  const { deps, app } = ctx;
  const { client } = googleClientFor(deps.stores, deps.fetch);
  const row = app as AppRow;
  let sub: PlaySubscription | null;
  try { sub = await client.getSubscription(row, subscriptionId); } catch (e) {
    if (e instanceof GoogleApiError && e.status === 404) sub = null;
    else throw e;
  }
  const newPlans = new Map<string, EditLineRow[]>();
  for (const r of rows) if (r.kind === "new_product") { const bp = r.storeIdentifier.split(":")[1]!; newPlans.set(bp, [...(newPlans.get(bp) ?? []), r]); }
  const regional = (rs: EditLineRow[]) => rs.map((r) => ({ regionCode: r.territory, newSubscriberAvailability: true, price: microsMoney(r.newMicros, r.currency) }));
  const planFor = (bp: string, rs: EditLineRow[]): PlayBasePlan => ({ basePlanId: bp, autoRenewingBasePlanType: { billingPeriodDuration: rs[0]!.product?.duration ?? "P1M" }, regionalConfigs: regional(rs) });

  // A new subscription: created with its base plans, then each plan activated.
  if (!sub) {
    if (rows.some((r) => r.kind !== "new_product")) return rows.map(() => ({ ok: false, error: `${subscriptionId} is no longer in Google Play.` }));
    const title = (rows[0]!.product?.display_name ?? subscriptionId).slice(0, 55);
    const languageCode = await client.defaultLanguage(row);
    await client.createSubscriptionWithBasePlans(row, subscriptionId, { languageCode, title }, [...newPlans].map(([bp, rs]) => planFor(bp, rs)));
    const activated = await activateNew(ctx, client, row, subscriptionId, newPlans);
    return rows.map((r) => activated.get(r.storeIdentifier.split(":")[1]!) ?? { ok: true });
  }

  // Changes to existing base plans, plus base plans this edit adds; skip rows whose price is already there (a retry).
  const plans: PlayBasePlan[] = (sub.basePlans ?? []).map((b) => ({ ...b, regionalConfigs: [...(b.regionalConfigs ?? [])] }));
  const out: (Outcome | null)[] = rows.map(() => null);
  let changed = false;
  for (const [bp, rs] of newPlans) {
    const existing = plans.find((b) => b.basePlanId === bp);
    if (!existing) { plans.push(planFor(bp, rs)); changed = true; continue; }
    // Created by an earlier attempt of this edit: set the prices like a change.
    for (const r of rs) changed = setRegion(existing, r) || changed;
  }
  rows.forEach((r, i) => {
    if (r.kind !== "price_change") return;
    const bp = r.storeIdentifier.split(":")[1];
    const plan = plans.find((b) => b.basePlanId === bp);
    if (!plan) { out[i] = { ok: false, error: `Base plan ${bp} is no longer in Google Play.` }; return; }
    const cfg = plan.regionalConfigs!.find((c) => c.regionCode === r.territory);
    if (cfg && moneyMicros(cfg.price) === r.newMicros && cfg.price?.currencyCode === r.currency) { out[i] = { ok: true, note: "Already at this price." }; return; }
    changed = setRegion(plan, r) || changed;
  });
  if (changed) {
    await client.patchSubscriptionBasePlans(row, { ...sub, basePlans: plans });
    for (const [bp, rs] of newPlans) if (!ctx.created[`${subscriptionId}:${bp}`]) await productCreated(ctx, `${subscriptionId}:${bp}`, `${subscriptionId}:${bp}`, rs[0]!.product ?? {});
  }
  const activated = newPlans.size ? await activateNew(ctx, client, row, subscriptionId, newPlans, true) : new Map<string, Outcome>();
  return rows.map((r, i) => out[i] ?? (r.kind === "new_product" ? activated.get(r.storeIdentifier.split(":")[1]!) : undefined) ?? { ok: true });
}

function setRegion(plan: PlayBasePlan, r: EditLineRow): boolean {
  const configs = plan.regionalConfigs ?? (plan.regionalConfigs = []);
  const cfg = configs.find((c) => c.regionCode === r.territory);
  const price = microsMoney(r.newMicros, r.currency);
  if (cfg) {
    if (moneyMicros(cfg.price) === r.newMicros && cfg.price?.currencyCode === r.currency) return false;
    cfg.price = price;
  } else configs.push({ regionCode: r.territory, newSubscriberAvailability: true, price });
  return true;
}

/** Activates the edit's new base plans and records them as created; the outcome per base plan id. */
async function activateNew(ctx: CommitContext, client: ReturnType<typeof googleClientFor>["client"], row: AppRow, subscriptionId: string, newPlans: Map<string, EditLineRow[]>, recorded = false): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  for (const [bp, rs] of newPlans) {
    const key = `${subscriptionId}:${bp}`;
    if (!recorded && !ctx.created[key]) await productCreated(ctx, key, key, rs[0]!.product ?? {});
    let o: Outcome = { ok: true };
    try { await client.activateBasePlan(row, subscriptionId, bp); } catch (e) {
      if (isCredentialError(e)) throw e;
      // Already active (a retry) is fine; anything else leaves the plan as a draft.
      if (!(e instanceof GoogleApiError && /already active|ACTIVE/i.test(e.message))) o = { ok: false, error: `The base plan was created but not activated: ${storeMessage("play", e)} Activate it in Play Console.` };
    }
    out.set(bp, o);
  }
  return out;
}

// ---- Answers --------------------------------------------------------------------------------------------------------

export function editShape(e: EditRow, rows?: EditLineRow[]) {
  const counts = rows ? { pending: rows.filter((r) => r.status === "pending").length, succeeded: rows.filter((r) => r.status === "succeeded").length, failed: rows.filter((r) => r.status === "failed").length } : undefined;
  return {
    object: "product_edit" as const, id: e.id, app_id: e.appId, store: e.store, status: e.status, file_name: e.fileName,
    created_at: e.createdAt.getTime(), updated_at: e.updatedAt.getTime(), committed_at: e.committedAt?.getTime() ?? null, created_by: e.createdBy,
    errors: e.errors, warnings: e.warnings, summary: e.summary, options: e.options, ...(counts ? { results: counts } : {}),
    ...(rows ? { rows: rows.map(rowShape) } : {}),
  };
}

export function rowShape(r: EditLineRow) {
  return {
    object: "product_edit_row" as const, idx: r.idx, kind: r.kind, line: r.line, store_identifier: r.storeIdentifier, territory: r.territory, currency: r.currency,
    old_amount_micros: r.oldMicros, new_amount_micros: r.newMicros,
    change_percent: r.oldMicros ? Math.round((r.newMicros / r.oldMicros - 1) * 1000) / 10 : null,
    product: r.product ?? null, status: r.status, error: r.error, attempts: r.attempts, updated_at: r.updatedAt?.getTime() ?? null,
  };
}

/** Prices of a cached listing as CSV-ready text (the dashboard's territory table uses the same formatting). */
export const priceText = (p: StorePrice) => microsText(p.amount_micros, p.currency);
