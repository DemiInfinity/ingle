import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// commands.ts reads ~/.ingle, so point HOME at a temp folder before loading it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingle-home-'));
process.env.HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cov: typeof import('../src/engine/coverage') = require('../src/engine/coverage');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cmds: typeof import('../src/tools/commands') = require('../src/tools/commands');
type CommandEntry = import('../src/tools/commands').CommandEntry;

const ROOT = '/work/shop';
/** A rename of `total` used in five files. */
const PLACES = [
  { path: 'src/cart.ts', line: 12 },
  { path: 'src/checkout.ts', line: 40 },
  { path: 'src/checkout.ts', line: 88 },
  { path: 'src/receipt.ts', line: 7 },
  { path: 'src/report.ts', line: 150 },
  { path: 'test/cart.test.ts', line: 3 },
];

function renameRun() {
  const s = cov.newCoverage(ROOT);
  cov.recordCall(s, 'impact', { symbol: 'total' });
  cov.addPlaces(s, 'total', PLACES);
  return s;
}

function command(mustUse: string): CommandEntry {
  return {
    name: 'careful', description: '', when: [], always: true, enabled: true, body: '', file: 'x.md', neverUse: [], thenRun: '',
    mustUse: mustUse.split(',').map((x) => cmds.parseRequirement(x)).filter((r): r is NonNullable<typeof r> => !!r),
  };
}

test('remembers affected places once, relative to the project', () => {
  const s = renameRun();
  cov.addPlaces(s, 'total', [{ path: 'src/cart.ts', line: 12 }, { path: `${ROOT}/src/extra.ts`, line: 5 }, { path: '/elsewhere/x.ts', line: 1 }]);
  assert.deepEqual(s.symbols, ['total']);
  assert.equal(s.places.length, PLACES.length + 1);
  assert.ok(s.places.some((p) => p.path === 'src/extra.ts' && p.line === 5));
  assert.ok(!s.places.some((p) => p.path.includes('elsewhere')));
});

test('symbols come from the argument or from the line in brackets', () => {
  assert.deepEqual(cov.symbolsOf({ symbol: 'Cart.total' }, ''), ['Cart.total']);
  assert.deepEqual(cov.symbolsOf({}, '(no symbol named: using what the uncommitted changes touch — total, Cart.add)\nimpact of total…'), ['total', 'Cart.add']);
  assert.deepEqual(cov.symbolsOf({}, '(no symbol named: using the selection, runSubAgent)\n…'), ['runSubAgent']);
  assert.deepEqual(cov.symbolsOf({}, 'Missing argument: symbol.'), []);
});

test('no check unless code changed after the lookup', () => {
  const s = cov.newCoverage(ROOT);
  cov.recordCall(s, 'edit_file', { path: 'src/cart.ts' });     // edit before any lookup
  cov.addPlaces(s, 'total', PLACES);
  assert.equal(s.changed, false);
  assert.equal(cov.coverageNudge(s), undefined);
  // A lookup used only to answer a question (no change afterwards) isn't checked either.
  const q = renameRun();
  assert.equal(cov.coverageNudge(q), undefined);
});

test('edits and reads near the affected lines count; reads elsewhere in the file do not', () => {
  const s = renameRun();
  cov.recordCall(s, 'edit_file', { path: 'src/cart.ts' });
  cov.recordCall(s, 'edit_file', { path: `${ROOT}/src/checkout.ts` });                  // absolute path
  cov.recordCall(s, 'read_file', { path: 'src/receipt.ts' });                          // whole file
  cov.recordCall(s, 'read_file', { path: 'src/report.ts', start_line: 1, end_line: 60 }); // not near line 150
  cov.recordCall(s, 'outline', { file: 'test/cart.test.ts' });
  assert.deepEqual(cov.unvisited(s), [{ path: 'src/report.ts', line: 150 }]);
  cov.recordCall(s, 'read_file', { path: './src/report.ts', start_line: '140', end_line: '160' });
  assert.deepEqual(cov.unvisited(s), []);
});

test('definition at a position counts; by name it does not; denied calls never count', () => {
  const s = renameRun();
  cov.recordCall(s, 'definition', { symbol: 'total' });
  cov.recordCall(s, 'write_file', { path: 'src/receipt.ts' }, true);   // denied
  assert.ok(cov.unvisited(s).some((p) => p.path === 'src/receipt.ts'));
  cov.recordCall(s, 'definition', { symbol: 'src/receipt.ts:8:3' });
  assert.ok(!cov.unvisited(s).some((p) => p.path === 'src/receipt.ts'));
});

