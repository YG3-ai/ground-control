import AppKit

enum MenuBarIcon {
  static var image: NSImage {
    if let named = NSImage(named: "MenuBarIcon") {
      named.isTemplate = true
      return named
    }
    let fallback = NSImage(
      systemSymbolName: "antenna.radiowaves.left.and.right",
      accessibilityDescription: "Ground Control"
    )!
    fallback.isTemplate = true
    return fallback
  }
}
