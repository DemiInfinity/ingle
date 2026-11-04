import Foundation

/// A short, hand-picked list of models known to work well in Ingle (checked November 2026).
/// Anything else on Ollama or Hugging Face can be typed in by name.
struct CatalogModel: Identifiable, Hashable {
    var id: String { tag }
    let tag: String
    let name: String
    let sizeGB: Double
    let bestFor: ModelRole
    let blurb: String
}

enum ModelRole: String, CaseIterable, Identifiable {
    case daily, hard, autocomplete, add
    var id: String { rawValue }

    var prefKey: String? {
        switch self {
        case .daily: return Prefs.K.daily
        case .hard: return Prefs.K.hard
        case .autocomplete: return Prefs.K.auto
        case .add: return nil
        }
    }

    var currentModel: String? { prefKey.map(Prefs.str) }

    var menuTitle: String {
        switch self {
        case .daily: return "Replace \(Prefs.dailyName) (Daily coding)"
        case .hard: return "Replace \(Prefs.hardName) (Hard jobs)"
        case .autocomplete: return "Replace Autocomplete"
        case .add: return "New model — just add it"
        }
    }
}

enum ModelCatalog {
    static let models: [CatalogModel] = [
        CatalogModel(tag: "qwen3.6:35b-mlx", name: "Qwen3.6 35B · MLX", sizeGB: 23, bestFor: .daily,
                     blurb: "Same brain as Ember, in Apple’s MLX format: up to twice as fast. Tight on 36 GB — use 16K context."),
        CatalogModel(tag: "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS", name: "Qwen3.6 35B · compact", sizeGB: 17.7, bestFor: .daily,
                     blurb: "Ember’s default. Fast mixture-of-experts model that leaves room for your other apps."),
        CatalogModel(tag: "qwen3.8:27b-mlx", name: "Qwen3.8 27B · MLX", sizeGB: 18, bestFor: .hard,
                     blurb: "Flint’s default. The strongest coder that fits, but slow and power-hungry."),
        CatalogModel(tag: "qwen3.6:27b-coding-nvfp4", name: "Qwen3.6 27B Coding · MLX", sizeGB: 20, bestFor: .hard,
                     blurb: "About twice Flint’s speed, a generation behind on quality."),
        CatalogModel(tag: "glm-4.7-flash", name: "GLM-4.7 Flash", sizeGB: 19, bestFor: .daily,
                     blurb: "Fast mixture-of-experts alternative with good tool use."),
        CatalogModel(tag: "gpt-oss:20b", name: "gpt-oss 20B", sizeGB: 14, bestFor: .daily,
                     blurb: "OpenAI’s open model. Fast and light, weaker at coding than Qwen."),
        CatalogModel(tag: "qwen3-coder:30b", name: "Qwen3-Coder 30B", sizeGB: 19, bestFor: .daily,
                     blurb: "Older coding model, superseded by Qwen3.6, kept for comparison."),
        CatalogModel(tag: "qwen2.5-coder:1.5b-base", name: "Qwen2.5-Coder 1.5B base", sizeGB: 1, bestFor: .autocomplete,
                     blurb: "Default autocomplete. Tiny and quick, barely touches the battery."),
        CatalogModel(tag: "qwen2.5-coder:7b-base", name: "Qwen2.5-Coder 7B base", sizeGB: 4.7, bestFor: .autocomplete,
                     blurb: "Smarter autocomplete for when you’re plugged in."),
    ]

    /// Roughly how much the GPU may use on this Mac (macOS keeps about a quarter back).
    static var gpuBudgetGB: Double { Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824 * 0.72 }

    static func fitNote(_ model: CatalogModel) -> String {
        let budget = gpuBudgetGB
        if model.sizeGB > budget { return "Too big for this Mac" }
        if model.sizeGB > budget - 3 { return "Very tight on this Mac" }
        return "Fits this Mac"
    }
}
