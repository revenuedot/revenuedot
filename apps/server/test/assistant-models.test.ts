// RevenueDot AI's model choice (prd/ai-assistant/PRD.md §1). The provider's fetch is replaced, so no model is called.
import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { assistantModelFromEnv, workersAiAssistantModel } from "../src/services/assistant/models.js";
import { capsFromEnv, DEFAULT_CAPS } from "../src/services/assistant/limits.js";

describe("assistant models", () => {
  it("self-host: Anthropic (Claude Opus 5.5) first, then OpenAI (GPT-6 Astra), else none; REVENUEDOT_ASSISTANT_MODEL overrides", () => {
    expect(assistantModelFromEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toMatchObject({ provider: "Anthropic", model: "claude-opus-5-5" });
    expect(assistantModelFromEnv({ OPENAI_API_KEY: "o" })).toMatchObject({ provider: "OpenAI", model: "gpt-6-astra" });
    expect(assistantModelFromEnv({ OPENAI_API_KEY: "o", REVENUEDOT_ASSISTANT_MODEL: "gpt-6.1-sol" })?.model).toBe("gpt-6.1-sol");
    expect(assistantModelFromEnv({ ANTHROPIC_API_KEY: " " })).toBeUndefined();
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
