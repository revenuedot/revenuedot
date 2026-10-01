// RevenueDot: decodes paywall_components and ui_config JSON with the RevenueCat iOS SDK's own models (from the purchases-ios fork checked out next to this repo)
// and prints the first error with its path. Usage: swift run -c release paywall-decode <file.json> [ui]
import Foundation
@_spi(Internal) import RevenueCat

// Decodes a paywall_components JSON file the way the SDK does and prints the first error with its path.
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
if CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "workflow" {
  do { let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; let w = try d.decode(PublishedWorkflow.self, from: data); print("WORKFLOW OK", w.id, w.screens.keys.sorted(), w.steps.keys.sorted()) } catch { print("WORKFLOW ERROR", error) }
  exit(0)
}
if CommandLine.arguments.count > 2 {
  let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase
  do { let u = try d.decode(UIConfig.self, from: data); print("UI OK", u.app.fonts.keys.sorted(), u.localizations.keys.sorted()) } catch { print("UI ERROR", error) }
  exit(0)
}
let decoder = JSONDecoder()
decoder.keyDecodingStrategy = .convertFromSnakeCase
do {
  let pw = try decoder.decode(PaywallComponentsData.self, from: data)
  if let e = pw.errorInfo, !e.isEmpty { for (k, v) in e { print("ERROR in", k, v) } } else { print("OK", pw.templateName, pw.componentsLocalizations.keys.sorted()) }
} catch let DecodingError.keyNotFound(k, ctx) { print("keyNotFound", k.stringValue, ctx.codingPath.map(\.stringValue).joined(separator: "."), ctx.debugDescription) }
catch let DecodingError.typeMismatch(t, ctx) { print("typeMismatch", t, ctx.codingPath.map(\.stringValue).joined(separator: "."), ctx.debugDescription) }
catch let DecodingError.valueNotFound(t, ctx) { print("valueNotFound", t, ctx.codingPath.map(\.stringValue).joined(separator: "."), ctx.debugDescription) }
catch let DecodingError.dataCorrupted(ctx) { print("dataCorrupted", ctx.codingPath.map(\.stringValue).joined(separator: "."), ctx.debugDescription) }
catch { print("error", error) }
