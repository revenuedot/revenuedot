# SDK forks and the fork pipeline (scope 1.13)

**The forks are drop-in RevenueCat SDKs that talk to RevenueDot.** Each of the 10 forks keeps RevenueCat's public API and every name that app code imports (`Purchases.configure`, `Purchases.shared`, `import RevenueCat`, `com.revenuecat.purchases.*`, `package:purchases_flutter`), so apps and every RevenueCat guide keep working. What changes is the default API host (`https://api.revenuedot.app`), the response-signing key the SDK trusts (ours), the registry names we publish under, and a fork banner in each README. One script re-applies all of this after every upstream merge.

Status and per-repo results: [docs/STATUS.md](../../docs/STATUS.md) row 1.13. Research behind this: `company/docs/research/revenuecat-tech/sdk-surface-and-fork-plan.md` and `sdk-wire-protocol.md` (private repo).

## 1. Names: keep what code imports, rename what a registry owns

**Rule: a name stays when changing it would break app code; a name changes when it is a registry entry RevenueCat owns.** We cannot publish to RevenueCat's CocoaPods pods, Maven group or npm scope, and we do not want to: our builds must be distinguishable from theirs.

| Ecosystem | Published as (ours) | Kept unchanged (what apps import) | Why |
|---|---|---|---|
| iOS, CocoaPods | `RevenueDotPurchases`, `RevenueDotPurchasesUI` | Swift modules `RevenueCat`, `RevenueCatUI` (`s.module_name`) | Pod names are global on trunk; `import RevenueCat` is in every app file |
| iOS, SPM | `https://github.com/revenuedot/purchases-ios`, tags `<version>-revenuedot` | package identity `purchases-ios`, products `RevenueCat`, `RevenueCatUI` | SPM identity comes from the URL's last path part, which is the same |
| Android | Maven `app.revenuedot.purchases:purchases`, `purchases-ui`, … (same artifact ids) | Kotlin packages `com.revenuecat.purchases.*` | 935 source files and every app import use the package; the Maven group must be a domain we own (`revenuedot.app`) |
| Hybrid common | pods `RevenueDotPurchasesHybridCommon(UI)` (modules `PurchasesHybridCommon(UI)`), Maven `app.revenuedot.purchases:purchases-hybrid-common`, npm `@revenuedot/purchases-typescript-internal(-esm)`, `@revenuedot/purchases-js-hybrid-mappings` | module names; TypeScript import specifiers through npm aliases | wrappers import these modules by name |
| React Native | npm `@revenuedot/react-native-purchases`, `-ui`, `-store-galaxy` | `import Purchases from "react-native-purchases"` via `"react-native-purchases": "npm:@revenuedot/react-native-purchases@<v>"`; local pods `RNPurchases`, `RNPaywalls` | npm aliases give a zero-code swap |
| Flutter | git dependency `github.com/revenuedot/purchases-flutter`, tags `<version>-revenuedot`; a RevenueDot-hosted pub repository later | package names `purchases_flutter`, `purchases_ui_flutter` (`publish_to: none`) | Dart imports use the package name, and pub.dev names are RevenueCat's |
| Web | npm `@revenuedot/purchases-js`, `@revenuedot/purchases-js-vega` | `"@revenuecat/purchases-js": "npm:@revenuedot/purchases-js@<v>"` keeps imports | npm alias |
| Capacitor | npm `@revenuedot/purchases-capacitor`, `-ui` | install through the alias `@revenuecat/purchases-capacitor`, so Capacitor's generated pod and SPM names (derived from the package name) stay `RevenuecatPurchasesCapacitor` | a direct scoped install would change the generated native names; not supported until verified |
| KMP | Maven `app.revenuedot.purchases:purchases-kmp-*` | Kotlin packages `com.revenuecat.purchases.kmp.*` | same as Android |
| Unity | OpenUPM `com.revenuedot.purchases-unity` (built from tags `upm/<version>`); the UI package installs from git, as upstream | C# namespaces, assembly names | `using RevenueCat;` stays |
| Cordova | npm `@revenuedot/cordova-plugin-purchases` | plugin id `cordova-plugin-purchases`, global `Purchases` | config.xml and app code refer to the id and global |

