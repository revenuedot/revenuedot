// RevenueDot Enterprise (ee/LICENSE). Single sign-on: SAML 2.0 and OpenID Connect. Spec: prd/enterprise/PRD.md §5.
import { Hono } from "hono";
import type { PasswordRefusal } from "../../../apps/server/src/extensions.js";
import type { EeCtx } from "../util.js";

export function ssoRoutes(_ctx: EeCtx) {
  return new Hono();
}

export async function ssoPasswordPolicy(_ctx: EeCtx, _email: string): Promise<PasswordRefusal | null> {
  return null;
}
