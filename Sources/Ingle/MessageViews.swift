import SwiftUI
import AppKit

// MARK: One message

struct MessageRow: View {
    let message: ChatMessage
    let isLast: Bool
    let streaming: Bool
    let onRegenerate: () -> Void
    /// "Undo this run" (force = "Undo anyway"): nil when done, else why not and whether it can be forced.
    var onUndo: ((Bool) -> (message: String, canForce: Bool)?)? = nil

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
            let shown: Bool = !p.body.isEmpty || !p.thinking.isEmpty || live || message.toolCalls.isEmpty
            if let cp = message.checkpoint, !cp.files.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    if shown { assistant(p) }
                    UndoRunBar(checkpoint: cp, busy: streaming, onUndo: onUndo)
                }
            } else if shown {
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

// MARK: Diffs in the approval card (edit_file, write_file over an existing file)

/// The change an edit_file or write_file call would make, shown in its approval card as a unified diff,
/// with Side by Side opening the whole file in a sheet. Worked out when the card appears (nothing is written).
struct ApprovalDiff: View {
    let pendingID: UUID
    let call: ToolCall
    let folder: String?
    @State private var preview: CodeTools.Preview?
    @State private var unified = ""
    @State private var stats: (added: Int, removed: Int) = (0, 0)
    @State private var showSideBySide = false

    var body: some View {
        Group {
            if let preview, !unified.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("−\(stats.removed) +\(stats.added) lines")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Ember.secondary)
                        Spacer()
                        Button("Side by Side") { showSideBySide = true }
                            .controlSize(.small)
                    }
                    ScrollView([.vertical, .horizontal]) {
                        DiffText(unified: unified)
                            .padding(10)
                    }
                    // Short diffs sit top-left instead of centred; long ones scroll.
                    .defaultScrollAnchor(.topLeading)
                    .frame(minHeight: min(CGFloat(unified.components(separatedBy: "\n").count) * 16 + 20, 140), maxHeight: 260)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Ember.code))
                }
                .sheet(isPresented: $showSideBySide) {
                    SideBySideDiff(preview: preview) { showSideBySide = false }
                }
            } else {
                // A real (empty) view: `.task` never runs on a Group with nothing in it.
                Color.clear.frame(height: 0)
            }
        }
        .task(id: pendingID) {
            let found: CodeTools.Preview? = CodeTools.preview(call, folder: folder)
            preview = found
            if let found {
                unified = LineDiff.unified(found.original, found.proposed, name: found.name)
                stats = LineDiff.stats(found.original, found.proposed)
            }
        }
    }
}

/// A unified diff with removed lines red and added lines green.
struct DiffText: View {
    let unified: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(unified.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? " " : line)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(color(line))
                    .padding(.horizontal, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(background(line))
            }
        }
        .textSelection(.enabled)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func color(_ line: String) -> Color {
        if line.hasPrefix("@@") { return Ember.accent }
        if line.hasPrefix("+++") || line.hasPrefix("---") { return Ember.secondary }
        if line.hasPrefix("+") { return Color(hex: 0x9BE29B) }
        if line.hasPrefix("-") { return Ember.danger }
        return Ember.text.opacity(0.8)
    }

    private func background(_ line: String) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") { return .clear }
        if line.hasPrefix("+") { return Color.green.opacity(0.12) }
        if line.hasPrefix("-") { return Color.red.opacity(0.12) }
        return .clear
    }
}

/// The whole file before and after, side by side, with changed lines highlighted.
struct SideBySideDiff: View {
    let preview: CodeTools.Preview
    let done: () -> Void

    private struct Row: Identifiable {
        let id: Int
        let left: (Int, String)?
        let right: (Int, String)?
        let changed: Bool
    }

