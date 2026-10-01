import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type ArchiveFileEntry, type ArchiveProgress, type ArchiveTableEntry, type DB } from "@revenuedot/db";
import { fromBase64, toBase64 } from "../signing.js";
import { seal, unseal, type SecretKey } from "../secrets.js";
import { ZERO_SUM, addRows, encryptJson, gzip, linesToBytes, newKdf, passphraseKey, sha256Hex, tarStream, type Kdf } from "./format.js";
import { ARCHIVE_FORMAT, ARCHIVE_SCHEMA, ARCHIVE_VERSION, NOT_EXPORTED, ident, rowsOf, scopeWhere, tableInfos, type TableInfo } from "./tables.js";
import type { ArchiveStore } from "./store.js";

/**
 * Full project exports (prd/moves-export/PRD.md §1). A job reads every table of the project in primary-key order and
 * writes gzip JSON Lines files of at most PART_ROWS rows (or PART_BYTES), a secrets file per part when the owner gave a
 * passphrase, then members.json and manifest.json. Work is bounded: each call (`advanceExport`, from the tick or the
 * `advance` endpoint) writes files until its time budget is spent and saves where it stopped, so a Worker never runs
 * out of CPU. Purpose "verify" computes counts and checksums only (the target side of a move).
 */

const E = schema.projectExports;
export type ExportRow = typeof E.$inferSelect;
export const PART_ROWS = 5000;
const PART_BYTES = 8 * 1024 * 1024;
const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 4;
export const ARCHIVE_TTL_MS = 7 * 86_400_000;

export interface ArchiveRuntime {
  db: DB;
  store: ArchiveStore;
  now: Date;
  /** This server's sealing key (services/secrets.ts): opens sealed columns, seals the passphrase key while a job runs. */
  serverKey: SecretKey | null;
  budgetMs?: number;
}

export const exportPrefix = (projectId: string, exportId: string) => `exports/${projectId}/${exportId}/`;
const partName = (n: number) => String(n).padStart(4, "0");

export class ExportInputError extends Error {}

export interface CreateExport {
  projectId: string;
  purpose?: "download" | "move" | "verify";
  passphrase?: string | null;
  requestedBy?: string | null;
  sourceUrl?: string | null;
  edition?: string;
  /** Verify runs: the source manifest, whose columns the checksums use. */
  against?: Record<string, unknown> | null;
}

export async function createExport(rt: ArchiveRuntime, o: CreateExport): Promise<ExportRow> {
  const purpose = o.purpose ?? "download";
  let secretKey: string | null = null, secretSalt: string | null = null;
  if (o.passphrase) {
    if (o.passphrase.length < 12) throw new ExportInputError("The export passphrase needs at least 12 characters.");
    const kdf = newKdf();
    const raw = await passphraseKey(o.passphrase, kdf);
    secretKey = await seal({ k: toBase64(raw) }, rt.serverKey);
    secretSalt = kdf.salt;
  }
  // One export at a time per project and purpose: a second request returns the one already running.
  const [open] = await rt.db.select().from(E).where(and(eq(E.projectId, o.projectId), eq(E.purpose, purpose), inArray(E.status, ["queued", "running"]))).limit(1);
  if (open && purpose !== "verify" && open.includeSecrets === !!o.passphrase) return open;
  const [row] = await rt.db.insert(E).values({
    id: newId("exp_", 16), projectId: o.projectId, purpose, status: "queued", includeSecrets: !!o.passphrase, secretKey, secretSalt,
    storage: rt.store.kind, nextAttemptAt: rt.now, requestedBy: o.requestedBy ?? null, createdAt: rt.now,
    manifest: { source: { url: o.sourceUrl ?? null, edition: o.edition ?? "self-hosted" }, ...(o.against ? { against: o.against } : {}) },
    expiresAt: new Date(rt.now.getTime() + ARCHIVE_TTL_MS),
  }).returning();
  return row!;
}

