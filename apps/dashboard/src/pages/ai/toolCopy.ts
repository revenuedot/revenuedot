/**
 * Words for RevenueDot AI's tool cards (prd/ai-assistant/PRD.md §3): a title per tool, what a running read is doing, and
 * the sentence an approval card asks ("Grant Pro to wjqx8kd2rn1 until Nov 8, 2026?"). Tool names match the server's
 * (apps/server/src/services/assistant/tools.ts).
 */
type Input = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

export const TOOL_TITLES: Record<string, string> = {
  "get-metrics": "Revenue metrics", "list-charts": "Charts", "get-chart": "Chart", "list-customers": "Find customers", "get-customer": "Customer",
  "list-events": "Event history", "list-transactions": "Transactions", "list-apps": "Apps", "list-products": "Products", "list-entitlements": "Entitlements",
  "list-offerings": "Offerings", "list-paywalls": "Paywalls", "list-targeting-rules": "Targeting rules", "list-experiments": "Experiments",
  "get-experiment-results": "Experiment results", "get-project-health": "Setup health", "list-webhook-integrations": "Webhooks",
  "list-webhook-deliveries": "Webhook deliveries", "list-integrations": "Integrations", "get-import-status": "Import status",
  "grant-customer-entitlement": "Grant entitlement", "revoke-customer-entitlement": "Revoke entitlement", "create-product": "Create product",
  "attach-products-to-entitlement": "Attach products to entitlement", "attach-products-to-package": "Attach products to package",
  "set-current-offering": "Set current offering", "import-storekit-products": "Import StoreKit products", "start-experiment": "Start experiment",
  "pause-experiment": "Pause experiment", "retry-webhook-delivery": "Retry webhook delivery", "replay-failed-webhook-deliveries": "Replay failed deliveries",
};

export const toolTitle = (name: string) => TOOL_TITLES[name] ?? name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** "7d" → "for 7 days"; an ISO date or epoch → "until Nov 8, 2026". */
function until(v: unknown): string {
  if (typeof v === "string") {
    const d = /^(\d+)\s*(h|d|w|m|y)$/i.exec(v.trim());
    if (d) {
      const n = Number(d[1]);
      const unit = { h: "hour", d: "day", w: "week", m: "month", y: "year" }[d[2]!.toLowerCase() as "h"]!;
      return `for ${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  const t = typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : Date.parse(s(v));
  return Number.isFinite(t) ? `until ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "";
}

/** The question on an approval card. */
export function describeWrite(name: string, a: Input): string {
  switch (name) {
    case "grant-customer-entitlement": return `Grant ${s(a.entitlement_id)} to ${s(a.customer_id)} ${until(a.expires_at)}`.trim();
    case "revoke-customer-entitlement": return `Revoke the granted ${s(a.entitlement_id)} from ${s(a.customer_id)}`;
    case "create-product": return `Create the ${s(a.type).replace(/_/g, " ")} product ${s(a.store_identifier)}${a.subscription_duration ? ` (${s(a.subscription_duration)})` : ""}`;
    case "attach-products-to-entitlement": return `Attach ${(a.product_ids as unknown[] | undefined)?.length ?? 0} product(s) to ${s(a.entitlement_id)}`;
    case "attach-products-to-package": return `Put ${(a.product_ids as unknown[] | undefined)?.length ?? 0} product(s) in package ${s(a.package_id)}`;
    case "set-current-offering": return `Make ${s(a.offering_id)} the current offering`;
    case "import-storekit-products": return `Import ${(a.product_ids as unknown[] | undefined)?.length ? `${(a.product_ids as unknown[]).length} products` : "the StoreKit products"} into app ${s(a.app_id)}`;
    case "start-experiment": return `Start experiment ${s(a.experiment_id)}`;
    case "pause-experiment": return `Pause experiment ${s(a.experiment_id)}`;
    case "retry-webhook-delivery": return `Send webhook delivery ${s(a.delivery_id)} again`;
    case "replay-failed-webhook-deliveries": return `Send every failed delivery of webhook ${s(a.webhook_id)} from the last ${s(a.days ?? 7)} days again`;
    default: return `Run ${toolTitle(name)}`;
  }
}

/** What a read is doing while it runs. */
export function describeRead(name: string, a: Input): string {
  switch (name) {
    case "get-metrics": return a.metric ? `${s(a.metric).replace(/_/g, " ")}, last ${s(a.days ?? 28)} days` : "Overview, last 28 days";
    case "get-chart": return [s(a.chart).replace(/_/g, " "), a.segment ? `by ${s(a.segment)}` : "", a.start_date ? `${s(a.start_date)} to ${s(a.end_date) || "today"}` : ""].filter(Boolean).join(" · ");
    case "get-customer": return s(a.customer_id);
    case "list-customers": return a.search ? `Search "${s(a.search)}"` : "Newest customers";
    case "list-events": case "list-transactions": return a.customer_id ? `Customer ${s(a.customer_id)}` : "Newest first";
    default: return "";
  }
}

export const WRITE_TOOLS = new Set(["grant-customer-entitlement", "revoke-customer-entitlement", "create-product", "attach-products-to-entitlement", "attach-products-to-package",
  "set-current-offering", "import-storekit-products", "start-experiment", "pause-experiment", "retry-webhook-delivery", "replay-failed-webhook-deliveries"]);
