# Experiments and Targeting (Tier 2, parity pass)

**Status:** spec for branch `experiments-v2` (2026-10-02, migration 0032). Before this branch an experiment compared exactly two offerings (A and B) for everyone who asked, with an audience and an enrollment share, and its results showed customers, conversions, trials, revenue and the chance that B converts better. "New experiment" stayed disabled until a project had two offerings. Targeting was one table of rules.

This spec brings both pages to what RevenueCat's dashboard does today (observed live, 2026-10-01) and to its documentation ([configuring experiments](https://www.revenuecat.com/docs/tools/experiments-v1/configuring-experiments-v1), [interpreting results](https://www.revenuecat.com/docs/tools/experiments-v1/experiments-results-v1)), in `DESIGN.md`'s look. Nothing here copies RevenueCat's wording.

## Users and jobs
- **A growth person** picks "Price point", duplicates the current offering with the $14.99 product instead of the $9.99 one, starts the test for new customers in the US, and comes back two weeks later to a table that says which price earns more per customer and how sure that is.
- **A founder** asks RevenueDot AI to "test a 14-day trial against our 7-day trial" and approves the draft it prepares.
- **A developer** runs several experiments at once on different placements and audiences and decides, by dragging the list, which one a customer joins first.
- **An analyst** exports the per-variant numbers and the daily series as CSV.
- **The SDK** keeps working unchanged: same offering responses, the same customer always lands in the same variant, `EXPERIMENT_ENROLLMENT` once, `experiments` on lifecycle webhooks.

## 1. The experiment
| Field | Values | Editable after start |
|---|---|---|
| `name` | 1–256 characters | yes |
| `type` | `introductory_offer`, `free_trial_offer`, `paywall_design`, `price_point`, `subscription_duration`, `subscription_ordering`, `other` | yes (only labels and defaults) |
| `primary_metric` | one rate or per-customer metric (§4) | yes |
| `secondary_metrics` | up to 12 metric ids | yes |
| `notes` | Markdown, up to 20,000 characters (the hypothesis) | yes |
| `variants` | 2 to 4: control `a` plus treatments `b`, `c`, `d`. Each has a `name`, an `offering_id` (what `Offerings.current` returns) and `placements` (`{ placement_id: offering_id or null }`) | no |
| `enrollment` | `new` (customers first seen after the experiment started) or `new_and_existing` (anyone who asks while it runs) | no |
| `track_paywall_views` | boolean; required (true) with `new_and_existing` | no |
| `audience_id` or `audience_rules` | a saved audience, or conditions written for this experiment only (the audience condition format), or neither (everyone) | no |
| `enrollment_percent` | 1–100: the share of matching customers enrolled | yes |
| `priority` | 1-based position in the enrollment order (§2) | through reorder |
| `status` | `draft` → `running` ⇄ `paused` → `stopped` | — |

Validation: two variants may not serve the same offering and the same placement offerings (they would be identical); every offering must belong to the project; placement ids are letters, digits, `_`, `.`, `-` (1–100); `new_and_existing` needs paywall tracking; a running or paused experiment keeps its variants, enrollment, tracking and audience. A stopped experiment cannot start again.

**Starter categories** (the empty state and the "New experiment" menu): Introductory offer, Free trial offer, Paywall design, Price point, Subscription duration, Subscription ordering. Each one opens the create form with the type, its default metrics (table below) and a one-line hint, and offers to **duplicate the control offering** for the treatment: the copy keeps the packages in order and lets you swap each package's product (to one with another price, duration, trial or introductory offer), reorder the packages (ordering tests) and copy the control's paywall (design tests).

| Type | Primary metric | Secondary metrics | Treatment helper |
|---|---|---|---|
| Introductory offer | Conversion to paying | Initial conversion rate, Realized LTV per customer, Churned subscribers | swap to products with an introductory price |
| Free trial offer | Conversion to paying | Initial conversion rate, Trial conversion rate, Realized LTV per customer | swap to products with another trial |
| Paywall design | Initial conversion rate | Conversion to paying, Realized LTV per customer | same packages, copy of the paywall |
| Price point | Realized LTV per customer | Conversion to paying, Initial conversion rate, Refund rate | swap to products with another price |
| Subscription duration | Realized LTV per customer | Conversion to paying, MRR per customer, Churned subscribers | swap to products with another period |
| Subscription ordering | Initial conversion rate | Conversion to paying, Realized LTV per customer | reorder packages |

