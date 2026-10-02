# Web billing, purchase links, funnels, web discounts and domains (Tier 3, parity batch C)

**Status:** built on branch `tier3-web-billing`; "Connect with Stripe" (§8) on branch `tier3-connect-recovery`. Everything runs on the developer's own Stripe account: either through RevenueDot's Stripe Connect platform (the developer clicks "Connect with Stripe"), or through a restricted key they paste into the Stripe app (`prd/store-stripe/PRD.md`). Every test runs against an in-process fake Stripe; no real Stripe account or key is used.

## Users and jobs
- **Developers** sell their app's subscriptions on the web without building a checkout: connect Stripe once, describe the checkout look, create web products (RevenueDot creates them in their Stripe account), put them in an offering, and share a purchase link or publish a funnel.
- **Growth people** build multi-step web-to-app funnels without code (quiz, info, email capture, paywall, success), publish them to a URL, and see where visitors drop off.
- **End users** pay on the web, get a redemption link, open the app, and have access at once, also when they paid before installing the app.
- **Developers' backends and agents** manage discounts with RevenueCat's v2 discount operations.

## What RevenueCat has (the bar)
From the live walkthrough (`company/docs/research/parity-matrix.md`, frames 10, 15 and 26):
- **Web** (sidebar, pinned): web providers (RevenueCat Billing, Paddle, Stripe) listed with app id and public key, and a four-step checklist: connect a provider, add a web config (checkout look and billing), create web products and prices, create an offering.
- **Funnels and Purchase Links**: no-code web-to-app funnels hosted by RevenueCat (multi-step, "Build with AI", events sent to analytics and ad tools) and a checkout link per offering.
- **Web Discounts** (Product catalog): discounts applied automatically or with a code at checkout; v2 has 10 discount operations.
- **Project settings → Domains**: the production domain for funnels, RevenueCat's (`signup.cat/<funnel>`) or a custom one.
- **Redemption links**: after an anonymous web purchase the customer gets `<scheme>://redeem_web_purchase?redemption_token=…`; the SDKs parse it (`DeepLinkParser`, host `redeem_web_purchase`, query `redemption_token`) and call `POST /v1/subscribers/redeem_purchase` with `{ app_user_id, redemption_token }`. Answers: customer info, or 7849 invalid token, 7852 already redeemed by someone else, 7853 expired with `purchase_redemption_error_info.obfuscated_email` (and a fresh link is emailed). Fixtures: `android/error_7849…`, `error_7852…`, `error_7853…`, `ios/req-post-redeem-web-purchase.json`, `ios/resp-error-web-redemption-expired.json`.

