// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the `revenuedot` command line (import, import verify, import plan, move, export).
// Docs: https://revenuedot.app/docs/migrate
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseTokenCsv } from "./convert.js";
import { HttpError, type HttpOptions } from "./http.js";
import { buildPlan, formatPlan } from "./plan.js";
import { RevenueCatClient } from "./revenuecat.js";
import { RevenueDotClient } from "./revenuedot.js";
import { formatReport, runImport } from "./run.js";
import { verifyImport, type VerifyReport } from "./verify.js";
import { generatePassword, resetPassword, type Query } from "./admin.js";
import { PromptCancelled, terminalPrompt, type Prompt } from "./prompt.js";
import { exportCommand, moveCommand } from "./move/command.js";

const HELP = `revenuedot: move a project from RevenueCat to RevenueDot, between RevenueDot servers, or export it.

Usage
  npx revenuedot move --from http://old-server:8787 --to https://api.revenuedot.app [--dry-run]
  npx revenuedot move --from http://old-server:8787 --to https://api.revenuedot.app --finish
  npx revenuedot move --from-archive revenuedot-proj.tar --to https://api.revenuedot.app
  npx revenuedot export --from https://api.revenuedot.app [--out file.tar] [--include-secrets]
  npx revenuedot import --from-revenuecat --rc-project proj... --to https://your-server
  npx revenuedot import verify --rc-project proj... --to https://your-server
  npx revenuedot import plan --to https://your-server [--rc-project proj...]
  npx revenuedot admin reset-password <email> [--password <new password>]   (self-host; needs DATABASE_URL)

  The CLI asks for the secret keys it needs and hides what you type or paste.

Options
  --rc-project <id>       RevenueCat project id (proj...), shown in the RevenueCat dashboard URL
  --to <url>              Your RevenueDot server, e.g. http://localhost:8787 (or REVENUEDOT_URL)
  --to-project <id>       RevenueDot project id (default: the key's project)
  --state <file>          State file for resuming (default: ./revenuedot-import-<rc project>.json)
  --dry-run               Read everything and report what would change; write nothing
  --restart               Ignore the state file and start from the first customer
  --concurrency <n>       Customers fetched in parallel (default 4; RevenueCat allows 480 requests a minute)
  --limit <n>             Import only the first n customers (a trial run)
  --ids <file>            Import only these RevenueCat customer ids, looked up by id (a JSON array, or one id per
                          line); for customers RevenueCat's list leaves out, such as verify's missing_customer ids
  --page-size <n>         Customers per page and per import call (default 50, at most 100)
  --google-tokens <csv>   Google purchase tokens (columns purchase_token and order_id, or app_user_id and product_id)
  --no-public-keys        Keep RevenueDot's own SDK keys instead of RevenueCat's
  --emit-events           Record lifecycle events and send webhooks for imported purchases (default: none)
  --json                  Print the report as JSON
  --password <password>   admin reset-password: the new password (default: a generated one, printed once)
  --database-url <url>    admin: the server's Postgres (or DATABASE_URL), e.g. postgres://revenuedot:...@localhost:5432/revenuedot
  -h, --help              Show this help

Moves between RevenueDot servers (Cloud and self-host)
  --from <url>            The server the project is on now (or REVENUEDOT_FROM_URL)
  --to <url>              The server it moves to
  --from-archive <file>   An archive from npx revenuedot export instead of --from
  --dry-run               Export and show what would change on the target (rows per table); write nothing
  --finish                Switch: pause writes on --from, copy again, verify, go live on --to, forward --from there
  --replace               Replace a moved-away copy of the project that is still on --to
  --out <file>            export: where to save the .tar
  --include-secrets       export: include store keys and webhook secrets, encrypted with a passphrase you type
  Keys: REVENUEDOT_FROM_KEY (a secret key of the project on --from) and REVENUEDOT_TO_TOKEN (an import token from
  --to: Receive a project). In a terminal the CLI asks for both and hides what you type.

Keys
  In a terminal, the CLI asks for each missing key. Without one (CI, piped input), set:
  REVENUECAT_API_KEY      RevenueCat secret API key, v2, read-only is enough (sk_...)
  REVENUEDOT_API_KEY      RevenueDot secret API key for the target project
  --rc-key and --to-key also work, but a key on the command line stays in your shell history.

Docs: https://revenuedot.app/docs/migrate`;

