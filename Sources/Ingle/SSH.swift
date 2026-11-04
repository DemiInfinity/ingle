import Foundation

/// SSH access: run commands on the user's own servers with the system ssh client.
/// A host is usable only if it is a plain `Host` alias in ~/.ssh/config **and** ticked in
/// Settings → Mac Access → SSH. Keys or ssh-agent only (BatchMode), so Ingle never handles passwords.
/// Keep in step with Extensions/vscode/src/tools/ssh.ts.
enum SSH {
    static let refusal = "That host isn't set up for Ingle. Add it in Settings → Mac Access → SSH."

    static let definition: [String: Any] = MacTools.tool(
        "ssh_command", "Run a shell command on one of the user's SSH hosts and return its output. The user must approve.",
        ["host": MacTools.prop("One of the SSH host names listed in your instructions"),
         "command": MacTools.prop("The command to run on that host"),
         "cwd": MacTools.prop("Optional working folder on that host")],
        required: ["host", "command"])

    // MARK: Settings

    static var isOn: Bool { Prefs.sshEnabled }

    /// Ticked hosts that are still in ~/.ssh/config. Empty when SSH is off.
    static var enabledHosts: [String] { enabledHosts(configFile: nil) }

    static func enabledHosts(configFile: String?) -> [String] {
        guard Prefs.sshEnabled else { return [] }
        let ticked: Set<String> = Set(Prefs.sshHosts.map { $0.lowercased() })
        return configHosts(file: configFile).filter { ticked.contains($0.lowercased()) }
    }

    /// The config alias for `host` if Ingle may use it, or nil. Raw `user@host` and `host:port` are never accepted.
    static func allowedHost(_ host: String) -> String? {
        let h: String = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !h.isEmpty, isPlainAlias(h) else { return nil }
        return enabledHosts.first { $0.lowercased() == h.lowercased() }
    }

    /// For tool selection: does the message mention SSH, a server, or one of the enabled hosts?
    static func mentioned(in lowercasedText: String) -> Bool {
        let hosts: [String] = enabledHosts
        guard !hosts.isEmpty else { return false }
        if ["ssh", "server", "remote"].contains(where: { lowercasedText.contains($0) }) { return true }
        return hosts.contains { mentionsWord(lowercasedText, $0.lowercased()) }
    }

    private static func mentionsWord(_ text: String, _ word: String) -> Bool {
        let escaped: String = NSRegularExpression.escapedPattern(for: word)
        let pattern: String = "(?<![a-z0-9_-])" + escaped + "(?![a-z0-9_-])"
        return text.range(of: pattern, options: .regularExpression) != nil
    }

    /// The fact every model gets (same meaning as `sshFact` in Extensions/vscode/src/engine/prompt.ts).
    static var promptFact: String {
        let hosts: [String] = enabledHosts
        let list: String = hosts.isEmpty
            ? "Hosts: none (SSH is off or no host is ticked; the user can set it up in Settings → Mac Access → SSH)."
            : "Hosts: " + hosts.joined(separator: ", ") + "."
        return "If SSH is on, you can run commands on the user's own servers with ssh_command, using only the host names listed. Each call needs approval. Never try to reach other hosts. " + list
    }

    // MARK: ~/.ssh/config

