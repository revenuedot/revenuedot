import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { fromBase64, toBase64 } from "../signing.js";
import { seal, unseal, type SecretKey } from "../secrets.js";
import { PassphraseError, ZERO_SUM, addRows, addSums, bytesToLines, decryptJson, gunzip, passphraseKey, sha256Hex, type Kdf } from "./format.js";
import { ARCHIVE_FORMAT, ARCHIVE_SCHEMA, ident, rowsOf, scopeWhere, tableInfos } from "./tables.js";
import type { SecretEntry } from "./export.js";
import { backfillRejected } from "../../stores/rejected.js";

/**
 * The target side of a move or an archive load (prd/moves-export/PRD.md §2): checks a manifest, then applies each file.
 * Rows go in with `json_populate_recordset`, so every value turns back into its column's type, and upsert by primary
 * key, so a file sent twice (a resumed or repeated copy) changes nothing. Only rows of the imported project are written.
 */

const I = schema.projectImports;
export type ImportRow = typeof I.$inferSelect;
const BATCH = 500;

export interface Manifest {
  format: string; version: number; schema: string; created_at: string; export_id?: string;
  source?: { url?: string | null; edition?: string } | null;
  project: { id: string; name: string | null };
  summary?: { apps?: { id: string; name: string; type: string; public_key: string }[]; web_slug?: string | null; custom_domain?: string | null; verified_slug?: string | null };
  tables: { name: string; columns: string[]; rows: number; checksum: string; files: { name: string; rows: number; bytes: number; sha256: string }[]; secret_files?: { name: string; rows: number; bytes: number; sha256: string }[] }[];
  secrets: { included: boolean; kdf?: Kdf; columns: string[] };
  members?: string | null;
}

export class ImportError extends Error {
  constructor(message: string, public code: "invalid" | "conflict" | "schema" | "passphrase" | "checksum" | "state" = "invalid") { super(message); }
}

const schemaNo = (tag: string) => Number(/^(\d+)_/.exec(tag)?.[1] ?? NaN);

/** Checks that this server can load the archive: format, schema version, tables and columns it knows. */
export function checkManifest(m: Manifest): void {
  if (!m || m.format !== ARCHIVE_FORMAT || m.version !== 1) throw new ImportError("This is not a RevenueDot export (manifest.json format revenuedot-export, version 1).");
  if (!m.project?.id || !Array.isArray(m.tables)) throw new ImportError("The manifest has no project or tables.");
  const theirs = schemaNo(m.schema), ours = schemaNo(ARCHIVE_SCHEMA);
  if (!(theirs <= ours)) throw new ImportError(`The archive was written by a newer RevenueDot (schema ${m.schema}); this server is at ${ARCHIVE_SCHEMA}. Upgrade this server first.`, "schema");
  const infos = tableInfos();
  for (const t of m.tables) {
    const info = infos.get(t.name);
    if (!info) throw new ImportError(`The archive has a table this server does not know: ${t.name}. Upgrade this server first.`, "schema");
    const unknown = t.columns.filter((c) => !info.columns.includes(c));
    if (unknown.length) throw new ImportError(`The archive's ${t.name} has columns this server does not know (${unknown.join(", ")}). Upgrade this server first.`, "schema");
    for (const f of [...t.files, ...(t.secret_files ?? [])]) if (!/^(tables|secrets)\/[a-z_]+\/\d{4}\.(jsonl\.gz|json\.enc)$/.test(f.name)) throw new ImportError(`Bad file name in the manifest: ${f.name}`);
  }
}

export interface Plan {
  project: { id: string; name: string | null; exists: boolean; state: string | null };
  conflicts: string[];
  needs_replace: boolean;
  tables: { name: string; archive_rows: number; target_rows: number }[];
  secrets_included: boolean;
}

/**
 * What loading this archive would do: conflicts with other projects here, and rows per table now against the archive.
 * Row counts and the move state of a project that already exists are shown only to someone who may see it (this import
 * created it, or `userId` is one of its admins): an import token must not reveal another account's project.
 */
