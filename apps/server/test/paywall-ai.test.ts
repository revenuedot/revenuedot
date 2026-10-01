import { describe, expect, it } from "vitest";
import { anthropicModel, modelFromEnv, openAiModel, workersAiModel } from "../src/services/paywall-ai.js";

/** A fetch that records the request and answers `body` with `status`. */
const fakeFetch = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit; json: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, json: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe("paywall AI providers", () => {
  it("OpenAI: caps the output, times out, asks for JSON and reads the answer", async () => {
    const { f, calls } = fakeFetch(200, { choices: [{ message: { content: "{\"a\":1}" } }] });
    expect(await openAiModel("sk-test", undefined, f, "https://llm.example.com/v1").complete("sys", "user")).toBe("{\"a\":1}");
    expect(calls[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(calls[0]!.json).toMatchObject({ model: "gpt-4.1-mini", max_tokens: 4096, response_format: { type: "json_object" } });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("Anthropic: caps the output, times out and joins the text blocks", async () => {
    const { f, calls } = fakeFetch(200, { content: [{ type: "text", text: "{\"a\"" }, { type: "text", text: ":1}" }] });
    expect(await anthropicModel("key", "claude-test", f).complete("sys", "user")).toBe("{\"a\":1}");
    expect(calls[0]!.json).toMatchObject({ model: "claude-test", max_tokens: 4096, system: "sys" });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("provider errors throw with the status (the route answers 502)", async () => {
    await expect(openAiModel("k", undefined, fakeFetch(429, { error: { message: "slow down" } }).f).complete("s", "u")).rejects.toThrow(/429: slow down/);
    await expect(anthropicModel("k", undefined, fakeFetch(200, { content: [] }).f).complete("s", "u")).rejects.toThrow(/no answer/);
  });

  it("Workers AI: caps the output and accepts a string or an already-parsed answer", async () => {
    const inputs: unknown[] = [];
    const ai = (response: unknown) => ({ run: async (_m: string, input: unknown) => { inputs.push(input); return { response }; } });
    expect(await workersAiModel(ai("{}")).complete("s", "u")).toBe("{}");
    expect(await workersAiModel(ai({ a: 1 })).complete("s", "u")).toBe("{\"a\":1}");
    expect(inputs[0]).toMatchObject({ max_tokens: 4096 });
    await expect(workersAiModel(ai(undefined)).complete("s", "u")).rejects.toThrow();
  });

  it("self-host picks OpenAI, then Anthropic, else none", () => {
    expect(modelFromEnv({ OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" })?.provider).toBe("OpenAI");
    expect(modelFromEnv({ ANTHROPIC_API_KEY: "b", REVENUEDOT_AI_MODEL: "m" })).toMatchObject({ provider: "Anthropic", model: "m" });
    expect(modelFromEnv({ OPENAI_API_KEY: "  " })).toBeUndefined();
  });
});
