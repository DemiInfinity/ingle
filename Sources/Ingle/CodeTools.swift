import Foundation

/// Code mode's coding tools: find_files, search_code, edit_file, get_problems and repo_map. Offered only in a
/// Code chat (`Conversation.codeFolder`). Names, arguments and output match the VS Code extension
/// (Extensions/vscode/src/tools/files.ts and repomap.ts) — keep them in step; task 33b's code intelligence
/// builds on these as its fallback.
enum CodeTools {
    private static func prop(_ d: String) -> [String: Any] { ["type": "string", "description": d] }

    static let names: Set<String> = ["find_files", "search_code", "edit_file", "get_problems", "repo_map"]
    /// The ones that only read (no approval inside the project, and helpers may use them).
    static let readOnlyNames: Set<String> = ["find_files", "search_code", "repo_map"]

    static let definitions: [[String: Any]] = [
        MacTools.tool("repo_map", "Outline of the project: files and their key functions, classes and exports, most relevant first. Use it to find where things live before reading files. Optional focus (words about what you need) and folder.",
                      ["focus": prop("What you are looking for, e.g. \"invoice totals\" or \"auth middleware\""),
                       "folder": prop("Only show this folder (relative to the project)")], required: []),
        MacTools.tool("find_files", "Find files in the project by name pattern, e.g. \"*.tsx\", \"src/**/*.test.ts\" or \"**/Invoice*\".",
                      ["glob": prop("Glob pattern")], required: ["glob"]),
        MacTools.tool("search_code", "Search the project's files for text (plain text, not case-sensitive). Returns path:line: text. Optionally limit to a glob like \"**/*.ts\".",
                      ["query": prop("Text to look for"), "glob": prop("Optional file pattern")], required: ["query"]),
        MacTools.tool("get_problems", "Run the project's check command (its tests, build or lint) and get the errors and warnings, for one file or the whole project if no path. The user approves.",
                      ["path": prop("Optional file path")], required: []),
        MacTools.tool("edit_file", "Change a file by replacing one exact piece of text. old_text must match the file exactly once (copy it from read_file, without line numbers); keep it small but unique. The user approves.",
                      ["path": prop("File path"), "old_text": prop("The exact text to replace"), "new_text": prop("The text to put in its place")],
                      required: ["path", "old_text", "new_text"]),
    ]

    static var readOnlyDefinitions: [[String: Any]] {
        definitions.filter { readOnlyNames.contains(ToolSelectionName.of($0)) }
    }

    // MARK: Before approval

    /// Code mode: fills in what a call will really do before it's shown for approval. get_problems gets the
    /// check command (a command's then_run first, else the one detected from the path, as Effort does) in
    /// `command` and `cwd` — set here, never taken from the model, so the card and the session scope show
    /// exactly what will run.
    static func prepare(_ call: ToolCall, folder: String?, commands: [IngleCommand]) -> ToolCall {
        guard let folder, call.name == "get_problems" else { return call }
        var c = call
        let path: String = Project.standard(Project.resolve(call.arg("path"), in: folder))
        c.arguments["path"] = call.arg("path").trimmingCharacters(in: .whitespaces).isEmpty ? "" : path
        if let run = commands.compactMap(\.thenRun).first {
            c.arguments["command"] = run
            c.arguments["cwd"] = folder
        } else if let check = EffortLevel.detectCheckCommand(from: path, stopAt: Project.standard(folder)) {
            c.arguments["command"] = check.command
            c.arguments["cwd"] = check.dir
        } else {
            c.arguments["command"] = ""
            c.arguments["cwd"] = ""
        }
        c.raw = try? JSONSerialization.data(withJSONObject: c.arguments)
        return c
    }

