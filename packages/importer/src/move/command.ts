// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: `npx revenuedot move` and `npx revenuedot export` (prd/moves-export/PRD.md §4).
// Docs: https://revenuedot.app/docs/guides/move-projects
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { requestBytes, ArchiveSource, HttpSource, HttpTarget, exportArchive } from "./clients.js";
import { formatFinish, formatPlan, formatVerify, newMoveState, runMove, type MoveSource, type MoveState } from "./core.js";
import type { HttpOptions } from "../http.js";
import type { Prompt } from "../prompt.js";

export interface MoveIO {
  out: (s: string) => void; err: (s: string) => void; env: Record<string, string | undefined>;
  prompt?: Prompt; http?: HttpOptions; isTTY?: boolean;
  /** Tests: no real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Tests: the clock `--finish` reads while it waits for the pause to reach every server process. A `sleep` that
   * returns at once needs a clock it moves, or the wait would spin on the real clock for 10 seconds.
   */
  now?: () => number;
  /** Tests: reads an archive file. */
  readFile?: (path: string) => Uint8Array;
}

export interface MoveOptions {
  from?: string; "from-key"?: string; "from-archive"?: string; to?: string; "to-token"?: string;
  "dry-run"?: boolean; finish?: boolean; state?: string; replace?: boolean; json?: boolean; restart?: boolean;
}

const hostOf = (u: string) => { try { return new URL(u).host.replace(/[^\w.-]/g, "_"); } catch { return "server"; } };
const randomPassphrase = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

function loadState(path: string): MoveState | null {
  if (!existsSync(path)) return null;
  const s = JSON.parse(readFileSync(path, "utf8")) as MoveState;
  if (s.version !== 1) throw new Error(`${path} was written by another version; move it away or pass --restart.`);
  return s;
}
function saveState(path: string, s: MoveState) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
  renameSync(tmp, path);
}

async function ask(io: MoveIO, question: string, check: (k: string) => string | null): Promise<string | undefined> {
  if (!io.prompt) return undefined;
  for (let i = 0; i < 3; i++) {
    const k = await io.prompt(question, { hidden: true });
    const problem = !k ? "Nothing entered." : check(k);
    if (!problem) return k;
    io.err(problem);
  }
  return undefined;
}

const SK = (k: string) => (k.startsWith("sk_") ? null : "That is not a RevenueDot secret key (sk_…). Create one in the source project's API keys page.");
const RDI = (k: string) => (/^rdi_[0-9a-f]{64}$/.test(k) ? null : "That is not an import token (rdi_…). Create one on the destination: Receive a project.");

