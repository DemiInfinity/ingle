import SwiftUI
import UniformTypeIdentifiers

/// What a preview tab shows a file as.
enum PreviewKind: String {
    case markdown, html, svg, image, pdf, csv, tsv, json, yaml, code

    static func of(_ url: URL) -> PreviewKind {
        switch url.pathExtension.lowercased() {
        case "md", "markdown", "mdown", "mkd": return .markdown
        case "html", "htm", "xhtml": return .html
        case "svg": return .svg
        case "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "tif", "tiff", "avif": return .image
        case "pdf": return .pdf
        case "csv": return .csv
        case "tsv", "tab": return .tsv
        case "json", "jsonc", "geojson", "ipynb": return .json
        case "yaml", "yml": return .yaml
        default: return .code
        }
    }

    /// Text files get Preview / Source / Split, and Source edits the file.
    var isText: Bool { ![.image, .pdf].contains(self) }
    /// Rendered by the shared page in Support/preview (everything except HTML pages and PDFs).
    var usesRenderer: Bool { ![.html, .pdf].contains(self) }
}

/// One open file in the preview pane. The preview always shows what's on disk; Source edits are saved to the file.
@MainActor @Observable
final class PreviewTab: Identifiable {
    enum Mode: String, CaseIterable { case preview = "Preview", source = "Source", split = "Split" }

    let id = UUID()
    let url: URL
    let kind: PreviewKind
    /// The file as it is on disk (text files).
    private(set) var text: String = ""
    /// The Source editor's text; saved shortly after you stop typing.
    var draft: String = "" { didSet { if draft != text { scheduleSave() } } }
    var mode: Mode
    /// HTML only: run the page's scripts (network requests stay blocked either way).
    var javaScript: Bool
    /// Bumped whenever the file changes, so web views and PDFs reload.
    private(set) var stamp: Int = 0
    private(set) var missing = false
    /// Saving failed (read-only file, folder gone…).
    private(set) var saveError: String?
    /// The preview couldn't be shown safely (the network block failed to set up).
    var problem: String?
    /// The file is downloaded from the web (quarantined).
    let fromWeb: Bool

    private var watcher: FileWatcher?
    private var saveWork: DispatchWorkItem?
    private var modified: Date?

    var name: String { url.lastPathComponent }
    var folder: URL { url.deletingLastPathComponent() }

    init(url: URL, mode: Mode = .preview) {
        self.url = url
        self.kind = PreviewKind.of(url)
        self.mode = PreviewKind.of(url).isText ? mode : .preview
        let quarantined: Bool = PreviewTab.isQuarantined(url)
        self.fromWeb = quarantined
        // A page that came from the web starts with its scripts off; you can switch them on.
        self.javaScript = !quarantined
        load()
        watcher = FileWatcher(path: url.path) { [weak self] in
            MainActor.assumeIsolated { self?.diskChanged() }
        }
    }

    func close() {
        flushSave()
        watcher?.stop()
        watcher = nil
    }

    static func isQuarantined(_ url: URL) -> Bool {
        let size: Int = getxattr(url.path, "com.apple.quarantine", nil, 0, 0, 0)
        return size > 0
    }

    private func load() {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        missing = attrs == nil
        modified = attrs?[.modificationDate] as? Date
        guard kind.isText, !missing else { return }
        let raw: String = (try? String(contentsOf: url, encoding: .utf8))
            ?? (try? String(contentsOf: url, encoding: .isoLatin1)) ?? ""
        text = raw
        if saveWork == nil { draft = raw }
    }

    /// The watcher saw a change. Our own saves come back here too; nothing to do for those.
    private func diskChanged() {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let date = attrs?[.modificationDate] as? Date
        if attrs != nil, !missing, date == modified { return }
        let before: String = text
        load()
        if !kind.isText || text != before || attrs == nil { stamp += 1 }
    }

    func reload() {
        load()
        stamp += 1
    }

    private func scheduleSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.flushSave() }
        }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    /// Writes the Source editor's text now (if it differs from the file).
    func flushSave() {
        saveWork?.cancel()
        saveWork = nil
        guard kind.isText, draft != text else { return }
        do {
            try draft.write(to: url, atomically: true, encoding: .utf8)
            saveError = nil
            text = draft
            modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
            missing = false
            stamp += 1
        } catch {
            saveError = "Couldn’t save \(name): \(error.localizedDescription)"
        }
    }

    /// A task-list tick clicked in the preview: change that box in the file.
    func toggleTask(_ index: Int, checked: Bool) {
        flushSave()
        guard let next = PreviewTasks.toggle(text, index: index, checked: checked) else { return }
        draft = next
        flushSave()
    }
}

/// Task-list boxes in Markdown, counted the way the renderer counts them (front matter and code blocks skipped).
enum PreviewTasks {
    static func toggle(_ text: String, index: Int, checked: Bool) -> String? {
        var lines: [String] = text.components(separatedBy: "\n")
        var fence: String?
        var count = 0
        var start = 0
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
           let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
            start = end + 1
        }
        for i in start..<lines.count {
            let line: String = lines[i]
            let trimmed: String = line.trimmingCharacters(in: .whitespaces)
            if let f = fence {
                if trimmed.hasPrefix(f) { fence = nil }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                fence = String(trimmed.prefix(3))
                continue
            }
            guard let r = line.range(of: #"^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]"#, options: .regularExpression) else { continue }
            if count == index {
                var head: String = String(line[r])
                head.removeLast(2)
                lines[i] = head + (checked ? "x]" : " ]") + line[r.upperBound...]
                return lines.joined(separator: "\n")
            }
            count += 1
        }
        return nil
    }
}

