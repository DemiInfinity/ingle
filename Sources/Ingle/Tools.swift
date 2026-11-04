import Foundation
import AppKit

/// Tools for the user's Mac. Terminal tools (files and commands) are always available; Mac control
/// (apps, AppleScript, screenshots) needs the Mac button on in the chat. Anything that changes the Mac
/// or looks at the screen needs approval.
enum MacTools {
    static func prop(_ description: String) -> [String: Any] {
        ["type": "string", "description": description]
    }

    static func tool(_ name: String, _ description: String, _ props: [String: [String: Any]], required: [String]) -> [String: Any] {
        ["type": "function",
         "function": ["name": name, "description": description,
                      "parameters": ["type": "object", "properties": props, "required": required]]]
    }

    static let definitions: [[String: Any]] = [
        tool("list_files", "List the files and folders inside a folder on the user's Mac.",
             ["path": prop("Folder path, e.g. ~/Projects")], required: ["path"]),
        tool("read_file", "Read a file on the user's Mac: text and code, documents (PDF, Word, RTF, Excel, Pages) as text, and images (PNG, JPEG, HEIC…) so you can look at them.",
             ["path": prop("File path")], required: ["path"]),
        tool("write_file", "Create or overwrite a text file on the user's Mac. The user must approve.",
             ["path": prop("File path"), "content": prop("The full new file contents")], required: ["path", "content"]),
        tool("run_command", "Run a zsh command in Terminal on the user's Mac and return its output. The user must approve. Use for git, builds, tests, scripts and searching.",
             ["command": prop("The command to run"), "cwd": prop("Optional working folder")], required: ["command"]),
    ]

    /// Controlling the Mac itself — only when the Mac button is on in the chat.
    static let controlDefinitions: [[String: Any]] = [
        tool("open", "Open an app, file, folder or URL on the user's Mac. The user must approve.",
             ["target": prop("App name (e.g. Safari), path, or URL")], required: ["target"]),
        tool("applescript", "Control apps on the user's Mac with AppleScript: tell an app to do something (play music, make a note, open a document, set a window), or use System Events to click buttons, choose menus and type. The user must approve each script.",
             ["script": prop("The AppleScript to run")], required: ["script"]),
        tool("screenshot", "Take a screenshot of the user's screen to see what's on it (asks the user first). Use it to check the result of what you did.",
             [:], required: []),
    ]

    static let helpTool: [String: Any] = tool(
        "ingle_help", "Explain part of Ingle, the app you're running in. Use for any question about Ingle's features or settings.",
        ["topic": prop("One of: " + HelpTopics.names.joined(separator: ", "))], required: ["topic"])

    static let mcpTools: [[String: Any]] = [
        tool("mcp_tools", "List what an MCP server can do: its tools, what they do and their inputs.",
             ["server": prop("The MCP server's name from INGLE.md")], required: ["server"]),
        ["type": "function",
         "function": ["name": "mcp_call",
                      "description": "Use one tool from an MCP server. Check its inputs with mcp_tools first. The user must approve.",
                      "parameters": ["type": "object",
                                     "properties": ["server": prop("The MCP server's name"),
                                                    "tool": prop("The tool's name"),
                                                    "arguments": ["type": "object", "description": "The tool's inputs, as an object"]],
                                     "required": ["server", "tool"]]]],
    ]

    /// The inputs for an mcp_call, as JSON for the server.
    static func mcpArguments(_ call: ToolCall) -> Data? {
        guard let raw = call.raw, let dict = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else { return nil }
        if let a = dict["arguments"] as? [String: Any] { return try? JSONSerialization.data(withJSONObject: a) }
        if let s = dict["arguments"] as? String, let d = s.data(using: .utf8),
           (try? JSONSerialization.jsonObject(with: d)) is [String: Any] { return d }
        return nil
    }

