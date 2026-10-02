# RevenueDot design system

**Locked 2026-09-30.** Every screen, the marketing site, docs and emails follow this file. The tokens live in [`design/tokens.css`](design/tokens.css); the reference screen is [`prd/dashboard/mockup.html`](prd/dashboard/mockup.html) (published preview: https://claude.ai/artifact/HsMddzZAGFNxgLztJDaVaL). If code and this file disagree, fix one of them in the same change.

## The style in one paragraph
**RevenueCat's navigation, Superwall's materials, Vercel's restraint.** The information architecture copies RevenueCat's sidebar, because every customer we win already knows where things are. The materials are neutral, like Vercel's: a pure white page, near-black ink, light grey hairlines, square corners, Manrope with monospace figures, uppercase tracked labels, and crosshair corner marks on the key grid. Vercel sets the discipline: one accent, hairlines instead of shadows, generous whitespace, nothing decorative. The accent is ours: the gold dot from the logo.

## 1. Rules
1. **Square.** `--radius: 0` for buttons, inputs, cards, tables, tags and menus. Only the live dot and avatars are round.
2. **Hairlines, not shadows.** Panels are a 1px `--border` on `--panel`. No drop shadows in the app.
3. **One accent.** Gold `--accent` marks what is live or current: the live dot, the sparkline's last point, the focus ring, the current period. Never a large fill, never body text on white (use `--accent-ink`).
4. **Ink is the primary.** Primary buttons and the selected segment are `--fg` fill with `--bg` text. Secondary buttons are a hairline box.
5. **Numbers are the product.** Metrics in Manrope 600 with tabular figures; IDs, table amounts, deltas and counts in `--mono`.
6. **State colours mean state only.** `--up` for growth and healthy, `--down` for decline and failure, `--info` for trials and sandbox.
7. **Both themes.** Light is pure white with neutral greys (no yellow, olive or warm tint); dark is the inverse (`#0A0A0A` ground, `#FAFAFA` ink). Every colour comes from a token.

## 2. Brand mark
- **An R whose leg is finished by a gold dot** ("R3"). Geometry, files and rules: [`brand/README.md`](brand/README.md); kit in `brand/kit/`.
- In the app the mark sits on a square `--fg` tile (26px) at the top of the sidebar.
- **Wordmark:** "RevenueDot", Geist Semibold, tracking −0.035em (outlined in the kit, so it renders without the font).

## 3. Colour tokens
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#0A0A0A` | Page |
| `--panel` | `#FFFFFF` | `#111111` | Cards, tables, inputs |
| `--sidebar` | `#FAFAFA` | `#0D0D0D` | Navigation |
| `--hover` | `#F5F5F5` | `#171717` | Hover |
| `--active` | `#EDEDED` | `#1F1F1F` | Selected nav item |
| `--fg` | `#0A0A0A` | `#FAFAFA` | Text, primary fill |
| `--fg-2` | `#525252` | `#A3A3A3` | Secondary text |
| `--fg-3` | `#6B6B6B` | `#8A8A8A` | Labels, captions |
| `--border` | `#E5E5E5` | `#262626` | Panel edges, grid dividers |
| `--border-2` | `#F0F0F0` | `#1C1C1C` | Row separators |
| `--accent` | `#F7B500` | `#F7B500` | The gold dot |
| `--accent-ink` | `#8A5A00` | `#FFD35C` | Gold text |
| `--up` / `--down` / `--info` | `#587A27` / `#C2410C` / `#2F6F9F` | `#9BC75A` / `#F0875A` / `#7FB7E0` | State |

## 4. Typography
| Role | Spec |
|---|---|
| Page title | Manrope 600, 28/34, tracking −0.035em |
| Panel title | Manrope 600, 14/20 |
| Body, table cells | Manrope 500, 13–14/20, tracking −0.005em |
| Labels, table headers, buttons | Manrope 600, 11–12/16, UPPERCASE, tracking +0.04–0.06em, `--fg-3` (buttons `--fg`) |
| Metric | Manrope 600, 34/42, tabular figures, tracking −0.035em; cents at 18px in `--fg-3` |
| IDs, amounts, deltas, counts, `kbd` | Geist Mono 400–500, 12–13 |
| Marketing display | Manrope 600, 64–88px, tracking −0.045em (Superwall scale) |

Load: `Manrope:wght@400;500;600;700` and `Geist Mono:wght@400;500`.

## 5. Layout
- **Shell:** 232px sidebar (`--sidebar`, right hairline) + 56px top bar (breadcrumb, search with `⌘K`, docs, notifications, theme, primary action) + scrolling page, max 1200px, 32px padding, 24px gaps.
- **Sidebar = RevenueCat's IA, in order:** project switcher → Overview · Analytics ▸ (Charts, Benchmarks) · Customers · Product catalog ▸ (Offerings, Products, Entitlements, In-app currencies, Web discounts) · Paywalls · Targeting · Experiments · Funnels · Ads ▸ (Overview, Rewards) · Lifecycle ▸ (Customer Center, Support, Retention, Refund control, Win-back) · Auth. Pinned to the bottom: Apps · Web · API keys · Integrations · Project settings. Items 32px, 16px icons, selected item = `--active` fill plus a 2px `--fg` inset bar on the left; sub-items indented with a hairline guide.
- **Page head:** title + one muted context line on the left; period segment (7D/28D/90D/12M) and the Sandbox switch on the right.
- **AI bar:** a 44px hairline box under the head: gold sparkle, a real example question, `/` shortcut.
- **Metric grid:** one bordered block split by hairlines (3 × 2), crosshair marks at the top-left and bottom-right corners. Each cell: uppercase label + 14px icon, the number, a mono delta in state colour + context, a 44px sparkline with a 6px gold square on the last point.
- **Panels:** hairline box, 48px header (title left, uppercase "VIEW ALL →" right), 44px rows.
- **Tags:** square, 1px `currentColor` border, uppercase 10.5px (RENEWAL `--up`, TRIAL `--info`, INITIAL `--accent-ink`, BILLING ISSUE and REFUND `--down`).
- **Health rows:** 8px square status block, bold title, muted detail, mono count on the right.

## 6. Components
| Component | Spec |
|---|---|
| Button, primary | 32px, `--fg` fill, `--bg` text, uppercase 12px 600 |
| Button, secondary | 32px, hairline, `--panel` fill; hover border `--fg-3` |
| Icon button | 32px square, border appears on hover |
| Input and search | 32px, hairline, `--panel`, 13px, `kbd` hint in a hairline box |
| Segmented control | hairline outer box, 30px items split by hairlines, selected = `--fg` fill |
| Switch | 30 × 16 square track, square thumb; on = `--fg` |
| Focus | 2px `--accent` outline, 2px offset, on everything interactive |

## 7. Charts
- Sparklines: 1.25px `--spark` line over `--spark-fill`, last point a 6px `--accent` square.
- Full charts: hairline grid, mono axis labels in `--fg-3`, history in `--fg`, the current period in `--accent`. One y axis only: measures with different units are shown one at a time.
- Charts with several series (segments, stacked movements) use `--series-1` … `--series-5` in that fixed order, never cycled, and "Other" in `--fg-3`. The five hues passed the dataviz palette validator in both themes (adjacent colour-blind ΔE ≥ 9.2, normal-vision ΔE ≥ 19.7); every multi-series chart has a legend and a table. Marks stay square; stacked segments are separated by a 2px surface gap.
- Money detail pages may use the MRR waterfall and definition panels ("What MRR is", with the formula as chips), in these tokens.

## 8. Motion
150ms for hover and colour, 200ms for expand and collapse, easing `cubic-bezier(.23, 1, .32, 1)`. The live dot pulses (2s). Nothing else loops. `prefers-reduced-motion` turns motion off.

## 9. Marketing site and docs
Same tokens at Superwall's scale: white background, Manrope display at 64–88px with tight tracking, square black uppercase CTAs, hairline grids with crosshair corners, mono stats (`$11,978.40`, `8,902 notifications today`). Product screenshots are real app captures. Dark sections use the inverse tokens.

## 10. Do not
- Rounded corners, drop shadows, gradients, glass or glow in the app.
- Superwall's orange or RevenueCat's red and indigo.
- More than one accent in a view; gold on large areas.
- Emoji as icons (country flags in customer rows are data, not decoration).
- Copying another product's page layouts beyond the sidebar IA.

## History
- `docs/design/brand.html` is the earlier monochrome-and-gold exploration (Geist, rounded). This file supersedes it.
