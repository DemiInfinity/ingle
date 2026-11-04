import SwiftUI
import AppKit

// MARK: One message

struct MessageRow: View {
    let message: ChatMessage
    let isLast: Bool
    let streaming: Bool
    let onRegenerate: () -> Void

    @State private var showThinking = false
    @State private var showOutput = false

    private var live: Bool { isLast && streaming }
    private var parts: (thinking: String, body: String) { ThinkSplitter.split(message.content, extra: message.thinking) }

    var body: some View {
        switch message.role {
        case .user where message.nudge == true:
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.shield").font(.system(size: 10))
                Text(message.content.replacingOccurrences(of: "Ingle: ", with: "Ingle reminded the assistant: "))
                    .lineLimit(2)
            }
            .font(.system(size: 11.5))
            .foregroundStyle(Ember.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .user: user
        case .tool: tool
        case .assistant where message.compactedCount != nil:
            compaction
        case .assistant:
            let p = parts
            if !p.body.isEmpty || !p.thinking.isEmpty || live || message.toolCalls.isEmpty {
                assistant(p)
            }
        }
    }

    /// "Earlier messages summarised" divider; click to read the summary the model now works from.
    private var compaction: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.snappy) { showOutput.toggle() }
            } label: {
                HStack(spacing: 10) {
                    Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1)
                    HStack(spacing: 5) {
                        Image(systemName: "rectangle.compress.vertical").font(.system(size: 10))
                        Text("Earlier messages summarised · \(message.compactedCount ?? 0) messages")
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
                            .rotationEffect(.degrees(showOutput ? 90 : 0))
                    }
                    .font(.system(size: 11))
                    .foregroundStyle(Ember.secondary)
                    .fixedSize()
                    Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("The assistant now sees this summary instead of the messages above")
            if showOutput {
                Text(message.content)
                    .font(.system(size: 12))
                    .foregroundStyle(Ember.secondary)
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.04)))
            }
        }
    }

    private var user: some View {
        HStack {
            Spacer(minLength: 80)
            VStack(alignment: .trailing, spacing: 6) {
                if let files = message.imageFiles, !files.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(files, id: \.self) { f in
                            if let image = ImageStore.nsImage(f) {
                                Image(nsImage: image).resizable().scaledToFill()
                                    .frame(width: files.count == 1 ? 220 : 110, height: files.count == 1 ? 160 : 90)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    .onTapGesture { NSWorkspace.shared.open(ImageStore.url(f)) }
                                    .help("Open image")
                            }
                        }
                    }
                }
                if !message.content.isEmpty { userText }
            }
        }
    }

    private var userText: some View {
        HStack {
            Text(message.content)
                .font(.system(size: 14))
                .lineSpacing(3)
                .foregroundStyle(Ember.text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16,
                                                   bottomTrailingRadius: 4, topTrailingRadius: 16)
                    .fill(Ember.bubble))
                .overlay(UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16,
                                                bottomTrailingRadius: 4, topTrailingRadius: 16)
                    .strokeBorder(Ember.accent.opacity(0.22)))
        }
    }

    private func assistant(_ p: (thinking: String, body: String)) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Ember.raised)
                    .frame(width: 22, height: 22)
                    .overlay(NetworkMark(top: true, lineWidth: 1.4).frame(width: 13, height: 13))
                Text(ModelNames.display(message.model ?? ""))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Ember.text.opacity(0.85))
                if let used = message.usedContext, !used.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "sparkles").font(.system(size: 9))
                        Text(used.joined(separator: " · "))
                    }
                    .font(.system(size: 11))
                    .foregroundStyle(Ember.accent.opacity(0.85))
                    .padding(.horizontal, 8)
                    .frame(height: 20)
                    .background(Capsule().fill(Ember.accent.opacity(0.1)))
                    .help("What the assistant used for this reply: skills and rules it opened, research it read, and commands in force (⚑)")
                }
                if !p.thinking.isEmpty {
                    Button {
                        withAnimation(.snappy) { showThinking.toggle() }
                    } label: {
                        HStack(spacing: 4) {
                            Text(thinkLabel(p))
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .rotationEffect(.degrees(showThinking ? 90 : 0))
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12))
                    .foregroundStyle(Ember.secondary)
                    .padding(.horizontal, 10)
                    .frame(height: 24)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
                }
            }
            if showThinking && !p.thinking.isEmpty {
                Text(p.thinking)
                    .font(.system(size: 12.5))
                    .lineSpacing(3)
                    .foregroundStyle(Ember.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Ember.hairline).frame(width: 2) }
            }
            if p.body.isEmpty && live {
                TypingDots()
            } else if !p.body.isEmpty {
                MarkdownView(text: p.body, failed: message.failed)
            }
            if !live && !p.body.isEmpty {
                HStack(spacing: 2) {
                    CopyButton(text: p.body)
                    if isLast {
                        Button(action: onRegenerate) {
                            Image(systemName: "arrow.clockwise").font(.system(size: 11))
                        }
                        .buttonStyle(IconButtonStyle())
                        .help("Regenerate")
                    }
                    if let tps = message.tokensPerSecond {
                        Text(stats(tps))
                            .font(.system(size: 11))
                            .foregroundStyle(Ember.secondary)
                            .padding(.leading, 6)
                    }
                }
                .foregroundStyle(Ember.text.opacity(0.72))
                .padding(.top, 2)
            }
        }
    }

    private var tool: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.snappy) { showOutput.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: message.toolIcon ?? "wrench")
                        .font(.system(size: 12))
                        .frame(width: 22, height: 22)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Ember.raised))
                    Text(message.denied ? "Denied: \(message.toolTitle ?? "")" : (message.toolTitle ?? "Tool"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(message.denied ? Ember.danger : Ember.text.opacity(0.85))
                    Text(message.toolDetail ?? "")
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(Ember.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Ember.tertiary)
                        .rotationEffect(.degrees(showOutput ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showOutput {
                ScrollView([.horizontal, .vertical]) {
                    Text(message.content)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(Ember.text.opacity(0.8))
                        .textSelection(.enabled)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
                .background(RoundedRectangle(cornerRadius: 8).fill(Ember.code))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.white.opacity(0.06)))
            }
        }
    }

    private func thinkLabel(_ p: (thinking: String, body: String)) -> String {
        if live && p.body.isEmpty { return "Thinking…" }
        if let s = message.thoughtSeconds { return "Thought for \(max(1, Int(s.rounded())))s" }
        return "Thoughts"
    }

    private func stats(_ tps: Double) -> String {
        if let s = message.seconds { return String(format: "%.0f tok/s · %.1fs", tps, s) }
        return String(format: "%.0f tok/s", tps)
    }
}

