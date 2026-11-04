import SwiftUI
import AppKit

// MARK: Git for the Commit button

/// Commit a run's files: find their repository, draft a message from the diff, then `git add` exactly those files and
/// `git commit`. Never pushes. Same as Extensions/vscode/src/tools/gitCommit.ts (tested there).
enum GitCommit {
    struct Out: Sendable { let ok: Bool; let out: String; let err: String }

    static func git(_ cwd: String, _ args: [String], input: String? = nil) async -> Out {
        await Task.detached { () -> Out in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: cwd)
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            let stdin = Pipe()
            p.standardInput = input == nil ? FileHandle.nullDevice : stdin
            do { try p.run() } catch { return Out(ok: false, out: "", err: error.localizedDescription) }
            if let input {
                stdin.fileHandleForWriting.write(Data(input.utf8))
                try? stdin.fileHandleForWriting.close()
            }
            let o: Data = out.fileHandleForReading.readDataToEndOfFile()
            let e: Data = err.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return Out(ok: p.terminationStatus == 0, out: String(decoding: o, as: UTF8.self), err: String(decoding: e, as: UTF8.self))
        }.value
    }

    /// The nearest existing folder for a path (a file the run deleted no longer exists).
    static func existingDir(_ path: String) -> String {
        var d: String = (path as NSString).deletingLastPathComponent
        var n = 0
        while !FileManager.default.fileExists(atPath: d) && n < 64 { d = (d as NSString).deletingLastPathComponent; n += 1 }
        return d
    }

    private static func real(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    }

    /// The one repository holding all these files, or why not.
    static func repo(for files: [String]) async -> Result<String, CommitError> {
        var repos = Set<String>()
        for f in files {
            let r: Out = await git(existingDir(f), ["rev-parse", "--show-toplevel"])
            if !r.ok { return .failure(CommitError("\((f as NSString).lastPathComponent) isn’t in a git repository.")) }
            repos.insert(real(r.out.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        guard repos.count == 1, let repo = repos.first else {
            return .failure(CommitError(repos.isEmpty ? "No files to commit." : "These files are in more than one repository, so commit them yourself."))
        }
        return .success(repo)
    }

    /// Paths relative to the repo (symlinks like /tmp → /private/tmp resolved).
    static func relative(_ repo: String, _ files: [String]) -> [String] {
        files.map { f in
            let dir: String = existingDir(f)
            let tail: String = String(f.dropFirst(dir.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let abs: String = (real(dir) as NSString).appendingPathComponent(tail)
            return abs.hasPrefix(repo + "/") ? String(abs.dropFirst(repo.count + 1)) : abs
        }
    }

    /// The diff of just these files against HEAD (new files whole), capped for the model.
    static func diff(_ repo: String, _ rel: [String], max: Int = 12_000) async -> String {
        var out: String = await git(repo, ["diff", "HEAD", "--"] + rel).out
        for f in rel {
            let tracked: String = await git(repo, ["ls-files", "--", f]).out.trimmingCharacters(in: .whitespacesAndNewlines)
            if tracked.isEmpty, let body = try? String(contentsOfFile: (repo as NSString).appendingPathComponent(f), encoding: .utf8) {
                let plus: String = body.components(separatedBy: "\n").map { "+" + $0 }.joined(separator: "\n")
                out += "\n--- /dev/null\n+++ b/\(f)\n" + String(plus.prefix(4000))
            }
        }
        return out.count > max ? String(out.prefix(max)) + "\n…(diff trimmed)" : out
    }

    static func prompt(_ diff: String) -> String {
        "Write a git commit message for this change. First line: a summary in the imperative, under 60 characters, no full stop. "
            + "Then, only if useful, a blank line and up to three short lines saying why. British English. Reply with the message only — no quotes, no code fences.\n\n"
            + "```diff\n" + diff + "\n```"
    }

    static func clean(_ text: String, fallback files: [String] = []) -> String {
        var t: String = ThinkSplitter.split(text, extra: "").body.trimmingCharacters(in: .whitespacesAndNewlines)
        t = t.replacingOccurrences(of: #"^```[a-zA-Z]*\n?"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\n?```$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(?i)(commit message|message)\s*:\s*"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”").union(.whitespacesAndNewlines))
        // git takes everything up to the first blank line as the subject: keep the summary line on its own.
        if !t.isEmpty || files.isEmpty { return format(t) }
        let names: [String] = files.map { ($0 as NSString).lastPathComponent }
        let more: String = names.count > 3 ? " and \(names.count - 3) more" : ""
        return "Update " + names.prefix(3).joined(separator: ", ") + more
    }

    /// A blank line after the summary (git folds lines without one into the subject). Same as formatMessage in gitCommit.ts.
    static func format(_ text: String) -> String {
        var lines: [String] = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
            .map { $0.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) }
        if lines.count > 1, !lines[1].trimmingCharacters(in: .whitespaces).isEmpty { lines.insert("", at: 1) }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The commands that will run (shown on the approval card).
    static func commandText(_ rel: [String], signOff: Bool) -> String {
        func q(_ s: String) -> String {
            s.range(of: #"^[\w./@-]+$"#, options: .regularExpression) != nil ? s : "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
        }
        let list: String = rel.map(q).joined(separator: " ")
        return "git add -A -- \(list)\ngit commit\(signOff ? " -s" : "") -F <message> -- \(list)"
    }

    /// Stages exactly these files (deletions too) and commits only them. Never pushes. The short hash, or why not.
    static func commit(_ repo: String, _ rel: [String], message: String, signOff: Bool) async -> Result<String, CommitError> {
        let text: String = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if rel.isEmpty { return .failure(CommitError("No files to commit.")) }
        if text.isEmpty { return .failure(CommitError("The commit message is empty.")) }
        // Files the run created and removed again are neither on disk nor in git: leave them out.
        var keep: [String] = []
        for f in rel {
            if FileManager.default.fileExists(atPath: (repo as NSString).appendingPathComponent(f)) {
                keep.append(f)
                continue
            }
            let tracked: Out = await git(repo, ["ls-files", "--error-unmatch", "--", f])
            if tracked.ok { keep.append(f) }
        }
        if keep.isEmpty { return .failure(CommitError("None of these files have changes to commit.")) }
        let add: Out = await git(repo, ["add", "-A", "--"] + keep)
        if !add.ok { return .failure(CommitError("git add failed: " + add.err.trimmingCharacters(in: .whitespacesAndNewlines))) }
        let args: [String] = ["commit"] + (signOff ? ["-s"] : []) + ["-F", "-", "--"] + keep
        let c: Out = await git(repo, args, input: format(text) + "\n")
        if !c.ok {
            let why: String = (c.err + "\n" + c.out).trimmingCharacters(in: .whitespacesAndNewlines)
            if why.range(of: "nothing to commit|no changes added", options: [.regularExpression, .caseInsensitive]) != nil {
                return .failure(CommitError("Nothing to commit: these files already match the last commit."))
            }
            return .failure(CommitError("git commit failed: " + why.components(separatedBy: "\n").prefix(6).joined(separator: "\n")))
        }
        let hash: String = await git(repo, ["rev-parse", "--short", "HEAD"]).out.trimmingCharacters(in: .whitespacesAndNewlines)
        return .success(hash)
    }

    struct CommitError: Error { let message: String; init(_ m: String) { message = m } }
}

// MARK: The store's side

extension ChatStore {
    /// The run's files in their repository, or why they can't be committed.
    func commitTarget(_ messageID: ChatMessage.ID) async -> Result<(repo: String, rel: [String]), GitCommit.CommitError>? {
        guard let i = conversations.firstIndex(where: { $0.messages.contains { $0.id == messageID } }),
              let cp = conversations[i].messages.first(where: { $0.id == messageID })?.checkpoint else { return nil }
        let files: [String] = Checkpoints.summary(Checkpoints.Run(chat: conversations[i].id.uuidString, run: cp.run)).map(\.path)
        if files.isEmpty { return .failure(GitCommit.CommitError("This run has no files to commit.")) }
        switch await GitCommit.repo(for: files) {
        case .failure(let e): return .failure(e)
        case .success(let repo): return .success((repo: repo, rel: GitCommit.relative(repo, files)))
        }
    }

    /// Commit: a message drafted from the diff by the chat's model, for you to edit.
    func draftCommit(_ messageID: ChatMessage.ID) async -> Result<String, GitCommit.CommitError> {
        guard let target = await commitTarget(messageID) else { return .failure(GitCommit.CommitError("That run is gone.")) }
        guard case .success(let t) = target else {
            if case .failure(let e) = target { return .failure(e) }
            return .failure(GitCommit.CommitError("That run is gone."))
        }
        let diff: String = await GitCommit.diff(t.repo, t.rel)
        let model: String = conversations.first(where: { $0.messages.contains { $0.id == messageID } })?.model ?? Prefs.dailyModel
        var text = ""
        do {
            let messages: [[String: Any]] = [["role": "user", "content": GitCommit.prompt(diff)]]
            let ctx: Int = min(Prefs.contextLength(for: model), 16_384)
            let stream = OllamaClient().chat(model: model, messages: messages, tools: nil, think: .off, numCtx: ctx, keepAlive: Prefs.keepAlive)
            for try await chunk in stream { text += chunk.content }
        } catch {
            text = ""
        }
        return .success(GitCommit.clean(text, fallback: t.rel))
    }

    /// Runs `git add` on exactly the run's files and `git commit`, after approval. Never pushes. nil when done, else why not.
    func commitRun(_ messageID: ChatMessage.ID, message: String) async -> String? {
        guard let i = conversations.firstIndex(where: { $0.messages.contains { $0.id == messageID } }) else { return "That run is gone." }
        let chat: Conversation.ID = conversations[i].id
        if streamingID == chat { return "Wait for the reply to finish (or press Stop), then commit." }
        if message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Write a commit message first." }
        guard let target = await commitTarget(messageID) else { return "That run is gone." }
        let t: (repo: String, rel: [String])
        switch target {
        case .failure(let e): return e.message
        case .success(let ok): t = ok
        }
        let signOff: Bool = Prefs.commitSignOff
        let command: String = GitCommit.commandText(t.rel, signOff: signOff)
        let call = ToolCall(name: "git_commit", arguments: ["command": command, "message": message])
        let n: Int = t.rel.count
        let info = MacTools.Info(title: "Commit \(n) file\(n == 1 ? "" : "s") in \((t.repo as NSString).lastPathComponent)",
                                 detail: command + "\n\n" + message.trimmingCharacters(in: .whitespacesAndNewlines), icon: "checkmark.seal")
        guard await requestApproval(chat, call, info) else { return "Not committed." }
        switch await GitCommit.commit(t.repo, t.rel, message: message, signOff: signOff) {
        case .failure(let e): return e.message
        case .success(let hash):
            if let j = index(chat), let k = conversations[j].messages.firstIndex(where: { $0.id == messageID }) {
                conversations[j].messages[k].checkpoint?.committed = hash
            }
            save()
            let summary: String = message.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").first ?? ""
            notice = "Committed \(hash): \(summary)"
            return nil
        }
    }
}

// MARK: The panel

/// Under the last reply of a run that changed files: each file with its diff, Open in editor, Undo this run and
/// (in a git repo) Commit. Built on Checkpoints.changes(run).
struct ChangesPanel: View {
    @Environment(ChatStore.self) private var store
    let chat: Conversation.ID
    let messageID: ChatMessage.ID
    let checkpoint: RunCheckpoint
    let busy: Bool
    /// "Undo this run" (force = "Undo anyway"): nil when done, else why not and whether it can be forced.
    let onUndo: ((Bool) -> (message: String, canForce: Bool)?)?

    private struct FileChange: Identifiable {
        let id: Int
        let path: String
        let action: Checkpoints.Action
        let before: String
        let after: String
        let unified: String
        let added: Int
        let removed: Int
    }

    @State private var open = false
    @State private var files: [FileChange] = []
    @State private var expanded: Set<Int> = []
    @State private var sideBySide: CodeTools.Preview?
    @State private var repo: String?
    @State private var noCommit: String?
    @State private var refusal: (message: String, canForce: Bool)?
    @State private var commitPhase: CommitPhase = .none
    @State private var commitMessage = ""
    @State private var commitError: String?

    private enum CommitPhase { case none, drafting, editing, committing }

    private var count: String { "\(checkpoint.files.count) file\(checkpoint.files.count == 1 ? "" : "s")" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    open.toggle()   // no animation: a changing height inside the chat's LazyVStack draws over its neighbours
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plusminus").font(.system(size: 10, weight: .semibold))
                        Text("Changes · \(count)")
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .font(.system(size: 11.5))
                    .foregroundStyle(Ember.secondary)
                    .padding(.horizontal, 10)
                    .frame(height: 24)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .help("Every file this run changed, with its diff")
                if let hash = checkpoint.committed {
                    tag("checkmark", "Committed \(hash)")
                }
                if checkpoint.undone == true {
                    tag("arrow.uturn.backward", "Run undone · \(count) put back")
                }
            }
            if open { panel }
        }
        .task(id: open) { if open { await load() } }
        .sheet(item: Binding(get: { sideBySide.map(SheetItem.init) }, set: { sideBySide = $0?.preview })) { item in
            SideBySideDiff(preview: item.preview) { sideBySide = nil }
        }
    }

    private struct SheetItem: Identifiable {
        let preview: CodeTools.Preview
        var id: String { preview.name }
    }

    private func tag(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 10, weight: .semibold))
            Text(text)
        }
        .font(.system(size: 11.5))
        .foregroundStyle(Ember.secondary)
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                if files.isEmpty {
                    Text("Loading the diffs…").font(.system(size: 11.5)).foregroundStyle(Ember.secondary)
                }
                ForEach(files) { f in fileRow(f) }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.04)))
            Text("Undo puts these files back. " + Checkpoints.notCovered)
                .font(.system(size: 11))
                .foregroundStyle(Ember.secondary)
            if let refusal {
                warning(refusal.message)
            }
            if let noCommit, checkpoint.committed == nil, checkpoint.undone != true {
                Text("Commit: " + noCommit).font(.system(size: 11)).foregroundStyle(Ember.secondary)
            }
            HStack(spacing: 8) {
                if checkpoint.undone != true {
                    if let refusal, refusal.canForce {
                        Button { undo(force: true) } label: { Label("Undo Anyway", systemImage: "arrow.uturn.backward") }
                    } else {
                        Button { undo(force: false) } label: { Label("Undo This Run", systemImage: "arrow.uturn.backward") }
                            .help("Put back every file this run changed")
                    }
                }
                if repo != nil, checkpoint.committed == nil, checkpoint.undone != true, commitPhase == .none {
                    Button { draft() } label: { Label("Commit…", systemImage: "checkmark.seal") }
                        .buttonStyle(.borderedProminent)
                        .help("Draft a commit message for exactly these files (never pushed)")
                }
            }
            .controlSize(.regular)
            .disabled(busy)
            commitEditor
        }
    }

    @ViewBuilder private var commitEditor: some View {
        switch commitPhase {
        case .none:
            EmptyView()
        case .drafting:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Drafting a commit message…").font(.system(size: 12)).foregroundStyle(Ember.secondary)
            }
        case .editing, .committing:
            VStack(alignment: .leading, spacing: 6) {
                Text("Commit message (only this run’s files\(repo.map { " in " + ($0 as NSString).lastPathComponent } ?? ""); never pushed)")
                    .font(.system(size: 11)).foregroundStyle(Ember.secondary)
                TextEditor(text: $commitMessage)
                    .font(.system(size: 12.5, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(minHeight: 70, maxHeight: 140)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Ember.code))
                    .disabled(commitPhase == .committing)
                if let commitError { warning(commitError) }
                HStack {
                    Button("Cancel") { commitPhase = .none; commitError = nil }
                    Spacer()
                    Button { commit() } label: {
                        Label(commitPhase == .committing ? "Committing…" : "Commit", systemImage: "checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(commitPhase == .committing || busy
                              || commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func warning(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11))
            Text(text).textSelection(.enabled)
        }
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(Ember.warn)
    }

    private func fileRow(_ f: FileChange) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button {
                    if expanded.contains(f.id) { expanded.remove(f.id) } else { expanded.insert(f.id) }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
                            .rotationEffect(.degrees(expanded.contains(f.id) ? 90 : 0))
                        Text(verb(f.action))
                            .foregroundStyle(f.action == .remove ? Ember.accent : Ember.secondary)
                            .frame(width: 56, alignment: .leading)
                        Text((f.path as NSString).abbreviatingWithTildeInPath)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(Ember.text)
                            .lineLimit(1)
                            .truncationMode(.head)
                            .help(f.path)
                        Spacer(minLength: 8)
                        Text("+\(f.added)").foregroundStyle(Color(hex: 0x9BE29B))
                        Text("−\(f.removed)").foregroundStyle(Ember.danger)
                    }
                    .font(.system(size: 11.5))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button { sideBySide = CodeTools.Preview(name: (f.path as NSString).lastPathComponent, original: f.before, proposed: f.after) } label: {
                    Image(systemName: "rectangle.split.2x1").font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Ember.secondary)
                .help("Side by side")
                if f.action != .recreate {
                    Button { ChangesPanel.openInEditor(f.path) } label: {
                        Image(systemName: "arrow.up.forward.app").font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Ember.secondary)
                    .help(ChangesPanel.editorName.map { "Open in \($0)" } ?? "Open in the default app")
                }
            }
            if expanded.contains(f.id) {
                ScrollView([.vertical, .horizontal]) {
                    if f.unified.isEmpty {
                        Text("No text changes (a binary file, or it ended up the same).")
                            .font(.system(size: 11.5)).foregroundStyle(Ember.secondary).padding(10)
                    } else {
                        DiffText(unified: f.unified).padding(10)
                    }
                }
                .defaultScrollAnchor(.topLeading)
                // A fixed height (not a range), so the LazyVStack measures the row correctly.
                .frame(height: min(CGFloat(max(f.unified.components(separatedBy: "\n").count, 2)) * 16 + 20, 300))
                .background(RoundedRectangle(cornerRadius: 8).fill(Ember.code))
            }
        }
    }

    private func verb(_ a: Checkpoints.Action) -> String {
        switch a {
        case .restore: return "Edited"
        case .remove: return "Created"
        case .recreate: return "Deleted"
        }
    }

    private func load() async {
        let run = Checkpoints.Run(chat: chat.uuidString, run: checkpoint.run)
        let actions: [String: Checkpoints.Action] = Dictionary(Checkpoints.summary(run).map { ($0.path, $0.action) }, uniquingKeysWith: { a, _ in a })
        var list: [FileChange] = []
        for (n, c) in Checkpoints.changes(run).enumerated() {
            let before: String = c.before ?? "", after: String = c.after ?? ""
            let name: String = (c.path as NSString).lastPathComponent
            let st: (added: Int, removed: Int) = LineDiff.stats(before, after)
            list.append(FileChange(id: n, path: c.path, action: actions[c.path] ?? .restore, before: before, after: after,
                                   unified: LineDiff.unified(before, after, name: name, maxChars: 20_000),
                                   added: st.added, removed: st.removed))
        }
        files = list
        guard checkpoint.committed == nil, !list.isEmpty else { return }
        switch await GitCommit.repo(for: list.map(\.path)) {
        case .success(let r): repo = r; noCommit = nil
        case .failure(let e): repo = nil; noCommit = e.message
        }
    }

    private func undo(force: Bool) {
        refusal = onUndo?(force)
    }

    private func draft() {
        commitPhase = .drafting
        commitError = nil
        Task {
            switch await store.draftCommit(messageID) {
            case .success(let text): commitMessage = text; commitPhase = .editing
            case .failure(let e): commitError = e.message; commitPhase = .editing
            }
        }
    }

    private func commit() {
        commitPhase = .committing
        commitError = nil
        let text: String = commitMessage
        Task {
            if let why = await store.commitRun(messageID, message: text) {
                commitError = why
                commitPhase = .editing
            } else {
                commitPhase = .none
            }
        }
    }

    // MARK: Open in editor

    /// VS Code if it's installed, otherwise nil (the default app).
    static var editorApp: URL? {
        for id in ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.vscodium"] {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) { return url }
        }
        return nil
    }

    static var editorName: String? {
        editorApp.map { $0.deletingPathExtension().lastPathComponent }
    }

    static func openInEditor(_ path: String) {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { return }
        if let app = editorApp {
            NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(url)
        }
    }
}
