import SwiftUI
import AppKit
import ServiceManagement

struct SettingsView: View {
    private enum Tab: String, CaseIterable, Identifiable {
        case general = "General", models = "Models", web = "Web & Memory", mac = "Mac Access", secrets = "Secrets", ext = "Extensions", about = "About"
        var id: String { rawValue }
        var icon: String {
            switch self {
            case .general: return "gearshape"
            case .models: return "cpu"
            case .web: return "globe"
            case .mac: return "macbook"
            case .secrets: return "key"
            case .ext: return "puzzlepiece.extension"
            case .about: return "info.circle"
            }
        }
    }

    @State private var tab: Tab = .general

    var body: some View {
        VStack(spacing: 0) {
            // Our own tab bar, so the selected tab is ember rather than the system accent colour.
            HStack(spacing: 4) {
                ForEach(Tab.allCases) { t in
                    Button { tab = t } label: {
                        VStack(spacing: 4) {
                            Image(systemName: t.icon).font(.system(size: 17))
                            Text(t.rawValue).font(.system(size: 11, weight: .medium))
                        }
                        .frame(width: 90, height: 54)
                        .foregroundStyle(tab == t ? Ember.accent : Ember.secondary)
                        .background(RoundedRectangle(cornerRadius: 9)
                            .fill(tab == t ? Ember.accent.opacity(0.12) : Color.clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(Ember.sidebar)
            Rectangle().fill(Color.black.opacity(0.35)).frame(height: 1)

            Group {
                switch tab {
                case .general: GeneralSettings()
                case .models: ModelSettings()
                case .web: WebMemorySettings()
                case .mac: MacAccessSettings()
                case .secrets: SecretsSettings()
                case .ext: ExtensionsSettings()
                case .about: AboutSettings()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 660, height: 640)
        .background(Ember.bg)
        .tint(Ember.accent)
        .preferredColorScheme(.dark)
        .navigationTitle(tab.rawValue)
    }
}

/// Grouped form in Ingle's warm dark style.
private struct EmberForm<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        Form { content }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .background(Ember.bg)
            .foregroundStyle(Ember.text)
    }
}

private struct TitleAndHint: View {
    let title: String
    let hint: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(hint).font(.system(size: 11)).foregroundStyle(Ember.secondary)
        }
    }
}

// MARK: General

struct GeneralSettings: View {
    @Environment(ModelManager.self) private var mm
    @AppStorage(Prefs.K.sleep) private var sleepAfter = 15
    @AppStorage(Prefs.K.switchMode) private var switchMode = "unload"
    @AppStorage(Prefs.K.autoMode) private var autoMode = "smart"
    @AppStorage(Prefs.K.warnBattery) private var warnBattery = true
    @AppStorage(Prefs.K.showName) private var showName = false
    @AppStorage(Prefs.K.server) private var serverURL = "http://localhost:11434"
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        EmberForm {
            Section("Behaviour") {
                Picker(selection: $sleepAfter) {
                    Text("2 minutes").tag(2)
                    Text("5 minutes").tag(5)
                    Text("15 minutes").tag(15)
                    Text("30 minutes").tag(30)
                    Text("1 hour").tag(60)
                    Divider()
                    Text("Never").tag(-1)
                } label: { TitleAndHint(title: "Sleep models after", hint: "Unloads from memory when unused") }

                Picker(selection: $switchMode) {
                    Text("Unload the other one").tag("unload")
                    Text("Keep both loaded").tag("keep")
                } label: { TitleAndHint(title: "When switching models", hint: "Two big models won’t fit in memory") }

                Picker(selection: $autoMode) {
                    Text("Smart").tag("smart")
                    Text("Always loaded").tag("always")
                    Text("On demand").tag("ondemand")
                } label: {
                    TitleAndHint(title: "Autocomplete",
                                 hint: autoMode == "smart" ? "Pauses while \(Prefs.dailyName) or \(Prefs.hardName) is awake, back when they sleep"
                                     : autoMode == "always" ? "Stays loaded (about 1 GB) for instant suggestions"
                                     : "Loads only when Continue asks for it")
                }
                Toggle(isOn: $warnBattery) {
                    TitleAndHint(title: "Warn when on battery", hint: "Asks you to plug in before loading Hard jobs")
                }
            }
            Section("Menu bar") {
                Toggle("Show model name next to icon", isOn: $showName)
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in
                        do {
                            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                        } catch {
                            launchAtLogin = SMAppService.mainApp.status == .enabled
                        }
                    }
            }
            Section("AI engine") {
                LabeledContent("Status") {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(mm.state == .offline ? Ember.danger : Color.green)
                            .frame(width: 8, height: 8)
                        Text(mm.state == .offline ? "Not running" : "\(mm.engineName) · Ollama \(mm.version)")
                            .foregroundStyle(Ember.secondary)
                        Button(mm.state == .offline ? "Start" : "Restart") {
                            if mm.state == .offline { mm.openOllama() } else { Task { await mm.restartEngine() } }
                        }
                    }
                }
                TextField("Server address", text: $serverURL)
            }
            EngineUpdateSection()
        }
    }
}

/// Engine version, update check and one-click update.
private struct EngineUpdateSection: View {
    private var up: EngineUpdater { EngineUpdater.shared }
    @State private var autoCheck = EngineUpdater.autoCheck

