// Solution landing pages: /solutions/<slug>. Facts come from docs/STATUS.md, the docs repo and src/lib/pricing.ts.
// Writing rules: apps/site/CONTENT.md. Cloud Standard prices come from src/lib/pricing.ts.
import type { Landing } from "./types";

const SIGNUP = "https://app.revenuedot.app/signup";

export const SOLUTIONS: Landing[] = [
  {
    slug: "existing-apps",
    section: "solutions",
    name: "Apps already selling",
    card: "Already selling with your own code, Adapty or Stripe? Import your products and keep every subscriber.",
    label: "Solution",
    title: "Move your existing in-app purchases to RevenueDot and keep every subscriber",
    metaTitle: "Move existing in-app purchases to RevenueDot",
    metaDescription:
      "Already sell subscriptions with your own StoreKit or Play Billing code, Adapty or Stripe? Import your products, install one SDK and keep every subscriber.",
    answer:
      "If your app already sells subscriptions with its own StoreKit or Google Play Billing code, or with another tool, you can move it to RevenueDot without losing a subscriber. Import your products from App Store Connect, Google Play or Stripe, install the RevenueDot SDK, and call `syncPurchases()` once in the update. Each subscriber's purchases are checked with the store, and their access carries over.",
    shot: {
      src: "screens/offerings-light.png",
      alt: "The Offerings page in RevenueDot: the default offering with three packages, and a win-back offering",
    },
    points: [
      { title: "Products imported", text: "One click reads App Store Connect, Google Play or Stripe and fills your catalog." },
      { title: "Subscribers kept", text: "The update sends each device's purchases, and the store's notifications fill in the rest." },
      { title: "Your server keeps working", text: "RevenueDot can forward every store notification to your old endpoint while you move." },
      { title: "Less code to maintain", text: "Receipt checks, renewals, refunds and grace periods move out of your codebase." },
    ],
    blocks: [
      {
        h2: "RevenueDot takes over the purchase work your own code does today",
        label: "What moves",
        bullets: [
          "**Checking purchases with the store.** RevenueDot verifies StoreKit 2 signed transactions with Apple and reads Google Play purchase tokens with the Play Developer API. Your server no longer trusts the device.",
          "**Renewals, cancellations, billing problems and refunds.** App Store Server Notifications and Google Play real-time notifications update each customer, and [webhooks](/docs/guides/webhooks) tell your backend.",
          "**One answer to \"is this user premium?\"** A customer who pays on iOS, Android or the web has the same access everywhere.",
          "**Paywalls, experiments and charts.** [Paywall templates](/features/paywalls), [price tests](/features/experiments) and [43 charts](/charts) work from the first purchase.",
        ],
      },
      {
        h2: "How to move an app that already sells in-app purchases",
        label: "Steps",
        steps: [
          {
            name: "Create a free project and add your store apps",
            text: `[Start free on Cloud](${SIGNUP}) and add your App Store, Google Play or Stripe app with its credentials. Paste RevenueDot's notification URLs into App Store Connect and Google Play. If your own server receives those notifications today, set the app's forward URL to it, so it keeps getting every notification while you move.`,
          },
          {
            name: "Import your products",
            text: "Click **Import products**. RevenueDot reads App Store Connect, Google Play or Stripe and creates each product with its type and duration. Attach them to an entitlement such as `pro` (the access your app checks) and put them in the offering your paywall shows. See [import products](/docs/guides/import-products).",
          },
          {
            name: "Install the RevenueDot SDK",
            text: "Add the [RevenueDot SDK](/sdks) for your platform and configure it with your app's key and your own user ID, so purchases land on the right customer. Replace your purchase calls with the SDK's: load the offering, buy a package, check the entitlement.",
          },
          {
            name: "Bring your subscribers over",
            text: "Call `syncPurchases()` once on the first launch of the update. It sends the device's purchases to RevenueDot, which checks them with the store. To also record subscribers who have not opened the update yet, turn on `track_new_purchases` for the app.",
          },
          {
            name: "Check access from your backend",
            text: "Read a customer's active entitlements with a secret key, or receive [webhooks](/docs/guides/webhooks) for every renewal, cancellation and refund. Then retire your own receipt code.",
          },
        ],
      },
      {
        h2: "The update configures the SDK and syncs purchases once",
        label: "Swift",
        code: {
          title: "First launch of the update",
          label: "Swift",
          code: `import RevenueCat   // the module name of the open-source SDK the RevenueDot SDK is built from

Purchases.configure(withAPIKey: "appl_...", appUserID: currentUser.id)

// Once, on the first launch of this update: send the device's existing App Store purchases to RevenueDot.
if !UserDefaults.standard.bool(forKey: "revenuedotSynced") {
    _ = try? await Purchases.shared.syncPurchases()
    UserDefaults.standard.set(true, forKey: "revenuedotSynced")
}
let isPro = try await Purchases.shared.customerInfo().entitlements["pro"]?.isActive == true`,
        },
        paras: [
          "The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `RevenueCat` and calls `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account. Android, React Native and Flutter have the same calls; see [the SDK guides](/docs/sdks).",
        ],
      },
      {
        h2: "Apps on Adapty, Qonversion or Stripe follow the same steps",
        label: "Other tools",
        bullets: [
          "**Adapty or Qonversion:** replace their SDK with the RevenueDot SDK. Your App Store and Google Play products stay exactly as they are, and `syncPurchases()` brings each subscriber over. See [RevenueDot vs Adapty](/compare/revenuedot-vs-adapty) and [RevenueDot vs Qonversion](/compare/revenuedot-vs-qonversion).",
          "**Stripe:** your backend posts each Stripe subscription ID to RevenueDot with the Stripe app's key, and new web sales can use RevenueDot's [web checkout](/features/web-billing) on your own Stripe account. See [Stripe](/stores/stripe).",
          "**RevenueCat:** you do not need these steps. Keep your SDK and change one line; see [Migrate from RevenueCat](/migrate-from-revenuecat).",
        ],
      },
      {
        h2: "What to know before you move",
        label: "Honest notes",
        bullets: [
          "**You change code.** Moving from your own code means replacing your purchase calls with the SDK's. Most apps touch the paywall screen, the purchase call and the access check.",
          "**RevenueDot launched in 2026.** A real App Store sandbox purchase has run end to end on an iPhone. Google Play handling is tested against a copy of Google's API, so run a Play sandbox purchase before you ship.",
          "**Subscribers who never open the update** are recorded from store notifications only when `track_new_purchases` is on. Without it, they come over the next time they open the app.",
        ],
      },
    ],
    howTo: "How to move an app that already sells in-app purchases",
    faq: [
      {
        q: "Can I move to RevenueDot if I wrote my own StoreKit or Play Billing code?",
        a: "Yes. Import your products, install the RevenueDot SDK in place of your purchase code, and call syncPurchases() once on the first launch of the update. RevenueDot checks each device's purchases with Apple or Google and gives the customer the same access they had.",
      },
      {
        q: "Will my current subscribers lose access when I move?",
        a: "No, as long as the update syncs their purchases. syncPurchases() sends the device's App Store or Google Play purchases to RevenueDot, which verifies them with the store. Turn on track_new_purchases to also record subscribers from store notifications before they open the update.",
      },
      {
        q: "Do I have to change my products in App Store Connect or Google Play?",
        a: "No. Your products, prices and subscription groups stay in the stores as they are. RevenueDot imports their identifiers, types and durations, and reads prices from the stores.",
      },
      {
        q: "Can my own server keep receiving App Store and Google Play notifications?",
        a: "Yes. Each app has a forward URL. RevenueDot sends every store notification to it, byte for byte, so your old server keeps working while you move.",
      },
      {
        q: "What does RevenueDot cost for an app that already sells?",
        a: "RevenueDot Cloud is free until your app makes $10,000 a month in tracked revenue. Above that, it charges 0.5% of the revenue above $10,000, capped at $999 a month.",
      },
    ],
    docs: [
      { href: "/docs/guides/import-products", label: "Import products from the stores" },
      { href: "/docs/sdks", label: "SDK guides" },
      { href: "/docs/guides/app-store", label: "Connect the App Store" },
      { href: "/docs/guides/google-play", label: "Connect Google Play" },
      { href: "/docs/help/store-notifications-not-arriving", label: "Store notifications and track_new_purchases" },
      { href: "/docs/guides/webhooks", label: "Webhooks" },
    ],
    related: ["/add-in-app-purchases", "/solutions/receipt-validation", "/sdks/ios", "/sdks/android", "/compare/revenuedot-vs-adapty", "/pricing"],
  },

  {
    slug: "indie-developers",
    section: "solutions",
    name: "Indie developers",
    card: "A free backend until your app makes $10K a month, with paywalls, charts, web checkout and a Test Store.",
    label: "Solution",
    title: "A free in-app purchase backend for indie developers",
    metaTitle: "Free in-app purchase backend for indie developers",
    metaDescription:
      "RevenueDot Cloud is free until your app makes $10,000 a month, with paywalls, 43 charts, web checkout and a Test Store included.",
    answer:
      "RevenueDot gives indie developers a free backend for subscriptions and in-app purchases. RevenueDot Cloud is free until your app makes $10,000 a month, then 0.5% of the revenue above that, capped at $999 a month. Paywalls, 43 charts and web checkout on your own Stripe account are included, and the Test Store lets you buy before you have an App Store or Google Play account.",
    shot: {
      src: "screens/overview-light.png",
      alt: "The RevenueDot dashboard overview with monthly revenue, active subscriptions and a sandbox switch",
    },
    points: [
      { title: "Free to $10K a month", text: "RevenueDot Cloud costs $0 while your app tracks up to $10,000 a month." },
      { title: "Capped at $999 a month", text: "Above $10,000 a month Cloud Standard charges 0.5%, and the bill never passes $999." },
      { title: "Test before the stores", text: "The Test Store lets you make purchases before you have an App Store or Google Play account." },
      { title: "Your data stays yours", text: "Customers and purchases live in Postgres tables you can query through the REST API and the dashboard." },
    ],
    blocks: [
      {
        h2: "How to add subscriptions to an indie app for free",
        label: "Steps",
        steps: [
          {
            name: "Create a free Cloud project",
            text: `[Start free on Cloud](${SIGNUP}). It takes an email address and a project name.`,
          },
          {
            name: "Add a Test Store app",
            text: "Make purchases before you have an App Store or Google Play account. See [the Test Store](/stores/test-store).",
          },
          {
            name: "Create your products",
            text: "Add your plans, an entitlement such as `pro` (the access your app checks) and an offering (the products your paywall shows).",
          },
          {
            name: "Install the RevenueDot SDK",
            text: "Add the [RevenueDot SDK](/sdks) for your platform and configure it with your app's key. It needs no RevenueCat account.",
          },
          {
            name: "Show a paywall and buy",
            text: "Publish a paywall from a template, show it in your app and make a test purchase. Connect the App Store and Google Play when you are ready to ship.",
          },
        ],
      },
      {
        h2: "An indie app gets paywalls, charts and web checkout before it earns $10,000 a month",
        label: "Included",
        bullets: [
          "Offerings, entitlements and a REST API, plus webhooks with a delivery log.",
          "[Paywalls](/features/paywalls) with a template gallery and a visual editor, and [charts](/features/charts) for MRR, trial conversion and churn.",
          "Web checkout on your own Stripe account, with purchase links and funnels. See [web to app](/solutions/web-to-app).",
          "Win-back offers, refund control for Apple's refund requests and support integrations.",
          "A Test Store, so you can test with no store account. See [test in-app purchases without sandbox](/stores/test-store).",
        ],
      },
      {
        h2: "Already on RevenueCat? Here is the bill and the five-step move",
        label: "Switching",
        paras: [
          "RevenueCat is free below $2,500 of monthly tracked revenue. Once an app reaches $2,500, it charges 1% of all tracked revenue, according to its [pricing page](https://www.revenuecat.com/pricing) (checked October 2026). Its paywall and funnel tools are priced separately.",
        ],
        table: {
          head: ["Monthly tracked revenue", "RevenueCat", "RevenueDot Cloud"],
          rows: [
            ["$5,000", "$50", "$0"],
            ["$10,000", "$100", "$0"],
            ["$25,000", "$250", "$75"],
            ["$50,000", "$500", "$200"],
            ["$100,000", "$1,000", "$450"],
          ],
          caption: "Cloud Standard is 0.5% of tracked revenue above $10,000, capped at $999 a month.",
        },
      },
      {
        h2: "How to move an indie app from RevenueCat to RevenueDot",
        label: "Switching",
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
        h2: "What you give up, said plainly",
        label: "Tradeoffs",
        bullets: [
          "**Age.** RevenueDot launched in 2026, and RevenueCat has years of production use at far larger scale. If you are switching, run both side by side and compare them before you turn RevenueCat off.",
          "**The SDK packages are new.** The RevenueDot SDKs are published (CocoaPods, Maven Central, npm, OpenUPM and git tags) and were first released in October 2026. An app switching from RevenueCat can keep the stock RevenueCat SDK with a proxy URL instead.",
          "**Some RevenueCat features are not copied.** [What differs from RevenueCat](/docs/migrate/what-differs) lists them, and the [comparison](/compare/revenuedot-vs-revenuecat) shows both sides.",
          "If you switch from RevenueCat, you can run both in parallel for as long as you like, so the switch is reversible.",
        ],
      },
    ],
    howTo: "How to add subscriptions to an indie app for free",
    faq: [
      {
        q: "Is there a free in-app purchase backend for indie developers?",
        a: "Yes. RevenueDot Cloud is free until your app makes $10,000 a month in tracked revenue, and self-hosting is free under AGPL-3.0. Paywalls, charts, web checkout and the Test Store are included, and the RevenueDot SDK needs no RevenueCat account.",
      },
      {
        q: "How much does RevenueCat cost for a small app?",
        a: "RevenueCat is free up to $2,500 of monthly tracked revenue, then 1% of all tracked revenue once you pass it, per its pricing page checked in October 2026. An app with $10,000 a month pays $100, and one with $50,000 pays $500. Paywall and funnel tools are priced separately.",
      },
      {
        q: "Is there a free alternative to RevenueCat?",
        a: "RevenueDot Cloud is free up to $10,000 of monthly tracked revenue, then 0.5%, never more than $999 a month. An app on the RevenueCat SDK keeps it and changes one proxy URL line. Start free at https://app.revenuedot.app/signup.",
      },
      {
        q: "What does RevenueDot Cloud cost above $10,000 a month?",
        a: "Cloud Standard is 0.5% of tracked revenue above $10,000, capped at $999 a month, and the rate never rises. The Cloud free plan covers up to $10,000 a month.",
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
      { href: "/docs/getting-started/quickstart", label: "First purchase in 5 minutes" },
      { href: "/docs/migrate", label: "Migrate from RevenueCat" },
      { href: "/docs/migrate/importer", label: "The importer" },
      { href: "/docs/migrate/dual-run", label: "Run both side by side" },
      { href: "/docs/migrate/what-differs", label: "What differs from RevenueCat" },
    ],
    related: ["/pricing", "/compare/revenuedot-vs-revenuecat", "/migrate-from-revenuecat", "/stores/test-store"],
  },

  {
    slug: "app-studios",
    section: "solutions",
    name: "App studios",
    card: "Run every client app on RevenueDot Cloud with one project each and team roles. Free up to $10K a month.",
    label: "Solution",
    title: "In-app purchase backend for app studios: many apps, one server, team roles",
    metaTitle: "In-app purchase backend for app studios and agencies",
    metaDescription:
      "Run many apps on RevenueDot Cloud. One project per product, Admin, Developer and Viewer roles per project, free up to $10,000 a month.",
    answer:
      "An app studio can run every app on RevenueDot Cloud. Each product is a project with its own catalog, customers, webhooks and API keys, and each person has an Admin, Developer or Viewer role per project. RevenueDot Cloud is free up to $10,000 a month in tracked revenue, then 0.5%, never more than $999 a month.",
    points: [
      { title: "One project per product", text: "Each project owns its catalog, customers, webhooks and secret keys, so clients never see each other's data." },
      { title: "Roles per project", text: "Admin, Developer and Viewer. A person can hold a different role in each project." },
      { title: "Many projects", text: "One RevenueDot server holds any number of projects, one per client app." },
      { title: "One SDK for every app", text: "Every client app installs the RevenueDot SDK with its own app key." },
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
          "RevenueDot Cloud is free up to $10,000 of monthly tracked revenue, then 0.5%, never more than $999 a month. [Start free on Cloud](https://app.revenuedot.app/signup). See [pricing](/pricing).",
          "For comparison, RevenueCat charges 1% of all monthly tracked revenue once it reaches $2,500 ([pricing](https://www.revenuecat.com/pricing), checked October 2026).",
        ],
      },
      {
        h2: "How to onboard a new client app",
        label: "Steps",
        steps: [
          {
            name: "Create a project for the client",
            text: `In the dashboard click **New project** on [RevenueDot Cloud](${SIGNUP}).`,
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
            name: "Install the RevenueDot SDK in the client app",
            text: "Install the RevenueDot SDK and configure it with the app's key. For a client already on RevenueCat, import their project first; their app can keep the RevenueCat SDK and change one line.",
          },
        ],
      },
      {
        h2: "Limits to plan for",
        label: "Honest notes",
        bullets: [
          "**One container per database.** The background job has no lock across processes, so run one RevenueDot container per Postgres for now.",
          "**Roles are three** today: Admin, Developer and Viewer.",
          "**Store credentials** for Apple and Google are stored in the project's database. Encrypt backups and limit who can read them.",
        ],
      },
    ],
    howTo: "How to onboard a new client app",
    faq: [
      {
        q: "Can I run multiple apps on one RevenueDot account?",
        a: "Yes. Create one project per product, and add an app per store inside it. Each project has its own catalog, customers, webhooks and API keys.",
      },
      {
        q: "How do I give a client read-only access to their revenue?",
        a: "Invite them to their project with the Viewer role. A Viewer can read everything the dashboard shows and change nothing. A person can have a different role in each project.",
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
      { href: "/docs/guides/going-to-production", label: "Going to production" },
      { href: "/docs/migrate/importer", label: "The importer" },
    ],
    related: ["/solutions/indie-developers", "/pricing", "/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat"],
  },

  {
    slug: "self-hosted-in-app-purchases",
    section: "solutions",
    name: "Running the server yourself",
    card: "Most teams start on RevenueDot Cloud. These are the technical notes for running the open-source server yourself.",
    label: "Solution",
    title: "RevenueDot Cloud, or the open-source server on Docker and Postgres",
    metaTitle: "RevenueDot Cloud, or run the server yourself",
    metaDescription:
      "Start free on RevenueDot Cloud with no servers to run. The open-source server (AGPL-3.0) also runs from one Docker image plus Postgres 16.",
    answer:
      "RevenueDot Cloud is free up to $10,000 a month in tracked revenue, then 0.5%, never more than $999 a month, and needs no servers: sign up at https://app.revenuedot.app/signup. The same open-source code (AGPL-3.0) also runs as one Docker image next to Postgres 16 for teams that need their own infrastructure.",
    shot: {
      src: "dashboard-light.png",
      alt: "The RevenueDot dashboard showing customers, revenue and setup health",
    },
    points: [
      { title: "One image, one database", text: "A single container plus Postgres 16 with a persistent volume." },
      { title: "Migrations on start", text: "Upgrades are a rebuild and a restart. The server applies database migrations itself." },
      { title: "Open source", text: "The server and dashboard are AGPL-3.0, and the SDK forks are MIT." },
      { title: "Your Postgres", text: "When you run the server yourself, every purchase and customer lives in your Postgres, and the server never calls RevenueDot." },
    ],
    blocks: [
      {
        h2: "How to run the RevenueDot server yourself",
        label: "Steps",
        steps: [
          {
            name: "Clone the repository and copy the config",
            text: "Clone `revenuedot/revenuedot`, copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`. Do it before the first start: the password is written into the volume then.",
          },
          {
            name: "Start the stack",
            text: "Run `docker compose up -d`. It pulls `ghcr.io/revenuedot/revenuedot` (built for amd64 and arm64 on every change) and starts RevenueDot and Postgres.",
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
            text: "Add your App Store key and Google Play service account, set the notification URLs the dashboard shows, then install the RevenueDot SDK in your app and set its proxy URL to your server.",
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
docker compose up -d          # pulls ghcr.io/revenuedot/revenuedot and starts RevenueDot and Postgres
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
        h2: "Production checklist for a server you run",
        label: "Before production",
        bullets: [
          "A managed Postgres with point-in-time recovery, daily dumps copied off the server, and one test restore.",
          "SMTP settings so password resets, invites and alert emails arrive. Without them, emails print to the server log.",
          "`REVENUEDOT_SIGNING_KEY` set, if you ship SDK builds that verify responses.",
          "Store credentials checked in the dashboard, and notification status showing **Ready** for each app.",
          "Uptime monitoring on `GET /v1/health`.",
        ],
        paras: ["The full list is in [Going to production](/docs/guides/going-to-production). The [technical notes page](/self-host) covers the same stack."],
      },
      {
        h2: "RevenueDot Cloud or your own server",
        label: "Choice",
        paras: [
          `RevenueDot Cloud is free up to $10,000 of monthly tracked revenue, then 0.5%, never more than $999 a month, and needs no servers: [start free on Cloud](${SIGNUP}). Cloud and a server you run use the same code, API and schema. A server you run sends no telemetry, and talks only to Apple, Google, Stripe or Amazon if you connect them, your webhook endpoints and any forwarding URL you set.`,
        ],
        bullets: [
          "**Signatures:** a server you run signs with its own key, so set the SDK's entitlement verification to disabled on iOS and Android, or build the RevenueDot SDK with your own public key.",
          "**Status:** the Docker image builds on `node:24-slim`, and CI starts it against Postgres 16 on every pull request.",
        ],
      },
    ],
    howTo: "How to run the RevenueDot server yourself",
    faq: [
      {
        q: "Can I run the RevenueDot server myself?",
        a: "Yes. RevenueDot Cloud needs no servers, and the open-source server also runs with Docker Compose next to Postgres 16. Your app installs the RevenueDot SDK and sets its proxy URL to your server; an app on the RevenueCat SDK keeps it and changes that one line.",
      },
      {
        q: "What do I need to run RevenueDot on my own server?",
        a: "A machine with Docker and Compose v2, plus Postgres 16, which Compose starts for you. For production use a managed Postgres with backups and put the server behind HTTPS.",
      },
      {
        q: "What license is the RevenueDot server under?",
        a: "The server and dashboard are AGPL-3.0, and any company can run them for its own apps. The AGPL asks you to share changes if you modify the server and offer it to others over a network.",
      },
      {
        q: "How do I upgrade a RevenueDot server I run?",
        a: "Pull the new code, rebuild the image and restart. Database migrations run automatically when the server starts. Back up Postgres first.",
      },
      {
        q: "Does a RevenueDot server I run send my data to RevenueDot?",
        a: "No. It has no telemetry and never calls RevenueDot's servers. It talks to the stores you connect, your webhook endpoints and any forwarding URL you set.",
      },
    ],
    docs: [
      { href: "/docs/guides/self-hosting", label: "Running the server yourself" },
      { href: "/docs/guides/going-to-production", label: "Going to production" },
      { href: "/docs/guides/backups", label: "Back up and restore" },
      { href: "/docs/guides/upgrades", label: "Upgrades" },
      { href: "/docs/getting-started/quickstart", label: "Quickstart" },
    ],
    related: ["/solutions/eu-data-residency", "/solutions/app-studios", "/pricing", "/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat"],
  },

  {
    slug: "eu-data-residency",
    section: "solutions",
    name: "EU data residency",
    card: "What RevenueDot Cloud does and does not offer for EU data location. No certifications claimed.",
    label: "Solution",
    title: "EU data residency for in-app purchase data: what RevenueDot offers today",
    metaTitle: "EU data residency for in-app purchase data",
    metaDescription:
      "RevenueDot Cloud does not pin data to an EU region today. Plain notes on where data sits, GDPR and what we do not claim.",
    answer:
      "RevenueDot Cloud does not pin data to an EU region today. Teams that must keep in-app purchase data in the EU can run the open-source server in a region they choose, such as Frankfurt or Dublin, so every customer, purchase and receipt lives in their own Postgres database. This page is not legal advice.",
    points: [
      { title: "Cloud location", text: "RevenueDot Cloud runs on Cloudflare's network and does not offer an EU-only region today." },
      { title: "Your own region", text: "A server you run yourself sits in any cloud region you pick, has no telemetry and never calls RevenueDot's servers." },
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
        h2: "How to keep in-app purchase data in the EU with a server you run",
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
            text: "Clone the repository, set `DATABASE_URL` and a strong password in `.env`, and run `docker compose up -d`. See [running the server yourself](/solutions/self-hosted-in-app-purchases).",
          },
          {
            name: "Put HTTPS and backups in the same region",
            text: "Terminate TLS in front of the server and keep database dumps in storage in the same region, encrypted.",
          },
          {
            name: "Connect your stores and install the SDK",
            text: "Add your Apple and Google credentials, set the notification URLs, then install the RevenueDot SDK in your app and set its proxy URL to your own HTTPS address.",
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
          "**Your app.** The RevenueDot Android SDK (`app.revenuedot.purchases:purchases` on Maven Central) sends diagnostics, paywall events and ad events to your server. An app that keeps the stock RevenueCat Android SDK still sends them to RevenueCat's hosts. See [the Android SDK page](/sdks/android).",
        ],
      },
      {
        h2: "RevenueDot Cloud and data location",
        label: "Cloud",
        paras: [
          "RevenueDot Cloud runs on Cloudflare's network, and Cloudflare is its only listed subprocessor, with locations described as a global network and the United States. Cloud does not offer an EU-only region today. For transfers from the EEA, UK or Switzerland to countries without an adequacy decision, the EU Standard Contractual Clauses apply, according to the [data processing summary](/legal/dpa), which is a summary and not the signed agreement. If you need data to stay in the EU, the open-source server can run in a region you choose.",
        ],
      },
      {
        h2: "What this does and does not give you",
        label: "Limits",
        bullets: [
          "Hosting in the EU helps with where data sits. It does not make an app GDPR compliant. Lawful basis, notices, retention and requests from users are still your job, and your lawyer's call.",
          "RevenueDot holds no compliance certification. It publishes its [security policy](/security) and its code, which you can read.",
          "You are the controller. A deployment you run yourself involves no processing by RevenueDot.",
        ],
      },
    ],
    howTo: "How to keep in-app purchase data in the EU with a server you run",
    faq: [
      {
        q: "Can I keep in-app purchase data in the EU?",
        a: "Yes, by running the open-source RevenueDot server and a Postgres database in an EU region. Customer, purchase and receipt data then stays in your database. The stores, integrations and email provider you connect are separate processors.",
      },
      {
        q: "Does RevenueDot Cloud have an EU region?",
        a: "Not today. RevenueDot Cloud runs on Cloudflare's network, with the United States listed as a location. If you need purchase data kept in the EU, you can run the open-source server in your own EU region.",
      },
      {
        q: "Is RevenueDot GDPR compliant?",
        a: "Hosting in the EU helps with data location, but compliance covers more, such as a lawful basis, privacy notices and responding to user requests. RevenueDot claims no certification. Ask your lawyer about your own obligations.",
      },
      {
        q: "How do I delete a customer's data from RevenueDot?",
        a: "The REST API v2 has a Delete a customer call, and on a server you run the database is yours, so you can also remove rows directly. Deleted customers stay in older backups until those backups expire.",
      },
      {
        q: "Does a RevenueDot server I run send data to RevenueDot?",
        a: "No. It has no telemetry and never calls RevenueDot's servers. It talks to the stores you connect, your webhook endpoints, the integrations you enable and your SMTP server.",
      },
    ],
    docs: [
      { href: "/docs/guides/self-hosting", label: "Running the server yourself" },
      { href: "/docs/guides/backups", label: "Back up and restore" },
      { href: "/docs/guides/going-to-production", label: "Going to production" },
      { href: "/docs/api/rest-v2", label: "REST API v2" },
    ],
    related: ["/solutions/app-studios", "/pricing", "/compare/revenuedot-vs-revenuecat"],
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
            text: "Register your URL scheme and pass the redemption link to the RevenueDot SDK's `redeemWebPurchase`. The entitlement is active at once.",
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
          "On April 30, 2025 a US federal judge found that Apple willfully violated a 2021 order, and required Apple to let apps on the US storefront link to outside payment with no commission on those links ([The Next Web, May 2026](https://thenextweb.com/news/supreme-court-apple-epic-contempt-stay-denial)). Apple appealed. According to [Fenwick's summary](https://www.fenwick.com/insights/publications/ninth-circuit-largely-upholds-ruling-in-epic-v-apple), the Ninth Circuit upheld the contempt finding in December 2025 but said Apple may charge a commission limited to costs it genuinely needs for the hand-off. As of May 2026 the district court was still to decide what commission, if any, Apple can charge.",
          "The rules apply to the US storefront and may have changed since those reports. Read Apple's current terms and ask your lawyer before you add a link to your app. RevenueDot hosts the web checkout and does not decide what links Apple allows.",
        ],
      },
      {
        h2: "Limits and status",
        label: "Honest notes",
        bullets: [
          "The hosted checkout is a Stripe-hosted page. An embedded checkout (Stripe Elements) is not built.",
          "Connect with Stripe (OAuth) is not available on RevenueDot Cloud yet. You paste a restricted key and a webhook signing secret.",
          "Run a purchase in Stripe test mode before you go live.",
          "RevenueCat Web Billing (`rcb_`) purchases are not accepted. Paddle purchases are tracked when your backend posts them, not through purchases-js. See [the web SDK page](/sdks/web).",
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
        a: "Payments run on your own Stripe account. RevenueDot Cloud is free up to $10,000 of monthly tracked revenue, and Cloud Standard is 0.5% above that, capped at $999 a month. Stripe charges its own fees.",
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
      "Server-side receipt validation means your server asks Apple or Google whether a purchase is real instead of trusting the phone. RevenueDot does this for your app: it verifies StoreKit 2 transactions against Apple's root certificate and the App Store Server API, reads Google Play purchase tokens from the Play Developer API, and answers 5xx for its own failures so no purchase is lost.",
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
            name: "Install the RevenueDot SDK",
            text: "Install the RevenueDot SDK and configure it with the app's key. The SDK then posts each purchase to `POST /v1/receipts`. An app on the RevenueCat SDK sets the proxy URL before `configure` instead.",
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
        a: "Send the purchase to a server that asks the store. For Apple that means verifying the signed transaction and calling the App Store Server API. For Google it means reading the purchase token with the Play Developer API. RevenueDot does both for every purchase your app's SDK sends.",
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
      "To add subscriptions to an app built with an AI agent, connect the agent to RevenueDot's hosted MCP server at https://mcp.revenuedot.app/mcp, install the add-subscriptions skill, and let it set up products, entitlements and the RevenueDot SDK. The agent signs in with OAuth, and you choose what it may do.",
    points: [
      { title: "Hosted MCP server", text: "One connector for Claude, ChatGPT in developer mode, Cursor and other MCP clients." },
      { title: "Agent skills", text: "add-subscriptions, migrate-from-revenuecat, support-playbook, and weekly-revenue-check." },
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
            text: "The agent installs the RevenueDot SDK and configures it with your app's key. Review the diff, then test with a Test Store key in a debug build.",
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
          "**Skills:** [add-subscriptions](https://github.com/revenuedot/agent-skills) covers iOS, Android, React Native and Flutter. Others cover migrating from RevenueCat, answering a support ticket, and a weekly revenue check.",
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
        a: "Yes, something has to verify store receipts and track entitlements. RevenueDot is that server, so the agent only adds the RevenueDot SDK and your app's key, with no purchase backend to write.",
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
