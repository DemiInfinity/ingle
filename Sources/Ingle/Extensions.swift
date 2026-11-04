import Foundation
import AppKit

/// Everything you might edit by hand lives in ~/.ingle, like ~/.claude and ~/.cursor:
///   ~/.ingle/mcp.json   MCP servers (same format as Claude Desktop and Cursor)
///   ~/.ingle/skills/    one folder per skill, each with a SKILL.md
///   ~/.ingle/rules.md   rules every assistant follows
enum IngleHome {
    static var url: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ingle", isDirectory: true) }
    static var mcp: URL { url.appendingPathComponent("mcp.json") }
    static var skills: URL { url.appendingPathComponent("skills", isDirectory: true) }
    static var rules: URL { url.appendingPathComponent("rules.md") }   // old single file, migrated
    static var rulesFolder: URL { url.appendingPathComponent("rules", isDirectory: true) }

    static func ensure() {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    /// One-time move from where earlier builds kept these files.
    static func migrate() {
        let fm = FileManager.default
        let old = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Ingle", isDirectory: true)
        ensure()
        let oldMCP = old.appendingPathComponent("mcp.json")
        if fm.fileExists(atPath: oldMCP.path), !fm.fileExists(atPath: mcp.path) { try? fm.moveItem(at: oldMCP, to: mcp) }
        let oldSkills = old.appendingPathComponent("Skills", isDirectory: true)
        if fm.fileExists(atPath: oldSkills.path), !fm.fileExists(atPath: skills.path) { try? fm.moveItem(at: oldSkills, to: skills) }
        if !fm.fileExists(atPath: rules.path), let saved = Prefs.d.string(forKey: Prefs.K.rules), !saved.isEmpty {
            writeRules(saved)
        }
        // rules.md → rules/general.md (always on)
        if fm.fileExists(atPath: rules.path) {
            try? fm.createDirectory(at: rulesFolder, withIntermediateDirectories: true)
            let target = rulesFolder.appendingPathComponent("general.md")
            if !fm.fileExists(atPath: target.path) {
                let body = readRules().trimmingCharacters(in: .whitespacesAndNewlines)
                if !body.isEmpty {
                    try? "---\ndescription: General rules\nalways: true\n---\n\n\(body)\n".write(to: target, atomically: true, encoding: .utf8)
                }
            }
            try? fm.removeItem(at: rules)
        }
    }

    static func readRules() -> String {
        (try? String(contentsOf: rules, encoding: .utf8)) ?? ""
    }

    static func writeRules(_ text: String) {
        ensure()
        try? text.write(to: rules, atomically: true, encoding: .utf8)
    }
}

private var ingleSupport: URL { IngleHome.url }

// MARK: - Rules

/// One file per rule in ~/.ingle/rules. Frontmatter: description (when it applies) and always (true/false).
/// Always-on rules go into every chat in full; the rest are listed in the index and loaded with use_rule.
struct Rule: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String
    let always: Bool
    let body: String
    let file: URL
}

enum RuleStore {
    /// Your rules in ~/.ingle/rules, plus the current project's .ingle/rules if your editor reported one.
    static func all(project: String? = nil) -> [Rule] {
        var out = load(IngleHome.rulesFolder, prefix: "")
        if let project {
            let names = Set(out.map(\.name))
            out += load(URL(fileURLWithPath: project).appendingPathComponent(".ingle/rules", isDirectory: true), prefix: "project/")
                .filter { !names.contains($0.name) }
        }
        return out
    }

