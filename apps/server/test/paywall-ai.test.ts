// The paywall AI's providers (services/paywall-ai.ts). Every provider's fetch or model is replaced: nothing is called.
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { aiSdkModel, anthropicModel, gatewayModel, openAiModel, paywallModelFromEnv, workersAiModel } from "../src/services/paywall-ai.js";

/** A fetch that records the request and answers `body` with `status`. */
const fakeFetch = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit; json: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, json: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
};
const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } };
/** An AI SDK model that answers `text` and records each call's options. */
const mockModel = (text: string, finish: "stop" | "length" = "stop") => {
  const calls: Record<string, unknown>[] = [];
  const m = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text }], finishReason: { unified: finish, raw: finish }, usage, warnings: [] };
    },
  });
  return { m, calls };
};

describe("paywall AI providers", () => {
  it("picks the AI Gateway, then OpenAI, then Workers AI, then Anthropic, else none", () => {
    const workersAi = { run: async () => ({}) };
    expect(paywallModelFromEnv({ AI_GATEWAY_API_KEY: "g", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, { workersAi }))
      .toMatchObject({ provider: "Vercel AI Gateway", model: "openai/gpt-6-luna" });
    expect(paywallModelFromEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, { workersAi })).toMatchObject({ provider: "OpenAI", model: "gpt-6-luna" });
    expect(paywallModelFromEnv({ ANTHROPIC_API_KEY: "a" }, { workersAi })).toMatchObject({ provider: "Workers AI", model: "@cf/moonshotai/kimi-k2.6" });
    expect(paywallModelFromEnv({ ANTHROPIC_API_KEY: "a" })).toMatchObject({ provider: "Anthropic" });
    expect(paywallModelFromEnv({ AI_GATEWAY_API_KEY: "  ", OPENAI_API_KEY: " " })).toBeUndefined();
  });

  it("REVENUEDOT_PAYWALL_MODEL overrides the model: a gateway model id with the gateway", () => {
    expect(paywallModelFromEnv({ AI_GATEWAY_API_KEY: "g", REVENUEDOT_PAYWALL_MODEL: "anthropic/claude-opus-5.5" })?.model).toBe("anthropic/claude-opus-5.5");
    // A bare id left over from a direct provider is not a gateway id: the gateway default stays.
    expect(paywallModelFromEnv({ AI_GATEWAY_API_KEY: "g", REVENUEDOT_AI_MODEL: "gpt-4.1-mini" })?.model).toBe("openai/gpt-6-luna");
    expect(paywallModelFromEnv({ ANTHROPIC_API_KEY: "a", REVENUEDOT_AI_MODEL: "m" })?.model).toBe("m");
  });

  it("AI Gateway: authenticates with the key and asks for the schema as structured output with medium reasoning", async () => {
    const { f, calls } = fakeFetch(400, { error: { message: "test stops here", type: "invalid_request_error" } });
    const m = paywallModelFromEnv({ AI_GATEWAY_API_KEY: "test-gateway-key" }, { fetch: f })!;
    await expect(m.json({ name: "paywall_brief", system: "sys", user: "u", schema: SCHEMA })).rejects.toThrow(/test stops here/);
    const h = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(new URL(calls[0]!.url).host).toBe("ai-gateway.vercel.sh");
    expect(h.get("authorization")).toBe("Bearer test-gateway-key");
    expect(h.get("ai-language-model-id")).toBe("openai/gpt-6-luna");
    expect(calls[0]!.json).toMatchObject({
      responseFormat: { type: "json", name: "paywall_brief", schema: SCHEMA },
      providerOptions: { openai: { reasoningEffort: "medium", strictJsonSchema: true } },
      prompt: [{ role: "system", content: "sys" }, { role: "user" }],
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(gatewayModel("k", { model: "openai/gpt-6-sol" })).toMatchObject({ provider: "Vercel AI Gateway", model: "openai/gpt-6-sol" });
    // REVENUEDOT_PAYWALL_REASONING changes the effort; funnels' free text carries it too.
    await expect(paywallModelFromEnv({ AI_GATEWAY_API_KEY: "k", REVENUEDOT_PAYWALL_REASONING: "low" }, { fetch: f })!.complete("s", "u")).rejects.toThrow();
    expect(calls.at(-1)!.json).toMatchObject({ providerOptions: { openai: { reasoningEffort: "low" } } });
  });

  it("AI SDK models: JSON answers become the value with usage; free text passes through", async () => {
    const { m, calls } = mockModel("{\"a\":\"x\"}");
    const model = aiSdkModel(m, "Vercel AI Gateway", "openai/gpt-6-luna");
    expect(await model.json({ name: "n", system: "s", user: "u", schema: SCHEMA, maxTokens: 100 })).toEqual({ value: { a: "x" }, usage: { input: 12, output: 7 } });
    expect(calls[0]).toMatchObject({ maxOutputTokens: 16_100, responseFormat: { type: "json", name: "n" } });
    expect(await aiSdkModel(mockModel("hello").m, "P", "m").complete("s", "u")).toBe("hello");
  });

  it("AI SDK models: a cut-off or non-JSON answer throws (the designer reports the step)", async () => {
    await expect(aiSdkModel(mockModel("{\"a\":\"x\"}", "length").m, "P", "m").json({ name: "n", system: "s", user: "u", schema: SCHEMA })).rejects.toThrow();
    await expect(aiSdkModel(mockModel("sorry").m, "P", "m").json({ name: "n", system: "s", user: "u", schema: SCHEMA })).rejects.toThrow();
    await expect(aiSdkModel(mockModel("  ").m, "P", "m").complete("s", "u")).rejects.toThrow(/no answer/);
  });

  it("OpenAI direct: strict JSON schema, reasoning effort, base URL", async () => {
    const { f, calls } = fakeFetch(200, { choices: [{ message: { content: "{\"a\":\"x\"}" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    const m = openAiModel("sk-test", { fetch: f, baseUrl: "https://llm.example.com/v1/" });
    expect(await m.json({ name: "n", system: "s", user: "u", schema: SCHEMA })).toEqual({ value: { a: "x" }, usage: { input: 3, output: 2 } });
    expect(calls[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(calls[0]!.json).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "low", response_format: { type: "json_schema", json_schema: { name: "n", strict: true, schema: SCHEMA } } });
    await expect(openAiModel("k", { fetch: fakeFetch(429, { error: { message: "slow down" } }).f }).complete("s", "u")).rejects.toThrow(/429: slow down/);
  });

  it("OpenAI direct: older models and compatible servers get max_tokens and no reasoning_effort", async () => {
    const answer = { choices: [{ message: { content: "{\"a\":\"x\"}" }, finish_reason: "stop" }] };
    const old = fakeFetch(200, answer);
    const m = paywallModelFromEnv({ OPENAI_API_KEY: "k", REVENUEDOT_AI_MODEL: "gpt-4.1-mini" }, { fetch: old.f })!;
    await m.json({ name: "n", system: "s", user: "u", schema: SCHEMA, maxTokens: 100 });
    await m.complete("s", "u");
    for (const c of old.calls) {
      expect(c.json).not.toHaveProperty("reasoning_effort");
      expect(c.json).not.toHaveProperty("max_completion_tokens");
    }
    expect(old.calls[0]!.json).toMatchObject({ model: "gpt-4.1-mini", max_tokens: 100 });
    // A reasoning model gets max_completion_tokens; free text never sends reasoning_effort.
    const luna = fakeFetch(200, answer);
    await openAiModel("k", { fetch: luna.f }).complete("s", "u");
    expect(luna.calls[0]!.json).toHaveProperty("max_completion_tokens");
    expect(luna.calls[0]!.json).not.toHaveProperty("reasoning_effort");
    // An explicit effort is always sent.
    const forced = fakeFetch(200, answer);
    await openAiModel("k", { fetch: forced.f, model: "local-llm", reasoning: "high" }).json({ name: "n", system: "s", user: "u", schema: SCHEMA });
    expect(forced.calls[0]!.json).toMatchObject({ reasoning_effort: "high" });
  });

  it("Anthropic: a forced tool call whose input is the answer", async () => {
    const { f, calls } = fakeFetch(200, { content: [{ type: "tool_use", input: { a: "x" } }], stop_reason: "tool_use" });
    expect((await anthropicModel("key", "claude-test", f).json({ name: "n", system: "s", user: "u", schema: SCHEMA })).value).toEqual({ a: "x" });
    expect(calls[0]!.json).toMatchObject({ model: "claude-test", tool_choice: { type: "tool", name: "n" }, tools: [{ name: "n", input_schema: SCHEMA }] });
    await expect(anthropicModel("k", undefined, fakeFetch(200, { content: [] }).f).complete("s", "u")).rejects.toThrow(/no answer/);
  });

  it("Workers AI: a forced function call; arguments as text or parsed", async () => {
    const inputs: Record<string, unknown>[] = [];
    const ai = (out: unknown) => ({ run: async (_m: string, input: Record<string, unknown>) => { inputs.push(input); return out; } });
    const r = await workersAiModel(ai({ choices: [{ message: { tool_calls: [{ function: { arguments: "{\"a\":\"x\"}" } }] }, finish_reason: "tool_calls" }] })).json({ name: "n", system: "s", user: "u", schema: SCHEMA });
    expect(r.value).toEqual({ a: "x" });
    expect(inputs[0]).toMatchObject({ tool_choice: { type: "function", function: { name: "n" } }, reasoning_effort: "none" });
    expect(await workersAiModel(ai({ response: { a: 1 } })).complete("s", "u")).toBe("{\"a\":1}");
    expect(inputs.at(-1)).toMatchObject({ reasoning_effort: "none" });
    expect((await workersAiModel(ai({ tool_calls: [{ arguments: { a: "y" } }] })).json({ name: "n", system: "s", user: "u", schema: SCHEMA })).value).toEqual({ a: "y" });
    await expect(workersAiModel(ai({ choices: [{ message: {}, finish_reason: "length" }] })).json({ name: "n", system: "s", user: "u", schema: SCHEMA })).rejects.toThrow(/output tokens/);
  });
});