    var body: some View {
        Section {
            LabeledContent("Installed") {
                Text(up.installed.isEmpty ? "–" : "Ollama \(up.installed)" + (EngineUpdater.updatedBinary != nil ? " (updated)" : " (built in)"))
                    .foregroundStyle(Ember.secondary)
            }
            LabeledContent("Latest") {
                HStack(spacing: 10) {
                    switch up.phase {
                    case .checking:
                        ProgressView().controlSize(.small)
                        Text("Checking…").foregroundStyle(Ember.secondary)
                    case .downloading(let f):
                        ProgressView(value: f).frame(width: 120)
                        Text("Downloading \(Int(f * 100))%").foregroundStyle(Ember.secondary)
                    case .installing:
                        ProgressView().controlSize(.small)
                        Text("Installing…").foregroundStyle(Ember.secondary)
                    case .failed(let message):
                        Text(message).foregroundStyle(Ember.warn).lineLimit(2)
                    case .idle:
                        if let latest = up.latest {
                            Text(up.updateAvailable ? "Ollama \(latest) available" : "Up to date (\(latest))")
                                .foregroundStyle(up.updateAvailable ? Ember.accent : Ember.secondary)
                        } else {
                            Text("Not checked yet").foregroundStyle(Ember.secondary)
                        }
                    }
                }
            }
            HStack {
                Button("Check Now") { Task { await up.check() } }
                    .disabled(up.isBusy)
                if up.updateAvailable {
                    Button("Update Engine") { Task { await up.update() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Ember.accent)
                        .disabled(up.isBusy)
                }
                Spacer()
                if up.canRollBack {
                    Button("Roll Back") { Task { await up.rollBack() } }
                        .disabled(up.isBusy)
                        .help("Go back to the engine you had before the last update")
                }
                if EngineUpdater.updatedBinary != nil {
                    Button("Use Built-in") { Task { await up.useBundled() } }
                        .disabled(up.isBusy)
                        .help("Go back to the engine that came with Ingle")
                }
            }
            Toggle(isOn: $autoCheck) {
                TitleAndHint(title: "Tell me when an update is out", hint: "Checks once a day and sends a notification")
            }
            .onChange(of: autoCheck) { _, on in EngineUpdater.autoCheck = on }
        } header: {
            Text("Engine updates")
        } footer: {
            Text("New Ollama versions add support for new models and fix bugs. Updates come from Ollama’s GitHub releases, are checked against their published checksums, and your models aren’t touched. The previous engine is kept so you can roll back.")
                .font(.system(size: 11))
                .foregroundStyle(Ember.secondary)
        }
        .task { if up.installed.isEmpty { await up.refreshInstalled() } }
    }
}

// MARK: Models

struct ModelSettings: View {
    @Environment(ModelManager.self) private var mm
    @AppStorage(Prefs.K.daily) private var daily = "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS"
    @AppStorage(Prefs.K.hard) private var hard = "qwen3.8:27b-mlx"
    @AppStorage(Prefs.K.auto) private var auto = "qwen2.5-coder:1.5b-base"
    @AppStorage(Prefs.K.ctxDaily) private var ctxDaily = Prefs.contextLength
    @AppStorage(Prefs.K.ctxHard) private var ctxHard = Prefs.contextLength
    @State private var pendingDelete: String?

    var body: some View {
        EmberForm {
            Section("Which model does what") {
                picker("Daily coding", "Chat, edits, quick questions", $daily, bigOnly: true)
                picker("Hard jobs", "Slower, smarter, best plugged in", $hard, bigOnly: true)
                picker("Autocomplete", "Used by Continue as you type", $auto, bigOnly: false)
                contextPicker("\(Prefs.dailyName)’s context", $ctxDaily)
                contextPicker("\(Prefs.hardName)’s context", $ctxHard)
            }
            GetModelSection()
            PersonaSection(title: "Daily coding", nameKey: Prefs.K.dailyName, personaKey: Prefs.K.dailyPersona,
                           effortKey: Prefs.K.dailyEffort,
                           defaultName: "Ember", defaultPersona: Persona.dailyDefault, defaultEffort: .medium)
            PersonaSection(title: "Hard jobs", nameKey: Prefs.K.hardName, personaKey: Prefs.K.hardPersona,
                           effortKey: Prefs.K.hardEffort,
                           defaultName: "Flint", defaultPersona: Persona.hardDefault, defaultEffort: .high)
            OtherModelPersonas(exclude: [daily, hard, auto])
            Section {
                ForEach(mm.available, id: \.name) { model in
                    HStack {
                        Text(ModelNames.pretty(model.name))
                        Spacer()
                        Text(size(model.size)).foregroundStyle(Ember.secondary).font(.system(size: 12))
                        Text(mm.isLoaded(model.name) ? "Loaded" : "Sleeping")
                            .font(.system(size: 11))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .foregroundStyle(mm.isLoaded(model.name) ? Color.green : Ember.secondary)
                            .background(Capsule().fill(mm.isLoaded(model.name) ? Color.green.opacity(0.15) : Color.white.opacity(0.07)))
                        Button { pendingDelete = model.name } label: { Image(systemName: "trash") }
                            .buttonStyle(.plain)
                            .foregroundStyle(Ember.secondary)
                            .disabled([daily, hard, auto].contains(model.name))
                            .help([daily, hard, auto].contains(model.name) ? "In use — replace it first" : "Delete this model")
                    }
                }
                if mm.available.isEmpty { Text("No models downloaded yet").foregroundStyle(Ember.secondary) }
            } header: {
                HStack {
                    Text("Downloaded")
                    Spacer()
                    Button("Download Models") { Task { await mm.downloadAll() } }
                }
            } footer: {
                if let status = mm.downloadStatus {
                    Text(status).font(.system(size: 11)).foregroundStyle(Ember.secondary)
                }
            }
        }
        .alert("Delete \(ModelNames.pretty(pendingDelete ?? ""))?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })) {
            Button("Cancel", role: .cancel) { pendingDelete = nil }
            Button("Delete", role: .destructive) {
                if let tag = pendingDelete { Task { await mm.delete(tag) } }
                pendingDelete = nil
            }
        } message: {
            Text("This frees up disk space. You can download it again any time.")
        }
    }

