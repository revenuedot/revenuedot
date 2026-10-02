// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the move between two RevenueDot servers as a step machine (prd/moves-export/PRD.md §4). The CLI
// (`npx revenuedot move`) runs it in one go; a server runs the same steps for its dashboard's "Move this project", a few at
// a time from its background job. No Node APIs here, so it also runs on Cloudflare Workers.
// Docs: https://revenuedot.app/docs/guides/move-projects

export interface ArchiveFile { name: string; rows: number; bytes: number; sha256: string }
export interface ManifestTable { name: string; columns: string[]; rows: number; checksum: string; files: ArchiveFile[]; secret_files?: ArchiveFile[] }
export interface Manifest {
  format: string; version: number; schema: string; created_at: string; export_id?: string;
  source?: { url?: string | null; edition?: string } | null;
  project: { id: string; name: string | null };
  summary?: { apps?: { id: string; name: string; type: string; public_key: string }[] };
  tables: ManifestTable[];
  secrets: { included: boolean; columns: string[] };
  members?: string | null;
}
export interface ExportInfo { id: string; status: "queued" | "running" | "succeeded" | "failed" | "expired"; error?: string | null; rows?: number; progress?: { table: number } | null }
export interface PlanTable { name: string; archive_rows: number; target_rows: number }
export interface Plan { project: { id: string; name: string | null; exists: boolean; state: string | null }; conflicts: string[]; needs_replace: boolean; tables: PlanTable[]; secrets_included: boolean }
/** `skipped_rows`: rows written on the source while it was exported whose parent row (a new customer) the archive lacks. */
export interface VerifyTable { name: string; source_rows: number; target_rows: number; skipped_rows?: number; source_checksum: string; target_checksum: string; match: boolean }
export interface VerifyResult { done: boolean; tables?: VerifyTable[]; ok?: boolean }
export interface NotificationUrl { app_id: string; app_name: string; store: string; url: string; where: string }
export interface FinishReport {
  project_id: string;
  webhooks_with_new_secrets: { id: string; name: string; url: string }[];
  apps_needing_credentials: { id: string; name: string; type: string }[];
  members_added: { email: string; role: string }[];
  members_to_invite: { email: string; role: string }[];
  notification_urls: NotificationUrl[];
  /** Custom domains to verify again on the new server (a new TXT value, the CNAME pointing there). */
  domains_to_verify?: string[];
}

/** The server the project leaves (or a downloaded archive). */
export interface MoveSource {
  label: string;
  project(): Promise<{ id: string; name: string; move_state: string | null }>;
  startExport(passphrase: string | null): Promise<ExportInfo>;
  /** Moves the export forward (about 10 seconds of work) and returns it. */
  advanceExport(id: string): Promise<ExportInfo>;
  readFile(exportId: string, name: string): Promise<Uint8Array>;
  pause(): Promise<void>;
  forward(toUrl: string): Promise<void>;
  cancel(): Promise<void>;
}

/** The server the project goes to. */
export interface MoveTarget {
  url: string;
  plan(manifest: Manifest): Promise<{ plan: Plan }>;
  begin(manifest: Manifest, passphrase: string | null, replace: boolean): Promise<{ id: string; project_id: string; files_done: Record<string, string> }>;
  putFile(importId: string, name: string, bytes: Uint8Array): Promise<{ applied: boolean }>;
  members(importId: string, members: unknown): Promise<unknown>;
  verify(importId: string): Promise<VerifyResult>;
  finish(importId: string): Promise<FinishReport>;
}

export type Phase = "export" | "plan" | "copy" | "members" | "verify" | "paused" | "finish" | "done";

export interface MoveState {
  version: 1;
  source: string;
  target: string;
  /** "copy": copy and verify (the source keeps serving). "finish": pause, copy again, verify, go live, forward. */
  mode: "copy" | "finish";
  dryRun: boolean;
  phase: Phase;
  projectId?: string;
  exportId?: string;
  importId?: string;
  pausedAt?: number;
  /** Files the target has applied, by name → SHA-256. */
  done: Record<string, string>;
  plan?: Plan;
  verify?: VerifyTable[];
  report?: FinishReport;
  error?: string;
}

export const newMoveState = (source: string, target: string, mode: "copy" | "finish", dryRun = false): MoveState =>
  ({ version: 1, source, target, mode, dryRun, phase: mode === "finish" ? "paused" : "export", done: {} });

export interface MoveContext {
  source: MoveSource;
  target: MoveTarget;
  /** In memory only (never in the state): encrypts the secrets for this copy. */
  passphrase: string | null;
  replace?: boolean;
  /** Seconds to wait after pausing the source, so every server process has seen the pause. */
  drainSeconds?: number;
  now?: () => number;
  log?: (msg: string) => void;
  progress?: (msg: string) => void;
  /** Called after every unit of work, to save the state (CLI state file, the server's project_moves row). */
  save?: (s: MoveState) => Promise<void> | void;
}

