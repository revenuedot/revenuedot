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

/**
 * "Create with AI" drafts (prd/catalog/PRD.md): from "Draft products … : Pro $9.99 monthly, $59.99 yearly and a $99.99
 * lifetime unlock on the Test Store" the products per period with the price written next to it, on the apps the text
 * names (iOS, Android, Test Store; all when none), attached to `pro` when the text says Pro.
 */
const PERIODS: [RegExp, string | null, string][] = [[/\bweekly|\bweek\b/i, "P1W", "weekly"], [/\bmonthly|\bmonth\b/i, "P1M", "monthly"], [/\b(yearly|annual|year)\b/i, "P1Y", "annual"], [/\blifetime\b/i, null, "lifetime"]];
export function draftProducts(text: string, apps: { id: string; type: string }[]) {
  const name = /\b(pro|premium|plus|gold)\b/i.exec(text)?.[1]?.toLowerCase() ?? "pro";
  const wanted = apps.filter((a) => (/\b(ios|app store|iphone)\b/i.test(text) && a.type === "app_store") || (/\b(android|play)\b/i.test(text) && a.type === "play_store") || (/test store/i.test(text) && a.type === "test_store"));
  const targets = wanted.length ? wanted : apps.filter((a) => ["app_store", "play_store", "test_store"].includes(a.type));
  const products: Record<string, unknown>[] = [];
  for (const [re, duration, word] of PERIODS) {
    const m = re.exec(text);
    if (!m) continue;
    // The price written closest before the period word ("$9.99 monthly"), else right after it ("monthly at $9.99").
    const before = [...text.slice(0, m.index).matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].pop()?.[1];
    const after = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(text.slice(m.index))?.[1];
    const amount = Number(before ?? after ?? 0);
    for (const app of targets) {
      const id = app.type === "play_store" ? (duration ? `${name}:${word}` : `${name}_${word}`) : app.type === "app_store" ? `com.example.${name}.${word}` : `${name}_${word}`;
      products.push({
        app_id: app.id, store_identifier: id, type: duration ? "subscription" : "non_consumable", display_name: `${name[0]!.toUpperCase()}${name.slice(1)} ${word[0]!.toUpperCase()}${word.slice(1)}`,
        ...(duration ? { subscription_duration: duration } : {}), ...(app.type === "test_store" && amount > 0 ? { test_store_price: { amount, currency: "USD" } } : {}),
      });
    }
  }
  return { products, entitlement: { lookup_key: name, display_name: `${name[0]!.toUpperCase()}${name.slice(1)} access` } };
}
const PACKAGE_FOR: Record<string, string> = { P1W: "$rc_weekly", P1M: "$rc_monthly", P2M: "$rc_two_month", P3M: "$rc_three_month", P6M: "$rc_six_month", P1Y: "$rc_annual" };
export function draftOffering(text: string, products: { id: string; type: string; store_identifier: string; subscription?: { duration?: string | null } }[]) {
  const key = /\b(?:called|named|key)\s+["'`]?([\w-]+)/i.exec(text)?.[1] ?? "ai_offering";
  const packages = new Map<string, { lookup_key: string; display_name: string; products: string[] }>();
  for (const p of products) {
    const pk = p.type === "subscription" ? PACKAGE_FOR[p.subscription?.duration ?? ""] : p.type === "non_consumable" ? "$rc_lifetime" : undefined;
    if (!pk) continue;
    const x = packages.get(pk) ?? { lookup_key: pk, display_name: pk.replace("$rc_", "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), products: [] };
    x.products.push(p.id);
    packages.set(pk, x);
  }
  // In the order RevenueCat's New Offering form lists the package types.
  const order = ["$rc_monthly", "$rc_annual", "$rc_six_month", "$rc_three_month", "$rc_two_month", "$rc_weekly", "$rc_lifetime"];
  const sorted = [...packages.values()].sort((a, b) => order.indexOf(a.lookup_key) - order.indexOf(b.lookup_key));
  return { lookup_key: key, display_name: key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), packages: sorted, make_current: /\b(current|default)\b/i.test(text) };
}

/** The default script: enough intelligence for the demo flows, nothing more. */
export const defaultScript: FakeScript = ({ prompt, tools, lastUserText: text, lastToolResults }) => {
  const sys = prompt.find((m) => m.role === "system");
  const base = /\/projects\/[A-Za-z0-9_]+/.exec(typeof sys?.content === "string" ? sys.content : "")?.[0] ?? "";
  const drafting = /^draft (products|an offering)/i.exec(text.trim())?.[1]?.toLowerCase();
  if (drafting && lastToolResults.length === 1 && ["list-apps", "list-products"].includes(lastToolResults[0]!.toolName)) {
    const out = lastToolResults[0]!.output as { items?: Record<string, any>[] };
    if (drafting === "products") {
      const d = draftProducts(text, (out.items ?? []) as { id: string; type: string }[]);
      if (!d.products.length) return { text: "I could not tell which products to create. Name the periods and prices, such as \"$9.99 monthly and $59.99 yearly\"." };
      return { text: `Here is the draft: ${d.products.length} products, attached to ${d.entitlement.lookup_key}. Approve to create them.`, toolCalls: [{ toolName: "create-products", input: d }] };
    }
    const d = draftOffering(text, (out.items ?? []) as never);
    if (!d.packages.length) return { text: "There are no subscription or lifetime products to put in an offering yet. Create products first." };
    return { text: `Here is the draft offering ${d.lookup_key} with ${d.packages.length} packages. Approve to create it.`, toolCalls: [{ toolName: "create-offering", input: d }] };
  }
  if (typeof sys?.content === "string" && sys.content.includes("this week's growth insights")) return insightsStep(prompt, tools, lastToolResults);
  const has = (name: string) => tools.includes(name);
  if (lastToolResults.length) {
    const r = lastToolResults.find((x) => x.toolName === "grant-customer-entitlement") ?? lastToolResults[0]!;
    const out = r.output as Record<string, any>;
    if (out?.denied) return { text: "OK, I did not change anything." };
    if (typeof out === "string" || out?.error) return { text: `That did not work: ${typeof out === "string" ? out : out.error}` };
    if (r.toolName === "get-metrics" && Array.isArray(out?.metrics)) {
      const by = Object.fromEntries(out.metrics.map((m: { id: string; value: number }) => [m.id, m.value]));
      return { text: `**MRR is ${money(by.mrr)}** with ${by.active_subscriptions ?? 0} active subscriptions and ${by.active_trials ?? 0} trials. Revenue in the last 28 days was ${money(by.revenue)}.\n\n- New customers (28 days): ${by.new_customers ?? 0}\n- Active customers (28 days): ${by.active_users ?? 0}\n\nSee the [MRR chart](${base}/charts/mrr) for the trend.` };
    }
    if (r.toolName === "grant-customer-entitlement") return { text: `Done. The customer has the entitlement until ${out?.entitlements?.active?.[0]?.expires_at ? new Date(out.entitlements.active[0].expires_at).toDateString() : "the date you chose"}.` };
    if (r.toolName === "create-products") return { text: `Created ${out?.created?.length ?? 0} products${out?.skipped?.length ? `, skipped ${out.skipped.length} that already existed` : ""}${out?.entitlement ? ` and attached them to ${out.entitlement.lookup_key}` : ""}. See [products](${base}/product-catalog/products).` };
    if (r.toolName === "create-offering") return { text: `Created the offering ${out?.lookup_key} with ${out?.packages?.length ?? 0} packages${out?.is_current ? "; it is now the current offering" : ""}. See [offerings](${base}/product-catalog/offerings).` };
    if (r.toolName === "get-project-health") return { text: `Setup health: ${out?.apps?.length ?? 0} apps checked, webhooks delivered ${out?.webhooks?.delivered_percent_24h ?? "n/a"}% in the last 24 hours.` };
    // Drafting an experiment or a targeting rule: read the offerings, then propose the draft (an approval card).
    if (r.toolName === "list-offerings" && Array.isArray(out?.items)) {
      const items = out.items as { id: string; lookup_key: string; is_current: boolean }[];
      const named = items.filter((o) => new RegExp(`\\b${o.lookup_key.replace(/[^\w]/g, ".")}\\b`, "i").test(text));
      const control = items.find((o) => o.is_current) ?? items[0];
      const others = items.filter((o) => o !== control);
      if (/targeting rule/i.test(text)) {
        const pick = named.find((o) => o !== control) ?? others[0];
        if (!pick || !has("create-targeting-rule")) return { text: "You need a second offering for a targeting rule. Create one in Product catalog → Offerings." };
        return { text: `I'll draft a rule that shows ${pick.lookup_key}. It stays off until you turn it on.`, toolCalls: [{ toolName: "create-targeting-rule", input: { name: `Show ${pick.lookup_key}`, offering: pick.lookup_key } }] };
      }
      const treatments = named.filter((o) => o !== control);
      const pick = treatments.length ? treatments : others.slice(0, 1);
      if (!control || !pick.length || !has("create-experiment")) return { text: "There is only one offering, so there is nothing to test against it yet. Duplicate it on the Experiments page and change the copy first." };
      const type = /trial/i.test(text) ? "free_trial_offer" : /price/i.test(text) ? "price_point" : /annual|monthly|weekly|duration/i.test(text) ? "subscription_duration" : /design|paywall/i.test(text) ? "paywall_design" : "other";
      return {
        text: `I'll draft it as an experiment with ${control.lookup_key} as the control. Nobody joins until you start it.`,
        toolCalls: [{ toolName: "create-experiment", input: { name: `${control.lookup_key} vs ${pick.map((o) => o.lookup_key).join(" vs ")}`, type, control_offering: control.lookup_key, treatment_offerings: pick.map((o) => o.lookup_key), notes: `Hypothesis: ${text.slice(0, 300)}` } }],
      };
    }
    if (r.toolName === "create-experiment" && out?.id) return { text: `Done: [${out.name}](${base}/experiments/${out.id}) is saved as a draft with ${out.variants?.length ?? 2} variants. Review it and start it when you are ready.` };
    if (r.toolName === "create-targeting-rule" && out?.id) return { text: `Done: the rule "${out.name}" is saved and turned off. Turn it on from [Targeting](${base}/targeting).` };
    return { text: `${r.toolName} returned ${JSON.stringify(out).slice(0, 200)}` };
  }
  const t = text.toLowerCase();
  if (drafting) {
    const write = drafting === "products" ? "create-products" : "create-offering";
    if (!has(write)) return { text: "I can't change anything in this project: RevenueDot AI is read only here." };
    return { toolCalls: [{ toolName: drafting === "products" ? "list-apps" : "list-products", input: {} }] };
  }
  const grant = /grant\s+(\w+)\s+(?:to|for)\s+([\w.@:-]+)/i.exec(text);
  if (grant) {
    if (!has("grant-customer-entitlement")) return { text: "I can't change anything in this project: RevenueDot AI is read only here." };
    const write = { toolName: "grant-customer-entitlement", input: { customer_id: grant[2]!, entitlement_id: grant[1]!.toLowerCase(), expires_at: "7d" } };
    // "look up <user> and grant …": a read and a write in one step, the read finishing after the approval request.
    const read = /\blook\s*up\b/i.test(text) && has("get-customer") ? [{ toolName: "get-customer", input: { customer_id: grant[2]! } }] : [];
    return { text: "I'll grant it for 7 days once you approve.", toolCalls: [...read, write] };
  }
  if (/(draft|create|set up).*(experiment|targeting rule)|\btest\b.*\b(against|vs)\b/.test(t) && has("list-offerings")) return { toolCalls: [{ toolName: "list-offerings", input: {} }] };
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

/**
 * AI growth insights (services/insights): look at one chart with a read tool, then answer with JSON built from the data
 * pack in the first user message, quoting its numbers and citing its ids.
 */
function insightsStep(prompt: Prompt, tools: string[], lastToolResults: { toolName: string; output: unknown }[]): FakeStep {
  const askedTool = prompt.some((m) => m.role === "tool");
  if (!askedTool && !lastToolResults.length && tools.includes("get-chart")) return { toolCalls: [{ toolName: "get-chart", input: { chart: "mrr", resolution: "week" } }] };
  const first = prompt.find((m) => m.role === "user");
  const text = first && Array.isArray(first.content) ? first.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") : typeof first?.content === "string" ? first.content : "";
  const json = /```json\s*([\s\S]*?)```/.exec(text)?.[1];
  let items: { id: string; label: string; unit: string; value: number | null; previous: number | null; change_pct: number | null; window: string }[] = [];
  try { items = JSON.parse(json ?? "{}").items ?? []; } catch { /* no pack */ }
  const fmt = (v: number | null, unit: string) => (v === null ? "n/a" : unit === "$" ? money(v) : unit === "%" ? `${v.toFixed(1)}%` : String(v));
  const pick = (id: string) => items.find((i) => i.id === id && i.value !== null);
  const chosen = [pick("revenue"), pick("trial_conversion"), items.find((i) => i.id.startsWith("campaign_")), items.find((i) => i.id.startsWith("benchmark_")), pick("new_customers"), pick("mrr"), pick("refund_rate")]
    .filter((x): x is NonNullable<typeof x> => !!x).filter((x, i, a) => a.indexOf(x) === i).slice(0, 4);
  const insights = chosen.map((i) => ({
    title: `${i.label.replace(/\s*\(.*$/, "").replace(/:.*$/, "")}: ${fmt(i.value, i.unit)}`.slice(0, 80),
    finding: `${i.label} is ${fmt(i.value, i.unit)}${i.previous !== null ? `, against ${fmt(i.previous, i.unit)} (${i.window})` : ""}.`,
    recommendation: i.id.startsWith("campaign_") ? "Move more of next week's ad budget to this campaign and compare its day-30 revenue." : i.id === "trial_conversion" ? "Run an experiment with a 14-day trial against the current one." : "Open the chart, find the day the change started and check what shipped then.",
    metric_ids: [i.id],
  }));
  return { text: "```json\n" + JSON.stringify({ insights }) + "\n```" };
}