    private func contextPicker(_ title: String, _ selection: Binding<Int>) -> some View {
        Picker(selection: selection) {
            Text("8K tokens").tag(8192)
            Text("16K tokens").tag(16384)
            Text("32K tokens").tag(32768)
            Text("64K tokens").tag(65536)
        } label: {
            TitleAndHint(title: title, hint: "How much of the chat it remembers. Longer uses more memory; takes effect next time it wakes")
        }
    }

    private func picker(_ title: String, _ hint: String, _ selection: Binding<String>, bigOnly: Bool) -> some View {
        let limit = Int64(Double(ProcessInfo.processInfo.physicalMemory) * 0.7)
        var options = mm.available.filter { !bigOnly || ($0.size ?? 0) < limit }.map(\.name)
        if !options.contains(selection.wrappedValue) { options.insert(selection.wrappedValue, at: 0) }
        return Picker(selection: selection) {
            ForEach(options, id: \.self) { Text(ModelNames.pretty($0)).tag($0) }
        } label: { TitleAndHint(title: title, hint: hint) }
    }

    private func size(_ bytes: Int64?) -> String {
        guard let bytes else { return "" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

/// Pick a model online, choose its job, download.
private struct GetModelSection: View {
    @Environment(ModelManager.self) private var mm
    @State private var selection = ModelCatalog.models.first?.tag ?? ""
    @State private var custom = ""
    @State private var role: ModelRole = .daily
    @State private var removeOld = false
    @State private var confirming = false

    private static let customTag = "__custom__"
    private var chosen: CatalogModel? { ModelCatalog.models.first { $0.tag == selection } }
    private var tag: String { selection == Self.customTag ? custom.trimmingCharacters(in: .whitespaces) : selection }
    private var alreadyHave: Bool { mm.available.contains { $0.name == tag } }

    var body: some View {
        Section {
            Picker(selection: $selection) {
                ForEach(ModelCatalog.models) { m in
                    Text("\(m.name) · \(m.sizeGB < 2 ? String(format: "%.1f", m.sizeGB) : String(format: "%.0f", m.sizeGB)) GB").tag(m.tag)
                }
                Divider()
                Text("Other — type a name…").tag(Self.customTag)
            } label: { TitleAndHint(title: "Model", hint: "Recommended models, or any from Ollama or Hugging Face") }
            .onChange(of: selection) { _, _ in
                if let c = chosen { role = c.bestFor }
            }

            if selection == Self.customTag {
                TextField("Name", text: $custom, prompt: Text("e.g. gemma4:12b-mlx or hf.co/user/repo:Q4_K_M"))
            } else if let c = chosen {
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.blurb).font(.system(size: 12)).foregroundStyle(Ember.text.opacity(0.85))
                    Text(ModelCatalog.fitNote(c))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(ModelCatalog.fitNote(c) == "Fits this Mac" ? Color.green : Ember.warn)
                }
            }

            Picker(selection: $role) {
                ForEach(ModelRole.allCases) { r in Text(r.menuTitle).tag(r) }
            } label: { TitleAndHint(title: "Use it as", hint: "Replace an assistant’s model, or keep it as an extra") }

            if role != .add, let current = role.currentModel {
                Toggle(isOn: $removeOld) {
                    TitleAndHint(title: "Delete the old model afterwards",
                                 hint: "Frees the space used by \(ModelNames.pretty(current))")
                }
            }

            HStack {
                if let status = mm.installStatus {
                    Text(status).font(.system(size: 11)).foregroundStyle(Ember.secondary).lineLimit(2)
                }
                Spacer()
                Button(alreadyHave ? "Use This Model" : "Download") {
                    if removeOld && role != .add { confirming = true } else { start() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(tag.isEmpty || mm.installing != nil)
            }
            if mm.installing != nil {
                if let p = mm.installProgress { ProgressView(value: p) } else { ProgressView().controlSize(.small) }
            }
        } header: {
            Text("Get a model")
        }
        .confirmationDialog("Replace and delete \(ModelNames.pretty(role.currentModel ?? ""))?", isPresented: $confirming) {
            Button("Download and Replace", role: .destructive) { start() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(ModelNames.pretty(tag)) will take over, and the old model will be deleted once the download finishes.")
        }
    }

    private func start() {
        let t = tag, r = role, remove = removeOld && role != .add
        Task { await mm.install(t, as: r, removeOld: remove) }
    }
}

/// Names and personalities for every other downloaded model.
private struct OtherModelPersonas: View {
    @Environment(ModelManager.self) private var mm
    let exclude: [String]

    private var models: [String] {
        mm.available.map(\.name).filter { name in
            !exclude.contains(name) && !name.lowercased().contains("embed")
        }
    }

    var body: some View {
        if !models.isEmpty {
            Section {
                ForEach(models, id: \.self) { model in
                    OtherModelPersonaRow(model: model)
                }
            } header: {
                Text("Other models")
            } footer: {
                Text("Give any other model a name and a character. Leave them blank to use the model’s own name and a plain, helpful character. Every model still knows how Ingle works.")
                    .font(.system(size: 11))
                    .foregroundStyle(Ember.secondary)
            }
        }
    }
}

private struct OtherModelPersonaRow: View {
    let model: String
    @State private var name = ""
    @State private var persona = ""
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Name", text: $name, prompt: Text(ModelNames.pretty(model)))
                Text("Personality").font(.system(size: 12))
                TextEditor(text: $persona)
                    .font(.system(size: 12))
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(height: 160)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Ember.code))
                HStack {
                    Button("Start from the default") { persona = Persona.otherDefault }
                        .disabled(!persona.isEmpty)
                    Spacer()
                    Button("Clear") { name = ""; persona = "" }
                        .disabled(name.isEmpty && persona.isEmpty)
                }
            }
            .padding(.top, 6)
        } label: {
            HStack {
                Text(ModelProfiles.name(model) ?? ModelNames.pretty(model))
                if ModelProfiles.name(model) != nil {
                    Text(ModelNames.pretty(model)).foregroundStyle(Ember.secondary).font(.system(size: 11))
                }
            }
        }
        .onAppear {
            name = ModelProfiles.name(model) ?? ""
            persona = ModelProfiles.persona(model) ?? ""
        }
        .onChange(of: name) { ModelProfiles.set(model, name: name, persona: persona) }
        .onChange(of: persona) { ModelProfiles.set(model, name: name, persona: persona) }
    }
}

