# Integrations and scheduled data exports (Tier 2)

**Status:** Tier 2 built on branch `tier2-integrations` (2026-10-01); Batch D (branch `tier3-ads-integrations`, 2026-10-01) adds the other 26 partners of RevenueCat's catalogue, so the catalogue has RevenueCat's 37 entries plus BigQuery (section "Batch D partners" below). Ten integrations (Slack, Segment, Amplitude, Mixpanel, PostHog, Firebase, BigQuery, AppsFlyer, Adjust, Meta) receive every event webhooks get, through the same queue, retry schedule, delivery log and replay. Scheduled exports write CSV or Parquet files of transactions, customers, subscriptions and events to Amazon S3, Cloudflare R2 or Google Cloud Storage. Tested with fake partners and fake buckets only; no real partner account has received an event yet.

## Users and jobs
- **Growth and data teams** keep the dashboards they built on RevenueCat's integrations: the same event names (`rc_initial_purchase_event` ...), the same reserved attributes (`$amplitudeDeviceId`, `$mixpanelDistinctId`, `$appsflyerId` ...), and the same transaction export columns.
- **Founders** get a Slack message for each sale, trial, cancellation, refund and billing issue.
- **Marketers** send purchases to AppsFlyer, Adjust and Meta so ad networks optimise for paying users.
- **Data engineers** get daily files in their own bucket, or a BigQuery table that fills as events happen.
- **Operators** see, per integration, what was sent, what the partner answered, and why an event was skipped, and resend failures.

## Essential now and later
Essential (this change)
- One fan-out: an event queues to webhooks and to every enabled integration whose filters match (environment, app, event types) and that sends that kind of event.
- Credentials sealed at rest, never returned by the API (only "configured" and the last four characters).
- The webhook retry schedule (5, 10, 20, 40, 80 minutes), a delivery log with the scrubbed request and the partner's answer, manual retry, bulk replay, and a test event.
- Exports: daily or weekly, incremental or full, CSV (gzip or plain) or Parquet, to S3, R2 or GCS, with run now, run history and a bucket check.

Later
- Alert emails for failing integrations and exports (webhooks have them; `services/alerts.ts`).
- AppsFlyer web APIs (Web S2S, PBA), Meta's App Events API, paywall and funnel events, Firebase's Firestore extension (a webhook receiver; works today with our webhooks).
- Per-column selection for exports, Azure Blob and email destinations, the in-app currency ledger feed, AWS IAM-role (STS) credentials.
- (Done in Batch D: the rest of the catalogue, see "Batch D partners".)

## How it works
- **Fan-out:** `services/events.ts` `queueDeliveries` (webhooks) now also calls `services/integrations/queue.ts`, which inserts one `integration_deliveries` row per matching integration. `sendsEvent` (core) leaves out event types the partner never receives (Slack gets no EXPIRATION), so the log is not full of noise.
- **Builders are pure:** `packages/core/src/integrations/<partner>.ts` turn the stored webhook event into HTTP requests, or a reason to skip. They use WebCrypto only (SHA-256 for Meta), so they run on Node and Workers. The adapter `services/integrations/deliver.ts` decrypts the secrets, adds app and device context, sends, checks the answer and logs it.
- **Current attributes:** at send time the customer's current attributes are laid over the ones the event was recorded with (the newer value wins). An event skipped because `$appsflyerId` arrived a second after the purchase goes through when it is retried.
- **Answers:** 2xx is accepted unless the body says otherwise (Mixpanel `status: 0`, BigQuery `insertErrors`, Adjust `error`, Slack not `ok`). Timeouts, 408, 425, 429 and 5xx retry on the webhook schedule; any other 4xx fails at once, since resending the same request cannot succeed. Fix the settings, then replay.
- **Skipped:** a builder that has nothing to send marks the delivery `skipped` with the reason (no `$adjustId`, no sandbox key, no Adjust token for this step). RevenueCat creates no delivery row in these cases, which makes "why didn't my event arrive" hard to answer; ours says why.
- **Credentials:** `services/secrets.ts`, AES-256-GCM with WebCrypto. The key is `REVENUEDOT_ENCRYPTION_KEY` (base64, 32 bytes), else derived with HKDF from `REVENUEDOT_SIGNING_KEY` (RevenueDot Cloud always has one), else the secrets are stored as `plain:` JSON (self-host without either key; still never returned). Stored as `v1:<key id>:<iv>:<ciphertext>`; a changed key gives "enter the credentials again" instead of garbage. Store credentials on `apps.credentials` are not sealed this way yet (known gap).
- **Delivery log:** method and URL of each request, the body with every secret value replaced by `[redacted]` (first 4,000 characters), the HTTP status, the first 1,000 characters of the answer, the time taken, attempts and the name the partner received.

