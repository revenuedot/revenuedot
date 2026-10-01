# Product specs (PRDs)

**Rule: write the PRD before the code.** Every feature gets `prd/<feature>/PRD.md` before its first commit, and the PRD changes in the same commit as any behaviour it describes. The tiers and build order are in [`SCOPE.md`](SCOPE.md); what is done today is in [`docs/STATUS.md`](../docs/STATUS.md).

Each PRD is short and has the same sections: users and jobs, essential now and later, the RevenueCat behaviour we match (with sources), endpoints and screens, the tests that prove it, and known gaps.

## Tier 1
| Scope | Feature | PRD |
|---|---|---|
| 1.0, 1.1 | Contract harness and SDK-compatible API | [sdk-api](sdk-api/PRD.md) |
| 1.2 | App Store ingestion | [store-apple](store-apple/PRD.md) |
| 1.3 | Google Play ingestion | [store-google](store-google/PRD.md) |
| 1.4, 1.5 | Entitlement engine and identity | [entitlements-identity](entitlements-identity/PRD.md) |
| 1.6 | Catalog | [catalog](catalog/PRD.md) |
| 1.7 | Webhooks out | [webhooks](webhooks/PRD.md) |
| 1.8 | REST API v1 and v2 | [rest-api](rest-api/PRD.md) |
| 1.8, 1.10 | Customers | [customers](customers/PRD.md) |
| 1.9 | Migration from RevenueCat | [migration](migration/PRD.md) |
| 1.10 | Apps and project setup | [apps-setup](apps-setup/PRD.md) |
| 1.10 | Dashboard | [dashboard](dashboard/PRD.md) (reference screen: [mockup.html](dashboard/mockup.html)) |
| 1.11 | Self-host | [self-host](self-host/PRD.md) |
| 1.12 | Cloud | [cloud](cloud/PRD.md) |
| 1.13 | SDK forks | [sdk-forks](sdk-forks/PRD.md) |
| 1.14 | MCP server and agent skills | [mcp-and-skills](mcp-and-skills/PRD.md) |
| 1.15, 1.17 | Docs, examples and cookbook | [ecosystem](ecosystem/PRD.md) |
| 1.16 | Brand and marketing site | [site](site/PRD.md) |

## Tier 2
| Scope | Feature | PRD |
|---|---|---|
| Stores | Amazon Appstore ingestion | [store-amazon](store-amazon/PRD.md) |
| Stores | Stripe subscriptions from the customer's own Stripe account | [store-stripe](store-stripe/PRD.md) |
