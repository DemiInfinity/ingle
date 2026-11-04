import Foundation
import Observation

struct ChatMessage: Identifiable, Codable, Equatable {
    enum Role: String, Codable { case user, assistant, tool }

    var id = UUID()
    var role: Role
    var content: String
    var thinking: String = ""
    var model: String?
    var toolCalls: [ToolCall] = []
    var toolName: String?
    var toolTitle: String?
    var toolDetail: String?
    var toolIcon: String?
    var denied = false
    var failed = false
    var tokensPerSecond: Double?
    var seconds: Double?
    var thoughtSeconds: Double?
    var usedContext: [String]?
    /// Images on this message, stored as JPEGs in Application Support/Ingle/images.
    var imageFiles: [String]?
    /// Text read from those images, for models that can't see images.
    var imageText: String?
    /// Set on a summary message: how many earlier messages it replaces when talking to the model.
    var compactedCount: Int?
    /// A reminder Ingle sent the model because a command wasn't obeyed (shown as a small note, not a bubble).
    var nudge: Bool?

    var isRealUser: Bool { role == .user && nudge != true }

    /// The shape Ollama's /api/chat expects for history.
    var ollamaJSON: [String: Any] {
        var m: [String: Any] = ["role": role.rawValue, "content": content]
        if !toolCalls.isEmpty {
            m["tool_calls"] = toolCalls.map { call -> [String: Any] in
                let args: Any = call.raw.flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? call.arguments
                return ["function": ["name": call.name, "arguments": args]]
            }
        }
        if let toolName { m["tool_name"] = toolName }
        return m
    }
}

struct Conversation: Identifiable, Codable, Equatable {
    var id = UUID()
    var title = "New chat"
    var model: String
    var macAccess = false
    var useEditor: Bool?
    var webAccess: Bool?

    var webOn: Bool { webAccess ?? Prefs.webOnByDefault }
    var messages: [ChatMessage] = []
    var updated = Date()
}

struct Attachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let text: String
    /// For images: the stored JPEG (see ImageStore). `text` is empty then.
    var imageFile: String? = nil
}

struct PendingApproval: Identifiable {
    let id = UUID()
    let conversation: Conversation.ID
    let call: ToolCall
    let info: MacTools.Info
}

/// Text handed over from the editor ("Ask Ingle about this"), waiting for the chat view to pick it up.
struct IncomingDraft: Equatable {
    let id = UUID()
    let conversation: Conversation.ID
    let text: String
    let attachment: Attachment?
}

struct ChatSection: Identifiable {
    var id: String { title }
    let title: String
    let items: [Conversation]
}

@MainActor @Observable
final class ChatStore {
    var conversations: [Conversation] = []
    var selection: Conversation.ID?
    var streamingID: Conversation.ID?
    var think = false
    var search = ""
    var pending: PendingApproval?
    /// What the assistant is doing right now ("Search the web…"), shown above the message box.
    var activity: String?
    var incoming: IncomingDraft?
    /// /mcp opens the MCP servers dialog.
    var showMCP = false
    /// A short note under the message box, e.g. after /skill-reload.
    var notice: String?
    /// Skills for the "/" menu; refreshed by /skill-reload.
    var skills: [Skill] = SkillStore.all()

    static weak var current: ChatStore?

    private var task: Task<Void, Never>?
    private var approval: CheckedContinuation<Bool, Never>?
    private var alwaysAllow: [Conversation.ID: Set<String>] = [:]
    private var visionCache: [String: Bool] = [:]
    /// Images produced by the last tool call (read_file on an image), attached to its tool message.
    private var lastToolImages: [String] = []
    private let fileURL: URL

    init() {
        Prefs.register()
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Ingle", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("chats.json")
        load()
        if conversations.isEmpty { newChat() } else { selection = conversations.first?.id }
        ChatStore.current = self
    }

    // MARK: From the editor

    func receiveFromEditor(_ ask: AskRequest) {
        newChat()
        guard let id = selection else { return }
        var attachment: Attachment?
        if let sel = ask.selection, !sel.isEmpty {
            let name = ask.file.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "selection"
            attachment = Attachment(name: "\(name) (selected)", text: sel)
        }
        let text = (ask.text?.isEmpty == false) ? ask.text! : (attachment == nil ? "" : "Can you look at this?")
        incoming = IncomingDraft(conversation: id, text: text, attachment: attachment)
    }

    func setWebAccess(_ on: Bool) {
        guard let id = selection, let i = index(id) else { return }
        conversations[i].webAccess = on
        save()
    }

    func setUseEditor(_ on: Bool) {
        guard let id = selection, let i = index(id) else { return }
        conversations[i].useEditor = on
        save()
    }

    // MARK: Lookup

    var current: Conversation? { conversations.first { $0.id == selection } }

    func index(_ id: Conversation.ID) -> Int? { conversations.firstIndex { $0.id == id } }

