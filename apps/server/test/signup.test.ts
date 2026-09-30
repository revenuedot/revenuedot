// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: who may sign up. Self-hosted servers take only their owner's account unless REVENUEDOT_ALLOW_SIGNUP=true.
// Docs: https://revenuedot.app/docs/self-hosting
import { afterEach, describe, expect, it } from "vitest";
import { openDb, schema } from "@revenuedot/db";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/context.js";
import { defaultStores } from "../src/stores/index.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function server(over: Partial<Deps>) {
  const o = await openDb("pglite://memory");
  close = o.close;
  const app = createApp({ db: o.db, now: () => new Date("2026-09-30T12:00:00Z"), stores: defaultStores(), ...over });
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined }));
    return { status: res.status, body: await res.json() as any, cookie: res.headers.get("set-cookie") };
  };
  const signup = (email: string) => call("POST", "/auth/signup", { email, password: "correct horse battery", project_name: "Scanner" });
  return { db: o.db, call, signup };
}

describe("sign-up on a self-hosted server (owner_only, the default of the Node entry)", () => {
  it("takes the first account, then refuses new ones with 403 while the owner can still sign in", async () => {
    const s = await server({ signup: "owner_only" });
    expect((await s.call("GET", "/auth/config")).body).toEqual({ edition: "self-hosted", signup: "open" });
    const owner = await s.signup("owner@example.com");
    expect(owner.status).toBe(201);
    expect((await s.call("GET", "/auth/config")).body).toEqual({ edition: "self-hosted", signup: "closed" });

    const second = await s.signup("stranger@example.com");
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ type: "signup_closed", message: expect.stringContaining("REVENUEDOT_ALLOW_SIGNUP=true") });
    expect(second.cookie).toBeNull();
    expect((await s.db.select().from(schema.users)).map((u) => u.email)).toEqual(["owner@example.com"]);

    expect((await s.call("POST", "/auth/login", { email: "owner@example.com", password: "correct horse battery" })).status).toBe(200);
  });

  it("REVENUEDOT_ALLOW_SIGNUP=true (signup: open) and the cloud edition take anyone", async () => {
    const open = await server({ signup: "open" });
    expect((await open.signup("a@example.com")).status).toBe(201);
    expect((await open.signup("b@example.com")).status).toBe(201);
    expect((await open.call("GET", "/auth/config")).body.signup).toBe("open");
    await close!(); close = undefined;

    const cloud = await server({ edition: "cloud", signup: "owner_only" });
    expect((await cloud.signup("a@example.com")).status).toBe(201);
    expect((await cloud.signup("b@example.com")).status).toBe(201);
    expect((await cloud.call("GET", "/auth/config")).body).toEqual({ edition: "cloud", signup: "open" });
  });
});
