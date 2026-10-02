// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the migration journal stays in order, and a migration drizzle would skip (its journal "when" is not later
// than the last one applied, as when branches merge out of order) stops the start instead of being skipped silently.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { openDb } from "../src/index.js";

const journal = JSON.parse(readFileSync(fileURLToPath(new URL("../migrations/meta/_journal.json", import.meta.url)), "utf8")) as { entries: { idx: number; tag: string; when: number }[] };
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("migrations", () => {
  it("journal entries have strictly increasing `when`, in the order they are listed", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const [a, b] = [journal.entries[i - 1]!, journal.entries[i]!];
      expect(b.when, `${b.tag} must have a later "when" than ${a.tag}`).toBeGreaterThan(a.when);
    }
  });

  it("refuses to start when a migration would be skipped", async () => {
    dir = mkdtempSync(join(tmpdir(), "rd-migrations-"));
    const url = `pglite://${dir}`;
    const first = await openDb(url);
    // As if the newest migration had been applied before an older-dated one merged: drop the second-newest's record and
    // pretend a later migration ran.
    const prev = journal.entries[journal.entries.length - 2]!;
    const last = journal.entries[journal.entries.length - 1]!;
    await first.db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${prev.when}`);
    await first.db.execute(sql`update drizzle.__drizzle_migrations set created_at = ${last.when + 1000} where created_at = ${last.when}`);
    await first.close();
    await expect(openDb(url)).rejects.toThrow(new RegExp(`${prev.tag}.*would be skipped`));
  });

  it("a server started without migrating refuses a database missing a migration, and accepts one that has them all", async () => {
    dir = mkdtempSync(join(tmpdir(), "rd-migrations-"));
    const url = `pglite://${dir}`;
    await expect(openDb(url, { migrate: false })).rejects.toThrow(/missing \d+ migrations .*REVENUEDOT_MIGRATE=skip/);
    await (await openDb(url)).close();
    const skipping = await openDb(url, { migrate: false });
    const last = journal.entries[journal.entries.length - 1]!;
    await skipping.db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${last.when}`);
    await skipping.close();
    await expect(openDb(url, { migrate: false })).rejects.toThrow(new RegExp(`missing 1 migration \\(${last.tag}\\)`));
  });

  it("starts normally on a database that applied every migration", async () => {
    dir = mkdtempSync(join(tmpdir(), "rd-migrations-"));
    const url = `pglite://${dir}`;
    await (await openDb(url)).close();
    const again = await openDb(url);
    await again.close();
  });
});