interface ColumnsFor { (t: TableInfo): string[] }

/** The columns this export writes for a table: the archive's own, or (verify) the ones the source manifest lists. */
function columnsFor(row: ExportRow): ColumnsFor {
  const against = (row.manifest as { against?: { tables?: { name: string; columns: string[] }[] } } | null)?.against;
  const map = new Map((against?.tables ?? []).map((t) => [t.name, t.columns]));
  return (t) => {
    const cols = map.get(t.name);
    return cols ? t.columns.filter((c) => cols.includes(c)) : t.columns;
  };
}

/** One page of a table: each row as its exact JSON text, in primary-key order after `cursor`. */
async function readPage(db: DB, t: TableInfo, cols: string[], projectId: string, cursor: unknown[] | null, limit: number) {
  const list = sql.join(cols.map((c) => sql`t.${ident(c)}`), sql`, `);
  const pk = sql.join(t.pk.map((c) => sql`t.${ident(c)}`), sql`, `);
  const after = cursor ? sql` AND (${pk}) > (${sql.join(cursor.map((v) => sql`${v}`), sql`, `)})` : sql``;
  const keys = sql.join(t.pk.map((c, i) => sql`x.${ident(c)}::text AS ${ident(`k${i}`)}`), sql`, `);
  return db.transaction(async (tx) => {
    // Timestamps in UTC, so both ends of a move write the same text for the same row.
    await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
    const r = await tx.execute(sql`SELECT row_to_json(x)::text AS j, ${keys} FROM (SELECT ${list} FROM ${ident(t.name)} t WHERE ${scopeWhere(t.name, projectId)}${after} ORDER BY ${pk} LIMIT ${limit}) x`);
    return rowsOf<Record<string, string>>(r);
  });
}

export interface SecretEntry { pk: unknown[]; values: Record<string, unknown> }

/** Takes the secret columns out of rows (emptying them in the line) and returns them, unsealed, for the secrets file. */
async function splitSecrets(t: TableInfo, cols: string[], lines: string[], serverKey: SecretKey | null): Promise<{ lines: string[]; secrets: SecretEntry[] }> {
  if (!t.secrets) return { lines, secrets: [] };
  const out: string[] = [];
  const secrets: SecretEntry[] = [];
  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    let any = false;
    for (const [col, spec] of Object.entries(t.secrets)) {
      if (!cols.includes(col)) continue;
      const v = row[col];
      const isEmpty = v === null || v === "" || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
      if (!isEmpty) {
        // Sealed columns travel open (inside the encrypted file) and are sealed again with the target's key.
        values[col] = spec.sealed ? await unseal(v as string, serverKey).catch(() => null) : v;
        any = any || values[col] !== null;
      }
      row[col] = spec.empty;
    }
    if (any) secrets.push({ pk: t.pk.map((c) => row[c]), values });
    out.push(JSON.stringify(row));
  }
  return { lines: out, secrets };
}

