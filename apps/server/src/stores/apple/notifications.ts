import { Hono } from "hono";
import type { Deps } from "../../context.js";

export function appleNotificationRoutes(_deps: Deps) {
  const r = new Hono();
  r.post("/:appId", (c) => c.json({ status: "not implemented" }, 501));
  return r;
}
