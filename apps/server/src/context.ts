import type { DB } from "@revenuedot/db";
import type { StoreAdapter } from "./stores/types.js";
import type { schema } from "@revenuedot/db";

export interface Deps {
  db: DB;
  now: () => Date;
  stores: Record<string, StoreAdapter>;
  /** Called after writes that may create webhook deliveries; the tick worker sends them. */
  kick?: () => void;
  /** Store-side subscription actions for the REST API (Google refund/revoke/defer/cancel, Apple extend). */
  storeActions?: Partial<Record<"revoke" | "defer" | "refund" | "cancel" | "extend", (a: { projectId: string; customerId: string; id: string; body: unknown; now: Date }) => Promise<void>>>;
  /** HTTP client for outbound calls (webhooks, stores); injectable for tests. */
  fetch?: typeof fetch;
}

export type AppRecord = typeof schema.apps.$inferSelect;
export type Vars = { app: AppRecord; deps: Deps; auth: import("./services/auth.js").KeyAuth };