/** Claims an export and works on it until the budget is spent. Returns the row as it is now. */
export async function advanceExport(rt: ArchiveRuntime, exportId: string): Promise<ExportRow | null> {
  const started = Date.now();
  const budget = rt.budgetMs ?? 8_000;
  const [cur] = await rt.db.select().from(E).where(eq(E.id, exportId));
  if (!cur || !["queued", "running"].includes(cur.status)) return cur ?? null;
  const died = cur.status === "running";
  const [run] = await rt.db.update(E).set({
    status: "running", nextAttemptAt: new Date(rt.now.getTime() + LEASE_MS), startedAt: cur.startedAt ?? rt.now, error: null,
    ...(died ? { attempts: sql`${E.attempts} + 1` } : {}),
  }).where(and(eq(E.id, exportId), eq(E.status, cur.status), lte(E.nextAttemptAt, rt.now))).returning();
  // Another tick or request holds it.
  if (!run) return cur;
  const fail = async (message: string) => {
    const [r] = await rt.db.update(E).set({ status: "failed", error: message.slice(0, 1000), finishedAt: rt.now, secretKey: null }).where(eq(E.id, exportId)).returning();
    if (run.purpose !== "verify") await rt.store.deletePrefix(exportPrefix(run.projectId, run.id)).catch(() => {});
    return r!;
  };
  if (died && run.attempts >= MAX_ATTEMPTS) return fail("The export stopped before it finished several times. Try again, or contact support.");
  try {
    const infos = [...tableInfos().values()];
    const cols = columnsFor(run);
    const prefix = exportPrefix(run.projectId, run.id);
    const files = run.purpose !== "verify";
    let raw: Uint8Array | null = null;
    if (run.includeSecrets && run.secretKey) raw = fromBase64((await unseal(run.secretKey, rt.serverKey)).k!);
    const tables: ArchiveTableEntry[] = [...run.tables];
    let p: ArchiveProgress = run.progress ?? { table: 0, cursor: null, part: 0, rows: 0, sum: ZERO_SUM };
    let wrote = false;
    while (p.table < infos.length) {
      if (wrote && Date.now() - started >= budget) {
        const [r] = await rt.db.update(E).set({ status: "queued", nextAttemptAt: rt.now, progress: p, tables }).where(eq(E.id, exportId)).returning();
        return r!;
      }
      const t = infos[p.table]!;
      const tcols = cols(t);
      // Read up to one file's worth of rows.
      let lines: string[] = [];
      let bytes = 0;
      let cursor = p.cursor;
      let more = true;
      while (more && lines.length < PART_ROWS && bytes < PART_BYTES) {
        const limit = Math.min(t.page ?? 1000, PART_ROWS - lines.length);
        const page = await readPage(rt.db, t, tcols, run.projectId, cursor, limit);
        for (const r of page) { lines.push(r.j!); bytes += r.j!.length; }
        if (page.length) { const last = page[page.length - 1]!; cursor = t.pk.map((_c, i) => last[`k${i}`]); }
        more = page.length === limit;
      }
      const split = await splitSecrets(t, tcols, lines, rt.serverKey);
      lines = split.lines;
      let entry = tables.find((x) => x.name === t.name);
      if (!entry) { entry = { name: t.name, columns: tcols, rows: 0, checksum: ZERO_SUM, files: [] }; tables.push(entry); }
      if (lines.length || p.part === 0) {
        const part = p.part + 1;
        if (files) {
          const gz = await gzip(linesToBytes(lines));
          const name = `tables/${t.name}/${partName(part)}.jsonl.gz`;
          await rt.store.put(prefix + name, gz);
          const f: ArchiveFileEntry = { name, rows: lines.length, bytes: gz.length, sha256: await sha256Hex(gz) };
          entry.files = [...entry.files.filter((x) => x.name !== name), f];
          if (raw && split.secrets.length) {
            const sname = `secrets/${t.name}/${partName(part)}.json.enc`;
            const box = await encryptJson(raw, { table: t.name, pk: t.pk, rows: split.secrets });
            await rt.store.put(prefix + sname, box);
            const sf: ArchiveFileEntry = { name: sname, rows: split.secrets.length, bytes: box.length, sha256: await sha256Hex(box) };
            entry.secretFiles = [...(entry.secretFiles ?? []).filter((x) => x.name !== sname), sf];
          }
        }
        p = { table: p.table, cursor, part, rows: p.rows + lines.length, sum: await addRows(p.sum, lines) };
      }
      if (!more) {
        entry.rows = p.rows;
        entry.checksum = p.sum;
        p = { table: p.table + 1, cursor: null, part: 0, rows: 0, sum: ZERO_SUM };
      }
      await rt.db.update(E).set({ progress: p, tables }).where(eq(E.id, exportId));
      wrote = true;
    }
    const manifest = await finishManifest(rt, run, tables);
    if (files) {
      const members = await membersOf(rt.db, run.projectId);
      await rt.store.put(`${prefix}members.json`, new TextEncoder().encode(JSON.stringify(members, null, 2)));
      await rt.store.put(`${prefix}manifest.json`, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    }
    const [r] = await rt.db.update(E).set({
      status: "succeeded", progress: null, tables, manifest, secretKey: null, finishedAt: rt.now, nextAttemptAt: rt.now,
      rows: tables.reduce((n, t) => n + t.rows, 0), bytes: tables.reduce((n, t) => n + t.files.reduce((m, f) => m + f.bytes, 0) + (t.secretFiles ?? []).reduce((m, f) => m + f.bytes, 0), 0),
    }).where(eq(E.id, exportId)).returning();
    return r!;
  } catch (e) {
    console.error(`export ${exportId} failed`, e);
    // Database hiccups and storage errors retry from where it stopped (the lease runs out); a few in a row fail it.
    if (run.attempts + 1 >= MAX_ATTEMPTS) return fail(e instanceof Error ? e.message : String(e));
    const [r] = await rt.db.update(E).set({ status: "queued", attempts: sql`${E.attempts} + 1`, nextAttemptAt: new Date(rt.now.getTime() + 30_000), error: e instanceof Error ? e.message.slice(0, 500) : String(e) }).where(eq(E.id, exportId)).returning();
    return r!;
  }
}

async function membersOf(db: DB, projectId: string) {
  const [p] = await db.select({ owner: schema.projects.ownerUserId }).from(schema.projects).where(eq(schema.projects.id, projectId));
  const rows = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.memberships.role })
    .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.projectId, projectId)).orderBy(asc(schema.users.email));
  return rows.map((r) => ({ email: r.email, name: r.name, role: r.role, owner: r.id === p?.owner }));
}

