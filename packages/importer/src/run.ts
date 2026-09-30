// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the import run (catalog, then customers) with its state file and final report.
// Docs: https://revenuedot.app/docs/migrate
import type { HttpOptions } from "./http.js";
import { RevenueCatClient } from "./revenuecat.js";
import { RevenueDotClient } from "./revenuedot.js";
import { importCatalog, type CatalogReport } from "./catalog.js";
import { importCustomers } from "./customers.js";
import type { TokenBook } from "./convert.js";
import { addProblem, loadState, newState, saveState, type ImportState, type Problem } from "./state.js";

export interface ImportOptions {
  rcKey: string;
  rcProject: string;
  rcBaseUrl?: string;
  to: string;
  toKey: string;
  toProject?: string | null;
  statePath: string;
  dryRun?: boolean;
  /** Ignore the state file and start over (the import is idempotent, so this only costs time). */
  restart?: boolean;
  concurrency?: number;
  pageSize?: number;
  limit?: number;
  publicKeys?: boolean;
  emitEvents?: boolean;
  tokens?: TokenBook;
  http?: HttpOptions;
  /** Separate HTTP options for the RevenueDot side (tests inject the in-process server here). */
  targetHttp?: HttpOptions;
  log?: (m: string) => void;
  progress?: (m: string) => void;
}

export interface ImportReport {
  dryRun: boolean;
  source: string;
  target: { url: string; project: string };
  catalog: CatalogReport;
  customers: ImportState["customers"];
  googleWithoutToken: number;
  problems: Problem[];
  statePath: string | null;
}

export async function runImport(o: ImportOptions): Promise<ImportReport> {
  const log = o.log ?? (() => {});
  const progress = o.progress ?? log;
  const dryRun = !!o.dryRun;
  const retryLog: HttpOptions["onRetry"] = ({ status, waitMs }) => progress(status === 429 ? `rate limited; waiting ${Math.ceil(waitMs / 1000)}s` : `request failed (${status ?? "network"}); retrying in ${Math.ceil(waitMs / 1000)}s`);
  const rc = new RevenueCatClient({ apiKey: o.rcKey, projectId: o.rcProject, baseUrl: o.rcBaseUrl, http: { onRetry: retryLog, ...o.http } });
  const rd = new RevenueDotClient({ url: o.to, apiKey: o.toKey, projectId: o.toProject, http: { onRetry: retryLog, ...(o.targetHttp ?? o.http) } });
  const project = await rd.project();
  const target = { url: o.to.replace(/\/+$/, ""), project: project.id };

  let state = o.restart ? null : loadState(o.statePath);
  if (state && (state.source.project !== o.rcProject || state.target.project !== target.project)) {
    throw new Error(`${o.statePath} belongs to RevenueCat project ${state.source.project} -> RevenueDot project ${state.target.project}. Pass --state with another file, or --restart.`);
  }
  state ??= newState(o.rcProject, target);
  if (state.customers.complete) {
    // The previous pass finished: this run is an incremental pass over everyone (idempotent, picks up changes).
    const pass = state.customers.pass + 1;
    state.customers = { pass, after: null, complete: false, pages: 0, imported: 0, created: 0, merged: 0, subscriptions: 0, purchases: 0, needsTokenRefresh: 0 };
    state.problems = [];
  }
  const save = () => { if (!dryRun) saveState(o.statePath, state!); };
  if (state.customers.after) log(`Resuming pass ${state.customers.pass} after customer ${state.customers.after} (${state.customers.imported} already imported).`);

  // The catalog is cheap and always re-synced, so products or offerings added since the last run come along.
  log(`Catalog: RevenueCat project ${o.rcProject} -> RevenueDot project ${project.id} (${project.name})${dryRun ? " [dry run]" : ""}`);
  const catalog = await importCatalog(rc, rd, { dryRun, publicKeys: o.publicKeys ?? true, log });
  state.catalog = { ...catalog.map, done: true };
  for (const p of catalog.problems) addProblem(state.problems, p);
  save();
  const c = catalog.report;
  progress(`catalog: ${c.apps.created + c.apps.matched} apps, ${c.products.created + c.products.matched} products, ${c.entitlements.created + c.entitlements.matched} entitlements, ${c.offerings.created + c.offerings.matched} offerings`);

  const { googleWithoutToken } = await importCustomers(rc, rd, catalog.map, state, {
    dryRun, concurrency: o.concurrency ?? 4, pageSize: o.pageSize, limit: o.limit, tokens: o.tokens, emitEvents: o.emitEvents, save, log, progress,
  });
  return { dryRun, source: o.rcProject, target, catalog: catalog.report, customers: state.customers, googleWithoutToken, problems: state.problems, statePath: dryRun ? null : o.statePath };
}

export function formatReport(r: ImportReport): string {
  const out: string[] = [];
  const verb = r.dryRun ? "would be created" : "created";
  out.push(r.dryRun ? "Dry run: nothing was written to RevenueDot." : `Import finished: RevenueCat project ${r.source} -> ${r.target.url} (project ${r.target.project}).`);
  out.push("");
  out.push("Catalog");
  const line = (name: string, x: { created: number; matched: number; updated: number }) => `  ${name.padEnd(14)} ${x.created} ${verb}, ${x.matched} already there${x.updated ? `, ${x.updated} updated` : ""}`;
  out.push(line("Apps", r.catalog.apps), line("Products", r.catalog.products), line("Entitlements", r.catalog.entitlements), line("Offerings", r.catalog.offerings), line("Packages", r.catalog.packages));
  out.push(`  ${"SDK keys".padEnd(14)} ${r.catalog.publicKeys.updated} kept (existing app builds keep working with RevenueDot)`);
  out.push("");
  out.push(`Customers (pass ${r.customers.pass}${r.customers.complete ? ", complete" : ", incomplete: run again to continue"})`);
  out.push(`  ${r.customers.imported} customers ${r.dryRun ? "read" : "imported"}${r.dryRun ? "" : ` (${r.customers.created} new, ${r.customers.merged} merged with existing ones)`}`);
  out.push(`  ${r.customers.subscriptions} subscriptions, ${r.customers.purchases} one-time purchases`);
  if (r.dryRun && r.googleWithoutToken) out.push(`  ${r.googleWithoutToken} Google Play subscriptions have no purchase token in the export; RevenueDot looks them up with the app's service account, or marks them needs_token_refresh`);
  if (!r.dryRun && r.customers.needsTokenRefresh) out.push(`  ${r.customers.needsTokenRefresh} Google Play subscriptions need a purchase token (add the service account and run again; see "revenuedot import plan")`);
  const by = (k: Problem["kind"]) => r.problems.filter((p) => p.kind === k);
  const section = (title: string, list: Problem[]) => { if (list.length) { out.push("", title, ...list.slice(0, 50).map((p) => `  - ${p.message}`)); if (list.length > 50) out.push(`  ... and ${list.length - 50} more in ${r.statePath ?? "the state file"}`); } };
  section("Store credentials to re-enter in RevenueDot (they cannot be exported)", by("credentials"));
  section("Skipped", by("skipped"));
  section("Errors", by("error"));
  section("Notes", by("note"));
  out.push("", `Next: npx revenuedot import verify (same flags), then npx revenuedot import plan for the cutover steps.`);
  if (r.statePath) out.push(`State: ${r.statePath}`);
  return out.join("\n");
}