/// The preview pane's tabs. One shared store: plan cards, links, the changes panel, /preview and open_preview all
/// open files here.
@MainActor @Observable
final class PreviewStore {
    static let shared = PreviewStore()

    private(set) var tabs: [PreviewTab] = []
    var selected: PreviewTab.ID?
    var visible = false

    var current: PreviewTab? { tabs.first { $0.id == selected } ?? tabs.last }

    /// Opens (or brings forward) a file. Returns why it couldn't, or nil.
    @discardableResult
    func open(_ url: URL, mode: PreviewTab.Mode? = nil) -> String? {
        let file: URL = url.standardizedFileURL.resolvingSymlinksInPath()
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir) else { return "\(file.path) doesn’t exist." }
        guard !isDir.boolValue else { return "\(file.path) is a folder; the preview shows files." }
        if let tab = tabs.first(where: { $0.url == file }) {
            if let mode, tab.kind.isText { tab.mode = mode }
            selected = tab.id
        } else {
            let tab = PreviewTab(url: file, mode: mode ?? .preview)
            tabs.append(tab)
            selected = tab.id
        }
        visible = true
        return nil
    }

    func close(_ id: PreviewTab.ID) {
        guard let i = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[i].close()
        WebPreviewCache.drop(id)
        tabs.remove(at: i)
        if selected == id { selected = tabs.indices.contains(i) ? tabs[i].id : tabs.last?.id }
        if tabs.isEmpty { visible = false }
    }

    func toggle() {
        visible.toggle()
    }

    /// Resolves a link or a path the model gave: absolute, ~, file:// or relative to `base` (a folder).
    static func resolve(_ path: String, base: URL?) -> URL? {
        var p: String = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return nil }
        if p.hasPrefix("file://"), let u = URL(string: p) { return u }
        if p.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*:"#, options: .regularExpression) != nil { return nil }   // http:, mailto: …
        if let hash = p.firstIndex(of: "#") { p = String(p[..<hash]) }
        p = p.removingPercentEncoding ?? p
        if p.hasPrefix("~") { return URL(fileURLWithPath: (p as NSString).expandingTildeInPath) }
        if p.hasPrefix("/") { return URL(fileURLWithPath: p) }
        guard let base else { return nil }
        return URL(fileURLWithPath: p, relativeTo: base).standardizedFileURL
    }
}

/// The one way the rest of the app opens a file in the previewer (plan cards, briefs, links, the changes panel).
enum Preview {
    @MainActor static func open(_ url: URL, mode: PreviewTab.Mode? = nil) {
        if let problem = PreviewStore.shared.open(url, mode: mode) {
            NSSound.beep()
            NSLog("Ingle preview: %@", problem)
            return
        }
        AppActions.showChat()
    }

    /// The open_preview tool: no approval, since it only shows a file the user could already see.
    @MainActor static func tool(path: String, folder: String?) -> String {
        let base: URL? = folder.map { URL(fileURLWithPath: $0, isDirectory: true) }
        guard let url = PreviewStore.resolve(path, base: base) else { return "Give a file path, e.g. ~/Desktop/page.html." }
        // Never auto-open HTML that came from the web.
        if PreviewKind.of(url) == .html, PreviewTab.isQuarantined(url) {
            return "\(url.lastPathComponent) was downloaded from the web, so it isn’t opened automatically. Tell the user they can open it in the preview pane themselves (scripts start switched off)."
        }
        if let problem = PreviewStore.shared.open(url) { return problem }
        AppActions.showChat()
        return "Showing \(url.path) in the preview pane beside the chat."
    }

    static let definition: [String: Any] = [
        "type": "function",
        "function": ["name": "open_preview",
                     "description": "Show a file to the user, rendered, in the preview pane beside the chat: Markdown, HTML pages, SVG, images, PDF, CSV, JSON, YAML or code. Use it after writing a file the user will want to see.",
                     "parameters": ["type": "object",
                                    "properties": ["path": ["type": "string", "description": "File path"]],
                                    "required": ["path"]]]]

    /// Words that suggest the user wants to see a file (tool filtering).
    static func wanted(_ text: String) -> Bool {
        text.range(of: #"preview|show me|let me see|render|open (it|the|that)|\.(html?|svg|md|csv|pdf)\b|diagram|chart|page|mermaid"#,
                   options: .regularExpression) != nil
    }
}

extension ChatStore {
    /// `/preview <path>`: opens the file (relative paths are inside a Code chat's project); on its own, shows or hides the pane.
    func previewCommand(_ argument: String) {
        let path: String = argument.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            PreviewStore.shared.toggle()
            return
        }
        let base: URL? = current?.codeFolder.map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? URL(fileURLWithPath: FileManager.default.homeDirectoryForCurrentUser.path, isDirectory: true)
        guard let url = PreviewStore.resolve(path, base: base) else {
            notice = "Give /preview a file path, e.g. /preview ~/Desktop/notes.md"
            return
        }
        if let problem = PreviewStore.shared.open(url) {
            notice = problem
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(6))
                self?.notice = nil
            }
        }
    }
}

private struct PreviewFolderKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    /// The folder relative file links in replies resolve against (a Code chat's project).
    var previewFolder: String? {
        get { self[PreviewFolderKey.self] }
        set { self[PreviewFolderKey.self] = newValue }
    }
}
