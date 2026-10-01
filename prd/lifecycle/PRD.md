# Lifecycle and customer lists (Tier 2/3, batch B)

**Status:** built on branch `tier2-lifecycle` (2026-10-01). Refund Control answers Apple's refund requests with consumption information, Retention serves cancel and refund offers to the Customer Center and answers Apple's Retention Messaging API, Win-back emails churned subscribers an offer, Support stores and emails Customer Center tickets and gives help desks a customer summary, and Customers has audiences, summary cards, filters and CSV export. Tested against a mocked App Store and the in-memory mailer; no real Apple refund request, retention message or win-back email to a real customer has run yet.

Scope rows: `prd/SCOPE.md` Tier 2 "win-back offers", Tier 3 "Revenue recovery: failed-payment recovery, refund defense (Apple consumption info), win-back flows". Parity rows: `company/docs/research/parity-matrix.md` (Lifecycle: Support, Retention, Refund control, Win-back; Customers: saved customer lists), and its "Live walkthrough notes" plus contact-sheet frames 18 to 21.

## Users and jobs
- **Developers with App Store apps** lose money to refunds that Apple grants without knowing the customer used the purchase. They want Apple to get the facts (and their preference) within Apple's 12-hour window without writing a server.
- **Growth teams** want to save customers at the moment they cancel or ask for a refund: a discount in the in-app Customer Center, and a message or offer on Apple's own cancel screen.
- **Lifecycle marketers** want churned subscribers emailed an offer, and to see how many came back.
- **Support teams** want tickets from the in-app Customer Center in their inbox, and the customer's subscription state next to the ticket in Intercom or Zendesk.
- **Everyone** wants to slice the customer list (active, expired, sandbox, custom conditions), save the slice as an audience and export it.

