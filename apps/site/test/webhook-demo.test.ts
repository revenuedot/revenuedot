import { describe, expect, it } from "vitest";
import worker from "../worker/index";

const call = (method: string) => worker.fetch(new Request("https://revenuedot.app/review/webhook-demo", { method, body: method === "POST" ? "{}" : undefined }), { ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } } as never);

describe("/review/webhook-demo", () => {
  it("answers 200 to a webhook delivery", async () => {
    const res = await call("POST");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("answers 405 to anything but POST", async () => {
    expect((await call("GET")).status).toBe(405);
  });
});
