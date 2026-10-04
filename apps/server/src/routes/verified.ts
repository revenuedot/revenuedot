import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { publicPage, VERIFIED_ORIGIN, type PublicMetric, type PublicPage } from "../services/verified.js";
import { Raster, encodePng, hex } from "../services/og-png.js";
import { sha256Hex } from "../services/auth.js";
import { b64decode } from "../services/paywalls.js";
import { requestOrigin } from "../services/account-email.js";

/**
 * Public Verified Metrics pages (prd/project-settings §4), on the API host:
 *   GET /verified/{slug}               the page (HTML, no scripts)
 *   GET /verified/{slug}/metrics.json  the same numbers as JSON
 *   GET /verified/{slug}/og.png        the 1200×630 link preview
 *   GET /verified/{slug}/icon          the project icon, when the page shows it
 * Only published pages answer. Responses are public for 5 minutes in browsers and 15 at the edge; the Worker also keeps a
 * copy in the edge cache keyed by the page's version, so a busy page does not recompute the overview and a saved or
 * unpublished page is never served from an old copy.
 */

const CACHE = "public, max-age=300, s-maxage=900";

interface EdgeCache { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> }
const edgeCache = (): EdgeCache | null => (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default ?? null;
const waitUntil = (c: Context, p: Promise<unknown>) => { try { (c as unknown as { executionCtx: { waitUntil(p: Promise<unknown>): void } }).executionCtx.waitUntil(p); } catch { /* Node */ } };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function formatMetric(m: Pick<PublicMetric, "unit" | "value">, compact = false): string {
  const v = m.value;
  if (compact && Math.abs(v) >= 10_000) {
    const [n, s] = Math.abs(v) >= 1_000_000 ? [v / 1_000_000, "M"] : [v / 1_000, "K"];
    return `${m.unit === "$" ? "$" : ""}${n.toFixed(n >= 100 ? 0 : 1)}${s}`;
  }
  const whole = Math.round(v).toLocaleString("en-US");
  return m.unit === "$" ? `$${whole}` : whole;
}

function sparkSvg(values: number[]): string {
  if (values.length < 2) return "";
  const w = 240, h = 44, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 6) + 3, h - 4 - ((v - min) / span) * (h - 8)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1]!;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d} L${lx.toFixed(1)} ${h} L3 ${h} Z" fill="var(--spark-fill)"/><path d="${d}" fill="none" stroke="var(--fg)" stroke-width="1.25" vector-effect="non-scaling-stroke"/><rect x="${(lx - 3).toFixed(1)}" y="${(ly - 3).toFixed(1)}" width="6" height="6" fill="var(--accent)"/></svg>`;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTH[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(2, 4)}`;

/** The "Line charts" type: the last 12 calendar months, one point per month, with its range and first and last month. */
function lineSvg(m: PublicMetric): string {
  const pts = m.history;
  if (pts.length < 2) return `<div class="cap nohist">No monthly history for this metric.</div>`;
  const w = 320, h = 120, top = 8, bottom = 22, values = pts.map((x) => x.value);
  const min = Math.min(0, ...values), max = Math.max(...values), span = max - min || 1;
  const xy = values.map((v, i) => [(i / (values.length - 1)) * (w - 8) + 4, top + (h - top - bottom) * (1 - (v - min) / span)] as const);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const base = (h - bottom).toFixed(1);
  const [lx, ly] = xy[xy.length - 1]!;
  const peak = formatMetric({ unit: m.unit, value: max }, true);
  const label = `${m.name} by month from ${monthLabel(pts[0]!.date)} to ${monthLabel(pts[pts.length - 1]!.date)}: ${pts.map((x) => formatMetric({ unit: m.unit, value: x.value })).join(", ")}`;
  return `<svg class="line" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
    + `<line x1="0" x2="${w}" y1="${top}" y2="${top}" stroke="var(--border)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`
    + `<line x1="0" x2="${w}" y1="${base}" y2="${base}" stroke="var(--border)" vector-effect="non-scaling-stroke"/>`
    + `<path d="${d} L${lx.toFixed(1)} ${base} L4 ${base} Z" fill="var(--spark-fill)"/><path d="${d}" fill="none" stroke="var(--fg)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
    + xy.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6" fill="var(--fg)"/>`).join("")
    + `<rect x="${(lx - 3.5).toFixed(1)}" y="${(ly - 3.5).toFixed(1)}" width="7" height="7" fill="var(--accent)"/></svg>`
    + `<div class="axis"><span>${esc(monthLabel(pts[0]!.date))}</span><span>Peak ${esc(peak)}</span><span>${esc(monthLabel(pts[pts.length - 1]!.date))}</span></div>`;
}

