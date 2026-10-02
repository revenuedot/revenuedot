// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the import's state file, which makes a run resumable and a re-run incremental.
// Docs: https://revenuedot.app/docs/migrate
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface Problem {
  /** credentials: store keys to re-enter; token: Google purchase token missing; skipped: data not imported; note: worth knowing. */
  kind: "credentials" | "token" | "skipped" | "note" | "error";
  message: string;
}

export interface CatalogMap {
  apps: Record<string, { id: string | null; type: string; name: string; identifier: string | null }>;
  products: Record<string, { id: string | null; storeIdentifier: string; appId: string | null; rcAppId: string; type: string }>;
  entitlements: Record<string, { id: string | null; lookupKey: string }>;
  offerings: Record<string, { id: string | null; lookupKey: string }>;
  packages: Record<string, { id: string | null; lookupKey: string }>;
}

export interface ImportState {
  version: 1;
  source: { project: string };
  target: { url: string; project: string };
  startedAt: string;
  updatedAt: string;
  catalog: CatalogMap & { done: boolean };
  customers: {
    /** Full passes over the source's customer list; a re-run after a complete pass starts the next one. */
    pass: number;
    /** Last source customer id of the last imported page (the resume point). */
    after: string | null;
    complete: boolean;
    pages: number;
    imported: number;
    created: number;
    merged: number;
    subscriptions: number;
    purchases: number;
    needsTokenRefresh: number;
    /** The list walk of this pass is done; only the catch-up (RevenueCat ids RevenueDot lacks) is left. */
    walked?: boolean;
    /** Customers the catch-up imported (RevenueCat's list order shifted them past the walk). */
    caughtUp?: number;
  };
  problems: Problem[];
}

export const emptyCatalog = (): CatalogMap => ({ apps: {}, products: {}, entitlements: {}, offerings: {}, packages: {} });

export function newState(source: string, target: { url: string; project: string }, now = new Date()): ImportState {
  return {
    version: 1, source: { project: source }, target, startedAt: now.toISOString(), updatedAt: now.toISOString(),
    catalog: { ...emptyCatalog(), done: false },
    customers: { pass: 1, after: null, complete: false, pages: 0, imported: 0, created: 0, merged: 0, subscriptions: 0, purchases: 0, needsTokenRefresh: 0 },
    problems: [],
  };
}

export function loadState(path: string): ImportState | null {
  if (!existsSync(path)) return null;
  const s = JSON.parse(readFileSync(path, "utf8")) as ImportState;
  if (s.version !== 1) throw new Error(`${path} was written by a different importer version; move it away or pass --restart.`);
  return s;
}

/** Writes to a temporary file and renames it, so a crash never leaves half a state file. */
export function saveState(path: string, s: ImportState, now = new Date()) {
  s.updatedAt = now.toISOString();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}

const MAX_PROBLEMS = 1000;

/** Adds a problem once (the same message twice is one problem). The list is capped so a huge import keeps a small state file. */
export function addProblem(list: Problem[], p: Problem) {
  if (list.length >= MAX_PROBLEMS || list.some((x) => x.kind === p.kind && x.message === p.message)) return;
  list.push(p);
}
