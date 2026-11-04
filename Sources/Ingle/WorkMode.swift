import SwiftUI

/// Work modes (the Mode pill; ⇧Tab cycles): Ask · Edit · Auto · Plan · Debug, set per chat.
/// Kept in step with Extensions/vscode/src/engine/modes.ts (tested there in test/workflow.test.ts).
enum WorkMode: String, CaseIterable, Identifiable {
    case ask, edit, auto, plan, debug

    var id: String { rawValue }

    var label: String {
        switch self {
        case .ask: return "Ask"
        case .edit: return "Edit"
        case .auto: return "Auto"
        case .plan: return "Plan"
        case .debug: return "Debug"
        }
    }

    var role: String {
        switch self {
        case .ask: return "Asks first"
        case .edit: return "Edits freely"
        case .auto: return "Safe steps auto"
        case .plan: return "Read only"
        case .debug: return "Find the cause"
        }
    }

    var icon: String {
        switch self {
        case .ask: return "hand.raised"
        case .edit: return "pencil"
        case .auto: return "bolt"
        case .plan: return "list.bullet.clipboard"
        case .debug: return "ladybug"
        }
    }

    var help: String {
        switch self {
        case .ask: return "Ask: every file change and command asks first."
        case .edit: return "Edit: file changes inside the project are approved automatically. Commands, anything outside the project, MCP, SSH, Mac control and secrets still ask."
        case .auto: return "Auto: as Edit, plus commands inside the project run without asking, except risky ones (sudo, deleting, git push/reset/clean, network, writes outside the project, secrets)."
        case .plan: return "Plan: the assistant only reads and searches, then ends with a plan to Approve (or change by replying)."
        case .debug: return "Debug: reproduce or locate the failure, state the cause with evidence, then fix and rerun to confirm. Edits are refused until the cause is stated."
        }
    }

    var promptLine: String {
        switch self {
        case .ask: return ""
        case .edit: return "Mode: Edit. Your file changes inside the project are approved automatically; commands and anything outside the project still ask."
        case .auto: return "Mode: Auto. File changes and safe commands inside the project run without asking; risky ones (sudo, deleting, git push, network, anything outside the project) still ask. Stay inside the project."
        case .plan: return TaskList.planModePrompt
        case .debug: return "Mode: Debug. Work in this order: 1) reproduce or locate the failure (run it, or read and search the code); 2) write the cause with its evidence in a line starting \"Cause:\"; 3) fix it; 4) rerun the reproduction or the tests to confirm. Ingle refuses edits until you have done 1 and 2."
        }
    }

    /// ⇧Tab: Ask → Edit → Auto → Plan → Debug → Ask.
    var next: WorkMode {
        let all = WorkMode.allCases
        let i: Int = all.firstIndex(of: self) ?? 0
        return all[(i + 1) % all.count]
    }

    // MARK: Auto-approval

    static func inside(_ root: String?, _ path: String) -> Bool {
        guard let root, !root.isEmpty, !path.isEmpty else { return false }
        let r: String = URL(fileURLWithPath: root).standardizedFileURL.path
        let p: String = URL(fileURLWithPath: path).standardizedFileURL.path
        return p == r || p.hasPrefix(r.hasSuffix("/") ? r : r + "/")
    }

