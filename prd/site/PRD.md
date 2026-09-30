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
| `/docs`, `/docs/<path>`, `/docs/api/*` | The revenuedot/docs repo rendered at build time (see "Docs and blog" below) |
| `/blog`, `/blog/<slug>` | Posts from the docs repo's `blog/`, newest first |
| `/changelog` | Milestones |
| `/legal/*`, `/security` | Terms, privacy, cookies, DPA summary, acceptable use, licensing and trademarks, responsible disclosure |

Circo, Inc. appears only on legal pages; no street address anywhere. Every legal page carries a "LEGAL DRAFT, needs counsel review" code comment.

## SEO and AI answers
- Per-page title and description, canonical, OG/Twitter image (`brand/kit-social/revenuedot.png`, copied at build).
- JSON-LD: Organization everywhere; WebSite and SoftwareApplication (offers = available plans) on home; FAQPage on home, pricing, compare, migrate, self-host; BreadcrumbList on inner pages; HowTo on migrate.
- JSON-LD on docs pages: TechArticle and BreadcrumbList; on blog posts: BlogPosting and BreadcrumbList.
- `sitemap.xml` (the page files plus every docs page and blog post, with each file's last commit date), `robots.txt` (allows AI crawlers by name), `/.well-known/security.txt`.
- `llms.txt`, `llms-full.txt` and `llms/<section>.txt` at the site root come from the docs repo (its `llms.txt` is canonical), with links pointed at the `.md` twins on revenuedot.app; `llms.txt` gains a "Website" section for the marketing pages.
- `_redirects` covers the docs URLs used in code that have no page: `/docs/self-hosting` and `/docs/mcp`. `check` fails on any other unresolved revenuedot.app/docs or /blog URL in the workspace.

## Docs and blog
The build reads the revenuedot/docs repo checked out next to this monorepo (`../docs` from the repo root; `DOCS_DIR` overrides it, relative to `apps/site`) and fails with clone instructions when it is missing.
- **URLs.** `docs/<section>/<page>.md` is `/docs/<section>/<page>`, a section `README.md` is `/docs/<section>`, `api/<page>.md` is `/docs/api/<page>`, `blog/<slug>.md` is `/blog/<slug>`, and `api/openapi.yaml` is served at `/docs/api/openapi.yaml`. Relative links in the Markdown are rewritten to these URLs; links to other workspace repos go to GitHub.
- **Markdown twins.** Every docs and blog URL plus `.md` (`/docs.md`, `/blog.md` too) returns the page's Markdown with frontmatter and absolute links.
- **Layout.** Three columns at 1240px and up: section nav (collapsible sections, a drawer under 1024px), the page, and an on-page table of contents that marks the heading in view. Shiki code blocks use a neutral theme made of CSS variables (one HTML for light and dark) with a language label and a copy button. Each page ends with "Edit on GitHub" (API pages link to the OpenAPI source), "View as Markdown", the last commit date, and previous and next pages in sidebar order.
- **Search.** Pagefind indexes the docs, API reference and blog at build time (`dist/pagefind`); ⌘K, Ctrl+K or "/" opens the dialog. The CSP allows `wasm-unsafe-eval` for it.
- **Titles.** The page title is the docs page's question title plus " | RevenueDot Docs" when it fits in 70 characters, else the sidebar label. Meta descriptions keep whole sentences up to 170 characters.
- **Sidebar order and labels** live in `src/lib/docs.ts`; a new docs folder without a section there fails the build.

## Analytics
Cloudflare Web Analytics (cookieless), on only when `PUBLIC_CF_WEB_ANALYTICS_TOKEN` is set at build time. The privacy and cookie pages describe it.

## Commands
- `pnpm --filter site dev` (4321; search needs a build), `build` (Astro, then Pagefind), `preview` (4322), `check` (links and #anchors, meta, JSON-LD, sitemap, `.md` twins, llms files, the Pagefind index, and every revenuedot.app/docs or /blog URL in the sibling repos; `CHECK_WORKSPACE=0` skips that scan), `shots` (every page at 1440 and 390, light or `--dark`, fails on horizontal scroll), `capture` (dashboard screenshots from the seeded e2e server).
- Deploy: `pnpm --filter site run deploy` (build, check, then `cf deploy --prebuilt` to revenuedot.app and www; config `apps/site/cloudflare.config.ts`). Live at https://revenuedot.app; www redirects to the apex with a zone redirect rule.
