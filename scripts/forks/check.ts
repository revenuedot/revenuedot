/**
 * Runs each fork's checks (rules/<repo>.json "checks") on a committed ref, in a throwaway git worktree so installs and
 * the npm-alias rewrite (lib/unalias.mjs) never touch the fork checkout.
 *
 *   pnpm tsx scripts/forks/check.ts --all                       # every fork, ref = revenuedot/main-patches
 *   pnpm tsx scripts/forks/check.ts --repo purchases-js --ref upstream-sync --dir /tmp/fork-checks [--only typecheck] [--clean]
 *   (--clean deletes the worktree and its installs afterwards; without it node_modules are reused on the next run)
 *
 * A check whose output starts with "SKIPPED" is reported as skipped (toolchain not available). Exit code 1 on any failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allRepos, loadConfig, loadSpec, pinContext } from "./apply.ts";
import { checkPins, installVersion } from "./lib/pins.ts";
import { checkReadme, git, leakScan } from "./lib/rules.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CheckResult { repo: string; name: string; status: "pass" | "fail" | "skipped"; seconds: number; tail: string }

export function runChecks(repo: string, opts: { workspace: string; ref: string; dir: string; only?: string; clean?: boolean }): CheckResult[] {
  const cfg = loadConfig();
  const spec = loadSpec(repo);
  const root = join(opts.workspace, repo);
  const sha = git(root, ["rev-parse", "--verify", opts.ref]);
  const wt = join(opts.dir, repo);
  mkdirSync(opts.dir, { recursive: true });
  if (existsSync(join(wt, ".git"))) {
    git(wt, ["checkout", "-q", "--detach", "--force", sha]);
    git(wt, ["reset", "-q", "--hard", sha]);
    git(wt, ["clean", "-fdq"]); // keeps ignored files such as node_modules between runs
  } else {
    git(root, ["worktree", "prune"]);
    git(root, ["worktree", "add", "-q", "--detach", "--force", wt, sha]);
  }
  const results: CheckResult[] = [];
  const leaks = leakScan(wt, cfg, spec);
  results.push({ repo, name: "leak scan (RevenueCat hosts and signing key in shipped code)", status: leaks.length ? "fail" : "pass", seconds: 0, tail: leaks.slice(0, 10).join("\n") || "clean" });
  console.log(`  ${(leaks.length ? "fail" : "pass").padEnd(7)} leak scan${leaks.length ? `: ${leaks.length} RevenueCat host(s) or key(s) left` : ""}`);
  const pins = checkPins(pinContext(repo, wt, cfg, opts.workspace));
  const pinTail = pins.problems.map((p) => `${p.repo}${p.where === "working tree" ? "" : `@${p.where}`}: ${p.pin} = ${p.version}: ${p.problem}`);
  results.push({ repo, name: "pins (every pinned fork version has a revenuedot/release-<v> branch or <v>-revenuedot tag)", status: pinTail.length ? "fail" : "pass", seconds: 0, tail: (pinTail.length ? pinTail : pins.ok).join("\n") || "no pins" });
  console.log(`  ${(pinTail.length ? "fail" : "pass").padEnd(7)} pins${pinTail.length ? `: ${pinTail.length} pin(s) without a fork release` : ` (${pins.ok.length} resolved)`}`);
  pinTail.forEach((l) => console.log(`      ${l}`));
  // README: the RevenueDot block sits at the top, matches what the rule renders now, and no RevenueCat sign-up copy precedes the upstream README.
  const readmeVars = { ...cfg.vars, org: cfg.org, repo, ...installVersion(wt, spec.version, cfg.vars.gitTagSuffix!) };
  const readmeProblems = spec.rules.flatMap((r) => (r.type === "readme" ? checkReadme(wt, r, readmeVars) : []));
  results.push({ repo, name: "readme (RevenueDot README block current and above the upstream README)", status: readmeProblems.length ? "fail" : "pass", seconds: 0, tail: readmeProblems.join("\n") || "ok" });
  console.log(`  ${(readmeProblems.length ? "fail" : "pass").padEnd(7)} readme${readmeProblems.length ? `: ${readmeProblems.join("; ")}` : ""}`);
  for (const c of spec.checks ?? []) {
    if (opts.only && !c.name.includes(opts.only)) continue;
    const t0 = Date.now();
    const r = spawnSync("bash", ["-o", "pipefail", "-c", c.run], { cwd: wt, encoding: "utf8", timeout: (c.timeoutSec ?? 300) * 1000, env: { ...process.env, FORKS_DIR: HERE, CI: "1" }, maxBuffer: 256 * 1024 * 1024 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    const tail = out.split("\n").slice(-12).join("\n");
    const status = /^SKIPPED/m.test(out) && r.status === 0 ? "skipped" : r.status === 0 ? "pass" : "fail";
    results.push({ repo, name: c.name, status, seconds: Math.round((Date.now() - t0) / 1000), tail: r.error ? `${r.error.message}\n${tail}` : tail });
    console.log(`  ${status.padEnd(7)} ${c.name} (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (status === "fail") console.log(tail.split("\n").map((l) => `      ${l}`).join("\n"));
  }
  if (opts.clean) { rmSync(wt, { recursive: true, force: true }); git(root, ["worktree", "prune"]); }
  return results;
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const cfg = loadConfig();
  const repos = argv.includes("--all") ? allRepos() : argv.flatMap((a, i) => (argv[i - 1] === "--repo" ? [a] : []));
  if (!repos.length) throw new Error("Pass --repo <name> or --all");
  const workspace = resolve(get("--workspace") ?? resolve(HERE, "../../.."));
  const dir = resolve(get("--dir") ?? join(tmpdir(), "revenuedot-fork-checks"));
  const ref = get("--ref") ?? cfg.patchBranch;
  const all: CheckResult[] = [];
  for (const repo of repos) {
    console.log(`\n== ${repo} @ ${ref}`);
    try { all.push(...runChecks(repo, { workspace, ref, dir, only: get("--only"), clean: argv.includes("--clean") })); }
    catch (e) { all.push({ repo, name: "setup", status: "fail", seconds: 0, tail: (e as Error).message }); console.log(`  fail    setup: ${(e as Error).message}`); }
  }
  const report = join(dir, `report-${repos.length === 1 ? repos[0] : "all"}.json`);
  writeFileSync(report, JSON.stringify(all, null, 2));
  const count = (s: string) => all.filter((r) => r.status === s).length;
  console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skipped")} skipped. Report: ${report}`);
  process.exit(count("fail") ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
