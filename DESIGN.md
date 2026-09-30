# RevenueDot design system

**Direction: monochrome infrastructure, one gold dot.** RevenueDot looks like the developer tools enterprises already trust (Vercel's type and restraint, Profound's and Resend's dark enterprise pages, Linear's precision). Everything is black, white and neutral grey. The only brand color is the gold dot: the mark, the live indicator, focus, and the one highlighted number on a page.

Why gold: it reads as revenue without the "money green" every finance chart already uses for "up", it is unused among developer-infrastructure brands (Vercel black, Supabase and Neon green, Stripe, Clerk and Railway purple, Linear indigo, RevenueCat red and indigo), and it looks premium on near-black, which is what enterprise buyers see first.

The dashboard's money screens follow the Mercury-style grammar of our sister product Accountable (`~/Developer/accountable`), recolored: its periwinkle becomes neutral plus the gold dot, because periwinkle sits next to RevenueCat's dashboard indigo and the two sister brands should stay distinct. Accountable's marketing look (light aurora gradients, pill buttons) is not used: RevenueDot's site stays in the Vercel/Profound/Resend developer grammar.

References studied: `revenuedot/company` → `docs/research/contact-sheets/design-references/` (Vercel, Profound, Resend, Stripe, Linear, Mercury, four Magic UI templates) and the RevenueCat dashboard study. The app's compact layout follows the "Compact Workspace" spec (`~/Developer/claude/design/open-sunsama/DESIGN.md`); its measurements are restated in section 7.

Code is the source of truth: `packages/ui/src/tokens.css` (to be created from this file). Keep both in sync.

## 1. Rules
1. **Monochrome first.** Primary buttons are black on light and white on dark. Gold never fills a large area and never fills a primary button.
2. **One dot per view.** Gold marks the single most important thing: the live indicator, the selected state, the headline metric. If two things are gold, one is wrong.
3. **Semantic colors mean state only.** Green is "up / active / paid", red is "down / failed / refunded", orange is "needs attention". They never decorate.
4. **Numbers are the product.** Money and counts use Geist Mono or tabular Geist, right-aligned in tables, with currency and period always shown (`$11,978 MRR`, `983 active`).
5. **Content carries hierarchy.** Size, weight and grey level do the work. Borders are 1px hairlines; one boundary per edge.
6. **Both themes are first class.** The marketing site is dark-first; the dashboard and docs follow the system setting.

## 2. Brand mark
- **Mark: an R whose leg is finished by a gold dot** ("R3", chosen 2026-09-30). Geometry, files and rules: `brand/README.md`; generated kit in `brand/kit/`.
- **Wordmark:** "RevenueDot", Geist Semibold, tracking −0.035em, outlined in `brand/kit/wordmark/`.
- **The gold dot is the only brand colour.** In the product the same dot marks live data (8px, slow pulse).

## 3. Color tokens
All values are sRGB hex; contrast ratios are measured against the matching background.

### Neutrals
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#0A0A0A` | Page |
| `--bg-subtle` | `#FAFAFA` | `#111111` | App canvas, alternating sections |
| `--surface` | `#FFFFFF` | `#141414` | Cards, tables, popovers |
| `--surface-hover` | `#F5F5F5` | `#1A1A1A` | Row and card hover |
| `--muted` | `#F2F2F2` | `#1F1F1F` | Secondary controls, code background |
| `--border` | `#EAEAEA` | `#262626` | Hairlines |
| `--border-strong` | `#D4D4D4` | `#333333` | Inputs, focused edges |
| `--fg` | `#0A0A0A` | `#EDEDED` | Main text (17:1 both themes) |
| `--fg-muted` | `#666666` | `#A1A1A1` | Secondary text (5.7:1 / 7.7:1) |
| `--fg-subtle` | `#8F8F8F` | `#737373` | Placeholders, disabled, axis labels (non-essential only) |
| `--primary` | `#0A0A0A` | `#EDEDED` | Primary button fill |
| `--primary-fg` | `#FFFFFF` | `#0A0A0A` | Text on primary |

