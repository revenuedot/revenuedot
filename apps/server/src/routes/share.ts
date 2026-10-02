import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { cardByToken, firstSaleHtml, firstSaleSvg } from "../services/assistant/first-sale.js";
import { sha256Hex } from "../services/auth.js";
import { cardPngBase64, cardSvg, goneHtml, shareHtml, type ChartSnapshot } from "../services/charts/share.js";
import { b64decode } from "../services/paywalls.js";

/**
 * Public share pages (prd/ai-assistant/PRD.md §4): GET /share/first-sale/<token> (HTML with Open Graph tags) and
 * GET /share/first-sale/<token>.svg (the 1200×630 card). The token is the only key; the card holds no personal data.
 *
 * Chart share links (prd/charts/PRD.md "Share preview"): GET /share/charts/<token> (the page), …/og.png (the 1200×630
 * link preview) and …/chart.svg. They draw the snapshot taken when the link was made. A link is found by its token's
 * SHA-256, and read on every request, so a revoked link answers 410 at once: responses are revalidated each time (ETag),
 * never served from a cache after a revoke. Nothing here draws much: the PNG was drawn when the link was made, and each
 * process keeps the pages and SVGs it drew (a link's snapshot never changes), so a public link cannot keep a server busy.
 */
const CHART_TOKEN = /^cs_[A-Za-z0-9_-]{32}$/;
const DRAWN_MAX_CHARS = 8_000_000;

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

  // Pages and SVGs this process drew, least recently used first, within DRAWN_MAX_CHARS.
  const drawn = new Map<string, string>();
  let drawnChars = 0;
  const draw = (key: string, make: () => string) => {
    const hit = drawn.get(key);
    if (hit !== undefined) { drawn.delete(key); drawn.set(key, hit); return hit; }
    const out = make();
    drawn.set(key, out);
    drawnChars += out.length;
    for (const [k, v] of drawn) { if (drawnChars <= DRAWN_MAX_CHARS || k === key) break; drawn.delete(k); drawnChars -= v.length; }
    return out;
  };

  const S = schema.chartShares;
  const charts = async (c: Context, kind: "html" | "png" | "svg") => {
    const token = c.req.param("token") ?? "";
    const row = CHART_TOKEN.test(token)
      ? (await deps.db.select({ id: S.id, snapshot: S.snapshot, image: S.image, revokedAt: S.revokedAt }).from(S).where(eq(S.tokenHash, await sha256Hex(token))).limit(1))[0]
      : undefined;
    const base = { "x-content-type-options": "nosniff", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };
    if (!row || row.revokedAt) {
      const status = row ? 410 : 404;
      return kind === "html" ? c.html(goneHtml(!!row), status, { ...base, "cache-control": "no-store" }) : c.body(null, status, { ...base, "cache-control": "no-store" });
    }
    const snap = row.snapshot as unknown as ChartSnapshot;
    const etag = `"${row.id}-${kind}-${snap.computed_at}"`;
    const headers: Record<string, string> = { ...base, "cache-control": "no-cache", etag };
    const inm = c.req.header("if-none-match");
    if (inm && inm.split(",").map((x) => x.trim().replace(/^W\//, "")).includes(etag)) return new Response(null, { status: 304, headers });
    if (kind === "png") {
      // Links made before the PNG was kept (or copied without it) get it drawn once and saved.
      let image = row.image;
      if (!image) { image = await cardPngBase64(snap); await deps.db.update(S).set({ image }).where(eq(S.id, row.id)); }
      return c.body(b64decode(image) as unknown as ArrayBuffer, 200, { ...headers, "content-type": "image/png" });
    }
    if (kind === "svg") return c.body(draw(`${row.id}:svg`, () => cardSvg(snap)), 200, { ...headers, "content-type": "image/svg+xml; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
    const origin = (deps.apiUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    return c.html(draw(`${row.id}:html:${origin}`, () => shareHtml(snap, `${origin}/share/charts/${token}`)), 200, {
      ...headers, "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
  };
  r.get("/share/charts/:token", (c) => charts(c, "html"));
  r.get("/share/charts/:token/og.png", (c) => charts(c, "png"));
  r.get("/share/charts/:token/chart.svg", (c) => charts(c, "svg"));
  return r;
}
