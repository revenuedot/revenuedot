import { and, asc, eq, gt, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { depsSecretKey, seal, unseal, type SecretKey, type SecretMap } from "./secrets.js";
import { secretText, STORE_SECRET_FIELDS, storeSecretHint } from "./store-secrets.js";
import { notMoving } from "./archive/moving.js";

/**
 * The one-time backfill behind migration 0041 (prd: docs/STATUS.md, "store credentials sealed"), run by the tick until
 * nothing is left, so it needs no step of its own on deploy and is safe to repeat:
 *  1. Store secrets still plain in `apps.credentials` (saved before sealing, or restored from an archive) move into
 *     `apps.secrets`, sealed, with their hints; the plain copies leave `credentials`.
 *  2. With a key: secrets kept as `plain:` (saved while the server had no key) are sealed, and secrets sealed with an
 *     older key (`REVENUEDOT_ENCRYPTION_KEY="new,old"` during a rotation) are sealed again with the current one, in every
 *     sealed column: apps, integrations, export jobs, two-factor secrets and server moves.
 * A server without a key keeps the existing rule: secrets move to `apps.secrets` as `plain:`, never returned by the API.
 * Every write is conditional on the row being unchanged since it was read, so a save in between wins. A row whose sealed
 * value this server cannot open is left as it is. Nothing here logs a value: only counts and row ids.
 */

const A = schema.apps;
const PAGE = 100;

export interface BackfillResult { moved: number; resealed: number; unopenable: string[] }

/** Apps of a store with secret fields that still hold any of them in `credentials` (even an empty one). */
function plainInCredentials(): SQL {
  const byType = new Map<string, string[]>();
  for (const [type, fields] of Object.entries(STORE_SECRET_FIELDS)) byType.set(type, [...fields]);
  return or(...[...byType].map(([type, fields]) =>
    and(eq(A.type, type), sql`${A.credentials} ?| array[${sql.join(fields.map((f) => sql`${f}`), sql`, `)}]::text[]`)))!;
}

/** A sealed value that should be sealed again: `plain:` while a key exists, or `v1` with another key id. */
function staleSealed(col: SQL | typeof A.secrets, key: SecretKey | null): SQL | undefined {
  if (!key) return undefined;
  return sql`(${col} like 'plain:%' or (${col} like 'v1:%' and split_part(${col}, ':', 2) <> ${key.id}))`;
}

/** Whether a stored value is already sealed with the current key (or legitimately plain without one). */
export function isCurrent(stored: string | null, key: SecretKey | null): boolean {
  if (!stored) return true;
  if (!key) return stored.startsWith("plain:") || stored.startsWith("v1:");
  return stored.startsWith(`v1:${key.id}:`);
}

async function backfillApps(db: DB, key: SecretKey | null, max: number, out: BackfillResult) {
  const stale = staleSealed(sql`${A.secrets}`, key);
  let after = "";
  for (;;) {
    const rows = await db.select({ id: A.id, type: A.type, credentials: A.credentials, secrets: A.secrets, secretHints: A.secretHints }).from(A)
      .where(and(gt(A.id, after), notMoving(A.projectId), stale ? or(plainInCredentials(), and(isNotNull(A.secrets), stale)) : plainInCredentials()))
      .orderBy(asc(A.id)).limit(PAGE);
    for (const row of rows) {
      if (out.moved + out.resealed >= max) return;
      const fields = STORE_SECRET_FIELDS[row.type] ?? [];
      const credentials: Record<string, unknown> = { ...(row.credentials ?? {}) };
      const legacy: SecretMap = {};
      let movedAny = false;
      for (const f of fields) {
        if (!(f in credentials)) continue;
        movedAny = true;
        const v = secretText(credentials[f]);
        if (v) legacy[f] = v;
        delete credentials[f];
      }
      let opened: SecretMap;
      try { opened = await unseal(row.secrets, key); } catch {
        // Sealed with a key this server does not have: moving plain values in would drop the sealed ones. Left alone.
        out.unopenable.push(row.id);
        continue;
      }
      // A plain value in credentials was written after the sealed one (a save seals and removes plain copies, so only a
      // later writer, such as an archive import or an older server, can put one back): it wins.
      const merged: SecretMap = { ...opened, ...legacy };
      if (!movedAny && isCurrent(row.secrets, key)) continue;
      const hints: Record<string, string> = { ...(row.secretHints ?? {}) };
      for (const f of fields) delete hints[f];
      for (const [f, v] of Object.entries(merged)) hints[f] = storeSecretHint(f, v);
      const sealed = await seal(merged, key);
      const [done] = await db.update(A).set({ credentials, secrets: sealed, secretHints: hints })
        .where(and(eq(A.id, row.id), sql`${A.credentials} = ${JSON.stringify(row.credentials ?? {})}::jsonb`,
          row.secrets === null ? sql`${A.secrets} is null` : eq(A.secrets, row.secrets)))
        .returning({ id: A.id });
      if (done) { if (movedAny) out.moved++; else out.resealed++; }
    }
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1]!.id;
  }
}

