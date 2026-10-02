# Catalog (scope 1.6)

**Status:** Projects, apps, products, entitlements, offerings, packages, offering metadata and the current offering work through API v2 and the dashboard's Product catalog pages, and the SDK decodes the offerings they produce in the browser tests.

## Users and jobs
- **A developer setting up an app** adds the store product ids, groups them into entitlements such as `pro`, and builds the offering the paywall shows.
- **A growth person** changes which offering is current, or edits offering metadata, without shipping an app update.
- **A team moving from RevenueCat** recreates the same identifiers, so the SDK code in the app does not change.

## Essential now and later
Essential (Tier 1)
- Projects and apps, each app with a public SDK key that carries the store prefix the SDKs expect (`appl_`, `goog_`, `test_` and so on).
- Products by store identifier, with type, display name and an optional subscription duration; archive, unarchive and delete.
- Entitlements with attach and detach of products; archive, unarchive and delete.
- Offerings with a lookup key, display name, JSON metadata and exactly one current offering per project; archive and unarchive.
- Packages with reserved `$rc_` identifiers or custom ones, a position, and one product per app.
- Google Play eligibility on package products (`all`, SDK below 6, SDK 6 and above), so a legacy product and a new one can share a package.

Later
- Importing products from App Store Connect, Google Play and Stripe: built, see "Import from store" below. Prices from Apple and Google, and editing products in the store, are Tier 2.
- Paywalls, targeting rules and experiments on offerings (Tier 2); web purchase links (Tier 3).
- In-app currencies and web discounts (Tier 2).

