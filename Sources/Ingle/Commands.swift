import Foundation
import AppKit

/// Commands — the obedience layer. Rules and skills are advice; a command is checked by Ingle itself:
/// required tools are always offered, banned tools are blocked, and the assistant can't finish a request
/// until it has done what the command demands. Stored in ~/.ingle/commands (shared with VS Code).
struct IngleCommand: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String
    let when: [String]          // trigger phrases; empty = always (only "always" on its own, or nothing)
    let mustUse: [String]       // "tool", "mcp:server", "mcp:server/tool", "skill:name"
    let neverUse: [String]      // tool names, "mcp:server", "mcp:server/tool"
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

    /// Every tool that changes files: any of these makes a then_run owed. Add new file-changing tools here
    /// (VS Code's list is FILE_CHANGING_TOOLS in commands.ts).
    static let fileChangingTools: Set<String> = ["write_file", "edit_file"]

    static func all(project: String? = nil) -> [IngleCommand] { loadAll(project: project).commands }

    /// Yours, then the project's (prefixed project/). A command whose final name is already taken is skipped:
    /// the first one wins, yours before the project's. Same as loadAllCommands in commands.ts.
    static func loadAll(project: String?) -> (commands: [IngleCommand], skipped: [IngleCommand]) {
        var found = load(folder, prefix: "")
        if let project {
            found += load(URL(fileURLWithPath: project).appendingPathComponent(".ingle/commands", isDirectory: true), prefix: "project/")
        }
        var seen = Set<String>()
        var commands: [IngleCommand] = []
        var skipped: [IngleCommand] = []
        for c in found {
            let key: String = c.name.lowercased()
            if seen.contains(key) { skipped.append(c); continue }
            seen.insert(key)
            commands.append(c)
        }
        return (commands, skipped)
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
        let loaded = loadAll(project: project)
        let list = loaded.commands.filter(\.enabled)
        guard !list.isEmpty || !loaded.skipped.isEmpty else { return nil }
        var lines = ["## Commands (enforced by Ingle — they appear in full when they apply)"]
        for c in list { lines.append("- \(c.name): \(c.description) (when: \(c.always ? "always" : c.when.joined(separator: ", ")))") }
        for c in loaded.skipped { lines.append("- Skipped \(c.file.path): another command is already called \(c.name).") }
        return lines.joined(separator: "\n")
    }

    // MARK: Nudges

    /// Start of every nudge Ingle sends the model.
    static let nudgePrefix = "Ingle: before you finish"
    static let maxNudges = 2

    /// One nudge listing everything owed. Reusable by any check that sends the model back (e.g. "verify after
    /// editing"). Same wording as nudgeText in commands.ts.
    static func nudgeText(_ items: [String]) -> String {
        let list: String = items.map { "- " + $0 }.joined(separator: "\n")
        return "\(nudgePrefix), you still need to:\n\(list)\nDo that now, then finish your answer."
    }

    /// The ⚠ chip for a command that wasn't obeyed ("" reason = still owed after the nudges).
    static func ignoredChip(_ name: String, _ reason: String) -> String {
        "⚠ didn’t follow \(name)" + (reason.isEmpty ? "" : " (\(reason))")
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

    /// Why command_create must refuse this call, or nil. Advice-only commands (no must_use, never_use or then_run)
    /// are refused — that's a rule. Hand-written ones still load. Same as commandCreateRefusal in commands.ts.
    static func refusal(_ call: ToolCall) -> String? {
        func blank(_ k: String) -> Bool { call.arg(k).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if blank("name") { return "A command needs a name." }
        if blank("must_use") && blank("never_use") && blank("then_run") {
            return "A command needs at least one of must_use, never_use or then_run — otherwise it’s just advice (use rule_create for that)."
        }
        return nil
    }

    static func create(_ call: ToolCall) -> String {
        if let refusal = refusal(call) { return refusal }
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
                    "never_use": MacTools.prop("Comma-separated tool names, mcp:server or mcp:server/tool that must not be used"),
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
    /// Commands given up on: name → reason ("" = still owed after the nudges).
    private(set) var givenUp: [String: String] = [:]
    private var checkedAvailability = false

    init(_ commands: [IngleCommand]) { self.commands = commands }

    /// never_use items that are plain tool names (removed from the tool list). mcp: items are blocked per call.
    var blocked: Set<String> { Set(commands.flatMap(\.neverUse).filter { !$0.hasPrefix("mcp:") }) }

    /// "server" and optional "tool" of an mcp: item.
    private static func mcpParts(_ item: String) -> [String] {
        item.dropFirst(4).split(separator: "/", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func callMatches(_ item: String, _ call: ToolCall) -> Bool {
        guard item.hasPrefix("mcp:") else { return call.name.lowercased() == item }
        guard call.name == "mcp_call" else { return false }
        let parts = mcpParts(item)
        guard let server = parts.first, !server.isEmpty else { return false }
        let callServer: String = call.arg("server").trimmingCharacters(in: .whitespaces).lowercased()
        if callServer != server { return false }
        if parts.count < 2 { return true }
        return call.arg("tool").trimmingCharacters(in: .whitespaces).lowercased() == parts[1]
    }

    /// The command (and its never_use item) that bans this call, if any. Handles tool names and mcp:server[/tool].
    func blockingCommand(for call: ToolCall) -> (command: IngleCommand, item: String)? {
        for c in commands {
            if let item = c.neverUse.first(where: { Self.callMatches($0, call) }) { return (c, item) }
        }
        return nil
    }

    /// Same wording as blockedMessage in commands.ts.
    static func blockedMessage(_ c: IngleCommand, _ item: String) -> String {
        let usable: [String] = c.mustUse.filter { !$0.hasPrefix("skill:") }.map(requirementWords)
        let instead: String = usable.isEmpty ? "" : " Instead, " + usable.joined(separator: ", and ") + "."
        return "Blocked by the command \"\(c.name)\": you must not use \(item).\(instead)"
    }

    static func requirementWords(_ r: String) -> String {
        guard r.hasPrefix("mcp:") else { return r.hasPrefix("skill:") ? "follow the \(r.dropFirst(6)) skill" : "use \(r)" }
        let parts = mcpParts(r)
        let server: String = parts.first ?? ""
        if parts.count == 2 { return "use the \(server) MCP's \(parts[1]) tool (mcp_call with server \"\(server)\" and tool \"\(parts[1])\")" }
        return "use the \(server) MCP (mcp_call with server \"\(server)\")"
    }

    /// The tool a requirement needs offered ("" for skills, which Ingle attaches itself).
    static func toolNeeded(_ r: String) -> String {
        if r.hasPrefix("skill:") { return "" }
        return r.hasPrefix("mcp:") ? "mcp_call" : r
    }

    mutating func record(_ call: ToolCall, succeeded: Bool) {
        guard succeeded else { return }
        calls.append(call)
        for c in commands {
            guard let run = c.thenRun?.lowercased() else { continue }
            if CommandStore.fileChangingTools.contains(call.name) { changedSinceRun[c.name] = true }
            if call.name == "run_command", call.arg("command").lowercased().contains(run) { changedSinceRun[c.name] = false }
        }
    }

    private func satisfied(_ req: String) -> Bool {
        if req.hasPrefix("skill:") { return true }   // attached automatically
        // Only actually using an MCP server counts (mcp_call), not just looking at it.
        return calls.contains { Self.callMatches(req, $0) }
    }

    /// What a command still owes before the request may finish, in words.
    func owed(_ c: IngleCommand) -> [String] {
        var out: [String] = c.mustUse.filter { !satisfied($0) }.map(Self.requirementWords)
        if let run = c.thenRun, changedSinceRun[c.name] == true {
            out.append("run `\(run)` with run_command (files changed since it last ran)")
        }
        return out
    }

    /// Call once with the tools on offer (after required ones were added from everything available). A command
    /// whose required tool still isn't there (e.g. web_search with Web off) is given up on now: ⚠, no nudges.
    mutating func checkAvailability(offered: Set<String>) {
        guard !checkedAvailability else { return }
        checkedAvailability = true
        let have = Set(offered.map { $0.lowercased() })
        for c in commands {
            var reason: String? = nil
            for r in c.mustUse {
                let needs = Self.toolNeeded(r)
                if !needs.isEmpty && !have.contains(needs) { reason = "\(needs) isn’t available"; break }
            }
            if reason == nil, c.thenRun != nil, !have.contains("run_command") { reason = "run_command isn’t available" }
            if let reason { givenUp[c.name] = reason }
        }
    }

    /// The completion check. Returns one nudge for everything owed, or nil to finish (then see `chips`).
    /// Each command gets at most CommandStore.maxNudges. Same as completionCheck in commands.ts.
    mutating func completionCheck() -> String? {
        var items: [String] = []
        for c in commands where givenUp[c.name] == nil {
            let missing = owed(c)
            if missing.isEmpty { continue }
            let n: Int = nudges[c.name] ?? 0
            if n >= CommandStore.maxNudges { givenUp[c.name] = ""; continue }
            nudges[c.name] = n + 1
            items.append("the command \"\(c.name)\": " + missing.joined(separator: ", and "))
        }
        return items.isEmpty ? nil : CommandStore.nudgeText(items)
    }

    /// ⚠ chips for commands that weren't obeyed.
    var chips: [String] {
        commands.compactMap { c in givenUp[c.name].map { CommandStore.ignoredChip(c.name, $0) } }
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
