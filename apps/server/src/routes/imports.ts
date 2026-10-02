import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { SESSION_COOKIE, sessionUser } from "../services/sessions.js";
import { needsVerification } from "../services/account-email.js";
import { advanceExport, checkDownloadToken, createExport, exportTar } from "../services/archive/export.js";
import { ImportError, applyFile, applyMembers, beginImport, createImportToken, finishImport, importForToken, planImport, type ImportRow, type Manifest } from "../services/archive/import.js";
import { apiOrigin, archiveRuntime, linkMaterial } from "../services/archive/runtime.js";
import { moveStateChanged } from "../services/archive/gate.js";

/**
 * The target side of a move (prd/moves-export/PRD.md §2), outside the project-scoped v2 routes because the project does
 * not exist here yet: an account-level import token (`rdi_`) authorizes it. Also the public archive download, whose
 * signed token is its only auth. Mounted before the v2 routes.
 */
const I = schema.projectImports;

const err = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 422, type: string, message: string) => c.json({ object: "error", type, message, doc_url: "https://revenuedot.app/docs/guides/move-projects" }, status);

function importErr(c: Context, e: unknown) {
  if (e instanceof ImportError) {
    const status = e.code === "conflict" || e.code === "state" ? 409 : e.code === "schema" ? 422 : e.code === "passphrase" ? 400 : 400;
    return err(c, status, e.code === "conflict" ? "resource_already_exists" : e.code === "state" ? "resource_locked_error" : "parameter_error", e.message);
  }
  const msg = e instanceof Error ? e.message : String(e);
  // A unique index the archive collides with (another project here uses the same key, slug or domain).
  if (/duplicate key|unique constraint/i.test(msg)) return err(c, 409, "resource_already_exists", `The archive collides with another project on this server: ${msg.slice(0, 300)}`);
  console.error("import failed", e);
  return c.json({ object: "error", type: "server_error", message: "The import failed on the server. Try again; the copy resumes where it stopped.", retryable: true }, 500);
}

