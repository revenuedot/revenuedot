// Overview across projects (GET /v2/overview, GET /v2/overview/transactions): sums, roles, custom roles and denials
// from extensions, project_ids, pagination, and who may call it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { ServerExtension } from "../src/extensions.js";
import { createSecretKey } from "../src/services/auth.js";
import { sumHistories } from "../src/routes/v2/account-overview.js";
import { accountServer } from "./account-helpers.js";

type Server = Awaited<ReturnType<typeof accountServer>>;
const DAY = 86400_000;
// Project "custom" has a custom role without the Overview scope; project "sso" is closed by enforced single sign-on.
const ext: ServerExtension = {
  name: "test-access",
  async projectAccess({ projectId }: { projectId: string }) {
    if (projectId === "proj_custom") return { permissions: ["customer_information:purchases:read"] };
    if (projectId === "proj_sso") return { deny: { status: 403, message: "This organization requires single sign-on." } };
    return null;
  },
} as ServerExtension;

let s: Server;
beforeEach(async () => { s = await accountServer({ extensions: [ext] }); });
afterEach(async () => { await s.close(); });

async function project(id: string, name: string, userId: string, role: string) {
  await s.db.insert(schema.projects).values({ id, name, createdAt: new Date(s.now().getTime() - DAY) });
  await s.db.insert(schema.memberships).values({ userId, projectId: id, role });
}
/** A customer first seen `daysAgo`, with one paid purchase of `usd` (sandbox when asked). */
async function sale(projectId: string, user: string, usd: number, daysAgo: number, sandbox = false) {
  const at = new Date(s.now().getTime() - daysAgo * DAY);
  const id = `${projectId}_${user}`;
  await s.db.insert(schema.customers).values({ id, projectId, originalAppUserId: user, firstSeen: at, lastSeen: at });
  await s.db.insert(schema.transactions).values({
    id: `tx_${id}`, projectId, customerId: id, appId: null, store: "test_store", storeTransactionId: `st_${id}`, productIdentifier: "pro_monthly",
    kind: "purchase", isSandbox: sandbox, purchasedAt: at, expiresAt: new Date(at.getTime() + 30 * DAY), revenueUsd: usd,
  });
}
const metric = (body: any, id: string) => body.metrics.find((m: any) => m.id === id);

describe("GET /v2/overview", () => {
  it("sums every project the user may read, and says which ones are left out and why", async () => {
    const a = await s.signup("owner@example.com");
    const own = a.projectId!;
    await project("proj_view", "Viewer project", a.userId, "viewer");
    await project("proj_custom", "Custom role", a.userId, "developer");
    await project("proj_sso", "SSO only", a.userId, "admin");
    // Someone else's project never counts.
    const b = await s.signup("other@example.com");
    await sale(own, "u1", 9.99, 2);
    await sale(own, "u2", 4.99, 40);
    await sale("proj_view", "v1", 19.99, 3);
    await sale("proj_view", "v2", 2.5, 1, true);
    await sale("proj_custom", "c1", 100, 1);
    await sale("proj_sso", "s1", 100, 1);
    await sale(b.projectId!, "x1", 1000, 1);

    const r = await a.browser.call("GET", "/v2/overview");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "account_overview", currency: "USD", environment: "production", days: 28 });
    // Oldest project first (the three added here are a day older than the signup project).
    expect(r.body.projects).toEqual([
      { id: "proj_custom", name: "Custom role", included: false, reason: expect.stringContaining("role") },
      { id: "proj_sso", name: "SSO only", included: false, reason: "This organization requires single sign-on." },
      { id: "proj_view", name: "Viewer project", included: true },
      { id: own, name: "Scanner", included: true },
    ]);
    expect(r.body.projects.map((p: any) => p.id)).not.toContain(b.projectId);
    // Revenue in the last 28 days: 9.99 (own) + 19.99 (viewer); 4.99 is 40 days old, sandbox and other projects do not count.
    expect(metric(r.body, "revenue").value).toBe(29.98);
    expect(metric(r.body, "revenue").history).toMatchObject({ days: 28, value: 29.98, previous_value: 4.99 });
    expect(metric(r.body, "new_customers").value).toBe(3);
    expect(metric(r.body, "active_users").history.values).toBeNull();
    // Each card equals the sum of the projects' own Overview.
    for (const id of [own, "proj_view"]) {
      const one = await a.browser.call("GET", `/v2/projects/${id}/metrics/overview`);
      expect(one.status).toBe(200);
    }
    const ownRev = (await a.browser.call("GET", `/v2/projects/${own}/metrics/overview`)).body.metrics.find((m: any) => m.id === "revenue").value;
    const viewRev = (await a.browser.call("GET", `/v2/projects/proj_view/metrics/overview`)).body.metrics.find((m: any) => m.id === "revenue").value;
    expect(ownRev + viewRev).toBeCloseTo(29.98, 2);

    // Sandbox data and another period.
    const sb = await a.browser.call("GET", "/v2/overview?environment=sandbox&days=7");
    expect(metric(sb.body, "revenue").history.value).toBe(2.5);
    expect(metric(sb.body, "revenue").history.values).toHaveLength(7);
    // project_ids narrows; ids the user cannot open are ignored.
    const one = await a.browser.call("GET", `/v2/overview?project_ids=proj_view,${b.projectId},nope`);
    expect(one.body.projects).toEqual([{ id: "proj_view", name: "Viewer project", included: true }]);
    expect(metric(one.body, "revenue").value).toBe(19.99);
    // Removed from the project: it is gone from the list and the sums, and its id is ignored.
    await s.db.delete(schema.memberships).where(and(eq(schema.memberships.userId, a.userId), eq(schema.memberships.projectId, "proj_view")));
    const after = await a.browser.call("GET", "/v2/overview");
    expect(after.body.projects.map((p: any) => p.id)).not.toContain("proj_view");
    expect(metric(after.body, "revenue").value).toBe(9.99);
    expect((await a.browser.call("GET", "/v2/overview?project_ids=proj_view")).body.projects).toEqual([]);
    expect((await a.browser.call("GET", "/v2/overview/transactions?starting_after=tx_proj_view_v1")).body.param).toBe("starting_after");
  });

  it("validates its parameters and refuses API keys and signed-out calls", async () => {
    const a = await s.signup("owner@example.com");
    expect((await a.browser.call("GET", "/v2/overview?environment=staging")).body).toMatchObject({ type: "parameter_error", param: "environment" });
    expect((await a.browser.call("GET", "/v2/overview?days=0")).body.param).toBe("days");
    expect((await a.browser.call("GET", "/v2/overview?currency=EUR")).body.param).toBe("currency");
    const { key } = await createSecretKey(s.db, a.projectId!, "all", ["*"]);
    const k = await s.client().call("GET", "/v2/overview", undefined, { authorization: `Bearer ${key}` });
    expect(k.status).toBe(403);
    expect(k.body.message).toContain("dashboard session");
    expect((await s.client().call("GET", "/v2/overview")).status).toBe(401);
    // No project at all: zeros, no error.
    const lone = await s.signup("lone@example.com", { project_name: undefined });
    const z = await lone.browser.call("GET", "/v2/overview");
    expect(z.status).toBe(200);
    expect(metric(z.body, "mrr").value).toBe(0);
  });
});