/// Name + personality for one assistant.
private struct PersonaSection: View {
    let title: String
    let defaultName: String
    let defaultPersona: String
    let defaultEffort: EffortLevel
    @AppStorage private var name: String
    @AppStorage private var persona: String
    @AppStorage private var effort: String

    init(title: String, nameKey: String, personaKey: String, effortKey: String, defaultName: String, defaultPersona: String,
         defaultEffort: EffortLevel) {
        self.title = title
        self.defaultName = defaultName
        self.defaultPersona = defaultPersona
        self.defaultEffort = defaultEffort
        _name = AppStorage(wrappedValue: defaultName, nameKey)
        _persona = AppStorage(wrappedValue: defaultPersona, personaKey)
        _effort = AppStorage(wrappedValue: defaultEffort.rawValue, effortKey)
    }

    var body: some View {
        Section {
            TextField("Name", text: $name)
            Picker("Default effort", selection: $effort) {
                ForEach(EffortLevel.allCases) { e in Text(e.label).tag(e.rawValue) }
            }
            .help("Effort for new chats with this assistant. You can change it per chat with the Effort pill (⌘⇧E). "
                  + (EffortLevel(rawValue: effort) ?? defaultEffort).help)
            VStack(alignment: .leading, spacing: 6) {
                Text("Personality")
                TextEditor(text: $persona)
                    .font(.system(size: 12))
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(height: 220)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Ember.code))
            }
            Button("Reset to default") {
                name = defaultName
                persona = defaultPersona
                effort = defaultEffort.rawValue
            }
            .disabled(name == defaultName && persona == defaultPersona && effort == defaultEffort.rawValue)
        } header: {
            Text("\(title) assistant")
        } footer: {
            Text("Write only the character: who they are, what they’re good and bad at, likes, dislikes and how they talk. Ingle always adds what every assistant needs to know — how Ingle works, its tools, Web and Mac access, your rules, skills and memory — so renaming or rewriting never loses that.")
                .font(.system(size: 11))
                .foregroundStyle(Ember.secondary)
        }
    }
}

// MARK: Mac access

struct MacAccessSettings: View {
    @AppStorage(Prefs.K.autoRead) private var autoRead = true
    @State private var folders = Prefs.workspaceFolders
    @AppStorage(Prefs.K.commitSignOff) private var commitSignOff = false

    var body: some View {
        EmberForm {
            Section {
                Text("The assistant can always read files in these folders and use Terminal, asking before every command or file change (“Allow for This Session” covers only the same command or folder). Switch on Mac in a chat to also let it control apps and see your screen. Turn on SSH to let it run commands on servers you choose.")
                    .font(.system(size: 12))
                    .foregroundStyle(Ember.secondary)
            }
            Section("Workspace folders") {
                ForEach(folders, id: \.self) { folder in
                    HStack {
                        Image(systemName: "folder").foregroundStyle(Ember.accent)
                        Text(folder)
                        Spacer()
                        Button(role: .destructive) {
                            folders.removeAll { $0 == folder }
                            Prefs.workspaceFolders = folders
                        } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.plain)
                        .help("Remove")
                    }
                }
                Button("Add Folder…") { addFolder() }
                Toggle(isOn: $autoRead) {
                    TitleAndHint(title: "Read files here without asking", hint: "Listing and reading only. Outside these folders it always asks.")
                }
            }
            SSHSection()
            Section("Commit button") {
                Toggle(isOn: $commitSignOff) {
                    TitleAndHint(title: "Add a Signed-off-by line", hint: "Commits made with Commit under a run’s changes use git commit -s. Ingle never pushes.")
                }
            }
            Section("Always asks first") {
                Label("Running Terminal commands", systemImage: "terminal")
                Label("Running commands on your servers (SSH)", systemImage: "server.rack")
                Label("Creating or changing files", systemImage: "square.and.pencil")
                Label("Opening apps, files and links", systemImage: "arrow.up.forward.app")
                Label("Committing a run’s changes", systemImage: "checkmark.seal")
            }
            Section {
                Text("Local models can make mistakes. Ingle always shows you exactly what it’s about to do — read it before you press Allow.")
                    .font(.system(size: 12))
                    .foregroundStyle(Ember.secondary)
            }
        }
    }

    private func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        guard panel.runModal() == .OK else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for url in panel.urls {
            let path = url.path.hasPrefix(home) ? "~" + url.path.dropFirst(home.count) : url.path
            if !folders.contains(path) { folders.append(path) }
        }
        Prefs.workspaceFolders = folders
    }
}

/// SSH: a switch, then each plain Host from ~/.ssh/config with a tick box. Only ticked hosts can be used.
private struct SSHSection: View {
    @AppStorage(Prefs.K.sshOn) private var enabled = false
    @State private var hosts: [String] = SSH.configHosts()
    @State private var ticked: Set<String> = Set(Prefs.sshHosts.map { $0.lowercased() })

