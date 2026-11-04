import SwiftUI
import UniformTypeIdentifiers

struct ChatRoot: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 220, ideal: 256, max: 340)
        } detail: {
            if let c = store.current {
                ChatDetail(conversation: c).id(c.id)
            } else {
                Ember.bg
            }
        }
        .searchable(text: $store.search, placement: .sidebar, prompt: "Search chats")
        .toolbarBackground(Ember.bg, for: .windowToolbar)
        .tint(Ember.accent)
        .preferredColorScheme(.dark)
        .onAppear {
            AppActions.openChat = { openWindow(id: "chat") }
            // Opening the window starts on a blank new chat (an empty one is reused, e.g. an editor request).
            store.newChat()
        }
    }
}

// MARK: Sidebar

struct Sidebar: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        @Bindable var store = store
        List(selection: $store.selection) {
            ForEach(store.sections) { section in
                Section(section.title) {
                    ForEach(section.items) { c in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.title).lineLimit(1).foregroundStyle(Ember.text)
                            Text(store.meta(for: c)).font(.system(size: 11)).foregroundStyle(Ember.secondary)
                        }
                        .padding(.vertical, 3)
                        .tag(c.id)
                        .contextMenu {
                            Button("Delete Chat", role: .destructive) { store.delete(c.id) }
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Ember.sidebar.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                SystemCard()
                StatusCard()
            }
            .padding(10)
        }
        .toolbar {
            ToolbarItem {
                Button { store.newChat() } label: { Label("New Chat", systemImage: "square.and.pencil") }
                    .help("New chat (⌘N)")
            }
        }
    }
}

struct StatusCard: View {
    @Environment(ModelManager.self) private var mm

