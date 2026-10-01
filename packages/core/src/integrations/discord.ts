import { conceptOf, isSandbox, json, revenueUsd, skip, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Discord: one embed per event to a channel webhook through Execute Webhook
 * (`POST /api/webhooks/{id}/{token}`, https://docs.discord.com/developers/resources/webhook).
 * RevenueCat's behaviour: https://www.revenuecat.com/docs/integrations/third-party-integrations/discord
 * Secrets: `webhook_url` (it holds the webhook token; checked on save with the outbound URL guard and to be a
 * discord.com webhook). Settings: `reporting`. Sandbox events are posted when the integration's environment includes
 * sandbox, labelled "Sandbox" like Slack.
 * Sent: purchases, trials, renewals, cancellations, refunds, one-time purchases, billing issues, product changes,
 * refund reversals and tests. Customer and product ids come from apps, so they are escaped as Discord markdown text and
 * `allowed_mentions` is empty: `@everyone` or `<@id>` in an id never pings anyone.
 */

const GOOD = 5763719, BAD = 15548997;

export const DISCORD_EVENTS: Concept[] = ["initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "non_subscription_purchase", "billing_issue", "product_change", "refund_reversed", "test"];

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
  refund_reversed: { verb: "had a refund reversed", good: true, money: true },
  test: { verb: "is a test customer: Discord is connected to RevenueDot", good: true },
};

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
/** Markdown and mention characters become literal text; `@` gets a zero-width space so `@everyone` stays text. */
export const discordEscape = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[\\`*_~|<>[\]()#]/g, "\\$&").replace(/@/g, "@\u200b");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A Discord webhook URL: https://discord.com/api/webhooks/<id>/<token> (also discordapp.com, ptb., canary., /api/v10/). */
export function discordWebhookOk(v: unknown): boolean {
  if (typeof v !== "string") return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  return u.protocol === "https:" && !u.username && !u.password && !u.port
    && /^((ptb|canary)\.)?discord(app)?\.com$/.test(u.hostname) && /^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname);
}

/** The webhook token (the URL's last path segment), so a log line that quotes only the token is scrubbed too. */
const tokenOf = (url: string) => { const t = new URL(url).pathname.replace(/\/$/, "").split("/").pop(); return t ? [t] : []; };

export async function buildDiscord(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const url = i.secrets.webhook_url;
  if (!url) return skip("No Discord webhook URL is saved.");
  if (!discordWebhookOk(url)) return skip("The saved Discord webhook URL is not a discord.com webhook.");
  const c = conceptOf(e);
  const line = c ? LINES[c] : undefined;
  if (!c || !line) return skip(`${e.type} events are not posted to Discord.`);
  const refund = c === "cancellation" && e.cancel_reason === "CUSTOMER_SUPPORT";
  const verb = refund ? "was refunded" : line.verb;
  const who = String(e.app_user_id ?? e.original_app_user_id ?? "unknown");
  const customer = i.context?.dashboardUrl && i.context.projectId
    ? `[${discordEscape(who)}](${i.context.dashboardUrl}/projects/${encodeURIComponent(i.context.projectId)}/customers/${encodeURIComponent(who).replace(/\(/g, "%28").replace(/\)/g, "%29")})`
    : discordEscape(who);
  const product = c === "product_change" && e.new_product_id ? `${e.product_id} → ${e.new_product_id}` : String(e.product_id ?? "");
  const revenue = revenueUsd(e, i.settings.reporting);
  const money = !!line.money || refund;
  const fields: { name: string; value: string; inline: boolean }[] = [];
  if (product) fields.push({ name: "Product", value: cut(discordEscape(product), 1024), inline: true });
  if (money) fields.push({ name: "Revenue", value: usd(revenue), inline: true });
  if (e.store) fields.push({ name: "Store", value: cut(discordEscape(String(e.store)), 1024), inline: true });
  if (e.country_code) fields.push({ name: "Country", value: cut(discordEscape(String(e.country_code)), 1024), inline: true });
  if (isSandbox(e)) fields.push({ name: "Environment", value: "Sandbox", inline: true });
  const body = {
    username: "RevenueDot",
    allowed_mentions: { parse: [] },
    embeds: [{
      description: cut(`Customer ${customer} ${verb}.`, 4096),
      color: line.good && !refund ? GOOD : BAD,
      fields,
      timestamp: new Date(e.event_timestamp_ms ?? i.now.getTime()).toISOString(),
    }],
  };
  return { name: refund ? "refund" : c, requests: [{ method: "POST", url, headers: { "content-type": "application/json" }, body: json(body) }], redact: [url, ...tokenOf(url)] };
}
