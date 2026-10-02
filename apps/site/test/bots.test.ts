import { describe, expect, it, vi } from "vitest";
import { trackCrawler } from "../worker/bots";

const req = (url: string, ua: string | null, init: RequestInit = {}) => new Request(url, { ...init, headers: { ...(ua ? { "user-agent": ua } : {}), "cf-connecting-ip": "203.0.113.9" } });
const ok = new Response("ok", { status: 200 });

describe("trackCrawler", () => {
  it("reports a known AI crawler with the path only, the status and the IP", () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    const waits: Promise<unknown>[] = [];
    trackCrawler(req("https://revenuedot.app/pricing?token=secret", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"), ok, { waitUntil: (p) => void waits.push(p) }, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://datafa.st/api/ai-crawls");
    expect(JSON.parse(init.body as string)).toEqual({
      websiteId: "dfid_D9m4bJCw2lmFrxMQaatXu", domain: "revenuedot.app", href: "https://revenuedot.app/pricing",
      ai: { userAgent: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", ip: "203.0.113.9", statusCode: 200, source: "server_middleware" },
    });
    expect(waits).toHaveLength(1);
  });

  it("reports crawler-facing files", () => {
    for (const path of ["/llms.txt", "/robots.txt", "/sitemap.xml", "/docs/setup.md"]) {
      const fetcher = vi.fn(async () => new Response("{}"));
      trackCrawler(req(`https://revenuedot.app${path}`, "ClaudeBot/1.0"), ok, undefined, fetcher as unknown as typeof fetch);
      expect(fetcher, path).toHaveBeenCalledTimes(1);
    }
  });

  it("skips browsers, assets, non-GET requests and requests without a user agent", () => {
    const cases: Request[] = [
      req("https://revenuedot.app/", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
      req("https://revenuedot.app/logo.png", "GPTBot/1.2"),
      req("https://revenuedot.app/api/contact-sales", "GPTBot/1.2", { method: "POST" }),
      req("https://revenuedot.app/", null),
      req("https://revenuedot.app/", "Mozilla/5.0 (Linux; Android 13; CUBOT_X5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"),
      req("https://revenuedot.app/", "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0 Safari/537.36 BIDUBrowser/8.7"),
      req("https://preview.revenuedot.workers.dev/", "GPTBot/1.2"),
    ];
    for (const r of cases) {
      const fetcher = vi.fn(async () => new Response("{}"));
      trackCrawler(r, ok, undefined, fetcher as unknown as typeof fetch);
      expect(fetcher, `${r.method} ${r.url}`).not.toHaveBeenCalled();
    }
  });

  it("never throws or blocks when DataFast is down", async () => {
    const waits: Promise<unknown>[] = [];
    trackCrawler(req("https://revenuedot.app/", "PerplexityBot/1.0"), ok, { waitUntil: (p) => void waits.push(p) }, (async () => { throw new Error("down"); }) as unknown as typeof fetch);
    await expect(Promise.all(waits)).resolves.toBeDefined();
  });
});
