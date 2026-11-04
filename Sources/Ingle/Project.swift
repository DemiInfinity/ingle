import Foundation

/// Code mode: a chat that belongs to a project folder. `Conversation.codeFolder` is the one place that says
/// "this chat is Code mode on folder X"; everything here works from that folder.
enum Project {
    static let codeMode = "code"

    /// Folder name for chips and the sidebar.
    static func name(_ path: String) -> String { (path as NSString).lastPathComponent }

    static func standard(_ path: String) -> String {
        URL(fileURLWithPath: Prefs.expand(path.trimmingCharacters(in: .whitespaces))).standardizedFileURL.path
    }

    static func isFolder(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
    }

    /// Is `path` the project folder or inside it? Relative paths count as inside (they're resolved against it).
    static func contains(_ folder: String, _ path: String) -> Bool {
        let root: String = standard(folder)
        let p: String = standard(resolve(path, in: folder))
        return p == root || p.hasPrefix(root + "/")
    }

    /// A path the model gave, made absolute: relative paths are inside the project folder.
    static func resolve(_ path: String, in folder: String) -> String {
        let t: String = path.trimmingCharacters(in: .whitespaces)
        if t.isEmpty || t == "." { return folder }
        if t.hasPrefix("/") || t.hasPrefix("~") { return t }
        return (folder as NSString).appendingPathComponent(t)
    }

    /// In Code mode, relative paths and a missing working folder mean the project folder. Applied once to each
    /// call before approval, so the card, the session scope and the tool all see the same absolute path.
    static func prepare(_ call: ToolCall, folder: String?) -> ToolCall {
        guard let folder else { return call }
        var c = call
        switch call.name {
        case "list_files", "read_file", "write_file", "edit_file":
            c.arguments["path"] = resolve(call.arg("path"), in: folder)
        case "run_command":
            c.arguments["cwd"] = resolve(call.arg("cwd"), in: folder)
        default:
            return call
        }
        // `raw` is only used to show and resend the original arguments; keep the resolved ones instead.
        c.raw = try? JSONSerialization.data(withJSONObject: c.arguments)
        return c
    }

    // MARK: Git

    struct Git: Equatable {
        var branch: String?
        /// `git status --short`, trimmed to a few lines.
        var status: String
    }

    /// Branch and short status, or nil when the folder isn't a git repository. Runs off the main thread.
    static func git(_ folder: String) async -> Git? {
        await Task.detached(priority: .userInitiated) { () -> Git? in
            guard let inside = run(["-C", folder, "rev-parse", "--is-inside-work-tree"]), inside == "true" else { return nil }
            let branch: String? = run(["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"])
            let status: String = run(["-C", folder, "status", "--short"]) ?? ""
            var lines: [String] = status.split(separator: "\n").map(String.init)
            let extra: Int = lines.count - 25
            if extra > 0 { lines = Array(lines.prefix(25)) + ["… and \(extra) more"] }
            return Git(branch: branch, status: lines.joined(separator: "\n"))
        }.value
    }

    private static func run(_ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data: Data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Rules files

    /// AGENTS.md / CLAUDE.md / .cursorrules in a project root, the convention Claude Code and Cursor use.
    /// Shared by the editor bridge and Code mode. Same as `projectInstructions` in Extensions/vscode/src/engine/prompt.ts.
    /// (The project's .ingle/rules and .ingle/commands come in through RuleStore and CommandStore.)
    static func instructions(_ folder: String) -> String? {
        var parts: [String] = []
        for name in ["AGENTS.md", "CLAUDE.md", ".cursorrules"] {
            let url = URL(fileURLWithPath: folder).appendingPathComponent(name)
            if let text = try? String(contentsOf: url, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                parts.append("### From \(name)\n" + String(text.prefix(8000)))
            }
        }
        return parts.isEmpty ? nil : "## This project's own rules — follow them\n" + parts.joined(separator: "\n\n")
    }

    /// The Code-mode part of the system prompt: folder, branch, short status, then the project's rules files.
    static func promptSection(_ folder: String, git: Git?) -> String {
        var lines: [String] = ["## The project (Code mode)", "Project folder: \(folder) — relative paths and commands without a folder use it."]
        if let git {
            lines.append("Git branch: \(git.branch ?? "unknown")")
            lines.append(git.status.isEmpty ? "Git status: clean" : "Git status (short):\n" + git.status)
        } else {
            lines.append("Not a git repository.")
        }
        if let rules = instructions(folder) { lines.append(""); lines.append(rules) }
        return lines.joined(separator: "\n")
    }

    // MARK: Recent projects

    static var recent: [String] {
        (Prefs.d.stringArray(forKey: Prefs.K.recentProjects) ?? []).filter(isFolder)
    }

    static func remember(_ folder: String) {
        var list: [String] = Prefs.d.stringArray(forKey: Prefs.K.recentProjects) ?? []
        list.removeAll { $0 == folder }
        list.insert(folder, at: 0)
        Prefs.d.set(Array(list.prefix(8)), forKey: Prefs.K.recentProjects)
    }
}
