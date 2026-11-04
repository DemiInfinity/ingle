import Foundation
import Security
import LocalAuthentication

/// One saved secret as listed in ~/.ingle/secrets.json — the name and description only, never the value.
struct SecretEntry: Codable, Hashable, Identifiable {
    var id: String { name }
    var name: String
    var description: String
    var created: String?
}

/// Something in a message that looks like a password or key (the composer asks before sending it).
struct DetectedSecret: Identifiable, Equatable {
    let id = UUID()
    let value: String
    let kind: String
    var suggested: String
}

/// The secrets store: values live only in the macOS Keychain (service "Ingle", one item per secret); the model sees
/// names and `{{secret:name}}` placeholders. A value goes into a tool call only after the user approves that call (and
/// Touch ID, if on), and tool output is scrubbed back to placeholders before the model or the chat history sees it.
/// Keep detection, substitution and scrubbing in step with Extensions/vscode/src/tools/secretsCore.ts.
enum Secrets {
    static let service = "Ingle"
    static var indexURL: URL { IngleHome.url.appendingPathComponent("secrets.json") }

    // MARK: The names file

    private struct IndexFile: Codable { var secrets: [SecretEntry] }

    static func all() -> [SecretEntry] {
        guard let data = try? Data(contentsOf: indexURL),
              let file = try? JSONDecoder().decode(IndexFile.self, from: data) else { return [] }
        return file.secrets.filter { isValidName($0.name) }
    }

    static func names() -> [String] { all().map(\.name) }

    private static func writeIndex(_ list: [SecretEntry]) {
        IngleHome.ensure()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(IndexFile(secrets: list)) else { return }
        try? data.write(to: indexURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: indexURL.path)
    }

    // MARK: Keychain