### The dot (brand)
| Token | Value | Use |
|---|---|---|
| `--dot` | `#F7B500` | The mark, live dot, focus ring, selected indicator, key metric accent. On dark: 10.9:1 |
| `--dot-bright` | `#FFD35C` | Hover and glow on dark only |
| `--dot-ink` | light `#8A5A00` / dark `#FFD35C` | Gold text (links in docs, highlighted numbers). 5.9:1 on white, 13.9:1 on near-black |
| `--dot-wash` | light `#FFF8E1` / dark `#1F1905` | Tinted background for the one highlighted row or callout |
| Scale | 50 `#FFFAEB` · 100 `#FEF0C7` · 200 `#FEDF89` · 300 `#FFD35C` · 400 `#FFC21A` · 500 `#F7B500` · 600 `#D69A00` · 700 `#A87600` · 800 `#8A5A00` · 900 `#5C3D00` | Charts and illustrations |

Never put `--dot` text on white (1.8:1). Use `--dot-ink`.

### Semantic
| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--success` | `#15803D` | `#22C55E` | Active, paid, renewal, MRR up |
| `--danger` | `#DC2626` | `#F87171` | Failed, refunded, expired, MRR down |
| `--warning` | `#C2410C` | `#FB923C` | Billing issue, grace period, needs action (orange, kept apart from gold) |
| `--info` | `#2563EB` | `#60A5FA` | Sandbox, trial, informational |
Each has a `-wash` background at about 8% opacity for badges.

### Money screens (Accountable / Mercury grammar)
Studied from the latest local Accountable build (2026-09-30): `company/docs/research/contact-sheets/design-references/accountable/`.
- **Metric cards:** title, one muted context line (`As of Sep 30`), the big number (weight 400, cents smaller and muted), a small **delta pill** (`↑ 4.2% vs Aug`, `--success-wash` / `--danger-wash`, 11px), then a 96px chart with a first and last date label only.
- **Charts:** history in `--fg` at 70% (lines 1.5px, bars 60% of the slot) over a vertical gradient fill (18% → 0%). The current period is the gold dot: the last point or bar in `--chart-hi` (light `#A87600`, dark `#F7B500`), a soft band behind it (`rgb(247 181 0/.10)`), and a label `Sep · $11,978`. Projections are dashed. Three faint grid lines, no axis line, 12px `--fg-subtle` labels.
- **Metric detail page:** large chart on the left (y-axis labels at $50K steps), and on the right a **"What MRR is" panel**: a plain-language definition plus the formula as chips (`MRR $11,978 = Monthly $6,240 + Annual ÷ 12 $4,980 + Weekly × 4.33 $758`), then the top contributors. This is where we publish our chart method, the trust point for switching from RevenueCat.
- **"What changed this month":** three AI-written lines, each with the number and its biggest driver, every figure checked against the data.
- **Tables:** an inline 12-month mini bar column (current month gold) next to the amount.
- **Period picker:** a month strip across years with the current month selected.
### Other chart rules
- Main series: `--fg` line with a 12% area fill; the series being explained gets `--dot`.
- Comparison series: `--fg-subtle`, dashed.
- Categorical (up to 6): `#0A0A0A/#EDEDED`, `--dot`, `#2563EB`, `#15803D`, `#9333EA`, `#737373`.
- Movement charts (MRR movement): new and expansion `--success`, churn and contraction `--danger`, net line `--fg`.
- Grid lines: `--border` at 60%. Axis text: `--fg-subtle`, 11px tabular.

## 4. Typography
Families: **Geist** (UI and marketing) and **Geist Mono** (code, IDs, money in tables). Load weights 400, 500, 600.

| Role | Size / line | Weight | Tracking |
|---|---|---|---|
| Marketing display | 64 / 64 (mobile 40 / 44) | 600 | −0.045em |
| Marketing H2 | 40 / 44 (mobile 30 / 34) | 600 | −0.035em |
| Marketing H3 | 20 / 28 | 600 | −0.015em |
| Lead paragraph | 18 / 28 | 400 | 0 |
| Body | 16 / 26 (docs), 14 / 20 (app) | 400 | 0 |
| App page title | 20 / 28 | 600 | −0.02em |
| App section heading | 14 / 20 | 600 | 0 |
| Controls, nav | 13 / 20 | 500 | 0 |
| Metadata | 12 / 16 | 400–500 | 0 |
| Eyebrow / table header | 11 / 16 | 500, uppercase | +0.06em |
| Metric (big number) | 28 / 36 | 400, tabular; cents at 60% size in `--fg-muted` (`$2,480,310.42`) | −0.02em |
| Code | 13 / 20 Geist Mono | 400 | 0 |

