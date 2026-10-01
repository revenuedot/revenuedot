/**
 * The language model behind "Generate with AI" (prd/paywalls/PRD.md §3). One small interface, three providers:
 * - Cloud: the Workers AI binding `AI` (no key; cloudflare.config.ts).
 * - Self-host: OPENAI_API_KEY or ANTHROPIC_API_KEY (REVENUEDOT_AI_MODEL picks the model), read by entry.node.ts.
 * - Tests and the e2e server: a fake that returns a fixed answer.
 * With none configured the dashboard hides the button and the API answers 503.
 */

export interface PaywallModel {
  /** Shown in the dashboard ("Workers AI · llama-3.3-70b"). */
  provider: string;
  model: string;
  complete(system: string, user: string): Promise<string>;
}

/** The Workers AI binding's `run`, typed only as far as we use it. */
export interface WorkersAi { run(model: string, input: { messages: { role: string; content: string }[]; max_tokens?: number; temperature?: number }): Promise<unknown> }

/** Output cap per call (cost) and how long a self-hosted provider may take before the request fails. */
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 90_000;

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function workersAiModel(ai: WorkersAi, model = WORKERS_AI_MODEL): PaywallModel {
  return {
    provider: "Workers AI", model,
    async complete(system, user) {
      const r = await ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: MAX_TOKENS, temperature: 0.4 });
      const o = r as { response?: unknown };
      // Newer models may return the parsed object when the answer is JSON.
      if (typeof o?.response === "string") return o.response;
      if (o?.response && typeof o.response === "object") return JSON.stringify(o.response);
      throw new Error("Workers AI returned no answer.");
    },
  };
}

export function openAiModel(apiKey: string, model = "gpt-4.1-mini", f: typeof fetch = fetch, baseUrl = "https://api.openai.com/v1"): PaywallModel {
  return {
    provider: "OpenAI", model,
    async complete(system, user) {
      const res = await f(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ model, max_tokens: MAX_TOKENS, temperature: 0.4, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
      if (!res.ok) throw new Error(`OpenAI answered ${res.status}: ${body?.error?.message ?? "no message"}`);
      const text = body?.choices?.[0]?.message?.content;
      if (!text) throw new Error("OpenAI returned no answer.");
      return text;
    },
  };
}

export function anthropicModel(apiKey: string, model = "claude-sonnet-4-5", f: typeof fetch = fetch): PaywallModel {
  return {
    provider: "Anthropic", model,
    async complete(system, user) {
      const res = await f("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ model, max_tokens: MAX_TOKENS, temperature: 0.4, system, messages: [{ role: "user", content: user }] }),
      });
      const body = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; error?: { message?: string } } | null;
      if (!res.ok) throw new Error(`Anthropic answered ${res.status}: ${body?.error?.message ?? "no message"}`);
      const text = body?.content?.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (!text) throw new Error("Anthropic returned no answer.");
      return text;
    },
  };
}

/** Self-host: the first configured provider in the environment, or none. */
export function modelFromEnv(env: Record<string, string | undefined>, f: typeof fetch = fetch): PaywallModel | undefined {
  const model = env.REVENUEDOT_AI_MODEL?.trim() || undefined;
  if (env.OPENAI_API_KEY?.trim()) return openAiModel(env.OPENAI_API_KEY.trim(), model, f, env.OPENAI_BASE_URL?.trim() || undefined);
  if (env.ANTHROPIC_API_KEY?.trim()) return anthropicModel(env.ANTHROPIC_API_KEY.trim(), model, f);
  return undefined;
}

/** A model that always answers `answer` (tests, the e2e server). Records what it was asked. */
export function fakeModel(answer: string | ((system: string, user: string) => string)): PaywallModel & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  return {
    provider: "Fake", model: "fake-paywall-model", calls,
    async complete(system, user) { calls.push({ system, user }); return typeof answer === "function" ? answer(system, user) : answer; },
  };
}
