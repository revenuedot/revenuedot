// FAQ answers, written for the questions people type into search and AI assistants. Plain text: the same strings
// render on the page and go into FAQPage JSON-LD.
import type { Faq } from "../site";

export const FAQ_ALTERNATIVE: Faq = {
  q: "Is there an open-source RevenueCat alternative?",
  a: "Yes. RevenueDot is an open-source (AGPL-3.0) backend for in-app purchases and subscriptions that implements the API the RevenueCat SDKs call. You keep the RevenueCat SDK in your app, point it at RevenueDot with one line (the SDK's proxy URL), and keep your purchase code, offerings and customers. Start free on RevenueDot Cloud, free up to $10,000 a month in tracked revenue, or self-host it.",
};

export const FAQ_SELF_HOST: Faq = {
  q: "Can I self-host RevenueCat?",
  a: "RevenueCat itself is closed source and runs only in RevenueCat's cloud. RevenueDot is a self-hostable server that works with the RevenueCat SDK, so self-hosting means running RevenueDot with Docker and Postgres on your own servers, in the region you choose.",
};

export const FAQ_PRICE_ALT: Faq = {
  q: "What is a cheaper alternative to RevenueCat's pricing?",
  a: "Once an app reaches $2,500 a month in tracked revenue, RevenueCat charges 1% of all of it, which is $500 a month for an app making $50,000 a month. RevenueDot Cloud is free up to $10,000 a month; the planned paid plan is 0.5% above that, capped at $999 a month. Self-hosted RevenueDot has no revenue share: you pay only for your own servers.",
};

export const FAQ_CHANGE_APP: Faq = {
  q: "Do I have to change my app to switch?",
  a: "One line. Set the SDK's proxy URL to https://api.revenuedot.app (or your own server) before configure. Offerings, purchases, restores, entitlements and customer info work as before. With the stock SDK you also turn off its response-signature check, or you use a RevenueDot SDK fork, which verifies RevenueDot's signatures.",
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
  a: "RevenueDot Cloud has a free plan up to $10,000 of monthly tracked revenue. Self-hosting is free forever under AGPL-3.0, with no limits. Cloud Standard (0.5% of tracked revenue above $10,000, capped at $999 a month) are coming. Enterprise has custom pricing starting at $50,000 a year; contact sales at revenuedot.app/contact-sales.",
};

export const FAQ_READY: Faq = {
  q: "How is RevenueDot tested?",
  a: "Every endpoint is checked against real RevenueCat responses, the unmodified RevenueCat iOS SDK runs a full purchase against it on the iPhone simulator, and webhooks are delivered live to 23 example backends. For a switch with no risk, run RevenueDot side by side with RevenueCat: it forwards every store notification to RevenueCat, so you can compare both before you cut over.",
};

export const FAQ_LICENSE: Faq = {
  q: "What license is RevenueDot under?",
  a: "The server and dashboard are AGPL-3.0. The SDK forks, CLI, MCP server and agent skills are MIT. The ee/ folder (enterprise features such as SSO and audit logs) is under the RevenueDot Enterprise License.",
};

export const FAQ_AFFILIATED: Faq = {
  q: "Is RevenueDot affiliated with RevenueCat?",
  a: "No. RevenueDot is an independent project. It is not affiliated with, endorsed by or sponsored by RevenueCat, Inc. The name RevenueCat is used only to describe compatibility with RevenueCat's MIT-licensed SDKs.",
};

export const FAQ_STORES: Faq = {
  q: "Which stores and SDK features are supported?",
  a: "The App Store (StoreKit 1 and 2, App Store Server API, Server Notifications v2), Google Play (Play Developer API, real-time notifications), the Amazon Appstore, Stripe and a Test Store. Because RevenueDot serves the API the RevenueCat SDKs call, Expo, StoreKit 2 and current Google Play Billing work through the SDKs you already use. Web checkout with Stripe, purchase links and web funnels are built in.",
};

export const FAQ_DATA: Faq = {
  q: "Where does my purchase data live?",
  a: "In RevenueDot Cloud it runs on Cloudflare's network; EU and US data regions are part of Enterprise. When you self-host, every purchase, customer and receipt lives in your own Postgres database, in the cloud and region you choose, and nothing is sent to RevenueDot.",
};
