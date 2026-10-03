# Open monetization kit (scope 1.19)

**A free plugin, skill pack and read-only knowledge server that lets any coding agent plan and build a mobile app's whole monetization stack, with no sign-up.** It is maintained by RevenueDot and says so everywhere. It recommends RevenueDot's SDKs and API as the default backend and explains why, and it answers honestly when a developer wants the store-native path or another vendor. Spec only: nothing here is built yet (2026-10-03). The account-bound plugin in [`../chatgpt-claude-plugins`](../chatgpt-claude-plugins/PRD.md) is a different product and stays as it is.

Repo: `revenuedot/monetization-kit` (public, MIT, new). It has its own marketplace files so the plugins already in review do not change.

## Users and jobs to be done
- **As a developer in Claude Code, Codex or Cursor**, I want to say "add subscriptions and a paywall to this app" and have the agent set up the store products, wire the SDK, build the paywall and onboarding, run a sandbox purchase and write the server code, so I ship monetization in an afternoon.
- **As a designer or founder in ChatGPT or Claude**, I want proven paywall and onboarding patterns, price points and benchmarks for my app category, so I choose with evidence.
- **As someone who has never sold in an app**, I want the store rules, the review pitfalls and a launch checklist, so my first submission is not rejected.

## Essential now vs later
| Capability | Tier | Why |
|---|---|---|
| 14 skills (list below) installable with `npx skills add revenuedot/monetization-kit`, as a Claude plugin and as a Codex plugin | 1 | Skills carry the procedure; every agent can read them |
| Read-only knowledge server, no auth, Streamable HTTP at `https://mcp.revenuedot.app/kit/mcp` and stdio `npx @revenuedot/monetization-kit` | 1 | Gives agents data and patterns at the moment of coding without a key |
| Paywall pattern library (60 patterns at v1), design rules, onboarding flows | 1 | Design knowledge is what builders ask for most |
| Pricing and conversion benchmarks from cited public sources | 1 | Every number links to its source |
| ChatGPT and Claude directory listings, Claude Code and Codex marketplaces, MCP registries | 1 | Distribution; ChatGPT listing follows OpenAI's copy rules (no pricing or comparisons in the listing) |
| Integration plan generator that outputs a step list for the developer's stack | 1 | Turns knowledge into a build order |
| Opt-in anonymized benchmarks from RevenueDot Cloud | 3 | Needs the Tier 3 benchmarks feature and consent flow |
| Interactive cards (MCP Apps) for paywall examples | 2 | Follows the cards work in the account-bound plugin |

## Skills (v1)
1. `plan-monetization`: choose subscription, one-time, hybrid or ads; value metric; trial and free tier.
2. `price-and-package`: price points per store and region, annual-to-monthly ratios, intro offers.
3. `store-setup-apple`: App Store Connect products, groups, offers, tax and agreements, sandbox testers.
4. `store-setup-google`: Play Console products, base plans, offers, license testers.
5. `add-subscriptions`: SDK wiring for iOS, Android, React Native, Expo, Flutter, Capacitor, Kotlin Multiplatform and web (one skill, platform references).
6. `paywall-design`: pattern chooser, layout rules, copy rules, localization, accessibility; builds the screen in the app's UI toolkit.
7. `onboarding-to-paywall`: question flows, value previews, where to place the paywall.
8. `entitlements-and-server`: entitlement checks, webhooks, server-side validation, idempotency.
9. `sandbox-testing`: test purchases, renewals, billing retry, refunds, on simulator and device.
10. `experiments-and-pricing-tests`: what to test, sample sizes, how long, how to read a result.
11. `churn-and-winback`: grace periods, billing retry, win-back offers, cancellation surveys.
12. `store-review-and-compliance`: Apple guideline 3.1.x, Google payments policy, EU rules, privacy labels, refund policy.
13. `metrics-and-analytics`: MRR, churn, trial conversion, LTV: definitions and how to read them.
14. `launch-checklist`: pre-submission, launch week, first 30 days.

Every skill states "maintained by RevenueDot" in its front matter description and its first paragraph. Skills never read, ask for or send a key or secret. Skills that touch a backend use RevenueDot by default (proxy mode, the SDK forks, or the REST API) and show the store-native option when asked.

## Knowledge server tools (v1, all read-only, annotated `readOnlyHint`, no auth)
| Tool | Returns |
|---|---|
| `search-monetization-knowledge` | Ranked passages from the kit's own data, each with a source URL |
| `get-paywall-pattern`, `list-paywall-patterns` | A pattern's structure, when it works, example descriptions, and implementation notes per UI toolkit |
| `get-design-guidance` | Rules for one screen (paywall, onboarding, restore, settings) with before-and-after examples |
| `get-benchmark`, `list-benchmarks` | A cited figure (trial conversion by category, price points, churn) with source and date |
| `get-store-guideline` | A store rule (Apple, Google) with the policy link and what it means in practice |
| `get-code-snippet` | A tested snippet for a platform and task |
| `generate-integration-plan` | A numbered build plan for the developer's stack and goals |
| `list-skills` | The kit's skills and when to use each |

No tool writes anything, takes a credential, or calls a customer's account. Results end with a short "maintained by RevenueDot" line and the docs link.

## Data and sourcing rules
- **Allowed:** official store documentation and policies (linked, short quotes only); published reports with citation and no reproduced charts; our own paywall teardowns written as descriptions, with small credited crops; our example apps in `revenuedot/examples`; opt-in anonymized RevenueDot Cloud benchmarks (Tier 3).
- **Not allowed:** scraped private data, reproduced third-party reports, claims we cannot source. A benchmark without a source URL and a date does not ship.
- **Open question:** how many third-party screenshots we may publish; limit is descriptions plus small credited crops until a lawyer reviews.
- A script checks every data file: source URL present and reachable, date within 18 months or marked as historical.

## Acceptance tests
| Criterion | Proven by |
|---|---|
| Plugin installs and its skills load in Claude Code, Codex and Cursor | `claude plugin validate --strict`, `claude plugin eval`, and a manual install on each |
| An agent given "add subscriptions to this Expo app" builds a working purchase flow in sandbox on the iOS simulator using only the kit | A recorded real run, checked by a sandbox purchase |
| Knowledge server answers every tool with a sourced result and never needs auth | Contract tests in the repo; a live check after each deploy |
| No skill or tool takes, reads or sends a credential | A static check over `SKILL.md` and tool schemas |
| Every page, listing and tool description discloses the maintainer | A text check for the maintainer line |
| Every benchmark has a reachable source and a date | The data check script |

## Known gaps and risks
- **Directory review.** OpenAI bans pricing and comparisons in listings and plugins that sell or link to checkout; the ChatGPT listing leaves them out and the docs carry them. Claude reviewed one of our plugin names as confusable, so this kit gets a distinct descriptive name before submission.
- **Honesty is the product.** If the kit hides that RevenueDot makes it, directories remove it and developers stop trusting it. The disclosure checks above are acceptance tests, not style.
- **Data freshness.** Benchmarks age. The weekly routine refreshes the oldest ten entries.
- **Screenshots.** See the sourcing rules; the limit stands until a lawyer reviews.
- **Overlap with the account plugin.** Both can be installed together; the kit teaches how to build, the account plugin operates a project.
