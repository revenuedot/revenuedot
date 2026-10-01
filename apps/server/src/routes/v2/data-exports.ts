import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { depsSecretKey, mergeSecrets, unseal } from "../../services/secrets.js";
import { nextRunAt } from "../../services/exports/run.js";
import { checkBucket, StorageError, type Destination } from "../../services/exports/storage.js";
import { EXPORT_TABLES } from "../../services/exports/tables.js";
import { outboundUrlProblem } from "../../services/outbound.js";
import { V2Error, body, listOf, notFound, pageParams, paginate, paramError, scope, type V2Router } from "./common.js";

/**
 * Scheduled data exports (RevenueDot extension): CSV or Parquet files of transactions, customers, subscriptions and
 * events, written daily or weekly to Amazon S3, Cloudflare R2 or Google Cloud Storage.
 *   GET    /v2/projects/{project_id}/integrations/exports                               list
 *   POST   /v2/projects/{project_id}/integrations/exports                               create
 *   GET    /v2/projects/{project_id}/integrations/exports/{export_id}
 *   POST   /v2/projects/{project_id}/integrations/exports/{export_id}                   update
 *   DELETE /v2/projects/{project_id}/integrations/exports/{export_id}
 *   POST   /v2/projects/{project_id}/integrations/exports/{export_id}/actions/run       run now (`mode` full or incremental)
 *   POST   /v2/projects/{project_id}/integrations/exports/{export_id}/actions/check     check the bucket and credentials
 *   GET    /v2/projects/{project_id}/integrations/exports/{export_id}/runs              run history, newest first
 * `credentials` (secret_access_key, service_account_json) are sealed and come back only as `{ configured, hint }`.
 */

const Dest = z.enum(["s3", "r2", "gcs"]);
const Config = z.object({
  bucket: z.string().trim().min(3).max(222).regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/, "must be a valid bucket name (lower case letters, digits, dots, dashes)").optional(),
  prefix: z.string().trim().max(512).regex(/^[^\\]*$/).refine((p) => !p.split("/").some((seg) => seg === "." || seg === ".."), "must not contain . or .. folders").nullable().optional(),
  region: z.string().trim().regex(/^[a-z0-9-]{2,32}$/).nullable().optional(),
  endpoint: z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL").nullable().optional(),
  account_id: z.string().trim().regex(/^[a-f0-9]{32}$/, "must be the 32-character Cloudflare account ID").nullable().optional(),
  access_key_id: z.string().trim().min(1).max(256).nullable().optional(),
}).strict();
const Credentials = z.object({ secret_access_key: z.string().max(1024).nullable().optional(), service_account_json: z.string().max(20_000).nullable().optional() }).strict();
const Table = z.enum(EXPORT_TABLES);
const Fields = {
  name: z.string().trim().min(1).max(255), enabled: z.boolean(), destination: Dest, config: Config, credentials: Credentials,
  format: z.enum(["csv", "parquet"]), compression: z.enum(["gzip", "none"]), schedule: z.enum(["daily", "weekly"]),
  hour_utc: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6).nullable(), mode: z.enum(["incremental", "full"]),
  tables: z.array(Table).min(1).max(EXPORT_TABLES.length), environment: z.enum(["production", "sandbox"]).nullable(),
};
const Create = z.object({ ...Fields, name: Fields.name.optional(), enabled: Fields.enabled.optional(), credentials: Fields.credentials.optional(),
  format: Fields.format.optional(), compression: Fields.compression.optional(), schedule: Fields.schedule.optional(), hour_utc: Fields.hour_utc.optional(),
  weekday: Fields.weekday.optional(), mode: Fields.mode.optional(), tables: Fields.tables.optional(), environment: Fields.environment.optional() }).strict();
const Update = z.object(Fields).partial().strict();
const Run = z.object({ mode: z.enum(["incremental", "full"]).optional() }).strict();

type Job = typeof schema.exportJobs.$inferSelect;
type RunRow = typeof schema.exportRuns.$inferSelect;
const SECRET_FIELDS: Record<Destination, string> = { s3: "secret_access_key", r2: "secret_access_key", gcs: "service_account_json" };

export function exportShape(j: Job) {
  const secretField = SECRET_FIELDS[j.destination as Destination];
  return {
    object: "data_export" as const, id: j.id, project_id: j.projectId, name: j.name, enabled: j.enabled, destination: j.destination,
    config: { bucket: null, prefix: null, region: null, endpoint: null, account_id: null, access_key_id: null, ...j.destinationConfig },
    credentials: { [secretField]: { configured: secretField in j.secretHints, hint: j.secretHints[secretField] ?? null } },
    format: j.format, compression: j.compression, schedule: j.schedule, hour_utc: j.hourUtc, weekday: j.weekday, mode: j.mode, tables: j.tables,
    environment: j.environment === "both" ? null : j.environment, next_run_at: j.nextRunAt?.getTime() ?? null, last_run_at: j.lastRunAt?.getTime() ?? null,
    last_error: j.lastError, consecutive_failures: j.consecutiveFailures, created_at: j.createdAt.getTime(), updated_at: j.updatedAt?.getTime() ?? null,
  };
}

