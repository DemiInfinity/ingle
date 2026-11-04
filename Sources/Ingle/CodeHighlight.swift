import SwiftUI

/// Lightweight syntax colouring for code blocks. Not a full parser — a handful of regexes that
/// cover the languages Ingle sees most (Swift, TS/JS, C#, Python, SQL, shell, Go, Rust, Java, HTML, CSS, JSON).
enum CodeHighlight {
    enum Palette {
        static let keyword = Color(hex: 0xFF8F70)   // ember coral
        static let type = Color(hex: 0xF2C46D)      // warm gold
        static let string = Color(hex: 0xA9D18E)    // soft sage
        static let number = Color(hex: 0xD7A8EC)    // lavender
        static let comment = Color(hex: 0x8C7D82)   // muted plum-grey
        static let function = Color(hex: 0x82C8F5)  // sky
        static let tag = Color(hex: 0xFF8F70)
        static let attribute = Color(hex: 0xF2C46D)
        static let plain = Ember.text.opacity(0.9)
    }

    private static let keywords: Set<String> = [
        // shared C-family / JS / TS / Swift / C# / Java / Go / Rust
        "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default",
        "defer", "delete", "do", "else", "enum", "export", "extends", "extension", "false", "final", "finally",
        "for", "func", "function", "go", "guard", "if", "impl", "implements", "import", "in", "init", "interface",
        "internal", "is", "let", "match", "mod", "mut", "namespace", "new", "nil", "null", "nullptr", "of",
        "override", "package", "private", "protected", "protocol", "pub", "public", "readonly", "return", "self",
        "Self", "sealed", "static", "struct", "super", "switch", "this", "throw", "throws", "trait", "true", "try",
        "type", "typeof", "undefined", "use", "using", "var", "void", "where", "while", "yield", "fn", "loop",
        "some", "any", "inout", "lazy", "weak", "unowned", "mutating", "fileprivate", "open", "repeat",
        "virtual", "volatile", "get", "set", "value", "record", "required", "with", "from", "select",
        // Python
        "and", "def", "del", "elif", "except", "global", "lambda", "nonlocal", "not", "or", "pass", "raise",
        "None", "True", "False", "print",
        // Shell
        "then", "fi", "done", "esac", "export", "local", "echo", "source", "function",
    ]

    private static let sqlKeywords: Set<String> = [
        "select", "from", "where", "join", "left", "right", "inner", "outer", "full", "on", "group", "by",
        "order", "having", "limit", "offset", "insert", "into", "values", "update", "set", "delete", "create",
        "table", "index", "view", "drop", "alter", "add", "column", "primary", "key", "foreign", "references",
        "not", "null", "and", "or", "as", "distinct", "count", "sum", "avg", "min", "max", "case", "when",
        "then", "else", "end", "in", "is", "like", "between", "exists", "union", "all", "with", "desc", "asc",
        "default", "unique", "constraint", "returning", "begin", "commit", "rollback", "transaction",
    ]

    private static let hashComments: Set<String> = ["python", "py", "bash", "sh", "zsh", "shell", "yaml", "yml",
                                                     "ruby", "rb", "toml", "dockerfile", "makefile", "r", "perl", "conf", "ini"]
    private static let dashComments: Set<String> = ["sql", "lua", "haskell", "hs", "postgres", "postgresql", "mysql", "sqlite"]
    private static let markup: Set<String> = ["html", "xml", "svg", "jsx", "tsx", "vue", "svelte", "xaml", "plist"]

    private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        // Patterns are fixed literals, so a failure here is a programming error.
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    private static let blockComment = regex(#"/\*[\s\S]*?\*/|<!--[\s\S]*?-->"#)
    private static let lineComment = regex(#"//[^\n]*"#)
    private static let hashComment = regex(#"(?m)(^|\s)#[^\n]*"#)
    private static let dashComment = regex(#"--[^\n]*"#)
    private static let strings = regex(#""(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`"#)
    private static let numbers = regex(#"\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b"#)
    private static let words = regex(#"\b[A-Za-z_][A-Za-z0-9_]*\b"#)
    private static let tags = regex(#"</?[A-Za-z][\w:.-]*|/?>"#)
    private static let attributes = regex(#"\b[A-Za-z_:][\w:.-]*(?==)"#)
    private static let cssProps = regex(#"(?m)^\s*([a-z-]+)(?=\s*:)"#)

    static func highlight(_ code: String, language: String) -> AttributedString {
        let lang = language.lowercased().trimmingCharacters(in: .whitespaces)
        var out = AttributedString(code)
        out.foregroundColor = Palette.plain
        guard !code.isEmpty, code.utf16.count < 60_000 else { return out }

        let ns = code as NSString
        let full = NSRange(location: 0, length: ns.length)
        var taken = [Bool](repeating: false, count: ns.length)

        func free(_ r: NSRange) -> Bool {
            for i in r.location..<(r.location + r.length) where taken[i] { return false }
            return true
        }

        func paint(_ r: NSRange, _ color: Color, italic: Bool = false, claim: Bool = true) {
            guard r.length > 0, r.location + r.length <= ns.length, free(r),
                  let range = Range(r, in: out) else { return }
            out[range].foregroundColor = color
            if italic { out[range].font = .system(size: 12.5, design: .monospaced).italic() }
            if claim { for i in r.location..<(r.location + r.length) { taken[i] = true } }
        }

        func each(_ re: NSRegularExpression, group: Int = 0, _ body: (NSRange) -> Void) {
            for m in re.matches(in: code, range: full) {
                let r = m.range(at: group)
                if r.location != NSNotFound { body(r) }
            }
        }

        // 1. Comments and strings win over everything inside them.
        each(blockComment) { paint($0, Palette.comment, italic: true) }
        if hashComments.contains(lang) {
            each(hashComment) { paint($0, Palette.comment, italic: true) }
        } else if dashComments.contains(lang) {
            each(dashComment) { paint($0, Palette.comment, italic: true) }
        } else if lang != "css" && lang != "html" {
            each(lineComment) { paint($0, Palette.comment, italic: true) }
        }
        each(strings) { paint($0, Palette.string) }

        // 2. Markup tags and attributes.
        if markup.contains(lang) {
            each(tags) { paint($0, Palette.tag) }
            each(attributes) { paint($0, Palette.attribute) }
        }
        if lang == "css" || lang == "scss" {
            each(cssProps, group: 1) { paint($0, Palette.attribute) }
        }

        // 3. Numbers.
        each(numbers) { paint($0, Palette.number) }

        // 4. Words: keywords, function calls, types.
        let isSQL = dashComments.contains(lang)
        for m in words.matches(in: code, range: full) {
            let r = m.range
            let word = ns.substring(with: r)
            if isSQL {
                if sqlKeywords.contains(word.lowercased()) { paint(r, Palette.keyword) }
                continue
            }
            if keywords.contains(word) {
                paint(r, Palette.keyword)
                continue
            }
            // A word followed by "(" is a function call or definition.
            var next = r.location + r.length
            while next < ns.length, ns.character(at: next) == 32 { next += 1 }
            if next < ns.length, ns.character(at: next) == 40 {   // "("
                paint(r, Palette.function)
                continue
            }
            if let first = word.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(first), word.count > 1 {
                paint(r, Palette.type)
            }
        }
        return out
    }
}
