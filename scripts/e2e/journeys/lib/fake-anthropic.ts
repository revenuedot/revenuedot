// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a scripted stand-in for Anthropic's Messages API (https://docs.anthropic.com/en/api/messages), served by
// the capture server for api.anthropic.com. The journey server runs with ANTHROPIC_API_KEY set to a made-up key, so the
// real model path runs end to end (AI SDK Anthropic provider, SSE streaming, tool calls, approvals) and only the model's
// words come from this script: "revenue/MRR" questions call get-metrics, "grant <entitlement> to <user>" calls
// grant-customer-entitlement, "look up X and grant pro to X" calls get-customer and the grant in one step, tool results get a one-line summary, and the paywall and funnel generators get valid JSON.
import type { ServerResponse } from "node:http";
import type { Captured } from "./stack.ts";

export interface FakeModelLog { at: number; tools: string[]; lastUser: string; answer: unknown }
export const fakeModelCalls: FakeModelLog[] = [];

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

const money = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : String(v));
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (b.type === "text" ? b.text : typeof b.content === "string" ? b.content : Array.isArray(b.content) ? textOf(b.content) : "")).join("\n") : "";

/** The user's own words: the last user message's text, skipping messages that only carry tool results. */
function requestText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (text.trim()) return text;
  }
  return "";
}

