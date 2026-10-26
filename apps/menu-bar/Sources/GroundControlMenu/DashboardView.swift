import SwiftUI

struct DashboardView: View {
  @ObservedObject var model: StatusModel

  private var statusColor: Color {
    if model.workerConnected && model.relayOk { return .green }
    if model.relayOk { return .orange }
    return .red
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        ZStack {
          Circle()
            .fill(
              LinearGradient(
                colors: [Color(red: 0.05, green: 0.2, blue: 0.35), Color(red: 0.1, green: 0.35, blue: 0.5)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
            .frame(width: 52, height: 52)
          Image(systemName: "antenna.radiowaves.left.and.right")
            .font(.title2)
            .foregroundStyle(Color.cyan)
        }
        VStack(alignment: .leading, spacing: 4) {
          Text("Ground Control")
            .font(.title2.bold())
          HStack(spacing: 6) {
            Circle().fill(statusColor).frame(width: 8, height: 8)
            Text(model.statusLine)
              .foregroundStyle(.secondary)
          }
        }
        Spacer()
      }

      Text(model.detail)
        .font(.subheadline)
        .foregroundStyle(.secondary)

      if !model.publicURL.isEmpty {
        Text(model.publicURL)
          .font(.caption)
          .textSelection(.enabled)
          .lineLimit(2)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color.primary.opacity(0.05))
          .clipShape(RoundedRectangle(cornerRadius: 8))
      }

      HStack {
        Button("Refresh") { model.refresh() }
        Button("Copy MCP URL") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(model.publicURL + "/mcp", forType: .string)
        }
        .disabled(model.publicURL.isEmpty)
        Spacer()
        Button("Open whiteboard") {
          if let url = URL(string: "http://127.0.0.1:8788/") {
            NSWorkspace.shared.open(url)
          }
        }
      }

      Text("Checked \(model.lastChecked)")
        .font(.caption2)
        .foregroundStyle(.tertiary)

      Spacer(minLength: 0)
    }
    .padding(20)
    .frame(width: 380, height: 280)
    .background(WindowConfigurator())
  }

  private struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
      let view = NSView()
      DispatchQueue.main.async {
        view.window?.identifier = NSUserInterfaceItemIdentifier("dashboard")
        view.window?.title = "Ground Control"
      }
      return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
  }
}
