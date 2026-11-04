import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultsFor, impactLocations, loadEngineLib, mentionedFiles, parseDiffHunks, runCodeIntel, symbolFromSelection,
  symbolsInRanges, workingSetFiles, changedSymbols, type WorkingSet,
} from '../src/tools/codeintelCore';
import { selectTools, type SelectableTool } from '../src/engine/toolSelection';
import { allowedInPlanMode } from '../src/tools/tasks';

// out-test/test → Extensions/vscode → Extensions
const EXTENSIONS = path.resolve(__dirname, '..', '..', '..');
const REPO = path.resolve(EXTENSIONS, '..');
const FIXTURE = path.join(EXTENSIONS, 'ingle-code', 'test', 'fixtures', 'ts-shop');
const EMPTY: WorkingSet = { open: [], changed: [], mentioned: [] };
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function copyFixture(git: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-codeintel-'));
  made.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (git) {
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q'); g('add', '.'); g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x');
  }
  return fs.realpathSync(dir);
}

function engine(root: string) {
  const lib = loadEngineLib();
  assert.ok(lib, 'vendor/ingle-code is built (scripts/build-engine.js)');
  return new lib.CodeEngine({ root, noServers: true });
}

// MARK: pure parts

test('git diff hunks become changed line ranges', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@ x', '+one', '+two', '@@ -10 +12 @@', '-old', '+new', '@@ -20,3 +21,0 @@', '-gone',
    'diff --git a/old.ts b/old.ts', '--- a/old.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@',
  ].join('\n');
  const h = parseDiffHunks(diff);
  assert.deepEqual([...h.keys()], ['src/a.ts']);
  assert.deepEqual(h.get('src/a.ts'), [[4, 5], [12, 12], [21, 21]]);
});

test('changed lines map to the innermost symbol', () => {
  const items = [
    { name: 'Cart', kind: 'class', startLine: 1, endLine: 30 },
    { name: 'total()', kind: 'method', startLine: 10, endLine: 15, container: 'Cart' },
    { name: 'helper', kind: 'function', startLine: 40, endLine: 45 },
  ];
  assert.deepEqual(symbolsInRanges(items, [[12, 12], [41, 50], [3, 3], [100, 101]]), ['Cart.total', 'helper', 'Cart']);
});

test('a selection counts as a symbol only when it is one name', () => {
  assert.equal(symbolFromSelection('runSubAgent'), 'runSubAgent');
  assert.equal(symbolFromSelection(' MacTools.approvalScope() '), 'MacTools.approvalScope');
  assert.equal(symbolFromSelection('let x = 1'), undefined);
  assert.equal(symbolFromSelection(''), undefined);
  assert.equal(symbolFromSelection(undefined), undefined);
});

test('files the chat mentions are kept only when they exist', () => {
  const have = new Set(['Sources/Ingle/ChatStore.swift', 'src/a.ts']);
  const found = mentionedFiles('Look at `Sources/Ingle/ChatStore.swift` and ./src/a.ts, not src/missing.ts or e.g. notes.md', (p) => have.has(p));
  assert.deepEqual(found, ['Sources/Ingle/ChatStore.swift', 'src/a.ts']);
});

test('working set: active file first, no duplicates', () => {
  assert.deepEqual(workingSetFiles({ activeFile: 'a.ts', open: ['b.ts', 'a.ts'], changed: ['c.ts', 'b.ts'], mentioned: ['d.ts'] }), ['a.ts', 'c.ts', 'b.ts', 'd.ts']);
});

test('missing arguments default to the working set', () => {
  const ws: WorkingSet = { selection: 'discount', activeFile: 'src/cart.ts', open: ['src/cart.ts'], changed: ['src/pricing.ts'], mentioned: [] };
  assert.deepEqual(defaultsFor('impact', {}, ws), { args: { symbol: 'discount' }, note: '(no symbol named: using the selection, discount)' });
  assert.deepEqual(defaultsFor('references', { symbol: 'x' }, ws), { args: { symbol: 'x' } });
  const outline = defaultsFor('outline', {}, ws);
  assert.ok('args' in outline && outline.args.file === 'src/cart.ts');
  const diag = defaultsFor('diagnostics', {}, ws);
  assert.ok('args' in diag && JSON.stringify(diag.args.paths) === JSON.stringify(['src/cart.ts', 'src/pricing.ts']));
  assert.ok('error' in defaultsFor('outline', {}, EMPTY));
  // No selection: the symbol stays missing so the changed symbols are tried next.
  assert.deepEqual(defaultsFor('callers', {}, { ...ws, selection: 'two words' }), { args: {} });
});

// MARK: tool selection