    private static func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: name]
    }

    /// Reads one value. May show macOS's Keychain prompt (e.g. after a rebuild), so call it off the main thread.
    static func readValue(_ name: String) -> String? {
        var q: [String: Any] = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status: OSStatus = SecItemCopyMatching(q as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Values for these names, read on a background thread. Missing ones are left out.
    static func values(_ names: [String]) async -> [String: String] {
        await Task.detached(priority: .userInitiated) { () -> [String: String] in
            var out: [String: String] = [:]
            for n in names { if let v = readValue(n) { out[n] = v } }
            return out
        }.value
    }

    /// Adds a new secret. Returns an error sentence, or nil when saved. Never overwrites one that exists.
    static func add(name rawName: String, description: String, value: String) -> String? {
        let name: String = rawName.trimmingCharacters(in: .whitespaces).lowercased()
        guard isValidName(name) else { return "“\(rawName)” can’t be a secret name: use lower-case letters, digits, dots and dashes." }
        guard !value.isEmpty else { return "There’s no value to save." }
        var list: [SecretEntry] = all()
        if list.contains(where: { $0.name == name }) { return "There’s already a secret called \(name). Pick another name." }
        var q: [String: Any] = query(name)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrLabel as String] = "Ingle: \(name)"
        q[kSecAttrComment as String] = description
        var status: OSStatus = SecItemAdd(q as CFDictionary, nil)
        if status == errSecDuplicateItem {
            // Left over from before (not in secrets.json): replace it.
            SecItemDelete(query(name) as CFDictionary)
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { return "Couldn’t save to the Keychain (error \(status))." }
        let stamp: String = ISO8601DateFormatter().string(from: Date())
        list.append(SecretEntry(name: name, description: description, created: stamp))
        writeIndex(list)
        return nil
    }

    static func delete(_ name: String) {
        SecItemDelete(query(name) as CFDictionary)
        writeIndex(all().filter { $0.name != name })
    }

    static func setDescription(_ name: String, _ description: String) {
        let attrs: [String: Any] = [kSecAttrComment as String: description]
        SecItemUpdate(query(name) as CFDictionary, attrs as CFDictionary)
        writeIndex(all().map { $0.name == name ? SecretEntry(name: name, description: description, created: $0.created) : $0 })
    }

    /// Renames a secret. Returns an error sentence, or nil when done.
    static func rename(_ old: String, to rawNew: String) -> String? {
        let new: String = rawNew.trimmingCharacters(in: .whitespaces).lowercased()
        guard new != old else { return nil }
        guard isValidName(new) else { return "Use lower-case letters, digits, dots and dashes." }
        if all().contains(where: { $0.name == new }) { return "There’s already a secret called \(new)." }
        let attrs: [String: Any] = [kSecAttrAccount as String: new, kSecAttrLabel as String: "Ingle: \(new)"]
        let status: OSStatus = SecItemUpdate(query(old) as CFDictionary, attrs as CFDictionary)
        guard status == errSecSuccess else { return "Couldn’t rename it in the Keychain (error \(status))." }
        writeIndex(all().map { $0.name == old ? SecretEntry(name: new, description: $0.description, created: $0.created) : $0 })
        return nil
    }

    // MARK: Touch ID

    /// Touch ID (or the Mac's password). False if cancelled or not possible.
    static func confirmPresence(_ reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }

    // MARK: Names and placeholders

    static let placeholderPattern: String = #"\{\{\s*[Ss][Ee][Cc][Rr][Ee][Tt]\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*\}\}"#
    private static let placeholderRegex: NSRegularExpression = try! NSRegularExpression(pattern: placeholderPattern)

    static func placeholder(_ name: String) -> String { "{{secret:\(name)}}" }

    static func isValidName(_ name: String) -> Bool {
        name.range(of: #"^[a-z0-9][a-z0-9._-]{0,63}$"#, options: .regularExpression) != nil
    }

    /// "My GitHub Token" → "my-github-token".
    static func slugName(_ text: String) -> String {
        var s: String = text.lowercased().replacingOccurrences(of: "[^a-z0-9._-]+", with: "-", options: .regularExpression)
        s = s.replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^[-._]+|[-._]+$"#, with: "", options: .regularExpression)
        return s.isEmpty ? "secret" : String(s.prefix(64))
    }

    static func uniqueName(_ base: String, taken: [String]) -> String {
        let used: Set<String> = Set(taken.map { $0.lowercased() })
        let root: String = slugName(base)
        if !used.contains(root) { return root }
        var n: Int = 2
        while used.contains("\(root)-\(n)") { n += 1 }
        return "\(root)-\(n)"
    }

    /// github-token → INGLE_SECRET_GITHUB_TOKEN
    static func envName(_ name: String) -> String {
        "INGLE_SECRET_" + name.uppercased().replacingOccurrences(of: "[^A-Z0-9]", with: "_", options: .regularExpression)
    }

    static func names(inText text: String) -> [String] {
        let ns = text as NSString
        var out: [String] = []
        for m in placeholderRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let n: String = ns.substring(with: m.range(at: 1)).lowercased()
            if !out.contains(n) { out.append(n) }
        }
        return out
    }

    /// Secret names a tool call uses (in any argument, including nested MCP arguments).
    static func names(in call: ToolCall) -> [String] {
        var out: [String] = []
        for key in call.arguments.keys.sorted() {
            for n in names(inText: call.arguments[key] ?? "") where !out.contains(n) { out.append(n) }
        }
        if let raw = call.raw, let text = String(data: raw, encoding: .utf8) {
            for n in names(inText: text) where !out.contains(n) { out.append(n) }
        }
        return out
    }

    // MARK: Detection (the composer's "Save as secret?" check)

    private struct Pattern { let regex: NSRegularExpression; let kind: String; let name: String }

    private static func re(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    private static let known: [Pattern] = [
        Pattern(regex: re(#"-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----"#), kind: "private key", name: "private-key"),
        Pattern(regex: re(#"\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})"#), kind: "GitHub token", name: "github-token"),
        Pattern(regex: re(#"\bsk-ant-[A-Za-z0-9_-]{20,}"#), kind: "Anthropic key", name: "anthropic-key"),
        Pattern(regex: re(#"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}"#), kind: "API key", name: "openai-key"),
        Pattern(regex: re(#"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"#), kind: "Stripe key", name: "stripe-key"),
        Pattern(regex: re(#"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"#), kind: "AWS access key", name: "aws-access-key"),
        Pattern(regex: re(#"\bxox[abposr]-[A-Za-z0-9-]{10,}"#), kind: "Slack token", name: "slack-token"),
        Pattern(regex: re(#"\bAIza[0-9A-Za-z_-]{35}"#), kind: "Google API key", name: "google-api-key"),
    ]

    private static let phrase: NSRegularExpression = re(
        #"\b(my\s+(?:[a-z]+\s+)?)?(password|passcode|passphrase|passwd|pin|api[ _-]?key|secret[ _-]?key|secret|token|access[ _-]?key|private[ _-]?key)\b\s*(?:is|was|=|:)\s*:?\s*["'`]?([^\s"'`]+)"#,
        [.caseInsensitive])
    private static let cardRegex: NSRegularExpression = re(#"(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])"#)
    private static let tokenRegex: NSRegularExpression = re(#"[^\s"'`,;()\[\]{}<>=:]+"#)

    private static let notValues: Set<String> = [
        "wrong", "expired", "invalid", "missing", "incorrect", "not", "empty", "set", "unset", "the", "a", "an", "too", "still", "also",
        "being", "correct", "right", "working", "broken", "fine", "ok", "okay", "different", "same", "here", "there", "below",
        "above", "in", "on", "saved", "stored", "changed", "reset", "gone", "lost", "required", "needed", "weak", "strong",
        "short", "long", "secret", "private", "public", "null", "none", "undefined", "true", "false", "string", "number",
        "blank", "new", "old", "now", "already", "definitely", "probably", "just", "very", "really", "something",
    ]

    private static func has(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    private static func phraseValueLooksReal(_ value: String, strong: Bool) -> Bool {
        if value.count < 4 || value.hasPrefix("{{") { return false }
        if notValues.contains(value.lowercased()) { return false }
        if strong { return true }
        if has(value, #"[()\[\]{}<>]"#) || value.hasPrefix("$") || has(value, #"^[A-Za-z_$][\w$]*(\.[\w$]+)+$"#) { return false }
        if has(value, #"[0-9!#$%&*+?^~@]"#) { return true }
        return value.count >= 16 && !has(value, #"^[A-Za-z_.-]+$"#)
    }

    static func luhn(_ digits: String) -> Bool {
        var sum: Int = 0
        var double: Bool = false
        for c in digits.reversed() {
            guard var d = c.wholeNumberValue else { return false }
            if double { d *= 2; if d > 9 { d -= 9 } }
            sum += d
            double.toggle()
        }
        return sum % 10 == 0
    }

    static func entropy(_ s: String) -> Double {
        var counts: [Character: Int] = [:]
        for c in s { counts[c, default: 0] += 1 }
        let total: Double = Double(s.count)
        var h: Double = 0
        for n in counts.values {
            let p: Double = Double(n) / total
            h -= p * log2(p)
        }
        return h
    }

    static func looksRandom(_ token: String) -> Bool {
        guard token.count >= 32, token.count <= 512 else { return false }
        guard has(token, #"^[A-Za-z0-9+/_\-=.]+$"#) else { return false }
        guard has(token, "[a-z]"), has(token, "[A-Z]"), has(token, "[0-9]") else { return false }
        if has(token, #"^[0-9a-fA-F-]+$"#) { return false }
        let slashes: Int = token.filter { $0 == "/" }.count
        if token.contains("//") || slashes > 3 || (slashes > 0 && token.contains(".")) { return false }
        return entropy(token) >= 3.5
    }

    /// Likely secrets in a message, in order, not overlapping each other or an existing placeholder.
    static func detect(_ text: String) -> [DetectedSecret] {
        let ns = text as NSString
        let all = NSRange(location: 0, length: ns.length)
        var taken: [NSRange] = placeholderRegex.matches(in: text, range: all).map(\.range)
        var found: [(Int, DetectedSecret)] = []
        func add(_ r: NSRange, _ kind: String, _ name: String) {
            guard r.length > 0, !taken.contains(where: { NSIntersectionRange($0, r).length > 0 }) else { return }
            taken.append(r)
            found.append((r.location, DetectedSecret(value: ns.substring(with: r), kind: kind, suggested: name)))
        }
        for p in known {
            for m in p.regex.matches(in: text, range: all) { add(m.range, p.kind, p.name) }
        }
        for m in phrase.matches(in: text, range: all) {
            let valueRange: NSRange = m.range(at: 3)
            guard valueRange.location != NSNotFound else { continue }
            var value: String = ns.substring(with: valueRange)
            value = value.replacingOccurrences(of: #"[.,;!?)\]}]+$"#, with: "", options: .regularExpression)
            let strong: Bool = m.range(at: 1).location != NSNotFound
            guard phraseValueLooksReal(value, strong: strong) else { continue }
            var word: String = ns.substring(with: m.range(at: 2)).lowercased()
            word = word.replacingOccurrences(of: "[ _]", with: "-", options: .regularExpression)
            let name: String = ["passwd", "passcode", "passphrase"].contains(word) ? "password" : word
            let r = NSRange(location: valueRange.location, length: (value as NSString).length)
            add(r, word.replacingOccurrences(of: "-", with: " "), name)
        }
        for m in cardRegex.matches(in: text, range: all) {
            let digits: String = ns.substring(with: m.range).replacingOccurrences(of: "[ -]", with: "", options: .regularExpression)
            if digits.count >= 13 && digits.count <= 19 && luhn(digits) { add(m.range, "card number", "card-number") }
        }
        for m in tokenRegex.matches(in: text, range: all) where looksRandom(ns.substring(with: m.range)) {
            add(m.range, "key or token", "api-token")
        }
        // The same value twice (e.g. pasted twice) is one secret.
        var seen: Set<String> = []
        return found.sorted { $0.0 < $1.0 }.map(\.1).filter { seen.insert($0.value).inserted }
    }

    /// Detected secrets with names that don't clash with saved ones or each other.
    static func detectWithNames(_ text: String) -> [DetectedSecret] {
        var taken: [String] = names()
        return detect(text).map { d in
            var copy = d
            copy.suggested = uniqueName(d.suggested, taken: taken)
            taken.append(copy.suggested)
            return copy
        }
    }

    /// A masked hint for the card: "ghp_…" — never the whole value.
    static func preview(_ value: String) -> String {
        String(value.prefix(min(4, value.count / 4))) + "…"
    }

    /// Every copy of each value becomes its placeholder (longest values first).
    static func replaceValues(_ text: String, _ names: [String: String]) -> String {
        var out: String = text
        for (value, name) in names.sorted(by: { $0.key.count > $1.key.count }) where !value.isEmpty {
            out = out.replacingOccurrences(of: value, with: placeholder(name))
        }
        return out
    }

    // MARK: Which tools may use a secret, and where it goes

    struct Use {
        let names: [String]
        let destination: String
        let warning: String?
        var line: String { "Uses secret\(names.count > 1 ? "s" : ""): \(names.joined(separator: ", ")) → \(destination)" }
    }

    enum Check {
        case none                 // no placeholders
        case refuse(String)       // can't be used here; nothing runs
        case passThrough          // run as usual (e.g. an SSH host that isn't set up: the tool refuses it)
        case use(Use)             // ask, then substitute
    }

    static let refused = "Secrets can only be used in run_command, ssh_command, write_file, open, applescript and mcp_call. Nothing was run."

    private static let tools: Set<String> = ["run_command", "ssh_command", "write_file", "open", "applescript", "mcp_call"]

    @MainActor
    static func check(_ call: ToolCall) -> Check {
        let used: [String] = names(in: call)
        if used.isEmpty { return .none }
        let isMCP: Bool = call.name == "mcp_call" || MCPManager.shared.tool(named: call.name) != nil
        guard tools.contains(call.name) || isMCP else { return .refuse(refused) }
        let saved: Set<String> = Set(names())
        let missing: [String] = used.filter { !saved.contains($0) }
        if !missing.isEmpty {
            return .refuse("There’s no secret called \(missing.joined(separator: ", ")). Use secret_list to see the names; the user can add one with /secret or in Settings → Secrets. Nothing was run.")
        }
        if call.name == "ssh_command" && (!SSH.isOn || SSH.allowedHost(call.arg("host")) == nil) { return .passThrough }
        let destination: String
        var warning: String?
        switch call.name {
        case "run_command": destination = "a command on this Mac"
        case "ssh_command": destination = "a command on \(call.arg("host").trimmingCharacters(in: .whitespaces))"
        case "write_file":
            destination = "the file \(call.arg("path"))"
            warning = "This writes \(used.joined(separator: ", ")) to disk in plain text."
        case "open": destination = "opening \(call.arg("target"))"
        case "applescript": destination = "an AppleScript"
        case "mcp_call": destination = "the MCP server \(call.arg("server"))"
        default: destination = "the MCP server \(MCPManager.shared.tool(named: call.name)?.server ?? call.name)"
        }
        return .use(Use(names: used, destination: destination, warning: warning))
    }

    // MARK: Substitution (only after approval, at run time)

    enum Quoting { case none, single, double }

    static func shQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Walks a shell command and replaces each placeholder with `put(name, quoting it sits in)`.
    private static func shellWalk(_ command: String, _ put: (String, Quoting) -> String) -> String {
        let ns = command as NSString
        let n: Int = ns.length
        var out: String = ""
        var state: Quoting = .none
        var segment: Int = 0
        var i: Int = 0
        while i < n {
            let c: unichar = ns.character(at: i)
            if c == 123, let m = placeholderRegex.firstMatch(in: command, options: [.anchored], range: NSRange(location: i, length: n - i)) {
                out += ns.substring(with: NSRange(location: segment, length: i - segment))
                out += put(ns.substring(with: m.range(at: 1)).lowercased(), state)
                i += m.range.length
                segment = i
                continue
            }
            if c == 92 && state != .single && i + 1 < n { i += 2; continue }        // backslash
            if c == 39 && state != .double { state = state == .single ? .none : .single }     // '
            else if c == 34 && state != .single { state = state == .double ? .none : .double } // "
            i += 1
        }
        out += ns.substring(with: NSRange(location: segment, length: n - segment))
        return out
    }

    /// run_command: placeholders become environment variable references, so values never appear in the command line.
    static func substituteShellEnv(_ command: String, _ values: [String: String]) -> (command: String, env: [String: String]) {
        var env: [String: String] = [:]
        let text: String = shellWalk(command) { name, quoting in
            guard let value = values[name] else { return placeholder(name) }
            let v: String = envName(name)
            env[v] = value
            switch quoting {
            case .single: return "'\"${\(v)}\"'"
            case .double: return "${\(v)}"
            case .none: return "\"${\(v)}\""
            }
        }
        return (text, env)
    }

    /// ssh_command (environment variables don't reach the server): the value, quoted for where it sits.
    static func substituteShellLiteral(_ command: String, _ values: [String: String]) -> String {
        shellWalk(command) { name, quoting in
            guard let value = values[name] else { return placeholder(name) }
            switch quoting {
            case .single: return value.replacingOccurrences(of: "'", with: "'\\''")
            case .double: return value.replacingOccurrences(of: #"([\\"$`])"#, with: #"\\$1"#, options: .regularExpression)
            case .none: return shQuote(value)
            }
        }
    }

    static func substituteLiteral(_ text: String, _ values: [String: String], applescript: Bool = false) -> String {
        let ns = text as NSString
        var out: String = ""
        var last: Int = 0
        for m in placeholderRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let name: String = ns.substring(with: m.range(at: 1)).lowercased()
            if let value = values[name] {
                out += applescript ? value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") : value
            } else {
                out += ns.substring(with: m.range)
            }
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    private static func substituteJSON(_ v: Any, _ values: [String: String]) -> Any {
        if let s = v as? String { return substituteLiteral(s, values) }
        if let a = v as? [Any] { return a.map { substituteJSON($0, values) } }
        if let d = v as? [String: Any] { return d.mapValues { substituteJSON($0, values) } }
        return v
    }

    /// The call with values put in, plus environment variables for run_command. Never stored or shown.
    static func substitute(_ call: ToolCall, _ values: [String: String]) -> (call: ToolCall, env: [String: String]) {
        var out: ToolCall = call
        var env: [String: String] = [:]
        let applescript: Bool = call.name == "applescript"
        var args: [String: String] = [:]
        for (k, v) in call.arguments {
            if k == "command" && call.name == "run_command" {
                let r = substituteShellEnv(v, values)
                args[k] = r.command
                env.merge(r.env) { a, _ in a }
            } else if k == "command" && call.name == "ssh_command" {
                args[k] = substituteShellLiteral(v, values)
            } else {
                args[k] = substituteLiteral(v, values, applescript: applescript)
            }
        }
        out.arguments = args
        if let raw = call.raw, let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] {
            var top: [String: Any] = [:]
            for (k, v) in obj {
                if k == "command", let s = v as? String, call.name == "run_command" { top[k] = substituteShellEnv(s, values).command }
                else if k == "command", let s = v as? String, call.name == "ssh_command" { top[k] = substituteShellLiteral(s, values) }
                else { top[k] = substituteJSON(v, values) }
            }
            out.raw = try? JSONSerialization.data(withJSONObject: top)
        }
        return (out, env)
    }

    // MARK: Scrubbing (tool output → placeholders)

    private static let uriAllowed: CharacterSet = {
        var set = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        set.insert(charactersIn: "-_.!~*'()")
        return set
    }()

    /// The forms a value may come back in: as typed, base64 (with and without padding), URL-encoded, JSON-escaped.
    static func variants(_ value: String) -> [String] {
        let b64: String = Data(value.utf8).base64EncodedString()
        var unpadded: String = b64
        while unpadded.hasSuffix("=") { unpadded.removeLast() }
        let url: String = value.addingPercentEncoding(withAllowedCharacters: uriAllowed) ?? value
        var json: String = value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        json = json.replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r").replacingOccurrences(of: "\t", with: "\\t")
        var out: [String] = []
        for v in [value, b64, unpadded, url, json] where v.count >= 4 && !out.contains(v) { out.append(v) }
        return out
    }

    /// Replaces secret values in text. Built from the values once, then used for every tool result in a turn.
    struct Scrubber: Sendable {
        let pairs: [(String, String)]

        init(_ secrets: [String: String]) {
            var p: [(String, String)] = []
            for (name, value) in secrets where value.count >= 4 {
                for v in Secrets.variants(value) { p.append((v, Secrets.placeholder(name))) }
            }
            pairs = p.sorted { $0.0.count > $1.0.count }
        }

        var isEmpty: Bool { pairs.isEmpty }

        func scrub(_ text: String) -> String {
            var out: String = text
            for (v, p) in pairs where out.contains(v) { out = out.replacingOccurrences(of: v, with: p) }
            return out
        }
    }

    /// A scrubber for every saved secret (reads the Keychain off the main thread).
    static func scrubber() async -> Scrubber {
        let list: [String] = names()
        if list.isEmpty { return Scrubber([:]) }
        return Scrubber(await values(list))
    }

    // MARK: Prompt and tool

    /// Same meaning as `secretsFact` in Extensions/vscode/src/tools/secretsCore.ts.
    static var promptFact: String {
        let list: [String] = names()
        let saved: String = list.isEmpty ? "none yet (the user can add one with /secret or in Settings → Secrets)" : list.joined(separator: ", ")
        return "Secrets: never ask the user to type a password or key in chat. Use secret_list and {{secret:name}} placeholders in tool arguments (e.g. in run_command); the user approves each use. You can't read secret values. Saved secrets: \(saved)."
    }

    static let listDefinition: [String: Any] = MacTools.tool(
        "secret_list",
        "List the user's saved secrets (names and descriptions only — you can never read values). Use one as {{secret:name}} in a tool argument; the user approves each use.",
        [:], required: [])

    static func listText() -> String {
        let list: [SecretEntry] = all()
        if list.isEmpty { return "No secrets saved yet. The user can add one with /secret or in Settings → Secrets." }
        return list.map { "- \($0.name)\($0.description.isEmpty ? "" : " — " + $0.description) (use {{secret:\($0.name)}})" }.joined(separator: "\n")
    }
}
