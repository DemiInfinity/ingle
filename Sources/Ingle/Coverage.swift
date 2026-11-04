import AppKit
import SwiftUI

/// Coverage checks (task 34): the harness notices what was missed. When a run calls `impact` or `references` and
/// then changes code, the affected places are remembered. Before the model finishes, any affected file it neither
/// read (near an affected line) nor edited gets one nudge, sent with the command nudges (CommandTracker). Still
/// unvisited after that, with no reason given, the reply gets the ⚠ chip. On at High/Max effort, in Debug mode, or
/// when a command says `must_use: coverage`. Same rules as coverage.ts in the VS Code extension (tested there).
struct Coverage {
    /// One affected place: a project-relative path and a 1-based line.
    struct Place: Codable, Equatable, Hashable {
        var path: String
        var line: Int
        var text: String { "\(path):\(line)" }
    }

    struct Read { var path: String; var start: Int?; var end: Int? }

    /// What a reply keeps for its ⚠ chip: the project and the places never looked at.
    struct Chip: Codable, Equatable {
        var root: String
        var places: [Place]
    }

    /// Tools whose results name affected places.
    static let sources: Set<String> = ["impact", "references"]
    /// A read this many lines either side of an affected line still counts as looking at it.
    private static let margin = 3
    /// Places listed in the nudge (the chip lists them all).
    private static let listInNudge = 8

    let root: String
    private(set) var symbols: [String] = []
    private(set) var places: [Place] = []
    /// Code changed after the first lookup: only then is coverage checked.
    private(set) var changed = false
    private(set) var reads: [Read] = []
    private(set) var edited: [String] = []
    private(set) var nudged = false
    /// What the model said after the nudge (a stated reason resolves it).
    private var said = ""

    init(root: String) { self.root = root }

    /// Is coverage checking on for this run? High/Max effort, Debug mode, or a command requiring it.
    static func isOn(effort: EffortLevel, mode: WorkMode, forced: Bool) -> Bool {
        forced || mode == .debug || effort.coverage
    }

    /// Project-relative path, or nil outside the project.
    func rel(_ p: String) -> String? {
        var s: String = p.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("./") { s = String(s.dropFirst(2)) }
        if s.isEmpty { return nil }
        let full: String = s.hasPrefix("/") ? s : (s.hasPrefix("~") ? (s as NSString).expandingTildeInPath : root + "/" + s)
        let std: String = (full as NSString).standardizingPath
        let base: String = (root as NSString).standardizingPath
        guard std.hasPrefix(base + "/") else { return nil }
        return String(std.dropFirst(base.count + 1))
    }

