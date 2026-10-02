# Analytics: DataFast on revenuedot.app and RevenueDot Cloud

Goal: know which channel brings each visitor, signup and paying Cloud customer, so marketing spend follows revenue. Runbook and goal list: `docs/analytics.md`.

## Scope
1. **Tracking script** on every page of `revenuedot.app` (site and docs) and on `app.revenuedot.app` (dashboard). Never on a self-hosted dashboard.
2. **Cross-subdomain visitor**: `data-domain=revenuedot.app` makes the visitor and session cookies readable on `app.` and `api.`.
3. **Stripe revenue attribution**: Cloud Standard Checkout sends `datafast_visitor_id` and `datafast_session_id` in the session and subscription metadata. DataFast reads the payments from RevenueDot's own Stripe account (restricted key, connected in DataFast).
4. **User profile**: the dashboard identifies the signed-in user by email, with plan, project count and email-verified.
5. **Goals** for each step toward paying (site clicks, contact-sales form, signup, first project, app, API key, checkout), and scroll goals on the home and pricing sections.
6. **Bot traffic**: the site Worker reports AI, search and training crawlers to DataFast, server side.

7. **Consent by region**: EEA, UK and Swiss visitors get DataFast's cookieless script (no cookies, no banner); everyone else gets the cookie script. The Privacy and Cookie policies say so.

## Rules
- The website id (`dfid_…`) is public. No API key is needed: goals and identify come from the browser, revenue from Stripe, bots from the public bot endpoint.
- Never send a project name, a password, a token or a card detail to DataFast. Goal parameters are short labels (a plan, a location on the page).
- Goal names never reuse DataFast's reserved names (`payment`, `free_trial`, `trial_*`, `subscription_*`, `identify`).
- Analytics code never throws: a blocked script must not break a page.

## Validation
- Unit: `apps/dashboard/test/analytics.test.ts`, `apps/site/test/bots.test.ts`, the Checkout metadata test in `apps/server/test/billing.test.ts`.
- Browser: `apps/dashboard/e2e/analytics.spec.ts` (signup, project, Upgrade, Stripe metadata, no private data).
- Live: after each deploy, a real visit, click and crawler request show in DataFast (`datafast analytics realtime`, `datafast analytics goals`).