/** The manifest: format, schema, project, every table with its files and checksum, secrets, and what is left out. */
async function finishManifest(rt: ArchiveRuntime, run: ExportRow, tables: ArchiveTableEntry[]) {
  const [project] = await rt.db.select().from(schema.projects).where(eq(schema.projects.id, run.projectId));
  const apps = await rt.db.select({ id: schema.apps.id, name: schema.apps.name, type: schema.apps.type, public_key: schema.apps.publicKey }).from(schema.apps).where(eq(schema.apps.projectId, run.projectId));
  const [domain] = await rt.db.select({ slug: schema.webDomains.slug, custom: schema.webDomains.customDomain }).from(schema.webDomains).where(eq(schema.webDomains.projectId, run.projectId));
  const [verified] = await rt.db.select({ slug: schema.verifiedPages.slug }).from(schema.verifiedPages).where(eq(schema.verifiedPages.projectId, run.projectId));
  const secretColumns = [...tableInfos().values()].flatMap((t) => Object.keys(t.secrets ?? {}).map((c) => `${t.name}.${c}`));
  const kdf: Kdf | null = run.includeSecrets && run.secretSalt ? { name: "PBKDF2", hash: "SHA-256", iterations: 100_000, salt: run.secretSalt } : null;
  const source = (run.manifest as { source?: unknown } | null)?.source ?? null;
  return {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, schema: ARCHIVE_SCHEMA, created_at: rt.now.toISOString(), export_id: run.id, source,
    project: { id: run.projectId, name: project?.name ?? null },
    summary: { apps, web_slug: domain?.slug ?? null, custom_domain: domain?.custom ?? null, verified_slug: verified?.slug ?? null },
    tables: tables.map((t) => ({ name: t.name, columns: t.columns, rows: t.rows, checksum: t.checksum, files: t.files, ...(t.secretFiles?.length ? { secret_files: t.secretFiles } : {}) })),
    secrets: kdf ? { included: true, kdf, columns: secretColumns } : { included: false, columns: secretColumns },
    members: run.purpose === "verify" ? null : "members.json",
    excluded: Object.entries(NOT_EXPORTED).filter(([k]) => !k.startsWith("billing_") && !["project_exports", "archive_blobs", "project_imports", "project_moves"].includes(k)).map(([table, why]) => ({ table, why })),
  };
}