export class MoveError extends Error {}

const files = (m: Manifest): ArchiveFile[] => m.tables.flatMap((t) => [...t.files, ...(t.secret_files ?? [])]);

/**
 * Runs steps until the move is done, waits on something (returns "waiting"), or `deadline` (ms timestamp) passes
 * ("more"). The state is updated in place and saved after each step. A failed step throws; the state keeps the phase,
 * so running again resumes there.
 */
export async function runMove(ctx: MoveContext, s: MoveState, deadline = Infinity): Promise<"done" | "more" | "waiting"> {
  const now = ctx.now ?? Date.now;
  const save = async () => { await ctx.save?.(s); };
  const log = ctx.log ?? (() => {});
  let manifest: Manifest | null = null;
  const getManifest = async () => (manifest ??= JSON.parse(new TextDecoder().decode(await ctx.source.readFile(s.exportId!, "manifest.json"))) as Manifest);
  while (s.phase !== "done") {
    if (now() > deadline) return "more";
    switch (s.phase) {
      case "paused": {
        // finish: stop writes on the source, then give every process time to see it before the last copy.
        if (!s.pausedAt) {
          await ctx.source.pause();
          s.pausedAt = now();
          log(`Paused writes on ${ctx.source.label}: purchases and notifications wait (they retry) while the last copy runs.`);
          await save();
        }
        const wait = (ctx.drainSeconds ?? 10) * 1000 - (now() - s.pausedAt);
        if (wait > 0) return "waiting";
        s.phase = "export";
        s.exportId = undefined;
        await save();
        break;
      }
      case "export": {
        if (!s.exportId) {
          const p = await ctx.source.project();
          s.projectId = p.id;
          const e = await ctx.source.startExport(ctx.passphrase);
          s.exportId = e.id;
          log(`Exporting project ${p.name} (${p.id}) from ${ctx.source.label}.`);
          await save();
        }
        const e = await ctx.source.advanceExport(s.exportId);
        if (e.status === "failed" || e.status === "expired") throw new MoveError(`The export failed on ${ctx.source.label}: ${e.error ?? e.status}`);
        if (e.status !== "succeeded") { ctx.progress?.(`Exporting… table ${(e.progress?.table ?? 0) + 1}`); break; }
        s.phase = "plan";
        await save();
        break;
      }
      case "plan": {
        const m = await getManifest();
        const { plan } = await ctx.target.plan(m);
        s.plan = plan;
        if (plan.conflicts.length && !(plan.needs_replace && ctx.replace && plan.conflicts.every((c) => c.includes("already exists")))) {
          throw new MoveError(`The target cannot take this project:\n  - ${plan.conflicts.join("\n  - ")}`);
        }
        if (s.dryRun) { s.phase = "done"; await save(); return "done"; }
        // Before the first file: the target checks the manifest, keeps the passphrase-derived key, and marks the project incoming.
        const imp = await ctx.target.begin(m, m.secrets.included ? ctx.passphrase : null, !!ctx.replace);
        s.importId = imp.id;
        s.done = imp.files_done ?? {};
        s.phase = "copy";
        await save();
        break;
      }
      case "copy": {
        const m = await getManifest();
        const all = files(m);
        const todo = all.filter((f) => s.done[f.name] !== f.sha256);
        if (!todo.length) { s.phase = "members"; await save(); break; }
        const f = todo[0]!;
        const bytes = await ctx.source.readFile(s.exportId!, f.name);
        await ctx.target.putFile(s.importId!, f.name, bytes);
        s.done[f.name] = f.sha256;
        ctx.progress?.(`Copying files ${all.length - todo.length + 1}/${all.length}: ${f.name}`);
        await save();
        break;
      }
      case "members": {
        if ((await getManifest()).members) {
          const raw = await ctx.source.readFile(s.exportId!, "members.json");
          await ctx.target.members(s.importId!, JSON.parse(new TextDecoder().decode(raw)));
        }
        s.phase = "verify";
        await save();
        break;
      }
      case "verify": {
        const v = await ctx.target.verify(s.importId!);
        if (!v.done) { ctx.progress?.("Verifying row counts and checksums on the target…"); break; }
        s.verify = v.tables ?? [];
        const bad = s.verify.filter((t) => !t.match);
        if (bad.length) {
          s.error = `Verification found differences in ${bad.map((t) => t.name).join(", ")}.`;
          await save();
          if (s.mode === "finish") await ctx.source.cancel().catch(() => {});
          throw new MoveError(`${s.error}${s.mode === "finish" ? ` ${ctx.source.label} serves the project again.` : ""}`);
        }
        log(`Verified: ${s.verify.length} tables, ${s.verify.reduce((n, t) => n + t.target_rows, 0)} rows, every count and checksum matches.`);
        const left = s.verify.reduce((n, t) => n + (t.skipped_rows ?? 0), 0);
        if (left) log(`${left} row(s) written on ${ctx.source.label} during the export belong to records created after their table was read (such as a new app user); they were left out${s.mode === "copy" ? " and arrive with --finish" : ", and the app creates them again on the new server"}.`);
        s.phase = s.mode === "finish" ? "finish" : "done";
        await save();
        break;
      }
      case "finish": {
        if (!s.report) {
          s.report = await ctx.target.finish(s.importId!);
          log(`The project is live on ${ctx.target.url}.`);
          await save();
        }
        await ctx.source.forward(ctx.target.url);
        log(`${ctx.source.label} now forwards every SDK call, REST call and store notification for this project to ${ctx.target.url}.`);
        s.phase = "done";
        await save();
        break;
      }
    }
  }
  return "done";
}

