# Win-back offers (Tier 2)

**Status:** built on branch `tier2-v2-events` (2026-10-01). Every App Store and Google Play transaction records which offer it used, so win-back purchases show up in webhooks (`offer_code`), data exports (`offer`, `offer_type`) and the customer's subscription. Apple's list of win-back offers a lapsed customer may redeem is stored from the renewal info and readable through an API extension. Tested with signed test transactions and a mocked App Store; no real win-back offer has been redeemed yet.

## Users and jobs
- **App developers** turn on Apple's win-back offers (iOS 18+) and keep using the RevenueCat SDK as is: `eligibleWinBackOffers(forProduct:)`, `purchase(product:winBackOffer:)`, StoreKit messages and the App Store's streamlined purchase sheet.
- **Growth teams** see which lapsed customers came back on a win-back offer, in their webhook handler, their warehouse export and the customer page.
- **Lifecycle marketers** pick lapsed customers Apple says are eligible for a win-back offer and send them the offer's link from their own email tool.

## What the server must provide, and what it does not
The RevenueCat SDKs do all win-back work on the device. This table is the result of reading the forks.

| Question | Answer | Source |
|---|---|---|
| Who decides eligibility? | StoreKit, on the device: `Product.SubscriptionInfo.Status` → renewal info → `eligibleWinBackOfferIDs`, filtered to the product's own win-back offers | `purchases-ios` `Sources/Purchasing/StoreKit2/Win-Back Offers/WinBackOfferEligibilityCalculator.swift` |
| Does a win-back purchase need a server signature? | No. The SDK adds StoreKit's `.winBackOffer(offer)` purchase option; only promotional offers are signed (`POST /v1/offers`, already built) | `PurchasesOrchestrator.swift` (`options.insert(.winBackOffer(...))`) |
| Do offerings or paywalls carry win-back fields? | No. Neither the offerings response nor the paywall components have a win-back key; the SDK reads the offers from StoreKit | `OfferingsResponse.swift`, RevenueCatUI (no win-back keys) |
| What does the SDK send after a win-back purchase? | The normal `POST /v1/receipts` with the transaction's JWS. The JWS carries `offerType` 4 and the `offerIdentifier` | `PostReceiptDataOperation.swift` (no win-back field); Apple `offerType` (https://developer.apple.com/documentation/appstoreserverapi/offertype) |
| What happens when the customer redeems in the App Store without opening the app (streamlined purchasing)? | Apple sends `SUBSCRIBED` / `RESUBSCRIBE` to the app's notification URL. The chain is already known, so the purchase reaches the right customer as `RENEWAL` | RevenueCat's iOS offers guide asks for App Store Server Notifications for this case (https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/ios-subscription-offers) |
| Android? | The Android SDK has no win-back concept. Google Play offers are "new customer acquisition", "upgrade" or "developer determined"; a developer-determined offer used to win customers back arrives as an ordinary offer id on the purchase | `purchases-android` (no win-back code); https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/google-play-offers |

So the server's job is to record the offer faithfully and make it visible. Nothing in the SDK protocol changes.

## Essential now and later
Essential (this change)
- Record the offer on every subscription period and transaction: `offer_type` and `offer_id`.
  - App Store `offerType` 1 → `free_trial` when free, else `introductory`; 2 → `promotional`; 3 → `offer_code`; 4 → `win_back`. `offer_id` is Apple's `offerIdentifier`.
  - Google Play: a free-trial phase → `free_trial`, an introductory-price phase → `introductory`, any other offer → `unspecified` (RevenueCat's charts name for Google offers outside the first period). `offer_id` is `offerDetails.offerId`.
- Send the offer id as `offer_code` on webhook lifecycle events (RevenueCat: "Offer or promotion code used for the transaction", App Store and Google Play). It was always `null` before.
- Fill the `offer` and `offer_type` columns of the transaction export (they were always empty).
- Keep RevenueCat's period types: a free win-back period is `TRIAL`, a paid one `NORMAL` (`stores/apple/map.ts`, unchanged).
- Store Apple's `eligibleWinBackOfferIds` from the renewal info each time RevenueDot reads it (receipt posts with the In-App Purchase key, notifications, store actions), and expose it: `GET /v2/projects/{project_id}/customers/{customer_id}/win_back_offers` (RevenueDot extension).

Later
- A charts "Offer type" dimension (Free trial, Introductory, Offer code, Promotional, Win-back, Unspecified, No offer).
- An audience condition "eligible for a win-back offer" for targeting.
- Win-back offers on the web (RevenueCat's Web Billing campaigns) are out of scope: RevenueDot has no Web Billing.

## RevenueCat behaviour we match
- Win-back offers are for lapsed subscribers on iOS 18+, need the In-App Purchase key, and are redeemed through the App Store, a StoreKit message, a unique offer URL, a paywall, a StoreKit view or the app's own code (https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/ios-subscription-offers).
- A resubscription inside the same subscription group, win-back included, is a `RENEWAL` with the same `original_transaction_id` (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).
- `offer_code` is "sometimes" present and may be null; the transaction export has `offer` and `offer_type` (https://www.revenuecat.com/docs/integrations/scheduled-data-exports).

## Endpoints and screens
- No SDK endpoint changes.
- `stores/apple/map.ts` `offerOf` and `stores/google/map.ts` `offerOf` classify the offer; `services/purchases.ts` stores it on `subscriptions` and `transactions` (migration 0015); `services/events.ts` sends it as `offer_code`; `services/exports/tables.ts` exports it.
- `GET /v2/projects/{project_id}/customers/{customer_id}/win_back_offers` (scope `customer_information:subscriptions:read`): one item per App Store subscription chain with `{ object: "win_back_offer_eligibility", subscription_id, product_id, offer_ids, updated_at }`. `offer_ids` is Apple's list, best offer first; empty when Apple says none.

## Tests that prove it
- `packages/contract/test/win-back.test.ts`: a lapsed App Store customer comes back with a signed win-back transaction (`offerType` 4) through `POST /v1/receipts`; the customer info shows the subscription active with the right period type, the webhook is `RENEWAL` with `offer_code`, the transaction row and the export carry `win_back`, and the eligibility endpoint returns the offer ids from the renewal info. A streamlined purchase arrives as an App Store notification and reaches the same customer. Google Play offers are classified from `offerPhase` and `offerDetails`.

## Known gaps
- No real win-back offer has been redeemed: it needs an approved subscription in App Store Connect and a sandbox device.
- Google Play has no win-back offer type of its own; RevenueDot reports such offers as `unspecified` unless they are the free-trial or introductory phase.
