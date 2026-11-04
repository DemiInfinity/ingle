// Runs Extensions/vscode/src/tools/editmatch.ts on the cases file and prints the results as JSON (see editmatch-parity.sh).
const fs = require('fs');
const path = require('path');
const ts = require(path.join(__dirname, '../../Extensions/vscode/node_modules/typescript'));
const src = fs.readFileSync(path.join(__dirname, '../../Extensions/vscode/src/tools/editmatch.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = cases.map((c) => {
  const p = mod.exports.planEdit(c.text, c.old, c.new);
  if (p.ok) return { ok: true, start: p.start, end: p.end, replacement: p.replacement, tolerant: p.tolerant, result: c.text.slice(0, p.start) + p.replacement + c.text.slice(p.end) };
  return p.reason === 'many' ? { ok: false, reason: 'many', count: p.count } : { ok: false, reason: 'none', nearest: p.nearest ?? '' };
});
process.stdout.write(JSON.stringify(out));
