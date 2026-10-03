# RevenueDot: open-source, self-hostable alternative to RevenueCat. https://revenuedot.app
# One image runs the API and the dashboard. Set DATABASE_URL to a Postgres.
# Published as ghcr.io/revenuedot/revenuedot (linux/amd64 and linux/arm64) by .github/workflows/publish-image.yml.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
# The lockfile (and the pnpm settings in package.json) alone decide this layer, so the package download, the slow part
# of an arm64 build under QEMU, comes from Docker's cache and from the cache in CI until a dependency changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# The enterprise folder (ee/LICENSE) is in the image but stays off unless REVENUEDOT_LICENSE_KEY is set.
COPY ee ./ee
COPY design ./design
COPY brand ./brand
RUN pnpm install --frozen-lockfile --offline && pnpm --filter @revenuedot/dashboard build

FROM node:24-slim
COPY --from=build /app /app
WORKDIR /app/apps/server
ENV NODE_ENV=production PORT=8787 DASHBOARD_DIST=/app/apps/dashboard/dist
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node runs as PID 1 (no pnpm wrapper), so SIGTERM reaches the server and it drains (prd/ha-self-host/PRD.md).
# Migrations only (Helm hook Job, ECS and Cloud Run tasks): node --import tsx src/migrate.node.ts
CMD ["node", "--import", "tsx", "src/entry.node.ts"]