function chartOf(p: PublicPage, m: PublicMetric): string {
  if (p.chart_type === "numbers_only") return "";
  if (p.chart_type === "line") return lineSvg(m);
  return sparkSvg(m.sparkline);
}

function html(p: PublicPage, url: string): string {
  const title = `${p.display_name}: verified metrics`;
  const desc = p.metrics.slice(0, 3).map((m) => `${m.name} ${formatMetric(m)}`).join(" · ") || "Verified revenue metrics";
  const when = new Date(p.computed_at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const cells = p.metrics.map((m) => `<div class="cell"><div class="label">${esc(m.name)}</div><div class="value">${esc(formatMetric(m))}</div><div class="cap">${esc(m.caption)}</div>${chartOf(p, m)}</div>`).join("");
  const links = [p.store_links.app_store ? `<a class="btn" href="${esc(p.store_links.app_store)}" rel="noopener">App Store</a>` : "", p.store_links.play_store ? `<a class="btn" href="${esc(p.store_links.play_store)}" rel="noopener">Google Play</a>` : ""].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(url)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(url)}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#fff;--panel:#fff;--fg:#0A0A0A;--fg-2:#525252;--fg-3:#737373;--border:#E5E5E5;--accent:#F7B500;--spark-fill:rgba(10,10,10,.05);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0A0A0A;--panel:#111;--fg:#FAFAFA;--fg-2:#A3A3A3;--fg-3:#8A8A8A;--border:#262626;--spark-fill:rgba(250,250,250,.06)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:500 14px/20px Manrope,-apple-system,system-ui,sans-serif;letter-spacing:-.005em}
main{max-width:1040px;margin:0 auto;padding:56px 16px}
.top{display:flex;align-items:center;gap:16px;margin-bottom:32px;flex-wrap:wrap}.icon{width:56px;height:56px;border:1px solid var(--border);object-fit:cover}
h1{margin:0;font-size:34px;line-height:42px;font-weight:600;letter-spacing:-.035em}.badge{display:inline-flex;align-items:center;gap:8px;font:600 11px/16px Manrope;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-3)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}.links{margin-left:auto;display:flex;gap:8px}
.btn{height:32px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--border);background:var(--panel);color:var(--fg);text-decoration:none;font:600 12px/16px Manrope;text-transform:uppercase;letter-spacing:.05em}
.grid{position:relative;display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--border);background:var(--panel)}
.grid:before,.grid:after{content:"";position:absolute;width:9px;height:9px;border:0 solid var(--fg)}.grid:before{top:-5px;left:-5px;border-top-width:1px;border-left-width:1px}.grid:after{bottom:-5px;right:-5px;border-bottom-width:1px;border-right-width:1px}
.cell{padding:20px 20px 16px;border-right:1px solid var(--border);border-bottom:1px solid var(--border)}.cell:nth-child(3n){border-right:0}
.label{font:600 11px/16px Manrope;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-3)}.value{font-size:34px;line-height:42px;font-weight:600;letter-spacing:-.035em;font-variant-numeric:tabular-nums;margin-top:8px}
.cap{color:var(--fg-3);font-size:12px;margin-bottom:12px}.nohist{margin:24px 0 0}
.t-line .grid{grid-template-columns:repeat(2,1fr)}.t-line .cell:nth-child(3n){border-right:1px solid var(--border)}.t-line .cell:nth-child(2n){border-right:0}.t-line .cell{padding:24px 24px 20px}
.axis{display:flex;justify-content:space-between;color:var(--fg-3);font:400 11px/16px "Geist Mono",ui-monospace,monospace;margin-top:4px}
.t-numbers_only .cap{margin-bottom:0}footer{margin-top:24px;color:var(--fg-3);font:400 12px/18px "Geist Mono",ui-monospace,monospace;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer a{color:var(--fg-2)}.empty{padding:40px;color:var(--fg-2);border:1px solid var(--border)}
@media (max-width:760px){.grid,.t-line .grid{grid-template-columns:1fr}.cell,.t-line .cell,.t-line .cell:nth-child(3n){border-right:0}.links{margin-left:0}h1{font-size:28px;line-height:34px}}
</style></head><body class="t-${p.chart_type}"><main>
<div class="top">${p.icon_url ? `<img class="icon" src="${esc(p.icon_url)}" alt="">` : ""}<div><div class="badge"><span class="dot"></span>Verified by RevenueDot</div><h1>${esc(p.display_name)}</h1></div><div class="links">${links}</div></div>
${p.metrics.length ? `<div class="grid">${cells}</div>` : `<div class="empty">No metrics are shown on this page.</div>`}
<footer><span>Production data computed by RevenueDot from store receipts and notifications. Updated ${esc(when)}.</span><a href="https://revenuedot.app">revenuedot.app</a></footer>
</main></body></html>`;
}

async function ogImage(p: PublicPage): Promise<Uint8Array> {
  const W = 1200, H = 630, M = 64;
  const ink = hex("#0A0A0A"), fg3 = hex("#737373"), border = hex("#E5E5E5"), gold = hex("#F7B500");
  const r = new Raster(W, H, hex("#FFFFFF"));
  // Badge and title.
  r.rect(M, M + 4, 14, 14, gold);
  r.text(M + 28, M + 4, "VERIFIED BY REVENUEDOT", 2, fg3);
  const scale = Raster.textWidth(p.display_name, 9) <= W - 2 * M ? 9 : 6;
  r.text(M, M + 48, Raster.fit(p.display_name.toUpperCase(), scale, W - 2 * M), scale, ink);
  // Up to three metrics in a hairline grid with crosshair corners.
  const shown = p.metrics.slice(0, 3);
  const top = 250, bottom = H - M - 40, gx = M, gw = W - 2 * M;
  r.rect(gx, top, gw, 1, border); r.rect(gx, bottom, gw, 1, border); r.rect(gx, top, 1, bottom - top, border); r.rect(gx + gw - 1, top, 1, bottom - top, border);
  r.rect(gx - 6, top - 6, 13, 2, ink); r.rect(gx - 6, top - 6, 2, 13, ink); r.rect(gx + gw - 7, bottom + 5, 13, 2, ink); r.rect(gx + gw + 4, bottom - 6, 2, 13, ink);
  const cw = gw / Math.max(1, shown.length);
  shown.forEach((m, i) => {
    const x = gx + i * cw;
    if (i) r.rect(x, top, 1, bottom - top, border);
    r.text(x + 28, top + 28, Raster.fit(m.name.toUpperCase(), 2, cw - 56), 2, fg3);
    const value = formatMetric(m, true);
    const vs = Raster.textWidth(value, 7) <= cw - 56 ? 7 : 5;
    r.text(x + 28, top + 64, value, vs, ink);
    const pts = p.chart_type === "line" ? m.history.map((x) => x.value) : p.chart_type === "numbers_only" ? [] : m.sparkline;
    if (pts.length >= 2) {
      const sx = x + 28, sw = cw - 56, sy = bottom - 90, sh = 60;
      const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
      const at = (j: number) => [sx + (j / (pts.length - 1)) * sw, sy + sh - ((pts[j]! - min) / span) * sh] as const;
      for (let j = 1; j < pts.length; j++) { const [ax, ay] = at(j - 1); const [bx, by] = at(j); r.line(ax, ay, bx, by, 3, ink); }
      const [lx, ly] = at(pts.length - 1);
      r.rect(lx - 6, ly - 6, 12, 12, gold);
    }
  });
  if (!shown.length) r.text(gx + 28, top + 40, "NO METRICS SHOWN", 3, fg3);
  r.text(M, H - M - 14, Raster.fit(`VERIFIED/${p.slug}`.toUpperCase(), 2, W - 2 * M), 2, fg3);
  return encodePng(r);
}

export function verifiedRoutes(deps: Deps) {
  const r = new Hono();

  const load = async (slug: string) => {
    const [row] = await deps.db.select().from(schema.verifiedPages).where(eq(schema.verifiedPages.slug, slug.toLowerCase())).limit(1);
    return row && row.status === "published" ? row : null;
  };
  const notFound = (c: Context) => c.json({ object: "error", type: "resource_missing", message: "This verified metrics page does not exist or is not published." }, 404, { "cache-control": "no-store" });
  const originOf = (c: Context) => {
    if (deps.apiUrl) return deps.apiUrl.replace(/\/+$/, "");
    return requestOrigin(c.req.url, (n) => c.req.header(n));
  };

  /**
   * Serves from the edge cache when possible; computes, tags with an ETag and stores otherwise. The page row is read first
   * (one indexed lookup): an unpublished page answers 404 at once in every data centre, and the cache key carries the
   * row's version, so a saved change is never served stale from a copy another data centre kept.
   */
  const serve = async (c: Context, kind: "html" | "json" | "png") => {
    const row = await load(c.req.param("slug")!);
    if (!row) return notFound(c);
    const cache = edgeCache();
    const origin = originOf(c);
    // Keyed by the page's own URL (its custom domain or the API host), so no request header can file one under the other.
    const pageKey = VERIFIED_ORIGIN.get(c.req.raw) ?? `${originOf(c)}/verified/${row.slug}`;
    const key = cache ? new Request(`${pageKey}/${kind}?v=${row.updatedAt.getTime()}`, { method: "GET" }) : null;
    if (cache && key && !c.req.header("if-none-match")) {
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) return hit;
    }
    // On the page's custom domain (app.ts) every link names that domain.
    const pageUrl = VERIFIED_ORIGIN.get(c.req.raw) ?? `${origin}/verified/${row.slug}`;
    const page = await publicPage(deps.db, row, deps.now(), `${pageUrl}/icon`);
    let bytes: Uint8Array | string, type: string;
    if (kind === "json") { bytes = JSON.stringify({ object: "verified_metrics_page", url: pageUrl, ...page }); type = "application/json; charset=utf-8"; }
    else if (kind === "png") { bytes = await ogImage(page); type = "image/png"; }
    else { bytes = html(page, pageUrl); type = "text/html; charset=utf-8"; }
    // The ETag follows the numbers, not the computation time, so an unchanged page answers 304.
    const etag = `"${(await sha256Hex(`${kind}:${JSON.stringify({ ...page, computed_at: 0 })}`)).slice(0, 32)}"`;
    const headers: Record<string, string> = {
      "content-type": type, "cache-control": CACHE, etag, "x-content-type-options": "nosniff", "access-control-allow-origin": "*",
      ...(kind === "html" ? { "content-security-policy": "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } : {}),
    };
    const inm = c.req.header("if-none-match");
    if (inm && inm.split(",").map((x) => x.trim().replace(/^W\//, "")).includes(etag)) return new Response(null, { status: 304, headers });
    const res = new Response(c.req.method === "HEAD" ? null : (bytes as BodyInit), { headers });
    if (cache && key && c.req.method === "GET") waitUntil(c, cache.put(key, res.clone()).catch(() => undefined));
    return res;
  };

  // The project icon, by slug: the page never shows the asset's project-scoped URL (which names the project id).
  r.get("/verified/:slug/icon", async (c) => {
    const row = await load(c.req.param("slug"));
    if (!row?.showIcon || !row.iconAssetId) return notFound(c);
    const [a] = await deps.db.select({ id: schema.mediaAssets.id, contentType: schema.mediaAssets.contentType, data: schema.mediaAssets.dataBase64 }).from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.projectId, row.projectId), eq(schema.mediaAssets.id, row.iconAssetId), eq(schema.mediaAssets.kind, "image"))).limit(1);
    if (!a) return notFound(c);
    const etag = `"${a.id}"`;
    const headers = { "content-type": a.contentType, "cache-control": CACHE, etag, "x-content-type-options": "nosniff", "access-control-allow-origin": "*", "content-security-policy": "default-src 'none'; sandbox" };
    const inm = c.req.header("if-none-match");
    if (inm && inm.split(",").map((x) => x.trim().replace(/^W\//, "")).includes(etag)) return new Response(null, { status: 304, headers });
    return new Response(c.req.method === "HEAD" ? null : b64decode(a.data), { headers });
  });
  r.get("/verified/:slug", (c) => serve(c, "html"));
  r.get("/verified/:slug/metrics.json", (c) => serve(c, "json"));
  r.get("/verified/:slug/og.png", (c) => serve(c, "png"));
  return r;
}