    static var configURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh/config")
    }

    /// Plain (non-wildcard, non-negated) `Host` aliases from ~/.ssh/config and the files it `Include`s, in order.
    static func configHosts(file: String? = nil) -> [String] {
        var seen: Set<String> = []
        var out: [String] = []
        var visited: Set<String> = []
        collectHosts(from: file ?? configURL.path, depth: 0, visited: &visited) { alias in
            if seen.insert(alias.lowercased()).inserted { out.append(alias) }
        }
        return out
    }

    private static func collectHosts(from path: String, depth: Int, visited: inout Set<String>, add: (String) -> Void) {
        guard depth < 8, visited.insert(path).inserted,
              let text = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        for raw in text.components(separatedBy: .newlines) {
            let line: String = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            let words: [String] = splitLine(line)
            guard let keyword = words.first?.lowercased() else { continue }
            let args: [String] = Array(words.dropFirst())
            if keyword == "host" {
                for pattern in args where isPlainAlias(pattern) { add(pattern) }
            } else if keyword == "include" {
                for pattern in args {
                    for file in expandInclude(pattern) {
                        collectHosts(from: file, depth: depth + 1, visited: &visited, add: add)
                    }
                }
            }
        }
    }

    /// Splits `Keyword arg arg` or `Keyword=arg`, honouring double quotes.
    static func splitLine(_ line: String) -> [String] {
        var words: [String] = []
        var current: String = ""
        var quoted: Bool = false
        var sawEquals: Bool = false
        for ch in line {
            if ch == "\"" { quoted.toggle(); continue }
            let isSeparator: Bool = !quoted && (ch == " " || ch == "\t" || (ch == "=" && words.isEmpty && !sawEquals))
            if isSeparator {
                if ch == "=" { sawEquals = true }
                if !current.isEmpty { words.append(current); current = "" }
            } else {
                current.append(ch)
            }
        }
        if !current.isEmpty { words.append(current) }
        return words
    }

    /// A name ssh can only read as a host alias: no wildcards, negation, user@, ports or option-like dashes.
    static func isPlainAlias(_ s: String) -> Bool {
        guard !s.isEmpty, !s.hasPrefix("-"), !s.hasPrefix("."), s.count <= 253 else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        return s.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    /// Include paths are relative to ~/.ssh and may use ~ and globs.
    private static func expandInclude(_ pattern: String) -> [String] {
        var p: String = (pattern as NSString).expandingTildeInPath
        if !p.hasPrefix("/") {
            p = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh").appendingPathComponent(p).path
        }
        var g = glob_t()
        defer { globfree(&g) }
        guard glob(p, 0, nil, &g) == 0 else { return [] }
        var files: [String] = []
        for i in 0..<Int(g.gl_pathc) {
            if let c = g.gl_pathv[i] { files.append(String(cString: c)) }
        }
        return files.sorted()
    }

    // MARK: Running

    /// Quotes text for a POSIX shell. A leading `~` or `~/` stays expandable as `"$HOME"`.
    static func quote(_ s: String) -> String {
        func single(_ t: String) -> String { "'" + t.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        if s == "~" { return "\"$HOME\"" }
        if s.hasPrefix("~/") { return "\"$HOME\"/" + single(String(s.dropFirst(2))) }
        return single(s)
    }

    /// The command line ssh sends: `cd <cwd> && <command>` when a folder is given.
    static func remoteCommand(_ command: String, cwd: String) -> String {
        let folder: String = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        return folder.isEmpty ? command : "cd " + quote(folder) + " && " + command
    }

    static func arguments(alias: String, remote: String) -> [String] {
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "-T", alias, "--", remote]
    }

    static func run(host: String, command: String, cwd: String) async -> String {
        guard isOn else { return "SSH is off. The user can turn it on in Settings → Mac Access → SSH." }
        guard let alias = allowedHost(host) else { return refusal }
        let cmd: String = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cmd.isEmpty else { return "ssh_command needs a command." }
        let result: CommandRunner.Result = await CommandRunner.run(
            "/usr/bin/ssh", arguments(alias: alias, remote: remoteCommand(cmd, cwd: cwd)), cwd: nil)
        return result.text + hint(for: result, alias: alias)
    }

    /// ssh exits with 255 when it couldn't connect; say what to do about the usual causes.
    private static func hint(for result: CommandRunner.Result, alias: String) -> String {
        guard result.exitCode == 255 else { return "" }
        let out: String = result.output.lowercased()
        if out.contains("host key verification failed") || out.contains("remote host identification has changed") {
            return "\n\nIngle only connects to hosts whose key is already trusted. Ask the user to run `ssh \(alias)` once in Terminal to check and save its host key."
        }
        if out.contains("permission denied") {
            return "\n\nIngle uses SSH keys or ssh-agent only and never passwords. Ask the user to set up key login for \(alias) (for example with ssh-copy-id)."
        }
        if out.contains("timed out") || out.contains("could not resolve") || out.contains("no route") || out.contains("refused") {
            return "\n\nCouldn't reach \(alias). It may be off or not on this network."
        }
        return ""
    }
}

/// Runs a process with the limits every command tool shares: 120-second timeout, ANSI codes removed,
/// output trimmed to its start and end, and stopped when the user presses Stop (task cancellation).
enum CommandRunner {
    static let timeout: TimeInterval = 120
    static let maxOutput: Int = 20_000

