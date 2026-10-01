import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

/**
 * The shareable first-sale card (prd/ai-assistant/PRD.md §4). When a project's first paid production purchase arrives,
 * the tick saves a card with an unguessable token: what was bought, for how much, in which store and country, and when.
 * No app user id or other personal data is on it. Projects whose first sale is older than FRESH_DAYS get a skipped
 * marker instead, so established apps never see a "first sale" months later and are not scanned again.
 */
const T = schema.transactions, Card = schema.aiShareCards;
const PAID = ["purchase", "renewal", "one_time"];
export const FRESH_DAYS = 14;

export interface FirstSale {
  project_name: string;
  product: string;
  store: string;
  country: string | null;
  amount: number | null;
  currency: string | null;
  revenue_usd: number;
  purchased_at: number;
}

const token = () => {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return `fs_${btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};

/** Creates cards for projects with a recent first sale. At most `limit` projects per call. Returns how many cards were made. */
export async function ensureFirstSaleCards(db: DB, now: Date, limit = 20): Promise<number> {
  const since = new Date(now.getTime() - FRESH_DAYS * 86400_000);
  const due = await db.selectDistinct({ projectId: T.projectId }).from(T)
    .where(and(eq(T.isSandbox, false), inArray(T.kind, PAID), gt(T.revenueUsd, 0), gt(T.purchasedAt, since),
      sql`not exists (select 1 from ${Card} where ${Card.projectId} = ${T.projectId} and ${Card.kind} = 'first_sale')`))
    .limit(limit);
  let made = 0;
  for (const { projectId } of due) {
    const [first] = await db.select({ t: T, appName: schema.apps.name, projectName: schema.projects.name }).from(T)
      .innerJoin(schema.projects, eq(schema.projects.id, T.projectId))
      .leftJoin(schema.apps, eq(schema.apps.id, T.appId))
      .where(and(eq(T.projectId, projectId), eq(T.isSandbox, false), inArray(T.kind, PAID), gt(T.revenueUsd, 0)))
      .orderBy(asc(T.purchasedAt)).limit(1);
    if (!first) continue;
    const fresh = first.t.purchasedAt.getTime() >= since.getTime();
    const data: FirstSale | { skipped: true } = fresh ? {
      project_name: first.projectName, product: first.t.productIdentifier, store: first.t.store, country: first.t.countryCode,
      amount: first.t.priceAmount, currency: first.t.priceCurrency, revenue_usd: first.t.revenueUsd, purchased_at: first.t.purchasedAt.getTime(),
    } : { skipped: true };
    const r = await db.insert(Card).values({ id: token(), projectId, kind: "first_sale", data: data as unknown as Record<string, unknown>, createdAt: now }).onConflictDoNothing().returning({ id: Card.id });
    if (r.length && fresh) made++;
  }
  return made;
}

export async function firstSaleCard(db: DB, projectId: string) {
  const [row] = await db.select().from(Card).where(and(eq(Card.projectId, projectId), eq(Card.kind, "first_sale"))).limit(1);
  if (!row || (row.data as { skipped?: boolean }).skipped) return null;
  return { id: row.id, data: row.data as unknown as FirstSale, created_at: row.createdAt.getTime() };
}

export async function cardByToken(db: DB, id: string) {
  if (!/^fs_[A-Za-z0-9_-]{20,40}$/.test(id)) return null;
  const [row] = await db.select().from(Card).where(eq(Card.id, id)).limit(1);
  if (!row || (row.data as { skipped?: boolean }).skipped) return null;
  return { id: row.id, data: row.data as unknown as FirstSale };
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const STORES: Record<string, string> = { app_store: "App Store", mac_app_store: "Mac App Store", play_store: "Google Play", amazon: "Amazon Appstore", stripe: "Stripe", test_store: "Test Store", promotional: "Promotional", rc_billing: "Web" };

export function priceText(d: FirstSale) {
  if (d.amount !== null && d.currency) {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: d.currency }).format(d.amount); } catch { /* unknown currency */ }
    return `${d.amount} ${d.currency}`;
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(d.revenue_usd);
}

/** The 1200×630 card (Open Graph size), in the design tokens' light theme: white, near-black ink, one gold dot. */
export function firstSaleSvg(d: FirstSale): string {
  const when = new Date(d.purchased_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const meta = [STORES[d.store] ?? d.store, d.country, when].filter(Boolean).join("  ·  ");
  const name = d.project_name.length > 28 ? `${d.project_name.slice(0, 27)}…` : d.project_name;
  const product = d.product.length > 44 ? `${d.product.slice(0, 43)}…` : d.product;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#FFFFFF"/>
<rect x="40" y="40" width="1120" height="550" fill="none" stroke="#E5E5E5" stroke-width="2"/>
<path d="M40 64V40h24M1160 566v24h-24" fill="none" stroke="#0A0A0A" stroke-width="2"/>
<g font-family="Manrope, ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">
<text x="96" y="140" font-size="22" font-weight="600" letter-spacing="2.6" fill="#737373">FIRST SALE</text>
<circle cx="250" cy="132" r="7" fill="#F7B500"/>
<text x="96" y="252" font-size="76" font-weight="600" letter-spacing="-3" fill="#0A0A0A">${esc(name)}</text>
<text x="96" y="330" font-size="34" font-weight="500" fill="#525252">just made its first sale.</text>
<text x="96" y="456" font-size="92" font-weight="600" letter-spacing="-3.5" fill="#0A0A0A">${esc(priceText(d))}</text>
<text x="96" y="512" font-family="Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24" fill="#737373">${esc(product)}  ·  ${esc(meta)}</text>
<text x="1104" y="548" text-anchor="end" font-size="26" font-weight="600" letter-spacing="-0.8" fill="#0A0A0A">RevenueDot</text>
<circle cx="1118" cy="540" r="5" fill="#F7B500"/>
</g>
</svg>`;
}

/** The public share page: the card, Open Graph and Twitter tags, nothing else. */
export function firstSaleHtml(d: FirstSale, pageUrl: string, imageUrl: string): string {
  const title = `${d.project_name} made its first sale`;
  const desc = `${priceText(d)} for ${d.product} on ${STORES[d.store] ?? d.store}. Powered by RevenueDot.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(pageUrl)}"><meta property="og:image" content="${esc(imageUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(imageUrl)}">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#0a0a0a;font:500 15px/1.5 Manrope,ui-sans-serif,system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}}main{width:min(1200px,100% - 32px);display:flex;flex-direction:column;gap:16px}img{width:100%;height:auto;border:1px solid #e5e5e5}a{color:inherit}</style>
</head><body><main><img src="${esc(imageUrl)}" alt="${esc(`${title}: ${desc}`)}" width="1200" height="630"><p>${esc(desc)} <a href="https://revenuedot.app">revenuedot.app</a></p></main></body></html>`;
}