**Duplicate offering** (`POST /v2/projects/{id}/offerings/{offering_id}/actions/duplicate`, RevenueDot extension): `{ lookup_key, display_name, packages?: [{ source_package_id, products?: [{ product_id, eligibility_criteria }] }], copy_paywall? }`. Without `packages` the copy is exact. With them, the list sets the order and which packages are kept, and `products` replaces a package's products. `copy_paywall` copies the paywall's draft and published content onto the new offering.

**Offering deletion:** an offering used by a draft, running or paused experiment (any variant or placement) cannot be deleted (409 naming the experiment). Before this branch deleting such an offering deleted the experiment and its results; now a stopped experiment keeps its results and shows the deleted offering's id.

## 2. Enrollment (the SDK contract)
On `GET /v1/subscribers/{id}/offerings` the server resolves, in order: a customer offering override; the experiment the customer is enrolled in (running or paused); a new enrollment; the first live targeting rule; the project's current offering.
1. **Sticky:** a customer enrolled in a running or paused experiment gets their variant until it stops. One customer is in at most one experiment that is not stopped.
2. **New enrollment:** running experiments are checked by `priority` (1 first). The first one whose enrollment mode, audience and share admit the customer enrolls them, and the rest are skipped.
   - `new`: only customers whose `first_seen` is at or after the experiment's `started_at` (a resumed experiment keeps its first start).
   - `new_and_existing`: anyone.
   - Audience: the saved audience's rules or the inline rules, evaluated with the request's headers like targeting rules.
   - Share: `bucket(experiment_id + ":enroll:" + customer_id) < enrollment_percent`, where `bucket` is the first two bytes of SHA-256 modulo 100 (unchanged).
   - Variant: `u` = first two bytes of SHA-256(`experiment_id:variant:customer_id`). When 100 is divisible by the variant count (2 or 4), variant = `floor((u mod 100) / (100 / n))`; for 3 variants, `u mod 3`. Two variants therefore split exactly as before this branch (`u mod 100 < 50` → a).
3. **What the SDK receives:** `current_offering_id` = the variant's offering; `placements.offering_ids_by_placement` = the matching targeting rule's placements overlaid with the variant's; `EXPERIMENT_ENROLLMENT` once (unique row per experiment and customer); lifecycle webhooks carry `experiments: [{ experiment_id, experiment_variant, enrolled_at_ms }]`.
4. **Pause** stops new enrollments only. **Stop** sends enrolled customers back to targeting or the current offering on their next request.
5. **Priority:** new experiments are created at the bottom (highest number). `POST /experiments/actions/reorder { experiment_ids }` takes every draft, running and paused experiment once; stopped ones keep their place after them.
6. **Migration 0032** turns each A/B experiment into variants `a` (Control, `offering_a`) and `b` (Treatment B, `offering_b`), keeps every enrollment row (so nobody changes variant), sets `enrollment = new_and_existing` (what they did), and numbers `priority` by start time per project (the old enrollment order). `offering_a` and `offering_b` stay as the first two variants' offerings for older readers and archives; their foreign keys become `ON DELETE SET NULL`.

