// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: team invites and project members (prd/account-email/PRD.md).
// Docs: https://revenuedot.app/docs/guides/team
import { afterEach, describe, expect, it } from "vitest";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { createSecretKey } from "../src/services/auth.js";

type S = Awaited<ReturnType<typeof accountServer>>;
let s: S | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

async function owner(over: Parameters<typeof accountServer>[0] = {}) {
  s = await accountServer(over);
  const o = await s.signup("owner@example.com");
  const P = `/v2/projects/${o.projectId}`;
  return { ...o, P, s };
}

describe("invites", () => {
  it("an admin invites by email; a new person creates an account from the link and joins with the role", async () => {
    const { browser, P, projectId, s } = await owner({ signup: "owner_only" });
    const inv = await browser.call("POST", `${P}/invites`, { email: " New.Dev@Example.com", role: "developer" });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ object: "invite", email: "new.dev@example.com", role: "developer", status: "pending", email_sent: true });
    const { token, message } = s.linkIn("new.dev@example.com", "/invite?token=");
    expect(message.subject).toBe("owner invited you to Scanner on RevenueDot");
    expect(message.text).toContain("Developer: apps, catalog, customers and integrations");

    const guest = s.client();
    const info = await guest.call("GET", `/auth/invites/${encodeURIComponent(token)}`);
    expect(info.body).toMatchObject({ email: "new.dev@example.com", role: "developer", project: { id: projectId, name: "Scanner" }, invited_by: { email: "owner@example.com" }, account_exists: false });

    // Sign-up is closed on this self-hosted server, but the invite opens it for this address only.
    expect((await s.client().call("POST", "/auth/signup", { email: "stranger@example.com", password: "12345678" })).status).toBe(403);
    expect((await guest.call("POST", "/auth/signup", { email: "other@example.com", password: "long enough", invite_token: token })).body.type).toBe("invite_email_mismatch");
    const created = await guest.call("POST", "/auth/signup", { email: "new.dev@example.com", password: "long enough", name: "Dev", invite_token: token });
    expect(created.status).toBe(201);
    expect(created.body.project_id).toBe(projectId);
    const me = (await guest.call("GET", "/auth/me")).body;
    expect(me.projects).toEqual([expect.objectContaining({ id: projectId, role: "developer" })]);
    expect(me.user.email_verified).toBe(true);
    // The link works once.
    expect((await s.client().call("GET", `/auth/invites/${encodeURIComponent(token)}`)).body.reason).toBe("accepted");
    expect((await browser.call("GET", `${P}/invites`)).body.items).toEqual([]);
    const collab = (await browser.call("GET", `${P}/collaborators`)).body.items;
    expect(collab.map((x: any) => [x.email, x.role])).toEqual([["owner@example.com", "admin"], ["new.dev@example.com", "developer"]]);
  });

  it("an existing user accepts while signed in with the invited address, not another", async () => {
    const { browser, P, projectId, s } = await owner();
    const other = await s.signup("kim@example.com");
    const wrong = await s.signup("lee@example.com");
    await browser.call("POST", `${P}/invites`, { email: "kim@example.com", role: "viewer" });
    const { token } = s.linkIn("kim@example.com", "/invite?token=");
    expect((await s.client().call("GET", `/auth/invites/${token}`)).body.account_exists).toBe(true);
    expect((await s.client().call("POST", `/auth/invites/${token}/accept`)).status).toBe(401);
    const denied = await wrong.browser.call("POST", `/auth/invites/${token}/accept`);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("kim@example.com");
    // Signing up again with the invited address is a 409 that says to sign in.
    expect((await s.client().call("POST", "/auth/signup", { email: "kim@example.com", password: "long enough", invite_token: token })).status).toBe(409);
    const ok = await other.browser.call("POST", `/auth/invites/${token}/accept`);
    expect(ok.body).toEqual({ ok: true, project_id: projectId });
    const projects = (await other.browser.call("GET", "/auth/me")).body.projects;
    expect(projects.find((p: any) => p.id === projectId).role).toBe("viewer");
    expect((await other.browser.call("POST", `/auth/invites/${token}/accept`)).status).toBe(404);
  });

  it("resend makes a new link (the old one stops working); revoke ends it; expired invites stay listed", async () => {
    const { browser, P, s } = await owner();
    const inv = (await browser.call("POST", `${P}/invites`, { email: "max@example.com", role: "viewer" })).body;
    const old = s.linkIn("max@example.com", "/invite?token=").token;
    // Inviting the same address again refreshes the same invite with the new role.
    const again = (await browser.call("POST", `${P}/invites`, { email: "max@example.com", role: "admin" })).body;
    expect(again.id).toBe(inv.id);
    expect(again.role).toBe("admin");
    expect((await s.client().call("GET", `/auth/invites/${old}`)).body.reason).toBe("invalid");
    const second = s.linkIn("max@example.com", "/invite?token=").token;
    const r = await browser.call("POST", `${P}/invites/${inv.id}/actions/resend`);
    expect(r.status).toBe(200);
    expect((await s.client().call("GET", `/auth/invites/${second}`)).status).toBe(404);
    const third = s.linkIn("max@example.com", "/invite?token=").token;
    expect((await s.client().call("GET", `/auth/invites/${third}`)).status).toBe(200);

    s.advance(8 * 86400_000);
    expect((await s.client().call("GET", `/auth/invites/${third}`)).body.reason).toBe("expired");
    expect((await browser.call("GET", `${P}/invites`)).body.items).toEqual([expect.objectContaining({ id: inv.id, status: "expired" })]);
    await browser.call("POST", `${P}/invites/${inv.id}/actions/resend`);
    const fourth = s.linkIn("max@example.com", "/invite?token=").token;
    expect((await s.client().call("GET", `/auth/invites/${fourth}`)).status).toBe(200);

    expect((await browser.call("DELETE", `${P}/invites/${inv.id}`)).status).toBe(200);
    expect((await s.client().call("GET", `/auth/invites/${fourth}`)).body.reason).toBe("revoked");
    expect((await browser.call("GET", `${P}/invites`)).body.items).toEqual([]);
    expect((await browser.call("DELETE", `${P}/invites/${inv.id}`)).status).toBe(404);
  });

  it("refuses members already in the project, bad input, other projects and secret API keys", async () => {
    const { browser, P, projectId, s } = await owner();
    expect((await browser.call("POST", `${P}/invites`, { email: "owner@example.com", role: "viewer" })).status).toBe(409);
    expect((await browser.call("POST", `${P}/invites`, { email: "nope", role: "viewer" })).status).toBe(400);
    expect((await browser.call("POST", `${P}/invites`, { email: "a@example.com", role: "owner" })).status).toBe(400);
    const other = await s.signup("zed@example.com");
    expect((await other.browser.call("POST", `${P}/invites`, { email: "a@example.com", role: "viewer" })).status).toBe(404);
    const { key } = await createSecretKey(s.db, projectId!, "ci");
    expect((await s.client().call("POST", `${P}/invites`, { email: "a@example.com", role: "viewer" }, { authorization: `Bearer ${key}` })).status).toBe(403);
    expect((await s.client().call("GET", `${P}/invites`, undefined, { authorization: `Bearer ${key}` })).status).toBe(403);
  });

  it("limits a project to 50 invites a day", async () => {
    const { browser, P, s } = await owner();
    for (let i = 0; i < 50; i++) expect((await browser.call("POST", `${P}/invites`, { email: `p${i}@example.com`, role: "viewer" })).status).toBe(201);
    expect((await browser.call("POST", `${P}/invites`, { email: "p50@example.com", role: "viewer" })).status).toBe(429);
    s.advance(86400_000 + 1);
    expect((await browser.call("POST", `${P}/invites`, { email: "p50@example.com", role: "viewer" })).status).toBe(201);
  }, 60_000);
});

