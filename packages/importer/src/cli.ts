// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the `revenuedot` command line (import, import verify, import plan).
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

const HELP = `revenuedot: move a project from RevenueCat to RevenueDot.

Usage
  npx revenuedot import --from-revenuecat --rc-key sk_... --rc-project proj... --to https://your-server --to-key sk_...
  npx revenuedot import verify --rc-key sk_... --rc-project proj... --to https://your-server --to-key sk_...
  npx revenuedot import plan --to https://your-server --to-key sk_... [--rc-project proj...]
  npx revenuedot admin reset-password <email> [--password <new password>]   (self-host; needs DATABASE_URL)

Options
  --rc-key <key>          RevenueCat secret API key, v2, read-only is enough (or REVENUECAT_API_KEY)
  --rc-project <id>       RevenueCat project id (proj...), shown in the RevenueCat dashboard URL
  --to <url>              Your RevenueDot server, e.g. http://localhost:8787 (or REVENUEDOT_URL)
  --to-key <key>          RevenueDot secret API key for the target project (or REVENUEDOT_API_KEY)
  --to-project <id>       RevenueDot project id (default: the key's project)
  --state <file>          State file for resuming (default: ./revenuedot-import-<rc project>.json)
  --dry-run               Read everything and report what would change; write nothing
  --restart               Ignore the state file and start from the first customer
  --concurrency <n>       Customers fetched in parallel (default 4; RevenueCat allows 480 requests a minute)
  --limit <n>             Import only the first n customers (a trial run)
  --google-tokens <csv>   Google purchase tokens (columns purchase_token and order_id, or app_user_id and product_id)
  --no-public-keys        Keep RevenueDot's own SDK keys instead of RevenueCat's
  --emit-events           Record lifecycle events and send webhooks for imported purchases (default: none)
  --json                  Print the report as JSON
  --password <password>   admin reset-password: the new password (default: a generated one, printed once)
  --database-url <url>    admin: the server's Postgres (or DATABASE_URL), e.g. postgres://revenuedot:...@localhost:5432/revenuedot
  -h, --help              Show this help

Docs: https://revenuedot.app/docs/migrate`;

export interface CliIO { out: (s: string) => void; err: (s: string) => void; env: Record<string, string | undefined>; http?: HttpOptions; targetHttp?: HttpOptions; isTTY?: boolean; /** admin commands: SQL runner (tests); default: postgres at DATABASE_URL. */ query?: Query }

/** Runs the CLI; returns the exit code (0 ok, 1 failed or differences found, 2 usage error). */
export async function main(argv: string[], io: CliIO = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), env: process.env, isTTY: process.stderr.isTTY }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        "from-revenuecat": { type: "boolean" }, "rc-key": { type: "string" }, "rc-project": { type: "string" }, "rc-url": { type: "string" },
        to: { type: "string" }, "to-key": { type: "string" }, "to-project": { type: "string" }, state: { type: "string" },
        "dry-run": { type: "boolean" }, restart: { type: "boolean" }, concurrency: { type: "string" }, limit: { type: "string" },
        "page-size": { type: "string" }, "google-tokens": { type: "string" }, "no-public-keys": { type: "boolean" }, "emit-events": { type: "boolean" },
        json: { type: "boolean" }, help: { type: "boolean", short: "h" }, password: { type: "string" }, "database-url": { type: "string" },
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
  if (cmd !== "import" || (sub && sub !== "verify" && sub !== "plan")) { io.err(`Unknown command: ${positionals.join(" ")}\n\n${HELP}`); return 2; }

  const rcKey = v["rc-key"] ?? io.env.REVENUECAT_API_KEY;
  const rcProject = v["rc-project"] ?? io.env.REVENUECAT_PROJECT_ID;
  const to = v.to ?? io.env.REVENUEDOT_URL;
  const toKey = v["to-key"] ?? io.env.REVENUEDOT_API_KEY;
  const need = (pairs: [string, unknown][]) => pairs.filter(([, x]) => !x).map(([n]) => n);
  const missing = need(sub === "plan" ? [["--to", to], ["--to-key", toKey]] : [["--rc-key", rcKey], ["--rc-project", rcProject], ["--to", to], ["--to-key", toKey]]);
  if (missing.length) { io.err(`Missing ${missing.join(", ")}.\n\n${HELP}`); return 2; }
  if (rcKey && !rcKey.startsWith("sk_") && !rcKey.startsWith("atk_")) { io.err("--rc-key must be a RevenueCat secret key (sk_...) or OAuth token (atk_...), not a public SDK key."); return 2; }
  const int = (name: string, x: string | undefined) => {
    if (x === undefined) return undefined;
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number.`);
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
      concurrency: int("--concurrency", v.concurrency), limit: int("--limit", v.limit), pageSize: int("--page-size", v["page-size"]),
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
    `  Customers             RevenueCat ${r.customers.revenuecat}, RevenueDot ${r.customers.revenuedot}${r.customers.revenuedot > r.customers.revenuecat ? " (RevenueDot also has customers created since the import)" : ""}`,
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
