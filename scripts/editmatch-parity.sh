#!/bin/zsh
# Checks that the Mac app's EditMatch.swift and VS Code's editmatch.ts give the same result for every case in
# scripts/parity/editmatch-cases.json (start/end offsets, replacement, tolerant flag, "many" counts and the
# nearest-lines hint). Needs Xcode's swiftc and the extension's node_modules (npm install in Extensions/vscode).
set -e
here=${0:A:h}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$here/parity/editmatch-main.swift" "$tmp/main.swift"   # top-level code has to be in main.swift
swiftc -O -o "$tmp/editmatch" "$here/../Sources/Ingle/EditMatch.swift" "$tmp/main.swift"
"$tmp/editmatch" "$here/parity/editmatch-cases.json" > "$tmp/swift.json"
node "$here/parity/editmatch.js" "$here/parity/editmatch-cases.json" > "$tmp/ts.json"
node -e '
const [s, t, c] = process.argv.slice(1).map((f) => JSON.parse(require("fs").readFileSync(f, "utf8")));
const norm = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
let bad = 0;
c.forEach((k, i) => {
  const same = norm(s[i]) === norm(t[i]);
  if (!same) bad++;
  console.log((same ? "same  " : "DIFF  ") + k.name + "  →  " + (t[i].ok ? "replace " + t[i].start + "–" + t[i].end + (t[i].tolerant ? " (tolerant)" : "") : t[i].reason + (t[i].count ? " ×" + t[i].count : "")));
  if (!same) console.log("  swift: " + JSON.stringify(s[i]) + "\n  ts:    " + JSON.stringify(t[i]));
});
console.log(bad ? bad + " of " + c.length + " cases differ" : "All " + c.length + " cases match");
process.exit(bad ? 1 : 0);
' "$tmp/swift.json" "$tmp/ts.json" "$here/parity/editmatch-cases.json"
