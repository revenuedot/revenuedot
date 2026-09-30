// Recomputes USD values of purchases saved before prices were converted at the purchase date's exchange rate
// (apps/server/src/services/fx-backfill.ts says which rows qualify). Dry run by default; --apply writes. Idempotent.
// Usage: DATABASE_URL=postgres://... pnpm tsx scripts/backfill-usd.ts [--apply]   (or pass the URL as an argument)
import { openDb } from "../packages/db/src/index.js";
import { backfillUsd } from "../apps/server/src/services/fx-backfill.js";

const apply = process.argv.includes("--apply");
const url = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.env.DATABASE_URL;
if (!url || !/^(postgres(ql)?|pglite):\/\//.test(url)) {
  console.error("Set DATABASE_URL (or pass it as the first argument) to a postgres:// URL.");
  process.exit(1);
}
const { db, close } = await openDb(url);
try {
  console.log(`${apply ? "Applying" : "Dry run (pass --apply to write)"} on ${url.startsWith("pglite") ? url : new URL(url).host}`);
  await backfillUsd(db, { apply, log: (l) => console.log(l) });
} finally {
  await close();
}