    private var rows: [Row] {
        let ops: [LineDiff.Op] = LineDiff.ops(LineDiff.splitLines(preview.original), LineDiff.splitLines(preview.proposed))
        var out: [Row] = []
        var i = 0
        while i < ops.count {
            if ops[i].t == " " {
                out.append(Row(id: out.count, left: (ops[i].a, ops[i].s), right: (ops[i].b, ops[i].s), changed: false))
                i += 1
                continue
            }
            // A run of removals and additions: pair them up line by line.
            var removed: [LineDiff.Op] = []
            var added: [LineDiff.Op] = []
            while i < ops.count && ops[i].t != " " {
                if ops[i].t == "-" { removed.append(ops[i]) } else { added.append(ops[i]) }
                i += 1
            }
            for k in 0..<max(removed.count, added.count) {
                let l: (Int, String)? = k < removed.count ? (removed[k].a, removed[k].s) : nil
                let r: (Int, String)? = k < added.count ? (added[k].b, added[k].s) : nil
                out.append(Row(id: out.count, left: l, right: r, changed: true))
            }
        }
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(preview.name).font(.system(size: 13, weight: .semibold, design: .monospaced))
                Spacer()
                Button("Done", action: done).keyboardShortcut(.defaultAction)
            }
            .padding(12)
            Divider()
            HStack(spacing: 0) {
                Text("Before").frame(maxWidth: .infinity, alignment: .leading)
                Text("After").frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Ember.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { row in
                        HStack(spacing: 0) {
                            cell(row.left, changed: row.changed, added: false)
                            Rectangle().fill(Ember.hairline).frame(width: 1)
                            cell(row.right, changed: row.changed, added: true)
                        }
                    }
                }
                .textSelection(.enabled)
            }
            .background(Ember.code)
        }
        .frame(minWidth: 900, minHeight: 560)
        .background(Ember.surface)
    }

    private func cell(_ line: (Int, String)?, changed: Bool, added: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(line.map { String($0.0) } ?? "")
                .foregroundStyle(Ember.tertiary)
                .frame(width: 44, alignment: .trailing)
            Text(line?.1 ?? "")
                .foregroundStyle(Ember.text.opacity(0.9))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(.vertical, 1)
        .padding(.trailing, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(line == nil ? Color.clear : (changed ? (added ? Color.green.opacity(0.13) : Color.red.opacity(0.13)) : Color.clear))
    }
}

// MARK: Undo this run

/// Under the last reply of a run that changed files: "Undo this run", with a preview of what it will put back.
struct UndoRunBar: View {
    let checkpoint: RunCheckpoint
    let busy: Bool
    let onUndo: ((Bool) -> (message: String, canForce: Bool)?)?

    @State private var open = false
    @State private var refusal: (message: String, canForce: Bool)?

    private var count: String { "\(checkpoint.files.count) file\(checkpoint.files.count == 1 ? "" : "s")" }

    var body: some View {
        if checkpoint.undone == true {
            HStack(spacing: 5) {
                Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold))
                Text("Run undone · \(count) put back")
            }
            .font(.system(size: 11.5))
            .foregroundStyle(Ember.secondary)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    withAnimation(.snappy) { open.toggle(); refusal = nil }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.uturn.backward").font(.system(size: 10, weight: .semibold))
                        Text("Undo this run · \(count)")
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .font(.system(size: 11.5))
                    .foregroundStyle(Ember.secondary)
                    .padding(.horizontal, 10)
                    .frame(height: 24)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .help("Put back every file this run changed")
                if open { preview }
            }
        }
    }

    private var preview: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(checkpoint.files, id: \.path) { f in
                    HStack(spacing: 8) {
                        Text(verb(f.action))
                            .foregroundStyle(f.action == .remove ? Ember.danger : Ember.secondary)
                            .frame(width: 78, alignment: .leading)
                        Text((f.path as NSString).abbreviatingWithTildeInPath)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(Ember.text)
                            .lineLimit(1)
                            .truncationMode(.head)
                            .help(f.path)
                    }
                    .font(.system(size: 11.5))
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.04)))
            Text(Checkpoints.notCovered)
                .font(.system(size: 11))
                .foregroundStyle(Ember.secondary)
            if let refusal {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11))
                    Text(refusal.message).textSelection(.enabled)
                }
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(Ember.warn)
            }
            HStack(spacing: 8) {
                if let refusal, refusal.canForce {
                    Button("Undo Anyway") { undo(force: true) }
                        .buttonStyle(.borderedProminent)
                } else {
                    Button("Undo") { undo(force: false) }
                        .buttonStyle(.borderedProminent)
                }
                Button("Cancel") { withAnimation(.snappy) { open = false; refusal = nil } }
            }
            .controlSize(.regular)
            .disabled(busy)
        }
    }

    private func verb(_ a: Checkpoints.Action) -> String {
        switch a {
        case .restore: return "Put back"
        case .remove: return "Remove"
        case .recreate: return "Bring back"
        }
    }

    private func undo(force: Bool) {
        refusal = onUndo?(force)
        if refusal == nil { open = false }
    }
}