## RevenueCat behaviour we match
- Entitlements are the level of access a customer has; products unlock them ([Entitlements](https://www.revenuecat.com/docs/getting-started/entitlements), operations `attach-products-to-entitlement`, `detach-products-from-entitlement`).
- An offering is a set of packages, and the project has one current offering that the SDK returns as `current_offering_id` ([Offerings](https://www.revenuecat.com/docs/offerings/overview), fixtures `ios/resp-offerings-real-signed.json` and `android/get_offerings_with_placements.json`). The first offering in a project becomes current, like RevenueCat's default offering.
- Offering metadata is free-form JSON the app reads at runtime ([Offering metadata](https://www.revenuecat.com/docs/tools/offering-metadata), operation `update-offering`).
- Products are added by their store identifier ([Products overview](https://www.revenuecat.com/docs/offerings/products-overview), operations `create-product`, `archive-product`).
- The SDK's product-to-entitlement mapping lists both the bare Google product id and `id:base_plan` (fixtures `ios/resp-product-entitlement-mapping.json`, `android/product_entitlement_mapping.json`).
- Every v2 catalog response is validated against RevenueCat's OpenAPI v2 response schemas (operations `list-projects`, `create-app`, `list-products`, `create-entitlement`, `create-offering`, `create-packages`, `attach-products-to-package` and the rest of the catalog tags).

## Endpoints and screens
API v2, all under `/v2/projects/{project_id}` unless noted (`apps/server/src/routes/v2/`):
- `GET, POST /v2/projects`; `GET, POST /apps`; `GET, POST, DELETE /apps/{app_id}`; `GET /apps/{app_id}/public_api_keys`.
- `GET, POST /products`; `GET, POST, DELETE /products/{id}`; `POST /products/{id}/actions/archive` and `/unarchive`.
- `GET, POST /entitlements`; `GET, POST, DELETE /entitlements/{id}`; `GET /entitlements/{id}/products`; `POST /entitlements/{id}/actions/archive`, `/unarchive`, `/attach_products`, `/detach_products`.
- `GET, POST /offerings`; `GET, POST, DELETE /offerings/{id}`; `POST /offerings/{id}/actions/archive` and `/unarchive`; `GET, POST /offerings/{id}/packages`.
- `GET, POST, DELETE /packages/{id}`; `GET /packages/{id}/products`; `POST /packages/{id}/actions/attach_products` and `/detach_products`.
- SDK side: `GET /v1/subscribers/{id}/offerings`, `GET /v1/offerings` and `GET /v1/product_entitlement_mapping` read the same tables (`apps/server/src/repo/catalog.ts`).

Dashboard (`apps/dashboard/src/pages/catalog/`), all under `/projects/:projectId/product-catalog/`:
- `offerings`, `offerings/new`, `offerings/:offeringId`, `offerings/:offeringId/edit`.
- `products`, `products/:productId`; `entitlements`, `entitlements/:entitlementId`.

## Import from store
RevenueCat's Products page has **+ New → Import Products**, which lists the products of the connected store that can be imported ([Product configuration](https://www.revenuecat.com/docs/offerings/products-overview)). Google Play subscriptions are imported as subscription id plus base plan id, and one-time products only when they are backwards compatible; Stripe products are imported from the Product catalog with a price chosen when a product has several ([Stripe](https://www.revenuecat.com/docs/web/integrations/stripe)). App Store Connect needs a team key with the App Manager role ([App Store Connect API key](https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/app-store-connect-api-key-configuration)); Google needs "View app information and download bulk reports (read-only)" among the service account's permissions ([Play service credentials](https://www.revenuecat.com/docs/service-credentials/creating-play-service-credentials)).

What RevenueDot does (`apps/server/src/services/store-import.ts`, `routes/v2/store-import.ts`):
- `GET /v2/projects/{id}/apps/{app_id}/store_products` (extension) lists every store product, all store pages read, with `type`, `duration` (ISO 8601), `display_name`, the store's state, its group, `importable` with a `note`, and `in_catalog` plus the catalog `product_id`.
  - **App Store / Mac App Store:** the App Store Connect API key (`app_store_connect_api_key`, `_id`, `_issuer`): the app by bundle id, its subscription groups and each group's subscriptions (`subscriptionPeriod` → `P1W` … `P1Y`), and in-app purchases v2 (`CONSUMABLE`, `NON_CONSUMABLE`, `NON_RENEWING_SUBSCRIPTION`). Paging follows `links.next` only on App Store Connect's own host.
  - **Google Play:** the service account: `monetization.subscriptions.list`, one row per base plan as `subscription_id:base_plan_id` with the base plan's billing period (prepaid and installment plans noted), and `monetization.onetimeproducts.list` (falls back to the legacy `inappproducts.list` when that API answers 404) as `one_time`. A subscription without a base plan is listed but not importable. One-time products without a backwards-compatible purchase option are importable with a note (RevenueCat requires manual entry for them).
  - **Stripe:** the app's restricted key ("Products: Read" covers products and prices), through the outbound guard: one row per active price (`price_…`, the identifier web billing uses), named after its product; recurring prices become subscriptions with their interval, one-time prices non-consumables. A product without an active price and metered prices are listed but not importable. A price whose product id is already in the catalog counts as in the catalog. RevenueCat imports the Stripe product and picks one price; RevenueDot imports prices so a monthly and a yearly price of one product can both be in the catalog.
  - **Amazon:** 422 with the reason: Amazon has no API that lists in-app items, so they are added by SKU. **Test Store:** 422, its products only exist in RevenueDot.
- `POST …/store_products/actions/import` with `store_identifiers` (1–1000) and optional `entitlement_ids` re-reads the store, so type, duration and name always come from the store, never the request. It creates what is missing, reports what was already in the catalog (`existing`) and what failed (`not_in_store`, `not_importable`), and attaches every created and existing product to the entitlements. Running it twice changes nothing. Flat-rate Stripe prices also become web products, so the web checkout can sell them.
- Errors: 422 `unprocessable_entity_error` naming the missing credential or permission (App Manager role; "View app information and download bulk reports (read-only)"; Stripe "Products" Read), 422 `store_error` with `retryable: true` while the store cannot be reached, 404 for another project's app, 400 for an unknown entitlement id.
- Dashboard: "Import products" on the Products page (and "Import" on each app group) and on each app's page opens a dialog: app picker, the store's products with search, select all, rows already in the catalog disabled, store notes, an optional entitlement picker, and a summary of what was created, skipped and failed.

## Tests that prove it
- `packages/contract/test/v2-catalog.test.ts`: projects, apps (pagination, validation, delete cascades), products, the entitlement lifecycle, offering lifecycle with current switching and expansion, packages with eligibility criteria, and OpenAPI coverage of every catalog operation.
- `packages/contract/test/sdk.test.ts` ("offerings and mapping"): offerings per calling app decode with the SDK schemas; archived products drop out of packages; the mapping lists both Google ids.
- `apps/server/test/store-import.test.ts`: the listing and the import against fake App Store Connect, Google Play and Stripe APIs (paging, types, durations, `in_catalog`, entitlements, idempotency, missing credentials and permissions, outages, Amazon).
- `apps/dashboard/e2e/store-import.spec.ts`: the import dialog against the e2e server's store fakes.
- `apps/dashboard/e2e/catalog.spec.ts`: empty states, products, entitlement `pro`, offering `default` with packages and metadata, the SDK response decoded with `OfferingsSchema`, "Make default" by keyboard, duplicate, deactivate, delete, reorder, archive and unarchive, with no console errors.

## Known gaps
- Price labels such as "$9.99/week" need Apple and Google prices (Tier 2); the pages show the duration instead. The import does not read App Store or Play prices yet.
- Store import has not run against a real App Store Connect, Play Console or Stripe account yet; it is tested against fakes built from the APIs' documented shapes.
- The offering Paywall tab is disabled, and "Create with AI" is not offered.
- Google Play eligibility is kept and shown but can only be changed through `attach_products` in the API.
- The dashboard's "…" menu on each app group in Products is left out; the Apps page owns app settings.
