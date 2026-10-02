# Account settings (RevenueCat parity)

**Status: building (2026-10-02), branch `account-settings`, migration 0028.** Extends `prd/account-email/PRD.md` (scope 1.18), whose "Later" list named email change, two-factor authentication and weekly digests.

Account settings are everything that belongs to a person rather than a project. RevenueCat keeps them at `app.revenuecat.com/settings/*` behind a left nav of six sections; RevenueDot keeps them at `/account/*` with the same six sections, in the design system of `DESIGN.md`.

## Users and jobs
- **A developer whose work email changed** moves the account to the new address without losing projects. The new inbox proves itself with a link; the old inbox is told, so a stolen session cannot quietly take the account.
- **A security-minded admin** turns on an authenticator app, keeps recovery codes in a password manager, sees every signed-in browser and signs out the ones that are not theirs, and revokes AI assistants (ChatGPT, Claude, Cursor) that have an OAuth key.
- **A founder** gets one email every week with MRR, revenue, new customers, trials and churn against the week before, and an email the morning after revenue or new subscriptions fall off a cliff (a broken paywall, a store outage).
- **A product manager** hears when an experiment has enough data to read, and when it ends.
- **An agency owner** sees which projects they own and what each costs, and closes their account once client projects are handed over.
- **Someone outside the US** reads every amount in their own currency and weeks that start on their own first day.

## RevenueCat behaviour we match (observed live 2026-10-01, app.revenuecat.com/settings)
| RevenueCat section | What it has | RevenueDot |
|---|---|---|
| General | Email and name with Update; account-level "Stripe accounts" (account name, mode Live/Test, version, actions, "Connect Stripe"); Log out; Delete account in a danger zone | Same. Stripe accounts: see §1 |
| Billing | "Owned projects" (project, role, plan); Billing & Payments (current plan, View plans, payment method, invoices with revenue tracked per period, billing history) | Same; Billing & Payments is RevenueDot Cloud's billing (prd/cloud-billing) |
| Security | Update password (new and again); two-factor authentication with "Authenticator app" (status, Set up); "Active OAuth tokens" (client, URL, created, Revoke) | Same, plus the current password, recovery codes and a sessions list |
| Notifications | Failing-integration developer emails; Anomaly Detection alerts (BETA, "Add Alert" per project for revenue anomalies); Performance Notifications matrix per project × (Performance Summary, Experiment Results, Experiment Performance Alerts); email preferences | Alert emails (kept from 1.18); a matrix per project × (Weekly summary, Experiment results, Revenue anomalies with a sensitivity) |
| Interface | Theme System/Light/Dark; a custom tint colour with Reset | Same, stored per user |
| Date and region | Start week on; display currency (per user, converts every amount in the dashboard) | Same |

Not matched: RevenueCat's "Experiment Performance Alerts" column (alerts while an experiment runs) is folded into "Experiment results" (enough data, ended); a third experiment email can come later.

## Essential now
### 1. General (`/account/general`)
- **Name**: `POST /auth/me { name }` (unchanged).
- **Email change**: `POST /auth/email/change { new_email, password, code? }`.
  - Needs the current password, and a two-factor code when two-factor is on. 5 requests per user per hour (429 beyond).
  - Refused when the address is taken (409), equals the current one (400), or either address must sign in with single sign-on (an enterprise `passwordPolicy` refusal, 403 `sso_required`).
  - Sends a link to the **new** address (`/confirm-email?token=…`, kind `email_change`, 24 hours, single use, only the SHA-256 stored, the new address kept on the token row) and a notice to the **old** address naming the new one, with a link to reset the password if it was not them.
  - The `/confirm-email` page asks for a click on **Confirm new email** before it calls the API, so a mail scanner that opens the link (and runs its script) cannot move the account to a mistyped address.
  - `POST /auth/email/change/confirm { token }` works without a session (the link may open in another browser): the address must still be free (the unique index decides, so an address taken a moment before answers 409, not 500); the account's email becomes the new one and counts as verified; every other open link (reset, verification, other changes) stops working, because links are bound to the address they were sent to; the old address gets a "changed" email. Expired or used links answer 400 with `reason`.
  - `GET /auth/me` adds `user.pending_email` while a change waits; `DELETE /auth/email/change` cancels it.
