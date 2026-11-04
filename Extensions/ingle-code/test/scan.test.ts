// Pure logic: patterns, outlines, masking, paging, imports, grep parsing.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { languageById, matchDefinition, isTestFile, testStem } from '../src/engine/languages';
import { scanOutline, codeMask, scanCalls, looksLikeCall, enclosingFunction } from '../src/engine/scan';
import { paginate } from '../src/engine/util';
import { parseGrep, wordColumns } from '../src/engine/files';
import { parseImports, importsCovers } from '../src/engine/engine';

const swift = languageById('swift')!;
const ts = languageById('typescript')!;
const py = languageById('python')!;
const go = languageById('go')!;
const rust = languageById('rust')!;

test('definition patterns find declarations, not calls', () => {
  assert.equal(matchDefinition(swift, '    static func approvalScope(_ call: ToolCall) -> ApprovalScope {', 'approvalScope')?.kind, 'function');
  assert.equal(matchDefinition(swift, '    @MainActor private static func go() {', 'go')?.kind, 'function');
  assert.equal(matchDefinition(swift, '        let scope = MacTools.approvalScope(call)', 'approvalScope'), undefined);
  assert.equal(matchDefinition(swift, '/// see approvalScope', 'approvalScope'), undefined);
  const d = matchDefinition(ts, 'export function approvalScope(toolName: string): ApprovalScope {', 'approvalScope');
  assert.equal(d?.kind, 'function');
  assert.equal(d?.col, 16);
  assert.equal(matchDefinition(ts, '  async run(task: string): Promise<void> {', 'run')?.kind, 'method');
  assert.equal(matchDefinition(ts, '  run(() => {', 'run'), undefined, 'a call with a callback is not a method');
  assert.equal(matchDefinition(ts, '    const scope = approvalScope(a, b);', 'approvalScope'), undefined);
  assert.equal(matchDefinition(ts, '  if (ready) {'), undefined);
  assert.equal(matchDefinition(py, 'async def fetch(url):', 'fetch')?.kind, 'function');
  assert.equal(matchDefinition(go, 'func (s *Server) Start(ctx context.Context) error {', 'Start')?.kind, 'function');
  assert.equal(matchDefinition(rust, 'pub(crate) async fn load(path: &Path) -> Result<()> {', 'load')?.kind, 'function');
});

test('scan outline nests members and skips locals', () => {
  const src = [
    'enum MacTools {',
    '    static let names = ["a"]',
    '    static func approvalScope(_ call: ToolCall) -> String {',
    '        let key = "x { not a brace"',
    '        return key',
    '    }',
    '}',
    'func top() {}',
  ].join('\n');
  const o = scanOutline(src, swift);
  assert.deepEqual(o.map((s) => [s.name, s.kind, s.startLine, s.endLine, s.depth, s.container ?? '']), [
    ['MacTools', 'enum', 1, 7, 0, ''],
    ['names', 'variable', 2, 2, 1, 'MacTools'],
    ['approvalScope', 'function', 3, 6, 1, 'MacTools'],
    ['top', 'function', 8, 8, 0, ''],
  ]);
  assert.equal(enclosingFunction(o, 5)?.name, 'approvalScope');
});

test('python outline uses indentation', () => {
  const o = scanOutline('class A:\n    def f(self):\n        x = 1\n        return x\n\ndef g():\n    pass\n', py);
  assert.deepEqual(o.map((s) => [s.name, s.startLine, s.endLine, s.depth]), [['A', 1, 4, 0], ['f', 2, 4, 1], ['g', 6, 7, 0]]);
});

test('codeMask blanks comments and strings but keeps positions', () => {
  const src = 'let a = "{ x }" // }\nfoo(1) /* bar( */';
  const m = codeMask(src, ts);
  assert.equal(m.length, src.length);
  assert.equal(m.split('\n')[0].includes('{'), false);
  assert.equal(m.split('\n')[1].includes('foo('), true);
  assert.equal(m.split('\n')[1].includes('bar'), false);
});

test('interpolated code stays visible', () => {
  const sw = codeMask('let s = "Total: \\(cart.total()) done"', swift);
  assert.ok(sw.includes('cart.total()'));
  assert.ok(!sw.includes('Total:'));
  const js = codeMask('const s = `Total: ${cart.total({ a: 1 })} done`;', ts);
  assert.ok(js.includes('cart.total({ a: 1 })'));
  assert.ok(!js.includes('done'));
});

test('scanCalls lists calls in a body, not keywords', () => {
  const src = 'function total() {\n  if (x) { sub(); }\n  return discount(sub()); // fake()\n}\n';
  const calls = scanCalls(src, ts, 1, 4);
  assert.deepEqual([...calls.keys()].sort(), ['discount', 'sub']);
  assert.deepEqual(calls.get('sub'), [2, 3]);
  assert.equal(looksLikeCall('a = discount (1)', 'discount', 4), true);
  assert.equal(looksLikeCall('a = discount', 'discount', 4), false);
});

test('paginate clamps and reports ranges', () => {
  const p = paginate(Array.from({ length: 95 }, (_, i) => i), 3, 40);
  assert.deepEqual([p.page, p.pages, p.from, p.to, p.items.length], [3, 3, 81, 95, 15]);
  const q = paginate([], 5, 40);
  assert.deepEqual([q.page, q.pages, q.from, q.to], [1, 1, 0, 0]);
});

test('git grep -z output parses, including colons in text', () => {
  const hits = parseGrep('a/b.ts\u000012\u0000x: y\nc.swift\u00003\u0000z\n');
  assert.deepEqual(hits, [{ file: 'a/b.ts', line: 12, text: 'x: y' }, { file: 'c.swift', line: 3, text: 'z' }]);
  assert.deepEqual(wordColumns('ab abc ab_ ab', 'ab'), [0, 11]);
});

test('test files and stems', () => {
  assert.ok(isTestFile('Extensions/vscode/test/matcher.test.ts'));
  assert.ok(isTestFile('Tests/ShopTests/CartTests.swift'));
  assert.ok(isTestFile('pkg/server_test.go'));
  assert.ok(!isTestFile('src/engine/toolSelection.ts'));
  assert.equal(testStem('test/toolSelection.test.ts'), 'toolSelection');
  assert.equal(testStem('Tests/X/CartTests.swift'), 'Cart');
});

test('imports resolve to real paths, so a shared stem is not enough', () => {
  const imp = parseImports('Extensions/vscode/test/toolSelection.test.ts', "import { selectTools } from '../src/engine/toolSelection';\nconst x = require('./helpers.js');");
  assert.ok(importsCovers(imp, 'Extensions/vscode/src/engine/toolSelection.ts'));
  assert.ok(importsCovers(imp, 'Extensions/vscode/test/helpers.ts'));
  assert.ok(!importsCovers(imp, 'Extensions/ingle-code/src/engine/toolSelection.ts'));
  assert.ok(!importsCovers(imp, 'Sources/Ingle/ToolSelection.swift'));
  const sw = parseImports('Tests/ShopTests/CartTests.swift', '@testable import Shop\nimport XCTest');
  assert.ok(importsCovers(sw, 'Sources/Shop/Pricing.swift'));
  assert.ok(!importsCovers(sw, 'Sources/Other/Pricing.swift'));
  const p = parseImports('tests/test_api.py', 'from app.api import handler\nfrom . import util');
  assert.ok(importsCovers(p, 'app/api.py'));
});