export function runShape(r: RunRow) {
  return {
    object: "data_export_run" as const, id: r.id, export_id: r.jobId, status: r.status, trigger: r.trigger, mode: r.mode,
    window_start: r.windowStart?.getTime() ?? null, window_end: r.windowEnd.getTime(), attempts: r.attempts,
    next_attempt_at: r.status === "queued" ? r.nextAttemptAt.getTime() : null, files: r.files, rows: r.rows, bytes: r.bytes, error: r.error,
    started_at: r.startedAt?.getTime() ?? null, finished_at: r.finishedAt?.getTime() ?? null, created_at: r.createdAt.getTime(),
  };
}

function checkDestination(dest: Destination, config: Record<string, unknown>, secrets: Record<string, string>, strictUrls: boolean) {
  if (!config.bucket) throw paramError("config.bucket: set the bucket name.", "config.bucket");
  const endpointProblem = typeof config.endpoint === "string" ? outboundUrlProblem(config.endpoint, strictUrls) : null;
  if (endpointProblem) throw paramError(`config.endpoint: ${endpointProblem}.`, "config.endpoint");
  if (dest === "gcs") {
    let j: Record<string, unknown> | null = null;
    try { j = secrets.service_account_json ? JSON.parse(secrets.service_account_json) : null; } catch { j = null; }
    if (!j || typeof j.client_email !== "string" || typeof j.private_key !== "string") throw paramError("credentials.service_account_json: paste the service account's JSON key (with client_email and private_key).", "credentials.service_account_json");
    return;
  }
  if (dest === "r2" && !config.account_id && !config.endpoint) throw paramError("config.account_id: set your Cloudflare account ID.", "config.account_id");
  if (!config.access_key_id) throw paramError("config.access_key_id: set the access key ID.", "config.access_key_id");
  if (!secrets.secret_access_key) throw paramError("credentials.secret_access_key: set the secret access key.", "credentials.secret_access_key");
}