## RevenueCat behaviour we match
Public pages: [third-party integrations](https://www.revenuecat.com/docs/integrations/third-party-integrations/amplitude), [attribution](https://www.revenuecat.com/docs/integrations/attribution/appsflyer), [scheduled data exports](https://www.revenuecat.com/docs/integrations/scheduled-data-exports), [webhook event types](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).

Lifecycle steps. Integrations name trials apart from paid purchases; we derive the step from the webhook fields:

| Step | Webhook event | Analytics name (Segment, Amplitude, Mixpanel, PostHog, AppsFlyer) | Firebase | Meta |
|---|---|---|---|---|
| initial_purchase | INITIAL_PURCHASE, period_type not TRIAL | `rc_initial_purchase_event` | `purchase` | `Subscribe` |
| trial_started | INITIAL_PURCHASE, period_type TRIAL | `rc_trial_started_event` | `rc_trial_start` | `StartTrial` |
| trial_converted | RENEWAL, is_trial_conversion true | `rc_trial_converted_event` | `purchase` (is_trial_conversion) | `Subscribe` |
| renewal | RENEWAL | `rc_renewal_event` | `purchase` (is_renewal) | `Subscribe` |
| trial_cancelled | CANCELLATION, period_type TRIAL | `rc_trial_cancelled_event` | `rc_cancellation` | not sent |
| cancellation (refunds too: cancel_reason CUSTOMER_SUPPORT, negative price) | CANCELLATION | `rc_cancellation_event` | `rc_cancellation` | not sent |
| uncancellation | UNCANCELLATION | `rc_uncancellation_event` | `rc_uncancellation` | not sent |
| non_subscription_purchase | NON_RENEWING_PURCHASE | `rc_non_subscription_purchase_event` | `purchase` | `fb_mobile_purchase` |
| subscription_paused | SUBSCRIPTION_PAUSED | `rc_subscription_paused_event` | `rc_subscription_paused` | not sent |
| expiration | EXPIRATION | `rc_expiration_event` | `rc_expiration` | not sent |
| billing_issue | BILLING_ISSUE | `rc_billing_issue_event` | `rc_billing_issue` | not sent |
| product_change | PRODUCT_CHANGE | `rc_product_change_event` | `rc_product_change` | not sent |
| purchase_redeemed | PURCHASE_REDEEMED | `rc_purchase_redeemed` (Segment, Amplitude, Mixpanel) | not sent | not sent |
| experiment_enrollment | EXPERIMENT_ENROLLMENT | `rc_experiment_enrollment_event` (Amplitude) | not sent | not sent |
| test | TEST (the Send test button) | `rc_test_event` | `rc_test` | `Subscribe` |

- Every analytics and AppsFlyer name can be overridden per step (`event_names`). Adjust uses the event tokens you create in Adjust, one per step; a step without a token is not sent.
- `rc_subscription_status` is set on the customer's profile with each event: active, intro, cancelled, grace_period, trial, cancelled_trial, grace_period_trial, expired, promotional, expired_promotional, paused.
- Revenue is US dollars, gross or "after store commission and taxes" (setting `reporting`); refunds are negative where the partner accepts that (Segment, Amplitude, Mixpanel, PostHog, AppsFlyer), and left out where it does not (Adjust drops the amount, Meta and Firebase do not get refunds as purchases).
- AppsFlyer's default event names are not published by RevenueCat; we use the same `rc_*_event` names as the analytics tools. Every name can be changed.

## Integrations

### Slack
- **API:** POST to an incoming webhook URL (https://api.slack.com/messaging/webhooks), a message with `text` and one attachment (fields: customer with a dashboard link, product, revenue, store, country, "Sandbox").
- **Settings:** `webhook_url` (secret), `reporting`. Default environment: production.
- **Sent:** purchases, trial start, conversion and cancellation, renewals, cancellations, refunds ("was refunded"), one-time purchases, billing issues, product changes, tests.

### Segment
- **API:** HTTP Tracking API, `POST /v1/track` and `POST /v1/identify` on `api.segment.io` or `events.eu1.segmentapis.com`, Basic auth with the write key. `messageId` is the event id (identify: `<id>-identify`), so retries are deduplicated.
- **Settings:** `write_key` (secret), `region` (us, eu), `anonymous_id` (send `$RCAnonymousID:` users as `anonymousId`), `reporting`. Default environment: production.
- **Properties:** revenue (USD), currency, price_in_purchased_currency, purchased_currency, store, product_id, entitlement, entitlements, purchased_at and expires_at (seconds), period_type, environment, presented_offering_id, transaction ids, app_user_id, original_app_user_id, aliases, app_id, country_code, subscriber_attributes, and the step's extras (cancel_reason, expiration_reason, new_product_id, auto_resumes_at, is_trial_conversion). Traits: last_seen_app_user_id, aliases, rc_subscription_status. `context.environment` is production or sandbox.

### Amplitude
- **API:** HTTP V2 (`https://api2.amplitude.com/2/httpapi`, EU `https://api.eu.amplitude.com/2/httpapi`). `insert_id` is the event id; `partner_id: revenuedot`; `options.min_id_length: 1`.
- **Settings:** `api_key`, `sandbox_api_key` (secrets; sandbox events are sent only with the sandbox key), `region`, `reporting`. Default environment: both.
- **Identity:** `$amplitudeUserId` and `$amplitudeDeviceId` when set (both, or the one present), else the app user id.
- **Revenue:** `revenue`, `price`, `quantity`, `productId`, `revenueType` (purchase, renewal, refund) on money events; `user_properties.$set.rc_subscription_status`.

### Mixpanel
- **API:** Ingestion API. Without an API secret: `POST /track?verbose=1` (Mixpanel takes events up to 5 days old). With the project's API secret: `POST /import?strict=1` with Basic auth (any age, so replays of old events work). Then `POST /engage?verbose=1` with `$set rc_subscription_status` and, for money, `$append $transactions { $time, $amount, product_id, store }`. Hosts: api.mixpanel.com, api-eu.mixpanel.com, api-in.mixpanel.com.
- **Settings:** `project_token`, `sandbox_project_token`, `api_secret` (secrets), `region`, `reporting`. Default environment: both.
- **Identity:** `$mixpanelDistinctId` when set, else the app user id. `$insert_id` from the event id.

### PostHog
- **API:** capture, `POST <host>/i/v0/e/` with `api_key`, `event`, `distinct_id`, `timestamp`, `uuid` (the event id, so PostHog deduplicates) and properties including `rc_subscription_status` and `$set`.
- **Settings:** `api_key`, `sandbox_api_key` (secrets), `region` (us, eu, custom) and `host` for self-hosted PostHog, `reporting`. Default environment: both.
- **Identity:** `$posthogUserId` when set, else the app user id.

### Firebase (Google Analytics 4)
- **API:** Measurement Protocol for app streams, `POST https://www.google-analytics.com/mp/collect?firebase_app_id=…&api_secret=…` with `app_instance_id`, `user_id`, `timestamp_micros` and one event. Times in microseconds, `event_id` for deduplication, `affiliation` = store.
- **Settings:** `ios_firebase_app_id`, `android_firebase_app_id`, `ios_api_secret`, `android_api_secret` (secrets), `currency` (usd or the customer's), `reporting`. The App Store goes to the iOS stream, Google Play to the Android stream.
- **Needs:** `$firebaseAppInstanceId`, else the event is skipped. Sandbox events are sent with `environment: SANDBOX`. GA's Measurement Protocol answers 204 without validating, so a wrong app id or secret shows as delivered.

### BigQuery
- **API:** streaming insert, `tabledata.insertAll` (`https://bigquery.googleapis.com/bigquery/v2/projects/{p}/datasets/{d}/tables/{t}/insertAll`), one row per event with `insertId` = event id. Signed in with the service account (RS256 JWT built with WebCrypto, `services/google-sa.ts`). When the table does not exist, RevenueDot creates it (`tables.insert`, partitioned by day on `event_timestamp`) and inserts again.
- **Settings:** `service_account_json` (secret; BigQuery Data Editor on the dataset), `project_id` (defaults to the key's project), `dataset_id`, `table_id` (default `revenuedot_events`), `reporting`. Every event type is sent, sandbox included.
- **Columns:** id, type, event_timestamp, app_user_id, original_app_user_id, aliases, app_id, environment, store, product_id, new_product_id, period_type, purchased_at, expiration_at, entitlement_ids, presented_offering_id, transaction_id, original_transaction_id, country_code, currency, price_in_purchased_currency, price_usd, revenue_usd, is_trial_conversion, cancel_reason, expiration_reason, payload (the whole event as JSON).

### AppsFlyer
- **API:** S2S in-app events, `POST https://api2.appsflyer.com/inappevent/{app id}` with header `authentication: <dev key>` (S2S tokens: `api3.appsflyer.com`). Body: appsflyer_id, customer_user_id, eventName, eventValue (a JSON string with af_revenue, af_price, renewal, af_content_id, af_currency USD), eventCurrency, eventTime (`yyyy-MM-dd HH:mm:ss.SSS` UTC), af_events_api, idfa, idfv, advertising_id, amazon_aid, ip, bundleIdentifier, sharing_filter (from `$appsflyerSharingFilter`).
- **Settings:** `dev_key`, `sandbox_dev_key` (secrets; sandbox only with it), `s2s_token`, `ios_app_id`, `android_app_id`, `reporting`.
- **Needs:** `$appsflyerId`. Sent steps: purchases, trials, renewals, cancellations, one-time purchases, expirations, billing issues, product changes. Refunds carry negative revenue.

### Adjust
- **API:** S2S events, `POST https://s2s.adjust.com/event`, form-encoded: s2s=1, app_token, event_token, adid, created_at_unix, environment (production or sandbox), idfa, idfv, gps_adid, ip_address, revenue and currency (only when at least 0.001, since Adjust rejects less), callback_params (app_user_id, app_id, product_id). `Authorization: Bearer` when S2S authentication is on.
- **Settings:** `ios_app_token`, `android_app_token`, `event_tokens` (step → token), `oauth_token` (secret), `reporting`.
- **Needs:** `$adjustId` and a token for the step.

### Meta
- **API:** Conversions API for app events, `POST https://graph.facebook.com/v21.0/{dataset id}/events` with `access_token`, `partner_agent: revenuedot`, optional `test_event_code`. Event: event_name, event_time (seconds), event_id, action_source `app`, user_data (external_id = SHA-256 of the app user id, madid, anon_id, em and ph SHA-256 of the normalised value, client_ip_address), custom_data (currency USD, value, order_id, content_type, content_ids, contents), app_data (advertiser_tracking_enabled, application_tracking_enabled, vendor_id, the 16-slot extinfo with bundle id, app version, OS version).
- **Settings:** `dataset_id`, `access_token` (secret), `sandbox_dataset_id`, `sandbox_access_token` (secret), `send_without_att`, `test_event_code`, `reporting`. Default environment: production.
- **Needs:** `$fbAnonId` or an advertising id (`$idfa`, `$gpsAdId`, `$amazonAdId`; all-zero ids do not count), and on iOS `$attConsentStatus` = authorized unless `send_without_att`.

## Batch D partners
Built on branch `tier3-ads-integrations` (2026-10-01). Each partner is a `PartnerDef` (`packages/core/src/integrations/common.ts`): its catalogue entry, the steps it sends, a pure payload builder, the default event names, a check of 2xx answers that still mean "rejected" (`answerError`) and a save-time check (`validate`). They register in `partners-analytics.ts`, `partners-attribution.ts`, `partners-marketing.ts` and `partners-connections.ts`; the catalogue API, the dashboard form, the fan-out, retries, the delivery log and replay are the Tier 2 machinery unchanged. Fields marked `url` are checked with the outbound guard when saved (https only on Cloud) and again before each send.

**Documented API or webhook adapter.** Where the partner publishes an API for these events, the builder sends exactly that request. Four partners publish none and instead give RevenueCat customers a webhook URL to paste into RevenueCat; for them `webhook-adapter.ts` POSTs RevenueCat's webhook body (`{"api_version":"1.0","event":{…}}`, the stored event unchanged) with an optional Authorization value to the URL the partner gives you. The catalogue card says "Via webhook" and the page says why.

| Partner | Category | How | Endpoint | Identity | Sandbox |
|---|---|---|---|---|---|
| mParticle | Analytics | Events API | `POST https://s2s.{pod}.mparticle.com/v2/events`, Basic key:secret | `$mparticleId` as `mpid`; `customer_id` = app user id, `$email`, device ids | `environment: development` |
| Statsig | Analytics | log_event | `POST https://events.statsigapi.net/v1/log_event`, `statsig-api-key` | `userID` = app user id | `statsigEnvironment.tier: development` |
| Superwall | Analytics | Webhook adapter | the URL Superwall support gives you | in the body | both, by the environment filter |
| TelemetryDeck | Analytics | Ingest v2 | `POST https://nom.telemetrydeck.com/v2/` (or `/v2/namespace/{ns}/`) | `$telemetryDeckUserId` (skipped without it) | `isTestMode: true` |
| Appstack | Attribution | Webhook adapter | the URL and Authorization from Appstack › Integrations › RevenueCat | `$appstackId` in the body | both |
| Asapty | Attribution | RevenueCat's published Asapty request | `GET https://asapty.com/_api/mmpEvents/?…` | `$appleAdsCampaignId` and the other Apple Ads attributes (skipped without them) | not sent |
| Branch | Attribution | v2 Events API | `POST https://api2.branch.io/v2/event/standard` (START_TRIAL, SUBSCRIBE, PURCHASE) or `/custom` | `$idfa`/`$idfv` or `$gpsAdId`; `developer_identity` | sandbox `key_test_…` key |
| Google Tag Manager | Attribution | GA4 Measurement Protocol to your server container | `POST {server_container_url}/mp/collect?measurement_id=…` | `client_id` and `user_id` = app user id | sandbox measurement ID |
| Kochava | Attribution | Post-install event API | `POST https://control.kochava.com/track/json` | `$kochavaDeviceId` plus `$idfa`/`$idfv` or `$gpsAdId` | test app GUIDs |
| Airbridge | Attribution | S2S events | `POST https://api.airbridge.io/events/v2/apps/{app}/mobile-app/9360`, Bearer | `externalUserID`; `$airbridgeDeviceId` | sandbox app and token; events older than 24 hours skipped |
| SplitMetrics Acquire | Attribution | Webhook adapter | the URL SplitMetrics support gives you | in the body | both |
| Singular | Attribution | S2S (RevenueCat's published Singular request) | v2 `POST https://s2s.singular.net/api/v2/evt` or v1 `GET /api/v1/evt` | `$singularDeviceId` (v2), advertising ids (v1) | sandbox SDK key |
| SolarEngine | Attribution | Webhook adapter (RevenueCat names the hosts and an MD5 signature, but not the path, platform codes or signing input) | the URL SolarEngine gives you | `$solarEngine*` in the body | production by default |
| Tenjin | Attribution | S2S | `POST https://track.tenjin.com/v0/purchase` (money) or `/v0/event`, Basic SDK key | `$tenjinId` (skipped without it) | not sent |
| Airship | Marketing | Custom Events and Attributes | `POST https://go.urbanairship.com/api/custom-events` (EU `go.airship.eu`) | `$airshipChannelId` as the channel, else `named_user_id` | sandbox app key and token |
| Braze | Marketing | `/users/track` | `POST https://rest.<cluster>.braze.(com\|eu)/users/track`, Bearer | `$brazeAliasName` + `$brazeAliasLabel`, else `external_id` | sandbox API key |
| CleverTap | Marketing | Upload API | `POST https://{region}.api.clevertap.com/1/upload` | `$clevertapId` as `objectId`, else `identity` | sandbox account |
| Customer.io | Marketing | Track API v1 | `PUT /api/v1/customers/{id}` then `POST …/events` on track(-eu).customer.io | app user id (or `$customerioId`) | sandbox site |
| Discord | Marketing | Execute webhook | the channel webhook URL (discord.com/api/webhooks/…) | — | labelled "Sandbox" |
| Intercom | Marketing | Data events | `POST https://api.intercom.io/events` (EU, AU hosts), `Intercom-Version: 2.11` | `user_id` = app user id, else `$email` | same workspace |
| Iterable | Marketing | events/track, commerce/trackPurchase, users/update | `https://api.iterable.com/api/…` (EU host) | `$email`, else `$iterableUserId`, else app user id | sandbox API key |
| OneSignal | Marketing | Update user (tags) | `PATCH https://api.onesignal.com/apps/{app_id}/users/by/{onesignal_id\|external_id}/{id}` | `$onesignalUserId`, else the app user id | same app, tagged |

Steps: the analytics and attribution partners send RevenueCat's lifecycle steps with the `rc_*_event` names (overridable), except where the partner has its own standard names (Branch START_TRIAL/SUBSCRIBE/PURCHASE, Kochava Start Trial/Subscribe/Purchase, Airbridge `airbridge.subscribe` …). Revenue is USD by the "Sales reporting" setting; refunds are negative only where the partner accepts it (mParticle refund action, Statsig, TelemetryDeck, Kochava, Singular), and carry no money elsewhere. The adapter partners get every step except experiment enrollment.

**Connections** (no events, own pages):
- **Google AdMob** (Ads): OAuth and ad units for the Ads pages, `prd/ads/PRD.md`.
- **Apple Search Ads** (Attribution): attribution needs no setup, since the SDK's AdServices token is resolved with Apple and stored as `$appleAdsCampaignId` and the other `$appleAds*` attributes. The page reports customers first seen in a period by campaign, with paying customers and production revenue to date (`GET /v2/projects/{id}/ads/apple_search_ads/report`). With an Apple Search Ads API user (organization ID, client ID, team ID, key ID and the P-256 private key; Apple's SEC1 `EC PRIVATE KEY` is accepted) it loads campaign and ad group names from the Campaign Management API v5 (`POST /v2/projects/{id}/ads/apple_search_ads/sync`): an ES256 client secret, `client_credentials` at appleid.apple.com, then `GET /api/v5/campaigns` and each campaign's ad groups with `X-AP-Context: orgId=…`.
- **Intercom inbox** (Support): Intercom's Canvas Kit calls `POST /v1/support/intercom/{project_id}/canvas`; the body's `X-Body-Signature` (hex HMAC-SHA256 with the Intercom app's client secret) is checked, the contact is found by `external_id` then email, and the answer is the support summary as Canvas Kit components (status, entitlements, plan, renewal, total spent, customer since, refunds, open tickets, an "Open in RevenueDot" button).
- **Zendesk** (Support): a private ticket sidebar app in `integrations/zendesk-app/` (manifest, iframe, translations, logos). It calls `GET /v2/projects/{id}/support_summaries?email=` with a secret key kept in Zendesk's secure settings (`{{setting.secret_key}}`, `secure: true`), so the key never reaches an agent's browser. "Mark as installed" on the page records it for the catalogue.

**Funnel events to ad networks.** FUNNEL_VIEWED, FUNNEL_STEP_COMPLETED and FUNNEL_PURCHASE (web billing funnels, opt-in by event filter, `prd/web-billing/PRD.md` §5) reach the partners that can match a web visitor:

| Partner | Request | Names | Matching |
|---|---|---|---|
| Meta Ads | Conversions API website event (`action_source: website`, `event_source_url`) | ViewContent, FunnelStepCompleted (Lead for an email step), Purchase with USD value | `client_user_agent` (required, else skipped), `client_ip_address`, `fbc` = `fb.1.<ms>.<fbclid>`, `external_id` = SHA-256 of the visitor's anonymous app user id |
| Google Tag Manager | GA4 Measurement Protocol to the server container | page_view (with `page_location` = the page plus utm_* and gclid), rd_funnel_step_completed (generate_lead for an email step), purchase | `client_id`/`user_id` = the anonymous app user id |
| Branch | v2 web event | VIEW_ITEM, rd_funnel_step_completed (COMPLETE_REGISTRATION for an email step), PURCHASE | `developer_identity`, `user_agent`, `ip`, `http_origin`, click ids and utm in `custom_data` |
| AppsFlyer | Web S2S API `POST https://events.appsflyer.com/v2.0/s2s/inapps/app/web/{web_app_id}`, `Authorization: Bearer <Web S2S token>` (the request RevenueCat publishes for its own web events) | rd_funnel_* with `event_revenue` in USD | `user_id.customer_user_id`; new settings `web_app_id` and `web_s2s_token`; sandbox funnel events are skipped |

To make this possible, a funnel event records, only when an enabled integration's filter names a FUNNEL_* type, the visitor's IP, user agent and page URL (the page now sends `page_url`) and the landing URL's ad click ids (`fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`, `msclkid`); no visitor IP is stored otherwise. FUNNEL_PURCHASE is recorded from Stripe's checkout completion, so it inherits the session's landing context, utm_* included, and carries `revenue_usd` and `currency`. Adjust, Kochava, Singular, Tenjin, Airbridge and Asapty match by mobile device ids or Apple Ads attribution, which a web visitor does not have, so they never queue funnel events. The same web purchase also arrives as INITIAL_PURCHASE from the Stripe store; Meta's and Branch's app paths skip it without device ids, so it is counted once. Tests: `apps/server/test/funnel-ads.test.ts`, `packages/core/test/integrations-funnel-ads.test.ts` (exact requests).

No real partner account has received an event; every test uses fakes.

**Tests:** `packages/core/test/integrations-batch-d-analytics-attribution.test.ts` (51) and `integrations-batch-d-marketing.test.ts` (26): the exact request of every partner for one App Store purchase (method, URL, headers, body compared field by field), names for trials and renewals, refunds, sandbox, identity skips, redaction, answer and save checks; `packages/core/test/integrations.test.ts` checks every catalogue entry; `apps/server/test/ads.test.ts` covers the Intercom canvas signature and the Apple Search Ads client secret, name sync and report; `apps/server/test/funnel-ads.test.ts` and `packages/core/test/integrations-funnel-ads.test.ts` cover funnel events to ad networks; `apps/dashboard/e2e/ads.spec.ts` configures Superwall against a local fake (delivered), Statsig (save check), AdMob, Zendesk and the Intercom inbox in the browser.

## Paywall events
RevenueCat sends paywall events to Amplitude, Mixpanel, PostHog and Segment when "Send Paywall events" is on in the integration ([Paywall integrations](https://www.revenuecat.com/docs/tools/paywalls/integrations.md), and the Paywalls events section of each partner page, e.g. [Amplitude](https://www.revenuecat.com/docs/integrations/third-party-integrations/amplitude.md)). Its webhooks get none ([event types](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields.md)).

- **Types:** opt-in `PAYWALL_IMPRESSION`, `PAYWALL_CLOSE`, `PAYWALL_CANCEL`, `PAYWALL_EXIT_OFFER`, `PAYWALL_COMPONENT_INTERACTED` (RevenueCat's five) plus `PAYWALL_PURCHASE_INITIATED` and `PAYWALL_PURCHASE_ERROR` (RevenueDot additions; the SDKs already post them). `OPT_IN_EVENT_TYPES` in `packages/core/src/events.ts`.
- **Source:** the SDKs' `POST /v1/events` (`services/sdk-events.ts`). After storing the batch in `sdk_events`, one lookup of the project's enabled webhook and integration filters decides whether any paywall type is wanted; only then are customers, attributes, aliases and paywall names read, an `events` row written and deliveries queued. The row id is a UUID derived from the project and the SDK's event id, so a resent batch queues nothing twice. Forwarding never fails the request.
- **Event body:** `id`, `type`, `event_timestamp_ms`, `app_id`, `app_user_id`, `original_app_user_id`, `aliases`, `environment` (from `is_sandbox`/`X-Is-Sandbox`), `store` (the app's store), the paywall fields (`paywall_id`, `paywall_name`, `paywall_revision`, `offering_id`, `session_id`, `display_mode`, `dark_mode`, `locale`, placement and targeting from `presented_offering_context`, exit offer, package, product, error and component fields; `PAYWALL_EVENT_FIELDS`), `sdk_version`, `platform_version` and `subscriber_attributes`. No price, revenue or transaction.
- **Analytics tools:** Segment, Amplitude, Mixpanel and PostHog send them named `paywall_impression` … (RevenueCat's defaults), renamable under Event names, with the paywall fields as properties, no revenue and no subscription status (Mixpanel sends no profile update). BigQuery takes every event it is given. The webhook-adapter partners never get them.
- **Filters:** for integrations, paywall types listed in `event_types` are added to the other events instead of narrowing the filter (`services/integrations/queue.ts`), so ticking "Send paywall events" keeps purchases flowing. Funnel and alias types keep narrowing it, so funnel-only ad integrations stay funnel-only. Webhooks keep RevenueCat's filter rule: a non-empty list is exactly what is sent.
- **Cost on the request path:** only events that carry the SDK's `id` are forwarded (both SDKs always send one), the filters are read once per batch and passed down, each event is forwarded in its own try/catch.
- **Dashboard:** a "Paywall events" group on the Segment, Amplitude, Mixpanel and PostHog pages ("Send paywall events" ticks RevenueCat's five; each type can be changed) and a Paywall events group in the webhook form.
- **Tests:** `packages/core/test/integrations-paywall-events.test.ts`, `apps/server/test/paywall-events.test.ts`, `apps/dashboard/e2e/paywall-events.spec.ts`.

## Scheduled data exports
- **Destinations:** Amazon S3 (virtual-hosted URL in the bucket's region, or any S3-compatible `endpoint` path-style), Cloudflare R2 (`https://<account id>.r2.cloudflarestorage.com`, region `auto`), Google Cloud Storage (JSON API simple upload, service-account token). S3 and R2 use an access key pair; requests are signed with AWS Signature Version 4 in WebCrypto (`services/exports/sigv4.ts`, checked against AWS's published vectors).
- **Formats:** CSV, gzip (`.csv.gz`, default) or plain; Parquet (Snappy) through hyparquet-writer, which is pure JavaScript, so Parquet works on Workers too (the Worker build bundles it). CSV times are UTC `YYYY-MM-DD HH:MM:SS`; Parquet uses TIMESTAMP_MILLIS, INT64, DOUBLE, BOOLEAN, STRING and JSON columns.
- **Files:** `<prefix>/<YYYY-MM-DD>/<table>_<YYYYMMDDTHHMMSSZ>.<ext>`, split into `_part2`, `_part3` ... above 10,000 rows. The date is the end of the window.
- **Schedule:** daily at `hour_utc` (default 03:00 UTC) or weekly on `weekday` (0 = Sunday). The every-minute tick queues a run when `next_run_at` passes and works through one run per tick. "Run now" queues a run at once (on Node it starts right away; on Workers within a minute, on the cron).
- **Incremental and full:** each table keeps the end of its last successful window (`export_jobs.cursor`). Incremental runs export rows that changed in (previous end, this end]; a table's first run, and any run with mode `full`, exports everything up to the end. A transaction counts as changed when it was recorded, refunded or its refund was reversed, or its subscription changed (cancellation, billing issue) in the window. RevenueCat's guidance applies: key rows on `store_transaction_id` and keep the latest by `updated_at`.
- **Tables:** `transactions` (RevenueCat's transaction export columns we can fill: rc_original_app_user_id, rc_last_seen_app_user_id_alias, country, country_source, product_identifier, product_display_name, product_duration, start_time, end_time, grace_period_end_time, effective_end_time, store, is_auto_renewable, is_trial_period, is_in_intro_offer_period, is_sandbox, price_in_usd (0 once refunded), purchase_price_in_usd, takehome_percentage, tax_percentage, commission_percentage, store_transaction_id, original_store_transaction_id, refunded_at, unsubscribe_detected_at, billing_issues_detected_at, purchased_currency, price_in_purchased_currency, purchase_price_in_purchased_currency, entitlement_identifiers, renewal_number, is_trial_conversion, presented_offering, ownership_type, reserved_subscriber_attributes, custom_subscriber_attributes, platform, updated_at, offer, offer_type, first_seen_time, auto_resume_time, plus app_id); `customers`, `subscriptions`, `events` (RevenueDot's own; events carry the webhook body as JSON).
- **Environment:** both (default), production or sandbox.
- **Failures:** a transient failure (5xx, timeout, token endpoint down) retries the whole run after 10 and 30 minutes; files are overwritten, so a retry is safe. 4xx and credential errors fail the run. The bucket check runs S3 HeadBucket or GCS buckets.get and says what to fix on 403 and 404.

## Endpoints and screens
All under `/v2/projects/{project_id}`, scopes `project_configuration:integrations:read` and `:read_write`, written to the audit log (target types `integration` and `data_export`; tests and bucket checks are not logged). RevenueDot extensions: RevenueCat's API v2 has only webhook integrations.
- `GET integrations/catalog`: each integration's fields (key, label, type, options, hints), default environment and docs link. The dashboard draws its forms from it.
- `GET`, `POST integrations/partners`; `GET`, `POST`, `DELETE integrations/partners/{id}`. Body: `type`, `name`, `enabled`, `environment` (production, sandbox, null for both), `app_id`, `event_types`, `settings` (every catalogue field; secrets included, `null` removes one, missing keeps it), `event_names`.
- `POST integrations/partners/{id}/test` (`app_user_id`, `environment`, `product_id`): a TEST event to this integration only; with `app_user_id` it carries that customer's attributes, so attribution partners can be tested end to end.
- `GET integrations/partners/{id}/deliveries?status=pending|delivered|failed|skipped`, `POST .../deliveries/{delivery_id}/retry`, `POST .../actions/replay` (`status`: failed, skipped, failed_and_skipped; `since`, `until` in ms).
- `GET`, `POST integrations/exports`; `GET`, `POST`, `DELETE integrations/exports/{id}`; `POST .../actions/run` (`mode`); `POST .../actions/check`; `GET .../runs`.
- Dashboard: `/projects/:projectId/integrations` (catalogue with live cards), `/integrations/:type` (configure, test, turn off, delivery log with retry and replay), `/integrations/exports` (list), `/integrations/exports/new` and `/integrations/exports/:exportId` (destination, format, schedule, tables, run now, check bucket, run history).
- Database: migration `0013_integrations_exports.sql` adds `integrations`, `integration_deliveries`, `export_jobs`, `export_runs`, and `transactions.created_at` (for incremental exports; existing rows get the migration's time).

## Tests that prove it
- `packages/core/test/integrations.test.ts` (26): the exact request of each integration for one App Store INITIAL_PURCHASE; names and fields for trial start, conversion, renewal, cancellation, refund and expiration; reserved ids; sandbox and device-id skips; Android routing; partner answers and which statuses retry.
- `apps/server/test/integrations.test.ts` (8): sealed secrets and hints, validation, audit; fan-out from the real purchase pipeline to several integrations with a scrubbed log; the 5/10/20/40/80-minute schedule then failed, a 400 failing at once, replay; a skip that goes through after the app sends `$appsflyerId`; environment, app, event type filters and pausing; the test event with a customer's attributes; BigQuery's service-account sign-in (the JWT verified with jose) and table creation; a changed encryption key.
- `apps/server/test/exports.test.ts` (7): signed gzip CSV to S3 read back (RevenueCat's columns, trial conversion, renewal numbers, attributes), the next day's incremental file with the refund and the new purchase only; Parquet to R2 read back with hyparquet (types included); GCS upload with a service-account token; schedules; retries after 10 and 30 minutes then failure on 403; HeadBucket check.
- `apps/server/test/sigv4.test.ts` (7): AWS's published Signature Version 4 vectors (get-vanilla, post-vanilla, query order, and four S3 examples).
- `apps/dashboard/e2e/integrations.spec.ts`: configure Slack and Amplitude in the browser against a local fake partner, send a test, see the delivery log, turn one off, configure an S3 export against a local fake bucket, run it and see the run history.

## Known gaps
- No real partner, bucket or BigQuery dataset has been used yet; every test uses fakes.
- Superwall, SplitMetrics Acquire and SolarEngine publish no URL for RevenueCat webhooks: customers ask the partner for it. Kochava's strict authentication, Airbridge's token type and Asapty's `source` check are not documented publicly; see the Batch D section.
- Funnel events reach Meta, Google Tag Manager, Branch and AppsFlyer; Adjust's web events need its web SDK's `web_uuid`, which funnels do not run, so Adjust gets none.
- Store credentials (`apps.credentials`) are not sealed with `services/secrets.ts` yet.
- Integrations and exports do not send alert emails when they keep failing.
- AppsFlyer web APIs, Meta's App Events API, paywall and funnel events, column selection, Azure and email destinations, the in-app currency ledger and IAM-role credentials are not built.
- Exports keep up to 10,000 rows (one file) in memory and spend at most about 20 seconds per tick; a big export is spread over several ticks and carries on from the last file written. Not yet tried on a project with millions of rows.
- Graph API version for Meta is pinned to v21.0 (`META_GRAPH` in `packages/core/src/integrations/meta.ts`).
