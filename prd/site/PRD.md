# Marketing site (scope 1.16)

**revenuedot.app is a static Astro site in `apps/site` that answers the three searches that bring switchers: "open source RevenueCat alternative", "self-host RevenueCat" and "RevenueCat pricing alternative".** It follows `DESIGN.md` and imports `design/tokens.css` directly, so the site and the dashboard share one palette.

## Pages
| Path | Job |
|---|---|
| `/` | What RevenueDot is, the one line, how switching works, real dashboard captures, cost table, FAQ |
| `/pricing` | Self-host free; Cloud Free (available); Cloud Standard and Enterprise marked "Coming"; bill calculator; FAQ |
| `/revenuedot-vs-revenuecat` | Fair, sourced comparison, including when to stay on RevenueCat; "not affiliated" notice; no RevenueCat logo |
| `/migrate-from-revenuecat` | Importer, dual-run forwarding, the proxy line for all nine SDKs, fork packages, HowTo JSON-LD |
| `/self-host` | docker compose, what runs, self-host vs cloud, production checklist |
| `/docs`, `/blog`, `/changelog` | Docs hub linking to github.com/revenuedot/docs; blog index built from `../docs/blog` front matter; milestones |
| `/legal/*`, `/security` | Terms, privacy, cookies, DPA summary, acceptable use, licensing and trademarks, responsible disclosure |

Circo, Inc. appears only on legal pages; no street address anywhere. Every legal page carries a "LEGAL DRAFT, needs counsel review" code comment.

## SEO and AI answers
- Per-page title and description, canonical, OG/Twitter image (`brand/kit-social/revenuedot.png`, copied at build).
- JSON-LD: Organization everywhere; WebSite and SoftwareApplication (offers = available plans) on home; FAQPage on home, pricing, compare, migrate, self-host; BreadcrumbList on inner pages; HowTo on migrate.
- `sitemap.xml` (derived from the page files), `robots.txt` (allows AI crawlers by name), `llms.txt`, `/.well-known/security.txt`.
- `_redirects` sends `revenuedot.app/docs/*` deep links (used across examples) to the closest page until the docs site exists.

## Analytics
Cloudflare Web Analytics (cookieless), on only when `PUBLIC_CF_WEB_ANALYTICS_TOKEN` is set at build time. The privacy and cookie pages describe it.

## Commands
- `pnpm --filter site dev` (4321), `build`, `preview` (4322), `check` (links, meta, JSON-LD, sitemap), `shots` (every page at 1440 and 390, light or `--dark`, fails on horizontal scroll), `capture` (dashboard screenshots from the seeded e2e server).
- Deploy: `pnpm --filter site run deploy` (build, check, `wrangler deploy` to revenuedot.app and www). Needs approval.