## Essential now and later
Essential (this batch)
- Web page with the four-step checklist on the developer's Stripe; web config; web products created in Stripe.
- Hosted checkout (Stripe Checkout Session created server-side with the developer's key), success page, purchase recorded through the Stripe store path, redemption link.
- Purchase links per offering, funnels with builder, preview, publish, events and analytics.
- Real `POST /v1/subscribers/redeem_purchase` and PURCHASE_REDEEMED.
- Web discounts as Stripe coupons and promotion codes; the 10 v2 discount operations real.
- Domains: RevenueDot's path (`/pay/<project>/<slug>`, or `pay.<host>` when `REVENUEDOT_PAY_URL` is set) and a verified custom domain.

Later
- Paddle as a web provider; Stripe Elements embedded checkout (the purchases-js `/rcbilling/v1/checkout/*` flow stays a stub, see below); Apple Pay domain registration.
- Automatic TLS for custom domains on Cloud (Cloudflare for SaaS custom hostnames, see Domains).
- Funnel A/B tests (RevenueCat's "test every step"), funnel templates gallery, image upload in funnels.

## 1. Web (providers and checklist)
Screen `/projects/:id/web`: the project's Stripe apps as web providers (name, app id, public key with reveal and copy), "Add web provider" (Add app → Stripe), then **Start selling on the web** with four steps, each done or not from real state:
1. **Connect Stripe**: a Stripe app connected with "Connect with Stripe" (§8), or with a restricted key. With a restricted key, web billing needs write access the store adapter does not: **Products, Prices, Checkout Sessions, Coupons and Promotion Codes: write** (plus the read permissions in `prd/store-stripe/PRD.md`). "Check credentials" names a missing permission.
2. **Add a web config** (`PUT /v2/projects/{id}/apps/{app_id}/web_config`): app name, logo URL, colours (background, text, accent, button text) with presets, terms and privacy URLs, support email, success behaviour (`show_redemption` page, or `redirect` to a URL with `?redemption_url=`), cancel URL, the app's deep link scheme for redemption links (default `rd-<10 hex of the project id hash>`), App Store and Google Play URLs for the success page, and the redemption link lifetime (default 24 hours).
3. **Create web products and prices** (`POST /v2/projects/{id}/apps/{app_id}/web_products`): name, identifier, type (subscription or one-time), price and currency, billing period (week, month, 3 months, 6 months, year), free trial days. RevenueDot creates a Stripe Product (`metadata.revenuedot_project`) and a Price in the developer's account and stores the RevenueDot product with `store_identifier` = the price id (price ids win over product ids in the Stripe store, so each price is its own product), plus the price in `web_products`. Linking an existing price: `{ stripe_price_id }` reads it from Stripe instead. Optionally attaches the product to entitlements.
4. **Create an offering**: done when an offering has a package with a web product; the button opens the offering editor.

## 2. Hosted checkout
- A checkout starts from a purchase link, a funnel's paywall step or the iOS SDK's paywall web checkout (`POST /rcbilling/v1/hosted-checkout`).
- `POST <pay>/api/checkout` `{ project, slug, package, app_user_id?, email?, code?, session? }` creates a `web_checkouts` row and a Stripe Checkout Session with the developer's key: `mode` subscription or payment, one line item (the package's web price), `success_url` `<page>/success?co=<checkout id>&session_id={CHECKOUT_SESSION_ID}`, `cancel_url` (the config's or the page), `client_reference_id` = checkout id, `metadata` and `subscription_data.metadata` with `app_user_id`, `rd_checkout`, `rd_source`; `subscription_data.trial_period_days` for trials; `customer_email`; `discounts[0].promotion_code` (a code) or `discounts[0].coupon` (a link's automatic discount). It answers `{ url }`; the page redirects.
- **App user id**: the one passed (purchase link `?app_user_id=`, funnel query string, iOS SDK) or a new anonymous id `$RCAnonymousID:<32 hex>`.
- **Recording.** The success page and the `checkout.session.completed` webhook both call `completeWebCheckout`, which is idempotent: it reads the session from Stripe, posts the session id through the Stripe store path (the same verification and `applyPurchases` as `POST /v1/receipts` with `X-Platform: stripe`), so INITIAL_PURCHASE or NON_RENEWING_PURCHASE fire with `presented_offering_id` = the offering, counts the discount redemption, and, for anonymous purchases, issues a redemption token. A webhook for a session with `metadata.rd_checkout` is always tracked, whatever `track_new_purchases` says. A session that is still `open` shows "Payment is processing" and the page reloads.
- **Success page**: the config's success step (title, text), "Open the app" (the https redemption URL), App Store and Google Play buttons, and, when the customer paid with an app user id, a note that the purchase is already on their account. Redirect mode sends a 303 to the configured URL with `redemption_url`.
- The customer gets an email with the redemption link (when Stripe knows their email and the server can send mail).

## 3. Purchase links
- One link per offering (`/v2/projects/{id}/purchase_links`): name, slug (unique in the project with funnels), optional automatic discount, optional expiry, enabled.
- URL: `<pay base>/<project slug>/<link slug>`; `?app_user_id=` buys for that user (no redemption link needed); `?email=` pre-fills; `?code=` pre-fills a discount code. An expired or disabled link answers 410 with a page.
- The page is the offering's packages as plan cards (name, price per period, trial), a discount code field with a live check, legal links, and the web config's look. Copy button in the dashboard with the `app_user_id` example.

## 4. Redemption links
- Token: `rdrt_` + 32 random bytes (base64url). Only its SHA-256 is stored, on the `web_checkouts` row, with its expiry. Deep link `<scheme>://redeem_web_purchase?redemption_token=<token>`; https link `<pay base>/r/<token>` opens a page that tries the deep link and shows store buttons (use it in emails and QR codes).
- `POST /v1/subscribers/redeem_purchase` `{ app_user_id, redemption_token }` with the app's public key:

| Case | Answer |
|---|---|
| Unknown token, or a token from another project | 400 · 7849 "Invalid redemption token." |
| Already redeemed by this customer (or an alias of it) | 200, customer info (the SDK may retry) |
| Already redeemed by another customer | 400 · 7852 "The purchase has already been redeemed." |
| Expired, or replaced by a newer link | 400 · 7853 with `purchase_redemption_error_info.obfuscated_email` (`t***@e******e.com`); a new link is emailed (at most one per hour per purchase) |
| Valid | the web customer (anonymous) is aliased into the app user, like `logIn` (`identify`); 200 with the customer info; PURCHASE_REDEEMED |

- PURCHASE_REDEEMED carries RevenueCat's sample fields: `store` `STRIPE`, `environment`, `redeemed_from` (the anonymous web id), `redeemed_by` (the app user id), `redemption_outcome` `alias`, `redemption_platform` (from `X-Platform`), `product_id`, `entitlement_ids`, plus `app_id` (the Stripe app) and `app_user_id` (the redeemer); like RevenueCat's sample, no `aliases` or `subscriber_attributes`.

## 5. Funnels
- A funnel is `{ theme, steps[] }`, stored as a draft and a published copy (`funnels.draft`, `funnels.published`). Step types:
  - `question`: title, subtitle, options (label, optional `next` step id for paths), multiple choice, `attribute` (the answer is saved as that customer attribute).
  - `info`: title, body, optional image URL, button label.
  - `email`: title, subtitle, placeholder, required; saved as `$email` and passed to Stripe as `customer_email`.
  - `paywall`: title, subtitle, offering, feature bullets, highlighted package, automatic discount, button label; the checkout.
  - `success`: title, body, show the redemption link and store buttons.
- Validation (`packages/core/src/funnels/validate.ts`): 1 to 30 steps, unique ids, one paywall before the success step, the success step last, `next` ids exist, option counts 1–8, text lengths.
- **Builder** `/projects/:id/funnels/:funnelId`: steps list (add, reorder, duplicate, delete), properties of the selected step and the theme, live preview (the same renderer as the public page, in a phone frame, showing the selected step), publish and unpublish, the public URL with copy, and an Analytics tab. The paywall step renders the offering's packages with the web prices; it does not reuse the React paywall renderer, because public pages are server-rendered HTML with a few lines of script, not the dashboard bundle.
- **Renderer** (`packages/core/src/funnels/render.ts`): one pure function from funnel, look, packages and URLs to an HTML page. The server serves it; the dashboard renders it into the preview iframe. The page script moves between steps, keeps answers in the page, sends events with `sendBeacon`, and posts the checkout.
- **Build with AI** (`POST /v2/projects/{id}/funnels/generate`): the paywall generator's model and caps (one call every 5 seconds per project, 60 a day per project, 100 a day per person, 5,000 a day per server), a prompt that asks for the funnel JSON, repaired and validated before it is returned.
- **Events**: `funnel_viewed`, `step_viewed`, `step_completed` (with the answer), `checkout_started` and `purchase` are stored in `funnel_events` (`POST <pay>/api/events`, rate-limited per IP; the server records checkout and purchase itself). FUNNEL_VIEWED, FUNNEL_STEP_COMPLETED and FUNNEL_PURCHASE (RevenueDot event types) go to webhooks and integrations whose event filter names them (opt-in, like SUBSCRIBER_ALIAS), with `funnel_id`, `funnel_name`, `step_id`, `step_type`, `step_index`, `answer`, `session_id`, the visitor's anonymous `app_user_id` (`$RCAnonymousID:…`, made when the page loads and reused for the purchase) and the query string's `utm_*`. Segment, Amplitude, Mixpanel and PostHog send them as `rd_funnel_viewed`, `rd_funnel_step_completed` and `rd_funnel_purchase`.
- **Analytics** (`GET /v2/projects/{id}/funnels/{id}/analytics?days=`): views (unique sessions), per step the sessions that saw it and completed it with the drop-off, checkouts started, purchases, conversion (purchases ÷ views) and revenue.

## 6. Web discounts
- RevenueCat's v2 discount operations are real: list, create, get, update, delete, enable, disable, and the codes list, create and delete. Responses keep RevenueCat's `Discount` and `DiscountCode` shapes exactly (both have `additionalProperties: false`, so RevenueDot's extra settings live in the extension list `GET /v2/projects/{id}/web_discounts`).
- Fields: `identifier`, `customer_facing_name`, `type` `percentage` (1–100) or `fixed_amount` (amounts by currency), `duration_mode` `one_time` / `time_window` (ISO 8601 months or years, `P3M`) / `forever`, `eligibility` `everyone` / `never_purchased` / `never_subscribed` / `never_subscribed_to_the_same_product`, `product_identifiers`. RevenueDot additions accepted on create and update: `max_redemptions`, `expires_at` (ms).
- In Stripe: a Coupon per Stripe app (`percent_off`, or `amount_off` and `currency` with `currency_options` for the other currencies; `duration` once / repeating with `duration_in_months` / forever; `applies_to.products` from the product identifiers; `max_redemptions`; `redeem_by`; `metadata.revenuedot_discount`) and a Promotion Code per code. Disabling deactivates the promotion codes; enabling reactivates them; deleting a code deactivates its promotion code; deleting the discount deletes the coupon (existing subscriptions keep their discount, as in Stripe).
- At checkout: the code is matched case-insensitively; it must be enabled, not expired, under its redemption cap, for one of the package's products, and the buyer must be eligible (an app user id's purchase history; an anonymous buyer has never purchased). A link's automatic discount applies without a code.
- Stripe outages answer 422 `store_error` with `retryable: true`, like the other store operations.

## 7. Domains
- **RevenueDot's domain**: each project has a slug (`web_domains.slug`, from the project name, editable). Pages live at `<origin>/pay/<slug>/<page>`; with `REVENUEDOT_PAY_URL` (Cloud: `https://pay.revenuedot.app` once the hostname is added) at `<pay url>/<slug>/<page>`. On self-host the server's own host serves them.
- **Custom domain** (`PUT /v2/projects/{id}/web_domain` `{ custom_domain }`, `POST …/web_domain/actions/verify`): the dashboard shows two DNS records, a CNAME from the domain to the pay host and a TXT `_revenuedot.<domain>` with a token. Verify reads both through DNS over HTTPS (Cloudflare's resolver) and marks the domain verified; then the server answers that host with the project's pages at `/<page>`.
- **On Cloud** the custom hostname also needs TLS and routing from Cloudflare for SaaS (a custom hostname on the `revenuedot.app` zone and a fallback origin). That is an account change, so it is a documented manual step in `docs/cloud.md`, not done by the server.

## 8. Stripe Connect ("Connect with Stripe")
Today a developer pastes a restricted key from their own Stripe account. "Connect with Stripe" does the same job in two clicks, through RevenueDot's own Stripe Connect platform account. The developer's account stays theirs: it is a **Standard** connected account, charges are **direct charges** on it, Stripe's fees are theirs, and payouts go to them. RevenueDot takes **no application fee**: the pricing notes charge for tracked revenue and recovered money, not for web payments (`company/docs/business-model.md`). Kai decides whether that changes.

**Platform keys come from the environment.** Kai adds them once the platform account exists:

| Variable | What |
|---|---|
| `REVENUEDOT_STRIPE_CONNECT_CLIENT_ID` | The platform's OAuth client id (`ca_…`, Stripe Dashboard → Settings → Connect → Onboarding options → OAuth) |
| `REVENUEDOT_STRIPE_CONNECT_SECRET_KEY` | The platform's secret key (`sk_live_…`). A `sk_test_…` key makes every connection a test-mode one |
| `REVENUEDOT_STRIPE_CONNECT_TEST_SECRET_KEY` | Optional `sk_test_…`: lets a developer connect in test mode too (an account connected with the live client id can be used in both modes) |
| `REVENUEDOT_STRIPE_CONNECT_WEBHOOK_SECRET` | The signing secret of the platform's Connect webhook endpoint (`whsec_…`); several, comma-separated, when live and test have separate endpoints |

Without the client id, a secret key and a webhook secret, Connect is **unavailable**: the button is disabled and says why ("Connect with Stripe is not set up on this server"), and the restricted-key path works as before.

**Flow (OAuth, an existing Stripe account).**
1. On the Stripe app's page (or step 1 of the Web checklist) the developer picks live or test mode and clicks **Connect with Stripe**. `POST /v2/projects/{id}/apps/{app_id}/stripe_connect/actions/start` `{ method: "oauth", mode, redirect_uri }` stores the SHA-256 of a fresh state (`<project>.<app>.<random>`) and of a browser nonce for 10 minutes and answers Stripe's authorize URL (`https://connect.stripe.com/oauth/authorize?response_type=code&client_id=…&scope=read_write&state=…&redirect_uri=…`) and the nonce. The dashboard keeps the nonce in the tab's session storage.
2. Stripe sends the developer back to `<dashboard>/connect/stripe?code=…&state=…` (or `error=access_denied`). That page posts `actions/finish` `{ state, code, nonce }`. The state is single-use and must be this app's pending one, the nonce must match (so a link started in someone else's project cannot connect your account to theirs), and it must be under 10 minutes old.
3. The server exchanges the code at `POST https://connect.stripe.com/oauth/token` (`grant_type=authorization_code`, the platform secret key as the bearer), and keeps only `stripe_user_id` (the `acct_…` id). The access token Stripe also returns is not stored: the platform key plus `Stripe-Account` does everything. It reads `GET /v1/accounts/{acct}` for `charges_enabled` and `details_submitted`.
4. The account id is **sealed** in `apps.secrets` (`stripe_connect_account_id`, AES-256-GCM like the other store secrets); the dashboard sees only `acct_…abcd`. A SHA-256 of the id routes Connect webhooks (`stripe_connections.account_hash`). Connecting removes the app's restricted key and webhook signing secret, so one app has one way to reach Stripe.

**Flow (Account Links, no Stripe account yet).** "Create a Stripe account" calls `actions/start` with `method: "account_link"` (and the developer's email): `POST /v1/accounts` `{ type: "standard", email }`, then `POST /v1/account_links` `{ account, type: "account_onboarding", refresh_url, return_url }`, both with the platform key. The account is linked at once (sealed like above, `charges_enabled` false); Stripe's onboarding returns to the same callback page, which calls `finish` to read the account's status again. `account.updated` keeps it current.

**Using the connection.** When a connected app's secrets are opened in memory (`withStoreSecrets`), the platform secret key of the connection's mode becomes the app's key and the account id its `Stripe-Account` header. Every existing Stripe path therefore works unchanged on the connected account: receipts, the store adapter's reads, web products and prices, hosted checkout, purchase links, funnels, web discounts (coupons and promotion codes), the customer portal for payment recovery (`prd/payment-recovery/PRD.md`), refunds recorded from `charge.refunded`, and "Check credentials" (it reads one subscription and one Checkout Session on the connected account). A test-mode connection records sandbox purchases.

**Webhooks.** Connected accounts need no endpoint of their own: Stripe sends their events to the platform's Connect endpoint `POST /v1/notifications/stripe-connect`, with `account` on each event. The signature is checked against every configured platform secret, the event is routed to each connected app whose account hash matches, and then handled exactly like an event on the app's own endpoint (stored per app, de-duplicated by event id, forwarded when the app has a forwarding URL). An event for an account no app is connected to answers 200 `unknown_account`, so Stripe does not retry it for days.

**Disconnect.**
- In RevenueDot: `actions/disconnect` deauthorizes at `POST https://connect.stripe.com/oauth/deauthorize` (`client_id`, `stripe_user_id`), removes the sealed id and marks the connection `disconnected`. Stripe answering that the account is already disconnected is not an error; Stripe being down still disconnects locally and says so.
- In Stripe: the developer removes RevenueDot from their account; Stripe sends `account.application.deauthorized` to the platform endpoint, and the app is disconnected with the reason "Disconnected in Stripe" (the app page shows it).
- After a disconnect the app has no key: Stripe calls answer "no API key yet" until the developer connects again or pastes a restricted key.

**API (RevenueDot extensions).** `GET /v2/projects/{id}/apps/{app_id}/stripe_connect` (availability with the reason, modes, status `not_connected` / `connected` / `disconnected`, method, mode, account hint, `charges_enabled`, `details_submitted`, times, the disconnect reason); `POST …/stripe_connect/actions/start`, `…/actions/finish`, `…/actions/disconnect` (`project_configuration:apps:read_write`). `GET /v2/projects/{id}/web` providers carry `connection` (`stripe_connect` or `restricted_key`).

**Data (migration 0026).** `stripe_connections` (one row per Stripe app: status, method, mode, account hash, pending state and nonce hashes with their expiry and redirect URI, `charges_enabled`, `details_submitted`, connected and disconnected times, who connected, disconnect reason). The account id itself lives only sealed in `apps.secrets`.

**Kai's setup steps** (none are done; nothing here calls Stripe until they are):
1. In the Circo Stripe account (or a new RevenueDot one), turn on Connect: Settings → Connect → choose **Standard** accounts, platform profile, business details.
2. Settings → Connect → Onboarding options → OAuth: turn OAuth on and add the redirect URIs `https://app.revenuedot.app/connect/stripe` (Cloud) and, for testing, `http://localhost:5178/connect/stripe`. Copy the live client id.
3. Developers → Webhooks → Add endpoint → "Events on Connected accounts": `https://api.revenuedot.app/v1/notifications/stripe-connect`, with the events in the Stripe app's list plus `account.updated` and `account.application.deauthorized`. Copy its signing secret (and the test-mode endpoint's, if one is added).
4. Store the client id, `sk_live_…`, optional `sk_test_…` and the webhook secrets in 1Password (`RevenueDot` vault), then set them as Worker secrets on `revenuedot` (`REVENUEDOT_STRIPE_CONNECT_*`), piped from 1Password.
5. Decide whether web payments carry an application fee (none today).

## API additions (RevenueDot extensions)
| Method and path | What |
|---|---|
| `GET /v2/projects/{id}/web` | Providers, checklist state, domain, pay base URL |
| `GET`, `PUT /v2/projects/{id}/apps/{app_id}/web_config` | Web config |
| `GET`, `POST /v2/projects/{id}/apps/{app_id}/web_products` | Web products in Stripe |
| `GET`, `POST /v2/projects/{id}/purchase_links`; `PATCH`, `DELETE …/{id}` | Purchase links |
| `GET`, `POST /v2/projects/{id}/funnels`; `GET`, `PATCH`, `DELETE …/{id}`; `POST …/{id}/actions/publish`, `…/unpublish`; `GET …/{id}/analytics`; `GET …/{id}/preview_data`; `POST …/funnels/generate`, `GET …/funnels/ai` | Funnels |
| `GET /v2/projects/{id}/web_discounts` | Discounts with RevenueDot's extra settings, codes and Stripe ids |
| `GET`, `PUT /v2/projects/{id}/web_domain`; `POST …/web_domain/actions/verify` | Domains |
| `GET /v2/projects/{id}/apps/{app_id}/stripe_connect`; `POST …/stripe_connect/actions/start`, `…/finish`, `…/disconnect` | Stripe Connect (§8) |
| `POST /v1/notifications/stripe-connect` (Stripe) | The platform's Connect webhook endpoint (§8) |
| `POST /rcbilling/v1/hosted-checkout` (SDK) | Real: a Stripe Checkout for the package's web product, `{ operation_session_id, checkout_url, success_url, cancel_url }` |

Public pages (no auth): `GET <pay>/<project>/<slug>`, `…/success`, `GET <pay>/r/<token>`, `POST <pay>/api/checkout`, `POST <pay>/api/discount`, `POST <pay>/api/events`.

## Data (migration 0018)
`web_configs`, `web_products`, `web_domains`, `purchase_links`, `funnels`, `funnel_events`, `web_checkouts` (checkout, purchase and redemption token), `discounts`, `discount_codes`.

## Tests
- `apps/server/test/web-billing.test.ts` (fake Stripe in `packages/contract/src/fake-stripe.ts`, which keeps products, prices, sessions, subscriptions, invoices, coupons and promotion codes in memory): web config, web products created in Stripe with the right form fields, the checklist, purchase link checkout with and without an app user id, completion from the success page and from the webhook in either order (one INITIAL_PURCHASE), one-time products, expired links, the iOS hosted checkout, custom domain verification against a fake DNS resolver, host routing.
- `packages/contract/test/redemption.test.ts`: the SDK request fixture, every answer against the SDK fixtures (7849, 7852, 7853 with the obfuscated email), the customer info schema, idempotent retries, aliasing into an identified and an anonymous app user, PURCHASE_REDEEMED against RevenueCat's sample keys, the expired link email.
- `packages/contract/test/v2-discounts.test.ts`: all 10 operations validated against RevenueCat's OpenAPI, the Stripe coupon and promotion code calls, eligibility and caps at checkout, the discount on the Checkout Session.
- `packages/core/test/funnels.test.ts`: validation, paths, the renderer (escaping, every step type, preview mode).
- `apps/server/test/funnels.test.ts`: publish, the public page, events, opt-in webhook and integration delivery, analytics, AI generation with the fake model.
- `apps/server/test/stripe-connect.test.ts` (fake Stripe platform with connected accounts in `packages/contract/src/fake-stripe.ts`): unavailable without platform keys, OAuth start and finish (state, nonce, expiry, single use, another project's state), the code exchange, the sealed account id, checkout, web products, discounts, receipts and refunds sent with `Stripe-Account`, Connect webhooks routed by account (signature, unknown account, de-duplication), `account.application.deauthorized`, disconnect, Account Links onboarding, test-mode connections, the restricted-key path unchanged.
- `apps/dashboard/e2e/stripe-connect.spec.ts`: the button unavailable with the reason, connect through the fake OAuth page, connected state, test mode, disconnect, deauthorized in Stripe, the Web checklist.
- `apps/dashboard/e2e/web.spec.ts` (fake Stripe in the e2e server): connect Stripe, web config, create a web product, create an offering, open the purchase link, complete a fake checkout, redeem the link, build, publish, visit and convert a funnel, a discount code applied; screenshots at 1440×900 and 390px.

## Known gaps
- Stripe Connect has not run against a real platform account: the platform does not exist yet (Kai's setup steps in §8). There is no application fee.
- No real Stripe account has been used; a run in Stripe test mode with a restricted key is the next check (form encoding of nested fields, Checkout redirects, coupon `currency_options`).
- Custom domains on Cloud need the Cloudflare for SaaS custom hostname created by hand; `pay.revenuedot.app` needs its DNS record and worker route added (both account changes).
- The purchases-js Web Billing flow (`rcb_` keys, `/rcbilling/v1/checkout/*`, Stripe Elements inside the SDK) is still a stub: RevenueDot's checkout is a hosted page.
- Funnel events go to webhooks, four analytics integrations and, since Batch D, Meta, Google Tag Manager, Branch and AppsFlyer as web events (`prd/integrations/PRD.md`, "Funnel events to ad networks"); Adjust gets none (it needs its web SDK).
- "Check credentials" tests the key's read permissions only; a key without write access fails at the first web product with a message naming Products and Prices.
