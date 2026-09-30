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
}

export type AppRecord = typeof schema.apps.$inferSelect;
export type Vars = { app: AppRecord; deps: Deps; auth: import("./services/auth.js").KeyAuth };
