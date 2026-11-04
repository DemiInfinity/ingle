import Foundation
import CryptoKit

/// Checkpoints: undo a whole run. Before a run first changes a file, its original is copied to
/// ~/.ingle/checkpoints/<chat>/<run>/ (a file that didn't exist is recorded as "didn't exist"). When the run ends,
/// the files' new state is recorded too, so Undo can refuse if a file changed again after the run.
/// Same folder format as Extensions/vscode/src/tools/checkpoints.ts — keep them in step. Foundation only.
enum Checkpoints {
    /// Every tool that changes a local file, in one place. Each of them calls `snapshot(path:run:)` before writing.
    /// (VS Code's list is FILE_CHANGING_TOOLS in checkpoints.ts.)
    static let fileChangingTools: Set<String> = ["write_file", "edit_file"]

    /// Shown in the Undo preview.
    static let notCovered = "Changes made by commands, or on other computers over SSH, can’t be undone here."

    static let maxAgeDays: Double = 14
    static let maxBytes: Int64 = 500 * 1024 * 1024

    /// Which run a change belongs to: the chat and one id per reply to a message.
    struct Run: Equatable, Hashable, Sendable {
        let chat: String
        let run: String
    }

    /// What Undo would do to a file: put the original back, remove a file the run created, or bring back one it deleted.
    enum Action: String, Codable, Equatable { case restore, remove, recreate }

    struct FileSummary: Codable, Equatable {
        var path: String
        var action: Action
    }

    /// One changed file (for the changes panel). nil = didn't exist before / doesn't exist now.
    struct Change: Equatable {
        let path: String
        let before: String?
        let after: String?
    }

    enum RestoreResult: Equatable {
        case done(restored: [String], message: String)
        case refused(changedLater: [String], message: String)
    }

    // MARK: Storage

    struct State: Codable, Equatable {
        var exists: Bool
        var blob: String?
        var hash: String?
    }

    struct Entry: Codable {
        var path: String
        var before: State
        /// For a file that didn't exist: the highest folder the run had to create for it (removed again if empty).
        var createdDir: String?
        var after: State?
    }

    struct Manifest: Codable {
        var version: Int = 1
        var chat: String
        var run: String
        var created: Double          // ms since 1970, like the TS side
        var finished: Double?
        var undone: Double?
        var files: [Entry]
    }

    /// For tests: a folder to use instead of ~/.ingle/checkpoints.
    nonisolated(unsafe) static var rootOverride: URL?