- **Log out** (`POST /auth/logout`, unchanged) and **Log out of all sessions** (`POST /auth/logout/all`: every session of the user, this one included).
- **Delete account**: `POST /auth/account/delete { email, password?, code? }`.
  - The typed email must match; the password is needed when the account has one; a code when two-factor is on.
  - **Refused (409 `ownership_transfer_required`, with the projects listed)** while the user owns a project that has other members, or is the last admin of a project that has other members. The message says to transfer ownership (Project settings → General) or remove the members first.
  - **Refused (409 `billing_active`)** while a Cloud Standard subscription is active or past due: cancel it on the Billing page first, so nobody is charged for a deleted account.
  - Enterprise extensions may refuse too (`beforeAccountDelete`, for example the last owner of an organization with members).
  - **What goes:** projects where the user is the only member (with everything in them), the OAuth keys the user granted (in any project), the user's memberships, sessions, links, recovery codes, notification preferences and sends, AI conversations and the Cloud billing account (foreign keys cascade). **What stays:** audit log entries, and projects other people still use. Each project the user leaves gets a `collaborator_account_deleted` entry with the email and name, because older entries name the actor by a user id that no longer resolves. A "Your account was deleted" email goes to the address. The response clears the cookie.
- **Stripe accounts**: RevenueCat connects Stripe at account level. RevenueDot's Connect with Stripe (PR #32) is per app and not merged, so the section is a placeholder that stays hidden until the server reports `account.features.stripe_connect: true`. When #32 merges, the section lists each connected account across the user's admin projects (app, project, mode Live/Test, status, Disconnect) from #32's `stripe_connections`.

### 2. Billing (`/account/billing`)
- **Owned projects**: `GET /auth/account/projects` lists every project the user belongs to with `role`, `is_owner`, `members`, the owner's name, and `plan` (Cloud: the owner's plan, "Cloud Free" / "Cloud Standard" / "Enterprise"; self-host: "Self-hosted"). Owned projects first, then the rest ("Projects you are a member of").
- **Billing & Payments**: the merged Cloud billing (`GET /v2/billing`, prd/cloud-billing) on the same page: plan and status, tracked revenue against the limit, the bill so far, plans with Upgrade or Manage billing, invoices. Shown only on Cloud with `billing_ready`, exactly like the existing Billing link; self-host shows "free and unmetered".

### 3. Security (`/account/security`)
- **Change password**: `POST /auth/password/change { current_password, new_password }`. A wrong current password answers 400 and counts toward 10 attempts per user per 15 minutes (429 beyond). On success every other session of the user is revoked (this one stays), open reset links stop working, and a "password changed" email goes out. Accounts that must use single sign-on are refused (403); accounts without a password (created by SSO) are told to use "Forgot password".
- **Two-factor authentication (TOTP, RFC 6238)**: HMAC-SHA1, 30-second steps, 6 digits, one step of drift either way, and a code (time step) is never accepted twice.
  - `POST /auth/2fa/setup { password }`: a new 20-byte secret, sealed at rest with `services/secrets.ts` (AES-256-GCM), answered once as base32 and an `otpauth://totp/RevenueDot:<email>?secret=…&issuer=RevenueDot` URI. The dashboard draws the QR code in the browser (`uqr`, MIT). Refused while two-factor is on.
  - `POST /auth/2fa/enable { code }`: checks the code against the pending secret, turns two-factor on and answers **10 recovery codes once** (`xxxxx-xxxxx`, 50 random bits each, stored as SHA-256, each works once). An email confirms it.
  - `POST /auth/2fa/disable { code }`: a current code or a recovery code. An email confirms it.
  - `POST /auth/2fa/recovery_codes { code }`: 10 new codes; the old ones stop working.
  - **Sign-in**: with two-factor on, a correct password answers `200 { two_factor_required: true, challenge }` and **no session**. `POST /auth/login/2fa { challenge, code | recovery_code }` finishes it. The challenge is a single-use link-style token (kind `two_factor`, 10 minutes, bound to the address). A password reset on such an account also ends in this step instead of signing in. The OAuth consent page's sign-in form (ChatGPT, Claude) asks for the code too.
  - **Rate limits**: 5 attempts per challenge (then sign in again), and 10 wrong codes per user per 15 minutes across sign-in and settings (429). Each attempt is counted before the check, so parallel guesses cannot pass the limit, and a right code is taken back off. A password change or reset ends the challenges begun with the old password.
  - A recovery code used at sign-in sends an email naming how many are left.
  - **Single sign-on sessions** (enterprise `ee/`) never ask for the code: the identity provider is the second factor. SSO-created sessions are labelled "Single sign-on" in the sessions list. Password sign-in, reset and the break-glass owner sign-in do ask.
  - `GET /v2/projects/{id}/collaborators` now fills RevenueCat's `has_mfa` from it.
