import SwiftUI
import AppKit

// MARK: - Slash commands ("/" in the message box)

struct SlashItem: Identifiable, Hashable {
    enum Kind: Hashable { case command, skill }
    var id: String { name }
    let name: String          // without the slash
    let detail: String
    let kind: Kind
    let icon: String
}

enum SlashCommands {
    static let commands: [SlashItem] = [
        SlashItem(name: "compact", detail: "Summarise older messages so the chat can keep going", kind: .command, icon: "rectangle.compress.vertical"),
        SlashItem(name: "new", detail: "Start a new chat", kind: .command, icon: "square.and.pencil"),
        SlashItem(name: "mcp", detail: "MCP servers Ingle knows about, and whether they're connected", kind: .command, icon: "puzzlepiece.extension"),
        SlashItem(name: "skill-reload", detail: "Re-read skills, rules and MCP servers from disk", kind: .command, icon: "arrow.clockwise"),
        SlashItem(name: "commands", detail: "Commands Ingle enforces (rules the assistant must obey)", kind: .command, icon: "exclamationmark.shield"),
        SlashItem(name: "secret", detail: "Save a password or key in the Keychain, for the assistant to use with your approval", kind: .command, icon: "key"),
    ]

    static func items(skills: [Skill]) -> [SlashItem] {
        commands + skills.map { SlashItem(name: $0.name, detail: $0.description.isEmpty ? "Skill" : $0.description, kind: .skill, icon: "wand.and.stars") }
    }

    /// The text after "/" while the user is still typing the command name, or nil when the menu shouldn't show.
    static func query(_ draft: String) -> String? {
        guard draft.hasPrefix("/"), !draft.contains(" "), !draft.contains("\n") else { return nil }
        return String(draft.dropFirst()).lowercased()
    }

    static func filter(_ items: [SlashItem], _ q: String) -> [SlashItem] {
        guard !q.isEmpty else { return items }
        let starts = items.filter { $0.name.lowercased().hasPrefix(q) }
        let contains = items.filter { !$0.name.lowercased().hasPrefix(q) && ($0.name.lowercased().contains(q) || $0.detail.lowercased().contains(q)) }
        return starts + contains
    }

    /// "/code-review please check Invoice.tsx" → the skill named code-review, if there is one.
    static func skill(in text: String, skills: [Skill]) -> Skill? {
        guard text.hasPrefix("/") else { return nil }
        let word = text.dropFirst().split(whereSeparator: { $0 == " " || $0 == "\n" }).first.map(String.init) ?? ""
        return skills.first { $0.name.caseInsensitiveCompare(word) == .orderedSame }
    }
}

struct SlashMenu: View {
    let items: [SlashItem]
    let selected: Int
    let pick: (SlashItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                Text("No commands or skills match")
                    .font(.system(size: 12)).foregroundStyle(Ember.tertiary)
                    .padding(12)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                                if i == 0 || items[i - 1].kind != item.kind {
                                    Text(item.kind == .command ? "COMMANDS" : "SKILLS")
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundStyle(Ember.tertiary)
                                        .padding(.horizontal, 10)
                                        .padding(.top, i == 0 ? 4 : 10)
                                        .padding(.bottom, 4)
                                }
                                Button { pick(item) } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: item.icon)
                                            .font(.system(size: 12))
                                            .foregroundStyle(i == selected ? Ember.accent : Ember.secondary)
                                            .frame(width: 18)
                                        Text("/" + item.name)
                                            .font(.system(size: 13, weight: .medium, design: .monospaced))
                                            .foregroundStyle(Ember.text)
                                        Text(item.detail)
                                            .font(.system(size: 12))
                                            .foregroundStyle(Ember.secondary)
                                            .lineLimit(1)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.horizontal, 10)
                                    .frame(height: 30)
                                    .background(RoundedRectangle(cornerRadius: 8)
                                        .fill(i == selected ? Ember.accent.opacity(0.13) : Color.clear))
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .id(item.id)
                            }
                        }
                        .padding(6)
                    }
                    .frame(maxHeight: 280)
                    .onChange(of: selected) {
                        if items.indices.contains(selected) { proxy.scrollTo(items[selected].id) }
                    }
                }
            }
            Divider().overlay(Color.white.opacity(0.06))
            Text("↑↓ to choose · Tab or Return to pick · Esc to close")
                .font(.system(size: 10.5))
                .foregroundStyle(Ember.tertiary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        }
        .frame(maxWidth: 720, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Ember.raised))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.09)))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
    }
}

