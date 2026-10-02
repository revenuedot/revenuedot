// RevenueDot Enterprise (ee/LICENSE). SCIM 2.0 provisioning (RFC 7643, RFC 7644). Spec: prd/enterprise/PRD.md §6.
import { Hono } from "hono";
import type { EeCtx } from "../util.js";

export function scimRoutes(_ctx: EeCtx) {
  return new Hono();
}
