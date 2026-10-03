# ee/

Paid enterprise features: organizations, custom roles, single sign-on (SAML 2.0 and OpenID Connect), SCIM 2.0 provisioning, data-location controls, audit retention and compliance exports. High availability and the SLA are planned. Licensed under the RevenueDot Enterprise License in `ee/LICENSE` (the n8n Enterprise License with only the names changed), not AGPL-3.0. Free for development and testing; production use needs a valid RevenueDot Enterprise license. Spec: `prd/enterprise/PRD.md`. User docs: https://revenuedot.app/docs/guides/enterprise

## Turning it on
- `REVENUEDOT_LICENSE_KEY=rdl1_…` turns on the features the key lists (`server/license.ts` checks its Ed25519 signature).
- `REVENUEDOT_EE_DEV=true` turns on every feature for development and testing (refused on RevenueDot Cloud).
- With neither, nothing in this folder is imported and a self-hosted server behaves exactly like the open-source build.
- **RevenueDot Cloud always loads it** and ignores the key: each organization gets the features of its owners' best plan (`server/plans.ts`). Cloud Standard: organizations, custom roles, single sign-on. Enterprise: everything. Cloud Free sees them as locked. Spec: `prd/enterprise/PRD.md` §2a.

## Extension points
Nothing outside `ee/` imports from `ee/`, except these two files:
- `apps/server/src/extensions.ts`: the `ServerExtension` interface (`mount`, `projectAccess`, `passwordPolicy`, `config`, `me`, `tick`) and `loadExtensions`, which imports `ee/server/index.ts` only when the licence variables are set.
- `apps/dashboard/src/extensions.tsx`: finds `ee/dashboard/index.tsx` with a build-time glob and loads it lazily under `/organizations/*`; the dashboard links to it only when `/auth/me` reports `enterprise`.

## Layout
| Path | What |
|---|---|
| `server/index.ts` | The extension: routes, project access (enforced SSO, custom roles), password policy, tick |
| `server/schema.ts` | `ee_*` tables (migration `packages/db/migrations/0025_enterprise.sql`) |
| `server/license.ts` | Licence keys and features |
| `server/plans.ts` | Cloud: plan per organization, features per plan, the 90-day audit log purge |
| `server/orgs.ts`, `server/access.ts`, `server/provision.ts` | Organizations, custom roles, group role mappings, membership provisioning |
| `server/sso/` | SAML 2.0, OpenID Connect, domain verification |
| `server/scim/` | SCIM 2.0 Users and Groups |
| `server/region.ts` | Data location |
| `server/retention.ts`, `server/exports.ts` | Audit retention and signed compliance exports |
| `dashboard/` | Organization settings pages; `locked.tsx` shows a feature the plan or licence lacks |
| `scripts/` | Licence key pair and licence issuing |
| `test/` | Unit and API tests (`npx vitest run ee/test`) |
| `e2e/` | Browser tests on a Railway development database with a local test identity provider (`bash ee/e2e/run.sh`) |
