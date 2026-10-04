# Account email (scope 1.18)

**Status: building (2026-09-30).** Approved by Kai on 2026-09-30 for Tier 1: password reset, email verification on Cloud, team invites and alert emails, with Cloudflare Email Sending for Cloud and SMTP for self-host.

## Users and jobs
- **A developer who forgot their password** gets back in without asking anyone: "Forgot password?" on the sign-in page, a link by email, a new password.
- **A team lead** invites a colleague by email to one project with a role, sees who is in the project, and changes or removes access.
- **A project admin** hears about breakage before customers do: store notifications failing, a webhook endpoint that keeps failing, or App Store or Google Play credentials that the store rejects.
- **A self-hoster without a mail server** still has a way back in: `revenuedot admin reset-password <email>` against the database.

## Essential now and later
Essential (Tier 1)
1. **Mail drivers** (`apps/server/src/mail/`): one interface, `sendMail({ to, subject, text, html, replyTo })`.
   - `cloudflare`: the Workers `send_email` binding `EMAIL` (Cloud). Sender `RevenueDot <no-reply@mail.revenuedot.app>`, Reply-To `hello@revenuedot.app`. `mail.revenuedot.app` is its own sending domain, so the `hello@` inbox (Google Workspace, apex records) keeps its own reputation.
   - `smtp`: `REVENUEDOT_SMTP_URL=smtp://user:pass@host:587` (or `smtps://` for port 465) and `REVENUEDOT_MAIL_FROM`, through nodemailer. Node only.
   - `log`: when nothing is configured, every email, links included, is printed to the server log, so a self-hoster can copy a reset link from `docker compose logs`.
   - Links point at `REVENUEDOT_PUBLIC_URL` (Cloud: `https://app.revenuedot.app`), else the origin of the request that caused the email.
