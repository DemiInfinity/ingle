import SwiftUI
import AppKit

// Code mode's views: the Chat / Code switch, the folder picker for a new Code chat, and the project chip.

/// The Chat / Code switch at the top of the chat window (⌘⇧C).
struct ModeSwitch: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        Picker("Mode", selection: Binding(get: { store.current?.isCode ?? false }, set: { store.switchMode(code: $0) })) {
            Text("Chat").tag(false)
            Text("Code").tag(true)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 140)
        .help("Chat for anything; Code to work on a project folder (⌘⇧C)")
    }
}

/// Lets the user pick a folder with the system panel. Returns nil if they cancel.
@MainActor
func chooseProjectFolder() -> String? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Open Project"
    panel.message = "Choose a project folder for this Code chat"
    return panel.runModal() == .OK ? panel.url?.path : nil
}

/// Shown in a new Code chat until it has a folder: choose one, drop one in, or pick a recent project.
struct ProjectPicker: View {
    @Environment(ChatStore.self) private var store
    @State private var recent: [String] = Project.recent

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            RoundedRectangle(cornerRadius: 16)
                .fill(Ember.surface)
                .frame(width: 64, height: 64)
                .overlay(Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 24, weight: .medium)).foregroundStyle(Ember.accent))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.08)))
            VStack(spacing: 6) {
                Text("Which project?")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(Ember.text)
                Text("Choose a folder or drop one here. Reading it needs no approval; changes and commands still ask.")
                    .font(.system(size: 13))
                    .foregroundStyle(Ember.secondary)
                    .multilineTextAlignment(.center)
            }
            Button {
                if let path = chooseProjectFolder() { store.setProject(path) }
            } label: {
                Label("Choose Folder…", systemImage: "folder")
            }
            .controlSize(.large)
            .keyboardShortcut("o", modifiers: [.command, .shift])
            if !recent.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Recent projects").font(.system(size: 11, weight: .medium)).foregroundStyle(Ember.tertiary)
                    ForEach(recent, id: \.self) { path in
                        Button { store.setProject(path) } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "folder").foregroundStyle(Ember.accent)
                                Text(Project.name(path)).foregroundStyle(Ember.text)
                                Text(tidy(path)).foregroundStyle(Ember.tertiary).lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 0)
                            }
                            .font(.system(size: 13))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Ember.sidebar))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: 460)
            }
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
        .onAppear { recent = Project.recent }
    }

    private func tidy(_ path: String) -> String {
        let home: String = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }
}

/// The Code chat's folder and git branch, above the message box. Before the first message it can be changed.
struct ProjectChip: View {
    @Environment(ChatStore.self) private var store
    let path: String
    let canChange: Bool
    @State private var branch: String?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "folder.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(Ember.accent)
            Text(Project.name(path)).foregroundStyle(Ember.text)
            if let branch {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 9, weight: .semibold)).foregroundStyle(Ember.secondary)
                Text(branch).foregroundStyle(Ember.secondary)
            }
            if canChange {
                Button("Change…") {
                    if let p = chooseProjectFolder() { store.setProject(p) }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Ember.tertiary)
            } else {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                } label: {
                    Image(systemName: "arrow.up.forward").font(.system(size: 8, weight: .bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Ember.tertiary)
                .help("Show in Finder")
            }
        }
        .font(.system(size: 11.5, weight: .medium))
        .lineLimit(1)
        .padding(.horizontal, 12)
        .frame(height: 26)
        .background(Capsule().fill(Ember.accent.opacity(0.12)))
        .overlay(Capsule().strokeBorder(Ember.accent.opacity(0.3)))
        .help("Code mode on \(path)")
        .task(id: path) { branch = await Project.git(path)?.branch }
    }
}
