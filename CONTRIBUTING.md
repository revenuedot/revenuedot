# Contributing

Thank you for helping build RevenueDot.

1. Open an issue before large changes, so we can agree on the approach.
2. Every feature starts with a spec in `prd/<feature>/PRD.md`.
3. Changes to anything the RevenueCat SDKs call must pass the contract tests.
4. **Sign the Contributor License Agreement (CLA)** in `.github/CLA.md`. A bot asks you on your first pull request. The CLA lets Circo, Inc. offer RevenueDot under both the AGPL-3.0 and the Enterprise License; you keep the copyright in your work.
5. CI (`.github/workflows/ci.yml`) runs `npx tsc -b`, `pnpm vitest run` and the site build on every pull request. A merge to `main` deploys RevenueDot Cloud and the site (`.github/workflows/deploy.yml`), so `main` must always be releasable. Use Node 24 (`.nvmrc`).