    var body: some View {
        HStack(spacing: 10) {
            NetworkMark(top: mm.state != .off && mm.state != .offline,
                        sides: mm.state == .hard,
                        dashed: mm.state == .off || mm.state == .offline,
                        lineWidth: 1.3)
                .frame(width: 22, height: 22)
                .opacity(mm.state == .off || mm.state == .offline ? 0.55 : 1)
            VStack(alignment: .leading, spacing: 1) {
                Text(mm.headline).font(.system(size: 12, weight: .medium)).foregroundStyle(Ember.text)
                Text(mm.detail).font(.system(size: 11)).foregroundStyle(Ember.secondary)
            }
            Spacer(minLength: 0)
            if mm.state == .offline {
                Button("Start") { mm.openOllama() }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }
}

// MARK: Chat

struct ChatDetail: View {
    @Environment(ChatStore.self) private var store
    @Environment(ModelManager.self) private var mm
    let conversation: Conversation

    @State private var draft = ""
    @State private var attachments: [Attachment] = []
    @State private var importing = false
    @State private var dropping = false
    @State private var slashIndex = 0
    @State private var slashDismissed = false
    @State private var unreadable: String?
    /// Set when the message looks like it has a secret in it: Save as Secret / Send Anyway / Cancel.
    @State private var secretPrompt: SecretPromptState?
    @FocusState private var focused: Bool

    private var streaming: Bool { store.streamingID == conversation.id }

    /// The "/" menu's items for what's typed so far, or nil when it's closed.
    private var slashItems: [SlashItem]? {
        guard !slashDismissed, let q = SlashCommands.query(draft) else { return nil }
        return SlashCommands.filter(SlashCommands.items(skills: store.skills), q)
    }

    private func pickSlash(_ item: SlashItem) {
        slashIndex = 0
        switch item.kind {
        case .command:
            draft = ""
            _ = store.runSlashCommand("/" + item.name)
        case .skill:
            draft = "/\(item.name) "
        }
        focused = true
    }
    private var isHard: Bool { conversation.model == Prefs.hardModel }
    private var canSend: Bool {
        !streaming && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    var body: some View {
        VStack(spacing: 0) {
            banners
            if conversation.messages.isEmpty {
                EmptyChat(model: conversation.model) { text in
                    draft = text
                    focused = true
                }
            } else {
                messages
            }
            if let p = store.pending, p.conversation == conversation.id {
                ApprovalCard(pending: p)
            }
            composer
        }
        .background(Ember.bg)
        .navigationTitle(conversation.title)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            addFiles(urls)
        }
        .dropDestination(for: URL.self) { urls, _ in
            addFiles(urls)
            return true
        } isTargeted: { dropping = $0 }
        .onAppear {
            focused = true
            takeIncoming()
            // Opening a chat wakes the engine, so there's nothing to press.
            if mm.state == .offline { mm.openOllama() }
        }
        .onChange(of: store.incoming) { takeIncoming() }
        .onChange(of: draft) {
            slashIndex = 0
            if !draft.hasPrefix("/") { slashDismissed = false }
        }
        .sheet(isPresented: Binding(get: { store.showMCP }, set: { store.showMCP = $0 })) {
            MCPSheet()
        }
        .sheet(isPresented: Binding(get: { store.showAddSecret }, set: { store.showAddSecret = $0 })) {
            AddSecretSheet { name in
                store.notice = "Saved \(name). The assistant can use it as {{secret:\(name)}}, with your approval each time."
            }
        }
        .sheet(item: $secretPrompt) { state in
            SecretPromptSheet(found: state.found) { choice in
                secretPrompt = nil
                switch choice {
                case .cancel: focused = true
                case .sendAnyway: deliver(draft)
                case .saved(let names): deliver(Secrets.replaceValues(draft, names))
                }
            }
        }
    }

    @ViewBuilder private var banners: some View {
        if mm.state == .offline {
            Banner(icon: "bolt.slash", text: "The AI engine isn’t running yet — it starts by itself when you send a message.",
                   button: "Start Now") { mm.openOllama() }
        } else if isHard && mm.onBattery && Prefs.warnOnBattery {
            Banner(icon: "battery.25", text: "You’re on battery. Hard jobs drains it fast — plug in if you can.",
                   button: "Use Daily coding") { store.setModel(Prefs.dailyModel) }
        }
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(conversation.messages) { m in
                        MessageRow(message: m,
                                   isLast: m.id == conversation.messages.last?.id,
                                   streaming: streaming,
                                   onRegenerate: { store.regenerate() })
                            .id(m.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: 720)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 40)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: conversation.messages.last?.content) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: conversation.messages.count) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: streaming) {
                Task {
                    try? await Task.sleep(for: .milliseconds(80))
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if streaming, let activity = store.activity {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(activity).font(.system(size: 12)).foregroundStyle(Ember.secondary).lineLimit(1)
                }
                .frame(maxWidth: 720, alignment: .leading)
            }
            if let ctx = EditorBridge.shared.freshContext {
                EditorChip(context: ctx, on: conversation.useEditor ?? true) { store.setUseEditor($0) }
                    .frame(maxWidth: 720, alignment: .leading)
            }
            if let items = slashItems {
                SlashMenu(items: items, selected: min(slashIndex, max(0, items.count - 1)), pick: pickSlash)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            VStack(alignment: .leading, spacing: 10) {
                if !attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(attachments) { a in
                                HStack(spacing: 6) {
                                    if let file = a.imageFile, let image = ImageStore.nsImage(file) {
                                        Image(nsImage: image).resizable().scaledToFill()
                                            .frame(width: 20, height: 20).clipShape(RoundedRectangle(cornerRadius: 4))
                                    } else {
                                        Image(systemName: "doc.text").font(.system(size: 11))
                                    }
                                    Text(a.name).font(.system(size: 12)).lineLimit(1)
                                    Button {
                                        attachments.removeAll { $0.id == a.id }
                                    } label: {
                                        Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                                    }
                                    .buttonStyle(.plain)
                                    .help("Remove")
                                }
                                .foregroundStyle(Ember.text.opacity(0.85))
                                .padding(.horizontal, 12)
                                .frame(height: 28)
                                .background(Capsule().fill(Color.white.opacity(0.07)))
                            }
                        }
                    }
                }
                TextField("", text: $draft,
                          prompt: Text("Ask \(ModelNames.display(conversation.model)) anything…  (/ for commands and skills)").foregroundStyle(Ember.tertiary),
                          axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .foregroundStyle(Ember.text)
                    .lineLimit(1...10)
                    .focused($focused)
                    .onSubmit(send)
                    .onKeyPress(.upArrow) {
                        guard let items = slashItems, !items.isEmpty else { return .ignored }
                        slashIndex = (min(slashIndex, items.count - 1) - 1 + items.count) % items.count
                        return .handled
                    }
                    .onKeyPress(.downArrow) {
                        guard let items = slashItems, !items.isEmpty else { return .ignored }
                        slashIndex = (min(slashIndex, items.count - 1) + 1) % items.count
                        return .handled
                    }
                    .onKeyPress(.tab) {
                        guard let items = slashItems, !items.isEmpty else { return .ignored }
                        pickSlash(items[min(slashIndex, items.count - 1)])
                        return .handled
                    }
                    .onKeyPress(.return) {
                        guard let items = slashItems, !items.isEmpty else { return .ignored }
                        pickSlash(items[min(slashIndex, items.count - 1)])
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        guard slashItems != nil else { return .ignored }
                        slashDismissed = true
                        return .handled
                    }
                // Full labels when there's room; icons only when the window is narrow (never wrapped text).
                ViewThatFits(in: .horizontal) {
                    controls(compact: false)
                    controls(compact: true)
                }
                .foregroundStyle(Ember.secondary)
            }
            .padding(EdgeInsets(top: 12, leading: 16, bottom: 10, trailing: 12))
            .background(RoundedRectangle(cornerRadius: 16).fill(Ember.surface))
            .overlay(RoundedRectangle(cornerRadius: 16)
                .strokeBorder(dropping ? Ember.accent : (focused ? Ember.accent.opacity(0.55) : Color.white.opacity(0.09)),
                              lineWidth: dropping ? 2 : 1))
            .frame(maxWidth: 720)

