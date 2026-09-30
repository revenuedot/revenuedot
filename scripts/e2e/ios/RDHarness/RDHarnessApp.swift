// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the iOS contract harness app. The unmodified RevenueCat iOS SDK, pointed at a RevenueDot server with
// Purchases.proxyURL and a Test Store (test_) key from the launch environment, exposes each SDK call as a button that
// the XCUITest in RDHarnessUITests drives. Docs: https://revenuedot.app/docs/sdks/ios
// `@_spi(Internal)` is only for the Customer Center fetch, which RevenueCatUI makes through the same call.
@_spi(Internal) import RevenueCat
import SwiftUI

@main
struct RDHarnessApp: App {
    init() {
        let env = ProcessInfo.processInfo.environment
        Purchases.logLevel = .debug
        // The one line an app changes to move to RevenueDot (proxy mode), set before configure.
        Purchases.proxyURL = URL(string: env["RD_SERVER_URL"] ?? "http://localhost:8787")!
        Purchases.configure(
            with: Configuration.Builder(withAPIKey: env["RD_API_KEY"] ?? "test_missing")
                // Proxy mode with the stock SDK: RevenueCat's signing key cannot verify RevenueDot's responses.
                .with(entitlementVerificationMode: .disabled)
                .build()
        )
    }

    var body: some Scene { WindowGroup { HarnessView() } }
}

@MainActor
final class Harness: ObservableObject {
    @Published var appUserID = Purchases.shared.appUserID
    @Published var packages: [Package] = []
    @Published var entitlement = "pro: unknown"
    @Published var status = "configured"
    @Published var extras = ""

    private func show(_ info: CustomerInfo) {
        appUserID = Purchases.shared.appUserID
        let pro = info.entitlements["pro"]
        entitlement = pro?.isActive == true ? "pro: active (\(pro!.productIdentifier))" : "pro: inactive"
    }

    func step(_ name: String, _ body: () async throws -> Void) async {
        status = "\(name): running"
        do { try await body(); status = "\(name): ok" } catch { status = "\(name): failed \(error.localizedDescription)" }
    }

    func customerInfo() async { await step("customerInfo") { show(try await Purchases.shared.customerInfo(fetchPolicy: .fetchCurrent)) } }

    func offerings() async {
        await step("offerings") {
            let o = try await Purchases.shared.offerings()
            packages = o.current?.availablePackages ?? []
            if packages.isEmpty { throw NSError(domain: "harness", code: 1, userInfo: [NSLocalizedDescriptionKey: "no current offering"]) }
        }
    }

    func buy(_ p: Package) async {
        await step("purchase") {
            let r = try await Purchases.shared.purchase(package: p)
            if r.userCancelled { throw NSError(domain: "harness", code: 2, userInfo: [NSLocalizedDescriptionKey: "cancelled"]) }
            show(r.customerInfo)
        }
    }

    func logIn(_ id: String) async { await step("logIn") { show(try await Purchases.shared.logIn(id).customerInfo) } }

    /// Attribution and attributes through the public API: the reserved setters, device identifiers, the deprecated
    /// Apple Search Ads call (`POST .../attribution`) and AdServices token collection (`POST .../adservices_attribution`).
    func attribution() async {
        await step("attribution") {
            let a = Purchases.shared.attribution
            a.setEmail("harness@revenuedot.test")
            a.setDisplayName("RD Harness")
            a.setAttributes(["harness_run": "ios"])
            a.setAdjustID("adjust-harness-1")
            a.collectDeviceIdentifiers()
            Purchases.addAttributionData(
                ["Version3.1": ["iad-attribution": "true", "iad-campaign-name": "Harness Spring", "iad-adgroup-name": "Harness Group", "iad-keyword": "harness"]],
                from: .appleSearchAds, forNetworkUserId: nil
            )
            a.enableAdServicesAttributionTokenCollection()
            _ = try await Purchases.shared.syncAttributesAndOfferingsIfNeeded()
            // The attribution and AdServices posts run on the SDK's own queue; give them time to finish.
            try await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    /// The other public calls that reach RevenueDot: sync, virtual currencies, web purchase redemption, reward
    /// verification and the Customer Center configuration. Each result is shown for the UI test to check.
    func others() async {
        await step("others") {
            var out: [String] = []
            _ = try await Purchases.shared.syncPurchases()
            out.append("sync=ok")
            let vcs = try await Purchases.shared.virtualCurrencies()
            out.append("vc=\(vcs.all.count)")
            let redemption = Purchases.parseAsWebPurchaseRedemption(URL(string: "rdharness://redeem_web_purchase?redemption_token=harness-token")!)!
            switch await Purchases.shared.redeemWebPurchase(redemption) {
            case .invalidToken: out.append("redeem=invalidToken")
            case .success: out.append("redeem=success")
            case .error(let e): out.append("redeem=error \(e.code)")
            case .purchaseBelongsToOtherUser: out.append("redeem=otherUser")
            case .expired: out.append("redeem=expired")
            }
            let reward = await Purchases.shared.pollRewardVerification(clientTransactionID: UUID().uuidString)
            out.append(reward == .failed ? "reward=failed" : "reward=other")
            do { _ = try await Purchases.shared.loadCustomerCenter(); out.append("cc=loaded") } catch { out.append("cc=error") }
            extras = out.joined(separator: " ")
        }
    }
}

struct HarnessView: View {
    @StateObject private var h = Harness()
    @State private var loginID = ProcessInfo.processInfo.environment["RD_LOGIN_ID"] ?? "harness_user"

    var body: some View {
        // Status and results stay above the list, so the UI test can read them while the list is scrolled.
        VStack(spacing: 0) {
        VStack(alignment: .leading, spacing: 4) {
            Text(h.status).accessibilityIdentifier("status")
            Text(h.extras.isEmpty ? "-" : h.extras).font(.caption).accessibilityIdentifier("extras")
        }.padding(.horizontal)
        List {
            Section("State") {
                Text(h.appUserID).accessibilityIdentifier("appUserID")
                Text(h.entitlement).accessibilityIdentifier("entitlement")
                Text(h.packages.map { "\($0.identifier)=\($0.storeProduct.productIdentifier) \($0.localizedPriceString)" }.joined(separator: ", "))
                    .accessibilityIdentifier("packages")
            }
            Section("SDK calls") {
                Button("getCustomerInfo") { Task { await h.customerInfo() } }.accessibilityIdentifier("customerInfoButton")
                Button("getOfferings") { Task { await h.offerings() } }.accessibilityIdentifier("offeringsButton")
                ForEach(h.packages, id: \.identifier) { p in
                    Button("purchase \(p.identifier)") { Task { await h.buy(p) } }.accessibilityIdentifier("buy-\(p.identifier)")
                }
                TextField("app user id", text: $loginID).accessibilityIdentifier("loginField")
                Button("logIn") { Task { await h.logIn(loginID) } }.accessibilityIdentifier("loginButton")
                Button("attribution") { Task { await h.attribution() } }.accessibilityIdentifier("attributionButton")
                Button("other calls") { Task { await h.others() } }.accessibilityIdentifier("othersButton")
            }
        }
        }
    }
}
