import Foundation
import SwiftUI
import AppKit

/// The second-opinion card on a run's last reply (task 35): why it was offered, the brief (secrets scrubbed) and
/// the summary for Flint. Same meaning as `EscalationInfo` + `escalationData` in the VS Code extension.
struct EscalationCard: Codable, Equatable {
    var reasons: [String]
    /// The hard-jobs model's name when Try with it is offered; nil when the chat is already on it.
    var flint: String?
    /// "flint" or "kept" once the user chose (the card shrinks to a note).
    var chosen: String?
    /// The saved brief, once prepared.
    var file: String?
    var goal: String
    var brief: String
    var summary: String
    var redact: Bool?
    /// The project the run worked in (briefs are saved in its .ingle/briefs).
    var project: String?
}

/// Second opinion: when a run is truly stuck, the harness (never the model) offers a stronger model or a copy-only
/// brief for a cloud AI. Same rules and wording as Extensions/vscode/src/engine/escalation.ts (tested there).
enum Escalation {
    static let checkFailLimit: Int = 3
    static let cardTitle = "This might need a stronger model"
    static let stuckReason = "It went round in circles and stopped."
    static let reviewReason = "The review found problems that weren’t fixed."
    static func commandReason(_ name: String) -> String { "The command “\(name)” still wasn’t followed after reminders." }
    static func checkReason(_ label: String, _ n: Int) -> String { "`\(label)` failed \(n) times." }
    /// Task 34 (coverage) calls log.add("coverage", coverageReason(n)) when affected places stay unresolved.
    static func coverageReason(_ n: Int) -> String { "\(n) affected place\(n == 1 ? "" : "s") not checked." }

    enum Outcome: String {
        case ok, failed, denied, skipped
        var words: String {
            switch self {
            case .ok: return "ok"
            case .failed: return "failed"
            case .denied: return "denied by the user"
            case .skipped: return "not run"
            }
        }
    }

    struct Attempt { let tool: String; let what: String; let outcome: Outcome }
    struct ErrorText { let what: String; let text: String }

    /// What one run did, for the triggers and the brief.
    struct Log {
        var root: String?
        var tools: Int = 0
        var attempts: [Attempt] = []
        var checkFailures: [String: Int] = [:]
        var errors: [ErrorText] = []
        var read: [String] = []
        var changed: [String] = []
        var triggers: [(kind: String, reason: String)] = []
        var offered: Bool = false

        init(root: String?) { self.root = root }

        mutating func add(_ kind: String, _ reason: String) {
            if triggers.contains(where: { $0.kind == kind && $0.reason == reason }) { return }
            triggers.append((kind, reason))
        }

        /// Records one tool call (output already scrubbed). Returns true when a check reached the failure limit.
        @discardableResult
        mutating func record(_ call: ToolCall, output: String, denied: Bool, skipped: Bool, known: [String]) -> Bool {
            tools += 1
            let raw: String = Escalation.argText(call)
            let what: String = Escalation.short(raw.isEmpty ? call.name : raw)
            if skipped { attempts.append(Attempt(tool: call.name, what: what, outcome: .skipped)); return false }
            if denied { attempts.append(Attempt(tool: call.name, what: what, outcome: .denied)); return false }
            let failed: Bool = Escalation.callFailed(call.name, output)
            attempts.append(Attempt(tool: call.name, what: what, outcome: failed ? .failed : .ok))
            let p: String = call.arg("path").isEmpty ? "" : Escalation.absPath(call.arg("path"), root: root)
            if !p.isEmpty {
                let changing: Bool = CommandStore.fileChangingTools.contains(call.name)
                if changing && !failed {
                    if !changed.contains(p) { changed.append(p) }
                } else if (call.name == "read_file" || changing) && !read.contains(p) {
                    read.append(p)
                }
            }
            guard failed else { return false }
            let key: String? = Escalation.checkKey(call, known: known)
            let text: String = Escalation.tail(output)
            if ["run_command", "get_problems", "ssh_command"].contains(call.name) {
                errors.removeAll { $0.text == text }
                errors.append(ErrorText(what: key ?? what, text: text))
                if errors.count > 4 { errors.removeFirst() }
            }
            guard let key else { return false }
            let n: Int = (checkFailures[key] ?? 0) + 1
            checkFailures[key] = n
            guard n == Escalation.checkFailLimit else { return false }
            add("check-failed", Escalation.checkReason(key, n))
            return true
        }

