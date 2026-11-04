import Foundation
import Observation

struct ChatMessage: Identifiable, Codable, Equatable {
    enum Role: String, Codable { case user, assistant, tool }

    var id = UUID()
    var role: Role
    var content: String
    var thinking: String = ""
    /// The visible phases behind this reply's Thinking disclosure. Optional so older saved chats still decode.
    var thinkingPhases: [ThinkingPhase]?
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
    /// True when the optional semantic thinking decider stopped this response and triggered a no-thinking retry.
    var deciderIntervened: Bool?
    var usedContext: [String]?
    /// Images on this message, stored as JPEGs in Application Support/Ingle/images.
    var imageFiles: [String]?
    /// Text read from those images, for models that can't see images.
    var imageText: String?
    /// Set on a summary message: how many earlier messages it replaces when talking to the model.
    var compactedCount: Int?
    /// A reminder Ingle sent the model because a command wasn't obeyed (shown as a small note, not a bubble).
    var nudge: Bool?
    /// Set on the last reply of a run that changed files: what "Undo this run" would do (see Checkpoints).
    var checkpoint: RunCheckpoint?
    /// On a tool row: the mode approved it without asking ("Auto approved (Edit mode): …").
    var autoApproved: String?
    /// A plan saved as a Markdown file (PlanFiles), shown as a card.
    var plan: PlanRef?
    /// A message typed while a run was going: it joined the run at the model's next step.
    var steer: Bool?
    /// Assistant text emitted only to introduce a tool call. Kept for model history, shown inside Thinking stages.
    var workflowHidden: Bool?
    /// Single live workflow bubble, removed when the final answer is ready.
    var workflowProgress: Bool?

    var isRealUser: Bool { role == .user && nudge != true }