    private static func has(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    /// Why a command must still ask in Auto mode ("" = safe to run without asking). Same as riskyCommand in modes.ts.
    static func riskyCommand(_ command: String, cwd: String, root: String?) -> String {
        let squeezed: String = command.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        // Commands inside `backticks` or $( … ) count as separate commands, so they're checked too.
        let split: String = squeezed.replacingOccurrences(of: "`", with: " ; ").replacingOccurrences(of: "$(", with: " ; ")
        let c: String = " " + split + " "
        guard let root, inside(root, cwd) else { return "it runs outside the project" }
        if has(c, #"\{\{\s*secret:"#) { return "it uses a secret" }
        if has(c, #"[ ;&|(]sudo "#) { return "it uses sudo" }
        if has(c, #"[ ;&|(]rm (-[a-zA-Z]*[rRf][a-zA-Z]* |--recursive|--force)"#) || has(c, #"[ ;&|(]rm -[a-zA-Z]*[rRf]"#) {
            return "it deletes recursively or forcibly (rm -r/-f)"
        }
        if has(c, #"[ ;&|(]git (push|clean)\b"#) || has(c, #"[ ;&|(]git reset .*--hard"#) {
            return "it can lose or publish work (git push / reset --hard / clean)"
        }
        if has(c, #"[ ;&|(](curl|wget|ssh|scp|sftp|rsync|nc|ftp|telnet) "#) { return "it uses the network" }
        if has(c, #"[ ;&|(](npm|yarn|pnpm|cargo|gem|twine|poetry|dotnet|swift package) (publish|push|upload)\b"#) { return "it publishes a package" }
        if has(c, #"[ ;&|(](npm (install|i|add|ci)|yarn add|pnpm (add|install)|pip3? install|brew install|gem install|cargo install|go install|npx) "#) {
            return "it downloads packages"
        }
        if has(c, #"\|\s*(ba|z)?sh\b"#) || has(c, #"[ ;&|(](eval|bash -c|sh -c|zsh -c) "#)
            || has(c, #"[ ;&|(](python3?|node|perl|ruby|php) (-c|-e|--eval) "#) {
            return "it runs code it builds on the fly"
        }
        if has(c, #"[ ;&|(](kill|killall|pkill|shutdown|reboot|launchctl|osascript|diskutil|defaults write|chown) "#) { return "it changes the system" }
        let writes: Bool = has(c, #"(>>?|[ ;&|(](cp|mv|tee|touch|mkdir|ln|chmod|rm|rmdir|dd|install|truncate|unlink) )"#)
        if writes, let re = try? NSRegularExpression(pattern: #"(?:^|[\s=>"'])((?:~|\.\.|/)[^\s"';|&<>()]*)"#) {
            let ns = c as NSString
            for m in re.matches(in: c, range: NSRange(location: 0, length: ns.length)) {
                let t: String = ns.substring(with: m.range(at: 1))
                if t == "/dev/null" || t.hasPrefix("/dev/std") { continue }
                let abs: String = t.hasPrefix("~") ? (t as NSString).expandingTildeInPath
                    : (t.hasPrefix("/") ? t : (cwd as NSString).appendingPathComponent(t))
                if !inside(root, abs) { return "it writes or deletes outside the project" }
            }
        }
        return ""
    }

    /// The note for a call this mode approves without asking ("Auto approved …"), or nil to ask as usual.
    /// Secrets never get here (they always ask). Same as autoApproval in modes.ts.
    func autoApproval(_ call: ToolCall, root: String?) -> String? {
        guard self == .edit || self == .auto, let root else { return nil }
        if !Secrets.names(in: call).isEmpty { return nil }
        switch call.name {
        case "write_file", "edit_file":
            let path: String = call.arg("path")
            let full: String = path.hasPrefix("/") || path.hasPrefix("~") ? Prefs.expand(path) : (root as NSString).appendingPathComponent(path)
            return WorkMode.inside(root, full) ? "Auto approved (\(label) mode): a file change inside the project" : nil
        case "run_command", "get_problems":
            guard self == .auto else { return nil }
            let cwdArg: String = call.arg("cwd")
            let cwd: String = cwdArg.isEmpty ? root : Prefs.expand(cwdArg)
            if !WorkMode.riskyCommand(call.arg("command"), cwd: cwd, root: root).isEmpty { return nil }
            return "Auto approved (Auto mode): a safe command inside the project"
        default:
            return nil
        }
    }
}

// MARK: Debug mode

/// Debug mode's progress in one run: edits wait until the failure is located and its cause stated; after an edit,
/// a rerun must confirm it. Same as DebugState and its functions in modes.ts.
struct DebugState {
    var located = false
    var cause = false
    var edited = false
    var confirmed = false
    var nudges = 0

    private static let looking: Set<String> = ["read_file", "list_files", "find_files", "search_code", "repo_map", "get_problems", "run_command", "delegate",
                                               "outline", "definition", "references", "callers", "callees", "impact", "diagnostics", "read_exhaustively"]
    private static let runs: Set<String> = ["run_command", "get_problems"]
    private static let edits: Set<String> = ["edit_file", "write_file"]

    static let tasks: [TaskItem] = [
        TaskItem(content: "Reproduce or locate the failure", status: .in_progress),
        TaskItem(content: "Find the cause (write \"Cause:\" with the evidence)", status: .pending),
        TaskItem(content: "Fix it", status: .pending),
        TaskItem(content: "Confirm: rerun the reproduction or the tests", status: .pending),
    ]

    static let unconfirmedChip = "⚠ fix not confirmed"

    /// Debug's own task list ticked from what has happened (the model may never call update_tasks). nil when the list
    /// isn't Debug's or nothing changed. Same as debugTick in modes.ts.
    func tick(_ list: [TaskItem]?) -> [TaskItem]? {
        let base: [TaskItem] = DebugState.tasks
        guard let list, list.map(\.content) == base.map(\.content) else { return nil }
        let done: [Bool] = [located, cause, edited, confirmed]
        let first: Int = done.firstIndex(of: false) ?? base.count
        let next: [TaskItem] = base.enumerated().map { i, t in
            TaskItem(content: t.content, status: i < first ? .done : (i == first ? .in_progress : .pending))
        }
        return next == list ? nil : next
    }

    mutating func saw(_ reply: String) {
        if reply.range(of: #"(?i)(^|\n)\s*(\*\*)?(root )?cause(\*\*)?\s*:"#, options: .regularExpression) != nil { cause = true }
    }

    func refusal(_ tool: String) -> String? {
        guard DebugState.edits.contains(tool), !(located && cause) else { return nil }
        let need: String = !located
            ? "first reproduce or locate the failure (run it, or read and search the code), then write the cause with its evidence in a line starting \"Cause:\""
            : "first write the cause with its evidence in a line starting \"Cause:\""
        return "Debug mode: don’t edit yet — \(need). Then fix it."
    }

    mutating func record(_ tool: String) {
        if DebugState.looking.contains(tool) { located = true }
        if DebugState.edits.contains(tool) {
            edited = true
            confirmed = false
        } else if DebugState.runs.contains(tool) && edited {
            confirmed = true
        }
    }

    mutating func finishNudge() -> String? {
        guard edited, !confirmed, nudges < 2 else { return nil }
        nudges += 1
        return "Ingle: before you finish (Debug mode), rerun the reproduction or the tests to confirm the fix (run_command), then finish your answer."
    }
}

// MARK: Views

/// The Mode pill in the message bar, styled like the Model and Effort pills.
struct ModeMenu: View {
    @Environment(ChatStore.self) private var store
    let conversation: Conversation
    var compact = false

    var body: some View {
        let mode: WorkMode = conversation.workModeValue
        // Styled exactly like ModelMenu and EffortMenu: a neutral pill, name in text colour, role in secondary.
        Menu {
            Picker("Mode", selection: Binding(get: { conversation.workModeValue }, set: { store.setWorkMode($0) })) {
                ForEach(WorkMode.allCases) { m in
                    Text("\(m.label) · \(m.role)").tag(m)
                }
            }
            .pickerStyle(.inline)
            Divider()
            Text(mode.help)
            Text("⇧Tab in the message box cycles the modes")
        } label: {
            HStack(spacing: 7) {
                Image(systemName: mode.icon)
                Text(mode.label).foregroundStyle(Ember.text).lineLimit(1)
                if !compact {
                    Text(mode.role).foregroundStyle(Ember.secondary).lineLimit(1)
                }
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Ember.secondary)
            }
            .font(.system(size: 12.5, weight: .medium))
            .padding(.horizontal, compact ? 10 : 14)
            .frame(height: 30)
            .background(Capsule().fill(Color.white.opacity(0.07)))
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Mode: \(mode.help) Click to change; ⇧Tab cycles.")
        .accessibilityLabel("Mode: \(mode.label)")
    }
}
