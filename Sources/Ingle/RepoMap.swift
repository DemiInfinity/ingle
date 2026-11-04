import Foundation

/// Repo map: a compact outline of the project — files and their key symbols — ranked by relevance to the
/// current request, so a small local model knows where things are without reading every file.
/// A port of Extensions/vscode/src/tools/repomap.ts (per-language patterns, no tree-sitter) — keep in step.
/// The Mac has no editor, so there's no active file, open tabs or imports to follow; git changes and the
/// request's words rank it.
enum RepoMap {
    static let codePattern = #"\.(tsx?|jsx?|mjs|cjs|vue|svelte|swift|cs|py|go|rs|kt|kts|java|rb|php|dart|c|cc|cpp|h|hpp|m|mm|sql|prisma|graphql|gql|sh)$"#
    static let skipPattern = #"\.(min|bundle)\.js$|\.d\.ts$|/(vendor|coverage|\.venv|venv|target|bin|obj)/"#
    static let maxFiles = 4000
    static let maxBytes = 300_000
    static let maxSymbols = 14

    struct FileInfo {
        let abs: String
        let rel: String
        let mtime: Date
        let symbols: [String]
    }

    /// Symbols by file, reused while the file's modification time is unchanged.
    private final class Cache: @unchecked Sendable {
        let lock = NSLock()
        var files: [String: FileInfo] = [:]
        func get(_ k: String) -> FileInfo? { lock.lock(); defer { lock.unlock() }; return files[k] }
        func set(_ k: String, _ v: FileInfo) { lock.lock(); files[k] = v; lock.unlock() }
    }
    private static let cache = Cache()

    // MARK: Symbol extraction

