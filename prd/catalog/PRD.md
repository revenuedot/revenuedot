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
- Importing products and prices from App Store Connect and Google Play, and editing them in the store (Tier 2).
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

## Tests that prove it
- `packages/contract/test/v2-catalog.test.ts`: projects, apps (pagination, validation, delete cascades), products, the entitlement lifecycle, offering lifecycle with current switching and expansion, packages with eligibility criteria, and OpenAPI coverage of every catalog operation.
- `packages/contract/test/sdk.test.ts` ("offerings and mapping"): offerings per calling app decode with the SDK schemas; archived products drop out of packages; the mapping lists both Google ids.
- `apps/dashboard/e2e/catalog.spec.ts`: empty states, products, entitlement `pro`, offering `default` with packages and metadata, the SDK response decoded with `OfferingsSchema`, "Make default" by keyboard, duplicate, deactivate, delete, reorder, archive and unarchive, with no console errors.

## Known gaps
- Price labels such as "$9.99/week" need store import (Tier 2); the pages show the duration instead.
- The offering Paywall tab is disabled, and "Create with AI" is not offered.
- Google Play eligibility is kept and shown but can only be changed through `attach_products` in the API.
- The dashboard's "…" menu on each app group in Products is left out; the Apps page owns app settings.
