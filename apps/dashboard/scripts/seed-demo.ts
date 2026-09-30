/**
 * Seeds the running dev server with a demo project through the API.
 *   pnpm --filter @revenuedot/dashboard seed         (API at http://localhost:8787)
 *   RD_API=http://localhost:8787 RD_EMAIL=... RD_PASSWORD=... tsx scripts/seed-demo.ts
 * Signs up (or signs in) the demo account and fills its first project. Safe to run twice: the catalog is reused and
 * another batch of customers is added.
 */
import { seedProject, session } from "../e2e/seed.ts";

const base = process.env.RD_API ?? "http://localhost:8787";
const email = process.env.RD_EMAIL ?? "demo@revenuedot.test";
const password = process.env.RD_PASSWORD ?? "demo-password-1";
const cookie = await session(base, email, password, "Scanner");
const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json() as { projects: { id: string; name: string }[] };
const project = me.projects[0]!;
const r = await seedProject(base, cookie, project.id);
console.log(`Seeded project "${project.name}" (${project.id}) with ${r.customers.length} customers.`);
console.log(`Sign in at http://localhost:5178/login as ${email} / ${password}`);
