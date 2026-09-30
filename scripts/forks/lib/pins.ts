/**
 * Version pins between forks (prd/sdk-forks/PRD.md section 3, "Pins between forks").
 *
 * A pin is a version number in one fork that names a release of another fork (or of itself): hybrid-common's podspec
 * pins RevenueDotPurchases 5.91.0, React Native pins purchases-hybrid-common 19.4.1, and so on. Each pin is declared
 * once in rules/<repo>.json "pins" and is used twice:
 *   - apply: a pin with follow "fork" is rewritten to the version the dependency fork carries on its patch branch, read
 *     at apply time, so it cannot drift from the fork. A pin with follow "upstream" keeps upstream's number (native SDKs,
 *     whose patch branch is an unreleased -SNAPSHOT; the dependent's code was built against that exact release).
 *   - check: every pinned version must exist in the dependency fork as branch revenuedot/release-<v> or tag
 *     <v>-revenuedot, and the pins of that release branch are checked in turn. A pin on the same repo must equal its
 *     own version.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, listFiles, matchesAny, render, type Vars } from "./rules.ts";

export interface Pin {
  /** The fork that provides the pinned version. */
  dep: string;
  files: string[];
  /** Regex; capture group 1 is the version. {{vars}} are substituted regex-escaped. */
  find: string;
  flags?: string;
  follow: "fork" | "upstream";
  note?: string;
}
/** Where a fork declares its own version: `file`, and a regex whose group 1 is the version (default: the whole first line). */
export interface VersionSource { file: string; regex?: string }

export interface PinSpec { repo: string; version?: VersionSource; pins?: Pin[] }

