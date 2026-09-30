#!/usr/bin/env bash
# Deploys RevenueDot Cloud with the `cf` CLI: builds the dashboard, finds (or creates) the Hyperdrive config "revenuedot",
# applies migrations to the production Postgres, then `cf deploy` (worker, dashboard assets, the app. and api. custom
# domains, the every-minute cron). Steps and background: docs/cloud.md.
#
# Needs: Node 22.18 or newer (cf loads cloudflare.config.ts), `cf auth login` with access to the Circo account, and the
# production Postgres URL in CLOUD_DATABASE_URL (default: read from 1Password, op://RevenueDot/Railway production Postgres/url).
# Run it from a clean checkout of main: it deploys and migrates whatever is in the working tree.
#
# Usage: pnpm deploy:cloud [--dry-run] [--secrets-file ~/.config/revenuedot/signing-root.key]
#   --secrets-file  .env file with REVENUEDOT_SIGNING_KEY=..., uploaded with the version. Needed on the first deploy
#                   only; later versions keep the secret.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=""
SECRETS_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --secrets-file) SECRETS_FILE="$2"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# The Circo account (also the default in apps/server/cloudflare.config.ts). Every cf call below targets it.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-5a8f4d72ace5f438725e1dfd1b0380ff}"
# The worker has no containers. Without this, the build waits on `docker image ls` when Docker is installed but not running.
export WRANGLER_DOCKER_BIN="${WRANGLER_DOCKER_BIN:-false}"
export CF_QUIET=1
CF=(pnpm --dir apps/server exec cf)

node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; }
# cf loads cloudflare.config.ts, which needs Node 22.18+. If the default node is older, use a newer nvm or Homebrew node.
if ! node_ok node; then
  for n in "$HOME"/.nvm/versions/node/v*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$n" ]] && node_ok "$n"; then export PATH="$(dirname "$n"):$PATH"; break; fi
  done
fi
node_ok node || { echo "cf needs Node 22.18 or newer to load cloudflare.config.ts (this is $(node -v))." >&2; exit 1; }

# CI passes CLOUD_DATABASE_URL from the GitHub "production" environment. A manual deploy reads it from 1Password.
if [[ -z "${CLOUD_DATABASE_URL:-}" && -z "$DRY_RUN" ]] && command -v op >/dev/null; then
  CLOUD_DATABASE_URL=$(op read "op://RevenueDot/Railway production Postgres/url" | tr -d '\n')
fi
if [[ -z "$DRY_RUN" && -z "${CLOUD_DATABASE_URL:-}" ]]; then
  echo "Set CLOUD_DATABASE_URL to the production Postgres URL (the one Hyperdrive points at)." >&2
  exit 1
fi

echo "1/4 Building the dashboard"
pnpm --filter @revenuedot/dashboard build

echo "2/4 Hyperdrive config \"revenuedot\""
# CI sets REVENUEDOT_HYPERDRIVE_ID (a GitHub variable), so its token needs no Hyperdrive permission.
[[ -z "${REVENUEDOT_HYPERDRIVE_ID:-}" ]] && REVENUEDOT_HYPERDRIVE_ID=$("${CF[@]}" hyperdrive list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s).find(c=>c.name==="revenuedot");console.log(h?h.id:"")})')
if [[ -z "$REVENUEDOT_HYPERDRIVE_ID" && -z "$DRY_RUN" ]]; then
  # The connection string goes in a temp file (mode 600), never on the command line.
  body=$(mktemp); trap 'rm -f "$body"' EXIT; chmod 600 "$body"
  CLOUD_DATABASE_URL="$CLOUD_DATABASE_URL" node -e 'const u=new URL(process.env.CLOUD_DATABASE_URL);process.stdout.write(JSON.stringify({name:"revenuedot",origin:{scheme:"postgres",host:u.hostname,port:Number(u.port||5432),database:decodeURIComponent(u.pathname.slice(1)),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password)}}))' > "$body"
  REVENUEDOT_HYPERDRIVE_ID=$("${CF[@]}" hyperdrive create --body "@$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
  rm -f "$body"
  echo "Created Hyperdrive config $REVENUEDOT_HYPERDRIVE_ID"
fi
export REVENUEDOT_HYPERDRIVE_ID="${REVENUEDOT_HYPERDRIVE_ID:-00000000000000000000000000000000}"
echo "Hyperdrive id: $REVENUEDOT_HYPERDRIVE_ID"

if [[ -z "$DRY_RUN" ]]; then
  echo "3/4 Applying migrations"
  pnpm tsx scripts/migrate.ts "$CLOUD_DATABASE_URL"
else
  echo "3/4 Skipping migrations (dry run)"
fi

echo "4/4 cf deploy ${DRY_RUN}"
DEPLOY_ARGS=($DRY_RUN)
[[ -n "$SECRETS_FILE" ]] && DEPLOY_ARGS+=(--secrets-file "$SECRETS_FILE")
"${CF[@]}" deploy ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}
