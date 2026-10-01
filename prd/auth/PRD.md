# Auth: sign in with Firebase or OpenID Connect (batch F, beta)

**Status:** built on branch `tier2-settings-auth` (2026-10-01). Migration 0021. Tested with keys generated in the tests and fake identity providers; no real Firebase project or identity provider has been called.

Scope row: parity matrix "Auth (beta)" (batch F). Contact-sheet frame 30 (RevenueCat's Auth page, "request access"): drop in your authentication provider (Firebase or any OpenID Connect provider, identity mapping handled for you), read customer attributes in your app, build on top of identity (virtual currency balances straight from your backend). RevenueCat gates it behind a request; RevenueDot ships a real settings page.

## Users and jobs
- **Indie developers without a backend** sign users in with Firebase Auth, Auth0, Clerk, Supabase, Cognito, Google or Apple and want those users' purchases to follow them across devices, without writing a server that calls `logIn` safely.
- **Teams with a backend** want to read a signed-in user's in-app currency balance from their server by the identity provider's user id.

## What the SDKs send (sources: the forks, upstream `main` 2026-09-30)
RevenueCat's SDKs contain an internal "IAM" login mode (iOS `Sources/Networking/Operations/TokenOperations.swift`, `Sources/Identity/Identity.swift`, `Networking/Responses/IAMResponses.swift`; Android `identity/IdentityAuthToken.kt`, `common/networking/TokenManager.kt`, `common/JWT.kt`). It is off by default and cannot be turned on through a public API, so RevenueDot serves the same wire format for apps and forks that call it:
- `POST /auth/login` with the app's public SDK key as `Authorization: Bearer`, body `{ "method": "firebase" | "oidc" | "google" | "apple" | "facebook" | "anonymous", "scope": "openid offline_access", "id_token": "<provider ID token>", "link_to_id": "<current app user id>"? }`.
- Response `{ "access_token", "refresh_token", "id_token", "scope", "expires_in" }`. The SDK decodes `access_token` as a JWT and reads the app user id from the claim **`rc.app_user_id`**; it reads `amr` (list of methods) from the ID token.
- `POST /auth/token` `{ "grant_type": "refresh_token", "refresh_token" }` returns the same shape.
- `POST /auth/revoke` `{ "token", "token_type_hint": "refresh_token" }`.
- With a session, requests carry `Authorization: Bearer <access token>` on the `/v1/customer/*` paths (already served by PR #5 for `rdat_` tokens).

RevenueDot serves these paths both at `/auth/*` (where the SDK sends them; a request with a bearer key is an app login, without one it is the dashboard's sign-in) and at `/v1/auth/*` (with the SDK's CORS for web apps).

## Essential now
1. **Providers** per project: Firebase (Firebase project ID; issuer `https://securetoken.google.com/<id>`, audience the project ID, Google's published JWKS) or OpenID Connect (issuer URL, audiences, JWKS URL or discovery from `<issuer>/.well-known/openid-configuration`). Each provider maps a verified identity to an app user ID: a claim (default `sub`) and an optional prefix (`firebase:`). Enable or disable each one. Up to 10 per project.
2. **Project switch:** Auth on or off, and whether anonymous sign-in (`method: "anonymous"`) is allowed.
3. **Token verification on the server:** signature with the provider's keys (RS256/384/512, PS256/384/512, ES256/384, EdDSA; never `none` or HMAC), `iss` equal to the configured issuer, `aud` one of the configured audiences, `exp` in the future and `nbf`/`iat`/Firebase `auth_time` not in the future (60 s leeway), non-empty `sub` up to 255 characters, token at most 16 KB, and a mapped app user ID of 1 to 100 characters that does not start with `$RCAnonymousID:` (a signed-in user is never anonymous, so a later `link_to_id` cannot merge into it). Keys are fetched **through the outbound guard** (https and public addresses only on Cloud, no redirects), cached per URL for the response's `max-age` (5 minutes to 24 hours, else 1 hour), refetched for an unknown `kid` at most once a minute; stale keys keep working while the provider is down. A discovery document that fails is asked again at most once a minute. Answers are read as a stream and cut at 256 KB (a declared larger `Content-Length` is not read at all), so a key URL cannot make the server buffer more.
4. **Identity mapping with logIn semantics:** the first sign-in of `(provider, sub)` creates a link to the mapped app user ID; later sign-ins use the link even if the mapping changes. `link_to_id` that is an anonymous id (`$RCAnonymousID:…`) is merged into the signed-in user exactly like the SDK's `logIn` (purchases move under the project's transfer behaviour, SUBSCRIBER_ALIAS is recorded). A non-anonymous `link_to_id` is ignored. Blocked app user IDs still sign in but get no entitlements.
5. **Tokens:** the access token is a subscriber token (one hour, stored hashed in `subscriber_tokens` beside the `rdat_` tokens, pinned to its app user ID and app). Because the SDK decodes it, it is a JWT (`typ: at+jwt`) signed with the server's identity key; the server never trusts its claims, it looks the token up by hash. The refresh token (`rdrf_…`, 30 days, rotated on every use, stored hashed) belongs to a session that `/auth/revoke` ends (its access tokens stop working at once; a refresh token ends its session whatever `token_type_hint` says). **Reuse detection** (OAuth 2.0 Security BCP §4.14): the session keeps the hash of the refresh token it rotated away from (`identity_sessions.previous_refresh_hash`); presenting that token again ends the session and deletes its access tokens, so a stolen refresh token stops working for the thief and the app alike. Refresh is refused (403 · 7224) while Auth is off, while the session's provider is disabled, and for anonymous sessions while anonymous sign-in is off. The ID token is an EdDSA JWT with `iss` (the API origin), `sub` and `rc.app_user_id` (the app user ID), `aud` (the app ID), `amr`, `idp` (provider ID), `iat`, `exp`, verifiable with **`GET /.well-known/jwks.json`**.
6. **What the app reads with the access token:** customer info (`GET /v1/customer`), customer attributes (`GET /v1/customer/attributes`, new: the attributes the SDK set, as `{ "subscriber_attributes": { key: { value, updated_at_ms } } }`), in-app currency balances (`GET /v1/customer/virtual_currencies`) and spending them, offerings and the rest of the `/v1/customer/*` paths.
7. **Backend endpoints (secret key):** `GET /v2/projects/{id}/auth/identities` (list, filter by `provider_id`, `subject`, `app_user_id`), `GET /v2/projects/{id}/auth/identities/{provider_id}/{subject}` (the link with the app user ID, active entitlements and **in-app currency balances**), `DELETE` of the same path (unlinks and revokes its sessions).
8. **Dashboard Auth page** (`/projects/:id/auth`, sidebar item after Lifecycle, BETA tag): the three explainer cards from RevenueCat's page as a header, the project switch, providers with add/edit/delete dialogs, a "Test a token" dialog that verifies a pasted ID token and shows the claims and mapped app user ID without signing anyone in, sign-in snippets (Swift, Kotlin, JavaScript, curl) and the recent identities table.

## Endpoints
| Method | Path | Auth |
|---|---|---|
| POST | `/auth/login`, `/v1/auth/login` | app public key |
| POST | `/auth/token`, `/v1/auth/token` | app public key |
| POST | `/auth/revoke`, `/v1/auth/revoke` | app public key |
| GET | `/.well-known/jwks.json` | none |
| GET | `/v1/customer/attributes` | access token |
| GET/POST | `/v2/projects/{id}/auth/settings` | secret key, dashboard |
| GET/POST | `/v2/projects/{id}/auth/providers` | secret key, dashboard |
| GET/POST/DELETE | `/v2/projects/{id}/auth/providers/{provider_id}` | secret key, dashboard |
| POST | `/v2/projects/{id}/auth/providers/{provider_id}/actions/test` | secret key, dashboard |
| GET | `/v2/projects/{id}/auth/identities` | secret key, dashboard |
| GET/DELETE | `/v2/projects/{id}/auth/identities/{provider_id}/{subject}` | secret key, dashboard |

Errors on `/auth/*` use the SDK's error format `{ code, message }`: 401 · 7225 for a bad SDK key, 401 · 7224 for an ID token that fails verification, an unknown or expired refresh token, 400 · 7226 for a malformed body, 403 · 7224 when Auth is off for the project or the method has no enabled provider, 503 when the provider's keys cannot be loaded (the SDK retries).

## Keys
The identity key is derived with HKDF from `REVENUEDOT_SIGNING_KEY` (info `identity tokens v1`), else from `REVENUEDOT_ENCRYPTION_KEY`. Without either, `/auth/login` answers 503 with a message that names the setting. Its `kid` is the first 16 hex characters of the SHA-256 of the public key.

## Tests
- `apps/server/test/identity-auth.test.ts`: RSA and EC keys generated in the test, a fake JWKS and discovery document served by an injected fetch; Firebase and OIDC sign-in, every claim check, `link_to_id` merge, refresh rotation, replay ending the session, refresh refused once Auth, the provider or anonymous sign-in is off, revoke whatever the hint, anonymous-looking mapped ids refused, the 256 KB read cap and the discovery retry limit, the SDK's JWT decoding (`rc.app_user_id`, `amr`), `/v1/customer/*` reads, attributes, balances by identity, the JWKS cache (TTL, unknown `kid`, outage), the outbound guard refusing private JWKS URLs on Cloud, isolation between projects.
- `apps/dashboard/e2e/settings.spec.ts` (the Auth page: provider config, test token) and screenshots compared with frame 30.
- `scripts/e2e/journeys/settings-auth.ts`: the real Node server on a Railway development database with a local OpenID Connect provider (keys generated in the run, discovery and JWKS on the capture server): anonymous sign-in, purchases and attributes with the access token, OIDC sign-in with `link_to_id`, customer info, attributes and balances, isolation, the backend identity read, ten kinds of bad token, the dashboard's sign-in on the same path, refresh, replay, revoke, provider off, and key rotation.

## Not built
- Google, Apple and Facebook as their own provider kinds (configure them as OpenID Connect: Google's issuer is `https://accounts.google.com`, Apple's `https://appleid.apple.com`); Facebook limited login tokens are not verified.
- Encrypted ID tokens (JWE), mTLS-bound tokens, token introspection.