2. **Password reset.** `POST /auth/password/forgot` always answers 200 with the same body, whether or not the account exists, and does the lookup and sending after the response, so timing does not tell either. Rate limits: 5 requests per IP per 15 minutes (429), 3 emails per address per hour (silently skipped). The link carries a random 32-byte token; only its SHA-256 is stored. It expires after 1 hour and works once. `POST /auth/password/reset` sets the password, revokes every session of the user, marks the email verified (the link proved the inbox), and signs this browser in. `POST /auth/password/check` tells the page whether a link is still good before the user types.
3. **Email verification (Cloud only).** Sign-up sends a link (24 hours, single use). Unverified accounts use the dashboard with a banner and a resend button (5 per hour). Creating secret API keys and inviting people need a verified email. Self-hosted servers treat every account as verified. **Exception, decided by Kai on 2026-10-01:** connecting an AI assistant through OAuth (`/oauth/token`) does not wait for a confirmed email, so someone can sign up from ChatGPT or Claude and connect in one go. More customers matter more than the small abuse risk; the key is limited to one project and can be revoked like any other.
4. **Team invites.** Roles follow RevenueCat's collaborator roles, trimmed to three for Tier 1: **Admin** (everything, invites and members), **Developer** (edits apps, catalog, customers and integrations; no secret API keys, members or project deletion), **Viewer** (read only, RevenueCat's "View Only"). An admin invites by email with a role; the invite link lasts 7 days, can be resent (new link, old one stops working) or revoked. An existing user signed in with the invited email accepts with one click; a new user creates an account on the invite page (the email is fixed, and it counts as verified). Self-hosted servers that only take the owner's sign-up still let invited people create accounts. Admins change roles and remove members; the last admin of a project cannot be removed or demoted. Members can leave a project.
5. **Alerts to project admins**, from the every-minute tick:
   - **Store notifications failing**: the setup health status `failing` for an App Store or Google Play app.
   - **Webhook failing**: 5 delivery attempts in a row failed for one webhook.
   - **Store credentials failing**: Apple answered 401 to the in-app purchase key, or Google answered 401/403 to the service account, on any call (receipt checks, notifications, the voided-purchases scan, the dashboard's "Check credentials"). A failing app is checked again every hour, and every app with credentials once a day.
   - **Integration failing** (2026-10-03): an enabled integration whose last 10 deliveries ended failed (`integrations.failed_deliveries_in_row`, counted when a delivery runs out of retries or fails with an error a retry cannot fix; `consecutive_failures` keeps counting attempts for the dashboard), or more than 50% of its delivery attempts in the last hour failed with at least 10 attempts (from the deliveries' attempt logs; skipped deliveries and attempts before the integration's last settings change do not count). It resolves when a delivery succeeds after the alert opened and the hourly rule no longer holds, or when the integration is turned off ("turned off" email) or deleted (no email). The email names the integration and partner, the numbers that tripped it and the last error, and links to `/projects/<id>/integrations/<type>#deliveries`. Admins can turn off this kind alone ("Integration failures", `users.integration_alert_emails`, on by default; migration 0035).
   - One email when an issue opens, at most one reminder per issue per 24 hours while it stays open, and one "resolved" email when it recovers. Admins opt out in Account settings ("Email me about problems with my projects").
6. **CLI**: `revenuedot admin reset-password <email> [--password <new>]` connects to `DATABASE_URL`, sets the password (generated and printed once if not given) and signs the user out everywhere.
7. **Templates**: text and HTML, neutral white, near-black ink, the gold dot mark, system fonts with Manrope first, no images from other hosts and no tracking pixels. The footer names RevenueDot and links to notification settings. No street address.

Later
- RevenueCat's other roles (Operations, Growth, Support), transfer of project ownership, audit log of member changes (Tier 2).
- Changing the account email, two-factor authentication, sign-in alerts.
- Weekly digests and product email; bounce and complaint handling beyond Cloudflare's suppression list.

## RevenueCat behaviour we match
- Collaborators are per project and invited by email with a role; new people create an account from the invite ([Collaborators](https://www.revenuecat.com/docs/projects/collaborators)). Only admins invite.
- `GET /v2/projects/{project_id}/collaborators` keeps RevenueCat's `collaborator` object; `role` is `admin`, `developer` or `read_only` (RevenueCat's names for these three).

## Endpoints and screens
Auth (no session unless noted):
- `POST /auth/password/forgot` `{ email }`, `POST /auth/password/check` `{ token }`, `POST /auth/password/reset` `{ token, password }`
- `POST /auth/email/verify` `{ token }`, `POST /auth/email/verify/resend` (session)
- `GET /auth/invites/{token}`, `POST /auth/invites/{token}/accept` (session); `POST /auth/signup` takes `invite_token`
- `POST /auth/me` `{ name, alert_emails }` (session); `GET /auth/me` adds `user.email_verified` and `user.alert_emails`
Project members (dashboard session; admins, except leaving):
- `GET /v2/projects/{id}/invites`, `POST /v2/projects/{id}/invites` `{ email, role }`, `POST /v2/projects/{id}/invites/{invite_id}/actions/resend`, `DELETE /v2/projects/{id}/invites/{invite_id}`
- `POST /v2/projects/{id}/collaborators/{user_id}` `{ role }`, `DELETE /v2/projects/{id}/collaborators/{user_id}`
Screens: "Forgot password?" on `/login`; `/forgot-password`, `/reset-password`, `/verify-email`, `/invite`; the unverified banner; Project settings → Collaborators (invite dialog, roles, pending invites); `/account` (name, alert emails).

## Tests that prove it
- `apps/server/test/account-email.test.ts`: reset token expiry, single use, rate limits, identical answers for known and unknown emails, sessions revoked; verification gates on Cloud and none on self-host.
- `apps/server/test/invites.test.ts`: invite, resend, revoke, accept as an existing and a new user, owner-only sign-up with an invite, role changes, last admin, developer and viewer limits.
- `apps/server/test/alerts.test.ts`: each alert kind opens, is not repeated within 24 hours, reminds after 24 hours, resolves once, honours the opt-out.
- `apps/server/test/mail.test.ts`: the SMTP driver against an in-process SMTP server; the log driver; templates have no remote images.
- `packages/importer/test/admin.test.ts`: `admin reset-password` on PGlite.
- `apps/dashboard/e2e/account-email.spec.ts`: forgot and reset, invite and accept, member management, alert settings, at desktop and 390px, with an in-memory mail capture.
- A real reset and invite email through Cloudflare Email Sending to Gmail with SPF, DKIM and DMARC passing.
