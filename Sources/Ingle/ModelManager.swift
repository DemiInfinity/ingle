import Foundation
import AppKit
import IOKit.ps

enum ModelState: Equatable {
    case offline, off, daily, hard, other
}

enum Power {
    static var onBattery: Bool {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let source = IOPSGetProvidingPowerSourceType(blob)?.takeUnretainedValue() else { return false }
        return (source as String) == "Battery Power"
    }
}

/// Watches Ollama and switches models. Shared by the menu bar, chat and settings.
@MainActor @Observable
final class ModelManager {
    var state: ModelState = .offline
    var running: [RunningModel] = []
    var available: [ModelInfo] = []
    var version = ""
    var onBattery = false
    var loading: String?
    var downloadStatus: String?
    var lastError: String?

    private var poller: Task<Void, Never>?

    /// The app's single manager, so the chat can ask it to make room.
    static weak var current: ModelManager?
    private var lastState: ModelState = .offline

    init() {
        Prefs.register()
        poller = Task { [weak self] in
            await OllamaServer.shared.ensureRunning()
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        Self.current = self
    }

    private var client: OllamaClient { OllamaClient() }

    func refresh() async {
        onBattery = Power.onBattery
        do {
            let models = try await client.running()
            running = models
            if version.isEmpty { version = (try? await client.version()) ?? "" }
            if let tags = try? await client.tags() { available = tags }
            await fixFormats()
            let names = Set(models.map(\.name))
            if names.contains(Prefs.hardModel) { state = .hard }
            else if names.contains(Prefs.dailyModel) { state = .daily }
            else if names.filter({ $0 != Prefs.autoModel && !$0.contains("embed") }).isEmpty { state = .off }
            else { state = .other }
        } catch {
            state = .offline
            running = []
            // The built-in engine stopped or never started: bring it back.
            if OllamaServer.shared.hasBuiltIn { await OllamaServer.shared.ensureRunning() }
        }
        usingBuiltIn = OllamaServer.shared.usingBuiltIn

        // Assistants just went to sleep (or the app just started): bring autocomplete back.
        if state == .off && lastState != .off && Prefs.autocompleteMode != "ondemand"
            && available.contains(where: { $0.name == Prefs.autoModel }) && !autocompleteReady {
            try? await client.load(Prefs.autoModel, keepAlive: "-1m")
        }
        lastState = state
    }

    /// Models already checked for the Qwen tool-call format fix this launch (one /api/show each).
    private var formatChecked: Set<String> = []

    /// Give the assistants' models the right tool-call format if they came without one (see `fixFormatIfNeeded`).
    private func fixFormats() async {
        let wanted: [String] = [Prefs.dailyModel, Prefs.hardModel]
        let have: Set<String> = Set(available.map(\.name))
        for model in wanted where have.contains(model) && !formatChecked.contains(model) {
            formatChecked.insert(model)
            await client.fixFormatIfNeeded(model)
        }
    }

    /// Free autocomplete's memory while a big assistant is working (Smart mode only).
    func pauseAutocompleteIfSmart() async {
        guard Prefs.autocompleteMode == "smart", autocompleteReady else { return }
        try? await client.unload(Prefs.autoModel)
    }

    var usingBuiltIn = false

    var engineName: String { usingBuiltIn ? "Built-in engine" : "Ollama app" }

    // MARK: Derived info

    var memoryGB: Double {
        Double(running.reduce(Int64(0)) { $0 + ($1.size_vram ?? $1.size ?? 0) }) / 1_073_741_824
    }

    var totalGB: Double { Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824 }

    var autocompleteReady: Bool { running.contains { $0.name == Prefs.autoModel } }

    func isLoaded(_ name: String) -> Bool { running.contains { $0.name == name } }

    func sleepsIn(_ name: String) -> String? {
        guard let raw = running.first(where: { $0.name == name })?.expires_at else { return nil }
        // Ollama sends nanosecond fractions, which ISO8601DateFormatter can't parse, so drop them.
        let trimmed = raw.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        guard let date = ISO8601DateFormatter().date(from: trimmed) else { return nil }
        if date.timeIntervalSinceNow > 86_400 * 365 { return "stays loaded" }
        let minutes = max(1, Int((date.timeIntervalSinceNow / 60).rounded(.up)))
        return "sleeps in \(minutes) min"
    }

    var headline: String {
        switch state {
        case .offline: return "AI engine isn't running"
        case .off: return "Asleep"
        case .daily: return "\(Prefs.dailyName) is awake"
        case .hard: return "\(Prefs.hardName) is awake"
        case .other: return "A model is loaded"
        }
    }

    var detail: String {
        switch state {
        case .offline: return "Start it to chat"
        case .off: return "Using no memory"
        case .daily, .hard, .other:
            let name = state == .hard ? Prefs.hardModel : state == .daily ? Prefs.dailyModel : (running.first?.name ?? "")
            let mem = String(format: "%.0f of %.0f GB", memoryGB, totalGB)
            if let s = sleepsIn(name) { return "\(mem) · \(s)" }
            return mem
        }
    }

    var statusLine: String {
        switch state {
        case .offline: return "AI engine isn't running"
        case .off: return "Asleep · using no memory"
        case .daily: return "\(Prefs.dailyName) · Daily coding · \(sleepsIn(Prefs.dailyModel) ?? "loaded")"
        case .hard: return "\(Prefs.hardName) · Hard jobs · \(sleepsIn(Prefs.hardModel) ?? "loaded")"
        case .other: return "Another model is loaded"
        }
    }

    // MARK: Actions

    /// Asks before loading the big model on battery. Returns true to go ahead.
    func confirmHardOnBattery() -> Bool {
        guard onBattery, Prefs.warnOnBattery else { return true }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "You’re on battery"
        alert.informativeText = "Hard jobs works your Mac’s GPU hard and drains the battery fast. Plug in first, or load it anyway?"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Load Anyway")
        return alert.runModal() == .alertSecondButtonReturn
    }

    func activate(_ model: String) async {
        loading = model
        defer { loading = nil }
        do {
            if Prefs.unloadOnSwitch {
                for m in running.map(\.name) where m != model && m != Prefs.autoModel {
                    try? await client.unload(m)
                }
            }
            await pauseAutocompleteIfSmart()
            try await client.load(model, keepAlive: Prefs.keepAlive)
            if Prefs.autocompleteMode == "always" { try? await client.load(Prefs.autoModel, keepAlive: "-1m") }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
        await refresh()
    }

    func sleepAll() async {
        for m in running.map(\.name) { try? await client.unload(m) }
        await refresh()
    }

    func downloadAll() async {
        let wanted = [Prefs.autoModel, Prefs.dailyModel, Prefs.hardModel]
        let have = Set(available.map(\.name))
        for model in wanted where !have.contains(model) {
            let label = ModelNames.pretty(model)
            downloadStatus = "Starting \(label)…"
            do {
                for try await step in client.pull(model) {
                    if let f = step.fraction {
                        downloadStatus = "Downloading \(label) · \(Int(f * 100))%"
                    } else {
                        downloadStatus = "\(label): \(step.status)"
                    }
                }
            } catch {
                downloadStatus = "Couldn’t download \(label): \(error.localizedDescription)"
                await refresh()
                return
            }
        }
        for model in wanted { await client.fixFormatIfNeeded(model) }
        downloadStatus = "All models downloaded"
        await refresh()
    }

    /// Start the AI engine: the built-in one if Ingle has it, otherwise the Ollama app.
    var installing: String?
    var installProgress: Double?
    var installStatus: String?
    var installingThinkingDecider = false

    /// Download a model, give it a job, and optionally delete the model it replaces.
    func install(_ tag: String, as role: ModelRole, removeOld: Bool) async {
        let tag = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tag.isEmpty, installing == nil else { return }
        installing = tag
        installProgress = nil
        installStatus = "Starting download…"
        defer { installing = nil }

        let label = ModelNames.pretty(tag)
        do {
            for try await step in client.pull(tag) {
                installProgress = step.fraction
                if let f = step.fraction {
                    installStatus = "Downloading \(label) · \(Int(f * 100))%"
                } else {
                    installStatus = "\(label): \(step.status)"
                }
            }
        } catch {
            installProgress = nil
            installStatus = "Couldn’t download \(label): \(error.localizedDescription)"
            return
        }

        await client.fixFormatIfNeeded(tag)

        let old = role.currentModel
        if let key = role.prefKey { Prefs.d.set(tag, forKey: key) }

        var note = role == .add ? "\(label) is ready — pick it from the model menu in any chat."
                                : "\(label) is ready and now powers \(role == .daily ? Prefs.dailyName : role == .hard ? Prefs.hardName : "autocomplete")."
        if removeOld, let old, old != tag, ![Prefs.dailyModel, Prefs.hardModel, Prefs.autoModel].contains(old) {
            do {
                try? await client.unload(old)
                try await client.delete(old)
                note += " Removed \(ModelNames.pretty(old))."
            } catch {
                note += " Couldn’t remove \(ModelNames.pretty(old)): \(error.localizedDescription)"
            }
        }
        installProgress = 1
        installStatus = note
        await refresh()
    }

    /// Pull the selected thinking decider tag. Ollama refreshes mutable tags such as `strands-decider` in place.
    func updateThinkingDecider(_ tag: String) async {
        guard installing == nil else { return }
        installing = tag
        installingThinkingDecider = true
        installProgress = nil
        installStatus = "Checking \(ModelNames.pretty(tag))…"
        defer { installing = nil; installingThinkingDecider = false }
        let label = ModelNames.pretty(tag)
        do {
            for try await step in client.pull(tag) {
                installProgress = step.fraction
                if let f = step.fraction {
                    installStatus = "Downloading \(label) · \(Int(f * 100))%"
                } else {
                    installStatus = "\(label): \(step.status)"
                }
            }
            installProgress = 1
            installStatus = "\(label) is ready; any available update was applied."
            await refresh()
        } catch {
            installProgress = nil
            installStatus = "Couldn’t update \(label): \(error.localizedDescription)"
        }
    }

    func delete(_ tag: String) async {
        try? await client.unload(tag)
        do {
            try await client.delete(tag)
            installStatus = "Deleted \(ModelNames.pretty(tag))."
        } catch {
            installStatus = "Couldn’t delete \(ModelNames.pretty(tag)): \(error.localizedDescription)"
        }
        await refresh()
    }

    func openOllama() {
        if OllamaServer.shared.hasBuiltIn {
            Task {
                await OllamaServer.shared.ensureRunning()
                await refresh()
            }
            return
        }
        let url = URL(fileURLWithPath: "/Applications/Ollama.app")
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    func restartEngine() async {
        await OllamaServer.shared.restart()
        await refresh()
    }

    func openModelFolder() {
        NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ollama/models"))
    }
}