export function dataExportRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/integrations/exports";
  const find = async (projectId: string, id: string) => {
    const [j] = await db.select().from(schema.exportJobs).where(and(eq(schema.exportJobs.projectId, projectId), eq(schema.exportJobs.id, id))).limit(1);
    if (!j) throw notFound("Data export");
    return j;
  };
  const cleanConfig = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined && v !== ""));

  r.get(P, scope("project_configuration:integrations:read"), async (c) => {
    const rows = await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), exportShape));
  });

  r.post(P, scope("project_configuration:integrations:read_write"), async (c) => {
    const b = await body(c, Create);
    const config = cleanConfig(b.config);
    const merged = await mergeSecrets(null, b.credentials ?? {}, await depsSecretKey(deps));
    checkDestination(b.destination, config, merged.values, deps.edition === "cloud");
    const schedule = b.schedule ?? "daily";
    const hourUtc = b.hour_utc ?? 3;
    const weekday = schedule === "weekly" ? b.weekday ?? 1 : null;
    const now = deps.now();
    const [row] = await db.insert(schema.exportJobs).values({
      id: newId("export_", 14), projectId: c.get("projectId"), name: b.name ?? `${b.destination.toUpperCase()} export`, enabled: b.enabled ?? true,
      destination: b.destination, destinationConfig: config, secrets: merged.sealed, secretHints: merged.hints, format: b.format ?? "csv", compression: b.compression ?? "gzip",
      schedule, hourUtc, weekday, mode: b.mode ?? "incremental", tables: b.tables ?? ["transactions"], environment: b.environment === undefined ? "both" : b.environment ?? "both",
      nextRunAt: nextRunAt({ schedule, hourUtc, weekday }, now), createdAt: now, updatedAt: now,
    }).returning();
    return c.json(exportShape(row!), 201);
  });

  r.get(`${P}/:export_id`, scope("project_configuration:integrations:read"), async (c) => c.json(exportShape(await find(c.get("projectId"), c.req.param("export_id")))));

  r.post(`${P}/:export_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    const b = await body(c, Update);
    const destination = b.destination ?? (j.destination as Destination);
    const config: Record<string, unknown> = { ...j.destinationConfig };
    for (const [k, v] of Object.entries(b.config ?? {})) { if (v === null || v === "") delete config[k]; else config[k] = v; }
    // Switching between S3/R2 and GCS drops the other kind's secret.
    const creds: Record<string, string | null | undefined> = { ...(b.credentials ?? {}) };
    if (b.destination && SECRET_FIELDS[b.destination] !== SECRET_FIELDS[j.destination as Destination]) creds[SECRET_FIELDS[j.destination as Destination]] = null;
    const merged = await mergeSecrets(j.secrets, creds, await depsSecretKey(deps));
    checkDestination(destination, config, merged.values, deps.edition === "cloud");
    const schedule = b.schedule ?? j.schedule, hourUtc = b.hour_utc ?? j.hourUtc;
    const weekday = schedule === "weekly" ? (b.weekday !== undefined ? b.weekday ?? 1 : j.weekday ?? 1) : null;
    const timing = b.schedule !== undefined || b.hour_utc !== undefined || b.weekday !== undefined || b.enabled === true;
    const [row] = await db.update(schema.exportJobs).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), destination, destinationConfig: config,
      secrets: merged.sealed, secretHints: merged.hints, ...(b.format !== undefined ? { format: b.format } : {}), ...(b.compression !== undefined ? { compression: b.compression } : {}),
      schedule, hourUtc, weekday, ...(b.mode !== undefined ? { mode: b.mode } : {}), ...(b.tables !== undefined ? { tables: b.tables } : {}),
      ...(b.environment !== undefined ? { environment: b.environment ?? "both" } : {}),
      ...(timing ? { nextRunAt: nextRunAt({ schedule, hourUtc, weekday }, deps.now()) } : {}), updatedAt: deps.now(),
    }).where(eq(schema.exportJobs.id, j.id)).returning();
    return c.json(exportShape(row!));
  });

  // Runs go with it (FK cascade). Files already written stay in the bucket.
  r.delete(`${P}/:export_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    await db.delete(schema.exportJobs).where(eq(schema.exportJobs.id, j.id));
    return c.json({ object: "data_export", id: j.id, deleted_at: deps.now().getTime() });
  });

  r.post(`${P}/:export_id/actions/run`, scope("project_configuration:integrations:read_write"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    const b = await body(c, Run);
    const R = schema.exportRuns;
    const [open] = await db.select().from(R).where(and(eq(R.jobId, j.id), inArray(R.status, ["queued", "running"]))).limit(1);
    if (open) throw new V2Error(409, "resource_locked_error", "A run of this export is already queued or running.", undefined, true);
    const now = deps.now();
    const mode = b.mode ?? j.mode;
    const starts = j.tables.map((t) => j.cursor[t]);
    const windowStart = mode === "full" || starts.some((s) => s === undefined) ? null : new Date(Math.min(...(starts as number[])));
    const [run] = await db.insert(R).values({ id: newId("exprun_", 14), jobId: j.id, status: "queued", trigger: "manual", mode, windowStart, windowEnd: now, nextAttemptAt: now, createdAt: now }).returning();
    deps.kick?.();
    return c.json(runShape(run!), 201);
  });

  r.post(`${P}/:export_id/actions/check`, scope("project_configuration:integrations:read_write"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    const now = deps.now();
    try {
      const secrets = await unseal(j.secrets, await depsSecretKey(deps));
      await checkBucket({ destination: j.destination as Destination, config: j.destinationConfig, secrets, strictUrls: deps.edition === "cloud" }, deps.fetch ?? fetch, now);
      return c.json({ object: "storage_check", export_id: j.id, ok: true, message: `RevenueDot can reach the bucket ${j.destinationConfig.bucket}.`, checked_at: now.getTime() });
    } catch (e) {
      const message = e instanceof StorageError && e.status === 403 ? `${e.message} Check that the credentials can list and write to the bucket.`
        : e instanceof StorageError && e.status === 404 ? `${e.message} The bucket does not exist or is in another region.` : e instanceof Error ? e.message : String(e);
      return c.json({ object: "storage_check", export_id: j.id, ok: false, message, checked_at: now.getTime() });
    }
  });

  r.get(`${P}/:export_id/runs`, scope("project_configuration:integrations:read"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    const { limit, startingAfter } = pageParams(c);
    const R = schema.exportRuns;
    const conds = [eq(R.jobId, j.id)];
    if (startingAfter) {
      const [cur] = await db.select().from(R).where(and(eq(R.jobId, j.id), eq(R.id, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match a run of this export.", "starting_after");
      conds.push(sql`(${R.createdAt}, ${R.id}) < (${cur.createdAt.toISOString()}::timestamptz, ${cur.id})`);
    }
    const rows = await db.select().from(R).where(and(...conds)).orderBy(desc(R.createdAt), desc(R.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, page.map(runShape), rows.length > limit ? page[page.length - 1]!.id : null));
  });
}
