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
  /**
   * Cloudflare for SaaS (REVENUEDOT_CF_SAAS_ZONE_ID and REVENUEDOT_CF_SAAS_API_TOKEN, a token with "SSL and Certificates:
   * Edit" on the zone): a verified Verified Metrics custom domain gets its custom hostname and certificate from the API.
   * Unset: the certificate is a manual step (docs/cloud.md); self-hosted servers need none.
   */
  cloudflareSaas?: { zoneId: string; apiToken: string };
  /**
   * The model behind RevenueDot AI (services/assistant/models.ts): Workers AI on Cloud, Anthropic or OpenAI on self-host.
   * Unset: the assistant is hidden and its routes answer 503.
   */
  assistant?: import("./services/assistant/models.js").AssistantModel;
  /** Where conversations run: "durable_object" (Cloud, one Agents Durable Object each) or "sse" (Postgres, the default). */
  assistantRuntime?: "durable_object" | "sse";
  /** Daily caps (REVENUEDOT_ASSISTANT_CAPS). Unset: services/assistant/limits.ts DEFAULT_CAPS. */
  assistantCaps?: import("./services/assistant/limits.js").AssistantCaps;
  /** Cloud: wipes a conversation's Durable Object after its row is deleted. */
  destroyConversation?: (conversationId: string) => Promise<void>;
  /**
   * RevenueDot's Stripe Connect platform for "Connect with Stripe" (REVENUEDOT_STRIPE_CONNECT_*; prd/web-billing/PRD.md §8).
   * Unset or incomplete: Connect is unavailable and developers paste a restricted key.
   */
  stripeConnect?: import("./services/stripe-connect-config.js").StripeConnectConfig;
  /**
   * Benchmarks (prd/attribution-benchmarks-insights §2): on only on RevenueDot Cloud (the Worker) and the e2e server. Off,
   * the benchmark endpoints answer `available: false`, the nightly job does nothing and no data is shared.
   */
  benchmarks?: boolean;
  /** Tests and the e2e server only: a lower k, smaller minimum samples (services/benchmarks.ts). Never set on Cloud. */
  benchmarkOptions?: import("./services/benchmarks.js").BenchmarkOptions;
  /** Generate and email the weekly AI growth insights digest (Cloud: always; self-host: REVENUEDOT_INSIGHTS_DIGEST=on). */
  insightsDigest?: boolean;
  /**
   * Where full-export archives are kept (prd/moves-export/PRD.md): R2 on Cloud, a folder or bucket on self-host. Unset:
   * Postgres (`archive_blobs`).
   */
  archiveStore?: import("./services/archive/store.js").ArchiveStore;
  /** Seconds a server-run move waits after pausing the source before the last copy (default 10; tests use 0). */
  moveDrainSeconds?: number;
  /** RevenueDot Cloud billing through RevenueDot's own Stripe account (prd/cloud-billing/PRD.md). Unset: not set up yet. */
  billing?: import("./services/billing/stripe.js").BillingConfig;
  /** The app's own fetch. Set by createApp; RevenueDot AI's tools call the REST API v2 through it in-process. */
  dispatch?: (req: Request) => Promise<Response>;
  /** Enterprise extensions (extensions.ts). Empty or unset in the open-source build. */
  extensions?: import("./extensions.js").ServerExtension[];
}

export type AppRecord = typeof schema.apps.$inferSelect;
export type Vars = { app: AppRecord; deps: Deps; auth: import("./services/auth.js").KeyAuth };