    var body: some View {
        Section("SSH") {
            Toggle(isOn: $enabled) {
                TitleAndHint(title: "Run commands on my servers",
                             hint: "Uses your ~/.ssh/config and SSH keys or ssh-agent. Ingle never asks for or stores passwords.")
            }
            if enabled {
                if hosts.isEmpty {
                    Text("No hosts found in ~/.ssh/config. Add a Host entry, connect once in Terminal, then press Reload.")
                        .font(.system(size: 12))
                        .foregroundStyle(Ember.secondary)
                } else {
                    ForEach(hosts, id: \.self) { host in
                        Toggle(host, isOn: Binding(
                            get: { ticked.contains(host.lowercased()) },
                            set: { on in set(host, on) }))
                            .toggleStyle(.checkbox)
                    }
                }
                HStack {
                    Text("Connect to a new host once in Terminal first, so its key is trusted.")
                        .font(.system(size: 11))
                        .foregroundStyle(Ember.secondary)
                    Spacer()
                    Button("Reload") { hosts = SSH.configHosts() }
                }
            }
        }
    }

    private func set(_ host: String, _ on: Bool) {
        if on { ticked.insert(host.lowercased()) } else { ticked.remove(host.lowercased()) }
        // Keep the names as written in ~/.ssh/config; drop ones that are no longer there.
        var names: [String] = hosts.filter { ticked.contains($0.lowercased()) }
        let gone: [String] = Prefs.sshHosts.filter { old in !hosts.contains { $0.lowercased() == old.lowercased() } }
        names += gone.filter { ticked.contains($0.lowercased()) }
        Prefs.sshHosts = names
    }
}

// MARK: Secrets

struct SecretsSettings: View {
    @AppStorage(Prefs.K.secretsTouchID) private var touchID = true
    @State private var list: [SecretEntry] = Secrets.all()
    @State private var adding = false
    @State private var editing: SecretEntry?
    @State private var deleting: SecretEntry?
    /// Values on show after Touch ID (hidden again after 30 seconds).
    @State private var shown: [String: String] = [:]
    @State private var problem: String?

    var body: some View {
        EmberForm {
            Section {
                Toggle(isOn: $touchID) {
                    TitleAndHint(title: "Ask for Touch ID each time a secret is used",
                                 hint: "After you press Allow on the card. Uses your Mac’s password if there’s no Touch ID.")
                }
            } footer: {
                Text("Assistants can use a secret by name ({{secret:name}}) but never see its value. Every use asks first, and output that shows a value is changed back to its name.")
                    .font(.system(size: 11))
                    .foregroundStyle(Ember.secondary)
            }
            Section("Saved secrets") {
                if list.isEmpty {
                    Text("None yet. Add one here, type /secret in a chat, or paste a key in a message and choose Save as Secret.")
                        .font(.system(size: 12))
                        .foregroundStyle(Ember.secondary)
                }
                ForEach(list) { s in row(s) }
                if let problem {
                    Text(problem).font(.system(size: 12)).foregroundStyle(Color.red)
                }
                HStack {
                    Text("Values are kept only in your Keychain. ~/.ingle/secrets.json lists the names.")
                        .font(.system(size: 11))
                        .foregroundStyle(Ember.secondary)
                    Spacer()
                    Button("Add Secret…") { adding = true }
                }
            }
            Section("VS Code") {
                Text("Ingle for VS Code asks this app for a value when you allow a use, so Touch ID (or a dialog) appears here. If this app isn’t open, macOS asks for your Keychain password instead.")
                    .font(.system(size: 12))
                    .foregroundStyle(Ember.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .sheet(isPresented: $adding, onDismiss: reload) { AddSecretSheet() }
        .sheet(item: $editing, onDismiss: reload) { EditSecretSheet(entry: $0) }
        .confirmationDialog("Delete \(deleting?.name ?? "this secret")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete", role: .destructive) {
                if let d = deleting { Secrets.delete(d.name); shown[d.name] = nil }
                deleting = nil
                reload()
            }
        } message: {
            Text("It’s removed from your Keychain. Chats that use {{secret:\(deleting?.name ?? "")}} won’t be able to any more.")
        }
        .onAppear(perform: reload)
    }

    private func row(_ s: SecretEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.name).font(.system(size: 13, design: .monospaced))
                    if !s.description.isEmpty {
                        Text(s.description).font(.system(size: 11)).foregroundStyle(Ember.secondary)
                    }
                }
                Spacer()
                if shown[s.name] != nil {
                    Button("Hide") { shown[s.name] = nil }
                } else {
                    Button("Show") { reveal(s.name) }
                }
                Button("Edit…") { editing = s }
                Button("Delete…") { deleting = s }
            }
            if let value = shown[s.name] {
                Text(value)
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Ember.code))
            }
        }
    }

    /// Values are shown only after Touch ID (or the Mac's password), whatever the setting above.
    private func reveal(_ name: String) {
        Task { @MainActor in
            guard await Secrets.confirmPresence("show the secret \(name)") else { return }
            let values: [String: String] = await Secrets.values([name])
            guard let value = values[name] else {
                problem = "Couldn’t read \(name) from the Keychain."
                return
            }
            problem = nil
            shown[name] = value
            try? await Task.sleep(for: .seconds(30))
            shown[name] = nil
        }
    }

    private func reload() { list = Secrets.all() }
}

/// Name, description and value for a new secret (Settings → Secrets, and /secret in a chat).
struct AddSecretSheet: View {
    var onSaved: (String) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var value = ""
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Save a secret", systemImage: "key.fill")
                .font(.system(size: 15, weight: .semibold))
            Text("Stored only in your Keychain. Assistants use it by name and you approve each use.")
                .font(.system(size: 12))
                .foregroundStyle(Ember.secondary)
            TextField("Name, e.g. github-token", text: $name)
            TextField("What it’s for (the assistant sees this)", text: $description)
            SecureField("Value", text: $value)
            if let problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(Color.red)
            }
            HStack {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save") {
                    let clean: String = name.trimmingCharacters(in: .whitespaces).lowercased()
                    if let p = Secrets.add(name: clean, description: description.trimmingCharacters(in: .whitespacesAndNewlines), value: value) {
                        problem = p
                    } else {
                        value = ""
                        onSaved(clean)
                        dismiss()
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || value.isEmpty)
            }
        }
        .textFieldStyle(.roundedBorder)
        .padding(20)
        .frame(width: 420)
        .background(Ember.bg)
    }
}

