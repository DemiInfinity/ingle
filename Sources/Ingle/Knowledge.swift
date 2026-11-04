import Foundation
import AppKit

// MARK: - Research reports

/// Short reports saved after web research, in ~/.ingle/research. Their index goes into every chat,
/// so earlier research can be recalled instead of redone.
struct ResearchReport: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let title: String
    let summary: String
    let date: String
    let body: String
    let url: URL
}

enum ReportStore {
    static var folder: URL { IngleHome.url.appendingPathComponent("research", isDirectory: true) }

    static func all() -> [ResearchReport] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return [] }
        return files.filter { $0.pathExtension.lowercased() == "md" && $0.lastPathComponent != "INDEX.md" }
            .compactMap { url in
                guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
                let meta = SkillStore.frontmatter(text)
                let name = url.deletingPathExtension().lastPathComponent
                return ResearchReport(name: name, title: meta["title"] ?? name, summary: meta["description"] ?? "",
                                      date: meta["date"] ?? "", body: RuleStore.stripFrontmatter(text), url: url)
            }
            .sorted { $0.date > $1.date }
    }

    static func save(title: String, summary: String, report: String, sources: String) -> String {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !report.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "A report needs a title and some content."
        }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let day = ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withFullDate])
        let name = "\(day)-\(MemoryStore.slug(title))"
        let oneLine = summary.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        var text = "---\ntitle: \(title.replacingOccurrences(of: "\n", with: " "))\ndescription: \(oneLine)\ndate: \(day)\n---\n\n# \(title)\n\n\(report.trimmingCharacters(in: .whitespacesAndNewlines))\n"
        let src = sources.trimmingCharacters(in: .whitespacesAndNewlines)
        if !src.isEmpty { text += "\n## Sources\n\(src)\n" }
        try? text.write(to: folder.appendingPathComponent("\(name).md"), atomically: true, encoding: .utf8)
        writeIndex()
        return "Saved research report “\(title)” (\(name))."
    }

    static func writeIndex() {
        let lines = ["# Research index", "", "Reports Ingle has written after researching the web, newest first.", ""]
            + all().map { "- \($0.date) · [\($0.title)](\($0.name).md) — \($0.summary)" }
        try? lines.joined(separator: "\n").write(to: folder.appendingPathComponent("INDEX.md"), atomically: true, encoding: .utf8)
    }

    static func read(_ name: String) -> String {
        let reports = all()
        let key = name.lowercased()
        guard let r = reports.first(where: { $0.name.lowercased() == key || $0.title.lowercased() == key })
                ?? reports.first(where: { $0.name.lowercased().contains(key) || $0.title.lowercased().contains(key) }) else {
            return "There's no report called \(name)."
        }
        return String(r.body.prefix(15_000))
    }

    static func search(_ query: String) -> String {
        let words = Set(query.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 2 })
        guard !words.isEmpty else { return "Give me a word or two to search for." }
        let scored = all().map { r -> (ResearchReport, Int) in
            let hay = (r.title + " " + r.summary + " " + r.body).lowercased()
            return (r, words.reduce(0) { $0 + (hay.contains($1) ? 1 : 0) })
        }.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }
        if scored.isEmpty { return "No saved research about that yet." }
        return scored.prefix(8).map { "- \($0.0.name): \($0.0.title) — \($0.0.summary) (\($0.0.date))" }.joined(separator: "\n")
    }

    static func indexSection() -> String? {
        let reports = all()
        guard !reports.isEmpty else { return nil }
        var lines = ["## Research index (earlier web research — check here before researching again; open with report_read)"]
        for r in reports.prefix(15) { lines.append("- \(r.name) — \(r.summary.isEmpty ? r.title : r.summary)") }
        if reports.count > 15 { lines.append("- …and \(reports.count - 15) older reports (find them with report_search)") }
        return lines.joined(separator: "\n")
    }

    static func openFolder() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        writeIndex()
        NSWorkspace.shared.open(folder)
    }
}

// MARK: - Skill and rule builder

