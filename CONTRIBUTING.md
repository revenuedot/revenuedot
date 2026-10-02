# Contributing

Thank you for helping build RevenueDot.

1. Open an issue before large changes, so we can agree on the approach.
2. Every feature starts with a spec in `prd/<feature>/PRD.md`.
3. Changes to anything the RevenueCat SDKs call must pass the contract tests.
4. **Sign the Contributor License Agreement (CLA).** We use the Harmony agreements, version 1.0: the [Individual CLA](.github/CLA.md), or the [Entity CLA](.github/CLA-entity.md) if you contribute for a company. Sign the individual one by commenting on your first pull request: "I have read the CLA Document and I hereby sign the CLA". The CLA lets Circo, Inc. offer RevenueDot under both the AGPL-3.0 and the Enterprise License; you keep the copyright in your work.
5. CI (`.github/workflows/ci.yml`) runs `npx tsc -b`, `pnpm vitest run` and the site build on every pull request. A merge to `main` deploys RevenueDot Cloud and the site (`.github/workflows/deploy.yml`), so `main` must always be releasable. Use Node 24 (`.nvmrc`).

## Work you do not own

The CLA covers only work you own the copyright in. If part of your pull request is someone else's work, for example code copied from another project:

1. Say so in the pull request description, with its source (a link) and its license.
2. Email legal@revenuedot.app before the pull request is merged.

We do not accept code under the AGPL or other copyleft licenses from other projects.
