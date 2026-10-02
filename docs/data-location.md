# Data location on RevenueDot Cloud (EU and US regions)

**RevenueDot Cloud stores everything in the US today. An EU region needs a second, separate deployment; none of it exists yet.** The enterprise code is ready for it: each organization project records its region (`ee_org_projects.region`), and with more than one region configured a deployment refuses requests for projects stored elsewhere (`ee/server/region.ts`, spec `prd/enterprise/PRD.md` §8). This runbook lists what has to be created on Cloudflare and Railway before EU hosting can be sold. Self-hosted servers need none of this: their data is wherever the customer runs them.

## How regions work
- **One deployment per region, nothing shared.** Each region has its own Worker, its own Postgres and its own hostnames. Accounts, organizations, projects, customers, purchases, events and audit logs of an EU organization live only in the EU database.
- **A project's region is where its rows are.** The dashboard cannot move a project between regions (422 with the other region's dashboard address); a move is a support job (below).
- **Misrouted traffic is refused, never processed:** API v2 and dashboard calls get 421 with the right origin; SDK calls and store notifications get 503 with `Retry-After: 60`, so apps retry and Apple and Google redeliver instead of finishing a purchase this deployment never recorded.
- **Configuration**, on every deployment:
  - `REVENUEDOT_REGION`: `us` or `eu`, this deployment's region.
  - `REVENUEDOT_REGIONS`: JSON of every region's origins, for example `{"us":{"api":"https://api.revenuedot.app","app":"https://app.revenuedot.app"},"eu":{"api":"https://api.eu.revenuedot.app","app":"https://app.eu.revenuedot.app"}}`. With one region listed (today), nothing is enforced.

## What the EU region needs
| # | Where | What | Notes |
|---|---|---|---|
| 1 | Railway | A Postgres service in **EU West (Amsterdam)**, in its own environment (`production-eu`) of project RevenueDot | Daily backups on; its own TCP proxy; credentials only in 1Password (`Railway production EU Postgres`) and a GitHub `production` secret |
| 2 | Cloudflare | A Hyperdrive config `revenuedot-eu` pointing at it, **with caching disabled** (`--caching-disabled`) | Hyperdrive's query cache runs in Cloudflare's data centres near the visitor, so EU rows could be cached outside the EU |
| 3 | Cloudflare | A second Worker `revenuedot-eu` from the same build (`apps/server/cloudflare.config.ts` with a region switch), on `api.eu.revenuedot.app` and `app.eu.revenuedot.app`, Smart Placement on, `REVENUEDOT_REGION=eu` | Same secrets as the US Worker except the database; its own `REVENUEDOT_LICENSE_KEY` |
| 4 | Cloudflare | The RevenueDot AI Durable Object namespace with `jurisdiction: "eu"`, and R2 buckets for data exports and paywall assets created with the EU jurisdiction | Keeps conversation state and files in the EU |
| 5 | Cloudflare | **Data Localization Suite** (Regional Services set to EU, Customer Metadata Boundary for logs) on the zone | Enterprise plan add-on. Without it, TLS is terminated and Workers run in the data centre nearest the visitor (data at rest stays in Amsterdam, but requests are processed worldwide). Decide with sales before promising "processed only in the EU" |
| 6 | Cloudflare | Email Sending for `mail.revenuedot.app` stays shared | Emails carry no customer data beyond the address and project name |
| 7 | GitHub Actions | `deploy.yml`: migrate both databases, deploy both Workers, run the smoke checks against both | One build, two deploys |
| 8 | Docs and site | Region in the sign-up flow (`app.eu.revenuedot.app/signup`), the SDK proxy URL `https://api.eu.revenuedot.app` in the quickstart, subprocessor list updated | The SDK forks take the proxy URL from the app, so no SDK change |

## Moving an existing project between regions (support)
1. Freeze writes for the project (maintenance flag), export its rows from the source database (every table with `project_id`, plus its members' `users` rows and the organization rows).
2. Import into the target database, set `ee_org_projects.region`, and check row counts.
3. Change the app's SDK proxy URL and the store notification URLs (App Store Server Notifications, Play RTDN, Amazon, Stripe) to the target region; the source deployment answers 503 meanwhile, so stores retry.
4. Delete the project from the source database once the target has served it for 7 days.

## Cost (list prices, to confirm before ordering)
- Railway: a second Postgres service, about the same as the US one.
- Cloudflare: a second Worker and Hyperdrive config fall under the current Workers Paid plan; the Data Localization Suite is an Enterprise add-on priced by sales.
