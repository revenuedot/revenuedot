// DataFast web analytics and revenue attribution (docs/analytics.md). Shared by the pages (Analytics.astro) and the Worker (worker/bots.ts),
// so it imports nothing. The website id is public: it is in every page's HTML.
export const DATAFAST = {
  websiteId: "dfid_D9m4bJCw2lmFrxMQaatXu",
  domain: "revenuedot.app",
  // The managed-proxy host (a DNS-only CNAME to proxy.datafast.io) that keeps ad blockers from dropping events: "a.revenuedot.app".
  // Empty loads the script from datafa.st. Turn it on only after the CNAME exists and DataFast shows the proxy Active.
  proxy: "",
} as const;
