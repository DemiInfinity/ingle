import Foundation

/// Finding old_text for edit_file: exact first, then tolerant of CRLF and trailing spaces. Pure.
/// A port of Extensions/vscode/src/tools/editmatch.ts — keep the two in step. It works on UTF-16 code units,
/// like JavaScript strings, so offsets and comparisons are the same in both apps (Swift's own String compares
/// by canonical equivalence, which would differ). `scripts/editmatch-parity.sh` checks them against each other.
enum EditMatch {
    typealias U = [UInt16]

    enum Plan: Equatable {
        /// Offsets are UTF-16 offsets into the file's text.
        case ok(start: Int, end: Int, replacement: String, tolerant: Bool)
        case many(count: Int)
        case none(nearest: String)
    }

    private static let lf: UInt16 = 10
    private static let cr: UInt16 = 13

    private static func u(_ s: String) -> U { Array(s.utf16) }
    private static func s(_ a: U) -> String { String(decoding: a, as: UTF16.self) }
    private static func s(_ a: ArraySlice<UInt16>) -> String { String(decoding: a, as: UTF16.self) }

    private static func hasCRLF(_ t: U) -> Bool {
        guard t.count > 1 else { return false }
        for i in 0..<(t.count - 1) where t[i] == cr && t[i + 1] == lf { return true }
        return false
    }

    /// /\r\n|\n/g → eol
    private static func toEol(_ t: U, _ eol: U) -> U {
        var out = U()
        out.reserveCapacity(t.count)
        var i = 0
        while i < t.count {
            if t[i] == cr, i + 1 < t.count, t[i + 1] == lf { out += eol; i += 2 }
            else if t[i] == lf { out += eol; i += 1 }
            else { out.append(t[i]); i += 1 }
        }
        return out
    }

    /// JavaScript's indexOf, including its clamping for an empty needle.
    private static func indexOf(_ hay: U, _ needle: U, from: Int) -> Int {
        let start = min(max(0, from), hay.count)
        if needle.isEmpty { return start }
        guard needle.count <= hay.count else { return -1 }
        let first = needle[0]
        var i = start
        while i + needle.count <= hay.count {
            if hay[i] == first {
                var j = 1
                while j < needle.count && hay[i + j] == needle[j] { j += 1 }
                if j == needle.count { return i }
            }
            i += 1
        }
        return -1
    }

    private static func countAll(_ hay: U, _ needle: U) -> [Int] {
        var at: [Int] = []
        var i = indexOf(hay, needle, from: 0)
        while i >= 0 && at.count < 50 {
            at.append(i)
            i = indexOf(hay, needle, from: i + max(1, needle.count))
        }
        return at
    }

    /// Spaces and tabs at the end (/[ \t]+$/).
    private static func rt(_ a: U) -> U {
        var end = a.count
        while end > 0 && (a[end - 1] == 32 || a[end - 1] == 9) { end -= 1 }
        return Array(a[0..<end])
    }

    /// The characters JavaScript's trim() and \s treat as white space.
    static func isJSSpace(_ c: UInt16) -> Bool {
        switch c {
        case 9, 10, 11, 12, 13, 32, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        case 0x2000...0x200A: return true
        default: return false
        }
    }

    private static func trim(_ a: U) -> U {
        var s = 0, e = a.count
        while s < e && isJSSpace(a[s]) { s += 1 }
        while e > s && isJSSpace(a[e - 1]) { e -= 1 }
        return Array(a[s..<e])
    }

    private static func hasPrefix(_ a: U, _ p: U) -> Bool { p.count <= a.count && Array(a[0..<p.count]) == p }
    private static func hasSuffix(_ a: U, _ p: U) -> Bool { p.count <= a.count && Array(a[(a.count - p.count)...]) == p }

    private static func split(_ a: U, _ sep: UInt16) -> [U] {
        var out: [U] = []
        var cur = U()
        for c in a {
            if c == sep { out.append(cur); cur = [] } else { cur.append(c) }
        }
        out.append(cur)
        return out
    }

