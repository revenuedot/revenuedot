# RevenueDot Enterprise (ee/LICENSE). Sourced by the enterprise browser tests: points DATABASE_URL at a database of its
# own on the Railway development Postgres (never a local Postgres), without printing it.
#   source ee/e2e/env.sh [database name, default rd_ee_e2e]
source ~/.config/revenuedot/dev.env
export DATABASE_URL="$(node -e 'const u = new URL(process.env.REVENUEDOT_DEV_DATABASE_URL); u.pathname = "/" + (process.argv[1] || "rd_ee_e2e"); process.stdout.write(u.toString())' "${1:-rd_ee_e2e}")"
