import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { checkFileToken, EMAIL_FILE_DAYS, emailFileKey } from "../services/exports/email.js";
import { dbStore } from "../services/archive/store.js";
import { linkMaterial } from "../services/archive/runtime.js";

/**
 * GET /v2/data-exports/download/{token}: one file of an email data export (services/exports/email.ts). The signed token
 * is the only auth, so the link in the email works in any browser or with curl; it and the file last 7 days.
 * Mounted before the v2 routes, like the archive download.
 */
export function dataExportDownloadRoutes(deps: Deps) {
  const r = new Hono();
  r.get("/v2/data-exports/download/:token", async (c) => {
    const gone = () => c.json({ object: "error", type: "resource_missing", message: `This download link has expired or is not valid. Files of email exports are kept for ${EMAIL_FILE_DAYS} days.` }, 404);
    const t = await checkFileToken(c.req.param("token"), deps.now(), linkMaterial(deps));
    if (!t) return gone();
    const [row] = await deps.db.select({ r: schema.exportRuns, j: schema.exportJobs }).from(schema.exportRuns).innerJoin(schema.exportJobs, eq(schema.exportJobs.id, schema.exportRuns.jobId)).where(eq(schema.exportRuns.id, t.runId));
    const file = row?.r.files[t.index];
    if (!row || !file || row.j.destination !== "email" || row.r.filesDeletedAt) return gone();
    const bytes = await (deps.archiveStore ?? dbStore(deps.db)).get(emailFileKey(row.j.projectId, row.j.id, row.r.id, file.key));
    if (!bytes) return gone();
    const name = file.key.split("/").pop()!;
    const type = name.endsWith(".parquet") ? "application/vnd.apache.parquet" : name.endsWith(".gz") ? "application/gzip" : "text/csv";
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type, "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
  });
  return r;
}
