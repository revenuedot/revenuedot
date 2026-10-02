// DataFast web analytics and revenue attribution (docs/analytics.md). Shared by the pages (Analytics.astro) and the Worker (worker/bots.ts),
// so it imports nothing. The website id is public: it is in every page's HTML.
export const DATAFAST = {
  websiteId: "dfid_D9m4bJCw2lmFrxMQaatXu",
  domain: "revenuedot.app",
} as const;
