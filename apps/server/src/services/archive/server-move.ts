import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { HttpTarget } from "revenuedot/src/move/clients.js";
import { MoveError, newMoveState, runMove, type ExportInfo, type MoveSource, type MoveState } from "revenuedot/src/move/core.js";
import type { Deps } from "../../context.js";
import { seal, unseal } from "../secrets.js";
import { outboundUrlProblem } from "../outbound.js";
import { advanceExport, createExport, exportPrefix, type ArchiveRuntime } from "./export.js";
import { randomPassphrase } from "./format.js";
import { archiveRuntime, setMoveState } from "./runtime.js";

/**
 * The dashboard's "Move this project" (prd/moves-export/PRD.md §6): this server runs the same step machine as
 * `npx revenuedot move`, with itself as the source (direct calls) and the destination over HTTP with its import token.
 * Steps run a few seconds at a time, from the `advance` endpoint the page polls and from the background tick.
 */

const M = schema.projectMoves;
export type MoveRow = typeof M.$inferSelect;
const LEASE_MS = 60_000;

/** This server as the source of a move. */
export function localSource(deps: Deps, rt: ArchiveRuntime, projectId: string, label: string): MoveSource {
  const info = (e: { id: string; status: string; error: string | null; rows: number; progress: { table: number } | null }): ExportInfo => ({ id: e.id, status: e.status as ExportInfo["status"], error: e.error, rows: e.rows, progress: e.progress });
  return {
    label,
    async project() {
      const [p] = await deps.db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
      return { id: p!.id, name: p!.name, move_state: p!.moveState };
    },
    async startExport(passphrase) { return info(await createExport(rt, { projectId, purpose: "move", passphrase, sourceUrl: label, edition: deps.edition })); },
    async advanceExport(id) { return info((await advanceExport({ ...rt, now: deps.now(), budgetMs: 5_000 }, id))!); },
    async readFile(exportId, name) {
      const b = await rt.store.get(exportPrefix(projectId, exportId) + name);
      if (!b) throw new MoveError(`The archive file ${name} is missing.`);
      return b;
    },
    pause: () => setMoveState(deps.db, projectId, "paused", deps.now()),
    forward: (url) => setMoveState(deps.db, projectId, "forwarded", deps.now(), url),
    cancel: () => setMoveState(deps.db, projectId, null, deps.now(), null),
  };
}

export class MoveInputError extends Error {}

