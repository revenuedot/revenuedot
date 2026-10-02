// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: writes that race on real Postgres (CI's test-postgres job runs it there; PGlite serialises everything).
// Found by the real-Postgres runs of the suite and the journeys (prd/validation/COVERAGE.md).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

describe("customer attributes written at the same time", () => {
  it("never fail with a duplicate key, and the newest timestamp wins", async () => {
    await h.fetch("/v1/subscribers/racer", { key: h.ids.testKey });
    const post = (value: string, at: number) => h.fetch("/v1/subscribers/racer/attributes", { method: "POST", key: h.ids.testKey, json: { attributes: { plan: { value, updated_at_ms: at }, [`k_${at}`]: { value, updated_at_ms: at } } } });
    const base = Date.now();
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => post(`v${i}`, base + i)));
    expect(res.map((r) => r.status)).toEqual(Array(12).fill(200));
    const [row] = await h.db.select().from(schema.customerAttributes).where(eq(schema.customerAttributes.key, "plan"));
    expect(row!.value).toBe("v11");
    // An older write that arrives late does not overwrite.
    expect((await post("stale", base - 1000)).status).toBe(200);
    const [after] = await h.db.select().from(schema.customerAttributes).where(eq(schema.customerAttributes.key, "plan"));
    expect(after!.value).toBe("v11");
  });
});
