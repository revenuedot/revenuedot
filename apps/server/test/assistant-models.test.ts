// RevenueDot AI's model choice (prd/ai-assistant/PRD.md §1). The provider's fetch is replaced, so no model is called.
import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { assistantModelFromEnv, workersAiAssistantModel } from "../src/services/assistant/models.js";
import { capsFromEnv, DEFAULT_CAPS } from "../src/services/assistant/limits.js";
import { gatewayLanguageModel } from "../src/services/ai-gateway.js";

describe("assistant models", () => {
  it("self-host: Anthropic (Claude Opus 5.5) first, then OpenAI (GPT-6 Astra), else none; REVENUEDOT_ASSISTANT_MODEL overrides", () => {
    expect(assistantModelFromEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toMatchObject({ provider: "Anthropic", model: "claude-opus-5-5" });
    expect(assistantModelFromEnv({ OPENAI_API_KEY: "o" })).toMatchObject({ provider: "OpenAI", model: "gpt-6-astra" });
    expect(assistantModelFromEnv({ OPENAI_API_KEY: "o", REVENUEDOT_ASSISTANT_MODEL: "gpt-6.1-sol" })?.model).toBe("gpt-6.1-sol");
    expect(assistantModelFromEnv({ ANTHROPIC_API_KEY: " " })).toBeUndefined();
  });

  it("AI_GATEWAY_API_KEY: GPT-6 Luna through the Vercel AI Gateway with medium reasoning, before every other provider", async () => {
    expect(assistantModelFromEnv({ AI_GATEWAY_API_KEY: "g", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toMatchObject({ provider: "Vercel AI Gateway", model: "openai/gpt-6-luna", vision: true });
    expect(assistantModelFromEnv({ AI_GATEWAY_API_KEY: "g", REVENUEDOT_ASSISTANT_MODEL: "openai/gpt-6-sol" })?.model).toBe("openai/gpt-6-sol");
    // A bare id from a direct provider is not a gateway id: the default stays.
    expect(assistantModelFromEnv({ AI_GATEWAY_API_KEY: "g", REVENUEDOT_ASSISTANT_MODEL: "claude-opus-5-5" })?.model).toBe("openai/gpt-6-luna");
    const reqs: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      reqs.push({ url, auth: new Headers(init.headers as HeadersInit).get("authorization"), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ error: { message: "test stops here", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    for (const [env, effort] of [[{}, "medium"], [{ REVENUEDOT_AI_REASONING: "high" }, "high"]] as const) {
      const m = assistantModelFromEnv({ AI_GATEWAY_API_KEY: "test-gateway-key", ...env }, f)!;
      const r = streamText({ model: m.languageModel, prompt: "hi", maxRetries: 0 });
      await r.consumeStream({ onError: () => {} });
      const req = reqs.at(-1)!;
      expect(new URL(req.url).host).toBe("ai-gateway.vercel.sh");
      expect(req.auth).toBe("Bearer test-gateway-key");
      expect(req.body).toMatchObject({ providerOptions: { openai: { reasoningEffort: effort } } });
    }
  });

  it("a call's own reasoning effort overrides the gateway model's default (the insights repair runs at low)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ error: { message: "test stops here", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const model = gatewayLanguageModel("test-gateway-key", { fetch: f });
    for (const call of [{}, { providerOptions: { openai: { reasoningEffort: "low" } } }]) {
      const r = streamText({ model, prompt: "hi", maxRetries: 0, ...call } as never) as unknown as { consumeStream(o: { onError: () => void }): Promise<void> };
      await r.consumeStream({ onError: () => {} });
    }
    expect(bodies.map((b) => (b as { providerOptions?: { openai?: { reasoningEffort?: string } } }).providerOptions?.openai?.reasoningEffort)).toEqual(["medium", "low"]);
  });

  it("the Anthropic request names the model and sends no temperature", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "test stops here" } }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const m = assistantModelFromEnv({ ANTHROPIC_API_KEY: "test-key" }, f)!;
    const r = streamText({ model: m.languageModel, instructions: "sys", prompt: "hi", maxRetries: 0 });
    await r.consumeStream({ onError: () => {} });
    expect(bodies[0]).toMatchObject({ model: "claude-opus-5-5", system: [{ type: "text", text: "sys" }] });
    expect(bodies[0]).not.toHaveProperty("temperature");
  });

  it("Cloud: Workers AI Kimi K2.6 through the binding", async () => {
    const runs: { model: string; input: Record<string, unknown> }[] = [];
    const m = workersAiAssistantModel({ run: async (model, input) => { runs.push({ model, input: input as Record<string, unknown> }); return { response: "hello", usage: { prompt_tokens: 1, completion_tokens: 1 } }; } });
    expect(m).toMatchObject({ provider: "Workers AI", model: "@cf/moonshotai/kimi-k2.6", vision: true });
    const r = streamText({ model: m.languageModel, prompt: "hi", maxRetries: 0 });
    await r.consumeStream({ onError: () => {} });
    expect(runs[0]!.model).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("caps come from REVENUEDOT_ASSISTANT_CAPS; bad JSON keeps the defaults", () => {
    expect(capsFromEnv('{"userTurnsPerDay": 5}')).toEqual({ ...DEFAULT_CAPS, userTurnsPerDay: 5 });
    expect(capsFromEnv("{oops")).toEqual(DEFAULT_CAPS);
  });
});