/// Rename a secret or change its description (the value stays as it is).
private struct EditSecretSheet: View {
    let entry: SecretEntry
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var description: String
    @State private var problem: String?

    init(entry: SecretEntry) {
        self.entry = entry
        _name = State(initialValue: entry.name)
        _description = State(initialValue: entry.description)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Edit \(entry.name)", systemImage: "key")
                .font(.system(size: 15, weight: .semibold))
            TextField("Name", text: $name)
            TextField("What it’s for", text: $description)
            Text("Renaming means chats that use {{secret:\(entry.name)}} need the new name.")
                .font(.system(size: 11))
                .foregroundStyle(Ember.secondary)
            if let problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(Color.red)
            }
            HStack {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save") {
                    if let p = Secrets.rename(entry.name, to: name) { problem = p; return }
                    let finalName: String = name.trimmingCharacters(in: .whitespaces).lowercased()
                    Secrets.setDescription(finalName, description.trimmingCharacters(in: .whitespacesAndNewlines))
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .textFieldStyle(.roundedBorder)
        .padding(20)
        .frame(width: 420)
        .background(Ember.bg)
    }
}

// MARK: Web & Memory

struct WebMemorySettings: View {
    @AppStorage(Prefs.K.webDefault) private var webDefault = true
    @AppStorage(Prefs.K.searchProvider) private var provider = "duckduckgo"
    @AppStorage(Prefs.K.searxng) private var searxng = ""
    @AppStorage(Prefs.K.brave) private var braveKey = ""
    @AppStorage(Prefs.K.memoryOn) private var memoryOn = true
    @AppStorage(Prefs.K.memoryAsk) private var memoryAsk = false
    @State private var files: [MemoryFile] = []
    @State private var confirmWipe = false

    var body: some View {
        EmberForm {
            Section {
                Toggle(isOn: $webDefault) {
                    TitleAndHint(title: "Web on in new chats", hint: "You can still switch it per chat with the Web pill")
                }
                Picker(selection: $provider) {
                    Text("DuckDuckGo").tag("duckduckgo")
                    Text("SearXNG (your own)").tag("searxng")
                    Text("Brave Search").tag("brave")
                } label: { TitleAndHint(title: "Search with", hint: "DuckDuckGo needs no setup") }
                if provider == "searxng" {
                    TextField("SearXNG address", text: $searxng, prompt: Text("https://search.yourdomain"))
                    Text("JSON output must be switched on in your SearXNG settings (search.formats: json).")
                        .font(.system(size: 11)).foregroundStyle(Ember.secondary)
                }
                if provider == "brave" {
                    SecureField("Brave Search API key", text: $braveKey)
                }
            } header: {
                Text("Web (read-only)")
            } footer: {
                Text("The assistant can search and read pages, nothing more: no logins, cookies, forms or JavaScript, and nothing on your local network. Pages are treated as untrusted — it won’t follow instructions written in them.")
                    .font(.system(size: 11)).foregroundStyle(Ember.secondary)
            }

            Section {
                Toggle(isOn: $memoryOn) {
                    TitleAndHint(title: "Long-term memory", hint: "Ember and Flint remember lasting facts about you across chats")
                }
                Toggle(isOn: $memoryAsk) {
                    TitleAndHint(title: "Ask before saving", hint: "Show an approval card before anything is remembered or forgotten")
                }
                .disabled(!memoryOn)
                if files.isEmpty {
                    Text("Nothing remembered yet. Tell Ember about yourself and it will start.").foregroundStyle(Ember.secondary)
                }
                ForEach(files) { f in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(f.name)
                            Text("\(f.description.isEmpty ? "Notes" : f.description) · \(f.facts.count) facts")
                                .font(.system(size: 11)).foregroundStyle(Ember.secondary).lineLimit(1)
                        }
                        Spacer()
                        Button { NSWorkspace.shared.open(f.url) } label: { Image(systemName: "square.and.pencil") }
                            .buttonStyle(.plain).foregroundStyle(Ember.secondary).help("Open and edit")
                    }
                }
                HStack {
                    Button("Open Memory Folder") { MemoryStore.openFolder() }
                    Button("Reload") { files = MemoryStore.all() }
                    Spacer()
                    Button("Forget Everything…", role: .destructive) { confirmWipe = true }
                        .disabled(files.isEmpty)
                }
                LabeledContent("Research reports") {
                    HStack {
                        Text("\(ReportStore.all().count) saved").foregroundStyle(Ember.secondary)
                        Button("Open Folder") { ReportStore.openFolder() }
                    }
                }
            } header: {
                Text("Memory")
            } footer: {
                Text("Kept in ~/.ingle/memory as plain Markdown, one file per subject. Every chat gets the index; details are looked up or attached when they match. Passwords, keys and card numbers are never saved.")
                    .font(.system(size: 11)).foregroundStyle(Ember.secondary)
            }
        }
        .onAppear { files = MemoryStore.all() }
        .confirmationDialog("Forget everything Ingle remembers about you?", isPresented: $confirmWipe) {
            Button("Forget Everything", role: .destructive) { MemoryStore.forgetEverything(); files = [] }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This deletes every memory file. It can’t be undone.")
        }
    }
}

// MARK: Extensions

struct ExtensionsSettings: View {
    @State private var rules: [Rule] = []
    @AppStorage(Prefs.K.claudeSkills) private var useClaudeSkills = true
    @AppStorage(Prefs.K.smartMatch) private var smartMatch = true
    @AppStorage(Prefs.K.followRider) private var followRider = false
    @Environment(ModelManager.self) private var mm
    @State private var skills: [Skill] = []
    @State private var importNote: String?

