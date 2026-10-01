# Paywalls (scope Tier 2)

**Status:** building on branch `tier2-paywalls` (batch A of `company/docs/research/parity-matrix.md`). Before this branch: a three-template form, a preview drawn by hand, draft, publish and versions on the server. This spec brings the dashboard to RevenueCat's paywall builder: a template gallery, a visual editor over the real component JSON, an AI generator, localizations and a cached asset CDN.

## Users and jobs
- **An indie developer** picks a proven 2026 layout (trial timeline, annual pre-selected), types their copy, publishes, and sees it in RevenueCatUI's `PaywallView` without an app release.
- **A growth person** changes one text, adds a badge, reorders the plans or adds a Spanish translation, previews it in light and dark mode with the "selected" and "intro offer" states, and publishes.
- **Anyone without design time** describes the paywall in a sentence ("meditation app, calm, 7-day trial, annual first") and gets a valid paywall to edit.
- **An AI agent or backend** does all of the above through REST API v2.

## The contract: what the SDK decodes
The SDKs render "paywall components" (RevenueCat's Paywalls V2). The schema is the iOS SDK's own Swift models (`purchases-ios/Sources/Paywalls/Components`), decoded with `convertFromSnakeCase`. A published paywall that fails to decode shows the SDK's fallback paywall, so **the server refuses to publish anything that would not decode** (422 with the JSON path of the first problem and the full list).

The 17 component types the SDK renders, and what each one requires (everything else is optional):

| Type | Required fields |
|---|---|
| `text` | `text_lid` (a key of `components_localizations`), `font_weight`, `color`, `font_size` (number or a named size), `horizontal_alignment`, `size`, `padding`, `margin` |
| `image` | `source.light` {`width`, `height`, `original`, `heic`, `heic_low_res`}, `size`, `fit_mode` |
| `icon` | `base_url`, `icon_name`, `formats` {`svg`, `png`, `heic`, `webp`}, `size`, `color` (iOS loads `base_url/formats.heic`) |
| `stack` | `components`, `dimension` (vertical/horizontal with `alignment` and `distribution`, or zlayer with `alignment`), `size`, `padding`, `margin` |
| `button` | `action` {`type`: `restore_purchases`, `navigate_back`, `navigate_to` + `destination`}, `stack` |
| `package` | `package_id`, `is_selected_by_default`, `stack` |
| `purchase_button` | `stack` (`method` {`type`: `in_app_checkout`, `web_checkout`, `web_product_selection`, `custom_web_checkout`} optional) |
| `sticky_footer` | `stack` (also `components_config.base.sticky_footer`) |
| `timeline` | `size`, `padding`, `margin`, `items[]` {`title` (text), `icon` (icon), optional `description`, `connector` {`width`, `color`, `margin`}} |
| `tabs` | `size`, `padding`, `margin`, `control` {`type`: `buttons` or `toggle`, `stack`}, `tabs[]` {`id`, `stack`} |
| `tab_control` | marks where the control's stack goes inside a tab |
| `tab_control_button` | `tab_id`, `stack` |
| `tab_control_toggle` | `thumb_color_on`, `thumb_color_off`, `track_color_on`, `track_color_off` |
| `carousel` | `pages[]` (stacks), `page_alignment`, `page_spacing`, `page_peek`, `initial_page_index`, `loop`; `page_control` {`position`, `spacing`, `default`, `active`} optional |
| `video` | `source.light` {`width`, `height`, `url`}, `show_controls`, `auto_play`, `loop`, `mute_audio`, `size`, `fit_mode` |
| `countdown` | `style` {`type`: `date`, `date` (ISO 8601)}, `count_from` (`days`, `hours`, `minutes`), `countdown_stack`; `end_stack` and `fallback` optional |
| `web_view` | `id`, `protocol_version` (1), `url` (a resolved https URL), `size` |

Shared types: colours are `{light, dark?}` of `{type: hex, value: "#rrggbbaa"}` or `linear`/`radial` gradients; sizes are `fit`, `fill`, `fixed` (with `value`) or `relative`; shapes are `rectangle` (with `corners`) or `pill`; borders `{color, width}`; shadows `{color, radius, x, y}`; badges `{style, alignment, stack}`. Overrides are `[{conditions: [{type}], properties}]` with the conditions `selected`, `intro_offer`, `promo_offer`, `compact`, `medium`, `expanded` and the rule conditions (`selected_package_condition`, `intro_offer_condition` …).

The validator (`packages/core/src/paywalls/validate.ts`) encodes this table. Beyond decoding it also checks what renders wrong without failing: every `text_lid` exists in the default locale, every `package_id` is a package of the paywall's offering (on publish), there is exactly one package selected by default per package group, there is a purchase button, component ids are unique. Those are warnings in the editor and errors on publish only where the SDK would break.

`scripts/e2e/paywall-decode` (a Swift package on the SDK fork, run with `PAYWALL_DECODE=1`) decodes every gallery template, an editor-built paywall and a repaired AI paywall with the SDK's own models in the contract tests.

## 1. Template gallery
RevenueCat's flow (frames 11 and 12): an empty Paywalls page offers three starts (template, scratch, AI); "Select template" opens a full-screen gallery with filters on the left and live phone previews in a grid.

Ours, in `DESIGN.md`'s look:
- **Empty state** with three cards: *Use a template* (opens the gallery), *Start from scratch* (an empty stack with a package list and a purchase button), *Generate with AI* (hidden when no model is configured).
- **Gallery** at `/projects/:id/paywalls/templates`: filter rail (Number of screens: single, multiple; Purchase method: in-app, web; Number of packages: any, 1, 2, 3; Number of tiers: any, 1, 2+) and a grid of live previews rendered by the same renderer as the editor, from the same JSON the SDK gets. Selecting a template asks for the offering (if the paywall has none yet) and creates the paywall from it.
- **Ten templates**, each built from the 2026 conversion research (`company/docs/research/paywall-onboarding-2026.md`):

| Id | Name | Screens | Method | Packages | Tiers | Built from |
|---|---|---|---|---|---|---|
| `trial_timeline` | Trial timeline | 1 | in-app | 2 | 1 | "How your free trial works" timeline: +23% trial starts (Blinkist) |
| `annual_two_plan` | Annual first | 1 | in-app | 2 | 1 | Annual pre-selected with a savings badge: yearly share 37% → 63% |
| `feature_hero` | Feature hero | 1 | in-app | 2 | 1 | Hero image, 3–5 benefits with icons |
| `comparison` | Free vs Pro | 1 | in-app | 2 | 1 | A two-column comparison table (kept short: a long chart loses to a simple paywall) |
| `minimal` | Minimal | 1 | in-app | 1–3 | 1 | Headline, plans, button |
| `onboarding_pages` | Story pages | 3 | in-app | 2 | 1 | Swipeable value pages before the plans: 2–3 pages convert 37% better (Superwall) |
| `countdown_offer` | Limited offer | 1 | in-app | 1 | 1 | A countdown to an offer end date and a struck-through anchor price |
| `tiers_tabs` | Tiers | 1 | in-app | 4 | 2 | Tabs for two tiers (Plus, Pro), two plans each |
| `social_proof` | Reviews | 1 | in-app | 2 | 1 | Rating, user count and one review: +17% revenue per user |
| `web_checkout` | Web checkout | 1 | web | 2 | 1 | The purchase button opens web checkout (`web_checkout`) |

Each template takes the offering's real package identifiers (and falls back to `$rc_monthly`/`$rc_annual` in the gallery), the app name and two brand colours, and uses `{{ product.* }}` variables for prices so the device shows local prices.

## 2. Visual editor
`/projects/:id/paywalls/:paywallId`, three columns at 1440px (tree 280px, phone preview, properties 340px):
- **Component tree:** every component with its type icon and a label (its text, package id or name). Select, add (a menu of all component types, added after the selection or inside a selected container), remove, duplicate, move up/down, move into the stack above, out to the parent, and drag to reorder within a parent. Keyboard: arrows move the selection, ⌘Z/⌘⇧Z undo and redo, Delete removes.
- **Properties panel**, per type: text (string per locale, size, weight, colour light/dark, alignment, background), image (pick from media assets or upload, fit, size, mask, light/dark source), icon (from the built-in icon set, colour, background shape), stack (direction, alignment, distribution, spacing, padding, margin, size, background colour or gradient or image, border, corner radius or pill, shadow, badge), package (package binding to the offering's packages, selected by default), purchase button (in-app or web checkout), button (restore, back, open URL / terms / privacy, customer center), timeline (items: icon, title, description, connector), tabs (tab names and default tab), carousel (peek, spacing, loop, auto-advance, page control), countdown (end date, count from), video (URL, autoplay, loop, mute), web view (https URL). Overrides: for packages and their children a "When selected" set of properties; for texts an "Intro offer" text. Every colour has light and dark values.
- **Undo/redo** over the whole document (100 steps).
- **Preview:** a phone frame (390 × 844) rendering the JSON with the same layout rules as RevenueCatUI (stacks, fill/fit/fixed sizes, alignment and distribution, padding, margins, shapes, borders, shadows, badges, sticky footer, tabs, carousels, countdowns ticking, variables with sample prices). Toolbar: light/dark, locale, selected package, intro-offer eligibility. Clicking a component in the preview selects it in the tree.
- **Draft, publish, versions:** Save draft (PATCH with the revision), Publish (server validates first), versions menu (save a named version, list versions, restore one into the draft), unpublish, duplicate, delete. A problems list shows validation issues with "go to component".
- **JSON tab:** the components JSON, editable, with "Repair" (the same repair as the AI generator).

## 3. AI generator
`POST /v2/projects/{project_id}/paywalls/generate` (RevenueDot extension) with `prompt`, optional `app_name`, `brand_colors` (up to 3 hex), `offering_id`, `locale`. The server asks a language model for components JSON in a lenient form of the SDK schema (inline `text` instead of `text_lid`, plain hex colours, `"fill"` sizes), then **repairs** it (`packages/core/src/paywalls/repair.ts`): fills required fields with defaults, moves text into localizations, turns plain colours into colour schemes, drops unknown types, binds package components to the offering's packages (adds a plan list when the model left one out), adds a purchase button in a sticky footer when missing, makes ids unique. The repaired result must pass the validator, or the call answers 502 and the dashboard says so. The answer is a draft for the editor; nothing is saved until the user saves.
- **Cloud:** the Workers AI binding `AI` (`cloudflare.config.ts`), model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. No external key.
- **Self-host:** `OPENAI_API_KEY` (model `REVENUEDOT_AI_MODEL`, default `gpt-4.1-mini`) or `ANTHROPIC_API_KEY` (default `claude-sonnet-4-5`). Without any, `GET /v2/projects/{project_id}/paywalls/ai` answers `available: false` and the dashboard hides every "Generate with AI" entry.
- Prompt limits: 2,000 characters; one generation per project every 5 seconds; 60 per project per day.

## 4. Asset CDN
- Uploaded images and fonts are served at `GET /assets/{project_id}/{object_name}` with `Cache-Control: public, max-age=31536000, immutable`, a strong `ETag`, `If-None-Match` → 304, `Content-Length`, CORS `*`, and `HEAD`. On Cloud the Worker answers repeat requests from the Cloudflare edge cache without a database query.
- Media assets report `original_width` and `original_height` so the editor writes the real size into `source.light.width/height`.
- Built-in icons (40, our own drawings) are served at `GET /assets/icons/{name}.png` (96 × 96, white on transparent; the SDK tints them) and as SVG at `/assets/icons/{name}.svg`.
- `asset_base_url` is the origin the SDK talks to (the API host on Cloud), so published image URLs resolve from the app. The contract test fetches every image URL of a published paywall.

## 5. Localizations
- The editor's **Localizations** tab: a table of every string key × locale, add a locale (copies the default locale), remove a locale, set the default locale, and missing strings highlighted. The text properties panel edits the string of the locale picked in the toolbar.
- Serving: a locale that lacks a key gets the default locale's string at publish time (the SDK otherwise renders an empty text). `ui_config.localizations` carries the period and price words (`month`, `annual`, `%d days` …) for every locale used by a paywall, for 12 languages (en, es, fr, de, it, pt, ja, ko, zh_Hans, zh_Hant, nl, ru); others fall back to English.

## 6. Charts extras
- **Saved charts:** "Save" on a chart stores its name, chart and the full view (range, dates, resolution, segment, filters, selectors, sandbox, compare). The chart rail lists saved charts on top ("Saved"); opening one restores the view; rename and delete from its menu. API: `GET/POST /v2/projects/{project_id}/saved_charts`, `PATCH/DELETE /v2/projects/{project_id}/saved_charts/{id}` (RevenueDot extension, migration 0016).
- **Compare to previous period:** a switch on the chart page fetches the same chart for the window of equal length right before the current one and draws it as a dashed grey line under the current series, with a "Previous period" row in the table and the change per summary value. For segmented and stacked charts the comparison uses the total.

## API additions (RevenueDot extensions)
| Method and path | What |
|---|---|
| `GET /v2/projects/{project_id}/paywall_templates` | The gallery: id, name, description, screens, purchase method, packages, tiers, tags |
| `POST /v2/projects/{project_id}/paywalls` with `template_id` (+ `template_options`) | Create from a template with the offering's packages |
| `POST /v2/projects/{project_id}/paywalls/validate` | Validate components JSON without saving: `valid`, `errors`, `warnings` |
| `GET /v2/projects/{project_id}/paywalls/ai` | Whether the AI generator is configured, and the model |
| `POST /v2/projects/{project_id}/paywalls/generate` | AI generator |
| `GET /v2/projects/{project_id}/paywalls/{paywall_id}/versions` | List saved versions |
| `POST /v2/projects/{project_id}/paywalls/{paywall_id}/versions/{version_id}/actions/restore` | Put a version back into the draft |
| `GET/POST /v2/projects/{project_id}/saved_charts`, `PATCH/DELETE …/{saved_chart_id}` | Saved charts |
| `GET /assets/icons/{name}.png` | Built-in icons |

## Tests
- Unit (`packages/core/test/paywalls.test.ts`): every template validates, every template's text ids resolve, repair turns sloppy model output into valid JSON, validation catches each required field per type.
- Contract (`packages/contract/test/v2-paywalls.test.ts`): create from template, validate endpoint, publish refuses invalid JSON, versions list and restore, AI generate with a fake model (and the 503 without one), asset caching headers and 304, icons, localization fill on serve, saved charts. `PAYWALL_DECODE=1` decodes templates, an editor document and an AI document with the Swift SDK models.
- E2E (`apps/dashboard/e2e/paywalls.spec.ts`): gallery filters → create from a template → add a component, change a text, reorder → preview → localization → publish → offerings and remote config serve it; AI generate with the e2e server's fake model; (`charts.spec.ts`) saved chart and compare.
- iOS: `scripts/e2e/ios/run.ts` publishes a gallery template on the current offering and an editor-style paywall (tabs, timeline, carousel, countdown) on a second offering; RevenueCatUI renders both.

## Known gaps
- Multi-screen paywalls are pages in one screen (a carousel). RevenueCat's multi-step workflows (several screens with navigation between them) are served for one step only.
- No free-form canvas drag of components on the phone; editing is through the tree and the properties panel.
- Video uploads (transcoding, low-res variants) are not built: a video component takes a URL.
- The AI generator does not see images; it picks icons from the built-in set and leaves image slots for the user.
- Exit offers (`exit_offers`) and custom variables have no editor UI; they pass through the API.
