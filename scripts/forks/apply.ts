/**
 * SDK fork pipeline: applies the RevenueDot patch rules to RevenueCat SDK forks (prd/sdk-forks/PRD.md).
 *
 *   pnpm tsx scripts/forks/apply.ts --all                     # patch every fork in place (working tree only)
 *   pnpm tsx scripts/forks/apply.ts --repo purchases-js --commit [--push]
 *   pnpm tsx scripts/forks/apply.ts --all --scan               # leak scan only, no changes
 *   pnpm tsx scripts/forks/apply.ts --repo purchases-ios --var apiHost=https://iap.example.com --var signingPublicKey=...   # self-host build
 *   pnpm tsx scripts/forks/apply.ts --repo purchases-ios --base 5.91.0 --branch revenuedot/release-5.91.0 --push   # patch an upstream tag
 *
 * --commit checks out the patch branch (from origin's copy if it exists, else from main), applies, and commits.
 * Forks live next to this repo: ~/Developer/revenuedot/<repo> (override with --workspace).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRule, expandIncludes, git, leakScan, render, sha256, type Config, type RepoSpec, type Result, type Rule } from "./lib/rules.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORDER = ["purchases-ios", "purchases-android", "purchases-hybrid-common", "purchases-js", "react-native-purchases", "purchases-flutter", "purchases-capacitor", "purchases-kmp", "purchases-unity", "cordova-plugin-purchases"];

export function loadConfig(overrides: Record<string, string> = {}): Config {
  const cfg = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")) as Config;
  const env: Record<string, string> = {};
  if (process.env.REVENUEDOT_FORK_API_HOST) env.apiHost = process.env.REVENUEDOT_FORK_API_HOST;
  if (process.env.REVENUEDOT_FORK_SIGNING_PUBLIC_KEY) env.signingPublicKey = process.env.REVENUEDOT_FORK_SIGNING_PUBLIC_KEY;
  cfg.vars = { ...cfg.vars, ...env, ...overrides };
  return cfg;
}
export const loadSpec = (repo: string): RepoSpec => JSON.parse(readFileSync(join(HERE, "rules", `${repo}.json`), "utf8"));
export const allRepos = () => ORDER.filter((r) => existsSync(join(HERE, "rules", `${r}.json`))).concat(readdirSync(join(HERE, "rules")).map((f) => f.replace(/\.json$/, "")).filter((r) => !r.startsWith("_") && !ORDER.includes(r)));

export function applyRepo(repo: string, root: string, cfg: Config, workspace: string): { results: Result[]; leaks: string[] } {
  const spec = loadSpec(repo);
  const vars: Record<string, string> = { ...cfg.vars, org: cfg.org, repo };
  const shared = JSON.parse(readFileSync(join(HERE, "rules", "_shared.json"), "utf8")) as Record<string, Rule[]>;
  const results = expandIncludes(spec.rules, shared).map((r) => applyRule(r, { root, vars, workspace, patchBranch: cfg.patchBranch }));
  // Provenance stamp: which rules and settings produced this tree (no timestamps, so re-runs are no-ops).
  const upstreamBase = git(root, ["merge-base", "HEAD", "upstream/main"], { allowFail: true });
  const stamp = {
    note: render("{{disclaimer}}", vars),
    pipeline: "https://github.com/revenuedot/revenuedot/tree/main/scripts/forks",
    rules: `scripts/forks/rules/${repo}.json`,
    rulesSha256: sha256(["rules/" + repo + ".json", "rules/_shared.json", "lib/rules.ts"].map((f) => readFileSync(join(HERE, f), "utf8")).join("\n")),
    upstream: { repo: spec.upstream, mergeBase: upstreamBase || null },
    apiHost: vars.apiHost,
    signingPublicKey: vars.signingPublicKey,
    publishes: spec.publishes,
  };
  const stampPath = join(root, ".revenuedot", "fork.json");
  const stampText = JSON.stringify(stamp, null, 2) + "\n";
  if (!existsSync(stampPath) || readFileSync(stampPath, "utf8") !== stampText) { mkdirSync(dirname(stampPath), { recursive: true }); writeFileSync(stampPath, stampText); results.push({ rule: "stamp .revenuedot/fork.json", changed: [".revenuedot/fork.json"], status: "applied" }); }
  return { results, leaks: leakScan(root, cfg, spec) };
}

function parseArgs(argv: string[]) {
  const a = { repos: [] as string[], all: false, commit: false, push: false, scan: false, workspace: resolve(HERE, "../../.."), vars: {} as Record<string, string>, quiet: false, base: "", branch: "" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--repo") a.repos.push(argv[++i]!);
    else if (k === "--all") a.all = true;
    else if (k === "--commit") a.commit = true;
    else if (k === "--push") { a.push = true; a.commit = true; }
    else if (k === "--scan") a.scan = true;
    else if (k === "--quiet") a.quiet = true;
    else if (k === "--base") a.base = argv[++i]!;
    else if (k === "--branch") a.branch = argv[++i]!;
    else if (k === "--workspace") a.workspace = resolve(argv[++i]!);
    else if (k === "--var") { const [key, ...v] = argv[++i]!.split("="); a.vars[key!] = v.join("="); }
    else throw new Error(`Unknown argument ${k}`);
  }
  if (a.all) a.repos = allRepos();
  if (!a.repos.length) throw new Error("Pass --repo <name> or --all");
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.vars);
  let failed = false;
  for (const repo of args.repos) {
    const root = join(args.workspace, repo);
    const branch = args.branch || cfg.patchBranch;
    console.log(`\n== ${repo} (${root})`);
    try {
      if (!existsSync(join(root, ".git"))) throw new Error("not a git checkout");
      if (args.scan) {
        const leaks = leakScan(root, cfg, loadSpec(repo));
        leaks.forEach((l) => console.log(`  LEAK ${l}`));
        console.log(leaks.length ? `  ${leaks.length} leak(s)` : "  clean");
        if (leaks.length) failed = true;
        continue;
      }
      if (args.commit) {
        if (git(root, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("working tree has uncommitted changes; commit or stash them first");
        // The patch branch continues from its existing tip; a new branch starts from --base (default main).
        const remote = git(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`], { allowFail: true });
        const local = git(root, ["rev-parse", "--verify", "--quiet", branch], { allowFail: true });
        git(root, ["checkout", "-q", "-B", branch, local || remote || args.base || "main"]);
      }
      const { results, leaks } = applyRepo(repo, root, cfg, args.workspace);
      for (const r of results) if (!args.quiet || r.status !== "unchanged") console.log(`  ${r.status.padEnd(16)} ${r.rule}${r.changed.length ? ` [${r.changed.length} file(s)]` : ""}${r.detail ? ` — ${r.detail}` : ""}`);
      leaks.forEach((l) => console.log(`  LEAK ${l}`));
      if (leaks.length) { failed = true; console.log(`  ${leaks.length} leak(s): add a rule or a scanExclude entry`); continue; }
      if (args.commit) {
        git(root, ["add", "-A"]);
        if (git(root, ["diff", "--cached", "--name-only"])) {
          const msg = `RevenueDot fork patches\n\nApplied by https://github.com/revenuedot/revenuedot/tree/main/scripts/forks (rules/${repo}.json).\nDefault API host ${cfg.vars.apiHost}; RevenueDot response-signing key; RevenueDot registry names.\n${cfg.vars.disclaimer}`;
          execGit(root, ["commit", "-q", "-m", msg]);
          console.log(`  committed ${git(root, ["rev-parse", "--short", "HEAD"])} on ${branch}`);
        } else console.log(`  nothing to commit on ${branch}`);
        if (args.push) { execGit(root, ["push", "-q", "-u", "origin", `${branch}:${branch}`]); console.log(`  pushed origin/${branch}`); }
      }
    } catch (e) {
      failed = true;
      console.error(`  ERROR ${(e as Error).message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

function execGit(cwd: string, args: string[]) { git(cwd, args); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