        /// The card's reasons, once per run, only after real tool use and at least one trigger.
        mutating func offer() -> [String]? {
            if offered || tools == 0 || triggers.isEmpty { return nil }
            offered = true
            return triggers.map(\.reason)
        }
    }

    // MARK: checks

    private static let checkPattern: String = [
        #"\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|lint|build|check|typecheck|type-check|verify)\b"#,
        #"\bnpx\s+(tsc|jest|vitest|mocha|eslint|playwright)\b"#, #"(^|[\s;&|])tsc(\s|$)"#,
        #"\bswift\s+(build|test)\b"#, #"\bxcodebuild\b"#, #"\bcargo\s+(test|build|check|clippy)\b"#,
        #"\bgo\s+(test|build|vet)\b"#, #"\bpytest\b"#, #"\bpython3?\s+-m\s+(pytest|unittest|mypy)\b"#,
        #"(^|[\s;&|])make(\s+(test|check|build|all))?(\s|$)"#, #"\bgradlew?\s+\w*(test|build|check)"#,
        #"\bmvn\b"#, #"\bdotnet\s+(test|build)\b"#, #"\bnode\s+--test\b"#, #"\bjest\b"#,
        #"\bvitest\b"#, #"\bmypy\b"#, #"\bruff\b"#, #"\brspec\b"#, #"\bphpunit\b"#,
        #"\bctest\b"#, #"\bdeno\s+(test|check)\b"#, #"\bflutter\s+test\b"#,
    ].joined(separator: "|")

    private static func matches(_ s: String, _ pattern: String, _ options: String.CompareOptions = [.regularExpression]) -> Bool {
        s.range(of: pattern, options: options) != nil
    }

