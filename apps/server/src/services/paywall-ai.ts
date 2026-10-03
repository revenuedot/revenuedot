/**
 * The language model behind "Generate with AI" for paywalls and funnels (prd/paywalls/PRD.md §3). One small interface,
 * four providers, picked in this order:
 * 1. AI_GATEWAY_API_KEY: Vercel AI Gateway through the AI SDK (ai-gateway.ts: `openai/gpt-6-luna`, medium reasoning,
 *    shared with every AI feature), structured output with the designer's strict JSON schema. Cloud and self-host alike.
 * 2. OPENAI_API_KEY: OpenAI GPT-6 Luna (`gpt-6-luna`) directly, Chat Completions with strict structured outputs.
 *    OPENAI_BASE_URL points it at a compatible gateway.
 * 3. Cloud without either key: the Workers AI binding `AI` with Kimi K2.6 (`@cf/moonshotai/kimi-k2.6`), forced function call.
 * 4. Self-host without either key: ANTHROPIC_API_KEY (Claude, forced tool call with the schema as its input).
 * REVENUEDOT_PAYWALL_MODEL overrides the model id (with the gateway only a gateway id such as `openai/gpt-6-sol` counts;
 * REVENUEDOT_AI_MODEL is its old name). REVENUEDOT_PAYWALL_REASONING (or REVENUEDOT_AI_REASONING) sets the reasoning
 * effort of reasoning models. With none configured the dashboard hides the button and the API
 * answers 503. Tests and the e2e server use `fakeModel` below.
 */
import { generateText, jsonSchema, Output, type LanguageModel } from "ai";
import { DEFAULT_AI_MODEL, GATEWAY_PROVIDER, aiReasoning, gatewayLanguageModel, gatewayModelId, isReasoningModel } from "./ai-gateway.js";
import { extractJson, type JsonModel } from "@revenuedot/core";

export interface PaywallModel extends JsonModel {
  /** Shown in the dashboard ("Draft from OpenAI · gpt-6-luna"). */
  provider: string;
  model: string;
  /** Free-text completion (funnels' "Build with AI"). */
  complete(system: string, user: string): Promise<string>;
}

/** The Workers AI binding's `run`, typed only as far as we use it. */
export interface WorkersAi { run(model: string, input: Record<string, unknown>, options?: unknown): Promise<unknown> }

/** Free-text output cap and how long one provider call may take before it fails. */
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 120_000;

export const GATEWAY_PAYWALL_MODEL = DEFAULT_AI_MODEL;
export const OPENAI_PAYWALL_MODEL = "gpt-6-luna";
export const WORKERS_AI_PAYWALL_MODEL = "@cf/moonshotai/kimi-k2.6";
export const ANTHROPIC_PAYWALL_MODEL = "claude-sonnet-4-5";

