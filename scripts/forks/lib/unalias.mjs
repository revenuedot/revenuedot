#!/usr/bin/env node
/**
 * Checks only. Our forks depend on each other through npm aliases ("npm:@revenuedot/purchases-js@1.66.0"), and those
 * packages are not on npm until we publish. For a local check this rewrites each alias in the given package.json files:
 * - to a local build when LOCAL_<NAME>=<dir> is set (e.g. LOCAL_PURCHASES_JS=/path/to/purchases-js), as "file:<dir>";
 * - otherwise to the identical upstream release it was built from ("npm:@revenuecat/purchases-js@1.66.0").
 * With --resolutions=<root package.json> the dependency fields stay untouched and yarn "resolutions" in that root
 * file do the redirect instead (for repos whose tests read the dependency fields).
 * Runs inside the throwaway check worktree, never on the committed tree.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "config.json"), "utf8"));
const resArg = process.argv.find((a) => a.startsWith("--resolutions="));
const resolutionsFile = resArg?.slice("--resolutions=".length);
const resolutions = {};
for (const file of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const changes = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      const m = /^npm:(@revenuedot\/[^@]+)@(.+)$/.exec(String(spec));
      if (!m) continue;
      const ours = m[1];
      const local = process.env[`LOCAL_${ours.replace(/^@revenuedot\//, "").replace(/[^a-z0-9]/gi, "_").toUpperCase()}`];
      const upstream = cfg.npmNames[ours];
      if (!local && !upstream) throw new Error(`No upstream name for ${ours} in config.json npmNames`);
      const next = local ? `file:${local}` : upstream === dep ? m[2] : `npm:${upstream}@${m[2]}`;
      if (resolutionsFile) resolutions[dep] = next; else pkg[field][dep] = next;
      changes.push(`${dep}: ${spec} -> ${next}`);
    }
  }
  if (!resolutionsFile) writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${file}: ${changes.length ? changes.join("; ") : "no aliases"}`);
}
if (resolutionsFile) {
  const root = JSON.parse(readFileSync(resolutionsFile, "utf8"));
  root.resolutions = { ...(root.resolutions ?? {}), ...resolutions };
  writeFileSync(resolutionsFile, JSON.stringify(root, null, 2) + "\n");
  console.log(`${resolutionsFile}: resolutions ${JSON.stringify(resolutions)}`);
}