    /// Where to replace old_text with new_text in `text`. new_text is converted to the file's line endings.
    static func plan(_ text: String, old oldText: String, new newText: String) -> Plan {
        let t: U = u(text)
        let o0: U = u(oldText)
        let n0: U = u(newText)
        let eol: U = hasCRLF(t) ? [cr, lf] : [lf]
        let crlf: Bool = eol.count == 2
        // 1. Exact, and exact after matching the file's line endings.
        let pairs: [(U, U)] = [(o0, n0), (toEol(o0, eol), toEol(n0, eol))]
        for (o, n) in pairs {
            let hits: [Int] = countAll(t, o)
            if hits.count == 1 {
                let rep: U = crlf ? toEol(n, eol) : n
                return .ok(start: hits[0], end: hits[0] + o.count, replacement: s(rep), tolerant: o != o0)
            }
            if hits.count > 1 { return .many(count: hits.count) }
        }
        // 2. Line by line, ignoring trailing whitespace and \r. The first line may start mid-line,
        //    the last may end mid-line.
        var oldN: U = toEolCRLFOnly(o0)
        var newN: U = toEolCRLFOnly(n0)
        if oldN.last == lf {
            while oldN.last == lf { oldN.removeLast() }
            if newN.last == lf { newN.removeLast() }
        }
        let oldLines: [U] = split(oldN, lf)
        if trim(oldN).isEmpty { return .none(nearest: "") }

        var lines: [(start: Int, text: U)] = []
        var pos = 0
        for raw in split(t, lf) {
            let txt: U = raw.last == cr ? Array(raw.dropLast()) : raw
            lines.append((pos, txt))
            pos += raw.count + 1
        }
        var found: [(Int, Int)] = []
        let k = oldLines.count
        var i = 0
        while i + k <= lines.count && found.count < 2 {
            var ok = true
            var start = lines[i].start
            var end = 0
            var j = 0
            while j < k && ok {
                let fl: U = lines[i + j].text
                let ol: U = oldLines[j]
                if k == 1 {
                    if rt(fl) == rt(ol) { start = lines[i].start; end = lines[i].start + fl.count } else { ok = false }
                } else if j == 0 {
                    let f: U = rt(fl), o: U = rt(ol)
                    if o.isEmpty ? f.isEmpty : hasSuffix(f, o) {
                        start = lines[i].start + (o.isEmpty ? 0 : f.count - o.count)
                    } else { ok = false }
                } else if j == k - 1 {
                    if rt(fl) == rt(ol) { end = lines[i + j].start + fl.count }
                    else if !ol.isEmpty && hasPrefix(fl, ol) { end = lines[i + j].start + ol.count }
                    else { ok = false }
                } else if rt(fl) != rt(ol) { ok = false }
                j += 1
            }
            if ok { found.append((start, end)) }
            i += 1
        }
        if found.count == 1 {
            return .ok(start: found[0].0, end: found[0].1, replacement: s(toEol(newN, eol)), tolerant: true)
        }
        if found.count > 1 { return .many(count: found.count) }
        return .none(nearest: nearestLines(text, oldLines: oldLines.map(s)))
    }

    /// .replace(/\r\n/g, '\n')
    private static func toEolCRLFOnly(_ t: U) -> U {
        var out = U()
        out.reserveCapacity(t.count)
        var i = 0
        while i < t.count {
            if t[i] == cr, i + 1 < t.count, t[i + 1] == lf { out.append(lf); i += 2 }
            else { out.append(t[i]); i += 1 }
        }
        return out
    }

    /// `text` with the plan applied (UTF-16 offsets).
    static func apply(_ text: String, start: Int, end: Int, replacement: String) -> String {
        let t: U = u(text)
        return s(t[0..<start]) + replacement + s(t[end...])
    }

    // MARK: Nearest lines for "not found"

    private static func bigrams(_ a: String) -> [UInt32: Int] {
        // .replace(/\s+/g, ' ').trim().toLowerCase()
        var squeezed = U()
        var inSpace = false
        for c in u(a) {
            if isJSSpace(c) { if !inSpace { squeezed.append(32) }; inSpace = true } else { squeezed.append(c); inSpace = false }
        }
        let t: U = u(s(trim(squeezed)).lowercased())
        var m: [UInt32: Int] = [:]
        if t.count < 2 { return m }
        for i in 0..<(t.count - 1) {
            let g: UInt32 = (UInt32(t[i]) << 16) | UInt32(t[i + 1])
            m[g, default: 0] += 1
        }
        return m
    }

    private static func similarity(_ a: String, _ b: String) -> Double {
        let A = bigrams(a), B = bigrams(b)
        var inter = 0, total = 0
        for (g, c) in A { inter += min(c, B[g] ?? 0); total += c }
        for c in B.values { total += c }
        return total > 0 ? Double(2 * inter) / Double(total) : 0
    }

    /// The numbered lines of `text` that look most like the old_text, for the "not found" message.
    static func nearestLines(_ text: String, oldLines: [String]) -> String {
        let lines: [String] = split(toEolCRLFOnly(u(text)), lf).map(s)
        let probe: String = oldLines.first(where: { trim(u($0)).count > 2 }) ?? oldLines.first ?? ""
        let offset: Int = max(0, oldLines.firstIndex(of: probe) ?? -1)
        let probeTrim: U = trim(u(probe))
        if probeTrim.isEmpty { return "" }
        var best = -1
        var bestScore: Double = 0
        let limit = min(lines.count, 20_000)
        for i in 0..<limit {
            let score: Double = trim(u(lines[i])) == probeTrim ? 2 : similarity(lines[i], probe)
            if score > bestScore { bestScore = score; best = i }
        }
        if best < 0 || bestScore < 0.35 { return "" }
        let from = max(0, best - offset - 1)
        let to = min(lines.count, from + oldLines.count + 3)
        return (from..<to).map { "\($0 + 1)\t\(lines[$0])" }.joined(separator: "\n")
    }
}