function script(body: any): Block[] {
  const tools: string[] = (body.tools ?? []).map((t: any) => t.name);
  const messages: any[] = body.messages ?? [];
  const last = messages[messages.length - 1];
  const system = textOf(body.system);
  const lastUserText = textOf(last?.content);
  const toolResults = Array.isArray(last?.content) ? last.content.filter((b: any) => b.type === "tool_result") : [];
  // AI growth insights (prd/attribution-benchmarks-insights §3): one read tool, then JSON that cites the data pack.
  if (/this week's growth insights/.test(system)) return insightBlocks(messages, tools, toolResults.length > 0);
  if (toolResults.length) {
    // The tool that produced the result: the previous assistant message's tool_use with that id.
    const prev = messages[messages.length - 2];
    // When a read and a write ran in one step, the write's result decides the answer.
    const uses = (prev?.content ?? []).filter((b: any) => b.type === "tool_use");
    const r = toolResults.find((t: any) => uses.find((b: any) => b.id === t.tool_use_id)?.name === "grant-customer-entitlement") ?? toolResults[0];
    const use = (prev?.content ?? []).find((b: any) => b.type === "tool_use" && b.id === r.tool_use_id);
    const out = textOf(r.content);
    if (/denied/i.test(out)) return [{ type: "text", text: "OK, I did not change anything." }];
    if (r.is_error) return [{ type: "text", text: `That did not work: ${out.slice(0, 200)}` }];
    let json: any = null; try { json = JSON.parse(out); } catch { /* text result */ }
    if (use?.name === "get-metrics" && Array.isArray(json?.metrics)) {
      const by = Object.fromEntries(json.metrics.map((m: any) => [m.id, m.value]));
      return [{ type: "text", text: `**MRR is ${money(by.mrr)}** with ${by.active_subscriptions ?? 0} active subscriptions. Revenue in the last 28 days was ${money(by.revenue)}.` }];
    }
    if (use?.name === "grant-customer-entitlement") return [{ type: "text", text: "Done. The customer has the entitlement for 7 days." }];
    // Drafting an experiment or a targeting rule: read the offerings, then propose the draft (an approval card).
    const request = requestText(messages);
    const base = /\/projects\/[A-Za-z0-9_]+/.exec(system)?.[0] ?? "";
    if (use?.name === "list-offerings" && Array.isArray(json?.items)) {
      const items = json.items as { lookup_key: string; is_current: boolean }[];
      const control = items.find((o) => o.is_current) ?? items[0];
      const named = items.filter((o) => o !== control && new RegExp(`\\b${o.lookup_key.replace(/[^\w]/g, ".")}\\b`, "i").test(request));
      const pick = named.length ? named : items.filter((o) => o !== control).slice(0, 1);
      const toolId = `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      if (!control || !pick.length) return [{ type: "text", text: "There is only one offering, so there is nothing to test against it yet." }];
      if (/targeting rule/i.test(request)) {
        if (!tools.includes("create-targeting-rule")) return [{ type: "text", text: "I can't change anything in this project." }];
        return [{ type: "text", text: `I'll draft a rule that shows ${pick[0]!.lookup_key}. It stays off until you turn it on.` }, { type: "tool_use", id: toolId, name: "create-targeting-rule", input: { name: `Show ${pick[0]!.lookup_key}`, offering: pick[0]!.lookup_key } }];
      }
      if (!tools.includes("create-experiment")) return [{ type: "text", text: "I can't change anything in this project." }];
      const type = /trial/i.test(request) ? "free_trial_offer" : /price/i.test(request) ? "price_point" : "other";
      return [{ type: "text", text: `I'll draft it with ${control.lookup_key} as the control. Nobody joins until you start it.` }, { type: "tool_use", id: toolId, name: "create-experiment", input: {
        name: `${control.lookup_key} vs ${pick.map((o) => o.lookup_key).join(" vs ")}`, type, control_offering: control.lookup_key, treatment_offerings: pick.map((o) => o.lookup_key), notes: `Hypothesis: ${request.slice(0, 300)}`,
      } }];
    }
    if (use?.name === "create-experiment" && json?.id) return [{ type: "text", text: `Done: [${json.name}](${base}/experiments/${json.id}) is saved as a draft with ${json.variants?.length ?? 2} variants.` }];
    if (use?.name === "create-targeting-rule" && json?.id) return [{ type: "text", text: `Done: the rule "${json.name}" is saved and turned off. Turn it on from [Targeting](${base}/targeting).` }];
    return [{ type: "text", text: `${use?.name ?? "The tool"} returned ${out.slice(0, 200)}` }];
  }
  if (/Funnel request: /.test(lastUserText) || /Funnel request: /.test(system)) {
    const ask = /Funnel request: (.*)/.exec(lastUserText + "\n" + system)?.[1]?.slice(0, 60) ?? "Quiz";
    return [{ type: "text", text: "```json\n" + JSON.stringify({
      theme: { background: "#FFFFFF", text: "#0A0A0A", accent: "#0A0A0A", button_text: "#FFFFFF", corner_radius: 0 },
      steps: [
        { id: "goal", type: "question", title: `AI: ${ask}`, options: [{ id: "a", label: "Sleep longer" }, { id: "b", label: "Fall asleep faster" }], attribute: "goal" },
        { id: "email", type: "email", title: "Where should we send your plan?", placeholder: "you@example.com", required: true },
        { id: "paywall", type: "paywall", title: "Start your free week", features: ["Daily plan"], allow_codes: true, button_label: "Continue" },
        { id: "success", type: "success", title: "You are in", body: "Open the app to start.", show_redemption: true },
      ],
    }) + "\n```" }];
  }
  if (/Paywall request: /.test(lastUserText) || /Paywall request: /.test(system)) {
    const ask = /Paywall request: (.*)/.exec(lastUserText + "\n" + system)?.[1]?.slice(0, 60) ?? "Go Pro";
    return [{ type: "text", text: "```json\n" + JSON.stringify({
      name: "AI paywall", background: "#0f172a",
      components: [{ type: "title", text: `AI: ${ask}`, color: "#ffffff" }, { type: "features", items: ["No ads", "Backup and sync"] }, { type: "packages" }],
      footer: [{ type: "cta", text: "Start free trial" }, { type: "button", action: "restore" }],
    }) + "\n```" }];
  }
  // "look up X and grant pro to X": a read tool and a write tool in the same step (PR #22 fixed a hang after Approve here).
  const both = /look up\s+([\w.@:-]+)\s+and\s+grant\s+(\w+)\s+(?:to|for)\s+([\w.@:-]+)/i.exec(lastUserText);
  if (both && tools.includes("grant-customer-entitlement")) {
    const tid = () => `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    return [{ type: "text", text: "I'll look them up and grant it once you approve." },
      { type: "tool_use", id: tid(), name: "get-customer", input: { customer_id: both[1]! } },
      { type: "tool_use", id: tid(), name: "grant-customer-entitlement", input: { customer_id: both[3]!, entitlement_id: both[2]!.toLowerCase(), expires_at: "7d" } }];
  }
  const grant = /grant\s+(\w+)\s+(?:to|for)\s+([\w.@:-]+)/i.exec(lastUserText);
  if (grant) {
    if (!tools.includes("grant-customer-entitlement")) return [{ type: "text", text: "I can't change anything in this project: RevenueDot AI is read only here." }];
    return [{ type: "text", text: "I'll grant it for 7 days once you approve." }, { type: "tool_use", id: `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, name: "grant-customer-entitlement", input: { customer_id: grant[2]!, entitlement_id: grant[1]!.toLowerCase(), expires_at: "7d" } }];
  }
  if (/(draft|create|set up).*(experiment|targeting rule)/i.test(lastUserText) && tools.includes("list-offerings")) {
    return [{ type: "tool_use", id: `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, name: "list-offerings", input: {} }];
  }
  if (/(revenue|mrr|insight|growth|doing|subscri)/i.test(lastUserText) && tools.includes("get-metrics")) {
    return [{ type: "tool_use", id: `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, name: "get-metrics", input: {} }];
  }
  return [{ type: "text", text: `I'm RevenueDot AI. You said: "${lastUserText.slice(0, 120)}".` }];
}