**Versions:** registries get the upstream version number unchanged (npm `@revenuedot/purchases-js@1.67.0` is RevenueCat 1.67.0 plus our patches). Git-resolved ecosystems (SPM, Flutter git deps, the KMP submodule, podspec `:tag`) use tags `<upstream version>-revenuedot`, because the forks also carry RevenueCat's own tags. Hotfixes between upstream releases: `-revenuedot.2`.

**Trademark position.** Keeping `RevenueCat` as a Swift module and Kotlin package name is a code-compatibility identifier, not a product name: our products are named RevenueDot, every README and package description says "Fork of RevenueCat's MIT SDK, maintained by RevenueDot, not affiliated with RevenueCat", and we never use RevenueCat's logo. The research doc recommended renaming modules too, with a codemod for apps; we chose compatibility because a rename breaks every app file and every guide. **Counsel should confirm this before the first public release** (open question 1).

## 2. What the patches change

**Hosts.** Every RevenueCat host in shipped code points at `{{apiHost}}` (default `https://api.revenuedot.app`): main API, web billing, diagnostics, paywall events, ad events, the fallback host (`api-production.8-lives-cat.io`), the second API source (`api.rc-backup.com`), and purchases-js's API and events hosts. Checkout branding assets go to `{{assetsHost}}` (`https://assets.revenuedot.app`). `setProxyURL` still overrides all of them, so self-hosters need no custom build.

**Signing key.** iOS `Signing.publicKey` and Android `DEFAULT_PUBLIC_KEY` carry RevenueDot's Ed25519 root public key (`gXdn2hmqR/TbdtQwK02laE0YgFz0Rtf918LICLrgZhg=`), so Trusted Entitlements verify against our server (section 4).

**Behaviour patches (small, each one closes a proxy-mode leak):**
1. Android: diagnostics, paywall events and ad events honour `proxyURL` (upstream sends them to RevenueCat hosts even behind a proxy).
2. purchases-js: analytics events honour `httpConfig.proxyURL` (upstream sends them to `e.revenue.cat`).
3. Flutter web: `Purchases.setProxyURL` works. Two rules: the web plugin only handled `setProxyURL` while the Dart API sends `setProxyURLString`, and the handler awaited the result of hybrid-mappings' `setProxyUrl` as a promise although it returns `void`, so every call threw (found by the 2026-10-02 release check).
4. purchases-js UI: "Secure checkout by RevenueCat" reads "Secure checkout by RevenueDot" in all 34 locales.

**Packaging.** Registry names (section 1), dependency pins between forks (hybrid-common → our iOS and Android; wrappers → our hybrid-common; hybrid-mappings → our purchases-js through an npm alias; the Flutter UI package → our Flutter core over git; KMP's iOS submodule → our purchases-ios), POM/podspec/package metadata (homepage, repository, author, description with the disclaimer).

**Licensing.** Every upstream `LICENSE` keeps RevenueCat's notice (and JayShortway's for KMP) unchanged; the pipeline adds one line after it: `Copyright (c) 2026 RevenueDot (modifications in this fork)`. Packages that shipped without a notice get one (`typescript/`, `purchases-js-hybrid-mappings/`, `purchases-capacitor-ui/`, and the one-word Galaxy stub). Podspecs point `:file => 'LICENSE'`. Third-party headers (AOSP, FasterXML) are untouched. Google Play SDK Console tokens (`verification.properties`) that belong to RevenueCat's coordinates are removed from KMP.