export interface CliIO {
  out: (s: string) => void; err: (s: string) => void; env: Record<string, string | undefined>; http?: HttpOptions; targetHttp?: HttpOptions; isTTY?: boolean;
  /** admin commands: SQL runner (tests); default: postgres at DATABASE_URL. */ query?: Query;
  /** move: no real waiting, and archive files from memory (tests). */ sleep?: (ms: number) => Promise<void>; readFile?: (path: string) => Uint8Array;
  /** Asks for a missing key. Set only when stdin and stderr are terminals; without it a missing key is a usage error. */ prompt?: Prompt;
}

const defaultIO = (): CliIO => ({
  out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), env: process.env, isTTY: process.stderr.isTTY,
  prompt: process.stdin.isTTY && process.stderr.isTTY ? terminalPrompt() : undefined,
});

const RC_KEY_ERROR = "must be a RevenueCat secret key (sk_...) or OAuth token (atk_...), not a public SDK key.";
const rcKeyOk = (k: string) => k.startsWith("sk_") || k.startsWith("atk_");

/** Asks until a usable key comes back (3 tries). Returns undefined when every try was empty or wrong. Never echoes the key. */
async function askKey(prompt: Prompt, question: string, io: CliIO, check?: (k: string) => string | null): Promise<string | undefined> {
  for (let i = 0; i < 3; i++) {
    const k = await prompt(question, { hidden: true });
    const problem = !k ? "No key entered." : check?.(k) ?? null;
    if (!problem) return k;
    io.err(problem);
  }
  return undefined;
}

