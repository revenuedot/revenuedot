// Shared by the Worker entry (entry.worker.ts) and RevenueDot AI's Durable Object (assistant-agent.worker.ts): the
// Worker's bindings and the app dependencies built from them.
import { defaultStores } from "./stores/index.js";
import { cloudflareMailer, logMailer, type SendEmailBinding } from "./mail/index.js";
import { workersAiModel, type WorkersAi } from "./services/paywall-ai.js";
import { assistantModelFromEnv, workersAiAssistantModel, type WorkersAiBinding } from "./services/assistant/models.js";
import { capsFromEnv } from "./services/assistant/limits.js";
import type { Deps } from "./context.js";

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
  /** Optional secret: base64 of 32 bytes that seals integration and export credentials. Unset: derived from the signing key. */
  REVENUEDOT_ENCRYPTION_KEY?: string;
  /** Workers AI, for "Generate with AI" on paywalls. No key needed. */
  AI?: WorkersAi;
  /** Where hosted web pages live (prd/web-billing/PRD.md §7). Default https://api.revenuedot.app/pay until pay.revenuedot.app is routed here. */
  REVENUEDOT_PAY_URL?: string;
  /** The host custom domains CNAME to (the Cloudflare for SaaS fallback origin, docs/cloud.md). */
  REVENUEDOT_CUSTOM_DOMAIN_TARGET?: string;
  /** RevenueDot AI: one Cloudflare Agents Durable Object per conversation (assistant-agent.worker.ts, prd/ai-assistant/PRD.md). */
  AssistantAgent?: DurableObjectNamespaceLike;
  /** Optional secrets: a provider key makes RevenueDot AI use it instead of Workers AI. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  REVENUEDOT_ASSISTANT_MODEL?: string;
  /** JSON caps for RevenueDot AI (services/assistant/limits.ts). */
  REVENUEDOT_ASSISTANT_CAPS?: string;
}

export const mailerFor = (env: Env) => (env.EMAIL ? cloudflareMailer(env.EMAIL) : logMailer());
export const publicUrlFor = (env: Env) => env.REVENUEDOT_PUBLIC_URL || "https://app.revenuedot.app";


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
  signingKey: env.REVENUEDOT_SIGNING_KEY ?? "",
  encryptionKey: env.REVENUEDOT_ENCRYPTION_KEY,
  mailer: mailerFor(env),
  publicUrl: publicUrlFor(env),
  ai: env.AI ? workersAiModel(env.AI) : undefined,
  // Apps reach the API host; paywall images and icons are served from it.
  apiUrl: "https://api.revenuedot.app",
  payUrl: env.REVENUEDOT_PAY_URL || "https://api.revenuedot.app/pay",
  customDomainTarget: env.REVENUEDOT_CUSTOM_DOMAIN_TARGET || undefined,
  // RevenueDot AI: a provider key set as a secret wins; otherwise Workers AI (Kimi K2.6). Conversations run in Durable Objects.
  assistant: assistantModelFromEnv(env as unknown as Record<string, string | undefined>) ?? (env.AI ? workersAiAssistantModel(env.AI as unknown as WorkersAiBinding) : undefined),
  assistantRuntime: env.AssistantAgent ? "durable_object" : "sse",
  assistantCaps: capsFromEnv(env.REVENUEDOT_ASSISTANT_CAPS),
  destroyConversation: env.AssistantAgent ? async (id: string) => {
    const { getAgentByName } = await import("agents");
    const stub = await getAgentByName(env.AssistantAgent as never, id);
    // destroy() resets the Durable Object, which can break the RPC that asked for it; the row is already gone.
    await (stub as unknown as { destroy(): Promise<void> }).destroy().catch(() => {});
  } : undefined,
  };
}

