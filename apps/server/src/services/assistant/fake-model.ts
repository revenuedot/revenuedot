import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AssistantModel } from "./models.js";

/**
 * A scripted language model for tests and the e2e server: no network, deterministic answers, real AI SDK streaming
 * (text deltas, tool calls, usage). `script` decides each step from the prompt; the default script below covers the
 * e2e flows (overview question → get-metrics, "grant pro to <user>" → an approval, a tool result → a summary).
 */
export type FakeStep = { text: string } | { toolCalls: { toolName: string; input: Record<string, unknown> }[]; text?: string } | { error: string };
export type FakeScript = (ctx: { prompt: LanguageModelV4CallOptions["prompt"]; tools: string[]; lastUserText: string; lastToolResults: { toolName: string; output: unknown }[] }) => FakeStep;

type Prompt = LanguageModelV4CallOptions["prompt"];

function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role === "user") return m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
  }
  return "";
}

/** Tool results of the trailing tool message (what the last step's tools returned), or none when the user spoke last. */
function trailingToolResults(prompt: Prompt): { toolName: string; output: unknown }[] {
  const last = prompt[prompt.length - 1];
  if (!last || last.role !== "tool") return [];
  return last.content.filter((p) => p.type === "tool-result").map((p) => {
    const r = p as { toolName: string; output: { type: string; value?: unknown; reason?: string } };
    return { toolName: r.toolName, output: r.output.type === "execution-denied" ? { denied: true, reason: r.output.reason } : r.output.value ?? r.output };
  });
}

const money = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : String(v));

/** The default script: enough intelligence for the demo flows, nothing more. */
export const defaultScript: FakeScript = ({ prompt, tools, lastUserText: text, lastToolResults }) => {
  const sys = prompt.find((m) => m.role === "system");
  const base = /\/projects\/[A-Za-z0-9_]+/.exec(typeof sys?.content === "string" ? sys.content : "")?.[0] ?? "";
  if (lastToolResults.length) {
    const r = lastToolResults[0]!;
    const out = r.output as Record<string, any>;
    if (out?.denied) return { text: "OK, I did not change anything." };
    if (typeof out === "string" || out?.error) return { text: `That did not work: ${typeof out === "string" ? out : out.error}` };
    if (r.toolName === "get-metrics" && Array.isArray(out?.metrics)) {
      const by = Object.fromEntries(out.metrics.map((m: { id: string; value: number }) => [m.id, m.value]));
      return { text: `**MRR is ${money(by.mrr)}** with ${by.active_subscriptions ?? 0} active subscriptions and ${by.active_trials ?? 0} trials. Revenue in the last 28 days was ${money(by.revenue)}.\n\n- New customers (28 days): ${by.new_customers ?? 0}\n- Active customers (28 days): ${by.active_users ?? 0}\n\nSee the [MRR chart](${base}/charts/mrr) for the trend.` };
    }
    if (r.toolName === "grant-customer-entitlement") return { text: `Done. The customer has the entitlement until ${out?.entitlements?.active?.[0]?.expires_at ? new Date(out.entitlements.active[0].expires_at).toDateString() : "the date you chose"}.` };
    if (r.toolName === "get-project-health") return { text: `Setup health: ${out?.apps?.length ?? 0} apps checked, webhooks delivered ${out?.webhooks?.delivered_percent_24h ?? "n/a"}% in the last 24 hours.` };
    return { text: `${r.toolName} returned ${JSON.stringify(out).slice(0, 200)}` };
  }
  const t = text.toLowerCase();
  const has = (name: string) => tools.includes(name);
  const grant = /grant\s+(\w+)\s+(?:to|for)\s+([\w.@:-]+)/i.exec(text);
  if (grant) {
    if (!has("grant-customer-entitlement")) return { text: "I can't change anything in this project: RevenueDot AI is read only here." };
    return { text: "I'll grant it for 7 days once you approve.", toolCalls: [{ toolName: "grant-customer-entitlement", input: { customer_id: grant[2]!, entitlement_id: grant[1]!.toLowerCase(), expires_at: "7d" } }] };
  }
  if (/(revenue|mrr|insight|growth|doing|subscri)/.test(t) && has("get-metrics")) return { toolCalls: [{ toolName: "get-metrics", input: {} }] };
  if (/(health|webhook|notification)/.test(t) && has("get-project-health")) return { toolCalls: [{ toolName: "get-project-health", input: {} }] };
  if (/fail please/.test(t)) return { error: "The model provider is unavailable (fake)." };
  return { text: `I'm RevenueDot AI. You said: "${text.slice(0, 120)}". Ask me about revenue, customers or your catalog.` };
};

export function fakeLanguageModel(script: FakeScript = defaultScript, opts: { delayMs?: number } = {}): LanguageModelV4 & { calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    specificationVersion: "v4", provider: "fake", modelId: "fake-assistant-model", supportedUrls: {}, calls,
    async doGenerate() { throw new Error("The fake assistant model only streams."); },
    async doStream(options) {
      calls.push(options);
      const tools = (options.tools ?? []).map((t) => t.name);
      const step = script({ prompt: options.prompt, tools, lastUserText: lastUserText(options.prompt), lastToolResults: trailingToolResults(options.prompt) });
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }, { type: "response-metadata", id: `fake-${calls.length}`, modelId: "fake-assistant-model", timestamp: new Date(0) }];
      if ("error" in step) parts.push({ type: "error", error: new Error(step.error) });
      else {
        const text = step.text ?? "";
        if (text) {
          parts.push({ type: "text-start", id: "t" });
          for (const w of text.match(/\S+\s*/g) ?? [text]) parts.push({ type: "text-delta", id: "t", delta: w });
          parts.push({ type: "text-end", id: "t" });
        }
        if ("toolCalls" in step) {
          step.toolCalls.forEach((c, i) => {
            const id = `call_${crypto.randomUUID().slice(0, 8)}_${i}`;
            const input = JSON.stringify(c.input);
            parts.push({ type: "tool-input-start", id, toolName: c.toolName }, { type: "tool-input-delta", id, delta: input }, { type: "tool-input-end", id });
            parts.push({ type: "tool-call", toolCallId: id, toolName: c.toolName, input });
          });
        }
      }
      const isTools = "toolCalls" in step;
      parts.push({
        type: "finish", finishReason: { unified: isTools ? "tool-calls" : "stop", raw: isTools ? "tool_use" : "end_turn" },
        usage: { inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } },
      });
      const delay = opts.delayMs ?? 0;
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            for (const p of parts) {
              if (delay && p.type === "text-delta") await sleep(delay);
              controller.enqueue(p);
            }
            controller.close();
          },
        }),
      };
    },
  };
}

export function fakeAssistantModel(script?: FakeScript, opts?: { delayMs?: number }): AssistantModel & { fake: ReturnType<typeof fakeLanguageModel> } {
  const fake = fakeLanguageModel(script, opts);
  return { provider: "Fake", model: "fake-assistant-model", languageModel: fake, vision: true, fake };
}
