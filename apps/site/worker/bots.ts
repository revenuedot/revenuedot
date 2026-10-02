// Bot traffic for DataFast (docs/analytics.md): when an AI assistant, search engine or training crawler asks for a page, tell
// DataFast so its Bot traffic card shows which pages they read. Crawlers fetch raw HTML and never run the tracking script, so this
// is a server-side call. It is best effort: it runs after the response is built, with a short timeout, and never delays a page.
// DataFast classifies the crawler and checks its IP again on its side; the user-agent test here only spares human traffic the call.
// https://datafa.st/docs/bot-traffic-tracking
import { DATAFAST } from "../src/datafast";

const ENDPOINT = "https://datafa.st/api/ai-crawls";
const CRAWLER = /bot|crawl|spider|slurp|chatgpt|gpt|claude|anthropic|perplexity|bingpreview|google|applebot|bytespider|ccbot|cohere|diffbot|meta-external|facebookexternalhit|amazon|duckassist|mistral|youbot|omgili|petalsearch|yandex|baidu|semrush|ahrefs|mj12|ia_archiver|ai2/i;
// Files the browser loads for a page. Crawler-facing files (robots.txt, llms.txt, sitemap.xml, markdown twins) are not in this list.
const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|mp4|webm|json|webmanifest)$/i;

interface Ctx { waitUntil(p: Promise<unknown>): void }

export function trackCrawler(request: Request, response: Response, ctx: Ctx | undefined, fetcher: typeof fetch = fetch): void {
  if (request.method !== "GET" && request.method !== "HEAD") return;
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!userAgent || !CRAWLER.test(userAgent)) return;
  const url = new URL(request.url);
  if (ASSET.test(url.pathname)) return;
  const body = JSON.stringify({
    websiteId: DATAFAST.websiteId,
    domain: url.hostname,
    // The path only: query strings can carry tokens or search text.
    href: `${url.origin}${url.pathname}`,
    ai: { userAgent, ip: request.headers.get("cf-connecting-ip") ?? undefined, statusCode: response.status, source: "server_middleware" },
  });
  const send = fetcher(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(1500) }).catch(() => {});
  if (ctx) ctx.waitUntil(send);
}
