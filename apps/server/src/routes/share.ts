import { Hono } from "hono";
import type { Deps } from "../context.js";
import { cardByToken, firstSaleHtml, firstSaleSvg } from "../services/assistant/first-sale.js";

/**
 * Public share pages (prd/ai-assistant/PRD.md §4): GET /share/first-sale/<token> (HTML with Open Graph tags) and
 * GET /share/first-sale/<token>.svg (the 1200×630 card). The token is the only key; the card holds no personal data.
 */
export function shareRoutes(deps: Deps) {
  const r = new Hono();
  r.get("/share/first-sale/:token", async (c) => {
    const raw = c.req.param("token");
    const svg = raw.endsWith(".svg");
    const card = await cardByToken(deps.db, svg ? raw.slice(0, -4) : raw);
    if (!card) return c.text("Not found", 404);
    if (svg) return c.body(firstSaleSvg(card.data), 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
    const origin = (deps.apiUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    return c.html(firstSaleHtml(card.data, `${origin}/share/first-sale/${card.id}`, `${origin}/share/first-sale/${card.id}.svg`), 200, { "cache-control": "public, max-age=300" });
  });
  return r;
}
