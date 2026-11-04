import Foundation

/// Built-in code intelligence in Code mode (task 33b): outline, definition, references, callers, callees, impact,
/// diagnostics and read_exhaustively from `ingle-code` (Extensions/ingle-code, shipped in
/// Ingle.app/Contents/Resources/ingle-code). One helper process per project, started on first use with Node and
/// spoken to with the MCP client (`MCPConnection`), but its tools are offered as built-in tools: normal names, no
/// mcp_call, no approval (read-only, and the engine refuses paths outside the project). Stopped when the project's
/// last Code chat is deleted, after 10 minutes unused, and when Ingle quits. Without Node the tools fall back to
/// search_code / repo_map and say once that results are approximate.
/// Names, arguments and output: Extensions/ingle-code/TOOLS.md. Same behaviour as codeintel.ts / codeintelCore.ts.
@MainActor
final class CodeIntel {
    static let shared = CodeIntel()

    static let toolNames: Set<String> = ["outline", "definition", "references", "callers", "callees", "impact", "diagnostics", "read_exhaustively"]
    private static let symbolTools: Set<String> = ["definition", "references", "callers", "callees", "impact"]
    private static let idleLimit: TimeInterval = 10 * 60

    // MARK: Definitions (TOOL_SPECS without `format`; symbol, outline's file and diagnostics' paths may be left out)

    private static func prop(_ type: String, _ d: String) -> [String: Any] { ["type": type, "description": d] }
    private static let symbolProp: [String: Any] = prop("string", "A name (approvalScope, MacTools.approvalScope) or a position file:line:col (1-based; col optional). Leave out to use what the user is working on (the selection, or what the uncommitted changes touch).")
    private static let fileHint: [String: Any] = prop("string", "Optional: prefer the definition in this file when the name is defined more than once.")
    private static let page: [String: Any] = ["type": "integer", "minimum": 1, "description": "Page of results (default 1)."]
    private static let depth: [String: Any] = ["type": "integer", "minimum": 1, "maximum": 2, "description": "1 = direct only (default), 2 = one more level."]

    private static func def(_ name: String, _ description: String, _ props: [String: Any], required: [String] = []) -> [String: Any] {
        ["type": "function",
         "function": ["name": name, "description": description,
                      "parameters": ["type": "object", "properties": props, "required": required] as [String: Any]] as [String: Any]]
    }

    static let definitions: [[String: Any]] = [
        def("outline", "Symbols in one file (types, functions, properties) with line ranges.",
            ["file": prop("string", "Path relative to the workspace. Leave out for the open file."), "page": page]),
        def("definition", "Where a symbol is defined.", ["symbol": symbolProp, "file": fileHint, "page": page]),
        def("references", "Every use of a symbol, grouped by file, with a total count. Each result says exact or approximate.",
            ["symbol": symbolProp, "file": fileHint, "page": page]),
        def("callers", "Functions that call this symbol.", ["symbol": symbolProp, "file": fileHint, "depth": depth, "page": page]),
        def("callees", "Functions in this workspace that this symbol calls.", ["symbol": symbolProp, "file": fileHint, "depth": depth, "page": page]),
        def("impact", "Everything a change to this symbol could affect: files that use it, its callers, and the tests that cover those files. Use before changing shared code.",
            ["symbol": symbolProp, "file": fileHint, "page": page]),
        def("diagnostics", "Compiler and type errors without a full build. With no paths, checks files changed since the last commit.",
            ["paths": ["type": "array", "items": ["type": "string"], "description": "Files or folders relative to the workspace. Leave out for the files the user is working on (open, changed, mentioned)."] as [String: Any],
             "page": page]),
        def("read_exhaustively", "Read a huge file or log in chunks with the local model and get a short note for every chunk, so nothing is skipped. Slow: use for files too big to read.",
            ["path": prop("string", "File relative to the workspace."), "question": prop("string", "What to look for."),
             "page": ["type": "integer", "minimum": 1, "description": "Which group of chunks to read (default 1)."] as [String: Any]],
            required: ["path", "question"]),
    ]

