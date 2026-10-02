# RevenueDot: open-source, self-hostable alternative to RevenueCat. https://revenuedot.app
# One image runs the API and the dashboard. Set DATABASE_URL to a Postgres.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# The enterprise folder (ee/LICENSE) is in the image but stays off unless REVENUEDOT_LICENSE_KEY is set.
COPY ee ./ee
COPY design ./design
COPY brand ./brand
RUN pnpm install --frozen-lockfile && pnpm --filter @revenuedot/dashboard build

FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=8787 DASHBOARD_DIST=/app/apps/dashboard/dist
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8787/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@revenuedot/server", "start"]