enum Builder {
    static func createSkill(name: String, description: String, instructions: String, replace: Bool) -> String {
        let slug = MemoryStore.slug(name)
        let dir = SkillStore.ingleFolder.appendingPathComponent(slug, isDirectory: true)
        let file = dir.appendingPathComponent("SKILL.md")
        if FileManager.default.fileExists(atPath: file.path) && !replace {
            return "A skill called \(slug) already exists. Call skill_create again with replace set to true to overwrite it."
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let text = "---\nname: \(slug)\ndescription: \(description.replacingOccurrences(of: "\n", with: " "))\n---\n\n\(instructions.trimmingCharacters(in: .whitespacesAndNewlines))\n"
        do {
            try text.write(to: file, atomically: true, encoding: .utf8)
            return "Created the skill \(slug) at \(file.path). It's now in the skills index."
        } catch {
            return "Couldn't save the skill: \(error.localizedDescription)"
        }
    }

    static func createRule(name: String, description: String, always: Bool, text body: String, replace: Bool) -> String {
        let slug = MemoryStore.slug(name)
        try? FileManager.default.createDirectory(at: IngleHome.rulesFolder, withIntermediateDirectories: true)
        let file = IngleHome.rulesFolder.appendingPathComponent("\(slug).md")
        if FileManager.default.fileExists(atPath: file.path) && !replace {
            return "A rule called \(slug) already exists. Call rule_create again with replace set to true to overwrite it."
        }
        let text = "---\ndescription: \(description.replacingOccurrences(of: "\n", with: " "))\nalways: \(always)\n---\n\n\(body.trimmingCharacters(in: .whitespacesAndNewlines))\n"
        do {
            try text.write(to: file, atomically: true, encoding: .utf8)
            return "Created the rule \(slug) (\(always ? "always on" : "used when relevant"))."
        } catch {
            return "Couldn't save the rule: \(error.localizedDescription)"
        }
    }
}

// MARK: - Tool definitions and guidance

enum KnowledgeTools {
    static let chatDefinitions: [[String: Any]] = [
        MacTools.tool("chat_list", "List the user's recent chats with Ingle (titles and dates).", [:], required: []),
        MacTools.tool("chat_search", "Search the user's past chats for something said before.",
                      ["query": MacTools.prop("Words to look for")], required: ["query"]),
        MacTools.tool("chat_read", "Read a past chat. Use its title (or part of it) from chat_list or chat_search.",
                      ["chat": MacTools.prop("The chat's title or part of it")], required: ["chat"]),
    ]

    static let reportDefinitions: [[String: Any]] = [
        MacTools.tool("report_save", "Save a short research report after researching on the web, so it can be recalled later.",
                      ["title": MacTools.prop("Report title"),
                       "summary": MacTools.prop("One line saying what it found"),
                       "report": MacTools.prop("Key findings in Markdown: short sections or bullet points"),
                       "sources": MacTools.prop("The URLs used, one per line")], required: ["title", "summary", "report"]),
        MacTools.tool("report_search", "Search saved research reports.", ["query": MacTools.prop("Words to look for")], required: ["query"]),
        MacTools.tool("report_read", "Read a saved research report.", ["name": MacTools.prop("The report's name from the research index")], required: ["name"]),
    ]

    static let builderDefinitions: [[String: Any]] = [
        ["type": "function",
         "function": ["name": "skill_create",
                      "description": "Create a new skill for the user (they approve it). A skill is step-by-step instructions for a kind of task.",
                      "parameters": ["type": "object",
                                     "properties": ["name": MacTools.prop("Short name, e.g. code-review"),
                                                    "description": MacTools.prop("One line saying when to use it"),
                                                    "instructions": MacTools.prop("The skill itself in Markdown: steps, checklists, examples"),
                                                    "replace": ["type": "boolean", "description": "Overwrite an existing skill with this name"]],
                                     "required": ["name", "description", "instructions"]]]],
        ["type": "function",
         "function": ["name": "rule_create",
                      "description": "Create a new rule for the user (they approve it).",
                      "parameters": ["type": "object",
                                     "properties": ["name": MacTools.prop("Short name, e.g. react-components"),
                                                    "description": MacTools.prop("One line saying when it applies"),
                                                    "always": ["type": "boolean", "description": "True if it applies to every chat"],
                                                    "text": MacTools.prop("The rule in plain words"),
                                                    "replace": ["type": "boolean", "description": "Overwrite an existing rule with this name"]],
                                     "required": ["name", "description", "text"]]]],
    ]

    static let delegateDefinition: [String: Any] = MacTools.tool(
        "delegate",
        "Hand a self-contained piece of work to a helper sub-agent that starts fresh and reports back. It can only read: web (if on), memory, reports, past chats, skills, rules, and files (if Mac access is on). Give it a complete, specific task.",
        ["task": MacTools.prop("Everything the helper needs: the goal, what to look at, and what to report back")],
        required: ["task"])

    static let systemPrompt = """
    More things you can do:
    - Past chats: when the user mentions an earlier conversation ("like we discussed", "last week"), use chat_search or chat_read.
    - Skill and rule builder: when asked to make a skill or rule, draft it properly (a clear name, a one-line description of when it applies, then step-by-step instructions) and save it with skill_create or rule_create. The user approves it.
    - Research reports: before researching something, check report_search — you may have done it before. After researching on the web, save what you found with report_save (title, one-line summary, key findings, sources).
    - Sub-agents: for a separate chunk of work (research one topic, read and summarise some files), use delegate with a complete task, then use its findings. Helpers run one at a time and can only read.
    """

    /// What a sub-agent may use: read-only tools only, and never another sub-agent.
    static let subAgentAllowed: Set<String> = [
        "web_search", "web_fetch", "memory_search", "memory_read", "report_search", "report_read",
        "chat_list", "chat_search", "chat_read", "use_skill", "use_rule", "ingle_help", "list_files", "read_file",
    ]
}