    static func describe(_ call: ToolCall) -> MacTools.Info? {
        guard toolNames.contains(call.name) else { return nil }
        let titles: [String: String] = ["outline": "Outline", "definition": "Find the definition", "references": "Find every use",
                                        "callers": "Find callers", "callees": "Find what it calls", "impact": "Check the impact",
                                        "diagnostics": "Check for errors", "read_exhaustively": "Read it all"]
        let icons: [String: String] = ["outline": "list.bullet.indent", "definition": "arrow.right.doc.on.clipboard", "references": "link",
                                       "callers": "arrow.down.right.and.arrow.up.left", "callees": "arrow.up.right", "impact": "waveform.path.ecg",
                                       "diagnostics": "exclamationmark.triangle", "read_exhaustively": "book"]
        var target: String = call.arg("symbol")
        if target.isEmpty { target = call.arg("file") }
        if target.isEmpty { target = call.arg("path") }
        if target.isEmpty { target = paths(call).joined(separator: ", ") }
        if target.isEmpty { target = "what you’re working on" }
        if call.name == "read_exhaustively", !call.arg("question").isEmpty { target += " — " + call.arg("question") }
        return MacTools.Info(title: titles[call.name] ?? call.name, detail: target, icon: icons[call.name] ?? "chevron.left.forwardslash.chevron.right")
    }

    // MARK: Node and the engine

    private static var nodeCache: String?

    /// Node 18 or later: on PATH, in Homebrew's and MacPorts' folders, or in nvm / Volta / asdf / fnm.
    static func node() -> String? {
        if let n = nodeCache, FileManager.default.isExecutableFile(atPath: n) { return n }
        let home: String = FileManager.default.homeDirectoryForCurrentUser.path
        var dirs: [String] = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        dirs += ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", home + "/.volta/bin", home + "/.asdf/shims"]
        dirs += versionDirs(home + "/.nvm/versions/node", suffix: "/bin")
        dirs += versionDirs(home + "/.local/share/fnm/node-versions", suffix: "/installation/bin")
        var seen: Set<String> = []
        for dir in dirs where seen.insert(dir).inserted {
            let path: String = dir + "/node"
            guard FileManager.default.isExecutableFile(atPath: path) else { continue }
            let out: String = String(decoding: CodeFiles.capture(path, ["--version"], cwd: "/"), as: UTF8.self)
            let major: Int = Int(out.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().split(separator: ".").first ?? "") ?? 0
            if major >= 18 { nodeCache = path; return path }
        }
        return nil
    }

    /// Version folders, newest first (v22.1.0 before v20.11.1).
    private static func versionDirs(_ root: String, suffix: String) -> [String] {
        let names: [String] = (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []
        let sorted: [String] = names.sorted { a, b in a.compare(b, options: .numeric) == .orderedDescending }
        return sorted.map { root + "/" + $0 + suffix }
    }

    /// The engine inside the app bundle (copied in by build.sh).
    static var engineScript: String? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let path: String = res.appendingPathComponent("ingle-code/bin/ingle-code").path
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    // MARK: Helpers (one per project)

    private struct Helper {
        let connection: MCPConnection
        let pid: Int32
        var lastUsed: Date
    }

    private var helpers: [String: Helper] = [:]
    private var starting: [String: Task<Helper?, Never>] = [:]
    private var idleTimer: Timer?
    /// Chats that have been told results are approximate without Node (said once per chat).
    private var warnedChats: Set<UUID> = []

    private func helper(for folder: String) async -> Helper? {
        if var h = helpers[folder] {
            h.lastUsed = Date()
            helpers[folder] = h
            return h
        }
        if let pending = starting[folder] { return await pending.value }
        guard let node = Self.node(), let script = Self.engineScript else { return nil }
        let task = Task<Helper?, Never> { @MainActor in
            let config = MCPServerConfig(name: "ingle-code", command: node, args: [script, "--root", folder], env: [:])
            let connection = MCPConnection(config, timeout: .seconds(300))
            do {
                _ = try await connection.start()
                let pid: Int32 = await connection.processID()
                return Helper(connection: connection, pid: pid, lastUsed: Date())
            } catch {
                await connection.stop()
                return nil
            }
        }
        starting[folder] = task
        let h: Helper? = await task.value
        starting[folder] = nil
        if let h { helpers[folder] = h }
        startIdleTimer()
        return h
    }

    private func startIdleTimer() {
        guard idleTimer == nil else { return }
        idleTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { @MainActor in CodeIntel.shared.stopIdle() }
        }
    }