    var sections: [ChatSection] {
        let list = search.isEmpty ? conversations : conversations.filter { c in
            c.title.localizedCaseInsensitiveContains(search) ||
            c.messages.contains { $0.content.localizedCaseInsensitiveContains(search) }
        }
        let cal = Calendar.current
        var today: [Conversation] = [], yesterday: [Conversation] = [], week: [Conversation] = [], older: [Conversation] = []
        for c in list.sorted(by: { $0.updated > $1.updated }) {
            if cal.isDateInToday(c.updated) { today.append(c) }
            else if cal.isDateInYesterday(c.updated) { yesterday.append(c) }
            else if c.updated > Date().addingTimeInterval(-7 * 86_400) { week.append(c) }
            else { older.append(c) }
        }
        return [ChatSection(title: "Today", items: today), ChatSection(title: "Yesterday", items: yesterday),
                ChatSection(title: "Previous 7 days", items: week), ChatSection(title: "Older", items: older)]
            .filter { !$0.items.isEmpty }
    }

    func meta(for c: Conversation) -> String {
        let when: String
        if abs(c.updated.timeIntervalSinceNow) < 60 {
            when = "just now"
        } else {
            let f = RelativeDateTimeFormatter()
            f.unitsStyle = .short
            when = f.localizedString(for: min(c.updated, Date()), relativeTo: Date())
        }
        return "\(ModelNames.display(c.model)) · \(when)"
    }

    // MARK: Chats

    func newChat(model: String? = nil) {
        if let c = current, c.messages.isEmpty, let i = index(c.id) {
            if let model { conversations[i].model = model }
            return
        }
        let c = Conversation(model: model ?? Prefs.dailyModel)
        conversations.insert(c, at: 0)
        selection = c.id
        save()
    }

    func delete(_ id: Conversation.ID) {
        if streamingID == id { stop() }
        conversations.removeAll { $0.id == id }
        if selection == id { selection = conversations.first?.id }
        if conversations.isEmpty { newChat() }
        save()
    }

    func setModel(_ model: String) {
        guard let id = selection, let i = index(id) else { return }
        conversations[i].model = model
        save()
    }

    func setMacAccess(_ on: Bool) {
        guard let id = selection, let i = index(id) else { return }
        conversations[i].macAccess = on
        save()
    }

    // MARK: Sending