const signalOf = (s?: AbortSignal) => (s ? AbortSignal.any([s, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));
/** A JSON answer as text (or an already-parsed object) → the value; a refusal or a cut-off answer throws. */
function parseAnswer(text: unknown, who: string): unknown {
  if (text && typeof text === "object") return text;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${who} returned no answer.`);
  try { return JSON.parse(text); } catch { /* fenced or with prose: */ }
  const v = extractJson(text);
  if (v === null) throw new Error(`${who} did not answer with JSON.`);
  return v;
}
type Usage = { input: number; output: number };
const usageOf = (u: Record<string, number> | undefined): Usage | undefined => (u ? { input: u.prompt_tokens ?? u.input_tokens ?? 0, output: u.completion_tokens ?? u.output_tokens ?? 0 } : undefined);

/** Chat Completions message `content` and finish reason, from OpenAI or Workers AI (OpenAI-shaped answers). */
function chatChoice(body: unknown): { content: unknown; finish?: string; refusal?: string } {
  const b = body as { choices?: { message?: { content?: unknown; refusal?: string | null }; finish_reason?: string }[]; response?: unknown } | null;
  const ch = b?.choices?.[0];
  if (ch) return { content: ch.message?.content, finish: ch.finish_reason, refusal: ch.message?.refusal ?? undefined };
  return { content: b?.response };
}

export function workersAiModel(ai: WorkersAi, model = WORKERS_AI_PAYWALL_MODEL): PaywallModel {
  return {
    provider: "Workers AI", model,
    async complete(system, user) {
      // Kimi K2.6 thinks by default; funnels' free-text answer needs no long reasoning either.
      const r = await ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_completion_tokens: MAX_TOKENS, temperature: 0.4, reasoning_effort: "none" });
      const { content } = chatChoice(r);
      if (typeof content === "string" && content.trim()) return content;
      if (content && typeof content === "object") return JSON.stringify(content);
      throw new Error("Workers AI returned no answer.");
    },
    async json({ name, system, user, schema, maxTokens = 6000, signal }) {
      signal?.throwIfAborted();
      // A forced function call with the schema as its parameters. Workers AI's JSON schema mode decodes keys in
      // alphabetical order and loops on enum arrays (measured 2026-10-02 with Kimi K2.6); function calling does neither.
      const run = ai.run(model, {
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        tools: [{ type: "function", function: { name, description: "Submit the answer.", parameters: schema } }],
        tool_choice: { type: "function", function: { name } },
        max_completion_tokens: maxTokens, temperature: 0.6,
        // Kimi K2.6 thinks by default; a paywall needs no long reasoning and the dialog waits for it.
        reasoning_effort: "none",
      });
      const r = await (signal ? Promise.race([run, new Promise<never>((_, no) => signal.addEventListener("abort", () => no(new Error("Cancelled.")), { once: true }))]) : run);
      const b = r as { choices?: { message?: { tool_calls?: { function?: { arguments?: unknown } }[] } }[]; tool_calls?: { arguments?: unknown }[]; usage?: Record<string, number> };
      const args = b?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ?? b?.tool_calls?.[0]?.arguments;
      const { content, finish } = chatChoice(r);
      if (finish === "length") throw new Error("Workers AI ran out of output tokens before finishing the paywall.");
      return { value: parseAnswer(args ?? content, "Workers AI"), usage: usageOf(b?.usage) };
    },
  };
}

export interface OpenAiOptions {
  model?: string;
  baseUrl?: string;
  /** Reasoning effort (none, low, medium, high) for reasoning models; default low for them, never sent to others. */
  reasoning?: string;
  fetch?: typeof fetch;
}

export function openAiModel(apiKey: string, o: OpenAiOptions = {}): PaywallModel {
  const model = o.model ?? OPENAI_PAYWALL_MODEL, f = o.fetch ?? fetch, base = (o.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  // Only reasoning models (GPT-5 and later, o-series) take reasoning_effort and max_completion_tokens; older models and
  // many OpenAI-compatible servers reject them. An explicit REVENUEDOT_PAYWALL_REASONING is always sent.
  const reasons = !!o.reasoning || isReasoningModel(model);
  const reasoning = o.reasoning ?? "low";
  const cap = (n: number, extra: number) => (reasons ? { max_completion_tokens: n + extra } : { max_tokens: n });
  const call = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    const res = await f(`${base}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, signal: signalOf(signal), body: JSON.stringify({ model, ...body }),
    });
    const json = (await res.json().catch(() => null)) as { error?: { message?: string }; usage?: Record<string, number> } | null;
    if (!res.ok) throw new Error(`OpenAI answered ${res.status}: ${json?.error?.message ?? "no message"}`);
    return json;
  };
  return {
    provider: "OpenAI", model,
    async complete(system, user) {
      const body = await call({ ...cap(MAX_TOKENS, MAX_TOKENS * 3), response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
      const { content } = chatChoice(body);
      if (typeof content !== "string" || !content) throw new Error("OpenAI returned no answer.");
      return content;
    },
    async json({ name, system, user, schema, maxTokens = 6000, signal }) {
      // Reasoning tokens count against max_completion_tokens, so the cap leaves room for them.
      const body = await call({
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
        ...(reasons ? { reasoning_effort: reasoning } : {}), ...cap(maxTokens, 16_000),
      }, signal);
      const { content, finish, refusal } = chatChoice(body);
      if (refusal) throw new Error(`OpenAI refused: ${refusal}`);
      if (finish === "length") throw new Error("OpenAI ran out of output tokens before finishing the paywall.");
      return { value: parseAnswer(content, "OpenAI"), usage: usageOf(body?.usage) };
    },
  };
}

/**
 * A paywall model on any AI SDK language model: free text with `generateText`, JSON with `Output.object` and the
 * designer's JSON schema (OpenAI models get strict structured outputs). The reasoning effort comes with the language
 * model (ai-gateway.ts). The gateway model below uses it; tests pass a mock.
 */
export function aiSdkModel(languageModel: LanguageModel, provider: string, model: string): PaywallModel {
  const providerOptions = { openai: { strictJsonSchema: true } };
  return {
    provider, model,
    async complete(system, user) {
      const r = await generateText({ model: languageModel, system, prompt: user, maxOutputTokens: MAX_TOKENS * 4, abortSignal: signalOf() });
      if (!r.text.trim()) throw new Error(`${provider} returned no answer.`);
      return r.text;
    },
    async json({ name, system, user, schema, maxTokens = 6000, signal }) {
      // Reasoning tokens count against the output cap, so it leaves room for them.
      const r = await generateText({
        model: languageModel, system, prompt: user, maxOutputTokens: maxTokens + 16_000, providerOptions, abortSignal: signalOf(signal),
        output: Output.object({ schema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]), name }),
      });
      if (r.finishReason === "length") throw new Error(`${provider} ran out of output tokens before finishing the paywall.`);
      return { value: r.output, usage: { input: r.usage.inputTokens ?? 0, output: r.usage.outputTokens ?? 0 } };
    },
  };
}

