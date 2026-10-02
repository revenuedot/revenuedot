// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the extension points (src/extensions.ts). Without an extension the server answers exactly as before; the
// hooks are exercised with a fake extension defined here (nothing is imported from ee/).
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { extensionsRequested, loadExtensions, type ServerExtension } from "../src/extensions.js";
import { tick } from "../src/services/tick.js";

type S = Awaited<ReturnType<typeof accountServer>>;
let s: S | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

describe("without extensions (the open-source build)", () => {
  it("loads nothing unless a licence key or development mode is set", async () => {
    expect(extensionsRequested({})).toBe(false);
    expect(extensionsRequested({ REVENUEDOT_LICENSE_KEY: "  " })).toBe(false);
    expect(extensionsRequested({ REVENUEDOT_EE_DEV: "1" })).toBe(false);
    expect(extensionsRequested({ REVENUEDOT_LICENSE_KEY: "rdl1_x.y" })).toBe(true);
    expect(await loadExtensions({})).toEqual([]);
  });

  it("answers as before: no enterprise fields, no enterprise routes", async () => {
    s = await accountServer();
    const o = await s.signup("owner@example.com");
    const config = (await s.client().call("GET", "/auth/config")).body;
    expect(Object.keys(config).sort()).toEqual(["edition", "signed_in", "signup"]);
    const me = (await o.browser.call("GET", "/auth/me")).body;
    expect(Object.keys(me).sort()).toEqual(["account", "projects", "user"]);
    expect((await o.browser.call("GET", "/v2/organizations")).status).toBe(404);
    expect((await o.browser.call("GET", "/v2/enterprise")).status).toBe(404);
    for (const path of ["/scim/v2/Users", "/sso/start?email=a@b.c"]) expect((await s.app.fetch(new Request(`http://localhost${path}`))).status).toBe(404);
    expect((await s.client().call("POST", "/auth/login", { email: "owner@example.com", password: "correct horse battery" })).status).toBe(200);
  });

  it("a role other than admin, developer or viewer gives no access", async () => {
    s = await accountServer();
    const o = await s.signup("owner@example.com");
    const other = await s.signup("other@example.com");
    await s.db.insert(schema.memberships).values({ userId: other.userId, projectId: o.projectId!, role: "role_unknown" });
    expect((await other.browser.call("GET", `/v2/projects/${o.projectId}/products`)).status).toBe(403);
    expect((await other.browser.call("GET", `/v2/projects/${o.projectId}/customers`)).status).toBe(403);
    // The collaborator list shows the stored role instead of calling it admin.
    const list = (await o.browser.call("GET", `/v2/projects/${o.projectId}/collaborators`)).body.items;
    expect(list.find((x: any) => x.id === other.userId).role).toBe("role_unknown");
  });
});

describe("extension hooks", () => {
  const calls: string[] = [];
  const fake: ServerExtension = {
    name: "fake",
    status: () => ({ mode: "development", features: ["x"] }),
    mount(app) {
      const r = new Hono();
      r.get("/v2/fake", (c) => c.json({ fake: true }));
      app.route("/", r);
    },
    async projectAccess(a) {
      calls.push(`access:${a.role}`);
      if (a.role === "blocked") return { deny: { status: 403, message: "Blocked by the extension." } };
      if (a.role === "products_only") return { permissions: ["project_configuration:products:read"] };
      return null;
    },
    async passwordPolicy(a) { return a.email.endsWith("@sso.example") ? { message: "Use SSO.", sso_url: "/sso/start" } : null; },
    async config() { return { sso: true }; },
    async me(a) { return { enterprise: { user: a.userId } }; },
    async tick() { return { fake_jobs: 1 }; },
  };

  it("mount, projectAccess, passwordPolicy, config, me and tick", async () => {
    s = await accountServer({ extensions: [fake] });
    const o = await s.signup("owner@example.com");
    expect((await o.browser.call("GET", "/v2/fake")).body).toEqual({ fake: true });
    expect((await s.client().call("GET", "/auth/config")).body.sso).toBe(true);
    expect((await o.browser.call("GET", "/auth/me")).body.enterprise).toEqual({ user: o.userId });
    const other = await s.signup("other@example.com");
    await s.db.insert(schema.memberships).values({ userId: other.userId, projectId: o.projectId!, role: "products_only" });
    expect((await other.browser.call("GET", `/v2/projects/${o.projectId}/products`)).status).toBe(200);
    expect((await other.browser.call("GET", `/v2/projects/${o.projectId}/customers`)).status).toBe(403);
    await s.db.update(schema.memberships).set({ role: "blocked" }).where(and(eq(schema.memberships.userId, other.userId), eq(schema.memberships.projectId, o.projectId!)));
    const denied = await other.browser.call("GET", `/v2/projects/${o.projectId}/products`);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe("Blocked by the extension.");
    expect((await o.browser.call("GET", `/v2/projects/${o.projectId}/products`)).status).toBe(200);
    expect(calls).toContain("access:admin");
    const login = await s.client().call("POST", "/auth/login", { email: "x@sso.example", password: "whatever1" });
    expect(login.status).toBe(403);
    expect(login.body).toEqual({ type: "sso_required", message: "Use SSO.", sso_url: "/sso/start" });
    expect((await s.client().call("POST", "/auth/signup", { email: "y@sso.example", password: "long enough" })).body.type).toBe("sso_required");
    const r = await tick(s.db, s.now(), fetch, { extensions: [fake] });
    expect(r.extensions).toEqual({ fake_jobs: 1 });
    expect("extensions" in (await tick(s.db, s.now(), fetch, {}))).toBe(false);
  });
});
