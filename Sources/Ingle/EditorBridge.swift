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
    var projectInstructions: String? { workspace.flatMap(Project.instructions) }
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
                    if request.path.hasPrefix("/secret/") && request.headers["x-ingle-token"] == self.token {
                        // Secret requests wait for the user (Touch ID or a dialog), so they're answered later.
                        Task { @MainActor in
                            let (status, body) = await self.routeSecret(request)
                            self.respond(connection, status: status, body: body)
                        }
                    } else {
                        let (status, body) = self.route(request)
                        self.respond(connection, status: status, body: body)
                    }
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

    // MARK: Secrets for VS Code

    private struct SecretUseRequest: Decodable {
        let names: [String]
        let purpose: String?
        let detail: String?
        let editor: String?
    }
    private struct SecretScrubRequest: Decodable { let text: String }
    private struct SecretSaveRequest: Decodable {
        let name: String
        let description: String?
        let value: String
    }

    private static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    /// /secret/use hands values to the editor only after the user confirms here (Touch ID, or a dialog when that's
    /// off), so having the bridge token isn't enough. /secret/scrub scrubs text without any value leaving the app.
    private func routeSecret(_ request: HTTPRequest) async -> (Int, String) {
        let decoder = JSONDecoder()
        switch (request.method, request.path) {
        case ("POST", "/secret/use"):
            guard let r = try? decoder.decode(SecretUseRequest.self, from: request.body), !r.names.isEmpty else {
                return (400, #"{"error":"bad json"}"#)
            }
            let names: [String] = r.names.map { $0.lowercased() }
            let saved: Set<String> = Set(Secrets.names())
            if let missing = names.first(where: { !saved.contains($0) }) {
                return (404, Self.json(["error": "There's no secret called \(missing)."]))
            }
            let who: String = r.editor ?? "VS Code"
            let list: String = names.joined(separator: ", ")
            let what: String = (r.purpose ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let ok: Bool
            if Prefs.secretsTouchID {
                let reason: String = what.isEmpty ? "let \(who) use \(list)" : "let \(who) use \(list) to \(what.prefix(1).lowercased() + what.dropFirst())"
                ok = await Secrets.confirmPresence(reason)
            } else {
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "\(who) wants to use \(list)"
                alert.informativeText = ([what, String((r.detail ?? "").prefix(600))].filter { !$0.isEmpty }).joined(separator: "\n\n")
                alert.addButton(withTitle: "Allow")
                alert.addButton(withTitle: "Deny")
                ok = alert.runModal() == .alertFirstButtonReturn
            }
            guard ok else { return (403, #"{"error":"Not confirmed in the Ingle app, so nothing was run."}"#) }
            let values: [String: String] = await Secrets.values(names)
            guard values.count == names.count else { return (500, #"{"error":"Couldn't read it from the Keychain."}"#) }
            return (200, Self.json(["values": values]))
        case ("POST", "/secret/scrub"):
            guard let r = try? decoder.decode(SecretScrubRequest.self, from: request.body) else { return (400, #"{"error":"bad json"}"#) }
            let scrubber: Secrets.Scrubber = await Secrets.scrubber()
            return (200, Self.json(["text": scrubber.scrub(r.text)]))
        case ("POST", "/secret/save"):
            guard let r = try? decoder.decode(SecretSaveRequest.self, from: request.body) else { return (400, #"{"error":"bad json"}"#) }
            if let problem = Secrets.add(name: r.name, description: r.description ?? "", value: r.value) {
                return (409, Self.json(["error": problem]))
            }
            return (200, #"{"ok":true}"#)
        default:
            return (404, #"{"error":"not found"}"#)
        }
    }

    private func respond(_ connection: NWConnection, status: Int, body: String) {
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Server Error"][status] ?? "OK"
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