    static var root: URL {
        rootOverride ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".ingle", isDirectory: true)
            .appendingPathComponent("checkpoints", isDirectory: true)
    }

    private static func safe(_ id: String) -> String {
        var s = String(id.map { c -> Character in
            (c.isASCII && (c.isLetter || c.isNumber)) || c == "_" || c == "-" || c == "." ? c : "_"
        })
        if s.hasPrefix(".") { s = "_" + s.drop(while: { $0 == "." }) }
        return s.isEmpty ? "_" : s
    }

    private static func dir(_ run: Run) -> URL {
        root.appendingPathComponent(safe(run.chat), isDirectory: true).appendingPathComponent(safe(run.run), isDirectory: true)
    }

    private static func manifestURL(_ run: Run) -> URL { dir(run).appendingPathComponent("manifest.json") }
    private static func blobURL(_ run: Run, _ name: String) -> URL {
        dir(run).appendingPathComponent("files", isDirectory: true).appendingPathComponent(name)
    }

    private static func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    private static func readManifest(_ run: Run) -> Manifest? {
        guard let data = try? Data(contentsOf: manifestURL(run)) else { return nil }
        return try? JSONDecoder().decode(Manifest.self, from: data)
    }

    private static func writeManifest(_ run: Run, _ m: Manifest) throws {
        try FileManager.default.createDirectory(at: dir(run), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(m)
        try data.write(to: manifestURL(run), options: .atomic)
    }

    private static func sha(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private enum ReadError: Error { case notAFile }

    /// A regular file's bytes, or nil if nothing is there. Throws for folders and unreadable files.
    private static func readBytes(_ path: String) throws -> Data? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { return nil }
        if isDir.boolValue { throw ReadError.notAFile }
        return try Data(contentsOf: URL(fileURLWithPath: path))
    }

    private static func capture(_ run: Run, _ data: Data?, _ name: String) throws -> State {
        guard let data else { return State(exists: false) }
        let url = blobURL(run, name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
        return State(exists: true, blob: name, hash: sha(data))
    }

    private static func load(_ run: Run, _ s: State) throws -> Data? {
        guard s.exists, let blob = s.blob else { return nil }
        return try Data(contentsOf: blobURL(run, blob))
    }

    private static func matches(_ path: String, _ s: State) -> Bool {
        guard let now = try? readBytes(path) else {
            // Missing (nil) or unreadable: only "missing" can match.
            return !s.exists && !FileManager.default.fileExists(atPath: path)
        }
        return s.exists && sha(now) == s.hash
    }

    private static func unchanged(_ e: Entry) -> Bool {
        guard let after = e.after else { return false }
        return after.exists == e.before.exists && after.hash == e.before.hash
    }

    // MARK: The API

    /// Records a file's original before a run first changes it. Every file-changing tool calls this, after approval
    /// and just before writing, with the absolute path. Only the first call per file per run copies anything.
    /// Returns an error sentence if the copy failed (the tool may still go ahead), or nil.
    @discardableResult
    static func snapshot(path: String, run: Run?) -> String? {
        guard let run else { return nil }
        // .standardized (not standardizedFileURL): drops ./.. without resolving symlinks, which would turn /private/tmp
        // into /tmp only for files that exist.
        let full = URL(fileURLWithPath: path).standardized.path
        do {
            var m = readManifest(run) ?? Manifest(chat: run.chat, run: run.run, created: now(), files: [])
            if m.files.contains(where: { $0.path == full }) { return nil }
            let i = m.files.count
            var entry = Entry(path: full, before: try capture(run, try readBytes(full), "\(i).before"))
            if !entry.before.exists {
                // The highest folder that doesn't exist yet: the tool will create it, so undo removes it again (if empty).
                var d = (full as NSString).deletingLastPathComponent
                var top: String?
                while !FileManager.default.fileExists(atPath: d) {
                    top = d
                    let up = (d as NSString).deletingLastPathComponent
                    if up == d || up.isEmpty { break }
                    d = up
                }
                entry.createdDir = top
            }
            m.files.append(entry)
            try writeManifest(run, m)
            return nil
        } catch {
            return "Couldn't save a checkpoint of \(path), so this change can't be undone with Undo this run: \(error.localizedDescription)"
        }
    }

    /// Ends a run: records each file's state now. Returns what Undo would do, or nil if the run changed nothing
    /// (then its checkpoint is deleted).
    static func finish(_ run: Run) -> [FileSummary]? {
        guard var m = readManifest(run) else { return nil }
        for i in m.files.indices {
            let now: Data? = (try? readBytes(m.files[i].path)) ?? nil
            m.files[i].after = (try? capture(run, now, "\(i).after")) ?? State(exists: now != nil)
        }
        m.finished = now()
        try? writeManifest(run, m)
        maybePrune()
        let s = summarise(m)
        if s.isEmpty { discard(run); return nil }
        return s
    }

    private static func summarise(_ m: Manifest) -> [FileSummary] {
        m.files.compactMap { f -> FileSummary? in
            if unchanged(f) { return nil }
            let action: Action = !f.before.exists ? .remove : (f.after.map { !$0.exists } ?? false) ? .recreate : .restore
            return FileSummary(path: f.path, action: action)
        }
    }

    /// What Undo would do for a run (empty if there's no checkpoint).
    static func summary(_ run: Run) -> [FileSummary] {
        readManifest(run).map(summarise) ?? []
    }

    /// The run's changed files with their text before and after. If the run hasn't finished, "after" is the file now.
    static func changes(_ run: Run) -> [Change] {
        guard let m = readManifest(run) else { return [] }
        func text(_ d: Data?) -> String? { d.map { String(decoding: $0, as: UTF8.self) } }
        var out: [Change] = []
        for f in m.files where !unchanged(f) {
            let before: String? = text((try? load(run, f.before)) ?? nil)
            let afterData: Data?
            if let a = f.after { afterData = (try? load(run, a)) ?? nil } else { afterData = (try? readBytes(f.path)) ?? nil }
            out.append(Change(path: f.path, before: before, after: text(afterData)))
        }
        return out
    }

    static func isUndone(_ run: Run) -> Bool { readManifest(run)?.undone != nil }

    /// Undoes a run: puts originals back, removes files it created, brings back files it deleted. Refuses if a file
    /// changed again after the run (unless `force`), and lists those files.
    static func restore(_ run: Run, force: Bool = false) -> RestoreResult {
        guard var m = readManifest(run) else {
            return .refused(changedLater: [], message: "There is no checkpoint for this run any more (checkpoints are kept for 14 days).")
        }
        if m.undone != nil { return .refused(changedLater: [], message: "This run has already been undone.") }
        let files = m.files.filter { !unchanged($0) }
        let changedLater: [String] = files.filter { f in f.after.map { !matches(f.path, $0) } ?? false }.map(\.path)
        if !changedLater.isEmpty && !force {
            let head = changedLater.count == 1 ? "This file has" : "These files have"
            return .refused(changedLater: changedLater,
                            message: "\(head) changed since the run, so undoing would lose those changes:\n" + changedLater.map { "• " + $0 }.joined(separator: "\n"))
        }
        let fm = FileManager.default
        var done: [String] = []
        var failed: [String] = []
        for f in files {
            do {
                if let original = try load(run, f.before) {
                    let url = URL(fileURLWithPath: f.path)
                    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try original.write(to: url, options: .atomic)
                } else {
                    if fm.fileExists(atPath: f.path) { try fm.removeItem(atPath: f.path) }
                    removeEmptyDirs((f.path as NSString).deletingLastPathComponent, top: f.createdDir)
                }
                done.append(f.path)
            } catch {
                failed.append("\(f.path) (\(error.localizedDescription))")
            }
        }
        m.undone = now()
        try? writeManifest(run, m)
        var message = "Undid the run: \(done.count) file\(done.count == 1 ? "" : "s") put back."
        if !failed.isEmpty { message += "\nCouldn't put back:\n" + failed.map { "• " + $0 }.joined(separator: "\n") }
        return .done(restored: done, message: message)
    }

    private static func removeEmptyDirs(_ dir: String, top: String?) {
        guard let top else { return }
        let fm = FileManager.default
        var d = dir
        while d == top || d.hasPrefix(top + "/") {
            guard let items = try? fm.contentsOfDirectory(atPath: d) else { return }
            // Finder's .DS_Store doesn't make a folder "used".
            if items.contains(where: { $0 != ".DS_Store" }) { return }
            guard (try? fm.removeItem(atPath: d)) != nil else { return }
            if d == top { return }
            d = (d as NSString).deletingLastPathComponent
        }
    }

    /// Deletes one run's checkpoint.
    static func discard(_ run: Run) {
        let fm = FileManager.default
        try? fm.removeItem(at: dir(run))
        let chatDir = dir(run).deletingLastPathComponent()
        if (try? fm.contentsOfDirectory(atPath: chatDir.path))?.isEmpty == true { try? fm.removeItem(at: chatDir) }
    }

    /// Deletes every checkpoint of a chat (when the chat is deleted).
    static func discardChat(_ chat: String) {
        try? FileManager.default.removeItem(at: root.appendingPathComponent(safe(chat), isDirectory: true))
    }

    private static func size(of url: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let f as URL in e {
            let s: Int = (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) ?? 0
            total += Int64(s)
        }
        return total
    }

    /// Deletes checkpoints older than 14 days, then the oldest while they take more than 500 MB. Returns how many runs went.
    @discardableResult
    static func prune(now: Double = Date().timeIntervalSince1970 * 1000, maxAgeDays: Double = maxAgeDays, maxBytes: Int64 = maxBytes) -> Int {
        let fm = FileManager.default
        struct Item { let url: URL; let created: Double; let size: Int64; let live: Bool }
        var runs: [Item] = []
        let chats: [URL] = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for c in chats {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: c.path, isDirectory: &isDir), isDir.boolValue else { continue }
            for r in (try? fm.contentsOfDirectory(at: c, includingPropertiesForKeys: nil)) ?? [] {
                var created: Double = 0
                var finished: Double?
                if let data = try? Data(contentsOf: r.appendingPathComponent("manifest.json")),
                   let m = try? JSONDecoder().decode(Manifest.self, from: data) {
                    created = m.created
                    finished = m.finished
                }
                if created == 0 {
                    let date: Date = ((try? fm.attributesOfItem(atPath: r.path))?[.modificationDate] as? Date) ?? Date()
                    created = date.timeIntervalSince1970 * 1000
                }
                // A run still going (not finished, under a day old) is never pruned for size.
                let live: Bool = finished == nil && now - created < 86_400_000
                runs.append(Item(url: r, created: created, size: size(of: r), live: live))
            }
        }
        runs.sort { $0.created < $1.created }
        var total: Int64 = runs.reduce(0) { $0 + $1.size }
        let cutoff: Double = now - maxAgeDays * 86_400_000
        var removed = 0
        for r in runs {
            if r.created >= cutoff && total <= maxBytes { break }
            if r.live && r.created >= cutoff { continue }
            guard (try? fm.removeItem(at: r.url)) != nil else { continue }
            total -= r.size
            removed += 1
        }
        for c in chats where (try? fm.contentsOfDirectory(atPath: c.path))?.isEmpty == true {
            try? fm.removeItem(at: c)
        }
        return removed
    }

    nonisolated(unsafe) private static var lastPrune: Date = .distantPast

    /// Prunes at most once an hour.
    static func maybePrune() {
        guard Date().timeIntervalSince(lastPrune) > 3600 else { return }
        lastPrune = Date()
        prune()
    }
}
