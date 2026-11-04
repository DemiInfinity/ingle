import Foundation

/// Runs the Ollama engine bundled inside Ingle.app, so the separate Ollama app isn't needed.
/// If another Ollama is already serving on this Mac, Ingle uses that instead of starting a second one.
@MainActor
final class OllamaServer {
    static let shared = OllamaServer()

    private var process: Process?
    private(set) var usingBuiltIn = false
    private var starting = false

    /// The engine Ingle runs: an updated one from Settings → General if installed, otherwise the one
    /// inside Ingle.app/Contents/Resources/OllamaRuntime.
    var builtInBinary: URL? {
        if let updated = EngineUpdater.updatedBinary { return updated }
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("OllamaRuntime/ollama"),
              FileManager.default.isExecutableFile(atPath: url.path) else { return nil }
        return url
    }

    var hasBuiltIn: Bool { builtInBinary != nil }

    /// Only manage a local engine; a remote server address (e.g. a home AI box) is left alone.
    private var isLocalServer: Bool {
        let host = URL(string: Prefs.serverURL)?.host ?? "localhost"
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    var isRunningBuiltIn: Bool { process?.isRunning == true }

    func isUp() async -> Bool {
        (try? await OllamaClient().version()) != nil
    }

    /// Start the built-in engine if nothing is answering. Safe to call repeatedly.
    func ensureRunning() async {
        guard isLocalServer, !starting else { return }
        if await isUp() {
            usingBuiltIn = isRunningBuiltIn
            return
        }
        guard let binary = builtInBinary else { return }
        starting = true
        defer { starting = false }

        let p = Process()
        p.executableURL = binary
        p.arguments = ["serve"]
        var env = ProcessInfo.processInfo.environment
        env["OLLAMA_HOST"] = URL(string: Prefs.serverURL).flatMap { u in u.port.map { "127.0.0.1:\($0)" } } ?? "127.0.0.1:11434"
        env["OLLAMA_KEEP_ALIVE"] = Prefs.keepAlive
        p.environment = env

        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Ingle", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let logURL = logs.appendingPathComponent("ollama.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            p.standardOutput = handle
            p.standardError = handle
        }

        do {
            try p.run()
        } catch {
            return
        }
        process = p
        usingBuiltIn = true

        for _ in 0..<40 {
            if await isUp() { return }
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    func restart() async {
        stop()
        try? await Task.sleep(for: .milliseconds(500))
        await ensureRunning()
    }

    func stop() {
        if let p = process, p.isRunning { p.terminate() }
        process = nil
        usingBuiltIn = false
    }
}