## 3. The create form (`/experiments/new`, `/experiments/{id}/edit` for drafts)
A full page, not a dialog, in this order:
1. **Details:** Name; Experiment type (select); Primary metric (select); Secondary metrics (checkbox list); Notes (Markdown textarea with a Preview tab).
2. **Variants:** a card per variant: name, offering (select, with "Duplicate the control offering…" which opens the duplicate dialog), and one row per placement (placement id → offering or "No paywall"). Buttons: **Import from targeting** (pick a targeting rule: its offering and placements go into every variant as the starting point), **Add placement** (adds a row to every variant), **Add variant** (up to 3 treatments), remove a treatment. A treatment without an offering shows **Create offering** (the duplicate dialog).
3. **Enrollment:** New customers / New and existing customers (radio cards); "Track paywall views for better analysis" (checkbox, forced on for new and existing).
4. **Audience:** Everyone / Saved audience (select) / Custom filters (the condition builder); Audience percentage (1–100).
5. **Estimate** (live, debounced): Matching customers (last 7 days) and Customers per variant (last 7 days) from `POST /experiments/actions/estimate`: customers first seen (new) or last seen (new and existing) in the last 7 days who match the audience, times the percentage, divided by the variant count. Approximate above 5,000 customers.
6. A note: new experiments start at the lowest enrollment priority; reorder from the list.
7. **Save as draft** and **Start experiment**. Errors show inline and in a banner with the server's message.

## 4. Results (`GET /experiments/{id}/results`, CSV at `…/results/export`)
**Who counts:** enrolled customers (production by default; `environment=sandbox` for test purchases), optionally filtered by `platform`, `country` (their last request) and `paywall` (`viewed`, `not_viewed`, `all`; default `viewed` when paywall views are tracked, else `all`). A paywall view is a `paywall_impression` or `custom_paywall_impression` SDK event after enrollment.

**What counts:** purchases made after enrollment, and everything that follows from them (renewals, refunds, trial conversions). Subscriptions are built from the ledger with the charts' rules (`buildSubscriptions`, `packages/core/src/charts/model.ts`); a subscription counts when it started at or after the customer's enrollment. Renewals of a subscription bought before enrollment do not count. Money is USD at the purchase date, refunds negative.

| Metric | Kind | Definition |
|---|---|---|
| Initial conversions / Initial conversion rate | count / rate | customers with a trial, subscription or one-time purchase ÷ customers |
| Trials started | count | trials started |
| Trials completed | count | trials that ended or converted |
| Trials converted / Trial conversion rate | count / rate | trials followed by a paid period (also through a product change) ÷ trials completed |
| Paid customers / Conversion to paying | count / rate | customers with at least one payment above zero ÷ customers |
| Active subscribers | count | customers with a paid subscription active now |
| Churned subscribers | count | customers who had a paid subscription and have none active now |
| Refunded customers / Refund rate | count / rate | customers with a refund ÷ paid customers |
| Realized LTV | total | revenue so far |
| Realized LTV per customer / per paying customer | mean | revenue ÷ customers / paid customers |
| MRR | total | monthly value of active paid subscriptions |
| MRR per customer / per paying customer | mean | MRR ÷ customers / paid customers |

**Statistics** (`packages/core/src/experiments/stats.ts`, 95%):
- Rates: **Wilson score interval** per variant. **Chance to beat control:** P(p_variant > p_control) with Beta(k+1, n−k+1) posteriors (uniform prior), computed exactly with Evan Miller's closed form (sum over the variant's successes, log-gamma) up to 20,000 terms, normal approximation of the two Betas beyond. **Lift interval:** relative lift with the delta method on log(p_v / p_c), so the interval is asymmetric and never below −100%.
- Per-customer means (LTV, MRR): mean ± 1.96 · s/√n per variant (CLT; lower bound clipped at 0); chance to beat control = Φ((μ_v − μ_c) / √(se_v² + se_c²)); lift interval by the delta method on log(μ_v / μ_c).
- Counts and totals have no interval.
- **Enough data:** every variant has at least 100 customers and the primary metric has at least 10 events (conversions, payers or completed trials) per variant. Until then the page says how many customers each variant still needs to detect a 20% relative lift on the primary metric at 95% confidence and 80% power (two-proportion sample size for rates, `2(z_α/2 + z_β)²σ²/δ²` for means), using the control's current value.
- **Series:** for each day from the start to today (or the stop, plus the time revenue keeps arriving), every metric's cumulative value per variant as of the end of that day.
- **CSV:** `kind=summary`: one row per variant and metric (value, numerator, denominator, lower, upper, lift, lift lower, lift upper, chance to beat control). `kind=daily`: one row per day and variant with every metric as a column.
- Older fields stay in the response for API clients: per variant `conversions`, `conversion_rate`, `trials`, `paying_customers`, `revenue`, `revenue_per_customer`; `chance_b_beats_a`; `enough_data`.

