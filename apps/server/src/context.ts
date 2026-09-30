import type { DB } from "@revenuedot/db";
import type { StoreAdapter } from "./stores/types.js";
import type { schema } from "@revenuedot/db";

export interface Deps {
  db: DB;
  now: () => Date;
  stores: Record<string, StoreAdapter>;
  /** Called after writes that may create webhook deliveries; the tick worker sends them. */
  kick?: () => void;
  /** HTTP client for outbound calls (webhooks, stores); injectable for tests. */
  fetch?: typeof fetch;
  /**
   * Keeps work that runs after the response alive (Workers: the request's waitUntil). Unset on Node, where a promise
   * runs on its own. Tests pass a collector and await it.
   */
  background?: (task: Promise<unknown>) => void;
  /** Base64 Ed25519 seed for response signing; falls back to REVENUEDOT_SIGNING_KEY. "" turns signing off. */
  signingKey?: string;
  /** "cloud" on RevenueDot Cloud (Workers); self-hosted otherwise. Shown to dashboard users with their plan. */
  edition?: "cloud" | "self-hosted";
  /**
   * Who may create an account with POST /auth/signup. "owner_only": only the first account (the self-host default, set by
   * entry.node.ts unless REVENUEDOT_ALLOW_SIGNUP=true). Unset or "open": anyone. The cloud edition is always open.
   */
  signup?: "open" | "owner_only";
}

export type AppRecord = typeof schema.apps.$inferSelect;
export type Vars = { app: AppRecord; deps: Deps; auth: import("./services/auth.js").KeyAuth };