describe("members and roles", () => {
  async function team() {
    const o = await owner();
    const join = async (email: string, role: string) => {
      await o.browser.call("POST", `${o.P}/invites`, { email, role });
      const b = o.s.client();
      await b.call("POST", "/auth/signup", { email, password: "long enough", invite_token: o.s.linkIn(email, "/invite?token=").token });
      return { browser: b, userId: (await b.call("GET", "/auth/me")).body.user.id as string };
    };
    return { ...o, dev: await join("dev@example.com", "developer"), viewer: await join("view@example.com", "viewer") };
  }

  it("developers edit the project but cannot create secret keys, invite or manage members; viewers only read", async () => {
    const { P, dev, viewer, userId } = await team();
    expect((await dev.browser.call("POST", P, { name: "Scanner 2" })).status).toBe(200);
    expect((await dev.browser.call("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" })).status).toBe(201);
    const key = await dev.browser.call("POST", `${P}/api_keys`, { name: "x" });
    expect(key.status).toBe(403);
    expect(key.body.message).toContain("Your role in this project (developer)");
    expect((await dev.browser.call("GET", `${P}/api_keys`)).status).toBe(200);
    expect((await dev.browser.call("POST", `${P}/invites`, { email: "q@example.com", role: "viewer" })).status).toBe(403);
    expect((await dev.browser.call("POST", `${P}/collaborators/${userId}`, { role: "viewer" })).status).toBe(403);
    expect((await dev.browser.call("DELETE", P)).status).toBe(403);
    expect((await viewer.browser.call("GET", `${P}/collaborators`)).status).toBe(200);
    expect((await viewer.browser.call("POST", P, { name: "nope" })).status).toBe(403);
    expect((await viewer.browser.call("GET", `${P}/invites`)).status).toBe(200);
  });

  it("admins change roles and remove members; the last admin stays; anyone can leave", async () => {
    const { browser, P, dev, viewer, userId, s } = await team();
    const promoted = await browser.call("POST", `${P}/collaborators/${dev.userId}`, { role: "admin" });
    expect(promoted.body).toMatchObject({ object: "collaborator", id: dev.userId, role: "admin", email: "dev@example.com" });
    expect((await dev.browser.call("POST", `${P}/api_keys`, { name: "now allowed" })).status).toBe(201);
    // Two admins: the owner can step down, then the last admin cannot.
    expect((await browser.call("POST", `${P}/collaborators/${userId}`, { role: "viewer" })).status).toBe(200);
    const last = await dev.browser.call("POST", `${P}/collaborators/${dev.userId}`, { role: "developer" });
    expect(last.status).toBe(400);
    expect(last.body.message).toContain("at least one admin");
    expect((await dev.browser.call("DELETE", `${P}/collaborators/${dev.userId}`)).status).toBe(422);
    // An admin removes a member; the member loses access at once.
    expect((await dev.browser.call("DELETE", `${P}/collaborators/${viewer.userId}`)).status).toBe(200);
    expect((await viewer.browser.call("GET", P)).status).toBe(404);
    // A non-admin can leave but not remove others.
    expect((await browser.call("DELETE", `${P}/collaborators/${dev.userId}`)).status).toBe(403);
    expect((await browser.call("DELETE", `${P}/collaborators/${userId}`)).status).toBe(200);
    expect((await browser.call("GET", P)).status).toBe(404);
    expect((await dev.browser.call("DELETE", `${P}/collaborators/usr_nobody`)).status).toBe(404);
    const rows = await s.db.select().from(schema.memberships);
    expect(rows.map((m) => [m.userId === dev.userId, m.role])).toEqual([[true, "admin"]]);
  });
});