// MARK: - /mcp

struct MCPSheet: View {
    @Environment(\.dismiss) private var dismiss
    private var mcp: MCPManager { MCPManager.shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("MCP servers").font(.system(size: 16, weight: .semibold)).foregroundStyle(Ember.text)
                    Text("From ~/.ingle/mcp.json, plus Cursor and Claude Code’s configs. The assistant can use them in any chat; each call asks you first.")
                        .font(.system(size: 12)).foregroundStyle(Ember.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            .padding(20)

            Divider().overlay(Color.white.opacity(0.06))

            if mcp.servers.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "puzzlepiece.extension").font(.system(size: 26)).foregroundStyle(Ember.tertiary)
                    Text("No MCP servers yet").foregroundStyle(Ember.text)
                    Text("Add them to ~/.ingle/mcp.json, or import Claude Desktop’s.").font(.system(size: 12)).foregroundStyle(Ember.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 160)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(mcp.servers) { server in
                            MCPStatusRow(server: server)
                            if server.id != mcp.servers.last?.id { Divider().overlay(Color.white.opacity(0.05)) }
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .frame(maxHeight: 360)
            }

            Divider().overlay(Color.white.opacity(0.06))
            HStack(spacing: 10) {
                Button("Edit mcp.json") { mcp.openConfig() }
                Button("Reload") { mcp.reload() }
                Button("Connect all") { Task { await mcp.ensureStarted() } }
                    .disabled(mcp.servers.isEmpty)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 560)
        .background(Ember.bg)
    }
}

private struct MCPStatusRow: View {
    let server: MCPServerConfig
    private var mcp: MCPManager { MCPManager.shared }
    private var status: MCPStatus { mcp.status[server.name] ?? .stopped }

    private var dot: Color {
        if !mcp.isEnabled(server.name) { return Color.white.opacity(0.2) }
        switch status {
        case .running: return .green
        case .starting: return .yellow
        case .failed: return .red
        case .stopped: return Color.white.opacity(0.35)
        }
    }

    private var label: String {
        if !mcp.isEnabled(server.name) { return "Turned off" }
        switch status {
        case .stopped: return "Not connected — connects when a chat needs it"
        case .starting: return "Connecting…"
        case .running(let n): return "Connected · \(n) tool\(n == 1 ? "" : "s")"
        case .failed(let message): return "Couldn’t connect: \(message)"
        }
    }

    private var tools: [String] { mcp.tools.filter { $0.server == server.name }.map(\.name) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Circle().fill(dot).frame(width: 8, height: 8)
                Text(server.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Ember.text)
                Text("from \(mcp.source(of: server.name))")
                    .font(.system(size: 10, weight: .medium))
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .foregroundStyle(Ember.secondary)
                    .background(Capsule().fill(Color.white.opacity(0.07)))
                Spacer()
                Toggle("", isOn: Binding(get: { mcp.isEnabled(server.name) }, set: { mcp.setEnabled(server.name, $0) }))
                    .toggleStyle(.switch).controlSize(.mini).labelsHidden()
                    .help("Let Ingle use this server")
                Button(isConnected ? "Reconnect" : "Connect") { Task { await mcp.restart(server.name) } }
                    .controlSize(.small)
                    .disabled(!mcp.isEnabled(server.name))
                if isConnected {
                    Button("Disconnect") { mcp.stop(server.name) }.controlSize(.small)
                }
            }
            Text(label).font(.system(size: 11.5)).foregroundStyle(Ember.secondary).lineLimit(3)
                .padding(.leading, 18)
            Text(([server.command] + server.args).joined(separator: " "))
                .font(.system(size: 11, design: .monospaced)).foregroundStyle(Ember.tertiary).lineLimit(1).truncationMode(.middle)
                .padding(.leading, 18)
            if !tools.isEmpty {
                Text(tools.joined(separator: " · "))
                    .font(.system(size: 11)).foregroundStyle(Ember.secondary).lineLimit(2)
                    .padding(.leading, 18)
            }
        }
        .padding(.vertical, 12)
    }

    private var isConnected: Bool {
        if case .running = status { return true }
        return false
    }
}