    func send(_ text: String, attachments: [Attachment]) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if attachments.isEmpty, runSlashCommand(trimmed) { return }
        var body = trimmed
        for a in attachments where a.imageFile == nil { body += "\n\nFile: \(a.name)\n```\n\(a.text)\n```" }
        body = body.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachments.compactMap(\.imageFile)
        guard !body.isEmpty || !images.isEmpty, streamingID == nil, let id = selection, let i = index(id) else { return }
        var message = ChatMessage(role: .user, content: body)
        if !images.isEmpty { message.imageFiles = images }
        conversations[i].messages.append(message)
        if conversations[i].title == "New chat" {
            let source = text.isEmpty ? (attachments.first?.name ?? "Files") : text
            let firstLine = source.split(separator: "\n").first.map(String.init) ?? source
            conversations[i].title = String(firstLine.prefix(48))
        }
        generate(in: id)
    }

    /// /compact, /new, /mcp, /skill-reload. Returns true if the text was a command (not sent to the model).
    func runSlashCommand(_ text: String) -> Bool {
        switch text.lowercased() {
        case "/compact": compactNow()
        case "/new": newChat()
        case "/mcp": showMCP = true
        case "/skill-reload", "/skills-reload", "/reload": reloadSkills()
        case "/commands":
            let list = CommandStore.all(project: EditorBridge.shared.freshContext?.workspace).filter(\.enabled)
            notice = list.isEmpty ? "No commands yet — ask: “write a command to always …”"
                : "Commands: " + list.map { $0.name + ($0.always ? " (always)" : "") }.joined(separator: " · ")
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(8))
                self?.notice = nil
            }
        default: return false
        }
        return true
    }

    func reloadSkills() {
        skills = SkillStore.all()
        MCPManager.shared.reload()
        SemanticMatcher.shared.clearCache()
        let rules = RuleStore.all(project: EditorBridge.shared.freshContext?.workspace).count
        let servers = MCPManager.shared.servers.count
        notice = "Reloaded · \(skills.count) skill\(skills.count == 1 ? "" : "s") · \(rules) rule\(rules == 1 ? "" : "s") · \(servers) MCP server\(servers == 1 ? "" : "s")"
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.notice = nil
        }
    }

    func regenerate() {
        guard let id = selection, let i = index(id), streamingID == nil else { return }
        while let last = conversations[i].messages.last, !last.isRealUser, last.compactedCount == nil {
            conversations[i].messages.removeLast()
        }
        generate(in: id)
    }

    func stop() {
        resolve(false)
        task?.cancel()
    }

    // MARK: Approvals

    func resolve(_ allow: Bool, always: Bool = false) {
        if always, let p = pending {
            alwaysAllow[p.conversation, default: []].insert(p.call.name)
        }
        approval?.resume(returning: allow)
        approval = nil
        pending = nil
    }

    private func requestApproval(_ id: Conversation.ID, _ call: ToolCall, _ info: MacTools.Info) async -> Bool {
        if alwaysAllow[id]?.contains(call.name) == true { return true }
        return await withCheckedContinuation { continuation in
            approval = continuation
            pending = PendingApproval(conversation: id, call: call, info: info)
        }
    }

    // MARK: The generation loop (with tool use when Mac access is on)

    private func generate(in id: Conversation.ID) {
        streamingID = id
        let think = self.think
        task = Task { [self] in
            // Engine asleep or stopped? Start it now rather than making the user press Start.
            if !(await OllamaServer.shared.isUp()) {
                activity = "Starting the engine…"
                await OllamaServer.shared.ensureRunning()
                for _ in 0..<60 {
                    if await OllamaServer.shared.isUp() { break }
                    try? await Task.sleep(for: .milliseconds(250))
                }
                await ModelManager.current?.refresh()
                activity = nil
            }
            // What you're working on, and rules/skills that clearly match this message, attached up front.
            let startConv = index(id).map { conversations[$0] }
            let editor = (startConv?.useEditor ?? true) ? EditorBridge.shared.freshContext : nil
            let project = editor?.workspace
            var attachedNames: [String] = []
            var attachedText = ""
            // Commands that apply to this request — enforced below, not just suggested.
            let requestText = startConv?.messages.last(where: { $0.isRealUser })?.content ?? ""
            var tracker = CommandTracker(CommandStore.active(for: requestText, project: project))
            for c in tracker.commands {
                attachedNames.append("⚑ " + c.name)
                for r in c.mustUse where r.hasPrefix("skill:") {
                    let skill = String(r.dropFirst(6))
                    attachedText += "### Skill: \(skill) (required by the command \(c.name) — follow it)\n\(String(SkillStore.read(skill).prefix(12_000)))\n\n"
                }
            }
            if let startConv {
                let lastUser = startConv.messages.last(where: { $0.isRealUser })?.content ?? ""
                let query = lastUser + " " + [editor?.language, editor?.fileName].compactMap { $0 }.joined(separator: " ")
                let rulePool = RuleStore.all(project: project).filter { !$0.always }
                let skillPool = SkillStore.all()
                let memoryPool = Prefs.memoryEnabled ? MemoryStore.all() : []
                let reportPool = ReportStore.all().prefix(60)
                var candidates: [SemanticMatcher.Candidate] = []
                for m in memoryPool {
                    let facts = m.facts.prefix(6).joined(separator: " ")
                    candidates.append(SemanticMatcher.Candidate(id: "memory:" + m.name, text: m.name + ": " + m.description + ". " + facts))
                }
                for r in reportPool {
                    candidates.append(SemanticMatcher.Candidate(id: "report:" + r.name, text: r.title + ": " + r.summary))
                }
                for r in rulePool {
                    candidates.append(SemanticMatcher.Candidate(id: "rule:" + r.name, text: r.name + ": " + r.description))
                }
                for sk in skillPool {
                    candidates.append(SemanticMatcher.Candidate(id: "skill:" + sk.name, text: sk.name + ": " + sk.description))
                }
                // "/skill-name …" always loads that skill.
                if let forced = SlashCommands.skill(in: lastUser, skills: SkillStore.all()) {
                    attachedText += "### Skill: \(forced.name) (the user asked for this skill — follow it)\n\(String(SkillStore.read(forced.name).prefix(12_000)))\n\n"
                    attachedNames.append(forced.name)
                }
                for hit in await SemanticMatcher.shared.matches(query: String(query.prefix(4000)), candidates: candidates) {
                    if hit.hasPrefix("rule:") {
                        let name = String(hit.dropFirst(5))
                        attachedText += "### Rule: \(name)\n\(RuleStore.read(name, project: project))\n\n"
                        attachedNames.append(name)
                    } else if hit.hasPrefix("report:") {
                        let name = String(hit.dropFirst(7))
                        attachedText += "### Earlier research: \(name)\n\(String(ReportStore.read(name).prefix(5000)))\n\n"
                        attachedNames.append("report: \(name)")
                    } else if hit.hasPrefix("memory:") {
                        let name = String(hit.dropFirst(7))
                        attachedText += "### Memory: \(name)\n\(String(MemoryStore.read(name).prefix(4000)))\n\n"
                        attachedNames.append("memory: \(name)")
                    } else if hit.hasPrefix("skill:"), !attachedNames.contains(String(hit.dropFirst(6))) {
                        let name = String(hit.dropFirst(6))
                        attachedText += "### Skill: \(name)\n\(String(SkillStore.read(name).prefix(12_000)))\n\n"
                        attachedNames.append(name)
                    }
                }
            }

            // Models that can't see images get the text in them instead.
            if let startConv, let i0 = index(id), !(await supportsVision(startConv.model)) {
                for k in conversations[i0].messages.indices {
                    let m = conversations[i0].messages[k]
                    guard let files = m.imageFiles, !files.isEmpty, m.imageText == nil else { continue }
                    activity = "Reading the image…"
                    var text = ""
                    for f in files { text += await ImageStore.recognizeText(f) + "\n" }
                    if let i1 = index(id), k < conversations[i1].messages.count { conversations[i1].messages[k].imageText = text }
                }
                activity = nil
            }

            // Local models cost nothing per step: keep going until done, stopped, or clearly stuck (200 is a backstop).
            let maxSteps = 200
            var callCounts: [String: Int] = [:]
            var skips = 0
            for _ in 0..<maxSteps {
                guard let i = index(id) else { break }
                let conv = conversations[i]
                let model = conv.model
                let vision = await supportsVision(model)
                var history = historyJSON(conv, vision: vision)
                var system: [String] = []
                if let summary = latestSummary(conv) {
                    system.append("## Summary of the earlier conversation (compacted — older messages aren't shown to you)\n" + summary)
                }
                var tools: [[String: Any]] = []
                if let persona = Persona.systemPrompt(for: model, web: conv.webOn) { system.append(persona) }
                if let block = CommandStore.promptBlock(tracker.commands) { system.append(block) }
                // Only the short INGLE.md index goes in; details load on demand through tools.
                system.append(IngleManifest.refresh(macAccess: conv.macAccess, project: project, web: conv.webOn, currentChat: id))
                if let editor {
                    system.append(editor.promptSection)
                    if let projectRules = editor.projectInstructions { system.append(projectRules) }
                }
                if !attachedText.isEmpty {
                    system.append("## Loaded for this request (matched automatically — follow them)\n" + attachedText)
                }
                tools.append(MacTools.helpTool)
                if Prefs.memoryEnabled {
                    system.append(MemoryStore.systemPrompt)
                    tools += MemoryStore.definitions
                }
                if conv.webOn {
                    system.append(WebTools.systemPrompt)
                    tools += WebTools.definitions
                }
                system.append(KnowledgeTools.systemPrompt)
                tools += KnowledgeTools.chatDefinitions
                tools += KnowledgeTools.reportDefinitions.filter { def in
                    // report_save only matters when the web is on
                    ((def["function"] as? [String: Any])?["name"] as? String) != "report_save" || conv.webOn
                }
                tools.append(KnowledgeTools.delegateDefinition)
                // The builder tools are only offered when the user is talking about skills or rules.
                let lastText = (conv.messages.last(where: { $0.isRealUser })?.content ?? "").lowercased()
                if lastText.contains("skill") || lastText.contains("rule") { tools += KnowledgeTools.builderDefinitions }
                if !SkillStore.all().isEmpty { tools.append(SkillStore.toolDefinition) }
                if RuleStore.all(project: project).contains(where: { !$0.always }) { tools.append(RuleStore.toolDefinition) }
                if conv.macAccess {
                    system.append(MacTools.systemPrompt)
                    tools += MacTools.definitions
                    if !MCPManager.shared.servers.isEmpty { tools += MacTools.mcpTools }
                }
                tools = ToolSelection.filter(tools, lastUserText: lastText)
                if lastText.contains("command") { tools.append(CommandStore.toolDefinition) }
                // Commands: tools they require are always offered (MCP even with Mac access off — still approved
                // per call); tools they ban are taken away.
                let have = Set(tools.map(ToolSelection.name))
                for def in Self.toolPool where tracker.requiredTools.contains(ToolSelection.name(def)) && !have.contains(ToolSelection.name(def)) {
                    tools.append(def)
                }
                let banned = tracker.blocked
                if !banned.isEmpty { tools.removeAll { banned.contains(ToolSelection.name($0).lowercased()) } }
                // Long chat? Summarise the older part first, like Claude's compacting.
                // The tool list counts too: it's sent with every request.
                let toolChars: Int = (try? JSONSerialization.data(withJSONObject: tools))?.count ?? 0
                let ctx: Int = Prefs.contextLength(for: model)
                let limit: Int = ctx * 3 / 4
                func fixedTokens() -> Int { (system.joined(separator: "\n\n").count + toolChars) / 4 }
                // Keep the last two turns word for word; if that's still too big (one long task), keep just the last.
                for keep in [2, 1] {
                    let used: Int = estimateTokens(history) + fixedTokens()
                    guard used > limit else { break }
                    guard await compact(id, keepTurns: keep, auto: true), let c2 = index(id).map({ conversations[$0] }) else { continue }
                    history = historyJSON(c2, vision: vision)
                    if let summary = latestSummary(c2) {
                        system.removeAll { $0.hasPrefix("## Summary of the earlier conversation") }
                        system.insert("## Summary of the earlier conversation (compacted — older messages aren't shown to you)\n" + summary, at: 0)
                    }
                }
                // Still too big (huge tool outputs in the current task): shorten old tool results so nothing is cut off silently.
                history = fit(history, budget: ctx * 9 / 10 - fixedTokens())
                if !system.isEmpty {
                    history.insert(["role": "system", "content": system.joined(separator: "\n\n")], at: 0)
                }
                var reply = ChatMessage(role: .assistant, content: "", model: model)
                if !attachedNames.isEmpty { reply.usedContext = attachedNames }
                conversations[i].messages.append(reply)
                conversations[i].updated = Date()

                let started = Date()
                var thinkStart: Date?
                var thinkEnd: Date?
                var calls: [ToolCall] = []
                var stopLoop = false

                if model == Prefs.dailyModel || model == Prefs.hardModel {
                    await ModelManager.current?.pauseAutocompleteIfSmart()
                }
                do {
                    let stream = OllamaClient().chat(
                        model: model, messages: history,
                        tools: tools.isEmpty ? nil : tools,
                        think: think, numCtx: Prefs.contextLength(for: model), keepAlive: Prefs.keepAlive)
                    for try await chunk in stream {
                        guard let j = index(id), let k = conversations[j].messages.indices.last else { break }
                        if !chunk.thinking.isEmpty {
                            if thinkStart == nil { thinkStart = Date() }
                            conversations[j].messages[k].thinking += chunk.thinking
                        }
                        if !chunk.content.isEmpty {
                            if thinkStart != nil && thinkEnd == nil { thinkEnd = Date() }
                            conversations[j].messages[k].content += chunk.content
                        }
                        calls += chunk.toolCalls
                        if chunk.done {
                            if chunk.evalDuration > 0 {
                                conversations[j].messages[k].tokensPerSecond =
                                    Double(chunk.evalCount) / (Double(chunk.evalDuration) / 1_000_000_000)
                            }
                            conversations[j].messages[k].seconds = Date().timeIntervalSince(started)
                            if let s = thinkStart {
                                conversations[j].messages[k].thoughtSeconds = (thinkEnd ?? Date()).timeIntervalSince(s)
                            }
                        }
                    }
                } catch is CancellationError {
                    stopLoop = true
                } catch {
                    if let j = index(id), let k = conversations[j].messages.indices.last {
                        conversations[j].messages[k].failed = true
                        if conversations[j].messages[k].content.isEmpty {
                            conversations[j].messages[k].content = Self.friendly(error)
                        }
                    }
                    stopLoop = true
                }

                guard !stopLoop, !Task.isCancelled, let j = index(id), let k = conversations[j].messages.indices.last else { break }
                conversations[j].messages[k].toolCalls = calls
                if calls.isEmpty {
                    // Finished — unless a command hasn't been obeyed. Then send it back (twice at most).
                    let owed = tracker.unmet()
                    if let item = owed.first(where: { (tracker.nudges[$0.0.name] ?? 0) < 2 }) {
                        let cmd = item.0, what = item.1
                        tracker.nudges[cmd.name, default: 0] += 1
                        var nudge = ChatMessage(role: .user, content: "Ingle: the command \"\(cmd.name)\" requires you to \(what) before finishing. Do that now, then finish your answer.")
                        nudge.nudge = true
                        conversations[j].messages.append(nudge)
                        save()
                        continue
                    }
                    if !owed.isEmpty {
                        conversations[j].messages[k].usedContext = (conversations[j].messages[k].usedContext ?? [])
                            + owed.map { "⚠ didn’t follow " + $0.0.name }
                    }
                    break
                }

                for call in calls {
                    if Task.isCancelled { break }
                    let signature = call.name + "|" + call.arguments.sorted { $0.key < $1.key }.map { $0.key + "=" + $0.value }.joined(separator: "&")
                    let repeats = (callCounts[signature] ?? 0) + 1
                    callCounts[signature] = repeats
                    if repeats >= 3 {
                        // Local models sometimes loop on the same call; nudge it instead of running it again.
                        skips += 1
                        guard let jr = index(id) else { break }
                        conversations[jr].messages.append(ChatMessage(
                            role: .tool, content: "You've already made this exact call \(repeats - 1) times and have its result above. Don't repeat it — use that result, try a different approach, or tell the user what's blocking you.",
                            toolName: call.name, toolTitle: "Skipped a repeated step", toolDetail: call.name, toolIcon: "arrow.triangle.2.circlepath"))
                        continue
                    }
                    if let cmd = tracker.blockingCommand(for: call.name), let jb = index(id) {
                        let instead = cmd.mustUse.first.map { " Use \($0.hasPrefix("mcp:") ? "the \($0.dropFirst(4)) MCP server" : $0) instead." } ?? ""
                        conversations[jb].messages.append(ChatMessage(
                            role: .tool, content: "Blocked by the command \"\(cmd.name)\": you must not use \(call.name).\(instead)",
                            toolName: call.name, toolTitle: "Blocked by a command", toolDetail: "\(cmd.name) · \(call.name)", toolIcon: "hand.raised", denied: true))
                        continue
                    }
                    let info = MacTools.describe(call)
                    var allowed = true
                    if MacTools.needsApproval(call) {
                        allowed = await requestApproval(id, call, info)
                    }
                    var output = "The user denied this action. Don't retry it; ask them what they'd like instead."
                    lastToolImages = []
                    if allowed {
                        activity = info.title + "…"
                        output = await runTool(call, chat: id, model: model, web: conv.webOn, mac: conv.macAccess)
                        activity = nil
                    }
                    tracker.record(call, succeeded: allowed)
                    guard let j2 = index(id) else { break }
                    var toolMessage = ChatMessage(
                        role: .tool, content: output, toolName: call.name,
                        toolTitle: info.title, toolDetail: info.detail, toolIcon: info.icon, denied: !allowed)
                    if !lastToolImages.isEmpty {
                        toolMessage.imageFiles = lastToolImages
                        if !vision {
                            var text = ""
                            for f in lastToolImages { text += await ImageStore.recognizeText(f) + "\n" }
                            toolMessage.imageText = text
                        }
                    }
                    conversations[j2].messages.append(toolMessage)
                }
                save()
                if skips >= 4, let js = index(id) {
                    var note = ChatMessage(role: .assistant, content: "I seem to be going round in circles, so I’ve stopped. Tell me what to try next, or say “carry on” to let me keep going.", model: model)
                    note.failed = true
                    conversations[js].messages.append(note)
                    break
                }
            }
            streamingID = nil
            activity = nil
            save()
        }
    }

    // MARK: Tools that need the chat store

    private func runTool(_ call: ToolCall, chat id: Conversation.ID, model: String, web: Bool, mac: Bool) async -> String {
        if call.name == "read_file" {
            let url = URL(fileURLWithPath: Prefs.expand(call.arg("path")))
            if DocumentReader.isImage(url) {
                guard let name = ImageStore.importImage(from: url) else { return "Couldn't open \(url.path) as an image." }
                lastToolImages = [name]
                return await supportsVision(model)
                    ? "Here is the image \(url.lastPathComponent) (attached)."
                    : "This model can't see images, so here is the text found in \(url.lastPathComponent) (attached below)."
            }
        }
        switch call.name {
        case "chat_list", "chat_search", "chat_read":
            return chatTool(call, excluding: id)
        case "delegate":
            return await runSubAgent(task: call.arg("task"), model: model, web: web, mac: mac, parent: id)
        default:
            return await MacTools.run(call)
        }
    }

    private func chatTool(_ call: ToolCall, excluding id: Conversation.ID) -> String {
        let others = conversations.filter { $0.id != id && !$0.messages.isEmpty }.sorted { $0.updated > $1.updated }
        let f = DateFormatter()
        f.dateFormat = "EEE d MMM yyyy, HH:mm"
        switch call.name {
        case "chat_list":
            if others.isEmpty { return "There are no other chats yet." }
            return others.prefix(25).map { "- \($0.title) — \(f.string(from: $0.updated)) · \(ModelNames.display($0.model)) · \($0.messages.count) messages" }
                .joined(separator: "\n")
        case "chat_search":
            let words = call.arg("query").lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 2 }
            guard !words.isEmpty else { return "Give me a word or two to search for." }
            var hits: [(Int, String)] = []
            for c in others {
                for m in c.messages where m.role != .tool {
                    let lower = m.content.lowercased()
                    let score = words.reduce(0) { $0 + (lower.contains($1) ? 1 : 0) }
                    guard score > 0, let first = words.compactMap({ m.content.range(of: $0, options: .caseInsensitive) }).first else { continue }
                    let start = m.content.index(first.lowerBound, offsetBy: -150, limitedBy: m.content.startIndex) ?? m.content.startIndex
                    let end = m.content.index(first.upperBound, offsetBy: 150, limitedBy: m.content.endIndex) ?? m.content.endIndex
                    let snippet = m.content[start..<end].replacingOccurrences(of: "\n", with: " ")
                    let who = m.role == .user ? "User" : ModelNames.display(m.model ?? c.model)
                    hits.append((score, "- “\(c.title)” (\(f.string(from: c.updated))) \(who): …\(snippet)…"))
                }
            }
            if hits.isEmpty { return "Nothing in past chats about that." }
            return hits.sorted { $0.0 > $1.0 }.prefix(10).map { $0.1 }.joined(separator: "\n")
        default:
            let key = call.arg("chat").lowercased().trimmingCharacters(in: .whitespaces)
            guard let c = others.first(where: { $0.title.lowercased() == key })
                    ?? others.first(where: { $0.title.lowercased().contains(key) }) else {
                return "There's no chat called \(call.arg("chat")). Use chat_list to see them."
            }
            var lines = ["Chat “\(c.title)” — \(f.string(from: c.updated))"]
            for m in c.messages where m.role != .tool && !m.content.isEmpty {
                let who = m.role == .user ? "User" : ModelNames.display(m.model ?? c.model)
                lines.append("\(who): \(m.content.prefix(2000))")
            }
            let text = lines.joined(separator: "\n\n")
            return text.count > 15_000 ? "…(earlier part left out)\n" + String(text.suffix(15_000)) : text
        }
    }

    /// A helper with a fresh context and read-only tools. Runs on the same model, one at a time.
    private func runSubAgent(task: String, model: String, web: Bool, mac: Bool, parent: Conversation.ID) async -> String {
        let task = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return "The helper needs a task." }
        var system = ["You are a helper sub-agent working for \(ModelNames.display(model)) inside Ingle, on the user's Mac. Do only the task below, using your tools where useful, then reply with a concise result: key findings, facts, and sources (URLs or file paths). No small talk and no questions — make sensible assumptions and say what they were."]
        if web { system.append(WebTools.systemPrompt) }
        if let memory = MemoryStore.indexSection() { system.append(memory) }
        if let reports = ReportStore.indexSection() { system.append(reports) }

        var pool: [[String: Any]] = []
        pool.append(contentsOf: MacTools.definitions)
        pool.append(contentsOf: WebTools.definitions)
        pool.append(contentsOf: MemoryStore.definitions)
        pool.append(contentsOf: KnowledgeTools.reportDefinitions)
        pool.append(contentsOf: KnowledgeTools.chatDefinitions)
        pool.append(MacTools.helpTool)
        pool.append(SkillStore.toolDefinition)
        pool.append(RuleStore.toolDefinition)
        let tools = pool.filter { def in
            guard let fn = def["function"] as? [String: Any], let name = fn["name"] as? String,
                  KnowledgeTools.subAgentAllowed.contains(name) else { return false }
            if name.hasPrefix("web_") { return web }
            if name == "list_files" || name == "read_file" { return mac }
            return true
        }

        var messages: [[String: Any]] = [["role": "system", "content": system.joined(separator: "\n\n")],
                                         ["role": "user", "content": task]]
        var lastContent = ""
        for _ in 0..<10 {
            if Task.isCancelled { return "Stopped." }
            activity = "Helper is thinking…"
            var content = ""
            var calls: [ToolCall] = []
            do {
                let stream = OllamaClient().chat(model: model, messages: messages, tools: tools, think: false,
                                                 numCtx: Prefs.contextLength(for: model), keepAlive: Prefs.keepAlive)
                for try await chunk in stream {
                    content += chunk.content
                    calls += chunk.toolCalls
                }
            } catch {
                return "The helper stopped: \(Self.friendly(error))"
            }
            lastContent = content
            var reply: [String: Any] = ["role": "assistant", "content": content]
            if !calls.isEmpty {
                reply["tool_calls"] = calls.map { c -> [String: Any] in
                    let args: Any = c.raw.flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? c.arguments
                    return ["function": ["name": c.name, "arguments": args]]
                }
            }
            messages.append(reply)
            if calls.isEmpty {
                let result = ThinkSplitter.split(content, extra: "").body
                return result.isEmpty ? "(The helper finished without a result.)" : result
            }
            for c in calls {
                let result: String
                if !KnowledgeTools.subAgentAllowed.contains(c.name) {
                    result = "Helpers can only read, so that tool isn't available."
                } else if (c.name == "list_files" || c.name == "read_file") && (!mac || !Prefs.inWorkspace(c.arg("path"))) {
                    result = mac ? "Helpers can only read inside the workspace folders." : "Mac access is off."
                } else if c.name.hasPrefix("chat_") {
                    result = chatTool(c, excluding: parent)
                } else {
                    activity = "Helper: " + MacTools.describe(c).title + "…"
                    result = await MacTools.run(c)
                }
                messages.append(["role": "tool", "content": result, "tool_name": c.name])
            }
        }
        let partial = ThinkSplitter.split(lastContent, extra: "").body
        return "The helper ran out of steps." + (partial.isEmpty ? "" : " Its last notes:\n" + partial)
    }

    static func friendly(_ error: Error) -> String {
        if let e = error as? URLError, [.cannotConnectToHost, .networkConnectionLost, .cannotFindHost].contains(e.code) {
            return "Couldn’t reach Ollama. Is it running?"
        }
        let text = error.localizedDescription
        let lower = text.lowercased()
        if lower.contains("not found") { return "That model isn’t downloaded yet. Use Download Models in Settings → Models." }
        if lower.contains("does not support tools") { return "This model can’t use Mac access. Switch to Daily coding or turn Mac access off." }
        return "Something went wrong: \(text)"
    }

    /// Every tool definition, so a command can bring back one the per-turn filter left out.
    static var toolPool: [[String: Any]] {
        var pool: [[String: Any]] = [MacTools.helpTool]
        pool += MemoryStore.definitions
        pool += WebTools.definitions
        pool += KnowledgeTools.chatDefinitions
        pool += KnowledgeTools.reportDefinitions
        pool.append(KnowledgeTools.delegateDefinition)
        pool += KnowledgeTools.builderDefinitions
        pool.append(SkillStore.toolDefinition)
        pool.append(RuleStore.toolDefinition)
        pool += MacTools.definitions
        pool += MacTools.mcpTools
        pool.append(CommandStore.toolDefinition)
        return pool
    }

    // MARK: Images and compacting

    func supportsVision(_ model: String) async -> Bool {
        if let v = visionCache[model] { return v }
        let caps = await OllamaClient().capabilities(model)
        let v = caps.contains("vision")
        if !caps.isEmpty { visionCache[model] = v }
        return v
    }

    /// The history the model sees: everything after the latest summary, with images attached or read as text.
    private func historyJSON(_ conv: Conversation, vision: Bool) -> [[String: Any]] {
        let start = (conv.messages.lastIndex { $0.compactedCount != nil }).map { $0 + 1 } ?? 0
        return conv.messages[start...].map { m -> [String: Any] in
            var json = m.ollamaJSON
            if let files = m.imageFiles, !files.isEmpty {
                if vision {
                    json["images"] = files.compactMap(ImageStore.base64)
                } else {
                    let text: String = (m.imageText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let what: String = files.count == 1 ? "An image was" : "\(files.count) images were"
                    let found: String = text.isEmpty ? "(no text found)" : text
                    let note: String = "\n\n[\(what) attached. This model can't see images, so here is the text read from it: \(found)]"
                    json["content"] = m.content + note
                }
            }
            return json
        }
    }

    /// Shortens the oldest tool results first, then drops the oldest messages before the latest request,
    /// until the history fits. Ollama would otherwise cut the start of the prompt without saying so.
    private func fit(_ history: [[String: Any]], budget: Int) -> [[String: Any]] {
        var h = history
        var i = 0
        while estimateTokens(h) > budget && i < h.count {
            if (h[i]["role"] as? String) == "tool", let text = h[i]["content"] as? String, text.count > 1500 {
                h[i]["content"] = String(text.prefix(1500)) + "\n…(shortened to fit the context)"
            }
            i += 1
        }
        let lastUser = h.lastIndex { ($0["role"] as? String) == "user" } ?? 0
        var dropped = 0
        while estimateTokens(h) > budget && dropped < lastUser {
            h.remove(at: 0)
            dropped += 1
        }
        while (h.first?["role"] as? String) == "tool" { h.removeFirst() }
        return h
    }

    private func latestSummary(_ conv: Conversation) -> String? {
        conv.messages.last { $0.compactedCount != nil }?.content
    }

    private func estimateTokens(_ history: [[String: Any]]) -> Int {
        var total = 0
        for m in history {
            let chars: Int = (m["content"] as? String)?.count ?? 0
            let images: Int = (m["images"] as? [String])?.count ?? 0
            total += chars / 4
            total += images * 800
            total += 8
        }
        return total
    }

    /// Roughly how full the model's context is for this chat (0…1), for the meter under the message box.
    func contextUsage(_ conv: Conversation) -> Double {
        let start = (conv.messages.lastIndex { $0.compactedCount != nil }).map { $0 + 1 } ?? 0
        let summaryChars: Int = latestSummary(conv)?.count ?? 0
        var tokens = 3000 + summaryChars / 4   // system prompt and index, roughly
        for m in conv.messages[start...] {
            let images: Int = m.imageFiles?.count ?? 0
            tokens += m.content.count / 4
            tokens += images * 800
        }
        return min(1, Double(tokens) / Double(max(2048, Prefs.contextLength(for: conv.model))))
    }

    /// "Compact chat" button or /compact.
    func compactNow() {
        guard let id = selection, streamingID == nil else { return }
        streamingID = id
        task = Task { [self] in
            if !(await compact(id, keepTurns: 0, auto: false)) {
                activity = nil
            }
            streamingID = nil
            activity = nil
        }
    }

    /// Summarises older messages so a long chat fits the model's context. The full messages stay visible;
    /// the model only sees the summary plus the last `keepTurns` user turns. Returns true if it compacted.
    @discardableResult
    private func compact(_ id: Conversation.ID, keepTurns: Int, auto: Bool) async -> Bool {
        guard let i = index(id) else { return false }
        let conv = conversations[i]
        let msgs = conv.messages
        let start = (msgs.lastIndex { $0.compactedCount != nil }).map { $0 + 1 } ?? 0
        let userTurns = msgs.indices.filter { $0 >= start && msgs[$0].isRealUser }
        let cut: Int
        if keepTurns == 0 {
            cut = msgs.count
        } else {
            guard userTurns.count > keepTurns else { return false }
            cut = userTurns[userTurns.count - keepTurns]
        }
        guard cut - start >= 2 else { return false }

        var lines: [String] = []
        if let previous = latestSummary(conv) { lines.append("Earlier summary:\n" + previous) }
        for m in msgs[start..<cut] {
            switch m.role {
            case .user:
                lines.append("User: " + m.content + ((m.imageFiles?.isEmpty == false) ? " [image attached]" : ""))
            case .assistant:
                let body = ThinkSplitter.split(m.content, extra: "").body
                if !body.isEmpty { lines.append("Assistant: " + body) }
            case .tool:
                lines.append("Tool \(m.toolName ?? "") (\(m.toolDetail ?? "")): " + String(m.content.prefix(1500)))
            }
        }
        var transcript = lines.joined(separator: "\n\n")
        let budget = Prefs.contextLength(for: conv.model) * 5 / 2   // characters, leaves room for the summary
        if transcript.count > budget {
            transcript = String(transcript.prefix(budget / 3)) + "\n\n…(middle left out)…\n\n" + String(transcript.suffix(budget * 2 / 3))
        }

        activity = "Compacting chat…"
        let prompt = """
        Summarise this conversation so it can continue without the original messages. Be dense and specific; keep:
        - what the user wants overall, and their preferences or constraints
        - decisions made and why
        - files, commands, URLs and names that matter, with key facts or code details
        - what was tried and what happened (errors, results)
        - open questions and the next steps
        Write it as short Markdown bullet points under those headings. No greeting, no commentary.

        Conversation:
        \(transcript)
        """
        var summary = ""
        do {
            let stream = OllamaClient().chat(model: conv.model, messages: [["role": "user", "content": prompt]], tools: nil,
                                             think: false, numCtx: Prefs.contextLength(for: conv.model), keepAlive: Prefs.keepAlive)
            for try await chunk in stream { summary += chunk.content }
        } catch {
            return false
        }
        summary = ThinkSplitter.split(summary, extra: "").body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !summary.isEmpty, let j = index(id), cut <= conversations[j].messages.count else { return false }
        var marker = ChatMessage(role: .assistant, content: summary, model: conv.model)
        marker.compactedCount = cut - start
        marker.usedContext = [auto ? "compacted automatically" : "compacted"]
        conversations[j].messages.insert(marker, at: cut)
        save()
        return true
    }

    // MARK: Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let list = try? JSONDecoder().decode([Conversation].self, from: data) else { return }
        conversations = list
    }

    func save() {
        guard let data = try? JSONEncoder().encode(conversations) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