/// Some models put their reasoning inline as <think>…</think>; move it out of the reply.
enum ThinkSplitter {
    static func split(_ content: String, extra: String) -> (thinking: String, body: String) {
        var thinking = extra
        var body = content
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("<think>") {
            let rest = trimmed.dropFirst(7)
            if let end = rest.range(of: "</think>") {
                thinking += String(rest[..<end.lowerBound])
                body = String(rest[end.upperBound...])
            } else {
                thinking += String(rest)
                body = ""
            }
        }
        return (thinking.trimmingCharacters(in: .whitespacesAndNewlines),
                body.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

struct TypingDots: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.3, paused: false)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate / 0.3) % 3
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { n in
                    Circle()
                        .fill(Ember.secondary)
                        .frame(width: 6, height: 6)
                        .opacity(n == step ? 1 : 0.35)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct CopyButton: View {
    let text: String
    var label: String?
    @State private var copied = false

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 11))
                if let label { Text(copied ? "Copied" : label).font(.system(size: 12)) }
            }
        }
        .buttonStyle(IconButtonStyle())
        .help("Copy")
    }
}

// MARK: Markdown

enum MDBlock {
    case paragraph(String)
    case heading(String, Int)
    case bullet(String, String)
    case code(String, String)
}

enum Markdown {
    static func blocks(_ text: String) -> [MDBlock] {
        var out: [MDBlock] = []
        var paragraph: [String] = []
        var code: [String]?
        var language = ""

        func flush() {
            if !paragraph.isEmpty {
                out.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }

        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let c = code {
                    out.append(.code(language, c.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    code = []
                }
                continue
            }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty { flush(); continue }
            if let h = heading(line) { flush(); out.append(.heading(h.1, h.0)); continue }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
                flush(); out.append(.bullet(String(line.dropFirst(2)), "•")); continue
            }
            if let n = numbered(line) { flush(); out.append(.bullet(n.1, n.0)); continue }
            paragraph.append(raw)
        }
        if let c = code { out.append(.code(language, c.joined(separator: "\n"))) }
        flush()
        return out
    }

    static func heading(_ line: String) -> (Int, String)? {
        let hashes = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes), line.dropFirst(hashes).hasPrefix(" ") else { return nil }
        return (hashes, String(line.dropFirst(hashes + 1)))
    }

    static func numbered(_ line: String) -> (String, String)? {
        let digits = line.prefix(while: { $0.isNumber })
        guard !digits.isEmpty, line.dropFirst(digits.count).hasPrefix(". ") else { return nil }
        return (digits + ".", String(line.dropFirst(digits.count + 2)))
    }

    static func inline(_ s: String) -> AttributedString {
        var a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
        let codeRanges = a.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map(\.range)
        for r in codeRanges {
            a[r].swiftUI.font = .system(size: 12.5, design: .monospaced)
            a[r].swiftUI.backgroundColor = Color.white.opacity(0.08)
        }
        return a
    }
}

struct MarkdownView: View {
    let text: String
    var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Markdown.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let s):
                    Text(Markdown.inline(s))
                        .font(.system(size: 14))
                        .lineSpacing(4)
                        .foregroundStyle(failed ? Ember.warn : Ember.text.opacity(0.94))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .heading(let s, let level):
                    Text(Markdown.inline(s))
                        .font(.system(size: level == 1 ? 18 : level == 2 ? 16 : 14.5, weight: .semibold))
                        .foregroundStyle(Ember.text)
                        .padding(.top, 4)
                case .bullet(let s, let marker):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker).foregroundStyle(Ember.secondary).frame(minWidth: 14, alignment: .trailing)
                        Text(Markdown.inline(s))
                            .lineSpacing(4)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.system(size: 14))
                    .foregroundStyle(Ember.text.opacity(0.94))
                case .code(let language, let code):
                    CodeBlock(language: language, code: code)
                }
            }
        }
    }
}

struct CodeBlock: View {
    let language: String
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.system(size: 12))
                    .foregroundStyle(Ember.secondary)
                Spacer()
                CopyButton(text: code, label: "Copy").foregroundStyle(Ember.text.opacity(0.8))
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .frame(height: 32)
            .background(Color.white.opacity(0.03))
            Rectangle().fill(Ember.hairline).frame(height: 1)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(CodeHighlight.highlight(code, language: language))
                    .font(.system(size: 12.5, design: .monospaced))
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .fixedSize()
            }
        }
        .background(Ember.code)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.07)))
    }
}
