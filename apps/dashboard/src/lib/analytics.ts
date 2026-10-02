/**
 * DataFast for RevenueDot Cloud (docs/analytics.md): pageviews on the dashboard, the user's profile, a goal for each step that
 * moves a new account toward paying, and the cookies the billing route puts on the Stripe Checkout session so DataFast credits
 * the payment to the channel that brought the visitor. Only app.revenuedot.app loads it: a self-hosted dashboard never does.
 * Everything here is best effort and never throws, so a blocked script cannot break a page.
 */
type Df = (...args: unknown[]) => void;

/** The website id is public (it is in every page's HTML). `proxy` and `site.ts` in apps/site hold the same values. */
export const DATAFAST = { websiteId: "dfid_D9m4bJCw2lmFrxMQaatXu", domain: "revenuedot.app", proxy: "" } as const;
export const CLOUD_HOST = "app.revenuedot.app";

const df = (): Df | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { datafast?: Df }).datafast);

/** Loads the tracking script on RevenueDot Cloud. */
export function initAnalytics(): void {
  if (typeof document === "undefined" || location.hostname !== CLOUD_HOST) return;
  const w = window as unknown as { datafast?: Df & { q?: unknown[] } };
  w.datafast = w.datafast || function (...a: unknown[]) { (w.datafast!.q = w.datafast!.q || []).push(a); };
  const s = document.createElement("script");
  s.defer = true;
  s.src = DATAFAST.proxy ? `https://${DATAFAST.proxy}/js/script.js` : "https://datafa.st/js/script.js";
  s.dataset.websiteId = DATAFAST.websiteId;
  s.dataset.domain = DATAFAST.domain;
  if (DATAFAST.proxy) s.dataset.apiUrl = `https://${DATAFAST.proxy}/api/events`;
  document.head.appendChild(s);
}

/** Records a goal. Names: lowercase letters, digits, `_`, `-`, `:`; parameter values are short strings. */
export function track(goal: string, params?: Record<string, string | number | boolean>): void {
  try {
    const f = df();
    if (!f) return;
    if (params) f(goal, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v).slice(0, 255)])));
    else f(goal);
  } catch { /* analytics never breaks the page */ }
}

let identified = "";
/** Tells DataFast who the visitor is. The email is the user id, so a contact-sales lead, the signup and the Stripe payment are one profile. */
export function identifyUser(me: { user: { email: string; name: string | null; email_verified: boolean }; account?: { plan: string }; projects: unknown[] }): void {
  const key = `${me.user.email}|${me.account?.plan ?? ""}|${me.projects.length}|${me.user.email_verified}`;
  if (key === identified) return;
  identified = key;
  try {
    df()?.("identify", {
      user_id: me.user.email,
      ...(me.user.name ? { name: me.user.name } : {}),
      plan: me.account?.plan ?? "free",
      projects: String(me.projects.length),
      email_verified: String(me.user.email_verified),
    });
  } catch { /* ignore */ }
}

/** Goals for the steps that matter, keyed by the successful request that completes them. */
const STEPS: { method: string; path: RegExp; goal: string; params?: Record<string, string> }[] = [
  { method: "POST", path: /^\/auth\/signup$/, goal: "signup_completed" },
  { method: "POST", path: /^\/auth\/invites\/[^/]+\/accept$/, goal: "invite_accepted" },
  { method: "POST", path: /^\/v2\/projects$/, goal: "project_created" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/apps$/, goal: "app_created" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/api_keys$/, goal: "api_key_created" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/products$/, goal: "product_created" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/entitlements$/, goal: "entitlement_created" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/offerings$/, goal: "offering_created" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/paywalls$/, goal: "paywall_created" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/integrations\/webhooks$/, goal: "webhook_created" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/test_purchases$/, goal: "test_purchase_made" },
  { method: "POST", path: /^\/v2\/projects\/[^/]+\/apps\/[^/]+\/stripe_connect\/actions\/finish$/, goal: "stripe_connected" },
  { method: "POST", path: /^\/v2\/billing\/checkout$/, goal: "checkout_started", params: { plan: "standard" } },
  { method: "POST", path: /^\/v2\/billing\/portal$/, goal: "billing_portal_opened" },
];

/** The goal for a request that succeeded, or undefined. `path` may carry a query string. */
export function goalFor(method: string, path: string): { goal: string; params?: Record<string, string> } | undefined {
  const p = path.split("?")[0]!;
  const m = method.toUpperCase();
  const s = STEPS.find((x) => x.method === m && x.path.test(p));
  return s ? { goal: s.goal, params: s.params } : undefined;
}

/** Called by the API client after a successful request. */
export function trackRequest(method: string, path: string): void {
  const g = goalFor(method, path);
  if (g) track(g.goal, g.params);
}
