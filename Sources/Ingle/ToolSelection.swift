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

    /// Code intelligence (task 33b): offered in coding requests that need it — a named symbol (`backticks`, foo(),
    /// snake_case) or words about uses, callers, definitions, changes, errors or big files. Same patterns as
    /// CODE_INTEL_WANTS in toolSelection.ts. `t` is lower-cased.
    private static let namesSymbol = #"`[^`\n]+`|\b[a-z_$][\w$]*\(\)|\b[a-z][a-z0-9]*_[a-z0-9_]+\b"#
    private static let uses = #"\bcall(s|ed|ers?|ing)?\b|\buse[sd]\b|\busages?\b|\breferences?\b|\brefs\b|\bdefin|\bdeclar|\bwhere is\b|\bimpact|\baffect|\bdepend|\brename|\brefactor|\bsignature|\bshared\b"#
    private static let changes = #"\bchang|\bmodif|\bupdat|\bremov|\bdelet|\breplac|\bbreak|\bsafe to\b"#
    static func codeIntelWants(_ name: String, _ t: String) -> Bool {
        let pattern: String
        switch name {
        case "definition", "references", "callers": pattern = uses + "|" + namesSymbol
        case "impact": pattern = uses + "|" + changes + "|" + namesSymbol
        case "callees": pattern = #"\bcallees?\b|what (does|do) .{0,60}\bcall|\bcalls? (into|out)|call (graph|tree|chain)|\bdepend"#
        case "outline": pattern = #"\boutline|\bstructure|\bsymbols?\b|what'?s in|\b(functions|methods|classes|types) in\b|\bskim"#
        case "diagnostics": pattern = #"\berrors?\b|\bdiagnos|type[- ]?(check|error)|\bcompil|\bwarnings?\b|\bbroken\b|\bproblems?\b|squiggl|does it build|\blint"#
        case "read_exhaustively": pattern = #"\blogs?\b|\bhuge\b|\bbig file|\blarge file|\bwhole file|\bentire file|\bevery line|exhaustiv|too (big|long|large)|all of (it|the file|this file)"#
        default: return true
        }
        return t.range(of: pattern, options: .regularExpression) != nil
    }

    /// Under strict filtering (Low effort): tools that are normally offered whenever they're usable need asking for.
    static func strictWants(_ name: String, _ t: String) -> Bool {
        switch name {
        case "report_read", "report_search": return mentions(t, ["report", "research", "earlier"])
        case "repo_map": return mentions(t, ["repo map", "project structure", "overview", "codebase", "architecture"])
        default: return true
        }
    }

    /// Drops optional tools this message doesn't call for. Core tools for the turned-on switches always stay.
    /// `filtering` comes from the effort level: strict (Low) never offers the helper and needs asking for reports;
    /// relaxed (High/Max) always offers the helper. Same as selectTools(strictness:) in toolSelection.ts.
    static func filter(_ tools: [[String: Any]], lastUserText: String, filtering: EffortLevel.Filtering = .normal) -> [[String: Any]] {
        let t = lastUserText.lowercased()
        return tools.filter { def in
            let n: String = name(def)
            if filtering == .strict, !strictWants(n, t) { return false }
            if n == "delegate" {
                switch filtering {
                case .strict: return false
                case .relaxed: return true
                case .normal: return wantsHelper(t)
                }
            }
            switch n {
            case "memory_read", "memory_rewrite", "memory_forget": return wantsMemoryEditing(t)
            case "chat_list", "chat_search", "chat_read": return wantsPastChats(t)
            case "ingle_help": return wantsHelp(t)
            case "delegate": return wantsHelper(t)
            case "report_read": return !ReportStore.all().isEmpty
            case "report_search": return !ReportStore.all().isEmpty
            case "mcp_tools", "mcp_call": return wantsMCP(t)
            case "ssh_command": return SSH.mentioned(in: t)
            case "open_preview": return Preview.wanted(t)
            case "secret_list": return wantsSecrets(t) && !Secrets.all().isEmpty
            case "outline", "definition", "references", "callers", "callees", "impact", "diagnostics", "read_exhaustively":
                return codeIntelWants(n, t)
            default: return true
            }
        }
    }
}