## 5. Pages
- **Experiments list:** empty state with the six starter cards and "Start from scratch"; **New experiment** menu (Create from scratch, Create with RevenueDot AI, the six types). Rows in enrollment order with a drag handle (and Move up / Move down in the row menu, arrow keys on the handle) for draft, running and paused experiments; stopped ones in a second table. Columns: priority, name, type, variants (offerings), enrollment, status, started.
- **Experiment page:** status and actions (Start, Pause, Resume, Stop with confirmation, Edit for drafts, Delete when not running); a summary (type, metrics, notes rendered, enrollment, audience, share, variants with placements); **Results:** environment and filters, guidance banner, a metric table (variant rows; the primary metric first; value with interval; lift with interval; chance to beat control), a time-series chart with a metric picker (one line per variant, `--series-1…4`, legend and table), **Export CSV** (summary, daily).
- **Create with RevenueDot AI:** a dialog asks what to test (with three examples); it opens a new RevenueDot AI conversation with that request. The assistant reads the offerings and calls `create-experiment`, which always creates a **draft** and is behind the approval card like every write; the answer links to the draft.

## 6. Targeting page (RevenueCat's layout)
- Tabs: **Live** (active rules whose start is past or unset and whose end is future or unset), **Scheduled** (active rules whose start is in the future), **Inactive** (turned off, or ended), **Audiences** (unchanged).
- Each rule is a card that reads as sentences: "If customer matches **Gold plan** (or **Any audience**) then show **promo** for **onboarding_end**" for each placement and "**promo** for all other cases", with the rule's name, its position number, schedule, a drag handle, and a "…" menu: Edit, Turn on / Turn off, Move up, Move down, Duplicate (an inactive copy), Delete.
- Below the live rules: **Select default offering** ("Show the selected offering to customers who don't match any of the rules above"), a picker that sets the project's current offering.
- **New rule** menu: Create from scratch (the rule dialog, now with optional start and end dates) and Create with RevenueDot AI (the assistant calls `create-targeting-rule`, which creates an **inactive** rule after approval).

## 7. AI tools
- `create-experiment` (write, approval): name, type, control offering, 1–3 treatment offerings (id or lookup key), primary and secondary metrics, notes, enrollment, audience id, percent. Always a draft.
- `create-targeting-rule` (write, approval): name, offering, placements, audience id, start and end. Always inactive.
- `list-audiences` (read). `stop-experiment` (write, approval). `list-experiments` and `get-experiment-results` describe variants, priority and the new metrics.

## 8. Tests
- Unit (`packages/core/test/experiments*.test.ts`): Wilson and normal values against published tables, exact Beta chance against hand-computed cases, delta-method lift, sample size, variant bucketing (two variants equal the old split for 10,000 seeds; 3 and 4 variants within 2% of even over 30,000 seeds; stable), result metrics on a hand-built ledger (trial conversion through a product change, refunds, pre-enrollment subscriptions excluded, filters), the daily series, CSV escaping.
- Contract (`packages/contract/test/v2-experiments.test.ts`): create with every field and validation errors, the draft/running/paused/stopped rules, enrollment modes, priority and reorder, inline audiences, placements in the SDK response, migration of an A/B experiment row, offering duplicate and delete guard, results shape and CSV, estimate.
- Journey on the Railway development Postgres (`scripts/e2e/journeys/experiments.ts`): hundreds of customers through the real SDK endpoints, a 4-variant and a 2-variant experiment with priorities, purchases and refunds through `/v1/receipts`, webhooks, results against SQL, CSV, the AI draft through the scripted model.
- Browser (`apps/dashboard/e2e/experiments.spec.ts`, `targeting.spec.ts`): every starter category, the form and its validations, start, pause, resume, stop, results and both CSVs, the AI draft approval, the Targeting tabs, cards, drag and default offering, phone width and dark mode, no console errors.
