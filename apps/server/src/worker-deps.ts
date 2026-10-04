// Shared by the Worker entry (entry.worker.ts) and RevenueDot AI's Durable Object (assistant-agent.worker.ts): the
// Worker's bindings and the app dependencies built from them.
import { defaultStores } from "./stores/index.js";
import { cloudflareMailer, logMailer, type SendEmailBinding } from "./mail/index.js";
import { paywallModelFromEnv, type WorkersAi } from "./services/paywall-ai.js";
import { assistantModelFromEnv, workersAiAssistantModel, type WorkersAiBinding } from "./services/assistant/models.js";
import { capsFromEnv } from "./services/assistant/limits.js";
import { fakeAssistantModel } from "./services/assistant/fake-model.js";
import type { Deps } from "./context.js";
import { stripeConnectFromEnv } from "./services/stripe-connect-config.js";
import { r2Store } from "./services/archive/store.js";
import { billingConfigFromEnv } from "./services/billing/stripe.js";

/** A Durable Object namespace, typed only as far as we use it (the shared tsconfig has no Workers types). */
export interface DurableObjectNamespaceLike { idFromName(name: string): unknown; get(id: unknown): unknown }

// Minimal Workers types, so the shared tsconfig (DOM lib) needs no @cloudflare/workers-types.
export interface Hyperdrive { connectionString: string }
export interface Fetcher { fetch(req: Request): Promise<Response> }
export interface ExecutionContext { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void; props: unknown }
export interface ScheduledController { scheduledTime: number; cron: string }

export interface Env {
  HYPERDRIVE: Hyperdrive;
  /** The built dashboard (apps/dashboard/dist), served with single-page-app fallback. */
  ASSETS: Fetcher;
  /** Secret. Base64 Ed25519 seed for response signing (Trusted Entitlements). Unset turns signing off. */
  REVENUEDOT_SIGNING_KEY?: string;
  /** Cloudflare Email Sending (`send_email` binding), sender no-reply@mail.revenuedot.app. Unset: emails go to the log. */
  EMAIL?: SendEmailBinding;
  /** Dashboard origin for links in emails; defaults to https://app.revenuedot.app. */
  REVENUEDOT_PUBLIC_URL?: string;
  /** The API host apps call; defaults to https://api.revenuedot.app. Local `cf dev` sets it to its own origin. */
  REVENUEDOT_API_URL?: string;
  /** Optional secret: base64 of 32 bytes that seals integration and export credentials. Unset: derived from the signing key. */
  REVENUEDOT_ENCRYPTION_KEY?: string;
  /** Workers AI, for "Generate with AI" on paywalls. No key needed. */
  AI?: WorkersAi;
  /** Optional secrets: the Google Cloud OAuth client for "Connect AdMob" (prd/ads/PRD.md). Unset: projects enter their own. */
  REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID?: string;
  REVENUEDOT_GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** Where hosted web pages live (prd/web-billing/PRD.md §7). Default https://api.revenuedot.app/pay until pay.revenuedot.app is routed here. */
  REVENUEDOT_PAY_URL?: string;
  /** The host custom domains CNAME to (the Cloudflare for SaaS fallback origin, docs/cloud.md). */
  REVENUEDOT_CUSTOM_DOMAIN_TARGET?: string;
  REVENUEDOT_CF_SAAS_ZONE_ID?: string;
  REVENUEDOT_CF_SAAS_API_TOKEN?: string;
  /** RevenueDot AI: one Cloudflare Agents Durable Object per conversation (assistant-agent.worker.ts, prd/ai-assistant/PRD.md). */
  AssistantAgent?: DurableObjectNamespaceLike;
  /**
   * Optional secrets: a provider key makes "Generate with AI" and RevenueDot AI use it instead of Workers AI.
   * AI_GATEWAY_API_KEY (Vercel AI Gateway) comes first.
   */
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  REVENUEDOT_ASSISTANT_MODEL?: string;
  /** JSON caps for RevenueDot AI (services/assistant/limits.ts). */
  REVENUEDOT_ASSISTANT_CAPS?: string;
  /** Secrets for "Connect with Stripe" (prd/web-billing/PRD.md §8), Kai's to add once the Connect platform exists. Unset: unavailable. */
  REVENUEDOT_STRIPE_CONNECT_CLIENT_ID?: string;
  REVENUEDOT_STRIPE_CONNECT_SECRET_KEY?: string;
  REVENUEDOT_STRIPE_CONNECT_TEST_SECRET_KEY?: string;
  REVENUEDOT_STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  /**
   * Optional R2 bucket for full-export archives (prd/moves-export/PRD.md). Unset: archives are kept in Postgres. Add the
   * binding in cloudflare.config.ts once the bucket exists (docs/cloud.md).
   */
  EXPORTS?: import("./services/archive/store.js").R2BucketLike;
  /** RevenueDot Cloud billing on RevenueDot's own Stripe account (prd/cloud-billing/PRD.md). Unset: billing is not set up. */
  REVENUEDOT_BILLING_STRIPE_SECRET_KEY?: string;
  REVENUEDOT_BILLING_STRIPE_WEBHOOK_SECRET?: string;
  REVENUEDOT_BILLING_PRICE_STANDARD?: string;
  REVENUEDOT_BILLING_METER_EVENT?: string;
  REVENUEDOT_BILLING_LIVE?: string;
  REVENUEDOT_BILLING_PLANS?: string;
  /** Local `cf dev` only: "1" answers with the scripted fake model, so the Durable Object runtime can be tried without a model call. Never set in production. */
  REVENUEDOT_ASSISTANT_FAKE?: string;
  /** Optional secret: the RevenueDot Enterprise licence key that turns on the `ee/` features (extensions.ts). Unset: off. */
  REVENUEDOT_LICENSE_KEY?: string;
  /** Data location (ee/server/region.ts): this deployment's region ("us" or "eu") and JSON of every region's API and dashboard origins. */
  REVENUEDOT_REGION?: string;
  REVENUEDOT_REGIONS?: string;
}