/** Reads files either from a working tree or from a committed ref of a repo. */
interface Tree { label: string; list(): string[]; read(path: string): string | null }
export function workTree(root: string): Tree {
  return { label: "working tree", list: () => listFiles(root), read: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null) };
}
export function refTree(root: string, ref: string): Tree {
  let files: string[] | null = null;
  return {
    label: ref,
    list: () => (files ??= git(root, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean)),
    read: (p) => { const s = git(root, ["show", `${ref}:${p}`], { allowFail: true }); return s || null; },
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pinRegex = (pin: Pin, vars: Vars) => new RegExp(pin.find.replace(/\{\{(\w+)\}\}/g, (_, k) => escapeRe(render(`{{${k}}}`, vars))), (pin.flags ?? "").replace("g", "") + "gd");
const isRelease = (v: string) => /^\d+\.\d+\.\d+$/.test(v);
const major = (v: string) => v.split(".")[0];

export function readVersion(tree: Tree, src: VersionSource | undefined): string | null {
  if (!src) return null;
  const s = tree.read(src.file);
  if (s == null) return null;
  const m = src.regex ? new RegExp(src.regex, "m").exec(s) : /^\s*(\S+)/.exec(s);
  return m?.[1] ?? null;
}

/** The ref a dependency fork publishes from: the local patch branch, else origin's copy. */
function patchRef(depRoot: string, patchBranch: string): string | null {
  for (const r of [patchBranch, `origin/${patchBranch}`]) if (git(depRoot, ["rev-parse", "--verify", "--quiet", r], { allowFail: true })) return r;
  return null;
}

export interface PinContext { root: string; repo: string; vars: Vars; workspace: string; patchBranch: string; loadSpec: (repo: string) => PinSpec }

/** The version the dependency fork carries now: the same checkout for a pin on itself, else the dep's patch branch. */
export function forkVersion(ctx: PinContext, dep: string): { version: string | null; from: string } {
  const spec = ctx.loadSpec(dep);
  if (dep === ctx.repo) return { version: readVersion(workTree(ctx.root), spec.version), from: "this checkout" };
  const depRoot = join(ctx.workspace, dep);
  const ref = existsSync(join(depRoot, ".git")) ? patchRef(depRoot, ctx.patchBranch) : null;
  if (!ref) return { version: null, from: `${dep} (no ${ctx.patchBranch} checkout in ${ctx.workspace})` };
  return { version: readVersion(refTree(depRoot, ref), spec.version), from: `${dep} ${ref}` };
}

export interface PinChange { pin: string; changed: string[]; detail: string }

/** Rewrites every follow:"fork" pin to the dependency fork's current version. Idempotent. */
export function applyPins(ctx: PinContext): PinChange[] {
  const spec = ctx.loadSpec(ctx.repo);
  const out: PinChange[] = [];
  const all = listFiles(ctx.root);
  for (const pin of spec.pins ?? []) {
    const name = `pin ${pin.dep} in ${pin.files.join(",")}`;
    const files = all.filter((f) => matchesAny(f, pin.files));
    if (!files.length) throw new Error(`Pin did not match: ${name}: no files match. Upstream probably moved it; update the pin in rules/${ctx.repo}.json.`);
    const re = pinRegex(pin, ctx.vars);
    let found = 0;
    const texts = files.map((f) => { const s = readFileSync(join(ctx.root, f), "utf8"); found += [...s.matchAll(re)].length; return [f, s] as const; });
    if (!found) throw new Error(`Pin did not match: ${name}: ${pin.find} not found. Upstream probably moved it; update the pin in rules/${ctx.repo}.json.`);
    if (pin.follow !== "fork") { out.push({ pin: name, changed: [], detail: "keeps upstream's version" }); continue; }
    const { version, from } = forkVersion(ctx, pin.dep);
    if (!version) throw new Error(`Pin ${name}: cannot read the version of ${from}`);
    const changed: string[] = []; const kept: string[] = [];
    for (const [f, s] of texts) {
      let next = ""; let last = 0;
      for (const m of s.matchAll(re)) {
        const [a, b] = m.indices![1]!; const cur = m[1]!;
        let v = cur;
        if (!isRelease(version)) kept.push(`${cur} (${from} is ${version}, not a release)`);
        else if (major(version) !== major(cur)) kept.push(`${cur} (${from} is ${version}, a different major version; move the pin by hand)`);
        else v = version;
        next += s.slice(last, a) + v; last = b;
      }
      next += s.slice(last);
      if (next !== s) { writeFileSync(join(ctx.root, f), next); changed.push(f); }
    }
    out.push({ pin: name, changed, detail: kept.length ? `kept ${[...new Set(kept)].join(", ")}` : `= ${version} from ${from}` });
  }
  return out;
}

export interface PinProblem { repo: string; where: string; pin: string; version: string; problem: string }

/** Where a fork provides version v: its release branch or its release tag. */
function releaseRef(depRoot: string, v: string, vars: Vars): string | null {
  const refs = [`refs/heads/revenuedot/release-${v}`, `refs/remotes/origin/revenuedot/release-${v}`, `refs/tags/${v}${vars.gitTagSuffix ?? "-revenuedot"}`];
  for (const r of refs) if (git(depRoot, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`], { allowFail: true })) return r;
  return null;
}

/**
 * Every pin in `tree` must point at a version the dependency fork provides (release branch or tag). Follows each
 * resolved release branch and checks its pins too, so a wrapper → hybrid-common → Android chain is covered.
 */
export function checkPins(ctx: PinContext, tree: Tree = workTree(ctx.root), seen = new Set<string>()): { ok: string[]; problems: PinProblem[] } {
  const key = `${ctx.repo}@${tree.label}`;
  const ok: string[] = []; const problems: PinProblem[] = [];
  if (seen.has(key)) return { ok, problems };
  seen.add(key);
  const spec = ctx.loadSpec(ctx.repo);
  const all = tree.list();
  for (const pin of spec.pins ?? []) {
    const name = `${pin.dep} in ${pin.files.join(",")}`;
    const re = pinRegex(pin, ctx.vars);
    const versions = new Set<string>();
    for (const f of all.filter((x) => matchesAny(x, pin.files))) for (const m of (tree.read(f) ?? "").matchAll(re)) versions.add(m[1]!);
    if (!versions.size) { problems.push({ repo: ctx.repo, where: tree.label, pin: name, version: "-", problem: "pin not found; update rules/" + ctx.repo + ".json" }); continue; }
    for (const v of versions) {
      if (pin.dep === ctx.repo) {
        const own = readVersion(tree, spec.version);
        if (own === v) ok.push(`${ctx.repo}@${tree.label}: ${name} = ${v} (its own version)`);
        else problems.push({ repo: ctx.repo, where: tree.label, pin: name, version: v, problem: `does not match the package's own version ${own}` });
        continue;
      }
      const depRoot = join(ctx.workspace, pin.dep);
      if (!existsSync(join(depRoot, ".git"))) { problems.push({ repo: ctx.repo, where: tree.label, pin: name, version: v, problem: `no ${pin.dep} checkout in ${ctx.workspace}` }); continue; }
      const ref = releaseRef(depRoot, v, ctx.vars);
      if (!ref) {
        problems.push({ repo: ctx.repo, where: tree.label, pin: name, version: v, problem: `${pin.dep} has no branch revenuedot/release-${v} or tag ${v}${ctx.vars.gitTagSuffix}. Create it: pnpm tsx scripts/forks/apply.ts --repo ${pin.dep} --base ${v} --branch revenuedot/release-${v} --push` });
        continue;
      }
      ok.push(`${ctx.repo}@${tree.label}: ${name} = ${v} → ${pin.dep} ${ref.replace(/^refs\/(heads|remotes|tags)\//, "")}`);
      const sub = checkPins({ ...ctx, root: depRoot, repo: pin.dep }, refTree(depRoot, ref), seen);
      ok.push(...sub.ok); problems.push(...sub.problems);
    }
  }
  return { ok, problems };
}