/** Capture handler: answers POST api.anthropic.com/v1/messages, streaming (SSE) or not. */
export async function fakeAnthropic(c: Captured, rs: ServerResponse): Promise<boolean> {
  if (c.host !== "api.anthropic.com" || c.path !== "/v1/messages") return false;
  const body = JSON.parse(c.body || "{}");
  if (!String(c.headers["x-api-key"] ?? "").startsWith("sk-ant-journey-")) {
    rs.statusCode = 401; rs.setHeader("content-type", "application/json");
    rs.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    return true;
  }
  const blocks = script(body);
  const lastUser = textOf(body.messages?.[body.messages.length - 1]?.content).slice(0, 200);
  fakeModelCalls.push({ at: Date.now(), tools: (body.tools ?? []).map((t: any) => t.name), lastUser, answer: blocks });
  const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  const id = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const usage = { input_tokens: 100, output_tokens: 20 };
  if (!body.stream) {
    rs.setHeader("content-type", "application/json");
    rs.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
    return true;
  }
  rs.setHeader("content-type", "text/event-stream");
  const send = (event: string, data: unknown) => rs.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of b.text.match(/.{1,24}/gs) ?? []) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
    } else {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send("message_stop", { type: "message_stop" });
  rs.end();
  return true;
}

function insightBlocks(messages: any[], tools: string[], afterTool: boolean): Block[] {
  const usedTool = messages.some((m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"));
  if (!afterTool && !usedTool && tools.includes("get-chart")) return [{ type: "tool_use", id: `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, name: "get-chart", input: { chart: "revenue", resolution: "week" } }];
  const pack = /```json\s*([\s\S]*?)```/.exec(textOf(messages[0]?.content))?.[1];
  let items: { id: string; label: string; unit: string; value: number | null; previous: number | null; window: string }[] = [];
  try { items = JSON.parse(pack ?? "{}").items ?? []; } catch { /* no pack */ }
  const fmt = (v: number | null, unit: string) => (v === null ? "n/a" : unit === "$" ? money(v) : unit === "%" ? `${v.toFixed(1)}%` : String(v));
  const pick = ["revenue", "trial_conversion", "campaign_1", "new_customers", "mrr", "refund_rate", "churn"].map((id) => items.find((i) => i.id === id && i.value !== null)).filter(Boolean).slice(0, 4) as typeof items;
  const insights = pick.map((i) => ({
    title: `${i.label.replace(/\s*\(.*$/, "").replace(/:.*$/, "")}: ${fmt(i.value, i.unit)}`.slice(0, 80),
    finding: `${i.label} is ${fmt(i.value, i.unit)}${i.previous !== null ? ` against ${fmt(i.previous, i.unit)} (${i.window})` : ""}.`,
    recommendation: i.id.startsWith("campaign_") ? "Move budget toward this campaign and compare day-30 revenue next week." : "Open the chart and find when the change started.",
    metric_ids: [i.id],
  }));
  return [{ type: "text", text: "```json\n" + JSON.stringify({ insights }) + "\n```" }];
}
