import Foundation
import Network
import AppKit
import ApplicationServices

/// What you're working on in your editor, as reported by the Ingle Bridge extension (VS Code)
/// or read from Rider's window title.
struct EditorDiagnostic: Codable, Hashable {
    let line: Int
    let severity: String
    let message: String
}

struct EditorContext: Codable, Equatable {
    var editor: String
    var workspace: String?
    var file: String?
    var language: String?
    var selection: String?
    var diagnostics: [EditorDiagnostic]?
    var updated: Date?

    var isFresh: Bool { (updated ?? .distantPast).timeIntervalSinceNow > -30 * 60 }
    var projectName: String? { workspace.map { URL(fileURLWithPath: $0).lastPathComponent } }
    var fileName: String? { file.map { URL(fileURLWithPath: $0).lastPathComponent } }

    var chipText: String {
        [projectName, fileName].compactMap { $0 }.joined(separator: " · ")
    }

    /// The part of the system prompt that tells the assistant what you're working on.
    var promptSection: String {
        var lines = ["## What the user is working on (from \(editor))"]
        if let workspace { lines.append("Project folder: \(workspace)") }
        if let file { lines.append("Current file: \(file)" + (language.map { " (\($0))" } ?? "")) }
        if let selection, !selection.isEmpty {
            lines.append("Selected code:\n```\(language ?? "")\n\(selection.prefix(8000))\n```")
        }
        if let d = diagnostics, !d.isEmpty {
            lines.append("Problems in this file:")
            for item in d.prefix(20) { lines.append("- line \(item.line) \(item.severity): \(item.message)") }
        }
        lines.append("Use this when it's relevant; don't mention it otherwise.")
        return lines.joined(separator: "\n")
    }

    /// AGENTS.md / CLAUDE.md in the project root, the convention Claude Code and Cursor use.
    var projectInstructions: String? {
        guard let workspace else { return nil }
        var parts: [String] = []
        for name in ["AGENTS.md", "CLAUDE.md", ".cursorrules"] {
            let url = URL(fileURLWithPath: workspace).appendingPathComponent(name)
            if let text = try? String(contentsOf: url, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                parts.append("### From \(name)\n" + String(text.prefix(8000)))
            }
        }
        return parts.isEmpty ? nil : "## This project's own rules — follow them\n" + parts.joined(separator: "\n\n")
    }
}

struct AskRequest: Codable {
    var text: String?
    var editor: String?
    var workspace: String?
    var file: String?
    var language: String?
    var selection: String?
    var diagnostics: [EditorDiagnostic]?
}

/// Tiny HTTP request parser — just enough for the bridge.
private struct HTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data

    static func parse(_ data: Data) -> HTTPRequest? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[data.startIndex..<headerEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = data[headerEnd.upperBound...]
        guard body.count >= length else { return nil }
        return HTTPRequest(method: String(requestLine[0]), path: String(requestLine[1]),
                           headers: headers, body: Data(body.prefix(length)))
    }
}

/// Listens on 127.0.0.1 only. Every request must carry the secret in ~/.ingle/bridge-token,
/// so other apps on the Mac can't push text into your chats.
@MainActor @Observable
final class EditorBridge {
    static let shared = EditorBridge()
    static let port: UInt16 = 47123

    var context: EditorContext?
    var listening = false
    var lastError: String?

    @ObservationIgnored private var listener: NWListener?
    @ObservationIgnored let token: String
    @ObservationIgnored private var riderTimer: Timer?

    static var tokenURL: URL { IngleHome.url.appendingPathComponent("bridge-token") }

    init() {
        token = Self.loadOrCreateToken()
    }