/** Seals `plain:` values and re-seals values of an older key in one text column (any table with a text id). */
async function resealColumn(db: DB, key: SecretKey, table: any, idCol: any, col: any, max: number, out: BackfillResult) {
  let after = "";
  for (;;) {
    const rows: { id: string; v: string | null }[] = await db.select({ id: idCol, v: col }).from(table)
      .where(and(gt(idCol, after), isNotNull(col), staleSealed(sql`${col}`, key)!)).orderBy(asc(idCol)).limit(PAGE);
    for (const r of rows) {
      if (out.moved + out.resealed >= max) return;
      let opened: SecretMap;
      try { opened = await unseal(r.v, key); } catch { out.unopenable.push(r.id); continue; }
      const sealed = await seal(opened, key);
      if (!sealed) continue;
      const [done] = await db.update(table).set({ [colKey(table, col)]: sealed }).where(and(eq(idCol, r.id), eq(col, r.v!))).returning({ id: idCol });
      if (done) out.resealed++;
    }
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1]!.id;
  }
}

/** The property name drizzle uses for a column of a table. */
function colKey(table: Record<string, unknown>, col: unknown): string {
  const k = Object.keys(table).find((name) => table[name] === col);
  if (!k) throw new Error("column not in table");
  return k;
}

/** A sealed text column outside the core schema (an extension's table), for rotation. */
export interface SealedColumn { table: any; id: any; column: any }

const RECHECK_MS = 3600_000;
let finishedAt = 0;

/**
 * Runs the backfill: at most `max` rows written per call. Returns what it did. After a run that finds nothing left it
 * rests for an hour in this process (a new process or Worker isolate checks at once); rows written plain later, by an
 * archive import or a server move, are sealed within the hour.
 */
export async function sealStoredSecrets(deps: { db: DB; encryptionKey?: string; signingKey?: string; now?: () => Date; columns?: SealedColumn[] }, max = 200): Promise<BackfillResult> {
  const out: BackfillResult = { moved: 0, resealed: 0, unopenable: [] };
  const nowMs = deps.now ? deps.now().getTime() : Date.now();
  if (finishedAt && nowMs - finishedAt < RECHECK_MS) return out;
  const key = await depsSecretKey(deps);
  await backfillApps(deps.db, key, max, out);
  if (key) {
    const S = schema;
    await resealColumn(deps.db, key, S.integrations, S.integrations.id, S.integrations.secrets, max, out);
    await resealColumn(deps.db, key, S.exportJobs, S.exportJobs.id, S.exportJobs.secrets, max, out);
    await resealColumn(deps.db, key, S.users, S.users.id, S.users.totpSecret, max, out);
    await resealColumn(deps.db, key, S.projectMoves, S.projectMoves.id, S.projectMoves.secrets, max, out);
    // Keys of archives being exported or imported (dropped when they finish).
    await resealColumn(deps.db, key, S.projectExports, S.projectExports.id, S.projectExports.secretKey, max, out);
    await resealColumn(deps.db, key, S.projectImports, S.projectImports.id, S.projectImports.secretKey, max, out);
    // Extensions' own sealed columns (Enterprise: the OpenID Connect client secret of each SSO connection).
    for (const c of deps.columns ?? []) await resealColumn(deps.db, key, c.table, c.id, c.column, max, out);
  }
  finishedAt = out.moved + out.resealed < max ? nowMs : 0;
  if (out.moved || out.resealed || out.unopenable.length) {
    console.log(`secrets backfill: ${out.moved} apps moved from plain credentials, ${out.resealed} values sealed again${out.unopenable.length ? `, ${out.unopenable.length} left as they are (sealed with a key this server does not have: ${out.unopenable.slice(0, 20).join(", ")})` : ""}`);
  }
  return out;
}

/** Tests only: lets the next call run again. */
export function resetSealBackfill() { finishedAt = 0; }

/** Rows still waiting for the backfill (apps with plain secrets in credentials, values sealed with an older key). */
export async function sealBackfillPending(deps: { db: DB; encryptionKey?: string; signingKey?: string }): Promise<number> {
  const key = await depsSecretKey(deps);
  const stale = staleSealed(sql`${A.secrets}`, key);
  const [r] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(A).where(stale ? or(plainInCredentials(), and(isNotNull(A.secrets), stale)) : plainInCredentials());
  return r?.n ?? 0;
}

