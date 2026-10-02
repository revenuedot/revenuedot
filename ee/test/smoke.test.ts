import { afterEach, expect, it } from "vitest";
import { eeServer, type EeServer } from "./helpers.js";
let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });
it("creates an organization and moves a project in", async () => {
  s = await eeServer();
  const o = await s.signup("owner@acme.test");
  const orgId = await s.createOrg(o.browser, "Acme", [o.projectId]);
  const r = await o.browser.call("GET", `/v2/organizations/${orgId}`);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ name: "Acme", your_role: "owner", project_count: 1, seats: { used: 1 } });
  const me = await o.browser.call("GET", "/auth/me");
  expect(me.body.enterprise).toMatchObject({ mode: "development", organizations: [{ id: orgId, role: "owner" }] });
});
