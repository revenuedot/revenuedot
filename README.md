# RevenueDot

**Open-source subscription and in-app purchase backend. Works with the RevenueCat SDK: change one line and keep your app code.**

> Status: pre-alpha. The scope is in [prd/SCOPE.md](prd/SCOPE.md). Nothing is ready to use yet.
>
> License: AGPL-3.0 for the server and dashboard; the `ee/` folder is under the [RevenueDot Enterprise License](ee/LICENSE); SDKs, CLI, MCP server and agent skills are MIT. Contributions need a [CLA](.github/CLA.md). Website: [revenuedot.app](https://revenuedot.app).

## What it does
- Validates App Store and Google Play purchases and keeps entitlements up to date.
- Answers the same API the RevenueCat SDKs call, so existing apps move by setting a proxy URL.
- Sends webhooks with the same payloads, so your backend code keeps working.
- Imports your catalog, customers and history in one command.
- Runs anywhere: `docker compose up` on your own server, or the hosted cloud.

## Switching (planned)
```swift
Purchases.proxyURL = URL(string: "https://api.revenuedot.app")!
```

RevenueDot is not affiliated with RevenueCat, Inc. "RevenueCat" is a trademark of RevenueCat, Inc.