    static func describe(_ call: ToolCall) -> MacTools.Info? {
        switch call.name {
        case "repo_map":
            let parts: [String] = [call.arg("focus"), call.arg("folder")].filter { !$0.isEmpty }
            return MacTools.Info(title: "Map the project", detail: parts.isEmpty ? "whole project" : parts.joined(separator: " · "), icon: "map")
        case "find_files": return MacTools.Info(title: "Find files", detail: call.arg("glob"), icon: "magnifyingglass")
        case "search_code":
            let glob: String = call.arg("glob")
            return MacTools.Info(title: "Search the code", detail: call.arg("query") + (glob.isEmpty ? "" : " in \(glob)"), icon: "text.magnifyingglass")
        case "get_problems":
            let command: String = call.arg("command")
            let path: String = call.arg("path")
            let target: String = path.isEmpty ? "(whole project)" : path
            if command.isEmpty { return MacTools.Info(title: "Check problems", detail: target, icon: "exclamationmark.triangle") }
            return MacTools.Info(title: "Check problems", detail: "cd \(call.arg("cwd")) && \(command)", icon: "exclamationmark.triangle")
        case "edit_file": return MacTools.Info(title: "Edit a file", detail: call.arg("path"), icon: "pencil")
        default: return nil
        }
    }

    // MARK: Running

    /// Runs one of the code tools for the Code chat on `folder`. File work happens off the main thread.
    /// `run` is the run this call belongs to: edit_file snapshots the file for Undo this run first (see Checkpoints).
    static func run(_ call: ToolCall, folder: String, run: Checkpoints.Run? = nil) async -> String {
        let root: String = Project.standard(folder)
        switch call.name {
        case "get_problems": return await problems(call, root: root)
        default:
            return await Task.detached(priority: .userInitiated) { () -> String in
                switch call.name {
                case "repo_map": return repoMap(call, root: root)
                case "find_files": return findFiles(call.arg("glob"), root: root)
                case "search_code": return searchCode(call.arg("query"), glob: call.arg("glob"), root: root)
                case "edit_file": return editFile(call, root: root, run: run)
                default: return "Unknown tool \(call.name)."
                }
            }.value
        }
    }

    /// Paths shown relative to the project when inside it, else with ~ for the home folder. Same as tidy() in VS Code.
    static func tidy(_ abs: String, root: String) -> String {
        let r: String = Project.standard(root)
        let p: String = Project.standard(abs)
        if p.hasPrefix(r + "/") { return String(p.dropFirst(r.count + 1)) }
        let home: String = FileManager.default.homeDirectoryForCurrentUser.path
        if p == home { return "~" }
        return p.hasPrefix(home + "/") ? "~" + p.dropFirst(home.count) : p
    }

    // MARK: repo_map

    private static func repoMap(_ call: ToolCall, root: String) -> String {
        let folder: String = call.arg("folder").trimmingCharacters(in: .whitespaces)
        var under: String? = nil
        if !folder.isEmpty {
            let u: String = Project.standard(Project.resolve(folder, in: root))
            if !(u == root || u.hasPrefix(root + "/")) { return "That folder is outside the project." }
            under = u
        }
        let map: String = RepoMap.build(root: root, query: call.arg("focus"), under: under, budgetChars: 16_000)
        return map.isEmpty ? "No code files found there." : map
    }

    // MARK: find_files

    static func normaliseGlob(_ g: String) -> String {
        var glob: String = g.trimmingCharacters(in: .whitespacesAndNewlines)
        if glob.hasPrefix("./") { glob = String(glob.dropFirst(2)) }
        if glob.isEmpty { return "**/*" }
        if !glob.contains("/") && !glob.hasPrefix("**") { glob = "**/" + glob }
        return glob
    }

    static func findFiles(_ rawGlob: String, root: String) -> String {
        let glob: String = normaliseGlob(rawGlob)
        guard let re = Glob.regex(glob) else { return "That pattern didn't work: it isn't a valid glob." }
        let names: [String] = CodeFiles.list(root, limit: 50_000).filter { Glob.matches(re, $0) }.sorted()
        if names.isEmpty { return "No files match \(glob)." }
        return names.prefix(200).joined(separator: "\n") + (names.count > 200 ? "\n…(more than 200 — narrow the pattern)" : "")
    }

    // MARK: search_code