/** Runs the CLI; returns the exit code (0 ok, 1 failed or differences found, 2 usage error, 130 cancelled at a prompt). */
export async function main(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        "from-revenuecat": { type: "boolean" }, "rc-key": { type: "string" }, "rc-project": { type: "string" }, "rc-url": { type: "string" },
        to: { type: "string" }, "to-key": { type: "string" }, "to-project": { type: "string" }, state: { type: "string" },
        "dry-run": { type: "boolean" }, restart: { type: "boolean" }, concurrency: { type: "string" }, limit: { type: "string" }, ids: { type: "string" },
        "page-size": { type: "string" }, "google-tokens": { type: "string" }, "no-public-keys": { type: "boolean" }, "emit-events": { type: "boolean" },
        json: { type: "boolean" }, help: { type: "boolean", short: "h" }, password: { type: "string" }, "database-url": { type: "string" },
        from: { type: "string" }, "from-key": { type: "string" }, "from-archive": { type: "string" }, "to-token": { type: "string" },
        finish: { type: "boolean" }, replace: { type: "boolean" }, out: { type: "string" }, "include-secrets": { type: "boolean" },
      },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : e}\n\n${HELP}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  const [cmd, sub] = positionals;
  if (v.help || !cmd) { io.out(HELP); return cmd || v.help ? 0 : 2; }
  if (cmd === "admin") return admin(sub, positionals.slice(2), v, io);
  if (cmd === "move" || cmd === "export") {
    const mio = { out: io.out, err: io.err, env: io.env, prompt: io.prompt, http: io.targetHttp ?? io.http, isTTY: io.isTTY, sleep: io.sleep, readFile: io.readFile };
    try {
      return cmd === "move" ? await moveCommand(v, mio) : await exportCommand(v, mio);
    } catch (e) {
      if (e instanceof PromptCancelled) return 130;
      throw e;
    }
  }
  if (cmd !== "import" || (sub && sub !== "verify" && sub !== "plan")) { io.err(`Unknown command: ${positionals.join(" ")}\n\n${HELP}`); return 2; }

  let rcKey = v["rc-key"] ?? io.env.REVENUECAT_API_KEY;
  const rcProject = v["rc-project"] ?? io.env.REVENUECAT_PROJECT_ID;
  const to = v.to ?? io.env.REVENUEDOT_URL;
  let toKey = v["to-key"] ?? io.env.REVENUEDOT_API_KEY;
  const need = (pairs: [string, unknown][]) => pairs.filter(([, x]) => !x).map(([n]) => n);
  const missing = need(sub === "plan" ? [["--to", to], ["--to-key", toKey]] : [["--rc-key", rcKey], ["--rc-project", rcProject], ["--to", to], ["--to-key", toKey]]);
  const isKey = (n: string) => n === "--rc-key" || n === "--to-key";
  // Keys are asked for on a terminal; everything else (and keys without a terminal) is a usage error, reported before any prompt.
  const blocking = io.prompt ? missing.filter((n) => !isKey(n)) : missing;
  if (blocking.length) {
    const hint = !io.prompt && blocking.some(isKey) ? "\nOr run it in a terminal: the CLI then asks for each missing key and hides what you type." : "";
    io.err(`Missing ${blocking.join(", ")}.${hint}\n\n${HELP}`);
    return 2;
  }
  if (rcKey && !rcKeyOk(rcKey)) { io.err(`--rc-key ${RC_KEY_ERROR}`); return 2; }
  try {
    if (missing.includes("--rc-key")) {
      rcKey = await askKey(io.prompt!, "RevenueCat secret API key (v2, sk_...): ", io, (k) => rcKeyOk(k) ? null : `The key ${RC_KEY_ERROR}`);
      if (!rcKey) return 2;
    }
    if (missing.includes("--to-key")) {
      toKey = await askKey(io.prompt!, "RevenueDot secret API key for the target project: ", io);
      if (!toKey) return 2;
    }
  } catch (e) {
    if (e instanceof PromptCancelled) return 130;
    throw e;
  }
  const int = (name: string, x: string | undefined) => {
    if (x === undefined) return undefined;
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number.`);
    return n;
  };

  const pageSize = (n: number | undefined) => {
    if (n !== undefined && n > 100) throw new Error("--page-size must be 100 or less (the import endpoint takes up to 100 customers per call).");
    return n;
  };

  // Progress goes to stderr (one updating line on a terminal); the report goes to stdout.
  let lastProgress = "";
  const progress = (m: string) => {
    if (io.isTTY) { process.stderr.write(`\r${m.padEnd(lastProgress.length)}`); lastProgress = m; } else io.err(m);
  };
  const log = (m: string) => { if (io.isTTY && lastProgress) { process.stderr.write("\n"); lastProgress = ""; } io.err(m); };
  const done = () => { if (io.isTTY && lastProgress) process.stderr.write("\n"); };

  try {
    if (sub === "plan") {
      const rd = new RevenueDotClient({ url: to!, apiKey: toKey!, projectId: v["to-project"], http: io.targetHttp ?? io.http });
      const steps = await buildPlan(rd, { to: to!, rcProject });
      io.out(v.json ? JSON.stringify(steps, null, 2) : formatPlan(steps));
      return 0;
    }
    if (sub === "verify") {
      const rc = new RevenueCatClient({ apiKey: rcKey!, projectId: rcProject!, baseUrl: v["rc-url"], http: io.http });
      const rd = new RevenueDotClient({ url: to!, apiKey: toKey!, projectId: v["to-project"], http: io.targetHttp ?? io.http });
      await rd.project();
      const report = await verifyImport(rc, rd, { concurrency: int("--concurrency", v.concurrency) ?? 4, limit: int("--limit", v.limit), progress });
      done();
      io.out(v.json ? JSON.stringify(report, null, 2) : formatVerify(report));
      return report.mismatches.length ? 1 : 0;
    }
    const tokens = v["google-tokens"] ? parseTokenCsv(readFileSync(v["google-tokens"], "utf8")) : undefined;
    const report = await runImport({
      rcKey: rcKey!, rcProject: rcProject!, rcBaseUrl: v["rc-url"], to: to!, toKey: toKey!, toProject: v["to-project"],
      statePath: v.state ?? `revenuedot-import-${rcProject!.replace(/[^\w-]/g, "_")}.json`, dryRun: v["dry-run"], restart: v.restart,
      concurrency: int("--concurrency", v.concurrency), limit: int("--limit", v.limit), ids: v.ids ? readIds(readFileSync(v.ids, "utf8")) : undefined, pageSize: pageSize(int("--page-size", v["page-size"])),
      publicKeys: !v["no-public-keys"], emitEvents: v["emit-events"], tokens, http: io.http, targetHttp: io.targetHttp, log, progress,
    });
    done();
    io.out(v.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  } catch (e) {
    done();
    const msg = e instanceof HttpError && (e.status === 401 || e.status === 403)
      ? `${e.message}\nCheck the API key: RevenueCat needs a v2 secret key with read access; RevenueDot needs a secret key of the target project.`
      : e instanceof Error ? e.message : String(e);
    io.err(`Failed: ${msg}${sub ? "" : "\nThe state file keeps the progress: run the same command again to resume."}`);
    return 1;
  }
}

export function formatVerify(r: VerifyReport): string {
  const out = [
    r.mismatches.length ? `Differences found for ${r.mismatchedCustomers} of ${r.customers.checked} customers.` : `No differences: ${r.customers.checked} customers match.`,
    "",
    `  Customers             RevenueCat ${r.customers.revenuecat}, RevenueDot ${r.customers.revenuedot} (unique ids)`,
    `  Missing in RevenueDot ${r.customers.missingInRevenueDot} RevenueCat customers${r.customers.missingInRevenueDot ? " (run the import again: its last step imports them)" : ""}`,
    `  Only in RevenueDot    ${r.customers.onlyInRevenueDot} customers RevenueCat does not know (merged or deleted there since the import, or new from live traffic)`,
    ...(r.customers.notListedByRevenueCat ? [`  Not listed by RevenueCat ${r.customers.notListedByRevenueCat} RevenueCat customers its customer list leaves out, found by id and checked`] : []),
    `  Active subscriptions  RevenueCat ${r.activeSubscriptions.revenuecat}, RevenueDot ${r.activeSubscriptions.revenuedot}`,
    `  Active entitlements   RevenueCat ${r.activeEntitlements.revenuecat}, RevenueDot ${r.activeEntitlements.revenuedot}`,
  ];
  if (r.mismatches.length) {
    out.push("", "Differences");
    for (const m of r.mismatches.slice(0, 200)) out.push(`  - ${m.customer}: ${m.detail}`);
    if (r.mismatches.length > 200) out.push(`  ... and ${r.mismatches.length - 200} more (use --json for all)`);
    out.push("", "Re-run the import to pick up purchases made since it ran, then verify again. Differences that stay point to data the import could not bring over.");
  }
  return out.join("\n");
}

/** `revenuedot admin reset-password <email>`: for self-hosters without email, straight against the database. */
async function admin(sub: string | undefined, args: string[], v: { password?: string; "database-url"?: string }, io: CliIO): Promise<number> {
  if (sub !== "reset-password" || args.length !== 1) { io.err(`Usage: revenuedot admin reset-password <email> [--password <new password>]\n\n${HELP}`); return 2; }
  const url = v["database-url"] ?? io.env.DATABASE_URL;
  if (!io.query && !url) { io.err("Set DATABASE_URL (or --database-url) to the RevenueDot server's Postgres. With Docker, run it inside the server container, which has DATABASE_URL: docker compose exec revenuedot pnpm --filter revenuedot cli admin reset-password <email>"); return 2; }
  const generated = v.password === undefined;
  const password = v.password ?? generatePassword();
  let close = async () => {};
  let q = io.query;
  if (!q) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
    q = (text, params) => sql.unsafe(text, params as never[]) as unknown as Promise<Record<string, unknown>[]>;
    close = () => sql.end();
  }
  try {
    const r = await resetPassword(q, args[0]!, password);
    if (!r.ok) { io.err(r.error); return 1; }
    io.out(`Password changed for ${r.email}; signed out of ${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? "" : "s"}.`);
    if (generated) io.out(`New password (shown once): ${password}`);
    return 0;
  } catch (e) {
    io.err(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await close();
  }
}

/** Customer ids from a file: a JSON array of ids (or of objects with `customer` or `id`, as verify's mismatches), or one id per line. */
export function readIds(text: string): string[] {
  const t = text.trim();
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as unknown[];
    return arr.map((x) => (typeof x === "string" ? x : (x as { customer?: string; id?: string }).customer ?? (x as { id?: string }).id ?? "")).filter(Boolean);
  }
  return t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}