    struct Result: Sendable {
        let exitCode: Int32?
        let output: String
        let text: String
    }

    /// Keeps the start and (mostly) the end — errors are usually at the bottom. Same as `capOutput` in VS Code.
    static func capOutput(_ s: String, max: Int = maxOutput) -> String {
        guard s.count > max else { return s }
        let head: Int = max * 2 / 5
        let tail: Int = max - head
        return String(s.prefix(head)) + "\n…(trimmed)…\n" + String(s.suffix(tail))
    }

    static func stripANSI(_ s: String) -> String {
        let pattern: String = "\u{1B}\\[[0-9;?]*[ -/]*[@-~]|\u{1B}\\][^\u{07}]*(\u{07}|\u{1B}\\\\)|\u{1B}[()][A-Z0-9]"
        return s.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    }

    /// Thread-safe holder for the process and its output, so Stop can end it from another task.
    private final class Run: @unchecked Sendable {
        let lock = NSLock()
        let process = Process()
        var head = Data()
        var tail = Data()
        var dropped = false
        var stopped = false

        func append(_ d: Data) {
            lock.lock(); defer { lock.unlock() }
            let headRoom: Int = CommandRunner.maxOutput - head.count
            if headRoom > 0 {
                head.append(d.prefix(headRoom))
                if d.count > headRoom { tail.append(d.dropFirst(headRoom)) }
            } else {
                tail.append(d)
            }
            // Keep memory bounded: hold at most a couple of caps' worth of the end.
            if tail.count > CommandRunner.maxOutput * 4 {
                tail = Data(tail.suffix(CommandRunner.maxOutput * 2))
                dropped = true
            }
        }

        func stop() {
            lock.lock(); stopped = true; lock.unlock()
            if process.isRunning { process.terminate() }
        }

        var wasStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

        func collected() -> String {
            lock.lock(); defer { lock.unlock() }
            let h: String = String(decoding: head, as: UTF8.self)
            let t: String = String(decoding: tail, as: UTF8.self)
            return h + (dropped ? "\n…(trimmed)…\n" : "") + t
        }
    }

    static func run(_ executable: String, _ arguments: [String], cwd: String?) async -> Result {
        let run = Run()
        return await withTaskCancellationHandler {
            await Task.detached(priority: .userInitiated) { () -> Result in
                let process: Process = run.process
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                if let cwd, !cwd.isEmpty { process.currentDirectoryURL = URL(fileURLWithPath: Prefs.expand(cwd)) }
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe
                process.standardInput = FileHandle.nullDevice
                let handle: FileHandle = pipe.fileHandleForReading
                handle.readabilityHandler = { h in
                    let d: Data = h.availableData
                    if !d.isEmpty { run.append(d) }
                }
                do { try process.run() } catch {
                    handle.readabilityHandler = nil
                    let message: String = "Couldn't start the command: \(error.localizedDescription)"
                    return Result(exitCode: nil, output: "", text: message)
                }
                if run.wasStopped { process.terminate() }
                let deadline: Date = Date().addingTimeInterval(timeout)
                while process.isRunning && Date() < deadline && !run.wasStopped {
                    try? await Task.sleep(for: .milliseconds(100))
                }
                var timedOut: Bool = false
                if process.isRunning && !run.wasStopped { process.terminate(); timedOut = true }
                process.waitUntilExit()
                // Don't wait for end-of-file: a background child can keep the pipe open forever.
                try? await Task.sleep(for: .milliseconds(150))
                handle.readabilityHandler = nil
                let raw: String = run.collected()
                let output: String = capOutput(stripANSI(raw).replacingOccurrences(of: "\r\n", with: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines))
                let status: String
                if timedOut { status = "stopped after 2 minutes" }
                else if run.wasStopped { status = "stopped by the user" }
                else { status = "exit code \(process.terminationStatus)" }
                let code: Int32? = (timedOut || run.wasStopped) ? nil : process.terminationStatus
                return Result(exitCode: code, output: output, text: "\(status)\n\(output.isEmpty ? "(no output)" : output)")
            }.value
        } onCancel: {
            run.stop()
        }
    }
}