/** Every file of a finished export, manifest last (so a reader that stops early never sees a manifest). */
export function exportFiles(row: ExportRow): { name: string; bytes: number }[] {
  const out: { name: string; bytes: number }[] = [];
  for (const t of row.tables) {
    for (const f of t.files) out.push({ name: f.name, bytes: f.bytes });
    for (const f of t.secretFiles ?? []) out.push({ name: f.name, bytes: f.bytes });
  }
  out.push({ name: "members.json", bytes: 0 }, { name: "manifest.json", bytes: 0 });
  return out;
}

/** The archive as one tar, read from the store one file at a time. */
export function exportTar(store: ArchiveStore, row: ExportRow): ReadableStream<Uint8Array> {
  const prefix = exportPrefix(row.projectId, row.id);
  const files = exportFiles(row).map((f) => ({ name: f.name, size: f.bytes, read: async () => (await store.get(prefix + f.name)) ?? new Uint8Array(0) }));
  // manifest.json first in the tar: readers (tar tf, the CLI) find it at once.
  files.unshift(files.pop()!);
  return tarStream(files, (row.finishedAt ?? row.createdAt).getTime());
}

/** Works on queued exports (the tick), and deletes archives older than 7 days. */
export async function processExports(rt: ArchiveRuntime, limit = 3): Promise<number> {
  const started = Date.now();
  const budget = rt.budgetMs ?? 20_000;
  const due = await rt.db.select({ id: E.id }).from(E).where(and(inArray(E.status, ["queued", "running"]), lte(E.nextAttemptAt, rt.now))).orderBy(asc(E.nextAttemptAt)).limit(limit);
  let worked = 0;
  for (const d of due) {
    const left = budget - (Date.now() - started);
    if (left <= 1000) break;
    await advanceExport({ ...rt, budgetMs: left }, d.id);
    worked++;
  }
  const old = await rt.db.select().from(E).where(and(inArray(E.status, ["succeeded", "failed"]), lte(E.expiresAt, rt.now))).limit(20);
  for (const o of old) {
    await rt.store.deletePrefix(exportPrefix(o.projectId, o.id)).catch((e) => console.error("archive cleanup failed", e));
    await rt.db.update(E).set({ status: "expired" }).where(eq(E.id, o.id));
  }
  return worked;
}

export const latestExports = (db: DB, projectId: string, limit = 20) =>
  db.select().from(E).where(and(eq(E.projectId, projectId), inArray(E.purpose, ["download", "move"]))).orderBy(desc(E.createdAt)).limit(limit);

/* ---- Download links: an HMAC of the export id and the expiry, valid for one hour, no other auth. ---- */

let processKey: Uint8Array | null = null;
async function linkKey(material: string | undefined): Promise<CryptoKey> {
  const raw = material ? new TextEncoder().encode(`revenuedot archive download v1|${material}`) : (processKey ??= crypto.getRandomValues(new Uint8Array(32)));
  return crypto.subtle.importKey("raw", (await crypto.subtle.digest("SHA-256", raw as Uint8Array<ArrayBuffer>)) as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const b64url = (b: Uint8Array) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function downloadToken(exportId: string, expiresAtMs: number, material: string | undefined): Promise<string> {
  const msg = `${exportId}.${Math.floor(expiresAtMs / 1000)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await linkKey(material), new TextEncoder().encode(msg)));
  return `${msg}.${b64url(sig)}`;
}

export async function checkDownloadToken(token: string, now: Date, material: string | undefined): Promise<string | null> {
  const m = /^(exp_[a-z0-9]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  if (Number(m[2]) * 1000 < now.getTime()) return null;
  const want = await downloadToken(m[1]!, Number(m[2]) * 1000, material);
  return want === token ? m[1]! : null;
}