    func stopIdle() {
        let cutoff = Date().addingTimeInterval(-Self.idleLimit)
        for (folder, h) in helpers where h.lastUsed < cutoff { stop(folder: folder) }
        if helpers.isEmpty { idleTimer?.invalidate(); idleTimer = nil }
    }

    /// Stops the project's helper (and its language servers).
    func stop(folder: String) {
        guard let h = helpers.removeValue(forKey: folder) else { return }
        Task { await h.connection.stop() }
    }

    /// When Ingle quits: signal every helper now (it stops its language servers and exits).
    func stopAll() {
        for (_, h) in helpers where h.pid > 0 { kill(h.pid, SIGTERM) }
        for folder in Array(helpers.keys) { stop(folder: folder) }
        idleTimer?.invalidate()
        idleTimer = nil
    }

    /// A Code chat was deleted: stop its project's helper unless another chat still uses the project.
    func chatClosed(folder: String?, stillUsed: Bool) {
        if let folder, !stillUsed { stop(folder: folder) }
    }

    var runningCount: Int { helpers.count }

    /// One tool call on the helper; the text it returns. Retries once if the helper had stopped.
    private func callHelper(_ name: String, _ args: [String: Any], folder: String) async -> String? {
        for _ in 0..<2 {
            guard let h = await helper(for: folder) else { return nil }
            let data: Data? = try? JSONSerialization.data(withJSONObject: args)
            do {
                return try await h.connection.call(name, arguments: data)
            } catch {
                // The process ended (crash, killed): start a fresh one once.
                helpers[folder] = nil
                await h.connection.stop()
            }
        }
        return "Code intelligence stopped unexpectedly. Try again, or use search_code."
    }

    private func json(_ name: String, _ args: [String: Any], folder: String) async -> [String: Any]? {
        var a = args
        a["format"] = "json"
        guard let text = await callHelper(name, a, folder: folder), !text.hasPrefix("Tool error:") else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
    }

    // MARK: Running a tool for the model

    /// Runs one code intelligence tool in a Code chat on `folder`. Missing symbol/file/paths default to the
    /// working set (the VS Code selection when it's this project, files changed in git, files the chat names).
    func run(_ call: ToolCall, folder: String, chat: Conversation) async -> String {
        var args: [String: Any] = Self.arguments(call)
        args["format"] = nil
        let ws = workingSet(folder: folder, chat: chat)
        guard Self.node() != nil, Self.engineScript != nil else { return fallback(call, args: args, folder: folder, chat: chat.id, ws: ws) }

        var note: String = ""
        if Self.symbolTools.contains(call.name), Self.isEmpty(args["symbol"]) {
            if let sel = ws.selection {
                args["symbol"] = sel
                note = "(no symbol named: using the selection, \(sel))\n"
            } else {
                let changed: [String] = await changedSymbols(folder: folder)
                if changed.isEmpty {
                    let files: [String] = ws.files
                    let list: String = files.isEmpty ? "" : "; files you're working on: " + files.prefix(10).joined(separator: ", ")
                    return "Missing argument: symbol. Nothing is selected and the uncommitted changes touch no symbol\(list). Name a symbol, or outline one of those files first."
                }
                var parts: [String] = []
                let targets: [String] = call.name == "impact" ? changed : Array(changed.prefix(1))
                for s in targets {
                    var a = args
                    a["symbol"] = s
                    parts.append(await callHelper(call.name, a, folder: folder) ?? "")
                }
                return "(no symbol named: using what the uncommitted changes touch — \(changed.joined(separator: ", ")))\n" + parts.joined(separator: "\n\n")
            }
        }
        if call.name == "outline", Self.isEmpty(args["file"]) {
            guard let f = ws.activeFile ?? ws.files.first else { return "Missing argument: file (and there is no open or changed file to default to)." }
            args["file"] = f
            note = "(no file named: outlining \(f), from what you're working on)\n"
        }
        if call.name == "diagnostics", Self.isEmpty(args["paths"]), !ws.files.isEmpty {
            args["paths"] = Array(ws.files.prefix(60))
            note = "(no paths named: checking the working set — open, changed and mentioned files)\n"
        }
        guard let text = await callHelper(call.name, args, folder: folder) else {
            return fallback(call, args: args, folder: folder, chat: chat.id, ws: ws)
        }
        return text.hasPrefix("Tool error:") ? String(text.dropFirst("Tool error: ".count)) : note + text
    }

