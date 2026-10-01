import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { V2Error, body, listOf, notFound, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { ExportInputError, advanceExport, createExport, downloadToken, exportPrefix, latestExports, type ExportRow } from "../../services/archive/export.js";
import { apiOrigin, archiveRuntime, exportShape, linkMaterial, setMoveState } from "../../services/archive/runtime.js";
import { MoveInputError, advanceServerMove, checkTargetUrl, finishServerMove, latestMove, moveShape, startServerMove } from "../../services/archive/server-move.js";

/**
 * Full exports and moves, the source side (prd/moves-export/PRD.md §2). A secret key needs
 * `project_configuration:projects:read_write`; in the dashboard only Admins can export or move a project, because an
 * archive holds every customer and, with a passphrase, every secret.
 */
const E = schema.projectExports;
const write = scope("project_configuration:projects:read_write");

const CreateExport = z.object({
  purpose: z.enum(["download", "move"]).optional(),
  include_secrets: z.boolean().optional(),
  passphrase: z.string().min(12, "The export passphrase needs at least 12 characters.").max(200).optional(),
}).strict();

function adminOnly(c: V2Context) {
  const p = c.get("principal");
  if (p.kind === "user" && p.role !== "admin") throw new V2Error(403, "authorization_error", "Only project Admins can export or move a project.");
  if (p.kind === "user" && p.via === "assistant") throw new V2Error(403, "authorization_error", "RevenueDot AI cannot export or move projects.");
}

export function moveRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const find = async (c: V2Context) => {
    const [e] = await db.select().from(E).where(and(eq(E.id, c.req.param("export_id")!), eq(E.projectId, c.get("projectId"))));
    if (!e || e.purpose === "verify") throw notFound("Export");
    return e;
  };
  const shape = async (c: V2Context, e: ExportRow) => {
    if (e.status !== "succeeded") return exportShape(e);
    const exp = deps.now().getTime() + 3_600_000;
    const token = await downloadToken(e.id, exp, linkMaterial(deps));
    return exportShape(e, { download_url: `${apiOrigin(deps, c)}/v2/exports/download/${token}`, download_expires_at: exp });
  };

  r.post("/v2/projects/:project_id/exports", write, async (c) => {
    adminOnly(c);
    const b = await body(c, CreateExport);
    if (b.include_secrets && !b.passphrase) throw paramError("include_secrets needs a passphrase: the secrets are encrypted with it.", "passphrase");
    const p = c.get("principal");
    try {
      const e = await createExport(await archiveRuntime(deps), {
        projectId: c.get("projectId"), purpose: b.purpose ?? "download", passphrase: b.passphrase ?? null,
        requestedBy: p.kind === "user" ? p.userId : `key:${p.keyId}`, sourceUrl: apiOrigin(deps, c), edition: deps.edition ?? "self-hosted",
      });
      deps.kick?.();
      return c.json(await shape(c, e), 202);
    } catch (e) {
      if (e instanceof ExportInputError) throw paramError(e.message, "passphrase");
      throw e;
    }
  });

  r.get("/v2/projects/:project_id/exports", write, async (c) => {
    adminOnly(c);
    const rows = await latestExports(db, c.get("projectId"));
    return c.json(listOf(c, await Promise.all(rows.map((e) => shape(c, e))), null));
  });

  r.get("/v2/projects/:project_id/export", write, async (c) => {
    adminOnly(c);
    const [e] = await latestExports(db, c.get("projectId"), 1);
    if (!e) throw notFound("Export");
    return c.json(await shape(c, e));
  });

  r.get("/v2/projects/:project_id/exports/:export_id", write, async (c) => { adminOnly(c); return c.json(await shape(c, await find(c))); });

  r.post("/v2/projects/:project_id/exports/:export_id/actions/advance", write, async (c) => {
    adminOnly(c);
    const e = await find(c);
    const row = await advanceExport(await archiveRuntime(deps, 8_000), e.id);
    return c.json(await shape(c, row ?? e));
  });

  // One archive file (the CLI copies files one by one).
  r.get("/v2/projects/:project_id/exports/:export_id/files/*", write, async (c) => {
    adminOnly(c);
    const e = await find(c);
    if (e.status !== "succeeded") throw new V2Error(409, "resource_locked_error", "The export is not finished yet.");
    const name = decodeURIComponent(c.req.path.split(`/files/`)[1] ?? "");
    if (!/^(manifest\.json|members\.json|(tables|secrets)\/[a-z_]+\/\d{4}\.(jsonl\.gz|json\.enc))$/.test(name)) throw notFound("File");
    const rt = await archiveRuntime(deps);
    const bytes = await rt.store.get(exportPrefix(e.projectId, e.id) + name);
    if (!bytes) throw notFound("File");
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream", "cache-control": "no-store" } });
  });

  r.delete("/v2/projects/:project_id/exports/:export_id", write, async (c) => {
    adminOnly(c);
    const e = await find(c);
    const rt = await archiveRuntime(deps);
    await rt.store.deletePrefix(exportPrefix(e.projectId, e.id));
    await db.update(E).set({ status: "expired", secretKey: null }).where(eq(E.id, e.id));
    return c.json({ object: "project_export", id: e.id, deleted: true });
  });

  /* ---- Move state of this project (the CLI and the dashboard). ---- */

  const projectRow = async (c: V2Context) => (await db.select().from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))))[0]!;
  const stateShape = async (c: V2Context) => {
    const p = await projectRow(c);
    return { object: "project_move_state", project_id: p.id, state: p.moveState, moved_to_url: p.movedToUrl, moved_in_at: p.movedInAt?.getTime() ?? null, moved_in_from: p.movedInFrom, updated_at: p.moveUpdatedAt?.getTime() ?? null, move: moveShape(await latestMove(deps, p.id)) };
  };

  r.get("/v2/projects/:project_id/move", scope("project_configuration:projects:read"), async (c) => c.json(await stateShape(c)));

  r.post("/v2/projects/:project_id/move/pause", write, async (c) => {
    adminOnly(c);
    const p = await projectRow(c);
    if (p.moveState === "forwarded" || p.moveState === "incoming") throw new V2Error(409, "resource_locked_error", `The project is ${p.moveState}; it cannot be paused.`);
    await setMoveState(db, p.id, "paused", deps.now());
    return c.json(await stateShape(c));
  });

  r.post("/v2/projects/:project_id/move/forward", write, async (c) => {
    adminOnly(c);
    const b = await body(c, z.object({ to_url: z.string().url() }));
    let url: string;
    try { url = checkTargetUrl(deps, b.to_url, apiOrigin(deps, c)); } catch (e) { throw paramError(e instanceof Error ? e.message : String(e), "to_url"); }
    const p = await projectRow(c);
    if (p.moveState !== "paused") throw new V2Error(409, "resource_locked_error", "Pause the project and copy it before forwarding (npx revenuedot move --finish does both).");
    await setMoveState(db, p.id, "forwarded", deps.now(), url);
    return c.json(await stateShape(c));
  });

  // Undo: a paused project serves writes again; a forwarded one serves everything here again (the copy elsewhere stays).
  r.post("/v2/projects/:project_id/move/cancel", write, async (c) => {
    adminOnly(c);
    const p = await projectRow(c);
    if (p.moveState === "incoming") throw new V2Error(409, "resource_locked_error", "This project is being copied in; cancel the move on the server it comes from, or delete this copy.");
    const m = await latestMove(deps, p.id);
    if (m && ["running", "ready", "copied"].includes(m.status)) await db.update(schema.projectMoves).set({ status: "cancelled", updatedAt: deps.now() }).where(eq(schema.projectMoves.id, m.id));
    await setMoveState(db, p.id, null, deps.now(), null);
    return c.json(await stateShape(c));
  });

  // The dashboard's move, run by this server.
  r.post("/v2/projects/:project_id/move", write, async (c) => {
    adminOnly(c);
    const b = await body(c, z.object({ to_url: z.string().min(1), to_token: z.string().min(1), dry_run: z.boolean().optional() }));
    const self = apiOrigin(deps, c);
    const p = await projectRow(c);
    if (p.moveState) throw new V2Error(409, "resource_locked_error", `The project is ${p.moveState}.`);
    let url: string;
    try { url = checkTargetUrl(deps, b.to_url.trim(), self); } catch (e) { throw paramError(e instanceof Error ? e.message : String(e), "to_url"); }
    const pr = c.get("principal");
    try {
      const row = await startServerMove(deps, { projectId: p.id, targetUrl: url, token: b.to_token.trim(), dryRun: !!b.dry_run, userId: pr.kind === "user" ? pr.userId : null, self });
      const advanced = await advanceServerMove(deps, row.id, 6_000);
      return c.json(moveShape(advanced), 202);
    } catch (e) {
      if (e instanceof MoveInputError) throw paramError(e.message, "to_token");
      throw e;
    }
  });

  r.post("/v2/projects/:project_id/move/actions/advance", write, async (c) => {
    adminOnly(c);
    const m = await latestMove(deps, c.get("projectId"));
    if (!m) throw notFound("Move");
    return c.json(moveShape(m.status === "running" ? await advanceServerMove(deps, m.id, 8_000) : m));
  });

  r.post("/v2/projects/:project_id/move/finish", write, async (c) => {
    adminOnly(c);
    const m = await latestMove(deps, c.get("projectId"));
    if (!m) throw notFound("Move");
    try {
      const next = await finishServerMove(deps, m);
      return c.json(moveShape(await advanceServerMove(deps, next.id, 6_000)), 202);
    } catch (e) {
      if (e instanceof MoveInputError) throw new V2Error(409, "resource_locked_error", e.message);
      throw e;
    }
  });
}
