// RevenueDot: decodes paywall_components and ui_config JSON with the RevenueCat iOS SDK's own models (from the purchases-ios fork checked out next to this repo)
// and prints the first error with its path.
// Usage: swift run -c release paywall-decode <file.json> [ui|workflow]
//        swift run -c release paywall-decode --many <file.json>...   (one "OK <file>" or "ERROR <file> ..." line each; exit 1 on any error)
import Foundation
@_spi(Internal) import RevenueCat

/// The decoder the SDK uses for API responses: snake_case keys and ISO 8601 dates (JSONDecoder.default in the SDK).
func sdkDecoder() -> JSONDecoder {
  let d = JSONDecoder()
  d.keyDecodingStrategy = .convertFromSnakeCase
  let frac = ISO8601DateFormatter(); frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let plain = ISO8601DateFormatter(); plain.formatOptions = [.withInternetDateTime]
  d.dateDecodingStrategy = .custom { decoder in
    let c = try decoder.singleValueContainer()
    let raw = try c.decode(String.self)
    if let date = frac.date(from: raw) ?? plain.date(from: raw) { return date }
    throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid ISO8601 date: \(raw)")
  }
  return d
}

func describe(_ error: Error) -> String {
  switch error {
  case let DecodingError.keyNotFound(k, ctx): return "keyNotFound \(k.stringValue) at \(ctx.codingPath.map(\.stringValue).joined(separator: ".")) \(ctx.debugDescription)"
  case let DecodingError.typeMismatch(t, ctx): return "typeMismatch \(t) at \(ctx.codingPath.map(\.stringValue).joined(separator: ".")) \(ctx.debugDescription)"
  case let DecodingError.valueNotFound(t, ctx): return "valueNotFound \(t) at \(ctx.codingPath.map(\.stringValue).joined(separator: ".")) \(ctx.debugDescription)"
  case let DecodingError.dataCorrupted(ctx): return "dataCorrupted at \(ctx.codingPath.map(\.stringValue).joined(separator: ".")) \(ctx.debugDescription)"
  default: return "\(error)"
  }
}

/// nil when the file decodes as paywall components; else the first error.
func decodePaywall(_ data: Data) -> String? {
  do {
    let pw = try sdkDecoder().decode(PaywallComponentsData.self, from: data)
    if let e = pw.errorInfo, !e.isEmpty { return e.map { "ERROR in \($0.key) \($0.value)" }.joined(separator: "; ") }
    return nil
  } catch { return describe(error) }
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "--many" {
  var failed = false
  for file in args.dropFirst() {
    guard let data = FileManager.default.contents(atPath: file) else { print("ERROR \(file) unreadable"); failed = true; continue }
    if let e = decodePaywall(data) { print("ERROR \(file) \(e)"); failed = true } else { print("OK \(file)") }
  }
  exit(failed ? 1 : 0)
}

let data = try Data(contentsOf: URL(fileURLWithPath: args[0]))
if args.count > 1 && args[1] == "workflow" {
  do { let w = try sdkDecoder().decode(PublishedWorkflow.self, from: data); print("WORKFLOW OK", w.id, w.screens.keys.sorted(), w.steps.keys.sorted()) } catch { print("WORKFLOW ERROR", describe(error)) }
  exit(0)
}
if args.count > 1 {
  do { let u = try sdkDecoder().decode(UIConfig.self, from: data); print("UI OK", u.app.fonts.keys.sorted(), u.localizations.keys.sorted()) } catch { print("UI ERROR", describe(error)) }
  exit(0)
}
if let e = decodePaywall(data) { print(e) } else {
  let pw = try sdkDecoder().decode(PaywallComponentsData.self, from: data)
  print("OK", pw.templateName, pw.componentsLocalizations.keys.sorted())
}