/** Vercel AI Gateway (`model` is a gateway id such as `openai/gpt-6-luna`). `fetch` lets tests check requests offline. */
export function gatewayModel(apiKey: string, o: { model?: string; reasoning?: string; fetch?: typeof fetch } = {}): PaywallModel {
  const model = o.model ?? GATEWAY_PAYWALL_MODEL;
  return aiSdkModel(gatewayLanguageModel(apiKey, { model, reasoning: o.reasoning, fetch: o.fetch }), GATEWAY_PROVIDER, model);
}

export function anthropicModel(apiKey: string, model = ANTHROPIC_PAYWALL_MODEL, f: typeof fetch = fetch): PaywallModel {
  const call = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    const res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, signal: signalOf(signal), body: JSON.stringify({ model, ...body }),
    });
    const json = (await res.json().catch(() => null)) as { content?: { type: string; text?: string; input?: unknown }[]; stop_reason?: string; error?: { message?: string }; usage?: Record<string, number> } | null;
    if (!res.ok) throw new Error(`Anthropic answered ${res.status}: ${json?.error?.message ?? "no message"}`);
    return json;
  };
  return {
    provider: "Anthropic", model,
    async complete(system, user) {
      const body = await call({ max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content: user }] });
      const text = body?.content?.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (!text) throw new Error("Anthropic returned no answer.");
      return text;
    },
    async json({ name, system, user, schema, maxTokens = 6000, signal }) {
      // A forced tool call: the schema is the tool's input, so the answer is the tool's arguments.
      const body = await call({
        max_tokens: maxTokens, system, messages: [{ role: "user", content: user }],
        tools: [{ name, description: "Submit the answer.", input_schema: schema }], tool_choice: { type: "tool", name },
      }, signal);
      if (body?.stop_reason === "max_tokens") throw new Error("Anthropic ran out of output tokens before finishing the paywall.");
      const use = body?.content?.find((c) => c.type === "tool_use");
      if (!use) throw new Error("Anthropic returned no answer.");
      return { value: use.input, usage: usageOf(body?.usage) };
    },
  };
}

/**
 * The model for this server: the AI Gateway when AI_GATEWAY_API_KEY is set, else OpenAI when OPENAI_API_KEY is set, else
 * the Workers AI binding (Cloud), else Anthropic, else none. `fetch` lets tests check the requests without a provider.
 */
export function paywallModelFromEnv(env: Record<string, string | undefined>, o: { workersAi?: WorkersAi; fetch?: typeof fetch } = {}): PaywallModel | undefined {
  const override = env.REVENUEDOT_PAYWALL_MODEL?.trim() || env.REVENUEDOT_AI_MODEL?.trim() || undefined;
  const reasoning = env.REVENUEDOT_PAYWALL_REASONING?.trim() || env.REVENUEDOT_AI_REASONING?.trim() || undefined;
  const gateway = env.AI_GATEWAY_API_KEY?.trim();
  if (gateway) {
    return gatewayModel(gateway, {
      model: gatewayModelId(override, "REVENUEDOT_PAYWALL_MODEL"), reasoning: aiReasoning(env, "REVENUEDOT_PAYWALL_REASONING", "REVENUEDOT_AI_REASONING"), fetch: o.fetch,
    });
  }
  const openai = env.OPENAI_API_KEY?.trim();
  if (openai) return openAiModel(openai, { model: override, baseUrl: env.OPENAI_BASE_URL?.trim() || undefined, reasoning, fetch: o.fetch });
  if (o.workersAi) return workersAiModel(o.workersAi, override);
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) return anthropicModel(anthropic, override, o.fetch);
  return undefined;
}

