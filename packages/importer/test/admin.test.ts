// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: `revenuedot admin reset-password` against a real (in-memory) RevenueDot database.
// Docs: https://revenuedot.app/docs/guides/self-hosting#reset-a-password-without-email
import { afterEach, describe, expect, it } from "vitest";
import { schema } from "@revenuedot/db";
import { main } from "../src/cli.js";
import type { Query } from "../src/admin.js";
import { hashPassword as serverHash, login, createSession } from "../../../apps/server/src/services/sessions.js";
import { openTestDb } from "../../contract/src/test-db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function setup() {
  const o = await openTestDb();
  close = o.close;
  await o.db.insert(schema.users).values({ id: "usr_1", email: "owner@example.com", passwordHash: await serverHash("old password 1") });
  await createSession(o.db, "usr_1", new Date());
  await createSession(o.db, "usr_1", new Date());
  const query: Query = (t, p) => o.query(t, p);
  const out: string[] = [], err: string[] = [];
  const run = (args: string[]) => main(args, { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, query });
  return { db: o.db, run, out, err };
}

describe("revenuedot admin reset-password", () => {
  it("sets the given password (the server accepts it) and signs the user out everywhere", async () => {
    const t = await setup();
    expect(await t.run(["admin", "reset-password", "Owner@Example.com", "--password", "new password 2"])).toBe(0);
    expect(t.out[0]).toBe("Password changed for owner@example.com; signed out of 2 sessions.");
    expect(t.out.join("\n")).not.toContain("new password 2");
    expect(await login(t.db, "owner@example.com", "new password 2")).toMatchObject({ id: "usr_1" });
    expect(await login(t.db, "owner@example.com", "old password 1")).toBeNull();
    expect(await t.db.select().from(schema.sessions)).toEqual([]);
  });

  it("generates and prints a password when none is given", async () => {
    const t = await setup();
    expect(await t.run(["admin", "reset-password", "owner@example.com"])).toBe(0);
    const pw = /New password \(shown once\): (\S+)/.exec(t.out.join("\n"))![1]!;
    expect(pw).toHaveLength(20);
    expect(await login(t.db, "owner@example.com", pw)).not.toBeNull();
  });

  it("fails for unknown emails, short passwords, missing DATABASE_URL and bad usage", async () => {
    const t = await setup();
    expect(await t.run(["admin", "reset-password", "nobody@example.com", "--password", "long enough"])).toBe(1);
    expect(t.err.at(-1)).toBe("No account uses nobody@example.com.");
    expect(await t.run(["admin", "reset-password", "owner@example.com", "--password", "short"])).toBe(1);
    expect(await t.run(["admin", "reset-password"])).toBe(2);
    expect(await t.run(["admin", "nope", "x"])).toBe(2);
    const err: string[] = [];
    expect(await main(["admin", "reset-password", "owner@example.com"], { out: () => {}, err: (s) => err.push(s), env: {} })).toBe(2);
    expect(err[0]).toContain("DATABASE_URL");
  });
});
