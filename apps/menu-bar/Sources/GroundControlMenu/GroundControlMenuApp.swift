import AppKit
import Foundation
import SwiftUI

@main
struct GroundControlMenuApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var model = StatusModel()

  var body: some Scene {
    MenuBarExtra {
      ContentView(model: model)
    } label: {
      Image(nsImage: menuBarStatusImage)
    }
    .menuBarExtraStyle(.menu)

    WindowGroup(id: "dashboard") {
      DashboardView(model: model)
    }
    .windowResizability(.contentSize)
    .defaultPosition(.center)
  }

  private var menuBarStatusImage: NSImage {
    let symbolName: String
    if !model.pendingApprovals.isEmpty {
      symbolName = "bell.badge"
    } else if model.workerConnected && model.relayOk {
      symbolName = "shield.checkered"
    } else {
      symbolName = model.iconName
    }
    let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
    if let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: "Ground Control")?
      .withSymbolConfiguration(config) {
      symbol.isTemplate = true
      return symbol
    }
    return MenuBarIcon.image
  }
}

struct ApprovalItem: Identifiable {
  let id: String
  let title: String
  let detail: String
  let kind: String
}

@MainActor
final class StatusModel: ObservableObject {
  @Published var workerConnected = false
  @Published var relayOk = false
  @Published var publicURL = ""
  @Published var lastChecked = "never"
  @Published var detail = "Checking…"
  @Published var pendingApprovals: [ApprovalItem] = []
  @Published var localControlOk = false

  private var timer: Timer?

  var iconName: String {
    if !pendingApprovals.isEmpty { return "bell.badge" }
    if workerConnected && relayOk { return "antenna.radiowaves.left.and.right" }
    if relayOk { return "antenna.radiowaves.left.and.right.slash" }
    return "exclamationmark.triangle"
  }

  var statusLine: String {
    if !pendingApprovals.isEmpty {
      return "\(pendingApprovals.count) approval(s) waiting"
    }
    if workerConnected { return "Running · worker connected" }
    if relayOk { return "Relay up · worker disconnected" }
    return "Not reachable"
  }

  private static let projectRoot = "/Users/partha/Projects/agent-control"

  init() {
    Self.ensureBackendServices()
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
  }

  /// Kickstarts relay, ngrok, and worker (installs LaunchAgents on first run).
  private static func ensureBackendServices() {
    let script = projectRoot + "/scripts/ensure-services.sh"
    DispatchQueue.global(qos: .utility).async {
      let task = Process()
      task.executableURL = URL(fileURLWithPath: "/bin/bash")
      task.arguments = [script]
      try? task.run()
      task.waitUntilExit()
    }
  }

  func refresh() {
    Task {
      async let health = Self.fetchHealth()
      async let approvals = Self.fetchApprovals()
      let (h, a) = await (health, approvals)
      await MainActor.run {
        self.relayOk = h.ok
        self.workerConnected = h.worker
        self.publicURL = h.url
        self.detail = h.detail
        self.localControlOk = a.ok
        self.pendingApprovals = a.items
        let fmt = DateFormatter()
        fmt.timeStyle = .short
        self.lastChecked = fmt.string(from: Date())
      }
    }
  }

  func resolve(id: String, approve: Bool) {
    Task {
      await Self.postResolve(id: id, approve: approve)
      await MainActor.run { self.refresh() }
    }
  }

  private struct Health {
    var ok: Bool
    var worker: Bool
    var url: String
    var detail: String
  }

  private struct ApprovalsFetch {
    var ok: Bool
    var items: [ApprovalItem]
  }