            HStack(spacing: 10) {
                if let unreadable {
                    Text(unreadable).foregroundStyle(Ember.accent)
                } else if let notice = store.notice {
                    Label(notice, systemImage: "checkmark.circle").foregroundStyle(Ember.secondary)
                } else {
                    Text("Return to send · ⌥Return for a new line · ⌘N new chat")
                }
                Spacer(minLength: 8)
                ContextMeter(usage: store.contextUsage(conversation),
                             canCompact: !streaming && conversation.messages.count > 2) { store.compactNow() }
            }
            .font(.system(size: 11))
            .foregroundStyle(Ember.tertiary)
            .frame(maxWidth: 720)
        }
        .padding(.horizontal, 32)
        .padding(.top, 12)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity)
    }

    /// The row under the message box: attach, model, Think, Web, Mac, approvals badge, send.
    @ViewBuilder
    private func controls(compact: Bool) -> some View {
            HStack(spacing: 8) {
                Button { importing = true } label: {
                    Image(systemName: "paperclip").font(.system(size: 14))
                }
                .buttonStyle(IconButtonStyle())
                .help("Attach files: code, documents (PDF, Word, Excel…) or images (including HEIC). You can also drop them here.")

                ModelMenu(conversation: conversation, compact: compact)
                ThinkToggle(compact: compact)

                Toggle(isOn: Binding(get: { conversation.webOn }, set: { store.setWebAccess($0) })) {
                    Label("Web", systemImage: "globe")
                }
                .toggleStyle(PillToggleStyle(compact: compact))
                .help("Let the assistant search and read web pages (read-only: no logins, forms or your local network)")

                Toggle(isOn: Binding(get: { conversation.macAccess }, set: { store.setMacAccess($0) })) {
                    Label("Mac", systemImage: "macbook")
                }
                .toggleStyle(PillToggleStyle(compact: compact))
                .help("Mac control: let the assistant open and drive apps (AppleScript) and look at your screen — asking before each action. Terminal commands and files work without this.")

                Spacer(minLength: compact ? 4 : 8)
                if !store.sessionAllowed.isEmpty {
                    Button { store.forgetSessionApprovals() } label: {
                        Label("\(store.sessionAllowed.count) allowed", systemImage: "checkmark.shield")
                            .labelStyle(compact ? AnyLabelStyle(.iconOnly) : AnyLabelStyle(.titleAndIcon))
                            .font(.system(size: 11))
                            .fixedSize()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Ember.warn)
                    .help("Allowed for this session without asking: \(store.sessionAllowed.values.sorted().joined(separator: "; ")). Click to ask every time again.")
                }
                Image(systemName: "hand.raised")
                    .font(.system(size: 11))
                    .help(conversation.macAccess
                          ? "Terminal and Mac control are on — every command, file change and app action asks you first"
                          : "Terminal is available and asks before every command or file change. Switch on Mac to let it control apps and see your screen.")
                Button {
                    if streaming { store.stop() } else { send() }
                } label: {
                    Image(systemName: streaming ? "stop.fill" : "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(canSend || streaming ? Ember.onAccent : Ember.tertiary)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(canSend || streaming ? Ember.accent : Color.white.opacity(0.1)))
                }
                .buttonStyle(.plain)
                .disabled(!canSend && !streaming)
                .help(streaming ? "Stop" : "Send")
            }
        .foregroundStyle(Ember.secondary)
    }

    private func addFiles(_ urls: [URL]) {
        var failed: [String] = []
        for url in urls {
            if let a = Attachment.from(url) { attachments.append(a) } else { failed.append(url.lastPathComponent) }
        }
        unreadable = failed.isEmpty ? nil : "Couldn’t read \(failed.joined(separator: ", "))"
        focused = true
    }

    private func takeIncoming() {
        guard let incoming = store.incoming, incoming.conversation == conversation.id else { return }
        draft = incoming.text
        if let a = incoming.attachment { attachments.append(a) }
        store.incoming = nil
        focused = true
    }

    private func send() {
        guard canSend else { return }
        if isHard && mm.state != .hard && !mm.confirmHardOnBattery() { return }
        // Looks like a password or key? Ask before it's stored or sent anywhere.
        let found: [DetectedSecret] = Secrets.detectWithNames(draft)
        if !found.isEmpty {
            secretPrompt = SecretPromptState(found: found)
            return
        }
        deliver(draft)
    }

    private func deliver(_ text: String) {
        store.send(text, attachments: attachments)
        draft = ""
        attachments = []
    }
}

