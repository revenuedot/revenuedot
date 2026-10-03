import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

import { createOpenAI } from "@ai-sdk/openai";
import { createWorkersAI } from "workers-ai-provider";
import { DEFAULT_AI_MODEL, GATEWAY_PROVIDER, aiReasoning, gatewayLanguageModel, gatewayModelId } from "../ai-gateway.js";

/**
 * The model behind RevenueDot AI (prd/ai-assistant/PRD.md §1). The strongest tool-calling model each provider offered on
 * 2026-10-01, overridable with REVENUEDOT_ASSISTANT_MODEL:
 * - Cloud: Workers AI `@cf/moonshotai/kimi-k2.6` through the `AI` binding (1T parameters, 262k context, function calling
 *   and vision; no key, billed to the Circo account).
 * - AI_GATEWAY_API_KEY (Cloud or self-host) → Vercel AI Gateway with GPT-6 Luna (`openai/gpt-6-luna`, medium reasoning,
 *   REVENUEDOT_AI_REASONING to change it), the model every AI feature shares (ai-gateway.ts); the override must then be a
 *   gateway model id. It wins over every other provider, Workers AI on Cloud too; without it nothing below changes.
 * - Self-host: ANTHROPIC_API_KEY → Claude Opus 5.5 (`claude-opus-5-5`), else OPENAI_API_KEY → GPT-6 Astra (`gpt-6-astra`,
 *   OPENAI_BASE_URL for compatible gateways).
 * Without one the assistant is hidden. No temperature is sent (Opus 5.5 rejects it) and tool choice stays automatic.
 */
export interface AssistantModel {
  /** Shown in the dashboard ("Workers AI · @cf/moonshotai/kimi-k2.6"). */
  provider: string;
  model: string;
  languageModel: LanguageModel;
  /** Whether the model reads images (screenshots); without it image attachments are described as unreadable. */
  vision: boolean;
}

export const WORKERS_AI_ASSISTANT_MODEL = "@cf/moonshotai/kimi-k2.6";
export const ANTHROPIC_ASSISTANT_MODEL = "claude-opus-5-5";
export const OPENAI_ASSISTANT_MODEL = "gpt-6-astra";
export const GATEWAY_ASSISTANT_MODEL = DEFAULT_AI_MODEL;

/** The Workers AI binding, typed only as far as the provider needs (the shared tsconfig has no Workers types). */
export type WorkersAiBinding = { run(model: string, input: unknown, options?: unknown): Promise<unknown> };

export function workersAiAssistantModel(binding: WorkersAiBinding, model = WORKERS_AI_ASSISTANT_MODEL): AssistantModel {
  const workersai = createWorkersAI({ binding: binding as never });
  return { provider: "Workers AI", model, languageModel: workersai(model as never), vision: true };
}

/** The AI Gateway, then Anthropic, then OpenAI, else none. `f` lets tests check the requests without calling a provider. */
export function assistantModelFromEnv(env: Record<string, string | undefined>, f?: typeof fetch): AssistantModel | undefined {
  const override = env.REVENUEDOT_ASSISTANT_MODEL?.trim() || undefined;
  const gatewayKey = env.AI_GATEWAY_API_KEY?.trim();
  if (gatewayKey) {
    const model = gatewayModelId(override, "REVENUEDOT_ASSISTANT_MODEL");
    return { provider: GATEWAY_PROVIDER, model, languageModel: gatewayLanguageModel(gatewayKey, { model, reasoning: aiReasoning(env, "REVENUEDOT_AI_REASONING"), fetch: f }), vision: true };
  }
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    const model = override ?? ANTHROPIC_ASSISTANT_MODEL;
    return { provider: "Anthropic", model, languageModel: createAnthropic({ apiKey: anthropicKey, fetch: f })(model), vision: true };
  }
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    const model = override ?? OPENAI_ASSISTANT_MODEL;
    return { provider: "OpenAI", model, languageModel: createOpenAI({ apiKey: openaiKey, baseURL: env.OPENAI_BASE_URL?.trim() || undefined, fetch: f })(model), vision: true };
  }
  return undefined;
}
