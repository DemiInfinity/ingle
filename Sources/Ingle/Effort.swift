import Foundation

/// Effort levels: how hard the assistant tries. One table, kept in step with
/// Extensions/vscode/src/engine/effort.ts — change both together (and the prompt facts, HelpTopics and
/// docs/agent-loop.md). test/effort.test.ts checks the TypeScript copy.
enum EffortLevel: String, CaseIterable, Identifiable {
    case low, medium, high, max

    var id: String { rawValue }

    enum Filtering { case strict, normal, relaxed }

    var label: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .max: return "Max"
        }
    }

    /// Ollama `think`: nil = off, otherwise the level for models that take one (others get `true`).
    var thinkLevel: String? {
        switch self {
        case .low: return nil
        case .medium: return "low"
        case .high: return "medium"
        case .max: return "high"
        }
    }

    /// Line added to the system prompt ("" = none).
    var promptLine: String {
        switch self {
        case .low: return "Answer directly in as few steps as possible."
        case .medium: return ""
        case .high: return "Investigate before changing anything: read the related code, then check your work."
        case .max: return "Plan first, investigate fully, verify with the project's checks, then review your own changes before finishing."
        }
    }

    /// strict: fewer optional tools; normal: as before; relaxed: the helper is always offered too.
    var filtering: Filtering {
        switch self {
        case .low: return .strict
        case .medium: return .normal
        case .high, .max: return .relaxed
        }
    }

    /// Run the project's check command once after changing files, before finishing.
    var verify: Bool { self == .high || self == .max }
    /// A short plan message first.
    var plan: Bool { self == .max }
    /// A read-only helper reviews the changes at the end.
    var review: Bool { self == .max }
    /// The nth identical call is skipped.
    var repeatLimit: Int { verify ? 4 : 3 }
    /// Stop after this many skipped calls.
    var stuckLimit: Int { verify ? 6 : 4 }

    /// Tooltip / help text (same as `help` in effort.ts).
    var help: String {
        switch self {
        case .low: return "Low: quick answers, no thinking, fewest tools."
        case .medium: return "Medium: thinks a little. Good for everyday work."
        case .high: return "High: thinks more, reads the related code first, and runs the project’s checks after editing."
        case .max: return "Max: shows a plan first, thinks hardest, runs the checks, and a helper reviews the changes at the end."
        }
    }

    /// Low → Medium → High → Max → Low (⌘⇧E).
    var next: EffortLevel {
        let all = EffortLevel.allCases
        let i: Int = all.firstIndex(of: self) ?? 0
        return all[(i + 1) % all.count]
    }

    /// Default for an assistant: what Settings → Models says, else Ember Medium, Flint High, others Medium.
    static func defaultFor(model: String) -> EffortLevel {
        if model == Prefs.hardModel { return EffortLevel(rawValue: Prefs.str(Prefs.K.hardEffort)) ?? .high }
        if model == Prefs.dailyModel { return EffortLevel(rawValue: Prefs.str(Prefs.K.dailyEffort)) ?? .medium }
        return .medium
    }

    /// Models whose `think` takes "low" | "medium" | "high" (Ollama: gpt-oss). Others take true/false.
    static func takesThinkLevels(_ model: String) -> Bool {
        model.lowercased().contains("gpt-oss")
    }

    /// What to send as Ollama's `think` for this level and model.
    func think(for model: String) -> OllamaThink {
        guard let level = thinkLevel else { return .off }
        return EffortLevel.takesThinkLevels(model) ? .level(level) : .on
    }

    // MARK: The project's check command

    struct CheckCommand { let command: String; let dir: String; let why: String }

    /// The check command for one folder, or nil. Order: package.json test → lint, Package.swift, Cargo.toml,
    /// go.mod, a Makefile with a test target, Python with pytest. Same as checkCommandIn in effort.ts.
    static func checkCommand(in dir: String) -> CheckCommand? {
        let fm = FileManager.default
        func has(_ f: String) -> Bool { fm.fileExists(atPath: (dir as NSString).appendingPathComponent(f)) }
        func text(_ f: String) -> String { (try? String(contentsOfFile: (dir as NSString).appendingPathComponent(f), encoding: .utf8)) ?? "" }
        if has("package.json") {
            var scripts: [String: Any] = [:]
            if let data = text("package.json").data(using: .utf8),
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let s = obj["scripts"] as? [String: Any] { scripts = s }
            let runner: String = has("pnpm-lock.yaml") ? "pnpm" : (has("yarn.lock") ? "yarn" : "npm")
            if let test = scripts["test"] as? String, !test.trimmingCharacters(in: .whitespaces).isEmpty,
               !test.contains("no test specified") {
                return CheckCommand(command: "\(runner) test", dir: dir, why: "package.json test script")
            }
            if let lint = scripts["lint"] as? String, !lint.trimmingCharacters(in: .whitespaces).isEmpty {
                return CheckCommand(command: "\(runner) run lint", dir: dir, why: "package.json lint script")
            }
        }
        if has("Package.swift") { return CheckCommand(command: "swift build", dir: dir, why: "Package.swift") }
        if has("Cargo.toml") { return CheckCommand(command: "cargo check", dir: dir, why: "Cargo.toml") }
        if has("go.mod") { return CheckCommand(command: "go test ./...", dir: dir, why: "go.mod") }
        if let make = ["Makefile", "makefile", "GNUmakefile"].first(where: has),
           text(make).range(of: #"(?m)^test\s*:"#, options: .regularExpression) != nil {
            return CheckCommand(command: "make test", dir: dir, why: "Makefile test target")
        }
        let pytest: Bool = has("pytest.ini") || has("conftest.py")
            || text("pyproject.toml").contains("[tool.pytest")
            || text("setup.cfg").range(of: #"\[(tool:)?pytest\]"#, options: .regularExpression) != nil
            || text("tox.ini").contains("[pytest]")
        if pytest { return CheckCommand(command: "pytest", dir: dir, why: "pytest config") }
        return nil
    }

    /// Walks up from a file or folder to the nearest folder with a check command. Stops at `stopAt` (e.g. the
    /// workspace) if given, and never goes above the home folder or to /. Same as detectCheckCommand in effort.ts.
    static func detectCheckCommand(from start: String, stopAt: String? = nil) -> CheckCommand? {
        let home: String = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
        var url = URL(fileURLWithPath: (start as NSString).expandingTildeInPath).standardizedFileURL
        var isDir: ObjCBool = false
        if !(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue) {
            url = url.deletingLastPathComponent()
        }
        let stop: String? = stopAt.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL.path }
        for _ in 0..<40 {
            let dir: String = url.path
            if dir == home || dir == "/" { return nil }
            if let found = checkCommand(in: dir) { return found }
            if let stop, dir == stop { return nil }
            url = url.deletingLastPathComponent()
        }
        return nil
    }

    /// Name of the built-in verify command (shown in nudges and the ⚠ chip).
    static let verifyName = "verify"

    /// The built-in "verify after editing" command for High/Max, in the same shape as a user command so
    /// CommandTracker enforces it (then_run, nudges, ⚠ chips). Same as verifyCommand in effort.ts.
    static func verifyCommand(_ check: CheckCommand) -> IngleCommand {
        IngleCommand(
            name: verifyName,
            description: "Effort: run the project's checks after editing (\(check.why))",
            when: [], mustUse: [], neverUse: [],
            thenRun: check.command, enabled: true,
            body: "Run it once in \(check.dir) (run_command with cwd \"\(check.dir)\") after your last change, and fix what it reports.",
            file: URL(fileURLWithPath: check.dir))
    }

    /// The chip when High/Max changed files but no check command could be found.
    static let verifySkippedChip = "verify skipped: no check command found"

    /// The question asked of the model for Max's plan step (not saved in the chat).
    static let planRequest = "Ingle: before doing anything, write a short plan for this request: 2–6 numbered steps, one line each. Don't do the work yet and don't call tools. If the request is simple, one line is enough."

    static let planHeading = "**Plan**"
    static let reviewHeading = "**Review**"

    /// The task given to the read-only helper that reviews Max's changes. Same as reviewTask in effort.ts.
    static func reviewTask(request: String, files: [String], diff: String) -> String {
        let list: String = files.map { "- " + $0 }.joined(separator: "\n")
        let d: String = diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "\n\n(No git diff available — read the files.)"
            : "\n\nThe diff:\n```diff\n\(String(diff.prefix(12_000)))\n```"
        return "Review the changes just made for this request: \"\(String(request.prefix(1500)))\".\nChanged files:\n\(list)\(d)\n\nLook for bugs, missed cases, and anything that doesn't match the request. Reply with a few short notes (most important first), or \"Looks good\" if you find nothing. Don't rewrite the code."
    }

    /// `git diff` for these files (grouped by repository), capped; "" when they aren't in a repo. Read-only, run by
    /// Ingle itself for Max's review — not a model tool call. Same as gitDiff in chatEngine.ts.
    static func gitDiff(_ files: [String]) async -> String {
        await Task.detached { () -> String in
            func git(_ cwd: String, _ args: [String]) -> String {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                p.arguments = args
                p.currentDirectoryURL = URL(fileURLWithPath: cwd)
                let out = Pipe()
                p.standardOutput = out
                p.standardError = FileHandle.nullDevice
                do { try p.run() } catch { return "" }
                let data: Data = out.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                return p.terminationStatus == 0 ? (String(data: data, encoding: .utf8) ?? "") : ""
            }
            var byRepo: [String: [String]] = [:]
            var order: [String] = []
            for f in files {
                let dir: String = (f as NSString).deletingLastPathComponent
                let top: String = git(dir, ["rev-parse", "--show-toplevel"]).trimmingCharacters(in: .whitespacesAndNewlines)
                if top.isEmpty { continue }
                if byRepo[top] == nil { order.append(top) }
                byRepo[top, default: []].append(f)
            }
            var out = ""
            for top in order {
                let list: [String] = byRepo[top] ?? []
                out += git(top, ["diff", "HEAD", "--"] + list)
                // New files aren't in `git diff HEAD` until added; show them as plain text.
                for f in list where git(top, ["ls-files", "--", f]).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let body: String = (try? String(contentsOfFile: f, encoding: .utf8)) ?? ""
                    out += "\n--- new file \(f)\n" + String(body.prefix(4000))
                }
                if out.count > 12_000 { break }
            }
            return String(out.prefix(12_000))
        }.value
    }
}