    private var mcp: MCPManager { MCPManager.shared }

    var body: some View {
        EmberForm {
            Section {
                Text("Every chat starts with a short index, ~/.ingle/INGLE.md: your always-on rules, plus one line for each other rule, skill and MCP server below. The assistant loads a skill or a server’s tools only when it needs them, so adding more doesn’t slow every message down. Add your own notes at the bottom of INGLE.md and they’re sent too.")
                    .font(.system(size: 12))
                    .foregroundStyle(Ember.secondary)
                Button("Open INGLE.md") {
                    _ = IngleManifest.refresh(macAccess: true)
                    NSWorkspace.shared.open(IngleManifest.url)
                }
            }
            Section {
                Toggle(isOn: $followRider) {
                    TitleAndHint(title: "Follow Rider", hint: "Reads Rider’s window title to know the project and file. Needs Accessibility permission.")
                }
                if followRider && !EditorBridge.shared.riderTrusted {
                    Button("Grant Accessibility Permission…") { EditorBridge.shared.requestAccessibility() }
                }
                Text("Ingle for VS Code has its own chat (the orange icon at the top right of the editor) and shares your assistants, rules, skills and memory with this app. Install it from Ingle’s Extensions/vscode folder with ./install.sh. Projects with AGENTS.md, CLAUDE.md or a .ingle/rules folder have those rules loaded automatically.")
                    .font(.system(size: 11)).foregroundStyle(Ember.secondary)
            } header: {
                Text("Editors")
            }

            CommandsSection()

            Section {
                Toggle(isOn: $smartMatch) {
                    TitleAndHint(title: "Suggest matching rules and skills",
                                 hint: "Before each message, Ingle finds skills, rules and earlier research that clearly fit it and points the assistant to them. It loads one only if it applies, and the reply shows what it used.")
                }
                if smartMatch {
                    if SemanticMatcher.shared.hasModel {
                        Text("Matching by meaning with nomic-embed-text.").font(.system(size: 11)).foregroundStyle(Color.green)
                    } else {
                        HStack {
                            Text("Matching by keywords. Download the small embedding model (about 300 MB) to match by meaning.")
                                .font(.system(size: 11)).foregroundStyle(Ember.secondary)
                            Spacer()
                            Button("Download") { Task { await mm.install(SemanticMatcher.model, as: .add, removeOld: false) } }
                                .disabled(mm.installing != nil)
                        }
                    }
                }
            } header: {
                Text("Smart matching")
            }

            Section {
                if rules.isEmpty {
                    Text("No rules yet.").foregroundStyle(Ember.secondary)
                }
                ForEach(rules) { rule in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rule.name)
                            Text(rule.description.isEmpty ? String(rule.body.prefix(80)) : rule.description)
                                .font(.system(size: 11)).foregroundStyle(Ember.secondary).lineLimit(1)
                        }
                        Spacer()
                        Picker("", selection: Binding(get: { rule.always }, set: { RuleStore.setAlways(rule, $0); rules = RuleStore.all() })) {
                            Text("Always").tag(true)
                            Text("When relevant").tag(false)
                        }
                        .labelsHidden()
                        .fixedSize()
                        Button { NSWorkspace.shared.open(rule.file) } label: { Image(systemName: "square.and.pencil") }
                            .buttonStyle(.plain)
                            .foregroundStyle(Ember.secondary)
                            .help("Edit this rule")
                    }
                }
                HStack {
                    Button("New Rule") { NSWorkspace.shared.open(RuleStore.create()); rules = RuleStore.all() }
                    Button("Open Rules Folder") { RuleStore.openFolder() }
                    Button("Reload") { rules = RuleStore.all() }
                }
            } header: {
                Text("Rules")
            } footer: {
                Text("One file per rule in ~/.ingle/rules. “Always” rules go into every chat in full; “When relevant” rules are listed in the index with their description, and loaded only when they apply.")
                    .font(.system(size: 11)).foregroundStyle(Ember.secondary)
            }

            Section {
                if skills.isEmpty {
                    Text("No skills yet.").foregroundStyle(Ember.secondary)
                }
                ForEach(skills) { skill in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(skill.name)
                        if !skill.description.isEmpty {
                            Text(skill.description).font(.system(size: 11)).foregroundStyle(Ember.secondary).lineLimit(2)
                        }
                    }
                }
                Toggle("Also use my skills in ~/.claude/skills", isOn: $useClaudeSkills)
                    .onChange(of: useClaudeSkills) { _, _ in skills = SkillStore.all() }
                HStack {
                    Button("Open Skills Folder") { SkillStore.openFolder() }
                    Button("Reload") { skills = SkillStore.all() }
                }
            } header: {
                Text("Skills")
            } footer: {
                Text("Kept in ~/.ingle/skills. A skill is a folder with a SKILL.md — name and description at the top, instructions below, the same format Claude uses. The assistant loads one when a request matches.")
                    .font(.system(size: 11)).foregroundStyle(Ember.secondary)
            }

            Section {
                if mcp.servers.isEmpty {
                    Text("No MCP servers yet.").foregroundStyle(Ember.secondary)
                }
                ForEach(mcp.servers) { server in
                    MCPServerRow(server: server)
                }
                HStack {
                    Button("Edit Config…") { mcp.openConfig() }
                    Button("Import from Claude Desktop") { importNote = mcp.importFromClaudeDesktop() }
                    Button("Reload") { mcp.reload() }
                }
                if let importNote {
                    Text(importNote).font(.system(size: 11)).foregroundStyle(Ember.secondary)
                }
            } header: {
                Text("MCP servers")
            } footer: {
                Text("Ingle’s servers live in ~/.ingle/mcp.json (same format as Claude Desktop and Cursor). Servers from ~/.cursor/mcp.json and ~/.claude.json show up too. The assistant can use them in any chat; each call asks you first.")
                    .font(.system(size: 11)).foregroundStyle(Ember.secondary)
            }
        }
        .onAppear {
            skills = SkillStore.all()
            rules = RuleStore.all()
        }
    }
}

