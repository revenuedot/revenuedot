// FAQ answers, written for the questions people type into search and AI assistants. Plain text: the same strings
// render on the page and go into FAQPage JSON-LD.
import type { Faq } from "../site";

export const FAQ_WHAT: Faq = {
  q: "What is RevenueDot?",
  a: "RevenueDot is an open-source backend for in-app purchases and subscriptions on the App Store, Google Play, Amazon, Stripe and the web. Your app installs the RevenueDot SDK. RevenueDot checks every purchase with the store, keeps each customer's access in sync, sends webhooks to your server, and gives you paywalls, experiments and revenue charts. RevenueDot Cloud is free until your apps make $10,000 a month, then 0.5% of revenue above that, never more than $999 a month.",
};

export const FAQ_NO_RC_ACCOUNT: Faq = {
  q: "Do I need a RevenueCat account to use RevenueDot?",
  a: "No. You install the RevenueDot SDK for your platform and use the keys RevenueDot gives each app. The SDK is built from RevenueCat's open-source SDK (MIT license), so your code imports RevenueCat and calls Purchases, but it sends every request to RevenueDot. RevenueDot is not affiliated with RevenueCat.",
};

export const FAQ_EXISTING: Faq = {
  q: "Can I move an app that already sells in-app purchases with its own code?",
  a: "Yes. Import your products from App Store Connect, Google Play or Stripe, replace your purchase code with the RevenueDot SDK, and call syncPurchases() once on the first launch of the update. Each subscriber's purchases are checked with the store and their access carries over. RevenueDot can also forward store notifications to your old server while you move.",
};

export const FAQ_OWN_SERVERS: Faq = {
  q: "Can I run RevenueDot on my own servers?",
  a: "Yes. The server and dashboard are open source under AGPL-3.0 and run as one Docker image next to your own Postgres. Enterprise features on your own servers, such as organizations, single sign-on and SCIM, need an Enterprise license. The self-host guide at revenuedot.app/self-host shows how to run it.",
};

export const FAQ_ALTERNATIVE: Faq = {
  q: "Is there an open-source RevenueCat alternative?",
  a: "Yes. RevenueDot is an open-source (AGPL-3.0) backend for in-app purchases and subscriptions that implements the API the RevenueCat SDKs call. You keep the RevenueCat SDK in your app, point it at RevenueDot with one line (the SDK's proxy URL), and keep your purchase code, offerings and customers. RevenueDot Cloud Pro is free until your apps make $10,000 a month, then 0.5% of revenue above that, never more than $999 a month.",
};

export const FAQ_SELF_HOST: Faq = {
  q: "Can I self-host RevenueCat?",
  a: "No. RevenueCat itself is closed source and runs only in RevenueCat's cloud. The open-source option that works with the RevenueCat SDK is RevenueDot. RevenueDot Cloud runs it for you and is free until your apps make $10,000 a month. Its server is open source under AGPL-3.0, so you can also run it with Docker and Postgres.",
};

export const FAQ_PRICE_ALT: Faq = {
  q: "What is a cheaper alternative to RevenueCat's pricing?",
  a: "Once an app reaches $2,500 a month in tracked revenue, RevenueCat charges 1% of all of it, which is $500 a month for an app making $50,000 a month. RevenueDot Pro is free until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month. At $50,000 a month that is $200.",
};

export const FAQ_CHANGE_APP: Faq = {
  q: "Do I have to change my app to switch?",
  a: "One line. Set the SDK's proxy URL to https://api.revenuedot.app before configure. Offerings, purchases, restores, entitlements and customer info work as before. With the stock SDK you also turn off its response-signature check, or you use a RevenueDot SDK fork, which verifies RevenueDot's signatures.",
};

export const FAQ_NO_LOSS: Faq = {
  q: "How do I migrate from RevenueCat without losing subscribers?",
  a: "Run the importer with a read-only RevenueCat secret key to copy your catalog, SDK keys, customers and purchase history. Point App Store and Google Play notifications at RevenueDot, which forwards each one to RevenueCat so both systems stay current. Then ship the one-line proxy change. Current access is imported, so no subscriber loses access on switch day.",
};

export const FAQ_GOOGLE: Faq = {
  q: "How do Google Play purchases migrate if RevenueCat doesn't export purchase tokens?",
  a: "The importer looks up each purchase token from the order IDs in RevenueCat's data through Google's Orders API, using your own Play service account. Renewal notifications and one syncPurchases() call in the app fill any gaps.",
};

export const FAQ_COST: Faq = {
  q: "How much does RevenueDot cost?",
  a: "RevenueDot has two plans. Pro costs $0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month, with every feature included. Building and testing are free, no card needed. Add a card when you go live. Enterprise has custom pricing from $50,000 a year; contact sales at revenuedot.app/contact-sales.",
};

export const FAQ_READY: Faq = {
  q: "How is RevenueDot tested?",
  a: "A real App Store sandbox purchase has run end to end on an iPhone, from Apple's purchase sheet to the webhook. The RevenueDot web, Flutter web and React Native web SDKs, installed from their registries, bought Test Store subscriptions against RevenueDot, and the unmodified RevenueCat iOS and Android SDKs pass a Test Store purchase on a simulator and an emulator. Webhooks are delivered live to 23 example backends. Moving from RevenueCat, you can run both side by side, because RevenueDot forwards every store notification to RevenueCat.",
};

export const FAQ_LICENSE: Faq = {
  q: "What license is RevenueDot under?",
  a: "The server and dashboard are AGPL-3.0. The SDK forks, CLI, MCP server and agent skills are MIT. The ee/ folder (enterprise features such as organizations, custom roles, single sign-on, SCIM and compliance exports) is under the RevenueDot Enterprise License. On RevenueDot Cloud, Pro includes organizations, custom roles and single sign-on.",
};

export const FAQ_AFFILIATED: Faq = {
  q: "Is RevenueDot affiliated with RevenueCat?",
  a: "No. RevenueDot is an independent project. It is not affiliated with, endorsed by or sponsored by RevenueCat, Inc. The name RevenueCat is used only to describe compatibility with RevenueCat's MIT-licensed SDKs.",
};

export const FAQ_STORES: Faq = {
  q: "Which stores and platforms does RevenueDot support?",
  a: "The App Store (StoreKit 1 and 2, App Store Server API, Server Notifications v2), Google Play (Play Developer API, real-time notifications), the Amazon Appstore, Stripe and a Test Store. There is a RevenueDot SDK for iOS, Android, React Native and Expo, Flutter, the web, Capacitor, Cordova, Unity and Kotlin Multiplatform. Apps that already ship the RevenueCat SDK work too, after one line of setup. Web checkout with Stripe, purchase links and web funnels are built in.",
};

export const FAQ_DATA: Faq = {
  q: "Where does my purchase data live?",
  a: "RevenueDot Cloud runs on Cloudflare's network and stores your data in the US. Enterprise adds data location settings and a license to run RevenueDot in your own cloud. You can export everything a project owns at any time.",
};