    static var systemPrompt: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let folders = Prefs.workspaceFolders.joined(separator: ", ")
        return """
        You can use the user's Mac: you are running locally on the user's Mac (macOS, zsh, home folder \(home)).
        You have tools to look at and act on this Mac. Their workspace folders are: \(folders).
        Rules:
        - Look before you act: list or read files before changing them.
        - Use one tool at a time and explain briefly what you are about to do.
        - Never delete files, run sudo, or change system settings unless the user clearly asked.
        - The user approves every command and write ("Allow for This Session" covers only the same command in the same folder, writes in the same folder, or the same app action). If they deny one, don't retry it; ask what they want instead.
        - Terminal is for files, code, git, builds and scripts. Don't use osascript or `open` from Terminal to control apps — that's Mac control, which has its own switch.
        - When done, summarise what you changed in plain words.
        """
    }

    static let controlPrompt = """
    Mac control is ON in this chat: you can open apps, files and links (open), drive apps with AppleScript (applescript — including System Events to click, choose menus and type), and look at the screen (screenshot). Each action asks the user first.
    - Prefer an app's own AppleScript commands over clicking through its interface.
    - After doing something visible, take a screenshot to check it worked, then say what you did.
    - Never enter passwords, buy anything, send messages or delete things unless the user clearly asked for exactly that.
    """

    struct Info {
        let title: String
        let detail: String
        let icon: String
    }

    @MainActor
    static func describe(_ call: ToolCall) -> Info {
        if call.name.hasPrefix("mcp_") {
            let t = MCPManager.shared.tool(named: call.name)
            let args = call.raw.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            return Info(title: "Use \(t?.name ?? call.name) (\(t?.server ?? "MCP"))", detail: args, icon: "puzzlepiece.extension")
        }
        switch call.name {
        case "use_skill": return Info(title: "Use a skill", detail: call.arg("name"), icon: "book")
        case "use_rule": return Info(title: "Check a rule", detail: call.arg("name"), icon: "list.bullet.rectangle")
        case "web_search": return Info(title: "Search the web", detail: call.arg("query"), icon: "magnifyingglass")
        case "chat_list": return Info(title: "Look through past chats", detail: "", icon: "bubble.left.and.bubble.right")
        case "chat_search": return Info(title: "Search past chats", detail: call.arg("query"), icon: "bubble.left.and.bubble.right")
        case "chat_read": return Info(title: "Read a past chat", detail: call.arg("chat"), icon: "bubble.left.and.bubble.right")
        case "report_save": return Info(title: "Save a research report", detail: call.arg("title"), icon: "doc.richtext")
        case "report_search": return Info(title: "Search research reports", detail: call.arg("query"), icon: "doc.richtext")
        case "report_read": return Info(title: "Read a research report", detail: call.arg("name"), icon: "doc.richtext")
        case "delegate": return Info(title: "Hand a task to a helper", detail: call.arg("task"), icon: "person.2")
        case "skill_create":
            return Info(title: "Create a skill", detail: "\(call.arg("name")) — \(call.arg("description"))\n\n\(call.arg("instructions").prefix(1500))", icon: "book")
        case "command_create":
            return Info(title: "Create a command (Ingle will enforce it)", detail: CommandStore.fileText(call), icon: "exclamationmark.shield")
        case "rule_create":
            let always = call.arg("always").lowercased() == "true" || call.arg("always") == "1"
            return Info(title: "Create a rule", detail: "\(call.arg("name")) (\(always ? "always" : "when relevant")) — \(call.arg("description"))\n\n\(call.arg("text").prefix(1500))", icon: "list.bullet.rectangle")
        case "web_fetch": return Info(title: "Read a web page", detail: call.arg("url"), icon: "globe")
        case "memory_search": return Info(title: "Search memory", detail: call.arg("query"), icon: "brain.head.profile")
        case "memory_read": return Info(title: "Read memory", detail: call.arg("file"), icon: "brain.head.profile")
        case "memory_save": return Info(title: "Save to memory", detail: "\(call.arg("file")): \(call.arg("fact"))", icon: "brain.head.profile")
        case "memory_rewrite": return Info(title: "Rewrite memory", detail: call.arg("file"), icon: "brain.head.profile")
        case "memory_forget": return Info(title: "Forget from memory", detail: "\(call.arg("file")): \(call.arg("text"))", icon: "brain.head.profile")
        case "ingle_help": return Info(title: "Check Ingle's help", detail: call.arg("topic"), icon: "questionmark.circle")
        case "mcp_tools": return Info(title: "Look inside an MCP server", detail: call.arg("server"), icon: "puzzlepiece.extension")
        case "mcp_call":
            let args = mcpArguments(call).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            return Info(title: "Use \(call.arg("tool")) (\(call.arg("server")))", detail: args, icon: "puzzlepiece.extension")
        case "list_files": return Info(title: "List a folder", detail: call.arg("path"), icon: "folder")
        case "read_file": return Info(title: "Read a file", detail: call.arg("path"), icon: "doc.text")
        case "write_file": return Info(title: "Write a file", detail: call.arg("path"), icon: "square.and.pencil")
        case "run_command":
            let cwd = call.arg("cwd")
            return Info(title: "Run a command", detail: cwd.isEmpty ? call.arg("command") : "cd \(cwd) && \(call.arg("command"))", icon: "terminal")
        case "open": return Info(title: "Open", detail: call.arg("target"), icon: "arrow.up.forward.app")
        case "applescript": return Info(title: "Control the Mac (AppleScript)", detail: call.arg("script"), icon: "applescript")
        case "screenshot": return Info(title: "Look at the screen", detail: "Takes a screenshot", icon: "camera.viewfinder")
        default: return Info(title: call.name, detail: call.arguments.map { "\($0.key): \($0.value)" }.joined(separator: ", "), icon: "wrench")
        }
    }

    /// What "Allow for This Session" covers for one call: `key` is what is remembered, `label` is shown on the card.
    struct ApprovalScope: Equatable {
        let key: String
        let label: String
    }

    /// The approval scope for a call. Commands are allowed by exact text and folder, writes and outside reads
    /// by folder (that folder only, not its subfolders), app actions by exact target or script, MCP by server/tool.
    /// Any tool not listed only covers the exact same call again, so a new tool must add a case to get a wider scope.
    /// Keep in step with `approvalScope` in Extensions/vscode/src/engine/chatEngine.ts.
    @MainActor
    static func approvalScope(_ call: ToolCall) -> ApprovalScope {
        switch call.name {
        case "run_command":
            let command: String = call.arg("command").trimmingCharacters(in: .whitespacesAndNewlines)
            let cwd: String = call.arg("cwd").trimmingCharacters(in: .whitespaces)
            let folder: String = cwd.isEmpty ? "" : standardPath(cwd)
            let place: String = folder.isEmpty ? "" : " in " + (folder as NSString).lastPathComponent
            return ApprovalScope(key: "run_command\n\(folder)\n\(command)", label: "“\(clip(command))”\(place)")
        case "write_file":
            let folder: String = (standardPath(call.arg("path")) as NSString).deletingLastPathComponent
            return ApprovalScope(key: "write\n\(folder)", label: "writing files in \(tidyPath(folder))")
        case "list_files", "read_file":
            let path: String = standardPath(call.arg("path"))
            let folder: String = call.name == "list_files" ? path : (path as NSString).deletingLastPathComponent
            return ApprovalScope(key: "read\n\(folder)", label: "reading in \(tidyPath(folder))")
        case "open":
            let target: String = call.arg("target").trimmingCharacters(in: .whitespaces)
            return ApprovalScope(key: "open\n\(target)", label: "opening “\(clip(target))”")
        case "applescript":
            return ApprovalScope(key: "applescript\n\(call.arg("script"))", label: "this exact script")
        case "screenshot":
            return ApprovalScope(key: "screenshot", label: "taking screenshots")
        case "mcp_call":
            let server: String = call.arg("server").trimmingCharacters(in: .whitespaces)
            let tool: String = call.arg("tool").trimmingCharacters(in: .whitespaces)
            return ApprovalScope(key: "mcp\n\(server.lowercased())/\(tool)", label: "the MCP tool \(server)/\(tool)")
        default:
            if let t = MCPManager.shared.tool(named: call.name) {
                return ApprovalScope(key: "mcp\n\(t.server.lowercased())/\(t.name)", label: "the MCP tool \(t.server)/\(t.name)")
            }
            let pairs: [String] = call.arguments.sorted { $0.key < $1.key }.map { $0.key + "=" + $0.value }
            let raw: String = call.raw.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let key: String = "exact\n\(call.name)\n" + pairs.joined(separator: "\n") + "\n" + raw
            return ApprovalScope(key: key, label: "this exact \(call.name) action")
        }
    }

    private static func standardPath(_ path: String) -> String {
        URL(fileURLWithPath: Prefs.expand(path.trimmingCharacters(in: .whitespaces))).standardizedFileURL.path
    }

    private static func tidyPath(_ path: String) -> String {
        let home: String = FileManager.default.homeDirectoryForCurrentUser.path
        if path == home { return "~" }
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    private static func clip(_ text: String) -> String {
        let flat: String = text.replacingOccurrences(of: "\n", with: " ")
        return flat.count > 80 ? String(flat.prefix(79)) + "…" : flat
    }

    static func needsApproval(_ call: ToolCall) -> Bool {
        switch call.name {
        case "list_files", "read_file":
            return !(Prefs.autoReadWorkspace && Prefs.inWorkspace(call.arg("path")))
        case "use_skill", "use_rule", "ingle_help", "mcp_tools", "web_search", "web_fetch", "memory_search", "memory_read",
             "chat_list", "chat_search", "chat_read", "report_save", "report_search", "report_read", "delegate":
            return false
        case "memory_save", "memory_rewrite", "memory_forget":
            return Prefs.memoryAskFirst
        default:
            return true
        }
    }

    @MainActor
    static func run(_ call: ToolCall) async -> String {
        if call.name.hasPrefix("mcp_") { return await MCPManager.shared.call(call) }
        switch call.name {
        case "use_skill": return SkillStore.read(call.arg("name"))
        case "use_rule": return RuleStore.read(call.arg("name"), project: EditorBridge.shared.freshContext?.workspace)
        case "web_search": return await WebTools.search(call.arg("query"))
        case "report_save":
            return ReportStore.save(title: call.arg("title"), summary: call.arg("summary"), report: call.arg("report"), sources: call.arg("sources"))
        case "report_search": return ReportStore.search(call.arg("query"))
        case "report_read": return ReportStore.read(call.arg("name"))
        case "skill_create":
            return Builder.createSkill(name: call.arg("name"), description: call.arg("description"),
                                       instructions: call.arg("instructions"), replace: call.arg("replace").lowercased() == "true")
        case "command_create": return CommandStore.create(call)
        case "rule_create":
            let always = call.arg("always").lowercased() == "true" || call.arg("always") == "1"
            return Builder.createRule(name: call.arg("name"), description: call.arg("description"), always: always,
                                      text: call.arg("text"), replace: call.arg("replace").lowercased() == "true")
        case "web_fetch": return await WebTools.fetch(call.arg("url"))
        case "memory_search": return MemoryStore.search(call.arg("query"))
        case "memory_read": return MemoryStore.read(call.arg("file"))
        case "memory_save": return MemoryStore.save(file: call.arg("file"), fact: call.arg("fact"), description: call.arguments["description"])
        case "memory_rewrite": return MemoryStore.rewrite(file: call.arg("file"), content: call.arg("content"), description: call.arguments["description"])
        case "memory_forget": return MemoryStore.forget(file: call.arg("file"), text: call.arg("text"))
        case "ingle_help": return HelpTopics.text(call.arg("topic"))
        case "mcp_tools": return await MCPManager.shared.describeTools(server: call.arg("server"))
        case "mcp_call":
            return await MCPManager.shared.call(server: call.arg("server"), tool: call.arg("tool"), arguments: mcpArguments(call))
        case "list_files": return listFiles(call.arg("path"))
        case "read_file": return readFile(call.arg("path"))
        case "write_file": return writeFile(call.arg("path"), call.arg("content"))
        case "run_command": return await shell(call.arg("command"), cwd: call.arg("cwd"))
        case "open": return await shell("open \(quoteForOpen(call.arg("target")))", cwd: "")
        case "applescript": return await appleScript(call.arg("script"))
        default: return "Unknown tool \(call.name)."
        }
    }

    // MARK: Implementations

    private static func listFiles(_ path: String) -> String {
        let p = Prefs.expand(path)
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: p) else {
            return "Couldn't open folder \(p)."
        }
        let lines = items.filter { !$0.hasPrefix(".") }.sorted().prefix(500).map { name -> String in
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: (p as NSString).appendingPathComponent(name), isDirectory: &isDir)
            return isDir.boolValue ? name + "/" : name
        }
        return lines.isEmpty ? "(empty folder)" : lines.joined(separator: "\n")
    }

    private static func readFile(_ path: String) -> String {
        let p = Prefs.expand(path)
        let url = URL(fileURLWithPath: p)
        if DocumentReader.isImage(url) { return "\(url.lastPathComponent) is an image; images can only be opened in the main chat." }
        if let text = try? String(contentsOfFile: p, encoding: .utf8) {
            return text.count > 100_000 ? String(text.prefix(100_000)) + "\n…(truncated)" : text
        }
        // PDF, Word, RTF, spreadsheets and other documents.
        return DocumentReader.text(at: url) ?? "Couldn't read \(p) as text or as a document."
    }

    private static func writeFile(_ path: String, _ content: String) -> String {
        let url = URL(fileURLWithPath: Prefs.expand(path))
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try content.write(to: url, atomically: true, encoding: .utf8)
            return "Wrote \(content.utf8.count) bytes to \(url.path)."
        } catch {
            return "Couldn't write \(url.path): \(error.localizedDescription)"
        }
    }

    private static func quoteForOpen(_ target: String) -> String {
        let t = target.trimmingCharacters(in: .whitespaces)
        let escaped = "'" + t.replacingOccurrences(of: "'", with: "'\\''") + "'"
        if t.contains("://") || t.hasPrefix("/") || t.hasPrefix("~") { return t.hasPrefix("~") ? "\"$HOME\(t.dropFirst())\"" : escaped }
        return "-a " + escaped
    }

    /// Runs AppleScript from a temporary file, so quotes in the script don't need escaping.
    private static func appleScript(_ script: String) async -> String {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("ingle-\(UUID().uuidString).applescript")
        do { try script.write(to: file, atomically: true, encoding: .utf8) } catch { return "Couldn't prepare the script." }
        defer { try? FileManager.default.removeItem(at: file) }
        return await shell("/usr/bin/osascript '\(file.path)'", cwd: "")
    }

    private static func shell(_ command: String, cwd: String) async -> String {
        await Task.detached(priority: .userInitiated) { () -> String in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lc", command]
            if !cwd.isEmpty { process.currentDirectoryURL = URL(fileURLWithPath: Prefs.expand(cwd)) }
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do { try process.run() } catch { return "Couldn't start the command: \(error.localizedDescription)" }
            let handle = pipe.fileHandleForReading
            let reader = Task.detached { handle.readDataToEndOfFile() }
            let deadline = Date().addingTimeInterval(120)
            while process.isRunning && Date() < deadline {
                try? await Task.sleep(for: .milliseconds(100))
            }
            var timedOut = false
            if process.isRunning { process.terminate(); timedOut = true }
            process.waitUntilExit()
            var output = String(decoding: await reader.value, as: UTF8.self)
            if output.count > 20_000 { output = String(output.prefix(20_000)) + "\n…(output truncated)" }
            let status = timedOut ? "stopped after 2 minutes" : "exit code \(process.terminationStatus)"
            return "\(status)\n\(output.isEmpty ? "(no output)" : output)"
        }.value
    }
}
