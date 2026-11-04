import Foundation
import AppKit

/// Commands — the obedience layer. Rules and skills are advice; a command is checked by Ingle itself:
/// required tools are always offered, banned tools are blocked, and the assistant can't finish a request
/// until it has done what the command demands. Stored in ~/.ingle/commands (shared with VS Code).
struct IngleCommand: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String
    let when: [String]          // trigger phrases; empty = always
    let mustUse: [String]       // "tool", "mcp:server", "mcp:server/tool", "skill:name"
    let neverUse: [String]      // tool names
    let thenRun: String?        // must run a command containing this after changing files
    let enabled: Bool
    let body: String
    let file: URL

    var always: Bool { when.isEmpty }

    func applies(to text: String) -> Bool {
        guard enabled else { return false }
        if always { return true }
        let t = text.lowercased()
        return when.contains { t.contains($0) }
    }

    /// Plain-words requirements for the prompt.
    var requirementLines: [String] {
        var out: [String] = []
        for r in mustUse {
            if r.hasPrefix("skill:") { out.append("Follow the skill \"\(r.dropFirst(6))\" (it's loaded below).") }
            else if r.hasPrefix("mcp:") {
                let parts = r.dropFirst(4).split(separator: "/", maxSplits: 1).map(String.init)
                if parts.count == 2 { out.append("You MUST use the \(parts[1]) tool of the \(parts[0]) MCP server (mcp_call with server \"\(parts[0])\", tool \"\(parts[1])\") before you finish.") }
                else { out.append("You MUST use the \(parts.first ?? "") MCP server (mcp_tools, then mcp_call with server \"\(parts.first ?? "")\") before you finish.") }
            } else { out.append("You MUST use \(r) before you finish.") }
        }
        for n in neverUse { out.append("Never use \(n).") }
        if let thenRun { out.append("After changing any file you MUST run: \(thenRun)") }
        return out
    }
}

enum CommandStore {
    static var folder: URL { IngleHome.url.appendingPathComponent("commands", isDirectory: true) }

    static func all(project: String? = nil) -> [IngleCommand] {
        var list = load(folder, prefix: "")
        if let project {
            list += load(URL(fileURLWithPath: project).appendingPathComponent(".ingle/commands", isDirectory: true), prefix: "project/")
        }
        return list
    }

    static func active(for text: String, project: String?) -> [IngleCommand] {
        all(project: project).filter { $0.applies(to: text) }
    }

    private static func list(_ value: String?) -> [String] {
        (value ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
    }

    private static func load(_ dir: URL, prefix: String) -> [IngleCommand] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        return files.filter { $0.pathExtension.lowercased() == "md" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { url in
                guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
                let meta = SkillStore.frontmatter(text)
                let when = list(meta["when"])
                let thenRun = meta["then_run"]?.trimmingCharacters(in: .whitespaces)
                return IngleCommand(
                    name: prefix + (meta["name"] ?? url.deletingPathExtension().lastPathComponent),
                    description: meta["description"] ?? "",
                    when: when == ["always"] ? [] : when,
                    mustUse: list(meta["must_use"]),
                    neverUse: list(meta["never_use"]),
                    thenRun: (thenRun?.isEmpty ?? true) ? nil : thenRun,
                    enabled: !["false", "no", "0", "off"].contains((meta["enabled"] ?? "true").lowercased()),
                    body: RuleStore.stripFrontmatter(text).trimmingCharacters(in: .whitespacesAndNewlines),
                    file: url)
            }
    }

    /// The block placed straight after the persona.
    static func promptBlock(_ commands: [IngleCommand]) -> String? {
        guard !commands.isEmpty else { return nil }
        var lines = ["## COMMANDS — you must obey these (Ingle checks, and will make you redo work that ignores them)"]
        for c in commands {
            lines.append("### \(c.name)" + (c.description.isEmpty ? "" : " — \(c.description)"))
            lines += c.requirementLines.map { "- " + $0 }
            if !c.body.isEmpty { lines.append(c.body) }
        }
        return lines.joined(separator: "\n")
    }

    static func indexSection(project: String?) -> String? {
        let list = all(project: project).filter(\.enabled)
        guard !list.isEmpty else { return nil }
        var lines = ["## Commands (enforced by Ingle — they appear in full when they apply)"]
        for c in list { lines.append("- \(c.name): \(c.description) (when: \(c.always ? "always" : c.when.joined(separator: ", ")))") }
        return lines.joined(separator: "\n")
    }

    static func setEnabled(_ c: IngleCommand, _ on: Bool) {
        guard var text = try? String(contentsOf: c.file, encoding: .utf8) else { return }
        if let r = text.range(of: #"(?m)^enabled:.*$"#, options: .regularExpression) {
            text.replaceSubrange(r, with: "enabled: \(on)")
        } else if text.hasPrefix("---\n") {
            text.insert(contentsOf: "enabled: \(on)\n", at: text.index(text.startIndex, offsetBy: 4))
        }
        try? text.write(to: c.file, atomically: true, encoding: .utf8)
    }

    static func openFolder() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }

    // MARK: Creating

