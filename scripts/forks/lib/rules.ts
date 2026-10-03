/**
 * The rule engine behind the SDK fork pipeline (prd/sdk-forks/PRD.md).
 * Every rule is idempotent: running the pipeline twice on the same checkout changes nothing the second time,
 * and running it after an upstream merge re-applies only what upstream overwrote.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Pin, VersionSource } from "./pins.ts";

export type Vars = Record<string, string>;

interface Base { note?: string; optional?: boolean }
/** Replace a string or regex in every file matching `files`. `done` marks the rule as already applied in a file. */
export interface ReplaceRule extends Base { type: "replace"; files: string[]; find: string; replace: string; regex?: boolean; flags?: string; done?: string; exclude?: string[] }
/** Set or delete values in a JSON file by JSON Pointer ("/dependencies/@revenuecat~1purchases-js"). `{{current}}` is the old value. */
export interface JsonRule extends Base { type: "json"; file: string; set?: Record<string, unknown>; setIfPresent?: Record<string, unknown>; remove?: string[]; skipIfCurrentMatches?: string }
export interface RenameRule extends Base { type: "rename"; from: string; to: string }
/** Writes `to` from `from` with string replacements. Regenerated on every run. */
export interface CopyRule extends Base { type: "copy"; from: string; to: string; replacements?: { find: string; replace: string }[] }
export interface DeleteRule extends Base { type: "delete"; files: string[] }
/** Keeps the upstream MIT notice and adds our copyright line after the last upstream copyright line. */
export interface LicenseRule extends Base { type: "license"; files: string[]; stubFrom?: string }
/** Keeps a marked fork banner at the top of each README. */
export interface BannerRule extends Base { type: "banner"; files: string[]; install: string }
/**
 * Keeps the RevenueDot README (lockup, H1, badges, install, configure, links) at the top of the repo README, above the
 * upstream README, which follows unchanged under "Upstream README". `{{version}}` is the newest published fork release
 * (see apply.ts), `{{forkVersion}}` the version this checkout declares. Strings may be given as arrays of lines.
 */
export interface ReadmeRule extends Base {
  type: "readme"; file: string;
  /** H1, for example "RevenueDot iOS SDK". */
  title: string;
  /** Upstream package or repo name named in the first sentence, for example "purchases-ios". */
  upstreamPackage: string;
  /** Docs page for this SDK, for example "https://revenuedot.app/docs/sdks/ios". */
  docs: string;
  /** Registry badges after the MIT one: shields.io image URLs that resolve for our package names. */
  badges: { alt: string; image: string; link: string }[];
  /** Markdown for the Install section. */
  install: string | string[];
  /** Code for the Configure section. */
  configure: { lang: string; code: string | string[] };
  /** One line after the configure block (what the fork changes about configuration), optional. */
  configureNote?: string;
  /** Folder in github.com/revenuedot/examples, for example "mobile/ios-swiftui"; omitted when there is no example. */
  example?: string;
  /** Replaces the default "What RevenueDot adds" bullets. */
  adds?: string[];
}
/** Points a git submodule at our fork, and pins it to our patch branch when that branch contains the pinned commit. */
export interface SubmoduleRule extends Base { type: "submodule"; path: string; url: string; pinToRepo?: string; /** Branch in pinToRepo to pin to; "{branch}" is the submodule's .gitmodules branch (an upstream tag). Default: the patch branch. */ pinBranch?: string }
export type Rule = ReplaceRule | JsonRule | RenameRule | CopyRule | DeleteRule | LicenseRule | BannerRule | ReadmeRule | SubmoduleRule;
/** Expands to a shared rule group from rules/_shared.json; "$files" and "$file" in the group are replaced. */
export interface IncludeRule { type: "include"; group: string; files?: string[]; file?: string }

export function expandIncludes(rules: (Rule | IncludeRule)[], shared: Record<string, Rule[]>): Rule[] {
  return rules.flatMap((r) => {
    if (r.type !== "include") return [r];
    const group = shared[r.group];
    if (!group) throw new Error(`Unknown shared rule group ${r.group}`);
    return group.map((g) => JSON.parse(JSON.stringify(g), (k, v) => (v === "$files" ? r.files : v === "$file" ? r.file : v)) as Rule);
  });
}

