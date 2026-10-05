# Onboarding and growth emails (RevenueDot Cloud)

> **v4 (2026-10-05): the program is 11 emails. Everything below that is not in this list was cut.** Kai: the v3 emails were too long and dense, code snippets belong in the docs (an email's copy goes stale when the usage code changes), and a few emails customers love beat many that cause ad fatigue. Each email is now a few lines and links to the docs for the how-to.
>
> | Email | Goes to |
> |---|---|
> | `welcome` | everyone, 5 minutes after sign-up |
> | `verify_reminder` | unconfirmed accounts, day 1 |
> | `connect_app` | test purchase done, SDK not seen |
> | `store_keys` | SDK seen, no store credentials |
> | `need_hand` | no SDK call by day 10, one self-serve nudge (no call booking: the product is product-led) |
> | `side_by_side` | RevenueCat import done, not live |
> | `first_sale` | first real sale |
> | `cutover` | migrators, a week after the first live sale |
> | `upgrade_nudge` | 3 days after the $10,000 email |
> | `standard_welcome` | Standard started |
> | `teammate_welcome` | people invited to a project |
>
> Cut: first_purchase, checkin, ai_setup, go_live, last_call, switch_plan, import_help, forwarding_check, sandbox_only, upgrade_personal, pricing_explainer, enterprise, standard_canceled, paywalls, experiments, recovery, team, how_going, assistant, referral, went_quiet. The caps (one per 44 hours, three a week) are unchanged.


**Status: building (2026-10-03), branch `lifecycle-email`.** Emails to the people who sign up for RevenueDot Cloud, sent on what each account has and has not done yet. Not to be confused with `prd/lifecycle/PRD.md` (win-back and retention emails a developer sends to *their* app's customers).

## Goal
Take every new Cloud account from sign-up to a live app, then to Cloud Standard and to referring other teams, with the fewest emails that still help. Each email answers the one question the person is stuck on, shows a short video of exactly that step, and has one button.

The journey, in the order a healthy account walks it:
1. **Signed up** → confirmed email.
2. **First test purchase** (Test Store, no store account needed): the product works for them.
3. **App connected**: the SDK in their app talks to RevenueDot (`sdk_versions`).
4. **Store connected**: App Store or Google Play credentials, or a Stripe app.
5. **Live**: the first production sale (`transactions`, not sandbox, revenue above zero).
6. **Adopted**: a published paywall, an experiment, a teammate, payment recovery, an AI assistant.
7. **Paying**: Cloud Standard once tracked revenue passes $10K a month; Enterprise above $500K.
8. **Referring**: a referral link once they have had real sales for three weeks.

## Why the every-minute tick, not Cloudflare Workflows
Considered: one Workflow instance per account (`step.sleep`, `step.waitForEvent`). Chosen instead: a rules pass inside the existing tick, over facts read fresh from Postgres.
- **Every send re-checks live facts.** A Workflow decides at sleep time; a person who finished the step an hour ago must never get the nudge. Here, eligibility is computed in the same query that sends.
- **Editing the plan applies to everyone in flight.** Workflow instances replay the code they started with (steps cached by name); changing a delay or a condition for 2,000 sleeping instances is fragile. Here the plan is data in `journeys.ts`.
- **Same runtime, same tests.** The tick already sends alerts, summaries and billing emails with claims and one-click unsubscribe. The tests run on the PGlite suite; no second runtime to deploy or observe.
- **Cost and limits.** No per-instance state to clean up for accounts that never come back.

## Who gets them
- **RevenueDot Cloud only** (`edition === "cloud"`), from the cron tick, and only when `REVENUEDOT_JOURNEYS` is `on` (the kill switch; `off` stops every journey email, the rest of the tick runs).
- **Account owners**: users who own at least one project. People who joined by invite get one teammate welcome and nothing else.
- **Not** internal addresses (`REVENUEDOT_JOURNEYS_EXCLUDE`, a comma list of domains and addresses), and not users who turned product emails off (except the verification reminder). Cloudflare Email Sending drops addresses on its own bounce and complaint suppression list.
- **No backfill flood.** Onboarding steps (welcome to day 21) go only to accounts created after `REVENUEDOT_JOURNEYS_SINCE` (ISO date, the launch day). Event and revenue steps (first sale, upgrade, referral) go to everyone, and only while the event is recent (each step has a `freshFor` window).

## Sending rules
- **Once per step per person, ever.** `journey_sends (user_id, step)` is the primary key; the row is inserted before the email goes out (the claim), so overlapping ticks send once.
- **At most one journey email every 44 hours and three a week**, per person. The welcome ignores the caps and does not count; the verification reminder ignores them but counts. The highest-priority eligible step wins; the others wait and are re-checked next time.
- **Local daytime.** Nudges go out 09:00 to 17:00 in the person's time zone (`users.time_zone`, sent by the dashboard; unknown means America/New_York), Monday to Friday. Celebrations and the verification reminder go any day, 08:00 to 21:00; the welcome goes at any hour.
- **Never next to a problem.** No journey email within 24 hours of an alert email to the same person (`alert_states`), except the welcome.
- **Bounded per pass:** 25 emails and 15 seconds; the job runs every 5 minutes (minute % 5 == 0). Each pass reads the last 3 days' sign-ups and one rotating slice of 200 older accounts. A send that fails gives its claim back, so a later pass retries.
- **Live means seen live.** A sale counts only when RevenueDot recorded it within 2 days of the purchase and it did not come from an import (`transactions.source = 'import'`), so an imported recent renewal never fires the first-sale email.
- **From RevenueDot, not a person.** `RevenueDot <hello@mail.revenuedot.app>`, Reply-To `hello@revenuedot.app`, so replies reach the team. No founder sign-off (Kai, 2026-10-05: these are lifecycle emails, not personal email).
- **A format for each email's goal** (Kai, 2026-10-05: never one numbered template for everything). Emails are built from blocks in `apps/server/src/mail/journeys.ts`: a setup tracker that shows the account's real progress, a video cover or a dashboard screenshot, a receipt card (first sale, plan), a big number (savings, customers imported), feature cards, a checklist with checkboxes, a timeline, questions and answers, code for every platform, a rendered preview of the email the developer's customers receive, a 0 to 10 rating, one-click reasons. Help offers and check-ins are plain notes signed "The RevenueDot team". Every email explains why the step matters, what the reader will see and the common mistakes; paragraphs stay short.
- **Unsubscribe.** Every email carries a one-click `List-Unsubscribe` (RFC 8058) that turns off `users.product_emails`, and a footer link to Account settings → Notifications ("Setup help, tips and product news"). Billing, security, verification and alert emails are not affected.
- **Links** carry `utm_source=revenuedot&utm_medium=email&utm_campaign=journeys&utm_content=<step>`, so DataFast attributes the visit and the goal.

## The steps
`T` is sign-up time. "Day N" means at least N×24 hours after `T`, at the next allowed send time. Conditions are checked at send time. When two steps are due, the one higher in this list wins (the order in `STEPS`); the other waits for the caps. "Migrating" means the reader chose the RevenueCat path (welcome email or Overview) or an import ran.

### A. Sign-up
| Step | When | Condition | Goal |
|---|---|---|---|
| `welcome` | T + 5 min, any hour | owns a project | pick a path: test purchase, or the switch guide |
| `teammate_welcome` | T + 10 min | joined someone else's project by invite | find their way around; nothing else is ever sent to them |
| `verify_reminder` | T + 24 h | email not confirmed | confirm (a new 24-hour link); counts towards the 44-hour gap |

### B. Celebrations and replies (any day, 08:00–21:00)
| Step | When | Condition | Goal |
|---|---|---|---|
| `first_sale` | after the first production sale, within 3 days | live | new developers: what comes next; migrators: "notifications reach RevenueDot, compare with import verify" |
| `standard_welcome` | after Standard first starts (`billing_accounts.standard_started_at`), within 3 days | started after the launch | SSO, organizations, support promise, billing date |
| `standard_canceled` | after the subscription is cancelled (one-click reasons, recorded) | Stripe status `canceled` after Standard started (a failed card or an unpaid checkout is not a choice, so it never triggers this) | reply: why? |

### C. Switching from RevenueCat
| Step | When | Condition | Goal | Video |
|---|---|---|---|---|
| `cutover` | 7 days after live, sales in the last 3 days | migrating | turn RevenueCat off; a month at their last 7 days' pace (×30/7) on both bills | Switch from RevenueCat |
| `switch_plan` | day 1 | migrating, no import, not live | import, run both, switch | Switch from RevenueCat |
| `import_help` | day 4 | migrating, no import, not live | run the import together on a call | none |
| `side_by_side` | 1 day after the import | not live | forward store notifications, point a test build | Switch from RevenueCat |
| `forwarding_check` | 5 days after the import | no store notification since the import, not live | forwarding to RevenueCat first, then the stores' notification URLs | none |

### D. Revenue (complements the billing emails at 80% and 100% of Free)
| Step | When | Condition | Goal |
|---|---|---|---|
| `enterprise` | tracked this month ≥ $500,000 | not Enterprise | book a call |
| `upgrade_personal` | 10 days after the latest `free_100` billing email (last 35 days) | still Free, `upgrade_nudge` sent | reply or upgrade |
| `upgrade_nudge` | 3 days after the latest `free_100` | still Free | upgrade to Standard; the bill for the month that passed $10,000 (may be last month) |
| `pricing_explainer` | tracked this month ≥ $5,000 | Free, below $10,000 | understand the bill; add a card ($0 under $10,000) |

### E. Onboarding (new developers; the next missing step)
| Step | When | Condition | Goal | Video |
|---|---|---|---|---|
| `go_live` | 2 days after the SDK connected and after `store_keys`, day 4 at the earliest | store connected, not live | four go-live checks | none |
| `store_keys` | 1 day after the SDK connected | no store connected | store credentials | none |
| `connect_app` | 20 h after the first test purchase, or day 3 with an app | not migrating, SDK not connected | SDK pointed at RevenueDot | Connect your app |
| `first_purchase` | day 1 | not migrating, no test purchase, no SDK | first test purchase | First purchase in 5 minutes |
| `checkin` | day 3 | not migrating, no app | reply: what are you building? | none |
| `ai_setup` | day 6 | not migrating, SDK not connected | one prompt in Claude Code, Cursor or Codex | none |
| `sandbox_only` | 14 days after `go_live` | store connected, sandbox purchases, no real sale | reply; check the release uses store keys and approved products | none |
| `need_hand` | day 10 | SDK not connected; migrators only after an import (import_help made the offer before) | book 15 minutes (migrators: set up forwarding together) | none |
| `last_call` | day 21 | SDK not connected | reply; onboarding then stops for good | none |

### F. Adoption (live; migrators after their `cutover` email, or 21 days after going live if it never went out)
| Step | When | Condition | Goal | Video |
|---|---|---|---|---|
| `paywalls` | 3 days after live | no published paywall | publish a paywall | Paywalls and experiments |
| `experiments` | 5 days after the first published paywall | no experiment started | start an experiment | Paywalls and experiments |
| `recovery` | 10 days after live | payment recovery off | turn it on | none |
| `team` | 12 days after live | confirmed email, nobody else in their projects | invite a teammate | none |
| `how_going` | 14 days after live | sales in the last 7 days | a one-click 0 to 10 rating, recorded, plus a reply | none |

### G. Referral and win-back
| Step | When | Condition | Goal |
|---|---|---|---|
| `referral` | 28 days after live | sales in the last 7 days; migrators 14 days after `cutover` | share a personal sign-up link; Kai helps the friend switch |
| `assistant` | 35 days after live | no AI assistant connected, `ai_setup` never sent | connect ChatGPT, Claude or Cursor (video: RevenueDot in ChatGPT) |
| `went_quiet` | 7 days without SDK traffic | was live, no sale in 7 days | reply: what changed? |

### What a typical account receives
- **New developer who goes live in a week:** welcome (minute 5) → first_purchase (day 1) → connect_app (day 2) → store_keys → go_live → first_sale → paywalls → experiments → recovery → team → how_going → referral → assistant. About 13 emails over 7 weeks, never two within 44 hours.
- **RevenueCat team:** welcome → switch_plan (day 1) → import_help (day 4, if no import) → side_by_side → forwarding_check (if needed) → first_sale → cutover (with their own saving) → adoption → referral 14 days after the cutover.
- **Sign-up who never connects:** welcome → first_purchase → checkin → ai_setup → need_hand → last_call (day 21), then nothing.
- **Unverified accounts** get the verification reminder even with product emails turned off: it is account mail.

## Data
- `users.product_emails boolean not null default true`, `users.time_zone text`, `users.journey_path text` (`new` or `revenuecat`), `users.referral_code text unique`, `users.referred_by text`.
- `projects.rc_import_at timestamptz`: set by the first `POST /v2/projects/{id}/import/customers`.
- `journey_feedback (user_id, kind, value, comment, created_at)`, primary key `(user_id, kind)`: one-click answers (`nps` 0 to 10, `cancel` reasons). `GET /auth/journeys/feedback/:token?kind=&value=` shows the answer with a confirm button and a comment box (a mail scanner that opens the link records nothing); `POST` records it.
- `transactions.source text`: `import` for rows an import wrote. Partial indexes `transactions_live_sales` and `transactions_sandbox` let each pass find a project's first and last live sale and first test purchase without reading imported history.
- `billing_accounts.standard_started_at`: the first time the account became Standard.
- `journey_sends (user_id, step, sent_at, token_hash)`, primary key `(user_id, step)`; `token_hash` is the unsubscribe token's SHA-256.

## Endpoints and screens
- `GET|POST /auth/journeys/unsubscribe/:token` (no session): GET shows a button, POST turns `product_emails` off (also as RFC 8058 one-click).
- `GET /auth/journeys/path/:token?path=revenuecat|new` (no session, from the welcome email): records the path, then redirects to the guide for that path.
- `POST /auth/me` accepts `time_zone`, `journey_path` and `product_emails`. The dashboard sends the browser's time zone once, and the Overview's "Already on RevenueCat" switch sets the path.
- Sign-up accepts `ref` (a referral code from `app.revenuedot.app/signup?ref=…`) and `time_zone`.
- Account settings → Notifications: "Setup help, tips and product news" switch.
- Videos: each email video is a 1200×675 cover (the video's poster, a play button and the length) at `revenuedot.app/email/<video>.png`, linking to the video on YouTube once it is published there, otherwise to `revenuedot.app/watch/<video>`.

## Tests that prove it
- Every step: eligible with the facts it needs, skipped when the goal is already done, never sent twice, held by the 44-hour and weekly caps, held outside the local window, held within 24 hours of an alert.
- Accounts created before `REVENUEDOT_JOURNEYS_SINCE` get no onboarding steps but do get `first_sale`.
- Invite-only users get no owner steps. Excluded domains, `product_emails = false` and self-hosted servers get nothing.
- Unsubscribe GET does not unsubscribe; POST does; a bad token answers 404.
- Rendering: every template renders text and HTML without `undefined`, `NaN` or empty links, under 102 KB (Gmail clips larger emails).