/** A dry run's table: rows in the archive against rows on the target now. */
export function formatPlan(p: Plan): string {
  const lines = [
    `Project ${p.project.name ?? ""} (${p.project.id}): ${p.project.exists ? `already on the target (${p.project.state ?? "live"})` : "new on the target"}.`,
    p.secrets_included ? "Secrets (store credentials, webhook signing secrets, integration keys) are included, encrypted." : "Secrets are not included.",
  ];
  if (p.conflicts.length) lines.push("", "Conflicts:", ...p.conflicts.map((c) => `  - ${c}`));
  const changed = p.tables.filter((t) => t.archive_rows !== t.target_rows);
  lines.push("", `${"Table".padEnd(32)} ${"Source".padStart(10)} ${"Target now".padStart(12)} ${"Change".padStart(10)}`);
  for (const t of p.tables.filter((x) => x.archive_rows || x.target_rows)) {
    const d = t.archive_rows - t.target_rows;
    lines.push(`${t.name.padEnd(32)} ${String(t.archive_rows).padStart(10)} ${String(t.target_rows).padStart(12)} ${(d ? (d > 0 ? `+${d}` : String(d)) : "=").padStart(10)}`);
  }
  lines.push("", changed.length ? `${changed.length} table(s) would change. Nothing was written.` : "The target already has the same row counts. Nothing was written.");
  return lines.join("\n");
}

export function formatVerify(v: VerifyTable[]): string {
  const bad = v.filter((t) => !t.match);
  const lines = [`${"Table".padEnd(32)} ${"Source".padStart(10)} ${"Target".padStart(10)}  Checksum`];
  for (const t of v.filter((x) => x.source_rows || x.target_rows || !x.match)) lines.push(`${t.name.padEnd(32)} ${String(t.source_rows).padStart(10)} ${String(t.target_rows).padStart(10)}  ${t.match ? "match" : "DIFFERENT"}${t.skipped_rows ? ` (${t.skipped_rows} left out: created during the export)` : ""}`);
  lines.push("", bad.length ? `${bad.length} table(s) differ.` : `All ${v.length} tables match.`);
  return lines.join("\n");
}

export function formatFinish(r: FinishReport, source: string, target: string): string {
  const out = [`Moved. Project ${r.project_id} now lives on ${target}; ${source} forwards its traffic there.`, ""];
  out.push("Next steps:");
  out.push(`  1. Point your app at the new server when you ship your next update: Purchases.proxyURL = "${target}" (until then the old server forwards).`);
  if (r.notification_urls.length) {
    out.push("  2. Change the store notification URLs (until then the old server forwards each notification):");
    for (const n of r.notification_urls) out.push(`     - ${n.app_name} (${n.store}): ${n.url}\n       ${n.where}`);
  }
  if (r.apps_needing_credentials.length) out.push(`  - Enter the store credentials again for: ${r.apps_needing_credentials.map((a) => a.name).join(", ")}.`);
  if (r.webhooks_with_new_secrets.length) out.push(`  - These webhooks have new signing secrets (copy them from the dashboard): ${r.webhooks_with_new_secrets.map((w) => w.name).join(", ")}.`);
  if (r.members_to_invite.length) out.push(`  - Invite these collaborators on the new server: ${r.members_to_invite.map((m) => `${m.email} (${m.role})`).join(", ")}.`);
  if (r.domains_to_verify?.length) out.push(`  - Verify your custom domain again on the new server (Project settings → Domains shows its TXT value; point the CNAME there): ${r.domains_to_verify.join(", ")}.`);
  return out.join("\n");
}
