#!/usr/bin/env bash
# RevenueDot Enterprise (ee/LICENSE). Runs the enterprise browser tests on a fresh database of their own on the Railway
# development Postgres, then drops it. One Playwright worker; ports 5462 (server) and 5463 (test identity provider).
#   bash ee/e2e/run.sh [playwright args, e.g. sso-saml.spec.ts]
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${EE_E2E_DB:-rd_ee_e2e}"
source ee/e2e/env.sh "$DB"
node ee/e2e/db.mjs recreate "$DB"
[ -f apps/dashboard/dist/index.html ] || pnpm --filter @revenuedot/dashboard build
status=0
(cd ee && npx playwright test -c e2e/playwright.config.ts "$@") || status=$?
[ "${KEEP_DB:-}" = "1" ] || node ee/e2e/db.mjs drop "$DB"
exit $status
