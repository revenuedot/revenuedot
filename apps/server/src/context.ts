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
  /** Base64 Ed25519 seed for response signing; falls back to REVENUEDOT_SIGNING_KEY. "" turns signing off. */
  signingKey?: string;
  /** "cloud" on RevenueDot Cloud (Workers); self-hosted otherwise. Shown to dashboard users with their plan. */
  edition?: "cloud" | "self-hosted";
}

export type AppRecord = typeof schema.apps.$inferSelect;
export type Vars = { app: AppRecord; deps: Deps; auth: import("./services/auth.js").KeyAuth };
