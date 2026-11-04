import Foundation

enum OllamaError: LocalizedError {
    case server(String)
    case thinkingUnsupported

    var errorDescription: String? {
        switch self {
        case .server(let message): return message
        case .thinkingUnsupported: return "This model can't think before answering."
        }
    }
}

struct ToolCall: Codable, Equatable, Sendable {
    var name: String
    var arguments: [String: String]
    var raw: Data? = nil

    func arg(_ key: String) -> String { arguments[key] ?? "" }
}

struct ModelInfo: Decodable, Hashable, Sendable {
    let name: String
    let size: Int64?
}

struct RunningModel: Decodable, Hashable, Sendable {
    let name: String
    let size: Int64?
    let size_vram: Int64?
    let expires_at: String?
}

struct ChatChunk: Sendable {
    var content = ""
    var thinking = ""
    var toolCalls: [ToolCall] = []
    var resetToolCalls = false
    var done = false
    var evalCount = 0
    var evalDuration: Int64 = 0
}

/// Detects four consecutive copies of the same 24–256 byte phrase in the model's thinking stream.
/// Keep a short tail so detection stays bounded for long responses.
private struct ThinkingRepeatGuard {
    private var tail: [UInt8] = []

    mutating func append(_ text: String) -> Bool {
        tail.append(contentsOf: text.utf8)
        if tail.count > 2_048 { tail = Array(tail.suffix(2_048)) }
        let count = tail.count
        guard count >= 96 else { return false }
        for period in 24...min(256, count / 4) {
            let last = (count - period)..<count
            let previous = (count - 2 * period)..<(count - period)
            guard tail[last].elementsEqual(tail[previous]) else { continue }
            let third = (count - 3 * period)..<(count - 2 * period)
            guard tail[last].elementsEqual(tail[third]) else { continue }
            let fourth = (count - 4 * period)..<(count - 3 * period)
            if tail[last].elementsEqual(tail[fourth]) { return true }
        }
        return false
    }
}

/// Minimal client for the local Ollama HTTP API.
struct OllamaClient: Sendable {
    let base: URL

    init() {
        base = URL(string: Prefs.serverURL) ?? URL(string: "http://localhost:11434")!
    }

    // MARK: Simple calls

    func version() async throws -> String {
        struct R: Decodable { let version: String }
        return try await get("api/version", R.self).version
    }

    func tags() async throws -> [ModelInfo] {
        struct R: Decodable { let models: [ModelInfo] }
        return try await get("api/tags", R.self).models.sorted { $0.name < $1.name }
    }

    func running() async throws -> [RunningModel] {
        struct R: Decodable { let models: [RunningModel] }
        return try await get("api/ps", R.self).models
    }

    func load(_ model: String, keepAlive: String) async throws {
        var body: [String: Any] = ["model": model, "keep_alive": keepAlive]
        // Autocomplete is driven by Continue, which picks its own context size — don't fight it.
        if model != Prefs.autoModel { body["options"] = ["num_ctx": Prefs.contextLength(for: model)] }
        try await post("api/generate", body)
    }

