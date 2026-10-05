// Integration pages, part A: Slack, Segment, Amplitude, Mixpanel, PostHog, Firebase, BigQuery, AppsFlyer, Adjust,
// Meta Ads, Branch, Braze, CleverTap, Customer.io, Discord, Google Tag Manager, Intercom and the Intercom inbox app.
// Every fact comes from packages/core/src/integrations (builders and catalogue) and docs/guides/integrations.md.
// Writing rules: apps/site/CONTENT.md.
import type { Block, IntegrationPage, Source } from "./types";

const RC_LIST: Source = { label: "RevenueCat third-party integrations", url: "https://www.revenuecat.com/docs/integrations/third-party-integrations" };
const RC_ATTRIBUTION: Source = { label: "RevenueCat attribution integrations", url: "https://www.revenuecat.com/docs/integrations/attribution" };
const GUIDE = "/docs/guides/integrations";
const BEHAVIOR = { href: `${GUIDE}#how-every-integration-behaves`, label: "How every integration behaves: retries, skips, revenue" };
const NAMES = { href: `${GUIDE}#event-names`, label: "Event names and how to rename them" };
const ATTRS = { href: `${GUIDE}#reserved-attributes-your-app-sets`, label: "Reserved attributes your app sets" };

/** The delivery block every page shares: retry schedule, delivery log, sealed credentials, plus a partner-specific line. */
function delivery(name: string, extra: string[] = []): Block {
  return {
    h2: `How RevenueDot delivers events to ${name}`,
    bullets: [
      `Timeouts, rate limits (HTTP 429) and server errors (5xx) from ${name} retry on the webhook schedule: after 5, 10, 20, 40 and 80 minutes.`,
      "Any other 4xx answer fails at once, because sending the same request again cannot work. Fix the setting, then click **Replay failed**.",
      "The delivery log keeps each request with every secret replaced by `[redacted]`, the answer, the time taken and, for skipped events, the reason.",
      "Credentials are sealed with AES-256-GCM on the server. After you save a key, the dashboard shows only its last four characters.",
      ...extra,
    ],
  };
}

/** The honest closing sentence for the "same as RevenueCat's" answers. */
const newer = (name: string) =>
  `RevenueCat's version has years of production use behind it. RevenueDot's is newer, so run **Send test event** and check ${name} before you rely on it.`;

const sdk = (name: string, more: string) => ({
  q: `Does the ${name} integration work with the RevenueCat SDK?`,
  a: `Yes. RevenueDot speaks the RevenueCat SDK protocol, so an app on the RevenueCat SDK keeps it and only the server address changes. New apps use the RevenueDot SDK, which is built from it. ${more}`,
});