export const mailerFor = (env: Env) => (env.EMAIL ? cloudflareMailer(env.EMAIL) : logMailer());
export const publicUrlFor = (env: Env) => env.REVENUEDOT_PUBLIC_URL || "https://app.revenuedot.app";
export const stripeConnectFor = (env: Env) => stripeConnectFromEnv(env as unknown as Record<string, string | undefined>);
export const googleOAuthFor = (env: Env) => ({ clientId: env.REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID || undefined, clientSecret: env.REVENUEDOT_GOOGLE_OAUTH_CLIENT_SECRET || undefined });


export const stores = defaultStores();

/**
 * Everything the app needs except the database and the after-response hooks. The fetch handler adds the per-request
 * database; the RevenueDot AI Durable Object adds its own connection (assistant-agent.worker.ts).
 */
export function baseDeps(env: Env): Omit<Deps, "db"> {
  return {
  now: () => new Date(),
  stores,
  edition: "cloud",
  // Anonymized benchmarks and the weekly insights digest are Cloud features (prd/attribution-benchmarks-insights).
  benchmarks: true,
  insightsDigest: true,
  signingKey: env.REVENUEDOT_SIGNING_KEY ?? "",
  encryptionKey: env.REVENUEDOT_ENCRYPTION_KEY,
  mailer: mailerFor(env),
  publicUrl: publicUrlFor(env),
  // "Generate with AI": the AI Gateway when AI_GATEWAY_API_KEY is set, else OpenAI, else Workers AI (services/paywall-ai.ts).
  ai: paywallModelFromEnv(env as unknown as Record<string, string | undefined>, { workersAi: env.AI }),
  // Apps reach the API host; paywall images and icons are served from it.
  apiUrl: env.REVENUEDOT_API_URL || "https://api.revenuedot.app",
  googleOAuth: googleOAuthFor(env),
  stripeConnect: stripeConnectFor(env),
  payUrl: env.REVENUEDOT_PAY_URL || `${env.REVENUEDOT_API_URL || "https://api.revenuedot.app"}/pay`,
  customDomainTarget: env.REVENUEDOT_CUSTOM_DOMAIN_TARGET || undefined,
  cloudflareSaas: env.REVENUEDOT_CF_SAAS_ZONE_ID && env.REVENUEDOT_CF_SAAS_API_TOKEN ? { zoneId: env.REVENUEDOT_CF_SAAS_ZONE_ID, apiToken: env.REVENUEDOT_CF_SAAS_API_TOKEN } : undefined,
  // RevenueDot AI: a provider key set as a secret wins; otherwise Workers AI (Kimi K2.6). Conversations run in Durable Objects.
  assistant: env.REVENUEDOT_ASSISTANT_FAKE === "1" ? fakeAssistantModel(undefined, { delayMs: 20 })
    : assistantModelFromEnv(env as unknown as Record<string, string | undefined>) ?? (env.AI ? workersAiAssistantModel(env.AI as unknown as WorkersAiBinding) : undefined),
  assistantRuntime: env.AssistantAgent ? "durable_object" : "sse",
  assistantCaps: capsFromEnv(env.REVENUEDOT_ASSISTANT_CAPS),
  archiveStore: archiveStoreFor(env),
  billing: billingConfigFromEnv(env as unknown as Record<string, string | undefined>),
  destroyConversation: env.AssistantAgent ? async (id: string) => {
    const { getAgentByName } = await import("agents");
    const stub = await getAgentByName(env.AssistantAgent as never, id);
    // destroy() resets the Durable Object, which can break the RPC that asked for it; the row is already gone.
    await (stub as unknown as { destroy(): Promise<void> }).destroy().catch(() => {});
  } : undefined,
  };
}


/** R2 when the EXPORTS bucket is bound; otherwise undefined (the app keeps archives in Postgres, per request connection). */
export const archiveStoreFor = (env: Env) => (env.EXPORTS ? r2Store(env.EXPORTS) : undefined);