  private static func fetchHealth() async -> Health {
    guard let url = URL(string: "http://127.0.0.1:8787/healthz") else {
      return Health(ok: false, worker: false, url: "", detail: "bad url")
    }
    do {
      let (data, response) = try await URLSession.shared.data(from: url)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        return Health(ok: false, worker: false, url: "", detail: "relay not responding")
      }
      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      let worker = (json?["worker"] as? [String: Any])?["connected"] as? Bool ?? false
      let pub = json?["public_base_url"] as? String ?? ""
      return Health(
        ok: true,
        worker: worker,
        url: pub,
        detail: worker ? "ChatGPT can reach your Mac" : "Start/reconnect worker"
      )
    } catch {
      return Health(ok: false, worker: false, url: "", detail: "relay offline")
    }
  }

  private static func fetchApprovals() async -> ApprovalsFetch {
    guard let url = URL(string: "http://127.0.0.1:8788/approvals") else {
      return ApprovalsFetch(ok: false, items: [])
    }
    do {
      let (data, response) = try await URLSession.shared.data(from: url)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        return ApprovalsFetch(ok: false, items: [])
      }
      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      let raw = json?["approvals"] as? [[String: Any]] ?? []
      let items = raw.compactMap { row -> ApprovalItem? in
        guard let id = row["id"] as? String,
              let title = row["title"] as? String else { return nil }
        let status = row["status"] as? String ?? ""
        guard status == "pending" else { return nil }
        return ApprovalItem(
          id: id,
          title: title,
          detail: (row["detail"] as? String) ?? "",
          kind: (row["kind"] as? String) ?? "general"
        )
      }
      return ApprovalsFetch(ok: true, items: items)
    } catch {
      return ApprovalsFetch(ok: false, items: [])
    }
  }

  private static func postResolve(id: String, approve: Bool) async {
    let action = approve ? "approve" : "deny"
    guard let url = URL(string: "http://127.0.0.1:8788/approvals/\(id)/\(action)") else {
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data(#"{"note":"menubar"}"#.utf8)
    _ = try? await URLSession.shared.data(for: req)
  }
}

struct ContentView: View {
  @ObservedObject var model: StatusModel
  @Environment(\.openWindow) private var openWindow
  private let root = "/Users/partha/Projects/agent-control"

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Ground Control")
        .font(.headline)
      Text(model.statusLine)
        .foregroundStyle(model.workerConnected ? .primary : .secondary)
      Text(model.detail)
        .font(.caption)
        .foregroundStyle(.secondary)
      Text("Checked \(model.lastChecked)")
        .font(.caption2)
        .foregroundStyle(.tertiary)
      if model.localControlOk {
        Text("Local approvals API · :8788")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }

      if !model.pendingApprovals.isEmpty {
        Divider()
        Text("Pending approvals")
          .font(.caption)
          .foregroundStyle(.secondary)
        ForEach(model.pendingApprovals) { item in
          Text("\(item.kind): \(item.title)")
            .lineLimit(2)
          HStack {
            Button("Approve") { model.resolve(id: item.id, approve: true) }
            Button("Deny", role: .destructive) {
              model.resolve(id: item.id, approve: false)
            }
          }
        }
      }

      Divider()

      Button("Open dashboard window") {
        openWindow(id: "dashboard")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
          AppDelegate.showDashboard()
        }
      }
      Button("Refresh status") { model.refresh() }
      Button("Open whiteboard") {
        if let url = URL(string: "http://127.0.0.1:8788/") {
          NSWorkspace.shared.open(url)
        }
      }
      Button("Open logs folder") { open(root + "/logs") }
      if !model.publicURL.isEmpty {
        Button("Copy MCP URL") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(model.publicURL + "/mcp", forType: .string)
        }
      }

      Divider()

      Button("Quit menu only (keep worker running)") {
        NSApp.terminate(nil)
      }

      Button("Stop Ground Control services…", role: .destructive) {
        confirmStopServices()
      }
    }
    .padding(4)
    .onReceive(NotificationCenter.default.publisher(for: .groundControlShowDashboard)) { _ in
      openWindow(id: "dashboard")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        AppDelegate.showDashboard()
      }
    }
  }

  private func open(_ path: String) {
    NSWorkspace.shared.open(URL(fileURLWithPath: path))
  }

  private func confirmStopServices() {
    let alert = NSAlert()
    alert.messageText = "Stop Ground Control?"
    alert.informativeText =
      "This stops relay, ngrok, and the worker LaunchAgents. Active ChatGPT jobs will lose the Mac connection. The menu bar icon will quit too."
    alert.alertStyle = .warning
    alert.addButton(withTitle: "Stop services")
    alert.addButton(withTitle: "Cancel")
    if alert.runModal() == .alertFirstButtonReturn {
      let script = root + "/scripts/uninstall-launchagents.sh"
      let task = Process()
      task.executableURL = URL(fileURLWithPath: "/bin/bash")
      task.arguments = [script]
      try? task.run()
      task.waitUntilExit()
      NSApp.terminate(nil)
    }
  }
}
