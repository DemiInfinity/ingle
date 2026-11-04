import Foundation

/// "This chat's settings": the state of every switch in the message box and what it means right now, sent with every
/// request so the assistant knows exactly what it can and can't do (and can suggest a better setting).
/// Same meaning as settingsPrompt() in Extensions/vscode/src/engine/prompt.ts — keep them in step.
enum ChatSettingsPrompt {
    @MainActor
    static func block(model: String, effort: EffortLevel, mode: WorkMode, reasoning: Bool, web: Bool,
                      mac: Bool, codeFolder: String?, editor: Bool?) -> String {
        var lines: [String] = [
            "## This chat's settings",
            "The user sets these in the message box; you can't change them. If a different setting would clearly help, say which in one short line.",
        ]
        lines.append("- Assistant: \(ModelNames.display(model)) (\(ModelNames.role(model))).")
        lines.append("- Effort: \(effort.label) — \(effortMeaning(effort))")
        lines.append("- Mode: \(mode.label) — \(withoutLabel(mode.help))")
        lines.append(reasoning
            ? "- Reasoning: On — think before answering, as deeply as the Effort level allows; a context report was prepared first."
            : "- Reasoning: Off — answer directly, without thinking first. For deep research or a hard problem, suggest switching on Reasoning (the brain icon).")
        lines.append(web
            ? "- Web: On — you can search and read web pages (read-only)."
            : "- Web: Off — no web access. If current information is needed, suggest switching on Web.")
        if let codeFolder {
            lines.append("- Chat type: Code mode on \(codeFolder). Mac control isn't available in Code mode.")
        } else {
            lines.append(mac
                ? "- Mac control: On — you can open apps, run AppleScript and take screenshots, each with approval."
                : "- Mac control: Off — you can't control apps or see the screen; the user can switch on the Mac button.")
        }
        let hosts: [String] = SSH.isOn ? SSH.enabledHosts : []
        lines.append(hosts.isEmpty ? "- SSH: Off." : "- SSH: On — hosts: \(hosts.joined(separator: ", ")).")
        if let editor {
            lines.append(editor
                ? "- Editor context: On — you see the user's open file and selection."
                : "- Editor context: Off — the user chose not to share their editor.")
        }
        return lines.joined(separator: "\n")
    }

    /// What each effort level asks of the assistant (thinking is Reasoning's job, not Effort's).
    static func effortMeaning(_ e: EffortLevel) -> String {
        switch e {
        case .low: return "keep it quick: fewest steps and tools."
        case .medium: return "normal care for everyday work."
        case .high: return "read the related code first, and run the project's checks after editing, before finishing."
        case .max: return "plan first as a task list, investigate fully, run the checks, and your changes are reviewed at the end."
        }
    }

    /// "Ask: every file change…" → "every file change…"
    private static func withoutLabel(_ help: String) -> String {
        guard let colon = help.firstIndex(of: ":") else { return help }
        return String(help[help.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
    }
}