- **Sessions**: `GET /auth/sessions` lists the user's signed-in browsers: created, last active (updated at most every 5 minutes), browser and system from the user agent, IP, method (password, two-factor, sign-up, reset, invite, single sign-on) and which one is this browser. Ids are a hash of the cookie, never the cookie. `DELETE /auth/sessions/{id}` signs one out; `POST /auth/sessions/revoke_others` signs out every other one.
- **Active OAuth tokens**: OAuth keys from `routes/oauth.ts` now record who granted them and to which client (`api_keys.created_by_user_id`, `oauth_client_id`). `GET /auth/oauth_tokens` lists the user's: client name, client URL (the client id when it is a metadata URL, else the first redirect host), project, access (read, read and write, money actions), created, last used. `DELETE /auth/oauth_tokens/{id}` revokes (deletes the key; the assistant gets 401 at once). Keys granted before this change are still under the project's API keys.

### 4. Notifications (`/account/notifications`)
- **Alert emails** (1.18): the existing "Email me about problems with my projects" switch.
- **Per project × kind** (`GET /auth/notifications`, `PUT /auth/notifications/{project_id} { weekly_summary, experiment_results, anomaly_alerts, anomaly_sensitivity }`): every kind is off until the user turns it on; any member may subscribe to a project they belong to.
- **Weekly summary**: on the first day of the user's week (Date and region), from 06:00 UTC until the end of the third day, one email per project for the 7 full UTC days before: MRR at the end of the week, revenue, new customers, new trials, churned subscriptions and churn rate, each against the week before (change and percent), in the user's display currency. Numbers come from the chart engine (`runChart`: `mrr`, `revenue`, `customers_new`, `trials_new`, `churn`, weekly buckets that start on the user's day), so they equal the Charts page. Production only. A project with no data in either week gets no email.
- **Experiment results**: one email when an experiment first has enough data (100 customers per variant, the rule of `…/experiments/{id}/results`) and one when it is stopped (within 7 days), with each variant's customers, conversion, revenue per customer and the chance B beats A.
- **Revenue anomalies**: once a day after 06:00 UTC, per project with at least one subscriber, yesterday (UTC) is compared with the 28 days before it for two series: revenue and new paid subscriptions (`revenue` and `actives_new` charts, daily). The math is pure (`packages/core/src/anomaly.ts`): a robust z-score `(x − median) / (1.4826 × MAD)` with floors so a flat history does not divide by zero, plus a minimum change, by sensitivity:

  | Sensitivity | z at least | Change at least | Minimum change |
  |---|---|---|---|
  | Low | 4.0 | 50% | revenue $50, 5 subscriptions |
  | Medium (default) | 3.0 | 30% | revenue $20, 3 subscriptions |
  | High | 2.0 | 20% | revenue $10, 2 subscriptions |

  Drops and spikes both alert. Fewer than 14 of the 28 days with a value (not 0) is "not enough history" and never alerts: a project that went live last week, or sells on one day in three, has a median of 0, and every sale would look like a spike. The result is stored per project and day (`anomaly_checks`), so a re-run never emails twice, and the email names the series, yesterday's value, the usual value (median), the change and a link to the chart.
- **Cron**: one step of the every-minute tick (`services/account-notifications.ts`), bounded per tick (at most 5 projects analysed, 20 emails, 15 seconds), idempotent through `notification_sends` (user, project, kind, period key) written before the email goes out, so two ticks racing send once. A running experiment without enough data is analysed again at most once an hour (a `rate_limits` key), so such experiments cannot take every tick's analyses. Members who left a project, and deleted accounts, are skipped. A reader whose currency has no rate gets USD, labelled USD.
- Every email names why it arrived and links to `/account/notifications`. The three opt-in emails also carry a one-click unsubscribe (RFC 8058: `List-Unsubscribe`, `List-Unsubscribe-Post`, and an Unsubscribe link in the footer): `GET /auth/notifications/unsubscribe/{token}` shows a button, `POST` turns that kind off for that project, with no session. The token's SHA-256 is `notification_sends.token_hash`.

### 5. Interface (`/account/interface`)
- **Theme** System / Light / Dark, `POST /auth/me { theme }`, applied on every page from `/auth/me` and cached in `localStorage` only to avoid a flash before it loads. The top bar's theme button saves it too.
- **Tint colour**: `POST /auth/me { tint: "#RRGGBB" | null }`, a few swatches plus a colour picker, and Reset (back to the gold). It replaces `--accent` (the live dot, focus ring, current period, last sparkline point) and a derived `--accent-ink` darkened (light theme) or lightened (dark theme) until it reaches 4.5:1 against the page, and `--accent-wash`. Surfaces never change: light mode stays pure white and grey (DESIGN.md §1.7). The page shows both contrast ratios.

### 6. Date and region (`/account/date-and-region`)
- **Start week on** (Sunday … Saturday, default Monday, as the charts always were): `POST /auth/me { week_start: 0..6 }`. Charts send it as `week_start` (a RevenueDot extension to `GET …/charts/{name}`; weekly buckets start on that day), the date pickers (Charts custom range, Audit logs, purchase link and discount expiry) start their weeks on it, and the weekly summary uses it.
- **Display currency**: `POST /auth/me { display_currency }`, one of the charts' 14 currencies (USD, EUR, GBP, AUD, CAD, JPY, BRL, KRW, CNY, MXN, SEK, PLN, NZD, CHF). Charts ask the API for that currency (per-day rates, as before). Every other USD amount in the dashboard (Overview cards, customers, transactions, ads, experiments, Verified Metrics preview) is converted in the browser at the latest ECB rate from `GET /auth/fx?currency=EUR` (`services/fx.ts`, cached rates, bundled fallback), with the rate date shown on the Date and region page. Store prices and purchase amounts in their own currency stay as they are. The API stays USD. RevenueDot Cloud bills and invoices stay in USD (that is what Stripe charges).

### 7. Data model (migration 0028_account_settings)
- `users`: `theme`, `tint`, `week_start`, `display_currency`, `totp_secret` (sealed), `totp_enabled_at`, `totp_last_step`, `password_changed_at`.
- `sessions`: `created_at`, `last_seen_at`, `user_agent`, `ip`, `method` (all defaulted, so `ee/` SSO sessions created through `createSession` keep working).
- `auth_tokens`: `new_email` (email change).
- `two_factor_recovery_codes` (user, SHA-256, used_at).
- `api_keys`: `created_by_user_id`, `oauth_client_id`.
- `notification_prefs` (user × project), `notification_sends` (user, project, kind, key), `anomaly_checks` (project, day, result).

## Tests that prove it
- `apps/server/test/totp.test.ts`: RFC 6238 Appendix B vectors (SHA-1, 8 digits) and 6-digit codes at fixed clocks, drift window, base32 round trip, otpauth URI.
- `apps/server/test/account-settings.test.ts`: email change (link to new, notice to old, expiry, single use, taken address, cancel, old links invalidated), password change (wrong current password, other sessions revoked, rate limit), sessions list and revoke, log out of all, two-factor setup, enable, sign-in with code and recovery code, replay refused, bad codes and the rate limit, reset with two-factor, disable, regenerate; OAuth token list and revoke; account deletion blocked (owned project with members, last admin, active billing) and allowed (data gone, other projects untouched); preferences; `has_mfa`.
- `apps/server/test/account-notifications.test.ts`: weekly summary content and idempotency, week start, display currency; experiment emails once each; anomaly alerts once per day with sensitivity; bounded per tick.
- `packages/core/test/anomaly.test.ts`: the detector's math; `packages/core/test/charts-week-start.test.ts`: weekly buckets per start day.
- `apps/dashboard/e2e/account-settings.spec.ts` (`E2E_PORT=5530`): every section, wrong current password, bad and good codes, sign-in with two-factor and with a recovery code, email change link expired and used, delete blocked then allowed, theme, tint, currency and week start applied across pages, phone width, dark mode, no console errors; emails from `/__mail`.
- Journey `account` (`scripts/e2e/journeys/account.ts`): the real Node server on a fresh Railway development database with an SMTP sink, checked through the API and SQL.

## Later
- WebAuthn passkeys and security keys; trusted devices; sign-in alerts for new browsers.
- Account-level Stripe accounts once PR #32 lands.
- RevenueCat's "Experiment Performance Alerts" while an experiment runs; anomaly detection on more metrics (trials, churn, refunds) and hourly.
- A user time zone for digests and anomaly days (UTC today).