test('one nudge naming the symbol and the places, then never again', () => {
  const s = renameRun();
  cov.recordCall(s, 'edit_file', { path: 'src/cart.ts' });
  cov.recordCall(s, 'edit_file', { path: 'src/checkout.ts' });
  cov.recordCall(s, 'edit_file', { path: 'src/receipt.ts' });
  cov.recordCall(s, 'edit_file', { path: 'test/cart.test.ts' });
  const item = cov.coverageNudge(s);
  assert.ok(item);
  assert.match(item!, /^You changed `total` but didn't look at 1 place that uses it: src\/report\.ts:150\. Check it/);
  assert.match(item!, /say why it doesn’t need changing/);
  assert.equal(cov.coverageNudge(s), undefined);
  // It goes out through the commands' nudge, alone or with what commands still owe.
  const text = cmds.completionCheck([], [], new Map(), new Map(), [item!]);
  assert.ok(text && cmds.isNudgeText(text) && text.includes('src/report.ts:150'));
  const both = cmds.completionCheck([command('search_code')], [], new Map(), new Map(), [item!]);
  assert.ok(both && both.includes('the command "careful"') && both.includes('You changed `total`'));
});

test('a long list is shortened in the nudge', () => {
  const s = cov.newCoverage(ROOT);
  cov.recordCall(s, 'references', { symbol: 'id' });
  cov.addPlaces(s, 'id', Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, line: i + 1 })));
  cov.recordCall(s, 'edit_file', { path: 'src/main.ts' });
  assert.match(cov.coverageNudge(s)!, /12 places that use it: .* and 4 more\. Check them/);
});

test('fixed after the nudge: no chip', () => {
  const s = renameRun();
  cov.recordCall(s, 'edit_file', { path: 'src/cart.ts' });
  assert.ok(cov.coverageNudge(s));
  for (const p of PLACES) cov.recordCall(s, 'edit_file', { path: p.path });
  cov.noteReply(s, 'Done: renamed everywhere.');
  assert.deepEqual(cov.coverageLeft(s), []);
});

test('a stated reason resolves it; a bare "done" does not', () => {
  const s = renameRun();
  cov.recordCall(s, 'edit_file', { path: 'src/cart.ts' });
  cov.noteReply(s, 'They only log the value.');   // before the nudge: ignored
  assert.ok(cov.coverageNudge(s));
  cov.noteReply(s, 'I’ve updated everything.');
  assert.equal(cov.coverageLeft(s).length, 5);
  cov.noteReply(s, 'The other places only log the value, so they don’t need changing.');
  assert.deepEqual(cov.coverageLeft(s), []);
  for (const t of ['report.ts doesn’t use the return value', 'Those are unaffected by the rename.', 'receipt.ts is unrelated']) {
    assert.ok(cov.statesReason(t), t);
  }
  for (const t of ['Renamed it.', 'All done!', 'I have already updated everything.']) assert.ok(!cov.statesReason(t), t);
});

test('the chip lists what is still unchecked', () => {
  const s = renameRun();
  cov.recordCall(s, 'edit_file', { path: 'src/cart.ts' });
  cov.recordCall(s, 'edit_file', { path: 'src/checkout.ts' });
  assert.equal(cov.coverageLeft(s).length, 0);   // nothing before the nudge
  cov.coverageNudge(s);
  cov.recordCall(s, 'read_file', { path: 'src/receipt.ts' });
  cov.noteReply(s, 'Finished the rename.');
  const left = cov.coverageLeft(s);
  assert.deepEqual(left.map(cov.placeText), ['src/report.ts:150', 'test/cart.test.ts:3']);
  assert.equal(cov.coverageChip(left.length), '⚠ 2 affected places not checked');
  assert.equal(cov.coverageChip(1), '⚠ 1 affected place not checked');
});

test('on at High and Max and in Debug mode; off at Low and Medium unless forced', () => {
  assert.equal(cov.coverageOn('low', 'ask', false), false);
  assert.equal(cov.coverageOn('medium', 'edit', false), false);
  assert.equal(cov.coverageOn('high', 'ask', false), true);
  assert.equal(cov.coverageOn('max', 'auto', false), true);
  assert.equal(cov.coverageOn('low', 'debug', false), true);
  assert.equal(cov.coverageOn('medium', 'ask', true), true);
});

test('must_use: coverage forces it, is never "owed" as a tool, and offers impact', () => {
  const c = command('coverage');
  assert.deepEqual(c.mustUse, [{ kind: 'coverage', raw: 'coverage' }]);
  assert.equal(cmds.coverageForced([c]), true);
  assert.equal(cmds.coverageForced([command('search_code')]), false);
  assert.deepEqual(cmds.owedWork(c, []), []);
  assert.equal(cmds.unavailableReason(c, ['read_file']), undefined);
  assert.ok(cmds.requiredTools([c]).has('impact'));
  assert.equal(cmds.completionCheck([c], [], new Map(), new Map()), undefined);
  assert.match(cmds.commandsBlock([c]), /run impact first and check every place it lists/);
  // Case-insensitive, like the other kinds.
  assert.equal(cmds.parseRequirement(' Coverage ')?.kind, 'coverage');
});