export const INTEGRATIONS_A: IntegrationPage[] = [
  // ---------------------------------------------------------------- Slack
  {
    kind: "slack",
    slug: "slack",
    name: "Slack",
    category: "marketing",
    logo: "slack.svg",
    card: "Post new purchases, trials, cancellations, refunds and billing issues to a Slack channel.",
    title: "Slack notifications for in-app purchases and subscriptions",
    metaTitle: "Slack alerts for in-app purchases and subscriptions",
    metaDescription: "Post every new subscription, trial, renewal, cancellation, refund and billing issue to a Slack channel. Included on every plan, and open source.",
    answer:
      "RevenueDot posts one Slack message for each new subscription, trial start, trial conversion, renewal, cancellation, refund, one-time purchase, billing issue and product change. Each message names the customer, product, revenue in US dollars, store and country, and links to the customer's page. You connect it with a Slack incoming webhook URL, and failed posts retry automatically.",
    uses: [
      "Watch every sale and trial land in a team channel without opening a dashboard.",
      "Catch billing issues and cancellations the day they happen, so support can reach out.",
      "Celebrate the first purchases after a launch or a paywall change.",
      "Keep refunds visible to finance and support in one place.",
    ],
    sends: [
      "RevenueDot sends one message per event for 11 event types: initial purchase, trial started, trial converted, trial cancelled, renewal, cancellation, one-time purchase, billing issue, product change, refund reversed and the test event.",
      "Each message has the customer (linked to their page in the dashboard), the product, the store and the country, plus the revenue in US dollars on money events.",
      "A cancellation caused by a refund (cancel reason `CUSTOMER_SUPPORT`) reads `was refunded` and shows the negative revenue.",
      "Expirations, pauses, transfers and uncancellations are not posted to Slack.",
      "The default environment is production. Sandbox events are labelled `Sandbox` and are posted only when the integration's environment includes sandbox.",
      "Customer and product ids are escaped, so an id such as `<!channel>` stays plain text and never pings anyone.",
    ],
    setup: [
      { name: "Create the Slack webhook", text: "In Slack, create an app, turn on **Incoming Webhooks** and add a webhook to the channel you want." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Slack." },
      { name: "Paste the URL", text: "Paste the webhook URL into **Incoming webhook URL**. RevenueDot encrypts it and shows only its last four characters afterward." },
      { name: "Choose the revenue", text: "Pick **Sales reporting**: **Gross revenue** or **After store commission and taxes**." },
      { name: "Connect and test", text: "Click **Connect Slack**, then **Send test event** to see a test message in the channel." },
    ],
    blocks: [delivery("Slack", ["Slack answers a successful post with the text `ok`. Any other answer is recorded as a failure with Slack's message."])],
    faq: [
      sdk("Slack", "Slack needs no device ids or attributes, only the purchases that reach RevenueDot."),
      {
        q: "Is it the same as RevenueCat's Slack integration?",
        a: "It does the same job: sale and subscription alerts in a channel. The message layout and wording are RevenueDot's own. " + newer("Slack"),
      },
      { q: "Can I choose which events go to Slack?", a: "Yes. Like webhooks, each integration filters by environment, app and event type, so you can post only new purchases and cancellations." },
      { q: "What happens when Slack is down?", a: "RevenueDot retries on the webhook schedule: 5, 10, 20, 40 and 80 minutes. Failed and skipped posts stay in the delivery log, and you can resend them." },
    ],
    partner: [
      { label: "Slack", url: "https://slack.com" },
      { label: "Slack incoming webhooks", url: "https://api.slack.com/messaging/webhooks" },
      RC_LIST,
    ],
    docs: [{ href: `${GUIDE}#slack`, label: "Slack setup in the integrations guide" }, BEHAVIOR],
    related: ["/integrations/discord", "/integrations/webhooks", "/features/webhooks", "/charts/revenue"],
  },

  // -------------------------------------------------------------- Segment
  {
    kind: "segment",
    slug: "segment",
    name: "Segment",
    category: "analytics",
    logo: "segment.svg",
    card: "A track and identify call for every subscription event, for every destination in your Segment workspace.",
    title: "Send in-app subscription events to Segment",
    metaTitle: "Send in-app subscription events to Segment",
    metaDescription: "Send every subscription, trial, renewal and refund to Segment as a track call plus an identify call, with event names you can rename. Open source.",
    answer:
      "RevenueDot sends each purchase, trial, renewal, cancellation and refund to Segment as a `track` call named like `rc_renewal_event`, plus an `identify` call that sets `rc_subscription_status`. Events carry revenue in US dollars, product, store, entitlements and transaction ids. They go to your Segment HTTP API source as they happen, and `messageId` lets Segment drop retried duplicates.",
    uses: [
      "Fan subscription revenue out to every Segment destination, such as your warehouse, ad networks and email tool.",
      "Join app behavior and subscription status in one customer profile.",
      "Trigger lifecycle campaigns from `rc_billing_issue_event` or `rc_trial_cancelled_event`.",
      "Moving from RevenueCat? Keep the event names your downstream dashboards already use.",
    ],
    sends: [
      "A `track` call per event, named `rc_initial_purchase_event`, `rc_trial_started_event`, `rc_trial_converted_event`, `rc_renewal_event`, `rc_cancellation_event` and so on. Rename any of them under **Event names**.",
      "The properties include `revenue` in US dollars, `currency` (`USD`), `price_in_purchased_currency`, `purchased_currency`, `store`, `product_id`, `entitlements`, `transaction_id` and the customer's attributes.",
      "An `identify` call sets the traits `rc_subscription_status`, `last_seen_app_user_id` and `aliases`.",
      "`userId` is the app user id. Turn on **Send anonymous app user ids as anonymousId** to send `$RCAnonymousID:` customers as `anonymousId`.",
      "`messageId` is the event id (the identify call adds `-identify`), so Segment deduplicates retries. `context.environment` is `production` or `sandbox`.",
      "The three web funnel events (`rd_funnel_viewed`, `rd_funnel_step_completed`, `rd_funnel_purchase`) are opt-in.",
      "Paywall events are opt-in: tick **Send paywall events** to get `paywall_impression`, `paywall_close`, `paywall_cancel`, `paywall_exit_offer` and `paywall_component_interacted`, plus RevenueDot's `paywall_purchase_initiated` and `paywall_purchase_error`. They carry the paywall, offering and session, and no revenue.",
    ],
    setup: [
      { name: "Add a Segment source", text: "In Segment, add an **HTTP API** source and copy its write key." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Segment." },
      { name: "Enter the key and region", text: "Paste the key into **Write key** and pick the **Region**: US (api.segment.io) or EU (events.eu1.segmentapis.com)." },
      { name: "Set identity and revenue", text: "Turn on **Send anonymous app user ids as anonymousId** if you want it, and pick **Sales reporting**." },
      { name: "Connect and test", text: "Click **Connect Segment**, then **Send test event** and look for `rc_test_event` in the source's Debugger." },
    ],
    blocks: [delivery("Segment")],
    faq: [
      sdk("Segment", "Set the customer's `$email` and other attributes with the SDK's attribute calls if you want them on the Segment profile."),
      {
        q: "Is it the same as RevenueCat's Segment integration?",
        a: "It sends the same `rc_*_event` names and the same `rc_subscription_status` trait, so dashboards built on RevenueCat's Segment events keep working. " + newer("Segment"),
      },
      { q: "Does Segment receive sandbox purchases?", a: "Sandbox events go to the same source with `context.environment` set to `sandbox`. Set the integration's environment to production to leave them out." },
      { q: "Can I use the EU region?", a: "Yes. Pick **EU** under **Region** and RevenueDot calls events.eu1.segmentapis.com instead of api.segment.io." },
    ],
    partner: [
      { label: "Segment", url: "https://segment.com" },
      { label: "Segment HTTP Tracking API", url: "https://segment.com/docs/connections/sources/catalog/libraries/server/http-api/" },
      RC_LIST,
    ],
    docs: [{ href: `${GUIDE}#segment`, label: "Segment setup in the integrations guide" }, NAMES],
    related: ["/integrations/amplitude", "/integrations/mixpanel", "/integrations/bigquery", "/features/webhooks", "/charts/revenue"],
  },

  // ------------------------------------------------------------ Amplitude
  {
    kind: "amplitude",
    slug: "amplitude",
    name: "Amplitude",
    category: "analytics",
    logo: "amplitude.svg",
    card: "Subscription events and revenue next to your product analytics in Amplitude.",
    title: "Send in-app subscription events to Amplitude",
    metaTitle: "Send in-app subscription events to Amplitude",
    metaDescription: "Send subscription events and revenue to Amplitude, matched on $amplitudeDeviceId, so revenue charts line up with your product analytics. Retried and logged.",
    answer:
      "RevenueDot sends every purchase, trial, renewal, cancellation and refund to Amplitude's HTTP V2 API as events like `rc_initial_purchase_event`. Money events carry `revenue`, `price`, `productId` and a `revenueType` of purchase, renewal or refund, so they feed Amplitude's revenue charts. The user is `$amplitudeUserId` and `$amplitudeDeviceId` when your app sets them.",
    uses: [
      "Chart revenue, trials and churn in Amplitude next to feature usage.",
      "Build funnels from a paywall view to `rc_trial_started_event` to `rc_trial_converted_event`.",
      "Segment retention by subscription status without exporting a spreadsheet.",
      "Send production and sandbox purchases to two separate Amplitude projects.",
    ],
    sends: [
      "One event per RevenueDot event through the HTTP V2 API, with `insert_id` set to the event id so Amplitude drops a retried duplicate and `partner_id` set to `revenuedot`.",
      "Event types are the `rc_*_event` names, plus `rc_purchase_redeemed` and `rc_experiment_enrollment_event`. Rename any of them under **Event names**.",
      "Initial purchases, trial conversions, renewals, one-time purchases, cancellations and refund reversals carry `revenue`, `price`, `quantity` 1, `productId` and `revenueType` (`purchase`, `renewal` or `refund`).",
      "The identity is `$amplitudeUserId` as `user_id` and `$amplitudeDeviceId` as `device_id` when your app sets them, otherwise the app user id as `user_id`.",
      "Each event sets the user property `rc_subscription_status` and carries `platform` (iOS, Android, Web and so on) and `country`.",
      "Sandbox events are sent only when you save a **Sandbox API key** for a second Amplitude project.",
      "Paywall events are opt-in: tick **Send paywall events** to get `paywall_impression`, `paywall_close`, `paywall_cancel`, `paywall_exit_offer` and `paywall_component_interacted`, plus RevenueDot's `paywall_purchase_initiated` and `paywall_purchase_error`. They carry the paywall, offering and session, and no revenue.",
    ],
    setup: [
      { name: "Copy your API keys", text: "In Amplitude, copy the project's API key. For sandbox events, also copy the key of a second project." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Amplitude." },
      { name: "Paste the keys", text: "Paste the key into **API key** and, optionally, the second one into **Sandbox API key**." },
      { name: "Pick the region", text: "Choose **Region**: US or EU. Pick **Sales reporting** too." },
      { name: "Connect and test", text: "Click **Connect Amplitude**, then **Send test event** and find `rc_test_event` in Amplitude's User Lookup." },
    ],
    blocks: [delivery("Amplitude")],
    faq: [
      sdk("Amplitude", "In your app, set `$amplitudeUserId` and `$amplitudeDeviceId` with the SDK's `setAttributes` call so events land on the right Amplitude user."),
      {
        q: "Is it the same as RevenueCat's Amplitude integration?",
        a: "It sends the same `rc_*_event` names and reads the same `$amplitudeUserId` and `$amplitudeDeviceId` attributes, so existing charts keep working. " + newer("Amplitude"),
      },
      { q: "Why are sandbox events missing in Amplitude?", a: "Sandbox events are sent only to a second Amplitude project through **Sandbox API key**. Without that key, RevenueDot skips them and says so in the delivery log." },
      { q: "Does it support Amplitude's EU data center?", a: "Yes. Choose **EU** under **Region** and RevenueDot sends events to api.eu.amplitude.com." },
    ],
    partner: [
      { label: "Amplitude", url: "https://amplitude.com" },
      { label: "Amplitude HTTP V2 API", url: "https://amplitude.com/docs/apis/analytics/http-v2" },
      { label: "RevenueCat Amplitude integration", url: "https://www.revenuecat.com/docs/integrations/third-party-integrations/amplitude" },
    ],
    docs: [{ href: `${GUIDE}#amplitude`, label: "Amplitude setup in the integrations guide" }, ATTRS],
    related: ["/integrations/mixpanel", "/integrations/segment", "/integrations/posthog", "/charts/mrr", "/features/webhooks"],
  },

  // ------------------------------------------------------------- Mixpanel
  {
    kind: "mixpanel",
    slug: "mixpanel",
    name: "Mixpanel",
    category: "analytics",
    logo: "mixpanel.svg",
    card: "Events, revenue and subscription status on Mixpanel profiles.",
    title: "Mixpanel integration for subscription events and revenue",
    metaTitle: "Mixpanel integration for in-app subscription revenue",
    metaDescription: "Send subscription events to Mixpanel with revenue in USD, subscription status on each profile and $transactions entries, so Mixpanel's revenue reports work.",
    answer:
      "RevenueDot sends every subscription event to Mixpanel, such as `rc_initial_purchase_event` and `rc_renewal_event`, each with revenue in US dollars. The customer's profile gets `rc_subscription_status` and an entry in the reserved `$transactions` list, so Mixpanel's revenue reports work. Add your project API secret to also accept events older than five days.",
    uses: [
      "Run Mixpanel's revenue and LTV reports on real subscription transactions.",
      "Break down trial conversion by country, store or product.",
      "Filter users by `rc_subscription_status`, for example `cancelled` or `grace_period`.",
      "Replay old events into Mixpanel after you fix a setting.",
    ],
    sends: [
      "An event named like `rc_trial_started_event` through the Ingestion API, with `distinct_id` set to `$mixpanelDistinctId` when your app sets it, otherwise the app user id.",
      "`$insert_id` is derived from the event id, so Mixpanel deduplicates retries.",
      "The properties include `revenue`, `currency` (`USD`), `product_id`, `store`, `offer_code`, `period_type`, `environment`, `entitlement_ids`, transaction ids and `$country_code`.",
      "A profile update sets `rc_subscription_status`. When revenue is not zero, it also appends a `$transactions` entry with `$time`, `$amount`, `product_id` and `store`.",
      "With a **Project API secret**, events go through `/import`, which accepts events of any age. Without it they go through `/track`, which accepts only the last five days.",
      "Sandbox events go only to a project you save as **Sandbox project token**. Data residency can be US, EU or India.",
      "Paywall events are opt-in: tick **Send paywall events** to get `paywall_impression`, `paywall_close`, `paywall_cancel`, `paywall_exit_offer` and `paywall_component_interacted`, plus RevenueDot's `paywall_purchase_initiated` and `paywall_purchase_error`. They carry the paywall, offering and session, and no revenue.",
    ],
    setup: [
      { name: "Copy the project token", text: "In Mixpanel, open **Project settings** and copy the project token. Copy a second project's token for sandbox events, and optionally the project **API secret**." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Mixpanel." },
      { name: "Paste the credentials", text: "Fill **Project token**, **Sandbox project token** and **Project API secret** (optional, needed to replay old events)." },
      { name: "Pick residency and revenue", text: "Choose **Data residency**: US, EU or India. Pick **Sales reporting**." },
      { name: "Connect and test", text: "Click **Connect Mixpanel**, then **Send test event** and check Mixpanel's Live View." },
    ],
    blocks: [delivery("Mixpanel", ["Mixpanel answers some bad events with HTTP 200 and `status: 0`. RevenueDot treats that as a failure and logs Mixpanel's error text."])],
    faq: [
      sdk("Mixpanel", "Set `$mixpanelDistinctId` with the SDK's attribute call if your app already identifies users in Mixpanel."),
      {
        q: "Is it the same as RevenueCat's Mixpanel integration?",
        a: "It sends the same `rc_*_event` names, the same `rc_subscription_status` profile property and reads the same `$mixpanelDistinctId` attribute. " + newer("Mixpanel"),
      },
      { q: "Why do old events not show up in Mixpanel?", a: "Without a **Project API secret**, Mixpanel's `/track` endpoint accepts only events from the last five days. Save the secret and RevenueDot uses `/import`, which accepts any age." },
      { q: "Do revenue reports work?", a: "Yes. Every event with revenue also adds a `$transactions` entry on the profile, which is what Mixpanel's revenue reports read." },
    ],
    partner: [
      { label: "Mixpanel", url: "https://mixpanel.com" },
      { label: "Mixpanel Ingestion API", url: "https://developer.mixpanel.com/reference/ingestion-api" },
      RC_LIST,
    ],
    docs: [{ href: `${GUIDE}#mixpanel`, label: "Mixpanel setup in the integrations guide" }, ATTRS],
    related: ["/integrations/amplitude", "/integrations/segment", "/integrations/posthog", "/charts/mrr", "/charts/revenue"],
  },

  // -------------------------------------------------------------- PostHog
  {
    kind: "posthog",
    slug: "posthog",
    name: "PostHog",
    category: "analytics",
    logo: "posthog.svg",
    card: "Revenue events for PostHog funnels, retention and session replays.",
    title: "Track in-app subscription revenue in PostHog",
    metaTitle: "Track in-app subscription revenue in PostHog",
    metaDescription: "Send purchases, trials, renewals and refunds to PostHog, with event names you can rename and subscription status on the person.",
    answer:
      "RevenueDot sends every purchase, trial, renewal, cancellation and refund to PostHog's capture endpoint as events like `rc_renewal_event`, with revenue in US dollars and the product, store and entitlements as properties. The person's `rc_subscription_status` is set on each event. It works with PostHog US Cloud, EU Cloud and self-hosted PostHog, and `uuid` stops duplicates.",
    uses: [
      "Build funnels from a paywall view to a paid subscription.",
      "Compare retention of trial users and paying users in PostHog.",
      "Watch session replays of users who hit `rc_billing_issue_event`.",
      "Send subscription events to PostHog.",
    ],
    sends: [
      "One event per RevenueDot event through the capture endpoint, named `rc_initial_purchase_event`, `rc_trial_started_event`, `rc_renewal_event` and so on. Rename them under **Event names**.",
      "`distinct_id` is `$posthogUserId` when your app sets it, otherwise the app user id. `uuid` is the event id, so PostHog deduplicates retries.",
      "The properties include `revenue` in US dollars, `currency`, `product_id`, `store`, `entitlement_ids`, `transaction_id`, `period_type`, `environment`, `country_code` and `platform`.",
      "Each event sets `rc_subscription_status` on the person with `$set`.",
      "Sandbox events are sent only when you save a **Sandbox project API key**.",
      "The three web funnel events (`rd_funnel_viewed`, `rd_funnel_step_completed`, `rd_funnel_purchase`) are opt-in.",
      "Paywall events are opt-in: tick **Send paywall events** to get `paywall_impression`, `paywall_close`, `paywall_cancel`, `paywall_exit_offer` and `paywall_component_interacted`, plus RevenueDot's `paywall_purchase_initiated` and `paywall_purchase_error`. They carry the paywall, offering and session, and no revenue.",
    ],
    setup: [
      { name: "Copy the project API key", text: "In PostHog, copy the **Project API key** (it starts with `phc_`). Copy a second project's key for sandbox events." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose PostHog." },
      { name: "Paste the keys", text: "Fill **Project API key** and, optionally, **Sandbox project API key**." },
      { name: "Pick the region", text: "Choose **Region**: US Cloud, EU Cloud or Self-hosted. For Self-hosted, enter your **PostHog URL**." },
      { name: "Connect and test", text: "Pick **Sales reporting**, click **Connect PostHog**, then **Send test event** and look for `rc_test_event` in Activity." },
    ],
    blocks: [delivery("PostHog")],
    faq: [
      sdk("PostHog", "Set `$posthogUserId` with the SDK's attribute call so purchases land on the same person as your in-app events."),
      {
        q: "Is it the same as RevenueCat's PostHog integration?",
        a: "It sends the same `rc_*_event` names and reads the same `$posthogUserId` attribute. " + newer("PostHog"),
      },
      { q: "Does it work with self-hosted PostHog?", a: "Yes. Choose **Self-hosted** under **Region** and enter your **PostHog URL**. RevenueDot checks that address with its outbound URL guard when you save." },
      { q: "Are refunds sent?", a: "A refund arrives as `rc_cancellation_event` with negative revenue, because PostHog accepts negative amounts." },
    ],
    partner: [
      { label: "PostHog", url: "https://posthog.com" },
      { label: "PostHog capture API", url: "https://posthog.com/docs/api/capture" },
      RC_LIST,
    ],
    docs: [{ href: `${GUIDE}#posthog`, label: "PostHog setup in the integrations guide" }, ATTRS],
    related: ["/integrations/amplitude", "/integrations/mixpanel", "/integrations/segment", "/charts/active-trials"],
  },

  // ------------------------------------------------------------- Firebase
  {
    kind: "firebase",
    slug: "firebase",
    name: "Firebase",
    category: "analytics",
    logo: "firebase.svg",
    card: "Purchase events in Google Analytics for Firebase, from your server.",
    title: "Send in-app purchase events to Firebase and Google Analytics",
    metaTitle: "In-app purchase events in Firebase Analytics",
    metaDescription: "Send subscription purchases and renewals to Google Analytics for Firebase as purchase events through the Measurement Protocol, using $firebaseAppInstanceId.",
    answer:
      "RevenueDot sends purchases, trial conversions, renewals and one-time purchases to Google Analytics for Firebase as the standard `purchase` event, with `value`, `currency`, `items`, `is_renewal` and `is_trial_conversion`. Other steps arrive as `rc_*` events such as `rc_cancellation`. It uses the Measurement Protocol and needs the customer's `$firebaseAppInstanceId` attribute.",
    uses: [
      "See subscription revenue in GA4 reports and Firebase's purchase and revenue views.",
      "Use renewals and trial conversions as audiences or conversions in Firebase.",
      "Send revenue in US dollars or in the currency the customer paid in.",
      "Build Firebase audiences of paying and cancelled customers.",
    ],
    sends: [
      "Purchases, trial conversions, renewals and one-time purchases arrive as `purchase`, with `value`, `currency`, `coupon`, `items`, `is_renewal` and `is_trial_conversion`.",
      "The other steps arrive as `rc_trial_start`, `rc_cancellation` (cancellations and trial cancellations), `rc_uncancellation`, `rc_subscription_paused`, `rc_expiration`, `rc_billing_issue`, `rc_product_change`, `rc_transfer` and `rc_test`.",
      "Every event needs the customer's `$firebaseAppInstanceId` attribute. Without it, RevenueDot skips the event and says why in the delivery log.",
      "Only App Store and Google Play purchases are sent, each to the iOS or Android stream you configured. Sandbox events carry `environment: SANDBOX`.",
      "**Currency** is either US dollars or the currency the customer paid in. Refunds are not sent as purchases, because GA4 has no negative purchase.",
    ],
    setup: [
      { name: "Get the stream details", text: "In Firebase, open **Google Analytics, Admin, Data streams**, pick the iOS or Android stream, copy its **Firebase App ID** and create a **Measurement Protocol API secret**." },
      { name: "Set the app instance id", text: "In your app, send Firebase Analytics' app instance id with `Purchases.shared.attribution.setFirebaseAppInstanceID(Analytics.appInstanceID())`." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Firebase." },
      { name: "Enter the stream values", text: "Fill **iOS Firebase app ID** and **iOS Measurement Protocol API secret**, **Android Firebase app ID** and **Android Measurement Protocol API secret**, or only the platform you use." },
      { name: "Choose currency and connect", text: "Pick **Currency** and **Sales reporting**, click **Connect Firebase**, then **Send test event** and open GA's Realtime report." },
    ],
    blocks: [delivery("Google Analytics", ["Google accepts every Measurement Protocol request without checking it, so a wrong app ID or secret still shows as delivered. Check GA's Realtime report after the test event."])],
    faq: [
      sdk("Firebase", "Your app must set `$firebaseAppInstanceId` with the SDK before the purchase, or RevenueDot skips the event."),
      {
        q: "Is it the same as RevenueCat's Firebase integration?",
        a: "It reads the same `$firebaseAppInstanceId` attribute and sends the same `purchase` and `rc_*` events through the Measurement Protocol. " + newer("Firebase"),
      },
      { q: "Why was my event skipped?", a: "The usual reason is a missing `$firebaseAppInstanceId`. The delivery log shows the reason. Once the app sends the id, click **Retry** and the event goes through." },
      { q: "Does it send web purchases?", a: "No. Firebase app streams are for iOS and Android, so purchases from Stripe or other web stores are skipped." },
    ],
    partner: [
      { label: "Firebase", url: "https://firebase.google.com" },
      { label: "GA4 Measurement Protocol", url: "https://developers.google.com/analytics/devguides/collection/protocol/ga4" },
      RC_LIST,
    ],
    docs: [{ href: `${GUIDE}#firebase`, label: "Firebase setup in the integrations guide" }, ATTRS],
    related: ["/integrations/google-tag-manager", "/integrations/bigquery", "/integrations/amplitude", "/charts/revenue"],
  },

  // ------------------------------------------------------------- BigQuery
  {
    kind: "bigquery",
    slug: "bigquery",
    name: "BigQuery",
    category: "core",
    logo: "bigquery.svg",
    card: "Every purchase event as a row in your BigQuery table, streamed as it happens.",
    title: "Stream in-app purchase events into BigQuery",
    metaTitle: "Stream in-app purchase events into BigQuery",
    metaDescription: "Stream every subscription and purchase event into a BigQuery table as it happens. RevenueDot creates the day-partitioned table, with revenue_usd and raw JSON.",
    answer:
      "RevenueDot streams every purchase, renewal, cancellation, refund and billing event into a BigQuery table as one row per event, as it happens. It creates the table for you, partitioned by day on `event_timestamp`, with columns such as `revenue_usd`, `store`, `product_id` and a `payload` JSON column holding the whole event. Retried rows are deduplicated by `insertId`.",
    uses: [
      "Run SQL on subscription revenue, trials and churn next to your product data.",
      "Join purchase events to app analytics tables in the same BigQuery dataset.",
      "Feed Looker Studio or another BI tool from a live table.",
      "Keep your own copy of every purchase event, sandbox included.",
    ],
    sends: [
      "Every event type is sent, sandbox included. Filter on the `environment` column.",
      "One row per event through the streaming insert API, with `insertId` set to the event id.",
      "The columns are `id`, `type`, `event_timestamp`, `app_user_id`, `original_app_user_id`, `aliases`, `app_id`, `environment`, `store`, `product_id`, `new_product_id`, `period_type`, `purchased_at`, `expiration_at`, `entitlement_ids`, `presented_offering_id`, `transaction_id`, `original_transaction_id`, `country_code`, `currency`, `price_in_purchased_currency`, `price_usd`, `revenue_usd`, `is_trial_conversion`, `cancel_reason`, `expiration_reason` and `payload`.",
      "`revenue_usd` follows your **Sales reporting** choice: gross, or after store commission and taxes.",
      "If the table does not exist, RevenueDot creates it, partitioned by day on `event_timestamp`. The default table name is `revenuedot_events`.",
    ],
    setup: [
      { name: "Create a service account", text: "In Google Cloud, create a service account with the **BigQuery Data Editor** role on a dataset and download its JSON key." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose BigQuery." },
      { name: "Paste the key", text: "Paste the JSON into **Service account key (JSON)**. Leave **Project ID** empty to use the service account's project." },
      { name: "Name the dataset and table", text: "Enter **Dataset** and, optionally, **Table**. The default is `revenuedot_events`." },
      { name: "Connect and test", text: "Pick **Sales reporting**, click **Connect BigQuery**, then **Send test event** and query the table." },
    ],
    blocks: [
      {
        h2: "Query daily revenue from the events table",
        paras: ["This query sums production revenue per day. Replace the project and dataset with yours."],
        code: {
          title: "Daily revenue",
          label: "BigQuery SQL",
          code: "SELECT DATE(event_timestamp) AS day, SUM(revenue_usd) AS revenue\nFROM `my-project.revenue.revenuedot_events`\nWHERE environment = 'PRODUCTION'\n  AND type IN ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE', 'CANCELLATION')\nGROUP BY day ORDER BY day DESC;",
        },
      },
      delivery("BigQuery", ["BigQuery can answer HTTP 200 with `insertErrors`. RevenueDot treats that as a failure and logs the first error."]),
    ],
    faq: [
      sdk("BigQuery", "BigQuery needs no attributes. Every event RevenueDot records goes into the table."),
      {
        q: "Is it the same as RevenueCat's integrations?",
        a: "No. BigQuery is an addition beyond RevenueCat's integration catalogue: a live streaming table instead of scheduled files. For files in S3, R2, GCS or Azure, or by email, use RevenueDot's scheduled data exports.",
      },
      { q: "Does RevenueDot create the table?", a: "Yes. If the table is missing, RevenueDot creates it with its schema, partitioned by day on `event_timestamp`, the first time an event arrives." },
      { q: "Are sandbox purchases included?", a: "Yes. BigQuery receives every event, so use `WHERE environment = 'PRODUCTION'` to leave sandbox rows out of your reports." },
    ],
    partner: [
      { label: "Google BigQuery", url: "https://cloud.google.com/bigquery" },
      { label: "BigQuery tabledata.insertAll", url: "https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/insertAll" },
      RC_LIST,
    ],
    docs: [{ href: `${GUIDE}#bigquery`, label: "BigQuery setup in the integrations guide" }, { href: `${GUIDE}#scheduled-data-exports`, label: "Scheduled data exports to S3, R2, GCS, Azure or email" }],
    related: ["/integrations/data-exports", "/integrations/webhooks", "/integrations/segment", "/charts/revenue"],
  },

  // ------------------------------------------------------------ AppsFlyer
  {
    kind: "appsflyer",
    slug: "appsflyer",
    name: "AppsFlyer",
    category: "attribution",
    logo: "appsflyer.svg",
    card: "Report purchases, trials and renewals to AppsFlyer with the customer's AppsFlyer id.",
    title: "Report in-app subscription revenue to AppsFlyer from your server",
    metaTitle: "Send subscription revenue events to AppsFlyer",
    metaDescription: "Send purchases, trials and renewals to AppsFlyer's server-to-server API with $appsflyerId and revenue on each event, so installs get credited with revenue.",
    answer:
      "RevenueDot reports purchases, trial starts, conversions, renewals and refunds to AppsFlyer's server-to-server in-app events API with the customer's `$appsflyerId`. Each event has a name such as `rc_renewal_event` and an `eventValue` with `af_revenue`, `af_price`, `af_content_id`, `renewal` and `af_currency`. Refunds carry negative revenue.",
    uses: [
      "Credit subscription revenue to the campaign or media source that drove the install.",
      "Optimize ad campaigns for trial starts and paid conversions, not just installs.",
      "Report renewals months after install, when the app is not open.",
      "Report Stripe, Web Billing and Paddle purchases through AppsFlyer's Web S2S API, or the legacy PBA API for Stripe.",
      "Send web funnel events to AppsFlyer's web S2S API as well.",
    ],
    sends: [
      "Events named `rc_initial_purchase_event`, `rc_trial_started_event`, `rc_trial_converted_event`, `rc_renewal_event`, `rc_cancellation_event` and so on. Rename them under **Event names**.",
      "`eventValue` holds `af_revenue`, `af_price`, `renewal`, `af_content_id` (the product id), `af_currency` (`USD`) and `af_order_id` (the transaction id). Refunds carry negative revenue.",
      "Web store purchases go to the Web S2S API (**Web SDK ID** and **Web S2S API token**) or, for Stripe on the legacy PBA setup, the PBA API. **Web store event routing** sends a customer who has `$appsflyerId` to the app's mobile API (the default) or every web purchase to the web API. A purchase is never sent twice.",
      "App Store and Play events need the customer's `$appsflyerId` attribute. Without it, RevenueDot skips the event and says why in the delivery log.",
      "Device ids come from the attributes `$idfa`, `$idfv`, `$gpsAdId`, `$amazonAdId` and `$ip`. `$appsflyerSharingFilter` becomes `sharing_filter`.",
      "Sandbox events are sent only with a **Sandbox developer key**. Web funnel events need the **Web SDK ID** and **Web S2S API token**.",
    ],
    setup: [
      { name: "Copy the keys", text: "In AppsFlyer, copy the **dev key** (or an S2S token) and your app IDs: `id123456789` for iOS and the package name for Android." },
      { name: "Set the AppsFlyer id", text: "In your app, set `$appsflyerId` with the AppsFlyer SDK's id and call `collectDeviceIdentifiers()` before the first purchase." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose AppsFlyer." },
      { name: "Enter keys and app IDs", text: "Fill **Developer key**, **iOS app ID** and **Android app ID**. Tick **The key is an S2S token** if it is one, and add **Sandbox developer key** for sandbox events." },
      { name: "Connect and test", text: "Pick **Sales reporting**, click **Connect AppsFlyer**, then **Send test event** for a customer who has `$appsflyerId`." },
    ],
    blocks: [delivery("AppsFlyer", ["Turn off purchase tracking in the AppsFlyer SDK, so the same purchase is not counted twice."])],
    faq: [
      sdk("AppsFlyer", "Set `$appsflyerId` and call `collectDeviceIdentifiers()` in the app, because AppsFlyer cannot attribute an event without the id."),
      {
        q: "Is it the same as RevenueCat's AppsFlyer integration?",
        a: "It reads the same `$appsflyerId` and device-id attributes. RevenueCat does not publish AppsFlyer's default event names, so RevenueDot uses its usual `rc_*_event` names, and you can rename any of them. " + newer("AppsFlyer"),
      },
      { q: "Why is an event skipped?", a: "Most often the customer has no `$appsflyerId`. Once the app sends it, click **Retry** on the skipped delivery." },
      { q: "Does it send web purchases?", a: "Yes. Fill **Web SDK ID** and **Web S2S API token** (or, on AppsFlyer's legacy PBA, **Web (PBA) bundle ID** and **Web (PBA) dev key**, Stripe only), then pick the **Web store event routing**. Sandbox web purchases go only through the mobile API, because AppsFlyer's web APIs have no sandbox." },
      { q: "Does it send web funnel events?", a: "Yes, opt-in. Add the funnel event types and fill **Web SDK ID** and **Web S2S API token**. They go to AppsFlyer's Web S2S API as `rd_funnel_viewed`, `rd_funnel_step_completed` and `rd_funnel_purchase`." },
    ],
    partner: [
      { label: "AppsFlyer", url: "https://www.appsflyer.com" },
      { label: "AppsFlyer S2S events API", url: "https://dev.appsflyer.com/hc/reference/s2s-events-api3-post" },
      { label: "AppsFlyer PBA Web S2S API", url: "https://dev.appsflyer.com/hc/reference/web-s2s-api-event-post" },
      { label: "RevenueCat AppsFlyer integration", url: "https://www.revenuecat.com/docs/integrations/attribution/appsflyer" },
      { label: "RevenueCat AppsFlyer event delivery reference", url: "https://www.revenuecat.com/docs/integrations/attribution/reference/appsflyer" },
    ],
    docs: [{ href: `${GUIDE}#appsflyer`, label: "AppsFlyer setup in the integrations guide" }, ATTRS],
    related: ["/integrations/adjust", "/integrations/branch", "/integrations/meta-ads", "/integrations/apple-search-ads", "/features/webhooks"],
  },

  // --------------------------------------------------------------- Adjust
  {
    kind: "adjust",
    slug: "adjust",
    name: "Adjust",
    category: "attribution",
    logo: "adjust.svg",
    card: "Report purchases and renewals to Adjust with event tokens you choose.",
    title: "Send subscription revenue events to Adjust with your own event tokens",
    metaTitle: "Send subscription revenue events to Adjust",
    metaDescription: "Send purchases, trials and renewals to Adjust's server-to-server API with $adjustId and one event token per step, with revenue in USD for attribution.",
    answer:
      "RevenueDot sends purchases, trial starts, trial conversions, renewals, cancellations and expirations to Adjust's server-to-server events endpoint. You create one Adjust event token per step and enter it in RevenueDot. Each event carries the customer's `$adjustId`, device ids and revenue in US dollars. Steps without a token, and customers without `$adjustId`, are skipped.",
    uses: [
      "Credit paid conversions to the campaign and network that drove the install.",
      "Optimize ad spend on trial starts and renewals instead of installs.",
      "Choose which steps count by creating a token only for those.",
      "Send sandbox purchases to Adjust's sandbox environment while you test.",
    ],
    sends: [
      "Ten steps can be sent: initial purchase, trial started, trial converted, trial cancelled, renewal, cancellation, one-time purchase, expiration, product change and test. Each uses the event token you enter, so there are no event names to rename.",
      "A step with no token is skipped. A customer without the `$adjustId` attribute is skipped too.",
      "Device ids come from `$idfa`, `$idfv`, `$gpsAdId` and `$ip`. The request is sent with `s2s=1` and `created_at_unix`.",
      "Revenue is in US dollars with `currency` set to `USD`. Adjust rejects amounts below 0.001, so trials and refunds are sent without revenue.",
      "Sandbox events go to Adjust's sandbox (`environment=sandbox`). `callback_params` carries the app user id, app id and product id.",
    ],
    setup: [
      { name: "Create event tokens", text: "In Adjust, copy each app's **app token** and create one **event token** per step you want, such as purchase, trial started and renewal." },
      { name: "Set the Adjust id", text: "In your app, set `$adjustId` to the Adjust SDK's `adid` and call `collectDeviceIdentifiers()`." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Adjust." },
      { name: "Enter tokens", text: "Fill **iOS app token**, **Android app token** and **Event tokens**. Add **S2S auth token** only if S2S security is on in Adjust." },
      { name: "Connect and test", text: "Pick **Sales reporting**, click **Connect Adjust**, then **Send test event** for a customer who has `$adjustId`." },
    ],
    blocks: [delivery("Adjust", ["Adjust can answer HTTP 200 with an `error` field. RevenueDot treats that as a failure and logs Adjust's message."])],
    faq: [
      sdk("Adjust", "Set `$adjustId` with the SDK's attribute call and call `collectDeviceIdentifiers()`, because Adjust cannot match an event without the `adid`."),
      {
        q: "Is it the same as RevenueCat's Adjust integration?",
        a: "It reads the same `$adjustId` and device-id attributes and uses event tokens that you create in Adjust, as RevenueCat's does. " + newer("Adjust"),
      },
      { q: "Why is revenue missing on trial events?", a: "Adjust rejects amounts below 0.001, so a trial start, which has no price, is sent without revenue. Paid steps carry revenue in US dollars." },
      { q: "Do I need the S2S auth token?", a: "Only when S2S security is turned on for the app in Adjust. RevenueDot then sends it as a Bearer token." },
    ],
    partner: [
      { label: "Adjust", url: "https://www.adjust.com" },
      { label: "Adjust S2S events API", url: "https://dev.adjust.com/en/api/s2s-api/events" },
      RC_ATTRIBUTION,
    ],
    docs: [{ href: `${GUIDE}#adjust`, label: "Adjust setup in the integrations guide" }, ATTRS],
    related: ["/integrations/appsflyer", "/integrations/branch", "/integrations/meta-ads", "/integrations/singular", "/features/webhooks"],
  },

  // ------------------------------------------------------------- Meta Ads
  {
    kind: "meta",
    slug: "meta-ads",
    name: "Meta Ads",
    category: "attribution",
    logo: "meta-ads.svg",
    card: "Send subscription purchase conversions to Meta through the Conversions API or the App Events API.",
    title: "Send subscription purchases to Meta Ads through the Conversions API",
    metaTitle: "Send subscription purchases to Meta Ads (CAPI)",
    metaDescription: "Send trial starts, subscriptions and renewals to Meta's Conversions API as StartTrial and Subscribe events, so Facebook and Instagram ads optimize for payers.",
    answer:
      "RevenueDot sends trial starts as `StartTrial`, and purchases, trial conversions and renewals as `Subscribe`, to your Meta dataset through the Conversions API for app events, or to your Meta app through the App Events API. One-time purchases arrive as `fb_mobile_purchase`. Meta matches the customer by `$fbAnonId` or an advertising id. The app user id, email and phone are sent as SHA-256 hashes.",
    uses: [
      "Optimize Facebook and Instagram campaigns for trial starts and paid subscriptions.",
      "Report renewals that happen long after the install.",
      "Test events safely in Events Manager's Test Events tab.",
      "Send web funnel events to Meta as website events, opt-in.",
    ],
    sends: [
      "Trial starts are `StartTrial`. Purchases, trial conversions and renewals are `Subscribe`. One-time purchases are `fb_mobile_purchase`. Rename them under **Event names**.",
      "Each event has `action_source: app`, `event_id` set to the event id, `custom_data` with `currency` (`USD`), `value` and `order_id`, and `partner_agent: revenuedot`.",
      "`user_data` has the hashed app user id as `external_id`, plus `madid` or `anon_id`, and hashed `em` and `ph` when `$email` and `$phoneNumber` are set.",
      "Matching needs `$fbAnonId` or an advertising id (`$idfa`, `$gpsAdId` or `$amazonAdId`). On iOS, `$attConsentStatus` must be `authorized`, unless you turn on **Send iOS events without ATT consent**.",
      "Meta takes no negative revenue, so refunds and other steps are not sent. Test events go only with a **Test event code**.",
      "Sandbox events go only to a **Sandbox dataset ID** with its own token.",
      "With **Integration type** set to **App Events API**, events go to your Meta app's `/activities` endpoint as `CUSTOM_APP_EVENTS` with its **Client token**, `advertiser_id` or `anon_id`, and hashed email and phone. App Store customers need `$attConsentStatus` = `authorized` with no override, and test events go only to the **Sandbox app ID**.",
      "Both types send `X-Forwarded-For` with `$ip` when the customer has it.",
    ],
    setup: [
      { name: "Get the dataset and token", text: "In Meta Events Manager, open the dataset linked to your app, copy the **Dataset ID** and generate a **Conversions API access token**. For the App Events API instead, copy the app's **App ID** and **Client token** (App settings → Advanced)." },
      { name: "Set the Meta ids", text: "In your app, call `collectDeviceIdentifiers()` and set `$fbAnonId` with the Meta SDK's anonymous id." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Meta Ads." },
      { name: "Enter the values", text: "Pick the **Integration type**. For the Conversions API, fill **Dataset ID** and **Conversions API access token**, and optionally **Sandbox dataset ID**, **Sandbox access token** and a **Test event code**. For the App Events API, fill **Meta app ID** and **Client token**, and optionally **Sandbox app ID** and **Sandbox client token**." },
      { name: "Connect and test", text: "Pick **Sales reporting**, click **Connect Meta Ads**, then **Send test event** and watch the Test Events tab." },
    ],
    blocks: [delivery("Meta", ["Turn off automatic purchase logging in the Meta SDK, so the same purchase is not counted twice."])],
    faq: [
      sdk("Meta Ads", "Call `collectDeviceIdentifiers()` and set `$fbAnonId` in the app, so Meta can match the purchase to the ad click."),
      {
        q: "Is it the same as RevenueCat's Meta integration?",
        a: "It follows RevenueCat's behavior: `StartTrial`, `Subscribe` and `fb_mobile_purchase`, the same `$fbAnonId` and `$attConsentStatus` attributes, and hashed user data. " + newer("Meta"),
      },
      { q: "Why does iOS skip some events?", a: "On iOS, RevenueDot sends an event only when `$attConsentStatus` is `authorized`. You can turn on **Send iOS events without ATT consent** if your own privacy review allows it." },
      { q: "Will test events count as real conversions?", a: "No. RevenueDot sends a test event only when you save a **Test event code**, so it shows in Events Manager's Test Events tab and never counts toward ad delivery." },
    ],
    partner: [
      { label: "Meta Ads", url: "https://www.facebook.com/business/ads" },
      { label: "Meta Conversions API for app events", url: "https://developers.facebook.com/docs/marketing-api/conversions-api" },
      { label: "Meta App Events API", url: "https://developers.facebook.com/docs/marketing-api/app-event-api" },
      RC_ATTRIBUTION,
    ],
    docs: [{ href: `${GUIDE}#meta`, label: "Meta setup in the integrations guide" }, { href: `${GUIDE}#funnel-events-to-ad-networks`, label: "Funnel events to ad networks" }],
    related: ["/integrations/appsflyer", "/integrations/adjust", "/integrations/google-tag-manager", "/integrations/branch", "/features/webhooks"],
  },

  // --------------------------------------------------------------- Branch
  {
    kind: "branch",
    slug: "branch",
    name: "Branch",
    category: "attribution",
    logo: "branch.svg",
    card: "Send trials, subscriptions and purchases to Branch to attribute revenue to links and campaigns.",
    title: "Attribute subscription revenue to Branch links and campaigns",
    metaTitle: "Send subscription revenue events to Branch",
    metaDescription: "Send trials, subscriptions and purchases to Branch's v2 Events API as START_TRIAL, SUBSCRIBE and PURCHASE, to credit revenue to links and campaigns.",
    answer:
      "RevenueDot sends trial starts as `START_TRIAL`, purchases, trial conversions and renewals as `SUBSCRIBE`, and one-time purchases as `PURCHASE` to Branch's v2 Events API, with revenue in US dollars and the product as a content item. Other steps go as custom events named like `rc_cancellation_event`. Branch needs a device id, and `developer_identity` is the app user id.",
    uses: [
      "Credit subscription revenue to the Branch link or campaign behind each install.",
      "Measure which deep links bring users who pay.",
      "Build Branch audiences from trial starts and cancellations.",
      "Send web funnel events to Branch as web events, opt-in.",
    ],
    sends: [
      "`START_TRIAL`, `SUBSCRIBE` and `PURCHASE` go to Branch's standard event endpoint. Every other step goes to the custom event endpoint as `rc_<step>_event`.",
      "Paid events carry `event_data.revenue` in US dollars, `currency` `USD` and a content item for the product. Branch takes no negative revenue, so refunds carry none.",
      "`developer_identity` is `$branchId` when your app sets it, otherwise the app user id.",
      "On iOS the customer needs `$idfa` or `$idfv`. On Android the customer needs `$gpsAdId` or `$androidId`. Without one, RevenueDot skips the event.",
      "`custom_data.event_id` holds the event id for your own deduplication, because Branch has no event id field.",
      "Use the live key (`key_live_`) in **Branch key** and the test key (`key_test_`) in **Sandbox Branch key**. Without the sandbox key, sandbox events are not sent.",
    ],
    setup: [
      { name: "Copy the Branch keys", text: "In Branch, open **Account Settings, Profile** and copy the live Branch Key (`key_live_`). Copy the test key (`key_test_`) for sandbox events." },
      { name: "Collect device ids", text: "In your app, call `collectDeviceIdentifiers()` so RevenueDot has `$idfa` or `$idfv` on iOS and `$gpsAdId` or `$androidId` on Android." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Branch." },
      { name: "Enter the keys", text: "Fill **Branch key** and **Sandbox Branch key**, and pick **Sales reporting**." },
      { name: "Connect and test", text: "Click **Connect Branch**, then **Send test event** for a customer who has a device id." },
    ],
    blocks: [delivery("Branch", ["Branch answers some rejected events with an `error` field. RevenueDot logs Branch's message."])],
    faq: [
      sdk("Branch", "Call `collectDeviceIdentifiers()` in the app, so RevenueDot has the device ids Branch needs to match the event."),
      {
        q: "Is it the same as RevenueCat's Branch integration?",
        a: "It follows RevenueCat's behavior: `START_TRIAL`, `SUBSCRIBE` and `PURCHASE` as Branch standard events, other steps as custom events with the `rc_*_event` names. " + newer("Branch"),
      },
      { q: "Why does RevenueDot reject my Branch key?", a: "**Branch key** must be the live key and start with `key_live_`. The test key, which starts with `key_test_`, goes in **Sandbox Branch key**." },
      { q: "Are web purchases sent?", a: "Not as app events. Web purchases are skipped by the app event path. Opt-in funnel events can go to Branch as web events with the visitor's user agent, IP address and page URL." },
    ],
    partner: [
      { label: "Branch", url: "https://www.branch.io" },
      { label: "Branch v2 Events API", url: "https://help.branch.io/apidocs/events-api" },
      RC_ATTRIBUTION,
    ],
    docs: [{ href: `${GUIDE}#branch`, label: "Branch setup in the integrations guide" }, ATTRS],
    related: ["/integrations/appsflyer", "/integrations/adjust", "/integrations/meta-ads", "/integrations/singular", "/features/webhooks"],
  },

  // ---------------------------------------------------------------- Braze
  {
    kind: "braze",
    slug: "braze",
    name: "Braze",
    category: "marketing",
    logo: "braze.svg",
    card: "Custom events, purchases and rc_subscription_status on Braze user profiles.",
    title: "Send subscription events and revenue to Braze user profiles",
    metaTitle: "Send in-app subscription events to Braze",
    metaDescription: "Send subscription events to Braze with each customer's subscription status on their profile and order placed events for revenue. Retried, logged, open source.",
    answer:
      "RevenueDot sends each subscription event to Braze in one `/users/track` request: a custom event named like `rc_trial_started_event`, the `rc_subscription_status` attribute, and for paid events an `ecommerce.order_placed` event or a legacy purchase object. The user is a Braze alias when you set one, otherwise the app user id as `external_id`.",
    uses: [
      "Start Canvas journeys when a trial starts, a billing issue appears or a subscription is cancelled.",
      "Segment users by `rc_subscription_status` for win-back and upgrade messages.",
      "Report revenue to Braze through its recommended eCommerce events.",
      "Send production and sandbox events to two separate Braze workspaces.",
    ],
    sends: [
      "A custom event per step, named `rc_initial_purchase_event`, `rc_trial_started_event`, `rc_renewal_event` and so on, for 13 steps. Rename them under **Event names**.",
      "The `rc_subscription_status` attribute is set on the user in the same request.",
      "Paid events (initial purchase, trial conversion, renewal, one-time purchase) with revenue above zero also send either `ecommerce.order_placed` or a purchase object. **Revenue** chooses which.",
      "The user is the alias `$brazeAliasName` plus `$brazeAliasLabel` when both are set, otherwise the app user id as `external_id`.",
      "Refunds are not sent as negative purchases. An optional **App identifier** ties events to one Braze app.",
    ],
    setup: [
      { name: "Create a REST API key", text: "In Braze, copy your instance's **REST endpoint** from **Settings, APIs and Identifiers** and create a REST API key with the `users.track` permission." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Braze." },
      { name: "Choose endpoint and key", text: "Pick the **REST endpoint** and paste the key into **REST API key**. Add **Sandbox REST API key** for sandbox events, from a second workspace." },
      { name: "Choose revenue format", text: "Optionally fill **App identifier**. Pick **Revenue**: **eCommerce order placed events** or **Legacy purchase objects**, and pick **Sales reporting**." },
      { name: "Connect and test", text: "Click **Connect Braze**, then **Send test event** and find `rc_test_event` on the user." },
    ],
    blocks: [delivery("Braze", ["Braze answers HTTP 201 with `errors` when it rejects part of a request. RevenueDot treats that as a failure and logs the first error.", "Braze has no idempotency key, so a replayed event is recorded again."])],
    faq: [
      sdk("Braze", "Set `$brazeAliasName` and `$brazeAliasLabel` with the SDK's attribute calls only if you identify Braze users by alias."),
      {
        q: "Is it the same as RevenueCat's Braze integration?",
        a: "It sends the same `rc_*_event` names and `rc_subscription_status` attribute, and reads the same alias attributes. " + newer("Braze"),
      },
      { q: "Which Braze regions work?", a: "Choose your instance's REST endpoint from the list: US-01 to US-08, US-10, EU-01, EU-02, AU-01, ID-01, JP-01 or KR-01. RevenueDot rejects any other address when you save." },
      { q: "Does replaying an event create a duplicate?", a: "Yes. Braze has no idempotency key, so a replayed event is recorded a second time. Replay only events that truly failed." },
    ],
    partner: [
      { label: "Braze", url: "https://www.braze.com" },
      { label: "Braze /users/track endpoint", url: "https://www.braze.com/docs/api/endpoints/user_data/post_user_track" },
      { label: "RevenueCat Braze integration", url: "https://www.revenuecat.com/docs/integrations/third-party-integrations/braze" },
    ],
    docs: [{ href: `${GUIDE}#braze`, label: "Braze setup in the integrations guide" }, ATTRS],
    related: ["/integrations/customer-io", "/integrations/clevertap", "/integrations/iterable", "/integrations/onesignal", "/features/webhooks"],
  },

  // ------------------------------------------------------------ CleverTap
  {
    kind: "clevertap",
    slug: "clevertap",
    name: "CleverTap",
    category: "marketing",
    logo: "clevertap.svg",
    card: "Subscription events and rc_subscription_status on CleverTap profiles.",
    title: "Send subscription events to CleverTap profiles",
    metaTitle: "Send in-app subscription events to CleverTap",
    metaDescription: "Send subscription events to CleverTap's Upload API with each customer's subscription status on their profile, in any CleverTap region. Retried and logged.",
    answer:
      "RevenueDot sends each subscription event to CleverTap's Upload API as an event named like `rc_renewal_event`, together with a profile update that sets `rc_subscription_status`. The event carries revenue in US dollars, product, store and transaction ids. The user is `$clevertapId` as `objectId` when set, otherwise the app user id as `identity`.",
    uses: [
      "Trigger CleverTap journeys on trial starts, billing issues and cancellations.",
      "Build segments from `rc_subscription_status`, such as `grace_period` or `cancelled`.",
      "Report renewals and revenue back to CleverTap profiles.",
      "Send sandbox purchases to a second CleverTap account.",
    ],
    sends: [
      "One request to `/1/upload` per event, with an event record named `rc_initial_purchase_event`, `rc_trial_started_event`, `rc_renewal_event` and so on, for 12 steps.",
      "Event data includes `revenue`, `currency` (`USD`), `product_id`, `store`, `environment`, `period_type`, `transaction_id`, `country_code` and `event_id`. Entitlement ids are joined with commas, because CleverTap takes flat properties.",
      "A profile record sets `rc_subscription_status` when the event changes it.",
      "The user is `$clevertapId` as `objectId` when set, otherwise the app user id as `identity`.",
      "Sandbox events are sent only when you fill both **Sandbox account ID** and **Sandbox passcode**.",
    ],
    setup: [
      { name: "Copy the credentials", text: "In CleverTap, copy the **Account ID** and **Passcode** from the project's settings. Copy a second account's for sandbox events." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose CleverTap." },
      { name: "Enter the account", text: "Fill **Account ID** and **Passcode**, and optionally **Sandbox account ID** and **Sandbox passcode**." },
      { name: "Pick the region", text: "Choose **Region**: Europe, India (in1), Singapore (sg1), United States (us1), Indonesia (aps3) or Middle East, UAE (mec1). Pick **Sales reporting**." },
      { name: "Connect and test", text: "Click **Connect CleverTap**, then **Send test event** and find `rc_test_event` on the profile." },
    ],
    blocks: [delivery("CleverTap", ["CleverTap answers HTTP 200 with `status` set to `partial` or `fail` when it rejects records. RevenueDot treats that as a failure and logs the error.", "CleverTap documents no idempotency key, so a replayed event is recorded again."])],
    faq: [
      sdk("CleverTap", "Set `$clevertapId` with the SDK's attribute call if you identify users by their CleverTap id."),
      {
        q: "Is it the same as RevenueCat's CleverTap integration?",
        a: "It sends the same `rc_*_event` names and `rc_subscription_status` profile property, and reads the same `$clevertapId` attribute. " + newer("CleverTap"),
      },
      { q: "Which region is the default?", a: "Europe, which uses api.clevertap.com. Choose your account's region under **Region**, or events go to the wrong cluster." },
      { q: "Does replaying an event create a duplicate?", a: "Yes. CleverTap documents no idempotency key, so a replayed event is recorded a second time." },
    ],
    partner: [
      { label: "CleverTap", url: "https://clevertap.com" },
      { label: "CleverTap Upload Events API", url: "https://developer.clevertap.com/docs/upload-events-api" },
      { label: "RevenueCat CleverTap integration", url: "https://www.revenuecat.com/docs/integrations/third-party-integrations/clevertap" },
    ],
    docs: [{ href: `${GUIDE}#clevertap`, label: "CleverTap setup in the integrations guide" }, ATTRS],
    related: ["/integrations/braze", "/integrations/customer-io", "/integrations/onesignal", "/integrations/iterable", "/features/webhooks"],
  },

  // ---------------------------------------------------------- Customer.io
  {
    kind: "customerio",
    slug: "customer-io",
    name: "Customer.io",
    category: "marketing",
    logo: "customer-io.svg",
    card: "Subscription events and rc_subscription_status on Customer.io people, for campaigns and segments.",
    title: "Send subscription events to Customer.io people for campaigns",
    metaTitle: "Send in-app subscription events to Customer.io",
    metaDescription: "Send subscription events to Customer.io's Track API with subscription status on the person and dedupe-safe event ids, so campaigns react to each change.",
    answer:
      "RevenueDot sends each subscription event to Customer.io's Track API in two calls: an identify call that updates the person's `rc_subscription_status`, `app_user_id` and email, then the event, named like `rc_trial_converted_event`, with purchase details as event data. The person's id is `$customerioId` when set, otherwise the app user id.",
    uses: [
      "Start a campaign when `rc_trial_started_event` or `rc_billing_issue_event` arrives.",
      "Segment people by `rc_subscription_status` for win-back and upsell emails.",
      "Use revenue and product in event data to personalize messages.",
      "Keep production and sandbox events in two separate workspaces.",
    ],
    sends: [
      "First a `PUT /api/v1/customers/{id}` identify, which creates the person when missing and sets `rc_subscription_status`, `app_user_id` and `email` (from `$email`).",
      "Then `POST /api/v1/customers/{id}/events` with the name `rc_initial_purchase_event`, `rc_renewal_event` and so on, for 13 steps. Rename them under **Event names**.",
      "Event data includes `revenue` in US dollars, `currency`, `product_id`, `platform`, `store`, `entitlement_ids`, `transaction_id`, `period_type`, `country_code` and `rc_subscription_status`.",
      "The event `id` is a ULID derived from RevenueDot's event id, so Customer.io drops a retried event instead of recording it twice.",
      "The person's id is `$customerioId` when your app sets it, otherwise the app user id. Data is sent to the US or EU Track API, as you choose.",
    ],
    setup: [
      { name: "Copy Track API credentials", text: "In Customer.io, open **Workspace Settings, API Credentials** and copy the Track API **Site ID** and **API key**." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Customer.io." },
      { name: "Enter the credentials", text: "Fill **Site ID** and **Track API key**. For sandbox events, fill **Sandbox site ID** and **Sandbox Track API key** from a second workspace." },
      { name: "Pick the region", text: "Choose **Region**: US (track.customer.io) or EU (track-eu.customer.io). Pick **Sales reporting**." },
      { name: "Connect and test", text: "Click **Connect Customer.io**, then **Send test event** and find `rc_test_event` on the person's activity." },
    ],
    blocks: [delivery("Customer.io")],
    faq: [
      sdk("Customer.io", "Set `$customerioId` and `$email` with the SDK's attribute calls if you want events on an existing Customer.io person."),
      {
        q: "Is it the same as RevenueCat's Customer.io integration?",
        a: "It sends the same `rc_*_event` names and `rc_subscription_status` attribute, and reads the same `$customerioId` and `$email` attributes. " + newer("Customer.io"),
      },
      { q: "Will a retry create a duplicate event?", a: "No. The event id is a ULID derived from RevenueDot's event id, and Customer.io drops a repeated one." },
      { q: "Does it create people that do not exist yet?", a: "Yes. The identify call is a `PUT`, which creates the person when missing, before the event is recorded." },
    ],
    partner: [
      { label: "Customer.io", url: "https://customer.io" },
      { label: "Customer.io Track API", url: "https://docs.customer.io/integrations/api/track/" },
      { label: "RevenueCat Customer.io integration", url: "https://www.revenuecat.com/docs/integrations/third-party-integrations/customerio" },
    ],
    docs: [{ href: `${GUIDE}#customerio`, label: "Customer.io setup in the integrations guide" }, ATTRS],
    related: ["/integrations/braze", "/integrations/intercom", "/integrations/iterable", "/integrations/clevertap", "/features/webhooks"],
  },

  // -------------------------------------------------------------- Discord
  {
    kind: "discord",
    slug: "discord",
    name: "Discord",
    category: "marketing",
    logo: "discord.svg",
    card: "Post new purchases, trials, cancellations, refunds and billing issues to a Discord channel.",
    title: "Discord notifications for in-app purchases and subscriptions",
    metaTitle: "Discord alerts for in-app purchases and subscriptions",
    metaDescription: "Post every new subscription, trial, renewal, cancellation, refund and billing issue to a Discord channel as an embed, with mentions turned off.",
    answer:
      "RevenueDot posts one Discord embed to a channel webhook for each purchase, trial start, trial conversion, renewal, cancellation, refund, one-time purchase, billing issue, product change and refund reversal. Each embed shows the customer, product, revenue in US dollars, store and country. Green marks good news and red marks cancellations. Mentions are turned off.",
    uses: [
      "Follow every sale and trial in your team's Discord server.",
      "Spot cancellations and billing issues without opening a dashboard.",
      "Share a live sales feed with a small team or community moderators.",
      "Keep refunds visible to everyone who handles support.",
    ],
    sends: [
      "One embed per event for 11 types: initial purchase, trial started, trial converted, trial cancelled, renewal, cancellation, one-time purchase, billing issue, product change, refund reversed and the test event.",
      "Each embed has the customer (linked to their dashboard page), `Product`, `Revenue` on money events, `Store`, `Country` and a timestamp.",
      "A refund reads `was refunded` and shows the negative revenue. Expirations, pauses and transfers are not posted.",
      "Sandbox events are labelled `Sandbox` and are posted only when the integration's environment includes sandbox.",
      "`allowed_mentions` is empty and ids are escaped as plain text, so an app user id like `@everyone` never pings anyone.",
    ],
    setup: [
      { name: "Create a webhook", text: "In Discord, open the channel's settings, then **Integrations, Webhooks, New Webhook**, and copy the webhook URL." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Discord." },
      { name: "Paste the URL", text: "Paste it into **Webhook URL**. RevenueDot checks that it is a discord.com webhook and shows only its last four characters afterward." },
      { name: "Choose the revenue", text: "Pick **Sales reporting**: gross revenue, or after store commission and taxes." },
      { name: "Connect and test", text: "Click **Connect Discord**, then **Send test event** to see a test embed in the channel." },
    ],
    blocks: [delivery("Discord")],
    faq: [
      sdk("Discord", "Discord needs no attributes or device ids, only the purchases that reach RevenueDot."),
      {
        q: "Is it the same as RevenueCat's Discord integration?",
        a: "It does the same job, sale and subscription alerts in a channel. The embed layout is RevenueDot's own. RevenueCat documents its version in its [Discord integration guide](https://www.revenuecat.com/docs/integrations/third-party-integrations/discord). " + newer("Discord"),
      },
      { q: "Can an app user id ping my whole server?", a: "No. Ids are escaped as text and mentions are turned off, so `@everyone` or `<@id>` in an id stays plain text." },
      { q: "Which webhook URLs are accepted?", a: "Webhook URLs on discord.com or discordapp.com (including ptb. and canary.) that look like `/api/webhooks/<id>/<token>`. Anything else is rejected when you save." },
    ],
    partner: [
      { label: "Discord", url: "https://discord.com" },
      { label: "Discord Execute Webhook API", url: "https://docs.discord.com/developers/resources/webhook" },
      { label: "RevenueCat Discord integration", url: "https://www.revenuecat.com/docs/integrations/third-party-integrations/discord" },
    ],
    docs: [{ href: `${GUIDE}#discord`, label: "Discord setup in the integrations guide" }, BEHAVIOR],
    related: ["/integrations/slack", "/integrations/webhooks", "/features/webhooks", "/charts/revenue"],
  },

  // -------------------------------------------------- Google Tag Manager
  {
    kind: "google_tag_manager",
    slug: "google-tag-manager",
    name: "Google Tag Manager",
    category: "attribution",
    logo: "google-tag-manager.svg",
    card: "Send purchases to your server-side Tag Manager container, for GA4, Google Ads and any tag it runs.",
    title: "Send in-app purchases to a server-side Google Tag Manager container",
    metaTitle: "In-app purchases to server-side Google Tag Manager",
    metaDescription: "Send subscription purchases to your server-side Tag Manager container as GA4 purchase events, then route them to GA4, Google Ads or any other tag.",
    answer:
      "RevenueDot posts purchases, trial conversions, renewals and one-time purchases to your server-side Google Tag Manager container as GA4's `purchase` event, with `value`, `transaction_id` and `items`. Other steps use names like `rc_cancellation_event`. The container's Measurement Protocol (GA4) client receives them, and your tags forward them to GA4, Google Ads or any other destination.",
    uses: [
      "Send subscription revenue to Google Ads for conversion tracking from one server container.",
      "Fan purchases out to GA4 and other tags without changing the app.",
      "Reuse the tags your web team already runs in the server container.",
      "Keep sandbox purchases in a separate GA4 stream.",
    ],
    sends: [
      "Initial purchases, trial conversions, renewals and one-time purchases are sent as `purchase` with `currency` (`USD`), `value`, `transaction_id`, `coupon`, `items`, `is_renewal` and `is_trial_conversion`.",
      "Other steps are named like `rc_trial_started_event` and `rc_billing_issue_event`. Rename any of them under **Event names**.",
      "The request is a POST to your container's `/mp/collect` with `measurement_id` and, if you set one, `api_secret`.",
      "`client_id` and `user_id` are the app user id, because an app has no GA browser cookie. `event_id` is the event id, for deduplication in your tags.",
      "GA4 has no negative purchase, so refunds carry no value. Sandbox events are sent only with a **Sandbox measurement ID**.",
    ],
    setup: [
      { name: "Add the GA4 client", text: "In Tag Manager, open the server container, then **Admin, Container Settings**, and copy the server container URL. Add a **Measurement Protocol (GA4)** client on the path `/mp/collect`." },
      { name: "Copy the measurement id", text: "In GA4, copy the data stream's **Measurement ID** (it starts with `G-`). A **Measurement Protocol API secret** is optional." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Google Tag Manager." },
      { name: "Enter the values", text: "Fill **Server container URL** and **Measurement ID**, and optionally **Measurement Protocol API secret**, **Sandbox measurement ID** and **Sandbox API secret**." },
      { name: "Connect and test", text: "Pick **Sales reporting**, click **Connect Google Tag Manager**, then **Send test event** and check the container's preview mode." },
    ],
    blocks: [delivery("your Tag Manager container")],
    faq: [
      sdk("Google Tag Manager", "No attributes are required. RevenueDot uses the app user id as the GA4 `client_id` and `user_id`."),
      {
        q: "Is it the same as RevenueCat's Google Tag Manager integration?",
        a: "It follows RevenueCat's behavior of sending purchases to a server-side container as GA4 events. Names for non-purchase steps follow the `rc_*_event` pattern. " + newer("Tag Manager"),
      },
      { q: "Does it work with a web container?", a: "No. It needs a server-side container, because RevenueDot calls the container's URL from the server." },
      { q: "Which URL do I enter?", a: "The server container URL only, without `?` or `#`. RevenueDot adds `/mp/collect` and the measurement id itself." },
    ],
    partner: [
      { label: "Google Tag Manager", url: "https://marketingplatform.google.com/about/tag-manager/" },
      { label: "Send data to a server container", url: "https://developers.google.com/tag-platform/tag-manager/server-side/send-data" },
      RC_ATTRIBUTION,
    ],
    docs: [{ href: `${GUIDE}#google_tag_manager`, label: "Google Tag Manager setup in the integrations guide" }, { href: `${GUIDE}#funnel-events-to-ad-networks`, label: "Funnel events to ad networks" }],
    related: ["/integrations/firebase", "/integrations/meta-ads", "/integrations/bigquery", "/integrations/appsflyer", "/features/webhooks"],
  },

  // ------------------------------------------------------------- Intercom
  {
    kind: "intercom",
    slug: "intercom",
    name: "Intercom",
    category: "marketing",
    logo: "intercom.svg",
    card: "Subscription events on Intercom contacts, for series, segments and messages.",
    title: "Send subscription events to Intercom contacts",
    metaTitle: "Send in-app subscription events to Intercom",
    metaDescription: "Send subscription events to Intercom contacts with subscription_status and the price in cents, for series, segments and messages about each subscription.",
    answer:
      "RevenueDot sends each subscription event to Intercom as a data event on the contact, named like `rc_initial_purchase_event`, with the product, entitlement, store, `subscription_status` and, on paid events, the price in cents. The contact is found by user id, which is your app user id. Anonymous customers need the `$email` attribute. It works in US, EU and Australia workspaces.",
    uses: [
      "Start an Intercom series when a trial starts or a billing issue appears.",
      "Segment contacts by subscription events for targeted in-app messages.",
      "Show subscription history in a contact's activity.",
      "Message customers who cancelled or whose subscription expired.",
    ],
    sends: [
      "A data event per step through `POST /events`, named `rc_initial_purchase_event`, `rc_trial_started_event`, `rc_renewal_event` and so on, for 11 steps. Rename them under **Event names**.",
      "The metadata holds up to 10 keys, such as `product_identifier`, `entitlement`, `store`, `environment`, `subscription_status`, `expires_at`, `period_type` and `cancellation_reason`.",
      "Paid events with revenue above zero carry `price` as an amount in cents with currency `usd`. Refunds carry none.",
      "The contact is the app user id as `user_id`. Anonymous app user ids use `$email` instead and are skipped without it.",
      "Intercom answers 404 for a contact it does not have. Sandbox events go to the same workspace with `environment: SANDBOX` when the environment includes sandbox.",
    ],
    setup: [
      { name: "Copy an access token", text: "In the Intercom Developer Hub, open your app's **Authentication** and copy the **Access token**." },
      { name: "Open the integration", text: "In RevenueDot, open **Integrations** in the project sidebar and choose Intercom." },
      { name: "Paste the token", text: "Paste it into **Access token**." },
      { name: "Pick the region", text: "Choose **Data hosting region**: US (api.intercom.io), EU (api.eu.intercom.io) or Australia (api.au.intercom.io). Pick **Sales reporting**." },
      { name: "Connect and test", text: "Click **Connect Intercom**, then **Send test event** for a customer whose user id exists in Intercom." },
    ],
    blocks: [delivery("Intercom", ["Intercom returns errors as an `error.list` body. RevenueDot logs the first message.", "Intercom deduplicates on contact, event name and `created_at`, so a retried event is not recorded twice."])],
    faq: [
      sdk("Intercom", "Set `$email` with the SDK's attribute call for anonymous customers, because Intercom finds contacts by user id or email."),
      {
        q: "Is it the same as RevenueCat's Intercom integration?",
        a: "It sends the same `rc_*_event` names as Intercom data events. " + newer("Intercom"),
      },
      { q: "Is this the same as the Intercom inbox app?", a: "No. This integration sends events to contacts. The separate Intercom inbox app shows each customer's subscription next to a conversation, and needs no access token." },
      { q: "Why did Intercom answer 404?", a: "Intercom has no contact with that user id. Create the contact in Intercom with your app user id as its external id, then retry the event." },
    ],
    partner: [
      { label: "Intercom", url: "https://www.intercom.com" },
      { label: "Intercom data events API", url: "https://developers.intercom.com/docs/references/rest-api/api.intercom.io/data-events/createdataevent" },
      { label: "RevenueCat Intercom integration", url: "https://www.revenuecat.com/docs/integrations/third-party-integrations/intercom" },
    ],
    docs: [{ href: `${GUIDE}#intercom`, label: "Intercom setup in the integrations guide" }, ATTRS],
    related: ["/integrations/intercom-inbox", "/integrations/customer-io", "/integrations/braze", "/integrations/zendesk", "/features/webhooks"],
  },

  // ------------------------------------------------------- Intercom inbox
  {
    kind: "intercom_inbox",
    slug: "intercom-inbox",
    name: "Intercom inbox",
    category: "support",
    logo: "intercom-inbox.svg",
    card: "Subscription status, plan, renewal date and total spent next to each conversation in Intercom.",
    title: "Show subscription status next to each Intercom conversation",
    metaTitle: "Show subscription status in the Intercom inbox",
    metaDescription: "Show each customer's subscription status, plan, renewal date, total spent, refunds and open tickets in the Intercom inbox sidebar. Open source.",
    answer:
      "The RevenueDot Intercom inbox app is a Canvas Kit app that shows each customer's subscription status, active entitlements, plan, store, renewal or expiry date, billing issue, total spent, customer since, refund requests and open tickets next to the conversation. Intercom calls RevenueDot directly, and RevenueDot checks every request's signature. No API key is involved.",
    uses: [
      "Answer billing questions without switching to a dashboard.",
      "See at once whether a customer is subscribed, in a trial or past due.",
      "Spot refund requests and open tickets while you reply.",
      "Open the customer in RevenueDot with one button.",
    ],
    sends: [
      "This app sends no events. Intercom calls `POST /v1/support/intercom/{project_id}/canvas` and RevenueDot answers with Canvas Kit components.",
      "The sidebar table shows status, active entitlements, plan, store, renewal or expiry date, billing issue, total spent, customer since, refund requests and open tickets, with an **Open in RevenueDot** button.",
      "Every request is checked with the hex HMAC-SHA256 in the `X-Body-Signature` header, computed with your app's client secret. A missing or wrong signature gets a 401.",
      "The customer is found by the contact's user id (`external_id`, which should be your app user id), then by the contact's email against the customers' `$email` attribute.",
      "A project without a connected Intercom inbox answers 404, and a contact with no match shows a message saying so.",
    ],
    setup: [
      { name: "Create the Intercom app", text: "In the Intercom Developer Hub, create an app and open **Canvas Kit**. For the **Inbox**, set the initialize URL to `https://api.revenuedot.app/v1/support/intercom/{project_id}/canvas`, with your project id." },
      { name: "Copy the client secret", text: "In the Developer Hub, open **Basic information** and copy the app's **client secret**." },
      { name: "Connect in RevenueDot", text: "In RevenueDot, open **Integrations** in the project sidebar, choose Intercom inbox, paste the secret into **Intercom app client secret** and click **Connect Intercom inbox**." },
      { name: "Install the app", text: "Install the app in your Intercom workspace and add it to the inbox sidebar." },
    ],
    blocks: [
      {
        h2: "How RevenueDot checks each Intercom request",
        paras: [
          "Intercom signs the raw request body with your app's client secret. RevenueDot computes the same signature with the secret you saved and answers 401 when it is missing or does not match.",
          "The client secret is sealed with AES-256-GCM on the server and is never shown again after you save it.",
        ],
      },
    ],
    faq: [
      sdk("Intercom inbox", "Set `$email` with the SDK's attribute call so RevenueDot can find customers whose Intercom contact has no user id."),
      { q: "Is this the same as the Intercom events integration?", a: "No. The events integration sends subscription events to contacts and needs an access token. The inbox app shows the customer's subscription in the sidebar and needs only the app's client secret." },
      { q: "Does the inbox app need an API key?", a: "No. Intercom calls RevenueDot directly, and RevenueDot verifies the signature with the client secret. No RevenueDot API key is involved." },
      { q: "What if the contact has no match?", a: "The sidebar says so. RevenueDot looks first for the contact's user id as your app user id, then for the contact's email against the customers' `$email` attribute." },
    ],
    partner: [
      { label: "Intercom", url: "https://www.intercom.com" },
      { label: "Intercom Canvas Kit", url: "https://developers.intercom.com/docs/canvas-kit" },
    ],
    docs: [{ href: "/docs/guides/support-integrations#intercom", label: "Intercom inbox setup in the support guide" }, { href: `${GUIDE}#intercom`, label: "Intercom events integration" }],
    related: ["/integrations/intercom", "/integrations/zendesk", "/integrations/slack", "/features/webhooks"],
  },
];
