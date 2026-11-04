import Foundation
import AppKit

/// Long-term memory in ~/.ingle/memory: one Markdown file per subject (about-me, preferences, projects…),
/// each starting with a one-line description. The index of files goes into every chat;
/// details are found with memory_search or attached automatically when they match.
struct MemoryFile: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String
    let body: String
    let url: URL

    var facts: [String] {
        body.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
    }
}

enum MemoryStore {
    static var folder: URL { IngleHome.url.appendingPathComponent("memory", isDirectory: true) }

    static func all() -> [MemoryFile] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return [] }
        return files.filter { $0.pathExtension.lowercased() == "md" && $0.lastPathComponent != "INDEX.md" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { url in
                guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
                let meta = SkillStore.frontmatter(text)
                return MemoryFile(name: url.deletingPathExtension().lastPathComponent,
                                  description: meta["description"] ?? "",
                                  body: RuleStore.stripFrontmatter(text), url: url)
            }
    }

    /// "About Me" → "about-me"
    static func slug(_ name: String) -> String {
        let lowered = name.lowercased().replacingOccurrences(of: ".md", with: "")
        let cleaned = lowered.map { $0.isLetter || $0.isNumber ? $0 : "-" }
        let collapsed = String(cleaned).replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
        let s = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return s.isEmpty ? "notes" : String(s.prefix(60))
    }

    private static func write(_ name: String, description: String, body: String) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let text = "---\ndescription: \(description)\n---\n\n\(body.trimmingCharacters(in: .whitespacesAndNewlines))\n"
        try? text.write(to: folder.appendingPathComponent("\(slug(name)).md"), atomically: true, encoding: .utf8)
        writeIndex()
    }

    /// A human-readable copy of the index, for browsing in Finder or an editor.
    static func writeIndex() {
        let lines = ["# Memory index", "", "Ingle keeps this up to date. Each file below holds one subject.", ""]
            + all().map { "- [\($0.name)](\($0.name).md) — \($0.description.isEmpty ? "(no description)" : $0.description) · \($0.facts.count) facts" }
        try? lines.joined(separator: "\n").write(to: folder.appendingPathComponent("INDEX.md"), atomically: true, encoding: .utf8)
    }

    // MARK: Tool actions

    static func save(file: String, fact: String, description: String?) -> String {
        let fact = fact.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !fact.isEmpty else { return "Nothing to save." }
        if looksSecret(fact) { return "Not saved: that looks like a password, key or card number, which Ingle never stores." }
        let name = slug(file)
        let existing = all().first { $0.name == name }
        let line = fact.hasPrefix("- ") ? fact : "- " + fact
        if let existing, existing.facts.contains(where: { $0.caseInsensitiveCompare(line) == .orderedSame }) {
            return "Already remembered in \(name)."
        }
        let desc = (existing?.description.isEmpty == false ? existing!.description : nil)
            ?? description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Things to remember about \(name.replacingOccurrences(of: "-", with: " "))"
        write(name, description: desc, body: (existing?.body ?? "") + "\n" + line)
        return "Saved to \(name): \(line.dropFirst(2))"
    }

    static func rewrite(file: String, content: String, description: String?) -> String {
        if looksSecret(content) { return "Not saved: that includes something that looks like a password, key or card number." }
        let name = slug(file)
        let existing = all().first { $0.name == name }
        let desc = description?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? existing?.description ?? "Things to remember"
        write(name, description: desc, body: content)
        return "Rewrote \(name)."
    }

    static func forget(file: String, text: String) -> String {
        let name = slug(file)
        guard let existing = all().first(where: { $0.name == name }) else { return "There's no memory file called \(name)." }
        let needle = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return "Say what to forget." }
        let kept = existing.body.components(separatedBy: "\n").filter { !$0.localizedCaseInsensitiveContains(needle) }
        let removed = existing.body.components(separatedBy: "\n").count - kept.count
        if removed == 0 { return "Nothing in \(name) mentions “\(needle)”." }
        write(name, description: existing.description, body: kept.joined(separator: "\n"))
        return "Forgot \(removed) line\(removed == 1 ? "" : "s") from \(name)."
    }

    static func read(_ file: String) -> String {
        let name = slug(file)
        guard let m = all().first(where: { $0.name == name }) else {
            return "There's no memory file called \(name). Files: \(all().map(\.name).joined(separator: ", "))."
        }
        return String(m.body.prefix(12_000))
    }

    /// Keyword scan across every memory, best lines first.
    static func search(_ query: String) -> String {
        let words = Set(query.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 2 })
        guard !words.isEmpty else { return "Give me a word or two to search for." }
        var hits: [(score: Int, line: String)] = []
        for file in all() {
            for fact in file.facts {
                let lower = fact.lowercased()
                let score = words.reduce(0) { $0 + (lower.contains($1) ? 1 : 0) }
                    + (words.contains(where: { file.name.contains($0) || file.description.lowercased().contains($0) }) ? 1 : 0)
                if score > 0 { hits.append((score, "[\(file.name)] \(fact)")) }
            }
        }
        if hits.isEmpty { return "Nothing in memory about that." }
        return hits.sorted { $0.score > $1.score }.prefix(15).map(\.line).joined(separator: "\n")
    }

    private static func looksSecret(_ s: String) -> Bool {
        let lower = s.lowercased()
        if ["password", "passcode", "pin code", "api key", "secret key", "private key", "token:"].contains(where: { lower.contains($0) }) { return true }
        // 13–19 digit runs (card numbers), allowing spaces or dashes.
        let digits = s.replacingOccurrences(of: "[ -]", with: "", options: .regularExpression)
        return digits.range(of: "\\d{13,19}", options: .regularExpression) != nil
    }

    // MARK: Prompt pieces

    static func indexSection() -> String? {
        let files = all()
        guard Prefs.memoryEnabled else { return nil }
        var lines = ["## Memory index (long-term memory about the user — search it before saying you don't know)"]
        if files.isEmpty {
            lines.append("(empty so far)")
        } else {
            for f in files { lines.append("- \(f.name) — \(f.description.isEmpty ? "notes" : f.description) (\(f.facts.count) facts)") }
        }
        return lines.joined(separator: "\n")
    }

    static let systemPrompt = """
    You have long-term memory in files (see the memory index).
    - When the user asks about themselves, their life, work or preferences, or refers to something from before, use memory_search or memory_read first.
    - When the user tells you a lasting fact about themselves (work, people, preferences, plans, how they like answers), save it with memory_save: one short fact, in the right file (about-me, preferences, work, projects, people, or a new subject). Don't ask first, and don't save passing chatter or things that will be out of date tomorrow.
    - If something changed, fix the old fact with memory_forget then memory_save, or memory_rewrite the file. If asked to forget something, use memory_forget.
    - Never save passwords, keys, card or bank numbers.
    """

    static let definitions: [[String: Any]] = [
        MacTools.tool("memory_search", "Search long-term memory about the user for a detail.",
                      ["query": MacTools.prop("Words to look for, e.g. 'work hours' or 'cat names'")], required: ["query"]),
        MacTools.tool("memory_read", "Read one memory file in full.",
                      ["file": MacTools.prop("File name from the memory index")], required: ["file"]),
        MacTools.tool("memory_save", "Remember one lasting fact about the user.",
                      ["file": MacTools.prop("Which file: about-me, preferences, work, projects, people, or a new subject"),
                       "fact": MacTools.prop("The fact, short and in plain words"),
                       "description": MacTools.prop("Only for a new file: one line saying what it holds")], required: ["file", "fact"]),
        MacTools.tool("memory_rewrite", "Replace a whole memory file, to correct or tidy it.",
                      ["file": MacTools.prop("File name"), "content": MacTools.prop("The full new contents, one fact per line"),
                       "description": MacTools.prop("Optional new one-line description")], required: ["file", "content"]),
        MacTools.tool("memory_forget", "Remove lines from a memory file that mention some text.",
                      ["file": MacTools.prop("File name"), "text": MacTools.prop("Text the lines to remove contain")], required: ["file", "text"]),
    ]

    static func openFolder() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        writeIndex()
        NSWorkspace.shared.open(folder)
    }

    static func forgetEverything() {
        for f in all() { try? FileManager.default.removeItem(at: f.url) }
        writeIndex()
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
