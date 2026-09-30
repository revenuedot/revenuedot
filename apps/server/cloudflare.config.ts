// RevenueDot Cloud on Cloudflare Workers, built and deployed with the `cf` CLI. Steps and inputs: docs/cloud.md.
// Deploy with `pnpm deploy:cloud` from the repo root; it creates or finds the Hyperdrive config and passes its id in.
import { bindings, defineConfig, triggers } from "cf/config";

/** The Circo account. Every `cf` command run from this folder (deploy, hyperdrive, domains) targets it. */
const CIRCO_ACCOUNT_ID = "5a8f4d72ace5f438725e1dfd1b0380ff";

export default defineConfig({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? CIRCO_ACCOUNT_ID,
  worker: {
    name: "revenuedot",
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/entry.worker.ts",
    // The dashboard build (apps/dashboard/dist, copied in by vite.config.ts). The worker answers the API paths itself
    // and hands everything else to ASSETS, which falls back to index.html for the single-page app's routes.
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: true },
    // One worker serves both hostnames: api.revenuedot.app is all API, app.revenuedot.app is the dashboard plus
    // same-origin API calls.
    domains: ["app.revenuedot.app", "api.revenuedot.app"],
    // The one periodic job: expirations, Google voided purchases, webhook deliveries.
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],
    observability: { enabled: true },
    env: {
      // Postgres through Hyperdrive. scripts/deploy-cloud.sh sets REVENUEDOT_HYPERDRIVE_ID to the id of the Hyperdrive
      // config named "revenuedot". `cf dev` connects to REVENUEDOT_LOCAL_DATABASE_URL (a Railway dev database, see
      // docs/cloud.md). Never put a real connection string in this file.
      HYPERDRIVE: bindings.hyperdrive({
        id: process.env.REVENUEDOT_HYPERDRIVE_ID ?? "00000000000000000000000000000000",
        dev: { connectionString: process.env.REVENUEDOT_LOCAL_DATABASE_URL ?? "postgres://revenuedot:revenuedot@localhost:5432/revenuedot" },
      }),
      ASSETS: bindings.assets(),
      // Base64 Ed25519 seed for response signing (Trusted Entitlements). Set by scripts/deploy-cloud.sh from
      // ~/.config/revenuedot/signing-root.key; locally from apps/server/.dev.vars (gitignored).
      REVENUEDOT_SIGNING_KEY: bindings.secret(),
      // Cloudflare Email Sending: password resets, verification, invites and alerts (prd/account-email/PRD.md). The
      // sending domain mail.revenuedot.app is onboarded on the Circo account; the binding may only send as no-reply@.
      // `cf dev` simulates it (emails are logged) unless REVENUEDOT_EMAIL_REMOTE=1, which sends real email.
      EMAIL: bindings.sendEmail({ allowedSenderAddresses: ["no-reply@mail.revenuedot.app"], dev: { remote: process.env.REVENUEDOT_EMAIL_REMOTE === "1" } }),
    },
  },
});
