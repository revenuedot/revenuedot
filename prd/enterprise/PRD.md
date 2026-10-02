# Enterprise (`ee/`): organizations, custom roles, SSO, SCIM, data location, audit retention, compliance exports (batch I)

**Status:** built on branch `tier3-ee` (2026-10-01). Migration 0025 (0022 to 0024 are reserved by `tier2-moves-billing`, `cc-editor` and `store-import`). Scope row: Tier 3, "The paid `ee/` folder" (`prd/SCOPE.md`). Licence: everything here lives in `ee/` under `ee/LICENSE`; the core only has licence-neutral extension points (§2).

## Users and jobs
- **IT and security admins** at larger app companies connect their identity provider (Okta, Microsoft Entra ID, Google Workspace, OneLogin, JumpCloud), require single sign-on for their domain, and let the identity provider create and remove accounts, so leavers lose access the moment HR offboards them.
- **Engineering and finance leads** group several apps' projects under one organization, give people the narrowest role that fits (a support agent who can refund but not edit the catalog), and see who has access to what.
- **Compliance officers** keep audit history for as long as their policy says (SOC 2, ISO 27001, HIPAA-adjacent apps keep one to seven years), export it with a signature an auditor can check, run quarterly access reviews, and keep EU users' data in the EU.

## What RevenueCat offers (sources checked 2026-10-01)
| Area | RevenueCat | RevenueDot Enterprise |
|---|---|---|
| Roles | Six fixed roles (Administrator, Operations, View Only, Growth, Developer, Support), on every plan; no custom roles ([collaborators](https://www.revenuecat.com/docs/projects/collaborators)) | Admin, Developer, Viewer built in (core) plus **custom roles** built from any of the 33 API v2 scopes, per organization or per project |
| Organizations | None: each project has one owner who pays; access is invited per project ([projects](https://www.revenuecat.com/docs/projects/overview)) | **Organizations** own projects, with owner, admin and member roles; organization admins are admins of every project |
| SSO | Enterprise plan only, on request; SAML or OIDC through WorkOS; enforced by email domain; turning it on removes existing collaborators ([SSO](https://www.revenuecat.com/docs/projects/sso)) | Self-serve **SAML 2.0** (SP- and IdP-initiated) and **OpenID Connect**, domain verification by DNS, enforcement by verified domain with an owner break-glass, just-in-time accounts; existing collaborators keep access |
| SCIM | Enterprise only; groups map to a role per project, highest role wins ([SSO](https://www.revenuecat.com/docs/projects/sso)) | **SCIM 2.0** Users and Groups (RFC 7643/7644), tested against Okta's and Entra's request shapes; same group → role per project, highest wins |
| Audit log | Per project; sign-ins, exports, changes; CSV export; retention not published ([audit logs](https://www.revenuecat.com/docs/dashboard-and-metrics/audit-logs)) | Project log (core) plus an **organization log**; retention set per organization (30 days to 10 years, or forever); **signed** CSV and JSON exports |
| Data location | US only (AWS), EU transfers under Standard Contractual Clauses ([DPA](https://www.revenuecat.com/dpa)) | Region per organization and project (US, EU); on Cloud each region is its own deployment and misrouted requests are refused (§8) |

Patterns followed: WorkOS for SSO set-up fields, DNS TXT domain verification, enforced SSO with an admin fallback, JIT provisioning and group-based roles ([SAML](https://workos.com/docs/integrations/saml), [domain verification](https://workos.com/docs/domain-verification), [JIT](https://workos.com/docs/user-management/jit-provisioning), [role assignment](https://workos.com/docs/sso/identity-provider-role-assignment)). SCIM follows [RFC 7643](https://datatracker.ietf.org/doc/html/rfc7643), [RFC 7644](https://datatracker.ietf.org/doc/html/rfc7644), [Okta's SCIM guide](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/) and [Entra's SCIM notes](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility).

## 1. Principles
1. **The open-source build is unchanged.** Without `REVENUEDOT_LICENSE_KEY` (or `REVENUEDOT_EE_DEV=true`), nothing in `ee/` is imported, no route is added and every response is what it was.
2. **Nothing outside `ee/` imports `ee/`**, except `apps/server/src/extensions.ts` (server) and `apps/dashboard/src/extensions.tsx` (dashboard), which load it only when the licence gate is on.
3. **One permission check.** Custom roles are lists of the same scopes secret API keys use; every API v2 route already checks `scope()`, so a custom role is enforced on every route with no per-route code.
4. **Least privilege on failure.** An unknown role, a deleted custom role or a project that left its organization means no access (the core now treats any role other than admin, developer and viewer as none).
5. **Never hand-roll XML signatures.** SAML uses `@node-saml/node-saml` (MIT) and `xml-crypto` (MIT); OpenID Connect uses `jose` (MIT).

## 2. Licence gate and extension points
- `REVENUEDOT_LICENSE_KEY=rdl1_<payload>.<signature>`: an Ed25519-signed JSON payload `{ v, id, licensee, features: ["*"] | [...], max_orgs, edition: "self-hosted" | "cloud" | "any", issued_at, expires_at }`, checked against public keys pinned in `ee/server/license.ts`. Expired keys keep working for 14 days with a warning, then the features turn off (password sign-in keeps working; SSO-only accounts need a password reset or a renewed key).
- `REVENUEDOT_EE_DEV=true`: every feature, for development and testing only (ee/LICENSE clause 3). Refused on RevenueDot Cloud. The dashboard shows a "Development licence" banner on organization pages.
- Features: `organizations`, `custom_roles`, `sso`, `scim`, `data_location`, `audit_retention`, `compliance_exports`.
- Server hooks (`ServerExtension`): `mount` (middleware and routes before the core's), `projectAccess` (deny, or a custom role's permissions), `passwordPolicy` (enforced SSO), `config` and `me` (dashboard flags), `tick` (periodic work). Dashboard hook: a lazily loaded module that adds `/organizations/*` routes and an "Organization settings" entry; loaded only when `/auth/me` returns `enterprise`.
- `ee/scripts/license-keygen.ts` makes the signing key pair; `ee/scripts/license-issue.ts` issues keys. **Decision for Kai:** the production public key is not pinned yet (§12).

## 3. Organizations
- An organization has a name, a default region, audit retention, SSO enforcement, seats bought (Cloud billing reads it; counting only here) and a billing email.
- Roles: **owner** (everything, including retention, seats, billing email, deleting the organization and managing owners), **admin** (members, projects, roles, SSO, SCIM, exports), **member** (sees the organization and the projects they were given).
- Owners and admins are **Admins of every organization project** (memberships with source "org"); demoting them removes those memberships.
- **Moving a project in:** an admin of the project who is an organization owner or admin. Everyone on the project becomes an organization member (source "project") so seats and access reviews include them. **Moving out:** memberships stay; custom roles turn into Viewer.
- **Seats used** = everyone active in the organization or a member of one of its projects.
- An organization with projects cannot be deleted; at least one owner always remains.

## 4. Custom roles
- Name (unique per organization), description, scopes (from the catalogue at `GET /v2/organizations/{id}/scopes`, 33 scopes in 5 groups), optional project (otherwise usable in every organization project).
- `project_configuration:api_keys:read_write` is admin-only and cannot be in a custom role. Members and invites stay with built-in Admins.
- Assigned with `POST /v2/organizations/{id}/projects/{project_id}/members/{user_id}` `{ role }` (organization admins or project admins); the core stores the role id in `memberships.role`.
- Enforcement: the core's project middleware asks `projectAccess`, which returns the role's scopes as the principal's `permissions`; `allows()` checks them exactly like a secret key's. MCP OAuth consent and RevenueDot AI treat custom roles as read-only (the API still checks each read).
- Deleting a role turns its members into Viewers and removes mappings that gave it.

## 5. Single sign-on
- **Connections** per organization: SAML 2.0 or OpenID Connect, enabled or not, with just-in-time provisioning on by default.
- **SAML:** SP entity id `<dashboard>/sso/saml/{id}/metadata`, ACS `<dashboard>/sso/saml/{id}/acs` (HTTP-POST), SP metadata at the entity id. SP-initiated via HTTP-Redirect with the request id kept in Postgres; IdP-initiated only when the connection allows it. Checks: assertion signature with the IdP certificate(s) (several during rotation), signature-wrapping defences of node-saml 5.1 (it reads only the signed XML), audience, Recipient, Destination, Issuer, NotBefore and NotOnOrAfter with 60 s skew, InResponseTo against an outstanding request for this connection, and **replay**: each assertion id is accepted once.
- **OpenID Connect:** discovery, authorization code with PKCE (S256), state and nonce, `id_token` verified with `jose` (issuer, audience, expiry, nonce, azp), `email_verified` must not be false. Discovery and JWKS URLs pass the outbound URL guard on Cloud.
- **Domains:** an organization adds a domain and publishes TXT `_revenuedot-sso.<domain>` = `revenuedot-sso-verification=<token>`; RevenueDot checks it over DNS-over-HTTPS. A domain belongs to one organization; public mail domains are refused. **SSO only signs in addresses on the organization's verified domains**, so an identity provider cannot sign in as someone else's account.
- **Sign-in:** "Continue with SSO" on the sign-in page asks for the work email and redirects to its organization's identity provider. Deep links survive (`next`).
- **Enforcement** (organization setting, needs an enabled connection and a verified domain): password sign-in, sign-up and reset are refused for addresses on verified domains (403 `sso_required` with the SSO link); sessions that did not start with this organization's SSO get 403 on its projects. **Owners keep password sign-in** (break-glass when the identity provider is down). People on other domains (contractors) keep their passwords; RevenueCat instead removes every collaborator when SSO turns on.
- **JIT:** first sign-in creates the account (no password, email verified) and organization membership; the `groups` attribute or claim is stored and mapped to project roles (§7). With JIT off, only existing organization members can sign in.

## 6. SCIM 2.0
- Base URL `<dashboard>/scim/v2`, bearer tokens per organization (`rdscim_…`, shown once, stored hashed, revocable).
- `ServiceProviderConfig`, `ResourceTypes`, `Schemas`, `/Users` and `/Groups` with GET (filters `eq ne co sw ew pr gt ge lt le`, `and or not`, value paths such as `emails[type eq "work"].value`), POST, PUT, PATCH (Okta's path-less `replace`, Entra's capitalised ops and `"False"` strings, dotted keys), DELETE; pagination with 1-based `startIndex`; ETags; RFC 7644 error bodies.
- Users must be on a verified domain. **Deprovisioning** (`active: false` or DELETE) removes every membership in the organization's projects and ends every session of that person at once; reactivation restores group-mapped access.

## 7. Group → role mappings
- `group name → (project, role)`, matched case-insensitively against SCIM group display names and SSO `groups` values. A person in several mapped groups gets the highest role per project: Admin, Developer, custom roles (more scopes first), Viewer.
- Provisioning only manages memberships it created (source "idp"); memberships added by hand are left alone while the person is active.

## 8. Data location
- Region on each organization (default for its projects) and each organization project: `us` or `eu`.
- **Self-host:** recorded, nothing enforced (the data is wherever the customer runs it).
- **Cloud:** each region is its own deployment (Worker, Hyperdrive and Postgres in that region). `REVENUEDOT_REGION` names this deployment's region and `REVENUEDOT_REGIONS` lists every region's API and dashboard origins. With more than one region configured, requests for a project in another region are refused before any route runs: API v2 and dashboard calls get 421 with the right origin; SDK calls and store notifications get 503 (retried, never a 4xx that would make the SDK finish a purchase). A project with customers cannot switch region from the dashboard (support moves the data). What Cloudflare and Railway need for EU hosting is in `docs/data-location.md`; **no EU resources exist yet**, so Cloud offers US only.

## 9. Audit retention
- The core keeps project audit logs forever (unchanged). An organization can set retention between 30 and 3,650 days, or keep forever (default). Only owners change it. An hourly job deletes older rows of the organization log and of its projects' logs, and records how many it deleted.
- Organization log actions: organization, member, project, role, mapping, SSO connection and domain, SCIM token and resource changes, SSO sign-ins and failures (reason, never the assertion), purges and exports.

## 10. Compliance exports
- `GET /v2/organizations/{id}/exports/audit_logs?format=csv|json&start_time&end_time`: organization and project audit rows, oldest first, with actor emails.
- `GET /v2/organizations/{id}/exports/access_review?format=csv|json`: one row per person per organization project (role, role name, the scopes it grants, how it was granted, password sign-in, last SSO sign-in, SCIM state), plus organization members without project access.
- Signed with Ed25519: `X-RevenueDot-Signature: ed25519=<base64>` over the exact file bytes, `X-RevenueDot-Content-SHA256`, `X-RevenueDot-Key-Id`; the public key is at `GET /v2/organizations/{id}/exports/public_key`. The key is derived (HKDF) from `REVENUEDOT_SIGNING_KEY` (else `REVENUEDOT_ENCRYPTION_KEY`), never the response-signing key itself. CSV cells that start with `= + - @` are prefixed with `'`. Up to 200,000 rows per file. Each export is logged with its SHA-256.

## 11. Dashboard
"Organization settings" (project switcher menu) at `/organizations/{id}/{tab}`, tabs: **General** (name, licence state, seats, billing email, delete), **Members**, **Projects** (move in and out, region), **Roles** (custom roles with the scope picker, project role assignment), **SSO** (connections with the values to paste into the identity provider, domains with the TXT record, enforcement), **SCIM** (tokens, base URL, group mappings), **Data location**, **Audit log** (organization log, retention), **Exports**. Sign-in page: "Continue with SSO". Same design system (`DESIGN.md`).

## 12. Decisions for Kai
1. **Licence signing key:** generate the Ed25519 pair (`pnpm tsx ee/scripts/license-keygen.ts`), keep the private key in 1Password, pin the public key in `ee/server/license.ts`, and set a Cloud licence (`REVENUEDOT_LICENSE_KEY` Worker secret). Until then only development mode turns features on.
2. **Which features are on Cloud Standard:** `company/docs/business-model.md` lists SSO, audit logs and region choice under Cloud Standard, while Tier 3 lists them as paid `ee/`. Options: Cloud Standard gets SSO (SAML and OIDC) and audit export; Enterprise adds SCIM, custom roles, enforcement, retention over one year and EU hosting.
3. **Development mode:** `REVENUEDOT_EE_DEV=true` unlocks everything on a self-hosted server with no key (ee/LICENSE clause 3 allows development use). Alternative: free 30-day development keys.
4. **EU region on Cloud:** whether and when to stand up the EU deployment (cost in `docs/data-location.md`).
5. **Retention on Cloud for non-enterprise projects:** the core keeps audit logs forever; a Cloud default (for example 90 days) would make retention a real upgrade.

## 13. Gaps
- SAML: no encrypted assertions, no signed AuthnRequests, no Single Logout. One SSO connection is used per organization at `/sso/start` (the first enabled one); others are reachable by their own start URL.
- OpenID Connect: no `private_key_jwt` client authentication.
- SCIM: no Bulk, no sorting; filters are evaluated in memory (fine to tens of thousands of users per organization).
- Organization API keys (machine access to organization routes) are not built; organization routes take a dashboard session.
- Data location: no EU deployment exists; moving a project's existing data between regions is a manual support job.
- Seats are counted, not billed: Cloud billing (branch `tier2-moves-billing`) must read `ee_organizations.seats`.
