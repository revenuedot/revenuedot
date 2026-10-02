# Customer Center editor

**Status:** built on branch `cc-editor` (2026-10-01). Dashboard editor, stored document, validation, SDK response and API v2 exposure are done and tested (unit, contract, Playwright, a real browser run against the Railway development database).

Scope rows: `prd/SCOPE.md` Tier 2 "Customer Center". Parity rows: `company/docs/research/parity-matrix.md` (Lifecycle: Customer Center), observed live in RevenueCat's dashboard (Lifecycle > Customer Center) on 2026-10-01.

## Who needs it
- **App developers** want to choose what customers can do on the in-app subscription screen without shipping a release: restore, change plan, cancel, refund, a help page, an in-app chat.
- **Growth teams** want to ask why customers cancel and answer each reason with an offer.
- **Designers and localizers** want the screen in the app's colours and in the customer's language.

## RevenueCat behaviour we match
- Header: Preview, Save changes, Reset configuration. Tabs Configuration, Appearance, Localization.
- Configuration: switches for the old-app-version warning, purchase history and the user details section (iOS only); two screens (customers with and without an active subscription), each with a title and an ordered list of paths, added from a menu (Missing Purchase, Refund Request, Change Plans, Manage, Custom URL, Custom Action; types already on the screen are disabled, Custom URL and Custom Action may repeat), each deletable. Selecting a path shows its description, button text and translations. Manage has a feedback survey (default answers Too expensive, Don't use the app, Bought by mistake); Manage, Refund Request and each survey answer can show a promotional offer. Custom URL has a URL and open method; Custom Action an action identifier.
- Appearance: accent, text, background, button text and button background colours for light and dark mode.
- Localization: 33 languages; custom strings per language with Delete selected; the predefined strings, each of which can be overridden.

## What we built
1. **Stored document** (`projects.customer_center`, JSON, no migration): the SDK shape plus editor-only fields: `title_localizations` / `subtitle_localizations` on screens, paths, surveys, answers and offers; `localization.custom_strings` (`{ language: { key: text } }`); a promotional offer is an offer of its own (`title`, `subtitle`, `product_mapping`), a reference `{ "retention_offer_id": "rto_..." }` to an offer under Lifecycle > Retention, or `null` (no offer, so the trigger's Retention offers are not added). Stored overrides merge over the default key by key (lists replace), so the Support page's partial saves and older clients keep working.
2. **Default** (`defaultCustomerCenter`, `packages/core/src/customer-center`): unchanged from before this branch so existing apps see no difference (Manage, Refund Request, Missing Purchase; no-active screen: Missing Purchase). RevenueCat's own default order (Missing Purchase, Change Plans, Manage, Refund Request; title "How can we help?") is one click away in the editor.
3. **Validation** (`validateCustomerCenter`): field-named problems for emails, hex colours, path ids (unique per screen), path types (non-repeatable types once per screen), Custom URL (a full URL), Custom Action identifiers, survey (only on Manage, 1 to 10 answers), offers (at least one product with a store offer id; a reference or an own offer, not both; references must exist in the project), languages, custom string keys, ticket settings and screen offerings. `POST /v2/.../customer_center_config` stores nothing when there is a problem and answers 400 with up to five problems.
4. **SDK response** (`sdkCustomerCenter`): exactly what purchases-ios `CustomerCenterConfigResponse` and purchases-android `CustomerCenterConfigData` decode. The language comes from `X-Preferred-Locales` (first supported locale; English and the configured locale otherwise). Texts: the configured translation, else the built-in translation of a default text, else as written. Strings: English base, built-in translations, then custom strings. Offers are filled to the SDK fields (`ios_offer_id`, `android_offer_id`, `eligible`, `title`, `subtitle`, `product_mapping`); paths the SDK could not act on (a Custom URL with no URL) are left out; only valid colours, ticket enums and offering types are sent; editor-only fields never are.
5. **API v2**: `GET /v2/projects/{id}/customer_center_config?locale=` returns `customer_center` (SDK shape), `config` (editable document) and `overrides`; `POST` replaces it (`null` resets). `GET /v2/projects/{id}/customers/{id}/customer_center?locale=` shows one customer's response.
6. **Dashboard** (`apps/dashboard/src/pages/lifecycle/CustomerCenter.tsx`, `CustomerCenterParts.tsx`): the three tabs; paths reorder by drag or arrows; a translations dialog per text; an offer picker (Retention offers for the trigger, none, one Retention offer, or an offer of its own); a phone preview that renders `sdkCustomerCenter` for either screen, light or dark, in any of the 33 languages, and follows taps into the survey and offers; Reset configuration with confirmation; unsaved-changes guard.

## Not built (gaps vs RevenueCat)
- Change Plans product groups (`change_plans`) have no editor; the SDK falls back to the store's plan list.
- The screen "offering" (a paywall button on the no-active screen) is stored and sent but has no editor control.
- Promotional offers of their own have no translations UI (the API accepts `title_localizations`).
- Custom strings cover the predefined keys; arbitrary keys are accepted by the API only.

## Tests
- `packages/core/test/customer-center.test.ts`: languages and locale matching, validation messages, SDK shape, translations, offer references, ticket and offering sanitising.
- `apps/server/test/customer-center.test.ts` (PGlite): storage, Support page partial saves, Retention offers and references, deleted offers, reset.
- `packages/contract/test/customer-center.test.ts`: the response decodes with the fields each SDK requires (zod schemas mirroring both SDKs, checked against the upstream fixtures) for the default, a full configuration in English and German, references and `null` offers; invalid documents are refused.
- `apps/dashboard/e2e/customer-center.spec.ts`: the editor end to end against the Node server.