    private static let keywords: Set<String> = ["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "new", "typeof", "await", "super", "constructor", "guard", "init", "self", "this", "when", "match", "with", "using", "lock", "foreach", "sizeof"]

    private static func grab(_ text: String, _ pattern: String, _ options: NSRegularExpression.Options = [.anchorsMatchLines],
                             _ out: inout [String], _ fmt: ([String]) -> String?) {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return }
        let ns = text as NSString
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if out.count >= 60 { break }
            var groups: [String] = []
            for i in 0..<m.numberOfRanges {
                let r = m.range(at: i)
                groups.append(r.location == NSNotFound ? "" : ns.substring(with: r))
            }
            if let s = fmt(groups), !s.isEmpty, !out.contains(s) { out.append(s) }
        }
    }

    static func extractSymbols(ext: String, text: String) -> [String] {
        var out: [String] = []
        let e = ext.lowercased()
        let m: NSRegularExpression.Options = [.anchorsMatchLines]
        func isOne(_ list: [String]) -> Bool { list.contains(e) }
        if isOne([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]) {
            grab(text, #"^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)"#, m, &out) { g in
                g[1].hasPrefix("function") ? "\(g[2])()" : (["const", "let", "var"].contains(g[1]) ? g[2] : "\(g[1]) \(g[2])")
            }
            grab(text, #"^class\s+([A-Za-z_$][\w$]*)"#, m, &out) { "class \($0[1])" }
            // Public methods inside classes (2–4 spaces in); private ones are implementation detail.
            grab(text, #"^ {2,4}(?!private |protected |#)(?:public |static |async |readonly |override |get |set )*([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*(?::[^{\n]+)?\{"#, m, &out) { g in
                keywords.contains(g[1]) ? nil : ".\(g[1])()"
            }
            grab(text, #"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"#, m, &out) { "\($0[1])()" }
            grab(text, #"^\s*(?:export\s+)?(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)"#, m, &out) { "\($0[1].uppercased()) \($0[2])" }
        } else if e == ".swift" {
            // Types first, then non-private functions.
            grab(text, #"^\s{0,4}(?:@\w+\s+)*(?:(?:public|fileprivate|internal|open|final|private)\s+)*(struct|class|enum|protocol|actor|extension|typealias)\s+([A-Za-z_][\w.]*)"#, m, &out) { "\($0[1]) \($0[2])" }
            grab(text, #"^\s{0,4}(?:@\w+\s+)*(?!.*\b(?:private|fileprivate)\b)(?:(?:public|internal|open|final|static|override|nonisolated|mutating)\s+)*func\s+([A-Za-z_]\w*)"#, m, &out) { "\($0[1])()" }
        } else if e == ".cs" {
            grab(text, #"\b(class|interface|record|struct|enum)\s+([A-Za-z_]\w*)"#, [], &out) { "\($0[1]) \($0[2])" }
            grab(text, #"^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+|virtual\s+|override\s+|abstract\s+)*[\w<>\[\],.? ]+\s+([A-Z]\w*)\s*\("#, m, &out) { g in
                keywords.contains(g[1].lowercased()) ? nil : "\(g[1])()"
            }
        } else if e == ".py" {
            grab(text, #"^(class|def|async def)\s+([A-Za-z_]\w*)"#, m, &out) { $0[1] == "class" ? "class \($0[2])" : "\($0[2])()" }
            grab(text, #"^ {4}(?:async )?def\s+([A-Za-z_]\w*)"#, m, &out) { $0[1].hasPrefix("__") ? nil : ".\($0[1])()" }
        } else if e == ".go" {
            grab(text, #"^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)"#, m, &out) { "\($0[1])()" }
            grab(text, #"^type\s+([A-Za-z_]\w*)\s+(struct|interface)"#, m, &out) { "\($0[2]) \($0[1])" }
        } else if e == ".rs" {
            grab(text, #"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][\w<>]*)"#, m, &out) { $0[1] == "fn" ? "\($0[2])()" : "\($0[1]) \($0[2])" }
        } else if isOne([".kt", ".kts", ".java"]) {
            grab(text, #"\b(class|interface|object|enum class|record)\s+([A-Za-z_]\w*)"#, [], &out) { "\($0[1]) \($0[2])" }
            grab(text, #"\bfun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\("#, [], &out) { "\($0[1])()" }
            grab(text, #"^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\], ]+\s+([a-z]\w*)\s*\("#, m, &out) { keywords.contains($0[1]) ? nil : "\($0[1])()" }
        } else if e == ".rb" {
            grab(text, #"^\s*(class|module|def)\s+([A-Za-z_][\w.:?!]*)"#, m, &out) { $0[1] == "def" ? "\($0[2])()" : "\($0[1]) \($0[2])" }
        } else if e == ".php" {
            grab(text, #"\b(class|interface|trait|function)\s+([A-Za-z_]\w*)"#, [], &out) { $0[1] == "function" ? "\($0[2])()" : "\($0[1]) \($0[2])" }
        } else if e == ".dart" {
            grab(text, #"^\s*(class|mixin|enum|extension)\s+([A-Za-z_]\w*)"#, m, &out) { "\($0[1]) \($0[2])" }
        } else if e == ".sql" {
            grab(text, #"\bcreate\s+(?:or\s+replace\s+)?(table|view|function|procedure|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)"#, [.caseInsensitive], &out) { "\($0[1].lowercased()) \($0[2])" }
        } else if e == ".prisma" {
            grab(text, #"^(model|enum)\s+(\w+)"#, m, &out) { "\($0[1]) \($0[2])" }
        } else if e == ".graphql" || e == ".gql" {
            grab(text, #"^(type|input|enum|interface|query|mutation)\s+(\w+)"#, m, &out) { "\($0[1]) \($0[2])" }
        } else if isOne([".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".mm"]) {
            grab(text, #"^(?:class|struct)\s+(\w+)"#, m, &out) { "class \($0[1])" }
            grab(text, #"^[A-Za-z_][\w\s*&:<>]*?\s\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{"#, m, &out) { keywords.contains($0[1]) ? nil : "\($0[1])()" }
            grab(text, #"^[-+]\s*\([^)]*\)\s*(\w+)"#, m, &out) { $0[1] }
        } else if e == ".sh" {
            grab(text, #"^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{"#, m, &out) { "\($0[1])()" }
        }
        return out
    }

    // MARK: Indexing

    private static func info(root: String, rel: String) -> FileInfo? {
        let abs = (root as NSString).appendingPathComponent(rel)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: abs),
              let mtime = attrs[.modificationDate] as? Date else { return nil }
        if let hit = cache.get(abs), hit.mtime == mtime { return hit }
        let size: Int = (attrs[.size] as? NSNumber)?.intValue ?? 0
        let fi: FileInfo
        if size > maxBytes {
            fi = FileInfo(abs: abs, rel: rel, mtime: mtime, symbols: [])
        } else {
            guard let text = try? String(contentsOfFile: abs, encoding: .utf8) else { return nil }
            let ext = "." + (abs as NSString).pathExtension
            fi = FileInfo(abs: abs, rel: rel, mtime: mtime, symbols: extractSymbols(ext: ext, text: text))
        }
        cache.set(abs, fi)
        return fi
    }

    static func words(_ text: String) -> [String] {
        let spaced = text.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).lowercased()
        let split = spaced.components(separatedBy: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789").inverted)
        let stop: Set<String> = ["the", "and", "for", "this", "that", "with", "can", "you", "please", "what", "how", "why", "fix", "add", "make", "file", "code", "into", "from", "are", "is", "it", "its", "not", "all", "any", "use", "out", "get", "set", "new", "one", "when", "then", "have", "does", "look", "see", "find", "run", "need", "want", "like", "should", "would", "could", "there", "their", "also", "just", "some"]
        var seen: [String] = []
        for w in split where w.count >= 3 && !stop.contains(w) && !seen.contains(w) { seen.append(w) }
        return Array(seen.prefix(40))
    }

    private static func stripExt(_ p: String) -> String {
        p.replacingOccurrences(of: #"\.(tsx?|jsx?|mjs|cjs)$"#, with: "", options: [.regularExpression, .caseInsensitive])
    }

    // MARK: The map

    /// A ranked outline of the project that fits the budget, or "" if there's nothing to show.
    /// `under` limits it to one folder (absolute). Does file work, so call it off the main thread.
    static func build(root: String, query: String = "", under: String? = nil, budgetChars: Int) -> String {
        let code = try? NSRegularExpression(pattern: codePattern, options: .caseInsensitive)
        let skip = try? NSRegularExpression(pattern: skipPattern)
        func hit(_ re: NSRegularExpression?, _ s: String) -> Bool {
            re?.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
        }
        var rels: [String] = CodeFiles.list(root, limit: maxFiles * 3)
            .filter { hit(code, $0) && !hit(skip, "/" + $0) }
        if rels.count > maxFiles { rels = Array(rels.prefix(maxFiles)) }
        if let under {
            let u = URL(fileURLWithPath: under).standardizedFileURL.path
            rels = rels.filter { r in
                let abs = (root as NSString).appendingPathComponent(r)
                return abs == u || abs.hasPrefix(u + "/")
            }
        }
        if rels.isEmpty { return "" }
        let infos: [FileInfo] = rels.compactMap { info(root: root, rel: $0) }
        let changed: Set<String> = CodeFiles.gitChanged(root)
        let q: [String] = words(query)

        var scored: [(f: FileInfo, s: Int)] = infos.map { f in
            var s = 0
            if changed.contains(f.abs) { s += 30 }
            let relLower = f.rel.lowercased()
            let symLower = f.symbols.joined(separator: " ").lowercased()
            for w in q {
                if relLower.contains(w) { s += 15 }
                if symLower.contains(w) { s += 8 }
            }
            if f.rel.range(of: #"(^|/)(index|main|app|program|server|routes?|api)\.[a-z]+$"#, options: [.regularExpression, .caseInsensitive]) != nil
                || f.rel.hasSuffix("App.swift") { s += 5 }
            s -= f.rel.split(separator: "/", omittingEmptySubsequences: false).count
            if f.symbols.isEmpty { s -= 5 }
            return (f, s)
        }
        scored.sort { a, b in a.s != b.s ? a.s > b.s : a.f.rel.localizedCompare(b.f.rel) == .orderedAscending }

        // Folder overview so the model knows the shape even of what's left out.
        var order: [String] = []
        var folders: [String: Int] = [:]
        for f in infos {
            let parts = f.rel.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            let top = parts.count > 1 ? parts.prefix(parts.count > 2 ? 2 : 1).joined(separator: "/") : "."
            if folders[top] == nil { order.append(top) }
            folders[top, default: 0] += 1
        }
        let ranked = order.enumerated().sorted { a, b in
            let ca = folders[a.element]!, cb = folders[b.element]!
            return ca != cb ? ca > cb : a.offset < b.offset
        }
        let overview: String = ranked.prefix(12).map { "\($0.element) (\(folders[$0.element]!))" }.joined(separator: ", ")

        var lines: [String] = []
        var used: Int = overview.utf16.count + 200
        var shown = 0
        for (f, _) in scored {
            var syms: String = f.symbols.prefix(maxSymbols).joined(separator: " · ")
            if f.symbols.count > maxSymbols { syms += " · +\(f.symbols.count - maxSymbols)" }
            let entry: String = syms.isEmpty ? f.rel : "\(f.rel)\n  \(syms)"
            if used + entry.utf16.count + 1 > budgetChars {
                if shown >= 3 { break }
                continue
            }
            lines.append(entry)
            used += entry.utf16.count + 1
            shown += 1
        }
        let rest = infos.count - shown
        var out: [String] = ["\(infos.count) code files. Folders: \(overview)."]
        out += lines
        if rest > 0 {
            out.append("…and \(rest) more files (repo_map with a focus or folder shows others; find_files / search_code to locate things).")
        }
        return out.joined(separator: "\n")
    }

    /// The prompt section for a Code chat: same heading as VS Code. "" when there's nothing to map.
    static func promptSection(root: String, query: String, contextTokens: Int) async -> String {
        let budget: Int = min(6000, contextTokens * 4 / 10)
        let map: String = await Task.detached(priority: .userInitiated) {
            build(root: root, query: query, budgetChars: budget)
        }.value
        if map.isEmpty { return "" }
        return "## Repo map (the project at a glance, most relevant first — read_file for details, repo_map for more)\n" + map
    }
}