    private static func isEmpty(_ v: Any?) -> Bool {
        if v == nil { return true }
        if let s = v as? String { return s.trimmingCharacters(in: .whitespaces).isEmpty }
        if let a = v as? [Any] { return a.isEmpty }
        return false
    }

    /// The call's arguments as the model sent them (arrays and numbers kept), else the flattened strings.
    static func arguments(_ call: ToolCall) -> [String: Any] {
        if let raw = call.raw, let obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] { return obj }
        return call.arguments
    }

    private static func paths(_ call: ToolCall) -> [String] {
        let a = arguments(call)
        if let list = a["paths"] as? [Any] { return list.map { "\($0)" } }
        if let s = a["paths"] as? String, !s.isEmpty { return [s] }
        return []
    }

    // MARK: Without Node

    private func fallback(_ call: ToolCall, args: [String: Any], folder: String, chat: UUID, ws: WorkingSet) -> String {
        let first: Bool = warnedChats.insert(chat).inserted
        let why: String = Self.engineScript == nil
            ? "Exact code analysis isn't bundled in this build of Ingle"
            : "Exact code analysis needs Node.js, which isn't installed on this Mac"
        let head: String = first
            ? "\(why), so this is an approximate text search. Tell the user once, plainly: results are approximate until Node.js is installed (for example with brew install node), which turns on exact results.\n"
            : "(approximate: text search, \(Self.engineScript == nil ? "code analysis isn't bundled" : "Node.js isn't installed"))\n"
        let symbol: String = (args["symbol"] as? String ?? ws.selection ?? "").replacingOccurrences(of: "()", with: "")
        switch call.name {
        case "outline":
            let file: String = args["file"] as? String ?? ws.activeFile ?? ""
            let map: String = RepoMap.build(root: Project.standard(folder), query: file, under: nil, budgetChars: 8_000)
            return head + (map.isEmpty ? "No code files found." : map)
        case "diagnostics":
            return head + "There's no approximate check for errors: use get_problems, which runs the project's check command."
        case "read_exhaustively":
            return head + "Reading in chunks needs Node.js too. Read the file in parts with read_file instead, and say which parts you read."
        default:
            guard !symbol.isEmpty else { return head + "Name a symbol to search for." }
            let name: String = symbol.split(separator: ".").last.map(String.init) ?? symbol
            return head + CodeTools.searchCode(name, glob: "", root: folder)
        }
    }

    // MARK: Working set

    struct WorkingSet {
        var selection: String?
        var activeFile: String?
        var changed: [String] = []
        var mentioned: [String] = []
        var files: [String] {
            var out: [String] = []
            for f in [activeFile].compactMap({ $0 }) + changed + mentioned where !out.contains(f) { out.append(f) }
            return out
        }
    }

    /// What the user is working on in this project: VS Code's file and selection (when it's this project), files
    /// changed in git, and source files the chat's messages name.
    func workingSet(folder: String, chat: Conversation) -> WorkingSet {
        var ws = WorkingSet()
        let root: String = Project.standard(folder)
        if let ctx = EditorBridge.shared.freshContext, let w = ctx.workspace, Project.standard(w) == root {
            if let f = ctx.file, Project.contains(root, f) { ws.activeFile = Self.relative(f, root: root) }
            ws.selection = Self.symbolFromSelection(ctx.selection)
        }
        ws.changed = CodeFiles.gitChanged(root).map { Self.relative($0, root: root) }.sorted()
        let text: String = chat.messages.filter { $0.isRealUser }.suffix(10).map(\.content).joined(separator: "\n")
        ws.mentioned = Self.mentionedFiles(text) { rel in
            var dir: ObjCBool = false
            let full: String = (root as NSString).appendingPathComponent(rel)
            return !rel.contains("..") && FileManager.default.fileExists(atPath: full, isDirectory: &dir) && !dir.boolValue
        }
        return ws
    }

    private static func relative(_ abs: String, root: String) -> String {
        let a: String = Project.standard(abs)
        return a.hasPrefix(root + "/") ? String(a.dropFirst(root.count + 1)) : a
    }

    /// A selection that names one symbol (`runSubAgent`, `MacTools.approvalScope`, `foo()`). Same as symbolFromSelection in TS.
    static func symbolFromSelection(_ sel: String?) -> String? {
        var s: String = (sel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasSuffix("()") { s = String(s.dropLast(2)) }
        guard !s.isEmpty, s.count <= 120,
              s.range(of: #"^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$"#, options: .regularExpression) != nil else { return nil }
        return s
    }

    /// Source files a message names that exist. Same pattern as mentionedFiles in TS.
    static func mentionedFiles(_ text: String, exists: (String) -> Bool) -> [String] {
        let pattern = #"(?:^|[\s`'"(\[])((?:[\w.@-]+/)*[\w.@-]+\.(?:swift|tsx?|mts|cts|jsx?|mjs|cjs|py|pyi|go|rs))(?=$|[\s`'"),:\]])"#
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else { return [] }
        var out: [String] = []
        let ns = text as NSString
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var p: String = ns.substring(with: m.range(at: 1))
            if p.hasPrefix("./") { p = String(p.dropFirst(2)) }
            if !out.contains(p), exists(p) { out.append(p) }
        }
        return out
    }

    /// Changed line ranges per file from `git diff -U0` (new side, 1-based, inclusive). Same as parseDiffHunks in TS.
    static func parseDiffHunks(_ diff: String) -> [(file: String, ranges: [ClosedRange<Int>])] {
        var out: [(file: String, ranges: [ClosedRange<Int>])] = []
        var file: String?
        let re = try? NSRegularExpression(pattern: #"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@"#)
        for line in diff.components(separatedBy: "\n") {
            if line.hasPrefix("+++ ") {
                let p: String = String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                file = p == "/dev/null" ? nil : (p.hasPrefix("b/") ? String(p.dropFirst(2)) : p)
                if let f = file { out.append((file: f, ranges: [])) }
                continue
            }
            guard file != nil, let re else { continue }
            let ns = line as NSString
            guard let m = re.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { continue }
            let start: Int = Int(ns.substring(with: m.range(at: 1))) ?? 1
            let count: Int = m.range(at: 2).location == NSNotFound ? 1 : (Int(ns.substring(with: m.range(at: 2))) ?? 1)
            let range: ClosedRange<Int> = count == 0 ? max(1, start)...max(1, start) : start...(start + count - 1)
            out[out.count - 1].ranges.append(range)
        }
        return out.filter { !$0.ranges.isEmpty }
    }

    private static let codeKinds: Set<String> = ["function", "method", "constructor", "class", "struct", "interface", "enum", "protocol", "property", "field", "variable", "constant", "type"]

    /// The innermost symbols whose bodies contain the changed lines. Same as symbolsInRanges in TS.
    static func symbolsInRanges(_ items: [[String: Any]], _ ranges: [ClosedRange<Int>]) -> [String] {
        var out: [String] = []
        for r in ranges {
            let hits: [[String: Any]] = items.filter { s in
                let kind: String = s["kind"] as? String ?? ""
                let a: Int = s["startLine"] as? Int ?? 0
                let b: Int = s["endLine"] as? Int ?? 0
                return codeKinds.contains(kind) && a <= r.upperBound && b >= r.lowerBound
            }
            let inner: [String: Any]? = hits.min { x, y in
                let lx: Int = (x["endLine"] as? Int ?? 0) - (x["startLine"] as? Int ?? 0)
                let ly: Int = (y["endLine"] as? Int ?? 0) - (y["startLine"] as? Int ?? 0)
                return lx < ly
            }
            guard let s = inner else { continue }
            let raw: String = s["name"] as? String ?? ""
            let base: String = raw.components(separatedBy: "(").first ?? raw
            let kind: String = s["kind"] as? String ?? ""
            var name: String = base
            if let c = s["container"] as? String, ["method", "property", "field", "constructor"].contains(kind) { name = c + "." + base }
            if !name.isEmpty, !out.contains(name) { out.append(name) }
        }
        return out
    }

    /// Symbols touched by the uncommitted changes (git diff + each file's outline), at most `limit`.
    func changedSymbols(folder: String, limit: Int = 3) async -> [String] {
        let diffData: Data = await Task.detached { CodeFiles.capture("/usr/bin/git", ["-C", folder, "diff", "-U0", "--no-color", "HEAD"], cwd: folder) }.value
        let hunks = Self.parseDiffHunks(String(decoding: diffData, as: UTF8.self))
        var out: [String] = []
        for h in hunks where out.count < limit {
            guard h.file.range(of: #"\.(swift|tsx?|mts|cts|jsx?|mjs|cjs|py|pyi|go|rs)$"#, options: .regularExpression) != nil else { continue }
            guard let o = await json("outline", ["file": h.file, "page": 1], folder: folder) else { continue }
            let items: [[String: Any]] = o["items"] as? [[String: Any]] ?? []
            for s in Self.symbolsInRanges(items, h.ranges) where !out.contains(s) && out.count < limit { out.append(s) }
        }
        return out
    }

    // MARK: Structured impact (task 34)

    /// Every place a change to `symbol` could affect: each real use (comment/string-only text matches and the
    /// definitions left out) and each caller's call lines, as project-relative paths and 1-based lines. Sorted,
    /// no duplicates. Empty without Node. Same as impactLocations() in codeintelCore.ts.
    func impact(_ symbol: String, folder: String, file: String? = nil) async -> [(path: String, line: Int)] {
        var seen: Set<String> = []
        var out: [(path: String, line: Int)] = []
        func add(_ p: String, _ line: Int) {
            if seen.insert("\(p):\(line)").inserted { out.append((path: p, line: line)) }
        }
        var base: [String: Any] = ["symbol": symbol]
        if let file { base["file"] = file }
        for tool in ["references", "callers"] {
            var pageNo = 1
            var pages = 1
            repeat {
                var a = base
                a["page"] = pageNo
                guard let r = await json(tool, a, folder: folder) else { break }
                pages = min(r["pages"] as? Int ?? 1, 50)
                for item in r["items"] as? [[String: Any]] ?? [] {
                    let p: String = item["file"] as? String ?? ""
                    if tool == "references" {
                        let approx: Bool = (item["exactness"] as? String) == "approximate"
                        if (item["inComment"] as? Bool == true && approx) || item["definition"] as? Bool == true { continue }
                        if let line = item["line"] as? Int { add(p, line) }
                    } else {
                        for line in item["callLines"] as? [Int] ?? [] { add(p, line) }
                    }
                }
                pageNo += 1
            } while pageNo <= pages
        }
        out.sort { a, b in a.path == b.path ? a.line < b.line : a.path < b.path }
        return out
    }
}
