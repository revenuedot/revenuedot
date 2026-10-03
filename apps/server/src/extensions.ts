import type { Hono } from "hono";
import type { DB } from "@revenuedot/db";
import type { Deps } from "./context.js";

/**
 * Extension points: the only way code outside this file reaches the paid `ee/` folder (LICENSING.md, ee/README.md).
 *
 * A self-hosted server behaves exactly as it does without `ee/`: unless REVENUEDOT_LICENSE_KEY or REVENUEDOT_EE_DEV is
 * set, `loadExtensions` returns no extensions and never imports anything from `ee/`. RevenueDot Cloud always loads it:
 * there each organization's plan decides which features it has (Cloud Standard: organizations, custom roles, single
 * sign-on; Enterprise: all), so Free accounts see the features as locked rather than missing. Every hook below is optional and is
 * called only when an extension is loaded. This file is licensed under AGPL-3.0 with the rest of the core.
 */
export interface ServerExtension {
  readonly name: string;
  /** What the dashboard shows: licence state and the features that are on. */
  status(): ExtensionStatus;
  /**
   * Called once by createApp, after the SDK response-signing middleware and before every route, so an extension can
   * add its own middleware (it then runs for every request) and its own routes (they win over the core's).
   */
  mount?(app: Hono, deps: Deps): void;
  /**
   * A dashboard user's access to a project, after the core found their membership. May deny it (for example when the
   * project's organization requires single sign-on) or give the principal an explicit permission list (custom roles).
   * `sessionChecked`: the caller has no session but checked this one moments ago (the OAuth token exchange, after the
   * consent screen), so checks bound to the session are skipped.
   */
  projectAccess?(a: { deps: Deps; userId: string; sessionId: string | null; projectId: string; role: string; sessionChecked?: boolean }): Promise<ProjectAccess | null>;
  /** Password sign-in, sign-up and reset for an email address. A refusal stops them (enforced single sign-on). */
  passwordPolicy?(a: { deps: Deps; email: string }): Promise<PasswordRefusal | null>;
  /** Extra fields for GET /auth/config (signed out): for example that single sign-on is available. */
  config?(deps: Deps): Promise<Record<string, unknown>>;
  /** Extra fields for GET /auth/me. */
  me?(a: { deps: Deps; userId: string; sessionId: string | null }): Promise<Record<string, unknown>>;
  /**
   * Before an account is deleted (Account settings → General, prd/account-settings): a refusal stops it, for example
   * when the person is the last owner of an organization that still has members.
   */
  beforeAccountDelete?(a: { deps: Deps; userId: string }): Promise<{ message: string } | null>;
  /** Runs at the end of every tick (services/tick.ts). Errors are logged and never stop the tick. */
  tick?(db: DB, now: Date): Promise<Record<string, number> | void>;
}

export interface ExtensionStatus {
  /**
   * "licensed": a valid key; "development": REVENUEDOT_EE_DEV (development and testing only); "invalid": a key that failed;
   * "cloud": RevenueDot Cloud, where the account's plan decides (the hooks report each person's features).
   */
  mode: "licensed" | "development" | "invalid" | "cloud";
  features: string[];
  /** Who the licence is for, when it names someone. */
  licensee?: string | null;
  expires_at?: number | null;
  message?: string | null;
}

export interface ProjectAccess {
  deny?: { status: 403 | 404; message: string };
  /** Replaces the built-in role's scopes with these (same syntax as secret API key permissions). */
  permissions?: string[];
}

export interface PasswordRefusal {
  message: string;
  /** Where the sign-in page should send the person instead. */
  sso_url?: string;
}

type Env = Record<string, string | undefined>;

/**
 * True when the enterprise extension should load: always on RevenueDot Cloud (plans decide there), otherwise only when
 * the environment asks for it. The self-hosted default (neither variable set) is off.
 */
export function extensionsRequested(env: Env, edition?: "cloud" | "self-hosted"): boolean {
  return edition === "cloud" || !!env.REVENUEDOT_LICENSE_KEY?.trim() || env.REVENUEDOT_EE_DEV === "true";
}

/**
 * Loads the enterprise extension when the environment asks for it. The extension checks the licence key itself
 * (ee/server/license.ts). A missing `ee/` folder or a load error logs and returns none, so the server still starts.
 */
export async function loadExtensions(env: Env, o: { edition?: "cloud" | "self-hosted" } = {}): Promise<ServerExtension[]> {
  if (!extensionsRequested(env, o.edition)) return [];
  try {
    const m = (await import("../../../ee/server/index.js")) as { createEnterprise: (x: { env: Env; edition?: "cloud" | "self-hosted" }) => Promise<ServerExtension> };
    const ext = await m.createEnterprise({ env, edition: o.edition });
    const s = ext.status();
    console.log(`RevenueDot Enterprise: ${s.mode}${s.message ? ` (${s.message})` : ""}.`);
    return [ext];
  } catch (e) {
    console.error("RevenueDot Enterprise could not be loaded; running without it.", e);
    return [];
  }
}