    static func normalise(_ command: String) -> String {
        var c: String = command.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        // Every leading `cd dir &&` (models often add one even when the cwd is already the project).
        while let r = c.range(of: #"^cd [^;&|]+(&&|;)\s*"#, options: .regularExpression) { c.removeSubrange(r) }
        c = c.replacingOccurrences(of: #"\s*\|\s*(tail|head|grep|cat|less|tee)\b.*$"#, with: "", options: .regularExpression)
        c = c.replacingOccurrences(of: #"\s*2>&1\s*"#, with: " ", options: .regularExpression)
        return c.trimmingCharacters(in: .whitespaces)
    }

    /// The check a call runs ("npm test", "get_problems (swift build)"), or nil.
    static func checkKey(_ call: ToolCall, known: [String]) -> String? {
        if call.name == "get_problems" {
            let cmd: String = normalise(call.arg("command"))
            return cmd.isEmpty ? "get_problems" : "get_problems (\(cmd))"
        }
        guard call.name == "run_command" else { return nil }
        let c: String = normalise(call.arg("command"))
        if c.isEmpty { return nil }
        let lower: String = c.lowercased()
        let isKnown: Bool = known.contains { k in
            let n: String = normalise(k).lowercased()
            return !n.isEmpty && lower.contains(n)
        }
        if isKnown { return c }
        return matches(c, checkPattern, [.regularExpression, .caseInsensitive]) ? c : nil
    }

    /// Whether a tool's output says it failed. Same formats as VS Code ("exit code N"; "N errors, M warnings").
    static func callFailed(_ name: String, _ output: String) -> Bool {
        let trimmed: Substring = output.drop { $0.isWhitespace }
        let first: String = String(trimmed.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        if name == "run_command" || name == "ssh_command" {
            if let r = first.range(of: #"^exit code (-?\d+)"#, options: .regularExpression) {
                let code: String = String(first[r].dropFirst("exit code ".count))
                return code != "0"
            }
            return matches(first, #"^(stopped after|killed \(|Couldn['’]t start)"#)
        }
        if name == "get_problems" {
            if let r = first.range(of: #"^\d+ errors?,"#, options: .regularExpression) {
                let digits: String = String(first[r].prefix { $0.isNumber })
                return (Int(digits) ?? 0) > 0
            }
            return first.contains("failed (exit code")
        }
        return matches(first, #"^(The tool failed|Couldn['’]t |Error:)"#)
    }

    static func short(_ s: String, _ max: Int = 140) -> String {
        let one: String = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return one.count > max ? String(one.prefix(max - 1)) + "…" : one
    }

    static func argText(_ call: ToolCall) -> String {
        for k in ["command", "path", "query", "pattern", "url", "name", "task", "host"] {
            let v: String = call.arg(k).trimmingCharacters(in: .whitespacesAndNewlines)
            if !v.isEmpty { return v }
        }
        return ""
    }

    static func absPath(_ p: String, root: String?) -> String {
        let t: String = p.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return "" }
        let expanded: String = (t as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") { return (expanded as NSString).standardizingPath }
        let base: String = root ?? NSHomeDirectory()
        return ((base as NSString).appendingPathComponent(expanded) as NSString).standardizingPath
    }

    static func tail(_ text: String, lines: Int = 40, chars: Int = 3000) -> String {
        let all: [Substring] = text.split(separator: "\n", omittingEmptySubsequences: false)
        var t: String = all.suffix(lines).joined(separator: "\n")
        while t.hasSuffix("\n") || t.hasSuffix(" ") { t.removeLast() }
        if t.count > chars { t = "…" + String(t.suffix(chars)) }
        return t
    }

    /// Max effort's review found problems (anything but "Looks good").
    static func reviewFoundProblems(_ notes: String) -> Bool {
        let t: String = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty || matches(t, #"^(Stopped\.|The helper (stopped|finished without|needs a task))"#, [.regularExpression, .caseInsensitive]) { return false }
        return !matches(t, #"^[\W_]*(looks good|lgtm|no (issues|problems|bugs)|nothing (to fix|found|wrong))\b"#, [.regularExpression, .caseInsensitive])
    }

    // MARK: relevant code

    struct Location: Equatable { let file: String; let line: Int }

    static func errorLocations(_ text: String) -> [Location] {
        var out: [Location] = []
        func add(_ file: String, _ line: Int) {
            guard !file.isEmpty, line > 0, !file.hasPrefix("http:"), !file.hasPrefix("https:"), !file.hasPrefix("file:") else { return }
            if !out.contains(Location(file: file, line: line)) { out.append(Location(file: file, line: line)) }
        }
        let ns = text as NSString
        let all = NSRange(location: 0, length: ns.length)
        let pattern: String = #"(?:^|[\s('"`\[])((?:~/|\.{1,2}/|/)?(?:[\w@.+-]+/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9})[:(](\d+)(?:[:,]\d+)?"#
        if let re = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) {
            for m in re.matches(in: text, range: all) {
                add(ns.substring(with: m.range(at: 1)), Int(ns.substring(with: m.range(at: 2))) ?? 0)
            }
        }
        if let py = try? NSRegularExpression(pattern: #"File "([^"]+)", line (\d+)"#) {
            for m in py.matches(in: text, range: all) {
                add(ns.substring(with: m.range(at: 1)), Int(ns.substring(with: m.range(at: 2))) ?? 0)
            }
        }
        return Array(out.prefix(20))
    }

    struct Excerpt { let file: String; let start: Int; let end: Int; let text: String; let lang: String }

    private static let sensitive: String = #"(^|/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|\.git-credentials)$"#
    private static let langs: [String: String] = [
        "ts": "ts", "tsx": "tsx", "js": "js", "jsx": "jsx", "mjs": "js", "cjs": "js", "swift": "swift", "py": "python",
        "rs": "rust", "go": "go", "rb": "ruby", "java": "java", "kt": "kotlin", "c": "c", "h": "c", "m": "objc",
        "mm": "objc", "cpp": "cpp", "cc": "cpp", "hpp": "cpp", "cs": "csharp", "php": "php", "sh": "sh", "zsh": "sh",
        "json": "json", "yml": "yaml", "yaml": "yaml", "toml": "toml", "md": "markdown", "html": "html", "css": "css",
        "sql": "sql", "dart": "dart",
    ]

    /// A small text file the brief may quote: not a key or .env, not in build output, inside the project.
    private static func quotable(_ abs: String, root: String?) -> String? {
        if matches(abs, sensitive, [.regularExpression, .caseInsensitive]) { return nil }
        if matches(abs, #"/(node_modules|\.git|\.build|build|dist|DerivedData)/"#) { return nil }
        if let root, !(abs == root || abs.hasPrefix(root.hasSuffix("/") ? root : root + "/")) { return nil }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: abs, isDirectory: &isDir), !isDir.boolValue else { return nil }
        let size: Int = ((try? FileManager.default.attributesOfItem(atPath: abs))?[.size] as? Int) ?? 0
        guard size <= 1_000_000, let text = try? String(contentsOfFile: abs, encoding: .utf8), !text.contains("\0") else { return nil }
        return text
    }

    static func shown(_ abs: String, root: String?) -> String {
        if let root, abs.hasPrefix(root + "/") { return String(abs.dropFirst(root.count + 1)) }
        return abs
    }

    /// Around each error location first, then the changed files, then the files read, within `budget` characters.
    static func codeExcerpts(_ log: Log, budget: Int = 12_000) -> (excerpts: [Excerpt], omitted: [String]) {
        let root: String? = log.root
        var locs: [String: [Int]] = [:]
        var order: [String] = []
        for e in log.errors {
            for l in errorLocations(e.text) {
                let abs: String = absPath(l.file, root: root)
                locs[abs, default: []].append(l.line)
                if !order.contains(abs) { order.append(abs) }
            }
        }
        for f in log.changed + log.read where !order.contains(f) { order.append(f) }
        var excerpts: [Excerpt] = []
        var omitted: [String] = []
        var left: Int = budget
        for abs in order {
            guard let text = quotable(abs, root: root) else { continue }
            let lines: [Substring] = text.split(separator: "\n", omittingEmptySubsequences: false)
            let ext: String = (abs as NSString).pathExtension.lowercased()
            let lang: String = langs[ext] ?? ""
            var windows: [(Int, Int)] = []
            if let at = locs[abs], !at.isEmpty {
                for n in at.sorted() {
                    let s: Int = max(1, n - 10)
                    let e: Int = min(lines.count, n + 10)
                    if let last = windows.last, s <= last.1 + 2 {
                        windows[windows.count - 1].1 = max(last.1, e)
                    } else {
                        windows.append((s, e))
                    }
                }
            } else {
                let count: Int = log.changed.contains(abs) ? 80 : 40
                windows.append((1, min(lines.count, count)))
            }
            var added: Bool = false
            for (s, e) in windows.prefix(4) where s <= e {
                var body: String = lines[(s - 1)..<e].joined(separator: "\n")
                if body.count > 4000 { body = String(body.prefix(4000)) + "\n…(trimmed)" }
                if body.count + 80 > left { break }
                left -= body.count + 80
                excerpts.append(Excerpt(file: shown(abs, root: root), start: s, end: e, text: body, lang: lang))
                added = true
            }
            if !added { omitted.append(shown(abs, root: root)) }
        }
        return (excerpts, omitted)
    }

    /// "Ingle · Swift (SwiftPM) (git branch main)".
    static func projectLine(_ root: String?, branch: String?) -> String {
        guard let root else { return "No project folder (a chat outside a project)." }
        let fm = FileManager.default
        func has(_ f: String) -> Bool { fm.fileExists(atPath: (root as NSString).appendingPathComponent(f)) }
        let names: [String] = (try? fm.contentsOfDirectory(atPath: root)) ?? []
        var stack: [String] = []
        if has("package.json") { stack.append(has("tsconfig.json") ? "Node.js/TypeScript" : "Node.js/JavaScript") }
        if has("Package.swift") { stack.append("Swift (SwiftPM)") }
        if names.contains(where: { $0.hasSuffix(".xcodeproj") || $0.hasSuffix(".xcworkspace") }) { stack.append("Xcode project") }
        if has("Cargo.toml") { stack.append("Rust") }
        if has("go.mod") { stack.append("Go") }
        if has("pyproject.toml") || has("requirements.txt") || has("setup.py") { stack.append("Python") }
        if has("Gemfile") { stack.append("Ruby") }
        if has("pom.xml") || has("build.gradle") || has("build.gradle.kts") { stack.append("JVM (Gradle/Maven)") }
        let b: String = (branch ?? "").isEmpty ? "" : " (git branch \(branch ?? ""))"
        let what: String = stack.isEmpty ? "stack not detected" : stack.joined(separator: ", ")
        return "\((root as NSString).lastPathComponent) · \(what)\(b)"
    }

    // MARK: the brief

    private static func fence(_ text: String, _ lang: String = "") -> String {
        let ticks: String = text.contains("```") ? "````" : "```"
        var body: String = text
        while body.hasSuffix("\n") { body.removeLast() }
        return "\(ticks)\(lang)\n\(body)\n\(ticks)"
    }

    static func isoDate(_ d: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    /// The self-contained Markdown brief. Same layout as buildBrief in escalation.ts.
    static func buildBrief(goal rawGoal: String, project: String, model: String, reasons: [String], log: Log,
                           excerpts: [Excerpt], omitted: [String], lastReply: String) -> String {
        let trimmed: String = rawGoal.trimmingCharacters(in: .whitespacesAndNewlines)
        let goal: String = trimmed.isEmpty ? "(no request text)" : trimmed
        let firstLine: String = goal.split(separator: "\n").first.map(String.init) ?? goal
        var out: [String] = ["# Help wanted: \(short(firstLine, 80))", "",
            "_A brief prepared by Ingle on \(isoDate()). A local model (\(model)) worked on this and couldn’t finish it. Please find the cause and suggest a fix._",
            "", "## Goal", "", goal.count > 2000 ? String(goal.prefix(2000)) + "…" : goal, "", "## Project", "", project]
        if !reasons.isEmpty {
            out += ["", "## Why it stopped", ""]
            out += reasons.map { "- " + $0 }
        }
        if !log.attempts.isEmpty {
            out += ["", "## What was tried", ""]
            let list: [String] = log.attempts.map { a in
                "\(a.tool) `\(a.what.replacingOccurrences(of: "`", with: "'"))` → \(a.outcome.words)"
            }
            let keep: [String] = list.count > 30
                ? Array(list.prefix(5)) + ["… \(list.count - 25) more steps …"] + Array(list.suffix(20))
                : list
            for (i, l) in keep.enumerated() { out.append(l.hasPrefix("…") ? l : "\(i + 1). \(l)") }
        }
        if !log.errors.isEmpty {
            out += ["", "## Errors"]
            for e in log.errors {
                out += ["", "From `\(e.what.replacingOccurrences(of: "`", with: "'"))`:", "", fence(e.text, "text")]
            }
        }
        if !excerpts.isEmpty {
            out += ["", "## Relevant code"]
            for x in excerpts { out += ["", "### \(x.file) (lines \(x.start)–\(x.end))", "", fence(x.text, x.lang)] }
            if !omitted.isEmpty { out += ["", "_Left out to keep this short: \(omitted.joined(separator: ", "))._"] }
        }
        let last: String = lastReply.trimmingCharacters(in: .whitespacesAndNewlines)
        if !last.isEmpty {
            out += ["", "## The local model’s last words", ""]
            out += short(last, 800).split(separator: "\n", omittingEmptySubsequences: false).map { "> " + $0 }
        }
        return out.joined(separator: "\n") + "\n"
    }

    /// A short "what was tried", added as context when the chat continues on the hard-jobs model.
    static func flintSummary(model: String, reasons: [String], log: Log) -> String {
        let steps: String = log.attempts.suffix(12).map { "- \($0.tool) `\($0.what)` → \($0.outcome.words)" }.joined(separator: "\n")
        var err: String = ""
        if let e = log.errors.last { err = "\nThe last error (\(e.what)):\n\(tail(e.text, lines: 15, chars: 1200))" }
        return "Ingle: \(model) tried this and couldn’t finish. \(reasons.joined(separator: " "))\nWhat was tried:\n\(steps)\(err)\n"
            + "Take a fresh look: re-read the relevant code, find the real cause, then fix it and check it. Don’t repeat what already failed."
    }

    // MARK: scrubbing

    /// Saved secrets' values → {{secret:name}}, then anything else that looks like a key → [redacted …].
    static func scrubSecrets(_ text: String, scrubber: Secrets.Scrubber?) -> String {
        var out: String = scrubber?.scrub(text) ?? text
        let found: [DetectedSecret] = Secrets.detect(out).sorted { $0.value.count > $1.value.count }
        for f in found { out = out.replacingOccurrences(of: f.value, with: "[redacted \(f.kind)]") }
        return out
    }

    /// Home folder → ~, the username on its own → <user>.
    static func redactPaths(_ text: String, home: String = NSHomeDirectory(), user: String = NSUserName()) -> String {
        var out: String = text
        if home.count > 1 { out = out.replacingOccurrences(of: home, with: "~") }
        if user.count >= 3 {
            let esc: String = NSRegularExpression.escapedPattern(for: user)
            out = out.replacingOccurrences(of: "(?<![A-Za-z0-9])\(esc)(?![A-Za-z0-9])", with: "<user>", options: .regularExpression)
        }
        return out
    }

    // MARK: saving

    static func slug(_ text: String) -> String {
        var s: String = text.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        s = String(s.prefix(48)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return s.isEmpty ? "brief" : s
    }

    /// <project>/.ingle/briefs, or ~/.ingle/briefs outside a project.
    static func briefsDir(project: String?) -> String {
        if let project { return (project as NSString).appendingPathComponent(".ingle/briefs") }
        return IngleHome.url.appendingPathComponent("briefs").path
    }

    /// Saves as YYYY-MM-DD-<slug>.md (-2, -3… if taken), or overwrites `existing` in the same folder.
    static func saveBrief(dir: String, goal: String, text: String, existing: String?) -> String? {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var file: String = ""
        if let existing, (existing as NSString).deletingLastPathComponent == dir { file = existing }
        if file.isEmpty {
            let first: String = goal.split(separator: "\n").first.map(String.init) ?? goal
            let base: String = "\(isoDate())-\(slug(first))"
            file = (dir as NSString).appendingPathComponent(base + ".md")
            var n: Int = 2
            while fm.fileExists(atPath: file) {
                file = (dir as NSString).appendingPathComponent("\(base)-\(n).md")
                n += 1
            }
        }
        do { try text.write(toFile: file, atomically: true, encoding: .utf8) } catch { return nil }
        return file
    }
}

// MARK: - The card and the brief sheet

/// "This might need a stronger model" under a stuck run's last reply: Try with Flint, Prepare a brief, Keep going.
struct EscalationCardView: View {
    @Environment(ChatStore.self) private var store
    let chat: Conversation.ID
    let messageID: ChatMessage.ID
    let card: EscalationCard
    let busy: Bool
    @State private var showBrief = false

    var body: some View {
        Group {
            if let chosen = card.chosen {
                HStack(spacing: 8) {
                    Image(systemName: chosen == "flint" ? "bolt" : "checkmark").font(.system(size: 11))
                    Text(chosen == "flint" ? "Continued with \(card.flint ?? Prefs.hardName)." : "Kept going with this model.")
                    Spacer(minLength: 8)
                    Button { showBrief = true } label: { Label("Brief", systemImage: "doc.text") }
                        .help("A Markdown brief to paste into a cloud AI yourself. Nothing is sent anywhere.")
                }
                .font(.system(size: 12))
                .foregroundStyle(Ember.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles").foregroundStyle(Ember.accent)
                        Text(Escalation.cardTitle).font(.system(size: 13, weight: .semibold)).foregroundStyle(Ember.text)
                    }
                    ForEach(card.reasons, id: \.self) { r in
                        Text("• " + r.replacingOccurrences(of: "`", with: ""))
                            .font(.system(size: 12)).foregroundStyle(Ember.secondary)
                    }
                    HStack(spacing: 8) {
                        if let flint = card.flint {
                            Button { store.tryWithFlint(chat, messageID) } label: { Label("Try with \(flint)", systemImage: "bolt") }
                                .buttonStyle(.borderedProminent)
                                .disabled(busy)
                                .help("Carry on in this chat with \(flint), the bigger local model, told what was already tried")
                        }
                        Button { showBrief = true } label: { Label("Prepare a brief for a cloud AI", systemImage: "doc.text") }
                            .help("A Markdown brief to paste into a cloud AI yourself. Nothing is sent anywhere.")
                        Button("Keep going") { store.keepGoing(chat, messageID) }
                    }
                    .controlSize(.regular)
                    Text("Nothing leaves your Mac unless you copy it yourself.")
                        .font(.system(size: 11)).foregroundStyle(Ember.tertiary)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Ember.accent.opacity(0.1)))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Ember.accent.opacity(0.35)))
            }
        }
        .sheet(isPresented: $showBrief) {
            BriefSheet(chat: chat, messageID: messageID, redact: card.redact ?? true)
        }
    }
}

/// The full brief to read and Copy. Saved as .ingle/briefs/YYYY-MM-DD-<slug>.md. Nothing is sent anywhere.
struct BriefSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let chat: Conversation.ID
    let messageID: ChatMessage.ID
    @State var redact: Bool
    @State private var text = ""
    @State private var file: String?
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text").foregroundStyle(Ember.accent)
                Text("Brief for a cloud AI").font(.system(size: 15, weight: .semibold))
            }
            Text("Nothing is sent anywhere. Read it, copy it, and paste it into the assistant you choose. Saved secrets are replaced with placeholders.")
                .font(.system(size: 12)).foregroundStyle(Ember.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Hide my home folder and username", isOn: $redact)
                .onChange(of: redact) { load() }
            ScrollView {
                Text(text)
                    .font(.system(size: 11.5, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .background(RoundedRectangle(cornerRadius: 8).fill(Ember.code))
            HStack(spacing: 8) {
                if let file {
                    Button { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: file)]) } label: {
                        Label("Saved as " + file.replacingOccurrences(of: NSHomeDirectory(), with: "~"), systemImage: "folder")
                            .lineLimit(1).truncationMode(.middle)
                    }
                    .buttonStyle(.link)
                    .help("Show the saved brief in Finder")
                }
                Spacer(minLength: 8)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.6))
                        copied = false
                    }
                } label: { Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 720, height: 560)
        .onAppear { load() }
    }

    private func load() {
        guard let r = store.prepareBrief(chat, messageID, redact: redact) else { return }
        text = r.text
        file = r.file
    }
}
