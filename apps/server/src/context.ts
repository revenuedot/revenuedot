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
  /**
   * Base64 of 32 bytes that seals integration and export credentials (services/secrets.ts); falls back to
   * REVENUEDOT_ENCRYPTION_KEY, then to a key derived from the signing key.
   */
  encryptionKey?: string;
  /** "cloud" on RevenueDot Cloud (Workers); self-hosted otherwise. Shown to dashboard users with their plan. */
  edition?: "cloud" | "self-hosted";
  /**
   * Who may create an account with POST /auth/signup. "owner_only": only the first account (the self-host default, set by
   * entry.node.ts unless REVENUEDOT_ALLOW_SIGNUP=true). Unset or "open": anyone. The cloud edition is always open.
   */
  signup?: "open" | "owner_only";
  /** Outgoing email (Cloudflare binding, SMTP, or the log driver when unset). See mail/index.ts. */
  mailer?: import("./mail/index.js").Mailer;
  /** Public dashboard origin for links in emails (REVENUEDOT_PUBLIC_URL). Unset: the origin of the request. */
  publicUrl?: string;
  /**
   * Runs work after the response (Workers: waitUntil on the request's connection; Node: fire and forget). Password
   * reset uses it so the answer takes the same time whether or not the account exists. Tests pass one they can await.
   */
  defer?: (task: () => Promise<unknown>) => void;
}

export type AppRecord = typeof schema.apps.$inferSelect;
export type Vars = { app: AppRecord; deps: Deps; auth: import("./services/auth.js").KeyAuth };