export function importRoutes(deps: Deps) {
  const r = new Hono();
  const { db } = deps;

  const sessionOf = (c: Context) => sessionUser(db, getCookie(c, SESSION_COOKIE), deps.now());

  /** The import this request may act on: its `rdi_` token, or the signed-in user who created it. */
  const importOf = async (c: Context, id?: string): Promise<ImportRow | Response> => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    let row: ImportRow | null = null;
    if (bearer) row = await importForToken(db, bearer, deps.now());
    else if (id) {
      const u = await sessionOf(c);
      if (u) row = (await db.select().from(I).where(and(eq(I.id, id), eq(I.userId, u.id))))[0] ?? null;
    }
    if (!row) return err(c, 401, "authentication_error", "Send the import token from the destination's \"Receive a project\" (Authorization: Bearer rdi_…). Tokens last 24 hours.");
    if (id && row.id !== id) return err(c, 404, "resource_missing", "Import not found.");
    return row;
  };

  const shape = (i: ImportRow) => ({
    object: "project_import", id: i.id, status: i.status, project_id: i.projectId, source_url: i.sourceUrl, files_done: i.filesDone,
    files_total: i.manifest ? (i.manifest as unknown as Manifest).tables.reduce((n, t) => n + t.files.length + (t.secret_files?.length ?? 0), 0) : 0,
    report: i.report, verify: i.verify, expires_at: i.expiresAt.getTime(), created_at: i.createdAt.getTime(), finished_at: i.finishedAt?.getTime() ?? null,
  });

  // "Receive a project": a token for one import, shown once.
  r.post("/v2/imports/tokens", async (c) => {
    const u = await sessionOf(c);
    if (!u) return err(c, 401, "authentication_error", "Sign in to create an import token.");
    const site = c.req.header("sec-fetch-site");
    if (site === "cross-site" || site === "same-site") return err(c, 403, "authorization_error", "Dashboard requests must come from the dashboard.");
    if (needsVerification(deps, u)) return err(c, 403, "authorization_error", "Verify your email address first: check your inbox for the link.");
    const t = await createImportToken(db, u.id, deps.now());
    return c.json({ object: "import_token", id: t.id, token: t.token, expires_at: t.expiresAt.getTime(), url: apiOrigin(deps, c) }, 201);
  });

  r.get("/v2/imports", async (c) => {
    const u = await sessionOf(c);
    if (!u) return err(c, 401, "authentication_error", "Sign in first.");
    const rows = await db.select().from(I).where(eq(I.userId, u.id));
    return c.json({ object: "list", items: rows.filter((x) => x.status !== "open" || x.expiresAt > deps.now()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 20).map(shape), next_page: null, url: "/v2/imports" });
  });

  // Dry run (plan) or begin: the manifest, and the passphrase when the archive carries secrets.
  r.post("/v2/imports", async (c) => {
    const imp = await importOf(c);
    if (imp instanceof Response) return imp;
    let b: { manifest?: Manifest; passphrase?: string; dry_run?: boolean; replace?: boolean };
    try { b = await c.req.json(); } catch { return err(c, 400, "invalid_request", "The body must be JSON: { manifest, passphrase?, dry_run?, replace? }."); }
    if (!b.manifest) return err(c, 400, "parameter_error", "Send the archive's manifest.json as manifest.");
    try {
      if (imp.status === "finished") throw new ImportError("This import is finished. Create a new import token to move the project again.", "state");
      if (b.dry_run) return c.json({ object: "import_plan", import_id: imp.id, plan: await planImport(db, b.manifest, { importId: imp.id, userId: imp.userId }) });
      const row = await beginImport(db, imp, b.manifest, { passphrase: b.passphrase ?? null, replace: !!b.replace, serverKey: (await archiveRuntime(deps)).serverKey, now: deps.now() });
      return c.json(shape(row), 201);
    } catch (e) { return importErr(c, e); }
  });

  r.get("/v2/imports/:id", async (c) => {
    const imp = await importOf(c, c.req.param("id"));
    if (imp instanceof Response) return imp;
    return c.json(shape(imp));
  });

  r.put("/v2/imports/:id/files/*", async (c) => {
    const imp = await importOf(c, c.req.param("id"));
    if (imp instanceof Response) return imp;
    const name = decodeURIComponent(c.req.path.split("/files/")[1] ?? "");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    try {
      const res = await applyFile(db, imp, name, bytes, { userId: imp.userId, serverKey: (await archiveRuntime(deps)).serverKey, now: deps.now() });
      if (name.startsWith("tables/projects/")) moveStateChanged();
      return c.json({ object: "import_file", name, ...res });
    } catch (e) { return importErr(c, e); }
  });

  r.post("/v2/imports/:id/members", async (c) => {
    const imp = await importOf(c, c.req.param("id"));
    if (imp instanceof Response) return imp;
    const b = await c.req.json().catch(() => ({})) as { members?: { email: string; role: string }[] };
    try { return c.json({ object: "import_members", ...(await applyMembers(db, imp, Array.isArray(b.members) ? b.members : [])) }); } catch (e) { return importErr(c, e); }
  });

  // Counts and checksums of the copy, recomputed here, against the manifest. Several calls: done: false until finished.
  r.post("/v2/imports/:id/verify", async (c) => {
    const imp = await importOf(c, c.req.param("id"));
    if (imp instanceof Response) return imp;
    if (!imp.manifest || !imp.projectId) return err(c, 409, "resource_locked_error", "Nothing was imported yet.");
    const m = imp.manifest as unknown as Manifest;
    const rt = await archiveRuntime(deps, 8_000);
    let exportId = (imp.verify as { export_id?: string; manifest_export?: string } | null)?.export_id;
    const stale = (imp.verify as { manifest_export?: string } | null)?.manifest_export !== m.export_id;
    if (!exportId || stale) {
      const e = await createExport(rt, { projectId: imp.projectId, purpose: "verify", against: { tables: m.tables.map((t) => ({ name: t.name, columns: t.columns })) } });
      exportId = e.id;
      await db.update(I).set({ verify: { export_id: e.id, manifest_export: m.export_id ?? null } }).where(eq(I.id, imp.id));
    }
    const e = await advanceExport(rt, exportId);
    if (!e || e.status === "failed") return err(c, 409, "resource_locked_error", `Verification failed: ${e?.error ?? "unknown"}`);
    if (e.status !== "succeeded") return c.json({ object: "import_verify", done: false, tables_done: e.progress?.table ?? 0 });
    const mine = new Map(e.tables.map((t) => [t.name, t]));
    const tables = m.tables.map((t) => {
      const x = mine.get(t.name);
      return { name: t.name, source_rows: t.rows, target_rows: x?.rows ?? 0, source_checksum: t.checksum, target_checksum: x?.checksum ?? "", match: !!x && x.rows === t.rows && x.checksum === t.checksum };
    });
    const ok = tables.every((t) => t.match);
    await db.update(I).set({ verify: { export_id: exportId, manifest_export: m.export_id ?? null, ok, at: deps.now().getTime() } }).where(eq(I.id, imp.id));
    return c.json({ object: "import_verify", done: true, ok, tables });
  });

  r.post("/v2/imports/:id/finish", async (c) => {
    const imp = await importOf(c, c.req.param("id"));
    if (imp instanceof Response) return imp;
    try {
      const report = await finishImport(db, imp, { now: deps.now(), baseUrl: apiOrigin(deps, c) });
      moveStateChanged();
      return c.json({ object: "import_report", ...report });
    } catch (e) { return importErr(c, e); }
  });

  // The whole archive as one tar. The link is signed and lasts an hour; it needs no session, so curl and browsers can use it.
  r.get("/v2/exports/download/:token", async (c) => {
    const id = await checkDownloadToken(c.req.param("token"), deps.now(), linkMaterial(deps));
    if (!id) return err(c, 404, "resource_missing", "This download link has expired or is not valid. Open the export again for a new link.");
    const [e] = await db.select().from(schema.projectExports).where(eq(schema.projectExports.id, id));
    if (!e || e.status !== "succeeded" || e.purpose === "verify" || (e.expiresAt && e.expiresAt <= deps.now())) return err(c, 404, "resource_missing", "This export is no longer available (exports are kept for 7 days).");
    const rt = await archiveRuntime(deps);
    const day = (e.finishedAt ?? e.createdAt).toISOString().slice(0, 10);
    return new Response(exportTar(rt.store, e), { headers: { "content-type": "application/x-tar", "content-disposition": `attachment; filename="revenuedot-${e.projectId}-${day}.tar"`, "cache-control": "no-store" } });
  });

  return r;
}