    /// The symbols an impact/references call was about: its `symbol` argument, or the ones the tool picked from the
    /// working set (named in brackets on the output's first line).
    static func symbols(of call: ToolCall, output: String) -> [String] {
        let s: String = call.arg("symbol").trimmingCharacters(in: .whitespaces)
        if !s.isEmpty { return [s] }
        let first: String = output.components(separatedBy: "\n").first ?? ""
        let changedPrefix = "(no symbol named: using what the uncommitted changes touch — "
        let selPrefix = "(no symbol named: using the selection, "
        for prefix in [changedPrefix, selPrefix] where first.hasPrefix(prefix) && first.hasSuffix(")") {
            let inner: String = String(first.dropFirst(prefix.count).dropLast())
            return inner.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        return []
    }

    /// Remembers the places a lookup found (paths relative to the project, or absolute inside it).
    mutating func add(symbol: String, places found: [(path: String, line: Int)]) {
        if !symbol.isEmpty, !symbols.contains(symbol) { symbols.append(symbol) }
        for p in found {
            guard let r = rel(p.path), p.line > 0 else { continue }
            let place = Place(path: r, line: p.line)
            if !places.contains(place) { places.append(place) }
        }
    }

    /// Records one call that ran (denied calls don't count): reads, edits, and whether code changed after a lookup.
    /// The Mac's read_file always reads the whole file, but ranges are honoured if given (as in VS Code).
    mutating func record(_ call: ToolCall, succeeded: Bool) {
        guard succeeded else { return }
        switch call.name {
        case "edit_file", "write_file":
            if let r = rel(call.arg("path")), !edited.contains(r) { edited.append(r) }
            if !symbols.isEmpty { changed = true }
        case "read_file", "read_exhaustively":
            if let r = rel(call.arg("path")) { reads.append(Read(path: r, start: Int(call.arg("start_line")), end: Int(call.arg("end_line")))) }
        case "outline":
            if let r = rel(call.arg("file")) { reads.append(Read(path: r, start: nil, end: nil)) }
        case "definition":
            // Only a position (file:line[:col]) shows a particular place; a name shows the definition, not the uses.
            let parts: [String] = call.arg("symbol").trimmingCharacters(in: .whitespaces).components(separatedBy: ":")
            if parts.count >= 2, let line = Int(parts[1]), parts.count <= 3, let r = rel(parts[0]) {
                reads.append(Read(path: r, start: line, end: line))
            }
        default:
            break
        }
    }

    /// Affected places in files the run neither edited nor read near an affected line.
    var unvisited: [Place] {
        var order: [String] = []
        var byFile: [String: [Place]] = [:]
        for p in places {
            if byFile[p.path] == nil { order.append(p.path) }
            byFile[p.path, default: []].append(p)
        }
        var out: [Place] = []
        for file in order where !edited.contains(file) {
            let list: [Place] = byFile[file] ?? []
            let looked: Bool = reads.contains { r in
                r.path == file && list.contains { p in
                    let afterStart: Bool = r.start.map { p.line >= $0 - Self.margin } ?? true
                    let beforeEnd: Bool = r.end.map { p.line <= $0 + Self.margin } ?? true
                    return afterStart && beforeEnd
                }
            }
            if !looked { out += list }
        }
        return out
    }

    /// The nudge item (joined to the command nudges' list), or nil when nothing's left or it was already sent.
    /// Sent once per run. Same wording as coverageNudge in coverage.ts.
    mutating func nudge() -> String? {
        guard !nudged, changed else { return nil }
        let left: [Place] = unvisited
        guard !left.isEmpty else { return nil }
        nudged = true
        let n: Int = left.count
        let shown: String = left.prefix(Self.listInNudge).map(\.text).joined(separator: ", ")
        let more: String = n > Self.listInNudge ? " and \(n - Self.listInNudge) more" : ""
        let what: String = symbols.map { "`\($0)`" }.joined(separator: ", ")
        let uses: String = n == 1 ? "place that uses" : "places that use"
        let check: String = n == 1 ? "it" : "them"
        let why: String = n == 1 ? "it doesn’t" : "they don’t"
        return "You changed \(what) but didn't look at \(n) \(uses) it: \(shown)\(more). Check \(check) (read_file or edit_file), or say why \(why) need changing."
    }

    /// Notes what the model said (after the nudge, it may give a reason instead of looking).
    mutating func noteReply(_ text: String) {
        if nudged, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { said += "\n" + text }
    }

    /// Does this text say why places don't need changing ("they only log the value")? Same as statesReason in
    /// coverage.ts.
    static func statesReason(_ text: String) -> Bool {
        let t: String = text.lowercased().replacingOccurrences(of: "’", with: "'").replacingOccurrences(of: "‘", with: "'")
        let verbs = "log|logs|read|reads|print|prints|display|displays|pass|passes|mention|mentions|use|uses|refer|refers|import|imports|test|tests|wrap|wraps|forward|forwards|call|calls"
        let pattern: String = "\\b(because|since (they|it|those|these|that)|only (\(verbs))|(don't|doesn't|do not|does not|won't|will not|no) (need|needs) (to )?(be )?chang|not affected|unaffected|unrelated|no change(s)? (is |are )?needed|(still|already) (correct|works|work|valid|compatible)|(don't|doesn't|do not|does not) (use|call|depend|touch))"
        return t.range(of: pattern, options: .regularExpression) != nil
    }

    /// Places still unchecked at the end of the run, for the ⚠ chip ([] when covered or a reason was given).
    var left: [Place] {
        guard nudged else { return [] }
        let u: [Place] = unvisited
        if u.isEmpty || Self.statesReason(said) { return [] }
        return u
    }

    /// The chip's words.
    static func chip(_ n: Int) -> String {
        "⚠ \(n) affected \(n == 1 ? "place" : "places") not checked"
    }

    /// Opens one place: VS Code at the line when it's installed, else the default app. Task 39's previewer can take
    /// this over (Preview.open) for files it shows.
    static func open(_ place: Place, root: String) {
        let path: String = root + "/" + place.path
        guard FileManager.default.fileExists(atPath: path) else { return }
        if ChangesPanel.editorApp != nil,
           let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
           let url = URL(string: "vscode://file\(encoded):\(place.line)") {
            NSWorkspace.shared.open(url)
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }
}

/// "⚠ N affected places not checked" under a reply; click to list them, click one to open it at its line.
struct CoverageChipView: View {
    let chip: Coverage.Chip
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(Coverage.chip(chip.places.count))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
            }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            .foregroundStyle(Ember.warn)
            .padding(.horizontal, 8)
            .frame(height: 20)
            .background(Capsule().fill(Ember.warn.opacity(0.12)))
            .overlay(Capsule().strokeBorder(Ember.warn.opacity(0.3)))
            .help("Places the change could affect that the assistant never looked at")
            .accessibilityLabel(Coverage.chip(chip.places.count))
            if open {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(chip.places, id: \.self) { place in
                        Button {
                            Coverage.open(place, root: chip.root)
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "doc.text").font(.system(size: 10)).foregroundStyle(Ember.secondary)
                                Text(place.text).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Ember.text)
                                    .lineLimit(1).truncationMode(.middle)
                            }
                        }
                        .buttonStyle(.plain)
                        .help("Open \(place.path) at line \(place.line)")
                    }
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Ember.warn.opacity(0.3)).frame(width: 2) }
            }
        }
    }
}
