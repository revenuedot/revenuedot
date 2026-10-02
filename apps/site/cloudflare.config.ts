// revenuedot.app marketing site on Cloudflare Workers, deployed with the `cf` CLI. Static assets answer every request
// except /api/* and pages, which the Worker script handles (worker/index.ts: the contact-sales form, the visitor's country, crawler notes).
// Deploy only after approval: pnpm --filter site run deploy. vite.config.ts hands the Astro build (dist/) to cf as the
// Worker's static assets. www.revenuedot.app redirects to the apex with a zone redirect rule (docs/cloud.md).
import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  // The Circo account. Every `cf` command run from this folder targets it unless CLOUDFLARE_ACCOUNT_ID says otherwise.
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "5a8f4d72ace5f438725e1dfd1b0380ff",
  worker: {
    name: "revenuedot-site",
    compatibilityDate: "2026-09-01",
    entrypoint: "worker/index.ts",
    // Every page goes through the Worker so crawler visits reach DataFast's Bot traffic card (worker/bots.ts); build assets and
    // media skip it and are served straight from the static assets.
    assets: { htmlHandling: "drop-trailing-slash", notFoundHandling: "404-page", runWorkerFirst: ["/*", "!/_astro/*", "!/brand/*", "!/clips/*", "!/videos/*", "!/og/*"] },
    domains: ["revenuedot.app", "www.revenuedot.app"],
    observability: { enabled: true },
    // Daily at 15:00 UTC (8am in California): the email listing people who started the contact-sales form and did not send it.
    triggers: [triggers.scheduled({ schedule: "0 15 * * *" })],
    env: {
      ASSETS: bindings.assets(),
      // Contact-sales leads (table sales_leads, created by the Worker on first use). D1 database "revenuedot-leads".
      LEADS: bindings.d1({ id: "5a27c04b-9869-419c-9ec8-c2ad0fb63dda", name: "revenuedot-leads" }),
      // Lead notifications. mail.revenuedot.app is onboarded for Email Sending on the Circo account (as for worker
      // `revenuedot`). `cf dev` logs the email instead of sending it unless REVENUEDOT_EMAIL_REMOTE=1.
      EMAIL: bindings.sendEmail({ allowedSenderAddresses: ["no-reply@mail.revenuedot.app"], dev: { remote: process.env.REVENUEDOT_EMAIL_REMOTE === "1" } }),
      // Where lead emails go. sales@circo.so delivers to Kai (tested 2026-10-01).
      SALES_TO: bindings.text(process.env.REVENUEDOT_SALES_TO ?? "sales@circo.so"),
      // 5 contact-sales posts a minute per IP address.
      LEAD_LIMIT: bindings.rateLimit({ namespace: "1101", simple: { limit: 5, period: 60 } }),
      // Partial answers from the stepped form: one save per step, so a higher limit (30 a minute per IP address).
      DRAFT_LIMIT: bindings.rateLimit({ namespace: "1102", simple: { limit: 30, period: 60 } }),
    },
  },
});