## RevenueCat behaviour we match
From the live walkthrough (2026-10-01, Test project, nothing saved) and frames 18 to 21:
- **Refund Control:** three cards (refund rate; refund request amount and refund requests, each with a Declined/Approved switch; last 28 days). Four policy templates: first purchase date, platform, recent renewal ("renewed or converted from a free trial in the last 24 hours"), create your own. Each policy has a customer count, eligibility conditions from the audience condition builder, and a refund preference: prefer full refund, prefer no refund, send consumption data only, do not respond. Policies are reordered by dragging; a default policy applies to everyone else ("Do not respond to refund requests" by default). Answers go to Apple as consumption information; Google chargebacks are recorded.
- **Retention:** two tabs and a Sandbox data switch. "Apple Retention Messaging API" shows a message or offer natively on iOS. "Customer Center" lists retention offers per trigger, "Cancellation Retention Discount" and "Refunds Retention Discount", each linked to products, with "New offer".
- **Win-back (beta):** "Bring churned subscribers back by sending a targeted web offer via email", empty state "Create your first win-back campaign".
- **Support:** tab Integrations (Intercom: subscription data in the inbox; Zendesk: ticket sidebar app) and tab Customer Center (the Customer Center's support settings).
- **Customers:** a left rail of audiences (All customers, Active subscribers, Sandbox, Non-subscription, Expired, custom audiences, "New audience"); four summary cards (customers, trialing subscribers, paid subscribers, total revenue); a filter bar with "Save audience" and "Export all"; columns customer, subscription status, auto-renewal status, first seen, last seen, spent, latest purchase.

## Apple contracts we implement (sources)
- **CONSUMPTION_REQUEST** notification (App Store Server Notifications v2): `data.signedTransactionInfo` is the purchase the customer wants refunded, `data.consumptionRequestReason` one of UNINTENDED_PURCHASE, FULFILLMENT_ISSUE, UNSATISFIED_WITH_PURCHASE, LEGAL, OTHER. Answer within 12 hours. https://developer.apple.com/documentation/appstoreservernotifications/consumptionrequestreason
- **Send Consumption Information V1**: `PUT /inApps/v1/transactions/consumption/{transactionId}`, 202 Accepted, body `ConsumptionRequestV1` with `accountTenure`, `appAccountToken` (UUID or ""), `consumptionStatus`, `customerConsented`, `deliveryStatus`, `lifetimeDollarsPurchased`, `lifetimeDollarsRefunded`, `platform`, `playTime`, `refundPreference`, `sampleContentProvided`, `userStatus`. Apple also documents a V2 (`/inApps/v2/...`, five fields, string enums); V1 is not deprecated and carries every field our data supports. https://developer.apple.com/documentation/appstoreserverapi/send-consumption-information-v1
- **REFUND** grants the request, **REFUND_DECLINED** declines it.
- **Retention Messaging API** (pre-release; Apple grants access on request at https://developer.apple.com/contact/request/retention-messaging-api/): Upload Message `PUT /inApps/v1/messaging/message/{messageIdentifier}` (`header` ≤ 66, `body` ≤ 144, optional image and bullet points), Configure Default Message `PUT /inApps/v1/messaging/default/{productId}/{locale}` (`messageIdentifier`), Configure Realtime URL `PUT /inApps/v1/messaging/realtime/url` (`realtimeURL`), hosts `api.storekit.apple.com` and `api.storekit-sandbox.apple.com`. Apple calls the Get Retention Message endpoint with `{ signedPayload }` whose payload has `originalTransactionId`, `appAppleId`, `productId`, `userLocale`, `requestIdentifier`, `environment`, `signedDate`; the answer within 700 ms is one of `message: { messageIdentifier }`, `alternateProduct: { messageIdentifier, productId }` or `promotionalOffer: { messageIdentifier, promotionalOfferSignatureV1 | promotionalOfferSignatureV2 }`. https://developer.apple.com/documentation/retentionmessaging
- Google Play has no consumption API. Refunds and chargebacks reach us as `voidedPurchaseNotification` and the daily voided-purchases scan; we record them against the policies for the cards, and there is nothing to answer.

## Essential now
1. **Refund Control**
   - Policies (`refund_policies`): name, template, rules (the audience shape: groups OR-ed, conditions AND-ed), preference, position. A project setting holds the default preference and whether the developer confirms customers consented to sharing consumption data (Apple requires `customerConsented: true`; without the confirmation nothing is sent and the request is recorded as skipped).
   - New condition field `lastRenewalAt` (latest renewal or trial conversion) for the recent-renewal template; it is available to every audience.
   - On CONSUMPTION_REQUEST: find or create the customer's request row (`refund_requests`), evaluate policies top to bottom against the customer, take the first match or the default, and unless the preference is "do not respond", build the V1 payload and send it with the app's In-App Purchase key right away. Failures retry from the tick (5 min, 15 min, 1 h, then hourly) until 5 minutes before the 12-hour deadline, then the row is `expired`. A repeated notification for the same transaction never sends twice.
   - Payload rules (pure function, `services/refunds.ts`):
     - `refundPreference`: full refund 1, no refund 2, consumption data only 0 (undeclared).
     - `consumptionStatus`: subscriptions: period over 3, used after purchase 2, never seen after purchase 1. Non-consumables: 2 if the customer opened the app after the purchase, else 1. Consumables that grant an in-app currency: balance 0 → 3, below the grant → 2, else 1; other consumables 0.
     - `accountTenure` from first seen, `lifetimeDollarsPurchased` and `lifetimeDollarsRefunded` from USD transactions in the request's environment, all in Apple's buckets.
     - `platform`: 1 for Apple platforms, 2 for others, from the customer's last seen platform; 0 unknown.
     - `sampleContentProvided`: the customer had a free trial of the product.
     - `deliveryStatus` 0 (RevenueDot granted the purchase), `userStatus` 1 for a known customer, 0 unknown.
     - `playTime` 0 unless the app sets the custom attribute `rd_play_time_minutes`; `rd_user_status` (active, suspended, terminated, limited) overrides `userStatus`.
     - `appAccountToken` from the transaction, else "".
   - REFUND (any store, through the purchase pipeline) marks the request approved, or records an approved request when Apple never asked; REFUND_DECLINED marks it declined. Google refunds and chargebacks are recorded approved with consumption `not_applicable`.
   - Cards over N days (default 28): refund rate = approved ÷ decided requests; amount and count split by approved and declined. Sandbox is excluded unless asked for.
2. **Retention**
   - Customer Center offers (`retention_offers`): trigger `cancel` or `refund`, name, title, subtitle, store, product mapping (store product id → store offer id), active. `GET /v1/customercenter/{id}` adds `promotional_offer` (`ios_offer_id`, `android_offer_id`, `eligible`, `title`, `subtitle`, `product_mapping`) to every CANCEL or REFUND_REQUEST path, which both SDKs already decode.
   - Apple Retention Messaging per App Store app (`apps.retention_messaging`): messages (text, switch plan, promotional offer), default message per product and locale, real-time rules (product → message), enabled switch. "Sync to Apple" uploads new messages, sets the defaults and registers our real-time URL in sandbox (production after Apple's performance test, a separate action). `POST /v1/retention/apple/{app_id}` verifies Apple's JWS, checks the bundle and `appAppleId`, and answers from the rules with no database write on the hot path except a counter; a promotional offer is signed with `promotionalOfferSignatureV1` from the In-App Purchase key.
3. **Win-back campaigns** (`winback_campaigns`, `winback_sends`, `email_suppressions`)
   - Audience: subscribers whose last subscription ended between N and M days ago, with no active subscription, an `$email` attribute, not unsubscribed, optionally limited to products, stores and a saved audience; one email per customer per campaign.
   - Email: subject, heading, body, button label; sent through the project's mailer (Cloudflare Email Sending on Cloud, SMTP or the log on self-host) with the project's support email as Reply-To, and an unsubscribe link (one click, also `List-Unsubscribe` on SMTP).
   - Offer link: a custom URL, or the store: App Store subscriptions page (where Apple shows eligible win-back offers) or the Play Store subscription page for the customer's product. RevenueDot has no web purchase links yet, so there is no web checkout.
   - Schedule: active campaigns send once a day at the chosen UTC hour (at most 500 per run), "Send now" runs at once, "Send test" sends a sample.
   - Stats: eligible now, sent, opened (only when "Track opens" adds a 1×1 image), clicked, reactivated (a new paid or trial transaction within 30 days of the email) and their revenue, unsubscribed.
4. **Support**
   - `POST /v1/customercenter/support/create-ticket` (`app_user_id`, `customer_email`, `issue_description`) stores the ticket, emails the Customer Center support address (Reply-To the customer) and answers `{ "sent": true }`; `{ "sent": false }` when ticket creation is off, the email is invalid, or the customer sent more than 5 in an hour.
   - Ticket settings live in the Customer Center config the SDK reads: `support.support_tickets` (`allow_creation`, `customer_type`: active, not_active, all or none, `customer_details`).
   - Dashboard ticket list with open and closed states.
   - `GET /v2/projects/{id}/customers/{customer_id}/support_summary` and `GET /v2/projects/{id}/support_summaries?email=` return what a help desk sidebar shows: status, entitlements, subscriptions with auto-renew and store, total spent, refunds, open tickets and a dashboard link.
5. **Customers**: built-in lists (All, Active subscribers, Sandbox, Non-subscription, Expired), saved audiences in the rail, filters from the condition builder, "Save audience" (creates a v2 audience), four summary cards, the RevenueCat columns, and CSV export. Lists scan the 10,000 most recently seen customers and say so when a project has more.
6. **Identity fix**: `mergeCustomers` moves in-app currency balances (summed) and ledger rows, so an anonymous customer's coins survive `logIn`. A ledger row whose source key the surviving customer already has is not counted twice. Support tickets, refund requests and win-back sends move too.

## Later
- Send Consumption Information V2 (`consumptionPercentage`, prorated refunds) once V1 is retired.
- Retention Messaging images and bullet points, the performance test from the dashboard, per-locale rules.
- Win-back: web checkout links (needs Web Billing, batch C), custom sending domains, multi-step sequences, A/B subject lines.
- Customer lists over the whole project with SQL filters instead of a 10,000-customer scan.
- Intercom and Zendesk apps of our own in their marketplaces.

## Endpoints (all RevenueDot extensions under `/v2/projects/{project_id}`)
| Method and path | Scope | What |
|---|---|---|
| `GET /refund_control` | `project_configuration:projects:read` | settings, policies with customer counts |
| `POST /refund_control` | `project_configuration:projects:read_write` | replace settings and the ordered policy list |
| `GET /refund_control/stats?days=28&environment=production` | `customer_information:customers:read` | the three cards |
| `GET /refund_requests` | `customer_information:customers:read` | requests, newest first, paginated |
| `GET`, `POST /retention_offers`; `POST`, `DELETE /retention_offers/{id}` | projects read / read_write | Customer Center offers |
| `GET`, `POST /apps/{app_id}/retention_messaging`; `POST .../actions/sync` | apps read / read_write | Apple Retention Messaging |
| `GET /support_tickets?status=`; `POST /support_tickets/{id}` | customers read / read_write | tickets |
| `GET /customers/{customer_id}/support_summary`; `GET /support_summaries?email=` | `customer_information:customers:read` | help desk sidebar data |
| `GET`, `POST /winback_campaigns`; `GET`, `POST`, `DELETE /winback_campaigns/{id}`; `POST .../actions/preview`, `.../actions/send_test`, `.../actions/run` | projects read / read_write | campaigns |
| `GET /customer_lists?list=&rules=&search=&limit=&starting_after=` | `customer_information:customers:read` | rows and summary cards |
| `GET /customer_lists/export?list=&rules=` | `customer_information:customers:read` | CSV |

Public (no key): `POST /v1/retention/apple/{app_id}` (Apple), `GET /v1/winback/c/{token}` (click), `GET /v1/winback/o/{token}` (open pixel), `GET`/`POST /v1/winback/u/{token}` (unsubscribe).

## Screens
`/projects/:id/lifecycle/refund-control`, `/lifecycle/retention`, `/lifecycle/winback` (list and editor), `/lifecycle/support`, `/customers` (rail, cards, filters). The condition builder from Targeting becomes one shared component.

## Tests that prove it
- `apps/server/test/refund-control.test.ts`: payload built from fixtures field by field; policy order and the default; a signed CONSUMPTION_REQUEST sends one PUT to the mocked App Store with the In-App Purchase key; retries inside and expiry after the 12-hour window; no consent → skipped; REFUND and REFUND_DECLINED set the outcome; Google voids recorded; card numbers.
- `apps/server/test/retention.test.ts`: offers in the SDK's Customer Center config; the real-time endpoint verifies the JWS and answers each message type; sync calls Apple's three endpoints.
- `apps/server/test/support.test.ts`: create-ticket stores, emails and rate-limits; settings off answers `sent: false`; support summary by id and by email.
- `apps/server/test/winback.test.ts`: audience selection (window, active excluded, no email, unsubscribed, already sent), sending with unsubscribe link, click and open tracking, unsubscribe, reactivation stats.
- `apps/server/test/customer-lists.test.ts`: built-in lists, rules, search, summary cards, CSV.
- `apps/server/test/merge-currency.test.ts`: logIn merges balances and ledger rows.
- `apps/dashboard/e2e/lifecycle.spec.ts`: each page end to end on the e2e server.

## Known gaps
- Apple's Retention Messaging API needs Apple's approval for each developer account; the code follows Apple's published contract but has not been called by Apple.
- `playTime` is undeclared unless the app reports `rd_play_time_minutes`; RevenueDot does not measure session length.
- Win-back on Cloud sends from `no-reply@mail.revenuedot.app` (Reply-To the project's support email); custom sending domains are not built. Cloudflare's binding gets no `List-Unsubscribe` header; the body link is always there.
- Customer lists, policy counts and win-back previews scan at most 10,000 customers per project.
