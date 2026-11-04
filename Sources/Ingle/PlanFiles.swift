import SwiftUI
import AppKit

/// A plan shown as a card in the chat: the file, its name and status.
struct PlanRef: Codable, Equatable {
    var file: String
    var name: String
    var status: String   // draft | approved | done
}

/// Plans as Markdown files: <project>/.ingle/plans/YYYY-MM-DD-<slug>.md (or ~/.ingle/plans/ without a project).
/// Frontmatter (title, status, chat, created), then the goal, the steps as a checklist and notes. Approve reads the file;
/// steps are ticked in it as the task list moves on. Same as Extensions/vscode/src/tools/planFiles.ts (tested there).
enum PlanFiles {
    struct Step: Equatable { var content: String; var done: Bool }
    struct Doc: Equatable {
        var title: String
        var status: String
        var chat: String
        var created: String
        var goal: String
        var steps: [Step]
        var notes: String
    }

    static func dir(project: String?) -> String {
        if let project { return (project as NSString).appendingPathComponent(".ingle/plans") }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".ingle/plans")
    }

    static func slug(_ title: String) -> String {
        let folded: String = title.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
        let words: [String] = folded.split(whereSeparator: { !($0.isASCII && ($0.isLetter || $0.isNumber)) }).map(String.init)
        var s: String = words.prefix(6).joined(separator: "-")
        if s.count > 48 { s = String(s.prefix(48)) }
        while s.hasSuffix("-") { s.removeLast() }
        return s.isEmpty ? "plan" : s
    }

    static func title(_ request: String) -> String {
        let first: String = request.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? "Plan"
        let t: String = first.replacingOccurrences(of: #"[.!?:;,\s]+$"#, with: "", options: .regularExpression)
        return t.count > 60 ? String(t.prefix(59)).trimmingCharacters(in: .whitespaces) + "…" : t
    }

    static func fromReply(_ reply: String, steps: [String], request: String, chat: String, now: Date = Date()) -> Doc {
        let clean: String = reply.replacingOccurrences(of: #"<think>[\s\S]*?</think>"#, with: "", options: .regularExpression)
        let stepSet = Set(steps)
        let kept: [String] = clean.components(separatedBy: "\n").filter { line in
            guard let r = line.range(of: #"^\s*(\d{1,2}[.)]|[-*•])\s+"#, options: .regularExpression) else { return true }
            let content: String = String(line[r.upperBound...]).replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
                .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            return !stepSet.contains(content)
        }
        let notes: String = kept.joined(separator: "\n").replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return Doc(title: title(request), status: "draft", chat: chat, created: f.string(from: now),
                   goal: String(request.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1500)),
                   steps: steps.map { Step(content: $0, done: false) }, notes: notes)
    }

    static func render(_ p: Doc) -> String {
        func q(_ s: String) -> String {
            let plain: Bool = s.range(of: #"^[\w .,()'/-]*$"#, options: .regularExpression) != nil && s.trimmingCharacters(in: .whitespaces) == s
            if plain { return s }
            let data = (try? JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes])) ?? Data()
            let arr: String = String(decoding: data, as: UTF8.self)
            return String(arr.dropFirst().dropLast())
        }
        var lines: [String] = ["---", "title: \(q(p.title))", "status: \(p.status)", "chat: \(p.chat)", "created: \(p.created)", "---", "",
                               "# \(p.title)", "", "## Goal", "", p.goal.isEmpty ? "(none given)" : p.goal, "", "## Steps", ""]
        lines += p.steps.map { "- [\($0.done ? "x" : " ")] \($0.content)" }
        lines += ["", "## Notes", "", p.notes.isEmpty ? "(none)" : p.notes, ""]
        return lines.joined(separator: "\n")
    }

    static func parse(_ raw: String) -> Doc {
        let text: String = raw.replacingOccurrences(of: "\r\n", with: "\n")
        var meta: [String: String] = [:]
        var body: String = text
        if text.hasPrefix("---\n"), let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 4)..<text.endIndex) {
            let head: String = String(text[text.index(text.startIndex, offsetBy: 4)..<end.lowerBound])
            for line in head.components(separatedBy: "\n") {
                guard let c = line.firstIndex(of: ":") else { continue }
                let key: String = line[..<c].trimmingCharacters(in: .whitespaces).lowercased()
                var v: String = line[line.index(after: c)...].trimmingCharacters(in: .whitespaces)
                if v.hasPrefix("\""), let d = ("[" + v + "]").data(using: .utf8),
                   let arr = (try? JSONSerialization.jsonObject(with: d)) as? [String], let s = arr.first { v = s }
                meta[key] = v
            }
            body = String(text[end.upperBound...])
            if body.hasPrefix("\n") { body.removeFirst() }
        }
        func section(_ name: String) -> String? {
            let lines: [String] = body.components(separatedBy: "\n")
            guard let start = lines.firstIndex(where: { $0.range(of: "^##\\s+\(name)\\s*$", options: [.regularExpression, .caseInsensitive]) != nil }) else { return nil }
            var out: [String] = []
            for l in lines[(start + 1)...] {
                if l.hasPrefix("## ") { break }
                out.append(l)
            }
            return out.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        var steps: [Step] = []
        for line in (section("Steps") ?? body).components(separatedBy: "\n") {
            guard let r = line.range(of: #"^\s*[-*]\s+\[[ xX]\]\s+"#, options: .regularExpression) else { continue }
            let mark: String = String(line[r]).trimmingCharacters(in: .whitespaces)
            steps.append(Step(content: String(line[r.upperBound...]).trimmingCharacters(in: .whitespaces),
                              done: mark.contains("[x]") || mark.contains("[X]")))
        }
        let status: String = ["draft", "approved", "done"].contains(meta["status"] ?? "") ? meta["status"]! : "draft"
        let heading: String? = body.components(separatedBy: "\n").first { $0.hasPrefix("# ") }.map { String($0.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
        return Doc(title: meta["title"].flatMap { $0.isEmpty ? nil : $0 } ?? heading ?? "Plan", status: status, chat: meta["chat"] ?? "",
                   created: meta["created"] ?? "", goal: section("Goal") ?? "", steps: steps, notes: section("Notes") ?? "")
    }

    /// Saves a new plan (-2, -3… if the name is taken). The path, or nil if it couldn't be written.
    static func save(_ p: Doc, in dir: String, now: Date = Date()) -> String? {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        let base: String = "\(f.string(from: now))-\(slug(p.title))"
        var file: String = (dir as NSString).appendingPathComponent(base + ".md")
        var n = 2
        while FileManager.default.fileExists(atPath: file) {
            file = (dir as NSString).appendingPathComponent("\(base)-\(n).md")
            n += 1
        }
        do { try render(p).write(toFile: file, atomically: true, encoding: .utf8) } catch { return nil }
        return file
    }

    static func read(_ file: String) -> Doc? {
        (try? String(contentsOfFile: file, encoding: .utf8)).map(parse)
    }

    static func tasks(_ p: Doc) -> [TaskItem] {
        var started = false
        return p.steps.map { s in
            if s.done { return TaskItem(content: s.content, status: .done) }
            defer { started = true }
            return TaskItem(content: s.content, status: started ? .pending : .in_progress)
        }
    }

    /// Ticks the checklist (by position when the counts match, else by matching text) and sets the status (done when all
    /// are ticked). Only the marks and the status line change. nil when nothing changed. Same as tickPlanText.
    static func tick(_ raw: String, tasks: [TaskItem], status: String? = nil) -> String? {
        let text: String = raw.replacingOccurrences(of: "\r\n", with: "\n")
        var lines: [String] = text.components(separatedBy: "\n")
        let stepsAt: Int? = lines.firstIndex { $0.range(of: #"^##\s+Steps\s*$"#, options: [.regularExpression, .caseInsensitive]) != nil }
        var end: Int = lines.count
        if let s = stepsAt, let n = lines[(s + 1)...].firstIndex(where: { $0.hasPrefix("## ") }) { end = n }
        let from: Int = (stepsAt ?? -1) + 1
        var idx: [Int] = []
        if from < end {
            for i in from..<end where lines[i].range(of: #"^\s*[-*]\s+\[[ xX]\]\s+"#, options: .regularExpression) != nil { idx.append(i) }
        }
        func norm(_ s: String) -> String {
            s.lowercased().replacingOccurrences(of: "`", with: "").replacingOccurrences(of: "*", with: "")
                .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        }
        let byPosition: Bool = idx.count == tasks.count
        for (k, i) in idx.enumerated() {
            let line: String = lines[i]
            guard let r = line.range(of: #"^\s*[-*]\s+\[[ xX]\]\s+"#, options: .regularExpression) else { continue }
            let content: String = String(line[r.upperBound...])
            let task: TaskItem? = byPosition ? tasks[k] : tasks.first { norm($0.content) == norm(content) }
            guard let task, let box = line.range(of: #"\[[ xX]\]"#, options: .regularExpression) else { continue }
            lines[i] = line.replacingCharacters(in: box, with: task.status == .done ? "[x]" : "[ ]")
        }
        let allTicked: Bool = !idx.isEmpty && idx.allSatisfy { lines[$0].contains("[x]") || lines[$0].contains("[X]") }
        if let want = allTicked ? "done" : status, lines.first == "---" {
            for i in 1..<lines.count {
                if lines[i] == "---" { break }
                if lines[i].hasPrefix("status:") { lines[i] = "status: \(want)"; break }
            }
        }
        let out: String = lines.joined(separator: "\n")
        return out == text ? nil : out
    }

    static func tickFile(_ file: String, tasks: [TaskItem], status: String? = nil) {
        guard let raw = try? String(contentsOfFile: file, encoding: .utf8), let next = tick(raw, tasks: tasks, status: status) else { return }
        try? next.write(toFile: file, atomically: true, encoding: .utf8)
    }

    /// The one place that opens a plan file: the preview pane beside the chat (Edit opens it in Split, to edit the file).
    @MainActor static func open(_ url: URL, edit: Bool = false) {
        Preview.open(url, mode: edit ? .split : nil)
    }
}

/// A plan saved as a Markdown file: name and status, Open, Edit (the file; Approve uses what it says) and, in Plan, Approve.
struct PlanCard: View {
    let plan: PlanRef
    let approve: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.text").font(.system(size: 12)).foregroundStyle(Ember.accent)
            Text(plan.name)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Ember.text)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(plan.file)
            Text(plan.status.capitalized)
                .font(.system(size: 10.5))
                .foregroundStyle(plan.status == "approved" ? Ember.accent : Ember.secondary)
                .padding(.horizontal, 6)
                .frame(height: 16)
                .background(Capsule().fill(Color.white.opacity(0.07)))
            Spacer(minLength: 8)
            Button("Open") { PlanFiles.open(URL(fileURLWithPath: plan.file)) }
                .help("Show the plan in the preview pane")
            Button { PlanFiles.open(URL(fileURLWithPath: plan.file), edit: true) } label: { Label("Edit", systemImage: "pencil") }
                .help("Edit the plan file — Approve uses what the file says")
            if let approve, plan.status == "draft" {
                Button(action: approve) { Label("Approve", systemImage: "checkmark") }
                    .buttonStyle(.borderedProminent)
                    .help("Start the work with this plan (read from the file) as the task list")
            }
        }
        .controlSize(.regular)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Ember.accent.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Ember.accent.opacity(0.35)))
    }
}
