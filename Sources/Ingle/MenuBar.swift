import SwiftUI
import AppKit

struct MenuBarLabel: View {
    @Environment(ModelManager.self) private var mm
    @AppStorage(Prefs.K.showName) private var showName = false

    var body: some View {
        let text = showName ? (mm.state == .daily ? "Daily" : mm.state == .hard ? "Hard" : "AI") : "AI"
        Image(nsImage: MenuIcon.image(state: mm.state, text: text))
    }
}

struct MenuContent: View {
    @Environment(ModelManager.self) private var mm
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        let daily = Prefs.dailyModel
        let hard = Prefs.hardModel

        Text("Ingle")
        Text(mm.statusLine)
        if mm.state == .hard && mm.onBattery {
            Text("On battery — plug in. Hard jobs drains it fast.")
        }
        if let error = mm.lastError {
            Text("Couldn’t load: \(error)")
        }
        Divider()

        if mm.state == .offline {
            Button("Start AI Engine") { mm.openOllama() }
        } else {
            Toggle(isOn: Binding(get: { mm.state == .daily }, set: { _ in
                Task { await mm.activate(daily) }
            })) {
                Text("\(Prefs.dailyName) — Daily coding")
                Text("Fast · low power · \(ModelNames.pretty(daily))")
            }
            Toggle(isOn: Binding(get: { mm.state == .hard }, set: { _ in
                guard mm.confirmHardOnBattery() else { return }
                Task { await mm.activate(hard) }
            })) {
                Text("\(Prefs.hardName) — Hard jobs")
                Text(mm.onBattery ? "Smarter · slower · plug in first" : "Smarter · slower · \(ModelNames.pretty(hard))")
            }
            if let loading = mm.loading {
                Text("Loading \(ModelNames.pretty(loading))…")
            }
            Divider()
            Text("Autocomplete · \(mm.autocompleteReady ? "Ready" : "Wakes as you type")")
            if mm.memoryGB > 0.1 {
                Text(String(format: "Memory · %.0f of %.0f GB", mm.memoryGB, mm.totalGB))
            }
            if mm.state != .off {
                Button("Sleep Now") { Task { await mm.sleepAll() } }
            }
        }
        Divider()
        Button("Open Chat") {
            NSApp.setActivationPolicy(.regular)   // back in the Dock while the chat is open
            openWindow(id: "chat")
            NSApp.activate(ignoringOtherApps: true)
        }
        .keyboardShortcut("o")
        Button("Settings…") {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        }
        .keyboardShortcut(",")
        Menu("More") {
            Button("Download Models") { Task { await mm.downloadAll() } }
            if let status = mm.downloadStatus { Text(status) }
            Button("Restart AI Engine") { Task { await mm.restartEngine() } }
            if EngineUpdater.shared.updateAvailable, let latest = EngineUpdater.shared.latest {
                Button("Update AI Engine to \(latest)") { Task { await EngineUpdater.shared.update() } }
            }
            Button("Open Model Folder") { mm.openModelFolder() }
            Divider()
            Text("\(mm.engineName) \(mm.version.isEmpty ? "–" : mm.version) · \(mm.available.count) models")
        }
        Divider()
        Button("Quit Ingle") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