Headings use `text-wrap: balance`. Running text stays near 65 characters wide.

## 5. Space, radius, elevation
- Spacing scale: 2, 4, 6, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128px. Marketing sections: 96–128px apart. App gaps: 8–16px.
- Radii: 4 (badges), 6 (inputs, small buttons), 8 (buttons, cards), 12 (dialogs, feature panels), full (avatars, live dot only).
- Shadows (light): card `0 0 0 1px rgb(0 0 0/0.06), 0 1px 2px rgb(0 0 0/0.04)`; popover `0 0 0 1px rgb(0 0 0/0.08), 0 8px 24px -6px rgb(0 0 0/0.16)`.
- Shadows (dark): card `0 0 0 1px rgb(255 255 255/0.07)`; popover `0 0 0 1px rgb(255 255 255/0.10), 0 12px 32px -8px rgb(0 0 0/0.7)`.
- Focus: 2px `--dot` ring with 2px offset, on every interactive element.

## 6. Motion
- 150ms for hover and color, 200ms for state changes, 300ms maximum for panels and page reveals. Easing `cubic-bezier(0.2, 0, 0, 1)`.
- Marketing: one orchestrated moment per section at most (a live purchase feed ticking in, a code sample typing its one changed line, a chart drawing once). Scroll-linked reveals start from a visible state.
- Live dot pulse: 2s, opacity 0.6 → 0, scale 1 → 2.4, infinite. The only looping animation in the app.
- `prefers-reduced-motion`: no pulses, no scroll effects, instant transitions.

## 7. App (dashboard) layout
Follows the Compact Workspace measurements:
- Global header 48px; left sidebar 240px (collapsed 56px) with grouped sections, setup items (Apps, API keys, Webhooks, Settings) pinned at the bottom — the same information architecture as the RevenueCat study.
- Buttons 32px (default) / 28px (dense) / 40px (marketing); 8px radius; 13px medium label.
- Inputs 32px, 6px radius, 13px text.
- Tables: 40px rows, 11px uppercase headers, money right-aligned in Geist Mono, row hover `--surface-hover`, "…" actions at row end.
- Metric cards: label 12px `--fg-muted`, value 32px tabular, period note 12px, sparkline 32px high with area fill. Six cards on Overview in a 3 × 2 grid.
- Detail pages: centred column, max 880px; key-value header block; every object shows its API identifier in Geist Mono with a copy button.
- Empty states: one line of text, one primary button, an optional small monochrome illustration. No stock art.
- Icons: Lucide, 16px, 1.5 stroke.

## 8. Marketing site
- **Signature: the revenue field.** Heroes sit on a dot grid (1.5px dots every 22px, 10% white on dark, 13% black on light, fading towards the edges). Each incoming purchase lights one dot gold with a 2.6s ripple while the totals tick up (`$48,213.60 tracked in the last hour`). Lit dots stay clear of the headline. It is the one exciting moment on the site; nothing else animates in the hero. Reduced motion shows a still field with a few gold dots.
- The hero is dark by default and has a light version (`#FAFAFA` field, gold `#D69A00` dots, dark text) for light pages and light-mode visitors.
- The hero shows the product, not an illustration: the one-line switch (`Purchases.proxyURL = …`) next to a live purchase feed with the gold live dot.
- Proof section: logos in monochrome at 40% opacity; numbers in the metric style.
- Comparison and pricing tables in the app table style.
- Light sections (docs, pricing detail, blog) use `--bg` white with the same grammar.

## 9. Do not
- Gradients, glass blur, glow halos, 3D blobs, purple-to-blue anything.
- Gold backgrounds, gold primary buttons, gold body text on white.
- More than one accent hue per view.
- Pill-shaped buttons everywhere, `rounded-2xl` cards everywhere, stacked borders plus shadows.
- Emoji as icons, illustrations of cartoon cats or dogs, anything that echoes RevenueCat's brand.