const tool = (name: string, readOnly = false): SelectableTool => ({ name, readOnly });
const CODE = ['outline', 'definition', 'references', 'callers', 'callees', 'impact', 'diagnostics', 'read_exhaustively'].map((n) => tool(n, true));
const BASE = [tool('read_file', true), tool('search_code', true), tool('edit_file'), tool('run_command')];
const pick = (msg: string) => selectTools({ available: [...BASE, ...CODE], lastUser: msg, isSubAgent: false, active: [], mcpToolNames: [], mcpWanted: false }).map((t) => t.name);

test('code intelligence is offered when a coding request needs it', () => {
  const calls = pick('What calls `runSubAgent`?');
  for (const n of ['callers', 'references', 'definition', 'impact']) assert.ok(calls.includes(n), n);
  assert.ok(!calls.includes('read_exhaustively'));
  assert.ok(pick('rename approvalScope to scopeFor').includes('impact'));
  assert.ok(pick('change how totals are rounded').includes('impact'));
  assert.ok(pick('any type errors in cart.ts?').includes('diagnostics'));
  assert.ok(pick('outline Tools.swift for me').includes('outline'));
  assert.ok(pick('why did it crash? the log is huge').includes('read_exhaustively'));
  assert.ok(pick('what does checkout call?').includes('callees'));
  assert.ok(pick('where is make_report() defined').includes('definition'));
});

test('a chatty message gets no code intelligence tools', () => {
  assert.deepEqual(pick('hello, how are you?'), ['read_file', 'search_code', 'edit_file', 'run_command']);
  assert.deepEqual(pick('remember I like tabs'), ['read_file', 'search_code', 'edit_file', 'run_command']);
});

test('helpers and plan mode may use them (read-only)', () => {
  const sub = selectTools({ available: [...BASE, ...CODE], lastUser: 'x', isSubAgent: true, active: [], mcpToolNames: [], mcpWanted: false }).map((t) => t.name);
  for (const t of CODE) assert.ok(sub.includes(t.name));
  assert.ok(allowedInPlanMode(tool('impact', true)));
});

// MARK: the real engine (scan only, so it runs anywhere)

test('the bundled engine answers references and impact, with exact paths and lines', async () => {
  const root = copyFixture(true);
  const e = engine(root);
  try {
    const text = await runCodeIntel(e, 'references', { symbol: 'discount', format: 'json' }, EMPTY);
    assert.match(text, /^references to discount: /);    // format: json is dropped, the model gets text
    assert.match(text, /src\/cart\.ts/);
    const locs = await impactLocations(e, 'discount');
    assert.deepEqual(locs, [
      { path: 'src/cart.ts', line: 1 }, { path: 'src/cart.ts', line: 21 },
      { path: 'test/pricing.test.ts', line: 1 }, { path: 'test/pricing.test.ts', line: 3 },
    ]);
    // Comment-only mentions (cart.ts:25) and the definition itself aren't places to check.
    assert.ok(!locs.some((l) => l.line === 25));
  } finally {
    await e.dispose();
  }
});

test('impact with no symbol covers what the uncommitted changes touch', async () => {
  const root = copyFixture(true);
  const file = path.join(root, 'src/pricing.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('* 0.1', '* 0.15'));
  const e = engine(root);
  try {
    assert.deepEqual(await changedSymbols(e, root), ['discount']);
    const text = await runCodeIntel(e, 'impact', {}, EMPTY);
    assert.match(text, /uncommitted changes touch — discount/);
    assert.match(text, /impact of changing discount/);
    assert.match(text, /test\/pricing\.test\.ts/);
  } finally {
    await e.dispose();
  }
});

test('no symbol and nothing changed: a plain sentence, not an error', async () => {
  const root = copyFixture(true);
  const e = engine(root);
  try {
    const text = await runCodeIntel(e, 'callers', {}, { ...EMPTY, open: ['src/cart.ts'] });
    assert.match(text, /^Missing argument: symbol\..*src\/cart\.ts/);
  } finally {
    await e.dispose();
  }
});

test('on this repo, every caller of runSubAgent is found (the task 33b check, scan only)', async () => {
  const e = engine(REPO);
  try {
    const text = await runCodeIntel(e, 'callers', { symbol: 'runSubAgent' }, EMPTY);
    // ChatStore.swift calls it from runTool (delegate) and from Max's review; chatEngine.ts has its own runSubAgent.
    assert.match(text, /^callers of runSubAgent: \d+/);
    assert.match(text, /Sources\/Ingle\/ChatStore\.swift/);
    const locs = await impactLocations(e, 'runSubAgent');
    const swiftCalls = execFileSync('git', ['grep', '-n', '-w', 'runSubAgent', '--', 'Sources', 'Extensions/vscode/src'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter((l) => l && !/func runSubAgent|private async runSubAgent|async runSubAgent\(|\/\/|\*/.test(l.split(':').slice(2).join(':')));
    for (const l of swiftCalls) {
      const [p, line] = l.split(':');
      assert.ok(locs.some((x) => x.path === p && x.line === Number(line)), `missing ${p}:${line}`);
    }
  } finally {
    await e.dispose();
  }
});
