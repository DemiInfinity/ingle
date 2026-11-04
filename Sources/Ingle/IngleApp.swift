import SwiftUI
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        MainActor.assumeIsolated {
            EditorBridge.shared.start()
            SettingsMirror.shared.start()
            DockPresence.shared.start()
            EngineUpdater.shared.start()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            MCPManager.shared.stopAll()
            OllamaServer.shared.stop()
        }
    }
}

@main
struct IngleApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var models = ModelManager()
    @State private var chats = ChatStore()

    init() {
        Prefs.register()
    }

    var body: some Scene {
        Window("Ingle", id: "chat") {
            ChatRoot()
                .environment(chats)
                .environment(models)
                .frame(minWidth: 780, minHeight: 540)
        }
        .defaultSize(width: 1120, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Chat") { chats.newChat() }
                    .keyboardShortcut("n")
                Button("Compact Chat") { chats.compactNow() }
                    .keyboardShortcut("k", modifiers: [.command, .shift])
                Button("Cycle Effort") { chats.cycleEffort() }
                    .keyboardShortcut("e", modifiers: [.command, .shift])
            }
        }

        Settings {
            SettingsView()
                .environment(models)
        }

        MenuBarExtra {
            MenuContent()
                .environment(models)
        } label: {
            MenuBarLabel()
                .environment(models)
        }
        .menuBarExtraStyle(.menu)
    }
}
