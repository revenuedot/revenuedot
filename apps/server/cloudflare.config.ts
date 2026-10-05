// RevenueDot Cloud on Cloudflare Workers, built and deployed with the `cf` CLI. Steps and inputs: docs/cloud.md.
// Deploy with `pnpm deploy:cloud` from the repo root; it creates or finds the Hyperdrive config and passes its id in.
import { bindings, defineConfig, exports, triggers } from "cf/config";

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
    // CPU time per invocation: the cron's work (the tick, then daily chart rollups within a 20-second budget) needs
    // headroom over the default 30 seconds.
    limits: { cpuMs: 60_000 },
    observability: { enabled: true },
    // RevenueDot AI: one Cloudflare Agents Durable Object per conversation (src/assistant-agent.worker.ts, SQLite storage).
    exports: { AssistantAgent: exports.durableObject({ storage: "sqlite" }) },
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
      // Workers AI for "Generate with AI" on paywalls (prd/paywalls/PRD.md §3) when the Worker has no AI_GATEWAY_API_KEY
      // secret (Vercel AI Gateway, put on the Worker by scripts/deploy-cloud.sh). No API key; billed to the Circo account.
      // `dev.remote`: Workers AI has no local simulation, so `cf dev` calls the real model (billed to the account).
      AI: bindings.ai({ dev: { remote: true } }),
      // RevenueDot AI conversations (prd/ai-assistant/PRD.md); the model is Workers AI through `AI` unless a provider key
      // (AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY) is set as a secret.
      AssistantAgent: bindings.durableObject({ worker: "revenuedot", exportName: "AssistantAgent" }),
      // Local `cf dev` only: REVENUEDOT_ASSISTANT_FAKE=1 in the shell answers with the scripted fake model (no model call).
      ...(process.env.REVENUEDOT_ASSISTANT_FAKE === "1" ? { REVENUEDOT_ASSISTANT_FAKE: bindings.text("1") } : {}),
      // Local `cf dev` only: REVENUEDOT_API_URL / REVENUEDOT_PUBLIC_URL in the shell (e.g. http://localhost:5615) make SDK
      // snippets, asset, pay and email links point at the local server instead of api. and app.revenuedot.app.
      ...(process.env.REVENUEDOT_API_URL ? { REVENUEDOT_API_URL: bindings.text(process.env.REVENUEDOT_API_URL) } : {}),
      ...(process.env.REVENUEDOT_PUBLIC_URL ? { REVENUEDOT_PUBLIC_URL: bindings.text(process.env.REVENUEDOT_PUBLIC_URL) } : {}),
      // Cloudflare Email Sending: password resets, verification, invites and alerts (prd/account-email/PRD.md). The
      // sending domain mail.revenuedot.app is onboarded on the Circo account; the binding may send as no-reply@ and, for the
      // onboarding and growth emails (prd/onboarding-emails/PRD.md), hello@.
      // `cf dev` simulates it (emails are logged) unless REVENUEDOT_EMAIL_REMOTE=1, which sends real email.
      // Full-export archives (prd/moves-export/PRD.md) in R2 once the bucket exists: REVENUEDOT_EXPORTS_BUCKET in the deploy
      // environment names it. Without it the Worker keeps archives in Postgres (archive_blobs). Setup: docs/cloud.md.
      ...(process.env.REVENUEDOT_EXPORTS_BUCKET ? { EXPORTS: bindings.r2({ name: process.env.REVENUEDOT_EXPORTS_BUCKET }) } : {}),
      EMAIL: bindings.sendEmail({ allowedSenderAddresses: ["no-reply@mail.revenuedot.app", "hello@mail.revenuedot.app"], dev: { remote: process.env.REVENUEDOT_EMAIL_REMOTE === "1" } }),
    },
  },
});