/// Ollama's `think`: off, on, or a level for models that take one (gpt-oss).
enum OllamaThink: Equatable {
    case off, on
    case level(String)

    var isOn: Bool { self != .off }

    /// The JSON value for the request body.
    var json: Any {
        switch self {
        case .off: return false
        case .on: return true
        case .level(let l): return l
        }
    }
}

// MARK: Max's plan and review (kept here so ChatStore's loop only calls them)

extension ChatStore {
    /// Max's plan step: asks for a short plan (no tools) and shows it as its own message. Returns false if stopped.
    /// The plan stays in the history, so the work that follows starts from it. Same as writePlan in chatEngine.ts.
    func writePlan(_ id: Conversation.ID, model: String, history: [[String: Any]], effort: EffortLevel) async -> Bool {
        guard let i = index(id) else { return false }
        let plan = ChatMessage(role: .assistant, content: "", model: model)
        conversations[i].messages.append(plan)
        activity = "Planning…"
        var text = ""
        do {
            let messages: [[String: Any]] = history + [["role": "user", "content": EffortLevel.planRequest]]
            let stream = OllamaClient().chat(model: model, messages: messages, tools: nil, think: effort.think(for: model),
                                             numCtx: Prefs.contextLength(for: model), keepAlive: Prefs.keepAlive)
            for try await chunk in stream { text += chunk.content }
        } catch {
            text = ""
        }
        activity = nil
        let body: String = ThinkSplitter.split(text, extra: "").body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let j = index(id), let k = conversations[j].messages.firstIndex(where: { $0.id == plan.id }) else { return false }
        if Task.isCancelled {
            conversations[j].messages.remove(at: k)
            return false
        }
        if body.isEmpty {
            // No plan came back: carry on without one rather than stopping the work.
            conversations[j].messages.remove(at: k)
            return true
        }
        conversations[j].messages[k].content = EffortLevel.planHeading + "\n\n" + body
        save()
        return true
    }

    /// Max's review: a read-only helper looks at the diff (or the files) and its notes are shown.
    /// Same as reviewChanges in chatEngine.ts.
    func reviewChanges(_ id: Conversation.ID, model: String, web: Bool, commands: [IngleCommand],
                       request: String, files: [String]) async {
        activity = "Reviewing the changes…"
        let diff: String = await EffortLevel.gitDiff(files)
        let task: String = EffortLevel.reviewTask(request: request, files: files, diff: diff)
        let notes: String = await runSubAgent(task: task, model: model, web: web, parent: id, commands: commands)
        activity = nil
        guard !Task.isCancelled, let j = index(id) else { return }
        var note = ChatMessage(role: .assistant, content: EffortLevel.reviewHeading + "\n\n" + notes.trimmingCharacters(in: .whitespacesAndNewlines), model: model)
        note.usedContext = ["helper review"]
        conversations[j].messages.append(note)
        save()
    }
}