export function checkTargetUrl(deps: Deps, url: string, self: string): string {
  const problem = outboundUrlProblem(url, deps.edition === "cloud");
  if (problem) throw new MoveInputError(`The destination ${problem}.`);
  const u = new URL(url);
  if (u.origin === new URL(self).origin) throw new MoveInputError("The destination is this server.");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

export async function startServerMove(deps: Deps, o: { projectId: string; targetUrl: string; token: string; dryRun: boolean; userId: string | null; self: string }): Promise<MoveRow> {
  if (!/^rdi_[0-9a-f]{64}$/.test(o.token)) throw new MoveInputError("Paste the import token from the destination (Receive a project), which starts with rdi_.");
  const key = (await archiveRuntime(deps)).serverKey;
  const now = deps.now();
  await deps.db.update(M).set({ status: "cancelled", updatedAt: now }).where(and(eq(M.projectId, o.projectId), inArray(M.status, ["running", "ready", "copied"])));
  const state = newMoveState(o.self, o.targetUrl, "copy", o.dryRun);
  const [row] = await deps.db.insert(M).values({
    id: newId("mov_", 16), projectId: o.projectId, targetUrl: o.targetUrl, secrets: (await seal({ token: o.token, passphrase: randomPassphrase() }, key))!,
    status: "running", state: state as unknown as Record<string, unknown>, requestedBy: o.userId, createdAt: now, updatedAt: now,
  }).returning();
  return row!;
}

/** Runs the move's steps for up to `budgetMs`. Returns the row afterwards. */
export async function advanceServerMove(deps: Deps, id: string, budgetMs = 8_000): Promise<MoveRow> {
  const now = deps.now();
  const [claimed] = await deps.db.update(M).set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(and(eq(M.id, id), eq(M.status, "running"), or(isNull(M.leaseUntil), lte(M.leaseUntil, now)))).returning();
  if (!claimed) return (await deps.db.select().from(M).where(eq(M.id, id)))[0]!;
  const rt = await archiveRuntime(deps);
  const secrets = await unseal(claimed.secrets, rt.serverKey);
  const s = claimed.state as unknown as MoveState;
  const save = async (st: MoveState) => { await deps.db.update(M).set({ state: st as unknown as Record<string, unknown>, updatedAt: deps.now() }).where(eq(M.id, id)); };
  try {
    const result = await runMove({
      source: localSource(deps, rt, claimed.projectId, s.source),
      target: new HttpTarget(claimed.targetUrl, secrets.token!, { fetch: deps.fetch ?? fetch, maxRetries: 1, sleep: async () => {} }),
      passphrase: secrets.passphrase!, now: () => Date.now(), save, replace: true, drainSeconds: deps.moveDrainSeconds ?? 10,
    }, s, Date.now() + budgetMs);
    const status = result === "done" ? (s.mode === "finish" ? "finished" : s.dryRun ? "ready" : "copied") : "running";
    const [row] = await deps.db.update(M).set({ status, state: s as unknown as Record<string, unknown>, error: null, leaseUntil: null, updatedAt: deps.now() }).where(eq(M.id, id)).returning();
    return row!;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A move that paused the source and failed gives the project back to this server.
    if (s.mode === "finish" && s.phase !== "done" && !s.report) await setMoveState(deps.db, claimed.projectId, null, deps.now()).catch(() => {});
    const [row] = await deps.db.update(M).set({ status: "failed", error: message.slice(0, 2000), state: s as unknown as Record<string, unknown>, leaseUntil: null, updatedAt: deps.now() }).where(eq(M.id, id)).returning();
    return row!;
  }
}

/** "Finish move": the same import, now with the pause, a last copy, verification, go-live and forwarding. */
export async function finishServerMove(deps: Deps, row: MoveRow): Promise<MoveRow> {
  const s = row.state as unknown as MoveState;
  if (row.status !== "copied" && row.status !== "ready") throw new MoveInputError(row.status === "finished" ? "This move is finished." : "Copy the data first; finish after the copy is verified.");
  const next: MoveState = { ...s, mode: "finish", dryRun: false, phase: "paused", pausedAt: undefined, exportId: undefined, verify: undefined };
  const [r] = await deps.db.update(M).set({ status: "running", state: next as unknown as Record<string, unknown>, error: null, updatedAt: deps.now() }).where(eq(M.id, row.id)).returning();
  return r!;
}

/**
 * The project's latest move. Two moves can share a timestamp (a frozen test clock, or a dry run and its copy started in
 * the same millisecond), and Postgres returns ties in any order. A move cancels the earlier ones before it is created, so
 * among equal timestamps the one not cancelled is the newer.
 */
export const latestMove = async (deps: Deps, projectId: string) =>
  (await deps.db.select().from(M).where(eq(M.projectId, projectId)).orderBy(desc(M.createdAt), sql`(${M.status} = 'cancelled')`).limit(1))[0] ?? null;

/** The tick: carries running moves forward. */
export async function processServerMoves(deps: Deps, budgetMs = 15_000): Promise<number> {
  const started = Date.now();
  const due = await deps.db.select({ id: M.id }).from(M).where(and(eq(M.status, "running"), or(isNull(M.leaseUntil), lte(M.leaseUntil, deps.now())))).orderBy(asc(M.updatedAt)).limit(3);
  for (const d of due) {
    const left = budgetMs - (Date.now() - started);
    if (left < 1000) break;
    await advanceServerMove(deps, d.id, left);
  }
  return due.length;
}

export function moveShape(m: MoveRow | null) {
  if (!m) return null;
  const s = m.state as unknown as MoveState;
  return {
    object: "project_move", id: m.id, status: m.status, target_url: m.targetUrl, mode: s.mode, dry_run: s.dryRun, phase: s.phase,
    files_copied: Object.keys(s.done ?? {}).length, plan: s.plan ?? null, verify: s.verify ?? null, report: s.report ?? null, error: m.error,
    created_at: m.createdAt.getTime(), updated_at: m.updatedAt.getTime(),
  };
}
