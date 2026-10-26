import AppKit

extension Notification.Name {
  static let groundControlShowDashboard = Notification.Name("groundControlShowDashboard")
}

private let showDashboardDistributed = Notification.Name("com.groundcontrol.show-dashboard")

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationWillFinishLaunching(_ notification: Notification) {
    let bundleId = Bundle.main.bundleIdentifier ?? "com.groundcontrol.menubar"
    let myPid = ProcessInfo.processInfo.processIdentifier
    for app in NSWorkspace.shared.runningApplications {
      guard app.bundleIdentifier == bundleId, app.processIdentifier != myPid else { continue }
      // Already running — focus it and open the dashboard instead of a second menu-bar icon.
      app.activate()
      DistributedNotificationCenter.default().post(name: showDashboardDistributed, object: nil)
      NSApp.terminate(nil)
      return
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApplication.shared.dockTile.badgeLabel = nil

    DistributedNotificationCenter.default().addObserver(
      forName: showDashboardDistributed,
      object: nil,
      queue: .main
    ) { _ in
      AppDelegate.showDashboard()
    }

    DispatchQueue.main.async {
      Self.hideDashboardWindows()
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    NotificationCenter.default.post(name: .groundControlShowDashboard, object: nil)
    NSApp.activate(ignoringOtherApps: true)
    return true
  }

  static func hideDashboardWindows() {
    for window in NSApp.windows where window.identifier?.rawValue == "dashboard" {
      window.orderOut(nil)
    }
  }

  static func showDashboard() {
    for window in NSApp.windows where window.identifier?.rawValue == "dashboard" {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    NotificationCenter.default.post(name: .groundControlShowDashboard, object: nil)
  }
}