// MARK: Pieces

/// "42% of context" — how full the model's memory of this chat is. Past 75% Ingle compacts automatically.
struct ContextMeter: View {
    let usage: Double
    let canCompact: Bool
    let compact: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                Circle().stroke(Color.white.opacity(0.12), lineWidth: 2)
                Circle().trim(from: 0, to: usage > 0 ? max(0.02, usage) : 0)
                    .stroke(usage > 0.75 ? Ember.accent : Ember.secondary, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 11, height: 11)
            Text("\(Int((usage * 100).rounded()))% of context")
            if canCompact && usage > 0.4 {
                Button("Compact", action: compact)
                    .buttonStyle(.plain)
                    .foregroundStyle(Ember.accent)
                    .help("Summarise the older messages so the chat can keep going (or type /compact)")
            }
        }
        .help("How much of the model’s context this chat uses, including Ingle’s instructions and tools once you’ve sent a message. Ingle summarises older messages automatically at 75%.")
    }
}

/// "Working in: my-app · Invoice.tsx" — what the editor reported; tap to include or leave out.
struct EditorChip: View {
    let context: EditorContext
    let on: Bool
    let toggle: (Bool) -> Void

    var body: some View {
        Button { toggle(!on) } label: {
            HStack(spacing: 6) {
                Image(systemName: context.editor == "Rider" ? "hammer" : "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                Text(on ? "Working in" : "Not using").foregroundStyle(Ember.secondary)
                Text(context.chipText.isEmpty ? context.editor : context.chipText)
                    .foregroundStyle(on ? Ember.text : Ember.tertiary)
                    .strikethrough(!on, color: Ember.tertiary)
                if on, let n = context.selection?.count, n > 0 {
                    Text("· selection").foregroundStyle(Ember.secondary)
                }
                if on, let d = context.diagnostics, !d.isEmpty {
                    Text("· \(d.count) problem\(d.count == 1 ? "" : "s")").foregroundStyle(Ember.warn)
                }
                Image(systemName: on ? "xmark" : "plus").font(.system(size: 8, weight: .bold)).foregroundStyle(Ember.tertiary)
            }
            .font(.system(size: 11.5, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background(Capsule().fill(on ? Ember.accent.opacity(0.12) : Color.white.opacity(0.05)))
            .overlay(Capsule().strokeBorder(on ? Ember.accent.opacity(0.3) : Color.white.opacity(0.08)))
        }
        .buttonStyle(.plain)
        .help(on ? "Ingle can see what you're working on in \(context.editor). Click to leave it out of this chat."
                 : "Click to let this chat see what you're working on in \(context.editor).")
    }
}

struct ModelMenu: View {
    @Environment(ChatStore.self) private var store
    @Environment(ModelManager.self) private var mm
    let conversation: Conversation
    var compact = false

    var body: some View {
        let daily = Prefs.dailyModel
        let hard = Prefs.hardModel
        let others = mm.available.map(\.name).filter { $0 != daily && $0 != hard && $0 != Prefs.autoModel && !$0.contains("embed") }
        Menu {
            Picker("Model", selection: Binding(get: { conversation.model }, set: { store.setModel($0) })) {
                Text("\(Prefs.dailyName) · Daily coding · \(ModelNames.pretty(daily))").tag(daily)
                Text("\(Prefs.hardName) · Hard jobs · \(ModelNames.pretty(hard))").tag(hard)
                if !others.isEmpty {
                    Divider()
                    ForEach(others, id: \.self) { Text(ModelNames.pretty($0)).tag($0) }
                }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                Text(ModelNames.display(conversation.model)).foregroundStyle(Ember.text).lineLimit(1)
                if !compact {
                    Text(ModelNames.role(conversation.model)).foregroundStyle(Ember.secondary).lineLimit(1)
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
        .help("Choose which model answers in this chat")
    }
}

struct ThinkToggle: View {
    @Environment(ChatStore.self) private var store
    var compact = false

    var body: some View {
        @Bindable var store = store
        Toggle(isOn: $store.think) { Label("Think", systemImage: "brain") }
            .toggleStyle(PillToggleStyle(compact: compact))
            .help("Let the model think before it answers. Slower, sometimes smarter.")
    }
}

struct Banner: View {
    let icon: String
    let text: String
    let button: String
    let action: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
            Text(text).font(.system(size: 13))
            Spacer(minLength: 8)
            Button(button, action: action)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 14)
                .frame(height: 26)
                .background(RoundedRectangle(cornerRadius: 6).fill(Ember.warn.opacity(0.2)))
        }
        .foregroundStyle(Ember.warn)
        .padding(.vertical, 9)
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Ember.warn.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Ember.warn.opacity(0.28)))
        .frame(maxWidth: 720)
        .padding(.horizontal, 32)
        .padding(.top, 14)
        .frame(maxWidth: .infinity)
    }
}

struct ApprovalCard: View {
    @Environment(ChatStore.self) private var store
    let pending: PendingApproval

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: pending.info.icon)
                Text("Ingle wants to \(sentenceCase(pending.info.title))")
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(Ember.text)
            if let use = pending.secretUse {
                Label(use.line, systemImage: "key.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Ember.accent)
                    .textSelection(.enabled)
            }
            if pending.call.name == "ssh_command" {
                (Text("on ") + Text(pending.call.arg("host")).bold().foregroundColor(Ember.accent) + Text(" over SSH"))
                    .font(.system(size: 15))
                    .foregroundStyle(Ember.text)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(pending.info.detail)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(Ember.text.opacity(0.9))
                    .textSelection(.enabled)
                    .padding(10)
                    .fixedSize()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Ember.code))
            if pending.call.name == "write_file" {
                Text("\(pending.call.arg("content").count) characters will be written. Expand the step afterwards to see the result.")
                    .font(.system(size: 11))
                    .foregroundStyle(Ember.secondary)
            }
            if let warning = pending.secretUse?.warning {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.yellow)
            }
            if pending.secretUse != nil {
                Text("Secrets are approved one use at a time\(Prefs.secretsTouchID ? " — Touch ID comes next" : "").")
                    .font(.system(size: 11))
                    .foregroundStyle(Ember.secondary)
            } else if !pending.scope.key.isEmpty {
                Text("Allow for This Session covers \(pending.scope.label), until Ingle quits.")
                    .font(.system(size: 11))
                    .foregroundStyle(Ember.secondary)
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                Button("Deny") { store.resolve(false) }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if pending.secretUse == nil && !pending.scope.key.isEmpty {
                    Button("Allow for This Session") { store.resolve(true, always: true) }
                        .help("Don’t ask again for \(pending.scope.label) until Ingle quits")
                }
                Button("Allow") { store.resolve(true) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 14).fill(Ember.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Ember.accent.opacity(0.45)))
        .frame(maxWidth: 720)
        .padding(.horizontal, 32)
        .padding(.top, 8)
        .frame(maxWidth: .infinity)
    }
}

