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
    var done = false
    var evalCount = 0
    var evalDuration: Int64 = 0
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

    func chat(model: String, messages: [[String: Any]], tools: [[String: Any]]?, think: Bool,
              numCtx: Int, keepAlive: String) -> AsyncThrowingStream<ChatChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    do {
                        try await streamChat(model: model, messages: messages, tools: tools, think: think,
                                             numCtx: numCtx, keepAlive: keepAlive, continuation: continuation)
                    } catch OllamaError.thinkingUnsupported {
                        // Model doesn't do "think"; retry without asking for it.
                        try await streamChat(model: model, messages: messages, tools: tools, think: nil,
                                             numCtx: numCtx, keepAlive: keepAlive, continuation: continuation)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func streamChat(model: String, messages: [[String: Any]], tools: [[String: Any]]?, think: Bool?,
                            numCtx: Int, keepAlive: String,
                            continuation: AsyncThrowingStream<ChatChunk, Error>.Continuation) async throws {
        var body: [String: Any] = [
            "model": model,
            "messages": messages,
            "stream": true,
            "keep_alive": keepAlive,
            "options": ModelTuning.options(model: model, think: think ?? false, numCtx: numCtx),
        ]
        if let think { body["think"] = think }
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
                if let calls = message["tool_calls"] as? [[String: Any]] {
                    chunk.toolCalls = calls.compactMap(Self.toolCall)
                }
            }
            chunk.done = obj["done"] as? Bool ?? false
            chunk.evalCount = (obj["eval_count"] as? NSNumber)?.intValue ?? 0
            chunk.evalDuration = (obj["eval_duration"] as? NSNumber)?.int64Value ?? 0
            continuation.yield(chunk)
            if chunk.done { break }
        }
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
    static func options(model: String, think: Bool, numCtx: Int) -> [String: Any] {
        var o: [String: Any] = ["num_ctx": numCtx]
        let m = model.lowercased()
        if m.contains("qwen3") {
            // Qwen3.x model cards: precise coding with thinking, or the non-thinking settings.
            if think {
                o["temperature"] = 0.6; o["top_p"] = 0.95; o["top_k"] = 20; o["min_p"] = 0
            } else {
                o["temperature"] = 0.7; o["top_p"] = 0.8; o["top_k"] = 20; o["min_p"] = 0
                o["presence_penalty"] = 1.5
            }
        }
        return o
    }
}
