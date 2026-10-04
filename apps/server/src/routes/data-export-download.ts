import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { checkFileToken, EMAIL_FILE_DAYS, emailFileKey } from "../services/exports/email.js";
import { emailPieceKey } from "../services/exports/upload.js";
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
    const store = deps.archiveStore ?? dbStore(deps.db);
    const fileKey = emailFileKey(row.j.projectId, row.j.id, row.r.id, file.key);
    const name = file.key.split("/").pop()!;
    const type = name.endsWith(".parquet") ? "application/vnd.apache.parquet" : name.endsWith(".gz") ? "application/gzip" : "text/csv";
    const headers = { "content-type": type, "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store", "content-length": String(file.bytes) };
    if (file.chunks) {
      // A big single-file CSV kept in pieces (services/exports/upload.ts): served in order as one file, one piece in memory at a time.
      const first = await store.get(emailPieceKey(fileKey, 1));
      if (!first) return gone();
      let n = 1;
      const body = new ReadableStream<Uint8Array>({
        start(ctl) { ctl.enqueue(first); },
        async pull(ctl) {
          if (++n > file.chunks!) return ctl.close();
          const piece = await store.get(emailPieceKey(fileKey, n));
          if (!piece) return ctl.error(new Error(`Piece ${n} of ${name} is missing.`));
          ctl.enqueue(piece);
        },
      });
      return new Response(body, { headers });
    }
    const bytes = await store.get(fileKey);
    if (!bytes) return gone();
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers });
  });
  return r;
}
