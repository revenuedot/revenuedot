import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { depsSecretKey, mergeSecrets, unseal } from "../../services/secrets.js";
import { INTERVAL_HOURS, nextRunAt } from "../../services/exports/run.js";
import { checkBucket, secretField, StorageError, type Destination } from "../../services/exports/storage.js";
import { COLUMNS, EXPORT_TABLES, type ExportTable } from "../../services/exports/tables.js";
import { AzureConfigError, parseConnectionString } from "../../services/exports/azure.js";
import { emailJobPrefix, MAX_RECIPIENTS, projectMemberEmails } from "../../services/exports/email.js";
import { dbStore } from "../../services/archive/store.js";
import { isEmailAddress } from "../../mail/index.js";
import { outboundUrlProblem } from "../../services/outbound.js";
import { V2Error, body, listOf, notFound, pageParams, paginate, paramError, scope, type V2Router } from "./common.js";

/**
 * Scheduled data exports (RevenueDot extension): CSV or Parquet files of transactions, customers, subscriptions, events
 * and paywall events, written every 4 to 12 hours, daily or weekly to Amazon S3, Cloudflare R2, Google Cloud Storage or
 * Azure Blob Storage, or emailed as download links to members of the project.
 *   GET    /v2/projects/{project_id}/integrations/exports                               list
 *   GET    /v2/projects/{project_id}/integrations/exports/columns                       every table's columns (the catalog)
 *   POST   /v2/projects/{project_id}/integrations/exports                               create
 *   GET    /v2/projects/{project_id}/integrations/exports/{export_id}
 *   POST   /v2/projects/{project_id}/integrations/exports/{export_id}                   update
 *   DELETE /v2/projects/{project_id}/integrations/exports/{export_id}
 *   POST   /v2/projects/{project_id}/integrations/exports/{export_id}/actions/run       run now (`mode` full or incremental)
 *   POST   /v2/projects/{project_id}/integrations/exports/{export_id}/actions/check     check the bucket and credentials
 *   GET    /v2/projects/{project_id}/integrations/exports/{export_id}/runs              run history, newest first
 * `credentials` (secret_access_key, service_account_json, connection_string) are sealed and come back only as
 * `{ configured, hint }`. `columns` maps a table to the columns to write (catalog order); a table left out gets them all.
 */

const Dest = z.enum(["s3", "r2", "gcs", "azure", "email"]);
const Config = z.object({
  bucket: z.string().trim().min(3).max(222).regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/, "must be a valid bucket name (lower case letters, digits, dots, dashes)").optional(),
  prefix: z.string().trim().max(512).regex(/^[^\\]*$/).refine((p) => !p.split("/").some((seg) => seg === "." || seg === ".."), "must not contain . or .. folders").nullable().optional(),
  region: z.string().trim().regex(/^[a-z0-9-]{2,32}$/).nullable().optional(),
  endpoint: z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL").nullable().optional(),
  account_id: z.string().trim().regex(/^[a-f0-9]{32}$/, "must be the 32-character Cloudflare account ID").nullable().optional(),
  access_key_id: z.string().trim().min(1).max(256).nullable().optional(),
  credential_type: z.enum(["service_account", "hmac"]).nullable().optional(),
  recipients: z.array(z.string().trim().toLowerCase().max(254).refine(isEmailAddress, "must be an email address")).max(MAX_RECIPIENTS, `can have at most ${MAX_RECIPIENTS} addresses`)
    .transform((a) => [...new Set(a)]).nullable().optional(),
  subject_prefix: z.string().trim().max(200).regex(/^[^\u0000-\u001f\u007f]*$/, "must be one line of text").nullable().optional(),
}).strict();
const Credentials = z.object({
  secret_access_key: z.string().max(1024).nullable().optional(), service_account_json: z.string().max(20_000).nullable().optional(),
  connection_string: z.string().max(4096).nullable().optional(),
}).strict();
const Table = z.enum(EXPORT_TABLES);
const Columns = z.record(z.string(), z.array(z.string().max(100)).max(200));
const Fields = {
  name: z.string().trim().min(1).max(255), enabled: z.boolean(), destination: Dest, config: Config, credentials: Credentials,
  format: z.enum(["csv", "parquet"]), compression: z.enum(["gzip", "none"]), schedule: z.enum(["daily", "weekly", "interval"]),
  hour_utc: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6).nullable(),
  interval_hours: z.number().int().refine((n) => (INTERVAL_HOURS as readonly number[]).includes(n), `must be one of ${INTERVAL_HOURS.join(", ")}`).nullable(),
  mode: z.enum(["incremental", "full"]), tables: z.array(Table).min(1).max(EXPORT_TABLES.length), columns: Columns, environment: z.enum(["production", "sandbox"]).nullable(),
};
const Create = z.object({ ...Fields, name: Fields.name.optional(), enabled: Fields.enabled.optional(), credentials: Fields.credentials.optional(),
  format: Fields.format.optional(), compression: Fields.compression.optional(), schedule: Fields.schedule.optional(), hour_utc: Fields.hour_utc.optional(),
  weekday: Fields.weekday.optional(), interval_hours: Fields.interval_hours.optional(), mode: Fields.mode.optional(), tables: Fields.tables.optional(),
  columns: Fields.columns.optional(), environment: Fields.environment.optional() }).strict();
