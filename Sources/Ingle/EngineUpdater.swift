import Foundation
import CryptoKit
import Observation
import UserNotifications

/// Keeps the built-in Ollama engine up to date without rebuilding Ingle.
/// Checks GitHub once a day, tells you when a newer engine is out, and installs it on request into
/// ~/Library/Application Support/Ingle/Engine/current (verified against Ollama's published checksums).
/// The previous engine is kept, so a bad update can be rolled back.
@MainActor @Observable
final class EngineUpdater {
    static let shared = EngineUpdater()

    enum Phase: Equatable {
        case idle, checking, downloading(Double), installing, failed(String)
    }

    private(set) var installed = ""        // version of the engine Ingle runs (built-in or updated)
    private(set) var latest: String?       // newest release on GitHub
    private(set) var phase: Phase = .idle
    private(set) var lastChecked: Date?

    var updateAvailable: Bool {
        guard let latest, !installed.isEmpty else { return false }
        return Self.compare(latest, installed) > 0
    }

    var canRollBack: Bool { FileManager.default.isExecutableFile(atPath: Self.previous.appendingPathComponent("ollama").path) }

    nonisolated static var autoCheck: Bool {
        get { Prefs.d.object(forKey: "checkEngineUpdates") as? Bool ?? true }
        set { Prefs.d.set(newValue, forKey: "checkEngineUpdates") }
    }

    // MARK: Folders