/** A model that answers `answer` to every free-text and JSON call (tests). Records what it was asked. */
export function fakeModel(answer: string | ((system: string, user: string, name?: string) => string)): PaywallModel & { calls: { system: string; user: string; name?: string }[] } {
  const calls: { system: string; user: string; name?: string }[] = [];
  const say = (system: string, user: string, name?: string) => { calls.push({ system, user, ...(name ? { name } : {}) }); return typeof answer === "function" ? answer(system, user, name) : answer; };
  return {
    provider: "Fake", model: "fake-paywall-model", calls,
    async complete(system, user) { return say(system, user); },
    async json({ name, system, user, signal }) { signal?.throwIfAborted(); return { value: parseAnswer(say(system, user, name), "The fake model") }; },
  };
}

/**
 * Answers the AI designer's structured calls like a well-behaved model (tests, the e2e server): a brief that keeps the
 * offering's order, then a design titled `AI: <first 60 characters of the description>`. Translations are left empty.
 */
export function fakeDesignerAnswer(name: string | undefined, user: string): string {
  if (name === "paywall_brief") {
    const pkgs = [...user.matchAll(/^- (\$?[\w.-]+) "/gm)].map((m) => m[1]!);
    const order = pkgs.filter((p) => !/life/i.test(p)).slice(0, 2);
    return JSON.stringify({
      app_name: /App name \(from the form\): (.*)/.exec(user)?.[1] ?? "", locale: "en_US", extra_locales: [], tone: "calm, friendly",
      plans: { order, selected: order[0] ?? "", trial_packages: [], trial_days: 0, missing: [] },
      discount: { percent: 0, package_id: "", limited_time: false }, benefits: { count: 0, named: [] },
      look: { appearance: "light", gradient: false, colors: [], description: "" }, sections: [], facts: [],
    });
  }
  if (name === "paywall_translations") return JSON.stringify({ locales: [] });
  const ask = /^Brief: (.*)$/m.exec(user)?.[1]?.slice(0, 60) ?? "Go Pro";
  const brief = JSON.parse(/What the brief asks for \(read from it, follow it\): (.*)$/m.exec(user)?.[1] ?? "{}") as { app_name?: string; plans?: { order?: string[]; selected?: string } };
  const order = brief.plans?.order ?? [];
  const app = brief.app_name ? ` with ${brief.app_name}` : "";
  return JSON.stringify({
    name: "AI paywall", locale: "en_US",
    theme: {
      appearance: "light", background: { style: "solid", colors: ["#ffffff"], angle: 180 }, accent: "#111111", on_accent: "#ffffff", text: "#111111",
      secondary_text: "#52525b", card: "#f4f4f5", card_border: "#e4e4e7", corners: "soft", dark_mode: "adapt",
    },
    close_button: "leading", order: ["hero", "benefits", "plans"],
    hero: { art: "icon_glow", icon: "star", decoration: "none", eyebrow: "", title: `AI: ${ask}`, subtitle: `Everything you need${app}.`, align: "center" },
    benefits: { style: "list", title: "", items: [
      { icon: "check_circle", title: "Unlimited access", description: "" }, { icon: "lock", title: "No ads", description: "" }, { icon: "devices", title: "On all your devices", description: "" },
    ] },
    trial_timeline: null, social_proof: null, countdown: null, comparison: null, pages: null, note: null,
    plans: {
      layout: "list", title: "",
      items: order.map((p, i) => ({ package_id: p, title: p.replace(/^\$rc_/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), subtitle: "{{ product.price_per_period }}", trial_subtitle: "", badge: i === 0 && order.length > 1 ? "BEST VALUE" : "", trial: false })),
      selected: brief.plans?.selected ?? order[0] ?? "",
    },
    footer: { cta: "Continue", cta_trial: "", reassurance: "No commitment, cancel anytime.", disclosure: "{{ product.price_per_period }}, renews automatically. Cancel anytime.", disclosure_trial: "", restore: "Restore purchases" },
    notes: [],
  });
}
