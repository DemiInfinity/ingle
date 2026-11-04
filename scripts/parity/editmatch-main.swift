// Runs Sources/Ingle/EditMatch.swift on the cases file and prints the results as JSON (see editmatch-parity.sh).
import Foundation

let data = FileManager.default.contents(atPath: CommandLine.arguments[1])!
let cases = try! JSONSerialization.jsonObject(with: data) as! [[String: String]]
var out: [[String: Any]] = []
for c in cases {
    switch EditMatch.plan(c["text"]!, old: c["old"]!, new: c["new"]!) {
    case .ok(let start, let end, let replacement, let tolerant):
        out.append(["ok": true, "start": start, "end": end, "replacement": replacement, "tolerant": tolerant,
                    "result": EditMatch.apply(c["text"]!, start: start, end: end, replacement: replacement)])
    case .many(let count): out.append(["ok": false, "reason": "many", "count": count])
    case .none(let nearest): out.append(["ok": false, "reason": "none", "nearest": nearest])
    }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]))