export interface Check { name: string; run: string; timeoutSec?: number }
export interface RepoSpec {
  repo: string;
  upstream: string;
  /** Registry names this fork publishes under, for the PRD table and the report. */
  publishes: string[];
  rules: (Rule | IncludeRule)[];
  /** Paths ignored by the leak scan (tests, fixtures, examples, docs, changelogs). */
  scanExclude?: string[];
  checks?: Check[];
  /** Where this fork declares its own version (read by other forks' pins). */
  version?: VersionSource;
  /** Version pins on other forks (or on this one); see lib/pins.ts. */
  pins?: Pin[];
}
export interface Config {
  org: string;
  patchBranch: string;
  syncBranch: string;
  vars: Vars;
  /** Our npm name → upstream npm name. Used only by checks, to install upstream builds of packages we have not published yet. */
  npmNames: Record<string, string>;
  leakPatterns: string[];
  scanExcludeDefault: string[];
}

export interface Result { rule: string; changed: string[]; status: "applied" | "unchanged" | "skipped-optional"; detail?: string }

export const render = (s: string, vars: Vars) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k]! : k === "current" ? m : (() => { throw new Error(`Unknown variable {{${k}}}`); })()));

/** Minimal glob: `**` (any depth), `*` (no slash), `?`, `{a,b}`. Matched against repo-relative POSIX paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = glob.indexOf("}", i); re += "(?:" + glob.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")"; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (path: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(path));

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trim(); }
  catch (e) { if (opts.allowFail) return ""; throw e; }
}

/** Tracked files plus untracked, non-ignored ones (so files created by earlier rules are visible). */
export function listFiles(root: string): string[] {
  return git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter((f) => f && existsSync(join(root, f)));
}

const read = (p: string) => readFileSync(p, "utf8");
function write(p: string, s: string) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); }

function jsonPointer(obj: any, pointer: string): { parent: any; key: string } | null {
  const parts = pointer.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = obj;
  for (const p of parts.slice(0, -1)) { if (cur == null || typeof cur !== "object" || !(p in cur)) return null; cur = cur[p]; }
  return cur && typeof cur === "object" ? { parent: cur, key: parts[parts.length - 1]! } : null;
}

function describe(r: Rule): string {
  switch (r.type) {
    case "replace": return `replace ${JSON.stringify(r.find).slice(0, 70)} in ${r.files.join(",")}`;
    case "json": return `json ${r.file}`;
    case "rename": return `rename ${r.from} -> ${r.to}`;
    case "copy": return `copy ${r.from} -> ${r.to}`;
    case "delete": return `delete ${r.files.join(",")}`;
    case "license": return `license ${r.files.join(",")}`;
    case "banner": return `banner ${r.files.join(",")}`;
    case "readme": return `readme ${r.file}`;
    case "submodule": return `submodule ${r.path}`;
  }
}

export interface ApplyContext { root: string; vars: Vars; workspace: string; patchBranch: string; log?: (s: string) => void }