    /// The shape Ollama's /api/chat expects for history.
    var ollamaJSON: [String: Any] {
        // A message typed during a run tells the model it came mid-run (the chat shows it as typed).
        let text: String = steer == true ? TaskList.steerText(content) : content
        var m: [String: Any] = ["role": role.rawValue, "content": text]
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

struct ThinkingPhase: Codable, Equatable, Identifiable {
    var id: String { title }
    var title: String
    var content: String
    var status: String?
}

/// A run's checkpoint as the chat shows it: the run's id and what Undo would do to each file.
struct RunCheckpoint: Codable, Equatable {
    var run: String
    var files: [Checkpoints.FileSummary]
    var undone: Bool?
    /// Short hash once the run's files were committed with the Commit button.
    var committed: String?
}

struct Conversation: Identifiable, Codable, Equatable {
    var id = UUID()
    var title = "New chat"
    var model: String
    var macAccess = false
    var useEditor: Bool?
    var webAccess: Bool?
    /// Effort level (EffortLevel raw value). nil in chats saved before effort levels: they had Think off
    /// (the Mac app never saved Think on), so they read as Medium.
    var effort: String?
    /// Reasoning (the brain pill): off = answer directly, no thinking and no pre-answer steps; on = the thinking flow
    /// (summarise → research → understand → choose tools) plus the model's own thinking at the Effort level.
    var reasoning: Bool?
    var reasoningOn: Bool { reasoning ?? false }

    var webOn: Bool { webAccess ?? Prefs.webOnByDefault }
    var effortLevel: EffortLevel { effort.flatMap(EffortLevel.init(rawValue:)) ?? .medium }
    var messages: [ChatMessage] = []
    var updated = Date()
    /// "code" for a Code chat; nil = a normal chat. Optional so older chats.json still decodes.
    var mode: String?
    /// The Code chat's project folder (nil until one is chosen).
    var projectPath: String?
    /// The task list the model keeps with update_tasks (or an approved plan).
    var tasks: [TaskItem]?
    /// Work mode (the Mode pill, WorkMode raw value): nil = Ask (and for older chats).
    var workMode: String?
    /// The mode before Plan, to go back to after Approve.
    var modeBefore: String?
    /// The plan file the task list ticks (an approved plan, or Max's).
    var planFile: String?

    var workModeValue: WorkMode { workMode.flatMap(WorkMode.init(rawValue:)) ?? .ask }

    var isCode: Bool { mode == Project.codeMode }
    /// The one place that says "this chat is Code mode on folder X": the project folder, or nil for a normal chat
    /// (or a Code chat still waiting for its folder). Approvals, the prompt and the tools all go by this.
    var codeFolder: String? { isCode ? projectPath : nil }
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
    /// What "Allow for This Session" would cover (empty key: not offered).
    let scope: MacTools.ApprovalScope
    /// Set when the call uses secrets: the card names them, and there's no "Allow for This Session".
    var secretUse: Secrets.Use? = nil
}

/// Text handed over from the editor ("Ask Ingle about this"), waiting for the chat view to pick it up.
struct IncomingDraft: Equatable {
    let id = UUID()
    let conversation: Conversation.ID
    let text: String
    let attachment: Attachment?
}

struct ChatSection: Identifiable {
    var id: String { path ?? title }
    let title: String
    let items: [Conversation]
    /// Set for a Code project's group: its folder.
    var path: String? = nil
}

@MainActor @Observable
final class ChatStore {
    var conversations: [Conversation] = []
    var selection: Conversation.ID?
    var streamingID: Conversation.ID?
    var search = ""
    var pending: PendingApproval?
    /// What the assistant is doing right now ("Search the web…"), shown above the message box.
    var activity: String?
    var incoming: IncomingDraft?
    /// /mcp opens the MCP servers dialog.
    var showMCP = false
    /// A short note under the message box, e.g. after /skill-reload.
    var notice: String?
    /// /secret opens the "Save a secret" sheet.
    var showAddSecret = false
    /// Skills for the "/" menu; refreshed by /skill-reload.
    var skills: [Skill] = SkillStore.all()
    /// Messages typed while a chat's run is going, waiting for the model's next step (per chat).
    var queued: [Conversation.ID: [ChatMessage]] = [:]
    /// The note for the call just approved by the chat's mode, picked up by its tool row (per chat).
    private var autoApproved: [Conversation.ID: String] = [:]

    static weak var current: ChatStore?

    private var task: Task<Void, Never>?
    private var activeOllamaStream: OllamaStreamControl?
    /// The run in progress per chat (one per reply to a message): file-changing tools checkpoint into it.
    private var activeRuns: [Conversation.ID: Checkpoints.Run] = [:]
    private var approval: CheckedContinuation<Bool, Never>?
    /// Approval scopes the user allowed for this session ("Allow for This Session"), until Ingle quits:
    /// scope key → label. See `MacTools.approvalScope`.
    private(set) var sessionAllowed: [String: String] = [:]
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
        // Open on a blank new chat, like starting fresh; empty chats from before aren't kept.
        conversations.removeAll { $0.messages.isEmpty }
        newChat()
        ChatStore.current = self
        // Old checkpoints (over 14 days, or the oldest above 500 MB) go at launch.
        Task.detached(priority: .background) { Checkpoints.prune() }
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

    func setReasoning(_ on: Bool) {
        guard let id = selection, let i = index(id) else { return }
        conversations[i].reasoning = on
        save()
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

    /// Started chats matching the search. A new chat appears in the list once it has a message.
    private var listed: [Conversation] {
        let started: [Conversation] = conversations.filter { !$0.messages.isEmpty }
        return search.isEmpty ? started : started.filter { c in
            c.title.localizedCaseInsensitiveContains(search) ||
            c.messages.contains { $0.content.localizedCaseInsensitiveContains(search) }
        }
    }

    /// The sidebar in Code mode: Code chats grouped by project, most recently used project first.
    var codeSections: [ChatSection] {
        let code: [Conversation] = listed.filter(\.isCode).sorted { $0.updated > $1.updated }
        var order: [String] = []
        var groups: [String: [Conversation]] = [:]
        for c in code {
            let path: String = c.projectPath ?? ""
            if groups[path] == nil { order.append(path) }
            groups[path, default: []].append(c)
        }
        return order.map { path in
            ChatSection(title: path.isEmpty ? "No folder" : Project.name(path), items: groups[path] ?? [], path: path)
        }
    }

    /// The sidebar in Chat mode: normal chats, by date.
    var sections: [ChatSection] {
        let list: [Conversation] = listed.filter { !$0.isCode }
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

    /// A blank normal chat. An empty current chat is reused (it isn't listed or saved until its first message).
    func newChat(model: String? = nil) {
        startChat(mode: nil, project: nil, model: model)
    }

    /// A blank Code chat on `project` (nil: it asks for a folder first).
    func newCodeChat(project: String? = nil) {
        startChat(mode: Project.codeMode, project: project, model: nil)
    }

    /// ⌘N: a new chat of the same kind as the current one (a Code chat stays on its project).
    func newChatSameKind() {
        if let c = current, c.isCode { newCodeChat(project: c.projectPath) } else { newChat() }
    }

    /// The Chat / Code switch and ⌘⇧C.
    func switchMode(code: Bool) {
        guard current?.isCode != code else { return }
        if code { newCodeChat() } else { newChat() }
    }

    /// Choose (or change, before the first message) the current Code chat's folder.
    func setProject(_ path: String) {
        let folder: String = Project.standard(path)
        guard Project.isFolder(folder), let id = selection, let i = index(id) else { return }
        if !conversations[i].messages.isEmpty, conversations[i].projectPath != nil { return }
        conversations[i].mode = Project.codeMode
        conversations[i].projectPath = folder
        conversations[i].macAccess = false
        Project.remember(folder)
        save()
    }

    private func startChat(mode: String?, project: String?, model: String?) {
        if let c = current, c.messages.isEmpty, let i = index(c.id) {
            if let model {
                conversations[i].model = model
                conversations[i].effort = EffortLevel.defaultFor(model: model).rawValue
            }
            conversations[i].mode = mode
            conversations[i].projectPath = project
            if mode != nil { conversations[i].macAccess = false }
            return
        }
        var c = Conversation(model: model ?? Prefs.dailyModel)
        c.effort = EffortLevel.defaultFor(model: c.model).rawValue
        c.mode = mode
        c.projectPath = project
        conversations.insert(c, at: 0)
        selection = c.id
        save()
    }

    func delete(_ id: Conversation.ID) {
        if streamingID == id { stop() }
        let folder: String? = index(id).flatMap { conversations[$0].codeFolder }
        conversations.removeAll { $0.id == id }
        CodeIntel.shared.chatClosed(folder: folder, stillUsed: conversations.contains { $0.codeFolder == folder })
        Checkpoints.discardChat(id.uuidString)
        if selection == id { selection = conversations.first?.id }
        if conversations.isEmpty { newChat() }
        save()
    }

    func setModel(_ model: String) {
        guard let id = selection, let i = index(id) else { return }
        conversations[i].model = model
        // A chat that hasn't started yet takes the new assistant's default effort.
        if conversations[i].messages.isEmpty { conversations[i].effort = EffortLevel.defaultFor(model: model).rawValue }
        save()
        // Switching here does what the menu bar's switch does: wake the new assistant (asking first for a big model on
        // battery) so the menu bar shows who's awake, instead of the old model until the next message.
        if let mm = ModelManager.current, !mm.isLoaded(model) {
            let big: Bool = model == Prefs.hardModel
            if !big || mm.confirmHardOnBattery() {
                Task { await mm.activate(model) }
            }
        }
    }

    func setEffort(_ level: EffortLevel) {
        guard let id = selection, let i = index(id) else { return }
        conversations[i].effort = level.rawValue
        save()
    }

    /// ⌘⇧E: Low → Medium → High → Max → Low.
    func cycleEffort() {
        guard let c = current else { return }
        setEffort(c.effortLevel.next)
    }

    func setMacAccess(_ on: Bool) {
        guard let id = selection, let i = index(id), !conversations[i].isCode else { return }
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
        // Typed while this chat's run is going: it waits and joins the run at the model's next step.
        if let id = selection, streamingID == id {
            guard attachments.isEmpty, !body.isEmpty else {
                notice = "Attach files once the reply has finished."
                return
            }
            var m = ChatMessage(role: .user, content: body)
            m.steer = true
            queued[id, default: []].append(m)
            return
        }
        guard !body.isEmpty || !images.isEmpty, streamingID == nil, let id = selection, let i = index(id) else { return }
        // A Code chat needs its folder first (the chat view asks for one).
        if conversations[i].isCode && conversations[i].projectPath == nil { return }
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
        case "/secret", "/secrets": showAddSecret = true
        case "/skill-reload", "/skills-reload", "/reload": reloadSkills()
        case "/commands":
            let list = CommandStore.all(project: currentProject).filter(\.enabled)
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

    /// The project whose .ingle rules and commands apply: the Code chat's folder, else the editor's workspace.
    private var currentProject: String? { current?.codeFolder ?? EditorBridge.shared.freshContext?.workspace }

    func reloadSkills() {
        skills = SkillStore.all()
        MCPManager.shared.reload()
        SemanticMatcher.shared.clearCache()
        let rules = RuleStore.all(project: currentProject).count
        let servers = MCPManager.shared.servers.count
        notice = "Reloaded · \(skills.count) skill\(skills.count == 1 ? "" : "s") · \(rules) rule\(rules == 1 ? "" : "s") · \(servers) MCP server\(servers == 1 ? "" : "s")"
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.notice = nil
        }
    }

    func regenerate() {
        guard let id = selection, let i = index(id), streamingID == nil else { return }
        // A reply that carries a run's checkpoint stays as a small stub, so that run's changes panel (and Undo) stay.
        var kept: [ChatMessage] = []
        while let last = conversations[i].messages.last, !last.isRealUser, last.compactedCount == nil {
            if let cp = last.checkpoint, cp.undone != true {
                var stub = ChatMessage(role: .assistant, content: "", model: last.model)
                stub.id = last.id
                stub.checkpoint = cp
                kept.insert(stub, at: 0)
            }
            conversations[i].messages.removeLast()
        }
        conversations[i].messages += kept
        generate(in: id)
    }

    /// The chat's task list. The plan file follows it: steps ticked, status approved → done (and its card too).
    func setTasks(_ id: Conversation.ID, _ list: [TaskItem]) {
        guard let i = index(id) else { return }
        conversations[i].tasks = list
        guard let file = conversations[i].planFile else { return }
        PlanFiles.tickFile(file, tasks: list, status: "approved")
        if let status = PlanFiles.read(file)?.status,
           let k = conversations[i].messages.firstIndex(where: { $0.plan?.file == file }),
           conversations[i].messages[k].plan?.status != status {
            conversations[i].messages[k].plan?.status = status
        }
    }

    /// Saves a plan reply as a Markdown file (the project's .ingle/plans, or ~/.ingle/plans), or nil.
    func savePlanFile(_ id: Conversation.ID, reply: String, request: String, project: String?) -> PlanRef? {
        let body: String = ThinkSplitter.split(reply, extra: "").body
        let steps: [String] = TaskList.fromPlan(body).map(\.content)
        guard steps.count >= 2 else { return nil }
        let doc: PlanFiles.Doc = PlanFiles.fromReply(body, steps: steps, request: request, chat: id.uuidString)
        guard let file = PlanFiles.save(doc, in: PlanFiles.dir(project: project)) else { return nil }
        return PlanRef(file: file, name: (file as NSString).lastPathComponent, status: "draft")
    }

    /// Takes back a message waiting to join the run.
    func unqueue(_ chat: Conversation.ID, _ messageID: ChatMessage.ID) {
        queued[chat]?.removeAll { $0.id == messageID }
        if queued[chat]?.isEmpty == true { queued[chat] = nil }
    }

    /// The current chat's mode (the Mode pill; ⇧Tab cycles). Going into Plan remembers the mode to come back to.
    func setWorkMode(_ mode: WorkMode) {
        guard let id = selection, let i = index(id) else { return }
        let was: WorkMode = conversations[i].workModeValue
        if mode == .plan && was != .plan { conversations[i].modeBefore = was.rawValue }
        conversations[i].workMode = mode == .ask ? nil : mode.rawValue
        if !conversations[i].messages.isEmpty { save() }
    }

    /// ⇧Tab in the message box.
    func cycleWorkMode() {
        guard let c = current else { return }
        setWorkMode(c.workModeValue.next)
        notice = "Mode: \(c.workModeValue.next.label) — \(c.workModeValue.next.role)"
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.notice = nil
        }
    }

    /// Approve under a plan reply: plan mode off, the plan becomes the task list, and the work starts.
    func approvePlan(_ messageID: ChatMessage.ID) {
        guard let id = selection, let i = index(id), streamingID == nil,
              let m = conversations[i].messages.first(where: { $0.id == messageID }), m.role == .assistant else { return }
        let back: WorkMode = conversations[i].modeBefore.flatMap(WorkMode.init(rawValue:)) ?? .ask
        conversations[i].modeBefore = nil
        conversations[i].workMode = back == .plan || back == .ask ? nil : back.rawValue
        // The plan file, as you left it, is what runs.
        let doc: PlanFiles.Doc? = m.plan.flatMap { PlanFiles.read($0.file) }
        if let plan = m.plan, doc != nil, let k = conversations[i].messages.firstIndex(where: { $0.id == messageID }) {
            conversations[i].planFile = plan.file
            conversations[i].messages[k].plan?.status = "approved"
        }
        let list: [TaskItem] = doc.map(PlanFiles.tasks) ?? TaskList.fromPlan(ThinkSplitter.split(m.content, extra: "").body)
        if !list.isEmpty { setTasks(id, list) }
        conversations[i].messages.append(ChatMessage(role: .user, content: TaskList.planApproved))
        generate(in: id)
    }

    func stop() {
        resolve(false)
        task?.cancel()
        activeOllamaStream?.cancel()
    }

    func thoughtMonitorSnapshot() -> [String: Any] {
        guard let id = streamingID, let i = index(id),
              let message = conversations[i].messages.last(where: { $0.role == .assistant }) else {
            return ["active": false]
        }
        return [
            "active": true,
            "chatId": id.uuidString,
            "model": message.model ?? "",
            "thinking": message.thinking,
            "content": message.content,
            "deciderIntervened": message.deciderIntervened == true,
        ]
    }

    // MARK: Approvals

    func resolve(_ allow: Bool, always: Bool = false) {
        if always, let p = pending, !p.scope.key.isEmpty, p.secretUse == nil {
            sessionAllowed[p.scope.key] = p.scope.label
        }
        approval?.resume(returning: allow)
        approval = nil
        pending = nil
    }

    func requestApproval(_ id: Conversation.ID, _ call: ToolCall, _ info: MacTools.Info, secretUse: Secrets.Use? = nil) async -> Bool {
        let scope: MacTools.ApprovalScope = MacTools.approvalScope(call)
        // Secrets are approved one use at a time: never from a session allowance.
        if secretUse == nil, !scope.key.isEmpty, sessionAllowed[scope.key] != nil { return true }
        // Edit / Auto mode: some calls inside the project go ahead without asking (the tool row says so).
        if secretUse == nil, let i = index(id) {
            let conv: Conversation = conversations[i]
            let root: String? = conv.codeFolder ?? ((conv.useEditor ?? true) ? EditorBridge.shared.freshContext?.workspace : nil)
            if let note = conv.workModeValue.autoApproval(call, root: root) {
                autoApproved[id] = note
                return true
            }
        }
        return await withCheckedContinuation { continuation in
            approval = continuation
            pending = PendingApproval(conversation: id, call: call, info: info, scope: scope, secretUse: secretUse)
        }
    }

    /// Asks for a call that uses secrets (card, then Touch ID if on), reads the values and runs it with them put in.
    /// The output comes back with the values scrubbed. Returns nil if the user said no.
    private func runWithSecrets(_ call: ToolCall, _ use: Secrets.Use, info: MacTools.Info, chat id: Conversation.ID,
                                model: String, web: Bool, mac: Bool, commands: [IngleCommand]) async -> String? {
        guard await requestApproval(id, call, info, secretUse: use) else { return nil }
        if Prefs.secretsTouchID {
            let ok: Bool = await Secrets.confirmPresence("use \(use.names.joined(separator: ", ")) for \(use.destination)")
            if !ok { return nil }
        }
        activity = "Getting \(use.names.joined(separator: ", ")) from the Keychain…"
        let values: [String: String] = await Secrets.values(use.names)
        activity = nil
        let missing: [String] = use.names.filter { values[$0] == nil }
        if !missing.isEmpty {
            return "Couldn’t read \(missing.joined(separator: ", ")) from the Keychain (macOS may have asked and been refused). Nothing was run."
        }
        let prepared = Secrets.substitute(call, values)
        activity = info.title + "…"
        let output: String = await runTool(prepared.call, chat: id, model: model, web: web, mac: mac, commands: commands, env: prepared.env)
        activity = nil
        return Secrets.Scrubber(values).scrub(output)
    }

    /// Ask again for everything allowed this session.
    func forgetSessionApprovals() { sessionAllowed.removeAll() }

    // MARK: The generation loop

    private func generate(in id: Conversation.ID) {
        streamingID = id
        let effort: EffortLevel = index(id).map { conversations[$0].effortLevel } ?? .medium
        let reasoning: Bool = index(id).map { conversations[$0].reasoningOn } ?? false
        let run = Checkpoints.Run(chat: id.uuidString, run: UUID().uuidString)
        let firstNew: Int = index(id).map { conversations[$0].messages.count } ?? 0
        let progressMessageID = UUID()
        if reasoning, let i = index(id) {
            let model = conversations[i].model
            var progress = ChatMessage(role: .assistant, content: "", model: model)
            progress.id = progressMessageID
            progress.workflowProgress = true
            progress.thinkingPhases = [
                ThinkingPhase(title: "Summarising", content: "Preparing the context summary and checking saved memory…", status: "Starting"),
                ThinkingPhase(title: "Understanding", content: "Waiting for the summary and research…", status: "Waiting"),
                ThinkingPhase(title: "Thinking", content: "Waiting for the context report…", status: "Waiting"),
            ]
            conversations[i].messages.append(progress)
            save()
        }
        activeRuns[id] = run
        // A finished task list goes when the next job starts; an unfinished one stays (e.g. "carry on" after Stop).
        if let i = index(id), conversations[i].tasks != nil, TaskList.allDone(conversations[i].tasks) {
            conversations[i].tasks = nil
            conversations[i].planFile = nil
        }
        task = Task { [self] in
            // Engine asleep or stopped? Start it now rather than making the user press Start.
            if !(await OllamaServer.shared.isUp()) {
                activity = "Starting the engine…"
                updateThinkingStage(id, messageID: progressMessageID, title: "Summarising", status: "Waiting for engine")
                await OllamaServer.shared.ensureRunning()
                for _ in 0..<60 {
                    if await OllamaServer.shared.isUp() { break }
                    try? await Task.sleep(for: .milliseconds(250))
                }
                await ModelManager.current?.refresh()
                activity = nil
            }
            updateThinkingStage(id, messageID: progressMessageID, title: "Summarising", status: "In progress",
                                content: "Summarising earlier messages and checking saved memory…")
            // What you're working on, and rules/skills that clearly match this message, attached up front.
            let startConv = index(id).map { conversations[$0] }
            var turnSummary = ""
            var turnSummaryPhase = ""
            var turnMemoryNotes = ""
            var currentRequest = ""
            var exactTurn = ""
            var understandingText = ""
            var turnResearchText = ""
            var followupInterpretation: String?
            if reasoning, let initial = startConv,
               let followupIndex = initial.messages.lastIndex(where: { $0.isRealUser }),
               followupIndex >= 0 {
                let prior = initial.messages[..<followupIndex].reversed().filter { $0.isRealUser || $0.role == .assistant }.prefix(2).reversed()
                exactTurn = prior.map { m in
                    "\(m.isRealUser ? "User" : "Assistant"): \(ThinkSplitter.split(m.content, extra: "").body)"
                }.joined(separator: "\n\n")
                currentRequest = initial.messages[followupIndex].content
                let memoryNotes = Prefs.memoryEnabled
                    ? MemoryStore.search(([currentRequest, exactTurn].filter { !$0.isEmpty }).joined(separator: "\n"))
                    : "Memory is disabled."
                let hasMemoryMatch = Prefs.memoryEnabled && !memoryNotes.localizedCaseInsensitiveContains("Nothing in memory")
                turnMemoryNotes = hasMemoryMatch ? memoryNotes : ""
                turnSummary = await summarizeForTurn(initial, before: followupIndex, request: currentRequest, memory: memoryNotes)
                var summaryDetails: [String] = []
                if hasMemoryMatch { summaryDetails.append("Saved memory checked:\n\(memoryNotes)") }
                summaryDetails.append("Context summary:\n\(turnSummary.isEmpty ? "Current request: \(currentRequest)" : turnSummary)")
                turnSummaryPhase = summaryDetails.joined(separator: "\n\n")
                updateThinkingStage(id, messageID: progressMessageID, title: "Summarising", status: "Done", content: turnSummaryPhase)
                updateThinkingStage(id, messageID: progressMessageID, title: "Understanding", status: "Waiting",
                                    content: "Waiting for summary and research…")
                activity = nil
            }
            // Code mode: the chat's folder is the project; the editor's context isn't used.
            let codeFolder: String? = startConv?.codeFolder
            let editor = (codeFolder == nil && (startConv?.useEditor ?? true)) ? EditorBridge.shared.freshContext : nil
            let project: String? = codeFolder ?? editor?.workspace
            var git: Project.Git? = nil
            if let codeFolder { git = await Project.git(codeFolder) }
            var attachedNames: [String] = []     // shown on the reply's chip: things actually in use
            var attachedText = ""
            var suggestions: [String] = []       // matched, offered, not loaded
            var usedNames: [String] = []         // skills/rules/reports the assistant actually opened
            // Commands that apply to this request — enforced below, not just suggested.
            let originalRequest = startConv?.messages.last(where: { $0.isRealUser })?.content ?? ""
            if currentRequest.isEmpty { currentRequest = originalRequest }
            var requestText = originalRequest
            var tracker = CommandTracker(CommandStore.active(for: requestText, project: project))
            for c in tracker.commands {
                attachedNames.append("⚑ " + c.name)
                for r in c.mustUse where r.hasPrefix("skill:") {
                    let skill = String(r.dropFirst(6))
                    attachedText += "### Skill: \(skill) (required by the command \(c.name) — follow it)\n\(String(SkillStore.read(skill).prefix(12_000)))\n\n"
                }
            }
            if let startConv {
                let lastUser = [startConv.messages.last(where: { $0.isRealUser })?.content ?? "", followupInterpretation ?? ""].joined(separator: "\n")
                let query = lastUser + " " + [editor?.language, editor?.fileName].compactMap { $0 }.joined(separator: " ")
                let rulePool = RuleStore.all(project: project).filter { !$0.always }
                let skillPool = SkillStore.all()
                let reportPool = ReportStore.all().prefix(60)
                var candidates: [SemanticMatcher.Candidate] = []
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
                    // Matches are suggestions; the assistant loads one only if it clearly applies.
                    if hit.hasPrefix("rule:") {
                        let name = String(hit.dropFirst(5))
                        suggestions.append("- rule \(name) — use_rule(\"\(name)\")")
                    } else if hit.hasPrefix("report:") {
                        let name = String(hit.dropFirst(7))
                        suggestions.append("- earlier research \(name) — report_read(\"\(name)\")")
                    } else if hit.hasPrefix("skill:"), !attachedNames.contains(String(hit.dropFirst(6))) {
                        let name = String(hit.dropFirst(6))
                        suggestions.append("- skill \(name) — use_skill(\"\(name)\")")
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

            // Code mode: the project at a glance, ranked for this request (at most ~1,500 tokens), once per request.
            var repoMap = ""
            let researchFolder = codeFolder ?? ((startConv?.useEditor ?? true) ? editor?.workspace : nil)
            let webResearchCues = ["research", "source", "citation", "prove", "verify", "fact-check", "look up", "search the web",
                                   "current", "latest", "today", "price", "news", "evidence", "deep dive"]
            let webResearchExpected = (startConv?.webOn ?? false) && webResearchCues.contains(where: { requestText.lowercased().contains($0) })
            let researchExpected = researchFolder != nil || webResearchExpected
            if reasoning && researchExpected {
                updateThinkingStage(id, messageID: progressMessageID, title: "Research", status: "In progress",
                                    content: "Checking relevant project files and web sources…")
            }
            if let researchFolder, let startConv {
                repoMap = await RepoMap.promptSection(root: researchFolder, query: requestText,
                                                      contextTokens: Prefs.contextLength(for: startConv.model))
            }
            if reasoning, let startConv {
                turnResearchText = await researchForTurn(model: startConv.model, query: requestText,
                    summary: turnSummary, understanding: "", projectContext: repoMap,
                    webOn: startConv.webOn)
            }
            if !turnResearchText.isEmpty {
                updateThinkingStage(id, messageID: progressMessageID, title: "Research", status: "Done", content: turnResearchText)
            } else {
                removeThinkingStage(id, messageID: progressMessageID, title: "Research")
            }
            let selectedModel = startConv?.model ?? Prefs.dailyModel
            let lowModel = Prefs.dailyModel.isEmpty ? selectedModel : Prefs.dailyModel
            if reasoning {
            // Understanding runs after research so its report can integrate the past-chat summary,
            // saved-memory matches, and any relevant project or web findings in one place.
            let reportPrompt = """
            Create a concise context report for the selected assistant model. Integrate the user's current intent with the relevant past messages, summary, saved-memory matches, and research findings below. Resolve references such as “redo” or “that”; preserve requested verification, source, and formatting constraints. Use short labelled sections. Include only information relevant to this request. Do not answer the request and do not repeat the full conversation.

            Current user request:
            \(currentRequest)

            Immediately preceding exchange:
            \(exactTurn.isEmpty ? "(None.)" : exactTurn)

            Past-chat summary:
            \(turnSummary.isEmpty ? "(No earlier messages.)" : turnSummary)

            Saved-memory findings:
            \(turnMemoryNotes.isEmpty ? "(No relevant saved-memory matches.)" : turnMemoryNotes)

            Research findings:
            \(turnResearchText.isEmpty ? "(No additional research was needed.)" : turnResearchText)
            """
            var report = ""
            updateThinkingStage(id, messageID: progressMessageID, title: "Understanding", status: "In progress",
                                content: "Interpreting the request and preparing the context report…")
            do {
                let stream = OllamaClient().chat(model: lowModel,
                    messages: [["role": "user", "content": reportPrompt]], tools: nil,
                    think: .off, numCtx: Prefs.contextLength(for: lowModel), keepAlive: Prefs.keepAlive)
                for try await chunk in stream { report += chunk.content }
            } catch { report = "Use the current request with the available summary and research. If a reference remains ambiguous, ask one concise clarification." }
            understandingText = ThinkSplitter.split(report, extra: "").body.trimmingCharacters(in: .whitespacesAndNewlines)
            if understandingText.isEmpty { understandingText = "Follow the current request using the available summary and research. If a reference remains ambiguous, ask one concise clarification." }
            updateThinkingStage(id, messageID: progressMessageID, title: "Understanding", status: "Done", content: understandingText)
            updateThinkingStage(id, messageID: progressMessageID, title: "Thinking", status: "Waiting",
                                content: "Waiting for the selected model…")
            followupInterpretation = "## Context report\n\(understandingText)\nUse this report as the complete interpretation of earlier context; do not reread prior chat messages."
            requestText = [originalRequest, followupInterpretation].compactMap { $0 }.joined(separator: "\n")
            }

            // Local models cost nothing per step: keep going until done, stopped, or clearly stuck (200 is a backstop).
            let maxSteps = 200
            // Scrubs every saved secret's value from tool output; read from the Keychain at the first tool result.
            var scrubber: Secrets.Scrubber?
            var callCounts: [String: Int] = [:]
            var skips = 0
            // Effort (Effort.swift): High/Max verify after editing, Max plans first and has the changes reviewed.
            var changedFiles: [String] = []
            var turnThinking = ""
            var turnToolingText = ""
            var turnActionEntries: [String] = []
            var actionInProgress = false
            var selectedToolNames = Set<String>()
            var toolingDecisionMade = false
            var verifyChecked = false
            var verifyMissing = false
            // Max: plan first (into the task list). Plan mode makes its own plan instead.
            let startMode: WorkMode = startConv?.workModeValue ?? .ask
            var needPlan: Bool = effort.plan && startMode != .plan && startMode != .debug
            // Debug: Reproduce → Find the cause → Fix → Confirm, enforced below.
            var dbg: DebugState? = startMode == .debug ? DebugState() : nil
            if dbg != nil, let i = index(id), TaskList.allDone(conversations[i].tasks) { setTasks(id, DebugState.tasks) }
            for _ in 0..<maxSteps {
                guard let i0 = index(id) else { break }
                // Steer: messages typed during the run join it here, after the last step's tool results.
                if let waiting = queued[id], !waiting.isEmpty {
                    queued[id] = nil
                    conversations[i0].messages += waiting
                    save()
                }
                guard let i = index(id) else { break }
                let conv = conversations[i]
                let planMode: Bool = conv.workModeValue == .plan
                let model = conv.model
                let vision = await supportsVision(model)
                let turnStart = conv.messages.lastIndex(where: { $0.isRealUser }) ?? conv.messages.count
                // With reasoning on, the context report stands in for earlier messages; off, the model sees them as before.
                var history = historyJSON(conv, vision: vision, startingAt: reasoning ? turnStart : nil)
                var system: [String] = []
                if let followupInterpretation { system.append(followupInterpretation) }
                var tools: [[String: Any]] = []
                // Mac control is off in Code mode, whatever the chat's Mac switch says.
                let mac: Bool = conv.macAccess && codeFolder == nil
                if let persona = Persona.systemPrompt(for: model, web: conv.webOn, codeFolder: codeFolder) { system.append(persona) }
                if let block = CommandStore.promptBlock(tracker.commands) { system.append(block) }
                // Only the short INGLE.md index goes in; details load on demand through tools.
                system.append(IngleManifest.refresh(macAccess: mac, project: project, web: conv.webOn, currentChat: id, code: codeFolder != nil))
                if let codeFolder { system.append(Project.promptSection(codeFolder, git: git)) }
                if let editor {
                    system.append(editor.promptSection)
                    if let projectRules = editor.projectInstructions { system.append(projectRules) }
                }
                if !attachedText.isEmpty {
                    system.append("## Loaded for this request\n" + attachedText)
                }
                if !effort.promptLine.isEmpty { system.append("## Effort\n" + effort.promptLine) }
                let modeLine: String = conv.workModeValue.promptLine
                if !modeLine.isEmpty { system.append(modeLine) }
                let taskSection: String = TaskList.prompt(conv.tasks)
                if !taskSection.isEmpty { system.append(taskSection) }
                if !suggestions.isEmpty {
                    system.append("## Possibly relevant (matched automatically — load one with its tool only if it clearly applies to this request; otherwise ignore them)\n" + suggestions.joined(separator: "\n"))
                }
                tools.append(MacTools.helpTool)
                if Prefs.memoryEnabled {
                    system.append(MemoryStore.systemPrompt)
                    system.append("Saved memory was already checked during Summarising. Use the relevant facts in the context report; repeat a memory lookup only if the current request needs a different detail.")
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
                let lastText = ((conv.messages.last(where: { $0.isRealUser })?.content ?? "") + "\n" + (followupInterpretation ?? "")).lowercased()
                if lastText.contains("skill") || lastText.contains("rule") { tools += KnowledgeTools.builderDefinitions }
                if !SkillStore.all().isEmpty { tools.append(SkillStore.toolDefinition) }
                if !Secrets.all().isEmpty { tools.append(Secrets.listDefinition) }
                if RuleStore.all(project: project).contains(where: { !$0.always }) { tools.append(RuleStore.toolDefinition) }
                // Terminal (files, commands) is always available and asks first; controlling the Mac needs the Mac button.
                system.append(codeFolder == nil ? MacTools.systemPrompt : MacTools.codePrompt)
                tools += MacTools.definitions
                if codeFolder != nil { tools += CodeTools.definitions + CodeIntel.definitions }
                if !MCPManager.shared.servers.isEmpty { tools += MacTools.mcpTools }
                if mac {
                    system.append(MacTools.controlPrompt)
                    tools += MacTools.controlDefinitions
                }
                // Everything this chat may use (the Web and Mac switches still apply). A command can bring back
                // any of it, but never a tool that's switched off.
                var pool: [[String: Any]] = tools
                pool += KnowledgeTools.builderDefinitions
                pool.append(CommandStore.toolDefinition)
                if reasoning && !toolingDecisionMade {
                    toolingDecisionMade = true
                    updateThinkingStage(id, messageID: progressMessageID, title: "Tooling", status: "In progress",
                                        content: "Selecting only the tools and skills this job needs…")
                    let toolChoices = pool.map { def -> String in
                        let fn = def["function"] as? [String: Any] ?? [:]
                        let name = fn["name"] as? String ?? ""
                        let description = fn["description"] as? String ?? ""
                        return "\(name): \(description.prefix(180))"
                    }.joined(separator: "\n")
                    let skillChoices = SkillStore.all().prefix(40).map { "\($0.name): \($0.description)" }.joined(separator: "\n")
                    let prompt = """
                    Choose only tools and skills that are genuinely needed for the current job. Use the context report and current request. Choose the smallest useful set. Select exact names only from the lists. Never select a tool that is not listed. Return JSON only: {"tools":[],"skills":[],"reason":"short explanation"}. If no tools or skills are needed, return empty arrays and an empty reason.

                    Context report:
                    \(understandingText)

                    Current request:
                    \(originalRequest)

                    Available tools:
                    \(toolChoices)

                    Available skills:
                    \(skillChoices.isEmpty ? "(none)" : skillChoices)
                    """
                    var choiceText = ""
                    do {
                        let stream = OllamaClient().chat(model: lowModel,
                            messages: [["role": "user", "content": prompt]], tools: nil,
                            think: .off, numCtx: Prefs.contextLength(for: lowModel), keepAlive: Prefs.keepAlive)
                        for try await chunk in stream { choiceText += chunk.content }
                    } catch { choiceText = "" }
                    if let left = choiceText.firstIndex(of: "{"), let right = choiceText.lastIndex(of: "}"), left <= right,
                       let data = String(choiceText[left...right]).data(using: .utf8),
                       let decision = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        let availableNames = Set(pool.map(ToolSelection.name))
                        selectedToolNames = Set((decision["tools"] as? [String] ?? []).filter { availableNames.contains($0) })
                        let selectedSkills = (decision["skills"] as? [String] ?? []).compactMap { wanted in
                            SkillStore.all().first { $0.name.caseInsensitiveCompare(wanted) == .orderedSame }
                        }
                        for skill in selectedSkills where !attachedNames.contains(skill.name) {
                            attachedNames.append(skill.name)
                            attachedText += "### Skill: \(skill.name) (selected for this request)\n\(String(SkillStore.read(skill.name).prefix(12_000)))\n\n"
                        }
                        if !selectedToolNames.isEmpty || !selectedSkills.isEmpty {
                            let toolLine = selectedToolNames.isEmpty ? "" : "Tools selected: \(selectedToolNames.sorted().joined(separator: ", "))"
                            let skillLine = selectedSkills.isEmpty ? "" : "Skills selected: \(selectedSkills.map(\.name).joined(separator: ", "))"
                            let reason = (decision["reason"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                            turnToolingText = ([toolLine, skillLine, reason].filter { !$0.isEmpty }).joined(separator: "\n")
                            updateThinkingStage(id, messageID: progressMessageID, title: "Tooling", status: "Done", content: turnToolingText)
                            system.append("## Tool and skill choices\n\(turnToolingText)")
                            if !attachedText.isEmpty { system.append("## Selected skill details\n\(attachedText)") }
                        } else {
                            removeThinkingStage(id, messageID: progressMessageID, title: "Tooling")
                        }
                    } else {
                        removeThinkingStage(id, messageID: progressMessageID, title: "Tooling")
                    }
                }
                tools = ToolSelection.filter(tools, lastUserText: lastText, filtering: effort.filtering)
                if lastText.contains("command") { tools.append(CommandStore.toolDefinition) }
                for def in pool where selectedToolNames.contains(ToolSelection.name(def)) && !tools.contains(where: { ToolSelection.name($0) == ToolSelection.name(def) }) {
                    tools.append(def)
                }
                // The task list: offered from Medium up (Low keeps the tool list short), and always while one is going.
                if effort != .low || planMode || !TaskList.allDone(conv.tasks) { tools.append(TaskList.definition) }
                // Commands: tools they require are always offered (still approved
                // per call); tools they ban are taken away.
                var have = Set(tools.map(ToolSelection.name))
                let required: Set<String> = tracker.requiredTools
                for def in pool {
                    let name = ToolSelection.name(def)
                    guard required.contains(name), !have.contains(name) else { continue }
                    tools.append(def)
                    have.insert(name)
                }
                let banned = tracker.blocked
                if !banned.isEmpty { tools.removeAll { banned.contains(ToolSelection.name($0).lowercased()) } }
                // Plan mode: only reading and searching (plus the task list and the read-only helper).
                if planMode { tools.removeAll { !TaskList.planModeTools.contains(ToolSelection.name($0)) } }
                // A command that still can't get its tool (e.g. web_search with Web off) gets ⚠ now, no nudges.
                tracker.checkAvailability(offered: Set(tools.map(ToolSelection.name)))
                // Only this turn's messages are sent; older turns are represented by the temporary summary.
                let toolChars: Int = (try? JSONSerialization.data(withJSONObject: tools))?.count ?? 0
                let ctx: Int = Prefs.contextLength(for: model)
                func fixedTokens() -> Int { (system.joined(separator: "\n\n").count + toolChars) / 4 }
                // Still too big (huge tool outputs in the current task): shorten old tool results so nothing is cut off silently.
                history = fit(history, budget: ctx * 9 / 10 - fixedTokens())
                if !system.isEmpty {
                    history.insert(["role": "system", "content": system.joined(separator: "\n\n")], at: 0)
                }
                func phaseRows(thinking: String, pending: Bool = false) -> [ThinkingPhase] {
                    var rows: [ThinkingPhase] = []
                    rows.append(ThinkingPhase(title: "Summarising", content: turnSummaryPhase, status: "Done"))
                    if !turnResearchText.isEmpty { rows.append(ThinkingPhase(title: "Research", content: turnResearchText, status: "Done")) }
                    rows.append(ThinkingPhase(title: "Understanding", content: understandingText, status: "Done"))
                    if !turnToolingText.isEmpty { rows.append(ThinkingPhase(title: "Tooling", content: turnToolingText, status: "Done")) }
                    rows.append(ThinkingPhase(title: "Thinking", content: thinking.isEmpty && !pending ? "No separate thinking trace was provided." : thinking,
                                              status: pending ? "In progress" : "Done"))
                    if !turnActionEntries.isEmpty {
                        rows.append(ThinkingPhase(title: "Actions", content: turnActionEntries.joined(separator: "\n\n---\n\n"),
                                                  status: actionInProgress ? "In progress" : "Done"))
                    }
                    return rows
                }
                @MainActor func appendAction(_ title: String, detail: String, result: String, messageID: UUID) {
                    let entry = "### \(title)\n\n\(detail)\n\n\(result)"
                    turnActionEntries.append(entry)
                    actionInProgress = false
                    updateThinkingStage(id, messageID: messageID, title: "Actions", status: "Done",
                                        content: turnActionEntries.joined(separator: "\n\n---\n\n"))
                }
                // Max: a short plan first, then the work starts with it in history.
                if needPlan {
                    needPlan = false
                    if let p = conversations[i].messages.firstIndex(where: { $0.id == progressMessageID }) {
                        conversations[i].messages.remove(at: p)
                    }
                    if await writePlan(id, model: model, history: history, effort: effort) { continue }
                    break
                }
                var reply = ChatMessage(role: .assistant, content: "", model: model)
                reply.workflowHidden = true
                reply.thinkingPhases = phaseRows(thinking: "", pending: true)
                conversations[i].messages.append(reply)
                let chip = attachedNames + usedNames
                if !chip.isEmpty { reply.usedContext = chip }
                if let ri = conversations[i].messages.firstIndex(where: { $0.id == reply.id }) {
                    conversations[i].messages[ri] = reply
                }
                conversations[i].updated = Date()

                let started = Date()
                var thinkStart: Date?
                var thinkEnd: Date?
                var calls: [ToolCall] = []
                var stopLoop = false
                var lastStageThoughtCount = 0
                updateThinkingStage(id, messageID: progressMessageID, title: "Thinking", status: "In progress",
                                    content: "Reasoning from the context report…")

                if model == Prefs.dailyModel || model == Prefs.hardModel {
                    await ModelManager.current?.pauseAutocompleteIfSmart()
                }
                do {
                    let control = OllamaStreamControl()
                    activeOllamaStream = control
                    defer { if activeOllamaStream === control { activeOllamaStream = nil } }
                    let stream = OllamaClient().chat(
                        model: model, messages: history,
                        tools: tools.isEmpty ? nil : tools,
                        think: reasoning ? effort.think(for: model) : .off,
                        numCtx: Prefs.contextLength(for: model), keepAlive: Prefs.keepAlive,
                        control: control)
                    for try await chunk in stream {
                        try Task.checkCancellation()
                        guard let j = index(id), let k = conversations[j].messages.indices.last else { break }
                        if !chunk.thinking.isEmpty {
                            if thinkStart == nil { thinkStart = Date() }
                            turnThinking += chunk.thinking
                            conversations[j].messages[k].thinking += chunk.thinking
                            if turnThinking.count - lastStageThoughtCount >= 256 {
                                lastStageThoughtCount = turnThinking.count
                                updateThinkingStage(id, messageID: progressMessageID, title: "Thinking", status: "In progress",
                                                    content: String(turnThinking.suffix(8000)))
                            }
                        }
                        if !chunk.content.isEmpty {
                            if thinkStart != nil && thinkEnd == nil { thinkEnd = Date() }
                            conversations[j].messages[k].content += chunk.content
                        }
                        if chunk.resetToolCalls { calls.removeAll() }
                        if chunk.deciderIntervened { conversations[j].messages[k].deciderIntervened = true }
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
                    let split = ThinkSplitter.split(conversations[j].messages[k].content, extra: turnThinking)
                    conversations[j].messages[k].thinkingPhases = phaseRows(thinking: split.thinking)
                    conversations[j].messages[k].thinking = ""
                    updateThinkingStage(id, messageID: progressMessageID, title: "Thinking", status: "Done",
                                        content: split.thinking.isEmpty ? "The model is preparing its reply." : split.thinking)
                } else {
                    let split = ThinkSplitter.split(conversations[j].messages[k].content, extra: turnThinking)
                    if !split.body.isEmpty {
                        turnActionEntries.append("### Assistant step\n\n" + split.body)
                    }
                    conversations[j].messages[k].workflowHidden = true
                    conversations[j].messages[k].thinkingPhases = phaseRows(thinking: split.thinking)
                    conversations[j].messages[k].thinking = ""
                    updateThinkingStage(id, messageID: progressMessageID, title: "Thinking", status: "Done",
                                        content: split.thinking.isEmpty ? "The model requested an action." : split.thinking)
                    if !split.body.isEmpty {
                        updateThinkingStage(id, messageID: progressMessageID, title: "Actions", status: "Done",
                                            content: turnActionEntries.joined(separator: "\n\n---\n\n"))
                    }
                }
                if dbg != nil {
                    dbg?.saw(conversations[j].messages[k].content)
                    if let ticked = dbg?.tick(conversations[j].tasks) { setTasks(id, ticked) }
                }
                // Finished, but you typed something meanwhile: carry on with it rather than ending the run.
                if calls.isEmpty, queued[id]?.isEmpty == false { continue }
                if calls.isEmpty {
                    // Finished — unless a command hasn't been obeyed. Then send it back: everything owed in one
                    // nudge, each command twice at most.
                    if let ask = tracker.completionCheck() ?? dbg?.finishNudge() {
                        var nudge = ChatMessage(role: .user, content: ask)
                        nudge.nudge = true
                        conversations[j].messages.append(nudge)
                        save()
                        continue
                    }
                    var chips: [String] = tracker.chips
                    if verifyMissing { chips.append(EffortLevel.verifySkippedChip) }
                    if let d = dbg, d.edited, !d.confirmed { chips.append(DebugState.unconfirmedChip) }
                    if !chips.isEmpty {
                        conversations[j].messages[k].usedContext = (conversations[j].messages[k].usedContext ?? []) + chips
                    }
                    // Plan mode: the plan is saved as a Markdown file, shown as a card on the reply.
                    if planMode, conversations[j].messages[k].plan == nil,
                       let card = savePlanFile(id, reply: conversations[j].messages[k].content, request: requestText, project: project) {
                        conversations[j].messages[k].plan = card
                    }
                    // Max: a read-only helper reviews what changed, and its notes are shown.
                    if effort.review, !changedFiles.isEmpty, !Task.isCancelled {
                        await reviewChanges(id, model: model, web: conv.webOn, commands: tracker.commands,
                                            request: requestText, files: changedFiles)
                    }
                    conversations[j].messages[k].workflowHidden = false
                    break
                }

                for modelCall in calls {
                    if Task.isCancelled { break }
                    // Code mode: relative paths and missing working folders mean the project folder.
                    // get_problems: the check command it will run is filled in here, before the card is shown.
                    let call: ToolCall = CodeTools.prepare(Project.prepare(modelCall, folder: codeFolder),
                                                           folder: codeFolder, commands: tracker.commands)
                    let stageMessageID = progressMessageID
                    let signature = call.name + "|" + call.arguments.sorted { $0.key < $1.key }.map { $0.key + "=" + $0.value }.joined(separator: "&")
                    let repeats = (callCounts[signature] ?? 0) + 1
                    callCounts[signature] = repeats
                    if repeats >= effort.repeatLimit {
                        // Local models sometimes loop on the same call; nudge it instead of running it again.
                        skips += 1
                        guard let jr = index(id) else { break }
                        conversations[jr].messages.append(ChatMessage(
                            role: .tool, content: "You've already made this exact call \(repeats - 1) times and have its result above. Don't repeat it — use that result, try a different approach, or tell the user what's blocking you.",
                            toolName: call.name, toolTitle: "Skipped a repeated step", toolDetail: call.name, toolIcon: "arrow.triangle.2.circlepath"))
                        appendAction("Skipped a repeated step", detail: call.name,
                                     result: "The identical action was skipped after \(repeats - 1) earlier attempts.", messageID: stageMessageID)
                        continue
                    }
                    // Plan mode refuses anything that changes things, even a tool the model names without being offered it.
                    if planMode, !TaskList.planModeTools.contains(call.name), let jp = index(id) {
                        let info0 = MacTools.describe(call)
                        conversations[jp].messages.append(ChatMessage(
                            role: .tool, content: TaskList.planModeRefusal,
                            toolName: call.name, toolTitle: info0.title, toolDetail: "Plan mode: not run", toolIcon: "hand.raised", denied: true))
                        appendAction(info0.title, detail: "Plan mode: not run", result: TaskList.planModeRefusal, messageID: stageMessageID)
                        continue
                    }
                    // Debug mode: no edits until the failure is located and its cause stated.
                    if let why = dbg?.refusal(call.name), let jd = index(id) {
                        let info0 = MacTools.describe(call)
                        conversations[jd].messages.append(ChatMessage(
                            role: .tool, content: why,
                            toolName: call.name, toolTitle: info0.title, toolDetail: "Debug mode: not yet", toolIcon: "ladybug", denied: true))
                        appendAction(info0.title, detail: "Debug mode: not yet", result: why, messageID: stageMessageID)
                        continue
                    }
                    if let ban = tracker.blockingCommand(for: call), let jb = index(id) {
                        conversations[jb].messages.append(ChatMessage(
                            role: .tool, content: CommandTracker.blockedMessage(ban.command, ban.item),
                            toolName: call.name, toolTitle: "Blocked by a command", toolDetail: "\(ban.command.name) · \(ban.item)", toolIcon: "hand.raised", denied: true))
                        appendAction("Blocked by a command", detail: "\(ban.command.name) · \(ban.item)",
                                     result: CommandTracker.blockedMessage(ban.command, ban.item), messageID: stageMessageID)
                        continue
                    }
                    // command_create refuses advice-only commands before asking the user to approve anything.
                    if call.name == "command_create", let refusal = CommandStore.refusal(call), let jc = index(id) {
                        conversations[jc].messages.append(ChatMessage(
                            role: .tool, content: refusal,
                            toolName: call.name, toolTitle: "Create a command", toolDetail: refusal, toolIcon: "exclamationmark.shield"))
                        appendAction("Create a command", detail: "Request rejected by command safety rules", result: refusal, messageID: stageMessageID)
                        continue
                    }
                    let info = MacTools.describe(call)
                    actionInProgress = true
                    turnActionEntries.append("### \(info.title)\n\n\(info.detail)\n\n**Status:** In progress")
                    updateThinkingStage(id, messageID: stageMessageID, title: "Actions", status: "In progress",
                                        content: turnActionEntries.joined(separator: "\n\n---\n\n"))
                    let deniedText = "The user denied this action. Don't retry it; ask them what they'd like instead."
                    var allowed = true
                    var ran = true
                    var output = deniedText
                    lastToolImages = []
                    switch Secrets.check(call) {
                    case .refuse(let why):
                        output = why
                        ran = false
                    case .use(let use):
                        if let result = await runWithSecrets(call, use, info: info, chat: id, model: model, web: conv.webOn, mac: mac, commands: tracker.commands) {
                            output = result
                        } else {
                            allowed = false
                        }
                    case .none, .passThrough:
                        if MacTools.needsApproval(call, codeFolder: codeFolder) {
                            allowed = await requestApproval(id, call, info)
                        }
                        if allowed {
                            activity = info.title + "…"
                            output = await runTool(call, chat: id, model: model, web: conv.webOn, mac: mac, commands: tracker.commands)
                            activity = nil
                        }
                    }
                    // Never let a secret's value reach the model or the history, even one this call didn't use.
                    if !Secrets.all().isEmpty {
                        if scrubber == nil { scrubber = await Secrets.scrubber() }
                        output = scrubber?.scrub(output) ?? output
                    }
                    tracker.record(call, succeeded: allowed && ran)
                    if allowed && ran, dbg != nil {
                        dbg?.record(call.name)
                        if let jt = index(id), let ticked = dbg?.tick(conversations[jt].tasks) { setTasks(id, ticked) }
                    }
                    let autoNote: String? = autoApproved.removeValue(forKey: id)
                    // High/Max: the first file change brings in the project's check command (unless a command's
                    // then_run already covers it). CommandTracker enforces it like then_run: same nudges, same ⚠.
                    if allowed && ran, CommandStore.fileChangingTools.contains(call.name) {
                        let full: String = Prefs.expand(call.arg("path"))
                        if !full.isEmpty, !changedFiles.contains(full) { changedFiles.append(full) }
                        if effort.verify, !verifyChecked, !full.isEmpty, !tracker.commands.contains(where: { $0.thenRun != nil }) {
                            verifyChecked = true
                            let stop: String? = project.flatMap { full.hasPrefix($0 + "/") ? $0 : nil }
                            if let check = EffortLevel.detectCheckCommand(from: full, stopAt: stop) {
                                tracker.add(EffortLevel.verifyCommand(check))
                            } else {
                                verifyMissing = true
                            }
                        }
                    }
                    // Show a skill, rule or report on the chip once the assistant has actually opened it.
                    if allowed, ["use_skill", "use_rule", "report_read"].contains(call.name) {
                        let opened = call.arg("name").trimmingCharacters(in: .whitespaces)
                        let label = call.name == "report_read" ? "report: " + opened : opened
                        if !opened.isEmpty, !usedNames.contains(label), !attachedNames.contains(label) {
                            usedNames.append(label)
                            if let ju = index(id), let ku = conversations[ju].messages.lastIndex(where: { $0.role == .assistant }) {
                                var chip = conversations[ju].messages[ku].usedContext ?? []
                                chip.append(label)
                                conversations[ju].messages[ku].usedContext = chip
                            }
                        }
                    }
                    guard let j2 = index(id) else { break }
                    var toolMessage = ChatMessage(
                        role: .tool, content: output, toolName: call.name,
                        toolTitle: info.title, toolDetail: info.detail, toolIcon: info.icon, denied: !allowed)
                    if allowed { toolMessage.autoApproved = autoNote }
                    if !lastToolImages.isEmpty {
                        toolMessage.imageFiles = lastToolImages
                        if !vision {
                            var text = ""
                            for f in lastToolImages { text += await ImageStore.recognizeText(f) + "\n" }
                            toolMessage.imageText = text
                        }
                    }
                    conversations[j2].messages.append(toolMessage)
                    let resultText = output.isEmpty ? "(No output)" : output
                    turnActionEntries[turnActionEntries.count - 1] = "### \(info.title)\n\n\(info.detail)\n\n\(resultText)"
                    actionInProgress = false
                    updateThinkingStage(id, messageID: stageMessageID, title: "Actions", status: "Done",
                                        content: turnActionEntries.joined(separator: "\n\n---\n\n"))
                }
                save()
                if skips >= effort.stuckLimit, let js = index(id) {
                    var note = ChatMessage(role: .assistant, content: "I seem to be going round in circles, so I’ve stopped. Tell me what to try next, or say “carry on” to let me keep going.", model: model)
                    note.failed = true
                    conversations[js].messages.append(note)
                    break
                }
            }
            activeRuns[id] = nil
            if let i = index(id), let progress = conversations[i].messages.firstIndex(where: { $0.id == progressMessageID }) {
                let progressPhases = conversations[i].messages[progress].thinkingPhases
                let visibleRunReply = conversations[i].messages.indices.last(where: {
                    $0 >= firstNew && $0 != progress && conversations[i].messages[$0].role == .assistant &&
                    conversations[i].messages[$0].workflowHidden != true
                })
                if visibleRunReply == nil, let lastInternal = conversations[i].messages.indices.last(where: {
                    $0 >= firstNew &&
                    conversations[i].messages[$0].role == .assistant && conversations[i].messages[$0].workflowHidden == true
                }) {
                    conversations[i].messages[lastInternal].workflowHidden = false
                    conversations[i].messages[lastInternal].thinkingPhases = progressPhases
                }
                conversations[i].messages.remove(at: progress)
            }
            endRun(id, run: run, firstNew: firstNew)
            streamingID = nil
            activity = nil
            // The menu bar shows which assistant is awake: refresh it now the reply's model (and any helper) has run.
            Task { await ModelManager.current?.refresh() }
            // Messages still waiting (Stop, or the run ended between steps) go back in the message box, not lost.
            if let left = queued[id], !left.isEmpty {
                queued[id] = nil
                incoming = IncomingDraft(conversation: id, text: left.map(\.content).joined(separator: "\n\n"), attachment: nil)
            }
            save()
        }
    }

    // MARK: Checkpoints (undo a whole run)

    private func updateThinkingStage(_ chatID: Conversation.ID, messageID: UUID, title: String,
                                     status: String, content: String? = nil) {
        guard let i = index(chatID),
              let m = conversations[i].messages.firstIndex(where: { $0.id == messageID }),
              var phases = conversations[i].messages[m].thinkingPhases else { return }
        if let p = phases.firstIndex(where: { $0.title == title }) {
            phases[p].status = status
            if let content { phases[p].content = content }
        } else {
            phases.append(ThinkingPhase(title: title, content: content ?? "", status: status))
            let order = ["Summarising", "Research", "Understanding", "Tooling", "Thinking"]
            phases.sort { (order.firstIndex(of: $0.title) ?? order.count) < (order.firstIndex(of: $1.title) ?? order.count) }
        }
        conversations[i].messages[m].thinkingPhases = phases
        conversations[i].updated = Date()
        save()
    }

    private func removeThinkingStage(_ chatID: Conversation.ID, messageID: UUID, title: String) {
        guard let i = index(chatID),
              let m = conversations[i].messages.firstIndex(where: { $0.id == messageID }),
              var phases = conversations[i].messages[m].thinkingPhases else { return }
        phases.removeAll { $0.title == title }
        conversations[i].messages[m].thinkingPhases = phases
        save()
    }

    /// After a run: records the files' new state and puts "Undo this run" on the run's last reply.
    private func endRun(_ id: Conversation.ID, run: Checkpoints.Run, firstNew: Int) {
        guard let files = Checkpoints.finish(run), let i = index(id) else { return }
        let msgs = conversations[i].messages
        let start: Int = min(firstNew, msgs.count)
        if let k = msgs.indices.last(where: { $0 >= start && msgs[$0].role == .assistant && msgs[$0].compactedCount == nil }) {
            conversations[i].messages[k].checkpoint = RunCheckpoint(run: run.run, files: files)
        } else {
            var note = ChatMessage(role: .assistant, content: "", model: conversations[i].model)
            note.checkpoint = RunCheckpoint(run: run.run, files: files)
            conversations[i].messages.append(note)
        }
    }

    /// "Undo this run" under a reply (force = "Undo anyway"). Returns nil when done, or why it didn't happen and
    /// whether "Undo anyway" may override it.
    func undoRun(_ messageID: ChatMessage.ID, force: Bool) -> (message: String, canForce: Bool)? {
        guard let i = conversations.firstIndex(where: { $0.messages.contains { $0.id == messageID } }),
              let k = conversations[i].messages.firstIndex(where: { $0.id == messageID }),
              let cp = conversations[i].messages[k].checkpoint else { return nil }
        if streamingID == conversations[i].id { return ("Wait for the reply to finish (or press Stop), then undo.", false) }
        let run = Checkpoints.Run(chat: conversations[i].id.uuidString, run: cp.run)
        switch Checkpoints.restore(run, force: force) {
        case .refused(let later, let message):
            if later.isEmpty && message.contains("already been undone") {
                conversations[i].messages[k].checkpoint?.undone = true
                save()
            }
            return (message, !later.isEmpty)
        case .done(_, let message):
            conversations[i].messages[k].checkpoint?.undone = true
            save()
            notice = message.components(separatedBy: "\n").first
            return message.contains("\n") ? (message, false) : nil
        }
    }

    // MARK: Tools that need the chat store

    private func runTool(_ call: ToolCall, chat id: Conversation.ID, model: String, web: Bool, mac: Bool, commands: [IngleCommand] = [], env: [String: String] = [:]) async -> String {
        if ["open", "applescript", "screenshot"].contains(call.name) && !mac {
            if index(id).flatMap({ conversations[$0].codeFolder }) != nil {
                return "Mac control is off in Code mode. If the user needs it, they can start a normal chat (the Chat icon at the top of the sidebar) and switch on the Mac button there."
            }
            return "Mac control is off in this chat. Ask the user to switch on the Mac button in the message bar (next to Effort and Web) if they want you to control apps or see the screen."
        }
        if call.name == "screenshot" {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("ingle-screen-\(UUID().uuidString).png")
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-x", file.path]
            try? p.run()
            p.waitUntilExit()
            defer { try? FileManager.default.removeItem(at: file) }
            guard let name = ImageStore.importImage(from: file) else {
                return "Couldn't take a screenshot. macOS may need permission: System Settings → Privacy & Security → Screen & System Audio Recording → turn on Ingle, then try again."
            }
            lastToolImages = [name]
            return await supportsVision(model)
                ? "Here is the screen right now (attached)."
                : "This model can't see images, so here is the text on the screen (attached below)."
        }
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
        if CodeTools.names.contains(call.name) {
            guard let folder = index(id).flatMap({ conversations[$0].codeFolder }) else { return "\(call.name) only works in Code mode." }
            return await CodeTools.run(call, folder: folder, run: activeRuns[id])
        }
        if CodeIntel.toolNames.contains(call.name) {
            guard let i = index(id), let folder = conversations[i].codeFolder else { return "\(call.name) only works in Code mode." }
            return await CodeIntel.shared.run(call, folder: folder, chat: conversations[i])
        }
        switch call.name {
        case "update_tasks":
            switch TaskList.parse(call) {
            case .failure(let e): return e.message
            case .success(let list):
                setTasks(id, list)
                return TaskList.result(list)
            }
        case "chat_list", "chat_search", "chat_read":
            return chatTool(call, excluding: id)
        case "delegate":
            return await runSubAgent(task: call.arg("task"), model: model, web: web, parent: id, commands: commands)
        case "use_rule":
            // A Code chat's project rules come from its folder, not from the editor.
            guard let folder = index(id).flatMap({ conversations[$0].codeFolder }) else { return await MacTools.run(call, env: env) }
            return RuleStore.read(call.arg("name"), project: folder)
        default:
            return await MacTools.run(call, env: env, run: activeRuns[id])
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
    /// The request's active commands apply to it too: never_use tools are hidden and blocked.
    /// It reads files inside the workspace folders whatever the Mac button says (Terminal reads are always on).
    func runSubAgent(task: String, model: String, web: Bool, parent: Conversation.ID, commands: [IngleCommand] = []) async -> String {
        let task = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return "The helper needs a task." }
        // Helpers read without asking, so only where reading is free: the Code chat's project, else the workspace folders.
        let codeFolder: String? = index(parent).flatMap { conversations[$0].codeFolder }
        var system = ["You are a helper sub-agent working for \(ModelNames.display(model)) inside Ingle, on the user's Mac. Do only the task below, using your tools where useful, then reply with a concise result: key findings, facts, and sources (URLs or file paths). No small talk and no questions — make sensible assumptions and say what they were."]
        if web { system.append(WebTools.systemPrompt) }
        if let memory = MemoryStore.indexSection() { system.append(memory) }
        if let reports = ReportStore.indexSection() { system.append(reports) }
        if let codeFolder { system.append("The project folder is \(codeFolder); relative paths are inside it.") }

        var pool: [[String: Any]] = []
        pool.append(contentsOf: MacTools.definitions)
        pool.append(contentsOf: WebTools.definitions)
        pool.append(contentsOf: MemoryStore.definitions)
        pool.append(contentsOf: KnowledgeTools.reportDefinitions)
        pool.append(contentsOf: KnowledgeTools.chatDefinitions)
        pool.append(MacTools.helpTool)
        pool.append(SkillStore.toolDefinition)
        pool.append(RuleStore.toolDefinition)
        // In Code mode helpers can also find their way round the project (read-only code tools).
        var allowed: Set<String> = KnowledgeTools.subAgentAllowed
        if codeFolder != nil {
            pool.append(contentsOf: CodeTools.readOnlyDefinitions)
            allowed.formUnion(CodeTools.readOnlyNames)
            pool.append(contentsOf: CodeIntel.definitions)
            allowed.formUnion(CodeIntel.toolNames)
        }
        let commandCheck = CommandTracker(commands)
        let banned: Set<String> = commandCheck.blocked
        let tools = pool.filter { def in
            guard let fn = def["function"] as? [String: Any], let name = fn["name"] as? String,
                  allowed.contains(name) else { return false }
            if banned.contains(name.lowercased()) { return false }
            if name.hasPrefix("web_") { return web }
            return true
        }

        var messages: [[String: Any]] = [["role": "system", "content": system.joined(separator: "\n\n")],
                                         ["role": "user", "content": task]]
        var lastContent = ""
        var scrubber: Secrets.Scrubber?
        for _ in 0..<10 {
            if Task.isCancelled { return "Stopped." }
            activity = "Helper is thinking…"
            var content = ""
            var calls: [ToolCall] = []
            do {
                let stream = OllamaClient().chat(model: model, messages: messages, tools: tools, think: .off,
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
            for modelCall in calls {
                let c: ToolCall = Project.prepare(modelCall, folder: codeFolder)
                let result: String
                if let ban = commandCheck.blockingCommand(for: c) {
                    result = CommandTracker.blockedMessage(ban.command, ban.item)
                } else if !allowed.contains(c.name) {
                    result = "Helpers can only read, so that tool isn't available."
                } else if !Secrets.names(in: c).isEmpty {
                    result = "Helpers can’t use secrets. " + Secrets.refused
                } else if (c.name == "list_files" || c.name == "read_file") && MacTools.needsApproval(c, codeFolder: codeFolder) {
                    result = codeFolder == nil ? "Helpers can only read inside the workspace folders." : "Helpers can only read inside the project folder."
                } else if c.name.hasPrefix("chat_") {
                    result = chatTool(c, excluding: parent)
                } else if let codeFolder, CodeIntel.toolNames.contains(c.name), let pi = index(parent) {
                    activity = "Helper: " + MacTools.describe(c).title + "…"
                    result = await CodeIntel.shared.run(c, folder: codeFolder, chat: conversations[pi])
                } else if let codeFolder, CodeTools.readOnlyNames.contains(c.name) {
                    activity = "Helper: " + MacTools.describe(c).title + "…"
                    result = await CodeTools.run(c, folder: codeFolder)
                } else {
                    activity = "Helper: " + MacTools.describe(c).title + "…"
                    result = await MacTools.run(c)
                }
                var clean: String = result
                if !Secrets.all().isEmpty {
                    if scrubber == nil { scrubber = await Secrets.scrubber() }
                    clean = scrubber?.scrub(result) ?? result
                }
                messages.append(["role": "tool", "content": clean, "tool_name": c.name])
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
        if lower.contains("does not support tools") { return "This model can’t use tools, so it can only chat. Switch to Daily coding or Hard jobs." }
        return "Something went wrong: \(text)"
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
    private func historyJSON(_ conv: Conversation, vision: Bool, startingAt requestedStart: Int? = nil) -> [[String: Any]] {
        let compactedStart = (conv.messages.lastIndex { $0.compactedCount != nil }).map { $0 + 1 } ?? 0
        let start = min(conv.messages.count, max(compactedStart, requestedStart ?? compactedStart))
        return conv.messages[start...].compactMap { m -> [String: Any]? in
            if m.role == .assistant, m.content.isEmpty, m.toolCalls.isEmpty, m.thinkingPhases != nil { return nil }
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

    /// Uses the lightweight model to collect project/web evidence before the selected model reasons over it.
    private func researchForTurn(model selectedModel: String, query: String, summary: String, understanding: String,
                                 projectContext: String, webOn: Bool) async -> String {
        let model = Prefs.dailyModel.isEmpty ? selectedModel : Prefs.dailyModel
        var evidence: [String] = []
        if !projectContext.isEmpty { evidence.append("Relevant project-folder map:\n\(projectContext)") }

        let request = (query + "\n" + understanding).lowercased()
        let webCue = ["research", "source", "citation", "prove", "verify", "fact-check", "look up", "search the web",
                      "current", "latest", "today", "price", "news", "evidence", "deep dive"]
        if webOn && webCue.contains(where: { request.contains($0) }) {
            let queryPrompt = """
            Create up to three short, distinct web search queries needed to verify the user's request. Output only one query per line, or NO_WEB_SEARCH if the request does not need web research. Never include a person's name, address, private fact, memory, or project-folder content in a query; generalise the topic.

            Request: \(understanding.isEmpty ? query : understanding)
            """
            var queryOutput = ""
            do {
                let stream = OllamaClient().chat(model: model, messages: [["role": "user", "content": queryPrompt]], tools: nil,
                                                 think: .off, numCtx: Prefs.contextLength(for: model), keepAlive: Prefs.keepAlive)
                for try await chunk in stream { queryOutput += chunk.content }
            } catch { queryOutput = "" }
            let queries = queryOutput.components(separatedBy: .newlines).map { line in
                line.replacingOccurrences(of: #"^\s*(?:[-*]|\d+[.)])\s*"#, with: "", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }.filter { !$0.isEmpty && !$0.localizedCaseInsensitiveContains("NO_WEB_SEARCH") }.prefix(3)
            var seenURLs = Set<String>()
            for searchQuery in queries {
                let results = await WebTools.search(searchQuery)
                evidence.append("Web search for \(searchQuery):\n\(results)")
                let urls = results.components(separatedBy: .newlines).compactMap { line -> String? in
                    let candidate = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        .trimmingCharacters(in: CharacterSet(charactersIn: ".,;"))
                    guard candidate.hasPrefix("https://") || candidate.hasPrefix("http://"),
                          URL(string: candidate) != nil else { return nil }
                    return candidate
                }
                    .filter { seenURLs.insert($0).inserted }
                for url in urls.prefix(2) { evidence.append("Source page:\n\(await WebTools.fetch(url))") }
            }
        }

        guard !evidence.isEmpty else { return "" }
        let prompt = """
        Prepare concise research notes for the selected assistant model. Extract only evidence relevant to the user's current request from the summary and materials below. Keep file paths and source URLs exactly. Separate evidence from assumptions, and do not invent missing details. Do not answer the user. If none of the materials are relevant, output exactly NO_RELEVANT_RESEARCH.

        Earlier-chat summary:
        \(summary)

        Request interpretation:
        \(understanding)

        Evidence collected:
        \(evidence.joined(separator: "\n\n"))
        """
        var notes = ""
        do {
            let stream = OllamaClient().chat(model: model, messages: [["role": "user", "content": prompt]], tools: nil,
                                             think: .off, numCtx: Prefs.contextLength(for: model), keepAlive: Prefs.keepAlive)
            for try await chunk in stream { notes += chunk.content }
        } catch { return evidence.joined(separator: "\n\n") }
        let cleaned = ThinkSplitter.split(notes, extra: "").body.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty || cleaned.localizedCaseInsensitiveContains("NO_RELEVANT_RESEARCH") { return "" }
        return cleaned
    }

    /// Builds temporary context for the current request. Unlike Compact Chat, this never edits the transcript.
    private func summarizeForTurn(_ conv: Conversation, before end: Int, request: String, memory: String) async -> String {
        let start = (conv.messages.lastIndex { $0.compactedCount != nil }).map { $0 + 1 } ?? 0
        var lines: [String] = []
        if end > 0, let priorSummary = conv.messages[..<end].last(where: { $0.compactedCount != nil })?.content {
            lines.append("Earlier summary: \(priorSummary)")
        }
        if end > start {
        for message in conv.messages[start..<end] {
            if message.compactedCount != nil { continue }
            switch message.role {
            case .user:
                lines.append("User: \(message.content)")
            case .assistant:
                let body = ThinkSplitter.split(message.content, extra: "").body
                if !body.isEmpty { lines.append("Assistant: \(body)") }
            case .tool:
                lines.append("Tool \(message.toolName ?? "") (\(message.toolDetail ?? "")): \(String(message.content.prefix(1200)))")
            }
        }
        }
        if lines.isEmpty { lines.append("No earlier messages are available.") }
        var transcript = lines.joined(separator: "\n\n")
        let summaryModel = Prefs.dailyModel.isEmpty ? conv.model : Prefs.dailyModel
        let maxChars = Prefs.contextLength(for: summaryModel) * 2
        if transcript.count > maxChars {
            transcript = String(transcript.prefix(maxChars / 3)) + "\n\n…(middle omitted for summary input)…\n\n" + String(transcript.suffix(maxChars * 2 / 3))
        }
        activity = nil
        let prompt = """
        Summarise this earlier chat and the relevant saved-memory lookup for one new user request. Keep only durable goals, preferences, decisions, important facts, and unresolved references needed to answer the request. Include relevant memory facts with their source names. Be concise and factual. Do not answer the request or include private chain-of-thought.

        Current request:
        \(request)

        Relevant saved memory (already checked; “Nothing in memory” means there were no keyword matches):
        \(memory)

        Earlier chat:
        \(transcript)
        """
        var summary = ""
        do {
            let stream = OllamaClient().chat(model: summaryModel, messages: [["role": "user", "content": prompt]], tools: nil,
                                             think: .off, numCtx: Prefs.contextLength(for: summaryModel), keepAlive: Prefs.keepAlive)
            for try await chunk in stream { summary += chunk.content }
        } catch { return "" }
        return ThinkSplitter.split(summary, extra: "").body.trimmingCharacters(in: .whitespacesAndNewlines)
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
        // Nothing sent yet: nothing used (the instructions only count once there's a chat to send).
        if conv.messages.isEmpty { return 0 }
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
                                             think: .off, numCtx: Prefs.contextLength(for: conv.model), keepAlive: Prefs.keepAlive)
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
        let started: [Conversation] = conversations.filter { !$0.messages.isEmpty }
        guard let data = try? JSONEncoder().encode(started) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