/// A small line diff (LCS on the changed middle) that prints a compact unified diff. Pure.
/// Same as Extensions/vscode/src/tools/diff.ts.
enum LineDiff {
    struct Op { let t: Character; let s: String; let a: Int; let b: Int }

    static func splitLines(_ text: String) -> [String] {
        if text.isEmpty { return [] }
        var lines: [String] = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        if lines.count > 1 && lines.last == "" { lines.removeLast() }
        return lines
    }

    static func ops(_ a: [String], _ b: [String]) -> [Op] {
        var pre = 0
        while pre < a.count && pre < b.count && a[pre] == b[pre] { pre += 1 }
        var suf = 0
        while suf < a.count - pre && suf < b.count - pre && a[a.count - 1 - suf] == b[b.count - 1 - suf] { suf += 1 }
        var out: [Op] = []
        for i in 0..<pre { out.append(Op(t: " ", s: a[i], a: i + 1, b: i + 1)) }
        let am: [String] = Array(a[pre..<(a.count - suf)])
        let bm: [String] = Array(b[pre..<(b.count - suf)])
        let n = am.count, m = bm.count
        if n * m > 4_000_000 {
            for (i, s) in am.enumerated() { out.append(Op(t: "-", s: s, a: pre + i + 1, b: pre + 1)) }
            for (j, s) in bm.enumerated() { out.append(Op(t: "+", s: s, a: pre + n + 1, b: pre + j + 1)) }
        } else {
            let w = m + 1
            var dp = [UInt32](repeating: 0, count: (n + 1) * w)
            if n > 0 && m > 0 {
                for i in stride(from: n - 1, through: 0, by: -1) {
                    for j in stride(from: m - 1, through: 0, by: -1) {
                        dp[i * w + j] = am[i] == bm[j] ? dp[(i + 1) * w + j + 1] + 1 : max(dp[(i + 1) * w + j], dp[i * w + j + 1])
                    }
                }
            }
            var i = 0, j = 0
            while i < n || j < m {
                if i < n && j < m && am[i] == bm[j] {
                    out.append(Op(t: " ", s: am[i], a: pre + i + 1, b: pre + j + 1)); i += 1; j += 1
                } else if i < n && (j >= m || dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
                    out.append(Op(t: "-", s: am[i], a: pre + i + 1, b: pre + j + 1)); i += 1
                } else {
                    out.append(Op(t: "+", s: bm[j], a: pre + i + 1, b: pre + j + 1)); j += 1
                }
            }
        }
        for k in 0..<suf {
            let ai = a.count - suf + k, bi = b.count - suf + k
            out.append(Op(t: " ", s: a[ai], a: ai + 1, b: bi + 1))
        }
        return out
    }

    /// Unified diff with `context` lines around each change. "" when the texts are the same.
    static func unified(_ oldText: String, _ newText: String, name: String = "file", context: Int = 3, maxChars: Int = 8000) -> String {
        let list: [Op] = ops(splitLines(oldText), splitLines(newText))
        let changed: [Int] = list.indices.filter { list[$0].t != " " }
        if changed.isEmpty { return "" }
        var hunks: [(Int, Int)] = []
        for i in changed {
            let s = max(0, i - context), e = min(list.count - 1, i + context)
            if let last = hunks.last, s <= last.1 + 1 { hunks[hunks.count - 1].1 = max(last.1, e) } else { hunks.append((s, e)) }
        }
        var out: [String] = ["--- a/\(name)", "+++ b/\(name)"]
        for (s, e) in hunks {
            let part: [Op] = Array(list[s...e])
            let oldCount: Int = part.filter { $0.t != "+" }.count
            let newCount: Int = part.filter { $0.t != "-" }.count
            let oldStart: Int = oldCount > 0 ? part.first(where: { $0.t != "+" })!.a : max(0, part[0].a - 1)
            let newStart: Int = newCount > 0 ? part.first(where: { $0.t != "-" })!.b : max(0, part[0].b - 1)
            out.append("@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@")
            for o in part { out.append(String(o.t) + o.s) }
        }
        var text: String = out.joined(separator: "\n")
        if text.count > maxChars { text = String(text.prefix(maxChars)) + "\n…(diff trimmed)" }
        return text
    }

    /// Lines added and removed.
    static func stats(_ oldText: String, _ newText: String) -> (added: Int, removed: Int) {
        let list: [Op] = ops(splitLines(oldText), splitLines(newText))
        return (list.filter { $0.t == "+" }.count, list.filter { $0.t == "-" }.count)
    }
}
