// Store landing pages: /stores/<slug>. Facts come from docs/guides/{app-store,google-play,amazon-appstore,stripe,test-store}.md
// and docs/STATUS.md. Writing rules: apps/site/CONTENT.md.
import type { Landing } from "./types";

const SIGNUP = "https://app.revenuedot.app/signup";

export const STORES: Landing[] = [
  {
    slug: "app-store",
    section: "stores",
    name: "App Store",
    card: "Server Notifications v2, StoreKit 2 checks, win-back offers and Apple refund requests on your server.",
    label: "Store",
    title: "App Store Server Notifications v2 setup and StoreKit 2 validation for your subscription backend",
    metaTitle: "App Store Server Notifications v2 setup (StoreKit 2)",
    metaDescription:
      "Set up App Store Server Notifications v2 in five steps. RevenueDot verifies StoreKit 2 purchases, reads Apple's App Store Server API and keeps your SDK.",
    answer:
      "To set up App Store Server Notifications v2, copy your app's notification URL from RevenueDot, paste it as both the Production and Sandbox Server URL in App Store Connect, and choose Version 2. Add an In-App Purchase key so RevenueDot can read each customer's full StoreKit 2 history from Apple's App Store Server API.",
    shot: {
      src: "lifecycle/refund-control.png",
      alt: "The Refund Control page in the RevenueDot dashboard, where ordered policies pick the answer sent to Apple's CONSUMPTION_REQUEST notification",
      caption: "Refund Control answers Apple's refund requests with the same In-App Purchase key.",
    },
    points: [
      { title: "StoreKit 2 verified", text: "RevenueDot checks every signed JWS transaction against Apple's root certificate." },
      { title: "Notifications v2", text: "Renewals, cancellations, billing retries and refunds arrive when they happen, not when the app next opens." },
      { title: "One key, many jobs", text: "The In-App Purchase key also signs promotional offers, answers refund requests and looks up order IDs." },
      { title: "RevenueCat SDK unchanged", text: "Your app keeps `import RevenueCat` and changes one proxy URL line." },
    ],
    blocks: [
      {
        h2: "How to set up App Store Server Notifications v2 with RevenueDot",
        label: "Setup",
        steps: [
          {
            name: "Create the App Store app",
            text: `In the dashboard open **Apps**, add an **App Store** app and enter your bundle ID. The app's public SDK key starts with \`appl_\`. [Start free on Cloud](${SIGNUP}) if you do not have an account yet.`,
          },
          {
            name: "Generate an In-App Purchase key",
            text: "In App Store Connect open Users and Access, then Integrations, then In-App Purchase. Click **+**, name the key and download the `.p8` file. Apple lets you download it once. Note the Key ID and the Issuer ID.",
          },
          {
            name: "Save the key and check it",
            text: "Open the app in RevenueDot, drop the `.p8` file, enter both IDs and click **Check credentials**. RevenueDot makes one harmless call to Apple and tells you whether the key works.",
          },
          {
            name: "Paste the notification URL into App Store Connect",
            text: "Copy the app's notification URL, which looks like `https://api.revenuedot.app/v1/notifications/apple/{app_id}`. In App Store Connect open your app, App Information, App Store Server Notifications. Paste it as both the Production Server URL and the Sandbox Server URL and pick **Version 2**.",
          },
          {
            name: "Make a sandbox purchase",
            text: "Buy a subscription with a sandbox tester. The app's notification status in RevenueDot turns **Ready** when the first notification about a known purchase is processed.",
          },
        ],
      },
      {
        h2: "What RevenueDot does with each purchase and notification",
        label: "How it works",
        bullets: [
          "**StoreKit 2:** the SDK posts the signed transaction. RevenueDot verifies the JWS against Apple's root certificate and, with the key, reads the full history and renewal state (auto-renew, billing retry, grace period) from the App Store Server API.",
          "**Without the key:** RevenueDot still verifies StoreKit 2 transactions, but it knows only what the device sent. StoreKit 1 receipts need the key. Without it RevenueDot answers 500 with code 7234, so the SDK keeps the purchase and retries after you add the key.",
          "**Notifications for purchases it has not seen:** RevenueDot stores them and applies them only when **Track new purchases from server-to-server notifications** is on.",
          "**Bundle check:** a notification for another bundle ID, or another Apple app ID when you set one, is refused.",
        ],
      },
      {
        h2: "How RevenueDot answers Apple",
        table: {
          head: ["Status", "When", "What Apple does"],
          rows: [
            ["200", "Every verified notification, including ones about purchases RevenueDot has not seen", "Stops retrying"],
            ["400", "The signature is invalid, or the notification belongs to another bundle ID", "App Store Connect shows the delivery as failed"],
            ["500", "RevenueDot itself failed", "Retries later"],
          ],
          caption: "Check any time with GET /v2/projects/{project_id}/setup_health, which lists each app's notification status.",
        },
      },
      {
        h2: "Check the notification URL and the key from the command line",
        label: "API",
        code: {
          title: "Read the URL, then ask Apple whether the key works",
          label: "terminal",
          code: `# The notification URL to paste into App Store Connect
curl -s "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/apps/$APP_ID/store_settings" \\
  -H "Authorization: Bearer $SECRET_KEY" | jq -r .notification_url

# One harmless call to Apple with the saved In-App Purchase key
curl -s -X POST "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/apps/$APP_ID/actions/verify_credentials" \\
  -H "Authorization: Bearer $SECRET_KEY"`,
        },
      },
      {
        h2: "What else the same Apple key gives you",
        label: "Beyond validation",
        bullets: [
          "**Win-back offers:** Apple's iOS 18 win-back offers work with the SDK unchanged. RevenueDot records the offer on each purchase and sends it as `offer_code` in webhooks.",
          "**Refund requests:** [Refund Control](/features/refund-control) answers Apple's `CONSUMPTION_REQUEST` within the 12-hour window, after you confirm that customers agreed to share usage data with Apple.",
          "**Promotional offers:** the server signs promotional offers with the key.",
          "**Order lookup:** a customer who sends you Apple's receipt email gets their subscription back through Apple's Look Up Order ID, with `restore_purchase_by_order_id`.",
          "**Extensions:** extend one subscription by 1 to 90 days, or every active subscriber of a product after an outage.",
        ],
        paras: [
          "Before you ship, run a purchase with a sandbox tester and check that it reaches the customer page and your webhooks.",
        ],
      },
    ],
    howTo: "How to set up App Store Server Notifications v2 with RevenueDot",
    faq: [
      {
        q: "How do I set up App Store Server Notifications v2?",
        a: "Copy the app's notification URL from RevenueDot, open App Store Connect, App Information, App Store Server Notifications, paste the URL as both the Production and the Sandbox Server URL and choose Version 2. Add an In-App Purchase key in RevenueDot so it can call the App Store Server API.",
      },
      {
        q: "Do I need a different URL for sandbox and production?",
        a: "No. RevenueDot reads the environment from Apple's signed notification, so you paste the same URL in both fields. Sandbox purchases are marked sandbox and stay out of production numbers.",
      },
      {
        q: "Do I need an In-App Purchase key if I use StoreKit 2?",
        a: "You need it for full history and renewal state, and for refund requests and promotional offers. Without it RevenueDot verifies StoreKit 2 transactions but knows only what the device sent. StoreKit 1 receipts are refused with a retryable 500 until you add the key.",
      },
      {
        q: "Does RevenueDot use Apple's deprecated verifyReceipt endpoint?",
        a: "No. RevenueDot verifies signed transactions locally and uses the App Store Server API with your In-App Purchase key. It stores the legacy shared secret but never calls verifyReceipt.",
      },
      {
        q: "Can I keep sending notifications to RevenueCat while I test RevenueDot?",
        a: "Yes. Set a forwarding URL on the app and RevenueDot copies each notification, byte for byte, to it. That is how a side-by-side run during a migration works. See [Migrate from RevenueCat](/migrate-from-revenuecat).",
      },
    ],
    docs: [
      { href: "/docs/guides/app-store", label: "Connect the App Store" },
      { href: "/docs/guides/sandbox-testing", label: "Test with sandbox accounts and Xcode" },
      { href: "/docs/guides/refund-control", label: "Answer Apple refund requests" },
      { href: "/docs/guides/win-back-offers", label: "Win-back offers" },
      { href: "/docs/help/store-notifications-not-arriving", label: "Store notifications not arriving" },
    ],
    related: ["/sdks/ios", "/stores/test-store", "/solutions/receipt-validation", "/features/refund-control", "/migrate-from-revenuecat", "/self-host"],
  },

  {
    slug: "google-play",
    section: "stores",
    name: "Google Play",
    card: "Play Developer API checks, real-time developer notifications over Pub/Sub, voided purchases and base plans.",
    label: "Store",
    title: "Google Play real-time developer notifications setup for subscriptions",
    metaTitle: "Google Play real-time developer notifications setup",
    metaDescription:
      "Connect Google Play to RevenueDot with a service account for the Play Developer API and a Pub/Sub push subscription for real-time developer notifications.",
    answer:
      "To set up Google Play real-time developer notifications, create a Pub/Sub topic, give Google's publisher account the Pub/Sub Publisher role, add a push subscription that points at your RevenueDot notification URL, and paste the topic name into Play Console. A service account lets RevenueDot read each purchase from the Play Developer API.",
    points: [
      { title: "Play Developer API", text: "Every purchase token is read from Google, acknowledged and checked again on each notification." },
      { title: "Pub/Sub push", text: "Renewals, cancellations, holds and refunds arrive at your RevenueDot URL as Google sends them." },
      { title: "Voided-purchase backup", text: "A daily scan of the last 30 days catches refunds whose notification never arrived." },
      { title: "Base plans", text: "Products map to `subscriptionId:basePlanId`, such as `pro:monthly`." },
    ],
    blocks: [
      {
        h2: "How to set up Google Play real-time developer notifications with RevenueDot",
        label: "Setup",
        steps: [
          {
            name: "Create the Google Play app",
            text: `Add a **Google Play** app in RevenueDot with your package name. Its public SDK key starts with \`goog_\`. [Start free on Cloud](${SIGNUP}) first if you have no account.`,
          },
          {
            name: "Create a service account",
            text: "In Google Cloud enable the Google Play Android Developer API, create a service account and download a JSON key. In Play Console, Users and permissions, invite the service account's email with View app information, View financial data and Manage orders and subscriptions.",
          },
          {
            name: "Save the key and check it",
            text: "Drop the JSON file on the app in RevenueDot and click **Check credentials**. New Play Console permissions can take up to 36 hours to apply. Until then the check says the account works but cannot see the app yet.",
          },
          {
            name: "Create the Pub/Sub topic",
            text: "In Google Cloud Pub/Sub create a topic. Give `google-play-developer-notifications@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it.",
          },
          {
            name: "Add a push subscription",
            text: "Add a subscription to the topic with delivery type **Push** and your app's notification URL as the endpoint. It looks like `https://api.revenuedot.app/v1/notifications/google/{app_id}`.",
          },
          {
            name: "Turn on notifications in Play Console",
            text: "In Play Console open Monetize with Play, Monetization setup. Paste the full topic name (`projects/<project>/topics/<topic>`), turn on subscriptions, voided purchases and one-time products, and click **Send test notification**. The app's status in RevenueDot turns **Ready**.",
          },
        ],
      },
      {
        h2: "How RevenueDot treats each Pub/Sub message",
        label: "How it works",
        bullets: [
          "RevenueDot stores the raw message once, keyed by message ID, and copies it to a forwarding URL when you set one.",
          "It then reads the purchase again from the Play Developer API, so a forged message cannot grant access.",
          "Voided-purchase notifications record refunds.",
          "You can also require Google-signed pushes: turn on authentication on the subscription and save the same audience and service account on the app. An unsigned push then gets 401.",
        ],
      },
      {
        h2: "What Pub/Sub gets back",
        table: {
          head: ["Status", "When", "Effect on Pub/Sub"],
          rows: [
            ["200", "The message is handled, a duplicate, for another package name, or about an invalid purchase token", "Stops retrying, because a retry would never succeed"],
            ["500 or 503", "A temporary failure, such as Google's API not answering", "Delivers the message again"],
            ["401", "Authentication is on and the push has no valid Google-signed token", "Message is rejected"],
          ],
        },
      },
      {
        h2: "Product IDs for base plans",
        label: "Catalog",
        paras: [
          "Create a subscription product in RevenueDot with `store_identifier` set to `subscriptionId:basePlanId`, for example `pro:monthly`. For one-time products use the product ID. Android purchases do not name the base plan, so RevenueDot gives a bare subscription ID the union of its base plans' entitlements when it builds the offline entitlement map.",
        ],
        code: {
          title: "Create the app and read the notification URL",
          label: "terminal",
          code: `curl -s -X POST "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/apps" \\
  -H "Authorization: Bearer $SECRET_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"Scanner (Android)","type":"play_store","play_store":{"package_name":"com.example.scanner"}}'

curl -s "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/apps/$APP_ID/store_settings" \\
  -H "Authorization: Bearer $SECRET_KEY" | jq -r .notification_url`,
        },
      },
      {
        h2: "What you can do from the server afterwards",
        label: "Beyond validation",
        bullets: [
          "Refund and revoke a subscription, cancel it (turn auto-renew off) or defer the next renewal by up to 365 days.",
          "Refund a one-time purchase.",
          "Restore a purchase from a Google order ID such as `GPA.1234-5678-9012-34567`, which RevenueDot turns into a purchase token with Google's Orders API.",
          "Create a subscription with one listing in Play Console from your catalog. Add base plans and prices in Play Console.",
        ],
        paras: [
          "Before you rely on a store action, run it once against a Play test track. See [testing with license testers](/docs/guides/sandbox-testing).",
        ],
      },
    ],
    howTo: "How to set up Google Play real-time developer notifications with RevenueDot",
    faq: [
      {
        q: "How do I set up Google Play real-time developer notifications?",
        a: "Create a Pub/Sub topic, give google-play-developer-notifications@system.gserviceaccount.com the Pub/Sub Publisher role, add a push subscription to your notification URL, then paste the topic name under Monetize with Play, Monetization setup in Play Console and send a test notification.",
      },
      {
        q: "Why does the service account check say it cannot see my app?",
        a: "New Play Console permissions can take up to 36 hours to apply. The service account needs View app information, View financial data and Manage orders and subscriptions. Check again later.",
      },
      {
        q: "What happens if RevenueDot is down when Google sends a notification?",
        a: "RevenueDot answers 500 or 503 for temporary failures and Pub/Sub delivers the message again. Once a day RevenueDot also asks Google for the last 30 days of voided purchases as a backup.",
      },
      {
        q: "Why must I acknowledge Google Play purchases?",
        a: "Google refunds purchases that stay unacknowledged for 3 days. RevenueDot acknowledges each purchase after it reads it from the Play Developer API, which needs the service account.",
      },
      {
        q: "Do I need to authenticate the Pub/Sub push?",
        a: "It is optional. RevenueDot trusts only what Google's API returns for a purchase token, so a fake message cannot grant access. Turn authentication on if you also want unsigned pushes rejected with 401.",
      },
    ],
    docs: [
      { href: "/docs/guides/google-play", label: "Connect Google Play" },
      { href: "/docs/sdks/android", label: "Android SDK guide" },
      { href: "/docs/guides/sandbox-testing", label: "Test with Play license testers" },
      { href: "/docs/help/store-notifications-not-arriving", label: "Store notifications not arriving" },
    ],
    related: ["/sdks/android", "/stores/test-store", "/solutions/receipt-validation", "/migrate-from-revenuecat", "/self-host", "/compare/revenuedot-vs-revenuecat"],
  },

  {
    slug: "amazon-appstore",
    section: "stores",
    name: "Amazon Appstore",
    card: "Receipt Verification Service checks and real-time notifications over SNS for Fire tablets and Android apps.",
    label: "Store",
    title: "Amazon Appstore receipt verification and real-time notifications for subscriptions",
    metaTitle: "Amazon Appstore receipt verification (RVS) setup",
    metaDescription:
      "Verify Amazon Appstore receipts with the Receipt Verification Service and receive Real-time Notifications over SNS. Your Android app keeps the RevenueCat SDK.",
    answer:
      "Amazon Appstore receipt verification works through Amazon's Receipt Verification Service (RVS). Save your Amazon shared key in RevenueDot, and it sends every receipt to RVS, which is the only source of dates and state. Add RevenueDot's URL as a Real-time Notifications endpoint so renewals, grace periods and cancellations arrive through SNS.",
    shot: {
      src: "amazon-setup.png",
      alt: "The Amazon app page in the RevenueDot dashboard with the shared key field, the Real-time Notifications URL and its live status",
    },
    points: [
      { title: "RVS is the truth", text: "What the device posts is never trusted for dates or state." },
      { title: "SNS signatures checked", text: "The signing certificate must come from an sns.<region>.amazonaws.com HTTPS URL." },
      { title: "Self-confirming", text: "RevenueDot confirms the SNS subscription by itself and the console shows Verified." },
      { title: "Retry-safe", text: "A missing or rejected key answers 5xx, so the SDK keeps the purchase and retries." },
    ],
    blocks: [
      {
        h2: "How to set up Amazon Appstore receipt verification with RevenueDot",
        label: "Setup",
        steps: [
          {
            name: "Create the Amazon app",
            text: `Add an **Amazon** app in RevenueDot with your package name. Its public SDK key starts with \`amzn_\`. [Start free on Cloud](${SIGNUP}) if you have no account.`,
          },
          {
            name: "Copy the shared key",
            text: "In the Amazon Developer Console open Settings, Identity, and copy the **Shared Key**.",
          },
          {
            name: "Save it and check it",
            text: "Paste the key on the app in RevenueDot and click **Check credentials**. RevenueDot asks RVS about a made-up receipt. Amazon answers 496 for a wrong key, so a bad key shows up here and not on a customer's purchase.",
          },
          {
            name: "Add the Real-time Notifications endpoint",
            text: "In the Amazon Appstore Console open your app, App Services, Real-time Notifications. Add an endpoint with your notification URL, which looks like `https://api.revenuedot.app/v1/notifications/amazon/{app_id}`, and click Submit. RevenueDot confirms the SNS subscription by itself.",
          },
          {
            name: "Point the SDK at RevenueDot",
            text: "Set the proxy URL and configure the SDK with the Amazon key, as in the code below. Your Android app keeps the RevenueCat SDK.",
          },
        ],
      },
      {
        h2: "The SDK configuration for Amazon",
        label: "Android code",
        code: {
          title: "Amazon configuration",
          label: "Kotlin",
          code: `Purchases.proxyURL = URL("https://api.revenuedot.app")   // or your own server
Purchases.configure(AmazonConfiguration.Builder(this, "amzn_…").build())`,
        },
      },
      {
        h2: "What the SDK sees from the server",
        bullets: [
          "The SDK first asks `GET /v1/receipts/amazon/{store_user_id}/{receipt_id}` for a subscription's term SKU, then posts the receipt to `POST /v1/receipts`.",
          "An unknown receipt or user answers **400** (code 7103), so the SDK stops trying.",
          "Amazon being down, throttling, a missing shared key or a rejected one answers **5xx** (code 7101). The SDK keeps the purchase unfulfilled and retries. A rejected key also marks the app's credentials as failing and sends an alert email.",
          "Products use the **term SKU** as `store_identifier` for subscriptions, such as `pro.monthly`.",
        ],
      },
      {
        h2: "How Amazon states map to RevenueDot events",
        table: {
          head: ["What Amazon reports", "Event"],
          rows: [
            ["A new subscription receipt", "`INITIAL_PURCHASE` (`TRIAL` during a free trial)"],
            ["`renewalDate` moved one term later", "`RENEWAL`"],
            ["Auto-renew turned off, or back on", "`CANCELLATION` (`UNSUBSCRIBE`), `UNCANCELLATION`"],
            ["A grace period", "`BILLING_ISSUE` and `CANCELLATION` (`BILLING_ERROR`), access continues to the grace end date"],
            ["Cancel date reached, or grace over", "`EXPIRATION`"],
            ["A deferred tier change", "`PRODUCT_CHANGE` to the deferred SKU"],
            ["A consumable or entitlement bought", "`NON_RENEWING_PURCHASE`"],
          ],
          caption: "Webhooks report store: AMAZON. Amazon has no subscription pause.",
        },
      },
      {
        h2: "Sandbox testing and known limits",
        label: "Honest notes",
        bullets: [
          "Purchases from Live App Testing and Amazon's test transactions are sandbox data and stay out of production numbers.",
          "Receipts from App Tester exist only in RVS's cloud sandbox. RevenueDot asks it when production RVS does not know a receipt.",
          "Amazon's accelerated test timelines are not supported, so event times follow real time.",
          "RVS has no price. RevenueDot saves the price the SDK posts and converts it to USD at the purchase date's rate.",
          "RevenueDot does not detect refunds of Amazon subscriptions, which matches [RevenueCat's documented behavior](https://www.revenuecat.com/docs/subscription-guidance/refunds).",
          "Run a Live App Testing purchase before you ship.",
        ],
      },
    ],
    howTo: "How to set up Amazon Appstore receipt verification with RevenueDot",
    faq: [
      {
        q: "How do I verify Amazon Appstore receipts on my server?",
        a: "Send each receipt to Amazon's Receipt Verification Service (RVS) with your shared key. RevenueDot does this for you: save the shared key on the Amazon app, and every receipt the RevenueCat SDK posts is checked with RVS before access is granted.",
      },
      {
        q: "Where do I find the Amazon shared key?",
        a: "In the Amazon Developer Console under Settings, Identity. Copy the Shared Key and paste it on the app in RevenueDot, then click Check credentials.",
      },
      {
        q: "Does the RevenueCat SDK work on Fire tablets with RevenueDot?",
        a: "Yes. Configure the Android SDK with AmazonConfiguration and your amzn_ key, and set the proxy URL to RevenueDot before configure. Only that URL changes.",
      },
      {
        q: "How do Amazon Real-time Notifications reach RevenueDot?",
        a: "Amazon publishes them through SNS to the endpoint you add in the Appstore Console. RevenueDot confirms the subscription, checks the SNS signature and re-reads the receipt from RVS before it changes anything.",
      },
      {
        q: "Can I test Amazon purchases without going live?",
        a: "Yes. Live App Testing and Amazon's test transactions are recorded as sandbox data, and App Tester receipts are checked against RVS's cloud sandbox. Amazon's accelerated test timelines are not supported.",
      },
    ],
    docs: [
      { href: "/docs/guides/amazon-appstore", label: "Connect the Amazon Appstore" },
      { href: "/docs/sdks/android", label: "Android SDK guide" },
      { href: "/docs/help/store-notifications-not-arriving", label: "Store notifications not arriving" },
      { href: "/docs/help/receipt-errors-4xx-vs-5xx", label: "Receipt errors: 4xx vs 5xx" },
    ],
    related: ["/sdks/android", "/stores/google-play", "/solutions/receipt-validation", "/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat"],
  },

  {
    slug: "stripe",
    section: "stores",
    name: "Stripe",
    card: "Track subscriptions from your own Stripe account and grant access in apps that use the RevenueCat SDK.",
    label: "Store",
    title: "Stripe subscriptions with the RevenueCat SDK, on your own Stripe account",
    metaTitle: "Stripe subscriptions with the RevenueCat SDK",
    metaDescription:
      "Track Stripe subscriptions in RevenueDot with a restricted key and webhooks. The same app user ID grants the entitlement in RevenueCat SDK apps.",
    answer:
      "To use Stripe subscriptions with the RevenueCat SDK, create a Stripe app in RevenueDot, save a restricted API key and a webhook signing secret from your own Stripe account, and post each new subscription to the receipts endpoint with the customer's app user ID. The customer then has the same entitlements in every app that uses that ID.",
    shot: {
      src: "stripe-webhooks.png",
      alt: "The Stripe app page in the RevenueDot dashboard showing the webhook URL, its live status and the events to select in Stripe",
    },
    points: [
      { title: "Your Stripe account", text: "Customers pay you. RevenueDot reads from Stripe and never charges or refunds for tracking." },
      { title: "Webhooks keep it current", text: "Renewals, failed payments, pauses, price changes and refunds come from Stripe-signed events." },
      { title: "One entitlement across stores", text: "Web and app purchases land on the same customer, so `pro` is active everywhere." },
      { title: "Hosted checkout optional", text: "No checkout of your own? RevenueDot can host one on the same Stripe app." },
    ],
    blocks: [
      {
        h2: "How to track Stripe subscriptions with RevenueDot and the RevenueCat SDK",
        label: "Setup",
        steps: [
          {
            name: "Create the Stripe app",
            text: `Add a **Stripe** app in RevenueDot. Its public key starts with \`strp_\`. Create products with \`store_identifier\` set to the Stripe product ID (\`prod_…\`), or a price ID (\`price_…\`) to sell several prices of one product separately. [Start free on Cloud](${SIGNUP}) first if you have no account.`,
          },
          {
            name: "Save a restricted API key",
            text: "In the Stripe Dashboard create a restricted key with **Read** access to Subscriptions, Invoices, Checkout Sessions, Charges, Customers, Products and Prices, and None for everything else. Paste it on the app and click **Check credentials**. A key without a permission names the one it lacks.",
          },
          {
            name: "Add the webhook endpoint",
            text: "In Stripe add an endpoint with your notification URL (`https://api.revenuedot.app/v1/notifications/stripe/{app_id}`) and the subscription, invoice, charge and Checkout events listed in the guide. Paste the endpoint's signing secret (`whsec_…`) on the app.",
          },
          {
            name: "Post each purchase from your backend",
            text: "After Stripe confirms a purchase, post its subscription ID or Checkout Session ID with the customer's app user ID to `POST /v1/receipts` with `X-Platform: stripe`. Posting the same ID again changes nothing.",
          },
          {
            name: "Read the entitlement in your app",
            text: "Log in to the RevenueCat SDK with the same app user ID. `customerInfo.entitlements` now includes the entitlements the Stripe purchase grants.",
          },
        ],
      },
      {
        h2: "Post a Stripe subscription to RevenueDot",
        label: "Backend call",
        code: {
          title: "Record a subscription",
          label: "terminal",
          code: `curl -X POST "$REVENUEDOT_URL/v1/receipts" \\
  -H "Authorization: Bearer strp_…" -H "X-Platform: stripe" -H "Content-Type: application/json" \\
  -d '{"app_user_id":"user_123","fetch_token":"sub_1Abc…"}'`,
        },
        paras: [
          "A subscription ID (`sub_…`) records the subscription. A Checkout Session ID (`cs_…`) records its subscription or, for a payment-mode session, each line item as a one-time purchase. A **400** means the ID can never succeed. A **5xx** means try again later, for example because the first invoice is not paid yet.",
        ],
      },
      {
        h2: "How Stripe states map to RevenueDot events",
        table: {
          head: ["What Stripe reports", "Event"],
          rows: [
            ["An active subscription with a paid invoice", "`INITIAL_PURCHASE` (`TRIAL` while trialing)"],
            ["A new paid invoice for the next period", "`RENEWAL`"],
            ["`cancel_at_period_end`, or a future `cancel_at`", "`CANCELLATION` (`UNSUBSCRIBE`)"],
            ["`past_due`: the renewal invoice failed", "`BILLING_ISSUE`, with access to the end of the paid period"],
            ["`unpaid`, or retries run out", "`EXPIRATION`"],
            ["Another price or product on the subscription", "`PRODUCT_CHANGE`, with no revenue for a proration invoice"],
            ["`charge.refunded` in full for the latest period", "`CANCELLATION` (`CUSTOMER_SUPPORT`) with a negative transaction"],
          ],
          caption: "Revenue is what each invoice charged, so coupons show in revenue. Webhooks report store: STRIPE.",
        },
      },
      {
        h2: "When a Stripe subscription counts, and what is not supported",
        label: "Rules",
        bullets: [
          "By default a subscription counts once its latest invoice is **paid**. Set `register_on` to `invoice_created` to grant access while the first invoice is still open.",
          "Turn on **Track new purchases from server-to-server notifications** to record purchases RevenueDot first hears about from a webhook. The customer comes from metadata (`app_user_id` by default), the Stripe customer ID, or an anonymous ID.",
          "A test-mode key records sandbox data. Use one Stripe app per Stripe account and mode.",
          "Not supported yet: Connect with Stripe (OAuth), subscription schedules, metered and tiered prices, and subscriptions with several items. The purchases-js Web Billing checkout for `rcb_` keys is not served either.",
          "Test in Stripe test mode before you go live.",
        ],
      },
      {
        h2: "No checkout yet? Let RevenueDot host it",
        label: "Web checkout",
        paras: [
          "With write permissions on the same restricted key, RevenueDot creates the Stripe products and prices, hosts purchase links and funnels, and gives buyers a redemption link that grants access in the app. See [web to app](/solutions/web-to-app) and the [web billing guide](/docs/guides/web-billing).",
        ],
      },
    ],
    howTo: "How to track Stripe subscriptions with RevenueDot and the RevenueCat SDK",
    faq: [
      {
        q: "Can I use Stripe subscriptions with the RevenueCat SDK?",
        a: "Yes, through RevenueDot. Create a Stripe app, save a restricted key and a webhook secret, and post each purchase to the receipts endpoint with an app user ID. The RevenueCat SDK in your app then shows the entitlement for that user, because entitlements belong to the customer and not to one store.",
      },
      {
        q: "Does RevenueDot charge my Stripe customers?",
        a: "No. For tracking it only reads from your Stripe account. If you use RevenueDot's hosted checkout, it creates Checkout Sessions in your account with your key, and the money goes to you.",
      },
      {
        q: "Which Stripe events do I need to send?",
        a: "customer.subscription.created, updated, deleted, paused and resumed, invoice.paid, invoice.payment_failed and invoice.updated, charge.refunded and checkout.session.completed. Other events are accepted and ignored.",
      },
      {
        q: "How does RevenueDot know which app user bought on Stripe?",
        a: "You post the subscription ID with the app user ID. For purchases you did not post, RevenueDot reads the user from Stripe metadata (the key `app_user_id` by default), from the Stripe customer ID, or uses an anonymous ID.",
      },
      {
        q: "Does RevenueDot support Stripe test mode?",
        a: "Yes. A test-mode key or a Stripe sandbox records sandbox data, which stays out of production numbers. Use a separate Stripe app for each mode.",
      },
    ],
    docs: [
      { href: "/docs/guides/stripe", label: "Track Stripe subscriptions" },
      { href: "/docs/guides/web-billing", label: "Sell on the web with Stripe" },
      { href: "/docs/guides/redemption-links", label: "Redemption links" },
      { href: "/docs/concepts/sandbox", label: "Sandbox and production" },
    ],
    related: ["/solutions/web-to-app", "/stores/stripe", "/sdks/web", "/stores/app-store", "/pricing", "/compare/revenuedot-vs-revenuecat"],
  },

  {
    slug: "test-store",
    section: "stores",
    name: "Test Store",
    card: "Buy and renew test subscriptions with no App Store Connect or Play Console account.",
    label: "Store",
    title: "Test in-app purchases without sandbox accounts or store setup",
    metaTitle: "Test in-app purchases without a sandbox account",
    metaDescription:
      "RevenueDot's Test Store lets you buy, renew, cancel and refund test subscriptions with a test_ key. No App Store Connect or Play Console account is needed.",
    answer:
      "To test in-app purchases without sandbox accounts, create a Test Store app in RevenueDot and give its test_ key to the RevenueCat SDK in a debug build. Purchases go through the SDK's own test dialog instead of Apple or Google. They grant entitlements, record events and send webhooks like real purchases, and they are always sandbox data.",
    shot: {
      src: "screens/overview-light.png",
      alt: "The RevenueDot dashboard overview with a sandbox switch and setup health, where a Test Store purchase shows up",
    },
    points: [
      { title: "No store account", text: "You need no App Store Connect, no Play Console and no tester account." },
      { title: "Real pipeline", text: "Test purchases run the same entitlement, event and webhook code as store purchases." },
      { title: "Simulated lifecycles", text: "One API call plays out a trial, renewal, billing issue, cancellation or refund." },
      { title: "Always sandbox", text: "Test purchases never count in production charts." },
    ],
    blocks: [
      {
        h2: "How to test in-app purchases with the RevenueDot Test Store",
        label: "Setup",
        steps: [
          {
            name: "Add a Test Store app",
            text: `[Sign up free on Cloud](${SIGNUP}), then in **Apps** add an app of type **Test Store**. Copy its \`test_\` key from **API keys**.`,
          },
          {
            name: "Create a product with a period and a price",
            text: "Add a product such as `pro_monthly` with duration `P1M` and a Test Store price. The duration is the period, so a `P1M` product expires one month after purchase. A product without a price shows 0.",
          },
          {
            name: "Attach it to an entitlement and an offering",
            text: "Attach the product to an entitlement such as `pro`, and put it in a package of your current offering, as you would for a store product.",
          },
          {
            name: "Configure the SDK with the test key",
            text: "Use the `test_` key as the SDK's API key and set the proxy URL to `https://api.revenuedot.app` before `configure`. Use the key in debug builds only.",
          },
          {
            name: "Buy in the app",
            text: "Call `purchase` as usual. The SDK shows its Test Store dialog. Choose the successful purchase and check that the entitlement is active in the app and on the customer's page in the dashboard.",
          },
        ],
      },
      {
        h2: "Buy with curl, no app needed",
        label: "API",
        code: {
          title: "A Test Store receipt",
          label: "terminal",
          code: `curl -s "$REVENUEDOT_URL/v1/receipts" -H "Authorization: Bearer $TEST_KEY" -H "Content-Type: application/json" \\
  -d "{\\"app_user_id\\":\\"user_1\\",\\"fetch_token\\":\\"test_$(date +%s)000_demo\\",\\"product_id\\":\\"pro_monthly\\",\\"price\\":9.99,\\"currency\\":\\"USD\\"}"`,
        },
        paras: ["The SDK posts `fetch_token` as `test_<purchase time in ms>_<id>`, and RevenueDot accepts any token of that form."],
      },
      {
        h2: "Simulate a renewal, cancellation or refund without waiting",
        label: "Lifecycles",
        code: {
          title: "Play out a renewal",
          label: "terminal",
          code: `curl -s -X POST "$REVENUEDOT_URL/v2/projects/$PROJECT_ID/test_purchases" \\
  -H "Authorization: Bearer $SECRET_KEY" -H "Content-Type: application/json" \\
  -d '{"app_user_id":"user_renewal","product_id":"pro_monthly","scenario":"renewal","price":9.99}'`,
        },
        table: {
          head: ["Scenario", "What happens", "Events (monthly product)"],
          rows: [
            ["`purchase`", "Bought now", "`INITIAL_PURCHASE`"],
            ["`trial`", "A 7-day free trial starts", "`INITIAL_PURCHASE` (price 0)"],
            ["`trial_conversion`", "Trial, then paid periods until now", "`INITIAL_PURCHASE`, `RENEWAL`"],
            ["`renewal`", "Bought, then renewed every period until now", "`INITIAL_PURCHASE`, `RENEWAL`"],
            ["`cancel`", "Renewed, then auto-renew turned off now", "`INITIAL_PURCHASE`, `CANCELLATION`"],
            ["`billing_issue`", "The charge fails at the last period end, with 7 days of grace", "`INITIAL_PURCHASE`, `BILLING_ISSUE`, `CANCELLATION`"],
            ["`refund`", "Renewed, then the latest period is refunded now", "`INITIAL_PURCHASE`, `CANCELLATION`"],
            ["`expire`", "Auto-renew off from the start, access ends at the period end", "`INITIAL_PURCHASE`, `CANCELLATION`, `EXPIRATION`"],
          ],
          caption: "Add offset_days (0 to 730) to move the start into the past. One-time products support purchase and refund only.",
        },
      },
      {
        h2: "Where the Test Store works and where it stops",
        label: "Limits",
        bullets: [
          "It works with the native SDKs, React Native (including Expo Go and the web) and purchases-js.",
          "Native SDKs accept `test_` keys in debug builds only. A release build shows an error screen on purpose, so ship with your `appl_` and `goog_` keys.",
          "It does not test the App Store or Google Play themselves. For that, use sandbox accounts and test tracks: see [App Store](/stores/app-store) and [Google Play](/stores/google-play).",
          "On the iOS simulator and an Android emulator the unmodified RevenueCat SDKs pass a Test Store purchase against RevenueDot.",
        ],
      },
    ],
    howTo: "How to test in-app purchases with the RevenueDot Test Store",
    faq: [
      {
        q: "How do I test in-app purchases without a sandbox account?",
        a: "Create a Test Store app in RevenueDot, use its test_ key in the RevenueCat SDK in a debug build, and buy through the SDK's test dialog. The purchase grants entitlements and sends webhooks like a real one, and it is stored as sandbox data.",
      },
      {
        q: "Can I test renewals and refunds without waiting a month?",
        a: "Yes. POST /v2/projects/{project_id}/test_purchases with a scenario such as renewal, trial_conversion, billing_issue, cancel or refund. RevenueDot plays out the whole history with each state applied at the time it would have happened.",
      },
      {
        q: "Can I ship an app with a test_ key?",
        a: "No. Native SDKs accept test_ keys only in debug builds, and a release build stops with an error screen. Ship with your appl_ and goog_ keys.",
      },
      {
        q: "Do Test Store purchases count in my revenue charts?",
        a: "No. They are always sandbox purchases and stay out of production numbers. Turn on the sandbox switch in the dashboard to see them.",
      },
      {
        q: "Does the Test Store work on the web?",
        a: "Yes. purchases-js and React Native on the web accept test_ keys and open a Test Store modal. Real web payments go through a Stripe-backed purchase link or funnel instead.",
      },
    ],
    docs: [
      { href: "/docs/guides/test-store", label: "Use the Test Store" },
      { href: "/docs/getting-started/quickstart", label: "First purchase in 5 minutes" },
      { href: "/docs/guides/sandbox-testing", label: "App Store and Google Play sandbox testing" },
      { href: "/docs/concepts/sandbox", label: "Sandbox and production" },
    ],
    related: ["/sdks/ios", "/sdks/android", "/sdks/react-native", "/sdks/flutter", "/stores/app-store", "/stores/google-play"],
  },
];
