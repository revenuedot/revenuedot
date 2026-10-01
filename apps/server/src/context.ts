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
  /**
   * The language model for "Generate with AI" on paywalls (services/paywall-ai.ts): Workers AI on Cloud, OpenAI or
   * Anthropic on self-host when a key is set. Unset: the generator is off.
   */
  ai?: import("./services/paywall-ai.js").PaywallModel;
  /**
   * The origin apps talk to (REVENUEDOT_API_URL; Cloud: https://api.revenuedot.app). Paywall asset and icon URLs use it, so
   * a paywall edited on the dashboard host still loads its images from the API host. Unset: the request's origin.
   */
  apiUrl?: string;
  /**
   * The Google Cloud OAuth client for "Connect AdMob" (REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID and _SECRET). Unset: each
   * project can enter its own client on the AdMob page (services/ads/admob.ts).
   */
  googleOAuth?: { clientId?: string; clientSecret?: string };
  /**
   * Where hosted web pages live (prd/web-billing/PRD.md §7): REVENUEDOT_PAY_URL, such as https://pay.revenuedot.app (pages at
   * the root of that host) or https://api.example.com/pay. Unset: `<request origin>/pay`.
   */
  payUrl?: string;
  /** The host custom domains must CNAME to (REVENUEDOT_CUSTOM_DOMAIN_TARGET). Unset: the pay host. */
  customDomainTarget?: string;
}

export type AppRecord = typeof schema.apps.$inferSelect;
export type Vars = { app: AppRecord; deps: Deps; auth: import("./services/auth.js").KeyAuth };