/** `revenuedot move`: returns the exit code. */
export async function moveCommand(v: MoveOptions, io: MoveIO): Promise<number> {
  const to = v.to ?? io.env.REVENUEDOT_TO_URL;
  const from = v.from ?? io.env.REVENUEDOT_FROM_URL;
  const archive = v["from-archive"];
  if (!to || (!from && !archive)) { io.err("Usage: npx revenuedot move --from <old server URL> --to <new server URL> [--dry-run] [--finish]\n       npx revenuedot move --from-archive <export.tar> --to <new server URL>"); return 2; }
  if (archive && v.finish) { io.err("--finish needs --from <server>: an archive file cannot be paused or forward traffic."); return 2; }
  let fromKey = v["from-key"] ?? io.env.REVENUEDOT_FROM_KEY;
  let token = v["to-token"] ?? io.env.REVENUEDOT_TO_TOKEN;
  if (!archive && !fromKey) fromKey = await ask(io, `Secret API key of the project on ${from} (sk_…): `, SK);
  if (!token) token = await ask(io, `Import token from ${to} (Receive a project, rdi_…): `, RDI);
  if ((!archive && !fromKey) || !token) { io.err("Missing keys. In a terminal the CLI asks for them; otherwise set REVENUEDOT_FROM_KEY and REVENUEDOT_TO_TOKEN."); return 2; }
  if (!archive && SK(fromKey!)) { io.err(SK(fromKey!)!); return 2; }
  if (RDI(token)) { io.err(RDI(token)!); return 2; }

  const source: MoveSource = archive
    ? (() => {
      const { untarBytes } = tarReader;
      return new ArchiveSource(untarBytes((io.readFile ?? ((p) => new Uint8Array(readFileSync(p))))(archive)), archive);
    })()
    : new HttpSource(from!, fromKey!, io.http);
  const target = new HttpTarget(to, token, io.http);
  const statePath = v.state ?? `revenuedot-move-${hostOf(archive ? "http://archive" : from!)}-to-${hostOf(to)}.json`;
  let s = v.restart ? null : loadState(statePath);
  if (s && (s.target !== target.url || s.source !== source.label)) { io.err(`${statePath} belongs to another move (${s.source} → ${s.target}). Pass --state <file> or --restart.`); return 2; }
  const mode: "copy" | "finish" = v.finish ? "finish" : "copy";
  if (!s || s.phase === "done" || s.dryRun || v["dry-run"]) s = newMoveState(source.label, target.url, mode, !!v["dry-run"]);
  else if (s.mode !== mode) s = { ...s, ...newMoveState(source.label, target.url, mode), importId: s.importId };
  // The passphrase lives in memory only. A copy whose export has not reached the target yet starts a new export with a new one.
  // A run that stopped at the plan (a wrong token, the target down) starts over at the export, which needs a new one.
  if (s.phase === "export" || s.phase === "plan") s = { ...s, phase: "export", exportId: undefined };
  const passphrase = randomPassphrase();
  const save = (st: MoveState) => saveState(statePath, st);
  let lastProgress = "";
  const progress = (m: string) => { if (io.isTTY) { process.stderr.write(`\r${m.padEnd(lastProgress.length)}`); lastProgress = m; } };
  const log = (m: string) => { if (io.isTTY && lastProgress) { process.stderr.write("\n"); lastProgress = ""; } io.err(m); };
  const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if (mode === "finish") log(`Finishing the move: writes on ${source.label} pause (the SDKs and the stores retry them), the project is copied again and verified, goes live on ${target.url}, and ${source.label} forwards everything there.`);
  try {
    for (;;) {
      const r = await runMove({ source, target, passphrase, replace: v.replace, log, progress, save, now: io.now }, s);
      if (r === "done") break;
      if (r === "waiting") { progress("Waiting 10 seconds for every server process to see the pause…"); await sleep(1000); }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // --finish paused writes on the old server. If the switch fails before the new server went live, the old one must not
    // stay paused (purchases would wait until someone notices): give it back its writes, and pause again on the next run.
    let unpaused = false;
    if (s.mode === "finish" && s.pausedAt && !s.report && s.phase !== "finish" && s.phase !== "done") {
      try {
        await source.cancel();
        s = { ...s, phase: "paused", pausedAt: undefined, exportId: undefined };
        save(s);
        unpaused = true;
      } catch { /* still paused: the message below says to run again */ }
    }
    if (/still has the copy of .* moved away/.test(msg) && !v.replace) io.err(`Failed: ${msg}\nRun again with --replace to replace that old copy.`);
    else if (unpaused) io.err(`Failed: ${msg}\n${source.label} serves the project again (writes are no longer paused). Run the same command to try the switch again.`);
    else io.err(`Failed: ${msg}\nThe state file (${statePath}) keeps the progress: run the same command again to resume.`);
    return 1;
  }
  if (io.isTTY && lastProgress) process.stderr.write("\n");
  if (v.json) { io.out(JSON.stringify({ plan: s.plan, verify: s.verify, report: s.report }, null, 2)); return 0; }
  if (s.dryRun) { io.out(formatPlan(s.plan!)); return 0; }
  if (s.verify) io.out(formatVerify(s.verify));
  if (s.report) io.out(`\n${formatFinish(s.report, source.label, target.url)}`);
  else io.out(`\nCopied and verified. ${source.label} still serves the project. When you are ready to switch, run the same command with --finish.`);
  return 0;
}

/** `revenuedot export`: saves the whole archive as a .tar. */
export async function exportCommand(v: { from?: string; "from-key"?: string; out?: string; "include-secrets"?: boolean; json?: boolean }, io: MoveIO): Promise<number> {
  const from = v.from ?? io.env.REVENUEDOT_FROM_URL ?? io.env.REVENUEDOT_URL;
  if (!from) { io.err("Usage: npx revenuedot export --from <server URL> [--out file.tar] [--include-secrets]"); return 2; }
  let key = v["from-key"] ?? io.env.REVENUEDOT_FROM_KEY ?? io.env.REVENUEDOT_API_KEY;
  if (!key) key = await ask(io, `Secret API key of the project on ${from} (sk_…): `, SK);
  if (!key || SK(key)) { io.err(key ? SK(key)! : "Missing the secret key (REVENUEDOT_FROM_KEY)."); return 2; }
  let passphrase: string | null = null;
  if (v["include-secrets"]) {
    passphrase = (await ask(io, "Export passphrase (12+ characters; you need it to load the secrets): ", (p) => (p.length >= 12 ? null : "Use at least 12 characters."))) ?? io.env.REVENUEDOT_EXPORT_PASSPHRASE ?? null;
    if (!passphrase) { io.err("--include-secrets needs a passphrase (asked in a terminal, or REVENUEDOT_EXPORT_PASSPHRASE)."); return 2; }
    if (io.prompt && (await io.prompt("Type it again: ", { hidden: true })) !== passphrase) { io.err("The two passphrases differ."); return 2; }
  }
  const src = new HttpSource(from, key, io.http);
  try {
    const p = await src.project();
    const e = await exportArchive(src, passphrase, (m) => { if (io.isTTY) process.stderr.write(`\r${m}`); });
    if (io.isTTY) process.stderr.write("\n");
    const out = v.out ?? `revenuedot-${p.id}-${new Date().toISOString().slice(0, 10)}.tar`;
    const bytes = await requestBytes(e.download_url!, {}, io.http);
    writeFileSync(out, bytes);
    if (v.json) io.out(JSON.stringify({ file: out, bytes: bytes.length, export: e }, null, 2));
    else io.out(`Saved ${out} (${(bytes.length / 1024).toFixed(0)} KB): project ${p.name} (${p.id}), ${e.rows ?? 0} rows${passphrase ? ", secrets encrypted with your passphrase" : ", no secrets"}.\nLoad it into another server with: npx revenuedot move --from-archive ${out} --to <server URL>`);
    return 0;
  } catch (e) {
    io.err(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** A tiny tar reader (ustar), enough for the archives RevenueDot writes. */
const tarReader = {
  untarBytes(b: Uint8Array): Map<string, Uint8Array> {
    const dec = new TextDecoder();
    const out = new Map<string, Uint8Array>();
    let off = 0;
    while (off + 512 <= b.length) {
      const h = b.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const str = (o: number, l: number) => dec.decode(h.subarray(o, o + l)).replace(/\0.*$/s, "");
      const prefix = str(345, 155);
      const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
      const size = parseInt(str(124, 12).trim() || "0", 8);
      out.set(name, b.slice(off + 512, off + 512 + size));
      off += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
  },
};