    static func create(_ call: ToolCall) -> String {
        let slug = MemoryStore.slug(call.arg("name"))
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("\(slug).md")
        if FileManager.default.fileExists(atPath: file.path) && call.arg("replace").lowercased() != "true" {
            return "A command called \(slug) already exists. Call command_create again with replace set to true to overwrite it."
        }
        do {
            try fileText(call).write(to: file, atomically: true, encoding: .utf8)
            return "Created the command \(slug). Ingle will enforce it from now on."
        } catch {
            return "Couldn't save the command: \(error.localizedDescription)"
        }
    }

    static func fileText(_ call: ToolCall) -> String {
        func one(_ s: String) -> String { s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) }
        var lines = ["---", "description: \(one(call.arg("description")))", "when: \(one(call.arg("when")).isEmpty ? "always" : one(call.arg("when")))"]
        if !call.arg("must_use").isEmpty { lines.append("must_use: \(one(call.arg("must_use")))") }
        if !call.arg("never_use").isEmpty { lines.append("never_use: \(one(call.arg("never_use")))") }
        if !call.arg("then_run").isEmpty { lines.append("then_run: \(one(call.arg("then_run")))") }
        lines += ["enabled: true", "---", "", call.arg("instructions").trimmingCharacters(in: .whitespacesAndNewlines)]
        return lines.joined(separator: "\n") + "\n"
    }

    static let toolDefinition: [String: Any] = [
        "type": "function",
        "function": [
            "name": "command_create",
            "description": "Create a command — a rule Ingle ENFORCES, not just advises: e.g. always use a certain MCP server or tool for some kind of task, never use a tool, or always run something after editing. Use when the user says 'always', 'must', 'never' or asks for a command. The user approves it.",
            "parameters": [
                "type": "object",
                "properties": [
                    "name": MacTools.prop("Short name, e.g. components-via-figma"),
                    "description": MacTools.prop("One line saying what it enforces"),
                    "when": MacTools.prop("Comma-separated trigger words that appear in requests it applies to, e.g. \"component, components, ui\" — or \"always\""),
                    "must_use": MacTools.prop("Comma-separated: tool names, mcp:server, mcp:server/tool, or skill:name"),
                    "never_use": MacTools.prop("Comma-separated tool names that must not be used"),
                    "then_run": MacTools.prop("A command that must be run after any file change, e.g. npm run lint"),
                    "instructions": MacTools.prop("Any extra instructions, in plain words"),
                    "replace": ["type": "boolean", "description": "Overwrite an existing command with this name"],
                ],
                "required": ["name", "description", "when"],
            ],
        ],
    ]
}

/// Tracks, for one request, whether active commands have been obeyed.
struct CommandTracker {
    let commands: [IngleCommand]
    private(set) var calls: [ToolCall] = []
    private var changedSinceRun: [String: Bool] = [:]   // command name → a file changed after its then_run last ran
    var nudges: [String: Int] = [:]

    init(_ commands: [IngleCommand]) { self.commands = commands }

    var blocked: Set<String> { Set(commands.flatMap(\.neverUse)) }

    func blockingCommand(for tool: String) -> IngleCommand? {
        commands.first { $0.neverUse.contains(tool.lowercased()) }
    }

    mutating func record(_ call: ToolCall, succeeded: Bool) {
        guard succeeded else { return }
        calls.append(call)
        for c in commands {
            guard let run = c.thenRun?.lowercased() else { continue }
            if call.name == "write_file" { changedSinceRun[c.name] = true }
            if call.name == "run_command", call.arg("command").lowercased().contains(run) { changedSinceRun[c.name] = false }
        }
    }

    private func satisfied(_ req: String) -> Bool {
        if req.hasPrefix("skill:") { return true }   // attached automatically
        if req.hasPrefix("mcp:") {
            let parts = req.dropFirst(4).split(separator: "/", maxSplits: 1).map { String($0) }
            // Only actually using the server counts (mcp_call), not just looking at it.
            return calls.contains { c in
                guard c.name == "mcp_call", c.arg("server").lowercased() == parts.first else { return false }
                return parts.count < 2 || c.arg("tool").lowercased() == parts[1]
            }
        }
        return calls.contains { $0.name.lowercased() == req }
    }

    /// What's still owed before the request may finish, per command.
    func unmet() -> [(IngleCommand, String)] {
        var out: [(IngleCommand, String)] = []
        for c in commands {
            if let missing = c.mustUse.first(where: { !satisfied($0) }) {
                let what = missing.hasPrefix("mcp:") ? "use the \(missing.dropFirst(4)) MCP server (mcp_call)" : "use \(missing)"
                out.append((c, what))
            } else if let run = c.thenRun, changedSinceRun[c.name] == true {
                out.append((c, "run `\(run)` after your file changes"))
            }
        }
        return out
    }

    /// Tool names that must be offered this request.
    var requiredTools: Set<String> {
        var out = Set<String>()
        for r in commands.flatMap(\.mustUse) {
            if r.hasPrefix("mcp:") { out.insert("mcp_tools"); out.insert("mcp_call") }
            else if !r.hasPrefix("skill:") { out.insert(r) }
        }
        if commands.contains(where: { $0.thenRun != nil }) { out.insert("run_command") }
        return out
    }
}
