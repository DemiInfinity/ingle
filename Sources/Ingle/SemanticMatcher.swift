import Foundation

/// Before a message is sent, find the rules and skills that clearly match it and attach them,
/// so the assistant doesn't have to remember to look them up. Uses a small local embedding model
/// when it's downloaded, and simple keyword matching otherwise.
@MainActor
final class SemanticMatcher {
    static let shared = SemanticMatcher()
    static let model = "nomic-embed-text"

    struct Candidate {
        let id: String
        let text: String
    }

    private var cache: [String: [Double]] = [:]

    func clearCache() { cache.removeAll() }

    var hasModel: Bool {
        ModelManager.current?.available.contains { $0.name == Self.model || $0.name.hasPrefix(Self.model + ":") } ?? false
    }

    /// IDs of candidates that match the query, best first.
    func matches(query: String, candidates: [Candidate], limit: Int = 3) async -> [String] {
        guard Prefs.smartMatching, !candidates.isEmpty,
              !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        if hasModel, let semantic = await semanticMatches(query: query, candidates: candidates, limit: limit) {
            return semantic
        }
        return keywordMatches(query: query, candidates: candidates, limit: limit)
    }

    // MARK: Embeddings

    private func semanticMatches(query: String, candidates: [Candidate], limit: Int) async -> [String]? {
        let missing = candidates.filter { cache[$0.text] == nil }
        if !missing.isEmpty {
            guard let vectors = await embed(missing.map { "search_document: " + $0.text }),
                  vectors.count == missing.count else { return nil }
            for (c, v) in zip(missing, vectors) { cache[c.text] = v }
        }
        guard let q = await embed(["search_query: " + String(query.prefix(2000))])?.first else { return nil }
        let scored = candidates.compactMap { c -> (String, Double)? in
            guard let v = cache[c.text] else { return nil }
            return (c.id, Self.cosine(q, v))
        }.sorted { $0.1 > $1.1 }
        let threshold = 0.58
        return scored.prefix(limit).filter { $0.1 >= threshold }.map { $0.0 }
    }

    private func embed(_ texts: [String]) async -> [[Double]]? {
        var req = URLRequest(url: OllamaClient().base.appendingPathComponent("api/embed"))
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["model": Self.model, "input": texts, "keep_alive": "5m"])
        guard let result = try? await URLSession.shared.data(for: req),
              (result.1 as? HTTPURLResponse)?.statusCode == 200,
              let obj = (try? JSONSerialization.jsonObject(with: result.0)) as? [String: Any],
              let raw = obj["embeddings"] as? [[NSNumber]] else { return nil }
        return raw.map { $0.map(\.doubleValue) }
    }

    private static func cosine(_ a: [Double], _ b: [Double]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot = 0.0, na = 0.0, nb = 0.0
        for i in a.indices { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
        return na == 0 || nb == 0 ? 0 : dot / (na.squareRoot() * nb.squareRoot())
    }

    // MARK: Keywords (fallback)

    private static let stopWords: Set<String> = [
        "this", "that", "with", "from", "what", "when", "where", "which", "about", "into", "your", "have",
        "will", "would", "could", "should", "there", "their", "them", "then", "than", "also", "just", "like",
        "make", "need", "want", "please", "help", "using", "user", "file", "code", "some", "more", "does",
    ]

    private static func words(_ s: String) -> Set<String> {
        Set(s.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
            .filter { $0.count > 3 && !stopWords.contains($0) })
    }

    private func keywordMatches(query: String, candidates: [Candidate], limit: Int) -> [String] {
        let q = Self.words(query)
        let scored = candidates.map { c -> (String, Int) in
            let overlap = Self.words(c.text).intersection(q).count
            let nameHit = Self.words(c.id).intersection(q).isEmpty ? 0 : 2
            return (c.id, overlap + nameHit)
        }.filter { $0.1 >= 2 }.sorted { $0.1 > $1.1 }
        return scored.prefix(limit).map { $0.0 }
    }
}
