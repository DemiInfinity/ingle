import SwiftUI

/// One item on a chat's task list (update_tasks). Same as TaskItem in Extensions/vscode/src/tools/tasks.ts.
struct TaskItem: Codable, Equatable, Hashable {
    enum Status: String, Codable { case pending, in_progress, done }
    var content: String
    var status: Status
}

/// The task list and plan mode: the rules, kept in step with tasks.ts (tested there in test/workflow.test.ts).
enum TaskList {
    static let maxTasks = 12

    private static let statusWords: [String: TaskItem.Status] = [
        "pending": .pending, "todo": .pending, "to do": .pending, "open": .pending, "not started": .pending,
        "in_progress": .in_progress, "in-progress": .in_progress, "in progress": .in_progress, "inprogress": .in_progress,
        "doing": .in_progress, "active": .in_progress, "current": .in_progress, "started": .in_progress,
        "done": .done, "completed": .done, "complete": .done, "finished": .done,
    ]

    static let badItems = "items must be a list like [{\"content\": \"Read the parser\", \"status\": \"in_progress\"}]."

    /// update_tasks' `items` from the raw call (an array, or JSON text of one). The list, or an error sentence.
    static func parse(_ call: ToolCall) -> Result<[TaskItem], ParseError> {
        var raw: Any? = nil
        if let data = call.raw, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            raw = obj["items"] ?? obj["tasks"] ?? obj["todos"]
        }
        if raw == nil { raw = call.arguments["items"] }
        if let text = raw as? String {
            guard let data = text.data(using: .utf8), let v = try? JSONSerialization.jsonObject(with: data) else {
                return .failure(ParseError(badItems))
            }
            raw = v
        }
        guard let array = raw as? [Any] else { return .failure(ParseError(badItems)) }
        var out: [TaskItem] = []
        for it in array {
            var content = ""
            var status: TaskItem.Status = .pending
            if let s = it as? String {
                content = s
            } else if let o = it as? [String: Any] {
                let c: Any? = o["content"] ?? o["task"] ?? o["title"] ?? o["text"]
                content = c.map { "\($0)" } ?? ""
                let word: String = (o["status"].map { "\($0)" } ?? "").trimmingCharacters(in: .whitespaces).lowercased()
                status = statusWords[word] ?? .pending
            }
            let clean: String = content.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            if !clean.isEmpty { out.append(TaskItem(content: String(clean.prefix(200)), status: status)) }
        }
        if out.isEmpty { return .failure(ParseError("The list is empty. Give at least one item, or leave the list as it is.")) }
        var list: [TaskItem] = Array(out.prefix(maxTasks))
        // One thing at a time: keep the first in-progress item, later ones go back to pending.
        var seen = false
        for k in list.indices where list[k].status == .in_progress {
            if seen { list[k].status = .pending }
            seen = true
        }
        return .success(list)
    }

    struct ParseError: Error { let message: String; init(_ m: String) { message = m } }

    /// What update_tasks tells the model after an update.
    static func result(_ list: [TaskItem]) -> String {
        let done: Int = list.filter { $0.status == .done }.count
        if done == list.count { return "Task list updated: all \(list.count) done. Finish with a short summary for the user." }
        var focus = ""
        if let now = list.first(where: { $0.status == .in_progress }) {
            focus = "Now: \(now.content)."
        } else if let next = list.first(where: { $0.status == .pending }) {
            focus = "Next: \(next.content) (mark it in_progress when you start)."
        }
        return "Task list updated: \(done)/\(list.count) done. \(focus) Update the list as each item is done."
    }

    static func allDone(_ list: [TaskItem]?) -> Bool {
        guard let list, !list.isEmpty else { return true }
        return list.allSatisfy { $0.status == .done }
    }

    /// The list in the system prompt while it isn't finished ("" otherwise).
    static func prompt(_ list: [TaskItem]?) -> String {
        guard let list, !allDone(list) else { return "" }
        let lines: [String] = list.map { t in
            let mark: String = t.status == .done ? "[x]" : (t.status == .in_progress ? "[>]" : "[ ]")
            return mark + " " + t.content
        }
        return "## Your task list (keep it current with update_tasks)\n" + lines.joined(separator: "\n")
    }

    /// A plan reply → a task list: the last numbered list (or the last bulleted one), first item in progress.
    /// [] when there are fewer than 2 steps. Same as tasksFromPlan in tasks.ts.
    static func fromPlan(_ text: String) -> [TaskItem] {
        let clean: String = text.replacingOccurrences(of: #"<think>[\s\S]*?</think>"#, with: "", options: .regularExpression)
        var blocks: [(items: [String], numbered: Int)] = []
        var open = false
        for line in clean.components(separatedBy: "\n") {
            let indented: Bool = line.hasPrefix("  ") || line.hasPrefix("\t")
            let trimmed: String = line.trimmingCharacters(in: .whitespaces)
            let item: String? = indented ? nil : listItem(trimmed)
            if let item {
                if !open { blocks.append((items: [], numbered: 0)); open = true }
                if trimmed.first?.isNumber == true { blocks[blocks.count - 1].numbered += 1 }
                let content: String = item.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
                    .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
                if content.count >= 3 { blocks[blocks.count - 1].items.append(String(content.prefix(200))) }
            } else if !trimmed.isEmpty && !indented {
                open = false
            }
        }
        let pick = blocks.last(where: { $0.numbered >= 2 && $0.items.count >= 2 }) ?? blocks.last(where: { $0.items.count >= 2 })
        guard let pick else { return [] }
        return pick.items.prefix(maxTasks).enumerated().map { i, c in TaskItem(content: c, status: i == 0 ? .in_progress : .pending) }
    }

    /// "1. x", "2) x", "- x", "* x", "• x", "[ ] x" → "x".
    private static func listItem(_ line: String) -> String? {
        guard let r = line.range(of: #"^(\d{1,2}[.)]|[-*•]|\[[ x>]?\])\s+"#, options: .regularExpression) else { return nil }
        let rest: String = String(line[r.upperBound...]).trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? nil : rest
    }

    static let definition: [String: Any] = [
        "type": "function",
        "function": [
            "name": "update_tasks",
            "description": "Keep a short to-do list for a job of 3 or more steps (not for quick questions). Send the whole list each time: mark one item in_progress as you start it and done as soon as it is finished.",
            "parameters": [
                "type": "object",
                "properties": [
                    "items": [
                        "type": "array",
                        "description": "The whole list, in order.",
                        "items": [
                            "type": "object",
                            "properties": [
                                "content": ["type": "string", "description": "One short step, e.g. \"Add a test for empty input\"."],
                                "status": ["type": "string", "enum": ["pending", "in_progress", "done"]],
                            ],
                            "required": ["content", "status"],
                        ] as [String: Any],
                    ] as [String: Any],
                ],
                "required": ["items"],
            ] as [String: Any],
        ] as [String: Any],
    ]

    // MARK: Plan mode

    /// What plan mode offers: reading and searching, the task list and the read-only helper. (get_problems runs the
    /// project's checks here, so it isn't included.)
    static let planModeTools: Set<String> = [
        "list_files", "read_file", "find_files", "search_code", "repo_map", "use_skill", "use_rule", "ingle_help", "mcp_tools",
        "secret_list", "web_search", "web_fetch", "memory_search", "memory_read", "chat_list", "chat_search", "chat_read",
        "report_search", "report_read", "delegate", "update_tasks",
    ]

    static let planModeRefusal = "Plan mode is on: you can only read and search. Don’t change files or run commands. Finish your investigation and end with a numbered plan; the user will approve it or ask for changes."

    static let planModePrompt = "## Plan mode\nThe user switched on plan mode: you can only read and search. Investigate what you need, then end your reply with a plan as a numbered list (one short step per line). Don’t change files or run commands. The user will approve the plan (then you do the work) or reply with changes."

    static let planApproved = "Approved. Go ahead with the plan (it is your task list now): work through it and keep the list current."

    /// How a message typed during a run reads to the model. Same as steerText in steer.ts.
    static func steerText(_ text: String) -> String {
        "(Sent while you were working — take it into account from here.)\n" + text
    }
}

// MARK: Views

/// The task list, pinned under the latest reply: ticks as it goes.
struct TaskListView: View {
    let tasks: [TaskItem]
    let running: Bool

    private var done: Int { tasks.filter { $0.status == .done }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "checklist").font(.system(size: 11))
                Text(done == tasks.count ? "All \(tasks.count) tasks done" : "Tasks")
                    .font(.system(size: 12, weight: done == tasks.count ? .regular : .semibold))
                Spacer()
                Text("\(done)/\(tasks.count)").font(.system(size: 11).monospacedDigit())
            }
            .foregroundStyle(Ember.secondary)
            if done < tasks.count || running {
                ForEach(Array(tasks.enumerated()), id: \.offset) { _, t in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        mark(t.status).frame(width: 14)
                        Text(t.content)
                            .font(.system(size: 12.5, weight: t.status == .in_progress ? .semibold : .regular))
                            .foregroundStyle(t.status == .done ? Ember.secondary : Ember.text)
                            .strikethrough(t.status == .done, color: Ember.tertiary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Ember.surface))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.08)))
    }

    @ViewBuilder private func mark(_ s: TaskItem.Status) -> some View {
        switch s {
        case .done:
            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Ember.accent)
        case .in_progress:
            if running { ProgressView().controlSize(.mini) } else { Circle().fill(Ember.accent).frame(width: 8, height: 8) }
        case .pending:
            Circle().strokeBorder(Ember.tertiary, lineWidth: 1.2).frame(width: 8, height: 8)
        }
    }
}

/// Under the plan reply while plan mode is on: Approve starts the work with the plan as the task list.
struct PlanApproveBar: View {
    let approve: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "list.bullet.clipboard").font(.system(size: 12))
                .foregroundStyle(Ember.accent)
            Text("Plan mode · Approve to start the work with this plan as the task list, or reply to change it.")
                .font(.system(size: 12))
                .foregroundStyle(Ember.text.opacity(0.9))
            Spacer(minLength: 8)
            Button(action: approve) { Label("Approve", systemImage: "checkmark") }
                .buttonStyle(.borderedProminent)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Ember.accent.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Ember.accent.opacity(0.35)))
    }
}