    nonisolated static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Ingle/Engine", isDirectory: true)
    }
    nonisolated static var current: URL { root.appendingPathComponent("current", isDirectory: true) }
    nonisolated static var previous: URL { root.appendingPathComponent("previous", isDirectory: true) }

    /// The updated engine, if one has been installed and is runnable.
    nonisolated static var updatedBinary: URL? {
        let url = current.appendingPathComponent("ollama")
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    // MARK: Lifecycle

    private var timer: Timer?

    func start() {
        Task { await refreshInstalled() }
        timer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in
            Task { @MainActor in await EngineUpdater.shared.checkIfDue() }
        }
        Task {
            try? await Task.sleep(for: .seconds(20))   // let the app settle first
            await checkIfDue()
        }
    }

    private func checkIfDue() async {
        guard Self.autoCheck else { return }
        let last = Prefs.d.object(forKey: "engineLastCheck") as? Date ?? .distantPast
        guard Date().timeIntervalSince(last) > 20 * 3600 else { return }
        await check(notify: true)
    }

    func refreshInstalled() async {
        guard let binary = OllamaServer.shared.builtInBinary else { installed = ""; return }
        installed = await Self.version(of: binary) ?? ""
    }

    // MARK: Checking

    private struct Release: Decodable {
        struct Asset: Decodable { let name: String; let browser_download_url: String; let size: Int? }
        let tag_name: String
        let assets: [Asset]
    }

    private func fetchLatest() async throws -> Release {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/ollama/ollama/releases/latest")!)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Ingle", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw UpdateError("GitHub answered \(http.statusCode). Try again later.")
        }
        return try JSONDecoder().decode(Release.self, from: data)
    }

    /// Looks for a newer engine. With `notify`, posts a notification once per new version.
    func check(notify: Bool = false) async {
        guard !isBusy else { return }
        phase = .checking
        defer { if phase == .checking { phase = .idle } }
        await refreshInstalled()
        do {
            let release = try await fetchLatest()
            latest = Self.clean(release.tag_name)
            lastChecked = Date()
            Prefs.d.set(Date(), forKey: "engineLastCheck")
            if notify, updateAvailable, let latest, Prefs.d.string(forKey: "engineNotified") != latest {
                Prefs.d.set(latest, forKey: "engineNotified")
                await Self.notify(latest: latest, installed: installed)
            }
        } catch {
            phase = .failed((error as? UpdateError)?.message ?? "Couldn’t check for updates: \(error.localizedDescription)")
        }
    }

    // MARK: Updating

    func update() async {
        guard !isBusy else { return }
        do {
            phase = .checking
            let release = try await fetchLatest()
            let version = Self.clean(release.tag_name)
            guard let asset = release.assets.first(where: { $0.name == "ollama-darwin.tgz" }),
                  let url = URL(string: asset.browser_download_url) else {
                throw UpdateError("This Ollama release has no Mac download yet. Try again later.")
            }
            let expected = try await expectedChecksum(release)

            // Download with progress.
            phase = .downloading(0)
            let fm = FileManager.default
            try fm.createDirectory(at: Self.root, withIntermediateDirectories: true)
            let archive = Self.root.appendingPathComponent("ollama-\(version).tgz")
            try await download(url, to: archive, size: asset.size)

            phase = .installing
            if let expected {
                let actual = try Self.sha256(of: archive)
                guard actual == expected else {
                    try? fm.removeItem(at: archive)
                    throw UpdateError("The download didn’t match Ollama’s published checksum, so it wasn’t installed.")
                }
            }

            // Unpack into a staging folder, slim it, and make sure it runs.
            let staging = Self.root.appendingPathComponent("staging", isDirectory: true)
            try? fm.removeItem(at: staging)
            try fm.createDirectory(at: staging, withIntermediateDirectories: true)
            try await Self.run("/usr/bin/tar", ["-xzf", archive.path, "-C", staging.path])
            try? fm.removeItem(at: archive)
            let binary = try Self.findBinary(in: staging)
            let engineDir = binary.deletingLastPathComponent()
            Self.slim(engineDir)
            guard let got = await Self.version(of: binary) else {
                throw UpdateError("The new engine wouldn’t start, so Ingle kept the current one.")
            }

            // Swap it in, keeping the old one for rollback.
            try? fm.removeItem(at: Self.previous)
            if fm.fileExists(atPath: Self.current.path) { try fm.moveItem(at: Self.current, to: Self.previous) }
            try fm.moveItem(at: engineDir, to: Self.current)
            try? fm.removeItem(at: staging)

            await restartEngine()
            installed = got
            latest = version
            phase = .idle
        } catch {
            phase = .failed((error as? UpdateError)?.message ?? "Update failed: \(error.localizedDescription)")
        }
    }

    /// Go back to the engine that was there before the last update.
    func rollBack() async {
        guard canRollBack, !isBusy else { return }
        let fm = FileManager.default
        let temp = Self.root.appendingPathComponent("swap", isDirectory: true)
        try? fm.removeItem(at: temp)
        try? fm.moveItem(at: Self.current, to: temp)
        try? fm.moveItem(at: Self.previous, to: Self.current)
        try? fm.moveItem(at: temp, to: Self.previous)
        await restartEngine()
        await refreshInstalled()
    }

    /// Back to the engine that shipped inside Ingle.app.
    func useBundled() async {
        guard !isBusy else { return }
        let fm = FileManager.default
        try? fm.removeItem(at: Self.previous)
        try? fm.moveItem(at: Self.current, to: Self.previous)
        await restartEngine()
        await refreshInstalled()
    }

    var isBusy: Bool {
        switch phase {
        case .checking, .downloading, .installing: return true
        default: return false
        }
    }

    private func restartEngine() async {
        let running = await OllamaServer.shared.isUp()
        if OllamaServer.shared.usingBuiltIn || !running {
            await OllamaServer.shared.restart()
        }
        await ModelManager.current?.refresh()
    }

    private func expectedChecksum(_ release: Release) async throws -> String? {
        guard let sums = release.assets.first(where: { $0.name == "sha256sum.txt" }),
              let url = URL(string: sums.browser_download_url) else { return nil }
        let (data, _) = try await URLSession.shared.data(from: url)
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            if parts.count >= 2, parts.last?.hasSuffix("ollama-darwin.tgz") == true { return String(parts[0]).lowercased() }
        }
        return nil
    }

    private func download(_ url: URL, to file: URL, size: Int?) async throws {
        let loader = Downloader { [weak self] fraction in
            Task { @MainActor in
                if case .downloading = self?.phase { self?.phase = .downloading(fraction) }
            }
        }
        let temp = try await loader.download(url)
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: temp, to: file)
    }

    // MARK: Helpers

    /// Drops what an Apple Silicon Mac never uses: Intel CPU libraries, the quantize tool and Ollama's app images.
    private static func slim(_ dir: URL) {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
        for name in items where name.hasPrefix("libggml-cpu-") || name == "llama-quantize"
            || name.hasSuffix(".png") || name.hasSuffix(".icns") || name.hasSuffix(".svg") {
            try? fm.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    private static func findBinary(in dir: URL) throws -> URL {
        let direct = dir.appendingPathComponent("ollama")
        if FileManager.default.isExecutableFile(atPath: direct.path) { return direct }
        if let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) {
            for case let url as URL in e where url.lastPathComponent == "ollama" && FileManager.default.isExecutableFile(atPath: url.path) {
                return url
            }
        }
        throw UpdateError("The download didn’t contain the ollama engine.")
    }

    static func version(of binary: URL) async -> String? {
        let out = try? await run(binary.path, ["-v"], capture: true)
        guard let out, let r = out.range(of: #"\d+\.\d+\.\d+"#, options: .regularExpression) else { return nil }
        return String(out[r])
    }

    @discardableResult
    private static func run(_ path: String, _ args: [String], capture: Bool = false) async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: path)
            p.arguments = args
            var env = ProcessInfo.processInfo.environment
            env["OLLAMA_HOST"] = "127.0.0.1:1"   // `-v` mustn't talk to a running server
            p.environment = env
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            p.terminationHandler = { proc in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let text = String(decoding: data, as: UTF8.self)
                if proc.terminationStatus == 0 || capture { cont.resume(returning: text) }
                else { cont.resume(throwing: UpdateError("\(URL(fileURLWithPath: path).lastPathComponent) failed: \(text.prefix(200))")) }
            }
            do { try p.run() } catch { cont.resume(throwing: error) }
        }
    }

    private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func clean(_ tag: String) -> String { tag.hasPrefix("v") ? String(tag.dropFirst()) : tag }

    /// Compares dotted versions: >0 if a is newer.
    static func compare(_ a: String, _ b: String) -> Int {
        let pa = a.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y ? 1 : -1 }
        }
        return 0
    }

    private static func notify(latest: String, installed: String) async {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        guard granted else { return }
        let content = UNMutableNotificationContent()
        content.title = "AI engine update available"
        content.body = "Ollama \(latest) is out (you have \(installed)). Update it in Ingle → Settings → General, or from the menu bar."
        try? await center.add(UNNotificationRequest(identifier: "engine-\(latest)", content: content, trigger: nil))
    }
}

struct UpdateError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

/// A download with progress (URLSession's async download has none).
private final class Downloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let progress: (Double) -> Void
    private var continuation: CheckedContinuation<URL, Error>?
    private var session: URLSession?

    init(progress: @escaping (Double) -> Void) { self.progress = progress }

    func download(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { cont in
            continuation = cont
            let s = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
            session = s
            s.downloadTask(with: url).resume()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesExpectedToWrite > 0 { progress(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temporary file is deleted when this returns, so move it somewhere safe first.
        let keep = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".tgz")
        do {
            if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
                throw UpdateError("The download failed (\(http.statusCode)).")
            }
            try FileManager.default.moveItem(at: location, to: keep)
            continuation?.resume(returning: keep)
        } catch {
            continuation?.resume(throwing: error)
        }
        continuation = nil
        session.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error, let c = continuation {
            continuation = nil
            c.resume(throwing: error)
            session.invalidateAndCancel()
        }
    }
}