    private static func load(_ folder: URL, prefix: String) -> [Rule] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return [] }
        return files.filter { $0.pathExtension.lowercased() == "md" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { url in
                guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
                let meta = SkillStore.frontmatter(text)
                let name = prefix + (meta["name"] ?? url.deletingPathExtension().lastPathComponent)
                // No frontmatter at all = a plain rule that always applies.
                let always = meta.isEmpty ? true : ["true", "yes", "1"].contains((meta["always"] ?? "false").lowercased())
                return Rule(name: name, description: meta["description"] ?? "", always: always,
                            body: stripFrontmatter(text), file: url)
            }
    }

    static func stripFrontmatter(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---",
              let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) else {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return lines[(end + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func read(_ name: String, project: String? = nil) -> String {
        let rules = all(project: project)
        guard let r = rules.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
            return "There's no rule called \(name). Rules: \(rules.map(\.name).joined(separator: ", "))."
        }
        return String(r.body.prefix(20_000))
    }

    static func setAlways(_ rule: Rule, _ on: Bool) {
        let desc = rule.description.isEmpty ? rule.name : rule.description
        let text = "---\ndescription: \(desc)\nalways: \(on)\n---\n\n\(rule.body)\n"
        try? text.write(to: rule.file, atomically: true, encoding: .utf8)
    }

    @discardableResult
    static func create() -> URL {
        try? FileManager.default.createDirectory(at: IngleHome.rulesFolder, withIntermediateDirectories: true)
        var n = 1
        var url = IngleHome.rulesFolder.appendingPathComponent("new-rule.md")
        while FileManager.default.fileExists(atPath: url.path) {
            n += 1
            url = IngleHome.rulesFolder.appendingPathComponent("new-rule-\(n).md")
        }
        let template = """
        ---
        description: When this rule applies, e.g. "Writing React components"
        always: false
        ---

        Write the rule here in plain words. Set always: true for rules that apply to every chat.
        """
        try? template.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    static func openFolder() {
        try? FileManager.default.createDirectory(at: IngleHome.rulesFolder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(IngleHome.rulesFolder)
    }

    static let toolDefinition: [String: Any] = MacTools.tool(
        "use_rule", "Load one of the user's rules from the rules index when it applies to what you're doing.",
        ["name": MacTools.prop("The rule's name, exactly as listed")], required: ["name"])
}

// MARK: - Skills

/// A skill is a folder with a SKILL.md: YAML-ish frontmatter (name, description) then instructions.
/// Same layout Claude uses, so existing skills work as they are.
struct Skill: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String
    let folder: URL
}

enum SkillStore {
    static var ingleFolder: URL { IngleHome.skills }
    static var claudeFolder: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/skills", isDirectory: true) }

    static func all() -> [Skill] {
        var roots = [ingleFolder]
        if Prefs.useClaudeSkills { roots.append(claudeFolder) }
        var seen = Set<String>()
        var out: [Skill] = []
        for root in roots {
            guard let items = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { continue }
            for dir in items.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                guard let text = try? String(contentsOf: dir.appendingPathComponent("SKILL.md"), encoding: .utf8) else { continue }
                let meta = frontmatter(text)
                let name = meta["name"] ?? dir.lastPathComponent
                guard !seen.contains(name.lowercased()) else { continue }
                seen.insert(name.lowercased())
                out.append(Skill(name: name, description: meta["description"] ?? "", folder: dir))
            }
        }
        return out
    }

    static func frontmatter(_ text: String) -> [String: String] {
        let lines = text.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else { return [:] }
        var out: [String: String] = [:]
        for line in lines.dropFirst() {
            if line.trimmingCharacters(in: .whitespaces) == "---" { break }
            guard let colon = line.range(of: ":") else { continue }
            let key = line[..<colon.lowerBound].trimmingCharacters(in: .whitespaces)
            var value = line[colon.upperBound...].trimmingCharacters(in: .whitespaces)
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") { value = String(value.dropFirst().dropLast()) }
            if !key.isEmpty { out[key] = value }
        }
        return out
    }

    static func read(_ name: String) -> String {
        let skills = all()
        guard let skill = skills.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
            return "There's no skill called \(name). Available: \(skills.map(\.name).joined(separator: ", "))."
        }
        let body = (try? String(contentsOf: skill.folder.appendingPathComponent("SKILL.md"), encoding: .utf8)) ?? ""
        var out = String(body.prefix(30_000))
        let extras = ((try? FileManager.default.contentsOfDirectory(atPath: skill.folder.path)) ?? [])
            .filter { $0 != "SKILL.md" && !$0.hasPrefix(".") }.sorted()
        if !extras.isEmpty {
            out += "\n\nOther files in this skill (open them with read_file):\n"
            out += extras.map { "- " + skill.folder.appendingPathComponent($0).path }.joined(separator: "\n")
        }
        return out
    }

    static let toolDefinition: [String: Any] = MacTools.tool(
        "use_skill", "Load the full instructions of one of the user's skills. Do this before any task a skill covers.",
        ["name": MacTools.prop("The skill's name, exactly as listed")], required: ["name"])

    static func promptSection(_ skills: [Skill]) -> String? {
        guard !skills.isEmpty else { return nil }
        return "SKILLS: the user has these skills. When a request matches one, call use_skill with its name first, then follow it.\n"
            + skills.map { "- \($0.name): \($0.description)" }.joined(separator: "\n")
    }

    static func openFolder() {
        try? FileManager.default.createDirectory(at: ingleFolder, withIntermediateDirectories: true)
        let example = ingleFolder.appendingPathComponent("example-skill/SKILL.md")
        if (try? FileManager.default.contentsOfDirectory(atPath: ingleFolder.path))?.isEmpty ?? true {
            try? FileManager.default.createDirectory(at: example.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? """
            ---
            name: example-skill
            description: Shows how a skill is written. Use when the user asks how skills work.
            ---

            # Example skill

            Write the steps the assistant should follow here, in plain words.
            Put any templates or reference files next to this SKILL.md.
            """.write(to: example, atomically: true, encoding: .utf8)
        }
        NSWorkspace.shared.open(ingleFolder)
    }
}

// MARK: - MCP

struct MCPServerConfig: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let command: String
    let args: [String]
    let env: [String: String]
}

