import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { withDashboardRoot } from "../src/node-dashboard.js";

// The self-hosted server (entry.node.ts) serves the API and the dashboard on one origin. Opening its address in a
// browser used to show the API's JSON instead of the sign-in page (found by the dashboard-ui journey).
describe("self-host: the server's root address", () => {
  const api = new Hono();
  api.get("/", (c) => c.json({ name: "RevenueDot" }));
  api.get("/v1/health", (c) => c.json({ ok: true }));
  const fetch = withDashboardRoot(api.fetch, "<!doctype html><div id=root></div>");

  it("gives a browser the dashboard", async () => {
    const res = await fetch(new Request("http://localhost:8787/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain('<div id=root>');
  });

  it("keeps the JSON for API clients and leaves every other path to the app", async () => {
    expect(await (await fetch(new Request("http://localhost:8787/", { headers: { accept: "application/json" } }))).json()).toEqual({ name: "RevenueDot" });
    expect(await (await fetch(new Request("http://localhost:8787/"))).json()).toEqual({ name: "RevenueDot" });
    expect(await (await fetch(new Request("http://localhost:8787/v1/health", { headers: { accept: "text/html" } }))).json()).toEqual({ ok: true });
    expect((await fetch(new Request("http://localhost:8787/", { method: "POST", headers: { accept: "text/html" } }))).status).toBe(404);
  });
});
