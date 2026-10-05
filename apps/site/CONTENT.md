# Writing for revenuedot.app

How every landing page, comparison, integration page, chart page and blog post is written. Types: `src/data/types.ts`. Data files: `src/data/*.ts`. Blog posts live in the revenuedot/docs repo (`blog/`).

## Who reads this
The five customer cases, in priority order (company `docs/marketing/positioning.md`, 2026-10-05). Every page that is not about switching is written for reader 1 first.
1. **Developers adding in-app purchases for the first time** (iOS, Android, Flutter, React Native, Expo, web, often with an AI coding tool). They have never used RevenueCat. They search "in app purchases", "how to add subscriptions to a Flutter app", "expo in app purchases", "paywall that converts". They install the RevenueDot SDK.
2. **Apps already selling with their own StoreKit or Play Billing code, or another tool** (Adapty, Qonversion, Stripe). They search "StoreKit 2 server-side validation", "Google Play real-time developer notifications", "adapty alternative". They import their products and install the RevenueDot SDK.
3. **Apps on RevenueCat that hit its bill**: free to $2,500 monthly tracked revenue, then 1% of all of it. They search "RevenueCat alternative", "RevenueCat pricing", "open source RevenueCat". They keep their SDK and change one line.
4. **Growth and product people at subscription apps** who need charts, paywalls, experiments, web checkout and win-back. They search "MRR chart", "trial conversion rate", "web to app funnel", "Apple refund request consumption".
5. **Teams that must own their data**: self-hosting, EU data residency, regulated apps, agencies running many apps.

What they want: a backend that just works on both stores, free until the app earns, paywalls and web checkout fast, their own purchase data, and (for switchers) no app rewrite. What they fear: a silent purchase bug, losing subscribers during a move, a young vendor disappearing, 4xx errors that make the SDK drop purchases, App Review rejections.

**Switching notes.** Outside the switching pages (`/revenuecat-alternative(s)`, `/migrate-from-revenuecat`, `/compare/*`, `/cheaper-revenuecat-alternatives`, `/do-i-need-revenuecat`, the RevenueCat fee calculator), mention RevenueCat only in a clearly marked "Switching from RevenueCat? Keep your SDK and change one line" note after the main path, or where a compatibility fact matters to a switcher. New apps install the RevenueDot SDK; explain once per page that its code says `import RevenueCat` because it is built from RevenueCat's MIT SDK, and that it needs no RevenueCat account.

## Rules
- **Only features merged to `main`.** Check `docs/STATUS.md` and the code. Never write about RevenueDot AI (the in-app assistant). Plan facts (Cloud Free, Cloud Standard, Enterprise, Self-host) come only from `src/lib/pricing.ts` and the pricing page.
- **Every claim about another company links a source** (its pricing page, docs, blog or GitHub). Write the month the fact was checked. If you cannot source it, leave it out.
- **Cloud first.** Every call to action leads to Cloud sign-up: https://app.revenuedot.app/signup. Self-hosting is the second option.
- **Honest.** Say where RevenueCat or another vendor is stronger (maturity, SOC 2, years of production). It builds trust and AI engines quote balanced pages.
- **Never copy** RevenueCat's or anyone's docs text. Never use anything from revenuedot/company verbatim; private numbers stay private.
- Prices: RevenueDot Cloud is free up to $10,000 monthly tracked revenue (live). Cloud Standard is 0.5% above $10K, capped at $999 a month, for apps up to $1M a month, and adds organizations, custom roles and single sign-on. Enterprise starts at $50K a year (Contact sales). Self-host is free (AGPL-3.0); organizations, SSO and SCIM on a self-hosted server need an Enterprise license. Never claim an EU region, high availability, SOC 2 or HIPAA.

## Voice
- **Answer in the first sentence.** The `answer` field fully answers the query in 40 to 70 words, so an AI engine can quote it alone.
- Plain English, complete sentences, short words, one idea per sentence. Active voice. No adverbs like "seamlessly", no "powerful", "robust", "leverage", "unlock", "supercharge", no em-dash chains.
- Name the real thing with its number: "1% of monthly tracked revenue above $2,500", not "a revenue share".
- Headings state a fact or answer a question the reader asked. Use the searcher's words ("How to validate App Store receipts on your server").
- American English. Product names: RevenueDot, RevenueDot Cloud, RevenueCat, App Store, Google Play, StoreKit 2.

## Structure that ranks and gets cited
- One H1 that contains the main keyword. `metaTitle` ≤ 60 characters, `metaDescription` 140 to 160 characters.
- Answer first, then proof: a screenshot, a code sample, a table, numbered steps.
- Tables for comparisons, numbered steps for how-tos (they become HowTo markup), 3 to 6 FAQs written as the exact questions people type (they become FAQPage markup).
- Link generously inside the site: docs guides, related integrations, charts and comparisons.

## Screenshots you can reference (`ShotRef.src`)
Real captures of the dashboard with demo data. In `docs/assets/` of the monorepo: `dashboard-light.png`, `charts-light.png`, `paywalls-editor-light.png`, `paywalls-gallery.png`, `paywalls-ios.png`, `amazon-setup.png`, `stripe-webhooks.png`, `lifecycle/customers.png`, `lifecycle/refund-control.png`, `lifecycle/retention-apple.png`, `lifecycle/retention-customer-center.png`, `lifecycle/support-customer-center.png`, `lifecycle/support-integrations.png`, `lifecycle/support-tickets.png`, `lifecycle/winback-editor.png`, `lifecycle/winback-list.png`, `web/web.png`, `web/web-config.png`, `web/web-product-dialog.png`, `web/funnels.png`, `web/funnel-builder.png`, `web/funnel-public.png`, `web/funnel-analytics.png`, `web/pay-link.png`, `web/pay-success.png`, `web/web-discounts.png`, `web/domains.png`. In `apps/site/src/assets/screens/`: `screens/overview-light.png`, `screens/customers-light.png`, `screens/customer-light.png`, `screens/offerings-light.png`. Chart and integration pages get their own capture automatically.