struct MCPTool: Hashable {
    let server: String
    let name: String
    let description: String
    let schema: Data
    let exposedName: String
}

enum MCPStatus: Equatable {
    case stopped, starting, running(Int), failed(String)
}

enum MCPNames {
    static func exposedName(server: String, tool: String) -> String {
        let raw = "mcp_\(server)_\(tool)"
        let cleaned = String(raw.map { $0.isLetter || $0.isNumber || $0 == "_" ? $0 : "_" })
        return String(cleaned.prefix(64))
    }
}

/// One stdio MCP server: newline-delimited JSON-RPC over the process's stdin/stdout.
actor MCPConnection {
    let config: MCPServerConfig
    private var process: Process?
    private let inPipe = Pipe()
    private let outPipe = Pipe()
    private let errPipe = Pipe()
    private var buffer = Data()
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    /// How long one request may take (code intelligence's first query can wait for a language server's index).
    private let requestTimeout: Duration

    init(_ config: MCPServerConfig, timeout: Duration = .seconds(60)) {
        self.config = config
        self.requestTimeout = timeout
    }

    /// The server's process ID (0 before start), so it can be signalled synchronously when Ingle quits.
    func processID() -> Int32 { process?.processIdentifier ?? 0 }

    func start() async throws -> [MCPTool] {
        let p = Process()
        // A login shell gives the server the same PATH as Terminal (npx, uvx, node…).
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        let line = ([config.command] + config.args).map(Self.quote).joined(separator: " ")
        p.arguments = ["-lc", "exec " + line]
        var env = ProcessInfo.processInfo.environment
        for (k, v) in config.env { env[k] = v }
        p.environment = env
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self else { return }
            Task { await self.receive(data) }
        }
        errPipe.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        p.terminationHandler = { [weak self] _ in
            guard let self else { return }
            Task { await self.failAll("The tool server stopped.") }
        }

        try p.run()
        process = p

        let initParams: [String: Any] = [
            "protocolVersion": "2025-06-18",
            "capabilities": [String: Any](),
            "clientInfo": ["name": "Ingle", "version": "1.0"],
        ]
        _ = try await request("initialize", initParams)
        send(["jsonrpc": "2.0", "method": "notifications/initialized"])

        let data = try await request("tools/list", [:])
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let list = obj?["tools"] as? [[String: Any]] ?? []
        return list.compactMap { t in
            guard let name = t["name"] as? String else { return nil }
            let schema = (t["inputSchema"] as? [String: Any]) ?? ["type": "object", "properties": [String: Any]()]
            return MCPTool(server: config.name, name: name, description: t["description"] as? String ?? "",
                           schema: (try? JSONSerialization.data(withJSONObject: schema)) ?? Data("{}".utf8),
                           exposedName: MCPNames.exposedName(server: config.name, tool: name))
        }
    }

    func call(_ tool: String, arguments: Data?) async throws -> String {
        let args = arguments.flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? [String: Any]()
        let data = try await request("tools/call", ["name": tool, "arguments": args])
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let parts = (obj["content"] as? [[String: Any]] ?? []).compactMap { item -> String? in
            if let text = item["text"] as? String { return text }
            if let type = item["type"] as? String { return "[\(type) content]" }
            return nil
        }
        var out = parts.joined(separator: "\n")
        if out.isEmpty, let structured = obj["structuredContent"],
           let d = try? JSONSerialization.data(withJSONObject: structured, options: [.fragmentsAllowed]) {
            out = String(decoding: d, as: UTF8.self)
        }
        if obj["isError"] as? Bool == true { out = "Tool error: " + out }
        if out.isEmpty { return "(no output)" }
        return out.count > 30_000 ? String(out.prefix(30_000)) + "\n…(truncated)" : out
    }

    func stop() {
        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil
        process?.terminationHandler = nil
        if let p = process, p.isRunning { p.terminate() }
        process = nil
        failAll("Stopped.")
    }

    // MARK: JSON-RPC plumbing

    private func request(_ method: String, _ params: [String: Any]) async throws -> Data {
        let id = nextID
        nextID += 1
        let message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method, "params": params]
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            send(message)
            Task {
                try? await Task.sleep(for: self.requestTimeout)
                self.timeout(id)
            }
        }
    }

    private func timeout(_ id: Int) {
        pending.removeValue(forKey: id)?.resume(throwing: OllamaError.server("The tool server didn’t answer in time."))
    }

    private func failAll(_ message: String) {
        let waiting = pending
        pending.removeAll()
        for (_, c) in waiting { c.resume(throwing: OllamaError.server(message)) }
    }

    private func send(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        try? inPipe.fileHandleForWriting.write(contentsOf: data)
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[buffer.startIndex..<newline])
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !line.isEmpty,
                  let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
            // A request from the server to us (e.g. ping): answer with an empty result.
            if obj["method"] != nil, let id = obj["id"] {
                send(["jsonrpc": "2.0", "id": id, "result": [String: Any]()])
                continue
            }
            guard let id = (obj["id"] as? NSNumber)?.intValue, let c = pending.removeValue(forKey: id) else { continue }
            if let error = obj["error"] as? [String: Any] {
                c.resume(throwing: OllamaError.server(error["message"] as? String ?? "Tool server error"))
            } else {
                let result = obj["result"] ?? [String: Any]()
                c.resume(returning: (try? JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])) ?? Data("{}".utf8))
            }
        }
    }

    private static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

