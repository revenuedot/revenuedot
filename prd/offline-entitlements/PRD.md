# Offline entitlements (Tier 2)

**Status:** built on branch `tier2-v2-events` (2026-10-01); App Store billing plans recorded online since 2026-10-03. `GET /v1/product_entitlement_mapping` answers per app, keys App Store products the way the iOS SDK looks them up (billing plans included) and Google Play products the way the Android SDK looks them up (the bare subscription id carries every base plan's entitlements). A contract test runs both SDKs' offline algorithms over our mapping and compares the result with the entitlements the server grants online.

## Users and jobs
- **End users** keep access to what they paid for when RevenueDot is down or unreachable with a 5xx: the SDK computes their entitlements on the device from their store purchases and the cached mapping.
- **App developers** get this with no code: the RevenueCat SDKs fetch the mapping every 25 hours and use it on their own.

## How the SDKs use the mapping
Read from the forks (`purchases-ios` `Sources/OfflineEntitlements/`, `purchases-android` `common/offlineentitlements/`):
- **When:** purchases completed by the SDK (not observer mode), no custom entitlement computation, not the Test Store, iOS 15+. Triggered by a 5xx on `GET /v1/subscribers/{id}` or `POST /v1/receipts` when no customer info is cached.
- **iOS** reads `StoreKit.Transaction.currentEntitlements`, re-keys every mapping entry by `product_identifier` plus the billing-plan component of `base_plan_id` (`"monthly"` is kept, `"upFront"` and none are dropped), and looks each transaction up by the same compound id. The dictionary key itself is ignored. Consumables abort the computation. When two products unlock one entitlement, a lifetime purchase wins, else the latest expiry.
- **Android** queries active Play purchases, which carry only the subscription id (no base plan), and looks up `mappings[productId]` by the **dictionary key**. It gives subscriptions an expiry of now + 1 day and aborts if any one-time product is active.

## Essential now and later
Essential (this change)
- **Per app.** A public key returns only its own app's products. A project with an App Store product `pro` and a Play product `pro:monthly` used to merge both into one `pro` entry with base plan `monthly`, which iOS then filed under `pro:monthly`, so iOS customers lost `pro` offline. A secret key without `X-Platform` still gets the whole project.
- **App Store keys.** `product` → key `product`. A product stored with a billing plan (`product:monthly`, iOS 26.4 monthly-commitment plans) → key `product:monthly` with `base_plan_id: "monthly"`; `product:upFront` → key `product` with `base_plan_id: "upFront"`, which is how iOS files an up-front purchase. No bare duplicate is added for App Store products.
- **Google Play keys.** `sub:plan` → key `sub:plan` with that plan's entitlements, plus the bare key `sub` with the **union** of the entitlements of all its base plans and the first base plan (by product creation, then id) as `base_plan_id`. Android cannot tell base plans apart offline; the union means no paying subscriber loses access during an outage. The cost is that a customer on a cheaper base plan may see the richer plan's entitlements for at most one day, and only while the server answers 5xx.
- **App Store purchases record the billing plan** (prd/store-apple/PRD.md): Apple's `billingPlanType` `MONTHLY` is stored as product plan `monthly`; `BILLED_UPFRONT` or no field is no plan. Online, a subscription matches the catalog with the same keys iOS uses offline (`productKeysFor` in `packages/core/src/entitlements.ts`): a monthly purchase of `product` matches `product:monthly`, then the bare `product`; an App Store purchase without a plan matches `product`, then `product:upFront`. Because the bare product also counts online for a monthly purchase, the `product:monthly` mapping key carries the bare product's entitlements too.
- **Other stores** (Test Store, Amazon, Stripe when merged) follow the Play rule when the identifier has a plan, else one key.
- **Entitlements:** only active entitlements, the same rule customer info uses; archived products still map, so earlier buyers keep access. Products without an entitlement are left out. Output order is stable.

Later
- Nothing for the SDK protocol. If RevenueCat changes how the bare Play key is chosen, follow it.

## RevenueCat behaviour we match
- Response `{ "product_entitlement_mapping": { "<key>": { "product_identifier", "base_plan_id"?, "entitlements": [] } } }`, refreshed by the SDK every 25 hours (`ios/resp-product-entitlement-mapping.json`, `android/product_entitlement_mapping.json`; https://www.revenuecat.com/docs/customers/customer-info#offline-entitlements).
- Offline entitlements need a 5xx, never a 4xx (`sdk-wire-protocol.md` section 8 in the company research). RevenueDot already answers 5xx for its own and the stores' temporary failures.
- One deliberate difference: the Android fixture's bare key carries the first base plan's entitlements only. Ours carries the union, for the reason above.

## Endpoints and screens
- `GET /v1/product_entitlement_mapping` (`apps/server/src/repo/catalog.ts` `productEntitlementMappingJSON`). No dashboard screen.

## Tests that prove it
- `packages/contract/test/offline-entitlements.test.ts`:
  - The iOS fixture's catalog produces exactly the iOS fixture. The Android fixture's catalog produces the Android fixture, except that the bare key holds the union.
  - Both responses decode with the SDK schema.
  - For every product of a mixed catalog (App Store with billing plans, Play with several base plans, one-time products), the online entitlements come from the server's own rule (`computeEntitlements`) and each SDK's offline algorithm (re-implemented from the forks, `packages/contract/src/offline-sdk.ts`) is run over the mapping: iOS matches online exactly, billing plans included; Android matches exactly for single-plan products and is a superset otherwise.
- `packages/contract/test/apple-billing-plan.test.ts`: signed StoreKit 2 transactions with `billingPlanType` `MONTHLY`, `BILLED_UPFRONT` and none go through `POST /v1/receipts`, App Store Server Notifications and the App Store Server API (all stubbed); customer info's active entitlements equal the iOS offline lookup for the same transaction, and `product_plan_identifier` is `monthly` only for the monthly plan.
- `packages/core/test/entitlements.test.ts` covers `productKeysFor`; `apps/server/test/apple.test.ts` covers the mapping from `billingPlanType`.
  - Keys never leak across apps.
- `packages/contract/test/sdk.test.ts` keeps the bare-and-plan key check, now with the Play app's key.

## Known gaps
- Amazon and Stripe products are mapped by the generic rule; their SDK paths are not covered by a fixture yet.
- A product stored only bare (`product`) and bought on Apple's monthly plan unlocks online but not offline: iOS looks the purchase up as `product:monthly`. Add `product:monthly` to the catalog to cover outages too. The billing-plan path is proven against a stubbed Apple only; no real iOS 26.4 purchase has run.
