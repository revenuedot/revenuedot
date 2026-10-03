/**
 * The Vercel AI Gateway, shared by every AI feature: "Generate with AI" for paywalls, funnels' "Build with AI",
 * RevenueDot AI (the assistant and the Create with AI flows it runs) and the insights. With AI_GATEWAY_API_KEY set they
 * all use one model, `DEFAULT_AI_MODEL` with `DEFAULT_AI_REASONING` effort; without it each keeps its own fallbacks
 * (paywall-ai.ts, assistant/models.ts).
 * - Model: the feature's override (REVENUEDOT_PAYWALL_MODEL, REVENUEDOT_ASSISTANT_MODEL) when it is a gateway id
 *   (`provider/model`), else `DEFAULT_AI_MODEL`.
 * - Reasoning effort for OpenAI reasoning models: REVENUEDOT_AI_REASONING (REVENUEDOT_PAYWALL_REASONING for the paywall
 *   designer and funnels), else `DEFAULT_AI_REASONING`. It travels as `providerOptions.openai.reasoningEffort`, which the
 *   gateway forwards to OpenAI, set once on the model so every call (streamText, generateText) carries it.
 * Works on Cloudflare Workers and Node: the provider only uses `fetch`.
 */
import { createGateway } from "@ai-sdk/gateway";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

export const DEFAULT_AI_MODEL = "openai/gpt-6-luna";
export const DEFAULT_AI_REASONING = "medium";
export const GATEWAY_PROVIDER = "Vercel AI Gateway";

/** OpenAI models that reason: GPT-5 and later, and the o-series (optionally with a provider prefix such as `openai/`). */
export const isReasoningModel = (model: string) => /^(?:openai\/)?(?:gpt-[5-9]|o\d)/.test(model);

/** The gateway model id for a feature: its override when that is a gateway id, else the default. */
export function gatewayModelId(override: string | undefined, envName: string): string {
  const o = override?.trim();
  if (!o) return DEFAULT_AI_MODEL;
  if (o.includes("/")) return o;
  // A bare id (gpt-4.1-mini, claude-opus-5-5) is left over from a direct provider; the gateway needs provider/model.
  console.warn(`${envName} "${o}" is not an AI Gateway model id (provider/model); using ${DEFAULT_AI_MODEL}.`);
  return DEFAULT_AI_MODEL;
}

/** The reasoning effort: the first variable set among `names`, else `DEFAULT_AI_REASONING`. */
export function aiReasoning(env: Record<string, string | undefined>, ...names: string[]): string {
  for (const n of names) { const v = env[n]?.trim(); if (v) return v; }
  return DEFAULT_AI_REASONING;
}

/** A gateway language model with the reasoning effort set on every call (OpenAI reasoning models only). */
export function gatewayLanguageModel(apiKey: string, o: { model?: string; reasoning?: string; fetch?: typeof fetch } = {}): LanguageModel {
  const model = o.model ?? DEFAULT_AI_MODEL;
  const base = createGateway({ apiKey, ...(o.fetch ? { fetch: o.fetch } : {}) })(model);
  if (!isReasoningModel(model)) return base;
  return wrapLanguageModel({ model: base, middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { reasoningEffort: o.reasoning ?? DEFAULT_AI_REASONING } } } }) });
}
