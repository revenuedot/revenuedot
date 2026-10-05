// Feature landing pages: /features/<slug>. Writing rules: apps/site/CONTENT.md. Facts come from docs/STATUS.md,
// the public guides in revenuedot/docs and the PRDs. Only features merged to main.
import type { Landing } from "./types";

export const FEATURES: Landing[] = [
  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "paywalls",
    section: "features",
    name: "Paywalls",
    card: "Build native paywalls from ten templates or a visual editor and publish them without an app release.",
    label: "Feature",
    title: "Paywall builder for iOS and Android apps: native paywalls you change without an app release",
    metaTitle: "Paywall Builder for iOS and Android Apps",
    metaDescription:
      "Build native paywalls from ten templates, a visual editor or AI, translate them and publish without an app release. The RevenueDot SDK shows them in one view.",
    answer:
      "RevenueDot's paywall builder makes native paywalls for iOS and Android. Pick one of ten templates, edit it in the visual editor, translate it, and publish it to an offering, the set of products a paywall shows. Your app shows it with one view from the RevenueDot SDK, PaywallView, and you ship no app release to change it.",
    shot: {
      src: "paywalls-editor-light.png",
      alt: "The RevenueDot paywall editor for a paywall named Annual first. The layer tree is on the left, a phone preview in the middle shows a headline, four benefit lines, a selected yearly plan at $39.99 and a Start free trial button, and the properties of the selected package are on the right.",
      caption: "The visual editor: layers, a live phone preview and the properties of the selected component. Prices in the preview are sample values.",
    },
    points: [
      { title: "10 templates", text: "Trial timeline, annual first, feature hero, free vs pro, minimal, story pages, limited offer, tiers, reviews and web checkout." },
      { title: "17 component types", text: "Text, image, icon, stack, package, purchase button, timeline, tabs, carousel, countdown, video and more, all editable." },
      { title: "Checked before publish", text: "The server validates each paywall the way the iOS SDK decodes it and refuses to publish one the SDK could not render." },
      { title: "No app release", text: "Apps fetch offerings at launch and when they return to the foreground, so a change reaches users within one session." },
    ],
    blocks: [
      {
        h2: "How to build and publish a paywall",
        label: "Steps",
        paras: ["Open **Paywalls** in the dashboard. A paywall belongs to one offering, and an offering has at most one paywall."],
        steps: [
          { name: "Pick a starting point", text: "Choose a template from the gallery, start from scratch, or describe the app and the offer and let Generate with AI draft it. Filter templates by number of screens, purchase method, packages and tiers." },
          { name: "Set the basics", text: "Choose the offering, add your app name, an accent color, and your Terms and Privacy links, then select Create paywall." },
          { name: "Edit it", text: "Select any layer or click it in the phone preview. Change text, images, colors, spacing and package cards in the properties panel. Switch between light and dark, and between customers who are and are not eligible for an intro offer." },
          { name: "Translate it", text: "Open the Localizations tab, add a language and fill in its strings. Empty cells show the default language, so a paywall is never blank." },
          { name: "Publish", text: "Select Publish. RevenueDot checks the paywall first and then sends it to apps in the offerings response. Save draft keeps your work private until then." },
        ],
      },
      {
        h2: "Which paywall templates does RevenueDot have?",
        paras: ["The gallery has ten layouts. Each one uses your offering's real packages in the preview."],
        table: {
          head: ["Template", "What it does"],
          rows: [
            ["Trial timeline", "Explains the free trial day by day, then shows two plans with yearly selected"],
            ["Annual first", "Benefits, then yearly and monthly plans with a savings badge"],
            ["Feature hero", "A full-width image, five benefits with icons and plans side by side"],
            ["Free vs Pro", "A short comparison table, then two plans"],
            ["Minimal", "A headline, your plans and one button"],
            ["Story pages", "Three swipeable value pages before the plans"],
            ["Limited offer", "A countdown to the end of an offer, one plan, dark theme"],
            ["Tiers", "Two tiers in tabs (Plus and Pro) with two plans each"],
            ["Reviews", "A rating, a user count and one review, then two plans"],
            ["Web checkout", "The button opens web checkout instead of the store sheet (iOS)"],
          ],
        },
      },
      {
        h2: "What can you change in the paywall editor?",
        paras: [
          "The editor has three columns: layers on the left, the phone preview in the middle and properties on the right. The preview shows the exact JSON your app receives.",
        ],
        bullets: [
          "**Layers:** add any of 14 component types, drag, nest, duplicate and remove them. Undo and redo work with the keyboard.",
          "**Variables:** texts can use values the device fills in, such as `{{ product.price_per_period }}` and `{{ product.relative_discount }}`, so prices always show the store's local currency.",
          "**Light and dark colors**, selected-state and intro-offer overrides, gradients, borders, shadows and badges.",
          "**Problems list:** anything the SDK would not decode, such as a text without a string, is listed with a Go to link. You cannot publish while errors remain.",
          "**Versions:** save a named version and restore it into the draft later. Unpublish takes a paywall off apps and keeps it as a draft.",
        ],
      },
      {
        h2: "How do you show a RevenueDot paywall in your app?",
        paras: [
          "Add the RevenueDot SDK's paywall library (`RevenueCatUI` on iOS, `purchases-ui` on Android) and present the paywall. `PaywallView()` shows the current offering's paywall, and you can pass an offering to show another one. Android uses `PaywallDialog`, React Native uses `RevenueCatUI.presentPaywall()` and Flutter uses `RevenueCatUI.presentPaywall()` from `purchases_ui_flutter`.",
          "The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `RevenueCatUI` and calls `PaywallView`. It sends every request to RevenueDot and needs no RevenueCat account. An app that already ships the RevenueCat SDK shows the same paywall with the same code.",
        ],
        code: {
          title: "PaywallScreen.swift",
          label: "Swift",
          code: `import RevenueCatUI

struct HomeView: View {
    @State private var showPaywall = false

    var body: some View {
        Button("Go Pro") { showPaywall = true }
            // Shows the paywall you published for the current offering.
            .sheet(isPresented: $showPaywall) { PaywallView() }
    }
}`,
        },
      },
      {
        h2: "How do you validate and publish a paywall with the API?",
        paras: [
          "Everything the editor does is in REST API v2. Check a paywall without saving it with `POST /v2/projects/{project_id}/paywalls/validate`, which returns `errors` and `warnings`. Publishing answers 422 with the first problem when the SDK could not render the paywall.",
        ],
        code: {
          title: "Publish a paywall",
          label: "curl",
          code: `curl -s -X POST "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/paywalls/$PAYWALL_ID/actions/publish" \\
  -H "Authorization: Bearer $SECRET_KEY"`,
        },
      },
      {
        h2: "What is not built yet?",
        bullets: [
          "Paywalls with several screens and navigation between them. A carousel gives you pages inside one screen, and a multi-screen paywall is served for its first screen only.",
          "Dragging components directly on the phone preview. You reorder them in the layer list.",
          "Video uploads. A video component takes a URL.",
          "An editor for exit offers and custom variables. They pass through the API.",
        ],
      },
    ],
    howTo: "How to build and publish a paywall",
    faq: [
      {
        q: "How do I build a paywall for my iOS or Android app without writing UI code?",
        a: "Open Paywalls in the RevenueDot dashboard, choose a template, pick your offering and publish. The RevenueDot SDK renders it natively, and so does the RevenueCat SDK, so your app only calls PaywallView on iOS, PaywallDialog on Android, or presentPaywall in React Native and Flutter. You write no layout code.",
      },
      {
        q: "Can I change a paywall without releasing a new app version?",
        a: "Yes. Apps fetch offerings, which carry the published paywall, at launch and when they return to the foreground. A change you publish reaches users within one session. The app needs an SDK version that renders paywall components: on iOS, version 5.83 or later of the RevenueDot or RevenueCat SDK.",
      },
      {
        q: "Can I A/B test paywalls?",
        a: "Yes, by testing two offerings. Give each offering its own paywall, then run an offering experiment that splits a share of customers between them and reports conversion, revenue and the chance the new offering wins. See the experiments feature page for the steps.",
      },
      {
        q: "Can I translate a paywall into other languages?",
        a: "Yes. The Localizations tab holds one set of strings per language. Missing strings fall back to the default language. The SDK also fills in the words around prices, such as month and days, in English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Japanese, Korean and Chinese.",
      },
      {
        q: "Does RevenueDot support multi-step paywall flows?",
        a: "Not yet. You can build several pages inside one screen with a carousel or tabs. A paywall with separate screens and navigation between them is served for its first screen only, so build multi-step onboarding as a web funnel instead.",
      },
    ],
    docs: [
      { href: "/docs/guides/paywalls", label: "Paywalls guide" },
      { href: "/docs/guides/targeting-and-experiments", label: "Targeting and experiments" },
      { href: "/docs/api/rest-v2", label: "REST API v2: paywall operations" },
    ],
    related: ["/features/experiments", "/features/web-billing", "/features/customer-center", "/features/funnels", "/sdks/ios", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "experiments",
    section: "features",
    name: "Targeting and experiments",
    card: "Target offerings by audience and A/B test two of them with results, with no app release.",
    label: "Feature",
    title: "A/B test paywalls and offerings in your app with audiences and targeting rules",
    metaTitle: "A/B Test Paywalls and Offerings in Your App",
    metaDescription:
      "Target offerings by country, platform, spend or attribute, use placements, and A/B test two offerings with conversion, revenue and chance-to-win results.",
    answer:
      "RevenueDot lets you show different offerings to different customers and A/B test two of them, with no app release. Audiences filter customers by country, platform, spend and attributes. Ordered targeting rules and placements pick the offering. An experiment splits customers deterministically and reports conversion, revenue and the chance the new offering wins.",
    shot: {
      src: "screens/experiments-light.png",
      dark: "screens/experiments-dark.png",
      alt: "An experiment page in RevenueDot, 'Annual plan first on the paywall': the results panel compares the control and treatment offerings on customers, paywall views, purchases, conversion and revenue, with the treatment's lift and chance to win.",
      caption: "Experiment results in the dashboard: control against treatment, with lift and chance to win. Captured with example data.",
    },
    points: [
      { title: "Audiences", text: "Conditions on country, platform, app version, subscription status, entitlements, spend, dates, attribution and custom attributes." },
      { title: "Ordered rules", text: "The first live rule that matches decides the current offering. Reorder rules and set start and end times." },
      { title: "Placements", text: "Ask for the offering of a spot in your app, such as onboarding_end, and target it separately." },
      { title: "Experiment results", text: "Customers per variant, conversions, trials, revenue, revenue per customer and the chance the treatment converts better." },
    ],
    blocks: [
      {
        h2: "How does RevenueDot decide which offering a customer sees?",
        paras: [
          "Your app asks for the current offering, or for the offering of a placement. RevenueDot answers per customer, in this order: an offering you assigned to that one customer through the API, then your live targeting rules from the top, then the project's current offering.",
          "An audience is a set of conditions. Conditions in a group must all be true, and separate groups are alternatives. **Preview** shows how many of your customers match today.",
        ],
        bullets: [
          "Fields: country, platform, app version, SDK version, locale, subscription status (`active`, `trialing`, `expired`, `never`), active entitlements, total spent, first and last seen, latest product, email, attribution (campaign, media source) and any `customAttribute:<key>`.",
          "A rule can have start and end times through the API.",
          "Rules are checked from the top. Use Move up and Move down to order them. New rules start off.",
        ],
      },
      {
        h2: "How do you read the targeted offering in your app?",
        paras: ["Your app reads the current offering with one SDK call, and RevenueDot decides which one comes back. The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `RevenueCat` and calls `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account."],
        code: {
          title: "Offerings.swift",
          label: "Swift",
          code: `let offerings = try await Purchases.shared.offerings()

// The offering your targeting rules chose for this customer.
let paywallOffering = offerings.current

// The offering for a placement you named in a rule.
let onboarding = offerings.currentOffering(forPlacement: "onboarding_end")`,
        },
      },
      {
        h2: "How to run an offering A/B test",
        label: "Steps",
        paras: ["An experiment compares two offerings: a control (a) and a treatment (b). Each offering can carry its own paywall."],
        steps: [
          { name: "Create both offerings", text: "Make the control and the treatment offering in your catalog, with the packages and the paywall each one should show." },
          { name: "Create the experiment", text: "Open Experiments and select New experiment. Pick both offerings, an optional audience and the share of customers to enroll." },
          { name: "Start it", text: "Select Start. Matching customers are enrolled the next time the app fetches offerings and always keep the same variant." },
          { name: "Read the results", text: "Wait for at least 100 customers in each variant, then compare conversions, trials, revenue per customer and the chance the treatment converts better." },
          { name: "Pause or stop", text: "Pause keeps enrolled customers on their variant and enrolls nobody new. Stop ends the experiment for good." },
        ],
      },
      {
        h2: "What do experiment results show?",
        bullets: [
          "Customers per variant.",
          "Conversions, which count any purchase or trial after enrolling.",
          "Trials, revenue and revenue per customer.",
          "The chance the treatment converts better than the control.",
        ],
        paras: [
          "Enrollment is deterministic: a customer who matches always lands in the same variant. Enrolling sends an `EXPERIMENT_ENROLLMENT` webhook once per customer and experiment, and enrolled customers' purchase, renewal and cancellation webhooks carry an `experiments` list, so your analytics tool can split by variant.",
        ],
      },
      {
        h2: "What is in the API?",
        paras: [
          "Audiences live at `/v2/projects/{project_id}/audiences` and targeting rules at `/v2/projects/{project_id}/targeting_rules`. Experiments live at `/v2/projects/{project_id}/experiments`, with `.../results` per variant. Start, pause and stop are actions on the experiment. An experiment compares two offerings, so test several ideas one after the other.",
        ],
      },
    ],
    howTo: "How to run an offering A/B test",
    faq: [
      {
        q: "How do I A/B test paywalls in my iOS or Android app?",
        a: "Create two offerings, each with its own paywall, then create an experiment in RevenueDot that enrolls a share of your customers and sends half to each offering. Customers keep their variant, and the results page shows conversions, revenue and the chance the new offering wins. No app release is needed.",
      },
      {
        q: "Can I show a different paywall to customers in a specific country?",
        a: "Yes. Create an audience with a country condition, then a targeting rule that gives that audience a different current offering. The offering carries its own paywall. The first live rule that matches the customer decides.",
      },
      {
        q: "What is a placement in an offering?",
        a: "A placement is a named spot in your app, such as onboarding_end. A targeting rule can assign a different offering to each placement, and the app asks for it with offerings.currentOffering(forPlacement:).",
      },
      {
        q: "How many customers do I need for an experiment result I can trust?",
        a: "RevenueDot suggests waiting for at least 100 customers in each variant before you read the chance the treatment converts better. Small samples swing a lot, so let the experiment run until both variants have enough customers.",
      },
      {
        q: "Can one customer be in two experiments?",
        a: "Enrollment is per experiment and deterministic, so a customer always keeps the same variant in an experiment. To keep results clean, give overlapping experiments different audiences.",
      },
    ],
    docs: [
      { href: "/docs/guides/targeting-and-experiments", label: "Targeting and experiments guide" },
      { href: "/docs/api/rest-v2", label: "REST API v2: audiences, rules and experiments" },
      { href: "/docs/api/webhook-events", label: "Webhook events: EXPERIMENT_ENROLLMENT" },
    ],
    related: ["/features/paywalls", "/features/customer-lists", "/features/webhooks", "/features/charts", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "charts",
    section: "features",
    name: "Charts",
    card: "43 charts for MRR, churn, trial conversion, LTV, retention and refunds, from your own purchase data.",
    label: "Feature",
    title: "Subscription analytics for apps: MRR, churn, trial conversion, LTV and 39 more charts",
    metaTitle: "Subscription Analytics: 43 Charts for Apps",
    metaDescription:
      "43 subscription analytics charts for apps: MRR, ARR, churn, trial conversion, LTV, retention and refunds. Sandbox excluded, USD, API and published SQL.",
    answer:
      "RevenueDot has 43 subscription analytics charts for apps, including MRR, ARR, churn, trial conversion, refund rate, LTV and retention. Each chart has a written formula, runs on your own purchase data and comes from one REST endpoint. Sandbox purchases are excluded and money is in US dollars. Moving from RevenueCat? The charts use its Charts v3 names, definitions and API parameters.",
    shot: {
      src: "charts-light.png",
      alt: "The RevenueDot Charts page showing MRR Movement for 90 days by week. A chart list on the left is grouped as Revenue, Subscriptions, Ads and LTV. Summary cards show New MRR $96.52, Resubscription MRR $0.00, Expansion MRR $0.00 and Churned MRR minus $3.33, above a bar chart and a table of weekly values.",
      caption: "MRR Movement: new, resubscription, expansion, churned and contraction MRR by week.",
    },
    points: [
      { title: "43 charts", text: "Revenue, subscriptions, ads, LTV, customers, conversion, paywalls, trials, churn and refunds, and retention." },
      { title: "One definition per number", text: "Each chart's formula is written down, and the SQL for 8 core charts is published and tested equal to the API." },
      { title: "Filters and segments", text: "Slice by app, store, product, offering, country, platform and app version. Compare to the previous period, save views and export CSV." },
      { title: "One chart API", text: "GET /v2/projects/{id}/charts/{chart_name} returns any chart as a time series or cohort table, with filters and segments." },
    ],
    blocks: [
      {
        h2: "Which subscription charts does RevenueDot have?",
        paras: ["The dashboard hub at [/charts](/charts) lists all 43 charts with their formulas. The groups:"],
        table: {
          head: ["Group", "Charts include"],
          rows: [
            ["Revenue", "Revenue, ARR, [MRR](/charts/mrr), MRR Movement, Non-subscription Purchases, Ad Revenue"],
            ["Subscriptions", "Active Subscriptions, Active Subscriptions Movement, Paid Subscriptions, Subscription Retention, Subscription Status"],
            ["Trials and conversion", "Active Trials, New Trials, Trial Conversion Rate, Trial Cancellation Rate, Initial Conversion, Conversion to Paying"],
            ["Churn and refunds", "Churn, Refund Rate, Refunds, Refund Request Outcomes, Play Store Cancel Reasons, Customer Center Survey Responses"],
            ["LTV", "Cohort Explorer, Realized LTV per Customer, Realized LTV per Paying Customer, Prediction Explorer"],
            ["Paywalls", "Paywall Encounter, Paywall Conversion, Paywall LTV, Paywall Abandonment"],
            ["Ads", "eCPM, Impressions, Fill Rate, Ad Monetized Customers, Clicks, CTR, ARPDAU (Ad Users)"],
            ["Customers", "New Customers, Active Customers"],
          ],
        },
      },
      {
        h2: "What rules does every chart follow?",
        bullets: [
          "**Sandbox purchases are excluded.** The Sandbox data switch shows only sandbox and Test Store purchases instead.",
          "**Money is in US dollars** at the exchange rate of the purchase date. Fourteen display currencies convert that amount at the same date's rate.",
          "**Refunds count on the refund date**, not the purchase date.",
          "**A resubscription is a new subscription.** A renewal after a billing issue continues the old one.",
          "**Periods are UTC.** Weeks start on Monday, and the current period's snapshot is taken now. Incomplete periods are marked with an asterisk.",
          "**MRR** normalizes every paid subscription to one month. Cancelled subscriptions count until they expire, and trials count zero.",
        ],
      },
      {
        h2: "How do you get a chart through the API?",
        paras: [
          "The key needs the `charts_metrics:charts:read` permission. `resolution` takes `day`, `week`, `month`, `quarter` or `year`. `filters` and `segment` slice the data, and `GET .../charts/{chart_name}/options` lists what each chart supports.",
        ],
        code: {
          title: "Monthly MRR for the first half of 2026",
          label: "curl",
          code: `curl -H "Authorization: Bearer $REVENUEDOT_SECRET_KEY" \\
  "https://api.revenuedot.app/v2/projects/$PROJECT_ID/charts/mrr?resolution=month&start_date=2026-01-01&end_date=2026-06-30"`,
        },
      },
      {
        h2: "Filters, segments, comparison and saved views",
        bullets: [
          "Filter and segment by app, store, product, product duration, offering, country, platform and app version. Paywall charts also split by paywall.",
          "Compare to the previous period draws the earlier window of the same length as a dashed line and shows the change in each summary number.",
          "Save a chart with its range, resolution, segment, filters and selectors. Saved charts are listed for everyone in the project.",
          "Download any chart as CSV.",
        ],
        paras: ["Published SQL for 8 core charts, among them revenue, active subscriptions, active trials and MRR, lets you reproduce the numbers in your own warehouse. A test checks the SQL equals the API."],
      },
      {
        h2: "Where are the gaps in RevenueDot's charts?",
        bullets: [
          "Tax is estimated where the store does not report it. Stripe, Paddle and Google Play orders report the tax; other purchases use the standard VAT or GST rate of the buyer's country, without reduced rates or US sales tax.",
          "Paid introductory offers count as direct purchases in Paid Subscriptions.",
          "Renewal cycle, offer type, attribution and custom-attribute dimensions are not available yet. Platform and app version are the customer's latest.",
          "App Store Save Outcomes is always zero, and refund request charts cover the App Store only.",
          "Charts are computed per request, so very large projects will need daily rollups.",
        ],
      },
    ],
    faq: [
      {
        q: "What subscription metrics does RevenueDot track?",
        a: "RevenueDot has 43 charts. They include MRR, ARR, revenue, active subscriptions, new paid subscriptions, subscription retention, active trials, trial conversion, initial conversion, churn, refund rate, realized LTV, paywall conversion and ad revenue. Each has a written formula and an API name.",
      },
      {
        q: "How does RevenueDot calculate MRR?",
        a: "At the end of each period, every paid subscription with access counts its price normalized to one month: a year divides by 12, a week multiplies by 4, and so on. Cancelled subscriptions count until they expire, trials count zero, and sandbox purchases are excluded.",
      },
      {
        q: "Can I get chart data through an API?",
        a: "Yes. GET /v2/projects/{project_id}/charts/{chart_name} returns time series and cohort tables with RevenueCat's parameters and response shape, so scripts written for RevenueCat's charts API keep working. A secret key with the charts_metrics:charts:read permission is required.",
      },
      {
        q: "Does RevenueDot exclude sandbox and test purchases from charts?",
        a: "Yes. Sandbox and Test Store purchases are excluded from every money and subscription number. Switch on Sandbox data, or send environment=sandbox to the API, to see only sandbox purchases instead.",
      },
      {
        q: "Can I reproduce a chart in my own database?",
        a: "For 8 core charts, yes. RevenueDot publishes the SQL for revenue, transactions, refunds, new trials, new customers, active subscriptions, active trials and MRR, and a test checks that the SQL equals the API. For anything else, use scheduled data exports to your own bucket.",
      },
    ],
    docs: [
      { href: "/docs/guides/charts", label: "Charts guide with every definition" },
      { href: "/docs/api/rest-v2", label: "REST API v2: charts" },
      { href: "/docs/guides/integrations", label: "Scheduled data exports" },
    ],
    related: ["/charts", "/charts/mrr", "/charts/revenue", "/features/ads", "/features/refund-control", "/integrations/data-exports", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "web-billing",
    section: "features",
    name: "Web billing",
    card: "Sell app subscriptions on the web with Stripe Checkout on your own account, then send buyers to the app.",
    label: "Feature",
    title: "Web checkout for iOS and Android apps with Stripe",
    metaTitle: "Web Checkout for Mobile Apps with Stripe",
    metaDescription:
      "Sell app subscriptions on the web with hosted Stripe Checkout on your own Stripe account. Web products, purchase links, funnels and a link back into the app.",
    answer:
      "RevenueDot hosts web checkout for your app's subscriptions and runs every payment on your own Stripe account. You connect Stripe with a restricted key, create web products, put them in an offering, and share a purchase link or a funnel. Buyers pay on Stripe Checkout and open the app with a redemption link, so you write no checkout code.",
    shot: {
      src: "web/web.png",
      alt: "The RevenueDot Web page with one Stripe provider named Scanner Web, a four-step checklist with every step ticked (connect Stripe, add a web config, create web products and prices, create an offering), and a table of web products starting with Pro monthly at $9.99 a month with a 7-day free trial.",
      caption: "The Web page: four checks, then you can share a purchase link or publish a funnel.",
    },
    points: [
      { title: "Your Stripe account", text: "Products, prices, coupons and Checkout Sessions are created in your Stripe account. Money goes to you." },
      { title: "Four setup steps", text: "Connect Stripe, add a web config, create web products and put them in an offering. The Web page checks each one." },
      { title: "Same entitlements", text: "A web purchase is recorded like any Stripe purchase, so entitlements, webhooks, integrations and charts work as before." },
      { title: "Back into the app", text: "The buyer opens a redemption link, and the SDK's redeemWebPurchase moves the purchase to the app user." },
    ],
    blocks: [
      {
        h2: "How to sell app subscriptions on the web with Stripe",
        label: "Steps",
        paras: ["Open **Web** in the dashboard and work through the checklist. You need a Stripe account and a RevenueDot project with your app."],
        steps: [
          { name: "Connect Stripe", text: "Add a web provider and pick Stripe, then save a restricted API key from your Stripe Dashboard. Add the RevenueDot webhook endpoint in Stripe and select checkout.session.completed." },
          { name: "Add a web config", text: "Set the app name, logo, theme colors, Terms and Privacy links, support email, your app's URL scheme and what happens after payment." },
          { name: "Create web products", text: "RevenueDot creates a Stripe Product and a Price in your account and a RevenueDot product whose store identifier is the Stripe price id. You can also use a price you already have." },
          { name: "Put web products in an offering", text: "A package can hold your App Store product, your Google Play product and your web product. The web pages show the packages that have a web product." },
          { name: "Share a link or publish a funnel", text: "Send buyers to a purchase link or a funnel. They pay on Stripe Checkout and get a redemption link on the success page and by email." },
        ],
      },
      {
        h2: "How does a web purchase reach the app?",
        bullets: [
          "The buyer opens a purchase link or funnel and picks a plan.",
          "RevenueDot creates a Stripe Checkout Session with your key and sends the buyer to Stripe's payment page.",
          "Stripe returns the buyer to the success page. RevenueDot reads the session from Stripe and records the purchase once, whichever of the success page or the webhook arrives first.",
          "The buyer opens the redemption link, the app calls `redeemWebPurchase`, and the entitlement is active.",
          "If the page already knows the app user id (`?app_user_id=` or the iOS SDK's web checkout), the purchase goes straight to that user and no redemption is needed.",
        ],
        paras: ["Each purchase arrives as `INITIAL_PURCHASE` (`TRIAL` during a trial) or `NON_RENEWING_PURCHASE` with `store: STRIPE`. Renewals, cancellations and refunds follow from Stripe's webhooks."],
      },
      {
        h2: "How do you create a web product with the API?",
        paras: [
          "Billing periods are `P1W`, `P1M`, `P3M`, `P6M` and `P1Y`. `trial_days` adds a free trial to each checkout. `type` is `subscription`, `consumable` or `non_consumable`.",
        ],
        code: {
          title: "Create a web product",
          label: "curl",
          code: `curl -s -X POST "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/apps/$APP_ID/web_products" \\
  -H "Authorization: Bearer $SECRET_KEY" -H "Content-Type: application/json" \\
  -d '{"display_name":"Pro monthly","type":"subscription","price":{"amount":9.99,"currency":"USD"},"duration":"P1M","trial_days":7,"entitlement_ids":["entl1a2b3c4d5e"]}'`,
        },
      },
      {
        h2: "Which Stripe key permissions does web billing need?",
        paras: ["Create a restricted key in your Stripe Dashboard and leave everything else at None. Web billing needs write access because RevenueDot creates products, prices, Checkout Sessions, coupons and promotion codes for you."],
        table: {
          head: ["Stripe resource", "Permission"],
          rows: [
            ["Products", "Write"],
            ["Prices", "Write"],
            ["Checkout Sessions", "Write"],
            ["Coupons", "Write"],
            ["Promotion Codes", "Write"],
            ["Subscriptions, Invoices, Charges, Customers", "Read"],
          ],
        },
      },
      {
        h2: "What does the buyer see, and can you use your own domain?",
        bullets: [
          "Pages use your logo, app name and colors, with your Terms, Privacy and support links.",
          "The success page shows Open the app and the App Store and Google Play buttons. With `success_mode: redirect`, RevenueDot sends the buyer to your own page with the redemption link in the query.",
          "Buyers can use a discount code or get an automatic discount. See web discounts in the docs.",
          "Pages live at `/pay/<project>/<page>` on the API host, or on a custom domain you verify with a CNAME and a TXT record.",
          "Use a test-mode Stripe key first. Purchases are then sandbox data, kept out of production charts.",
        ],
        paras: ["Check the App Store and Google Play rules for linking to external purchases in each country before you send buyers from inside an app to web checkout."],
      },
      {
        h2: "What is not built yet?",
        bullets: [
          "Connect with Stripe (OAuth) is built but not switched on for RevenueDot Cloud yet. Until it is, you paste a restricted key and a webhook signing secret.",
          "Paddle as a web provider.",
          "An embedded checkout, such as Stripe Elements on your own page, and the purchases-js in-SDK Web Billing checkout. RevenueDot's checkout is a hosted page.",
          "Apple Pay domain registration for a custom domain.",
        ],
      },
    ],
    howTo: "How to sell app subscriptions on the web with Stripe",
    faq: [
      {
        q: "How do I add web payments to my iOS app?",
        a: "Connect your Stripe account to RevenueDot with a restricted key, create web products, put them in an offering, and share a purchase link or publish a funnel. Buyers pay on a hosted Stripe Checkout page and open your app with a redemption link. The app calls the SDK's redeemWebPurchase to activate the entitlement.",
      },
      {
        q: "Does RevenueDot use my own Stripe account?",
        a: "Yes. Every product, price, coupon and Checkout Session is created in your Stripe account, and the money goes to you. RevenueDot stores the restricted key encrypted and reads the session back from Stripe to record each purchase.",
      },
      {
        q: "How does a web buyer get the subscription in my app?",
        a: "Through a redemption link. The success page shows it and RevenueDot emails it. Opening it launches your app, and the app passes it to redeemWebPurchase, which moves the purchase to the signed-in user. If you send buyers a link with app_user_id, they need no redemption.",
      },
      {
        q: "Can I give discounts at web checkout?",
        a: "Yes. Each web discount is a Stripe coupon and each code a Stripe promotion code in your account. Buyers can type a code, or a purchase link or funnel can apply a discount automatically. RevenueDot checks expiry, caps, plan and eligibility.",
      },
      {
        q: "Does RevenueDot support Paddle or other web payment providers?",
        a: "RevenueDot tracks Paddle Billing purchases that your backend posts, with Paddle's signed notifications. Its own hosted checkout, purchase links and funnels run on Stripe only: Paddle as a checkout provider, Connect with Stripe through OAuth and an embedded checkout are not built.",
      },
    ],
    docs: [
      { href: "/docs/guides/web-billing", label: "Sell on the web with Stripe" },
      { href: "/docs/guides/purchase-links", label: "Purchase links" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/guides/web-discounts", label: "Web discounts" },
      { href: "/docs/guides/custom-domains", label: "Custom domains" },
    ],
    related: ["/features/funnels", "/features/purchase-links", "/features/paywalls", "/stores/stripe", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "funnels",
    section: "features",
    name: "Web-to-app funnels",
    card: "Build quiz, email and paywall funnels on the web, take payment on Stripe and send buyers to your app.",
    label: "Feature",
    title: "Web-to-app onboarding funnels with Stripe checkout for mobile apps",
    metaTitle: "Web-to-App Funnel Builder for Mobile Apps",
    metaDescription:
      "Build a web funnel with questions, an email step and a paywall, publish it to a public URL, sell on Stripe Checkout and see where visitors drop off.",
    answer:
      "RevenueDot's funnel builder makes a few web screens in a row, such as a quiz, a proof point, an email field, your plans and a success page. You publish it to a public URL, visitors pay on Stripe Checkout, and they open your app with a redemption link. The analytics tab shows where visitors drop off.",
    shot: {
      src: "web/funnel-builder.png",
      alt: "The RevenueDot funnel builder for a funnel named Onboarding funnel. Six steps are listed on the left: two questions, an info step, an email step, a paywall and a success step. A phone preview in the middle shows the question What brings you here with four answers, and the question's title, subtitle and answers are on the right.",
      caption: "The builder: steps on the left, a live phone preview in the middle and step properties on the right.",
    },
    points: [
      { title: "Five step types", text: "Question, info, email, paywall and success, with up to 30 steps and answers that jump to other steps." },
      { title: "Answers become attributes", text: "A question's answer is saved on the customer and moves to the app user when the purchase is redeemed." },
      { title: "Events to your tools", text: "Funnel views, steps and purchases go to webhooks, Segment, Amplitude, Mixpanel, PostHog, Meta, Google Tag Manager, Branch and AppsFlyer." },
      { title: "Drop-off analytics", text: "Views, checkouts, purchases, conversion, revenue and the drop-off of every step." },
    ],
    blocks: [
      {
        h2: "How to publish a web-to-app funnel",
        label: "Steps",
        paras: ["First finish the four web billing steps: Stripe connected, a web config, web products and an offering. A funnel's paywall step sells that offering's web products."],
        steps: [
          { name: "Create a funnel", text: "Open Funnels and select Create funnel. Start from the starter (a question, an info step, an email step, the paywall and the success step), from a blank funnel, or describe it and use Build with AI." },
          { name: "Edit the steps", text: "Add, reorder, duplicate and delete steps. Set each step's text, the theme colors and the answers. Send an answer to another step with its next field to build paths." },
          { name: "Check the preview", text: "The phone preview is the real page with your web prices. Discount codes and payments run only on the public page." },
          { name: "Publish", text: "Select Publish. A funnel needs one paywall step and one success step, with the paywall before the success step and the success step last." },
          { name: "Share the URL", text: "The funnel lives at a public URL such as https://api.revenuedot.app/pay/scanner/focus-quiz, or on your own domain. Add ?app_user_id=, ?email= or ?code= to pre-fill them." },
        ],
      },
      {
        h2: "What does a funnel look like as JSON?",
        paras: ["The builder edits a JSON document, the same one the API reads and writes. A save checks that ids are unique, every next names a step that exists, and colors are valid."],
        code: {
          title: "funnel-draft.json",
          label: "JSON",
          code: `{
  "theme": { "background": "#FFFFFF", "text": "#0A0A0A", "accent": "#0A0A0A", "button_text": "#FFFFFF", "corner_radius": 0 },
  "steps": [
    { "id": "goal", "type": "question", "title": "What do you want to get done?", "attribute": "goal",
      "options": [
        { "id": "focus", "label": "Focus on deep work" },
        { "id": "sleep", "label": "Sleep better", "next": "sleep_tip" }
      ] },
    { "id": "plan", "type": "info", "title": "Your plan is ready", "body": "Your daily plan is set." },
    { "id": "sleep_tip", "type": "info", "title": "Better sleep starts tonight", "body": "A short routine helps most people." },
    { "id": "email", "type": "email", "title": "Where should we send your plan?", "required": true },
    { "id": "paywall", "type": "paywall", "title": "Choose your plan", "offering": "web", "highlight_package": "$rc_annual", "allow_codes": true },
    { "id": "success", "type": "success", "title": "You are in", "body": "Open the app to start.", "show_redemption": true }
  ]
}`,
        },
      },
      {
        h2: "How do you see where funnel visitors drop off?",
        paras: [
          "The Analytics tab, or `GET /v2/projects/{project_id}/funnels/{funnel_id}/analytics?days=7`, shows views, checkouts, purchases, conversion (purchases divided by views) and revenue in US dollars. Every step shows how many sessions saw and finished it and its drop-off, from 0 to 1.",
        ],
        shot: {
          src: "web/funnel-analytics.png",
          alt: "The Analytics tab of the published Onboarding funnel for 30 days: cards for views 1, checkouts 1, purchases 1, conversion 100% and revenue $59.99, then a table of the six steps with viewed, completed, a completion bar and drop-off, and a views-per-day chart.",
          caption: "Step-by-step completion and drop-off for a published funnel (demo data).",
        },
      },
      {
        h2: "Which funnel events can go to analytics and ad tools?",
        paras: [
          "The page records `funnel_viewed`, `step_viewed`, `step_completed`, `checkout_started` and `purchase`. Three of them are RevenueDot event types you opt in to on a webhook or integration: `FUNNEL_VIEWED`, `FUNNEL_STEP_COMPLETED` and `FUNNEL_PURCHASE`.",
        ],
        bullets: [
          "Segment, Amplitude, Mixpanel and PostHog get them as `rd_funnel_viewed`, `rd_funnel_step_completed` and `rd_funnel_purchase`.",
          "Meta, Google Tag Manager, Branch and AppsFlyer get them as web events with the visitor's browser and ad click ids, so campaigns learn which clicks led to purchases.",
          "An email step reports only `provided` or `skipped`, never the address. Visitors whose browser sends Global Privacy Control get no IP address, user agent or click ids.",
        ],
      },
      {
        h2: "What is not built yet?",
        bullets: [
          "A/B tests of funnel steps, a funnel template gallery and image upload. Use an https image URL.",
          "Funnel events for Adjust, Kochava, Singular, Tenjin and Airbridge. They match people by mobile device ids, which a web visitor does not have.",
        ],
      },
    ],
    howTo: "How to publish a web-to-app funnel",
    faq: [
      {
        q: "What is a web-to-app funnel for a mobile app?",
        a: "It is a short sequence of web pages, usually a quiz, a proof point, an email field and a paywall, that sells your app's subscription before the visitor installs the app. The visitor pays on the web, then opens the app and the purchase is linked to their account.",
      },
      {
        q: "How do web funnel buyers get access in the app?",
        a: "After payment they get a redemption link on the success page and by email. The link opens your app, the app calls the SDK's redeemWebPurchase, and RevenueDot merges the anonymous web buyer into the app user, along with the quiz answers saved as attributes.",
      },
      {
        q: "Can I build the funnel with AI?",
        a: "Yes. Select Build with AI and describe who the funnel is for, the questions and the offer. RevenueDot returns a funnel it has checked and repaired, and opens it as a draft for you to edit. Nothing is published until you publish it.",
      },
      {
        q: "Can I send funnel events to Meta or Google Ads?",
        a: "Yes, through the Meta, Google Tag Manager, Branch and AppsFlyer integrations. Funnel events are opt-in: add funnel_viewed, funnel_step_completed and funnel_purchase to the integration's event types. They carry ad click ids from the landing URL when the visitor has not opted out.",
      },
      {
        q: "Can I A/B test funnel steps?",
        a: "Not yet. You can run two funnels at different URLs and compare their analytics, and you can A/B test the offerings your apps use. Step-level tests inside one funnel are not built.",
      },
    ],
    docs: [
      { href: "/docs/guides/funnels", label: "Funnels guide" },
      { href: "/docs/guides/web-billing", label: "Sell on the web with Stripe" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/guides/integrations", label: "Funnel events to ad networks" },
    ],
    related: ["/features/web-billing", "/features/purchase-links", "/integrations/meta-ads", "/integrations/segment", "/features/charts", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "purchase-links",
    section: "features",
    name: "Purchase and redemption links",
    card: "Share a hosted checkout link for an offering, then let web buyers open your app with a redemption link.",
    label: "Feature",
    title: "Checkout links for app subscriptions: purchase links and redemption links",
    metaTitle: "Purchase Links and Redemption Links for Apps",
    metaDescription:
      "Share a hosted Stripe checkout link for one offering with ?app_user_id=, ?email= and ?code=. Buyers open your app with a redemption link and get access.",
    answer:
      "A RevenueDot purchase link is a hosted checkout page for one offering, which you put in emails, ads, QR codes or your website. Buyers pay on Stripe Checkout. A redemption link then opens your app and passes the purchase to the SDK's redeemWebPurchase, which moves it to the app user so the entitlement is active.",
    shot: {
      src: "web/pay-link.png",
      alt: "A hosted RevenueDot purchase page titled Go Pro on the web. A Monthly plan at $9.99 per month with a 7-day free trial is selected, an Annual plan at $59.99 per year has a Save 50% badge, a Have a discount code link sits below, and a Continue to payment button is at the bottom.",
      caption: "A purchase link for an offering with a monthly and an annual web plan.",
    },
    points: [
      { title: "One link per offering", text: "The page shows the offering's web plans, the trial and a Save badge for the cheapest monthly price." },
      { title: "Prefill with the URL", text: "?app_user_id= buys for a signed-in user, ?email= pre-fills the email and ?code= pre-fills a discount code." },
      { title: "Expiry and discounts", text: "Links can expire, be turned off and carry an automatic web discount." },
      { title: "Redeem in one call", text: "The SDK parses the redemption link and RevenueDot answers success, invalidToken, purchaseBelongsToOtherUser or expired." },
    ],
    blocks: [
      {
        h2: "How to share a checkout link for an offering",
        label: "Steps",
        paras: ["First finish the four web billing steps: Stripe connected, a web config, web products and an offering that holds them."],
        steps: [
          { name: "Create the link", text: "In the dashboard open Funnels, then Purchase links, then Create purchase link. Pick the offering and name the link. The slug becomes the end of the address." },
          { name: "Copy the URL", text: "The address is the pay base, the project slug and the link slug, such as https://api.revenuedot.app/pay/scanner/spring-sale, or your own domain once verified." },
          { name: "Add parameters for known users", text: "Use Copy link for a signed-in user, or add ?app_user_id=user_123 yourself. The purchase then goes straight to that customer." },
          { name: "Set an expiry or a discount", text: "Set expires_at to stop the link on a date, or discount_id to apply a web discount to every checkout without a code." },
          { name: "Watch the counters", text: "Each link counts the checkouts started and the purchases paid." },
        ],
      },
      {
        h2: "How do you create a purchase link with the API?",
        paras: ["An expired or turned-off link answers 410 with a page that says the link has expired. The key needs `project_configuration:offerings:read_write`."],
        code: {
          title: "Create a purchase link",
          label: "curl",
          code: `curl -s -X POST "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/purchase_links" \\
  -H "Authorization: Bearer $SECRET_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"Spring sale","offering_id":"ofrngm2u3h89blc","slug":"spring-sale"}'`,
        },
      },
      {
        h2: "Which URL parameters does a purchase link take?",
        table: {
          head: ["Parameter", "What it does"],
          rows: [
            ["?app_user_id=user_123", "Buys for this app user id. The purchase goes straight to that customer, so no redemption link is needed."],
            ["?email=ana@example.com", "Pre-fills the email. Stripe Checkout shows it and the receipt goes there."],
            ["?code=SPRING20", "Pre-fills a discount code and checks it at once."],
          ],
          caption: "Put your app's real user id in app_user_id, the same one you pass to Purchases.logIn.",
        },
      },
      {
        h2: "How does a redemption link open your app?",
        paras: [
          "A buyer who paid without an app user id gets a deep link such as `scanner://redeem_web_purchase?redemption_token=rdrt_...` and an https link at `/pay/r/<token>` for emails and QR codes. Register your URL scheme in the app, then pass the link to the SDK. The link works for 24 hours by default, and only the token's hash is stored.",
          "The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `RevenueCat` and calls `Purchases`. It sends every request to RevenueDot and needs no RevenueCat account.",
        ],
        code: {
          title: "ContentView.swift",
          label: "Swift",
          code: `import RevenueCat
import SwiftUI

struct ContentView: View {
    var body: some View {
        HomeView()
            .onOpenURL { url in
                // Only redemption links parse; other deep links return nil.
                guard let redemption = url.asWebPurchaseRedemption else { return }
                Task {
                    switch await Purchases.shared.redeemWebPurchase(redemption) {
                    case let .success(customerInfo):
                        print("Active:", customerInfo.entitlements.active.keys)
                    case .invalidToken, .purchaseBelongsToOtherUser, .expired, .error:
                        print("Show a message and offer help.")
                    }
                }
            }
    }
}`,
        },
      },
      {
        h2: "What happens when a redemption link is invalid or expired?",
        table: {
          head: ["SDK result", "Server answer", "What happened"],
          rows: [
            ["success", "200, customer info", "The purchase is on the app's user. A retry by the same customer also succeeds."],
            ["invalidToken", "400, code 7849", "The token is unknown, malformed or from another project."],
            ["purchaseBelongsToOtherUser", "400, code 7852", "Another customer already redeemed it."],
            ["expired", "400, code 7853", "The link is too old. RevenueDot emails a new link, at most once an hour per purchase."],
            ["error", "401, 5xx or no network", "Show an error and let the buyer try again."],
          ],
        },
        paras: ["Redeeming merges the anonymous web buyer into the app user, the same way `logIn` merges an anonymous customer, and RevenueDot sends one `PURCHASE_REDEEMED` webhook."],
      },
    ],
    howTo: "How to share a checkout link for an offering",
    faq: [
      {
        q: "How do I share a checkout link for my app's subscription?",
        a: "Create a purchase link for an offering in the RevenueDot dashboard and share its URL, such as https://api.revenuedot.app/pay/scanner/spring-sale. The page shows the offering's web plans and sends buyers to Stripe Checkout. Add ?app_user_id= to buy for a signed-in user.",
      },
      {
        q: "How do I redeem a web purchase in my iOS or Android app?",
        a: "Register a URL scheme, parse the incoming link with asWebPurchaseRedemption on iOS or Android, and call redeemWebPurchase. The purchase moves to the app's user and the entitlement becomes active at once. The result is success, invalidToken, purchaseBelongsToOtherUser, expired or error.",
      },
      {
        q: "What if the redemption link expires?",
        a: "Redeeming an expired link makes RevenueDot email a fresh link and answer expired with the buyer's email in an obfuscated form. The old link keeps answering expired, so the app can always tell the buyer to check their email. A buyer who gave no email needs support.",
      },
      {
        q: "Can a purchase link have an expiry date?",
        a: "Yes. Set expires_at when you create or update the link, or turn the link off. An expired or turned-off link answers 410 with a page that says the link has expired, and starting a checkout from it also answers 410.",
      },
      {
        q: "Do I need redemption if the buyer is already signed in to my app?",
        a: "No. If the link carries the app user id, for example from an email or an in-app button, the purchase goes straight to that customer. Redemption is for anonymous web buyers.",
      },
    ],
    docs: [
      { href: "/docs/guides/purchase-links", label: "Purchase links" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/guides/web-billing", label: "Sell on the web with Stripe" },
      { href: "/docs/guides/web-discounts", label: "Web discounts" },
    ],
    related: ["/features/web-billing", "/features/funnels", "/features/webhooks", "/sdks/ios", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "refund-control",
    section: "features",
    name: "Refund Control",
    card: "Answer Apple's CONSUMPTION_REQUEST in time with your refund preference, chosen by ordered policies.",
    label: "Feature",
    title: "Apple refund request handling for iOS apps: answer CONSUMPTION_REQUEST automatically",
    metaTitle: "Answer Apple Refund Requests (CONSUMPTION_REQUEST)",
    metaDescription:
      "Answer Apple's CONSUMPTION_REQUEST within 12 hours with consumption data and your refund preference, chosen by ordered policies. Track refund rate and amounts.",
    answer:
      "When a customer asks Apple for a refund, Apple sends your server a CONSUMPTION_REQUEST and gives you 12 hours to answer. RevenueDot's Refund Control answers for you. Ordered policies on customer conditions pick your refund preference, RevenueDot sends Apple the consumption data from its own records, and cards show refund rate, amounts and counts.",
    shot: {
      src: "lifecycle/refund-control.png",
      alt: "The RevenueDot Refund Control page. Cards show a 43% refund rate (3 of 7 decided requests refunded), $64.96 in refund requests and 4 requests. Four policy templates follow (first purchase date, platform, recent renewal, create your own), then ordered policies such as Renewed in the last day with Prefer full refund and Spent over $40 with Prefer no refund.",
      caption: "Policies are checked from the top. The first one a customer matches decides the answer.",
    },
    points: [
      { title: "Four policy templates", text: "First purchase date, platform, recent renewal, or any condition the audience builder knows." },
      { title: "Apple's 12-hour deadline", text: "Failed sends retry after 5 minutes, 15 minutes and then hourly, and stop 5 minutes before the deadline." },
      { title: "Consent first", text: "Nothing goes to Apple until you confirm customers agreed to share consumption data." },
      { title: "Every store in the cards", text: "Refund rate, amounts and counts include Google Play voids and chargebacks, Stripe refunds and Amazon refunds." },
    ],
    blocks: [
      {
        h2: "How to answer Apple refund requests automatically",
        label: "Steps",
        paras: ["Connect the App Store with the app's In-App Purchase key and turn on App Store Server Notifications version 2. RevenueDot sends the answer with the same key."],
        steps: [
          { name: "Confirm consent", text: "Open Lifecycle, then Refund control, and tick that customers agreed to share consumption data with Apple. Apple requires the consent, and RevenueDot sends nothing until you confirm it." },
          { name: "Add policies", text: "Start from First purchase date, Platform, Recent renewal or Create your own. Recent renewal covers customers who renewed or converted from a free trial in the last 24 hours." },
          { name: "Choose a refund preference", text: "Pick Prefer full refund, Prefer no refund, Send consumption data only, or Do not respond for each policy and for the default policy." },
          { name: "Order the policies", text: "Drag policies into order. The first policy whose conditions match the customer decides. Each card shows how many of your customers it would decide for." },
          { name: "Save", text: "Select Save. The next CONSUMPTION_REQUEST is answered with these rules." },
        ],
      },
      {
        h2: "What does RevenueDot send to Apple?",
        paras: [
          "For each request RevenueDot builds Apple's ConsumptionRequestV1 body from its own records and sends it with [Send Consumption Information](https://developer.apple.com/documentation/appstoreserverapi/send-consumption-information-v1). A repeated notification for the same purchase is never answered twice.",
        ],
        table: {
          head: ["Field", "How it is set"],
          rows: [
            ["customerConsented", "true, and only sent after you confirm consent"],
            ["consumptionStatus", "Subscriptions: 3 when the period is over, 2 when the customer opened the app after buying, 1 when they never did"],
            ["sampleContentProvided", "true when the customer had a free trial of the product"],
            ["accountTenure", "Days since the customer was first seen, in Apple's buckets"],
            ["lifetimeDollarsPurchased, lifetimeDollarsRefunded", "The customer's USD purchases and refunds, in Apple's buckets"],
            ["playTime, userStatus", "0 and 1 unless your app sets the custom attributes rd_play_time_minutes or rd_user_status"],
            ["refundPreference", "From the policy: 1 full refund, 2 no refund, 0 no preference"],
          ],
        },
      },
      {
        h2: "How do you read refund rate and requests with the API?",
        paras: ["Apple tells you the result: REFUND when it refunds and REFUND_DECLINED when it does not. The cards show the last 28 days, and the table lists each request with the policy used and the outcome."],
        code: {
          title: "Refund Control API",
          label: "curl",
          code: `# Refund rate, amounts and counts
curl -s "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/refund_control/stats" \\
  -H "Authorization: Bearer $SECRET_KEY"

# Each request, newest first, with the policy and the outcome
curl -s "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/refund_requests" \\
  -H "Authorization: Bearer $SECRET_KEY"`,
        },
      },
      {
        h2: "What about Google Play, Stripe and Amazon refunds?",
        paras: [
          "Google Play has no consumption API. A refund or chargeback arrives as a voided purchase and there is nothing to answer. RevenueDot records it as an approved refund request, with the policy that would have applied, so the cards cover every store. Stripe and Amazon refunds are recorded the same way.",
        ],
      },
      {
        h2: "What are the limits of Refund Control?",
        bullets: [
          "Apple makes the refund decision. Your answer is information and a preference, not an instruction.",
          "RevenueDot sends Send Consumption Information V1. Apple's newer V2, with a consumption percentage and prorated refunds, is not used yet.",
          "Policies, previews and counts scan at most the 10,000 most recently seen customers.",
          "App Store Save Outcomes in Charts is always zero until Apple's Retention Messaging API is in use.",
        ],
      },
    ],
    howTo: "How to answer Apple refund requests automatically",
    faq: [
      {
        q: "What is Apple's CONSUMPTION_REQUEST notification?",
        a: "It is an App Store Server Notification sent when a customer asks Apple for a refund. Your server has 12 hours to answer with consumption information, such as how long the customer used the purchase and whether you prefer a refund. Apple uses the answer when it decides.",
      },
      {
        q: "How do I respond to an Apple refund request automatically?",
        a: "Turn on Refund Control in RevenueDot, confirm customer consent, and set policies. RevenueDot builds the consumption data from its records and sends it with your In-App Purchase key, with a refund preference picked by the first policy that matches the customer.",
      },
      {
        q: "Does answering a refund request stop Apple from refunding?",
        a: "No. Apple decides. Your answer gives Apple facts and a preference of full refund, no refund or none. REFUND and REFUND_DECLINED notifications then show the outcome in the cards.",
      },
      {
        q: "Can I handle Google Play refunds the same way?",
        a: "Google Play has no equivalent API, so there is nothing to answer. RevenueDot records Google voids and chargebacks as refund requests so your refund rate covers every store.",
      },
      {
        q: "Do I need to tell customers I share data with Apple?",
        a: "Yes. Apple requires customer consent to send consumption data. Make sure your terms or privacy policy say so. RevenueDot sends nothing until you tick the consent box in Refund control.",
      },
    ],
    docs: [
      { href: "/docs/guides/refund-control", label: "Refund Control guide" },
      { href: "/docs/guides/app-store", label: "Connect the App Store" },
      { href: "/docs/api/extensions", label: "API extensions: Refund Control" },
    ],
    related: ["/features/customer-center", "/features/win-back", "/stores/app-store", "/features/charts", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "win-back",
    section: "features",
    name: "Win-back",
    card: "Email churned subscribers an offer, and record Apple win-back offers on every purchase.",
    label: "Feature",
    title: "Win-back campaigns and Apple win-back offers for lapsed subscribers",
    metaTitle: "Win-Back Campaigns for Lapsed Subscribers",
    metaDescription:
      "Email lapsed subscribers a link back to the store once each, with click tracking and one-click unsubscribe. Apple win-back offers need no extra app code.",
    answer:
      "RevenueDot has two win-back tools. Win-back campaigns email customers whose subscription ended a button back to the store, once per customer, with click tracking and one-click unsubscribe. Apple's iOS 18 win-back offers need no extra app code, because the SDK handles them on the device, and RevenueDot records each offer on the purchase and in webhooks.",
    shot: {
      src: "lifecycle/winback-editor.png",
      alt: "The RevenueDot win-back campaign editor for a campaign named Lapsed Pro subscribers. Counters show sent, opened, clicked, reactivated and revenue. The audience is subscribers whose last subscription ended between 1 and 90 days ago, with product and store tick boxes, and an email preview with a Resubscribe button.",
      caption: "A campaign: audience on the left, an email preview and a count of who would get it today on the right.",
    },
    points: [
      { title: "Once per customer", text: "Each customer gets a campaign's email once. Sandbox purchases never count." },
      { title: "Tracked and compliant", text: "Click tracking, optional open tracking, one-click unsubscribe with RFC 8058 headers and a suppression list." },
      { title: "Reactivation count", text: "Customers who bought or started a trial within 30 days of the email, and their revenue." },
      { title: "Apple offers recorded", text: "offer_code and offer_type on every period, including win_back, in webhooks and exports." },
    ],
    blocks: [
      {
        h2: "How to email lapsed subscribers a win-back offer",
        label: "Steps",
        paras: ["Customers need an email address in the `$email` attribute, which you set with `Purchases.shared.attribution.setEmail(_:)` or the API. Set the Customer Center support email under Lifecycle, then Support, because replies go there."],
        steps: [
          { name: "Create a campaign", text: "Open Lifecycle, then Win-back, and select Create campaign." },
          { name: "Choose the audience", text: "Customers whose last subscription ended between N and M days ago and who have no active subscription. Narrow by products, stores or a saved audience. Preview shows who would get the email today." },
          { name: "Write the email", text: "Add a subject, heading, body and button label. The email goes out under your app's name with an unsubscribe link." },
          { name: "Choose where the button goes", text: "Send App Store customers to their subscriptions page, where Apple lists the win-back offers they can redeem, and Google Play customers to the Play Store page. Or send everyone to your own https link, such as a web checkout." },
          { name: "Schedule and start", text: "Active campaigns send once a day at the UTC hour you choose, to at most 500 customers a day. Send test emails you a sample, and Send now runs the campaign at once." },
        ],
      },
      {
        h2: "What do win-back campaign results show?",
        bullets: [
          "**Sent**, **clicked** and **unsubscribed**.",
          "**Opened**, only when Track opens is on. It adds a 1x1 image to the email.",
          "**Reactivated:** customers who bought or started a trial within 30 days of the email, and the revenue from them.",
        ],
        paras: [
          "Every email has an unsubscribe link. When your server's public URL is https, the email also carries one-click `List-Unsubscribe` and `List-Unsubscribe-Post` headers ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)). An address that unsubscribes never gets another win-back email from the project. A project's campaigns together send at most 2,000 emails in 24 hours.",
        ],
      },
      {
        h2: "How do Apple win-back offers work with RevenueDot?",
        paras: [
          "Win-back offers are discounted or free periods Apple shows to customers whose subscription lapsed, on iOS 18 and later. The SDK, RevenueDot's or RevenueCat's, does the win-back work on the device, so you write no extra code and the offer needs no signature from the server. RevenueDot grants access, records the offer and keeps Apple's eligibility list.",
          "A win-back purchase arrives as a `RENEWAL` with the offer id in `offer_code`. A paid win-back period has `period_type: NORMAL` and a free one has `TRIAL`.",
        ],
        code: {
          title: "RENEWAL webhook (shortened)",
          label: "JSON",
          code: `{
  "api_version": "1.0",
  "event": {
    "type": "RENEWAL",
    "app_user_id": "user_1",
    "product_id": "pro_monthly",
    "period_type": "NORMAL",
    "transaction_id": "2000000007",
    "original_transaction_id": "2000000001",
    "price_in_purchased_currency": 4.99,
    "offer_code": "comeback_50",
    "store": "APP_STORE"
  }
}`,
        },
      },
      {
        h2: "How do you list the win-back offers a customer can redeem?",
        paras: [
          "RevenueDot stores Apple's list of win-back offers each time it reads the renewal info. `offer_ids` is Apple's list, best offer first, and is empty when Apple offers the customer nothing. Use it to send a lapsed customer the offer from your own email tool. This endpoint is a RevenueDot extension.",
        ],
        code: {
          title: "Eligible win-back offers",
          label: "curl",
          code: `curl -s https://api.revenuedot.app/v2/projects/$PROJECT_ID/customers/user_1/win_back_offers \\
  -H "Authorization: Bearer $SECRET_KEY"`,
        },
      },
      {
        h2: "What are the limits of win-back?",
        bullets: [
          "Create the Apple win-back offer in App Store Connect on a subscription App Review has approved. RevenueDot needs the app's In-App Purchase key and App Store Server Notifications turned on.",
          "Google Play has no separate win-back offer type. An offer you build for lapsed subscribers in Play Console arrives with its offer id like any other offer.",
          "Charts have no offer-type dimension yet.",
          "On RevenueDot Cloud, win-back email comes from no-reply@mail.revenuedot.app with Reply-To set to your support email. Custom sending domains are not available.",
        ],
      },
    ],
    howTo: "How to email lapsed subscribers a win-back offer",
    faq: [
      {
        q: "How do I email churned subscribers an offer?",
        a: "Create a win-back campaign in RevenueDot under Lifecycle, then Win-back. Choose customers whose subscription ended between two dates, write the email and pick where the button goes, such as the App Store subscriptions page. RevenueDot sends it daily at your chosen hour and counts who came back.",
      },
      {
        q: "What are Apple win-back offers?",
        a: "They are discounted or free periods that Apple shows to customers whose subscription lapsed, on iOS 18 and later. You create them in App Store Connect. The SDK handles them on the device, and RevenueDot records the offer on the resulting RENEWAL.",
      },
      {
        q: "Does RevenueDot track win-back offer purchases?",
        a: "Yes. Each subscription period and transaction stores its offer type and the store's offer id. Webhooks carry the id in offer_code, and the transaction export has offer and offer_type columns that say win_back.",
      },
      {
        q: "Is it legal to send win-back emails?",
        a: "RevenueDot adds an unsubscribe link and one-click unsubscribe headers, honors unsubscribes for good and sends only to the address you saved on the customer. The rules for consent differ by country, so check them with your own counsel before you send.",
      },
      {
        q: "Can I send win-back offers to Google Play customers?",
        a: "You can email them. The button goes to the Play Store page of their subscription or to your own link. Google Play has no separate win-back offer type, so build the offer in Play Console as a developer-determined offer.",
      },
    ],
    docs: [
      { href: "/docs/guides/win-back-campaigns", label: "Win-back campaigns" },
      { href: "/docs/guides/win-back-offers", label: "Win-back offers" },
      { href: "/docs/guides/app-store", label: "Connect the App Store" },
    ],
    related: ["/features/customer-center", "/features/refund-control", "/features/customer-lists", "/features/webhooks", "/stores/app-store", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "customer-center",
    section: "features",
    name: "Customer Center",
    card: "Retention offers on cancel and refund paths, Apple Retention Messaging and support tickets.",
    label: "Feature",
    title: "Customer Center for iOS and Android apps: retention offers, cancel flows and Apple Retention Messaging",
    metaTitle: "Customer Center: Retention Offers and Cancel Flows",
    metaDescription:
      "Give your app a subscription screen with cancel and refund retention offers, Apple Retention Messaging and support tickets, set up in the RevenueDot dashboard.",
    answer:
      "The Customer Center is a subscription screen inside your app, shown by the RevenueDot SDK and set up in the RevenueDot dashboard. You add a promotional offer to the cancel path or the refund path, so customers see it before they leave. RevenueDot also answers Apple's Retention Messaging API in real time and stores support tickets customers send from the screen.",
    shot: {
      src: "lifecycle/retention-customer-center.png",
      alt: "The RevenueDot Retention Offers page on the Customer Center tab. A Cancellation Retention Discount section lists an offer named Half off for 3 months for the App Store, mapping two Scanner Pro products to offer ids, switched on. A Refunds Retention Discount section below has no offer yet.",
      caption: "A cancellation offer linked to two App Store products. The SDK shows it before the customer cancels.",
    },
    points: [
      { title: "Retention offers", text: "A promotional offer on the cancel path or the refund path, mapped product by product to store offer ids." },
      { title: "Apple Retention Messaging", text: "RevenueDot answers Apple's real-time call within its 700 ms limit, with a message, a switch plan or a promotional offer." },
      { title: "Support tickets", text: "Customers write to you from the Customer Center and the ticket reaches your inbox and the dashboard." },
      { title: "Signed offers", text: "On iOS the SDK asks RevenueDot to sign the promotional offer with the app's In-App Purchase key." },
    ],
    blocks: [
      {
        h2: "How to add a retention offer to the Customer Center",
        label: "Steps",
        paras: ["The Customer Center is the subscription screen the RevenueDot SDK shows in your app, `CustomerCenterView` on iOS and `CustomerCenter` on Android. The RevenueCat SDK shows the same screen. Its configuration comes from RevenueDot."],
        steps: [
          { name: "Create the store offer", text: "Create a promotional offer in App Store Connect, or a developer-determined offer in Google Play Console, on each subscription you want to discount." },
          { name: "Add the offer in RevenueDot", text: "Open Lifecycle, then Retention, then the Customer Center tab. Select New offer under Cancellation Retention Discount or Refunds Retention Discount." },
          { name: "Write what customers see", text: "Give the offer a name, a title and a subtitle, and pick the store." },
          { name: "Link each product to its offer", text: "Map every product to its store offer id, then turn the offer on." },
          { name: "Show the Customer Center in your app", text: "RevenueDot adds the offer to the cancel or refund path in the configuration the SDK reads. The SDK shows it before the customer finishes." },
        ],
      },
      {
        h2: "How do you present the Customer Center in your app?",
        paras: [
          "Present the SDK's view. The RevenueDot SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports `RevenueCatUI` and needs no RevenueCat account. The configuration it reads is `GET /v1/customercenter/{app_user_id}`, served by RevenueDot. Edit it under Lifecycle, then Customer Center: the paths on each screen and their order, Custom URL and Custom Action paths, a cancel feedback survey with an offer per answer, colors for light and dark mode, and custom strings in 33 languages, with a live preview. Without changes, a built-in default is used.",
        ],
        code: {
          title: "SettingsView.swift",
          label: "Swift",
          code: `import RevenueCatUI

struct SettingsView: View {
    @State private var showCustomerCenter = false

    var body: some View {
        Button("Manage subscription") { showCustomerCenter = true }
            .sheet(isPresented: $showCustomerCenter) { CustomerCenterView() }
    }
}`,
        },
      },
      {
        h2: "How does Apple Retention Messaging work in RevenueDot?",
        paras: [
          "Apple calls your server in real time when a customer is about to cancel, and shows the message you pick on its own Confirm Cancellation screen. Apple grants access to the Retention Messaging API on request, so ask for it first.",
        ],
        bullets: [
          "Add messages with a header of up to 66 characters and a body of up to 144. A message can suggest another plan or carry a promotional offer.",
          "Set a default message for each product and locale. Apple shows it when the real-time call fails.",
          "Add real-time rules: for a product, or any product, which message to answer with.",
          "Select Sync to Apple (sandbox). For production, pass Apple's performance test first, then Sync to Apple (production).",
          "RevenueDot checks Apple's signature and app ID on every call and refuses a request signed more than 5 minutes earlier. If a promotional offer cannot be signed, it answers with no message and Apple shows your default.",
        ],
      },
      {
        h2: "How do support tickets from the Customer Center work?",
        paras: [
          "Under Lifecycle, then Support, turn on Let customers create tickets, enter your support email and choose which customers may write and which details the email includes. A customer can send 5 tickets an hour, one device 20, and the whole project 100, so a leaked SDK key cannot flood your inbox. The Support feature page covers Intercom and Zendesk.",
        ],
      },
      {
        h2: "What is not built yet?",
        bullets: [
          "Apple's Retention Messaging API needs Apple's approval, which RevenueDot cannot grant for you.",
          "App Store Save Outcomes in Charts is always zero until Apple's Retention Messaging API is in use.",
        ],
      },
    ],
    howTo: "How to add a retention offer to the Customer Center",
    faq: [
      {
        q: "What is the RevenueCat Customer Center and does it work with RevenueDot?",
        a: "The Customer Center is a subscription management screen inside the RevenueCat SDK, with paths for cancelling, refunds and support. RevenueDot Cloud serves its configuration, so the unmodified SDK shows your retention offers and sends tickets to RevenueDot.",
      },
      {
        q: "How do I show a discount when a customer tries to cancel?",
        a: "Create a promotional offer in App Store Connect or Google Play Console, then add it under Lifecycle, Retention, Customer Center in RevenueDot as a Cancellation Retention Discount and map each product to its offer id. The SDK shows it before the customer finishes cancelling.",
      },
      {
        q: "What is Apple's Retention Messaging API?",
        a: "It lets you show a message, a cheaper plan or a promotional offer on Apple's own Confirm Cancellation screen. Apple calls your server in real time, and RevenueDot answers from your rules within 700 milliseconds. Apple grants access to the API on request.",
      },
      {
        q: "Can I show a retention offer on the refund request path?",
        a: "Yes. Add an offer under Refunds Retention Discount. The SDK offers it when the customer asks for a refund in the Customer Center, before the refund flow continues.",
      },
      {
        q: "Does the Customer Center work on Android?",
        a: "Yes. The SDK's Customer Center runs on iOS and Android, and RevenueDot serves the same configuration to both. A cancellation offer uses a developer-determined offer in Google Play Console.",
      },
    ],
    docs: [
      { href: "/docs/guides/retention", label: "Retention offers guide" },
      { href: "/docs/guides/support-integrations", label: "Support tickets and help desks" },
      { href: "/docs/guides/app-store", label: "Connect the App Store" },
    ],
    related: ["/features/refund-control", "/features/win-back", "/features/support", "/stores/app-store", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "customer-lists",
    section: "features",
    name: "Customer lists",
    card: "Filter customers, save audiences and export a CSV from the Customers page.",
    label: "Feature",
    title: "Customer lists, saved audiences and CSV export for subscription apps",
    metaTitle: "Customer Lists, Audiences and CSV Export",
    metaDescription:
      "Slice your subscribers into lists, filter by country, platform, spend or attributes, save the filter as an audience and export it to CSV for your team.",
    answer:
      "RevenueDot's Customers page has built-in lists for all customers, active subscribers, sandbox, non-subscription and expired customers. You can filter any list with the audience condition builder, save the filter as an audience, and export the list as CSV. Saved audiences feed targeting rules, experiments, refund policies and win-back campaigns.",
    shot: {
      src: "lifecycle/customers.png",
      alt: "The RevenueDot Customers page. A left rail lists All customers, Active subscribers, Sandbox, Non-subscription and Expired, and a New audience link. Four cards show 53 customers, 2 trialing subscribers, 7 paid subscribers and $244.67 total revenue, above a table with subscription status, auto-renewal, first and last seen, spent and latest purchase.",
      caption: "Lists, four summary cards, search, Filter, Save audience and Export all.",
    },
    points: [
      { title: "Five built-in lists", text: "All customers, active subscribers, sandbox, non-subscription and expired." },
      { title: "Any condition", text: "Country, platform, app version, status, entitlements, spend, first or last seen, last renewal, email, attribution and custom attributes." },
      { title: "Saved audiences", text: "One saved filter reaches targeting rules, experiments, refund policies and win-back campaigns." },
      { title: "CSV export", text: "Export all downloads app user id, email, status, spend, store, country and platform." },
    ],
    blocks: [
      {
        h2: "Which customer lists does RevenueDot have?",
        table: {
          head: ["List", "Who is in it"],
          rows: [
            ["All customers", "Everyone the SDK or a store notification has told RevenueDot about"],
            ["Active subscribers", "Customers with an active production subscription, trials included"],
            ["Sandbox", "Customers with a sandbox purchase"],
            ["Non-subscription", "Customers with a production one-time purchase"],
            ["Expired", "Subscribers whose production subscriptions have all ended"],
            ["Your audiences", "Audiences you saved here or under Targeting"],
          ],
        },
        paras: ["Four cards sum up the list: customers, trialing subscribers, paid subscribers and total revenue (production, in USD)."],
      },
      {
        h2: "How do you filter customers and save an audience?",
        paras: [
          "Select Filter and add conditions. Conditions in a group must all match, and groups are alternatives. Search matches part of an app user id or an email. Save audience keeps the filter, and it appears in the rail.",
        ],
        bullets: [
          "Country, platform, app version and subscription status.",
          "Entitlements, total spent, first or last seen, first purchase and last renewal.",
          "Email, attribution (campaign, media source) and any custom attribute.",
          "Use the saved audience in targeting rules, experiments, refund policies and win-back campaigns.",
        ],
      },
      {
        h2: "How do you export a customer list to CSV?",
        paras: [
          "Export all downloads the list as CSV with app user id, email, subscription status, auto-renewal status, first and last seen, spent, latest product, store and purchase date, country and platform. The same export is available through the API with the list name.",
        ],
        code: {
          title: "Export active subscribers",
          label: "curl",
          code: `curl -s "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/customer_lists/export?list=active" \\
  -H "Authorization: Bearer $SECRET_KEY"`,
        },
      },
      {
        h2: "What are the limits of customer lists?",
        bullets: [
          "Lists look at the 10,000 most recently seen customers. On a larger project the cards say so.",
          "For every customer, use scheduled data exports of customers, subscriptions, transactions and events to your own bucket.",
          "The summary cards use production purchases only.",
        ],
      },
    ],
    faq: [
      {
        q: "How do I export my subscribers to CSV?",
        a: "Open Customers in the RevenueDot dashboard, pick a list such as Active subscribers, add filters if you like, and select Export all. The CSV has app user id, email, status, auto-renewal, spend, latest product, store, country and platform. The API offers the same export.",
      },
      {
        q: "How do I find all customers in one country on one platform?",
        a: "Select Filter on the Customers page, add a country condition and a platform condition in the same group, and the list shows customers who match both. Save the filter as an audience to reuse it in targeting and campaigns.",
      },
      {
        q: "What is a saved audience?",
        a: "A saved audience is a named set of customer conditions. RevenueDot uses it in targeting rules, offering experiments, Refund Control policies and win-back campaigns, and recomputes who matches whenever it is used.",
      },
      {
        q: "Can I export more than 10,000 customers?",
        a: "Lists look at the 10,000 most recently seen customers. For a complete export, schedule a data export of customers to Amazon S3, Cloudflare R2 or Google Cloud Storage as CSV or Parquet.",
      },
    ],
    docs: [
      { href: "/docs/guides/customer-lists", label: "Customer lists guide" },
      { href: "/docs/guides/targeting-and-experiments", label: "Audiences and targeting" },
      { href: "/docs/guides/integrations", label: "Scheduled data exports" },
    ],
    related: ["/features/experiments", "/features/refund-control", "/features/win-back", "/integrations/data-exports", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "webhooks",
    section: "features",
    name: "Webhooks",
    card: "Signed webhooks for every purchase, renewal, cancellation and refund, with retries and a delivery log.",
    label: "Feature",
    title: "Subscription webhooks for iOS and Android purchases: signed, retried and logged",
    metaTitle: "Subscription Webhooks for iOS and Android Apps",
    metaDescription:
      "Receive purchase, renewal, cancellation and refund webhooks as signed JSON, retried 5 times, with a delivery log and test events. Same format as RevenueCat's.",
    answer:
      "RevenueDot sends each subscription event, such as a purchase, renewal, cancellation or refund, to your URL as JSON. Each delivery carries an HMAC signature, is retried after 5, 10, 20, 40 and 80 minutes, and shows in a delivery log with a Retry button. Moving from RevenueCat? The payload follows its webhook format, so existing handlers work unchanged.",
    shot: {
      src: "screens/webhooks-light.png",
      dark: "screens/webhooks-dark.png",
      alt: "A RevenueDot webhook, 'Scanner backend', posting to api.scanner.example: deliveries on, production and sandbox, all apps and events, the signature header, and the delivery log of INITIAL_PURCHASE events each delivered with a 200 in a few milliseconds.",
      caption: "A webhook with its delivery log: every event, its response code and how long it took. Captured with example data.",
    },
    points: [
      { title: "Every lifecycle event", text: "Purchases, renewals, cancellations, billing issues, product changes and transfers, each with the customer and the product." },
      { title: "HMAC signature", text: "Verify X-RevenueCat-Webhook-Signature against the raw body. A timestamp stops replays." },
      { title: "Retries and a log", text: "Six attempts in all, each with its status, duration and error, and a Retry button." },
      { title: "Test events", text: "Send a TEST event, or make real events with Test Store scenarios such as renewal, cancel and refund." },
    ],
    blocks: [
      {
        h2: "How to receive and verify a RevenueDot webhook",
        label: "Steps",
        steps: [
          { name: "Add a webhook", text: "In the dashboard open Integrations, then Webhooks, then Add webhook, or call POST /v2/projects/{project_id}/integrations/webhooks. Optionally set an authorization header, an environment and an event filter." },
          { name: "Keep the signing secret", text: "The whsec_ signing secret is shown once, in the answer. Store it as a secret in your backend." },
          { name: "Verify the signature", text: "Read the raw body bytes. The header is t=<unix seconds>,v1=<hex>, where the hex is HMAC-SHA256 of the timestamp, a dot and the raw body, keyed with the secret. Refuse the request if t is more than 5 minutes from your clock." },
          { name: "Answer 200 and deduplicate", text: "Only an HTTP 200 counts as delivered. A delivery can arrive twice, so ignore an event.id you have handled. Keep the handler fast, because RevenueDot waits at most 60 seconds." },
          { name: "Send a test event", text: "Use Send test event in the dashboard. It sends a purchase-shaped TEST event signed like the others." },
        ],
      },
      {
        h2: "What does a webhook delivery look like?",
        paras: ["RevenueDot signs again on every attempt, so `t` is the attempt's time. Every field of every event type is on the webhook events reference."],
        code: {
          title: "A delivery (shortened)",
          label: "HTTP",
          code: `POST /webhooks/revenuedot HTTP/1.1
Content-Type: application/json
User-Agent: RevenueDot-Webhooks/1.0
Authorization: Bearer my-shared-token
X-RevenueCat-Webhook-Signature: t=1790800914,v1=0a1552334e825926036f7efe21527800ea45caa63eca523c6120c6da9041ef99

{"api_version":"1.0","event":{"id":"66339910-3BFF-49F4-B873-D1283D673DE2","type":"INITIAL_PURCHASE","app_user_id":"user_1","product_id":"pro_monthly","entitlement_ids":["pro"],"period_type":"NORMAL","environment":"SANDBOX","store":"TEST_STORE","price":9.99,"currency":"USD","presented_offering_id":"default"}}`,
        },
      },
      {
        h2: "How do you verify the signature in Node.js?",
        code: {
          title: "verify.js",
          label: "Node.js",
          code: `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(rawBody, header, secret, { now = new Date(), toleranceSeconds = 300 } = {}) {
  const match = /(?:^|,)\\s*t=(\\d+)\\s*,\\s*v1=([0-9a-f]{64})\\s*(?:,|$)/.exec(header ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  // Refuse old deliveries so a captured request cannot be replayed.
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(timestamp + ".").update(rawBody).digest();
  const received = Buffer.from(match[2], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}`,
        },
        paras: ["Runnable receivers for Node.js with Express, Next.js, Python with FastAPI and Go are in the examples repository."],
      },
      {
        h2: "Which webhook events does RevenueDot send?",
        bullets: [
          "**Lifecycle:** `INITIAL_PURCHASE`, `RENEWAL`, `CANCELLATION`, `UNCANCELLATION`, `NON_RENEWING_PURCHASE`, `SUBSCRIPTION_PAUSED`, `EXPIRATION`, `BILLING_ISSUE`, `PRODUCT_CHANGE`, `SUBSCRIPTION_EXTENDED`, `REFUND_REVERSED` and `TRANSFER`.",
          "**Price increases:** `PRICE_INCREASE_CONSENT_REQUIRED` and `PRICE_INCREASE_CONSENT_APPROVED`.",
          "**More:** `VIRTUAL_CURRENCY_TRANSACTION`, `EXPERIMENT_ENROLLMENT`, `PURCHASE_REDEEMED` and `TEST`. `SUBSCRIBER_ALIAS` goes only to webhooks whose filter names it.",
          "**Opt-in RevenueDot types for web funnels:** `FUNNEL_VIEWED`, `FUNNEL_STEP_COMPLETED` and `FUNNEL_PURCHASE`.",
          "**Opt-in paywall types from the SDK:** `PAYWALL_IMPRESSION`, `PAYWALL_CLOSE`, `PAYWALL_CANCEL`, `PAYWALL_EXIT_OFFER`, `PAYWALL_COMPONENT_INTERACTED`, `PAYWALL_PURCHASE_INITIATED` and `PAYWALL_PURCHASE_ERROR`.",
          "**Never sent:** `TEMPORARY_ENTITLEMENT_GRANT`, because RevenueDot never grants access it has not verified, and `INVOICE_ISSUANCE`, which only RevenueCat Billing issues.",
        ],
        paras: ["Each webhook can filter by environment, app and event type. Two webhooks each receive every event that matches. Order is not guaranteed, so use the timestamps in the event or fetch the customer's current state."],
      },
    ],
    howTo: "How to receive and verify a RevenueDot webhook",
    faq: [
      {
        q: "How do I verify a RevenueDot webhook signature?",
        a: "Read the raw request body, parse t and v1 from the X-RevenueCat-Webhook-Signature header, refuse the request if t is more than 5 minutes from your clock, then compute HMAC-SHA256 of t, a dot and the raw body with your whsec_ secret and compare it to v1 in constant time.",
      },
      {
        q: "Do RevenueCat webhook handlers work with RevenueDot?",
        a: "Yes. The payload follows RevenueCat's webhook format field for field, and RevenueDot sends 19 of the 21 event types. Only the endpoint URL and the signature secret change. The authorization header setting works the same way.",
      },
      {
        q: "What happens when my webhook endpoint is down?",
        a: "RevenueDot retries after 5, 10, 20, 40 and 80 minutes, six attempts in all, then marks the delivery failed. Only HTTP 200 counts as delivered, and each attempt waits at most 60 seconds. The delivery log shows every attempt, and you can retry a delivery by hand.",
      },
      {
        q: "Can I receive each event only once?",
        a: "Delivery is at least once, so a retry or a lost 200 can send an event twice. Deduplicate on event.id. Order is not guaranteed either, so use the event's timestamps when order matters.",
      },
      {
        q: "How do I test webhooks without a real purchase?",
        a: "Select Send test event in the dashboard for a signed TEST event, or call the test_purchases endpoint with a scenario such as renewal, cancel or refund to produce the matching real events from the Test Store.",
      },
    ],
    docs: [
      { href: "/docs/guides/webhooks", label: "Webhooks guide" },
      { href: "/docs/api/webhook-events", label: "Webhook events reference" },
      { href: "/docs/guides/test-store", label: "Test Store" },
    ],
    related: ["/integrations/webhooks", "/features/integrations", "/features/rest-api", "/features/purchase-links", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "rest-api",
    section: "features",
    name: "REST API",
    card: "REST API v1 and v2 for customers, subscriptions, catalog and charts, described in one OpenAPI document.",
    label: "Feature",
    title: "REST API for in-app purchases and subscriptions: customers, catalog, charts and store actions",
    metaTitle: "REST API for In-App Purchases and Subscriptions",
    metaDescription:
      "Manage customers, subscriptions, products, offerings and charts over REST with scoped secret keys and an OpenAPI 3.1 document. Compatible with RevenueCat's API.",
    answer:
      "RevenueDot's REST API lets your server read and change customers, subscriptions, products, offerings, charts and more, with secret keys that carry permissions. It serves REST API v1 and v2, described in one OpenAPI 3.1 document. Moving from RevenueCat? It covers all 128 operations of RevenueCat's REST API v2 with the same paths and errors, so you change only the base URL and the key.",
    points: [
      { title: "All 128 v2 operations", text: "Projects, apps, products, entitlements, offerings, packages, customers, subscriptions, purchases, charts, discounts and more." },
      { title: "Secret keys with permissions", text: "Each key carries only the permissions you give it, such as customer_information:customers:read_write." },
      { title: "One OpenAPI 3.1 document", text: "Every operation names its source file and permissions, and a script checks the document against the server's routes." },
      { title: "Extensions marked", text: "Operations that exist only in RevenueDot carry x-revenuedot-extension: true." },
    ],
    blocks: [
      {
        h2: "Which APIs does one RevenueDot server answer?",
        paras: [
          "RevenueDot follows RevenueCat's [REST API v2](https://www.revenuecat.com/docs/api-v2) paths, objects, pagination and errors, and adds its own operations for features RevenueCat's API does not have. The reference is generated from the OpenAPI document.",
        ],
        table: {
          head: ["API", "Paths", "Auth", "Operations"],
          rows: [
            ["SDK endpoints and store notifications", "/v1/..., /rcbilling/...", "Public app key", "62"],
            ["REST API v1", "/v1/subscribers/...", "Secret key", "10"],
            ["REST API v2", "/v2/projects/...", "Secret key or dashboard session", "160 in the reference, covering RevenueCat's 128"],
            ["RevenueDot extensions", "/v2/..., /pay/...", "Secret key, session or none", "149"],
            ["Webhooks (sent by RevenueDot)", "Your URL", "HMAC signature", "22 event types"],
          ],
          caption: "Counts come from the RevenueDot API reference.",
        },
      },
      {
        h2: "How to call the REST API with a secret key",
        label: "Steps",
        steps: [
          { name: "Create a secret key", text: "Open API keys in the dashboard or call POST /v2/projects/{project_id}/api_keys. The key starts with sk_ and is shown once. Give it only the permissions it needs." },
          { name: "Set the base URL", text: "Use https://api.revenuedot.app. Send the key as Authorization: Bearer sk_..." },
          { name: "Call an endpoint", text: "Lists return an object, items, next_page and url. limit is 1 to 100 with a default of 20. Follow next_page to page." },
          { name: "Handle errors", text: "Every error has the same body: object, type, message, param, doc_url and retryable, as in RevenueCat's v2. A missing permission answers 403 and names it." },
        ],
      },
      {
        h2: "How do you get a customer with REST API v2?",
        paras: ["Customers are addressed by any of their app user ids. A public app key on a v2 endpoint answers 403, because v2 needs a secret key."],
        code: {
          title: "Get a customer",
          label: "curl",
          code: `curl -s "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/customers/user_1" \\
  -H "Authorization: Bearer $SECRET_KEY"`,
        },
      },
      {
        h2: "How do you grant access with the API?",
        paras: [
          "Grant promotional access until `expires_at`, in epoch milliseconds. A grant ending within 2 hours of an existing grant for the same entitlement changes nothing. REST API v1 has the same action at `POST /v1/subscribers/{app_user_id}/entitlements/{entitlement}/promotional`.",
        ],
        code: {
          title: "Grant an entitlement",
          label: "curl",
          code: `curl -s -X POST "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/customers/user_1/actions/grant_entitlement" \\
  -H "Authorization: Bearer $SECRET_KEY" -H "Content-Type: application/json" \\
  -d '{"entitlement_id":"entl1v0bp6r0qs","expires_at":1830000000000}'`,
        },
      },
      {
        h2: "What do store actions do through the API?",
        bullets: [
          "**Google Play:** cancel, refund and revoke a subscription, defer a renewal, and refund one order or a one-time purchase.",
          "**App Store:** extend a subscription, and extend every active subscriber of a product. Apple does not let a server cancel or refund, so those answer 422 for App Store subscriptions.",
          "**Restore by order id:** find a store purchase by its order id and give it to a customer. It works with Google Play and App Store order ids.",
          "**Create in store:** create a product in App Store Connect, or a Google Play subscription with one listing.",
          "**The 2 invoice operations** exist only for RevenueCat Billing. RevenueDot answers them with responses valid against RevenueCat's spec, so a client never sees an unknown route.",
        ],
      },
    ],
    howTo: "How to call the REST API with a secret key",
    faq: [
      {
        q: "Does RevenueDot have a RevenueCat-compatible REST API?",
        a: "Yes. RevenueDot serves REST API v1 and all 128 operations of RevenueCat's REST API v2, with the same paths, objects, pagination and error format. Existing scripts keep working when you change the base URL and the secret key.",
      },
      {
        q: "How do I authenticate to the RevenueDot API?",
        a: "Send Authorization: Bearer sk_ with a project secret key for REST API v1 and v2. Public app keys, such as appl_ or goog_, are for the SDK endpoints and answer 403 on v2. Secret keys carry permissions, and a key can only create keys with permissions it holds.",
      },
      {
        q: "Is there an OpenAPI spec for RevenueDot?",
        a: "Yes. The OpenAPI 3.1 document is served at revenuedot.app/docs/api/openapi.yaml. Import it into Postman, Insomnia or Bruno, or generate a client. Each operation lists its permissions and the server file that implements it.",
      },
      {
        q: "Can I grant, cancel or refund subscriptions through the API?",
        a: "You can grant promotional access for any store. Cancel, refund and defer work for Google Play subscriptions. For App Store subscriptions, RevenueDot can extend a renewal, but Apple does not let a server cancel or refund.",
      },
      {
        q: "Are there endpoints that RevenueCat does not have?",
        a: "Yes, and they are marked as RevenueDot extensions. They include funnels, purchase links, web products, Refund Control, retention offers, support summaries, data exports, ads and reward rules, and the importer's endpoints.",
      },
    ],
    docs: [
      { href: "/docs/api", label: "API overview" },
      { href: "/docs/api/authentication", label: "Authentication" },
      { href: "/docs/api/rest-v1", label: "REST API v1" },
      { href: "/docs/api/rest-v2", label: "REST API v2" },
      { href: "/docs/api/extensions", label: "Extensions" },
    ],
    related: ["/features/webhooks", "/features/ai-connectors", "/features/migration", "/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "integrations",
    section: "features",
    name: "Integrations",
    card: "36 partner integrations, plus webhooks and scheduled CSV or Parquet exports to your own bucket.",
    label: "Feature",
    title: "Integrations for subscription events: 36 partners plus webhooks and data exports",
    metaTitle: "36 Subscription Integrations and Data Exports",
    metaDescription:
      "Send purchases, trials, renewals and refunds to Segment, Amplitude, Mixpanel, AppsFlyer, Meta, Braze and 30 more, or export CSV or Parquet to S3, R2 or GCS.",
    answer:
      "RevenueDot connects to 36 partners, among them Segment, Amplitude, Mixpanel, PostHog, AppsFlyer, Adjust, Meta, Braze and BigQuery, and sends them every purchase, trial, renewal and refund. Failed sends retry and are logged. Scheduled exports write CSV or Parquet files to Amazon S3, Cloudflare R2 or Google Cloud Storage. Moving from RevenueCat? Events keep RevenueCat's names.",
    shot: {
      src: "screens/integrations-light.png",
      dark: "screens/integrations-dark.png",
      alt: "The RevenueDot Integrations page scrolled to the Analytics section: cards for Amplitude, Mixpanel, PostHog, Segment, Firebase and the other analytics, engagement and attribution tools, each with its connection status.",
      caption: "The Integrations page: one card per tool, with its connection status. Captured with example data.",
    },
    points: [
      { title: "36 partners", text: "Analytics, attribution, marketing, support, ads and BigQuery. Browse them all at /integrations." },
      { title: "Your event names", text: "Each integration has default event names, and most analytics, attribution and marketing integrations let you rename each event to match your tracking plan." },
      { title: "Retries and a delivery log", text: "Each integration retries on the webhook schedule, shows the request and the partner's answer, and replays failed sends." },
      { title: "Scheduled exports", text: "Transactions, customers, subscriptions and events as CSV or Parquet, daily or weekly." },
    ],
    blocks: [
      {
        h2: "Which integrations does RevenueDot have?",
        paras: ["The hub at [/integrations](/integrations) has a page for each one, with setup steps and the events it receives."],
        table: {
          head: ["Category", "Partners"],
          rows: [
            ["Core", "Webhooks, scheduled data exports, [BigQuery](/integrations/bigquery)"],
            ["Analytics", "[Segment](/integrations/segment), [Amplitude](/integrations/amplitude), [Mixpanel](/integrations/mixpanel), [PostHog](/integrations/posthog), Firebase, mParticle, Statsig, Superwall, TelemetryDeck"],
            ["Attribution", "[AppsFlyer](/integrations/appsflyer), Adjust, [Meta](/integrations/meta-ads), Apple Search Ads, Appstack, Asapty, Branch, Google Tag Manager, Kochava, Airbridge, SplitMetrics Acquire, Singular, SolarEngine, Tenjin"],
            ["Marketing", "[Slack](/integrations/slack), Airship, Braze, CleverTap, Customer.io, Discord, Intercom, Iterable, OneSignal"],
            ["Ads", "[Google AdMob](/integrations/google-admob)"],
            ["Support", "[Intercom inbox](/integrations/intercom), Zendesk"],
          ],
        },
      },
      {
        h2: "How to connect an integration",
        label: "Steps",
        steps: [
          { name: "Open Integrations", text: "In the dashboard pick the tool you want from the catalogue." },
          { name: "Paste its key", text: "Paste the partner's key or token. RevenueDot encrypts it on the server and shows only its last four characters afterwards." },
          { name: "Choose what to send", text: "Filter by environment, app and event type, choose gross revenue or revenue after store commission and taxes, and rename events if you need to." },
          { name: "Send a test event", text: "Send test event delivers a TEST event to that integration only. Attribution tools need the customer's device ids, so use a customer whose attributes include them." },
          { name: "Watch the delivery log", text: "Every send shows the request, the partner's answer and Retry. Skipped sends say why, for example that the customer has no $adjustId attribute." },
        ],
      },
      {
        h2: "How do you connect an integration with the API?",
        paras: [
          "Every dashboard action is an API call under `/v2/projects/{project_id}/integrations/partners` with a secret key that has `project_configuration:integrations:read_write`. `GET .../integrations/catalog` lists the fields each tool takes.",
        ],
        code: {
          title: "Connect Amplitude",
          label: "curl",
          code: `curl -s -X POST "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/integrations/partners" \\
  -H "Authorization: Bearer $SECRET_KEY" -H "Content-Type: application/json" \\
  -d '{"type":"amplitude","environment":null,"settings":{"api_key":"'"$AMPLITUDE_KEY"'","region":"us"},"event_names":{"initial_purchase":"Subscribed"}}'`,
        },
      },
      {
        h2: "Which event names do integrations use?",
        table: {
          head: ["What happened", "Segment, Amplitude, Mixpanel, PostHog, AppsFlyer", "Firebase", "Meta"],
          rows: [
            ["Purchase", "rc_initial_purchase_event", "purchase", "Subscribe"],
            ["Free trial starts", "rc_trial_started_event", "rc_trial_start", "StartTrial"],
            ["Trial converts to paid", "rc_trial_converted_event", "purchase", "Subscribe"],
            ["Renewal", "rc_renewal_event", "purchase", "Subscribe"],
            ["Cancellation or refund", "rc_cancellation_event", "rc_cancellation", "none"],
            ["Billing issue", "rc_billing_issue_event", "rc_billing_issue", "none"],
          ],
          caption: "Rename any event on the integration's page. Funnel events are opt-in.",
        },
      },
      {
        h2: "How do scheduled data exports work?",
        bullets: [
          "Files are CSV (gzip) or Parquet, written daily or weekly, as incremental or full exports.",
          "Datasets: transactions with RevenueCat's export columns, customers, subscriptions and events.",
          "Destinations: Amazon S3, Cloudflare R2 and Google Cloud Storage, signed with SigV4 or a service-account JWT. Check bucket tests the credentials, and Run now starts an export.",
          "When an integration's last 10 deliveries fail, or more than half of its attempts in an hour, the project's admins get one email with a link to its delivery log.",
          "Not built yet: export column selection, Azure and email destinations and IAM-role credentials.",
        ],
      },
    ],
    howTo: "How to connect an integration",
    faq: [
      {
        q: "Which tools can RevenueDot send subscription events to?",
        a: "RevenueDot has 36 partner integrations: Segment, Amplitude, Mixpanel, PostHog, Firebase, BigQuery, AppsFlyer, Adjust, Meta, Braze, Slack, Intercom and many more, plus webhooks and scheduled exports. They cover analytics, attribution, marketing, support and ads.",
      },
      {
        q: "Will my Amplitude or Mixpanel charts keep working if I switch from RevenueCat?",
        a: "Yes. RevenueDot uses RevenueCat's event names and reserved attributes, such as rc_initial_purchase_event, $amplitudeUserId and $mixpanelDistinctId, so charts and funnels built on them keep working. Most analytics integrations also let you rename each event on the integration's page.",
      },
      {
        q: "How do I export my subscription data to a data warehouse?",
        a: "Create a scheduled data export to Amazon S3, Cloudflare R2 or Google Cloud Storage, as CSV or Parquet, daily or weekly. Or connect BigQuery, which streams every event into a table as a row, created for you when it does not exist.",
      },
      {
        q: "What happens when a partner's API is down?",
        a: "Timeouts, rate limits and server errors retry after 5, 10, 20, 40 and 80 minutes. Other 4xx answers fail at once because the same request cannot work, and the delivery log lets you fix the setting and replay failed sends.",
      },
      {
        q: "Are my partner API keys safe?",
        a: "API keys and tokens are encrypted on the server and never shown again. The dashboard shows only the last four characters. Set the environment filter to production if you do not want sandbox events to reach a partner.",
      },
    ],
    docs: [
      { href: "/docs/guides/integrations", label: "Integrations and data exports" },
      { href: "/docs/guides/webhooks", label: "Webhooks" },
      { href: "/docs/api/extensions", label: "API extensions: integrations and exports" },
    ],
    related: ["/integrations", "/integrations/webhooks", "/integrations/data-exports", "/integrations/segment", "/integrations/appsflyer", "/features/webhooks", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "ads",
    section: "features",
    name: "Ads",
    card: "Ad revenue next to subscription revenue, and AdMob rewarded ads verified on your server.",
    label: "Feature",
    title: "AdMob ad revenue tracking and server-verified rewarded ads for mobile apps",
    metaTitle: "AdMob Ad Revenue and Verified Rewarded Ads",
    metaDescription:
      "See ad revenue, eCPM and impressions in US dollars next to subscription revenue, and verify AdMob rewarded ads on your server to grant currency or access.",
    answer:
      "RevenueDot shows your app's ad revenue next to its subscription revenue, in US dollars, from the ad events the SDK sends. It also verifies AdMob rewarded ads on the server. Google signs a callback, a reward rule grants in-app currency or a few days of access, and your app only asks whether the reward went through.",
    points: [
      { title: "Ad revenue in dollars", text: "Revenue, impressions, eCPM, clicks, CTR and ad share of revenue, with change from the previous period." },
      { title: "Breakdowns", text: "By network, format, placement, ad unit and mediator, with AdMob ad unit names once connected." },
      { title: "Server-verified rewards", text: "A modified app cannot grant itself a reward, because only a callback signed by Google does." },
      { title: "Reward rules", text: "The first matching rule grants in-app currency or a promotional entitlement for minutes, hours or days." },
    ],
    blocks: [
      {
        h2: "How do you track ad revenue with the SDK?",
        paras: [
          "Ad revenue reaches RevenueDot through the SDK's ad tracker, which posts ad events to `POST /v1/events`. The RevenueDot SDK sends them to RevenueDot. It is built from RevenueCat's open-source SDK (MIT license), so your code calls `Purchases` and needs no RevenueCat account.",
          "Switching from RevenueCat? On iOS the stock RevenueCat SDK sends ad events to the proxy URL. The stock Android SDK sends them to RevenueCat's hosts even with a proxy URL, so use the RevenueDot Android SDK.",
          "Use RevenueCat's AdMob adapter to track loads, impressions, clicks and revenue for you, or call the tracker yourself from any network's or mediator's callbacks.",
        ],
        code: {
          title: "Report one impression's revenue",
          label: "Swift",
          code: `// iOS 15+: report the revenue of one impression from the mediator's paid-event callback.
Purchases.shared.adTracker.trackAdRevenue(AdRevenue(
    networkName: "AdMob", mediatorName: .adMob, adFormat: .rewarded, placement: "level_end",
    adUnitId: "ca-app-pub-3940256099942544/5224354917", impressionId: impressionId,
    revenueMicros: 12_500, currency: "USD", precision: .exact
))`,
        },
      },
      {
        h2: "What does the Ads overview show?",
        bullets: [
          "**Ad revenue**, converted to US dollars at each event's day rate, and **impressions**, **eCPM**, **clicks** and **CTR**.",
          "**Ad share of revenue:** ad revenue divided by ad revenue plus subscription revenue.",
          "A daily chart of ad revenue, impressions or eCPM, or stacked with subscription revenue.",
          "Tables by network, format, placement, ad unit and mediator, for 7, 28 or 90 days or 12 months, with a Sandbox data switch.",
          "Seven ad charts: eCPM, impressions, fill rate, ad monetized customers, clicks, CTR and ARPDAU.",
        ],
      },
      {
        h2: "How to verify AdMob rewarded ads on your server",
        label: "Steps",
        paras: ["Only AdMob's callback is verified today. AppLovin MAX, ironSource and Unity Ads callbacks are not."],
        steps: [
          { name: "Paste the callback URL into AdMob", text: "Open Ads, then Rewards, and copy the AdMob callback URL, https://api.revenuedot.app/v1/ads/admob/ssv on Cloud. In AdMob, turn on Server-side verification for each rewarded ad unit and paste it." },
          { name: "Pass the token in your app", text: "When the ad loads, call generateRewardVerificationToken and pass the token's app user id and custom data to AdMob's server-side verification options." },
          { name: "Add reward rules", text: "Choose what a verified reward grants: a fixed or network-sized amount of in-app currency, or an entitlement for a duration of up to 365 days. Narrow a rule by app, ad unit or reward item. The first rule that matches decides." },
          { name: "Poll for the answer", text: "When the ad's reward callback fires, call pollRewardVerification. The answer is verified, with the reward, or failed with a reason." },
          { name: "Send a test reward", text: "Send a test reward runs the same rules as a real AdMob callback for an app user id you enter, without an ad. The currency or access is granted for real." },
        ],
      },
      {
        h2: "How does the app ask for a reward?",
        code: {
          title: "RewardedAd.swift",
          label: "Swift",
          code: `// After the rewarded ad loads
let token = Purchases.shared.generateRewardVerificationToken(impressionId: impressionId)
let options = ServerSideVerificationOptions()
options.userIdentifier = token.appUserID
options.customRewardString = token.customData
rewardedAd.serverSideVerificationOptions = options

// When the ad's reward callback fires
let result = await Purchases.shared.pollRewardVerification(clientTransactionID: token.clientTransactionID)
if let gems = result.verifiedReward?.virtualCurrency { showReward(gems.amount) }`,
        },
        paras: ["A currency reward is written to the in-app currency ledger once per reward, so a callback Google sends twice never credits twice. A `VIRTUAL_CURRENCY_TRANSACTION` webhook goes out with `source: ad_reward`."],
      },
      {
        h2: "How does RevenueDot check the AdMob callback, and what is not built?",
        bullets: [
          "AdMob signs the query string with ECDSA (P-256, SHA-256). RevenueDot checks it with Google's published verifier keys. A bad signature answers 403 and records nothing.",
          "A callback is accepted only for your ad units, the ones connecting AdMob loads or the ones named on your reward rules.",
          "Connecting AdMob with Google sign-in loads ad unit names once a day. It is optional.",
          "AppLovin MAX, ironSource and Unity Ads reward callbacks are not verified yet.",
        ],
      },
    ],
    howTo: "How to verify AdMob rewarded ads on your server",
    faq: [
      {
        q: "How do I track ad revenue next to subscription revenue?",
        a: "Report ad impressions and revenue through the SDK's ad tracker, directly or with RevenueCat's AdMob adapter. The Ads overview shows ad revenue, impressions and eCPM in US dollars next to subscription revenue, and the charts add fill rate and ARPDAU.",
      },
      {
        q: "How do I verify AdMob rewarded ads on my server?",
        a: "Turn on server-side verification in AdMob and paste RevenueDot's callback URL. Your app passes a verification token to AdMob. When the customer watches the ad, AdMob calls RevenueDot with a signed request, RevenueDot checks Google's signature and a reward rule grants the reward.",
      },
      {
        q: "What can a rewarded ad grant?",
        a: "A reward rule grants in-app currency, as a fixed amount or AdMob's reward amount times a multiplier, or a promotional entitlement for up to 365 days. Rules are checked from the top, and the first match decides. A reward is recorded once per network transaction.",
      },
      {
        q: "Does RevenueDot support AppLovin MAX or ironSource reward verification?",
        a: "Not yet. You can track their ad revenue through the ad tracker, but only AdMob's signed callback is verified for rewards.",
      },
      {
        q: "Do I have to connect my AdMob account?",
        a: "No. Ad revenue works without it, and rewarded ads work when each reward rule names its ad unit. Connecting AdMob loads your ad unit names, so the overview shows names instead of ids, and tells reward verification which ad units are yours.",
      },
    ],
    docs: [
      { href: "/docs/guides/ads", label: "Ads guide" },
      { href: "/docs/guides/charts", label: "Charts: Ads" },
      { href: "/docs/api/extensions", label: "API extensions: ads" },
    ],
    related: ["/features/charts", "/charts", "/integrations/google-admob", "/features/webhooks", "/sdks/ios", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "offline-entitlements",
    section: "features",
    name: "Offline entitlements",
    card: "Paying customers keep their access while your purchase server is down, through the SDK's offline mapping.",
    label: "Feature",
    title: "Offline entitlements: keep paying customers' access when your purchase server is down",
    metaTitle: "Offline Entitlements for In-App Subscriptions",
    metaDescription:
      "The SDK keeps paying customers' access during a server outage with a product-to-entitlement mapping that RevenueDot serves for each app and store.",
    answer:
      "Paying customers keep their access when RevenueDot is down. The SDK caches a mapping from each product to the access it gives, its entitlements. When the server answers with a 5xx, the SDK works out the customer's entitlements on the device from the store's own record of their purchases. RevenueDot serves the mapping for each app and answers 5xx, never 4xx, for its own failures.",
    points: [
      { title: "No extra setup", text: "The SDK fetches and caches the mapping by itself and refreshes it when the copy is 25 hours old." },
      { title: "Per app and store", text: "Each app key gets its own app's products, keyed the way that app's SDK looks them up." },
      { title: "5xx, never 4xx", text: "RevenueDot answers 5xx for its own failures and store outages, so the SDK's offline path runs when it should." },
      { title: "Syncs when you are back", text: "The purchase stays unfinished, so the SDK posts it again once the server is up." },
    ],
    blocks: [
      {
        h2: "How do offline entitlements work?",
        steps: [
          { name: "The SDK fetches the mapping", text: "It calls GET /v1/product_entitlement_mapping and caches the answer, refreshing it when the copy is 25 hours old." },
          { name: "The server fails", text: "GET /v1/subscribers/{app_user_id} or POST /v1/receipts answers 5xx and no customer info is cached." },
          { name: "The SDK computes entitlements on the device", text: "It reads the active purchases from StoreKit or Google Play and looks each product up in the mapping." },
          { name: "The result is not cached", text: "The result is marked as verified on the device. The purchase stays unfinished, so the SDK posts it again once the server is back." },
        ],
      },
      {
        h2: "What does the mapping contain for each store?",
        table: {
          head: ["Store", "Product in RevenueDot", "Keys in the mapping"],
          rows: [
            ["App Store", "pro_monthly", "pro_monthly"],
            ["App Store, iOS 26.4 billing plan", "pro_annual:monthly", "pro_annual:monthly"],
            ["App Store, up-front billing plan", "pro_annual:upFront", "pro_annual"],
            ["Google Play", "pro:monthly and pro:annual", "pro:monthly, pro:annual and pro"],
            ["Google Play, product without a base plan", "legacy_pro", "legacy_pro"],
          ],
        },
        paras: [
          "Google Play's bare key carries the entitlements of every base plan of the subscription, because Android's purchase record names the subscription but not the base plan. Nobody who paid loses access, and a customer on a cheaper base plan may see the richer plan's entitlements for at most a day, only while the server is down. Archived products still map. Consumables are left out.",
        ],
      },
      {
        h2: "How do you read the mapping for an app?",
        code: {
          title: "Product-to-entitlement mapping",
          label: "curl",
          code: `curl -s https://api.revenuedot.app/v1/product_entitlement_mapping \\
  -H "Authorization: Bearer $GOOGLE_APP_KEY"

# {"product_entitlement_mapping": {
#   "pro:monthly": {"product_identifier": "pro", "base_plan_id": "monthly", "entitlements": ["pro"]},
#   "pro:annual":  {"product_identifier": "pro", "base_plan_id": "annual",  "entitlements": ["pro", "cloud_sync"]},
#   "pro":         {"product_identifier": "pro", "base_plan_id": "monthly", "entitlements": ["pro", "cloud_sync"]}}}`,
        },
        paras: ["A secret key with no `X-Platform` header gets the whole project's mapping."],
      },
      {
        h2: "When do offline entitlements not apply?",
        paras: ["These limits are the SDKs' own, not RevenueDot's."],
        bullets: [
          "The app completes purchases itself (observer mode, `purchasesAreCompletedBy = .myApp`).",
          "The Test Store, and iOS before version 15.",
          "A pending consumable on iOS, or any active one-time purchase on Android, where the SDK returns an error instead.",
          "A network error with no answer at all. Only a 5xx counts as the server being down.",
        ],
      },
    ],
    faq: [
      {
        q: "What happens to my subscribers' access if my purchase server goes down?",
        a: "Paying customers keep access. When the server answers 5xx, the SDK reads the customer's active purchases from StoreKit or Google Play and maps each product to entitlements with a mapping it cached from RevenueDot. Access is computed on the device until the server is back.",
      },
      {
        q: "Do I need to change my app code for offline entitlements?",
        a: "No. It is built into the SDK, both RevenueDot's and RevenueCat's, and needs only the normal setup. RevenueDot serves the mapping at GET /v1/product_entitlement_mapping for each app, and the SDK fetches and refreshes it by itself.",
      },
      {
        q: "Why does RevenueDot answer 5xx and not 4xx when it fails?",
        a: "A 4xx tells the SDK the purchase can never be accepted, so it finishes the transaction. A 5xx tells it to try again later and to use the offline mapping. RevenueDot answers 5xx for its own failures and store outages so purchases are not dropped.",
      },
      {
        q: "Does offline entitlement work with the Test Store or observer mode?",
        a: "No. The SDK does not use it in observer mode, with the Test Store or on iOS before version 15. A pending consumable on iOS and any active one-time purchase on Android also return an error instead.",
      },
    ],
    docs: [
      { href: "/docs/guides/offline-entitlements", label: "Offline entitlements guide" },
      { href: "/docs/help/receipt-errors-4xx-vs-5xx", label: "4xx vs 5xx on receipts" },
      { href: "/docs/guides/going-to-production", label: "Going to production" },
    ],
    related: ["/features/trusted-entitlements", "/features/rest-api", "/stores/app-store", "/stores/google-play", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "trusted-entitlements",
    section: "features",
    name: "Trusted Entitlements",
    card: "RevenueDot signs every SDK response, so the RevenueDot SDK can tell a real answer from a forged one.",
    label: "Feature",
    title: "Trusted Entitlements: signed SDK responses that your app can verify",
    metaTitle: "Trusted Entitlements: Signed SDK Responses",
    metaDescription:
      "RevenueDot signs every SDK response with Ed25519, and the RevenueDot SDK verifies it on RevenueDot Cloud. Self-hosted servers sign with their own key.",
    answer:
      "RevenueDot signs every SDK response with an Ed25519 signature, so your app can check that its access data came from RevenueDot unchanged. On RevenueDot Cloud the RevenueDot SDK verifies it and reports VERIFIED. A self-hosted server signs once you set REVENUEDOT_SIGNING_KEY. The stock RevenueCat SDK trusts only RevenueCat's key, so apps that keep it turn verification off.",
    points: [
      { title: "Signed responses", text: "Every 2xx and 3xx response under /v1 and /rcbilling carries an X-Signature header." },
      { title: "Intermediate keys", text: "The server makes a new intermediate key every 30 days. Only the root seed is configured." },
      { title: "Verified in tests", text: "The server's contract tests check the format against real signatures and reject tampered bodies, nonces and paths." },
      { title: "Cloud is signed", text: "RevenueDot Cloud signs with a public key published at /.well-known/revenuedot-signing-key." },
    ],
    blocks: [
      {
        h2: "What does each SDK setup give you?",
        table: {
          head: ["App uses", "Server", "Result"],
          rows: [
            ["RevenueDot SDK, official build", "RevenueDot Cloud", "VERIFIED"],
            ["RevenueDot SDK built with your public key", "Your server with REVENUEDOT_SIGNING_KEY", "VERIFIED"],
            ["Stock RevenueCat SDK, verification DISABLED", "Any", "No check. Everything works. Recommended for proxy mode."],
            ["Stock SDK, INFORMATIONAL (the iOS and Android default)", "Any", "Entitlements work, but each carries verification FAILED and the SDK logs an error."],
            ["Stock SDK, ENFORCED", "Any", "Every request fails. Never use it against RevenueDot."],
          ],
        },
        paras: ["Defaults differ per SDK. iOS and Android are informational, React Native, Flutter and Kotlin Multiplatform default to disabled, and purchases-js does not verify."],
      },
      {
        h2: "How to turn on response signing",
        label: "Steps",
        steps: [
          { name: "Generate a key pair", text: "In a checkout of the server repository run pnpm tsx scripts/signing-keygen.ts. It prints the REVENUEDOT_SIGNING_KEY seed and the public key." },
          { name: "Give the seed to the server", text: "Set REVENUEDOT_SIGNING_KEY as an environment variable and keep it in your password manager. Anyone with the seed can sign responses your apps trust." },
          { name: "Restart and check the public key", text: "Call /.well-known/revenuedot-signing-key. Without a key it answers 404 and responses are not signed." },
          { name: "Choose the app side", text: "Build the RevenueDot SDK with your public key to get VERIFIED, or turn verification off in the app." },
        ],
      },
      {
        h2: "How do you check the signing key?",
        code: {
          title: "Check the public key",
          label: "curl",
          code: `curl -s http://localhost:8787/.well-known/revenuedot-signing-key

# {"algorithm":"Ed25519","public_key":"ZzwPxGlon0E8ErpDh9QAH0Jh6+E6D6qufvTSetXZY9Y=","encoding":"base64","header":"X-Signature","docs":"https://revenuedot.app/docs"}`,
        },
      },
      {
        h2: "What does the signature cover?",
        paras: [
          "The X-Signature value is base64 of 180 bytes: an intermediate Ed25519 public key, its expiry in days, the root key's signature over both, a random salt, and the intermediate key's signature over the message. The message is the salt, the API key, the nonce, the request path, the request hash headers, the response time and ETag headers, and the body. The SDK sends a random `X-Nonce` with requests it verifies, and the nonce is part of the message.",
          "RevenueDot Cloud signs with the public key `gXdn2hmqR/TbdtQwK02laE0YgFz0Rtf918LICLrgZhg=`, and the official RevenueDot SDK builds verify against that key. Rotating the root key means shipping new SDK builds, because the key is compiled into the app.",
        ],
      },
    ],
    howTo: "How to turn on response signing",
    faq: [
      {
        q: "Why does the RevenueCat SDK report signature verification FAILED with RevenueDot?",
        a: "The stock SDK checks responses against RevenueCat's public key, and RevenueDot cannot sign with RevenueCat's private key. Set verification to disabled in the SDK, or use the RevenueDot SDK, which trusts RevenueDot Cloud's key. Access still works in informational mode, but the SDK logs errors.",
      },
      {
        q: "Should I use ENFORCED entitlement verification with RevenueDot?",
        a: "Not with the stock SDK. Every request would fail, because the stock SDK trusts only RevenueCat's key. Use DISABLED in proxy mode, or the RevenueDot SDK, which verifies RevenueDot's signatures.",
      },
      {
        q: "How do I get VERIFIED entitlements on my own server?",
        a: "Generate a signing key pair, set REVENUEDOT_SIGNING_KEY on the server, and build the RevenueDot SDK with your public key and host using the fork pipeline. The official RevenueDot SDK builds trust only RevenueDot Cloud's key.",
      },
      {
        q: "Does RevenueDot Cloud sign its responses?",
        a: "Yes. RevenueDot Cloud signs every SDK response, and its public key is served at /.well-known/revenuedot-signing-key. The official RevenueDot SDK trusts that key and reports VERIFIED.",
      },
    ],
    docs: [
      { href: "/docs/guides/trusted-entitlements", label: "Trusted Entitlements guide" },
      { href: "/docs/help/signature-verification-failed", label: "Why does the SDK report FAILED?" },
      { href: "/docs/getting-started/connect-your-app", label: "Connect your app" },
    ],
    related: ["/features/offline-entitlements", "/features/migration", "/sdks/ios", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "ai-connectors",
    section: "features",
    name: "AI connectors",
    card: "Connect ChatGPT, Claude, Cursor and Codex to your project with one URL and OAuth, with 38 tools.",
    label: "Feature",
    title: "Connect ChatGPT, Claude and Cursor to your subscription data with an MCP server",
    metaTitle: "Connect ChatGPT, Claude and Cursor via MCP",
    metaDescription:
      "Connect ChatGPT, Claude, Claude Code, Codex or Cursor to RevenueDot with OAuth. 38 tools set up your catalog, find customers, debug webhooks and read revenue.",
    answer:
      "RevenueDot has a hosted MCP server at https://mcp.revenuedot.app/mcp that connects ChatGPT, Claude, Claude Code, Codex and Cursor to your project with OAuth. Its 38 tools set up your catalog, find customers, grant access, debug webhooks and read revenue. You pick one project and one access level: read only, read and change, or money actions.",
    shot: {
      src: "screens/ai-light.png",
      dark: "screens/ai-dark.png",
      alt: "The RevenueDot AI page: the question 'How is revenue doing this month?' answered with the month's revenue, MRR, new and churned subscribers and a comparison with last month, with the suggested questions below.",
      caption: "The same questions you can ask from ChatGPT or Claude, answered from your project's data. Captured with example data.",
    },
    points: [
      { title: "One URL", text: "The same server is the RevenueDot connector for Claude and the plugin for ChatGPT and Codex." },
      { title: "38 tools", text: "Catalog setup, customer lookup, grants, webhooks, store connection checks and revenue reads." },
      { title: "You choose the access", text: "Read only, read and change, and a separate Money actions checkbox for refunds and cancels." },
      { title: "No secrets in chat", text: "No tool accepts a store key, a password or an API key. You add those in the dashboard." },
    ],
    blocks: [
      {
        h2: "How do you connect each assistant to RevenueDot?",
        table: {
          head: ["Assistant", "Steps"],
          rows: [
            ["Claude (claude.ai, Desktop, mobile)", "Add a custom connector in Connectors settings and paste https://mcp.revenuedot.app/mcp"],
            ["Claude Code", "Run claude mcp add --transport http revenuedot https://mcp.revenuedot.app/mcp, then /mcp to sign in"],
            ["ChatGPT", "Turn on developer mode, add an MCP connector with the URL and choose OAuth"],
            ["Codex", "Run codex plugin marketplace add revenuedot/agent-skills, then install revenuedot"],
            ["Cursor and others", "Add an MCP server of type streamable HTTP with the same URL"],
          ],
        },
      },
      {
        h2: "How to connect Claude Code to your RevenueDot project",
        label: "Steps",
        steps: [
          { name: "Add the server", text: "Run the claude mcp add command with the RevenueDot URL." },
          { name: "Sign in", text: "Type /mcp in Claude Code and choose RevenueDot. A RevenueDot page opens where you sign in with your dashboard account." },
          { name: "Pick the project and the access", text: "Choose one project and Read only, Read and change, or Read and change with Money actions. A first connection asks for read and change only." },
          { name: "Ask", text: "Try: Is everything connected? Did any webhook fail this week? Or: Find the customer with email jane@example.com and tell me why they don't have access." },
        ],
      },
      {
        h2: "Which connect command does Claude Code use?",
        code: {
          title: "Terminal",
          label: "Shell",
          code: `claude mcp add --transport http revenuedot https://mcp.revenuedot.app/mcp`,
        },
        paras: ["Config blocks for Claude Code, Claude Desktop, Codex, Cursor, ChatGPT and Windsurf, the full tool table and what RevenueCat's own MCP server offers are on [RevenueCat MCP server, official and open source](/revenuecat-mcp).", "Then run `/mcp` in Claude Code to sign in. You can also install the plugin with `/plugin marketplace add revenuedot/agent-skills`, then `/plugin install revenuedot@revenuedot`."],
      },
      {
        h2: "What can an assistant do with each access level?",
        table: {
          head: ["Choice", "The assistant can"],
          rows: [
            ["Read only", "Read the catalog, customers, events, transactions, webhooks and metrics"],
            ["Read and change", "Also create products, entitlements and offerings, grant and revoke access, set customer attributes, manage webhooks and delete a customer"],
            ["Money actions (separate checkbox)", "Also extend, cancel and refund subscriptions and make Test Store purchases"],
          ],
        },
      },
      {
        h2: "How does RevenueDot keep AI access safe?",
        bullets: [
          "No tool accepts a store key, a password or an API key. Add those in the dashboard.",
          "The assistant asks you before it cancels, refunds or deletes. Check the customer and the product it names.",
          "Cancel and refund work for Google Play subscriptions. Apple does not allow a server to refund or cancel, so the assistant sends the customer to reportaproblem.apple.com or extends their subscription.",
          "The connection is a secret API key named OAuth plus the app name, limited to the project and the access you chose. Delete it under API keys in the dashboard to disconnect. It does not expire.",
          "Prefer your own key? Send a secret key as a bearer token. A read-only key cannot change anything.",
        ],
      },
    ],
    howTo: "How to connect Claude Code to your RevenueDot project",
    faq: [
      {
        q: "How do I connect ChatGPT to my subscription data?",
        a: "Turn on developer mode in ChatGPT's settings, add an MCP connector with https://mcp.revenuedot.app/mcp and choose OAuth. Sign in with your RevenueDot account, pick one project and choose what ChatGPT may do. Then ask about customers, webhooks or revenue in chat.",
      },
      {
        q: "Is there an MCP server for in-app purchases?",
        a: "Yes. RevenueDot's hosted MCP server at https://mcp.revenuedot.app/mcp has 38 tools for catalog setup, customer lookup, entitlement grants, webhooks, store connection checks and revenue. It works with ChatGPT, Claude, Claude Code, Codex and Cursor, and uses OAuth 2.1.",
      },
      {
        q: "Can an AI assistant refund my customers by itself?",
        a: "Only if you allow it. Refunds and cancels need the separate Money actions permission, and the assistant asks you to approve the customer and product it names first. Refunds and cancels work for Google Play. Apple does not let a server refund or cancel.",
      },
      {
        q: "How do I disconnect an AI assistant from RevenueDot?",
        a: "Delete the secret key named OAuth plus the app's name under API keys in the dashboard. The connection is that key, limited to the project and access you chose. It does not expire, so delete it when you stop using the assistant.",
      },
      {
        q: "Can I use my own API key instead of OAuth?",
        a: "Yes. Send Authorization: Bearer sk_ with a secret key from API keys and give the key only the permissions you want the assistant to have.",
      },
    ],
    docs: [
      { href: "/docs/guides/connect-ai-assistants", label: "Connect AI assistants" },
      { href: "/docs/api/authentication", label: "API keys and permissions" },
      { href: "/docs/guides/webhooks", label: "Webhooks" },
    ],
    related: ["/revenuecat-mcp", "/features/rest-api", "/features/webhooks", "/features/migration", "/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "migration",
    section: "features",
    name: "Migration from RevenueCat",
    card: "Import your RevenueCat project, run both systems side by side, then cut over without losing access.",
    label: "Feature",
    title: "Migrate from RevenueCat to RevenueDot without losing subscribers",
    metaTitle: "Migrate from RevenueCat Without Losing Subscribers",
    metaDescription:
      "Import your RevenueCat apps, SDK keys, catalog, customers and purchases, run both systems with notification forwarding, ship one SDK setting and cut over.",
    answer:
      "Migrate in four phases: import your RevenueCat project with RevenueDot's importer, run both systems side by side with store notification forwarding, ship an app update that sets the SDK's proxy URL, then cut over. The importer copies your catalog, customers, purchases and SDK keys, so current access is imported and old app versions keep working.",
    shot: {
      src: "screens/importer-light.png",
      dark: "screens/importer-dark.png",
      alt: "Terminal output of 'npx revenuedot import --from-revenuecat --dry-run': the catalog it would create (apps, products, entitlements, offerings, packages, SDK keys kept), 14 customers read with their subscriptions and purchases, and the store credentials to re-enter because RevenueCat cannot export them.",
      caption: "The importer's dry run against a copy of a RevenueCat project: what it would create, what it read, and what you re-enter.",
    },
    points: [
      { title: "Importer", text: "Apps, public SDK keys, catalog, customers, aliases, attributes, subscriptions, one-time purchases and revenue history." },
      { title: "Dual run", text: "RevenueDot forwards the exact store notification body to RevenueCat, so both stay current while old app versions run." },
      { title: "Keep your SDK keys", text: "Each app's production key is copied, so builds already in the store keep working." },
      { title: "Resumable and safe to repeat", text: "A dry run writes nothing, a stopped import resumes, and a second run changes nothing that is already right." },
    ],
    blocks: [
      {
        h2: "How to migrate from RevenueCat in four phases",
        label: "Steps",
        paras: ["The full walkthrough is on [Migrate from RevenueCat](/migrate-from-revenuecat)."],
        steps: [
          { name: "Import and set up RevenueDot next to RevenueCat", text: "Run the importer, enter each app's store credentials (the App Store In-App Purchase key and the Google Play service account, which cannot be exported), run the importer again, and check with import verify." },
          { name: "Route store notifications through RevenueDot", text: "Point App Store Server Notifications at RevenueDot and set its forwarding URL to RevenueCat's. For Google Play, add a second Pub/Sub push subscription or forward the same way. Keep acting on RevenueCat's webhooks." },
          { name: "Ship the app update", text: "Set the SDK's proxy URL, turn off signature checks and call syncPurchases once on first launch. Users on older versions keep talking to RevenueCat, which stays correct because notifications are forwarded." },
          { name: "Cut over", text: "When import verify shows no differences and few users run old versions, create your webhooks in RevenueDot, turn off RevenueCat's and the forwarding URLs, and turn RevenueCat off." },
        ],
      },
      {
        h2: "What changes in your app?",
        paras: ["One setting. Set the proxy URL before `configure` and turn entitlement verification off. The rest of your RevenueCat SDK code stays the same. Call `syncPurchases()` once on the first launch of the update."],
        code: {
          title: "App.swift",
          label: "Swift",
          code: `import RevenueCat

// Point the SDK at RevenueDot; nothing else in the app changes.
Purchases.proxyURL = URL(string: "https://api.revenuedot.app")!
Purchases.configure(
    with: Configuration.Builder(withAPIKey: "appl_...")
        .with(entitlementVerificationMode: .disabled)
        .build()
)`,
        },
      },
      {
        h2: "How do you run the importer?",
        paras: [
          "The importer reads your RevenueCat project through RevenueCat's REST API v2 with a v2 secret key and writes it into RevenueDot. It sends no webhooks, resumes after a stop and asks for each key with hidden input, so no key lands in your shell history. The CLI is not on npm yet, so run it from the RevenueDot repository. Start with `--dry-run`, and add `--limit 50` to try 50 customers first.",
        ],
        code: {
          title: "From a checkout of revenuedot/revenuedot",
          label: "Shell",
          code: `pnpm --filter revenuedot cli import --from-revenuecat --rc-project proj... --to https://revenuedot.example.com --dry-run

# Compare both systems customer by customer, and print the cutover steps
pnpm --filter revenuedot cli import verify --rc-project proj... --to https://revenuedot.example.com
pnpm --filter revenuedot cli import plan --to https://revenuedot.example.com --rc-project proj...`,
        },
      },
      {
        h2: "What does the importer bring over, and what does it leave?",
        table: {
          head: ["Brought over", "Not brought over"],
          rows: [
            ["Apps and each app's public SDK key", "Store credentials. RevenueCat's API does not return them."],
            ["Products, entitlements, offerings and packages", "Paywalls, targeting rules, experiments and virtual currency balances. Recreate them in RevenueDot."],
            ["Customers, aliases and attributes", "Integrations and the webhooks themselves. Create them at cutover."],
            ["Subscriptions and one-time purchases", "Refunds of subscriptions. RevenueCat's v2 subscription object does not show them, so a refunded subscription imports as expired."],
            ["Promotional access and revenue history", "RevenueCat Billing renewals, and Google Play purchase tokens, which RevenueDot looks up with your service account."],
          ],
        },
      },
      {
        h2: "How does the dual run work?",
        bullets: [
          "App Store Connect accepts one production and one sandbox notification URL per app, so only one system can receive Apple's notifications directly.",
          "RevenueDot stores each notification, applies it and forwards the exact body to RevenueCat with a 10 second timeout. Forwarding never delays the answer to Apple or Google.",
          "For Google Play, if the Pub/Sub topic is in your own Google Cloud project, add a second push subscription to RevenueDot's URL.",
          "Turn on Track new purchases from server-to-server notifications for each app during the dual run.",
        ],
        paras: ["The [migration guide](/docs/migrate) and the cutover checklist cover each step with your app ids filled in by `import plan`."],
      },
    ],
    howTo: "How to migrate from RevenueCat in four phases",
    faq: [
      {
        q: "How do I migrate from RevenueCat without losing subscribers?",
        a: "Import your project with the importer, which copies customers, subscriptions and your public SDK keys. Forward store notifications from RevenueDot to RevenueCat so both stay current. Ship an app update with the new proxy URL and a one-time syncPurchases call. Cut over when import verify shows no differences.",
      },
      {
        q: "Do I have to change my app code to switch from RevenueCat?",
        a: "One setting. Set the SDK's proxy URL to RevenueDot before configure, and turn off entitlement verification, or use a RevenueDot fork. Your purchase, offerings and entitlement code stays the same.",
      },
      {
        q: "Will old versions of my app keep working?",
        a: "Yes. The importer copies each app's public SDK key into RevenueDot, and notification forwarding keeps RevenueCat current for users who have not updated. Re-run the importer while old versions are in use.",
      },
      {
        q: "Can I import my RevenueCat paywalls and experiments?",
        a: "Not yet. The importer copies catalog, customers, subscriptions and purchases. Paywalls, targeting rules, experiments and virtual currency balances are recreated in RevenueDot. Build paywalls from the ten templates or the visual editor.",
      },
      {
        q: "Where do I get the Google Play purchase tokens?",
        a: "RevenueCat's API gives Google Play order ids, not tokens. RevenueDot looks the tokens up with your Play service account, from a CSV you pass, from Google's next renewal notification, or from the app's syncPurchases call. Customers keep access in the meantime.",
      },
    ],
    docs: [
      { href: "/docs/migrate", label: "Migrate from RevenueCat" },
      { href: "/docs/migrate/importer", label: "The importer" },
      { href: "/docs/migrate/dual-run", label: "Dual run" },
      { href: "/docs/migrate/cutover-checklist", label: "Cutover checklist" },
      { href: "/docs/getting-started/connect-your-app", label: "Connect your app" },
    ],
    related: ["/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat", "/features/trusted-entitlements", "/features/rest-api", "/stores/app-store", "/stores/google-play"],
  },

  // ---------------------------------------------------------------------------------------------------------------
  {
    slug: "support",
    section: "features",
    name: "Support",
    card: "Customer Center tickets in your inbox, and subscription details in Intercom or Zendesk beside each chat.",
    label: "Feature",
    title: "Support tickets and Intercom or Zendesk sidebars for subscription apps",
    metaTitle: "Support Tickets with Intercom and Zendesk Sidebars",
    metaDescription:
      "Receive support tickets from the Customer Center and show each customer's subscription, entitlements, spend and refunds in Intercom or Zendesk.",
    answer:
      "RevenueDot stores the support requests customers send from the Customer Center, the subscription screen the SDK shows in your app, emails each one to your support address and lists it in the dashboard. Its Intercom inbox app and Zendesk sidebar app show the customer's subscription, entitlements, total spent, refunds and open tickets next to the conversation.",
    shot: {
      src: "lifecycle/support-tickets.png",
      alt: "The RevenueDot Support page on the Tickets tab. An open ticket from wren@example.com says they were charged twice for the weekly plan. A side panel shows the sender, app user ID, time received and status, with Reply by email and Close ticket buttons.",
      caption: "A ticket from the Customer Center, with the customer's app user ID and a Reply by email button.",
    },
    points: [
      { title: "Tickets from the app", text: "A customer writes from the Customer Center, and RevenueDot emails it to you with Reply-To set to the customer." },
      { title: "Flood limits", text: "5 tickets an hour per customer, 20 per device and 100 per project, so a leaked SDK key cannot flood your inbox." },
      { title: "Intercom inbox app", text: "A Canvas Kit app in your workspace, with every request signed and checked." },
      { title: "Zendesk sidebar app", text: "A private ticket sidebar app that looks the requester up by email." },
    ],
    blocks: [
      {
        h2: "How to turn on Customer Center support tickets",
        label: "Steps",
        steps: [
          { name: "Open the settings", text: "Go to Lifecycle, then Support, then the Customer Center tab." },
          { name: "Enter the support email", text: "Tickets are sent there, with Reply-To set to the customer's address, so you answer from your inbox." },
          { name: "Turn on tickets and choose who may write", text: "Switch on Let customers create tickets, and choose customers with an active subscription, without one, or everyone." },
          { name: "Choose the details in the email", text: "Include app user ID, active entitlements, total spent, customer since, last opened, app version, country, device and more." },
        ],
      },
      {
        h2: "How do you connect Intercom?",
        paras: ["The Intercom inbox app is a Canvas Kit app that you create in your own Intercom workspace. Intercom calls RevenueDot directly, and RevenueDot checks every request's signature, so no API key is involved."],
        bullets: [
          "In the Intercom Developer Hub, create an app and open Canvas Kit. For the Inbox, set the initialize URL to `https://api.revenuedot.app/v1/support/intercom/{project_id}/canvas`, with your project ID.",
          "Copy the app's client secret from Basic information, paste it into Integrations, then Intercom inbox in RevenueDot and select Connect Intercom inbox.",
          "Install the app in your workspace and add it to the inbox sidebar.",
          "RevenueDot finds the customer by the contact's user ID, which should be your app user ID, then by the contact's email against the `$email` attribute.",
        ],
      },
      {
        h2: "How do you connect Zendesk?",
        paras: ["The Zendesk app is a private ticket sidebar app whose source is in the RevenueDot repository under integrations/zendesk-app. It looks the requester up by email."],
        bullets: [
          "In RevenueDot, create a secret key with only the `customer_information:customers:read` permission.",
          "Zip the app folder and upload it as a private app in Zendesk's Admin Center.",
          "Fill in the RevenueDot API URL, the project ID and the secret key. Zendesk keeps the key as a secure setting, so agents' browsers never see it.",
        ],
      },
      {
        h2: "How do you use the support summary from your own help desk?",
        paras: [
          "Any other help desk can call the support summary from its backend with a secret key. The answer has the customer's status, active entitlements, each subscription with its store, auto-renew state and expiry, total spent, refund requests, open tickets and a link to the customer in the dashboard. Call it from your backend, never from code that runs in an agent's browser.",
        ],
        code: {
          title: "Support summary by email",
          label: "curl",
          code: `curl "https://api.revenuedot.app/v2/projects/$PROJECT_ID/support_summaries?email=wren@example.com" \\
  -H "Authorization: Bearer $REVENUEDOT_SECRET_KEY"`,
        },
      },
    ],
    howTo: "How to turn on Customer Center support tickets",
    faq: [
      {
        q: "How do I let customers contact support from my iOS or Android app?",
        a: "Turn on tickets under Lifecycle, Support, Customer Center in RevenueDot, enter your support email and choose who may write. The SDK's Customer Center then shows a write-to-us option, and each ticket is stored, emailed to you with Reply-To set to the customer, and listed in the dashboard.",
      },
      {
        q: "Can I see a customer's subscription in Intercom?",
        a: "Yes. The RevenueDot Intercom inbox app is a Canvas Kit app you create in your workspace. It shows the customer's status, entitlements, plan, store, renewal date, total spent, refund requests and open tickets in the inbox sidebar, with a link to the dashboard.",
      },
      {
        q: "Is there a Zendesk app for subscription data?",
        a: "Yes. RevenueDot ships a private Zendesk sidebar app. It finds the ticket requester by email through the support summary API and shows their subscription state. You upload it from the repository in Zendesk's Admin Center and set the RevenueDot URL, project id and a read-only key.",
      },
      {
        q: "How does RevenueDot stop support ticket spam?",
        a: "A customer can send 5 tickets an hour, one device 20, and a whole project 100. The customer's email must be one plain address and the message is cut at 5,000 characters, so a leaked SDK key cannot flood your inbox.",
      },
    ],
    docs: [
      { href: "/docs/guides/support-integrations", label: "Support tickets and help desks" },
      { href: "/docs/guides/integrations", label: "Intercom integration" },
      { href: "/docs/api/extensions", label: "API extensions: support" },
    ],
    related: ["/features/customer-center", "/integrations/intercom", "/features/refund-control", "/features/customer-lists", "/compare/revenuedot-vs-revenuecat"],
  },
];
