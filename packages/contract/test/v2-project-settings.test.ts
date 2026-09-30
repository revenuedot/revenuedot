import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "@revenuedot/server/services/auth.js";
import { harness, type Harness } from "../src/harness.js";
import { otherProject, signup, v2 } from "./v2-helpers.js";

/** Project settings for the dashboard: get/update/delete a project (RevenueDot extensions) and RevenueCat's collaborator list. */

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const P = "/v2/projects/{project_id}";

/** Posts the same Test Store receipt as a given app user, like a restore on a second account. */
const post = (user: string, token: string) =>
  h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: user, fetch_token: token, product_id: "pro_monthly", price: 9.99, currency: "USD" } });

describe("project settings", () => {
  it("GET returns the project with its transfer behaviour; POST updates name and behaviours; bad values are 400", async () => {
    const g = await call("GET", P, {}, { ext: true });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ object: "project", id: "proj1", name: "Scanner", transfer_behavior: "transfer", sandbox_transfer_behavior: null });
    const u = await call("POST", P, {}, { ext: true, json: { name: "  Scanner Pro ", transfer_behavior: "keep", sandbox_transfer_behavior: "transfer" } });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ name: "Scanner Pro", transfer_behavior: "keep", sandbox_transfer_behavior: "transfer" });
    expect((await call("POST", P, {}, { ext: true, json: { sandbox_transfer_behavior: null } })).body.sandbox_transfer_behavior).toBeNull();
    const bad = await call("POST", P, {}, { ext: true, json: { transfer_behavior: "steal" } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ type: "parameter_error", param: "transfer_behavior" });
    expect((await call("POST", P, {}, { ext: true, json: { name: "" } })).status).toBe(400);
    // The list keeps RevenueCat's project shape.
    const list = await call("GET", "/v2/projects");
    expect(list.body.items[0].name).toBe("Scanner Pro");
  });

  it("the transfer behaviour decides who gets a receipt posted by a second app user id", async () => {
    const at = h.now().getTime();
    const tok1 = `test_${at}_${crypto.randomUUID()}`, tok2 = `test_${at}_${crypto.randomUUID()}`;
    // Default: transfer to the new app user id.
    expect((await post("alice", tok1)).status).toBe(200);
    const moved = await post("bob", tok1);
    expect(moved.status).toBe(200);
    expect(Object.keys((await moved.json()).subscriber.entitlements)).toContain("pro");
    // Keep with the original: the second user is refused.
    await call("POST", P, {}, { ext: true, json: { transfer_behavior: "keep" } });
    expect((await post("carol", tok2)).status).toBe(200);
    const kept = await post("dave", tok2);
    expect(kept.status).toBe(400);
    expect((await kept.json()).code).toBe(7102);
    // A separate sandbox behaviour wins for sandbox receipts (Test Store purchases are sandbox).
    await call("POST", P, {}, { ext: true, json: { sandbox_transfer_behavior: "transfer" } });
    expect((await post("dave", tok2)).status).toBe(200);
  });

  it("secret keys need project write permission; other projects are 404", async () => {
    const { key } = await createSecretKey(h.db, "proj1", "read only", ["project_configuration:projects:read"]);
    expect((await call("GET", P, {}, { ext: true, key })).status).toBe(200);
    expect((await call("POST", P, {}, { ext: true, key, json: { name: "x" } })).status).toBe(403);
    await otherProject(h);
    expect((await call("GET", P, { project_id: "projB" }, { ext: true })).status).toBe(404);
    expect((await call("POST", P, { project_id: "projB" }, { ext: true, json: { name: "mine" } })).status).toBe(404);
    const [b] = await h.db.select().from(schema.projects).where(eq(schema.projects.id, "projB"));
    expect(b!.name).toBe("Other");
  });

  it("DELETE removes the project and everything in it, only for a dashboard admin", async () => {
    expect((await call("DELETE", P, {}, { ext: true })).status).toBe(403);
    const cookie = await signup(h);
    const pid = (await call("GET", "/v2/projects", {}, { cookie })).body.items[0].id;
    await call("POST", `${P}/apps`, { project_id: pid }, { cookie, json: { name: "T", type: "test_store" } });
    const [m] = await h.db.select().from(schema.memberships).where(eq(schema.memberships.projectId, pid));
    await h.db.update(schema.memberships).set({ role: "viewer" }).where(eq(schema.memberships.userId, m!.userId));
    expect((await call("DELETE", P, { project_id: pid }, { cookie, ext: true })).status).toBe(403);
    await h.db.update(schema.memberships).set({ role: "admin" }).where(eq(schema.memberships.userId, m!.userId));
    const d = await call("DELETE", P, { project_id: pid }, { cookie, ext: true });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ object: "project", id: pid });
    expect(await h.db.select().from(schema.projects).where(eq(schema.projects.id, pid))).toHaveLength(0);
    expect(await h.db.select().from(schema.apps).where(eq(schema.apps.projectId, pid))).toHaveLength(0);
    expect((await call("GET", "/v2/projects", {}, { cookie })).body.items).toHaveLength(0);
  });
});

describe("collaborators", () => {
  it("lists project members in RevenueCat's collaborator shape", async () => {
    const cookie = await signup(h, "kai@example.com", "Mine");
    const pid = (await call("GET", "/v2/projects", {}, { cookie })).body.items[0].id;
    const r = await call("GET", `${P}/collaborators`, { project_id: pid }, { cookie });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([expect.objectContaining({ object: "collaborator", email: "kai@example.com", role: "admin", has_mfa: false })]);
    // The harness project has no members.
    expect((await call("GET", `${P}/collaborators`)).body.items).toEqual([]);
  });
});
