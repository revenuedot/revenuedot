import { conceptOf, isSandbox, json, revenueUsd, skip, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Slack: one message per event to an incoming webhook URL (https://api.slack.com/messaging/webhooks).
 * Secrets: `webhook_url`. Settings: `reporting` (gross | proceeds). Sandbox events are posted when the integration's
 * environment includes sandbox (labelled "Sandbox").
 * Sent: purchases, trials, renewals, cancellations, refunds, billing issues and product changes; other events skip.
 */

const GOOD = "#5F822B", BAD = "#C2410C";

export const SLACK_EVENTS: Concept[] = ["initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "non_subscription_purchase", "billing_issue", "product_change", "test"];

const LINES: Partial<Record<Concept, { verb: string; good: boolean; money?: boolean }>> = {
  initial_purchase: { verb: "started a subscription", good: true, money: true },
  trial_started: { verb: "started a free trial", good: true },
  trial_converted: { verb: "converted from a free trial", good: true, money: true },
  trial_cancelled: { verb: "cancelled their free trial", good: false },
  renewal: { verb: "renewed their subscription", good: true, money: true },
  cancellation: { verb: "cancelled their subscription", good: false },
  non_subscription_purchase: { verb: "made a purchase", good: true, money: true },
  billing_issue: { verb: "has a billing issue", good: false },
  product_change: { verb: "changed their plan", good: true },
  test: { verb: "is a test customer: Slack is connected to RevenueDot", good: true },
};

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function buildSlack(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const url = i.secrets.webhook_url;
  if (!url) return skip("No Slack webhook URL is saved.");
  const c = conceptOf(e);
  const line = c ? LINES[c] : undefined;
  if (!c || !line) return skip(`${e.type} events are not posted to Slack.`);
  const refund = c === "cancellation" && e.cancel_reason === "CUSTOMER_SUPPORT";
  const verb = refund ? "was refunded" : line.verb;
  const who = String(e.app_user_id ?? e.original_app_user_id ?? "unknown");
  const link = i.context?.dashboardUrl && i.context.projectId
    ? `<${i.context.dashboardUrl}/projects/${encodeURIComponent(i.context.projectId)}/customers/${encodeURIComponent(who)}|${esc(who)}>`
    : esc(who);
  const product = c === "product_change" && e.new_product_id ? `${e.product_id} → ${e.new_product_id}` : String(e.product_id ?? "");
  const revenue = revenueUsd(e, i.settings.reporting);
  const fields: { title?: string; value: string; short?: boolean }[] = [
    { value: `Customer ${link} ${verb}.` },
    { title: "Product", value: esc(product), short: true },
  ];
  if (line.money || refund) fields.push({ title: "Revenue", value: usd(revenue), short: true });
  if (e.store) fields.push({ title: "Store", value: String(e.store), short: true });
  if (e.country_code) fields.push({ title: "Country", value: String(e.country_code), short: true });
  if (isSandbox(e)) fields.push({ title: "Environment", value: "Sandbox", short: true });
  const text = `Customer ${who} ${verb}${product ? `: ${product}` : ""}${line.money || refund ? ` (${usd(revenue)})` : ""}.`;
  const body = {
    text,
    username: "RevenueDot",
    attachments: [{ fallback: text, color: line.good && !refund ? GOOD : BAD, fields, ts: Math.floor((e.event_timestamp_ms ?? i.now.getTime()) / 1000) }],
  };
  return { name: refund ? "refund" : c, requests: [{ method: "POST", url, headers: { "content-type": "application/json" }, body: json(body) }], redact: [url] };
}
