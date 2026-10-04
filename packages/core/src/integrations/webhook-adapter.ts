import {
  CONCEPTS, DOCS, FUNNEL_CLIENT_FIELDS, conceptOf, isPaywallConcept, json, skip, type BuildInput, type Concept, type IntegrationField, type IntegrationKind, type IntegrationSpec, type PartnerDef, type Plan,
} from "./common.js";

/**
 * The documented-webhook adapter, for partners that publish no API of their own for subscription events and instead
 * ask RevenueCat customers for a webhook: the partner gives a URL (and sometimes an Authorization value), and the
 * partner reads RevenueCat's webhook body (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).
 * RevenueDot sends exactly that body, `{"api_version":"1.0","event":{...}}`, with `content-type: application/json` and
 * the optional Authorization value, to the URL saved in the integration (checked with the outbound URL guard on save
 * and before each send). The stored event already is the RevenueCat webhook event, so nothing is mapped; only a funnel visitor's IP address
 * and user agent (`client_ip`, `client_user_agent`) are left out.
 *
 * Steps: every lifecycle step webhooks get except experiment enrollments (CONCEPTS minus `experiment_enrollment`) and
 * paywall events (RevenueDot sends those to Segment, Amplitude, Mixpanel and PostHog, like RevenueCat).
 * The partners on the adapter take subscription and revenue events for attribution and paywall revenue; none of them
 * documents RevenueCat Experiments enrollments, which carry no money and would only add noise to their reports.
 * Sandbox events carry `environment: SANDBOX` in the body; whether they are sent is the integration's environment filter.
 */

export const WEBHOOK_ADAPTER_EVENTS: Concept[] = CONCEPTS.filter((c) => c !== "experiment_enrollment" && !isPaywallConcept(c));

export interface PartnerWebhookOptions {
  /** The partner's name, for skip reasons. */
  partner: string;
  /** The setting (or secret) that holds the partner's URL. */
  urlKey: string;
  /** Whether that URL is a secret field (it may embed a token), so the delivery log scrubs it. */
  urlIsSecret: boolean;
  /** The secret that holds the optional Authorization header value. */
  authKey?: string;
  /** Steps sent; defaults to WEBHOOK_ADAPTER_EVENTS. */
  events?: Concept[];
}

/**
 * A partner on the adapter: catalogue entry with a `webhook_url` field (and an optional `authorization` secret), the
 * steps, the builder, and a save check that the Authorization value is one line (a line break cannot go in a header).
 */
export function webhookPartner(p: {
  kind: IntegrationKind; name: string; category: IntegrationSpec["category"]; text: string; environment: IntegrationSpec["environment"];
  urlLabel: string; urlHint: string; urlIsSecret: boolean; urlPlaceholder?: string; authHint?: string; authRequired?: boolean;
}): PartnerDef {
  const fields: IntegrationField[] = [
    { key: "webhook_url", label: p.urlLabel, type: p.urlIsSecret ? "secret" : "text", required: true, url: true, hint: p.urlHint, ...(p.urlPlaceholder ? { placeholder: p.urlPlaceholder } : {}) },
  ];
  if (p.authHint) fields.push({ key: "authorization", label: "Authorization header value", type: "secret", ...(p.authRequired ? { required: true } : {}), hint: p.authHint });
  return {
    spec: { kind: p.kind, name: p.name, category: p.category, text: p.text, environment: p.environment, eventNames: false, fields, docs: `${DOCS}#${p.kind}`, api: "webhook" },
    events: WEBHOOK_ADAPTER_EVENTS,
    build: (i) => buildPartnerWebhook(i, { partner: p.name, urlKey: "webhook_url", urlIsSecret: p.urlIsSecret, authKey: p.authHint ? "authorization" : undefined }),
    validate: (_settings, secrets) =>
      secrets.authorization && /[\r\n]/.test(secrets.authorization) ? { param: "settings.authorization", message: "must be one line, without line breaks." } : null,
  };
}

/** RevenueCat's webhook body for the stored event, POSTed to the partner's URL. */
export async function buildPartnerWebhook(i: BuildInput, opts: PartnerWebhookOptions): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !(opts.events ?? WEBHOOK_ADAPTER_EVENTS).includes(c)) return skip(`${e.type} events are not sent to ${opts.partner}.`);
  const raw = opts.urlIsSecret ? i.secrets[opts.urlKey] : i.settings[opts.urlKey];
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url) return skip(`No ${opts.partner} webhook URL is saved.`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = opts.authKey ? i.secrets[opts.authKey]?.trim() : undefined;
  if (auth) headers.authorization = auth;
  const redact = [...(opts.urlIsSecret ? [url] : []), ...(auth ? [auth] : [])];
  // A funnel visitor's IP address and user agent are recorded for Meta and Branch only; adapter partners never get them.
  const event = { ...e };
  for (const k of FUNNEL_CLIENT_FIELDS) delete event[k];
  return { name: String(e.type), requests: [{ method: "POST", url, headers, body: json({ api_version: "1.0", event }) }], redact };
}