/// "Use Figma (MCP)" → "use Figma (MCP)": only the first letter is lowered, so names keep their case.
private func sentenceCase(_ title: String) -> String {
    guard let first = title.first else { return title }
    return first.lowercased() + title.dropFirst()
}

struct EmptyChat: View {
    let model: String
    let pick: (String) -> Void

    private struct Prompt: Hashable {
        let title: String
        let sub: String
        let text: String
    }

    private let prompts: [Prompt] = [
        Prompt(title: "Explain this error", sub: "Paste a stack trace or log", text: "Explain this error and how to fix it:\n\n"),
        Prompt(title: "Write tests for a function", sub: "xUnit, Jest or pytest", text: "Write unit tests for this function:\n\n"),
        Prompt(title: "Review my SQL query", sub: "Spot slow joins and missing indexes", text: "Review this SQL query for performance:\n\n"),
        Prompt(title: "Tidy my Downloads folder", sub: "Asks before changing anything", text: "Look in ~/Downloads and suggest how to organise it. Don't move anything yet."),
    ]

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            RoundedRectangle(cornerRadius: 16)
                .fill(Ember.surface)
                .frame(width: 64, height: 64)
                .overlay(NetworkMark(top: true, sides: model == Prefs.hardModel, lineWidth: 1.1).frame(width: 34, height: 34))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.08)))
            VStack(spacing: 6) {
                Text("What are we working on?")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(Ember.text)
                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Ember.secondary)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(prompts, id: \.title) { p in
                    Button { pick(p.text) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(p.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Ember.text)
                            Text(p.sub).font(.system(size: 12)).foregroundStyle(Ember.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Ember.sidebar))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.07)))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: 560)
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
    }

    private var subtitle: String {
        if model == Prefs.hardModel { return "\(Prefs.hardName) · Hard jobs on \(ModelNames.pretty(model)) — smarter, slower" }
        if model == Prefs.dailyModel { return "\(Prefs.dailyName) · Daily coding on \(ModelNames.pretty(model)) — fast, low power" }
        return ModelNames.pretty(model)
    }
}