export async function planImport(db: DB, m: Manifest, o: { importId?: string; userId?: string } = {}): Promise<Plan> {
  checkManifest(m);
  const pid = m.project.id;
  const [existing] = await db.select().from(schema.projects).where(eq(schema.projects.id, pid));
  const conflicts: string[] = [];
  let mine = false;
  if (existing && o.importId) {
    const [imp] = await db.select().from(I).where(and(eq(I.id, o.importId), eq(I.projectId, pid)));
    mine = !!imp;
  }
  let visible = mine;
  if (existing && !visible && o.userId) {
    const [admin] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.projectId, pid), eq(schema.memberships.userId, o.userId), eq(schema.memberships.role, "admin")));
    visible = !!admin;
  }
  const needsReplace = !!existing && !mine;
  if (existing && !mine && existing.moveState !== "forwarded") conflicts.push(`A project with id ${pid} already exists on this server and is not a moved-away copy. Delete it first, or move into another server.`);
  const keys = (m.summary?.apps ?? []).map((a) => a.public_key).filter(Boolean);
  if (keys.length) {
    const taken = await db.select({ key: schema.apps.publicKey }).from(schema.apps).where(and(inArray(schema.apps.publicKey, keys), ne(schema.apps.projectId, pid)));
    for (const k of taken) conflicts.push(`The SDK key ${k.key.slice(0, 12)}… is used by another project on this server.`);
  }
  if (m.summary?.web_slug) {
    const [s] = await db.select({ p: schema.webDomains.projectId }).from(schema.webDomains).where(and(eq(schema.webDomains.slug, m.summary.web_slug), ne(schema.webDomains.projectId, pid)));
    if (s) conflicts.push(`The web address /${m.summary.web_slug} is taken by another project on this server.`);
  }
  if (m.summary?.verified_slug) {
    const [s] = await db.select({ p: schema.verifiedPages.projectId }).from(schema.verifiedPages).where(and(eq(schema.verifiedPages.slug, m.summary.verified_slug), ne(schema.verifiedPages.projectId, pid)));
    if (s) conflicts.push(`The Verified Metrics address ${m.summary.verified_slug} is taken by another project on this server.`);
  }
  const tables: Plan["tables"] = [];
  for (const t of m.tables) {
    let target = 0;
    if (existing && visible) {
      const r = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM ${ident(t.name)} t WHERE ${scopeWhere(t.name, pid)}`));
      target = Number(r[0]?.n ?? 0);
    }
    tables.push({ name: t.name, archive_rows: t.rows, target_rows: target });
  }
  return { project: { id: pid, name: m.project.name, exists: !!existing, state: visible ? existing?.moveState ?? null : null }, conflicts, needs_replace: needsReplace && existing?.moveState === "forwarded", tables, secrets_included: !!m.secrets?.included };
}

/** Starts (or resumes) loading an archive into this server for `userId`. */
export async function beginImport(db: DB, imp: ImportRow, m: Manifest, o: { passphrase?: string | null; replace?: boolean; serverKey: SecretKey | null; now: Date }): Promise<ImportRow> {
  const plan = await planImport(db, m, { importId: imp.id, userId: imp.userId });
  if (imp.projectId && imp.projectId !== m.project.id) throw new ImportError(`This import token is already loading project ${imp.projectId}. Create a new token for another project.`, "state");
  if (plan.needs_replace && !o.replace) throw new ImportError(`This server still has the copy of ${m.project.id} that moved away from here. Send replace: true (the CLI asks) to replace it with the archive.`, "conflict");
  const blocking = plan.conflicts.filter((c) => !(plan.needs_replace && o.replace && c.includes("already exists")));
  if (blocking.length) throw new ImportError(blocking.join(" "), "conflict");
  if (m.secrets?.included && !o.passphrase) throw new ImportError("The archive has encrypted secrets: send the export passphrase.", "passphrase");
  let secretKey = imp.secretKey;
  if (m.secrets?.included && o.passphrase) {
    const raw = await passphraseKey(o.passphrase, m.secrets.kdf!);
    // Check the passphrase now on the first secrets file's checksum key: decrypting happens per file later.
    secretKey = await seal({ k: toBase64(raw) }, o.serverKey);
  }
  if (plan.needs_replace && o.replace) {
    const [old] = await db.select().from(schema.projects).where(eq(schema.projects.id, m.project.id));
    const [admin] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.projectId, m.project.id), eq(schema.memberships.userId, imp.userId), eq(schema.memberships.role, "admin")));
    if (!admin) throw new ImportError("Only an admin of the moved-away copy on this server can replace it.", "conflict");
    if (old?.moveState === "forwarded") await db.delete(schema.projects).where(eq(schema.projects.id, m.project.id));
  }
  // A new copy replaces the last one: rows deleted on the source since then (merged customers, removed aliases) must not
  // linger here, so the project this import created starts over. A resumed copy of the same export never comes here.
  if (imp.projectId === m.project.id && imp.status === "importing") await db.delete(schema.projects).where(and(eq(schema.projects.id, m.project.id), eq(schema.projects.moveState, "incoming")));
  const filesDone = {};
  const [row] = await db.update(I).set({
    status: "importing", projectId: m.project.id, manifest: m as unknown as Record<string, unknown>, sourceUrl: m.source?.url ?? null, secretKey, filesDone, updatedAt: o.now, verify: null, report: {},
  }).where(eq(I.id, imp.id)).returning();
  return row!;
}

function fileOf(m: Manifest, name: string) {
  for (const t of m.tables) {
    const f = t.files.find((x) => x.name === name);
    if (f) return { table: t, file: f, secret: false };
    const s = t.secret_files?.find((x) => x.name === name);
    if (s) return { table: t, file: s, secret: true };
  }
  return null;
}

/** Applies one archive file. Answers whether it was applied (false: the same file was applied before). */
export async function applyFile(db: DB, imp: ImportRow, name: string, bytes: Uint8Array, o: { userId: string; serverKey: SecretKey | null; now: Date }): Promise<{ applied: boolean; rows: number; skipped?: number }> {
  if (imp.status !== "importing" || !imp.manifest || !imp.projectId) throw new ImportError("Send the manifest first (POST /v2/imports).", "state");
  const m = imp.manifest as unknown as Manifest;
  const hit = fileOf(m, name);
  if (!hit) throw new ImportError(`${name} is not in the manifest.`);
  const digest = await sha256Hex(bytes);
  if (digest !== hit.file.sha256) throw new ImportError(`${name} does not match the manifest's checksum (damaged or from another export).`, "checksum");
  if (imp.filesDone[name] === digest) return { applied: false, rows: 0 };
  // Tables load in manifest order (foreign keys): a file needs every earlier table's files done.
  const order = m.tables.map((t) => t.name);
  const at = order.indexOf(hit.table.name);
  const missing = m.tables.slice(0, at).flatMap((t) => t.files.map((f) => f.name)).filter((n) => !imp.filesDone[n]);
  if (missing.length) throw new ImportError(`Send ${missing[0]} before ${name} (tables load in the manifest's order).`, "state");
  let rows = 0;
  let skipped: string[] = [];
  if (hit.secret) {
    if (!hit.table.files.every((f) => imp.filesDone[f.name])) throw new ImportError(`Send the ${hit.table.name} table files before its secrets.`, "state");
    if (!imp.secretKey) throw new ImportError("The archive has encrypted secrets: send the export passphrase.", "passphrase");
    const raw = fromBase64((await unseal(imp.secretKey, o.serverKey)).k!);
    let box: { table: string; pk: string[]; rows: SecretEntry[] };
    try { box = await decryptJson(raw, bytes); } catch (e) { throw new ImportError(e instanceof PassphraseError ? e.message : String(e), "passphrase"); }
    rows = await applySecrets(db, imp.projectId, hit.table.name, box.rows, o.serverKey);
  } else {
    ({ rows, skipped } = await applyRows(db, imp.projectId, hit.table.name, hit.table.columns, bytesToLines(await gunzip(bytes)), { userId: o.userId, now: o.now, from: m.source?.url ?? null }));
  }
  // Rows left out (their parent is not in the archive) are kept as a count and checksum, so verification still adds up.
  const skip = skipped.length ? { [name]: { table: hit.table.name, rows: skipped.length, sum: await addRows(ZERO_SUM, skipped) } } : null;
  // Recorded atomically per file name, so two parallel uploads never lose each other's mark.
  await db.update(I).set({
    filesDone: sql`${I.filesDone} || ${JSON.stringify({ [name]: digest })}::jsonb`, updatedAt: o.now,
    ...(skip ? { report: sql`jsonb_set(${I.report}, '{skipped_files}', coalesce(${I.report}->'skipped_files', '{}'::jsonb) || ${JSON.stringify(skip)}::jsonb)` } : {}),
  }).where(eq(I.id, imp.id));
  return { applied: true, rows, skipped: skipped.length };
}

/** Rows an import left out, per table: their count and checksum (see applyRows). */
export function skippedByTable(imp: ImportRow): Map<string, { rows: number; sum: string }> {
  const out = new Map<string, { rows: number; sum: string }>();
  const files = (imp.report?.skipped_files ?? {}) as Record<string, { table: string; rows: number; sum: string }>;
  for (const f of Object.values(files)) {
    const cur = out.get(f.table) ?? { rows: 0, sum: ZERO_SUM };
    out.set(f.table, { rows: cur.rows + f.rows, sum: addSums(cur.sum, f.sum) });
  }
  return out;
}

/**
 * Upserts rows of one table, only for this project. A row whose parent row (by foreign key) is not here is left out and
 * returned in `skipped`: the source keeps serving while it is exported table by table, so a customer created after the
 * customers table was read can have an alias or activity in a later table. Loading it would fail the whole file forever.
 */
export async function applyRows(db: DB, projectId: string, table: string, columns: string[], lines: string[], o: { userId: string; now: Date; from: string | null }): Promise<{ rows: number; skipped: string[] }> {
  const t = tableInfos().get(table);
  if (!t) throw new ImportError(`Unknown table ${table}.`);
  if (!lines.length) return { rows: 0, skipped: [] };
  const cols = columns.filter((c) => t.columns.includes(c));
  if (table === "projects") {
    if (lines.length !== 1 || (JSON.parse(lines[0]!) as { id?: string }).id !== projectId) throw new ImportError("The projects file must hold exactly the imported project.");
  }
  const target = sql.join(cols.map((c) => ident(c)), sql`, `);
  const source = sql.join(cols.map((c) => sql`r.${ident(c)}`), sql`, `);
  const pk = sql.join(t.pk.map((c) => ident(c)), sql`, `);
  const updatable = cols.filter((c) => !t.pk.includes(c));
  const inScope = "project" in t.scope
    ? sql`r.${ident(t.scope.project)} = ${projectId}`
    : sql`r.${ident(t.scope.via)} IN (${idsInTarget(t.scope.parent, projectId)})`;
  // A primary key that is already taken updates the row only when that row is this project's: an archive is client input,
  // and a row of another project with the same key (a package, a delivery) must never be overwritten or pulled over.
  const ownRow = "project" in t.scope
    ? sql`${ident(table)}.${ident(t.scope.project)} = ${projectId}`
    : sql`${ident(table)}.${ident(t.scope.via)} IN (${idsInTarget(t.scope.parent, projectId)})`;
  const onConflict = updatable.length
    ? sql`DO UPDATE SET ${sql.join(updatable.map((c) => sql`${ident(c)} = EXCLUDED.${ident(c)}`), sql`, `)} WHERE ${ownRow}`
    : sql`DO NOTHING`;
  // Columns that stay with this server but need a value on a new row (a web domain's verification token).
  const fill = Object.entries(t.fill ?? {});
  const fillCols = fill.length ? sql`, ${sql.join(fill.map(([c]) => ident(c)), sql`, `)}` : sql``;
  const fillVals = fill.length ? sql`, ${sql.join(fill.map(([, v]) => sql.raw(v)), sql`, `)}` : sql``;
  const parentThere = t.fks.map((fk) => {
    const isNull = sql.join(fk.columns.map((c) => sql`r.${ident(c)} IS NULL`), sql` OR `);
    const match = sql.join(fk.columns.map((c, i) => sql`p.${ident(fk.parentColumns[i]!)} = r.${ident(c)}`), sql` AND `);
    return sql`(${isNull} OR EXISTS (SELECT 1 FROM ${ident(fk.parent)} p WHERE ${match}))`;
  });
  let written = 0;
  const skipped: string[] = [];
  for (let i = 0; i < lines.length; i += BATCH) {
    let batch = lines.slice(i, i + BATCH);
    if (parentThere.length) {
      const orphans = rowsOf<{ i: number }>(await db.execute(sql`SELECT (e.ord - 1)::int AS i FROM json_array_elements(${`[${batch.join(",")}]`}::json) WITH ORDINALITY AS e(v, ord), LATERAL json_populate_record(NULL::${ident(table)}, e.v) r WHERE NOT (${sql.join(parentThere, sql` AND `)})`));
      if (orphans.length) {
        const out = new Set(orphans.map((x) => Number(x.i)));
        skipped.push(...batch.filter((_l, k) => out.has(k)));
        batch = batch.filter((_l, k) => !out.has(k));
        if (!batch.length) continue;
      }
    }
    const json = `[${batch.join(",")}]`;
    const res = await db.execute(sql`INSERT INTO ${ident(table)} (${target}${fillCols}) SELECT ${source}${fillVals} FROM json_populate_recordset(NULL::${ident(table)}, ${json}::json) r WHERE ${inScope} ON CONFLICT (${pk}) ${onConflict}`);
    written += Number((res as { rowCount?: number; count?: number }).rowCount ?? (res as { count?: number }).count ?? 0);
  }
  // Experiments from an archive written before migration 0031 (no variants column): upgrade them as the migration did,
  // so they keep enrolling everyone who asks and keep their old enrollment order.
  if (table === "experiments" && !columns.includes("variants")) await upgradeArchivedExperiments(db, projectId);
  // Store notifications from an archive written before migration 0033 (no rejected column): mark the unauthenticated ones.
  if (table === "store_notifications" && !columns.includes("rejected")) await backfillRejected(db, projectId);
  if (table === "projects") {
    // The project's own columns on this server: who owns it here, and that it is being copied in.
    await db.update(schema.projects).set({ ownerUserId: o.userId, moveState: "incoming", movedInAt: o.now, movedInFrom: o.from, moveUpdatedAt: o.now }).where(eq(schema.projects.id, projectId));
    await db.insert(schema.memberships).values({ userId: o.userId, projectId, role: "admin" }).onConflictDoUpdate({ target: [schema.memberships.userId, schema.memberships.projectId], set: { role: "admin" } });
  }
  return { rows: written, skipped };
}

/** Migration 0031's data steps for one project's experiments (prd/experiments/PRD.md §2). */
export async function upgradeArchivedExperiments(db: DB, projectId: string) {
  await db.execute(sql`UPDATE experiments SET variants = jsonb_build_array(
      jsonb_build_object('id', 'a', 'name', 'Control', 'offering_id', offering_a, 'placements', '{}'::jsonb),
      jsonb_build_object('id', 'b', 'name', 'Treatment B', 'offering_id', offering_b, 'placements', '{}'::jsonb)),
    enrollment = 'new_and_existing'
    WHERE project_id = ${projectId} AND variants = '[]'::jsonb AND offering_a IS NOT NULL AND offering_b IS NOT NULL`);
  await db.execute(sql`UPDATE experiments AS e SET priority = o.n FROM (
    SELECT id, row_number() OVER (ORDER BY started_at NULLS LAST, created_at, id) AS n FROM experiments WHERE project_id = ${projectId}) AS o
    WHERE o.id = e.id AND e.project_id = ${projectId}`);
}

function idsInTarget(parent: string, projectId: string): ReturnType<typeof sql> {
  const t = tableInfos().get(parent)!;
  const key = t.pk.length === 1 ? t.pk[0]! : "id";
  if ("project" in t.scope) return sql`SELECT ${ident(key)} FROM ${ident(parent)} WHERE ${ident(t.scope.project)} = ${projectId}`;
  return sql`SELECT ${ident(key)} FROM ${ident(parent)} WHERE ${ident(t.scope.via)} IN (${idsInTarget(t.scope.parent, projectId)})`;
}

/** Puts secret columns back: open values sealed with this server's key, the rest as they were. */
async function applySecrets(db: DB, projectId: string, table: string, entries: SecretEntry[], serverKey: SecretKey | null): Promise<number> {
  const t = tableInfos().get(table)!;
  let n = 0;
  for (const e of entries) {
    const row: Record<string, unknown> = {};
    for (const [col, v] of Object.entries(e.values)) {
      const spec = t.secrets?.[col];
      if (!spec) continue;
      row[col] = spec.sealed ? (v && typeof v === "object" ? await seal(v as Record<string, string>, serverKey) : null) : v;
    }
    const cols = Object.keys(row);
    if (!cols.length) continue;
    t.pk.forEach((c, i) => { row[c] = e.pk[i]; });
    const set = sql.join(cols.map((c) => sql`${ident(c)} = r.${ident(c)}`), sql`, `);
    const match = sql.join(t.pk.map((c) => sql`t.${ident(c)} = r.${ident(c)}`), sql` AND `);
    await db.execute(sql`UPDATE ${ident(table)} t SET ${set} FROM json_populate_record(NULL::${ident(table)}, ${JSON.stringify(row)}::json) r WHERE ${match} AND ${scopeWhere(table, projectId)}`);
    n++;
  }
  return n;
}

const newSecret = () => `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

export interface FinishReport {
  project_id: string;
  webhooks_with_new_secrets: { id: string; name: string; url: string }[];
  apps_needing_credentials: { id: string; name: string; type: string }[];
  members_added: { email: string; role: string }[];
  members_to_invite: { email: string; role: string }[];
  notification_urls: { app_id: string; app_name: string; store: string; url: string; where: string }[];
  /** Custom domains for hosted pages: verified per server, so they need Verify here (with this server's TXT value). */
  domains_to_verify: string[];
}

const STORE_OF: Record<string, { path: string; where: string }> = {
  app_store: { path: "apple", where: "App Store Connect → your app → App Information → App Store Server Notifications: set the Production and Sandbox URLs." },
  mac_app_store: { path: "apple", where: "App Store Connect → your app → App Information → App Store Server Notifications: set the Production and Sandbox URLs." },
  play_store: { path: "google", where: "Google Cloud Console → Pub/Sub → Subscriptions → the push subscription of your Real-time developer notifications topic: set the endpoint URL." },
  amazon: { path: "amazon", where: "Amazon Developer Console → your app → Real-time Notifications: subscribe this URL (SNS confirms it automatically)." },
  stripe: { path: "stripe", where: "Stripe Dashboard → Developers → Webhooks → your endpoint: set the URL (the signing secret stays the same)." },
  paddle: { path: "paddle", where: "Paddle → Developer tools → Notifications → your destination: set the URL, or click Apply in Paddle on the app's page (the secret key stays the same)." },
  roku: { path: "roku", where: "Roku developer dashboard → Roku Pay web services: set the push notification URL." },
  galaxy: { path: "galaxy", where: "Samsung Seller Portal → your app → In App Purchase: set the Instant Server Notification URL." },
};

export function notificationUrls(apps: { id: string; name: string; type: string }[], base: string) {
  const b = base.replace(/\/+$/, "");
  return apps.filter((a) => STORE_OF[a.type]).map((a) => ({ app_id: a.id, app_name: a.name, store: a.type, url: `${b}/v1/notifications/${STORE_OF[a.type]!.path}/${a.id}`, where: STORE_OF[a.type]!.where }));
}

/**
 * Members from members.json, listed to invite on this server. Nobody is added directly: members.json comes from whoever
 * holds the import token, so adding the accounts it names would put people into a project without their consent and tell
 * the token holder which emails have an account here. The person who imports owns the project and invites the rest.
 */
export async function applyMembers(db: DB, imp: ImportRow, members: { email: string; role: string }[]) {
  if (!imp.projectId || imp.status !== "importing") throw new ImportError(imp.status === "finished" ? "This import is already finished." : "Send the manifest first.", "state");
  const [me] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, imp.userId));
  const added: { email: string; role: string }[] = [], invite: { email: string; role: string }[] = [];
  for (const m of members.slice(0, 500)) {
    if (typeof m?.email !== "string" || !m.email.includes("@")) continue;
    const email = m.email.toLowerCase().trim();
    if (email === me?.email.toLowerCase()) continue;
    invite.push({ email, role: ["admin", "developer", "viewer"].includes(m.role) ? m.role : "viewer" });
  }
  await db.update(I).set({ report: { ...imp.report, members_added: added, members_to_invite: invite } }).where(eq(I.id, imp.id));
  return { added, invite };
}

/** Puts the project live on this server: new signing secrets where none came over, then the report. */
export async function finishImport(db: DB, imp: ImportRow, o: { now: Date; baseUrl: string }): Promise<FinishReport> {
  if (imp.status !== "importing" || !imp.projectId || !imp.manifest) throw new ImportError(imp.status === "finished" ? "This import is already finished." : "Nothing was imported yet.", "state");
  const m = imp.manifest as unknown as Manifest;
  const notDone = m.tables.flatMap((t) => [...t.files, ...(t.secret_files ?? [])]).filter((f) => !imp.filesDone[f.name]).map((f) => f.name);
  if (notDone.length) throw new ImportError(`${notDone.length} file(s) are not loaded yet, first: ${notDone[0]}.`, "state");
  const pid = imp.projectId;
  const hooks = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.projectId, pid), eq(schema.webhooks.signingSecret, "")));
  for (const h of hooks) await db.update(schema.webhooks).set({ signingSecret: newSecret() }).where(eq(schema.webhooks.id, h.id));
  const apps = await db.select().from(schema.apps).where(eq(schema.apps.projectId, pid));
  const storeApps = apps.filter((a) => ["app_store", "mac_app_store", "play_store", "amazon", "stripe", "paddle", "roku", "galaxy"].includes(a.type));
  const needCreds = storeApps.filter((a) => Object.keys(a.credentials ?? {}).length === 0 && !a.secrets);
  const domains = [
    ...await db.select({ d: schema.webDomains.customDomain }).from(schema.webDomains).where(eq(schema.webDomains.projectId, pid)),
    ...await db.select({ d: schema.verifiedPages.customDomain }).from(schema.verifiedPages).where(eq(schema.verifiedPages.projectId, pid)),
  ];
  await db.update(schema.projects).set({ moveState: null, moveUpdatedAt: o.now }).where(eq(schema.projects.id, pid));
  const report: FinishReport = {
    project_id: pid,
    webhooks_with_new_secrets: hooks.map((h) => ({ id: h.id, name: h.name, url: h.url })),
    apps_needing_credentials: needCreds.map((a) => ({ id: a.id, name: a.name, type: a.type })),
    members_added: (imp.report.members_added as FinishReport["members_added"]) ?? [],
    members_to_invite: (imp.report.members_to_invite as FinishReport["members_to_invite"]) ?? [],
    notification_urls: notificationUrls(apps, o.baseUrl),
    domains_to_verify: domains.map((x) => x.d).filter((d): d is string => !!d),
  };
  await db.update(I).set({ status: "finished", secretKey: null, finishedAt: o.now, updatedAt: o.now, report: report as unknown as Record<string, unknown> }).where(eq(I.id, imp.id));
  return report;
}

/** An import token: `rdi_` + 32 random bytes in hex. Only its SHA-256 is stored. */
export async function createImportToken(db: DB, userId: string, now: Date): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = `rdi_${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const id = newId("imp_", 16);
  const expiresAt = new Date(now.getTime() + 24 * 3_600_000);
  await db.insert(I).values({ id, userId, tokenHash: await sha256Hex(token), status: "open", expiresAt, createdAt: now, updatedAt: now });
  return { token, id, expiresAt };
}

export async function importForToken(db: DB, token: string, now: Date): Promise<ImportRow | null> {
  if (!/^rdi_[0-9a-f]{64}$/.test(token)) return null;
  const [row] = await db.select().from(I).where(eq(I.tokenHash, await sha256Hex(token)));
  if (!row || row.status === "cancelled") return null;
  // An unfinished import keeps working past the token's day (a big copy, a resumed move); a fresh token expires.
  if (row.status === "open" && row.expiresAt <= now) return null;
  return row;
}