describe("GET /v2/overview/transactions", () => {
  it("lists transactions of every readable project, newest first, with the project id and pages across projects", async () => {
    const a = await s.signup("owner@example.com");
    const own = a.projectId!;
    await project("proj_view", "Viewer project", a.userId, "viewer");
    await project("proj_custom", "Custom role", a.userId, "developer");
    await project("proj_sso", "SSO only", a.userId, "admin");
    await sale(own, "u1", 9.99, 3);
    await sale("proj_view", "v1", 19.99, 2);
    await sale("proj_custom", "c1", 5, 1);
    await sale("proj_sso", "s1", 100, 0.5);
    await sale(own, "sb", 1, 0.1, true);
    const r = await a.browser.call("GET", "/v2/overview/transactions?limit=2");
    expect(r.status).toBe(200);
    // The custom role may read purchases, so its project counts here (not on the cards); single sign-on keeps one out.
    expect(r.body.items.map((t: any) => [t.project_id, t.customer_id])).toEqual([["proj_custom", "c1"], ["proj_view", "v1"]]);
    expect(r.body.projects.find((p: any) => p.id === "proj_sso")).toMatchObject({ included: false });
    expect(r.body.next_page).toContain("starting_after=");
    const next = await a.browser.call("GET", r.body.next_page);
    expect(next.body.items.map((t: any) => t.customer_id)).toEqual(["u1"]);
    expect(next.body.next_page).toBeNull();
    const sb = await a.browser.call("GET", "/v2/overview/transactions?environment=sandbox");
    expect(sb.body.items.map((t: any) => t.customer_id)).toEqual(["sb"]);
    expect((await a.browser.call("GET", "/v2/overview/transactions?starting_after=tx_nope")).body.param).toBe("starting_after");
  });
});

describe("sumHistories", () => {
  it("adds values per date, keeps previous values only when every project has one, and drops series any project lacks", () => {
    const h = sumHistories("mrr", [
      { metric: "mrr", value: 10.005, previous_value: 5, values: [{ date: "2026-09-29", value: 4 }, { date: "2026-09-30", value: 10.005 }] },
      { metric: "mrr", value: 2.1, previous_value: 1, values: [{ date: "2026-09-29", value: 1 }, { date: "2026-09-30", value: 2.1 }] },
    ]);
    expect(h).toEqual({ metric: "mrr", value: 12.11, previous_value: 6, values: [{ date: "2026-09-29", value: 5 }, { date: "2026-09-30", value: 12.11 }] });
    expect(sumHistories("active_users", [{ metric: "active_users", value: 3, previous_value: null, values: null }, { metric: "active_users", value: 2, previous_value: null, values: null }]))
      .toEqual({ metric: "active_users", value: 5, previous_value: null, values: null });
    expect(sumHistories("revenue", [])).toEqual({ metric: "revenue", value: 0, previous_value: null, values: null });
  });
});