/// Reads ~/.ingle/mcp.json, plus the servers you've set up for Cursor and Claude Code, and runs them.
@MainActor @Observable
final class MCPManager {
    static let shared = MCPManager()

    var servers: [MCPServerConfig] = []
    var status: [String: MCPStatus] = [:]
    var tools: [MCPTool] = []
    var disabledNames: Set<String>

    private var connections: [String: MCPConnection] = [:]

    static var configURL: URL { IngleHome.mcp }

    /// Other apps' MCP configs that Ingle also reads (never writes). Ingle's own file wins on a name clash.
    static var otherSources: [(label: String, url: URL)] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [("Cursor", home.appendingPathComponent(".cursor/mcp.json")),
                ("Claude Code", home.appendingPathComponent(".claude.json"))]
    }

    @ObservationIgnored private var sourceOf: [String: String] = [:]

    func source(of name: String) -> String { sourceOf[name] ?? "Ingle" }
    static var claudeDesktopConfig: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Claude/claude_desktop_config.json")
    }

    init() {
        IngleHome.migrate()
        disabledNames = Set(Prefs.d.stringArray(forKey: Prefs.K.mcpDisabled) ?? [])
        reload()
    }

    func reload() {
        var list = Self.readServers(from: Self.configURL)
        var labels = Dictionary(uniqueKeysWithValues: list.map { ($0.name, "Ingle") })
        for other in Self.otherSources {
            for s in Self.readServers(from: other.url) where labels[s.name] == nil {
                list.append(s)
                labels[s.name] = other.label
            }
        }
        sourceOf = labels
        servers = list
        for name in Array(connections.keys) where !servers.contains(where: { $0.name == name }) { stop(name) }
    }

    static func readMap(_ url: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return obj["mcpServers"] as? [String: Any] ?? [:]
    }

    static func readServers(from url: URL) -> [MCPServerConfig] {
        let map = readMap(url)
        return map.keys.sorted().compactMap { name in
            guard let s = map[name] as? [String: Any], let command = s["command"] as? String else { return nil }
            return MCPServerConfig(name: name, command: command,
                                   args: s["args"] as? [String] ?? [],
                                   env: s["env"] as? [String: String] ?? [:])
        }
    }

    func isEnabled(_ name: String) -> Bool { !disabledNames.contains(name) }

    func setEnabled(_ name: String, _ on: Bool) {
        if on { disabledNames.remove(name) } else { disabledNames.insert(name); stop(name) }
        Prefs.d.set(Array(disabledNames), forKey: Prefs.K.mcpDisabled)
    }

    func ensureStarted() async {
        for s in servers where isEnabled(s.name) && connections[s.name] == nil {
            await start(s)
        }
    }

    func start(_ server: MCPServerConfig) async {
        status[server.name] = .starting
        let connection = MCPConnection(server)
        connections[server.name] = connection
        do {
            let list = try await connection.start()
            tools.removeAll { $0.server == server.name }
            tools += list
            status[server.name] = .running(list.count)
        } catch {
            status[server.name] = .failed(error.localizedDescription)
            connections[server.name] = nil
            await connection.stop()
        }
    }

    func restart(_ name: String) async {
        stop(name)
        if let s = servers.first(where: { $0.name == name }) { await start(s) }
    }

    func stop(_ name: String) {
        if let c = connections.removeValue(forKey: name) { Task { await c.stop() } }
        tools.removeAll { $0.server == name }
        status[name] = .stopped
    }

    func stopAll() {
        for name in Array(connections.keys) { stop(name) }
    }

    var toolDefinitions: [[String: Any]] {
        tools.filter { isEnabled($0.server) }.map { t in
            let schema = (try? JSONSerialization.jsonObject(with: t.schema)) ?? [String: Any]()
            return ["type": "function",
                    "function": ["name": t.exposedName,
                                 "description": "[\(t.server)] \(t.description)",
                                 "parameters": schema]]
        }
    }

    func tool(named exposed: String) -> MCPTool? { tools.first { $0.exposedName == exposed } }

    private func server(named name: String) -> MCPServerConfig? {
        servers.first { $0.name.caseInsensitiveCompare(name.trimmingCharacters(in: .whitespaces)) == .orderedSame }
    }

    /// Start one server if it isn't running. Returns its canonical name, or nil if unavailable.
    private func ready(_ name: String) async -> String? {
        guard let s = server(named: name), isEnabled(s.name) else { return nil }
        if connections[s.name] == nil { await start(s) }
        return connections[s.name] == nil ? nil : s.name
    }

    private var serverList: String {
        servers.filter { isEnabled($0.name) }.map(\.name).joined(separator: ", ")
    }

    func describeTools(server name: String) async -> String {
        guard let canonical = await ready(name) else {
            if case .failed(let message) = status[server(named: name)?.name ?? ""] ?? .stopped {
                return "The \(name) server couldn't start: \(message)"
            }
            return "There's no MCP server called \(name). Servers: \(serverList)."
        }
        let list = tools.filter { $0.server == canonical }
        if list.isEmpty { return "\(canonical) has no tools." }
        return list.map { t in
            var schema = String(decoding: t.schema, as: UTF8.self)
            if schema.count > 700 { schema = String(schema.prefix(700)) + "…" }
            return "- \(t.name): \(t.description)\n  inputs: \(schema)"
        }.joined(separator: "\n")
    }

    func call(server name: String, tool: String, arguments: Data?) async -> String {
        guard let canonical = await ready(name), let c = connections[canonical] else {
            return "There's no running MCP server called \(name). Servers: \(serverList)."
        }
        guard tools.contains(where: { $0.server == canonical && $0.name == tool }) else {
            return "\(canonical) has no tool called \(tool). Use mcp_tools to see its tools."
        }
        do { return try await c.call(tool, arguments: arguments) }
        catch { return "The tool failed: \(error.localizedDescription)" }
    }

    func call(_ call: ToolCall) async -> String {
        guard let t = tool(named: call.name), let c = connections[t.server] else {
            return "That tool isn’t available right now."
        }
        do { return try await c.call(t.name, arguments: call.raw) }
        catch { return "The tool failed: \(error.localizedDescription)" }
    }

    func openConfig() {
        try? FileManager.default.createDirectory(at: ingleSupport, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: Self.configURL.path) {
            let template = """
            {
              "mcpServers": {
                "filesystem": {
                  "command": "npx",
                  "args": ["-y", "@modelcontextprotocol/server-filesystem", "\(FileManager.default.homeDirectoryForCurrentUser.path)/Projects"]
                }
              }
            }
            """
            try? template.write(to: Self.configURL, atomically: true, encoding: .utf8)
        }
        NSWorkspace.shared.open(Self.configURL)
    }

    /// Copies stdio servers from Claude Desktop's config into Ingle's, without overwriting any with the same name.
    func importFromClaudeDesktop() -> String {
        let theirs = Self.readMap(Self.claudeDesktopConfig)
        guard !theirs.isEmpty else { return "No Claude Desktop MCP servers found." }
        var ours = Self.readMap(Self.configURL)
        var added = 0, skipped = 0
        for (name, value) in theirs {
            guard let s = value as? [String: Any], s["command"] != nil else { skipped += 1; continue }
            if ours[name] == nil { ours[name] = s; added += 1 }
        }
        try? FileManager.default.createDirectory(at: ingleSupport, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: ["mcpServers": ours], options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: Self.configURL, options: .atomic)
        }
        reload()
        var note = "Imported \(added) server\(added == 1 ? "" : "s")."
        if skipped > 0 { note += " Skipped \(skipped) remote server\(skipped == 1 ? "" : "s") (only local ones are supported for now)." }
        return note
    }
}
