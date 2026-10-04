import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { schema, type DB, type ExportFile } from "@revenuedot/db";
import { toBase64 } from "../signing.js";
import type { ArchiveStore } from "../archive/store.js";
import { trySend, type Mailer } from "../../mail/index.js";
import { dataExportEmail } from "../../mail/templates.js";

/**
 * The email destination of scheduled data exports: no bucket of the customer's. RevenueDot keeps each run's files in its
 * own file store (the archive store: R2 on Cloud, a folder, an S3 bucket or Postgres on self-host) for 7 days and emails
 * every recipient one signed download link per file. Recipients must be members of the project (checked when the export
 * is saved and again when the email goes out), at most 25.
 */

export const EMAIL_FILE_DAYS = 7;
export const MAX_RECIPIENTS = 25;

export const emailJobPrefix = (projectId: string, jobId: string) => `data-exports/${projectId}/${jobId}/`;
export const emailFileKey = (projectId: string, jobId: string, runId: string, key: string) => `${emailJobPrefix(projectId, jobId)}${runId}/${key}`;

let processKey: Uint8Array | undefined;
async function linkKey(material: string | undefined): Promise<CryptoKey> {
  const raw = material ? new TextEncoder().encode(`revenuedot data export download v1|${material}`) : (processKey ??= crypto.getRandomValues(new Uint8Array(32)));
  return crypto.subtle.importKey("raw", (await crypto.subtle.digest("SHA-256", raw as Uint8Array<ArrayBuffer>)) as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
const b64url = (b: Uint8Array) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** `<run id>.<file index>.<expiry, unix seconds>.<HMAC>`: a link to one file of one run. */
export async function fileToken(runId: string, index: number, expiresAtMs: number, material: string | undefined): Promise<string> {
  const msg = `${runId}.${index}.${Math.floor(expiresAtMs / 1000)}`;
  return `${msg}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await linkKey(material), new TextEncoder().encode(msg))))}`;
}

export async function checkFileToken(token: string, now: Date, material: string | undefined): Promise<{ runId: string; index: number } | null> {
  const m = /^(exprun_[a-z0-9]+)\.(\d{1,5})\.(\d{1,12})\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m || Number(m[3]) * 1000 < now.getTime()) return null;
  const want = await fileToken(m[1]!, Number(m[2]), Number(m[3]) * 1000, material);
  // Constant time: the link is the only auth, so the comparison must not tell how much of a forged signature matched.
  let diff = want.length ^ token.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0 ? { runId: m[1]!, index: Number(m[2]) } : null;
}

/** The emails of the project's members among `emails` (lower-cased). */
export async function projectMemberEmails(db: DB, projectId: string): Promise<Set<string>> {
  const rows = await db.select({ email: schema.users.email }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.projectId, projectId));
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

export interface NotifyDeps { db: DB; mailer?: Mailer; publicUrl: string; linkMaterial?: string; now: Date }

/**
 * Emails the download links of a finished run to every recipient who is still a member of the project. Returns how many
 * emails were accepted; with recipients and none accepted, the caller retries the run later.
 */
export async function sendExportEmail(d: NotifyDeps, job: typeof schema.exportJobs.$inferSelect, run: { id: string; files: ExportFile[] }): Promise<{ recipients: number; sent: number }> {
  const [project] = await d.db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, job.projectId));
  const members = await projectMemberEmails(d.db, job.projectId);
  const recipients = [...new Set(((job.destinationConfig.recipients as string[] | undefined) ?? []).map((e) => e.toLowerCase()))].filter((e) => members.has(e));
  if (!recipients.length) return { recipients: 0, sent: 0 };
  const expires = d.now.getTime() + EMAIL_FILE_DAYS * 86_400_000;
  const base = d.publicUrl.replace(/\/+$/, "");
  const files = await Promise.all(run.files.map(async (f, i) => ({
    name: f.key.split("/").pop() ?? f.key, rows: f.rows, bytes: f.bytes, url: `${base}/v2/data-exports/download/${await fileToken(run.id, i, expires, d.linkMaterial)}`,
  })));
  const mail = dataExportEmail({
    base, projectName: project?.name ?? job.projectId, exportName: job.name, subjectPrefix: (job.destinationConfig.subject_prefix as string | undefined) || null,
    finishedAt: d.now, expiresAt: new Date(expires), exportUrl: `${base}/projects/${job.projectId}/integrations/exports/${job.id}`, files,
  });
  let sent = 0;
  for (const to of recipients) if (await trySend(d.mailer, { to, ...mail })) sent++;
  return { recipients: recipients.length, sent };
}

/** Deletes the kept files of email exports whose runs finished more than 7 days ago (bounded per tick). */
export async function pruneEmailExportFiles(db: DB, store: ArchiveStore, now: Date, limit = 20): Promise<number> {
  const R = schema.exportRuns, J = schema.exportJobs;
  const old = await db.select({ id: R.id, jobId: R.jobId, projectId: J.projectId }).from(R).innerJoin(J, eq(J.id, R.jobId))
    .where(and(eq(J.destination, "email"), isNull(R.filesDeletedAt), isNotNull(R.finishedAt), lte(R.finishedAt, new Date(now.getTime() - EMAIL_FILE_DAYS * 86_400_000)))).limit(limit);
  for (const r of old) {
    await store.deletePrefix(`${emailJobPrefix(r.projectId, r.jobId)}${r.id}/`);
    await db.update(R).set({ filesDeletedAt: now }).where(eq(R.id, r.id));
  }
  return old.length;
}