const Update = z.object(Fields).partial().strict();
const Run = z.object({ mode: z.enum(["incremental", "full"]).optional() }).strict();

type Job = typeof schema.exportJobs.$inferSelect;
type RunRow = typeof schema.exportRuns.$inferSelect;

/**
 * Checks a column selection against the catalog and returns it in catalog order, without duplicates. An empty list (or a
 * table left out) means every column, new ones included.
 */
function normalizeColumns(columns: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [table, names] of Object.entries(columns)) {
    if (!(EXPORT_TABLES as readonly string[]).includes(table)) throw paramError(`columns.${table}: there is no table ${table}. Tables: ${EXPORT_TABLES.join(", ")}.`, `columns.${table}`);
    const known = COLUMNS[table as ExportTable].map(([n]) => n);
    const bad = names.filter((n) => !known.includes(n));
    if (bad.length) throw paramError(`columns.${table}: ${bad.map((b) => `"${b}"`).join(", ")} ${bad.length === 1 ? "is not a column" : "are not columns"} of ${table}.`, `columns.${table}`);
    if (names.length) out[table] = known.filter((n) => names.includes(n));
  }
  return out;
}

export function exportShape(j: Job) {
  const field = secretField(j.destination as Destination, j.destinationConfig);
  return {
    object: "data_export" as const, id: j.id, project_id: j.projectId, name: j.name, enabled: j.enabled, destination: j.destination,
    config: { bucket: null, prefix: null, region: null, endpoint: null, account_id: null, access_key_id: null, credential_type: null, recipients: null, subject_prefix: null, ...j.destinationConfig },
    credentials: field ? { [field]: { configured: field in j.secretHints, hint: j.secretHints[field] ?? null } } : {},
    format: j.format, compression: j.compression, schedule: j.schedule, hour_utc: j.hourUtc, weekday: j.weekday, interval_hours: j.intervalHours, mode: j.mode, tables: j.tables, columns: j.columns,
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

async function checkDestination(deps: Deps, projectId: string, dest: Destination, config: Record<string, unknown>, secrets: Record<string, string>, strictUrls: boolean, checkMembers = true) {
  if (dest === "email") {
    const to = (config.recipients as string[] | undefined) ?? [];
    if (!to.length) throw paramError("config.recipients: add at least one recipient.", "config.recipients");
    // On an update that keeps the recipients, a member who left must not block pausing or renaming: the send skips them.
    if (!checkMembers) return;
    const members = await projectMemberEmails(deps.db, projectId);
    const outside = to.filter((e) => !members.has(e.toLowerCase()));
    if (outside.length) throw paramError(`config.recipients: ${outside.join(", ")} ${outside.length === 1 ? "is not a member" : "are not members"} of this project. Invite them first.`, "config.recipients");
    return;
  }
  if (!config.bucket) throw paramError(dest === "azure" ? "config.bucket: set the container name." : "config.bucket: set the bucket name.", "config.bucket");
  const endpointProblem = typeof config.endpoint === "string" ? outboundUrlProblem(config.endpoint, strictUrls) : null;
  if (endpointProblem) throw paramError(`config.endpoint: ${endpointProblem}.`, "config.endpoint");
  if (dest === "azure") {
    if (!/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(String(config.bucket))) throw paramError("config.bucket: an Azure container name has 3 to 63 lower case letters, digits and single dashes.", "config.bucket");
    if (!secrets.connection_string) throw paramError("credentials.connection_string: paste the storage account's connection string.", "credentials.connection_string");
    try {
      const a = parseConnectionString(secrets.connection_string);
      const problem = outboundUrlProblem(a.blobEndpoint, strictUrls);
      if (problem) throw paramError(`credentials.connection_string: the BlobEndpoint ${problem}.`, "credentials.connection_string");
    } catch (e) {
      if (e instanceof AzureConfigError) throw paramError(`credentials.connection_string: ${e.message}`, "credentials.connection_string");
      throw e;
    }
    return;
  }
  if (dest === "gcs" && config.credential_type !== "hmac") {
    let j: Record<string, unknown> | null = null;
    try { j = secrets.service_account_json ? JSON.parse(secrets.service_account_json) : null; } catch { j = null; }
    if (!j || typeof j.client_email !== "string" || typeof j.private_key !== "string") throw paramError("credentials.service_account_json: paste the service account's JSON key (with client_email and private_key).", "credentials.service_account_json");
    return;
  }
  if (dest === "r2" && !config.account_id && !config.endpoint) throw paramError("config.account_id: set your Cloudflare account ID.", "config.account_id");
  if (!config.access_key_id) throw paramError("config.access_key_id: set the access key ID.", "config.access_key_id");
  if (!secrets.secret_access_key) throw paramError("credentials.secret_access_key: set the secret access key.", "credentials.secret_access_key");
}

const DEFAULT_NAME: Record<Destination, string> = { s3: "S3 export", r2: "R2 export", gcs: "GCS export", azure: "Azure export", email: "Email export" };

export function dataExportRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/integrations/exports";
  const find = async (projectId: string, id: string) => {
    const [j] = await db.select().from(schema.exportJobs).where(and(eq(schema.exportJobs.projectId, projectId), eq(schema.exportJobs.id, id))).limit(1);
    if (!j) throw notFound("Data export");
    return j;
  };
  const cleanConfig = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined && v !== ""));

  // The column catalog, before /:export_id so "columns" is not read as an export id.
  r.get(`${P}/columns`, scope("project_configuration:integrations:read"), (c) => c.json(listOf(c,
    EXPORT_TABLES.map((t) => ({ object: "data_export_table", table: t, columns: COLUMNS[t].map(([name, type]) => ({ name, type })) })), null)));

  r.get(P, scope("project_configuration:integrations:read"), async (c) => {
    const rows = await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), exportShape));
  });

  r.post(P, scope("project_configuration:integrations:read_write"), async (c) => {
    const b = await body(c, Create);
    const config = cleanConfig(b.config);
    const merged = await mergeSecrets(null, b.credentials ?? {}, await depsSecretKey(deps));
    await checkDestination(deps, c.get("projectId"), b.destination, config, merged.values, deps.edition === "cloud");
    const columns = normalizeColumns(b.columns ?? {});
    const schedule = b.schedule ?? "daily";
    const hourUtc = b.hour_utc ?? 3;
    const weekday = schedule === "weekly" ? b.weekday ?? 1 : null;
    const intervalHours = schedule === "interval" ? b.interval_hours ?? 6 : null;
    const now = deps.now();
    const [row] = await db.insert(schema.exportJobs).values({
      id: newId("export_", 14), projectId: c.get("projectId"), name: b.name ?? DEFAULT_NAME[b.destination], enabled: b.enabled ?? true,
      destination: b.destination, destinationConfig: config, secrets: merged.sealed, secretHints: merged.hints, format: b.format ?? "csv", compression: b.compression ?? "gzip",
      schedule, hourUtc, weekday, intervalHours, mode: b.mode ?? "incremental", tables: b.tables ?? ["transactions"], columns,
      environment: b.environment === undefined ? "both" : b.environment ?? "both",
      nextRunAt: nextRunAt({ schedule, hourUtc, weekday, intervalHours }, now), createdAt: now, updatedAt: now,
    }).returning();
    return c.json(exportShape(row!), 201);
  });

  r.get(`${P}/:export_id`, scope("project_configuration:integrations:read"), async (c) => c.json(exportShape(await find(c.get("projectId"), c.req.param("export_id")))));

  r.post(`${P}/:export_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    const b = await body(c, Update);
    // A run reads the job's tables, format and destination on every slice; changing them mid-run would mix them.
    const [busy] = await db.select({ id: schema.exportRuns.id }).from(schema.exportRuns)
      .where(and(eq(schema.exportRuns.jobId, j.id), inArray(schema.exportRuns.status, ["queued", "running"]))).limit(1);
    if (busy) throw new V2Error(409, "resource_locked_error", "A run of this export is queued or running. Change it after the run finishes.", undefined, true);
    const destination = b.destination ?? (j.destination as Destination);
    const config: Record<string, unknown> = { ...j.destinationConfig };
    for (const [k, v] of Object.entries(b.config ?? {})) { if (v === null || v === "") delete config[k]; else config[k] = v; }
    // Switching to a destination or credential type with another secret drops the old secret.
    const creds: Record<string, string | null | undefined> = { ...(b.credentials ?? {}) };
    const oldField = secretField(j.destination as Destination, j.destinationConfig), newField = secretField(destination, config);
    if (oldField && oldField !== newField) creds[oldField] = null;
    const merged = await mergeSecrets(j.secrets, creds, await depsSecretKey(deps));
    const recipientsChanged = destination !== j.destination || b.config?.recipients !== undefined;
    await checkDestination(deps, j.projectId, destination, config, merged.values, deps.edition === "cloud", recipientsChanged);
    const schedule = b.schedule ?? j.schedule, hourUtc = b.hour_utc ?? j.hourUtc;
    const weekday = schedule === "weekly" ? (b.weekday !== undefined ? b.weekday ?? 1 : j.weekday ?? 1) : null;
    const intervalHours = schedule === "interval" ? (b.interval_hours !== undefined ? b.interval_hours ?? 6 : j.intervalHours ?? 6) : null;
    const timing = b.schedule !== undefined || b.hour_utc !== undefined || b.weekday !== undefined || b.interval_hours !== undefined || b.enabled === true;
    const [row] = await db.update(schema.exportJobs).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), destination, destinationConfig: config,
      secrets: merged.sealed, secretHints: merged.hints, ...(b.format !== undefined ? { format: b.format } : {}), ...(b.compression !== undefined ? { compression: b.compression } : {}),
      schedule, hourUtc, weekday, intervalHours, ...(b.mode !== undefined ? { mode: b.mode } : {}), ...(b.tables !== undefined ? { tables: b.tables } : {}),
      ...(b.columns !== undefined ? { columns: normalizeColumns(b.columns) } : {}), ...(b.environment !== undefined ? { environment: b.environment ?? "both" } : {}),
      ...(timing ? { nextRunAt: nextRunAt({ schedule, hourUtc, weekday, intervalHours }, deps.now()) } : {}), updatedAt: deps.now(),
    }).where(eq(schema.exportJobs.id, j.id)).returning();
    // Leaving the email destination: the files kept for its links go now (the 7-day cleanup only looks at email exports).
    if (j.destination === "email" && destination !== "email") {
      await (deps.archiveStore ?? dbStore(db)).deletePrefix(emailJobPrefix(j.projectId, j.id));
      await db.update(schema.exportRuns).set({ filesDeletedAt: deps.now() }).where(and(eq(schema.exportRuns.jobId, j.id), isNull(schema.exportRuns.filesDeletedAt)));
    }
    return c.json(exportShape(row!));
  });

  // Runs go with it (FK cascade). Files already written stay in the bucket; files kept for an email export are deleted.
  r.delete(`${P}/:export_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    if (j.destination === "email") await (deps.archiveStore ?? dbStore(db)).deletePrefix(emailJobPrefix(j.projectId, j.id));
    await db.delete(schema.exportJobs).where(eq(schema.exportJobs.id, j.id));
    return c.json({ object: "data_export", id: j.id, deleted_at: deps.now().getTime() });
  });

  r.post(`${P}/:export_id/actions/run`, scope("project_configuration:integrations:read_write"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    const b = await body(c, Run);
    const R = schema.exportRuns;
    const now = deps.now();
    const mode = b.mode ?? j.mode;
    const starts = j.tables.map((t) => j.cursor[t]);
    const windowStart = mode === "full" || starts.some((s) => s === undefined) ? null : new Date(Math.min(...(starts as number[])));
    // The job row lock makes "no open run, then insert" atomic against the scheduler and a second click.
    const run = await db.transaction(async (tx) => {
      await tx.select({ id: schema.exportJobs.id }).from(schema.exportJobs).where(eq(schema.exportJobs.id, j.id)).for("update");
      const [open] = await tx.select({ id: R.id }).from(R).where(and(eq(R.jobId, j.id), inArray(R.status, ["queued", "running"]))).limit(1);
      if (open) return null;
      const [row] = await tx.insert(R).values({ id: newId("exprun_", 14), jobId: j.id, status: "queued", trigger: "manual", mode, windowStart, windowEnd: now, nextAttemptAt: now, createdAt: now }).returning();
      return row!;
    });
    if (!run) throw new V2Error(409, "resource_locked_error", "A run of this export is already queued or running.", undefined, true);
    deps.kick?.();
    return c.json(runShape(run), 201);
  });

  r.post(`${P}/:export_id/actions/check`, scope("project_configuration:integrations:read_write"), async (c) => {
    const j = await find(c.get("projectId"), c.req.param("export_id"));
    const now = deps.now();
    try {
      const secrets = await unseal(j.secrets, await depsSecretKey(deps));
      await checkBucket({ destination: j.destination as Destination, config: j.destinationConfig, secrets, strictUrls: deps.edition === "cloud" }, deps.fetch ?? fetch, now);
      const message = j.destination === "email" ? "Email exports need no bucket: RevenueDot keeps the files and emails the links."
        : `RevenueDot can reach the ${j.destination === "azure" ? "container" : "bucket"} ${j.destinationConfig.bucket}.`;
      return c.json({ object: "storage_check", export_id: j.id, ok: true, message, checked_at: now.getTime() });
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
