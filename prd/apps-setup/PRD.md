# Apps and project setup (scope 1.10, setup parts)

**Status:** A new owner can sign up, create a project, connect App Store, Google Play and Test Store apps with credentials checked by a live call to Apple or Google, see whether store notifications arrive or fail, copy public keys, create secret keys, set transfer behaviour, and see which SDK versions call the server; the browser tests cover each step.

## Users and jobs
- **The person installing RevenueDot** signs up as the owner and connects the first app in one sitting, without guessing whether the keys are right.
- **A developer** copies the public key and the one-line proxy URL change into the app.
- **A team in a dual run with RevenueCat** forwards store notifications to RevenueCat and watches that both sides receive them.
- **The owner of a live app** notices when store notifications start failing or when an old SDK version still calls the server.

## Essential now and later
Essential (Tier 1)
- Owner-only sign-up on self-host: the first account signs up, later ones get 403 unless `REVENUEDOT_ALLOW_SIGNUP=true`. The sign-up page explains how to open it.
- New project with only a name. Apps list with store, ids, masked public keys (reveal and copy) and setup state: Ready, Notifications failing (with the store's error), or Waiting for store notifications.
- App configuration per store. App Store: bundle id, `.p8` in-app purchase key with key id and issuer id, App Store Connect API key and vendor number, "track new purchases". Google Play: package name and service account JSON. Test Store: nothing to set, plus a test purchase.
- "Check credentials": a live call to Apple or Google that answers valid, invalid (with a plain reason) or unreachable, using values from the form before they are saved.
- Server notification URL (`/v1/notifications/apple/{app_id}` or `/google/{app_id}`) with "last received" that updates by itself, and a forwarding URL with the last forward's status.
- API keys page: public app keys, and secret v2 keys created with a name and permissions, shown once, then revoked.
- Project settings: name, transfer behaviour (`transfer`, `transfer_if_no_active`, `keep`, `share`; default `transfer`), an optional separate sandbox behaviour, collaborators list, delete project.
- SDK compatibility panel on the Apps page from `setup_health.sdk_versions`: platform, flavor, latest and most used version, whether the major version is contract-tested, and what differs from stock RevenueCat.

Later
- Setting the notification URL through Apple's API, and asking Apple for a test notification.
- Refund request answers, Retention Messaging, StoreKit offer signing key, Small Business Program dates.
- Amazon, Mac App Store, Stripe, Paddle, Roku and Web Billing apps in the dashboard (the API already creates them).
- Inviting collaborators and changing roles; editing a secret key's name or permissions; legacy v1 secret keys.

## RevenueCat behaviour we match
- App Store apps use an In-App Purchase key (`.p8`, key id, issuer id) ([In-app purchase key](https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration)); Google Play apps use a service account with financial data access ([Play service credentials](https://www.revenuecat.com/docs/service-credentials/creating-play-service-credentials)).
- Each app gets its own notification URL and a "last received" time ([Apple notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications/apple-server-notifications), [Google notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications/google-server-notifications)).
- Public keys use the store prefixes the SDKs expect, and secret keys carry scopes ([Authentication](https://www.revenuecat.com/docs/projects/authentication), operation `list-app-public-api-keys`).
- The four transfer behaviours, with "transfer to the new app user id" as the default ([Restore behavior](https://www.revenuecat.com/docs/projects/restore-behavior)).
- Collaborators come back in RevenueCat's shape (operation `list-collaborators`); apps in RevenueCat's shape (operations `create-app`, `update-app`, `delete-app`).
- The dashboard layout follows RevenueCat's sidebar and page structure per `DESIGN.md`.

## Endpoints and screens
- Auth (`apps/server/src/routes/auth.ts`): `GET /auth/config` (edition, sign-up open or closed), `POST /auth/signup`, `/auth/login`, `/auth/logout`, `GET /auth/me`.
- Under `/v2/projects/{project_id}`: `GET, POST, DELETE` (settings; delete for dashboard admins only), `GET /collaborators`, `GET /apps/{app_id}/store_settings` (no secrets), `POST /apps/{app_id}/actions/verify_credentials`, `GET /setup_health`, `GET, POST /api_keys`, `DELETE /api_keys/{key_id}`, plus the app routes in `prd/catalog/PRD.md`. `notification_forward_url` is set through `POST /apps/{app_id}`.
- Dashboard: `/signup`, `/login`, `/projects/new`, `/projects/:projectId/apps`, `/apps/:appId`, `/api-keys`, `/settings` and `/settings/:tab` (`apps/dashboard/src/pages/setup/`, `pages/Auth.tsx`).

## Tests that prove it
- `apps/server/test/signup.test.ts`: owner-only sign-up, 403 with the `REVENUEDOT_ALLOW_SIGNUP=true` hint, open sign-up, cloud edition always open.
- `apps/server/test/setup-endpoints.test.ts`: `verify_credentials` for Apple (valid, 401, bad `.p8`, missing fields, Apple down) and Google (valid, no Play Console access, wrong package, not a key file); store settings without secrets and the forwarding URL.
- `apps/server/test/setup-health.test.ts`: waiting, failing, received and Ready notification states; SDK versions recorded from request headers, throttled, with a support level.
- `packages/contract/test/v2-project-settings.test.ts`: settings, transfer behaviour deciding who gets a restored receipt, permissions, delete, collaborators.
- `packages/contract/test/v2-auth-extensions.test.ts`: setup health and API keys (plaintext once, no privilege escalation, revoke).
- `apps/dashboard/e2e/setup.spec.ts`, `sdk-compat.spec.ts`, `auth.spec.ts`: the full setup flow in a browser, including a real forwarded notification, the SDK panel from real SDK calls, a failing app in the Apps list, and the closed sign-up page.

## Known gaps
- The App Store Connect API key is stored but has no live check.
- Real Apple and Google credential checks run only against mocks in tests; a run with real store credentials is still to do.
- There is no "Download sample app" banner.
