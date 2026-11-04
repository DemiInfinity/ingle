import Foundation

/// Local models pick tools far less reliably as the list grows (≈85% right with 5 tools, ≈45% with 20,
/// RAG-MCP 2025). So each turn only offers the tools the message plausibly needs; the rest stay out.
@MainActor
enum ToolSelection {
    static func name(_ def: [String: Any]) -> String {
        (def["function"] as? [String: Any])?["name"] as? String ?? ""
    }

    private static func mentions(_ text: String, _ words: [String]) -> Bool {
        words.contains { text.contains($0) }
    }

    /// Words that suggest each optional group is needed.
    static func wantsMemoryEditing(_ t: String) -> Bool {
        mentions(t, ["remember", "memory", "memories", "forget", "about me", "my preference", "note that", "update what you know"])
    }
    static func wantsPastChats(_ t: String) -> Bool {
        mentions(t, ["chat", "conversation", "earlier", "last time", "yesterday", "last week", "discussed", "we talked", "you said", "i said", "before"])
    }
    static func wantsHelp(_ t: String) -> Bool {
        mentions(t, ["ingle", "setting", "how do i", "how can i", "where is", "shortcut", "menu bar", "this app", "feature", "what can you"])
    }
    static func wantsHelper(_ t: String) -> Bool {
        mentions(t, ["research", "compare", "look into", "investigate", "summarise", "summarize", "find out", "dig into", "go through", "sub-agent", "subagent", "helper", "in parallel"])
    }
    static func wantsSecrets(_ t: String) -> Bool {
        t.range(of: #"secret|password|passcode|token|api[ _-]?key|credential|log ?in|auth|sign ?in"#, options: .regularExpression) != nil
    }
    static func wantsMCP(_ t: String) -> Bool {
        if mentions(t, ["mcp"]) { return true }
        let names = MCPManager.shared.servers.map { $0.name.lowercased() }
        return names.contains { t.contains($0) }
    }

    /// Drops optional tools this message doesn't call for. Core tools for the turned-on switches always stay.
    static func filter(_ tools: [[String: Any]], lastUserText: String) -> [[String: Any]] {
        let t = lastUserText.lowercased()
        return tools.filter { def in
            switch name(def) {
            case "memory_read", "memory_rewrite", "memory_forget": return wantsMemoryEditing(t)
            case "chat_list", "chat_search", "chat_read": return wantsPastChats(t)
            case "ingle_help": return wantsHelp(t)
            case "delegate": return wantsHelper(t)
            case "report_read": return !ReportStore.all().isEmpty
            case "report_search": return !ReportStore.all().isEmpty
            case "mcp_tools", "mcp_call": return wantsMCP(t)
            case "ssh_command": return SSH.mentioned(in: t)
            case "secret_list": return wantsSecrets(t) && !Secrets.all().isEmpty
            default: return true
            }
        }
    }
}
