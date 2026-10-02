// RevenueDot Enterprise (ee/LICENSE). Issues a licence key.
//   op read "op://RevenueDot/RevenueDot Enterprise licence signing key/password" | pnpm tsx ee/scripts/license-issue.ts --licensee "Acme Inc." --days 365 [--features sso,scim] [--edition self-hosted|cloud|any] [--max-orgs 1]
// Reads the private key seed from stdin, prints the key (rdl1_…) on stdout.
import { issueLicense, FEATURES } from "../server/license.js";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const seed = Buffer.concat(chunks).toString("utf8").trim();
if (!seed) { console.error("Pipe the private key seed into stdin."); process.exit(1); }
const licensee = arg("licensee");
if (!licensee) { console.error("--licensee is required."); process.exit(1); }
const features = (arg("features") ?? "*").split(",").map((f) => f.trim()).filter(Boolean);
const unknown = features.filter((f) => f !== "*" && !(FEATURES as readonly string[]).includes(f));
if (unknown.length) { console.error(`Unknown features: ${unknown.join(", ")}. Known: ${FEATURES.join(", ")}.`); process.exit(1); }
const now = Date.now();
const days = Number(arg("days") ?? 365);
const edition = (arg("edition") ?? "any") as "self-hosted" | "cloud" | "any";
const maxOrgs = arg("max-orgs") ? Number(arg("max-orgs")) : null;
const key = await issueLicense(seed, { v: 1, id: `lic_${now.toString(36)}`, licensee, features, max_orgs: maxOrgs, edition, issued_at: now, expires_at: now + days * 86400_000 });
process.stdout.write(`${key}\n`);