// MARK: Secrets in the composer

struct SecretPromptState: Identifiable {
    let id = UUID()
    let found: [DetectedSecret]
}

enum SecretPromptChoice {
    case cancel, sendAnyway
    /// value → name, for every value saved in the Keychain.
    case saved([String: String])
}

/// "This looks like a secret": save each value in the Keychain (the message then uses placeholders), send as typed, or go back.
struct SecretPromptSheet: View {
    let found: [DetectedSecret]
    let finish: (SecretPromptChoice) -> Void

    @State private var names: [String]
    @State private var descriptions: [String]
    @State private var saved: [String: String] = [:]
    @State private var error: String?

    init(found: [DetectedSecret], finish: @escaping (SecretPromptChoice) -> Void) {
        self.found = found
        self.finish = finish
        _names = State(initialValue: found.map(\.suggested))
        _descriptions = State(initialValue: found.map { $0.kind.prefix(1).uppercased() + $0.kind.dropFirst() })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(found.count > 1 ? "These look like secrets" : "This looks like a secret", systemImage: "key.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Ember.text)
            Text("Save it in your Keychain and the message will use a placeholder instead. The assistant never sees the value, and you approve each use.")
                .font(.system(size: 12))
                .foregroundStyle(Ember.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(found.indices, id: \.self) { i in
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(found[i].kind) (\(Secrets.preview(found[i].value)))")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Ember.secondary)
                    HStack {
                        TextField("Name", text: $names[i]).frame(width: 180)
                        TextField("What it’s for (optional)", text: $descriptions[i])
                    }
                    .textFieldStyle(.roundedBorder)
                    .disabled(saved[found[i].value] != nil)
                }
            }
            if let error {
                Text(error).font(.system(size: 12)).foregroundStyle(Color.red)
            }
            HStack {
                Button("Cancel") { finish(.cancel) }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Send Anyway") { finish(.sendAnyway) }
                Button(found.count > 1 ? "Save as Secrets" : "Save as Secret") { save() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 480)
        .background(Ember.bg)
    }

    private func save() {
        for i in found.indices {
            let value: String = found[i].value
            if saved[value] != nil { continue }
            let name: String = names[i].trimmingCharacters(in: .whitespaces).lowercased()
            if let problem = Secrets.add(name: name, description: descriptions[i], value: value) {
                error = problem
                return
            }
            saved[value] = name
        }
        finish(.saved(saved))
    }
}
