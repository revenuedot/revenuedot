// Where analytics may not set cookies (docs/analytics.md, the Cookie policy): visitors in the EEA, the UK and Switzerland get DataFast's
// cookieless script, everyone else the cookie script that Stripe revenue attribution needs. The Worker decides from Cloudflare's country
// and swaps the script's address in the page it serves, so the page needs no extra request and no banner.
// https://datafa.st/docs/gdpr-cookieless-tracking
const COOKIELESS = new Set([
  // EU
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EEA and the others that follow the same rules
  "IS", "LI", "NO", "GB", "CH",
]);
const DEFAULT_SCRIPT = "https://datafa.st/js/script.js";
const COOKIELESS_SCRIPT = "https://datafa.st/js/script.cookieless.js";

export const needsCookieless = (country: string | null | undefined): boolean => !!country && COOKIELESS.has(country.toUpperCase());

type El = { getAttribute(n: string): string | null; setAttribute(n: string, v: string): void };
type Rewriter = new () => { on(sel: string, h: { element(e: El): void }): { transform(r: Response): Response } };

/** The same page, with the cookieless tracker for visitors who must not get cookies. Other responses pass through untouched. */
export function applyConsent(request: Request, response: Response): Response {
  const country = (request as Request & { cf?: { country?: string } }).cf?.country;
  if (!needsCookieless(country)) return response;
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const HTMLRewriter = (globalThis as unknown as { HTMLRewriter?: Rewriter }).HTMLRewriter;
  if (!HTMLRewriter) return response;
  return new HTMLRewriter()
    .on("script[data-website-id]", { element(el) { if (el.getAttribute("src") === DEFAULT_SCRIPT) el.setAttribute("src", COOKIELESS_SCRIPT); } })
    .transform(response);
}