export function applyRule(rule: Rule, ctx: ApplyContext): Result {
  const { root, vars } = ctx;
  const name = rule.note ? `${describe(rule)} (${rule.note})` : describe(rule);
  const changed: string[] = [];
  const miss = (detail: string): Result => {
    if (rule.optional) return { rule: name, changed, status: "skipped-optional", detail };
    throw new Error(`Rule did not match: ${name}: ${detail}. Upstream probably moved this code; update the rule.`);
  };

  switch (rule.type) {
    case "replace": {
      const files = listFiles(root).filter((f) => matchesAny(f, rule.files) && !(rule.exclude && matchesAny(f, rule.exclude)));
      if (!files.length) return miss("no files match");
      const find = render(rule.find, vars);
      const replace = render(rule.replace, vars);
      const done = rule.done !== undefined ? render(rule.done, vars) : undefined;
      if (!rule.regex && replace.includes(find) && done === undefined) throw new Error(`Rule ${name}: the replacement contains the search text, so it needs a "done" marker`);
      let matched = 0; let alreadyDone = 0;
      for (const f of files) {
        const p = join(root, f); const before = read(p);
        if (done !== undefined && before.includes(done)) { alreadyDone++; continue; }
        let after: string;
        if (rule.regex) {
          const re = new RegExp(find, (rule.flags ?? "") + (rule.flags?.includes("g") ? "" : "g"));
          const n = before.match(re)?.length ?? 0; matched += n;
          after = n ? before.replace(re, replace) : before;
        } else {
          const n = before.split(find).length - 1; matched += n;
          after = n ? before.split(find).join(replace) : before;
        }
        if (after !== before) { write(p, after); changed.push(f); }
      }
      if (matched === 0 && alreadyDone === 0) {
        // A plain replacement that already ran leaves its replacement text behind.
        if (!rule.regex && files.some((f) => read(join(root, f)).includes(replace))) return { rule: name, changed, status: "unchanged" };
        return miss(`pattern not found in ${files.length} file(s)`);
      }
      return { rule: name, changed, status: changed.length ? "applied" : "unchanged" };
    }
    case "json": {
      const p = join(root, rule.file);
      if (!existsSync(p)) return miss("file missing");
      const text = read(p);
      const indent = /^[ \t]+/m.exec(text)?.[0] ?? "  ";
      const obj = JSON.parse(text);
      const setOne = (ptr: string, raw: unknown, required: boolean) => {
        const loc = jsonPointer(obj, ptr);
        if (!loc) { if (required) throw new Error(`Rule ${name}: ${ptr} has no parent in ${rule.file}`); return; }
        const cur = loc.parent[loc.key];
        if (!required && cur === undefined) return;
        if (rule.skipIfCurrentMatches && typeof cur === "string" && new RegExp(rule.skipIfCurrentMatches).test(cur) && typeof raw === "string" && raw.includes("{{current}}")) return;
        const deep = (v: unknown): unknown => typeof v === "string" ? render(v, vars) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
        const val = typeof raw === "string" ? render(raw, vars).replace("{{current}}", String(cur ?? "")) : deep(raw);
        loc.parent[loc.key] = val;
      };
      for (const [ptr, v] of Object.entries(rule.set ?? {})) setOne(ptr, v, true);
      for (const [ptr, v] of Object.entries(rule.setIfPresent ?? {})) setOne(ptr, v, false);
      for (const ptr of rule.remove ?? []) { const loc = jsonPointer(obj, ptr); if (loc) delete loc.parent[loc.key]; }
      const out = JSON.stringify(obj, null, indent) + (text.endsWith("\n") ? "\n" : "");
      if (out !== text) { write(p, out); changed.push(rule.file); }
      return { rule: name, changed, status: changed.length ? "applied" : "unchanged" };
    }
    case "rename": {
      const from = join(root, rule.from); const to = join(root, rule.to);
      if (existsSync(from)) { if (existsSync(to)) rmSync(to); mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); changed.push(rule.from, rule.to); return { rule: name, changed, status: "applied" }; }
      if (existsSync(to)) return { rule: name, changed, status: "unchanged" };
      return miss("neither file exists");
    }
    case "copy": {
      const from = join(root, rule.from);
      if (!existsSync(from)) return miss("source missing");
      let s = read(from);
      for (const r of rule.replacements ?? []) s = s.split(render(r.find, vars)).join(render(r.replace, vars));
      const to = join(root, rule.to);
      if (!existsSync(to) || read(to) !== s) { write(to, s); changed.push(rule.to); }
      return { rule: name, changed, status: changed.length ? "applied" : "unchanged" };
    }
    case "delete": {
      const files = listFiles(root).filter((f) => matchesAny(f, rule.files));
      for (const f of files) { rmSync(join(root, f)); changed.push(f); }
      return { rule: name, changed, status: changed.length ? "applied" : "unchanged" };
    }
    case "license": {
      const line = render(vars.copyrightLine!, vars);
      for (const f of rule.files) {
        const p = join(root, f);
        if (!existsSync(p)) { if (rule.optional) continue; throw new Error(`Rule ${name}: ${f} missing`); }
        let s = read(p);
        if (s.includes(line)) continue;
        if (s.trim() === "MIT" && rule.stubFrom) s = read(join(root, rule.stubFrom)); // one-word stub: ship the full upstream notice
        if (s.includes(line)) { write(p, s); changed.push(f); continue; }
        const lines = s.split("\n");
        const permission = lines.findIndex((l) => /Permission is hereby granted/i.test(l));
        let last = -1;
        lines.forEach((l, i) => { if (/^\s*Copyright\b/i.test(l) && (permission < 0 || i < permission)) last = i; });
        if (last < 0) throw new Error(`Rule ${name}: no copyright line in ${f}`);
        lines.splice(last + 1, 0, line);
        write(p, lines.join("\n")); changed.push(f);
      }
      return { rule: name, changed, status: changed.length ? "applied" : "unchanged" };
    }
    case "banner": {
      const start = "<!-- revenuedot:banner:start -->"; const end = "<!-- revenuedot:banner:end -->";
      const block = [start, "> [!NOTE]", `> **${vars.disclaimer}** ${render(vars.bannerBody!, vars)}`, ">", `> **Install:** ${render(rule.install, vars)}`, ">", `> The upstream README follows, unchanged. Where it says RevenueCat's dashboard or API, use RevenueDot's.`, end, ""].join("\n");
      for (const f of rule.files) {
        const p = join(root, f);
        if (!existsSync(p)) { if (rule.optional) continue; throw new Error(`Rule ${name}: ${f} missing`); }
        let s = read(p);
        // The one-line notice added by hand when the forks were created (before the pipeline) is replaced by the managed block.
        s = s.replace(/^> \[!NOTE\]\n> \*\*RevenueDot fork\.\*\*[^\n]*\n\n?/, "");
        const i = s.indexOf(start); const j = s.indexOf(end);
        const next = i >= 0 && j > i ? s.slice(0, i) + block + s.slice(j + end.length).replace(/^\n/, "") : block + "\n" + s;
        if (next !== read(p)) { write(p, next); changed.push(f); }
      }
      return { rule: name, changed, status: changed.length ? "applied" : "unchanged" };
    }
    case "readme": {
      const p = join(root, rule.file);
      if (!existsSync(p)) { if (rule.optional) return { rule: name, changed, status: "skipped-optional", detail: "file missing" }; throw new Error(`Rule ${name}: ${rule.file} missing`); }
      const before = read(p);
      const next = upsertReadme(before, renderReadme(rule, vars));
      if (next !== before) { write(p, next); changed.push(rule.file); }
      return { rule: name, changed, status: changed.length ? "applied" : "unchanged" };
    }
    case "submodule": {
      const gm = join(root, ".gitmodules");
      if (!existsSync(gm)) return miss(".gitmodules missing");
      const key = git(root, ["config", "-f", ".gitmodules", "--get-regexp", "path"]).split("\n").find((l) => l.trim().endsWith(` ${rule.path}`))?.split(" ")[0]?.replace(/\.path$/, "");
      if (!key) return miss(`no submodule at ${rule.path}`);
      const url = render(rule.url, vars);
      if (git(root, ["config", "-f", ".gitmodules", `${key}.url`]) !== url) { git(root, ["config", "-f", ".gitmodules", `${key}.url`, url]); changed.push(".gitmodules"); }
      let detail = "";
      if (rule.pinToRepo) {
        const pinned = git(root, ["ls-files", "-s", "--", rule.path]).split(/\s+/)[1]; // the index, so a staged pin counts
        const sibling = join(ctx.workspace, rule.pinToRepo);
        const upstreamBranch = git(root, ["config", "-f", ".gitmodules", `${key}.branch`], { allowFail: true });
        const branch = (rule.pinBranch ?? ctx.patchBranch).replace("{branch}", upstreamBranch);
        const head = git(sibling, ["rev-parse", "--verify", "--quiet", branch], { allowFail: true }) || git(sibling, ["rev-parse", "--verify", "--quiet", `origin/${branch}`], { allowFail: true });
        if (pinned && head && pinned !== head) {
          // Move the pin only from "upstream X" (or "upstream X plus an older copy of our patches") to "upstream X plus our
          // patches", never to a different upstream version: everything between the common base and either commit must be ours.
          const base = git(sibling, ["merge-base", pinned, head], { allowFail: true });
          const onlyOurs = (tip: string) => git(sibling, ["rev-list", tip, `^${base}`], { allowFail: true }) === git(sibling, ["rev-list", tip, `^${base}`, "^upstream/main"], { allowFail: true });
          const isPatchedPin = !!base && git(sibling, ["rev-list", "--count", head, `^${base}`]) !== "0" && onlyOurs(head) && onlyOurs(pinned);
          if (isPatchedPin) { git(root, ["update-index", "--cacheinfo", `160000,${head},${rule.path}`]); changed.push(rule.path); detail = `pinned to ${rule.pinToRepo} ${branch} @${head.slice(0, 9)}`; }
          else detail = `left at ${pinned.slice(0, 9)}: ${rule.pinToRepo} ${branch} is not that commit plus our patches. Create it with: apply.ts --repo ${rule.pinToRepo} --base ${upstreamBranch || "<tag>"} --branch ${branch} --push`;
        } else if (!head) detail = `left at ${pinned?.slice(0, 9)}: ${rule.pinToRepo} has no branch ${branch}. Create it with: apply.ts --repo ${rule.pinToRepo} --base ${upstreamBranch || "<tag>"} --branch ${branch} --push`;
        else if (pinned === head) detail = `already pinned to ${branch}`;
      }
      return { rule: name, changed, status: changed.length ? "applied" : "unchanged", detail };
    }
  }
}

