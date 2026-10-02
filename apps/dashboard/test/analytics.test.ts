import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { goalFor, identifyUser, track, trackRequest } from "../src/lib/analytics";

describe("goalFor: the steps toward paying", () => {
  it("names a goal for each successful step", () => {
    expect(goalFor("POST", "/auth/signup")?.goal).toBe("signup_completed");
    expect(goalFor("POST", "/v2/projects")?.goal).toBe("project_created");
    expect(goalFor("POST", "/v2/projects/proj_1/apps")?.goal).toBe("app_created");
    expect(goalFor("POST", "/v2/projects/proj_1/api_keys")?.goal).toBe("api_key_created");
    expect(goalFor("POST", "/v2/projects/proj_1/products")?.goal).toBe("product_created");
    expect(goalFor("POST", "/v2/projects/proj_1/integrations/webhooks")?.goal).toBe("webhook_created");
    expect(goalFor("POST", "/v2/projects/proj_1/apps/app_1/stripe_connect/actions/finish")?.goal).toBe("stripe_connected");
    expect(goalFor("POST", "/v2/billing/checkout")).toEqual({ goal: "checkout_started", params: { plan: "standard" } });
  });
  it("a signup through an invite is not a new customer", () => {
    expect(goalFor("POST", "/auth/signup", { email: "a@b.co", invite_token: "tok" })?.goal).toBe("invite_signup_completed");
    expect(goalFor("POST", "/auth/signup", { email: "a@b.co", project_name: "x" })?.goal).toBe("signup_completed");
  });
  it("ignores reads, edits of existing things and unrelated writes", () => {
    expect(goalFor("GET", "/v2/projects")).toBeUndefined();
    expect(goalFor("POST", "/v2/projects/proj_1/integrations/webhooks/wh_1")).toBeUndefined();
    expect(goalFor("POST", "/v2/projects/proj_1/products/p1/actions/archive")).toBeUndefined();
    expect(goalFor("POST", "/auth/login")).toBeUndefined();
  });
  it("matches the path before the query string", () => {
    expect(goalFor("post", "/v2/projects?x=1")?.goal).toBe("project_created");
  });
  it("only uses goal names DataFast accepts and none of its reserved payment goals", () => {
    for (const p of ["/auth/signup", "/v2/projects", "/v2/billing/checkout", "/v2/billing/portal", "/v2/projects/p/test_purchases"]) {
      const g = goalFor("POST", p)!.goal;
      expect(g).toMatch(/^[a-z0-9_:-]{1,64}$/);
      expect(["payment", "free_trial", "trial_started", "trial_converted", "subscription_started", "subscription_upgraded", "subscription_downgraded", "subscription_renewed", "subscription_cancel_scheduled", "subscription_reactivated", "subscription_ended", "identify"]).not.toContain(g);
    }
  });
});

describe("sending to DataFast", () => {
  let calls: unknown[][];
  beforeEach(() => { calls = []; (globalThis as any).location = { hostname: "app.revenuedot.app" }; (globalThis as any).window = { datafast: (...a: unknown[]) => calls.push(a) }; });
  afterEach(() => { delete (globalThis as any).window; delete (globalThis as any).location; });

  it("track sends the goal with string parameters, and nothing when the script is absent or throws", () => {
    track("app_created");
    track("checkout_returned", { result: "success", n: 3 });
    expect(calls).toEqual([["app_created"], ["checkout_returned", { result: "success", n: "3" }]]);
    (globalThis as any).window = { datafast: () => { throw new Error("blocked"); } };
    expect(() => track("x")).not.toThrow();
    (globalThis as any).window = {};
    expect(() => track("x")).not.toThrow();
  });
  it("sends nothing from any other host, such as a self-hosted dashboard with its own DataFast snippet", () => {
    (globalThis as any).location = { hostname: "revenue.example.com" };
    track("app_created");
    identifyUser({ user: { email: "a@b.co", name: null, email_verified: true }, projects: [] });
    expect(calls).toEqual([]);
  });
  it("trackRequest records a goal only for the steps", () => {
    trackRequest("GET", "/auth/me");
    trackRequest("POST", "/v2/projects");
    expect(calls).toEqual([["project_created"]]);
  });
  it("identifyUser uses the email as user id, sends no project names, and repeats only when something changed", () => {
    const me = { user: { email: "founder@example.com", name: "Founder", email_verified: false }, account: { plan: "free" }, projects: [{ id: "p1", name: "Secret Name" }] };
    identifyUser(me);
    identifyUser(me);
    expect(calls).toEqual([["identify", { user_id: "founder@example.com", name: "Founder", plan: "free", projects: "1", email_verified: "false" }]]);
    identifyUser({ ...me, user: { ...me.user, email_verified: true } });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toContain("Secret Name");
  });
});
