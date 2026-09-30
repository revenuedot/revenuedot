#!/usr/bin/env bash
# Deploys RevenueDot Cloud: builds the dashboard, applies migrations to the production Postgres, then `wrangler deploy`.
# Needs: `wrangler login` (Circo account), the Hyperdrive id in apps/server/wrangler.jsonc, CLOUD_DATABASE_URL set to the
# production Postgres URL, and the REVENUEDOT_SIGNING_KEY secret set once (see docs/cloud.md).
# Usage: CLOUD_DATABASE_URL=postgres://... pnpm deploy:cloud [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=""
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="--dry-run"

if grep -q '"id": "00000000000000000000000000000000"' apps/server/wrangler.jsonc; then
  echo "Put the Hyperdrive id from 'wrangler hyperdrive create' into apps/server/wrangler.jsonc first." >&2
  exit 1
fi
if [[ -z "$DRY_RUN" && -z "${CLOUD_DATABASE_URL:-}" ]]; then
  echo "Set CLOUD_DATABASE_URL to the production Postgres URL (the one Hyperdrive points at)." >&2
  exit 1
fi

echo "1/3 Building the dashboard"
pnpm --filter @revenuedot/dashboard build

if [[ -z "$DRY_RUN" ]]; then
  echo "2/3 Applying migrations"
  pnpm tsx scripts/migrate.ts "$CLOUD_DATABASE_URL"
else
  echo "2/3 Skipping migrations (dry run)"
fi

echo "3/3 wrangler deploy ${DRY_RUN}"
cd apps/server
pnpm exec wrangler deploy $DRY_RUN
