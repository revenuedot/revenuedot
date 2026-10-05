# SDK fork pipeline

Applies RevenueDot's patches to the ten RevenueCat SDK forks (`prd/sdk-forks/PRD.md`): API host, response-signing key, registry names, licence lines, the README, and the version pins between forks. Everything is a rule in `rules/<repo>.json` (shared groups in `rules/_shared.json`, variables in `config.json`), run by `apply.ts`, verified by `check.ts`, and re-applied after every upstream merge by `sync-upstream.sh`.

```
pnpm tsx scripts/forks/apply.ts --all --commit --push     # (re)patch every fork on revenuedot/main-patches
pnpm tsx scripts/forks/apply.ts --all --pins              # pin check only
pnpm tsx scripts/forks/check.ts --all --clean             # leak scan, pins, README, then each fork's build checks
scripts/forks/sync-upstream.sh --all                      # merge upstream main, re-apply, open a PR per fork
```

## Branches: `revenuedot/main-patches` is the default branch on GitHub (decided 2026-10-03)

Each fork has:

| Branch | What it is | Who writes it |
|---|---|---|
| `main` | RevenueCat's `main` at fork time (2026-09-30) plus three README-only commits made by hand before the pipeline existed. Nothing is built from it. | Nobody. `sync-upstream.sh` never pushes to `origin/main`, and `apply.ts` only writes the patch branch. |
| `revenuedot/main-patches` | `main` (merged with `-s ours`, so it contains `main`) plus upstream merges plus the pipeline's commits. **The GitHub default branch**: what visitors see, what we build and publish from, and where `sync-upstream.sh` opens its pull requests. | The pipeline (`apply.ts --commit --push`, `sync-upstream.sh` by PR). |
| `upstream-sync` | Created by `sync-upstream.sh`; merged into `revenuedot/main-patches` by PR. | `sync-upstream.sh`. |
| `revenuedot/release-<v>` | An upstream release tag plus the pipeline commit. Tags `<v>-revenuedot` and the GitHub Releases are cut from these. | `apply.ts --base <v> --branch revenuedot/release-<v> --push`. |

Why the patch branch rather than patching `main`: the pipeline is designed around a branch that receives upstream merges and a regenerated patch commit, and `main` was deliberately kept as the upstream mirror so a diff `main...revenuedot/main-patches` is exactly "what RevenueDot changed". Switching the GitHub default (one `PATCH /repos/revenuedot/<repo>` call, `default_branch=revenuedot/main-patches`) gave every fork a RevenueDot landing page without renaming anything or teaching the pipeline to write `main`. Nothing else was renamed: `main` is still there, upstream tags are still there, and `upstream` remotes still point at RevenueCat.

Repo settings set at the same time (also by `gh api`): `homepage` is the SDK's docs page (`https://revenuedot.app/docs/sdks/<platform>`), wiki and projects are off, topics are kept.

## The README rule

`rules/<repo>.json` carries one `readme` rule for the repo's `README.md`. `apply.ts` renders it (`lib/rules.ts`, `renderReadme`) into a marked block at the top of the file:

- the RevenueDot lockup (`brand/kit/wordmark/revenuedot-lockup-{black,white}.svg` from the main repo, dark and light),
- an H1 such as "RevenueDot iOS SDK" and one sentence saying what the fork is,
- badges: MIT, the registry badge for our package name (shields.io, checked to resolve), and the upstream version this checkout carries,
- Install (the published command for that package manager), Configure (the lines that point the SDK at RevenueDot; the fork already trusts RevenueDot's signing key, so no verification setting), What RevenueDot adds, Links (docs page, example app in revenuedot/examples, releases, main repo, this pipeline), and the trademark line,
- then `---` and the heading "Upstream README (RevenueCat's, unchanged)"; RevenueCat's README follows untouched below the block, so the MIT attribution and history stay intact.

The block is bounded by `<!-- revenuedot:readme:start -->` and `<!-- revenuedot:readme:end -->`, so an upstream README change merges cleanly below it and the next `apply.ts` run regenerates only the block. The older `banner` rule (a `> [!NOTE]` box) is still used for sub-package READMEs (`react-native-purchases-ui`, `purchases_ui_flutter`, `purchases-capacitor-ui`); the readme rule removes a banner or the 2026-09-30 hand-written notice when it finds one at the top.

Two variables come from the checkout, not from the JSON: `{{version}}` is the version to install (the checkout's own version when it is a plain release, otherwise the newest `<v>-revenuedot` tag, so a `-SNAPSHOT` patch branch still names the published release) and `{{forkVersion}}` is the version the checkout declares (shown in the upstream badge). `check.ts` fails when the block on disk differs from what the rule renders now, when the H1 is missing, or when RevenueCat sign-up copy (`app.revenuecat.com`, "get started for free") appears above the upstream heading.

## GitHub Releases

Every fork has a Release on its newest `<v>-revenuedot` tag, marked latest, whose notes say which upstream version it is plus the RevenueDot patches, the install snippet and the docs link. A release is created only for a version that is on its registry (`company/docs/registries.md` lists what is live). Create the next one after the tag is pushed and the registry shows the version:

```
gh release create <v>-revenuedot --repo revenuedot/<repo> --title <v>-revenuedot --latest --notes-file <notes.md>
```

## Upstream workflows we delete

RevenueCat's own housekeeping workflows run in the forks too, and some cannot work there. A `delete` rule in the repo's rules file removes them, so the failure does not come back after an upstream merge:

- `.github/workflows/lock.yml` (six forks: iOS, Android, Flutter, React Native, Cordova, Unity): `dessant/lock-threads` v2 rejects GitHub's current installation tokens (over 100 characters), so the daily run failed in every fork (seen 2026-10-02 to 2026-10-05).
- `.github/workflows/main.yml` (purchases-kmp): submits a Gradle dependency graph, which needs the dependency graph switched on for the repo; every push to `main` failed.

When a fork's scheduled or push workflow fails, check `gh run list --repo revenuedot/<repo>` before anything else: if the workflow is RevenueCat's own and we do not need it, add a `delete` rule rather than fixing it.