    func delete(_ model: String) async throws {
        var req = URLRequest(url: base.appendingPathComponent("api/delete"))
        req.httpMethod = "DELETE"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["model": model])
        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw OllamaError.server(Self.errorMessage(data))
        }
    }

    /// Ask an Ollama decision model whether a short reasoning window is stuck in a loop.
    func thinkingLoopConfidence(model: String, state: String) async throws -> Double {
        var req = URLRequest(url: base.appendingPathComponent("v1/systemone"))
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": model,
            "state": state,
            "keep_alive": "30s",
            "questions": ["looping": [
                "type": "noul",
                "instructions": "Is the model's recent reasoning stuck in a repetitive loop, restating the same idea without meaningful progress toward the user's task? Be conservative: normal checking, correcting mistakes, and considering alternatives are not loops.",
                "criteria": [
                    "true": "The recent reasoning clearly repeats the same point or cycle without progress.",
                    "false": "The reasoning is progressing, checking work, or the evidence is insufficient to call it a loop.",
                ],
            ]],
        ])
        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw OllamaError.server(Self.errorMessage(data))
        }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let answers = root["answers"] as? [String: Any],
              let looping = answers["looping"] as? [String: Any],
              let confidence = (looping["noul"] as? NSNumber)?.doubleValue else {
            throw OllamaError.server("The thinking decider returned an invalid response.")
        }
        return confidence
    }

    /// What a model can do, e.g. ["completion", "tools", "vision", "thinking"].
    func capabilities(_ model: String) async -> [String] {
        var req = URLRequest(url: base.appendingPathComponent("api/show"))
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["model": model])
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
        return obj["capabilities"] as? [String] ?? []
    }

    /// Give a Qwen3.5-family GGUF import (e.g. Ember's hf.co default) Ollama's built-in tool-call format.
    /// Those downloads come with a plain text template and no PARSER/RENDERER, so tools and thinking don't work.
    /// Rewrites the model in place under the same name (same weights, no extra disk). Returns true if it changed.
    @discardableResult
    func fixFormatIfNeeded(_ model: String) async -> Bool {
        var req = URLRequest(url: base.appendingPathComponent("api/show"))
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["model": model])
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        let renderer: String = obj["renderer"] as? String ?? ""
        let details: [String: Any] = obj["details"] as? [String: Any] ?? [:]
        let family: String = details["family"] as? String ?? ""
        guard let fix = ModelTuning.formatFix(family: family, renderer: renderer) else { return false }
        let body: [String: Any] = ["model": model, "from": model, "renderer": fix.renderer,
                                   "parser": fix.parser, "stream": false]
        do { try await post("api/create", body) } catch { return false }
        return true
    }

    func unload(_ model: String) async throws {
        try await post("api/generate", ["model": model, "keep_alive": 0])
    }

    private func get<T: Decodable>(_ path: String, _ type: T.Type) async throws -> T {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.timeoutInterval = 3
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post(_ path: String, _ body: [String: Any]) async throws {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 600
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw OllamaError.server(Self.errorMessage(data))
        }
    }

    static func errorMessage(_ data: Data) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let e = obj["error"] as? String { return e }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: Pull (download) with progress

    func pull(_ model: String) -> AsyncThrowingStream<(status: String, fraction: Double?), Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: base.appendingPathComponent("api/pull"))
                    req.httpMethod = "POST"
                    req.timeoutInterval = 3600
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.httpBody = try JSONSerialization.data(withJSONObject: ["model": model, "stream": true])
                    let (bytes, _) = try await URLSession.shared.bytes(for: req)
                    for try await line in bytes.lines {
                        guard let obj = Self.json(line) else { continue }
                        if let e = obj["error"] as? String { throw OllamaError.server(e) }
                        let status = obj["status"] as? String ?? ""
                        var fraction: Double?
                        if let total = (obj["total"] as? NSNumber)?.doubleValue, total > 0,
                           let done = (obj["completed"] as? NSNumber)?.doubleValue {
                            fraction = done / total
                        }
                        continuation.yield((status, fraction))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Streaming chat

    /// Streaming /api/chat. If the model rejects `think`: a level is retried as plain `true`, then without `think`
    /// at all. Same as OllamaClient.chat in ollama.ts.
    func chat(model: String, messages: [[String: Any]], tools: [[String: Any]]?, think: OllamaThink,
              numCtx: Int, keepAlive: String) -> AsyncThrowingStream<ChatChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var tries: [OllamaThink?] = [think, nil]
                    if case .level = think { tries = [think, .on, nil] }
                    for (n, attempt) in tries.enumerated() {
                        do {
                            let result = try await streamChat(model: model, messages: messages, tools: tools, think: attempt,
                                                              numCtx: numCtx, keepAlive: keepAlive, continuation: continuation)
                            if result.loopStopped {
                                continuation.yield(ChatChunk(content: "\n\nI noticed my thinking started repeating, so I stopped it and am answering directly.\n\n", resetToolCalls: true))
                                var retryMessages = messages
                                if !result.thinking.isEmpty {
                                    let context = String(result.thinking.suffix(3_000))
                                    retryMessages.append(["role": "assistant", "content": "My previous thinking before it started repeating (incomplete context; do not repeat it):\n" + context])
                                }
                                retryMessages.append(["role": "user", "content": "Your previous response started repeating its reasoning before answering. Stop thinking and answer the original request directly now, using the conversation above and any useful context. Be concise and do not repeat the loop."])
                                let fallback = try await streamChat(model: model, messages: retryMessages, tools: tools, think: .off,
                                                                    numCtx: numCtx, keepAlive: keepAlive, continuation: continuation)
                                if fallback.loopStopped {
                                    continuation.yield(ChatChunk(content: "\n\nI stopped a second repeated thinking response. Please try a shorter prompt or Low effort.\n", resetToolCalls: true))
                                }
                            }
                            break
                        } catch OllamaError.thinkingUnsupported {
                            // The model doesn't take this kind of "think"; try the next, simpler one.
                            if n == tries.count - 1 { throw OllamaError.thinkingUnsupported }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func streamChat(model: String, messages: [[String: Any]], tools: [[String: Any]]?, think: OllamaThink?,
                            numCtx: Int, keepAlive: String,
                            continuation: AsyncThrowingStream<ChatChunk, Error>.Continuation) async throws -> (loopStopped: Bool, thinking: String) {
        var body: [String: Any] = [
            "model": model,
            "messages": messages,
            "stream": true,
            "keep_alive": keepAlive,
            "options": ModelTuning.options(model: model, think: think?.isOn ?? false, numCtx: numCtx),
        ]
        if let think { body["think"] = think.json }
        if let tools, !tools.isEmpty { body["tools"] = tools }

        var req = URLRequest(url: base.appendingPathComponent("api/chat"))
        req.httpMethod = "POST"
        req.timeoutInterval = 900
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (bytes, response) = try await URLSession.shared.bytes(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            let message = Self.errorMessage(data)
            if think != nil && message.lowercased().contains("think") { throw OllamaError.thinkingUnsupported }
            throw OllamaError.server(message)
        }

        var thought = ""
        var repeatGuard = ThinkingRepeatGuard()
        var loopStopped = false
        var lastDecisionLength = 0
        var deciderFailed = false
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard let obj = Self.json(line) else { continue }
            if let e = obj["error"] as? String {
                if think != nil && e.lowercased().contains("think") { throw OllamaError.thinkingUnsupported }
                throw OllamaError.server(e)
            }
            var chunk = ChatChunk()
            if let message = obj["message"] as? [String: Any] {
                chunk.content = message["content"] as? String ?? ""
                chunk.thinking = message["thinking"] as? String ?? ""
                let inlineThinking = ThinkSplitter.split(chunk.content, extra: "").thinking
                let streamedThinking = chunk.thinking + inlineThinking
                thought += streamedThinking
                if let calls = message["tool_calls"] as? [[String: Any]] {
                    chunk.toolCalls = calls.compactMap(Self.toolCall)
                }
            }
            chunk.done = obj["done"] as? Bool ?? false
            chunk.evalCount = (obj["eval_count"] as? NSNumber)?.intValue ?? 0
            chunk.evalDuration = (obj["eval_duration"] as? NSNumber)?.int64Value ?? 0
            let streamedThinking = chunk.thinking + ThinkSplitter.split(chunk.content, extra: "").thinking
            let repeated = !streamedThinking.isEmpty && repeatGuard.append(streamedThinking)
            var semanticLoop = false
            if repeated {
                loopStopped = true
                chunk.toolCalls = []
            } else if Prefs.thinkingDeciderEnabled, !deciderFailed,
                      thought.utf8.count - lastDecisionLength >= 768 {
                lastDecisionLength = thought.utf8.count
                let task = (messages.last(where: { ($0["role"] as? String) == "user" })?["content"] as? String ?? "")
                let state = "User task:\n\(String(task.suffix(1_000)))\n\nRecent reasoning:\n\(String(thought.suffix(2_500)))"
                do {
                    semanticLoop = try await thinkingLoopConfidence(model: Prefs.thinkingDeciderModel, state: state) >= 0.88
                    if semanticLoop { loopStopped = true; chunk.toolCalls = [] }
                } catch {
                    // A missing, unsupported, or unavailable optional decider never prevents the answer.
                    deciderFailed = true
                }
            }
            continuation.yield(chunk)
            if repeated || semanticLoop {
                break
            }
            if chunk.done { break }
        }
        return (loopStopped, thought)
    }

    private static func json(_ line: String) -> [String: Any]? {
        guard let data = line.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func toolCall(_ raw: [String: Any]) -> ToolCall? {
        guard let fn = raw["function"] as? [String: Any], let name = fn["name"] as? String else { return nil }
        var dict: [String: Any] = [:]
        if let a = fn["arguments"] as? [String: Any] {
            dict = a
        } else if let s = fn["arguments"] as? String,
                  let a = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] {
            dict = a
        }
        var args: [String: String] = [:]
        for (k, v) in dict { args[k] = (v as? String) ?? "\(v)" }
        return ToolCall(name: name, arguments: args, raw: try? JSONSerialization.data(withJSONObject: dict))
    }
}


/// Sampling settings the model makers recommend, sent on every request rather than trusting Ollama's defaults.
enum ModelTuning {
    /// Ollama's own Qwen3.5/3.6/3.8 models use the built-in "qwen3.5" parser and renderer (Qwen3-Coder XML tool
    /// calls with thinking — checked on Ollama 0.40.14). GGUF imports of the same models arrive without them.
    /// See docs/engine.md, "Qwen tool-call format".
    static func formatFix(family: String, renderer: String) -> (renderer: String, parser: String)? {
        guard renderer.isEmpty else { return nil }                 // already has a built-in format: leave it alone
        let qwen35Families: Set<String> = ["qwen35", "qwen35moe"]   // GGUF architecture names
        guard qwen35Families.contains(family.lowercased()) else { return nil }
        return ("qwen3.5", "qwen3.5")
    }

    static func options(model: String, think: Bool, numCtx: Int) -> [String: Any] {
        var o: [String: Any] = ["num_ctx": numCtx]
        let m = model.lowercased()
        if m.contains("qwen3") {
            // Qwen3.x model cards: precise coding with thinking, or the non-thinking settings.
            if think {
                o["temperature"] = 0.6; o["top_p"] = 0.95; o["top_k"] = 20; o["min_p"] = 0
                // The model cards suggest a presence penalty against endless repetition, which quantised models
                // are prone to — and thinking is where it loops (a 26K-character loop was seen with Ember).
                o["presence_penalty"] = 1.5
            } else {
                o["temperature"] = 0.7; o["top_p"] = 0.8; o["top_k"] = 20; o["min_p"] = 0
                o["presence_penalty"] = 1.5
            }
        }
        return o
    }
}
