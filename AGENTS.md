# AGENTS.md

RevenueDot is an open-source, self-hostable server for in-app purchases and subscriptions that speaks the RevenueCat SDK protocol. Apps switch by changing the SDK's proxy URL.

## Rules
- **Memory lives in the repo.** Record every decision, status change and research result in files and commit it. Chat sessions can end at any time. This repo is public: anything confidential goes to the private `revenuedot/company` repo instead.
- **Specs first.** Every feature has `prd/<feature>/PRD.md` before code. The tiered scope is in `prd/SCOPE.md`.
- **Compatibility is the contract.** Never change a response shape the RevenueCat SDKs decode without a passing contract test. Temporary failures on `POST /v1/receipts` must return 5xx, never 4xx.
- **Business logic is pure.** `apply(state, event) -> { state, effects }` in `packages/core`. Only thin adapters differ between Workers and Node.
- **Never copy RevenueCat's docs text or use its name, logo or domains** in our product names. Plain "works with the RevenueCat SDK" wording is fine.
- **No AGPL or other copyleft code from other projects.** Reading it for ideas is fine.
- Keep `docs/STATUS.md` current. Commit and push as you go.

## Index
- `prd/SCOPE.md`: tiers and build order.
- `docs/STATUS.md`: current phase, feature table, blockers.
- `docs/architecture.md`: stack and portability rules (to be added).
- `DESIGN.md`: design tokens (to be added).
- Sibling repos and the org map: `../AGENTS.md` (= `company/WORKSPACE.md`, private).