private struct MCPServerRow: View {
    let server: MCPServerConfig
    private var mcp: MCPManager { MCPManager.shared }

    private var statusText: String {
        switch mcp.status[server.name] ?? .stopped {
        case .stopped: return "Starts when a chat needs it"
        case .starting: return "Starting…"
        case .running(let n): return "Running · \(n) tool\(n == 1 ? "" : "s")"
        case .failed(let message): return "Couldn’t start: \(message)"
        }
    }

    private var isRunning: Bool {
        if case .running = mcp.status[server.name] ?? .stopped { return true }
        return false
    }

    var body: some View {
        HStack(spacing: 10) {
            Toggle(isOn: Binding(get: { mcp.isEnabled(server.name) }, set: { mcp.setEnabled(server.name, $0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(server.name)
                        if mcp.source(of: server.name) != "Ingle" {
                            Text("from \(mcp.source(of: server.name))")
                                .font(.system(size: 10, weight: .medium))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .foregroundStyle(Ember.secondary)
                                .background(Capsule().fill(Color.white.opacity(0.07)))
                        }
                    }
                    Text(statusText).font(.system(size: 11)).foregroundStyle(Ember.secondary).lineLimit(2)
                }
            }
            Button(isRunning ? "Restart" : "Start") {
                Task { await mcp.restart(server.name) }
            }
            .disabled(!mcp.isEnabled(server.name))
        }
    }
}

// MARK: About

struct AboutSettings: View {
    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            RoundedRectangle(cornerRadius: 22)
                .fill(Color(hex: 0x2A1F24))
                .frame(width: 96, height: 96)
                .overlay(NetworkMark(top: true, lineWidth: 1.05).frame(width: 60, height: 60))
                .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Color(hex: 0xFFC8AA, opacity: 0.16)))
            Text("Ingle").font(.system(size: 22, weight: .semibold))
            Text("Your AI, kept by the fire at home.").foregroundStyle(Ember.secondary)
            Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")")
                .font(.system(size: 11))
                .foregroundStyle(Ember.tertiary)

            // Credit where it's due: the engine that does the real work.
            VStack(spacing: 6) {
                Text("Powered by Ollama")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Ember.text.opacity(0.85))
                Text("Ingle runs your models with Ollama, the open-source engine by the Ollama team (MIT licence), which builds on llama.cpp and MLX. Thank you to everyone who makes them.")
                    .font(.system(size: 11))
                    .foregroundStyle(Ember.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
                Link("ollama.com", destination: URL(string: "https://ollama.com")!)
                    .font(.system(size: 11))
                    .tint(Ember.accent)
            }
            .padding(.top, 8)

            HStack(spacing: 14) {
                AboutDocLink(title: "Terms of Use", file: "TERMS")
                AboutDocLink(title: "Privacy", file: "PRIVACY")
                AboutDocLink(title: "Licence", file: "LICENSE")
                AboutDocLink(title: "Third-party licences", file: "OllamaRuntime")
            }
            .font(.system(size: 11))
            .padding(.top, 6)
            Text("Free for personal, non-commercial use.")
                .font(.system(size: 10.5))
                .foregroundStyle(Ember.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Ember.bg)
        .foregroundStyle(Ember.text)
    }
}


/// Commands: rules Ingle enforces. Listed with an on/off switch each.
private struct CommandsSection: View {
    @State private var commands: [IngleCommand] = []

    var body: some View {
        Section {
            if commands.isEmpty {
                Text("No commands yet. Ask in a chat: “write a command to always use the figma MCP for component builds”.")
                    .font(.system(size: 12)).foregroundStyle(Ember.secondary)
            }
            ForEach(commands) { c in
                Toggle(isOn: Binding(get: { c.enabled }, set: { CommandStore.setEnabled(c, $0); reload() })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.name)
                        Text((c.description.isEmpty ? "" : c.description + " · ") + "when: " + (c.always ? "always" : c.when.joined(separator: ", ")))
                            .font(.system(size: 11)).foregroundStyle(Ember.secondary).lineLimit(2)
                        if !c.requirementLines.isEmpty {
                            Text(c.requirementLines.joined(separator: " "))
                                .font(.system(size: 11)).foregroundStyle(Ember.tertiary).lineLimit(3)
                        }
                    }
                }
            }
            HStack {
                Button("Open Commands Folder") { CommandStore.openFolder() }
                Button("Reload") { reload() }
            }
        } header: {
            Text("Commands")
        } footer: {
            Text("Commands are rules Ingle enforces, not just suggests: required tools are always offered, banned tools are blocked, and the assistant can’t finish until it has done what the command says. Shared with Ingle for VS Code.")
                .font(.system(size: 11)).foregroundStyle(Ember.secondary)
        }
        .onAppear(perform: reload)
    }

    private func reload() { commands = CommandStore.all() }
}

/// Opens a document that ships inside Ingle.app (Resources/Legal), or the engine's licence folder.
private struct AboutDocLink: View {
    let title: String
    let file: String

    var body: some View {
        Button(title) {
            guard let res = Bundle.main.resourceURL else { return }
            let url = file == "OllamaRuntime"
                ? res.appendingPathComponent("OllamaRuntime", isDirectory: true)
                : res.appendingPathComponent("Legal/\(file).md")
            if FileManager.default.fileExists(atPath: url.path) {
                NSWorkspace.shared.open(url)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(Ember.accent)
    }
}
