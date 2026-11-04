import Foundation
import Observation

/// Writes ~/.ingle/settings.json so Ingle for VS Code uses the same names, personalities and models.
/// Runs on launch and whenever a setting changes. The extension only reads this file.
@MainActor
final class SettingsMirror {
    static let shared = SettingsMirror()
    private var pending: DispatchWorkItem?
    private var lastWritten: Data?

    func start() {
        write()
        observeMCP()
        NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleWrite() }
        }
    }

    /// MCP connections change without touching UserDefaults, so watch them directly.
    private func observeMCP() {
        withObservationTracking {
            _ = MCPManager.shared.status
            _ = MCPManager.shared.tools
            _ = MCPManager.shared.servers
        } onChange: { [weak self] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.scheduleWrite()
                    self?.observeMCP()
                }
            }
        }
    }

    private func mcpStatus() -> [String: Any] {
        let mcp = MCPManager.shared
        var out: [String: Any] = [:]
        for server in mcp.servers {
            let tools = mcp.tools.filter { $0.server == server.name }.map(\.name)
            switch mcp.status[server.name] ?? .stopped {
            case .stopped: out[server.name] = ["state": "stopped"]
            case .starting: out[server.name] = ["state": "starting"]
            case .running: out[server.name] = ["state": "running", "tools": tools]
            case .failed(let message): out[server.name] = ["state": "failed", "error": message]
            }
        }
        return out
    }

    private func scheduleWrite() {
        pending?.cancel()
        let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.write() } }
        pending = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: item)
    }

    private func write() {
        let engine = OllamaServer.shared.builtInBinary?.path
            ?? "/Applications/Ingle.app/Contents/Resources/OllamaRuntime/ollama"
        let fullName = NSFullUserName()
        let provider = Prefs.searchProvider.isEmpty ? "duckduckgo" : Prefs.searchProvider
        let dict: [String: Any] = [
            "userName": fullName.isEmpty ? NSUserName() : fullName,
            "assistants": [
                ["id": "daily", "name": Prefs.dailyName, "model": Prefs.dailyModel,
                 "persona": Prefs.str(Prefs.K.dailyPersona), "contextLength": Prefs.contextLength(for: Prefs.dailyModel)],
                ["id": "hard", "name": Prefs.hardName, "model": Prefs.hardModel,
                 "persona": Prefs.str(Prefs.K.hardPersona), "contextLength": Prefs.contextLength(for: Prefs.hardModel)],
            ],
            "autocompleteModel": Prefs.autoModel,
            "keepAlive": Prefs.keepAlive,
            "serverURL": Prefs.serverURL,
            "enginePath": engine,
            "web": ["onByDefault": Prefs.webOnByDefault, "provider": provider,
                    "searxngURL": Prefs.searxngURL, "braveKey": Prefs.braveKey],
            "memory": ["enabled": Prefs.memoryEnabled, "askFirst": Prefs.memoryAskFirst],
            "workspaceFolders": Prefs.workspaceFolders,
            "useClaudeSkills": Prefs.useClaudeSkills,
            "smartMatching": Prefs.smartMatching,
            "mcpDisabled": Array(MCPManager.shared.disabledNames).sorted(),
            "mcpStatus": mcpStatus(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]),
              data != lastWritten else { return }
        IngleHome.ensure()
        let file = IngleHome.url.appendingPathComponent("settings.json")
        do {
            try data.write(to: file, options: .atomic)
            // It can hold a Brave API key, so keep it private to this user.
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            lastWritten = data
        } catch {
            NSLog("Ingle: couldn't write settings.json: \(error.localizedDescription)")
        }
    }
}