    /// `git grep` in a git repository (tracked and untracked files, .gitignore respected), `grep -rn` otherwise.
    /// Plain text, not case-sensitive, binary files skipped, at most 100 matches. Same output as VS Code.
    static func searchCode(_ query: String, glob rawGlob: String, root: String) -> String {
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Give me some text to search for." }
        let hasGlob: Bool = !rawGlob.trimmingCharacters(in: .whitespaces).isEmpty
        let glob: String = hasGlob ? normaliseGlob(rawGlob) : "**/*"
        guard let re = Glob.regex(glob) else { return "Search failed: that glob isn't valid." }
        let output: Data
        if CodeFiles.isGitRepo(root) {
            var args: [String] = ["-C", root, "grep", "-n", "-I", "-i", "-F", "-z", "--untracked", "--no-color", "-e", query]
            if hasGlob { args += ["--", ":(glob)" + glob] }
            output = CodeFiles.capture("/usr/bin/git", args, cwd: root)
        } else {
            var args: [String] = ["-r", "-n", "-I", "-i", "-F", "--null"]
            for d in CodeFiles.excludedDirs { args.append("--exclude-dir=" + d) }
            args += ["-e", query, "."]
            output = CodeFiles.capture("/usr/bin/grep", args, cwd: root)
        }
        // Each line: path NUL line-number ":" text (git grep -z also puts NUL after the number; handle both).
        struct Hit { let path: String; let line: Int; let text: String }
        var hits: [Hit] = []
        for raw in String(decoding: output, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true) {
            let parts = raw.split(separator: "\0", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
            guard parts.count >= 2 else { continue }
            var path: String = parts[0]
            if path.hasPrefix("./") { path = String(path.dropFirst(2)) }
            let lineNo: Int
            let text: String
            if parts.count == 3 {
                guard let n = Int(parts[1]) else { continue }
                lineNo = n; text = parts[2]
            } else {
                guard let colon = parts[1].firstIndex(of: ":"), let n = Int(parts[1][..<colon]) else { continue }
                lineNo = n; text = String(parts[1][parts[1].index(after: colon)...])
            }
            if CodeFiles.isExcluded(path) || !Glob.matches(re, path) { continue }
            hits.append(Hit(path: path, line: lineNo, text: text))
        }
        hits.sort { $0.path != $1.path ? $0.path < $1.path : $0.line < $1.line }
        if hits.isEmpty { return "No matches for “\(query)”\(glob != "**/*" ? " in \(glob)" : "")." }
        let shown: [String] = hits.prefix(100).map { h in
            var line: String = jsTrim(h.text.hasSuffix("\r") ? String(h.text.dropLast()) : h.text)
            if line.count > 200 { line = String(line.prefix(200)) + "…" }
            return "\(h.path):\(h.line): \(line)"
        }
        return shown.joined(separator: "\n") + (hits.count > 100 ? "\n…(stopped at 100 matches — narrow the search or add a glob)" : "")
    }

    private static func jsTrim(_ s: String) -> String {
        let u: [UInt16] = Array(s.utf16)
        var a = 0, b = u.count
        while a < b && EditMatch.isJSSpace(u[a]) { a += 1 }
        while b > a && EditMatch.isJSSpace(u[b - 1]) { b -= 1 }
        return String(decoding: u[a..<b], as: UTF16.self)
    }

    // MARK: edit_file

    struct Proposal { let abs: String; let original: String; let proposed: String; let note: String }

    /// What an edit_file call would change, or the message for the model when it can't. Doesn't write anything.
    static func propose(_ call: ToolCall, root: String) -> Result<Proposal, ProposalError> {
        let raw: String = call.arg("path")
        if raw.trimmingCharacters(in: .whitespaces).isEmpty { return .failure(ProposalError("Give me the path of the file.")) }
        let abs: String = Project.standard(Project.resolve(raw, in: root))
        let shown: String = tidy(abs, root: root)
        if Project.isFolder(abs) { return .failure(ProposalError("\(shown) is a folder.")) }
        guard FileManager.default.fileExists(atPath: abs) else {
            return .failure(ProposalError("There's no file at \(shown). Use write_file to create it."))
        }
        guard let data = FileManager.default.contents(atPath: abs), let original = String(data: data, encoding: .utf8) else {
            return .failure(ProposalError("Couldn't read \(shown) as text."))
        }
        let oldText: String = call.arg("old_text")
        let newText: String = call.arg("new_text")
        if oldText.isEmpty {
            return .failure(ProposalError("old_text is empty. Give the exact text to replace (read the file first), or use write_file for a new file."))
        }
        if Array(oldText.utf16) == Array(newText.utf16) {
            return .failure(ProposalError("old_text and new_text are the same, so there is nothing to change."))
        }
        switch EditMatch.plan(original, old: oldText, new: newText) {
        case .many(let count):
            return .failure(ProposalError("old_text appears \(count) times in \(shown). Include a few more surrounding lines so it matches exactly once."))
        case .none(let nearest):
            let tail: String = nearest.isEmpty
                ? " Read the file again and copy the text exactly (without line numbers)."
                : " The closest lines are:\n\(nearest)\nRead the file again and copy the text exactly (without line numbers)."
            return .failure(ProposalError("old_text wasn't found in \(shown)." + tail))
        case .ok(let start, let end, let replacement, let tolerant):
            let proposed: String = EditMatch.apply(original, start: start, end: end, replacement: replacement)
            return .success(Proposal(abs: abs, original: original, proposed: proposed,
                                     note: tolerant ? " (matched ignoring line endings / trailing spaces)" : ""))
        }
    }

    struct ProposalError: Error { let message: String; init(_ m: String) { message = m } }

    private static func editFile(_ call: ToolCall, root: String, run: Checkpoints.Run?) -> String {
        switch propose(call, root: root) {
        case .failure(let e): return e.message
        case .success(let p):
            let shown: String = tidy(p.abs, root: root)
            // Keep the original for Undo this run before the first change in this run.
            let note: String = Checkpoints.snapshot(path: p.abs, run: run).map { " " + $0 } ?? ""
            // Written in place (not replaced), so the file keeps its permissions.
            guard let handle = FileHandle(forWritingAtPath: p.abs) else { return "Couldn't edit the file: \(shown) can't be opened for writing." }
            do {
                try handle.truncate(atOffset: 0)
                try handle.write(contentsOf: Data(p.proposed.utf8))
                try handle.close()
            } catch {
                try? handle.close()
                return "Couldn't edit the file: \(error.localizedDescription)"
            }
            let s = LineDiff.stats(p.original, p.proposed)
            return "Edited \(shown): −\(s.removed) +\(s.added) lines\(p.note)." + note
        }
    }

    /// The diff for the approval card: edit_file's change, or what write_file would do to an existing file.
    /// nil when there's nothing to compare (a new file, or an edit that won't apply).
    struct Preview: Equatable { let name: String; let original: String; let proposed: String }

    static func preview(_ call: ToolCall, folder: String?) -> Preview? {
        switch call.name {
        case "edit_file":
            guard let folder, case .success(let p) = propose(call, root: Project.standard(folder)) else { return nil }
            return Preview(name: tidy(p.abs, root: folder), original: p.original, proposed: p.proposed)
        case "write_file":
            let abs: String = Project.standard(call.arg("path"))
            guard !Project.isFolder(abs), let data = FileManager.default.contents(atPath: abs),
                  let original = String(data: data, encoding: .utf8) else { return nil }
            let name: String = folder.map { tidy(abs, root: $0) } ?? abs
            return Preview(name: name, original: original, proposed: call.arg("content"))
        default:
            return nil
        }
    }

    // MARK: get_problems

    private static func problems(_ call: ToolCall, root: String) async -> String {
        let command: String = call.arg("command")
        let cwd: String = call.arg("cwd")
        if command.isEmpty {
            return "No check command found for this project (looked for a package.json test or lint script, Package.swift, Cargo.toml, go.mod, a Makefile test target or pytest). Use run_command to run its checks."
        }
        let result: CommandRunner.Result = await CommandRunner.run("/bin/zsh", ["-lc", command], cwd: cwd)
        guard let code = result.exitCode else { return result.text }
        let rows: [Diagnostics.Row] = Diagnostics.parse(result.output, cwd: cwd)
        let path: String = call.arg("path")
        let fileOnly: Bool = !path.isEmpty && !Project.isFolder(path)
        let scoped: [Diagnostics.Row] = fileOnly ? rows.filter { Project.standard($0.file) == Project.standard(path) } : rows
        let from: String = " (from `\(command)`)"
        if scoped.isEmpty {
            if code != 0 && rows.isEmpty {
                let lines: [Substring] = result.output.split(separator: "\n", omittingEmptySubsequences: false)
                var tail: String = lines.suffix(60).joined(separator: "\n")
                if tail.count > 4000 { tail = "…" + String(tail.suffix(4000)) }
                return "`\(command)` failed (exit code \(code)) without file:line errors. The end of its output:\n\(tail)"
            }
            if fileOnly {
                let elsewhere: String = rows.isEmpty ? "" : " (\(rows.count) elsewhere in the project)"
                return "No errors or warnings in \(tidy(path, root: root))\(elsewhere)\(from)."
            }
            return "No errors or warnings in the project\(from)."
        }
        let sorted: [Diagnostics.Row] = scoped.filter(\.error) + scoped.filter { !$0.error }
        let errors: Int = scoped.filter(\.error).count
        let warnings: Int = scoped.count - errors
        let head: String = "\(errors) error\(errors == 1 ? "" : "s"), \(warnings) warning\(warnings == 1 ? "" : "s")\(from)"
        let body: [String] = sorted.prefix(50).map { r in
            "\(tidy(r.file, root: root)):\(r.line):\(r.column): \(r.error ? "error" : "warning"): \(r.message)"
        }
        return head + "\n" + body.joined(separator: "\n") + (sorted.count > 50 ? "\n…and \(sorted.count - 50) more" : "")
    }
}

/// Reads file:line errors out of compiler, linter and test output (Swift/clang/gcc, TypeScript, ESLint unix,
/// Go, Rust). Anything else falls back to the end of the output.
enum Diagnostics {
    struct Row: Equatable { let file: String; let line: Int; let column: Int; let error: Bool; let message: String }

    private static let colon = try? NSRegularExpression(pattern: #"^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.*)$"#)
    private static let paren = try? NSRegularExpression(pattern: #"^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(.*)$"#)
    private static let goLine = try? NSRegularExpression(pattern: #"^(\S+\.go):(\d+):(\d+):\s+(.*)$"#)
    private static let rustHead = try? NSRegularExpression(pattern: #"^(error|warning)(?:\[\w+\])?:\s*(.*)$"#)
    private static let rustAt = try? NSRegularExpression(pattern: #"^\s*-->\s*(.+?):(\d+):(\d+)"#)

    private static func groups(_ re: NSRegularExpression?, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = re?.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    static func parse(_ output: String, cwd: String) -> [Row] {
        var rows: [Row] = []
        var rust: (error: Bool, message: String)? = nil
        func abs(_ f: String) -> String {
            let t = f.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("/") ? t : (cwd as NSString).appendingPathComponent(t)
        }
        func add(_ r: Row) { if !rows.contains(r) { rows.append(r) } }
        for raw in output.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(raw)
            if let g = groups(colon, line) {
                add(Row(file: abs(g[1]), line: Int(g[2]) ?? 1, column: Int(g[3]) ?? 1, error: g[4] != "warning", message: g[5]))
            } else if let g = groups(paren, line) {
                add(Row(file: abs(g[1]), line: Int(g[2]) ?? 1, column: Int(g[3]) ?? 1, error: g[4] == "error", message: g[5]))
            } else if let g = groups(rustHead, line) {
                rust = (g[1] == "error", g[2])
            } else if let g = groups(rustAt, line), let r = rust {
                add(Row(file: abs(g[1]), line: Int(g[2]) ?? 1, column: Int(g[3]) ?? 1, error: r.error, message: r.message))
                rust = nil
            } else if let g = groups(goLine, line) {
                add(Row(file: abs(g[1]), line: Int(g[2]) ?? 1, column: Int(g[3]) ?? 1, error: true, message: g[4]))
            }
        }
        return rows
    }
}

/// The project's files: `git ls-files` (tracked + untracked, .gitignore respected) in a repository, else a walk.
/// Build and dependency folders are always skipped (same list as EXCLUDE_GLOB in files.ts).
enum CodeFiles {
    static let excludedDirs: [String] = ["node_modules", ".git", "dist", "build", "out", ".next", "Pods", "DerivedData"]

    static func isExcluded(_ rel: String) -> Bool {
        let parts = rel.split(separator: "/").dropLast()
        return parts.contains { excludedDirs.contains(String($0)) }
    }

    static func isGitRepo(_ root: String) -> Bool {
        String(decoding: capture("/usr/bin/git", ["-C", root, "rev-parse", "--is-inside-work-tree"], cwd: root), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    /// Relative paths of the project's files, at most `limit`.
    static func list(_ root: String, limit: Int) -> [String] {
        let fm = FileManager.default
        var out: [String] = []
        if isGitRepo(root) {
            let data = capture("/usr/bin/git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd: root)
            for p in String(decoding: data, as: UTF8.self).split(separator: "\0") {
                let rel = String(p)
                if isExcluded(rel) { continue }
                var dir: ObjCBool = false
                guard fm.fileExists(atPath: (root as NSString).appendingPathComponent(rel), isDirectory: &dir), !dir.boolValue else { continue }
                out.append(rel)
                if out.count >= limit { break }
            }
            return out
        }
        guard let walker = fm.enumerator(atPath: root) else { return [] }
        let skip: Set<String> = Set(excludedDirs + [".build", "__pycache__", ".venv", ".turbo", ".cache"])
        while let rel = walker.nextObject() as? String {
            let name = (rel as NSString).lastPathComponent
            if walker.fileAttributes?[.type] as? FileAttributeType == .typeDirectory {
                if skip.contains(name) { walker.skipDescendants() }
                continue
            }
            if name == ".DS_Store" { continue }
            out.append(rel)
            if out.count >= limit { break }
        }
        return out
    }

    /// Absolute paths with uncommitted changes (for ranking the repo map).
    static func gitChanged(_ root: String) -> Set<String> {
        let data = capture("/usr/bin/git", ["-C", root, "status", "--porcelain"], cwd: root)
        var changed: Set<String> = []
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") where line.count > 3 {
            let p = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces).components(separatedBy: " -> ").last ?? ""
            let clean = p.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            if !clean.isEmpty { changed.insert(URL(fileURLWithPath: root).appendingPathComponent(clean).standardizedFileURL.path) }
        }
        return changed
    }

    /// Runs a program and returns its standard output (at most `cap` bytes; it's stopped after that or 20 seconds).
    static func capture(_ exe: String, _ args: [String], cwd: String, cap: Int = 4_000_000) -> Data {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.standardInput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        let pipe = Pipe()
        p.standardOutput = pipe
        do { try p.run() } catch { return Data() }
        let deadline = Date().addingTimeInterval(20)
        var data = Data()
        let h = pipe.fileHandleForReading
        while true {
            let chunk = h.availableData
            if chunk.isEmpty { break }
            data.append(chunk)
            if data.count >= cap || Date() > deadline { p.terminate(); break }
        }
        p.waitUntilExit()
        return data
    }
}

/// Glob patterns as VS Code reads them: `**` any folders, `*` and `?` within a name, `{a,b}`, `[abc]`.
enum Glob {
    static func regex(_ glob: String) -> NSRegularExpression? {
        var re = "^"
        let c: [Character] = Array(glob)
        var i = 0
        var braces = 0
        while i < c.count {
            let ch = c[i]
            switch ch {
            case "*":
                if i + 1 < c.count && c[i + 1] == "*" {
                    let atStart: Bool = i == 0 || c[i - 1] == "/"
                    if atStart && i + 2 < c.count && c[i + 2] == "/" { re += "(?:.*/)?"; i += 3; continue }
                    if atStart && i + 2 == c.count { re += ".*"; i += 2; continue }
                    re += ".*"; i += 2; continue
                }
                re += "[^/]*"
            case "?": re += "[^/]"
            case "{": braces += 1; re += "(?:"
            case "}" where braces > 0: braces -= 1; re += ")"
            case "," where braces > 0: re += "|"
            case "[":
                guard let close = c[(i + 1)...].firstIndex(of: "]") else { re += "\\["; break }
                var body = String(c[(i + 1)..<close])
                if body.hasPrefix("!") { body = "^" + body.dropFirst() }
                re += "[" + body.replacingOccurrences(of: "\\", with: "\\\\") + "]"
                i = close
            default:
                re += NSRegularExpression.escapedPattern(for: String(ch))
            }
            i += 1
        }
        if braces != 0 { return nil }
        return try? NSRegularExpression(pattern: re + "$")
    }

    static func matches(_ re: NSRegularExpression, _ path: String) -> Bool {
        re.firstMatch(in: path, range: NSRange(location: 0, length: (path as NSString).length)) != nil
    }
}

/// The tool name in a definition (ToolSelection.name is @MainActor; this isn't).
enum ToolSelectionName {
    static func of(_ def: [String: Any]) -> String { (def["function"] as? [String: Any])?["name"] as? String ?? "" }
}
