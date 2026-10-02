import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { depsSecretKey } from "../secrets.js";
import { dbStore } from "./store.js";
import { tableInfos } from "./tables.js";
import { moveStateChanged } from "./gate.js";
import type { ArchiveRuntime, ExportRow } from "./export.js";

export async function archiveRuntime(deps: Deps, budgetMs?: number): Promise<ArchiveRuntime> {
  return { db: deps.db, store: deps.archiveStore ?? dbStore(deps.db), now: deps.now(), serverKey: await depsSecretKey(deps), budgetMs };
}

/** What signs archive download links: the sealing or signing key (a random per-process key without either). */
export const linkMaterial = (deps: Deps) => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return deps.encryptionKey || deps.signingKey || env.REVENUEDOT_ENCRYPTION_KEY || env.REVENUEDOT_SIGNING_KEY || undefined;
};

/** This server's API origin, as apps and other servers reach it. */
export function apiOrigin(deps: Deps, c: Context): string {
  if (deps.apiUrl) return deps.apiUrl.replace(/\/+$/, "");
  const fwd = c.req.header("x-forwarded-host");
  return fwd ? `${c.req.header("x-forwarded-proto") ?? "https"}://${fwd}` : new URL(c.req.url).origin;
}

export async function setMoveState(db: DB, projectId: string, state: "paused" | "forwarded" | "incoming" | null, now: Date, url?: string | null) {
  await db.update(schema.projects).set({ moveState: state, moveUpdatedAt: now, ...(url !== undefined ? { movedToUrl: url } : {}) }).where(eq(schema.projects.id, projectId));
  moveStateChanged();
}

/** The API shape of an export. */
export function exportShape(e: ExportRow, extra: Record<string, unknown> = {}) {
  return {
    object: "project_export", id: e.id, project_id: e.projectId, status: e.status, purpose: e.purpose, include_secrets: e.includeSecrets, storage: e.storage,
    rows: e.rows, bytes: e.bytes, tables_done: e.progress ? e.progress.table : e.status === "succeeded" ? e.tables.length : 0, tables_total: tableInfos().size,
    progress: e.progress ? { table: e.progress.table, rows_in_table: e.progress.rows } : null,
    error: e.error, created_at: e.createdAt.getTime(), finished_at: e.finishedAt?.getTime() ?? null, expires_at: e.expiresAt?.getTime() ?? null,
    ...(e.status === "succeeded" && e.purpose !== "verify" ? { manifest: e.manifest } : {}),
    ...extra,
  };
}
