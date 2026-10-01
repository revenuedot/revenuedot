// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "paywall-decode",
  platforms: [.macOS(.v13)],
  dependencies: [.package(path: "../../../../purchases-ios")],
  targets: [.executableTarget(name: "paywall-decode", dependencies: [.product(name: "RevenueCat", package: "purchases-ios")])]
)