export const README_START = "<!-- revenuedot:readme:start -->";
export const README_END = "<!-- revenuedot:readme:end -->";
export const README_UPSTREAM_HEADING = "## Upstream README (RevenueCat's, unchanged)";
const LOCKUP = "https://raw.githubusercontent.com/revenuedot/revenuedot/main/brand/kit/wordmark/revenuedot-lockup";
/** Text for a shields.io static badge path segment: "-" and "_" are shields' separators. */
export const shieldsText = (s: string) => encodeURIComponent(s.replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_"));
const lines = (v: string | string[]) => (Array.isArray(v) ? v.join("\n") : v);

/** The managed block, from the lockup to the "Upstream README" heading. Deterministic for the same rule and vars. */
export function renderReadme(rule: ReadmeRule, vars: Vars): string {
  const r = (s: string) => render(s, vars);
  const upstreamRepo = `https://github.com/RevenueCat/${vars.repo}`;
  const forkRepo = `https://github.com/${vars.org}/${vars.repo}`;
  const badges = [
    `[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)`,
    ...rule.badges.map((b) => `[![${r(b.alt)}](${r(b.image)})](${r(b.link)})`),
    `[![Upstream](https://img.shields.io/badge/upstream-${shieldsText(`RevenueCat/${vars.repo} ${vars.forkVersion}`)}-lightgrey)](${upstreamRepo})`,
  ];
  const adds = rule.adds ?? [
    "**Self-host for free, or use RevenueDot Cloud** free up to $10,000 a month of tracked revenue ([pricing](https://revenuedot.app/pricing)).",
    "**The same REST API and webhook payloads** as RevenueCat, so your backend and integrations keep working ([API reference](https://revenuedot.app/docs/api)).",
    "**Paywalls, experiments and the Customer Center** built in the RevenueDot dashboard and rendered by this SDK ([guides](https://revenuedot.app/docs/guides)).",
    "**A one-line migration:** point the stock SDK at RevenueDot with `setProxyURL`, or install this fork and drop the line ([migration guide](https://revenuedot.app/docs/migrate)).",
  ];
  const links = [
    `- **Docs for this SDK:** ${r(rule.docs)}`,
    ...(rule.example ? [`- **Example app:** https://github.com/${vars.org}/examples/tree/main/${r(rule.example)}`] : []),
    `- **Releases and changelog:** ${forkRepo}/releases (tags \`<upstream version>${vars.gitTagSuffix}\`; upstream's changes are in \`CHANGELOG.md\`)`,
    `- **RevenueDot server and dashboard:** https://github.com/${vars.org}/revenuedot`,
    `- **Fork pipeline (what we change and how upstream is merged):** https://github.com/${vars.org}/revenuedot/tree/main/scripts/forks`,
  ];
  return [
    README_START,
    `<p align="center"><a href="${vars.homepage}"><picture>`,
    `  <source media="(prefers-color-scheme: dark)" srcset="${LOCKUP}-white.svg">`,
    `  <img alt="RevenueDot" src="${LOCKUP}-black.svg" height="40">`,
    `</picture></a></p>`,
    "",
    `# ${r(rule.title)}`,
    "",
    `This is RevenueDot's MIT fork of RevenueCat's \`${r(rule.upstreamPackage)}\`: the same classes and method names, pointed at a RevenueDot server ([RevenueDot Cloud](https://app.revenuedot.app/signup) at \`${vars.apiHost}\`, or one you host) with RevenueDot's response-signing key built in, and kept in sync with upstream.`,
    "",
    badges.join(" "),
    "",
    "## Install",
    "",
    r(lines(rule.install)),
    "",
    "## Configure",
    "",
    "```" + rule.configure.lang,
    r(lines(rule.configure.code)),
    "```",
    "",
    `The fork already trusts RevenueDot's signing key, so no signature or verification setting is needed.${rule.configureNote ? " " + r(rule.configureNote) : ""} Full guide: ${r(rule.docs)}.`,
    "",
    "## What RevenueDot adds",
    "",
    ...adds.map((a) => `- ${r(a)}`),
    "",
    "## Links",
    "",
    ...links,
    "",
    `RevenueDot is not affiliated with RevenueCat, Inc. RevenueCat's copyright notice stays in \`LICENSE\`; RevenueDot's changes are MIT too.`,
    "",
    "---",
    "",
    README_UPSTREAM_HEADING,
    README_END,
    "",
  ].join("\n");
}

/** Puts the block at the top of a README, replacing an older block, the pipeline's NOTE banner, or the hand-written notice. */
export function upsertReadme(readme: string, block: string): string {
  let s = readme;
  const i = s.indexOf(README_START); const j = s.indexOf(README_END);
  if (i >= 0 && j > i) return s.slice(0, i) + block + s.slice(j + README_END.length).replace(/^\n/, "");
  const b0 = s.indexOf("<!-- revenuedot:banner:start -->"); const b1 = s.indexOf("<!-- revenuedot:banner:end -->");
  if (b0 >= 0 && b1 > b0) s = s.slice(0, b0) + s.slice(b1 + "<!-- revenuedot:banner:end -->".length).replace(/^\n+/, "");
  s = s.replace(/^> \[!NOTE\]\n> \*\*RevenueDot fork\.\*\*[^\n]*\n\n?/, "");
  return block + "\n" + s;
}

/** Problems with a README on disk: missing or stale block, or RevenueCat sign-up copy above the upstream section. */
export function checkReadme(root: string, rule: ReadmeRule, vars: Vars): string[] {
  const p = join(root, rule.file);
  if (!existsSync(p)) return rule.optional ? [] : [`${rule.file} missing`];
  const s = readFileSync(p, "utf8");
  const problems: string[] = [];
  const i = s.indexOf(README_START); const j = s.indexOf(README_END);
  if (i !== 0 || j < 0) return [`${rule.file} does not start with the RevenueDot README block (run apply.ts)`];
  const block = s.slice(0, j + README_END.length + 1);
  if (block !== renderReadme(rule, vars)) problems.push(`${rule.file}: the RevenueDot block is stale (run apply.ts)`);
  const ours = s.slice(0, s.indexOf(README_UPSTREAM_HEADING));
  if (!new RegExp(`^# ${render(rule.title, vars).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(ours)) problems.push(`${rule.file}: H1 "${render(rule.title, vars)}" missing`);
  for (const bad of ["app.revenuecat.com", "get started for free", "revenuecat.com/signup"]) if (ours.toLowerCase().includes(bad)) problems.push(`${rule.file}: "${bad}" appears above the upstream section`);
  return problems;
}

/** Finds RevenueCat hosts and signing keys left in shipped code after the rules ran. */
export function leakScan(root: string, cfg: Config, spec: RepoSpec): string[] {
  const exclude = [...cfg.scanExcludeDefault, ...(spec.scanExclude ?? [])];
  const hits: string[] = [];
  const files = listFiles(root).filter((f) => !matchesAny(f, exclude));
  const res = cfg.leakPatterns.map((p) => new RegExp(p));
  for (const f of files) {
    let s: string; try { s = readFileSync(join(root, f), "utf8"); } catch { continue; }
    if (s.includes("\0")) continue; // binary
    s.split("\n").forEach((l, i) => { if (res.some((r) => r.test(l))) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 140)}`); });
  }
  return hits;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export { copyFileSync };
