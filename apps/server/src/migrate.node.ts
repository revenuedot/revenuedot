// Applies pending database migrations and exits: the Helm chart's pre-install/pre-upgrade Job, the ECS and Cloud Run
// migration tasks, and `pnpm --filter @revenuedot/server migrate`. Safe to run while replicas start: it takes the same
// advisory lock as a replica migrating on start (prd/ha-self-host/PRD.md).
import { openDb } from "@revenuedot/db";

const url = process.env.DATABASE_URL;
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error("Set DATABASE_URL to a postgres:// URL.");
  process.exit(1);
}
const started = Date.now();
try {
  const { close } = await openDb(url, { migrate: true, max: 2 });
  await close();
  console.log(`Migrations applied to ${new URL(url).host} in ${Date.now() - started} ms.`);
} catch (e) {
  console.error("Migration failed:", e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, "postgres://…") : e);
  process.exit(1);
}