    private static func loadOrCreateToken() -> String {
        if let saved = try? String(contentsOf: tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           !saved.isEmpty { return saved }
        let fresh = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "")
        IngleHome.ensure()
        try? fresh.write(to: tokenURL, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
        return fresh
    }

    var freshContext: EditorContext? {
        guard let c = context, c.isFresh else { return nil }
        return c
    }

    // MARK: Listener

    func start() {
        guard listener == nil, let port = NWEndpoint.Port(rawValue: Self.port) else { return }
        do {
            let params = NWParameters.tcp
            params.requiredInterfaceType = .loopback
            params.allowLocalEndpointReuse = true
            let l = try NWListener(using: params, on: port)
            l.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.handle(connection) }
            }
            l.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    switch state {
                    case .ready: self?.listening = true; self?.lastError = nil
                    case .failed(let error): self?.listening = false; self?.lastError = error.localizedDescription
                    case .cancelled: self?.listening = false
                    default: break
                    }
                }
            }
            l.start(queue: .main)
            listener = l
        } catch {
            lastError = error.localizedDescription
        }
        startRiderWatch()
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] data, _, isComplete, error in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                var buf = buffer
                if let data { buf.append(data) }
                if let request = HTTPRequest.parse(buf) {
                    let (status, body) = self.route(request)
                    self.respond(connection, status: status, body: body)
                } else if isComplete || error != nil || buf.count > 2_000_000 {
                    connection.cancel()
                } else {
                    self.receive(connection, buffer: buf)
                }
            }
        }
    }

    private func route(_ request: HTTPRequest) -> (Int, String) {
        guard request.headers["x-ingle-token"] == token else { return (401, #"{"error":"bad token"}"#) }
        let decoder = JSONDecoder()
        switch (request.method, request.path) {
        case ("GET", "/ping"):
            return (200, #"{"ok":true,"app":"Ingle"}"#)
        case ("POST", "/context"):
            guard var c = try? decoder.decode(EditorContext.self, from: request.body) else { return (400, #"{"error":"bad json"}"#) }
            c.updated = Date()
            context = c
            return (200, #"{"ok":true}"#)
        case ("POST", "/ask"):
            guard let ask = try? decoder.decode(AskRequest.self, from: request.body) else { return (400, #"{"error":"bad json"}"#) }
            context = EditorContext(editor: ask.editor ?? "VS Code", workspace: ask.workspace, file: ask.file,
                                    language: ask.language, selection: ask.selection, diagnostics: ask.diagnostics, updated: Date())
            ChatStore.current?.receiveFromEditor(ask)
            AppActions.showChat()
            return (200, #"{"ok":true}"#)
        default:
            return (404, #"{"error":"not found"}"#)
        }
    }

    private func respond(_ connection: NWConnection, status: Int, body: String) {
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found"][status] ?? "OK"
        let bytes = Data(body.utf8)
        var response = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
        response += body
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }

    // MARK: Rider (window title, needs Accessibility permission)

    var riderTrusted: Bool { AXIsProcessTrusted() }

    func requestAccessibility() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    private func startRiderWatch() {
        riderTimer?.invalidate()
        riderTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkRider() }
        }
    }

    private func checkRider() {
        guard Prefs.followRider, AXIsProcessTrusted(),
              let app = NSWorkspace.shared.frontmostApplication,
              app.bundleIdentifier == "com.jetbrains.rider" else { return }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let window else { return }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success,
              let text = title as? String, !text.isEmpty else { return }
        // Rider titles look like "ProjectName – File.cs" (en dash), sometimes with extra parts.
        let parts = text.components(separatedBy: " – ").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let project = parts.first, !project.isEmpty else { return }
        let file = parts.count > 1 ? parts.last : nil
        let workspace = Self.findProject(named: project)
        let fileExt = file.map { ($0 as NSString).pathExtension.lowercased() } ?? ""
        let language = ["cs": "csharp", "ts": "typescript", "tsx": "typescriptreact", "js": "javascript",
                        "sql": "sql", "json": "json", "xaml": "xml", "razor": "razor"][fileExt]
        let next = EditorContext(editor: "Rider", workspace: workspace,
                                 file: file.map { name in workspace.map { "\($0)/…/\(name)" } ?? name },
                                 language: language, selection: nil, diagnostics: nil, updated: Date())
        if context?.editor != "Rider" || context?.chipText != next.chipText || !(context?.isFresh ?? false) {
            context = next
        }
    }

    /// Rider only shows the project's name, so look for a folder with that name in the workspace folders.
    private static func findProject(named name: String) -> String? {
        let fm = FileManager.default
        for root in Prefs.workspaceFolders.map(Prefs.expand) {
            let direct = (root as NSString).appendingPathComponent(name)
            if fm.fileExists(atPath: direct) { return direct }
            for sub in (try? fm.contentsOfDirectory(atPath: root)) ?? [] where !sub.hasPrefix(".") {
                let candidate = ((root as NSString).appendingPathComponent(sub) as NSString).appendingPathComponent(name)
                if fm.fileExists(atPath: candidate) { return candidate }
            }
        }
        return nil
    }
}

/// App-wide actions that need SwiftUI's openWindow, set once the chat window has appeared.
@MainActor
enum AppActions {
    static var openChat: (() -> Void)?

    static func showChat() {
        openChat?()
        NSApp.activate(ignoringOtherApps: true)
    }
}
