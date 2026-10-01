// Solution landing pages: /solutions/<slug>. Facts come from docs/STATUS.md, the docs repo and src/lib/pricing.ts.
// Writing rules: apps/site/CONTENT.md. The paid Cloud plan is planned, so every price for it says so.
import type { Landing } from "./types";

const SIGNUP = "https://app.revenuedot.app/signup";

export const SOLUTIONS: Landing[] = [
  {
    slug: "indie-developers",
    section: "solutions",
    name: "Indie developers",
    card: "Keep the RevenueCat SDK, stop paying 1% of revenue past $2,500. Free on Cloud up to $10K a month.",
    label: "Solution",
    title: "Cut your RevenueCat bill: a free in-app purchase backend for indie developers",
    metaTitle: "Cut your RevenueCat bill as an indie developer",
    metaDescription:
      "Once you reach $2,500 a month, RevenueCat charges 1% of all tracked revenue. RevenueDot Cloud is free up to $10,000 a month, and self-hosting is free. Keep your SDK code.",
    answer:
      "Once an app reaches $2,500 a month, RevenueCat charges 1% of all monthly tracked revenue. RevenueDot Cloud is free up to $10,000 a month, so an app making $10,000 a month saves $100 every month, and self-hosting costs nothing but your server. You keep the RevenueCat SDK and change one proxy URL line. The paid Cloud plan, 0.5% above $10,000, is planned.",
    shot: {
      src: "screens/overview-light.png",
      alt: "The RevenueDot dashboard overview with monthly revenue, active subscriptions and a sandbox switch",
    },
    points: [
      { title: "Free to $10K a month", text: "RevenueDot Cloud costs $0 while your app tracks up to $10,000 a month." },
      { title: "Self-host for $0", text: "The server is AGPL-3.0, with no revenue share and no limits." },
      { title: "Same SDK, one line", text: "Keep your offerings, entitlements and purchase code. Set the SDK's proxy URL." },
      { title: "Your data stays yours", text: "Customers and purchases live in Postgres tables you can query, on Cloud or on your server." },
    ],
    blocks: [
      {
        h2: "What the bill looks like at each revenue level",
        label: "Price",
        paras: [
          "RevenueCat is free up to $2,500 of monthly tracked revenue and then charges 1% of the revenue above that, according to its [pricing page](https://www.revenuecat.com/pricing) (checked September 2026). Its paywall and funnel tools are priced separately. The RevenueDot Cloud paid plan is planned and not yet billing.",
        ],
        table: {
          head: ["Monthly tracked revenue", "RevenueCat", "RevenueDot Cloud", "RevenueDot self-hosted"],
          rows: [
            ["$5,000", "$25", "$0", "$0 plus your server"],
            ["$10,000", "$100", "$0", "$0 plus your server"],
            ["$25,000", "$250", "$75 (planned)", "$0 plus your server"],
            ["$50,000", "$500", "$200 (planned)", "$0 plus your server"],
            ["$100,000", "$1,000", "$450 (planned)", "$0 plus your server"],
          ],
          caption: "The planned Cloud Standard plan is 0.5% of tracked revenue above $10,000, capped at $999 a month.",
        },
      },
      {
        h2: "How to move an indie app from RevenueCat to RevenueDot",
        label: "Switch",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}). It takes an email address and a project name.`,
          },
          {
            name: "Import your RevenueCat project",
            text: "Run `npx revenuedot import --from-revenuecat` with a read-only RevenueCat secret key. It copies apps, public SDK keys, products, offerings, customers and current access.",
          },
          {
            name: "Run both side by side",
            text: "Point App Store and Google Play server notifications at RevenueDot, which forwards each one to RevenueCat, so both stay accurate.",
          },
          {
            name: "Ship the one-line change",
            text: "Set the SDK's proxy URL to `https://api.revenuedot.app` in your next release, with signature checks turned off. Your RevenueCat API keys keep working in builds already out.",
          },
          {
            name: "Turn RevenueCat off",
            text: "When most active users are on the new version, switch RevenueCat off. The full order is in [Migrate from RevenueCat](/migrate-from-revenuecat).",
          },
        ],
      },
      {
        h2: "What an indie app gets on the free plan",
        label: "Included",
        bullets: [
          "Offerings, entitlements and the RevenueCat-compatible REST API, plus webhooks with a delivery log.",
          "[Paywalls](/features/paywalls) with a template gallery and a visual editor, and [charts](/features/charts) for MRR, trial conversion and churn.",
          "Web checkout on your own Stripe account, with purchase links and funnels. See [web to app](/solutions/web-to-app).",
          "Win-back offers, refund control for Apple's refund requests and support integrations.",
          "A Test Store, so you can test with no store account. See [test in-app purchases without sandbox](/stores/test-store).",
        ],
      },
      {
        h2: "What you give up, said plainly",
        label: "Tradeoffs",
        bullets: [
          "**Age.** RevenueCat has years of production use at far larger scale. RevenueDot launched in 2026. Run it side by side with RevenueCat during the migration and compare both before you switch.",
          "**Fork packages** are not on any registry yet, so you use the stock SDK with a proxy URL for now.",
          "**Some RevenueCat features are not copied.** [What differs from RevenueCat](/docs/migrate/what-differs) lists them, and the [comparison](/compare/revenuedot-vs-revenuecat) shows both sides.",
          "You can run both in parallel for as long as you like, so the switch is reversible.",
        ],
      },
    ],
    howTo: "How to move an indie app from RevenueCat to RevenueDot",
    faq: [
      {
        q: "How much does RevenueCat cost for a small app?",
        a: "RevenueCat is free up to $2,500 of monthly tracked revenue, then 1% of all tracked revenue once you pass it, per its pricing page checked in October 2026. An app with $10,000 a month pays $100, and one with $50,000 pays $500. Paywall and funnel tools are priced separately.",
      },
      {
        q: "Is there a free alternative to RevenueCat?",
        a: "RevenueDot Cloud is free up to $10,000 of monthly tracked revenue, and self-hosted RevenueDot is free with no limits under AGPL-3.0. Both work with the RevenueCat SDK, so you change one proxy URL line.",
      },
      {
        q: "What will RevenueDot Cloud cost above $10,000 a month?",
        a: "The planned Standard plan is 0.5% of tracked revenue above $10,000, capped at $999 a month. It is planned, not live. Today the Cloud free plan covers up to $10,000 a month and self-hosting costs only your own server.",
      },
      {
        q: "Do I have to rewrite my app to leave RevenueCat?",
        a: "No. You keep the RevenueCat SDK, your offerings, entitlements and purchase code. You set the proxy URL before configure, turn off signature checks and call syncPurchases once so current subscribers keep access.",
      },
      {
        q: "Can I go back to RevenueCat if it does not work out?",
        a: "Yes, while you run both side by side. RevenueDot forwards store notifications to RevenueCat, and the proxy URL is one setting in your app. Old app versions keep talking to RevenueCat until users update.",
      },
    ],
    docs: [
      { href: "/docs/migrate", label: "Migrate from RevenueCat" },
      { href: "/docs/migrate/importer", label: "The importer" },
      { href: "/docs/migrate/dual-run", label: "Run both side by side" },
      { href: "/docs/migrate/what-differs", label: "What differs from RevenueCat" },
      { href: "/docs/getting-started/quickstart", label: "First purchase in 5 minutes" },
    ],
    related: ["/pricing", "/compare/revenuedot-vs-revenuecat", "/migrate-from-revenuecat", "/self-host", "/solutions/self-hosted-in-app-purchases", "/stores/test-store"],
  },

  {
    slug: "app-studios",
    section: "solutions",
    name: "App studios",
    card: "Run every client app on one server with one project each, team roles and no revenue share on self-host.",
    label: "Solution",
    title: "In-app purchase backend for app studios: many apps, one server, team roles",
    metaTitle: "In-app purchase backend for app studios and agencies",
    metaDescription:
      "Run many apps on one RevenueDot server. One project per product, Admin, Developer and Viewer roles per project, and no revenue share when you self-host.",
    answer:
      "An app studio can run every app on one RevenueDot server. Each product is a project with its own catalog, customers, webhooks and API keys, and each person has an Admin, Developer or Viewer role per project. Self-hosting takes no share of any app's revenue, and RevenueDot Cloud is free up to $10,000 a month.",
    points: [
      { title: "One project per product", text: "Each project owns its catalog, customers, webhooks and secret keys, so clients never see each other's data." },
      { title: "Roles per project", text: "Admin, Developer and Viewer. A person can hold a different role in each project." },
      { title: "One server", text: "A self-hosted server holds any number of projects, and its cost does not grow with client revenue." },
      { title: "Same SDK for all", text: "Every app keeps the RevenueCat SDK and sets one proxy URL." },
    ],
    blocks: [
      {
        h2: "How RevenueDot is organized for many apps",
        label: "Structure",
        paras: [
          "A **project** is one product you sell. It owns the catalog, the customers, the webhooks and the secret keys. An **app** is that product on one store, such as the iOS app or the Android app, and each app has its own public SDK key. New projects come from the dashboard's **New project** button.",
        ],
        table: {
          head: ["Level", "Holds", "Example"],
          rows: [
            ["Project", "Catalog, customers, webhooks, secret keys, team", "Client A's fitness app"],
            ["App", "One store connection and one public SDK key", "Client A on the App Store (`appl_`), on Google Play (`goog_`), on the web (`strp_`)"],
            ["Member", "One role in one project", "A designer with Viewer access to Client A only"],
          ],
        },
      },
      {
        h2: "Team roles you can give to staff and clients",
        label: "Access",
        table: {
          head: ["Role", "Can do", "Cannot do"],
          rows: [
            ["Admin", "Everything in the project, including secret API keys, invites and deleting the project", "Nothing is off limits"],
            ["Developer", "Edit apps, store credentials, the catalog, customers, webhooks and settings", "Create or revoke secret API keys, invite people, change roles, delete the project"],
            ["Viewer", "Read everything the dashboard shows", "Change anything"],
          ],
          caption: "A project always keeps one Admin. Invite links last 7 days, and a project can send 50 invites a day.",
        },
      },
      {
        h2: "What one server costs against one bill per app",
        label: "Cost",
        paras: [
          "Self-hosted RevenueDot is AGPL-3.0 and takes no share of revenue, so adding a client app adds database rows, not a bill that grows with that client's sales. You pay for your own server and Postgres. If you prefer not to run servers, RevenueDot Cloud is free up to $10,000 of monthly tracked revenue, and the planned paid plan is capped at $999 a month. See [pricing](/pricing).",
          "For comparison, RevenueCat charges 1% of all monthly tracked revenue once it reaches $2,500 ([pricing](https://www.revenuecat.com/pricing), checked October 2026).",
        ],
      },
      {
        h2: "How to onboard a new client app",
        label: "Steps",
        steps: [
          {
            name: "Create a project for the client",
            text: `In the dashboard click **New project**, on [Cloud](${SIGNUP}) or on your own server.`,
          },
          {
            name: "Invite the team",
            text: "Open Project settings, Collaborators, and invite your developers as Developer and the client as Viewer or Admin.",
          },
          {
            name: "Connect the client's stores",
            text: "Add the client's App Store In-App Purchase key and Google Play service account to the project's apps. Each project holds its own credentials.",
          },
          {
            name: "Create the catalog and a secret key",
            text: "Add products, entitlements and offerings, then create a secret key for the client's backend and set up webhooks.",
          },
          {
            name: "Set the proxy URL in the client app",
            text: "Ship the app with the RevenueCat SDK and the proxy URL for your server. For a client already on RevenueCat, import their project first.",
          },
        ],
      },
      {
        h2: "Limits to plan for",
        label: "Honest notes",
        bullets: [
          "**One container per database.** The background job has no lock across processes, so run one RevenueDot container per Postgres for now.",
          "**Backups are yours** on a self-hosted server. Use the managed database's point-in-time recovery and daily dumps. See [Backups](/docs/guides/backups).",
          "**Roles are three** today: Admin, Developer and Viewer.",
          "**Store credentials** for Apple and Google are stored in the project's database. Encrypt backups and limit who can read them.",
        ],
      },
    ],
    howTo: "How to onboard a new client app",
    faq: [
      {
        q: "Can I run multiple apps on one RevenueDot server?",
        a: "Yes. Create one project per product, and add an app per store inside it. Each project has its own catalog, customers, webhooks and API keys. A self-hosted server holds any number of projects.",
      },
      {
        q: "How do I give a client read-only access to their revenue?",
        a: "Invite them to their project with the Viewer role. A Viewer can read everything the dashboard shows and change nothing. A person can have a different role in each project.",
      },
      {
        q: "Does self-hosted RevenueDot charge a share of each client's revenue?",
        a: "No. Self-hosting is free under AGPL-3.0, with no limits and no revenue share. You pay for your own server and Postgres.",
      },
      {
        q: "Are one client's customers visible to another client's team?",
        a: "No. A project owns its customers, and a member sees only the projects they belong to. Secret API keys belong to one project.",
      },
      {
        q: "How do I move a client from RevenueCat?",
        a: "Create their project, run the importer with their read-only RevenueCat secret key, forward store notifications to RevenueCat during a side-by-side run, then ship the proxy URL change in their next release.",
      },
    ],
    docs: [
      { href: "/docs/guides/team", label: "Invite your team" },
      { href: "/docs/concepts/projects-and-apps", label: "Projects, apps and API keys" },
      { href: "/docs/guides/self-hosting", label: "Self-hosting" },
      { href: "/docs/guides/going-to-production", label: "Going to production" },
      { href: "/docs/migrate/importer", label: "The importer" },
    ],
    related: ["/self-host", "/solutions/self-hosted-in-app-purchases", "/solutions/indie-developers", "/pricing", "/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat"],
  },

  {
    slug: "self-hosted-in-app-purchases",
    section: "solutions",
    name: "Self-hosted in-app purchases",
    card: "One Docker image and Postgres run your own in-app purchase server for the RevenueCat SDK.",
    label: "Solution",
    title: "Self-hosted in-app purchase server with Docker and Postgres",
    metaTitle: "Self-hosted in-app purchase server (Docker, Postgres)",
    metaDescription:
      "Run a self-hosted in-app purchase server for the RevenueCat SDK. One Docker image plus Postgres 16, AGPL-3.0, no revenue share and no telemetry.",
    answer:
      "A self-hosted in-app purchase server is one Docker image next to Postgres 16. Clone RevenueDot, copy .env.example to .env, run docker compose up -d, and the SDK API, REST API, store notifications and dashboard answer on port 8787. It is AGPL-3.0, takes no revenue share and works with the RevenueCat SDK.",
    shot: {
      src: "dashboard-light.png",
      alt: "The RevenueDot dashboard served by a self-hosted server, showing customers, revenue and setup health",
    },
    points: [
      { title: "One image, one database", text: "A single container plus Postgres 16 with a persistent volume." },
      { title: "Migrations on start", text: "Upgrades are a rebuild and a restart. The server applies database migrations itself." },
      { title: "No revenue share", text: "AGPL-3.0, free for any company to run for its own apps at any scale." },
      { title: "Your data, your region", text: "Every purchase and customer lives in your Postgres. The server never calls RevenueDot." },
    ],
    blocks: [
      {
        h2: "How to self-host an in-app purchase server with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Clone the repository and copy the config",
            text: "Clone `revenuedot/revenuedot`, copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`. Do it before the first start: the password is written into the volume then.",
          },
          {
            name: "Start the stack",
            text: "Run `docker compose up -d`. It builds the image and starts RevenueDot and Postgres. There is no published image yet.",
          },
          {
            name: "Check health and sign up",
            text: "Call `/v1/health`, then open `http://localhost:8787/login` and sign up. The first account is the owner, and sign-up closes after it.",
          },
          {
            name: "Put HTTPS in front",
            text: "Serve the server behind a reverse proxy or load balancer with TLS. The SDKs and the stores need an HTTPS URL.",
          },
          {
            name: "Connect the stores and your app",
            text: "Add your App Store key and Google Play service account, set the notification URLs the dashboard shows, then set your app's SDK proxy URL to your server.",
          },
        ],
      },
      {
        h2: "The three commands",
        label: "Terminal",
        code: {
          title: "Start RevenueDot with Docker Compose",
          label: "terminal",
          code: `git clone https://github.com/revenuedot/revenuedot.git
cd revenuedot
cp .env.example .env          # set POSTGRES_PASSWORD before the first start
docker compose up -d          # builds the image and starts RevenueDot and Postgres
curl http://localhost:8787/v1/health        # {"status":"ok"}`,
        },
      },
      {
        h2: "What runs inside the container",
        label: "Architecture",
        table: {
          head: ["Piece", "What it does"],
          rows: [
            ["`revenuedot` container", "One process: the SDK API (`/v1`), REST API (`/v2`), dashboard sign-in, OAuth for AI clients, store notifications and the dashboard web app. A background job records expirations, runs the daily Google Play voided-purchase check, sends webhooks and alert emails"],
            ["`db` container (Postgres 16)", "Every customer, purchase, event and setting, in the `revenuedot-data` volume"],
          ],
          caption: "Run one revenuedot container per database for now: the background job has no lock across processes.",
        },
      },
      {
        h2: "A production checklist for your own server",
        label: "Before production",
        bullets: [
          "A managed Postgres with point-in-time recovery, daily dumps copied off the server, and one test restore.",
          "SMTP settings so password resets, invites and alert emails arrive. Without them, emails print to the server log.",
          "`REVENUEDOT_SIGNING_KEY` set, if you ship SDK builds that verify responses.",
          "Store credentials checked in the dashboard, and notification status showing **Ready** for each app.",
          "Uptime monitoring on `GET /v1/health`.",
        ],
        paras: ["The full list is in [Going to production](/docs/guides/going-to-production). The existing [self-host page](/self-host) covers the same stack with a Cloud comparison."],
      },
      {
        h2: "Self-host or Cloud",
        label: "Choice",
        paras: [
          `Self-host and RevenueDot Cloud run the same code, API and schema, so a project can move either way. Cloud is free up to $10,000 of monthly tracked revenue and needs no servers: [start free on Cloud](${SIGNUP}). Self-hosting is free forever and costs your own infrastructure. Self-hosted servers send no telemetry, and talk only to Apple, Google, Stripe or Amazon if you connect them, your webhook endpoints and any forwarding URL you set.`,
        ],
        bullets: [
          "**Signatures:** a self-hosted server signs with its own key, so keep the stock SDK's verification disabled, or build the SDK forks with your own public key.",
          "**Status:** the Docker image builds on `node:24-slim`, and CI starts it against Postgres 16 on every pull request.",
        ],
      },
    ],
    howTo: "How to self-host an in-app purchase server with RevenueDot",
    faq: [
      {
        q: "Can I self-host an in-app purchase server?",
        a: "Yes. RevenueDot is an open-source server you run with Docker Compose next to Postgres 16. It implements the API the RevenueCat SDKs call, so your app keeps its SDK and sets one proxy URL to your server.",
      },
      {
        q: "What do I need to run RevenueDot on my own server?",
        a: "A machine with Docker and Compose v2, plus Postgres 16, which Compose starts for you. For production use a managed Postgres with backups and put the server behind HTTPS.",
      },
      {
        q: "Is self-hosted RevenueDot free for commercial apps?",
        a: "Yes. The server and dashboard are AGPL-3.0. Any company can run them for its own apps at any scale without paying. The AGPL asks you to share changes if you modify the server and offer it to others over a network.",
      },
      {
        q: "How do I upgrade a self-hosted RevenueDot?",
        a: "Pull the new code, rebuild the image and restart. Database migrations run automatically when the server starts. Back up Postgres first.",
      },
      {
        q: "Does the self-hosted server send my data to RevenueDot?",
        a: "No. It has no telemetry and never calls RevenueDot's servers. It talks to the stores you connect, your webhook endpoints and any forwarding URL you set.",
      },
    ],
    docs: [
      { href: "/docs/guides/self-hosting", label: "Self-hosting guide" },
      { href: "/docs/guides/going-to-production", label: "Going to production" },
      { href: "/docs/guides/backups", label: "Back up and restore" },
      { href: "/docs/guides/upgrades", label: "Upgrades" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
    ],
    related: ["/self-host", "/solutions/eu-data-residency", "/solutions/app-studios", "/pricing", "/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat"],
  },

  {
    slug: "eu-data-residency",
    section: "solutions",
    name: "EU data residency",
    card: "Keep purchase data in your own EU region by running RevenueDot on your Postgres. No certifications claimed.",
    label: "Solution",
    title: "EU data residency for in-app purchase data: run RevenueDot in your own EU region",
    metaTitle: "EU data residency for in-app purchase data",
    metaDescription:
      "Keep customer and purchase data in your chosen EU region by self-hosting RevenueDot on your own Postgres. Plain notes on GDPR and what we do not claim.",
    answer:
      "To keep in-app purchase data in the EU, self-host RevenueDot in a region you choose, such as Frankfurt or Dublin. Every customer, purchase and receipt then lives in your own Postgres database, and the server never calls RevenueDot. RevenueDot Cloud does not pin data to an EU region today. This page is not legal advice.",
    points: [
      { title: "Your region", text: "Run the server and Postgres in any cloud region you pick, in or outside the EU." },
      { title: "No data to us", text: "A self-hosted server has no telemetry and never calls RevenueDot's servers." },
      { title: "Data you can delete", text: "The REST API has a delete-customer call, and your database is yours to query and purge." },
      { title: "No certification claims", text: "RevenueDot claims no SOC 2, ISO 27001 or similar certification." },
    ],
    blocks: [
      {
        h2: "What data RevenueDot holds",
        label: "Scope",
        paras: [
          "For the apps that use it, RevenueDot processes app user IDs and aliases, store transaction IDs, product, price, currency, country, purchase and renewal dates, entitlement state, device platform, app version and any customer attributes you set, such as an email address. Do not send health or similar data as customer attributes. The [data processing summary](/legal/dpa) lists the same categories.",
        ],
      },
      {
        h2: "How to keep in-app purchase data in the EU with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Pick an EU region",
            text: "Choose the cloud provider and region you want, for example a Frankfurt or Dublin region of your provider.",
          },
          {
            name: "Create Postgres 16 in that region",
            text: "Use a managed Postgres with point-in-time recovery in the same region, or the bundled Postgres container on a server there.",
          },
          {
            name: "Run RevenueDot there",
            text: "Clone the repository, set `DATABASE_URL` and a strong password in `.env`, and run `docker compose up -d`. See [self-hosted in-app purchases](/solutions/self-hosted-in-app-purchases).",
          },
          {
            name: "Put HTTPS and backups in the same region",
            text: "Terminate TLS in front of the server and keep database dumps in storage in the same region, encrypted.",
          },
          {
            name: "Connect your stores and point the SDK at your server",
            text: "Add your Apple and Google credentials, set the notification URLs, then set the SDK's proxy URL to your own HTTPS address.",
          },
        ],
      },
      {
        h2: "Where data still leaves your server",
        label: "Honest notes",
        bullets: [
          "**The stores.** The server calls Apple, Google, Amazon or Stripe for the apps you connect. They process purchase data under their own terms.",
          "**Integrations you turn on.** Segment, Amplitude, Mixpanel, Meta, Slack and the other integrations send events to those vendors. Webhooks send events to your own endpoints. Turn on only what fits your policy.",
          "**Emails.** Password resets, invites and alerts leave through the SMTP provider you configure.",
          "**Your app.** The stock Android SDK still sends diagnostics, paywall events and ad events to RevenueCat's hosts. The planned fork sends them to your server. See [the Android SDK page](/sdks/android).",
        ],
      },
      {
        h2: "RevenueDot Cloud and data location",
        label: "Cloud",
        paras: [
          "RevenueDot Cloud runs on Cloudflare's network, and Cloudflare is its only listed subprocessor, with locations described as a global network and the United States. Cloud does not offer an EU-only region today. For transfers from the EEA, UK or Switzerland to countries without an adequacy decision, the EU Standard Contractual Clauses apply, according to the [data processing summary](/legal/dpa), which is a summary and not the signed agreement. If you need data to stay in the EU, self-host.",
        ],
      },
      {
        h2: "What this does and does not give you",
        label: "Limits",
        bullets: [
          "Hosting in the EU helps with where data sits. It does not make an app GDPR compliant. Lawful basis, notices, retention and requests from users are still your job, and your lawyer's call.",
          "RevenueDot holds no compliance certification. It publishes its [security policy](/security) and its code, which you can read.",
          "You are the controller. A self-hosted deployment involves no processing by RevenueDot.",
        ],
      },
    ],
    howTo: "How to keep in-app purchase data in the EU with RevenueDot",
    faq: [
      {
        q: "Can I keep in-app purchase data in the EU?",
        a: "Yes, by self-hosting RevenueDot on a server and Postgres database in an EU region. Customer, purchase and receipt data then stays in your database. The stores, integrations and email provider you connect are separate processors.",
      },
      {
        q: "Does RevenueDot Cloud have an EU region?",
        a: "Not today. RevenueDot Cloud runs on Cloudflare's network, with the United States listed as a location. If you need purchase data kept in the EU, self-host RevenueDot in your own EU region.",
      },
      {
        q: "Is self-hosted RevenueDot GDPR compliant?",
        a: "Hosting in the EU helps with data location, but compliance covers more, such as a lawful basis, privacy notices and responding to user requests. RevenueDot claims no certification. Ask your lawyer about your own obligations.",
      },
      {
        q: "How do I delete a customer's data from RevenueDot?",
        a: "The REST API v2 has a Delete a customer call, and on a self-hosted server the database is yours, so you can also remove rows directly. Deleted customers stay in older backups until those backups expire.",
      },
      {
        q: "Does a self-hosted RevenueDot server send data to RevenueDot?",
        a: "No. It has no telemetry and never calls RevenueDot's servers. It talks to the stores you connect, your webhook endpoints, the integrations you enable and your SMTP server.",
      },
    ],
    docs: [
      { href: "/docs/guides/self-hosting", label: "Self-hosting guide" },
      { href: "/docs/guides/backups", label: "Back up and restore" },
      { href: "/docs/guides/going-to-production", label: "Going to production" },
      { href: "/docs/api/rest-v2", label: "REST API v2" },
    ],
    related: ["/self-host", "/solutions/self-hosted-in-app-purchases", "/solutions/app-studios", "/pricing", "/compare/revenuedot-vs-revenuecat"],
  },

  {
    slug: "web-to-app",
    section: "solutions",
    name: "Web to app",
    card: "Sell on the web with Stripe Checkout, funnels and redemption links that open your app, on your Stripe account.",
    label: "Solution",
    title: "Web-to-app subscription funnels with Stripe Checkout and redemption links",
    metaTitle: "Web-to-app subscription funnels with Stripe",
    metaDescription:
      "Sell app subscriptions on the web with Stripe Checkout. Build funnels, share purchase links and let buyers open your app with a redemption link.",
    answer:
      "To sell app subscriptions on the web, connect your own Stripe account to RevenueDot, create web products, and share a purchase link or publish a funnel. Buyers pay on Stripe Checkout, and a redemption link opens your app and gives the purchase to their user. RevenueDot hosts the pages and records the purchase like any other store.",
    shot: {
      src: "web/funnels.png",
      alt: "The Funnels page in the RevenueDot dashboard listing published web funnels with their public URLs",
    },
    points: [
      { title: "Your Stripe account", text: "Payments run on your own Stripe account, and the money goes to you." },
      { title: "Funnels with analytics", text: "Quiz, info, email, paywall and success steps, with drop-off by step." },
      { title: "Redemption links", text: "A deep link moves the purchase to the app's user, even if the buyer paid before installing." },
      { title: "One entitlement", text: "Web, iOS and Android purchases land on the same customer." },
    ],
    blocks: [
      {
        h2: "How to sell app subscriptions on the web with RevenueDot and Stripe",
        label: "Steps",
        steps: [
          {
            name: "Connect Stripe",
            text: `[Start free on Cloud](${SIGNUP}), add a Stripe web provider and save a restricted key with Write access to Products, Prices, Checkout Sessions, Coupons and Promotion Codes, and Read on Subscriptions, Invoices, Charges and Customers.`,
          },
          {
            name: "Add a web config",
            text: "Set your app name, logo, colors, terms and privacy links, support email, success behavior and your app's URL scheme, such as `scanner`.",
          },
          {
            name: "Create web products",
            text: "Click **Create web product**. RevenueDot creates a Stripe Product and Price in your account and a RevenueDot product keyed by the Stripe price ID. Or point at a price you already have.",
          },
          {
            name: "Put them in an offering",
            text: "A package can hold your App Store product, your Google Play product and your web product, so one package sells everywhere.",
          },
          {
            name: "Share a purchase link or publish a funnel",
            text: "A link looks like `https://api.revenuedot.app/pay/scanner/spring-sale`. A funnel adds questions, an email step and the paywall before checkout.",
          },
          {
            name: "Redeem in the app",
            text: "Register your URL scheme and pass the redemption link to `redeemWebPurchase`. The entitlement is active at once.",
          },
        ],
      },
      {
        h2: "What a buyer goes through",
        label: "Flow",
        table: {
          head: ["Step", "What happens"],
          rows: [
            ["1", "The buyer opens a purchase link or funnel and picks a plan"],
            ["2", "RevenueDot creates a Stripe Checkout Session with your key and sends them to Stripe's payment page"],
            ["3", "Stripe sends them to the success page. RevenueDot reads the session from Stripe and records the purchase"],
            ["4", "The success page shows **Open the app** and the store buttons, and the buyer gets the link by email"],
            ["5", "The app opens the redemption link, calls `redeemWebPurchase`, and the purchase moves to the app's user"],
          ],
          caption: "When the page already knows the app user ID (`?app_user_id=`), step 5 is not needed. The purchase goes straight to that user.",
        },
      },
      {
        h2: "Funnel steps and analytics",
        label: "Funnels",
        bullets: [
          "**Step types:** question, info, email, paywall and success. The email goes to Stripe Checkout and becomes the customer's email attribute.",
          "**Paywall step:** sells an offering's web products, with a highlighted package, optional features list and discount.",
          "**Discounts:** web discounts and promotion codes run through Stripe coupons.",
          "**Analytics:** see where visitors drop off, by step. Funnel events can go to webhooks, analytics tools and ad networks such as Meta.",
          "**Custom domains:** serve the pages from your own domain.",
        ],
      },
      {
        h2: "Why web checkout matters after the 2025 US App Store ruling",
        label: "Context",
        paras: [
          "On April 30, 2025 a US federal judge found that Apple willfully violated a 2021 order, and required Apple to let apps on the US storefront link to outside payment with no commission on those links ([The Next Web, May 2026](https://thenextweb.com/news/supreme-court-apple-epic-contempt-stay-denial)). Apple appealed. According to [Perkins Coie's summary](https://perkinscoie.com/insights/update/epic-v-apple-ninth-circuit-weighs), the Ninth Circuit upheld the contempt finding in December 2025 but said Apple may charge a commission limited to costs it genuinely needs for the hand-off. As of May 2026 the district court was still to decide what commission, if any, Apple can charge.",
          "The rules apply to the US storefront and may have changed since those reports. Read Apple's current terms and ask your lawyer before you add a link to your app. RevenueDot hosts the web checkout and does not decide what links Apple allows.",
        ],
      },
      {
        h2: "Limits and status",
        label: "Honest notes",
        bullets: [
          "The hosted checkout is a Stripe-hosted page. An embedded checkout (Stripe Elements) is not built.",
          "Connect with Stripe (OAuth) is not built yet. You paste a restricted key.",
          "Run a purchase in Stripe test mode before you go live.",
          "RevenueCat Web Billing (`rcb_`) and Paddle purchases are not accepted. See [the web SDK page](/sdks/web).",
        ],
      },
    ],
    howTo: "How to sell app subscriptions on the web with RevenueDot and Stripe",
    faq: [
      {
        q: "How do I let users buy my app's subscription on the web?",
        a: "Connect your Stripe account to RevenueDot, create web products, put them in an offering and share a purchase link or publish a funnel. Buyers pay on Stripe Checkout. A redemption link opens your app and gives the purchase to their user.",
      },
      {
        q: "How does a web purchase reach the app?",
        a: "If the page knows the app user ID, the purchase goes straight to that user. Otherwise the buyer gets a redemption link, which opens the app and calls redeemWebPurchase. The link works for 24 hours by default and is also emailed.",
      },
      {
        q: "Can I link from my iOS app to web checkout?",
        a: "In the US storefront a 2025 court order lets apps link to outside payment without Apple's commission on those links, but the case is still on appeal and the commission terms may change. Check Apple's current rules and ask a lawyer first.",
      },
      {
        q: "Does RevenueDot take a cut of web payments?",
        a: "Payments run on your own Stripe account. RevenueDot Cloud is free up to $10,000 of monthly tracked revenue, and the planned paid plan is 0.5% above that, capped at $999 a month. Stripe charges its own fees.",
      },
      {
        q: "Can I see where visitors drop off in a funnel?",
        a: "Yes. The funnel's Analytics tab shows visitors per step and where they leave. Funnel events can also go to webhooks, analytics tools and ad networks.",
      },
    ],
    docs: [
      { href: "/docs/guides/web-billing", label: "Sell on the web with Stripe" },
      { href: "/docs/guides/funnels", label: "Build a web-to-app funnel" },
      { href: "/docs/guides/purchase-links", label: "Purchase links" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/guides/web-discounts", label: "Web discounts" },
    ],
    related: ["/stores/stripe", "/stores/stripe", "/sdks/ios", "/sdks/web", "/features/paywalls", "/pricing"],
  },

  {
    slug: "receipt-validation",
    section: "solutions",
    name: "Receipt validation",
    card: "Server-side receipt validation for App Store and Google Play that never trusts the device.",
    label: "Solution",
    title: "Server-side receipt validation for App Store and Google Play subscriptions",
    metaTitle: "Server-side receipt validation: App Store, Google Play",
    metaDescription:
      "Validate in-app purchase receipts on your server. RevenueDot verifies StoreKit 2 and Google Play purchases with Apple and Google, and retries safely on errors.",
    answer:
      "Server-side receipt validation means your server asks Apple or Google whether a purchase is real instead of trusting the phone. RevenueDot does this for the RevenueCat SDK: it verifies StoreKit 2 transactions against Apple's root certificate and the App Store Server API, reads Google Play purchase tokens from the Play Developer API, and answers 5xx for its own failures so no purchase is lost.",
    points: [
      { title: "Apple and Google asked", text: "Entitlements come from what the stores say, not from what the device posts." },
      { title: "Retry-safe", text: "A 5xx tells the SDK to keep the purchase and try again. A 4xx means it can never succeed." },
      { title: "Notifications confirm it", text: "App Store Server Notifications v2 and Google real-time notifications update state without the app." },
      { title: "Check from your backend", text: "Read active entitlements with a secret key, or receive webhooks." },
    ],
    blocks: [
      {
        h2: "How RevenueDot validates a receipt on each store",
        label: "How it works",
        table: {
          head: ["", "App Store", "Google Play"],
          rows: [
            ["What the SDK posts", "A StoreKit 2 signed transaction (or a StoreKit 1 receipt)", "A purchase token"],
            ["How it is checked", "JWS verified against Apple's root certificate, then the App Store Server API with your In-App Purchase key", "The Play Developer API with your service account"],
            ["Without credentials", "StoreKit 2 verified, but no history. StoreKit 1 refused with a retryable 500", "Answers 503 (code 7101), and the SDK retries after you add the service account"],
            ["Later changes", "App Store Server Notifications v2", "Real-time developer notifications over Pub/Sub, plus a daily voided-purchase scan"],
            ["Refunds", "Recorded from Apple's REFUND notification", "Recorded from voided-purchase notifications and the daily scan"],
          ],
          caption: "RevenueDot does not call Apple's deprecated verifyReceipt endpoint.",
        },
      },
      {
        h2: "How to validate App Store and Google Play receipts on your server with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free project and your store apps",
            text: `[Start free on Cloud](${SIGNUP}) and add an App Store app and a Google Play app.`,
          },
          {
            name: "Add the store credentials",
            text: "Add the In-App Purchase key and the Play service account, and check both in the dashboard. See [App Store](/stores/app-store) and [Google Play](/stores/google-play).",
          },
          {
            name: "Set up store notifications",
            text: "Paste the notification URLs into App Store Connect (Version 2) and a Pub/Sub push subscription. Watch each app's status turn **Ready**.",
          },
          {
            name: "Point the SDK at RevenueDot",
            text: "Set the proxy URL before `configure`. The SDK then posts receipts to `POST /v1/receipts`.",
          },
          {
            name: "Check access from your backend",
            text: "Read a customer's active entitlements with a secret key, or verify the HMAC on webhooks and deduplicate on the event ID.",
          },
        ],
      },
      {
        h2: "Check a customer's entitlements from your backend",
        label: "Backend",
        code: {
          title: "Active entitlements for one customer",
          label: "terminal",
          code: `curl -s -H "Authorization: Bearer $SECRET_KEY" \\
  "https://api.revenuedot.app/v2/projects/$PROJECT_ID/customers/user_1/active_entitlements"`,
        },
        paras: ["Keep the secret key (`sk_`) on your server. Never ship it in an app."],
      },
      {
        h2: "Why 4xx and 5xx matter for receipts",
        label: "Error rules",
        bullets: [
          "A **4xx** means the purchase can never be accepted. The SDK finishes the transaction for good, or on Android stops retrying.",
          "A **5xx** means a temporary problem, so the SDK keeps the transaction open and posts it again later.",
          "RevenueDot never answers 4xx for its own failures, so a server bug cannot make a paying customer lose a purchase.",
          "See [receipt errors: 4xx vs 5xx](/docs/help/receipt-errors-4xx-vs-5xx) for every code.",
        ],
      },
      {
        h2: "What has and has not been tested",
        label: "Honest notes",
        bullets: [
          "The unmodified RevenueCat iOS SDK 5.92 and Android SDK 10.24 pass Test Store purchases against RevenueDot on a simulator and an emulator in its test suite.",
          "Run an App Store and a Google Play sandbox purchase before you ship, as you would with any backend.",
          "For development only, an `allow_unsigned_receipts` setting accepts StoreKit 1 receipts without checking them. Anyone could forge one, so never turn it on in production.",
        ],
      },
    ],
    howTo: "How to validate App Store and Google Play receipts on your server with RevenueDot",
    faq: [
      {
        q: "How do I validate in-app purchase receipts on my server?",
        a: "Send the purchase to a server that asks the store. For Apple that means verifying the signed transaction and calling the App Store Server API. For Google it means reading the purchase token with the Play Developer API. RevenueDot does both for the RevenueCat SDK.",
      },
      {
        q: "Is Apple's verifyReceipt endpoint still the way to validate?",
        a: "Apple deprecated verifyReceipt. RevenueDot does not call it. It verifies StoreKit 2 signed transactions locally and uses the App Store Server API with your In-App Purchase key.",
      },
      {
        q: "What happens if validation fails because of a server error?",
        a: "RevenueDot answers 5xx for its own and temporary store failures, so the SDK keeps the purchase and retries. It answers 4xx only when a purchase can never be valid, so a paying customer does not lose access to a server bug.",
      },
      {
        q: "How do I verify a Google Play purchase token?",
        a: "Call the Google Play Developer API with a service account that has View financial data and Manage orders and subscriptions, then acknowledge the purchase within 3 days. RevenueDot does this and re-reads each purchase on every notification.",
      },
      {
        q: "Can my own backend check who has access?",
        a: "Yes. Read a customer's active entitlements with the REST API and a secret key, or receive webhooks and verify their HMAC signature. Deduplicate on the event ID.",
      },
    ],
    docs: [
      { href: "/docs/guides/app-store", label: "Connect the App Store" },
      { href: "/docs/guides/google-play", label: "Connect Google Play" },
      { href: "/docs/help/receipt-errors-4xx-vs-5xx", label: "Receipt errors: 4xx vs 5xx" },
      { href: "/docs/guides/webhooks", label: "Webhooks" },
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements" },
    ],
    related: ["/stores/app-store", "/stores/google-play", "/stores/amazon-appstore", "/sdks/ios", "/sdks/android", "/migrate-from-revenuecat"],
  },

  {
    slug: "ai-built-apps",
    section: "solutions",
    name: "AI-built apps",
    card: "Let Claude Code, Cursor or another agent add subscriptions with the RevenueDot MCP server and skills.",
    label: "Solution",
    title: "Add subscriptions to an AI-built app with Claude Code, Cursor and other agents",
    metaTitle: "Add subscriptions to an AI-built app with an agent",
    metaDescription:
      "Let Claude Code, Cursor or another AI agent add subscriptions to your app. Connect the RevenueDot MCP server, install agent skills and use llms.txt.",
    answer:
      "To add subscriptions to an app built with an AI agent, connect the agent to RevenueDot's hosted MCP server at https://mcp.revenuedot.app/mcp, install the add-subscriptions skill, and let it set up products, entitlements and the SDK's proxy URL. The agent signs in with OAuth, and you choose what it may do.",
    points: [
      { title: "Hosted MCP server", text: "One connector for Claude, ChatGPT in developer mode, Cursor and other MCP clients." },
      { title: "Agent skills", text: "add-subscriptions, migrate-from-revenuecat, support-playbook, weekly-revenue-check and self-host." },
      { title: "llms.txt and Markdown docs", text: "Agents read the docs as plain text at revenuedot.app/llms.txt and in the docs' Markdown copies." },
      { title: "You set the limits", text: "Read only, read and change, or money actions, per project." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to an AI-built app with RevenueDot",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}). Add your store apps, or a Test Store app to start without store accounts.`,
          },
          {
            name: "Connect your agent to the MCP server",
            text: "In Claude Code run the command below, then `/mcp` to sign in. In Cursor and other clients, add a streamable HTTP MCP server with the same URL.",
          },
          {
            name: "Install the skills",
            text: "Run `npx skills add revenuedot/agent-skills` to add the workflows to any agent, or install the plugin in Claude Code or Codex.",
          },
          {
            name: "Ask for plans and a paywall",
            text: "For example: set up monthly and annual Pro plans for my iOS and Android apps behind a `pro` entitlement, and add a paywall to my app.",
          },
          {
            name: "Check the SDK change",
            text: "The agent adds the RevenueCat SDK and sets the proxy URL to `https://api.revenuedot.app`. Review the diff, then test with a Test Store key in a debug build.",
          },
        ],
      },
      {
        h2: "Connect Claude Code to RevenueDot",
        label: "Terminal",
        code: {
          title: "Add the hosted MCP server",
          label: "terminal",
          code: `claude mcp add --transport http revenuedot https://mcp.revenuedot.app/mcp
/plugin marketplace add revenuedot/agent-skills
/plugin install revenuedot@revenuedot`,
        },
        paras: [
          "The assistant opens a RevenueDot page where you sign in, pick **one project** and choose what it may do. The same server backs the RevenueDot plugin for Codex and the connector for Claude. The ChatGPT directory listing is not live yet, so add it as a developer-mode connector.",
        ],
      },
      {
        h2: "What the agent can and cannot do",
        label: "Permissions",
        table: {
          head: ["Choice", "The assistant can"],
          rows: [
            ["Read only", "Read the catalog, customers, events, transactions, webhooks and metrics"],
            ["Read and change", "Also create products, entitlements and offerings, grant and revoke access, set customer attributes and manage webhooks"],
            ["Money actions", "Also extend, cancel and refund subscriptions and make Test Store purchases. A separate checkbox"],
          ],
          caption: "The connection is a secret API key limited to one project and the access you chose. Delete it under API keys to disconnect.",
        },
      },
      {
        h2: "What agents read: skills and llms.txt",
        label: "Context",
        bullets: [
          "**Skills:** [add-subscriptions](https://github.com/revenuedot/agent-skills) covers iOS, Android, React Native and Flutter. Others cover migrating from RevenueCat, answering a support ticket, a weekly revenue check and self-hosting.",
          "**llms.txt:** [revenuedot.app/llms.txt](/llms.txt) and [llms-full.txt](/llms-full.txt) give the whole docs in agent-friendly text.",
          "**Markdown docs:** every docs page has a plain `.md` copy.",
          "**REST API:** an OpenAPI 3.1 reference, so an agent can call the API directly with a secret key.",
        ],
      },
      {
        h2: "Safety rules that keep the agent in bounds",
        label: "Safety",
        bullets: [
          "No tool accepts a store key, a password or an API key from chat. Add those in the dashboard.",
          "The assistant asks before it cancels, refunds or deletes. Check the customer and product it names.",
          "Apple does not allow a server to refund or cancel. Cancel and refund work for Google Play subscriptions only.",
          "Use a read-only key if you only want the agent to look.",
        ],
      },
    ],
    howTo: "How to add subscriptions to an AI-built app with RevenueDot",
    faq: [
      {
        q: "Can Claude Code add subscriptions to my app?",
        a: "Yes. Connect Claude Code to the RevenueDot MCP server with claude mcp add --transport http revenuedot https://mcp.revenuedot.app/mcp, sign in, and ask it to set up plans. The add-subscriptions skill guides the SDK code for iOS, Android, React Native and Flutter.",
      },
      {
        q: "How do I connect Cursor or ChatGPT to RevenueDot?",
        a: "Add an MCP server of type streamable HTTP with https://mcp.revenuedot.app/mcp and choose OAuth. In ChatGPT turn on developer mode and add it as a connector. The ChatGPT directory listing is not live yet.",
      },
      {
        q: "Is it safe to let an AI agent manage my subscriptions?",
        a: "You choose the limit per project: read only, read and change, or money actions as a separate checkbox. The agent never needs store keys, and it asks before it cancels, refunds or deletes. Disconnect by deleting its API key.",
      },
      {
        q: "What is llms.txt on revenuedot.app?",
        a: "It is a plain-text index of the docs for AI agents, with a full version at llms-full.txt. Every docs page also has a Markdown copy, so an agent can read the exact steps.",
      },
      {
        q: "Does an AI-built app need a backend for in-app purchases?",
        a: "Yes, something has to verify store receipts and track entitlements. RevenueDot is that server, so the agent only adds the RevenueCat SDK and one proxy URL line, with no purchase backend to write.",
      },
    ],
    docs: [
      { href: "/docs/guides/connect-ai-assistants", label: "Connect AI assistants" },
      { href: "/docs/getting-started/quickstart", label: "First purchase in 5 minutes" },
      { href: "/docs/getting-started/connect-your-app", label: "Connect your app" },
      { href: "/docs/guides/test-store", label: "Test Store" },
    ],
    related: ["/sdks/react-native", "/sdks/ios", "/sdks/flutter", "/stores/test-store", "/solutions/indie-developers", "/pricing"],
  },
];
