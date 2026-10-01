# Ads: Overview, Rewards and AdMob (Tier 3, batch D)

**Status:** built on branch `tier3-ads-integrations` (2026-10-01). Ad revenue from the SDKs' ad events is shown in US dollars next to subscription revenue, rewarded ads are verified on the server with AdMob's signed callback and grant in-app currency or temporary access through rules, and AdMob can be connected to load ad unit names. Tested with a generated signing key, fake Google endpoints and the SDK poll; no real AdMob callback or Google account has been used yet.

Scope rows: parity matrix "Ads: overview, rewards" (batch D) and the AdMob row of "Integrations (37)". Contact-sheet frame 17 (RevenueCat's Ads page) and the live walkthrough note: three onboarding steps (add the SDK ad adapter, view ad revenue, impressions and placements, optionally connect AdMob to load ad units).

## Users and jobs
- **Developers of ad-supported apps** want ad revenue and subscription revenue in one place, in one currency, without exporting from each ad network.
- **Growth teams** want to see which networks, formats and placements earn the most, and eCPM over time.
- **Developers with rewarded ads** want rewards that cannot be faked from a modified app: the ad network tells the server, the server grants the reward, and the app only asks "did it go through?".
- **Product teams** want to change what a rewarded ad grants (coins, or a day of Pro) without an app release.

## What the SDKs send (sources: the forks, taken from upstream `main` on 2026-09-30)
- **Ad events** go to `POST /v1/events` in the same batch format as paywall events, with snake_case keys (iOS `Sources/Ads/Events/Networking/AdEventsRequest.swift`, Android `purchases/.../ads`): `id`, `version` (1), `type`, `app_user_id`, `app_session_id`, `timestamp_ms`, `capture_method` (`adapter` or `manual`), `network_name`, `mediator_name` (`AdMob`, `AppLovin` or any string), `ad_format` (`banner`, `interstitial`, `rewarded`, `rewarded_interstitial`, `native`, `app_open`, `other`), `placement`, `ad_unit_id`, `impression_id`; revenue events add `revenue_micros`, `currency`, `precision` (`exact`, `publisher_defined`, `estimated`, `unknown`).
- **Types:** `rc_ads_ad_failed_to_load` (plus `mediator_error_code`), `rc_ads_ad_loaded`, `rc_ads_ad_displayed`, `rc_ads_ad_opened`, `rc_ads_ad_revenue`, `rc_ads_ad_reward_sdk_earned` (`reward_verification_enabled`), `rc_ads_ad_reward_sdk_verified`, `rc_ads_ad_reward_sdk_failed_to_verify` (`reward_failure_reason`), `rc_ads_ad_reward_sdk_granted` (`reward_type`, `reward_virtual_currency_code`, `reward_virtual_currency_amount`, `reward_entitlement_id`).
- **Reward verification token** (`Purchases.generateRewardVerificationToken(impressionId:)`, iOS `Purchases.swift`): a new UUID `client_transaction_id` and `customData`, the JSON `{"api_key":"<the app's public key>","client_transaction_id":"…","impression_id":"…"}` with sorted keys. The app passes `customData` and the app user id to the ad network's server-side verification options (AdMob: `ServerSideVerificationOptions.customRewardString` and `userIdentifier`).
- **Polling** (`pollRewardVerification(clientTransactionID:)`): `GET /v1/subscribers/{app_user_id}/ads/reward_verifications/{client_transaction_id}` (subscriber-token mode: `/v1/customer/ads/reward_verifications/{id}`), up to 10 attempts about a second apart. The answer is `{"status":"pending"}`, `{"status":"verified","reward":{…}|null,"more_rewards":[…]}` or `{"status":"failed","failure_reason":"…","message":"…"}`. A reward is `{"type":"virtual_currency","code":"GEMS","amount":10}` (amount > 0) or `{"type":"entitlement","identifier":"pro","expires_at":"2026-10-02T12:00:00Z"}` (ISO 8601). After `verified` the SDK refreshes the customer's balances and customer info.

## AdMob server-side verification (sources)
- Google calls the SSV callback URL set on the rewarded ad unit with a GET whose query has `ad_network`, `ad_unit`, `custom_data`, `key_id`, `reward_amount`, `reward_item`, `signature`, `timestamp`, `transaction_id`, `user_id`; `signature` and `key_id` are always last. The signed message is the query string before `&signature=`. The signature is ECDSA P-256 with SHA-256, DER-encoded, base64url. Public keys: `https://www.gstatic.com/admob/reward/verifier-keys.json` (`{"keys":[{"keyId":…,"pem":…,"base64":…}]}`). https://developers.google.com/admob/android/ssv
- Google retries a callback that does not answer 200, and calls the URL with no parameters when you press "Verify URL" in AdMob.

## Essential now
1. **Ads Overview** (`/projects/:id/ads`): cards for ad revenue, impressions, eCPM, clicks and CTR, ad share of total revenue, and subscription revenue for the same period, each with the change from the previous period; a daily chart (ad revenue or impressions or eCPM, one measure at a time, with subscription revenue as a second series for revenue); tables by network, format, placement and ad unit (AdMob names when connected), and by mediator. Period 7D, 28D, 90D, 12M; Sandbox switch; app filter. With no ad events ever: RevenueCat's three onboarding steps (add the SDK adapter, explore ad analytics, connect AdMob).
2. **Ads Rewards** (`/projects/:id/ads/rewards`): the SSV callback URL to paste into AdMob, reward rules, a "Send a test reward" dialog, and the ledger of verifications with what each granted.
3. **Server-side verification:** `GET /v1/ads/admob/ssv`, the poll answers `verified` with the granted rewards.
4. **AdMob connection** (`/projects/:id/integrations/admob`): OAuth with a Google Cloud OAuth client, then the account's ad units are loaded and refreshed daily.
5. Remove SOON from Ads Overview and Rewards in the sidebar.

## Definitions
- **Ad revenue:** the sum of `revenue_micros / 1,000,000` of `rc_ads_ad_revenue` events in the event's `currency`, converted to US dollars at the rate of the event's day (the charts' FX tables: ECB, then the currency API, then bundled rates). Events in a currency we cannot convert count as 0 and are listed under "unconverted".
- **Impressions:** `rc_ads_ad_displayed` events. A network that sends only impression-level revenue (one `rc_ads_ad_revenue` per impression and no displayed events) counts each revenue event as an impression, per group, so eCPM is never infinite.
- **eCPM:** ad revenue ÷ impressions × 1,000. **Clicks:** `rc_ads_ad_opened`. **CTR:** clicks ÷ impressions. **Fill rate:** loaded ÷ (loaded + failed to load).
- **Ad customers:** distinct app user ids with an ad event in the period.
- **Subscription revenue:** the Overview's revenue rule: USD sum of transactions (refunds negative) purchased in the period, same environment.
- **Sandbox:** the SDK marks sandbox with `X-Is-Sandbox` (stored on `sdk_events.is_sandbox`); Test Store apps are sandbox. The switch shows one environment at a time, production by default.
- Periods are UTC days; the previous period has the same length and ends where this one starts.

## Rewards
- **Rules** (ordered, first match wins): an optional app, an optional ad unit id (AdMob `ad_unit` or the SDK's `ad_unit_id`), an optional reward item (AdMob `reward_item`), and a grant: in-app currency (`code`, a fixed `amount`, or the network's `reward_amount` times a multiplier) or an entitlement for a duration (minutes, 1 to 525,600). A rule can be turned off. No match: the reward is verified with no grant (`reward: null`), which the SDK reports as "verified, no reward".
- **Currency grants** go through the in-app currency ledger (`virtual_currency_transactions`, source `ad_reward`, idempotency key = the verification id), so a replayed callback never credits twice, and the balance is what `GET /v1/subscribers/{id}/virtual_currencies` returns. A `VIRTUAL_CURRENCY_TRANSACTION` webhook event is recorded with `source: "ad_reward"`.
- **Entitlement grants** are promotional grants (store `promotional`, product `rc_promo_<entitlement>_ad_reward`), exactly like `grant_entitlement`, so customer info, webhooks and integrations see them and they expire on their own.
- **Ledger** (`ad_reward_verifications`): one row per callback with network, transaction id, ad unit, reward item and amount, the customer, status, failure reason and the rewards granted. Unique on (network, network transaction id) and (project, client transaction id).
- **Failures recorded** (the poll answers `failed` with this reason): `invalid_custom_data` cannot be recorded (no project), so it is logged and answered 200 so Google stops retrying; `user_mismatch` when `user_id` is not the app user id in a token we issued for that customer; `grant_failed` when the rule names a currency or entitlement that no longer exists. Bad signatures answer 403 and record nothing.
- **Test rewards** (`POST /v2/projects/{id}/ads/reward_verifications/test`) run the same grant path for an app user id without a network callback, network `test`, marked sandbox.

## AdMob connection
- **OAuth client:** Google requires an OAuth client to read AdMob. RevenueDot Cloud reads `REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID` and `REVENUEDOT_GOOGLE_OAUTH_CLIENT_SECRET`; a self-hosted server sets the same variables, or each project pastes its own client id and secret on the AdMob page. Redirect URI: `<API origin>/v1/ads/admob/oauth/callback` (shown on the page). Scope `https://www.googleapis.com/auth/admob.readonly`, `access_type=offline`, `prompt=consent`.
- **State:** a random value; its SHA-256, the user and a 10-minute expiry are stored on the project's AdMob connection and cleared when used, so a callback cannot be replayed or used for another project.
- **Loading:** the refresh token (sealed) gets an access token; `GET https://admob.googleapis.com/v1/accounts` then `GET /v1/accounts/{publisher id}/adUnits` (paged) fill `ad_units` (ad unit id, display name, format, AdMob app id). Refreshed daily from the tick and with "Refresh now". Every Google call goes through the outbound guard without redirects.
- **Disconnect** deletes the tokens and the loaded ad units.

## Endpoints (RevenueDot extensions)
- `GET /v1/ads/admob/ssv` (Google, no key), `GET /v1/ads/admob/oauth/callback` (Google redirect).
- `GET /v1/subscribers/{app_user_id}/ads/reward_verifications/{client_transaction_id}` and `/v1/customer/ads/…`: real (was a stub answering `failed`).
- `GET /v2/projects/{id}/ads/overview?range=7d|28d|90d|12m&environment=production|sandbox&app_id=` (scope `charts_metrics:overview:read`).
- `GET`, `POST /v2/projects/{id}/ads/reward_rules`; `POST`, `DELETE /v2/projects/{id}/ads/reward_rules/{rule_id}`; `POST /v2/projects/{id}/ads/reward_rules/actions/reorder` (scope `project_configuration:integrations:read` / `:read_write`).
- `GET /v2/projects/{id}/ads/reward_verifications?status=verified|failed&app_user_id=` (paged), `POST /v2/projects/{id}/ads/reward_verifications/test`.
- `GET /v2/projects/{id}/ads/admob` (connection state, ad units), `POST /v2/projects/{id}/ads/admob/connect` (returns Google's authorization URL; body optional `client_id`, `client_secret`), `POST /v2/projects/{id}/ads/admob/refresh`, `DELETE /v2/projects/{id}/ads/admob`.
- Database: migration `0019_ads.sql` adds `ad_reward_rules`, `ad_reward_verifications`, `ad_units`; the AdMob connection is an `integrations` row of kind `admob` (sealed secrets).

## Tests that prove it
- `packages/core/test/ads.test.ts`: the overview aggregation (USD conversion per day, impressions fallback, eCPM, CTR, fill rate, breakdowns, previous period); rule matching; the reward answer shape for both SDK decoders; DER to P1363 signature conversion.
- `apps/server/test/ads.test.ts`: SSV signature verification with a generated P-256 key served as a fake `verifier-keys.json` (valid, tampered, unknown key id refetched once, empty "Verify URL" call); a verified reward credits currency once (replayed callback), and the SDK poll goes `pending` → `verified` with the reward, then `GET /v1/subscribers/{id}/virtual_currencies` shows the balance; an entitlement reward shows in customer info and expires; `user_mismatch`; rules CRUD and order; the overview against stored events in two currencies; the AdMob OAuth flow and ad unit load against a fake Google (state single use, expired state, sealed tokens, disconnect).
- `apps/dashboard/e2e/ads.spec.ts`: onboarding with no data, the overview with seeded events (cards, chart, tables, sandbox switch), a reward rule created in the browser, a test reward appearing in the ledger and in the customer's balance.

## RevenueCat behaviour we match and where we differ
- Same SDK protocol (event names, token format, poll answers), same onboarding steps, same page names and sidebar place (Ads ▸ Overview, Rewards), Sandbox switch.
- RevenueCat's Ads charts (Ad Revenue, eCPM, Impressions, Fill Rate, Ad Monetized Customers, Clicks, CTR, ARPDAU) already exist on the Charts page (`prd/charts/PRD.md`); the Overview links to them.
- RevenueCat does not document its SSV callback URL or reward configuration publicly; ours is `GET /v1/ads/admob/ssv` and the rules above. Only AdMob's callback format is verified: AppLovin MAX and ironSource callbacks are later.

## Later
- SSV for AppLovin MAX, ironSource (LevelPlay) and Unity Ads; AdMob Network Report revenue import (estimated earnings per ad unit per day) to compare with SDK-reported revenue; ARPDAU on the Overview; rewards that grant more than one item.