**Not changed on purpose:** log strings and doc comments that mention RevenueCat, API key prefixes (our server issues the same `appl_`, `goog_`, `rcb_`, `test_` prefixes, so the web SDK's prefix check passes unchanged), class names, `RevenueCatUI` exports.

## 3. The pipeline (`scripts/forks/`)

| File | Job |
|---|---|
| `config.json` | Org, branch names, variables (`apiHost`, `assetsHost`, `signingPublicKey`, `mavenGroup`, `npmScope`, `gitTagSuffix`, disclaimer and banner text), leak patterns, npm name map |
| `rules/<repo>.json` | Per-repo patch spec: ordered rules plus `publishes`, `scanExclude`, `checks`, `version` (where the fork declares its own version) and `pins` (version pins on other forks) |
| `rules/_shared.json` | Rule groups used by several repos: podspec metadata, Gradle POM properties, npm metadata |
| `lib/pins.ts` | Pins between forks: rewrites each pin that follows a fork to that fork's current version, and checks that every pinned version has a fork release branch or tag |
| `lib/rules.ts` | The rule engine. Rule types: `replace` (string or regex, file globs), `json` (JSON Pointer set/remove, `{{current}}`), `rename`, `copy`, `delete`, `license`, `banner`, `submodule`, `include` |
| `apply.ts` | Applies a repo's rules, writes `.revenuedot/fork.json` (rules hash, upstream merge base, host, key), runs the leak scan and the pin check (`--pins` runs only the pin check), and with `--commit`/`--push` commits one "RevenueDot fork patches" commit on the patch branch |
| `check.ts` | Runs the leak scan, the pin check and a repo's checks on a committed ref in a throwaway worktree (installs never touch the checkout); `lib/unalias.mjs` points unpublished `@revenuedot/*` aliases at the identical upstream builds for installs |
| `sync-upstream.sh` | Fetch upstream + tags → branch `upstream-sync` from `revenuedot/main-patches` → merge upstream (conflicts resolved to upstream; the rules regenerate our side) → re-apply rules → pin check (runs even with `--no-checks`) → checks → push branch and new tags → open or update a PR into `revenuedot/main-patches` |
| `e2e/purchases-js.e2e.ts` | The forked web SDK against the real server (section 5) |

**Every rule is idempotent and loud.** Running the pipeline twice changes nothing the second time. A rule whose target moved upstream fails with "Rule did not match … update the rule" instead of silently skipping, unless it is marked `optional`. After the rules run, the **leak scan** fails the repo if any RevenueCat API host, events host, fallback host, asset CDN or RevenueCat's signing key is left in shipped code (tests, examples, docs and changelogs are excluded per repo).

**Pins between forks come from the forks, not from hard-coded numbers.** Each pin is declared once in `rules/<repo>.json` `pins`, with the fork it names (`dep`), the files, a regex whose group 1 is the version, and `follow`:
- `follow: "fork"`: at apply time the pin is rewritten to the version the dependency fork carries on `revenuedot/main-patches` (read from its `version` source). Used for hybrid-mappings → purchases-js (now 1.67.0; upstream pinned 1.66.0), wrappers (React Native, Flutter, Capacitor, Unity, Cordova) → hybrid-common (19.4.1), and the packages that pin their own core (Flutter UI → Flutter core, React Native and Capacitor UI packages → their core). A version that is not a plain release (for example `-SNAPSHOT`) or has a different major version is left alone and reported.
- `follow: "upstream"`: upstream's number stays. Used for hybrid-common → iOS and Android and KMP → Android and iOS, because the native patch branches are unreleased `-SNAPSHOT` versions and the dependent was built against that exact upstream release.

**The pin check fails when a pin names a version no fork provides.** Every pinned version must exist in the dependency fork as branch `revenuedot/release-<v>` or tag `<v>-revenuedot`; a pin on the same repo must equal its own version. The check follows each release branch and checks its pins too (wrapper → hybrid-common 19.4.1 → Android 10.23.0). It runs in `apply.ts` (reported), `apply.ts --pins` (exit 1), `check.ts` (a failing check) and `sync-upstream.sh` (fails the repo). Its message names the command that creates the missing branch.

Current pins and the release branches they need (all pushed). Releases are tagged `<version>-revenuedot` on these branches; [docs/STATUS.md](../../docs/STATUS.md) row 1.13 lists what is on each registry.

| Pin | Version | Fork branch |
|---|---|---|
| hybrid-common `main-patches` → iOS, Android, purchases-js | 5.91.0, 10.23.3, 1.67.0 | `purchases-ios` `revenuedot/release-5.91.0`, `purchases-android` `revenuedot/release-10.23.3`, `purchases-js` `revenuedot/release-1.67.0` |
| hybrid-common release 19.4.1 → iOS, Android, purchases-js | 5.91.0, 10.23.0, 1.67.0 | the same iOS and purchases-js branches, `purchases-android` `revenuedot/release-10.23.0` |
| Wrappers (React Native, Flutter, Capacitor, Unity, Cordova) → hybrid-common | 19.4.1 | `purchases-hybrid-common` `revenuedot/release-19.4.1` |
| KMP `main-patches` → Android, iOS submodule | 10.22.1, 5.91.0 | `purchases-android` `revenuedot/release-10.22.1`, `purchases-ios` `revenuedot/release-5.91.0` |
| KMP release 3.10.1 → Android, iOS submodule | 10.22.1, 5.90.2 | `purchases-android` `revenuedot/release-10.22.1`, `purchases-ios` `revenuedot/release-5.90.2` |
| Wrapper releases | React Native 10.10.2, Capacitor 13.6.1, Cordova 8.2.3, Flutter 10.13.2, Unity 9.11.1, KMP 3.10.1 | `revenuedot/release-<version>` in each fork |

**Branches in each fork:**
- `main`: upstream `main` at fork time plus three README-only commits made by hand before the pipeline existed. The pipeline never pushes to it; nothing is built from it.
- `revenuedot/main-patches`: `main` (merged in, so GitHub shows `main` only as behind) plus upstream merges plus the pipeline commits. **The GitHub default branch since 2026-10-03**, so the repo page shows the RevenueDot README (the `readme` rule) instead of RevenueCat's. This is what we build and publish from. Why not patch `main`: `scripts/forks/README.md`.
- `upstream-sync`: created by `sync-upstream.sh`; merges into `revenuedot/main-patches` by PR.
- `revenuedot/release-<upstream tag>`: an upstream release tag plus the pipeline commit, made with `apply.ts --base <tag> --branch revenuedot/release-<tag>`. Release tags `<tag>-revenuedot` are cut from these. Which ones exist follows from the pins (table above).

**Self-host builds:** `apply.ts --var apiHost=https://iap.example.com --var signingPublicKey=<your key>` (or `REVENUEDOT_FORK_API_HOST` / `REVENUEDOT_FORK_SIGNING_PUBLIC_KEY`) produces forks for another host and key.

**Commands:**
```
pnpm tsx scripts/forks/apply.ts --all --commit --push     # (re)patch every fork on revenuedot/main-patches
pnpm tsx scripts/forks/apply.ts --all --pins              # pin check only
pnpm tsx scripts/forks/apply.ts --repo purchases-android --base 10.23.3 --branch revenuedot/release-10.23.3 --push   # a release branch a pin needs
pnpm tsx scripts/forks/check.ts --all --clean             # run every fork's checks
scripts/forks/sync-upstream.sh --all                      # after upstream releases
pnpm tsx scripts/forks/e2e/purchases-js.e2e.ts            # web SDK against the real server
```

## 4. Response signing (Trusted Entitlements)

**The server signs every 2xx/3xx response under `/v1` and `/rcbilling` exactly as RevenueCat's SDKs verify, so apps on our forks get `VERIFIED` entitlements instead of `FAILED`.**
- Code: `apps/server/src/services/signing.ts` (WebCrypto only, runs on Node and Workers), mounted in `apps/server/src/app.ts`.
- Key: `REVENUEDOT_SIGNING_KEY` = base64 of the 32-byte Ed25519 root seed. `pnpm tsx scripts/signing-keygen.ts` makes one. No key → no signing, and the SDK's default informational mode reports `FAILED` without blocking access.
- Wire format: 180-byte `X-Signature` (intermediate key, expiry in days, root signature, salt, payload signature); the payload covers salt, API key, `X-Nonce`, raw request path, `X-Post-Params-Hash`, `X-Headers-Hash`, `X-RevenueCat-Request-Time`, `X-RevenueCat-ETag` and the body. The server mints a 30-day intermediate key in memory and renews it with 7 days left.
- Public key: `GET /.well-known/revenuedot-signing-key` returns `{ algorithm: "Ed25519", public_key, … }`; the same value is `signingPublicKey` in `config.json` and is baked into the iOS and Android forks.
- Contract tests (`apps/server/test/signing.test.ts`): an independent verifier accepts all 8 real RevenueCat production signatures published in purchases-ios `SigningTests.swift` (proving the byte layout matches the SDKs), then accepts our server's signatures for iOS- and Android-shaped requests and rejects tampered body, nonce, path, API key, request time, wrong root key and an expired intermediate key.
- **Key custody:** the production root seed is held in two places only: the team's password manager and the `REVENUEDOT_SIGNING_KEY` secret of the `revenuedot` Worker behind `api.revenuedot.app`. No copy is kept on disk and it is never committed. The public key `gXdn2hmqR/TbdtQwK02laE0YgFz0Rtf918LICLrgZhg=` is published at https://api.revenuedot.app/.well-known/revenuedot-signing-key. Rotating it means re-running the pipeline with the new public key and shipping new SDK builds, so rotation is rare; a future step is to keep the root offline and give the server only pre-signed intermediate keys.
- Self-hosters on our official builds cannot sign with our root key. They either leave verification at the default (`DISABLED` on React Native, Flutter, KMP and TypeScript; informational elsewhere) or build forks with their own key (section 3).

## 5. Verification

- **Leak scan:** clean on all 10 forks.
- **Idempotency:** a second `apply.ts --all` run changes nothing, on `revenuedot/main-patches` and on every release branch.
- **Pin check:** passes on all 10 forks; a pin moved to a version with no fork branch (tested with hybrid-common 19.9.9 in Cordova) fails with the command that creates the branch.
- **README banners:** no fork README says "pre-alpha"; the banner says the fork is published and gives its install line.
- **Web SDK end to end** (`e2e/purchases-js.e2e.ts`): the built fork bundle defaults to `https://api.revenuedot.app` with no RevenueCat host; against the real server (own process, in-memory PGlite, production signing key) it configures with `proxyURL`, reads customer info, reads offerings, buys through the Test Store modal, sees the `pro` entitlement active, and the server's state agrees. Every SDK call, including analytics events, went to the proxy URL, and a nonce-signed response verified with the key baked into the forks.
- Per-repo checks and what is skipped for missing toolchains: [docs/STATUS.md](../../docs/STATUS.md).

## 6. Not done yet, and what each needs

1. **Counsel sign-off** on keeping `RevenueCat` module/package identifiers (section 1) and on the copyright line naming "RevenueDot" rather than Circo, Inc.
2. **npm trusted publishing:** npm accepts a trusted publisher only on a package that exists, so each new `@revenuedot` package needs one manual publish with Kai's 2FA (done for all ten on 2026-10-02), then `npm trust github <package> --repo revenuedot/<repo> --file revenuedot-release.yml --env production`. After that the fork's `revenuedot-release.yml` publishes on every `<version>-revenuedot` tag. Dry runs of that workflow upload the exact tarballs of packages not on npm yet (artifact `npm-tarballs`). CocoaPods trunk, Maven Central (`release-maven.yml` here, or each Android-based fork's own workflow) and the OpenUPM listing (in review) are set up.
3. **Release order:** iOS, Android → hybrid-common → purchases-js → hybrid-mappings → wrappers. Flutter's vendored `assets/web/purchases_js_hybrid_mappings.js` is replaced at release time by `dist/index.umd.js` from `@revenuedot/purchases-js-hybrid-mappings` of the pinned hybrid-common version (the same file upstream's fastlane downloads from its own package); the string-patch rules stay as a fallback and count as applied when the file already carries our host.
4. **CI:** a daily GitHub Actions job in this repo running `sync-upstream.sh --all`, with JDK 17 + Android SDK (Android, KMP), Xcode (iOS `swift build`/tests), Flutter, and Unity where licensable.
5. **Infrastructure:** `api.revenuedot.app` is live with `REVENUEDOT_SIGNING_KEY` (done 2026-09-30); `assets.revenuedot.app` serving checkout branding assets is not set up.
6. **Paywall renderer for web:** fork `@revenuecat/purchases-ui-js` from its npm tarball (its source repo is private) so purchases-js stops pulling RevenueCat's package at build time.
